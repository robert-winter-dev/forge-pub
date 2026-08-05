/**
 * FORGE LendingBot – Konfiguration
 *
 * Lädt und validiert alle Einstellungen aus .env.
 * Wird von allen anderen Modulen importiert.
 */

import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { envFile } from '../../../config/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: process.env.ENV_FILE ? resolve(__dirname, '..', process.env.ENV_FILE) : envFile('lending') });

function required(key) {
    const val = process.env[key];
    if (!val) throw new Error(`Fehlende Pflicht-Umgebungsvariable: ${key}`);
    return val;
}

function optional(key, fallback) {
    return process.env[key] ?? fallback;
}

function optionalBool(key, fallback = false) {
    const val = process.env[key];
    if (val === undefined) return fallback;
    return val === 'true' || val === '1';
}

function optionalInt(key, fallback) {
    const val = process.env[key];
    if (!val) return fallback;
    const n = parseInt(val, 10);
    if (isNaN(n)) throw new Error(`${key} muss eine ganze Zahl sein, got: ${val}`);
    return n;
}

function optionalFloat(key, fallback) {
    const val = process.env[key];
    if (!val) return fallback;
    const n = parseFloat(val);
    if (isNaN(n)) throw new Error(`${key} muss eine Zahl sein, got: ${val}`);
    return n;
}

// ─── Config-Objekt ────────────────────────────────────────────────────────────

