import axios from 'axios';
import { CONFIG } from '../config';
import { BotState, Position, TradeRecord } from '../types';
import { logger } from '../utils/logger';
import { fetchCurrentPrice } from '../scanner/dexscreener';
import { executeSell } from '../executor/jupiter';
import { saveTrade } from '../utils/storage';
import {
  notifySellProfit,
  notifySellLoss,
  notifyTrailingStop,
} from '../notifier/discord';

// ============================================
// MONITOR v8 — Smart dead_volume + Anti-Dashan
// ============================================
// Changements vs v7 :
// #3 : Dead volume timeout 3 min + extension intelligente
// #5 : Si PnL positif et volume mort → vente immédiate
//       Si PnL négatif → attendre 2 min de plus, mais stop-loss actif
// #7 : Trailing stop capé à -20% (anti-Dashan)

let monitorInterval: NodeJS.Timeout | null = null;
let fastCheckInterval: NodeJS.Timeout | null = null;

// Track quand on a perdu le prix pour chaque position
const deadVolumeTimers: Map<string, number> = new Map();

export function startMonitor(state: BotState): void {
  if (monitorInterval) return;
  logger.info('MONITOR', 'Surveillance v8 démarrée (smart dead_volume + anti-Dashan)');

  monitorInterval = setInterval(() => checkAllPositions(state), CONFIG.monitor.priceCheckInterval);
  fastCheckInterval = setInterval(() => fastCheckParallel(state), 1500);
}

export function stopMonitor(): void {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
  if (fastCheckInterval) { clearInterval(fastCheckInterval); fastCheckInterval = null; }
  deadVolumeTimers.clear();
}

