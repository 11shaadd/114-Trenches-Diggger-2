import axios from 'axios';
import { CONFIG } from '../config';
import { DetectedToken, TokenAnalysis } from '../types';
import { logger } from '../utils/logger';
import { getConnection } from '../utils/solana';
import { PublicKey } from '@solana/web3.js';

// ============================================
// ANALYZER v2 — Score de confiance AMÉLIORÉ
// ============================================
// Changements vs v1 :
// - Ajout détection de MOMENTUM (le prix monte-t-il en ce moment ?)
// - Ajout système de RED FLAGS (veto immédiat)
// - Critères plus stricts sur le ratio buy/sell
// - Vérification du price change récent via DexScreener
// - Liquidité minimum relevée

const { weights } = CONFIG.analyzer;

/**
 * Analyse un token et retourne un score de 0 à 100
 */
export async function analyzeToken(token: DetectedToken): Promise<TokenAnalysis> {
  // ─── ÉTAPE 1 : Red flags → rejet immédiat ───
  const redFlag = checkRedFlags(token);
  if (redFlag) {
    logger.warn('ANALYZER', `${token.symbol} : RED FLAG → ${redFlag}`);
    return {
      token,
      score: 0,
      confidence: 'ignore',
      breakdown: { volumeMcapRatio: 0, buyVsSellRatio: 0, holderDistribution: 0, holderGrowth: 0, devProfile: 0, liquidityLocked: 0, momentum: 0 },
      reasons: [`🚩 ${redFlag}`],
    };
  }

  // ─── ÉTAPE 2 : Récupérer les données de momentum ───
  const momentum = await scoreMomentum(token);

  // Si le momentum est très négatif, on refuse (mais plus souple qu'avant)
  if (momentum <= 1) {
    logger.info('ANALYZER', `${token.symbol} : momentum très faible (${momentum}/10) → ignoré`);
    return {
      token,
      score: Math.round(momentum * 10),
      confidence: 'ignore',
      breakdown: { volumeMcapRatio: 0, buyVsSellRatio: 0, holderDistribution: 0, holderGrowth: 0, devProfile: 0, liquidityLocked: 0, momentum },
      reasons: ['📉 Momentum très négatif'],
    };
  }

  // ─── ÉTAPE 3 : Scoring complet ───
  const breakdown = {
    volumeMcapRatio: scoreVolumeMcapRatio(token),
    buyVsSellRatio: scoreBuyVsSellRatio(token),
    holderDistribution: await scoreHolderDistribution(token),
    holderGrowth: scoreHolderGrowth(token),
    devProfile: scoreDevProfile(token),
    liquidityLocked: scoreLiquidityLocked(token),
    momentum,
  };

  // Calcul du score total pondéré (momentum a le poids le plus fort)
  const momentumWeight = (weights as any).momentum || 3.0;
  const weightedSum =
    breakdown.volumeMcapRatio * weights.volumeMcapRatio +
    breakdown.buyVsSellRatio * weights.buyVsSellRatio +
    breakdown.holderDistribution * weights.holderDistribution +
    breakdown.holderGrowth * weights.holderGrowth +
    breakdown.devProfile * weights.devProfile +
    breakdown.liquidityLocked * weights.liquidityLocked +
    breakdown.momentum * momentumWeight;

  const maxPossible =
    10 * weights.volumeMcapRatio +
    10 * weights.buyVsSellRatio +
    10 * weights.holderDistribution +
    10 * weights.holderGrowth +
    10 * weights.devProfile +
    10 * weights.liquidityLocked +
    10 * momentumWeight;

  const score = Math.round((weightedSum / maxPossible) * 100);

  // Déterminer le niveau de confiance (seuils relevés)
  let confidence: TokenAnalysis['confidence'];
  if (score <= CONFIG.analyzer.scoreIgnore) confidence = 'ignore';
  else if (score <= CONFIG.analyzer.scoreWatch) confidence = 'watch';
  else if (score <= CONFIG.analyzer.scoreBuyLow) confidence = 'low';
  else if (score <= CONFIG.analyzer.scoreBuyMid) confidence = 'medium';
  else confidence = 'high';

  const reasons = generateReasons(breakdown, token);

  const analysis: TokenAnalysis = {
    token,
    score,
    confidence,
    breakdown,
    reasons,
  };

  logger.info(
    'ANALYZER',
    `${token.symbol} : score ${score}/100 (${confidence}) — ` +
    `mom:${breakdown.momentum.toFixed(1)} vol/mc:${breakdown.volumeMcapRatio.toFixed(1)} ` +
    `buy:${breakdown.buyVsSellRatio.toFixed(1)} hold:${breakdown.holderDistribution.toFixed(1)} ` +
    `growth:${breakdown.holderGrowth.toFixed(1)} dev:${breakdown.devProfile.toFixed(1)} lp:${breakdown.liquidityLocked.toFixed(1)}`
  );

  return analysis;
}

