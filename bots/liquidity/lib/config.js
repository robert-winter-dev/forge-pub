/**
 * FORGE Liquidity – Konfiguration
 *
 * Lädt .env und config/pools.json, validiert alle Pflichtfelder,
 * gibt ein strukturiertes Config-Objekt zurück.
 */

import dotenv        from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path          from 'path';
import { fileURLToPath } from 'url';
import Database      from 'better-sqlite3';
import { applyPoolDynamics } from './db.js';
import { PATHS, envFile } from '../../../config/paths.js';
import { reasonPayload, renderReason } from '../../../lib/pool-reason.js';
import { stripSessionFields, diffFromDefaults } from '../../../lib/pool-settings-defaults.js';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_DB   = PATHS.settingsDb;
const LIQUIDITYBOT_DB       = PATHS.liquidityDb;

/** Öffnet die Bot-DB (liquiditybot.db) schreibend mit busy_timeout für die Pool-Setter. */
function openBotDbRW() {
    const db = new Database(LIQUIDITYBOT_DB);
    db.pragma('busy_timeout = 5000');
    return db;
}

dotenv.config({ path: envFile('liquidity') });

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function requireEnv(name) {
    const val = process.env[name];
    if (!val || val.trim() === '') {
        throw new Error(`Pflichtfeld fehlt in .env: ${name}`);
    }
    return val.trim();
}

function optionalEnv(name, defaultValue = null) {
    const val = process.env[name];
    return val?.trim() || defaultValue;
}

function requirePositiveFloat(name) {
    const raw = requireEnv(name);
    const val = parseFloat(raw);
    if (isNaN(val) || val <= 0) {
        throw new Error(`${name} muss eine positive Zahl sein (aktuell: "${raw}")`);
    }
    return val;
}

function optionalPositiveFloat(name, defaultValue) {
    const raw = optionalEnv(name);
    if (raw === null) return defaultValue;
    const val = parseFloat(raw);
    if (isNaN(val) || val <= 0) {
        throw new Error(`${name} muss eine positive Zahl sein (aktuell: "${raw}")`);
    }
    return val;
}

// Wie optionalPositiveFloat, aber 0 ist ein gültiger, expliziter Wert ("Reserve aus").
// Eigene Funktion statt optionalPositiveFloat wiederzuverwenden, damit ein Self-Hoster
// PREMIUM_RESERVE_USDC=0 ins .env schreiben kann, ohne dass das als Fehler geworfen wird.
function optionalNonNegativeFloat(name, defaultValue) {
    const raw = optionalEnv(name);
    if (raw === null) return defaultValue;
    const val = parseFloat(raw);
    if (isNaN(val) || val < 0) {
        throw new Error(`${name} muss eine nicht-negative Zahl sein (aktuell: "${raw}")`);
    }
    return val;
}

function optionalPositiveInt(name, defaultValue) {
    const raw = optionalEnv(name);
    if (raw === null) return defaultValue;
    const val = parseInt(raw, 10);
    if (isNaN(val) || val <= 0) {
        throw new Error(`${name} muss eine positive ganze Zahl sein (aktuell: "${raw}")`);
    }
    return val;
}

// ─── Pools laden ──────────────────────────────────────────────────────────────

/**
 * Liest config/pools.json (statische Pool-Definition) frisch von Disk und
 * überlagert die dynamischen Betriebsfelder (active/enabled/rangeOverride.fixedPct)
 * mit den autoritativen DB-Werten. Gibt { all, active } zurück.
 *
 * Wird beim Start UND zu Beginn jedes Bot-Zyklus aufgerufen (Hot-Reload ohne Neustart).
 * Wirft nur bei Parse-Fehlern der JSON — 0 aktive Pools sind erlaubt (Bot wartet dann).
 *
 * pools.json ist für die drei dynamischen Felder nur noch der SEED (Erstbefüllung
 * eines neuen Pools). Danach ist die DB Single Source of Truth; die Datei wird vom
 * Bot nicht mehr beschrieben. Existiert die DB (noch) nicht (Erst-Boot vor
 * openDatabase), bleibt die reine JSON-Semantik erhalten.
 */
