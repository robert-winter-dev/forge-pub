/**
 * FORGE Liquidity – Automatische Settings-Aktivierung bei Pool-Aktivierung
 *
 * Wird aufgerufen wenn ein Pool zum ersten Mal (oder erneut) einzahlt
 * und auf active=true gesetzt wird.
 */

import Database      from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';
import { config }          from './config.js';
import { PATHS } from '../../../config/paths.js';
import { POOL_SETTINGS_DEFAULTS } from '../../../lib/pool-settings-defaults.js';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const SETTINGS_DB = PATHS.settingsDb;

export const DEFAULT_SCORE_LIMIT = {
    enabled:    false,
    minScore:   30,
    swapToUsdc: true,
    sendTo:     '',
};

// TVL-Schutz-Default: jeder Pool startet mit aktiver Stufe 1 (100 % Exit + Swap→USDC).
// Angeglichen 2026-08-15 an die gelebte Konfiguration aller Pools — vorher lief der
// Voll-Exit über eine (inzwischen entfernte) zweite Stufe und ein neuer Pool startete
// gegenläufig zum Bestand. Die Schwelle wird mit dem **Exit**-Wert aus pools.json
// vorbefüllt (nicht mit dem höheren Warn-Wert), damit die Umstellung den Voll-Exit
// nicht früher auslöst als zuvor.
export const DEFAULT_TVL_PROTECTION = {
    level1: { enabled: true, thresholdUsd: null, withdrawPct: 100 },
    swapToUsdc:      true,
    sendTo:          '',
    // Cleanup-Cooldown: hält AUSSCHLIESSLICH den Cleanup (bin/cleanup.js) davon ab,
    // einen gerade verlassenen Pool wieder zu befüllen. Der TVL-Schutz selbst läuft
    // unabhängig davon weiter — er darf nie durch diesen Wert ausgesperrt werden.
    // 12 h (vorher 1 h): Mit 1 h durchlief SOL/ZEC am 2026-08-13 binnen sechs Stunden
    // zweimal den Zyklus „Pool reaktiviert → Kapital rein → TVL-Schutz zieht ab →
    // Exit", jedes Mal mit Transaktionskosten.
    cooldownHours:   12,
    tvlAtActivation: null,
};

/**
 * Setzt trailingStop.minimumValueUsd bei jeder Pool-(Re-)Aktivierung auf null zurück.
 *
 * Anders als die Drawdown-Schwelle (%) oder die TVL-Schutz-Werte ist der "Pool
 * Mindestwert" ein absoluter USD-Betrag, der an die Kapitalgröße der jeweiligen
 * Position gebunden ist. Bleibt er nach dem Schließen einer Position bestehen
 * (z.B. nach TVL-Exit, Score-Limit-Exit oder manuellem Close – nicht nach dem
 * Mindestwert-Exit selbst, dafür sorgt bereits clearMinimumValue() reaktiv),
 * kann er bei einer kleineren Neueinzahlung wieder zu früh greifen.
 *
 * @param {string} poolId
 */
export function ensureTrailingStopMinimumReset(poolId) {
    try {
        const db = new Database(SETTINGS_DB);
        db.exec(`
            CREATE TABLE IF NOT EXISTS pool_settings (
                bot_id   TEXT NOT NULL,
                pool_id  TEXT NOT NULL,
                settings TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (bot_id, pool_id)
            )
        `);

        const row = db.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        if (!row) { db.close(); return; }

        const current = JSON.parse(row.settings);
        if (current.trailingStop?.minimumValueUsd == null) { db.close(); return; }

        const oldValue = current.trailingStop.minimumValueUsd;
        current.trailingStop.minimumValueUsd = null;

        db.prepare(
            `UPDATE pool_settings SET settings = ? WHERE bot_id = ? AND pool_id = ?`
        ).run(JSON.stringify(current), config.botId, poolId);

        db.close();
        console.log(`[settings-auto] ${poolId}: trailingStop.minimumValueUsd bei Reaktivierung zurückgesetzt (war ${oldValue} USDC)`);
    } catch (err) {
        console.warn(`[settings-auto] ${poolId}: trailingStop.minimumValueUsd konnte nicht zurückgesetzt werden: ${err.message}`);
    }
}