// ═══ FAST CHECK PARALLÈLE ═══
async function fastCheckParallel(state: BotState): Promise<void> {
  const open = state.openPositions.filter(p => p.status !== 'closed');
  if (open.length === 0) return;

  const now = Date.now();

  const pricePromises = open.map(p =>
    fetchCurrentPrice(p.mintAddress)
      .then(price => ({ position: p, price }))
      .catch(() => ({ position: p, price: null as number | null }))
  );

  const results = await Promise.allSettled(pricePromises);

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { position: p, price } = result.value;
    if (p.status === 'closed') continue;

    // ═══ GESTION DEAD VOLUME (#3 + #5) ═══
    if (!price || price === 0) {
      // Pas de prix → tracker le dead timer
      if (!deadVolumeTimers.has(p.id)) {
        deadVolumeTimers.set(p.id, now);
        logger.info('MONITOR', `${p.symbol}: prix perdu, timer dead_volume lancé`);
      }

      const deadSince = deadVolumeTimers.get(p.id)!;
      const deadDuration = now - deadSince;

      // Si PnL POSITIF → vente immédiate (sécuriser le gain) (#5)
      if (p.pnlPercent > 0 && deadDuration > 15_000) {
        logger.success('MONITOR', `${p.symbol}: dead volume mais PnL +${p.pnlPercent.toFixed(1)}% → sécurisation immédiate`);
        deadVolumeTimers.delete(p.id);
        await closePosition(p, state, 'dead_volume');
        continue;
      }

      // Si PnL négatif et < -10% → couper à 3 min (#3)
      if (p.pnlPercent <= (CONFIG.monitor as any).deadVolumeStopLoss && deadDuration > (CONFIG.monitor as any).deadVolumeTimeout) {
        logger.warn('MONITOR', `${p.symbol}: dead volume 3min + PnL ${p.pnlPercent.toFixed(1)}% (< -10%) → fermeture`);
        deadVolumeTimers.delete(p.id);
        await closePosition(p, state, 'dead_volume');
        continue;
      }

      // Si PnL négatif mais > -10% → attendre 2 min de plus (#5)
      if (p.pnlPercent < 0 && p.pnlPercent > (CONFIG.monitor as any).deadVolumeStopLoss &&
          deadDuration > (CONFIG.monitor as any).deadVolumeTimeout + (CONFIG.monitor as any).deadVolumeExtension) {
        logger.warn('MONITOR', `${p.symbol}: dead volume 5min (extension) + PnL ${p.pnlPercent.toFixed(1)}% → fermeture`);
        deadVolumeTimers.delete(p.id);
        await closePosition(p, state, 'dead_volume');
        continue;
      }

      // Dans tous les cas, couper après 7 min (sécurité)
      if (deadDuration > 7 * 60 * 1000) {
        logger.warn('MONITOR', `${p.symbol}: dead volume > 7min → fermeture forcée`);
        deadVolumeTimers.delete(p.id);
        await closePosition(p, state, 'dead_volume');
        continue;
      }

      continue; // Pas de prix → passer au suivant
    }

    // Prix récupéré → reset le dead timer
    if (deadVolumeTimers.has(p.id)) {
      deadVolumeTimers.delete(p.id);
      logger.info('MONITOR', `${p.symbol}: prix récupéré, dead timer annulé`);
    }

    // Update prix
    p.currentPriceSol = price;
    p.pnlPercent = ((price - p.entryPriceSol) / p.entryPriceSol) * 100;
    if (price > p.highestPriceSol) p.highestPriceSol = price;

    const age = now - p.entryTime;

    // ═══ QUICK-CUT : -4% dans les 30 premières secondes ═══
    if (age < 30_000 && p.pnlPercent <= -4 && !p.isRunner) {
      logger.warn('MONITOR', `⚡ ${p.symbol} QUICK-CUT: ${p.pnlPercent.toFixed(1)}% en ${(age / 1000).toFixed(0)}s`);
      await closePosition(p, state, 'stop_loss');
      continue;
    }

    // ═══ EARLY STOP : -7% dans les 60 premières secondes ═══
    if (age < 60_000 && p.pnlPercent <= -7 && !p.isRunner) {
      logger.warn('MONITOR', `⚡ ${p.symbol} EARLY STOP: ${p.pnlPercent.toFixed(1)}% en ${(age / 1000).toFixed(0)}s`);
      await closePosition(p, state, 'stop_loss');
      continue;
    }

    // ═══ HARD STOP : -12% ═══
    if (p.pnlPercent <= -12 && !p.isRunner) {
      logger.warn('MONITOR', `⛔ ${p.symbol} HARD STOP: ${p.pnlPercent.toFixed(1)}%`);
      await closePosition(p, state, 'stop_loss');
      continue;
    }

    // ═══ ANTI-DASHAN : trailing_stop ne doit JAMAIS descendre sous -20% (#7) ═══
    if (p.pnlPercent <= (CONFIG.monitor as any).maxTrailingLoss && !p.isRunner) {
      logger.warn('MONITOR', `⛔ ${p.symbol} ANTI-DASHAN: trailing à ${p.pnlPercent.toFixed(1)}% > -20% → fermeture forcée`);
      await closePosition(p, state, 'trailing_stop');
      continue;
    }

    // ═══ RUNNER BREAKEVEN ═══
    if (p.isRunner && p.pnlPercent <= 2) {
      const highestPnl = ((p.highestPriceSol - p.entryPriceSol) / p.entryPriceSol) * 100;
      if (highestPnl >= 15) {
        logger.warn('MONITOR', `${p.symbol} 🚀RUNNER breakeven (pic: +${highestPnl.toFixed(1)}%)`);
        await closePosition(p, state, 'trailing_stop');
        continue;
      }
    }
  }
}

// ─── CHECK PRINCIPAL ──────────────────────────
async function checkAllPositions(state: BotState): Promise<void> {
  for (const p of state.openPositions.filter(p => p.status !== 'closed')) {
    try { await checkPosition(p, state); } catch {}
  }
}

async function checkPosition(position: Position, state: BotState): Promise<void> {
  const price = await fetchCurrentPrice(position.mintAddress);
  if (!price || price === 0) return; // Dead volume géré dans fastCheckParallel

  position.currentPriceSol = price;
  position.pnlPercent = ((price - position.entryPriceSol) / position.entryPriceSol) * 100;
  position.pnlSol = (price - position.entryPriceSol) * position.tokenAmount * (position.remainingPercent / 100);
  if (price > position.highestPriceSol) position.highestPriceSol = price;

  const highestPnl = ((position.highestPriceSol - position.entryPriceSol) / position.entryPriceSol) * 100;

  // ═══ AUTO-PROMOTE runner ═══
  if (!position.isRunner && position.pnlPercent >= 15) {
    const promoted = await checkIfRunner(position);
    if (promoted) {
      position.isRunner = true;
      position.runnerPromotedAt = Date.now();
      logger.success('MONITOR', `🚀 ${position.symbol} promu RUNNER à +${position.pnlPercent.toFixed(1)}%`);
    }
  }

  if (position.isRunner) {
    await handleRunner(position, state, highestPnl);
  } else {
    await handleScalp(position, state, highestPnl);
  }
}