export function loadPools() {
    const poolsPath = path.join(__dirname, '..', 'config', 'pools.json');
    let pools;
    try {
        pools = JSON.parse(readFileSync(poolsPath, 'utf-8'));
    } catch (err) {
        throw new Error(`config/pools.json nicht lesbar: ${err.message}`);
    }
    if (!Array.isArray(pools) || pools.length === 0) {
        throw new Error('config/pools.json muss ein nicht-leeres Array sein');
    }
    if (existsSync(LIQUIDITYBOT_DB)) {
        let bdb;
        try {
            bdb = new Database(LIQUIDITYBOT_DB, { readonly: true });
            applyPoolDynamics(bdb, pools);
        } catch { /* DB/Spalten noch nicht bereit → JSON-Seed-Werte behalten */ }
        finally { try { bdb?.close(); } catch { /* ignore */ } }
    }
    const activePools = pools.filter(p => p.active === true);
    return { all: pools, active: activePools };
}

/**
 * Räumt beim Pool-Close/Reaktivieren den **Session-Zustand** eines Pools ab.
 * Alle Nutzer-Einstellungen bleiben unverändert erhalten.
 *
 * 🔒 Regel seit 2026-08-15 (vorher umgekehrt, siehe unten):
 * Was der Nutzer in ForgeSettings eingestellt hat, ist Konfiguration und überlebt
 * jeden Kapitalabzug — Trailing Stop, TVL-Schutz, Score-Limit,
 * manueller Withdraw. Entfernt wird ausschließlich, was an das konkrete Engagement
 * gebunden ist: `POOL_SESSION_FIELDS` in lib/pool-settings-defaults.js (dort auch
 * die Begründung je Feld).
 *
 * Zuvor galt eine Whitelist: nur `tvlProtection` und `trailingStop` überlebten,
 * alles andere fiel auf die ForgeSettings-Defaults zurück. Das hat bei jedem Exit
 * stillschweigend Nutzerentscheidungen verworfen — Reinvest-Anteil und Mindest-
 * Claim-Betrag (autoCompound), die Score-Schwelle (scoreLimit) und vor allem
 * `cleanup.rankingEligible`: ein bewusst vom Cleanup ausgenommener Pool stand
 * nach dem nächsten Exit wieder in der Reinvest-Auswahl.
 *
 * Die beiden Vorfälle, die zur alten Whitelist geführt hatten, bleiben abgedeckt —
 * die neue Regel ist echt schwächer, sie hält mehr statt weniger:
 *   - tvlProtection: manuell gesetzte Schwellen bleiben (2026-07-30, SPCX/USDC auf
 *     forge-pub1: Deposit→NOTFALL-EXIT-Zyklus, weil die Schwelle auf den viel zu
 *     hohen pools.json-Fallback zurückfiel).
 *   - trailingStop: die Sektion bleibt vorhanden (2026-08-01, PUMP/SOL: eine
 *     fehlende Sektion las der Bot als „Trailing Stop komplett aus", während
 *     ForgeSettings die Defaults anzeigte). Zweite, unabhängige Absicherung
 *     dagegen: der Default-Fallback in lib/trailing-stop.js (loadTsConfig).
 *
 * @param {string} poolId
 * @param {string} logPrefix  Log-Präfix des Aufrufers (z.B. "[config]" oder "[bot:xyz]")
 */
