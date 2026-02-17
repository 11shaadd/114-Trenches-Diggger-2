import WebSocket from 'ws';
import axios from 'axios';
import { CONFIG } from '../config';
import { DetectedToken } from '../types';
import { logger } from '../utils/logger';

// ============================================
// PUMP.FUN SCANNER — Tokens en temps réel
// ============================================

const PUMPFUN_WS_URL = 'wss://pumpportal.fun/api/data';
const PUMPFUN_API = 'https://frontend-api-v2.pump.fun';

type TokenCallback = (token: DetectedToken) => void;

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 10;
const RECONNECT_DELAY = 5_000; // 5 secondes

// Cache pour éviter de traiter le même token plusieurs fois
const processedTokens = new Set<string>();

/**
 * Démarre la connexion WebSocket vers Pump.fun
 * Appelle le callback pour chaque nouveau token détecté
 */
export function startPumpFunScanner(onToken: TokenCallback): void {
  connectWebSocket(onToken);
}

function connectWebSocket(onToken: TokenCallback): void {
  try {
    ws = new WebSocket(PUMPFUN_WS_URL);

    ws.on('open', () => {
      logger.success('SCANNER', 'Connecté au WebSocket Pump.fun');
      reconnectAttempts = 0;

      // S'abonner aux nouveaux tokens créés
      ws!.send(JSON.stringify({
        method: 'subscribeNewToken',
      }));

      // S'abonner aussi aux trades récents (pour détecter les tokens qui prennent du volume)
      ws!.send(JSON.stringify({
        method: 'subscribeTokenTrade',
      }));
    });

    ws.on('message', async (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Nouveau token créé
        if (msg.txType === 'create' && msg.mint) {
          // On attend un peu pour laisser le token mûrir (on vise semi-early)
          const mintAddress = msg.mint;

          if (processedTokens.has(mintAddress)) return;

          // Programmer la vérification après le délai minimum (5 min)
          setTimeout(async () => {
            await checkPumpFunToken(mintAddress, onToken);
          }, CONFIG.scanner.minTokenAge * 1000);

          logger.info('SCANNER', `Pump.fun : nouveau token ${msg.symbol || mintAddress.slice(0, 8)}... — vérification dans ${CONFIG.scanner.minTokenAge / 60} min`);
        }

        // Trade sur un token existant — peut signaler un token qui prend de l'ampleur
        if (msg.txType === 'buy' && msg.mint && !processedTokens.has(msg.mint)) {
          // Si le volume SOL du trade est significatif, on vérifie le token
          if (msg.solAmount && msg.solAmount > 0.5) {
            await checkPumpFunToken(msg.mint, onToken);
          }
        }
      } catch {
        // Message non parseable, on ignore
      }
    });

    ws.on('close', () => {
      logger.warn('SCANNER', 'WebSocket Pump.fun déconnecté');
      attemptReconnect(onToken);
    });

    ws.on('error', (err) => {
      logger.error('SCANNER', 'Erreur WebSocket Pump.fun', err);
    });
  } catch (err) {
    logger.error('SCANNER', 'Impossible de se connecter à Pump.fun', err);
    attemptReconnect(onToken);
  }
}

function attemptReconnect(onToken: TokenCallback): void {
  if (reconnectAttempts >= MAX_RECONNECT) {
    logger.error('SCANNER', `Pump.fun : max de ${MAX_RECONNECT} tentatives de reconnexion atteint`);
    return;
  }

  reconnectAttempts++;
  const delay = RECONNECT_DELAY * reconnectAttempts;
  logger.info('SCANNER', `Pump.fun : reconnexion dans ${delay / 1000}s (tentative ${reconnectAttempts}/${MAX_RECONNECT})`);

  setTimeout(() => connectWebSocket(onToken), delay);
}

/**
 * Vérifie un token Pump.fun et l'envoie au callback s'il passe les filtres
 */