/**
 * Legt die Trailing-Stop-Sektion eines Neuzugangs mit den Schwellen **seines Pool-Typs** an.
 *
 * Die Einstellungs-Hierarchie ist dreistufig dokumentiert (siehe Kopf von `loadNonDefaults`
 * im Settings-Server): global → Vorbefüllung aus pools.json → Tab „Pool Typen". Stufe 3 wurde
 * bis 2026-08-22 aber ausschließlich für die „abweichend"-Markierung im UI ausgewertet und floss
 * nie in die wirksamen Werte ein: Der Tab schreibt seine Werte per einmaligem Bulk-Write in die
 * `pool_settings` aller **damals** vorhandenen Pools. Wer danach dazukam — jeder Pool aus dem
 * Scanner — erbte nichts und lief im Bot auf dem globalen Fallback von 10 % statt der für
 * seinen Typ gepflegten Schwelle, ohne zweite Stufe.
 *
 * Beobachtet am 2026-08-22: `liq-zbcn-sol` (Typ `volatil_3`) stand mit Höchststand 1603,62 und
 * Einstiegsreferenz 1387,41 rund 15 % im Plus, `d2_armed_at` war NULL. Ein Rückgang von +5 % auf
 * +2,15 % konnte nicht auslösen, weil die wirksame Schwelle 10 % statt 2 % war. Gleiches Muster
 * bei `liq-wbtc-sol` (Typ `volatil_1`).
 *
 * 🔒 Wie bei `ensureScoreLimitEnabled` gilt: Eine **vorhandene** Sektion ist eine
 * Nutzerentscheidung und wird nie überschrieben. Diese Funktion greift ausschließlich beim
 * Neuzugang. Bestehende Fehlstände korrigiert die Migration
 * `lib/migrations/0004-trailing-stop-pool-type-defaults.js` (`node bin/migrate.js`).
 *
 * @param {string} poolId
 * @param {string|null} poolType  `pool.poolType` aus pools.json; ohne ihn bleibt es beim globalen Default
 */
export function ensureTrailingStopDefaults(poolId, poolType) {
    try {
        const db = new Database(SETTINGS_DB);
        db.exec(`
            CREATE TABLE IF NOT EXISTS pool_settings (
                bot_id   TEXT NOT NULL,
                pool_id  TEXT NOT NULL,
                settings TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (bot_id, pool_id)
            )
        `);

        const row = db.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        const current = row ? JSON.parse(row.settings) : {};

        // Sektion vorhanden → Nutzerentscheidung, unangetastet lassen.
        if (current.trailingStop && typeof current.trailingStop === 'object') {
            db.close();
            return;
        }

        const fromType = poolType ? readPoolTypeTrailingStop(db, poolType) : null;
        current.trailingStop = {
            ...POOL_SETTINGS_DEFAULTS.trailingStop,
            ...(fromType ?? {}),
        };

        db.prepare(`
            INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES ('liquidity', ?, ?)
            ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
        `).run(poolId, JSON.stringify(current));

        db.close();
        const src = fromType ? `Pool-Typ ${poolType}` : 'globaler Default';
        console.log(`[settings-auto] ${poolId}: Trailing Stop eingerichtet aus ${src} – Drawdown 1 ${current.trailingStop.thresholdPct} %, Drawdown 2 ${current.trailingStop.thresholdPct2 ?? 'aus'}`);
    } catch (err) {
        console.warn(`[settings-auto] ${poolId}: Trailing-Stop-Default konnte nicht gesetzt werden: ${err.message}`);
    }
}

/**
 * Liest die im Tab „Pool Typen" gepflegten Drawdown-Schwellen eines Pool-Typs.
 * Gibt `null` zurück, wenn der Typ ungepflegt ist (beide Schwellen leer) — dann bleibt es
 * beim globalen Default, statt einen Pool mit lauter Nullwerten anzulegen.
 */
export function readPoolTypeTrailingStop(db, poolType) {
    try {
        const row = db.prepare(
            `SELECT settings FROM pool_type_settings WHERE bot_id = 'liquidity' AND pool_type = ?`
        ).get(poolType);
        if (!row) return null;

        const ts = JSON.parse(row.settings)?.trailingStop ?? {};
        const p1 = Number(ts.thresholdPct);
        if (!Number.isFinite(p1) || p1 <= 0) return null;

        const p2 = Number(ts.thresholdPct2);
        return {
            thresholdPct:  p1,
            thresholdPct2: (Number.isFinite(p2) && p2 > 0) ? p2 : null,
        };
    } catch {
        return null;
    }
}

/**
 * Richtet das InvestScore Limit ein, wenn ein Pool noch gar keine Score-Limit-
 * Einstellung hat. Wird beim Deposit (Pool-Aktivierung) aufgerufen.
 *
 * 🔒 Ein vorhandenes `scoreLimit.enabled` wird respektiert, egal ob an oder aus —
 * seit Pool-Einstellungen den Kapitalabzug überleben (resetPoolSessionState in
 * lib/config.js), ist der gespeicherte Zustand eine Nutzerentscheidung und keine
 * Altlast mehr — sie stillschweigend zu überschreiben wäre genau das Muster, das
 * mit dem Umbau abgeschafft wurde.
 *
 * Ein Pool ohne jede Score-Limit-Sektion ist dagegen ein Neuzugang — der bekommt
 * den Default (`DEFAULT_SCORE_LIMIT.enabled`, seit 2026-08-21 aus).
 */