export function resetPoolSessionState(poolId, logPrefix = '[config]') {
    try {
        const sdb = new Database(SETTINGS_DB, { fileMustExist: false });
        sdb.exec(`CREATE TABLE IF NOT EXISTS pool_settings (
            bot_id   TEXT NOT NULL,
            pool_id  TEXT NOT NULL,
            settings TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (bot_id, pool_id)
        )`);
        const row = sdb.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        if (!row) { sdb.close(); return; }

        let parsed;
        try {
            parsed = JSON.parse(row.settings);
        } catch {
            sdb.close();
            console.warn(`${logPrefix} Pool-Settings für ${poolId} nicht lesbar – unverändert gelassen`);
            return;
        }

        const { settings: cleaned, removed } = stripSessionFields(parsed);
        if (removed.length > 0) {
            sdb.prepare(`UPDATE pool_settings SET settings = ? WHERE bot_id = ? AND pool_id = ?`)
                .run(JSON.stringify(cleaned), config.botId, poolId);
        }
        sdb.close();

        // Hinweis ins Log: welcher Zustand fiel weg, welche Einstellungen wirken
        // nach der Reaktivierung abweichend vom Default weiter.
        const kept = diffFromDefaults(cleaned);
        const keptTxt = kept.length > 0
            ? kept.map(d => `${d.path}=${JSON.stringify(d.value)} (Default ${JSON.stringify(d.defaultValue)})`).join(', ')
            : 'keine (alles auf Default)';
        console.log(
            `${logPrefix} Pool-Settings ${poolId}: Session-Zustand zurückgesetzt` +
            `${removed.length > 0 ? ` (${removed.join(', ')})` : ' (nichts zurückzusetzen)'}` +
            ` – vom Default abweichend und weiterhin aktiv: ${keptTxt}`
        );
    } catch (err) {
        console.warn(`${logPrefix} Session-Zustand zurücksetzen für ${poolId} fehlgeschlagen: ${err.message}`);
    }
}

/**
 * Setzt das `active`-Flag eines Pools in der Bot-DB (Single Source of Truth,
 * persistent über Restarts). Schreibt bewusst NICHT mehr in pools.json — die
 * Datei bleibt statisch, damit der Bot keine wiederkehrenden Git-Diffs erzeugt.
 * Gibt true zurück, wenn der Wert geändert wurde, false wenn er schon dem
 * Zielzustand entsprach.
 */
export function setPoolActive(poolId, active) {
    let changed;
    const bdb = openBotDbRW();
    try {
        const row = bdb.prepare(`SELECT active FROM pools WHERE id = ?`).get(poolId);
        if (!row) throw new Error(`Pool ${poolId} nicht in DB-Tabelle pools gefunden (syncPools ausstehend?)`);
        changed = ((row.active === 1) !== active);
        if (changed) bdb.prepare(`UPDATE pools SET active = ? WHERE id = ?`).run(active ? 1 : 0, poolId);
    } finally {
        bdb.close();
    }
    if (!changed) return false;

    // Beim Deaktivieren nur den Session-Zustand abräumen — alle Nutzer-Einstellungen
    // bleiben erhalten (siehe resetPoolSessionState).
    if (active === false) {
        resetPoolSessionState(poolId, '[config]');
    }

    // Liquidierter Pool darf nicht weiter als fester Cleanup-Pin ("invest in") dienen.
    // Egal warum der Pool deaktiviert wird (Score-Limit, TVL-Schutz,
    // Trailing-Stop, manueller Withdraw): ist genau dieser Pool als
    // CLEANUP_MODE=pool:<id> konfiguriert, zurück auf 'ranking' ("bester Pool")
    // schalten – sonst reinvestiert der nächste Cleanup-Lauf blind und ohne
    // Score-Prüfung wieder in den gerade liquidierten Pool.
    if (active === false && getCleanupModeFromEnv() === `pool:${poolId}`) {
        try {
            setCleanupModeInEnv('ranking');
            console.log(`[config] ${poolId} liquidiert & war fester Cleanup-Pool → CLEANUP_MODE auf 'ranking' umgestellt`);
        } catch (err) {
            console.error(`[config] CLEANUP_MODE-Umstellung nach Liquidierung von ${poolId} fehlgeschlagen: ${err.message}`);
        }
    }

    return true;
}

