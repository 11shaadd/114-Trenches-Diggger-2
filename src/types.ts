// ============================================
// TYPES — Interfaces partagées du bot
// ============================================

/**
 * Token détecté par le Scanner
 */
export interface DetectedToken {
  // Identifiants
  mintAddress: string;
  name: string;
  symbol: string;

  // Données marché
  priceUsd: number;
  priceSol: number;
  marketCap: number;
  liquiditySol: number;
  volume5m: number;
  volume1h: number;

  // Métriques
  txCount5m: number;
  buyCount5m: number;
  sellCount5m: number;
  holderCount: number;

  // Sécurité
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  lpBurned: boolean;

  // Métadonnées
  createdAt: number;       // timestamp unix en ms
  detectedAt: number;      // quand le scanner l'a trouvé
  source: 'pumpfun' | 'dexscreener';
  pairAddress?: string;    // adresse de la paire sur le DEX
}

/**
 * Résultat de l'analyse (score)
 */
export interface TokenAnalysis {
  token: DetectedToken;
  score: number;              // 0 à 100
  confidence: 'ignore' | 'watch' | 'low' | 'medium' | 'high';

  // Détail des scores par critère
  breakdown: {
    volumeMcapRatio: number;
    buyVsSellRatio: number;
    holderDistribution: number;
    holderGrowth: number;
    devProfile: number;
    liquidityLocked: number;
    momentum?: number;
  };

  // Raisons principales
  reasons: string[];
}

/**
 * Position ouverte (trade en cours)
 */
export interface Position {
  id: string;                  // identifiant unique
  mintAddress: string;
  symbol: string;
  name: string;

  // Entrée
  entryPriceSol: number;
  entryAmountSol: number;      // combien de SOL investis
  tokenAmount: number;         // combien de tokens achetés
  entryTime: number;           // timestamp
  entryTxSignature: string;
  score: number;               // score au moment de l'achat

  // État actuel
  currentPriceSol: number;
  highestPriceSol: number;     // plus haut atteint (pour trailing stop)
  pnlPercent: number;          // profit/perte en %
  pnlSol: number;              // profit/perte en SOL

  // Gestion des paliers
  remainingPercent: number;    // % de la position encore ouverte (100 au début)
  takeProfitStage: number;     // 0 = aucun TP, 1 = TP1 déclenché, etc.
  trailingStopActive: boolean;

  // Runner mode
  isRunner?: boolean;           // true si promu en mode runner
  runnerPromotedAt?: number;    // timestamp de la promotion

  // Status
  status: 'open' | 'partial' | 'closed';
  closeReason?: 'stop_loss' | 'take_profit' | 'trailing_stop' | 'timeout' | 'dead_volume' | 'manual';
}

/**
 * Historique d'un trade complété
 */
export interface TradeRecord {
  id: string;
  mintAddress: string;
  symbol: string;

  // Résumé
  entryPriceSol: number;
  exitPriceSol: number;
  investedSol: number;
  returnedSol: number;
  pnlSol: number;
  pnlPercent: number;

  // Timing
  entryTime: number;
  exitTime: number;
  durationMs: number;

  // Détails
  score: number;
  closeReason: string;
  txSignatures: string[];
}

/**
 * État global du bot
 */
export interface BotState {
  // Capital
  totalCapitalSol: number;
  availableCapitalSol: number;
  reserveSol: number;

  // Positions
  openPositions: Position[];
  closedToday: TradeRecord[];

  // Performance journalière
  dailyPnlSol: number;
  dailyPnlPercent: number;
  dailyTradeCount: number;
  dailyWinCount: number;
  dailyLossCount: number;

  // Contrôle
  isPaused: boolean;
  pauseUntil: number | null;     // timestamp fin de pause
  startTime: number;

  // Tokens déjà analysés (éviter les doublons)
  seenTokens: Set<string>;
  watchList: Map<string, TokenAnalysis>;
}

/**
 * Ordre d'achat/vente émis par le Risk Manager
 */
export interface TradeOrder {
  type: 'buy' | 'sell';
  mintAddress: string;
  symbol: string;
  amountSol?: number;           // pour les achats
  tokenAmount?: number;         // pour les ventes
  percentToSell?: number;       // % de la position à vendre
  reason: string;
  priority: 'normal' | 'high';
  positionId?: string;          // référence à la position (pour les ventes)
}

/**
 * Message de notification Discord
 */
export interface DiscordNotification {
  type: 'detection' | 'buy' | 'sell_profit' | 'sell_loss' | 'trailing' | 'summary' | 'alert';
  title: string;
  description: string;
  color: number;                // couleur de l'embed Discord
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
}
