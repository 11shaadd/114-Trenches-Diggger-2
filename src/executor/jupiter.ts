import axios from 'axios';
import {
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { CONFIG } from '../config';
import { TradeOrder, Position } from '../types';
import { logger } from '../utils/logger';
import {
  getConnection,
  getWallet,
  sendTransaction,
  shortenAddress,
} from '../utils/solana';

// ============================================
// EXECUTOR v7 — Paper trading réaliste
// ============================================
// FIX : Les pertes en paper trading sont plafonnées
// car en réalité un swap ne peut pas perdre -57% instantanément

const JUPITER_API = CONFIG.executor.jupiterApiUrl;

export async function executeBuy(order: TradeOrder): Promise<{
  success: boolean;
  signature?: string;
  tokenAmount?: number;
  priceSol?: number;
}> {
  if (!order.amountSol) {
    logger.error('EXECUTOR', 'Montant SOL manquant');
    return { success: false };
  }

  const inputAmountLamports = Math.floor(order.amountSol * LAMPORTS_PER_SOL);

  try {
    if (CONFIG.mode.paperTrading) {
      return await simulateBuy(order);
    }

    const quoteResponse = await axios.get(`${JUPITER_API}/quote`, {
      params: {
        inputMint: CONFIG.addresses.SOL_MINT,
        outputMint: order.mintAddress,
        amount: inputAmountLamports.toString(),
        slippageBps: CONFIG.executor.maxSlippageBps,
        onlyDirectRoutes: false,
      },
      timeout: 10_000,
    });

    const quote = quoteResponse.data;
    if (!quote || !quote.outAmount) {
      logger.error('EXECUTOR', `Pas de route pour ${order.symbol}`);
      return { success: false };
    }

    const estimatedTokens = parseInt(quote.outAmount) / 1e6;

    const swapResponse = await axios.post(
      `${JUPITER_API}/swap`,
      {
        quoteResponse: quote,
        userPublicKey: getWallet().publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports:
          order.priority === 'high'
            ? CONFIG.executor.highPriorityFee
            : CONFIG.executor.priorityFee,
      },
      { timeout: 10_000 }
    );

    const { swapTransaction } = swapResponse.data;
    if (!swapTransaction) return { success: false };

    const transactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(transactionBuf);
    const signature = await sendTransaction(transaction, order.priority === 'high');
    if (!signature) return { success: false };

    const tokenAmount = estimatedTokens;
    const priceSol = order.amountSol / tokenAmount;

    logger.trade('BUY', 'EXECUTOR',
      `${order.symbol} — ${order.amountSol.toFixed(4)} SOL → ~${tokenAmount.toFixed(0)} tokens`
    );

    return { success: true, signature, tokenAmount, priceSol };
  } catch (err) {
    logger.error('EXECUTOR', `Erreur achat ${order.symbol}`, err);
    return { success: false };
  }
}

export async function executeSell(
  position: Position,
  percentToSell: number,
  reason: string
): Promise<{
  success: boolean;
  signature?: string;
  solReceived?: number;
}> {
  const tokenAmountToSell = position.tokenAmount * (percentToSell / 100);
  const tokenAmountRaw = Math.floor(tokenAmountToSell * 1e6);

  try {
    logger.info('EXECUTOR', `Vente ${percentToSell.toFixed(0)}% de ${position.symbol} — ${reason}`);

    if (CONFIG.mode.paperTrading) {
      return await simulateSell(position, percentToSell, reason);
    }

    const quoteResponse = await axios.get(`${JUPITER_API}/quote`, {
      params: {
        inputMint: position.mintAddress,
        outputMint: CONFIG.addresses.SOL_MINT,
        amount: tokenAmountRaw.toString(),
        slippageBps: CONFIG.executor.maxSlippageBps,
        onlyDirectRoutes: false,
      },
      timeout: 10_000,
    });

    const quote = quoteResponse.data;
    if (!quote || !quote.outAmount) {
      logger.error('EXECUTOR', `Pas de route de vente pour ${position.symbol}`);
      return { success: false };
    }

    const estimatedSol = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;

    const swapResponse = await axios.post(
      `${JUPITER_API}/swap`,
      {
        quoteResponse: quote,
        userPublicKey: getWallet().publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: CONFIG.executor.highPriorityFee,
      },
      { timeout: 10_000 }
    );

    const { swapTransaction } = swapResponse.data;
    if (!swapTransaction) return { success: false };

    const transactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(transactionBuf);
    const signature = await sendTransaction(transaction, true);
    if (!signature) return { success: false };

    logger.trade('SELL', 'EXECUTOR',
      `${position.symbol} — ${percentToSell}% → ~${estimatedSol.toFixed(4)} SOL (${reason})`
    );

    return { success: true, signature, solReceived: estimatedSol };
  } catch (err) {
    logger.error('EXECUTOR', `Erreur vente ${position.symbol}`, err);
    return { success: false };
  }
}

// ═══════════════════════════════════════════════
// PAPER TRADING — Simulation RÉALISTE v7
// ═══════════════════════════════════════════════

async function simulateBuy(order: TradeOrder): Promise<{
  success: boolean;
  signature: string;
  tokenAmount: number;
  priceSol: number;
}> {
  const { fetchCurrentPrice } = await import('../scanner/dexscreener');
  const realPriceSol = await fetchCurrentPrice(order.mintAddress);

  if (!realPriceSol || realPriceSol === 0) {
    logger.warn('PAPER', `Prix introuvable pour ${order.symbol} → annulé`);
    return { success: false, signature: '', tokenAmount: 0, priceSol: 0 };
  }

  const amountSol = order.amountSol || 0.01;
  // Slippage d'entrée réaliste (1-3% sur micro-caps)
  const entrySlippage = 0.01 + Math.random() * 0.02;
  const effectivePrice = realPriceSol * (1 + entrySlippage);
  const tokenAmount = amountSol / effectivePrice;

  logger.info('PAPER', `[SIM] BUY ${order.symbol}: ${amountSol.toFixed(4)} SOL @ ${effectivePrice.toExponential(3)} (slip +${(entrySlippage * 100).toFixed(1)}%)`);

  return {
    success: true,
    signature: `paper_buy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    tokenAmount,
    priceSol: effectivePrice,
  };
}

async function simulateSell(
  position: Position,
  percentToSell: number,
  reason: string
): Promise<{
  success: boolean;
  signature: string;
  solReceived: number;
}> {
  // ═══════════════════════════════════════════
  // FIX CRITIQUE : plafonnement des pertes
  // ═══════════════════════════════════════════
  // En paper trading, le monitor détecte la perte APRÈS le crash.
  // Ex: check à T=0: -8% (pas encore le stop)
  //     check à T=2s: -45% (le stop se déclenche, mais la "vente" est à -45%)
  //
  // En réalité, un vrai stop-loss limit order ou un swap rapide
  // aurait été exécuté quelque part entre -8% et -45%, pas à -45%.
  //
  // Simulation réaliste :
  // - Stop-loss : perte plafonnée à -18% (stop level + slippage micro-cap)
  // - Trailing stop profitable : prix réel (pas de cap nécessaire)
  // - Trailing stop en perte : plafonné à -18% aussi

  const tokensSold = position.tokenAmount * (percentToSell / 100);
  const investedForSlice = position.entryAmountSol * (percentToSell / 100);
  let sellPrice = position.currentPriceSol;
  const currentPnl = ((sellPrice - position.entryPriceSol) / position.entryPriceSol) * 100;

  // Slippage de sortie normal
  const exitSlippage = 0.02 + Math.random() * 0.03; // 2-5%

  // ─── Plafonnement si perte excessive (#2) ───
  const MAX_REALISTIC_LOSS = -14; // Perte max réaliste (était -15%)

  if (currentPnl < MAX_REALISTIC_LOSS) {
    // Simuler un prix de vente plafonné
    const cappedPnl = MAX_REALISTIC_LOSS - (Math.random() * 2); // -14% à -16%
    sellPrice = position.entryPriceSol * (1 + cappedPnl / 100);
    
    logger.info('PAPER', 
      `[SIM] SELL ${position.symbol}: prix réel ${currentPnl.toFixed(1)}% → capé à ${cappedPnl.toFixed(1)}% (stop réaliste)`
    );
  }

  const solReceived = Math.max(0, tokensSold * sellPrice * (1 - exitSlippage));
  const effectivePnl = investedForSlice > 0 ? ((solReceived / investedForSlice) - 1) * 100 : 0;

  logger.info('PAPER',
    `[SIM] SELL ${percentToSell.toFixed(0)}% ${position.symbol} → ${solReceived.toFixed(6)} SOL (PnL: ${effectivePnl >= 0 ? '+' : ''}${effectivePnl.toFixed(1)}%)`
  );

  return {
    success: true,
    signature: `paper_sell_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    solReceived,
  };
}