/**
 * Benutzer-Freigabe eines Pools („darf hier Kapital investiert werden?").
 *
 * Bewusst getrennt vom operativen `active`-Flag (siehe setPoolActive):
 *   - `enabled`  = Benutzer-Master-Schalter. Nur der User (ForgeSettings) und der
 *                  TVL-Voll-Exit setzen ihn. Gesperrte Pools werden vom Ranking-Cleanup
 *                  ÜBERSPRUNGEN und können nicht (re)aktiviert/bedeposited werden.
 *   - `active`   = operativer Zustand (offene Position vorhanden / zu pflegen),
 *                  wird ausschließlich von der Bot-Automatik geschrieben.
 *
 * Default: fehlendes Feld = freigegeben (true). So sind Bestands-Pools ohne
 * explizites `enabled` automatisch aktiv — kein Massen-Edit der pools.json nötig.
 */
export function isPoolEnabled(pool) {
    return pool?.enabled !== false;
}

/**
 * Setzt das `enabled`-Flag eines Pools in der Bot-DB (Single Source of Truth,
 * persistent). Schreibt nicht mehr in pools.json. NULL in der DB (noch nie gesetzt)
 * gilt als „freigegeben" (true) — konsistent zu isPoolEnabled(). Gibt true zurück
 * wenn geändert.
 *
 * @param {string} poolId
 * @param {boolean} enabled
 * @param {string} [reason] - Für die Settings-UI (Tooltip am Aktivieren-Button, wenn
 *   der Pool gerade gesperrt ist): erklärt wann + warum, ohne dass man dafür Changelog/DB
 *   durchsuchen muss (Fund 2026-08-06: forge-pub1 PUMP/SOL wirkte ohne diesen Kontext wie
 *   ein stiller Bug). Jeder Aufrufer sollte seinen Grund benennen; ohne Angabe wird ein
 *   generischer Platzhalter geschrieben statt den Aufruf abzulehnen.
 *   🔴 Kein Klartext: der Grund wird als Katalog-Key + Parameter über
 *   `reasonPayload()` übergeben und erst beim Lesen in die aktive Sprache gerendert
 *   (lib/pool-reason.js) — der Text entsteht beim Schreiben, die Sprache kann bis zum
 *   Anzeigen wechseln. Altbestand in Klartext bleibt unverändert lesbar.
 */
export function setPoolEnabled(poolId, enabled, reason = reasonPayload('reason.not_logged')) {
    let changed;
    const bdb = openBotDbRW();
    try {
        const row = bdb.prepare(`SELECT enabled FROM pools WHERE id = ?`).get(poolId);
        if (!row) throw new Error(`Pool ${poolId} nicht in DB-Tabelle pools gefunden (syncPools ausstehend?)`);
        const current = (row.enabled === null || row.enabled === undefined) ? true : row.enabled === 1;
        changed = (current !== enabled);
        if (changed) {
            bdb.prepare(`UPDATE pools SET enabled = ?, enabled_changed_at = ?, enabled_reason = ? WHERE id = ?`)
                .run(enabled ? 1 : 0, Date.now(), reason, poolId);
        }
    } finally {
        bdb.close();
    }
    if (!changed) return false;
    console.log(`[config] Pool ${poolId} ${enabled ? 'freigegeben' : 'gesperrt'} (enabled=${enabled}, Grund: ${renderReason(reason)})`);
    return true;
}

/**
 * Setzt `rangeOverride.fixedPct` eines Pools in der Bot-DB (Single Source of Truth,
 * persistent). Schreibt nicht mehr in pools.json. Der Pool MUSS in pools.json ein
 * `rangeOverride.fixedPct` haben (struktureller Slot) — der JSON-Wert dient als Seed
 * und als Vergleichsbasis, solange die DB-Spalte noch NULL ist. Gibt true zurück
 * wenn geändert, false wenn der effektive Wert bereits passte.
 *
 * @param {string} poolId
 * @param {number} newFixedPct
 * @returns {boolean}
 */
