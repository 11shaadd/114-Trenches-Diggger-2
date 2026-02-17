import axios from 'axios';
import { CONFIG } from '../config';
import { DiscordNotification, Position, TradeRecord } from '../types';
import { logger } from '../utils/logger';
import { shortenAddress, dexScreenerUrl } from '../utils/solana';
import { getPerformanceStats } from '../utils/storage';

// ============================================
// DISCORD NOTIFIER — Notifications en temps réel
// ============================================

// Couleurs Discord (en décimal)
const COLORS = {
  green: 0x00ff88,
  red: 0xff4444,
  yellow: 0xffaa00,
  blue: 0x5599ff,
  purple: 0xaa55ff,
  gray: 0x888888,
};

// Anti-spam : pas plus de 30 messages par minute
let messageCount = 0;
let resetTime = Date.now();

function canSend(): boolean {
  if (Date.now() - resetTime > 60_000) {
    messageCount = 0;
    resetTime = Date.now();
  }
  return messageCount < 30;
}

/**
 * Envoie un message embed Discord via webhook
 */
async function sendEmbed(notification: DiscordNotification): Promise<void> {
  if (!CONFIG.discord.webhookUrl) return;
  if (!canSend()) {
    logger.warn('DISCORD', 'Rate limit atteint, notification ignorée');
    return;
  }

  try {
    const embed: any = {
      title: notification.title,
      description: notification.description,
      color: notification.color,
      timestamp: new Date().toISOString(),
      footer: { text: 'SolSniper Bot' },
    };

    if (notification.fields) {
      embed.fields = notification.fields;
    }

    await axios.post(CONFIG.discord.webhookUrl, {
      embeds: [embed],
    });

    messageCount++;
  } catch (err) {
    logger.error('DISCORD', 'Erreur envoi notification', err);
  }
}

// ─── Notifications spécifiques ───────────────────

/**
 * Token détecté avec un bon score
 */
export async function notifyDetection(
  symbol: string,
  mintAddress: string,
  score: number,
  reasons: string[]
): Promise<void> {
  await sendEmbed({
    type: 'detection',
    title: `🔍 Token détecté : ${symbol}`,
    description: [
      `**Score** : ${score}/100`,
      `**Adresse** : \`${shortenAddress(mintAddress, 6)}\``,
      `**Raisons** :`,
      ...reasons.map((r) => `• ${r}`),
      `\n[Voir sur DexScreener](${dexScreenerUrl(mintAddress)})`,
    ].join('\n'),
    color: score >= 75 ? COLORS.green : COLORS.yellow,
  });
}

/**
 * Achat exécuté
 */
export async function notifyBuy(
  symbol: string,
  mintAddress: string,
  amountSol: number,
  score: number,
  txSignature: string
): Promise<void> {
  await sendEmbed({
    type: 'buy',
    title: `🟢 ACHAT : ${symbol}`,
    description: `Trade exécuté avec succès`,
    color: COLORS.green,
    fields: [
      { name: '💰 Montant', value: `${amountSol.toFixed(4)} SOL`, inline: true },
      { name: '📊 Score', value: `${score}/100`, inline: true },
      { name: '🔗 TX', value: `[Voir sur Solscan](https://solscan.io/tx/${txSignature})`, inline: false },
      { name: '📈 Chart', value: `[DexScreener](${dexScreenerUrl(mintAddress)})`, inline: false },
    ],
  });
}

/**
 * Vente avec profit
 */
export async function notifySellProfit(
  symbol: string,
  pnlPercent: number,
  pnlSol: number,
  reason: string
): Promise<void> {
  await sendEmbed({
    type: 'sell_profit',
    title: `💰 PROFIT : ${symbol}`,
    description: `Position fermée — ${reason}`,
    color: COLORS.green,
    fields: [
      { name: '📈 PNL', value: `+${pnlPercent.toFixed(1)}%`, inline: true },
      { name: '💎 Gain', value: `+${pnlSol.toFixed(4)} SOL`, inline: true },
    ],
  });
}

/**
 * Vente avec perte (stop-loss)
 */
