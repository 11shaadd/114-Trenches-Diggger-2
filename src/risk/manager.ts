import { CONFIG } from '../config';
import { BotState, TokenAnalysis, TradeOrder } from '../types';
import { logger } from '../utils/logger';
import { getSOLBalance } from '../utils/solana';
import { notifyRiskAlert } from '../notifier/discord';

// ============================================
// RISK MANAGER — Gestion du capital
// ============================================

/**
 * Calcule le capital déployable actuel
 */
export function getDeployableCapital(state: BotState): number {
  const deployable = state.availableCapitalSol - CONFIG.risk.reserveAmount;
  return Math.max(0, deployable);
}

/**
 * Vérifie si le bot peut ouvrir une nouvelle position
 */
export function canOpenPosition(state: BotState): { allowed: boolean; reason?: string } {
  // Bot en pause ?
  if (state.isPaused) {
    if (state.pauseUntil && Date.now() < state.pauseUntil) {
      const remaining = Math.ceil((state.pauseUntil - Date.now()) / 60_000);
      return { allowed: false, reason: `Bot en pause (${remaining} min restantes)` };
    }
    // Fin de pause
    state.isPaused = false;
    state.pauseUntil = null;
  }

  // Nombre max de positions atteint ?
  if (state.openPositions.length >= CONFIG.risk.maxOpenPositions) {
    return { allowed: false, reason: `Max positions atteint (${CONFIG.risk.maxOpenPositions})` };
  }

  // Perte journalière max atteinte ?
  const dailyLossPercent = Math.abs(state.dailyPnlSol) / CONFIG.risk.initialCapital;
  if (state.dailyPnlSol < 0 && dailyLossPercent >= CONFIG.risk.maxDailyLoss) {
    // Mettre en pause
    state.isPaused = true;
    state.pauseUntil = Date.now() + CONFIG.risk.pauseDuration;
    logger.warn('RISK', `Perte journalière max atteinte (${(dailyLossPercent * 100).toFixed(1)}%). Pause de ${CONFIG.risk.pauseDuration / 60_000} min.`);
    notifyRiskAlert(
      state.dailyPnlPercent,
      `Perte journalière de ${(dailyLossPercent * 100).toFixed(1)}% — Bot en pause pendant 1h`
    );
    return { allowed: false, reason: 'Perte journalière max atteinte — pause' };
  }

  // Capital suffisant ?
  const deployable = getDeployableCapital(state);
  if (deployable < 0.005) {
    return { allowed: false, reason: 'Capital déployable insuffisant' };
  }

  return { allowed: true };
}

/**
 * Calcule la taille de la position en SOL basée sur le score
 */
export function calculatePositionSize(
  analysis: TokenAnalysis,
  state: BotState
): number {
  const deployable = getDeployableCapital(state);

  let sizePercent: number;

  if (analysis.score >= 60) {
    sizePercent = CONFIG.risk.positionSizes.high;
  } else if (analysis.score >= 50) {
    sizePercent = CONFIG.risk.positionSizes.medium;
  } else {
    sizePercent = CONFIG.risk.positionSizes.low;
  }

  let positionSize = deployable * sizePercent;

  // Ajustements dynamiques

  // Si on a déjà des pertes aujourd'hui, réduire la taille
  if (state.dailyPnlSol < 0) {
    const lossRatio = Math.abs(state.dailyPnlSol) / CONFIG.risk.initialCapital;
    const reduction = 1 - lossRatio; // Plus on perd, plus on réduit
    positionSize *= Math.max(0.5, reduction); // Minimum 50% de la taille normale
  }

  // Si on a des gains, augmenter légèrement (Kelly simplifié)
  if (state.dailyPnlSol > 0 && state.dailyWinCount > 2) {
    const winRate = state.dailyWinCount / Math.max(1, state.dailyTradeCount);
    if (winRate > 0.6) {
      positionSize *= 1.1; // +10% si winrate > 60%
    }
  }

  // Floor et cap
  positionSize = Math.max(0.003, positionSize);     // Minimum 0.003 SOL (~micro-trade)
  positionSize = Math.min(deployable * 0.15, positionSize); // Max 15% du capital déployable

  logger.info(
    'RISK',
    `Position calculée pour ${analysis.token.symbol} : ${positionSize.toFixed(4)} SOL ` +
    `(score: ${analysis.score}, déployable: ${deployable.toFixed(4)} SOL)`
  );

  return positionSize;
}

/**
 * Décide s'il faut acheter un token basé sur l'analyse
 */
export function shouldBuy(
  analysis: TokenAnalysis,
  state: BotState
): TradeOrder | null {
  // Score insuffisant
  if (analysis.confidence === 'ignore' || analysis.confidence === 'watch') {
    return null;
  }

  // Vérifier si on peut ouvrir
  const check = canOpenPosition(state);
  if (!check.allowed) {
    logger.info('RISK', `Achat refusé pour ${analysis.token.symbol} : ${check.reason}`);
    return null;
  }

  // Vérifier qu'on n'a pas déjà ce token
  const alreadyOwned = state.openPositions.some(
    (p) => p.mintAddress === analysis.token.mintAddress
  );
  if (alreadyOwned) {
    return null;
  }

  // Calculer la taille
  const positionSize = calculatePositionSize(analysis, state);

  const order: TradeOrder = {
    type: 'buy',
    mintAddress: analysis.token.mintAddress,
    symbol: analysis.token.symbol,
    amountSol: positionSize,
    reason: `Score ${analysis.score}/100 (${analysis.confidence})`,
    priority: analysis.score >= 55 ? 'high' : 'normal',
  };

  return order;
}

/**
 * Met à jour le capital disponible après sync avec la blockchain
 */
export async function syncCapital(state: BotState): Promise<void> {
  const balance = await getSOLBalance();
  state.totalCapitalSol = balance;
  state.availableCapitalSol = balance - state.openPositions.reduce(
    (sum, p) => sum + p.entryAmountSol * (p.remainingPercent / 100),
    0
  );
}
