import fs from 'fs';
import path from 'path';
import { TradeRecord } from '../types';
import { logger } from './logger';

// ============================================
// STORAGE — Sauvegarde locale des trades
// ============================================

const DATA_DIR = path.join(process.cwd(), 'data');
const TRADES_FILE = path.join(DATA_DIR, 'trades.json');

// S'assurer que le dossier existe
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Charge l'historique des trades depuis le fichier JSON
 */
export function loadTrades(): TradeRecord[] {
  try {
    if (!fs.existsSync(TRADES_FILE)) {
      return [];
    }
    const raw = fs.readFileSync(TRADES_FILE, 'utf-8');
    return JSON.parse(raw) as TradeRecord[];
  } catch (err) {
    logger.error('BOT', 'Erreur chargement historique trades', err);
    return [];
  }
}

/**
 * Sauvegarde un nouveau trade dans l'historique
 */
export function saveTrade(trade: TradeRecord): void {
  try {
    const trades = loadTrades();
    trades.push(trade);
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
    logger.info('BOT', `Trade sauvegardé : ${trade.symbol} (${trade.pnlPercent > 0 ? '+' : ''}${trade.pnlPercent.toFixed(1)}%)`);
  } catch (err) {
    logger.error('BOT', 'Erreur sauvegarde trade', err);
  }
}

/**
 * Calcule les statistiques globales de performance
 */
export function getPerformanceStats(): {
  totalTrades: number;
  winRate: number;
  totalPnlSol: number;
  avgPnlPercent: number;
  bestTrade: number;
  worstTrade: number;
} {
  const trades = loadTrades();

  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      totalPnlSol: 0,
      avgPnlPercent: 0,
      bestTrade: 0,
      worstTrade: 0,
    };
  }

  const wins = trades.filter((t) => t.pnlSol > 0).length;
  const totalPnl = trades.reduce((sum, t) => sum + t.pnlSol, 0);
  const avgPnl = trades.reduce((sum, t) => sum + t.pnlPercent, 0) / trades.length;
  const best = Math.max(...trades.map((t) => t.pnlPercent));
  const worst = Math.min(...trades.map((t) => t.pnlPercent));

  return {
    totalTrades: trades.length,
    winRate: (wins / trades.length) * 100,
    totalPnlSol: totalPnl,
    avgPnlPercent: avgPnl,
    bestTrade: best,
    worstTrade: worst,
  };
}
