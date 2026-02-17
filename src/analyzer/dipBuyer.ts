import { CONFIG } from '../config';
import { TokenAnalysis, TradeOrder, BotState } from '../types';
import { logger } from '../utils/logger';
import { fetchCurrentPrice } from '../scanner/dexscreener';
import { shouldBuy, calculatePositionSize } from '../risk/manager';
import { notifyDetection } from '../notifier/discord';

// ============================================
// DIP BUYER — Acheter dans les creux, pas les pics
// ============================================
// Principe : Quand un token a un bon score, au lieu de l'acheter
// immédiatement (souvent au sommet), on le surveille et on attend
// qu'il fasse un dip (baisse) puis qu'il commence à remonter.
// On achète sur la confirmation du rebond.

interface WatchedToken {
  analysis: TokenAnalysis;
  addedAt: number;           // Quand on l'a ajouté à la watchlist
  highestPrice: number;      // Prix le plus haut observé
  lowestSinceHigh: number;   // Prix le plus bas depuis le dernier pic
  currentPrice: number;      // Prix actuel
  lastCheck: number;         // Dernier check de prix
  dipDetected: boolean;      // Un dip suffisant a été détecté
  dipPercent: number;        // % de baisse depuis le pic
  state: 'watching' | 'dip_detected' | 'waiting_rebound' | 'buy_signal' | 'expired' | 'abandoned';
}

// Watchlist active
const watchlist = new Map<string, WatchedToken>();
let dipCheckInterval: NodeJS.Timeout | null = null;

/**
 * Démarre le système de dip buying
 */
export function startDipBuyer(
  state: BotState,
  onBuySignal: (analysis: TokenAnalysis) => Promise<void>
): void {
  if (dipCheckInterval) return;

  logger.info('ANALYZER', `Dip Buyer démarré (check: ${CONFIG.dipBuyer.checkInterval / 1000}s, dip min: ${CONFIG.dipBuyer.minDipPercent}%)`);

  dipCheckInterval = setInterval(async () => {
    await checkWatchlist(state, onBuySignal);
  }, CONFIG.dipBuyer.checkInterval);
}

/**
 * Arrête le dip buyer
 */
export function stopDipBuyer(): void {
  if (dipCheckInterval) {
    clearInterval(dipCheckInterval);
    dipCheckInterval = null;
  }
}

/**
 * Ajoute un token à la watchlist pour surveiller un dip
 */