// ═══ RUNNER DETECTION ═══
async function checkIfRunner(position: Position): Promise<boolean> {
  try {
    const resp = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${position.mintAddress}`,
      { timeout: 5000 }
    );
    const pair = resp.data?.pairs?.[0];
    if (!pair) return false;

    const mc = pair.marketCap || pair.fdv || 0;
    const vol5m = pair.volume?.m5 || 0;
    const vol1h = pair.volume?.h1 || 0;
    const avgVol5m = vol1h > 0 ? vol1h / 12 : 0;
    const buys = pair.txns?.m5?.buys || 0;
    const sells = pair.txns?.m5?.sells || 0;
    const total = buys + sells;
    const buyRatio = total > 0 ? buys / total : 0;
    const priceChange5m = pair.priceChange?.m5 || 0;

    const signals = [
      avgVol5m > 0 && vol5m > avgVol5m * 1.5,
      buyRatio >= 0.55,
      priceChange5m > 0,
      mc < 200_000,
    ].filter(Boolean).length;

    return signals >= 3;
  } catch { return false; }
}

// ═══ MODE SCALP ═══
async function handleScalp(p: Position, state: BotState, highestPnl: number): Promise<void> {
  // Breakeven
  if (highestPnl >= 12 && p.pnlPercent <= 1) {
    logger.info('MONITOR', `${p.symbol} SCALP: breakeven (pic: +${highestPnl.toFixed(1)}%)`);
    await closePosition(p, state, 'trailing_stop');
    return;
  }

  // Trailing progressif
  if (highestPnl > 8) {
    const trail = getScalpTrail(highestPnl);
    if (p.currentPriceSol <= p.highestPriceSol * (1 - trail)) {
      logger.info('MONITOR', `${p.symbol} SCALP: trailing (pic: +${highestPnl.toFixed(1)}%, sortie: +${p.pnlPercent.toFixed(1)}%)`);
      if (p.pnlPercent > 0) await notifyTrailingStop(p.symbol, p.pnlPercent, p.pnlSol, highestPnl);
      await closePosition(p, state, 'trailing_stop');
      return;
    }
  }

  // Take-profit partiel
  for (let i = p.takeProfitStage; i < CONFIG.monitor.secureProfits.length; i++) {
    const sp = CONFIG.monitor.secureProfits[i];
    if (p.pnlPercent >= sp.triggerPercent * 100) {
      await partialSell(p, state, sp.sellPercent * 100, `Scalp TP +${(sp.triggerPercent * 100).toFixed(0)}%`);
      p.takeProfitStage = i + 1;
    }
  }

  // Timeout scalp
  if (Date.now() - p.entryTime > CONFIG.monitor.maxPositionAge) {
    if (p.pnlPercent <= 3) {
      logger.info('MONITOR', `${p.symbol} SCALP: timeout 90min (${p.pnlPercent.toFixed(1)}%)`);
      await closePosition(p, state, 'timeout');
    }
  }
}

// ═══ MODE RUNNER ═══
async function handleRunner(p: Position, state: BotState, highestPnl: number): Promise<void> {
  // Trailing LARGE
  if (highestPnl > 10) {
    const trail = getRunnerTrail(highestPnl);
    if (p.currentPriceSol <= p.highestPriceSol * (1 - trail)) {
      logger.info('MONITOR', `${p.symbol} 🚀RUNNER: trailing (pic: +${highestPnl.toFixed(1)}%, trail: ${(trail * 100).toFixed(0)}%, sortie: +${p.pnlPercent.toFixed(1)}%)`);
      if (p.pnlPercent > 0) await notifyTrailingStop(p.symbol, p.pnlPercent, p.pnlSol, highestPnl);
      await closePosition(p, state, 'trailing_stop');
      return;
    }
  }

  // Take-profit partiel runner
  const rsp = CONFIG.runner.secureProfits;
  for (let i = p.takeProfitStage; i < rsp.length; i++) {
    if (p.pnlPercent >= rsp[i].triggerPercent * 100) {
      await partialSell(p, state, rsp[i].sellPercent * 100, `Runner TP +${(rsp[i].triggerPercent * 100).toFixed(0)}%`);
      p.takeProfitStage = i + 1;
    }
  }

  // Timeout runner
  if (Date.now() - p.entryTime > CONFIG.runner.maxDuration && p.pnlPercent <= 5) {
    await closePosition(p, state, 'timeout');
  }
}

// ─── Trail calculators ────────────────────────
function getScalpTrail(pnl: number): number {
  const lvls = CONFIG.monitor.trailingLevels;
  for (let i = lvls.length - 1; i >= 0; i--) {
    if (pnl >= lvls[i].abovePercent) return lvls[i].trailPercent;
  }
  return lvls[0].trailPercent;
}

function getRunnerTrail(pnl: number): number {
  const lvls = CONFIG.runner.trailing.levels;
  for (let i = lvls.length - 1; i >= 0; i--) {
    if (pnl >= lvls[i].abovePercent) return lvls[i].trailPercent;
  }
  return lvls[0].trailPercent;
}

// ─── Sell helpers ─────────────────────────────
async function partialSell(p: Position, state: BotState, pct: number, reason: string): Promise<void> {
  const eff = Math.min(100, (pct / p.remainingPercent) * 100);
  const result = await executeSell(p, eff, reason);
  if (result.success) {
    p.remainingPercent -= pct;
    p.status = p.remainingPercent <= 0 ? 'closed' : 'partial';
    const pnl = (result.solReceived || 0) - p.entryAmountSol * (pct / 100);
    state.dailyPnlSol += pnl;
    state.dailyPnlPercent = (state.dailyPnlSol / CONFIG.risk.initialCapital) * 100;
    state.availableCapitalSol += result.solReceived || 0;
    if (pnl > 0) await notifySellProfit(p.symbol, p.pnlPercent, pnl, reason);
  }
}

async function closePosition(p: Position, state: BotState, reason: Position['closeReason']): Promise<void> {
  const result = await executeSell(p, p.remainingPercent, reason || 'manual');
  p.status = 'closed';
  p.closeReason = reason;
  p.remainingPercent = 0;
  deadVolumeTimers.delete(p.id);

  const invested = p.entryAmountSol;
  const returned = result.solReceived || 0;
  const pnlSol = returned - invested;
  const pnlPct = invested > 0 ? ((returned - invested) / invested) * 100 : 0;

  saveTrade({
    id: p.id, mintAddress: p.mintAddress, symbol: p.symbol,
    entryPriceSol: p.entryPriceSol, exitPriceSol: p.currentPriceSol,
    investedSol: invested, returnedSol: returned, pnlSol, pnlPercent: pnlPct,
    entryTime: p.entryTime, exitTime: Date.now(), durationMs: Date.now() - p.entryTime,
    score: p.score, closeReason: reason || 'manual',
    txSignatures: [p.entryTxSignature, result.signature || ''].filter(Boolean),
  });

  state.dailyPnlSol += pnlSol;
  state.dailyPnlPercent = (state.dailyPnlSol / CONFIG.risk.initialCapital) * 100;
  state.dailyTradeCount++;
  if (pnlSol > 0) state.dailyWinCount++; else state.dailyLossCount++;
  state.availableCapitalSol += returned;
  state.openPositions = state.openPositions.filter(x => x.id !== p.id);

  const tag = p.isRunner ? '🚀RUNNER' : 'SCALP';
  if (pnlSol >= 0) {
    await notifySellProfit(p.symbol, pnlPct, pnlSol, `${tag} — ${reason}`);
    logger.success('MONITOR', `${p.symbol} ${tag}: +${pnlPct.toFixed(1)}% (+${pnlSol.toFixed(4)} SOL)`);
  } else {
    await notifySellLoss(p.symbol, pnlPct, pnlSol, `${tag} — ${reason}`);
    logger.warn('MONITOR', `${p.symbol} ${tag}: ${pnlPct.toFixed(1)}% (${pnlSol.toFixed(4)} SOL)`);
  }
}
