import axios from 'axios';
import { CONFIG } from '../config';
import { DetectedToken } from '../types';
import { logger } from '../utils/logger';

// ============================================
// DEXSCREENER SCANNER — Tokens récents Solana
// ============================================

const DEXSCREENER_API = 'https://api.dexscreener.com';

/**
 * Récupère les paires récemment créées sur Solana
 */
export async function fetchRecentTokens(): Promise<DetectedToken[]> {
  try {
    // Endpoint : profils de tokens les plus récents sur Solana
    const response = await axios.get(
      `${DEXSCREENER_API}/token-profiles/latest/v1`,
      { timeout: 10_000 }
    );

    const pairs = response.data || [];
    const tokens: DetectedToken[] = [];

    for (const pair of pairs) {
      // Filtrer uniquement Solana
      if (pair.chainId !== 'solana') continue;

      // On récupère les détails complets de la paire
      try {
        const detailRes = await axios.get(
          `${DEXSCREENER_API}/latest/dex/tokens/${pair.tokenAddress}`,
          { timeout: 10_000 }
        );

        const pairData = detailRes.data?.pairs?.[0];
        if (!pairData) continue;

        const createdAt = pairData.pairCreatedAt || 0;
        const ageMs = Date.now() - createdAt;
        const ageMin = ageMs / 60_000;

        // Filtre d'âge : entre 5 min et 60 min
        if (ageMin < CONFIG.scanner.minTokenAge / 60) continue;
        if (ageMin > CONFIG.scanner.maxTokenAge / 60) continue;

        // Filtre de liquidité
        const liquiditySol = (pairData.liquidity?.usd || 0) / (pairData.priceNative ? parseFloat(pairData.priceNative) : 150);
        if (liquiditySol < CONFIG.scanner.minLiquidity) continue;

        const token: DetectedToken = {
          mintAddress: pair.tokenAddress,
          name: pairData.baseToken?.name || 'Unknown',
          symbol: pairData.baseToken?.symbol || '???',
          priceUsd: parseFloat(pairData.priceUsd || '0'),
          priceSol: parseFloat(pairData.priceNative || '0'),
          marketCap: pairData.marketCap || pairData.fdv || 0,
          liquiditySol,
          volume5m: pairData.volume?.m5 || 0,
          volume1h: pairData.volume?.h1 || 0,
          txCount5m: (pairData.txns?.m5?.buys || 0) + (pairData.txns?.m5?.sells || 0),
          buyCount5m: pairData.txns?.m5?.buys || 0,
          sellCount5m: pairData.txns?.m5?.sells || 0,
          holderCount: 0,  // DexScreener ne donne pas cette info, on la complétera
          mintAuthorityRevoked: true,   // À vérifier via RPC
          freezeAuthorityRevoked: true, // À vérifier via RPC
          lpBurned: false,
          createdAt,
          detectedAt: Date.now(),
          source: 'dexscreener',
          pairAddress: pairData.pairAddress,
        };

        // Filtre nombre de transactions
        if (token.txCount5m < CONFIG.scanner.minRecentTxCount) continue;

        tokens.push(token);
      } catch {
        // Token individuel qui échoue, on continue
        continue;
      }
    }

    if (tokens.length > 0) {
      logger.info('SCANNER', `DexScreener : ${tokens.length} tokens passent les filtres`);
    }

    return tokens;
  } catch (err) {
    logger.error('SCANNER', 'Erreur API DexScreener', err);
    return [];
  }
}

/**
 * Récupère les données à jour d'un token spécifique
 */
export async function fetchTokenData(mintAddress: string): Promise<DetectedToken | null> {
  try {
    const response = await axios.get(
      `${DEXSCREENER_API}/latest/dex/tokens/${mintAddress}`,
      { timeout: 10_000 }
    );

    const pair = response.data?.pairs?.[0];
    if (!pair) return null;

    return {
      mintAddress,
      name: pair.baseToken?.name || 'Unknown',
      symbol: pair.baseToken?.symbol || '???',
      priceUsd: parseFloat(pair.priceUsd || '0'),
      priceSol: parseFloat(pair.priceNative || '0'),
      marketCap: pair.marketCap || pair.fdv || 0,
      liquiditySol: (pair.liquidity?.usd || 0) / 150,  // approximation
      volume5m: pair.volume?.m5 || 0,
      volume1h: pair.volume?.h1 || 0,
      txCount5m: (pair.txns?.m5?.buys || 0) + (pair.txns?.m5?.sells || 0),
      buyCount5m: pair.txns?.m5?.buys || 0,
      sellCount5m: pair.txns?.m5?.sells || 0,
      holderCount: 0,
      mintAuthorityRevoked: true,
      freezeAuthorityRevoked: true,
      lpBurned: false,
      createdAt: pair.pairCreatedAt || 0,
      detectedAt: Date.now(),
      source: 'dexscreener',
      pairAddress: pair.pairAddress,
    };
  } catch (err) {
    logger.error('SCANNER', `Erreur récupération données ${mintAddress}`, err);
    return null;
  }
}

/**
 * Récupère le prix actuel d'un token en SOL
 */
export async function fetchCurrentPrice(mintAddress: string): Promise<number | null> {
  try {
    const response = await axios.get(
      `${DEXSCREENER_API}/latest/dex/tokens/${mintAddress}`,
      { timeout: 5_000 }
    );

    const pair = response.data?.pairs?.[0];
    if (!pair) return null;

    return parseFloat(pair.priceNative || '0');
  } catch {
    return null;
  }
}
