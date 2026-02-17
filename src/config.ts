import dotenv from 'dotenv';
dotenv.config();

// ============================================
// CONFIGURATION v8 — Optimisé post-résultats rentables
// ============================================
// Changements vs v7 :
// - Seuils d'achat abaissés (plus de trades)
// - Positions plus grosses (les winners compensent)
// - Dead volume intelligent
// - Cap pertes à -15%

export const CONFIG = {
  solana: {
    privateKey: process.env.PRIVATE_KEY || '',
    rpcUrl: process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com',
    heliusApiKey: process.env.HELIUS_API_KEY || '',
    commitment: 'confirmed' as const,
  },

  mode: {
    paperTrading: process.env.PAPER_TRADING === 'true',
  },

  scanner: {
    minTokenAge: 60,
    maxTokenAge: 30 * 60,
    minLiquidity: 3,
    minRecentTxCount: 15,
    dexScreenerInterval: 8_000,
    requireMintRevoked: true,
    requireFreezeRevoked: true,
  },

  // --- Analyzer : SEUILS ENCORE PLUS BAS (#4) ---
  analyzer: {
    scoreIgnore: 30,       // 0-30 → ignore (était 34)
    scoreWatch: 40,        // 31-40 → watchlist (était 44)
    scoreBuyLow: 50,       // 41-50 → achat micro (était 54)
    scoreBuyMid: 60,       // 51-60 → achat petit (était 64)
    // Au-dessus de 60 → achat moyen

    weights: {
      momentum: 2.5,
      volumeMcapRatio: 2.5,
      buyVsSellRatio: 2.0,
      holderDistribution: 1.5,
      holderGrowth: 2.0,
      devProfile: 1.0,
      liquidityLocked: 0.5,
    },
  },

  dipBuyer: {
    enabled: true,
    checkInterval: 3_000,
    maxWatchDuration: 10 * 60 * 1000,
    minDipPercent: 5,
    maxDipPercent: 35,
    reboundConfirmPercent: 2,
    maxWatchlistSize: 20,
  },

  // --- Risk : POSITIONS PLUS GROSSES (#6) ---
  risk: {
    initialCapital: 0.6,
    reserveAmount: 0.06,
    maxOpenPositions: 18,
    positionSizes: {
      low: 0.025,      // 2.5% du capital (était 1.5%)
      medium: 0.04,    // 4% du capital (était 2.5%)
      high: 0.06,      // 6% du capital (était 4%)
    },
    maxLossPerTrade: 0.15,
    maxDailyLoss: 0.30,
    pauseDuration: 20 * 60 * 1000,
  },

  runner: {
    detection: {
      volumeSpikeMultiplier: 2.0,
      minPriceIncrease: 15,
      minBuyRatio: 0.60,
      maxMarketCap: 150_000,
      minMarketCap: 5_000,
    },
    trailing: {
      levels: [
        { abovePercent: 0,    trailPercent: 0.20 },
        { abovePercent: 30,   trailPercent: 0.18 },
        { abovePercent: 80,   trailPercent: 0.15 },
        { abovePercent: 150,  trailPercent: 0.12 },
        { abovePercent: 300,  trailPercent: 0.10 },
      ],
    },
    secureProfits: [
      { triggerPercent: 0.50, sellPercent: 0.15 },
      { triggerPercent: 1.50, sellPercent: 0.15 },
      { triggerPercent: 3.00, sellPercent: 0.10 },
    ],
    maxDuration: 6 * 60 * 60 * 1000,
  },

  monitor: {
    priceCheckInterval: 2_000,

    trailingLevels: [
      { abovePercent: 0,    trailPercent: 0.10 },
      { abovePercent: 15,   trailPercent: 0.08 },
      { abovePercent: 30,   trailPercent: 0.07 },
      { abovePercent: 50,   trailPercent: 0.06 },
    ],

    initialStopLoss: 0.08,

    secureProfits: [
      { triggerPercent: 0.20, sellPercent: 0.30 },
      { triggerPercent: 0.40, sellPercent: 0.30 },
    ],

    breakevenActivation: 12,

    // Dead volume : timeout intelligent (#3 + #5)
    deadVolumeTimeout: 3 * 60 * 1000,      // 3 min si en perte (était 5 min)
    deadVolumeExtension: 2 * 60 * 1000,    // +2 min supplémentaires si perte < -5%
    deadVolumeStopLoss: -10,               // -10% max pour dead tokens en perte

    maxPositionAge: 90 * 60 * 1000,
    tightTrailPercent: 0.06,
    minVolumeAlive: 0.2,

    // Anti-Dashan : cap trailing stop à -20% (#7)
    maxTrailingLoss: -20,
  },

  executor: {
    maxSlippageBps: 1500,
    priorityFee: 100_000,
    highPriorityFee: 500_000,
    txConfirmTimeout: 30_000,
    maxRetries: 2,
    jupiterApiUrl: 'https://quote-api.jup.ag/v6',
  },

  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    summaryInterval: 45 * 60 * 1000,
  },

  addresses: {
    SOL_MINT: 'So11111111111111111111111111111111111111112',
    PUMP_FUN_PROGRAM: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  },
} as const;

export function validateConfig(): void {
  const errors: string[] = [];

  if (!CONFIG.solana.privateKey) errors.push('PRIVATE_KEY manquante dans .env');
  if (!CONFIG.solana.heliusApiKey) errors.push('HELIUS_API_KEY manquante dans .env');
  if (!CONFIG.discord.webhookUrl) errors.push('DISCORD_WEBHOOK_URL manquante dans .env');

  if (errors.length > 0) {
    console.error('\n❌ Erreurs de configuration :\n');
    errors.forEach((e) => console.error(`   → ${e}`));
    console.error('\n📄 Copie .env.example en .env et remplis les valeurs.\n');
    process.exit(1);
  }

  if (CONFIG.mode.paperTrading) {
    console.log('📝 Mode PAPER TRADING activé — aucun vrai SOL ne sera dépensé.\n');
  } else {
    console.log('💰 Mode RÉEL activé — le bot utilisera de vrais SOL !\n');
  }
}
