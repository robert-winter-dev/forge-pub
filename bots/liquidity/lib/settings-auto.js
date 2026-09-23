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
 * 🔒 Eine **vorhandene** Sektion ist eine
 * Nutzerentscheidung und wird nie überschrieben. Diese Funktion greift ausschließlich beim
 * Neuzugang. Bestehende Fehlstände korrigiert die Migration
 * `lib/migrations/0004-trailing-stop-pool-type-defaults.js` (`node bin/migrate.js`).
 *
 * Priorität zwischen CLI-Opt-out und Typ-Default (LIQ#0363, geklärt statt nebenbei
 * entschieden): `opts.arm === false` ist eine explizite, einmalige Entscheidung für GENAU
 * diese Einzahlung und schlägt immer. Ist er nicht gesetzt (Normalfall), entscheidet der
 * Typ-Default, falls im Tab „Pool Typen" gepflegt; sonst bleibt es beim globalen Default
 * (`true`). Es gibt kein Gegenstück, das `arm=true` gegen einen deaktivierten Typ erzwingt.
 *
 * @param {string} poolId
 * @param {string|null} poolType  `pool.poolType` aus pools.json; ohne ihn bleibt es beim globalen Default
 * @param {Object} [opts]
 * @param {boolean} [opts.arm]  Default `true`. `false` (LIQ#0362, UI-Opt-out bei Erst-Einzahlung):
 *   legt die Sektion trotzdem an, aber mit `enabled:false` — zählt danach als vorhandene
 *   Sektion/Nutzerentscheidung und wird nie nachträglich scharf geschaltet.
 */
export function ensureTrailingStopDefaults(poolId, poolType, opts = {}) {
    const arm = opts.arm !== false;
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

        const fromType         = poolType ? readPoolTypeTrailingStop(db, poolType) : null;
        const effectiveEnabled = !arm ? false : (fromType?.enabled ?? true);
        current.trailingStop = {
            ...POOL_SETTINGS_DEFAULTS.trailingStop,
            ...(fromType ?? {}),
            enabled: effectiveEnabled,
        };

        db.prepare(`
            INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES ('liquidity', ?, ?)
            ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
        `).run(poolId, JSON.stringify(current));

        db.close();
        const src = fromType ? `Pool-Typ ${poolType}` : 'globaler Default';
        if (!arm) {
            console.log(`[settings-auto] ${poolId}: Trailing Stop bei Erst-Einzahlung per Opt-out deaktiviert angelegt`);
        } else if (!effectiveEnabled) {
            console.log(`[settings-auto] ${poolId}: Trailing Stop laut ${src} deaktiviert angelegt`);
        } else {
            console.log(`[settings-auto] ${poolId}: Trailing Stop eingerichtet aus ${src} – Drawdown 1 ${current.trailingStop.thresholdPct} %, Drawdown 2 ${current.trailingStop.thresholdPct2 ?? 'aus'}`);
        }
    } catch (err) {
        console.warn(`[settings-auto] ${poolId}: Trailing-Stop-Default konnte nicht gesetzt werden: ${err.message}`);
    }
}

/**
 * Liest die im Tab „Pool Typen" gepflegten Trailing-Stop-Werte eines Pool-Typs:
 * Drawdown-Schwellen und `enabled` (LIQ#0363 — vorher fehlte `enabled` komplett, ein neuer
 * Pool erbte nie die Typ-Deaktivierung). Gibt `null` zurück, wenn der Typ ungepflegt ist
 * (weder Schwellen noch `enabled` gesetzt) — dann bleibt es beim globalen Default, statt
 * einen Pool mit lauter Nullwerten anzulegen.
 *
 * Schwellen und `enabled` sind unabhängig gültig: ein Typ mit `enabled:false` aber ohne
 * gepflegte Schwellen liefert `{ enabled: false }` ohne thresholdPct — sonst würde die
 * Deaktivierung wieder verschluckt, sobald niemand die Schwellen angefasst hat.
 */
export function readPoolTypeTrailingStop(db, poolType) {
    try {
        const row = db.prepare(
            `SELECT settings FROM pool_type_settings WHERE bot_id = 'liquidity' AND pool_type = ?`
        ).get(poolType);
        if (!row) return null;

        const ts = JSON.parse(row.settings)?.trailingStop ?? {};
        const p1 = Number(ts.thresholdPct);
        const hasThresholds = Number.isFinite(p1) && p1 > 0;
        const hasEnabled    = typeof ts.enabled === 'boolean';
        if (!hasThresholds && !hasEnabled) return null;

        const result = {};
        if (hasThresholds) {
            const p2 = Number(ts.thresholdPct2);
            result.thresholdPct  = p1;
            result.thresholdPct2 = (Number.isFinite(p2) && p2 > 0) ? p2 : null;
        }
        if (hasEnabled) result.enabled = ts.enabled;
        return result;
    } catch {
        return null;
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
 * @param {Object} [opts]
 * @param {boolean} [opts.arm]  Default `true`. `false` (LIQ#0362, UI-Opt-out bei Erst-Einzahlung):
 *   `level1.enabled` wird auf `false` erzwungen, statt aus dem Default zu übernehmen.
 *   Gilt nur, solange noch keine `tvlProtection`-Sektion existiert — ist bereits eine
 *   vorhanden, überschreibt diese Funktion `enabled` ohnehin nie (siehe unten).
 */
export function ensureTvlProtectionDefaults(poolId, currentTvl, defaults = {}, opts = {}) {
    const arm = opts.arm !== false;
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

        const hadSection = current.tvlProtection && typeof current.tvlProtection === 'object';
        const existing    = current.tvlProtection ?? {};
        const tp = {
            ...DEFAULT_TVL_PROTECTION,
            ...existing,
            level1: { ...DEFAULT_TVL_PROTECTION.level1, ...(existing.level1 ?? {}) },
        };

        // Opt-out greift nur beim Neuanlegen — eine bestehende Sektion ist bereits eine
        // Nutzerentscheidung (an oder aus) und wird hier wie zuvor nicht überschrieben.
        if (!hadSection && !arm) tp.level1.enabled = false;

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
        console.log(`[settings-auto] ${poolId}: TVL-Schutz-Defaults gesichert (tvlAtActivation=${tp.tvlAtActivation ?? 'n/a'}, level1.enabled=${tp.level1.enabled})`);
    } catch (err) {
        console.warn(`[settings-auto] ${poolId}: TVL-Schutz-Defaults konnten nicht gesetzt werden: ${err.message}`);
    }
}