// ─── RED FLAGS : Rejet immédiat (SOUPLES en v5) ──

function checkRedFlags(token: DetectedToken): string | null {
  // Liquidité trop faible → impossible de sortir
  if (token.liquiditySol < 2) {
    return `Liquidité trop faible (${token.liquiditySol.toFixed(1)} SOL)`;
  }

  // Ratio sell/buy très déséquilibré → dump violent
  const total = token.buyCount5m + token.sellCount5m;
  if (total > 15) {
    const sellRatio = token.sellCount5m / total;
    if (sellRatio > 0.70) {
      return `Dump en cours (${(sellRatio * 100).toFixed(0)}% sells)`;
    }
  }

  // Mint authority non révoquée
  if (!token.mintAuthorityRevoked) {
    return 'Mint authority NON révoquée';
  }

  // Freeze authority non révoquée
  if (!token.freezeAuthorityRevoked) {
    return 'Freeze authority NON révoquée';
  }

  // Très peu de tx → pas assez de données
  if (token.txCount5m < 10) {
    return `Trop peu de tx (${token.txCount5m})`;
  }

  return null; // PAS de filtre sur le market cap max — on veut entrer tôt ET tard
}

// ─── MOMENTUM : Le prix est-il en hausse ? ───────

async function scoreMomentum(token: DetectedToken): Promise<number> {
  try {
    const response = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${token.mintAddress}`,
      { timeout: 8_000 }
    );

    const pair = response.data?.pairs?.[0];
    if (!pair) return 3;

    const priceChange5m = pair.priceChange?.m5 || 0;
    const priceChange1h = pair.priceChange?.h1 || 0;

    let score = 5;

    // Prix sur 5 minutes — filtre mais SOUPLE
    if (priceChange5m < -25) score -= 5;       // Crash violent → refuser
    else if (priceChange5m < -15) score -= 3;  // Grosse baisse → danger
    else if (priceChange5m < -8) score -= 2;   // Baisse nette
    else if (priceChange5m < -3) score -= 1;   // Légère baisse → acceptable
    else if (priceChange5m > 1 && priceChange5m < 15) score += 2;  // Hausse douce → bien
    else if (priceChange5m >= 15 && priceChange5m < 50) score += 3; // Bonne hausse
    else if (priceChange5m >= 50) score += 1;  // Pump → attention mais pas refus

    // Prix sur 1 heure
    if (priceChange1h < -30) score -= 3;
    else if (priceChange1h < -10) score -= 1;
    else if (priceChange1h > 10 && priceChange1h < 100) score += 2;

    // Volume croissant
    const vol5m = pair.volume?.m5 || 0;
    const vol1h = pair.volume?.h1 || 0;
    const avgVol5m = vol1h / 12;
    if (avgVol5m > 0 && vol5m > avgVol5m * 1.5) {
      score += 1;
    }

    logger.info(
      'ANALYZER',
      `${token.symbol} momentum : 5m=${priceChange5m > 0 ? '+' : ''}${priceChange5m.toFixed(1)}%, ` +
      `1h=${priceChange1h > 0 ? '+' : ''}${priceChange1h.toFixed(1)}% → score ${Math.max(0, Math.min(10, score))}/10`
    );

    return Math.max(0, Math.min(10, score));
  } catch {
    return 3;
  }
}

// ─── Fonctions de scoring individuelles ──────────

function scoreVolumeMcapRatio(token: DetectedToken): number {
  if (token.marketCap === 0) return 0;

  const volumeRef = token.volume5m > 0 ? token.volume5m : token.volume1h / 12;
  const ratio = volumeRef / token.marketCap;

  if (ratio < 0.01) return 0;
  if (ratio < 0.02) return 2;
  if (ratio < 0.05) return 4;
  if (ratio < 0.10) return 6;
  if (ratio < 0.20) return 8;
  return 10;
}

function scoreBuyVsSellRatio(token: DetectedToken): number {
  const total = token.buyCount5m + token.sellCount5m;
  if (total === 0) return 3; // Pas de données → neutre (pas 0)

  const buyRatio = token.buyCount5m / total;

  // Plus souple qu'avant
  if (buyRatio < 0.35) return 0;
  if (buyRatio < 0.45) return 2;
  if (buyRatio < 0.50) return 4;
  if (buyRatio < 0.55) return 5;
  if (buyRatio < 0.60) return 6;
  if (buyRatio < 0.70) return 7;
  if (buyRatio < 0.80) return 9;
  return 10;
}

async function scoreHolderDistribution(token: DetectedToken): Promise<number> {
  try {
    const connection = getConnection();
    const mint = new PublicKey(token.mintAddress);

    const largestAccounts = await connection.getTokenLargestAccounts(mint);
    const accounts = largestAccounts.value;

    if (accounts.length === 0) return 2;

    const totalFromAccounts = accounts.reduce(
      (sum, acc) => sum + (acc.uiAmount || 0),
      0
    );

    if (totalFromAccounts === 0) return 2;

    const topHolderPercent = ((accounts[0].uiAmount || 0) / totalFromAccounts) * 100;
    const top5Percent =
      (accounts.slice(0, 5).reduce((sum, acc) => sum + (acc.uiAmount || 0), 0) /
        totalFromAccounts) * 100;

    let score = 5;

    if (topHolderPercent > 25) score -= 5;
    else if (topHolderPercent > 15) score -= 3;
    else if (topHolderPercent > 10) score -= 1;
    else if (topHolderPercent < 5) score += 2;

    if (top5Percent > 50) score -= 3;
    else if (top5Percent > 35) score -= 1;
    else score += 2;

    if (accounts.length >= 20) score += 1;

    return Math.max(0, Math.min(10, score));
  } catch {
    return 3;
  }
}

function scoreHolderGrowth(token: DetectedToken): number {
  const txPerMinute = token.txCount5m / 5;

  if (txPerMinute < 3) return 1;
  if (txPerMinute < 8) return 3;
  if (txPerMinute < 15) return 5;
  if (txPerMinute < 25) return 7;
  if (txPerMinute < 50) return 9;
  return 10;
}

function scoreDevProfile(token: DetectedToken): number {
  let score = 5;

  if (!token.mintAuthorityRevoked) score -= 4;
  if (!token.freezeAuthorityRevoked) score -= 4;

  if (token.liquiditySol > 30) score += 3;
  else if (token.liquiditySol > 15) score += 2;
  else if (token.liquiditySol > 8) score += 1;

  if (token.marketCap > 20_000 && token.marketCap < 500_000) score += 1;

  return Math.max(0, Math.min(10, score));
}

function scoreLiquidityLocked(token: DetectedToken): number {
  if (token.lpBurned) return 10;
  if (token.source === 'pumpfun') return 7;
  return 4;
}

// ─── Génération des raisons ──────────────────────

function generateReasons(
  breakdown: TokenAnalysis['breakdown'],
  token: DetectedToken
): string[] {
  const reasons: string[] = [];

  const mom = (breakdown as any).momentum || 0;
  if (mom >= 7) reasons.push('📈 Momentum fort — prix en hausse');
  else if (mom >= 5) reasons.push('➡️ Momentum neutre');
  else reasons.push('📉 Momentum faible — attention');

  if (breakdown.volumeMcapRatio >= 7)
    reasons.push('Volume/MCap élevé (forte activité)');

  if (breakdown.buyVsSellRatio >= 7)
    reasons.push(`Pression acheteuse (${token.buyCount5m}B vs ${token.sellCount5m}S)`);
  if (breakdown.buyVsSellRatio <= 3)
    reasons.push('⚠️ Plus de vendeurs que d\'acheteurs');

  if (breakdown.holderDistribution >= 7)
    reasons.push('Bonne distribution des holders');
  if (breakdown.holderDistribution <= 3)
    reasons.push('⚠️ Concentration élevée chez les top holders');

  if (breakdown.holderGrowth >= 7)
    reasons.push('Croissance rapide');

  if (token.lpBurned) reasons.push('LP brûlée');

  if (token.liquiditySol > 20)
    reasons.push(`Liquidité solide (${token.liquiditySol.toFixed(1)} SOL)`);

  return reasons;
}