async function checkPumpFunToken(mintAddress: string, onToken: TokenCallback): Promise<void> {
  if (processedTokens.has(mintAddress)) return;
  processedTokens.add(mintAddress);

  // Nettoyage périodique du cache (garder max 5000 entrées)
  if (processedTokens.size > 5000) {
    const arr = Array.from(processedTokens);
    arr.splice(0, 2500).forEach((t) => processedTokens.delete(t));
  }

  try {
    // Récupérer les données du token via l'API Pump.fun
    const response = await axios.get(`${PUMPFUN_API}/coins/${mintAddress}`, {
      timeout: 10_000,
    });

    const data = response.data;
    if (!data) return;

    const createdAt = data.created_timestamp || Date.now();
    const ageMs = Date.now() - createdAt;
    const ageSec = ageMs / 1000;

    // Filtres d'âge
    if (ageSec < CONFIG.scanner.minTokenAge) return;
    if (ageSec > CONFIG.scanner.maxTokenAge) return;

    // Calculer la liquidité approximative
    const virtualSolReserves = data.virtual_sol_reserves
      ? data.virtual_sol_reserves / 1e9
      : 0;

    if (virtualSolReserves < CONFIG.scanner.minLiquidity) return;

    // Construire l'objet token
    const token: DetectedToken = {
      mintAddress,
      name: data.name || 'Unknown',
      symbol: data.symbol || '???',
      priceUsd: data.usd_market_cap
        ? data.usd_market_cap / (data.total_supply || 1e9)
        : 0,
      priceSol: virtualSolReserves / (data.virtual_token_reserves
        ? data.virtual_token_reserves / 1e6
        : 1),
      marketCap: data.usd_market_cap || 0,
      liquiditySol: virtualSolReserves,
      volume5m: 0,   // Pump.fun ne donne pas directement, sera complété via DexScreener
      volume1h: 0,
      txCount5m: data.reply_count || 0,  // Approximation
      buyCount5m: 0,
      sellCount5m: 0,
      holderCount: 0,
      mintAuthorityRevoked: data.mint_authority === null,
      freezeAuthorityRevoked: data.freeze_authority === null,
      lpBurned: false,
      createdAt,
      detectedAt: Date.now(),
      source: 'pumpfun',
    };

    // Compléter avec DexScreener pour avoir les métriques de trading
    try {
      const dexRes = await axios.get(
        `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
        { timeout: 5_000 }
      );
      const pair = dexRes.data?.pairs?.[0];
      if (pair) {
        token.volume5m = pair.volume?.m5 || 0;
        token.volume1h = pair.volume?.h1 || 0;
        token.txCount5m = (pair.txns?.m5?.buys || 0) + (pair.txns?.m5?.sells || 0);
        token.buyCount5m = pair.txns?.m5?.buys || 0;
        token.sellCount5m = pair.txns?.m5?.sells || 0;
        token.priceSol = parseFloat(pair.priceNative || '0') || token.priceSol;
        token.priceUsd = parseFloat(pair.priceUsd || '0') || token.priceUsd;
        token.pairAddress = pair.pairAddress;
      }
    } catch {
      // Pas grave si DexScreener ne répond pas, on continue avec les données Pump.fun
    }

    // Filtre transactions minimum
    if (token.txCount5m < CONFIG.scanner.minRecentTxCount) return;

    logger.info('SCANNER', `Pump.fun : ${token.symbol} passe les filtres (liq: ${token.liquiditySol.toFixed(1)} SOL, tx5m: ${token.txCount5m})`);
    onToken(token);
  } catch (err) {
    // Token introuvable ou API down, on ignore silencieusement
  }
}

/**
 * Arrête le scanner Pump.fun
 */
export function stopPumpFunScanner(): void {
  if (ws) {
    ws.close();
    ws = null;
  }
  logger.info('SCANNER', 'Scanner Pump.fun arrêté');
}