export async function notifySellLoss(
  symbol: string,
  pnlPercent: number,
  pnlSol: number,
  reason: string
): Promise<void> {
  await sendEmbed({
    type: 'sell_loss',
    title: `🔴 PERTE : ${symbol}`,
    description: `Position fermée — ${reason}`,
    color: COLORS.red,
    fields: [
      { name: '📉 PNL', value: `${pnlPercent.toFixed(1)}%`, inline: true },
      { name: '💸 Perte', value: `${pnlSol.toFixed(4)} SOL`, inline: true },
    ],
  });
}

/**
 * Trailing stop déclenché
 */
export async function notifyTrailingStop(
  symbol: string,
  pnlPercent: number,
  pnlSol: number,
  highestPercent: number
): Promise<void> {
  await sendEmbed({
    type: 'trailing',
    title: `🟡 TRAILING STOP : ${symbol}`,
    description: `Le prix est redescendu depuis le pic de +${highestPercent.toFixed(1)}%`,
    color: COLORS.yellow,
    fields: [
      { name: '📈 PNL final', value: `+${pnlPercent.toFixed(1)}%`, inline: true },
      { name: '💎 Gain', value: `+${pnlSol.toFixed(4)} SOL`, inline: true },
      { name: '🏔️ Pic atteint', value: `+${highestPercent.toFixed(1)}%`, inline: true },
    ],
  });
}

/**
 * Résumé périodique (toutes les heures)
 */
export async function notifySummary(
  capitalSol: number,
  openPositions: number,
  dailyPnlSol: number,
  dailyPnlPercent: number,
  dailyTrades: number
): Promise<void> {
  const stats = getPerformanceStats();
  const emoji = dailyPnlSol >= 0 ? '📈' : '📉';

  await sendEmbed({
    type: 'summary',
    title: `📊 Résumé horaire`,
    description: `${emoji} Performance du jour`,
    color: dailyPnlSol >= 0 ? COLORS.blue : COLORS.red,
    fields: [
      { name: '💰 Capital', value: `${capitalSol.toFixed(4)} SOL`, inline: true },
      { name: '📂 Positions', value: `${openPositions} ouvertes`, inline: true },
      { name: '📊 PNL jour', value: `${dailyPnlSol >= 0 ? '+' : ''}${dailyPnlSol.toFixed(4)} SOL (${dailyPnlPercent >= 0 ? '+' : ''}${dailyPnlPercent.toFixed(1)}%)`, inline: false },
      { name: '🔄 Trades jour', value: `${dailyTrades}`, inline: true },
      { name: '🏆 Win rate global', value: `${stats.winRate.toFixed(1)}%`, inline: true },
      { name: '📈 PNL total', value: `${stats.totalPnlSol >= 0 ? '+' : ''}${stats.totalPnlSol.toFixed(4)} SOL`, inline: true },
    ],
  });
}

/**
 * Alerte de risque (perte journalière élevée)
 */
export async function notifyRiskAlert(
  dailyPnlPercent: number,
  message: string
): Promise<void> {
  await sendEmbed({
    type: 'alert',
    title: `⚠️ ALERTE RISQUE`,
    description: message,
    color: COLORS.red,
    fields: [
      { name: '📉 PNL jour', value: `${dailyPnlPercent.toFixed(1)}%`, inline: true },
    ],
  });
}

/**
 * Notification de démarrage du bot
 */
export async function notifyBotStart(
  walletAddress: string,
  capitalSol: number,
  paperMode: boolean
): Promise<void> {
  await sendEmbed({
    type: 'detection',
    title: `🤖 SolSniper Bot démarré`,
    description: paperMode
      ? '📝 Mode PAPER TRADING — aucun vrai SOL utilisé'
      : '💰 Mode RÉEL — trading avec de vrais SOL',
    color: COLORS.blue,
    fields: [
      { name: '👛 Wallet', value: `\`${shortenAddress(walletAddress, 6)}\``, inline: true },
      { name: '💰 Capital', value: `${capitalSol.toFixed(4)} SOL`, inline: true },
    ],
  });
}