export function updatePoolRangeOverride(poolId, newFixedPct) {
    // Strukturprüfung + Seed aus pools.json (nur lesen, nie schreiben).
    const poolsPath = path.join(__dirname, '..', 'config', 'pools.json');
    const json      = JSON.parse(readFileSync(poolsPath, 'utf-8'));
    const jsonPool  = json.find(p => p.id === poolId);
    if (!jsonPool) throw new Error(`Pool ${poolId} nicht in pools.json gefunden`);
    if (!jsonPool.rangeOverride || typeof jsonPool.rangeOverride.fixedPct !== 'number') {
        throw new Error(`Pool ${poolId} hat kein rangeOverride.fixedPct`);
    }

    let changed;
    const bdb = openBotDbRW();
    try {
        const row = bdb.prepare(`SELECT range_override_fixed_pct FROM pools WHERE id = ?`).get(poolId);
        if (!row) throw new Error(`Pool ${poolId} nicht in DB-Tabelle pools gefunden (syncPools ausstehend?)`);
        // Effektiver Ist-Wert: DB-Wert (autoritativ), sonst JSON-Seed.
        const current = (row.range_override_fixed_pct === null || row.range_override_fixed_pct === undefined)
            ? jsonPool.rangeOverride.fixedPct
            : row.range_override_fixed_pct;
        changed = (current !== newFixedPct);
        if (changed) bdb.prepare(`UPDATE pools SET range_override_fixed_pct = ? WHERE id = ?`).run(newFixedPct, poolId);
    } finally {
        bdb.close();
    }
    return changed;
}

/**
 * Setzt `poolType` eines Pools in der Bot-DB (Single Source of Truth seit LIQ#0332,
 * Festlegung). Schreibt nicht in pools.json — der JSON-Wert dient nur als Seed
 * (siehe setPoolActive-Kommentar). Aufrufer: der tägliche Vola-Drift-Check in bot.js
 * (lib/pool-type-drift.js), bei nachhaltig verschobener Tagesvola. Bewusst still
 * (kein Telegram/Dashboard-Hinweis) — nur ein Log-Eintrag für Support-Diagnose.
 * Gibt true zurück wenn geändert.
 *
 * @param {string} poolId
 * @param {string} newType
 * @returns {boolean}
 */
export function setPoolType(poolId, newType) {
    let changed;
    const bdb = openBotDbRW();
    try {
        const row = bdb.prepare(`SELECT pool_type FROM pools WHERE id = ?`).get(poolId);
        if (!row) throw new Error(`Pool ${poolId} nicht in DB-Tabelle pools gefunden (syncPools ausstehend?)`);
        changed = (row.pool_type !== newType);
        if (changed) bdb.prepare(`UPDATE pools SET pool_type = ? WHERE id = ?`).run(newType, poolId);
    } finally {
        bdb.close();
    }
    if (!changed) return false;
    console.log(`[config] Pool ${poolId}: poolType automatisch korrigiert → ${newType} (Vola-Drift-Check)`);
    return true;
}

// ─── Range-Modus validieren ───────────────────────────────────────────────────

function loadRangeConfig() {
    const mode = optionalEnv('RANGE_MODE', 'fixed');
    if (mode !== 'fixed' && mode !== 'atr') {
        throw new Error(`RANGE_MODE muss 'fixed' oder 'atr' sein (aktuell: "${mode}")`);
    }
    if (mode === 'fixed') {
        return {
            mode,
            fixedPct: optionalPositiveFloat('RANGE_FIXED_PCT', 20),
        };
    }
    return {
        mode,
        atrPeriod:     optionalPositiveInt('RANGE_ATR_PERIOD', 14),
        atrMultiplier: optionalPositiveFloat('RANGE_ATR_MULTIPLIER', 2.0),
        fixedPct:      optionalPositiveFloat('RANGE_FIXED_PCT', 20),  // Fallback wenn nicht genug ATR-Daten
        minRangePct:   optionalPositiveFloat('MIN_RANGE_PCT', 3),      // Untergrenze ±%
        maxRangePct:   optionalPositiveFloat('MAX_RANGE_PCT', 25),     // Obergrenze ±%
    };
}

// ─── Reward-Konfiguration validieren ─────────────────────────────────────────