export const config = {
    // ── Solana & Wallet ──────────────────────────────────────────────────────
    rpcUrl:      optional('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
    keypairPath: optional('SOLANA_KEYPAIR_PATH', '/path/to/your/wallet-keypair.json'),
    solReserve:  optionalFloat('SOL_RESERVE', 0.05),

    // ── Bot-Identifikation ───────────────────────────────────────────────────
    botId:          optional('BOT_ID', 'lending'),
    botDisplayName: optional('BOT_DISPLAY_NAME', 'FORGE Lending Bot'),

    // ── Telegram ─────────────────────────────────────────────────────────────
    telegram: {
        token:  optional('TELEGRAM_BOT_TOKEN', ''),
        chatId: optional('TELEGRAM_CHAT_ID', ''),
        get enabled() { return !!this.token && !!this.chatId; },
    },

    // ── Aktive Protokolle (Investing) ────────────────────────────────────────
    protocols: optional('LENDING_PROTOCOLS', 'kamino')
        .split(',')
        .map(p => p.trim().toLowerCase())
        .filter(Boolean),

    // ── Überwachte Protokolle (nur APY/TVL, kein Investing) ──────────────────
    // APY + TVL werden stündlich erfasst (gleicher Tick wie aktive Protokolle).
    // Fehler (API down, Vault nicht gefunden) werden still übersprungen.
    monitorProtocols: optional('MONITOR_PROTOCOLS', '')
        .split(',')
        .map(p => p.trim().toLowerCase())
        .filter(Boolean),

    // ── Kamino ───────────────────────────────────────────────────────────────
    kamino: {
        // Legacy-Felder für Rückwärtskompatibilität (= Main Market)
        market:      optional('KAMINO_MARKET',       '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'),
        usdcReserve: optional('KAMINO_USDC_RESERVE', 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59'),
        apiBase:     'http://127.0.0.1:3100/kamino', // FORGE API Proxy (Rate-Limiting zentral)

        // Bekannte Kamino klend USDC-Märkte (Adressen via api.kamino.finance verifiziert)
        // Alle: sofortiger Withdraw, gleicher klend-SDK, nur market + reserve unterschiedlich.
        // APY-Quelle: isolierte Leverage-Märkte (Borrower zahlen hohe Zinsen → hohe APY für Lender)
        markets: {
            'kamino': {
                market:  '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF',
                reserve: 'D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59',
                label:   'Kamino',
            },
            'kamino-figure': {
                market:  'CqAoLuqWtavaVE8deBjMKe8ZfSt9ghR6Vb8nfsyabyHA',
                reserve: '9GJ9GBRwCp4pHmWrQ43L5xpc9Vykg7jnfwcFGN8FoHYu',
                label:   'Kamino Figure',
            },
            'kamino-onre': {
                market:  '47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8',
                reserve: 'AYL4LMc4ZCVyq3Z7XPJGWDM4H9PiWjqXAAuuHBEGVR2Z',
                label:   'Kamino OnRe',
            },
            'kamino-huma': {
                market:  '52FSGeeokLpgvgAMdqxyt5Hoc2TbUYj5b8yxrEdZ37Vf',
                reserve: '4QKFoFDzNFnvfkzVazABbCEfMwd3y1pZqUVzmpnkCphj',
                label:   'Kamino Huma',
            },
        },
    },

    // ── Jupiter Lend ──────────────────────────────────────────────────────────
    jupiter: {
        apiBase:  'http://127.0.0.1:3100/jup',      // FORGE API Proxy (Rate-Limiting zentral)
        apiKey:   optional('JUPITER_API_KEY', ''),  // Geteilt mit SpotGridBot
        // USDC Mint auf Solana Mainnet
        usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    },

    // ── Drift ─────────────────────────────────────────────────────────────────
    // DEAKTIVIERT 2026-04-02: Exploit ~$270M, Protokoll pausiert (x.com/DriftProtocol)
    // drift: {
    //     programId: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH',
    //     usdcMarketIndex: 0,
    //     usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    // },

    // ── Loopscale ─────────────────────────────────────────────────────────────
    loopscale: {
        apiBase:  'http://127.0.0.1:3100/loopscale', // FORGE API Proxy (Rate-Limiting zentral)
        usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',

        // API-Bug-Workaround: vaultAddresses-Filter gibt Ergebnisse nur zurück wenn
        // ≥2 Adressen im Filter stehen, die ALLE nicht in der allgemeinen Vault-Liste sind.
        // Diese Adresse ist ein bekannter Loopscale-Vault (verifiziert via App-URL), der
        // nicht öffentlich gelistet ist – dient als Begleit-Adresse für den Filter-Fallback.
        filterCompanionAddress: '7PeYxZpM2dpc4RRDQovexMJ6tkSVLWtRN4mbNywsU3e6',

        // Verfügbare USDC-Vaults (Adressen unveränderlich – von Loopscale vergeben)
        vaults: {
            'loopscale-onre': {
                // Öffentlich zugänglicher USDC-Vault (RWA-besichert, ~7.9% APY)
                // In allgemeiner API-Liste enthalten → directQuery funktioniert
                address: '3gcVWr7Bgpp2EmbuF1VjjW6djHBik1d3vqjZLw2po6os',
                label:   'Loopscale USDC Public',
            },
            'loopscale-genesis': {
                // Nicht in allgemeiner API-Liste → braucht Filter-Fallback mit ≥2 Adressen
                // Zugänglich via app.loopscale.com/vault/AXanCP4d...
                // ~6.76% APY | TVL ~$2.13M (2026-03-25 verifiziert)
                address: 'AXanCP4dJHtWd7zY4X7nwxN5t5Gysfy2uG3XTxSmXdaB',
                label:   'Loopscale Gen',
            },
        },
    },

    // ── APY-Monitoring ────────────────────────────────────────────────────────
    apyThresholdPercent:  optionalFloat('APY_THRESHOLD_PERCENT', 5),
    apyUpdateIntervalMs:  optionalInt('APY_UPDATE_INTERVAL_MS', 3_600_000),

    // ── Auto-Deploy ───────────────────────────────────────────────────────────
    // Statische Defaults (werden von loadAutoDeployConfig() pro Zyklus überschrieben)
    autoDeployMode:       optional('AUTO_DEPLOY_MODE', 'disabled'),
    autoDeployMinDeposit: optionalFloat('AUTO_DEPLOY_MIN_DEPOSIT', 0),
    autoDeployMaxDeposit: optionalFloat('AUTO_DEPLOY_MAX_DEPOSIT', 0),

    // ── Compounding ───────────────────────────────────────────────────────────
    autoCompounding: optionalBool('AUTO_COMPOUNDING_ENABLED', false),

    // ── Dashboard-Sync ────────────────────────────────────────────────────────
    syncTarget:  optional('SYNC_TARGET', ''),
    syncSshPort: optionalInt('SYNC_SSH_PORT', 22),

    // ── Environment ──────────────────────────────────────────────────────────
    nodeEnv:  optional('NODE_ENV', 'production'),
    logLevel: optional('LOG_LEVEL', 'info'),
    get isDev() { return this.nodeEnv === 'development'; },
};

const ENV_PATH = resolve(__dirname, '..', process.env.ENV_FILE ?? '.env');

function parseEnvFile(path) {
    try {
        const result = {};
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const i = t.indexOf('=');
            if (i === -1) continue;
            result[t.slice(0, i).trim()] = t.slice(i + 1).trim();
        }
        return result;
    } catch { return {}; }
}

/**
 * Liest die Auto-Deploy-Konfiguration pro Zyklus frisch aus der .env.
 * So wirken Änderungen über das Settings-UI sofort ohne Bot-Neustart.
 */
export function loadAutoDeployConfig() {
    const env = parseEnvFile(ENV_PATH);
    const flt = (key, def) => { const v = parseFloat(env[key]); return isFinite(v) ? v : def; };
    return {
        autoDeployMode:              env.AUTO_DEPLOY_MODE               ?? 'disabled',
        apyThresholdPercent:         flt('APY_THRESHOLD_PERCENT',    5),
        autoDeployMinDeposit:        flt('AUTO_DEPLOY_MIN_DEPOSIT',  0),
        autoDeployMaxDeposit:        flt('AUTO_DEPLOY_MAX_DEPOSIT',  0),
        fixedApyThresholdPercent:    flt('FIXED_APY_THRESHOLD_PERCENT', 0),
        fixedAutoDeployMinDeposit:   flt('FIXED_AUTO_DEPLOY_MIN_DEPOSIT', 0),
        fixedAutoDeployMaxDeposit:   flt('FIXED_AUTO_DEPLOY_MAX_DEPOSIT', 0),
    };
}
