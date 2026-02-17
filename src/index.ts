import { CONFIG, validateConfig } from './config';
import { BotState, Position, TokenAnalysis, DetectedToken } from './types';
import { logger } from './utils/logger';
import { initSolana, getSOLBalance, sleep } from './utils/solana';
import { startPumpFunScanner, stopPumpFunScanner } from './scanner/pumpfun';
import { fetchRecentTokens } from './scanner/dexscreener';
import { analyzeToken } from './analyzer/scorer';
import { addToWatchlist, startDipBuyer, stopDipBuyer, getWatchlistSize, getWatchlistInfo } from './analyzer/dipBuyer';
import { shouldBuy, canOpenPosition, syncCapital } from './risk/manager';
import { executeBuy } from './executor/jupiter';
import { startMonitor, stopMonitor } from './monitor/positions';
import {
  notifyBotStart,
  notifyBuy,
  notifyDetection,
  notifySummary,
} from './notifier/discord';

// ============================================
// SOLSNIPER BOT v7 — Micro-cap + Dip Buy
// ============================================

const state: BotState = {
  totalCapitalSol: 0,
  availableCapitalSol: 0,
  reserveSol: CONFIG.risk.reserveAmount,
  openPositions: [],
  closedToday: [],
  dailyPnlSol: 0,
  dailyPnlPercent: 0,
  dailyTradeCount: 0,
  dailyWinCount: 0,
  dailyLossCount: 0,
  isPaused: false,
  pauseUntil: null,
  startTime: Date.now(),
  seenTokens: new Set<string>(),
  watchList: new Map<string, TokenAnalysis>(),
};

let isProcessing = false;
const tokenQueue: DetectedToken[] = [];

async function main(): Promise<void> {
  logger.banner();
  validateConfig();

  const { wallet } = initSolana();

  // Solde : simulé en paper trading, réel sinon
  let balance: number;
  if (CONFIG.mode.paperTrading) {
    balance = CONFIG.risk.initialCapital;
    logger.info('BOT', `Solde simulé (paper) : ${balance.toFixed(4)} SOL`);
  } else {
    balance = await getSOLBalance();
    logger.info('BOT', `Solde du wallet : ${balance.toFixed(4)} SOL`);
    if (balance < CONFIG.risk.reserveAmount) {
      logger.error('BOT', `Solde insuffisant ! Minimum requis : ${CONFIG.risk.reserveAmount} SOL`);
      process.exit(1);
    }
  }

  state.totalCapitalSol = balance;
  state.availableCapitalSol = balance;

  logger.divider();

  await notifyBotStart(wallet.publicKey.toBase58(), balance, CONFIG.mode.paperTrading);

  // Démarrer les modules
  logger.info('BOT', 'Démarrage des modules v5...');

  // 1. Scanner Pump.fun
  startPumpFunScanner(onTokenDetected);
  logger.success('BOT', 'Scanner Pump.fun démarré');

  // 2. Scanner DexScreener
  startDexScreenerPolling();
  logger.success('BOT', 'Scanner DexScreener démarré');

  // 3. Dip Buyer (NOUVEAU)
  startDipBuyer(state, onDipBuySignal);
  logger.success('BOT', 'Dip Buyer démarré — les tokens seront surveillés avant achat');

  // 4. Monitor (trailing stop progressif)
  startMonitor(state);
  logger.success('BOT', 'Monitor v5 démarré (trailing progressif)');

  // 5. Résumé Discord + Daily reset + Queue processor
  startPeriodicSummary();
  startDailyReset();
  startQueueProcessor();

  logger.divider();
  logger.success('BOT', '🚀 SolSniper Bot v5 opérationnel !');
  logger.info('BOT', `Mode : ${CONFIG.mode.paperTrading ? '📝 PAPER TRADING' : '💰 TRADING RÉEL'}`);
  logger.info('BOT', `Capital déployable : ${(balance - CONFIG.risk.reserveAmount).toFixed(4)} SOL`);
  logger.info('BOT', `Max positions : ${CONFIG.risk.maxOpenPositions} | Watchlist: ${CONFIG.dipBuyer.maxWatchlistSize}`);
  logger.info('BOT', `Stratégie : Wide Net + Runner Hold (SCALP + RUNNER dual mode)`);
  logger.info('BOT', `Seuil achat min : score ${CONFIG.analyzer.scoreBuyLow} | Runner detect: +${CONFIG.runner.detection.minPriceIncrease}%`);
  logger.divider();

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}

/**
 * Token détecté par un scanner
 */
function onTokenDetected(token: DetectedToken): void {
  if (state.seenTokens.has(token.mintAddress)) return;
  state.seenTokens.add(token.mintAddress);

  if (state.seenTokens.size > 10_000) {
    const arr = Array.from(state.seenTokens);
    arr.splice(0, 5000).forEach((t) => state.seenTokens.delete(t));
  }

  tokenQueue.push(token);
}

/**
 * Processeur de queue
 */