export function ensureScoreLimitEnabled(poolId) {
    try {
        const db = new Database(SETTINGS_DB);
        db.exec(`
            CREATE TABLE IF NOT EXISTS pool_settings (
                bot_id   TEXT NOT NULL,
                pool_id  TEXT NOT NULL,
                settings TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (bot_id, pool_id)
            )
        `);

        const row = db.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);

        const current = row ? JSON.parse(row.settings) : {};

        // Sektion vorhanden → der Zustand ist eine Nutzerentscheidung, egal ob an oder aus.
        if (current.scoreLimit && typeof current.scoreLimit === 'object') {
            db.close();
            return;
        }

        current.scoreLimit = { ...DEFAULT_SCORE_LIMIT };

        db.prepare(`
            INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES ('liquidity', ?, ?)
            ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
        `).run(poolId, JSON.stringify(current));

        db.close();
        console.log(`[settings-auto] ${poolId}: InvestScore Limit Default gesetzt (enabled=${current.scoreLimit.enabled}, minScore=${current.scoreLimit.minScore})`);
    } catch (err) {
        // Nicht-kritisch – Deposit soll nicht scheitern wegen Settings-Fehler
        console.warn(`[settings-auto] ${poolId}: InvestScore Limit Default konnte nicht gesetzt werden: ${err.message}`);
    }
}

/**
 * Stellt beim ersten Deposit (Pool-Aktivierung) die TVL-Schutz-Defaults sicher
 * und schreibt den TVL bei Aktivierung fest.
 *
 * - Legt tvlProtection an, falls noch nicht vorhanden (L2 aktiv, 100 % + Swap).
 * - tvlAtActivation wird bei JEDER (Re-)Aktivierung neu auf den aktuellen TVL
 *   gesetzt — er bezieht sich auf den Zeitpunkt des aktuellen Pool-Engagements.
 * - Schwellen vorbefüllen aus pools.json (tvlWarn/Exit), falls noch null.
 * - Bestehende, vom Nutzer gesetzte enabled/Schwellen werden NICHT überschrieben.
 *
 * @param {string} poolId
 * @param {number} currentTvl   Aktueller Pool-TVL (USDC), z.B. aus pool_stats
 * @param {Object} [defaults]   { warn, exit } – pools.json-Schwellen zur Vorbefüllung
 */
export function ensureTvlProtectionDefaults(poolId, currentTvl, defaults = {}) {
    try {
        const db = new Database(SETTINGS_DB);
        db.exec(`
            CREATE TABLE IF NOT EXISTS pool_settings (
                bot_id   TEXT NOT NULL,
                pool_id  TEXT NOT NULL,
                settings TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (bot_id, pool_id)
            )
        `);

        const row     = db.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        const current = row ? JSON.parse(row.settings) : {};

        const existing = current.tvlProtection ?? {};
        const tp = {
            ...DEFAULT_TVL_PROTECTION,
            ...existing,
            level1: { ...DEFAULT_TVL_PROTECTION.level1, ...(existing.level1 ?? {}) },
        };

        // Schwelle vorbefüllen (nur wenn noch nicht gesetzt). Bewusst der Exit-Wert:
        // seit der Umstellung 2026-08-15 ist Stufe 1 die Voll-Exit-Stufe, und ein
        // Voll-Exit muss beim Ernstfall-Wert greifen, nicht schon bei der Warnschwelle.
        if (tp.level1.thresholdUsd == null && defaults.exit > 0) tp.level1.thresholdUsd = defaults.exit;

        // TVL bei Aktivierung festschreiben (bei jeder Aktivierung neu)
        if (Number(currentTvl) > 0) tp.tvlAtActivation = Number(currentTvl);

        current.tvlProtection = tp;

        db.prepare(`
            INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES ('liquidity', ?, ?)
            ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
        `).run(poolId, JSON.stringify(current));

        db.close();
        console.log(`[settings-auto] ${poolId}: TVL-Schutz-Defaults gesichert (tvlAtActivation=${tp.tvlAtActivation ?? 'n/a'})`);
    } catch (err) {
        console.warn(`[settings-auto] ${poolId}: TVL-Schutz-Defaults konnten nicht gesetzt werden: ${err.message}`);
    }
}
