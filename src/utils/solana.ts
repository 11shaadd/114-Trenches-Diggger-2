import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  SendTransactionError,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG } from '../config';
import { logger } from './logger';

// ============================================
// SOLANA UTILS — Gestion wallet & transactions
// ============================================

let connection: Connection;
let wallet: Keypair;

/**
 * Initialise la connexion Solana et le wallet
 */
export function initSolana(): { connection: Connection; wallet: Keypair } {
  // Connexion au RPC Helius
  connection = new Connection(CONFIG.solana.rpcUrl, {
    commitment: CONFIG.solana.commitment,
    confirmTransactionInitialTimeout: 30_000,
  });

  // Chargement du wallet depuis la clé privée
  try {
    const decoded = bs58.decode(CONFIG.solana.privateKey);
    wallet = Keypair.fromSecretKey(decoded);
    logger.info('BOT', `Wallet chargé : ${wallet.publicKey.toBase58()}`);
  } catch (err) {
    logger.error('BOT', 'Impossible de charger la clé privée. Vérifie ton .env', err);
    process.exit(1);
  }

  return { connection, wallet };
}

/**
 * Récupère le solde SOL du wallet
 */
export async function getSOLBalance(): Promise<number> {
  try {
    const balance = await connection.getBalance(wallet.publicKey);
    return balance / LAMPORTS_PER_SOL;
  } catch (err) {
    logger.error('BOT', 'Erreur récupération balance SOL', err);
    return 0;
  }
}

/**
 * Récupère le solde d'un token SPL dans le wallet
 */
export async function getTokenBalance(mintAddress: string): Promise<number> {
  try {
    const mint = new PublicKey(mintAddress);
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      wallet.publicKey,
      { mint }
    );

    if (tokenAccounts.value.length === 0) return 0;

    const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount;
    return parseFloat(balance.uiAmount || '0');
  } catch (err) {
    logger.error('BOT', `Erreur récupération balance token ${mintAddress}`, err);
    return 0;
  }
}

/**
 * Envoie une transaction signée avec priority fee
 */
export async function sendTransaction(
  transaction: VersionedTransaction,
  highPriority: boolean = false
): Promise<string | null> {
  try {
    // Signer la transaction
    transaction.sign([wallet]);

    // Envoyer
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true, // Plus rapide pour les memecoins
      maxRetries: CONFIG.executor.maxRetries,
    });

    logger.info('EXECUTOR', `Transaction envoyée : ${signature}`);

    // Attendre la confirmation
    const confirmation = await connection.confirmTransaction(
      {
        signature,
        blockhash: transaction.message.recentBlockhash,
        lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight,
      },
      'confirmed'
    );

    if (confirmation.value.err) {
      logger.error('EXECUTOR', `Transaction échouée : ${signature}`, confirmation.value.err);
      return null;
    }

    logger.success('EXECUTOR', `Transaction confirmée : ${signature}`);
    return signature;
  } catch (err) {
    if (err instanceof SendTransactionError) {
      logger.error('EXECUTOR', `Erreur d'envoi de transaction`, err);
    } else {
      logger.error('EXECUTOR', 'Erreur transaction inconnue', err);
    }
    return null;
  }
}

/**
 * Raccourcit une adresse pour l'affichage
 * Ex: "7xKX...3nFq"
 */
export function shortenAddress(address: string, chars: number = 4): string {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Lien vers Solscan pour une transaction
 */
export function solscanTxUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

/**
 * Lien vers DexScreener pour un token
 */
export function dexScreenerUrl(mintAddress: string): string {
  return `https://dexscreener.com/solana/${mintAddress}`;
}

/**
 * Attend un certain temps (utilitaire)
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exporter les instances pour les autres modules
export function getConnection(): Connection {
  return connection;
}

export function getWallet(): Keypair {
  return wallet;
}