function startQueueProcessor(): void {
  setInterval(async () => {
    if (isProcessing || tokenQueue.length === 0) return;
    isProcessing = true;

    try {
      const token = tokenQueue.shift()!;
      await processToken(token);
    } catch (err) {
      logger.error('BOT', 'Erreur traitement token', err);
    } finally {
      isProcessing = false;
    }
  }, 500);
}

/**
 * Traite un token : analyse → achat direct OU watchlist
 * v5 : beaucoup plus agressif, on achète plus souvent
 */
async function processToken(token: DetectedToken): Promise<void> {
  const analysis = await analyzeToken(token);

  if (analysis.confidence === 'ignore') return;

  // Score watch (35-44) → watchlist si dip buyer actif
  if (analysis.confidence === 'watch') {
    if (CONFIG.dipBuyer.enabled) {
      await addToWatchlist(analysis);
    }
    return;
  }

  // Score low (45-54) → achat direct (plus de dip waiting pour les low)
  if (analysis.confidence === 'low') {
    logger.info('BOT', `${token.symbol} : score ${analysis.score} → achat micro direct`);
    await notifyDetection(token.symbol, token.mintAddress, analysis.score, analysis.reasons);
    await executeDirectBuy(analysis);
    return;
  }

  // Score medium (55-64) → achat direct
  if (analysis.confidence === 'medium') {
    logger.info('BOT', `${token.symbol} : score ${analysis.score} → achat petit direct`);
    await notifyDetection(token.symbol, token.mintAddress, analysis.score, analysis.reasons);
    await executeDirectBuy(analysis);
    return;
  }

  // Score high (65+) → achat direct, priorité haute
  if (analysis.confidence === 'high') {
    logger.info('BOT', `${token.symbol} : score ÉLEVÉ (${analysis.score}) → achat direct prioritaire`);
    await notifyDetection(token.symbol, token.mintAddress, analysis.score,
      [...analysis.reasons, '⚡ Score élevé → achat immédiat']);
    await executeDirectBuy(analysis);
  }
}

/**
 * Signal d'achat depuis le Dip Buyer (le dip + rebond ont été confirmés)
 */
async function onDipBuySignal(analysis: TokenAnalysis): Promise<void> {
  logger.info('BOT', `📉→📈 Signal dip-buy pour ${analysis.token.symbol} (score: ${analysis.score})`);
  await executeDirectBuy(analysis);
}

/**
 * Exécute un achat — plus rapide, moins de checks bloquants
 */