function loadRewardConfig() {
    const action = optionalEnv('REWARD_ACTION', 'reinvest');
    if (action !== 'reinvest' && action !== 'transfer') {
        throw new Error(`REWARD_ACTION muss 'reinvest' oder 'transfer' sein (aktuell: "${action}")`);
    }
    if (action === 'transfer') {
        const target = optionalEnv('REWARD_TARGET');
        if (!target) {
            throw new Error('REWARD_TARGET muss gesetzt sein wenn REWARD_ACTION=transfer');
        }
        return { action, target };
    }
    return { action, target: null };
}

// ─── Config zusammenbauen ─────────────────────────────────────────────────────

function loadConfig() {
    const pools  = loadPools();
    const range  = loadRangeConfig();
    const reward = loadRewardConfig();

    const telegramToken  = optionalEnv('TELEGRAM_BOT_TOKEN');
    const telegramChatId = optionalEnv('TELEGRAM_CHAT_ID');

    return {
        // Bot-Identifikation
        botId: optionalEnv('BOT_ID', 'liquidity'),

        // Wallet & RPC
        keypairPath: requireEnv('KEYPAIR_PATH'),
        rpcUrl:      requireEnv('RPC_URL'),
        solReserve:  optionalPositiveFloat('SOL_RESERVE', 0.10),
        // USDC-Reserve für FORGE-public-Premium-Zahlungen (0,10 USDC/h).
        // Default 0 = kein Effekt (Master zahlt kein Premium).
        // Cleanup darf diese Reserve nie investieren — sonst wäre Premium-Ausfall wegen
        // Guthabenmangel der Normalzustand statt der Ausnahme (siehe getUsableUsdcBalanceFresh
        // in lib/wallet.js).
        premiumReserveUsdc: optionalNonNegativeFloat('PREMIUM_RESERVE_USDC', 0),

        // Pools
        pools,

        // Überwachung
        checkIntervalMs: optionalPositiveInt('CHECK_INTERVAL_MS', 300_000),

        // Trailing-Stop-Schnellprüfung zwischen zwei Zyklen (lib/fast-stop-check.js):
        // alle FAST_TS_CHECK_MS je Pool mit offener Position nur den Pool-Preis lesen und
        // gegen den Höchststand prüfen. Grund: Fartcoin/SOL am 2026-08-22 verlor 9 % in
        // einem einzigen 5-Min-Intervall — ein 0,75-%-Stop löste bei −8,7 % aus, weil
        // dazwischen niemand hinsah. Eine Zusage, die feiner ist als die Abtastung, ist
        // keine (KB Core/wirkungsnachweis.md).
        fastTsCheck: {
            enabled:    optionalEnv('FAST_TS_CHECK_ENABLED', 'true') === 'true',
            intervalMs: optionalPositiveInt('FAST_TS_CHECK_MS', 30_000),
        },

        // Rebalancing
        rebalance: {
            enabled:          optionalEnv('REBALANCE_ENABLED', 'true') === 'true',
            thresholdPct:     optionalPositiveFloat('REBALANCE_THRESHOLD_PCT', 2),
            cooldownMinutes:  optionalPositiveInt('REBALANCE_COOLDOWN_MINUTES', 120),
        },

        // Risikomanagement (SL / TP / Trailing Stop)
        rm: {
            swapSlippageBps: optionalPositiveInt('RM_SWAP_SLIPPAGE_BPS', 300),
        },

        // Range
        range,

        // Fee-Harvesting
        feeClaimIntervalMs:  optionalPositiveInt('FEE_CLAIM_INTERVAL_MS', 3_600_000),
        feeClaimMinUsdc:     optionalPositiveFloat('FEE_CLAIM_MIN_USDC', 0.10),
        reward,

        // Portfolio-Tracking
        portfolioSnapshotIntervalMs: optionalPositiveInt('PORTFOLIO_SNAPSHOT_INTERVAL_MS', 300_000),

        // Dashboard-Export
        exportIntervalMs: optionalPositiveInt('EXPORT_INTERVAL_MS', 60_000),

        // Alerts
        alerts: {
            aprThreshold:          optionalPositiveFloat('APR_ALERT_THRESHOLD', 10),
            aprAlertCooldownMs:    optionalPositiveInt('APR_ALERT_COOLDOWN_H', 168) * 3_600_000,
outOfRangeMinutes:     optionalPositiveInt('OUT_OF_RANGE_ALERT_MINUTES', 30),
        },

        // Telegram
        telegram: {
            token:   telegramToken,
            chatId:  telegramChatId,
            get enabled() {
                return !!(this.token && this.chatId);
            },
        },

        // Dashboard-Sync
        syncTarget:  optionalEnv('SYNC_TARGET'),
        syncSshPort: optionalPositiveInt('SYNC_SSH_PORT', 22),
    };
}