export async function addToWatchlist(analysis: TokenAnalysis): Promise<void> {
  const mint = analysis.token.mintAddress;

  // Déjà dans la watchlist ?
  if (watchlist.has(mint)) return;

  // Watchlist pleine ?
  if (watchlist.size >= CONFIG.dipBuyer.maxWatchlistSize) {
    // Retirer le plus ancien
    let oldestKey = '';
    let oldestTime = Infinity;
    for (const [key, val] of watchlist) {
      if (val.addedAt < oldestTime) {
        oldestTime = val.addedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) watchlist.delete(oldestKey);
  }

  // Récupérer le prix actuel comme référence
  const currentPrice = await fetchCurrentPrice(mint);
  if (!currentPrice || currentPrice === 0) return;

  const watched: WatchedToken = {
    analysis,
    addedAt: Date.now(),
    highestPrice: currentPrice,
    lowestSinceHigh: currentPrice,
    currentPrice,
    lastCheck: Date.now(),
    dipDetected: false,
    dipPercent: 0,
    state: 'watching',
  };

  watchlist.set(mint, watched);

  logger.info(
    'ANALYZER',
    `🔍 ${analysis.token.symbol} ajouté à la watchlist (score: ${analysis.score}, prix: ${currentPrice.toFixed(12)} SOL) — en attente de dip`
  );

  await notifyDetection(
    analysis.token.symbol,
    mint,
    analysis.score,
    [...analysis.reasons, '⏳ En surveillance — attente de dip pour achat']
  );
}

/**
 * Vérifie tous les tokens de la watchlist
 */
async function checkWatchlist(
  state: BotState,
  onBuySignal: (analysis: TokenAnalysis) => Promise<void>
): Promise<void> {
  for (const [mint, watched] of watchlist) {
    try {
      // Token expiré ?
      if (Date.now() - watched.addedAt > CONFIG.dipBuyer.maxWatchDuration) {
        logger.info('ANALYZER', `⏰ ${watched.analysis.token.symbol} : durée de surveillance dépassée → retiré`);
        watched.state = 'expired';
        watchlist.delete(mint);
        continue;
      }

      // Récupérer le prix actuel
      const price = await fetchCurrentPrice(mint);
      if (!price || price === 0) continue;

      watched.currentPrice = price;
      watched.lastCheck = Date.now();

      // Mettre à jour le plus haut
      if (price > watched.highestPrice) {
        watched.highestPrice = price;
        watched.lowestSinceHigh = price; // Reset le point bas
      }

      // Mettre à jour le plus bas depuis le pic
      if (price < watched.lowestSinceHigh) {
        watched.lowestSinceHigh = price;
      }

      // Calculer le % de dip depuis le pic
      const dipFromHigh = ((watched.highestPrice - watched.lowestSinceHigh) / watched.highestPrice) * 100;
      watched.dipPercent = dipFromHigh;

      // ─── Machine à états ───

      switch (watched.state) {
        case 'watching':
          // On attend que le prix baisse suffisamment
          if (dipFromHigh >= CONFIG.dipBuyer.maxDipPercent) {
            // Trop de baisse → probable dump, abandonner
            logger.warn('ANALYZER', `${watched.analysis.token.symbol} : dip trop profond (-${dipFromHigh.toFixed(1)}%) → dump probable, abandonné`);
            watched.state = 'abandoned';
            watchlist.delete(mint);
          } else if (dipFromHigh >= CONFIG.dipBuyer.minDipPercent) {
            // Dip suffisant détecté !
            watched.dipDetected = true;
            watched.state = 'waiting_rebound';
            logger.info(
              'ANALYZER',
              `📉 ${watched.analysis.token.symbol} : DIP détecté (-${dipFromHigh.toFixed(1)}%) — en attente de rebond`
            );
          }
          break;

        case 'waiting_rebound':
          // Vérifier si le prix remonte depuis le point bas
          if (dipFromHigh >= CONFIG.dipBuyer.maxDipPercent) {
            logger.warn('ANALYZER', `${watched.analysis.token.symbol} : dip continue → abandon`);
            watched.state = 'abandoned';
            watchlist.delete(mint);
            break;
          }

          const reboundFromLow = ((price - watched.lowestSinceHigh) / watched.lowestSinceHigh) * 100;

          if (reboundFromLow >= CONFIG.dipBuyer.reboundConfirmPercent) {
            // Rebond détecté — mais on vérifie une dernière fois que c'est solide
            // Attendre 2s et re-checker
            await new Promise(r => setTimeout(r, 2000));
            const confirmPrice = await fetchCurrentPrice(mint);
            
            if (!confirmPrice || confirmPrice <= watched.lowestSinceHigh) {
              // Faux rebond → continuer à attendre
              logger.info('ANALYZER', `${watched.analysis.token.symbol} : faux rebond, prix retombé → on continue d'attendre`);
              break;
            }

            const confirmedRebound = ((confirmPrice - watched.lowestSinceHigh) / watched.lowestSinceHigh) * 100;
            if (confirmedRebound < CONFIG.dipBuyer.reboundConfirmPercent) {
              logger.info('ANALYZER', `${watched.analysis.token.symbol} : rebond non confirmé (${confirmedRebound.toFixed(1)}%) → attente`);
              break;
            }

            // Le prix remonte ! Signal d'achat confirmé
            watched.state = 'buy_signal';
            logger.success(
              'ANALYZER',
              `🎯 ${watched.analysis.token.symbol} : REBOND CONFIRMÉ (+${confirmedRebound.toFixed(1)}% depuis le creux, vérifié 2x) → SIGNAL D'ACHAT`
            );
            await onBuySignal(watched.analysis);
            watchlist.delete(mint);
          }
          break;
      }

    } catch (err) {
      // Erreur silencieuse pour ne pas bloquer les autres tokens
    }
  }
}

/**
 * Retourne le nombre de tokens en surveillance
 */
export function getWatchlistSize(): number {
  return watchlist.size;
}

/**
 * Retourne les tokens actuellement surveillés
 */
export function getWatchlistInfo(): Array<{
  symbol: string;
  score: number;
  state: string;
  dipPercent: number;
  watchDurationSec: number;
}> {
  return Array.from(watchlist.values()).map((w) => ({
    symbol: w.analysis.token.symbol,
    score: w.analysis.score,
    state: w.state,
    dipPercent: w.dipPercent,
    watchDurationSec: Math.round((Date.now() - w.addedAt) / 1000),
  }));
}
