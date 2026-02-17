import fs from 'fs';
import path from 'path';

// ============================================
// LOGGER — Système de logs avec couleurs
// ============================================

// Couleurs pour le terminal Windows (ANSI codes)
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

// Emojis par module pour identifier facilement les logs
const MODULE_EMOJI: Record<string, string> = {
  SCANNER: '📡',
  ANALYZER: '🔍',
  RISK: '💰',
  EXECUTOR: '⚡',
  MONITOR: '📊',
  DISCORD: '🔔',
  BOT: '🤖',
  PAPER: '📝',
};

// Chemin du fichier de log
const LOG_DIR = path.join(process.cwd(), 'data');
const LOG_FILE = path.join(LOG_DIR, 'bot.log');

// S'assurer que le dossier data/ existe
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function getTimestamp(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function writeToFile(level: string, module: string, message: string): void {
  const line = `[${getTimestamp()}] [${level}] [${module}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Silencieux si on ne peut pas écrire
  }
}

export const logger = {
  info(module: string, message: string): void {
    const emoji = MODULE_EMOJI[module] || 'ℹ️';
    console.log(
      `${COLORS.gray}[${getTimestamp()}]${COLORS.reset} ${emoji} ${COLORS.cyan}[${module}]${COLORS.reset} ${message}`
    );
    writeToFile('INFO', module, message);
  },

  success(module: string, message: string): void {
    const emoji = MODULE_EMOJI[module] || '✅';
    console.log(
      `${COLORS.gray}[${getTimestamp()}]${COLORS.reset} ${emoji} ${COLORS.green}[${module}]${COLORS.reset} ${COLORS.green}${message}${COLORS.reset}`
    );
    writeToFile('SUCCESS', module, message);
  },

  warn(module: string, message: string): void {
    console.log(
      `${COLORS.gray}[${getTimestamp()}]${COLORS.reset} ⚠️  ${COLORS.yellow}[${module}]${COLORS.reset} ${COLORS.yellow}${message}${COLORS.reset}`
    );
    writeToFile('WARN', module, message);
  },

  error(module: string, message: string, error?: unknown): void {
    const errMsg = error instanceof Error ? error.message : String(error || '');
    console.error(
      `${COLORS.gray}[${getTimestamp()}]${COLORS.reset} ❌ ${COLORS.red}[${module}]${COLORS.reset} ${COLORS.red}${message}${COLORS.reset}${errMsg ? ` — ${errMsg}` : ''}`
    );
    writeToFile('ERROR', module, `${message} ${errMsg}`);
  },

  trade(action: 'BUY' | 'SELL', module: string, message: string): void {
    const color = action === 'BUY' ? COLORS.green : COLORS.magenta;
    const emoji = action === 'BUY' ? '🟢' : '🔴';
    console.log(
      `${COLORS.gray}[${getTimestamp()}]${COLORS.reset} ${emoji} ${color}[${action}]${COLORS.reset} ${message}`
    );
    writeToFile(action, module, message);
  },

  divider(): void {
    console.log(`${COLORS.gray}${'─'.repeat(60)}${COLORS.reset}`);
  },

  banner(): void {
    console.log(`
${COLORS.cyan}
  ╔══════════════════════════════════════╗
  ║        🤖  SolSniper Bot  🤖         ║
  ║   Trading automatisé de memecoins    ║
  ║            Solana Network            ║
  ╚══════════════════════════════════════╝
${COLORS.reset}`);
  },
};