export const config = loadConfig();

/**
 * Löst ein per CLI übergebenes `--pool`-Argument gegen `pools.all` auf.
 *
 * 🔒 Seit LIQ#0467 können mehrere Pools denselben `pair`-String tragen (z.B. zwei
 * unabhängige Orca-Whirlpools für HYPE/USDC oder SOL/Fartcoin bei unterschiedlichem
 * Fee-Tier). Ein simples `pools.find(p => p.pair === arg)` nimmt in diesem Fall
 * stillschweigend den ERSTEN Treffer — bei deposit.js/withdraw.js liefe eine echte
 * Kapitalbewegung damit gegen den falschen Pool, ohne dass Fehler oder Warnung
 * erscheint. Deshalb: erst eindeutiger `id`-Treffer, sonst `pair`-Treffer nur, wenn
 * er eindeutig ist — bei Mehrdeutigkeit `ambiguous:true` + Kandidaten-Ids zurück,
 * statt zu raten.
 *
 * @param {Array<object>} pools  z.B. config.pools.all
 * @param {string} arg           Wert von --pool (id oder pair)
 * @returns {{ pool: object|null, ambiguous: boolean, candidates: string[] }}
 */
export function resolvePoolArg(pools, arg) {
    const byId = pools.find(p => p.id === arg);
    if (byId) return { pool: byId, ambiguous: false, candidates: [] };

    const byPair = pools.filter(p => p.pair === arg);
    if (byPair.length === 1) return { pool: byPair[0], ambiguous: false, candidates: [] };
    if (byPair.length > 1) {
        return { pool: null, ambiguous: true, candidates: byPair.map(p => p.id) };
    }
    return { pool: null, ambiguous: false, candidates: [] };
}

/**
 * Liest den aktuellen CLEANUP_MODE frisch aus der .env-Datei.
 * Wichtig: process.env kann im laufenden Bot-Prozess veraltet sein, weil
 * bots/settings/Score-Limit-Flow die .env zur Laufzeit ändern. Der Cleanup
 * selbst ist ein separater Prozess, der die .env bei jedem Lauf neu liest.
 * @returns {string|null}
 */
export function getCleanupModeFromEnv() {
    const envPath = path.join(__dirname, '..', '.env');
    if (!existsSync(envPath)) return process.env.CLEANUP_MODE ?? null;
    const text = readFileSync(envPath, 'utf-8');
    const m    = text.match(/^CLEANUP_MODE\s*=\s*(.*)$/m);
    return m ? m[1].trim() : (process.env.CLEANUP_MODE ?? null);
}

/**
 * Liest CLEANUP_MAX_DEPOSIT (max. Einzahlung pro Aktion in USDC) frisch aus der
 * .env-Datei. Wichtig: process.env kann im laufenden Bot-Prozess veraltet sein,
 * weil ForgeSettings die .env zur Laufzeit ändert. cleanup.js ist ein eigener
 * Prozess (liest process.env beim Start) — der Bot-Langläufer muss frisch lesen,
 * damit der Cap auch beim Öffnen einer neuen Position (reaktivierter Pool) greift.
 * Parsing identisch zu cleanup.js: 0 = kein Limit, Werte < 10 werden ignoriert.
 * @returns {number} Cap in USDC, 0 = kein Limit
 */
