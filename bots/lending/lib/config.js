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
import { listPools, listByType, getPool } from '../../../lib/lending-pools.js';

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
    botDisplayName: optional('BOT_DISPLAY_NAME', 'Lending Bot'),

    // ── Telegram ─────────────────────────────────────────────────────────────
    telegram: {
        token:  optional('TELEGRAM_BOT_TOKEN', ''),
        chatId: optional('TELEGRAM_CHAT_ID', ''),
        get enabled() { return !!this.token && !!this.chatId; },
    },

    // ── Pools ────────────────────────────────────────────────────────────────
    // Welche Pools es gibt, steht allein im Pool-Register (config/lending-pools.json,
    // LEN#001365). 🔒 Vorrang Register: LENDING_PROTOCOLS und MONITOR_PROTOCOLS aus der
    // .env bestimmen nichts mehr. Sonst könnte eine alte .env einen ausgelaufenen Pool
    // weiter abfragen lassen oder einen neuen Pool unsichtbar halten. Ob ein Pool im
    // Tick abgefragt wird, entscheidet sein Zustand (lib/lending-pools.js shouldQuery).
    protocols: listPools().map(p => p.id),

    // Nur noch für den Hinweis beim Bot-Start, dass die Zeilen wirkungslos sind.
    legacyEnvProtocols: [optional('LENDING_PROTOCOLS', ''), optional('MONITOR_PROTOCOLS', '')]
        .filter(Boolean),

    // ── Kamino ───────────────────────────────────────────────────────────────
    kamino: {
        // Legacy-Felder für Rückwärtskompatibilität (= Main Market)
        market:      optional('KAMINO_MARKET',       getPool('kamino')?.market),
        usdcReserve: optional('KAMINO_USDC_RESERVE', getPool('kamino')?.reserve),
        apiBase:     'http://127.0.0.1:3100/kamino', // FORGE API Proxy (Rate-Limiting zentral)

        // Bekannte Kamino klend USDC-Märkte: aus dem Pool-Register
        // (config/lending-pools.json, lib/lending-pools.js). Alle: sofortiger Withdraw,
        // gleicher klend-SDK, nur market + reserve unterschiedlich. Enthält bewusst auch
        // entfernte Pools: Auszahlen und die Schutzliste von close-scam-tokens.js dürfen
        // nie von Zustand oder Sichtbarkeit abhängen.
        markets: Object.fromEntries(listByType('kamino').map(p =>
            [p.id, { market: p.market, reserve: p.reserve, label: p.label }])),
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

        // Verfügbare USDC-Vaults: aus dem Pool-Register (Adressen unveränderlich, von
        // Loopscale vergeben). Ob ein Vault in der allgemeinen API-Liste steht oder den
        // Filter-Fallback braucht, erkennt LoopscaleProtocol._getVaultInfo() selbst.
        vaults: Object.fromEntries(listByType('loopscale').map(p =>
            [p.id, { address: p.address, label: p.label }])),
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