async function executeDirectBuy(analysis: TokenAnalysis): Promise<void> {
  const order = shouldBuy(analysis, state);
  if (!order) return;

  // ═══ PRE-BUY CHECK LÉGER ═══
  // Vérifie que le prix n'est pas en chute libre MAINTENANT
  // (Évite les cas MELON: -43% en 7s, WOF: -57% en 28s)
  const { fetchCurrentPrice } = await import('./scanner/dexscreener');
  const preBuyPrice = await fetchCurrentPrice(analysis.token.mintAddress);
  
  if (!preBuyPrice || preBuyPrice === 0) {
    logger.warn('BOT', `${analysis.token.symbol}: prix introuvable → achat annulé`);
    return;
  }

  // Comparer avec le prix connu du scanner
  if (analysis.token.priceSol > 0) {
    const drift = ((preBuyPrice - analysis.token.priceSol) / analysis.token.priceSol) * 100;
    if (drift < -8) {
      logger.warn('BOT', `${analysis.token.symbol}: prix en chute de ${drift.toFixed(1)}% depuis la détection → achat ANNULÉ`);
      return;
    }
    if (drift < -4) {
      logger.info('BOT', `${analysis.token.symbol}: baisse de ${drift.toFixed(1)}% depuis la détection → prudence mais on continue`);
    }
  }

  logger.info('BOT', `Achat de ${analysis.token.symbol} pour ${order.amountSol?.toFixed(4)} SOL (score: ${analysis.score})...`);

  const result = await executeBuy(order);

  if (result.success && result.signature && result.tokenAmount && result.priceSol) {
    // Pre-classify runner : MC < 50k + buy ratio > 55% → runner dès le départ
    const totalTx = analysis.token.buyCount5m + analysis.token.sellCount5m;
    const buyRatio = totalTx > 0 ? analysis.token.buyCount5m / totalTx : 0;
    const isEarlyRunner = analysis.token.marketCap > 0 &&
      analysis.token.marketCap < 50_000 &&
      analysis.token.volume5m > 0 &&
      buyRatio > 0.55;

    if (isEarlyRunner) {
      logger.info('BOT', `🚀 ${analysis.token.symbol} classé RUNNER dès l'entrée (MC: $${(analysis.token.marketCap/1000).toFixed(1)}k, buys: ${(buyRatio*100).toFixed(0)}%)`);
    }

    const position: Position = {
      id: `pos_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      mintAddress: analysis.token.mintAddress,
      symbol: analysis.token.symbol,
      name: analysis.token.name,
      entryPriceSol: result.priceSol,
      entryAmountSol: order.amountSol!,
      tokenAmount: result.tokenAmount,
      entryTime: Date.now(),
      entryTxSignature: result.signature,
      score: analysis.score,
      currentPriceSol: result.priceSol,
      highestPriceSol: result.priceSol,
      pnlPercent: 0,
      pnlSol: 0,
      remainingPercent: 100,
      takeProfitStage: 0,
      trailingStopActive: false,
      isRunner: isEarlyRunner,
      runnerPromotedAt: isEarlyRunner ? Date.now() : undefined,
      status: 'open',
    };

    state.openPositions.push(position);
    state.availableCapitalSol -= order.amountSol!;

    logger.success(
      'BOT',
      `Position ouverte : ${analysis.token.symbol} — ${order.amountSol!.toFixed(4)} SOL (score: ${analysis.score}) ${isEarlyRunner ? '🚀 RUNNER' : 'SCALP'}`
    );

    await notifyBuy(
      analysis.token.symbol,
      analysis.token.mintAddress,
      order.amountSol!,
      analysis.score,
      result.signature
    );
  } else {
    logger.warn('BOT', `Achat échoué pour ${analysis.token.symbol}`);
  }
}

/**
 * Polling DexScreener
 */
function startDexScreenerPolling(): void {
  scanDexScreener();
  setInterval(scanDexScreener, CONFIG.scanner.dexScreenerInterval);
}

async function scanDexScreener(): Promise<void> {
  try {
    const tokens = await fetchRecentTokens();
    for (const token of tokens) {
      onTokenDetected(token);
    }
  } catch (err) {
    logger.error('SCANNER', 'Erreur scan DexScreener', err);
  }
}

/**
 * Résumé Discord
 */
function startPeriodicSummary(): void {
  setInterval(async () => {
    try {
      if (!CONFIG.mode.paperTrading) {
        await syncCapital(state);
      }

      const watchInfo = getWatchlistInfo();
      const watchMsg = watchInfo.length > 0
        ? `\nWatchlist (${watchInfo.length}) : ${watchInfo.map(w => `${w.symbol}(${w.state}, dip:${w.dipPercent.toFixed(0)}%)`).join(', ')}`
        : '';

      logger.info('BOT', `Résumé : PNL=${state.dailyPnlSol >= 0 ? '+' : ''}${state.dailyPnlSol.toFixed(4)} SOL | Trades=${state.dailyTradeCount} | W=${state.dailyWinCount} L=${state.dailyLossCount} | Positions=${state.openPositions.length} | Watchlist=${getWatchlistSize()}${watchMsg}`);

      await notifySummary(
        state.totalCapitalSol,
        state.openPositions.length,
        state.dailyPnlSol,
        state.dailyPnlPercent,
        state.dailyTradeCount
      );
    } catch (err) {
      logger.error('DISCORD', 'Erreur envoi résumé', err);
    }
  }, CONFIG.discord.summaryInterval);
}

/**
 * Reset journalier
 */
function startDailyReset(): void {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setHours(24, 0, 0, 0);
  const msUntilMidnight = tomorrow.getTime() - now.getTime();

  setTimeout(() => {
    resetDailyCounters();
    setInterval(resetDailyCounters, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);
}

function resetDailyCounters(): void {
  logger.info('BOT', 'Reset des compteurs journaliers');
  state.dailyPnlSol = 0;
  state.dailyPnlPercent = 0;
  state.dailyTradeCount = 0;
  state.dailyWinCount = 0;
  state.dailyLossCount = 0;
  state.closedToday = [];
  state.isPaused = false;
  state.pauseUntil = null;
}

/**
 * Arrêt propre
 */
async function gracefulShutdown(): Promise<void> {
  logger.divider();
  logger.info('BOT', 'Arrêt du bot...');

  stopPumpFunScanner();
  stopDipBuyer();
  stopMonitor();

  logger.info('BOT', `PNL jour : ${state.dailyPnlSol >= 0 ? '+' : ''}${state.dailyPnlSol.toFixed(4)} SOL`);
  logger.info('BOT', `Trades : ${state.dailyTradeCount} (${state.dailyWinCount}W / ${state.dailyLossCount}L)`);
  logger.info('BOT', `Positions ouvertes : ${state.openPositions.length}`);
  logger.info('BOT', `Watchlist : ${getWatchlistSize()} tokens en surveillance`);

  if (state.openPositions.length > 0) {
    logger.warn('BOT', '⚠️  Positions ouvertes restantes :');
    for (const p of state.openPositions) {
      logger.info('BOT', `  → ${p.symbol} : ${p.pnlPercent >= 0 ? '+' : ''}${p.pnlPercent.toFixed(1)}%`);
    }
  }

  logger.success('BOT', 'SolSniper Bot arrêté.');
  logger.divider();
  process.exit(0);
}

main().catch((err) => {
  logger.error('BOT', 'Erreur fatale', err);
  process.exit(1);
});
