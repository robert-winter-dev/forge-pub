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

const __dirname   = dirname(fileURLToPath(import.meta.url));
const SETTINGS_DB = PATHS.settingsDb;

export const DEFAULT_SCORE_LIMIT = {
    enabled:    true,
    minScore:   30,
    swapToUsdc: true,
    sendTo:     '',
};

// TVL-Schutz-Default: jeder Pool startet mit aktiver Stufe 1 (100 % Exit + Swap→USDC),
// Stufe 2 bleibt aus. Angeglichen 2026-08-15 an die gelebte Konfiguration aller Pools —
// vorher lief der Voll-Exit hier über Stufe 2 und ein neuer Pool startete gegenläufig
// zum Bestand. Die Schwelle für Stufe 1 wird mit dem **Exit**-Wert aus pools.json
// vorbefüllt (nicht mit dem höheren Warn-Wert), damit die Umstellung den Voll-Exit
// nicht früher auslöst als zuvor.
export const DEFAULT_TVL_PROTECTION = {
    level1: { enabled: true,  thresholdUsd: null, withdrawPct: 100 },
    level2: { enabled: false, thresholdUsd: null, withdrawPct: 100 },
    swapToUsdc:      true,   // global für beide Stufen
    sendTo:          '',     // global für beide Stufen
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
 * Richtet das InvestScore Limit ein, wenn ein Pool noch gar keine Score-Limit-
 * Einstellung hat. Wird beim Deposit (Pool-Aktivierung) aufgerufen.
 *
 * 🔒 Ein vorhandenes `scoreLimit.enabled === false` wird seit 2026-08-15 respektiert
 * (vorher: bei jeder Aktivierung zurück auf `true`). Grund: Seit Pool-Einstellungen
 * den Kapitalabzug überleben (resetPoolSessionState in lib/config.js), ist ein
 * gespeichertes „aus" eine Nutzerentscheidung und keine Altlast mehr — sie stillschweigend
 * zu überschreiben wäre genau das Muster, das mit dem Umbau abgeschafft wurde.
 * Sichtbar bleibt es trotzdem: der Default steht auf `true`, ein „aus" erscheint damit
 * im Abweichungs-Hinweis in ForgeSettings.
 *
 * Ein Pool ohne jede Score-Limit-Sektion ist dagegen ein Neuzugang — der bekommt den
 * Schutz eingeschaltet.
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

        current.scoreLimit = { ...DEFAULT_SCORE_LIMIT, enabled: true };

        db.prepare(`
            INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES ('liquidity', ?, ?)
            ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
        `).run(poolId, JSON.stringify(current));

        db.close();
        console.log(`[settings-auto] ${poolId}: InvestScore Limit automatisch aktiviert (minScore=${current.scoreLimit.minScore})`);
    } catch (err) {
        // Nicht-kritisch – Deposit soll nicht scheitern wegen Settings-Fehler
        console.warn(`[settings-auto] ${poolId}: InvestScore Limit konnte nicht aktiviert werden: ${err.message}`);
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
            level2: { ...DEFAULT_TVL_PROTECTION.level2, ...(existing.level2 ?? {}) },
        };

        // Schwelle vorbefüllen (nur wenn noch nicht gesetzt). Bewusst der Exit-Wert für
        // Stufe 1: seit der Umstellung 2026-08-15 ist Stufe 1 die Voll-Exit-Stufe, und ein
        // Voll-Exit muss beim Ernstfall-Wert greifen, nicht schon bei der Warnschwelle.
        // Stufe 2 bleibt ohne Schwelle — sie ist standardmäßig aus; ein sinnvoller Wert
        // dafür liegt unterhalb von Stufe 1 und ist aus pools.json nicht ableitbar.
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