export function getCleanupMaxDepositFromEnv() {
    const envPath = path.join(__dirname, '..', '.env');
    let raw = process.env.CLEANUP_MAX_DEPOSIT;
    if (existsSync(envPath)) {
        const m = readFileSync(envPath, 'utf-8').match(/^CLEANUP_MAX_DEPOSIT\s*=\s*(.*)$/m);
        if (m) raw = m[1].trim();
    }
    const v = parseFloat(raw ?? '0');
    return v >= 10 ? v : 0;
}

/**
 * Liest CLEANUP_MIN_DEPOSIT (min. Einzahlung pro Aktion in USDC) frisch aus der
 * .env-Datei — analog zu getCleanupMaxDepositFromEnv(). Dient als absoluter Floor
 * beim Öffnen/Reaktivieren einer Position: liegt das verfügbare Wallet-Kapital
 * darunter, wird keine neue Position eröffnet (verhindert wirtschaftlich unsinnige
 * Mini-Positionen, deren TX-Fees den Ertrag auffressen). Der Bot-Langläufer muss
 * frisch lesen, weil ForgeSettings die .env zur Laufzeit ändert.
 * Parsing identisch zu cleanup.js: 0 = kein Minimum, Werte < 1 werden ignoriert.
 * @returns {number} Floor in USDC, 0 = kein Minimum
 */
export function getCleanupMinDepositFromEnv() {
    const envPath = path.join(__dirname, '..', '.env');
    let raw = process.env.CLEANUP_MIN_DEPOSIT;
    if (existsSync(envPath)) {
        const m = readFileSync(envPath, 'utf-8').match(/^CLEANUP_MIN_DEPOSIT\s*=\s*(.*)$/m);
        if (m) raw = m[1].trim();
    }
    const v = parseFloat(raw ?? '0');
    return v >= 1 ? v : 0;
}

/**
 * Liest CLEANUP_TREND_GATE (Komma-Liste geforderter Trend-Zeitebenen, z.B. '4h,1d')
 * frisch aus der .env-Datei — analog zu getCleanupModeFromEnv(). Leer/fehlend =
 * Gate aus, also unverändertes Verhalten.
 *
 * Der Bot-Langläufer muss frisch lesen, weil ForgeSettings die .env zur Laufzeit
 * ändert und bin/export.js den Gate-Zustand jede Minute ins Dashboard schreibt —
 * eine im Prozess eingefrorene Einstellung würde dort eine andere Wahrheit zeigen
 * als der stündliche Cleanup anwendet.
 * @returns {string|null} Rohwert, Parsing über lib/trend-indicators.js parseTrendGate()
 */
export function getCleanupTrendGateFromEnv() {
    const envPath = path.join(__dirname, '..', '.env');
    if (!existsSync(envPath)) return process.env.CLEANUP_TREND_GATE ?? null;
    const m = readFileSync(envPath, 'utf-8').match(/^CLEANUP_TREND_GATE\s*=\s*(.*)$/m);
    return m ? m[1].trim() : (process.env.CLEANUP_TREND_GATE ?? null);
}

/**
 * Schreibt CLEANUP_MODE in die Liquidity-.env (persistent über Restarts).
 * Wird beim Liquidieren eines Pools aufgerufen, wenn dieser das feste
 * Cleanup-Ziel (CLEANUP_MODE=pool:<id>) war – siehe setPoolActive.
 */
export function setCleanupModeInEnv(newMode) {
    const envPath = path.join(__dirname, '..', '.env');
    if (!existsSync(envPath)) return;
    let text = readFileSync(envPath, 'utf-8');
    if (/^CLEANUP_MODE\s*=/m.test(text)) {
        text = text.replace(/^CLEANUP_MODE\s*=.*$/m, `CLEANUP_MODE=${newMode}`);
    } else {
        text += `\nCLEANUP_MODE=${newMode}\n`;
    }
    writeFileSync(envPath, text, 'utf-8');
    console.log(`[config] CLEANUP_MODE → ${newMode} (.env aktualisiert)`);
}
