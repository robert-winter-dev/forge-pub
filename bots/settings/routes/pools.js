/**
 * /api/pools – Pool-Einstellungen (Trailing Stop, TVL-Schutz, Auto Compounding)
 *
 * GET /api/pools/liquidity              → alle Pools + gespeicherte Einstellungen
 * GET /api/pools/liquidity/:poolId      → Einstellungen eines Pools
 * PUT /api/pools/liquidity/:poolId      → Einstellungen speichern (Body: { autoCompound?, trailingStop?, tvlProtection?, cleanup?, maxInvestment? })
 *
 * Konfiguration liegt in settings.db (Tabelle: pool_settings).
 * Pool-Liste kommt aus bots/liquidity/config/pools.json.
 *
 * Hinweis: Diese Routen speichern nur die Konfiguration.
 * Die Ausführungslogik (Preis-Check, Withdraw, Swap, Send) muss separat
 * im Liquidity-Bot implementiert werden.
 */

import { Router }        from 'express';
import fs                from 'fs';
import path              from 'path';
import { fileURLToPath } from 'url';
import Database          from 'better-sqlite3';
import { PATHS }         from '../../../config/paths.js';
import { t } from '../../../lib/i18n.js';
import { renderReason } from '../../../lib/pool-reason.js';
import { POOL_SETTINGS_DEFAULTS, POOL_SESSION_FIELDS, diffFromDefaults, diffChangedFields }
    from '../../../lib/pool-settings-defaults.js';
import { HISTORY_SOURCES, ensureSourceColumn } from '../../../lib/migrations/_settings-history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POOLS_JSON  = PATHS.liquidityPools;
const LIQUIDITYBOT_DATA   = path.join(PATHS.html, 'liquidity', 'data', 'data.json');
const SCORES_JSON = PATHS.liquidityScores;
const OPP_DATA    = LIQUIDITYBOT_DATA; // Opportunity Scores sind im gleichen data.json wie das Dashboard
const SETTINGS_DB = PATHS.settingsDb;
const LIQUIDITYBOT_DB     = PATHS.liquidityDb;

/**
 * Liest Trailing-Stop-Status (HWM, aktueller LP-Wert, Snapshot-Zeit) für alle Pools.
 * Read-only auf liquiditybot.db (Liquidity Bot ist alleinige Schreibinstanz). Stille Fallbacks
 * — wenn die DB fehlt oder keine offene Position existiert, gibt es keinen Eintrag.
 *
 * Pendente HWM-Resets (noch nicht vom Bot übernommen): Wenn settings.db einen
 * resetRequestedAt-Zeitstempel enthält und der Bot ihn noch nicht verarbeitet hat
 * (hwm_at < resetRequestedAt), wird resetTargetUsd als hwmUsd angezeigt.
 * Dadurch ist der zurückgesetzte Wert sofort und nach einem Reload sichtbar.
 *
 * @returns {Object<string, { hwmUsd, hwmAt, currentUsd, snapshotAt, pendingReset? }>}
 */
function loadTrailingStopStatus() {
    const map = {};
    try {
        const db = new Database(LIQUIDITYBOT_DB, { readonly: true, fileMustExist: true });
        const positions = db.prepare(
            `SELECT pool_id, hwm_usd, hwm_at, entry_usd, d2_armed_at FROM positions WHERE closed_at IS NULL`
        ).all();
        const latestSnap = db.prepare(
            `SELECT lp_value_usd, fees_pending_usd, recorded_at FROM position_snapshots
             WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
        );
        for (const p of positions) {
            const snap = latestSnap.get(p.pool_id);
            // Der Bot vergleicht seit 2026-08-30 LP-Wert + offene Fees gegen die HWM
            // (latestStopValueUsd in bots/liquidity/lib/db.js) — das Modal muss denselben
            // Wert zeigen, sonst weicht der angezeigte Puffer vom echten ab.
            const currentUsd = snap?.lp_value_usd != null
                ? snap.lp_value_usd + (snap.fees_pending_usd > 0 ? snap.fees_pending_usd : 0)
                : null;
            map[p.pool_id] = {
                hwmUsd:     p.hwm_usd ?? null,
                hwmAt:      p.hwm_at  ?? null,
                currentUsd,
                snapshotAt: snap?.recorded_at  ?? null,
                // Zweistufiger Trailing Stop: Das UI muss die tatsächlich geltende Schwelle
                // anzeigen, nicht immer Stufe 1 — sonst stünde im Modal ein Liquidationswert,
                // der nicht dem entspricht, bei dem der Bot wirklich aussteigt.
                entryUsd:   p.entry_usd   ?? null,
                d2ArmedAt:  p.d2_armed_at ?? null,
            };
        }
        db.close();
    } catch {
        return map;
    }

    // Pendente Resets aus settings.db einblenden: solange der Bot sie noch nicht
    // übernommen hat (hwm_at < resetRequestedAt), zeigen wir resetTargetUsd als HWM.
    try {
        const sdb  = new Database(SETTINGS_DB, { readonly: true, fileMustExist: true });
        const rows = sdb.prepare(
            `SELECT pool_id, settings FROM pool_settings WHERE bot_id = 'liquidity'`
        ).all();
        sdb.close();
        for (const row of rows) {
            const ts = JSON.parse(row.settings)?.trailingStop;
            if (!(ts?.resetRequestedAt > 0) || !(ts?.resetTargetUsd > 0)) continue;
            const entry = map[row.pool_id];
            if (!entry) continue; // keine offene Position → kein Status-Block
            if ((entry.hwmAt ?? 0) < ts.resetRequestedAt) {
                entry.hwmUsd      = ts.resetTargetUsd;
                entry.pendingReset = true;
            }
        }
    } catch {
        // best-effort — zeigt im Zweifel den liquiditybot.db-Wert
    }

    return map;
}

/**
 * Rekonstruiert den TVL bei Pool-Aktivierung für offene Positionen aus liquiditybot.db.
 * Wird als Anzeige-Fallback genutzt, wenn tvlProtection.tvlAtActivation noch nicht
 * vom Bot gesetzt wurde (z.B. Positionen, die vor dem TVL-Schutz-Feature eröffnet
 * wurden). Nimmt den pool_stats-Wert mit recorded_at am nächsten zur Eröffnungszeit.
 * Read-only; wird NICHT in settings.db zurückgeschrieben (Bot ist Schreibinstanz).
 * @returns {Object<string, number>}
 */
function loadActivationTvls() {
    try {
        const db = new Database(LIQUIDITYBOT_DB, { readonly: true, fileMustExist: true });
        const positions = db.prepare(
            `SELECT pool_id, opened_at FROM positions WHERE closed_at IS NULL`
        ).all();
        const nearest = db.prepare(
            `SELECT tvl_usd FROM pool_stats WHERE pool_id = ? AND tvl_usd > 0
             ORDER BY ABS(recorded_at - ?) ASC LIMIT 1`
        );
        const map = {};
        for (const p of positions) {
            const row = nearest.get(p.pool_id, p.opened_at);
            if (row?.tvl_usd > 0) map[p.pool_id] = row.tvl_usd;
        }
        db.close();
        return map;
    } catch {
        return {};
    }
}

/**
 * Trendzustand je poolId aus data.json (`pool.trendGate.state`, geschrieben von
 * bots/liquidity/bin/export.js aus lib/trend-indicators.js).
 *
 * Das Cleanup-Modal braucht ihn, um „Aktuell bester Pool" **live** an die gesetzten
 * Trend-Haken anzupassen — also schon bevor gespeichert wurde. Deshalb kommt der
 * Zustand roh herüber und nicht das fertige Gate-Ergebnis aus dem Export: dessen
 * `required` spiegelt die gespeicherte .env, nicht die gerade angeklickten Haken.
 */
function loadTrendStates() {
    try {
        const data = JSON.parse(fs.readFileSync(LIQUIDITYBOT_DATA, 'utf8'));
        const map  = {};
        for (const p of (data.pools ?? [])) {
            if (p.id && p.trendGate?.state) map[p.id] = p.trendGate.state;
        }
        return map;
    } catch {
        return {};
    }
}

/**
 * Herkunft der Score-Daten aus data.json (siehe bin/export.js, 2026-07-25):
 * 'compute' = lokal gerechnet, 'delivered' = über Premium geliefert, 'none' = kein
 * Score verfügbar. Steuert in der Oberfläche die Premium-Anzeige des Scores.
 * Default 'compute': bestehende FORGE-Installationen ohne den neuen Provider-Code
 * (vor Commit dcdb053) haben kein scoreSource-Feld in ihrer data.json.
 */
function loadScoreState() {
    try {
        const data = JSON.parse(fs.readFileSync(LIQUIDITYBOT_DATA, 'utf8'));
        // Seit CORE#000931 liefert Premium die Edge statt des Scores — der Premium-Zustand
        // kommt deshalb aus edgeSource/edgeStale; scoreSource nur für eine data.json vom
        // alten Export. Die Feldnamen der API (scoreSource/scoreStale) bleiben, bis
        // LIQ#000932 den Score-Unterbau entfernt.
        if (data.edgeSource) return { source: data.edgeSource, stale: !!data.edgeStale };
        return { source: data.scoreSource ?? 'compute', stale: !!data.scoreStale };
    } catch {
        return { source: 'compute', stale: false };
    }
}

/** Aktuellen Pool-TVL (pools[].tvl) je poolId aus data.json lesen */
function loadPoolTvls() {
    try {
        const data  = JSON.parse(fs.readFileSync(LIQUIDITYBOT_DATA, 'utf8'));
        const pools = data.pools ?? [];
        const map   = {};
        for (const p of pools) {
            if (p.id && p.tvl != null) map[p.id] = p.tvl;
        }
        return map;
    } catch {
        return {};
    }
}

/**
 * Trailing-Stop-Advisor-Empfehlung je Pool aus data.json (LIQ#0351).
 *
 * Quelle ist bewusst data.json und nicht die Bot-DB: Auf dem Fork gibt es die
 * Advisor-Tabellen gar nicht, die Empfehlung kommt dort über den Premium-Kanal. Der
 * Export legt beides auf denselben Lesepfad — genau wie bei `scoreSource`.
 */
function loadTsAdvice() {
    try {
        const data = JSON.parse(fs.readFileSync(LIQUIDITYBOT_DATA, 'utf8'));
        const map  = {};
        for (const p of data.pools ?? []) {
            if (p.id && p.tsAdvice) map[p.id] = p.tsAdvice;
        }
        return map;
    } catch {
        return {};
    }
}

/** Aktuellen Positionswert (myValue) je poolId aus data.json lesen */
function loadCurrentValues() {
    try {
        const data      = JSON.parse(fs.readFileSync(LIQUIDITYBOT_DATA, 'utf8'));
        const positions = data.positions ?? [];
        const map       = {};
        for (const p of positions) {
            if (p.poolId && p.myValue != null) map[p.poolId] = p.myValue;
        }
        return map;
    } catch {
        return {};
    }
}

/**
 * Gebuchtes Kapital (positions.capital_usdc) je Pool mit offener Position.
 * Bewusst NICHT der Markt-Wert (lp_value_usd, siehe loadCurrentValues) — Max
 * Investment vergleicht gegen das eingezahlte Kapital, siehe Begründung in
 * lib/pool-settings-defaults.js (maxInvestment). Read-only auf liquiditybot.db.
 * @returns {Object<string, number>}
 */
function loadCapitalUsdc() {
    try {
        const db = new Database(LIQUIDITYBOT_DB, { readonly: true, fileMustExist: true });
        const rows = db.prepare(
            `SELECT pool_id, capital_usdc FROM positions WHERE closed_at IS NULL`
        ).all();
        db.close();
        const map = {};
        for (const r of rows) map[r.pool_id] = r.capital_usdc ?? 0;
        return map;
    } catch {
        return {};
    }
}

// ── Standard-Einstellungen (leere Konfiguration) ──────────────────────────────
// Quelle: lib/pool-settings-defaults.js — dieselbe Datei nutzt der Liquidity Bot,
// damit „Default" auf beiden Seiten dasselbe bedeutet (der Bot vergleicht beim
// Pool-Close dagegen, um vom Default abweichende Einstellungen zu protokollieren).
const DEFAULT_SETTINGS = POOL_SETTINGS_DEFAULTS;

// Pool-Typen: bewusst dupliziert statt aus bots/liquidity/lib/pool-type-advisor.js importiert
// (POOL_TYPES) — dieses Modul lädt beim Import u.a. config.js/pnl.js des Liquidity Bots und
// würde damit liquidity-bot-spezifische Env-Voraussetzungen in den Settings-Server-Prozess
// hineinziehen. Bei Änderung der Pool-Typen beide Stellen synchron halten.
const POOL_TYPES = ['rebalance_free', 'volatil_1', 'volatil_2', 'volatil_3', 'rwa'];

// Default für den "Pool Typen"-Tab: nur Buchhaltung des zuletzt eingetragenen Bulk-Werts,
// nicht der tatsächliche (danach ggf. wieder abweichende) Zustand der Einzel-Pools.
//
// Bewusst NICHT enthalten: trailingStop.minimumValueUsd und tvlProtection.level1.thresholdUsd —
// beide hängen eng an der konkreten Kapitalgröße/Historie eines einzelnen Pools und ergeben
// pool-typ-weit keinen Sinn (Festlegung LIQ-Pool-Typen-Refactor 2026-08-30).
const DEFAULT_POOL_TYPE_SETTINGS = {
    trailingStop: {
        enabled: true, thresholdPct: null, thresholdPct2: null,
        auto: false, autoSwapToUSDC: true, sendTo: '',
        // Nicht duplizieren: der TS-Cooldown-Default (6 h seit LIQ#0359) lebt in
        // lib/pool-settings-defaults.js, dieselbe Quelle wie der Liquidity Bot.
        cooldownHours: POOL_SETTINGS_DEFAULTS.trailingStop.cooldownHours,
    },
    tvlProtection: {
        level1: { enabled: true, withdrawPct: 100 },
        swapToUsdc: true, sendTo: '', cooldownHours: 12,
    },
    enabled: true,
};

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

export function openDb() {
    const db = new Database(SETTINGS_DB);
    db.exec(`
        CREATE TABLE IF NOT EXISTS pool_settings (
            bot_id   TEXT NOT NULL,
            pool_id  TEXT NOT NULL,
            settings TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (bot_id, pool_id)
        );
        CREATE TABLE IF NOT EXISTS pool_type_settings (
            bot_id     TEXT NOT NULL,
            pool_type  TEXT NOT NULL,
            settings   TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (bot_id, pool_type)
        );
        CREATE TABLE IF NOT EXISTS settings_history (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id     TEXT NOT NULL,
            scope      TEXT NOT NULL,   -- 'pool' | 'pool_type'
            scope_id   TEXT NOT NULL,   -- pool_id bzw. pool_type
            field      TEXT NOT NULL,   -- Punkt-Pfad, z.B. 'trailingStop.thresholdPct2'
            old_value  TEXT,            -- JSON-kodiert (unterscheidet null von "null"/0/false)
            new_value  TEXT,
            changed_at INTEGER NOT NULL,
            source     TEXT NOT NULL DEFAULT 'user'   -- HISTORY_SOURCES, lib/migrations/_settings-history.js
        );
        CREATE INDEX IF NOT EXISTS idx_settings_history_scope
            ON settings_history (bot_id, scope, scope_id, changed_at);
    `);
    // Spalte `source` auf einer bestehenden Tabelle nachrüsten (LIQ#0366) — idempotent, wie
    // das CREATE TABLE darüber. Ausgeliefert wird der Schritt formal von
    // lib/migrations/0007-settings-history-source.js; diese Zeile ist die Selbstheilung für
    // den Fall, dass bin/migrate.js (noch) nicht gelaufen ist — ohne sie schlägt der erste
    // Save mit „no such column: source" fehl.
    try { ensureSourceColumn(db); } catch { /* readonly o.ä. → der Schreibpfad meldet es */ }
    return db;
}

/**
 * Schreibt jede geänderte Blattfeld-Einstellung als eigene Zeile in settings_history.
 *
 * 🔒 Grund fürs Nachrüsten (2026-08-23): Weder pool_settings noch pool_type_settings
 * trugen bisher einen Zeitstempel — eine Frage wie „wann wurde thresholdPct2 auf 0,5
 * geändert" ließ sich nur zufällig über einen zeitnahen ts_executions-Eintrag eingrenzen,
 * und ganz ohne Auslösung in der Nähe gar nicht. Diese Funktion läuft an jedem Schreibpfad
 * für pool_settings/pool_type_settings mit (saveSettings() und der Pool-Typen-Bulk-Write).
 *
 * Session-Felder (POOL_SESSION_FIELDS, z.B. tvlAtActivation) sind bewusst ausgenommen —
 * das ist Bot-Zustand, keine Nutzer-Entscheidung, und würde die Historie mit
 * Positions-Rauschen zumüllen.
 *
 * 🔒 `source` ist Pflichtparameter und wird geprüft (LIQ#0366). Der Spalten-Default
 * `'user'` gilt ausschließlich für Altzeilen aus der Zeit vor der Spalte — neuer Code
 * darf sich nie darauf verlassen, sonst schreibt die erste Schreibstelle, die ihn
 * vergisst, wieder eine falsche Nutzerentscheidung in die Historie.
 */
export function recordSettingsHistory(db, botId, scope, scopeId, before, after, source) {
    if (!HISTORY_SOURCES.includes(source)) {
        throw new Error(`recordSettingsHistory: source muss einer von ${HISTORY_SOURCES.join(' | ')} sein (erhalten: ${JSON.stringify(source)})`);
    }
    const changes = diffChangedFields(before, after, { skipPaths: POOL_SESSION_FIELDS });
    if (!changes.length) return;
    const changedAt = Date.now();
    const insert = db.prepare(`
        INSERT INTO settings_history (bot_id, scope, scope_id, field, old_value, new_value, changed_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAll = db.transaction(rows => {
        for (const c of rows) {
            insert.run(botId, scope, scopeId, c.path, JSON.stringify(c.oldValue), JSON.stringify(c.newValue), changedAt, source);
        }
    });
    insertAll(changes);
}

/** Öffnet liquiditybot.db schreibend mit busy_timeout (analog routes/pools-actions.js openLiquidityDbRW). */
function openLiquidityDbRW() {
    const db = new Database(LIQUIDITYBOT_DB);
    db.pragma('busy_timeout = 5000');
    return db;
}

/** True wenn der Pool laut liquiditybot.db eine offene Position hält (analog routes/pools-actions.js). */
function hasOpenPosition(poolId) {
    try {
        const db  = new Database(LIQUIDITYBOT_DB, { readonly: true, fileMustExist: true });
        const row = db.prepare(
            `SELECT 1 FROM positions WHERE pool_id = ? AND closed_at IS NULL LIMIT 1`
        ).get(poolId);
        db.close();
        return !!row;
    } catch {
        return false;
    }
}

/**
 * pools.json ist seit Liquidity Bot v0.4.85 für `active`/`enabled`/`rangeOverride.fixedPct` nur
 * noch der Seed für neue Pools — bei bestehenden Pools ist die liquiditybot.db (Tabelle `pools`)
 * Single Source of Truth (siehe bots/liquidity/lib/config.js `loadPools()` /
 * `lib/db.js` `applyPoolDynamics()`, deren Logik hier gespiegelt wird). Ohne diesen
 * Überlagerungsschritt zeigte Settings veraltete active/enabled-Werte aus der Datei an,
 * obwohl der Bot längst nach dem DB-Wert arbeitet.
 */
export function loadPools() {
    const pools = JSON.parse(fs.readFileSync(POOLS_JSON, 'utf8'));

    let db;
    try {
        db = new Database(LIQUIDITYBOT_DB, { readonly: true, fileMustExist: true });
        const rows = db.prepare(`SELECT id, active, enabled, range_override_fixed_pct, enabled_changed_at, enabled_reason, pool_type FROM pools`).all();
        const byId = new Map(rows.map(r => [r.id, r]));
        for (const p of pools) {
            const row = byId.get(p.id);
            if (!row) continue; // Pool noch nicht in DB → JSON-Wert behalten
            p.active = row.active === 1;
            if (row.enabled !== null && row.enabled !== undefined) {
                p.enabled = row.enabled === 1;
            }
            // Fürs Aktivieren-Tooltip in der Settings-UI: wann + warum wurde die
            // Freigabe zuletzt geändert (siehe setPoolEnabled() in lib/config.js).
            p.enabledChangedAt = row.enabled_changed_at ?? null;
            p.enabledReason    = renderReason(row.enabled_reason);
            // pool_type ist seit LIQ#0332 DB-autoritativ (Vola-Drift-Check schreibt ihn
            // täglich still um) — analog zu applyPoolDynamics() in bots/liquidity/lib/db.js.
            // Ohne diese Überlagerung rechnete der Settings-Server nach einem Drift mit dem
            // veralteten pools.json-Typ (Effektiv-Settings UND Bulk-Write, LIQ#0378).
            if (row.pool_type !== null && row.pool_type !== undefined) {
                p.poolType = row.pool_type;
            }
            if (row.range_override_fixed_pct !== null && row.range_override_fixed_pct !== undefined
                && p.rangeOverride && typeof p.rangeOverride === 'object') {
                p.rangeOverride.fixedPct = row.range_override_fixed_pct;
            }
        }
    } catch { /* DB/Spalten (noch) nicht bereit → JSON-Seed-Werte behalten */ }
    finally { try { db?.close(); } catch { /* ignore */ } }

    return pools;
}

/**
 * Liefert die Parameter eines Pools, die den Default überschreiben.
 *
 * Bewusst gegen die ROHEN DB-Werte (nicht gegen das Ergebnis von loadSettings) —
 * dort ist bereits alles mit den Defaults gemergt, ein Diff wäre danach nutzlos.
 *
 * Seit 2026-08-15 überleben Pool-Einstellungen jeden Kapitalabzug (siehe
 * resetPoolSessionState in bots/liquidity/lib/config.js). Damit ein abweichender
 * Wert nicht unbemerkt dauerhaft weiterwirkt, weist das UI ihn an der Einstellung
 * selbst aus — diese Liste ist die Grundlage dafür.
 *
 * Was als „Default" gilt, ist dabei gestaffelt — sonst meldete jeder Pool ein halbes
 * Dutzend Abweichungen und der Hinweis wäre wertlos:
 *   1. POOL_SETTINGS_DEFAULTS (global)
 *   2. TVL-Vorbefüllung aus pools.json (tvlWarnThreshold/tvlExitThreshold) — genau das
 *      trägt die UI beim ersten Öffnen selbst ein
 *   3. Tab „Pool Typen": dessen Bulk-Werte sind der Standard für alle Pools dieses Typs.
 *      Ein Pool, der den Wert seines Typs trägt, weicht nicht ab — abweichend ist erst,
 *      wer davon einzeln abgerückt ist.
 *
 * @param {Object} pool  Pool aus loadPools() (für Vorbefüllung und Pool-Typ)
 * @returns {Array<{path, value, defaultValue}>}
 */
function loadNonDefaults(db, botId, pool) {
    const row = db.prepare(
        `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
    ).get(botId, pool.id);
    if (!row) return [];
    try {
        const overrides = {};
        if (pool.tvlWarnThreshold > 0) overrides['tvlProtection.level1.thresholdUsd'] = pool.tvlWarnThreshold;

        if (pool.poolType) {
            const pt = loadPoolTypeSettings(db, botId, pool.poolType);
            const fromType = {
                'trailingStop.enabled':               pt.trailingStop?.enabled,
                'trailingStop.thresholdPct':          pt.trailingStop?.thresholdPct,
                'trailingStop.thresholdPct2':         pt.trailingStop?.thresholdPct2,
                'trailingStop.auto':                  pt.trailingStop?.auto,
                'trailingStop.autoSwapToUSDC':        pt.trailingStop?.autoSwapToUSDC,
                'trailingStop.sendTo':                pt.trailingStop?.sendTo,
                'trailingStop.cooldownHours':         pt.trailingStop?.cooldownHours,
                'tvlProtection.level1.thresholdUsd':  pt.tvlProtection?.level1?.thresholdUsd,
                'tvlProtection.level1.enabled':        pt.tvlProtection?.level1?.enabled,
                'tvlProtection.level1.withdrawPct':    pt.tvlProtection?.level1?.withdrawPct,
                'tvlProtection.swapToUsdc':            pt.tvlProtection?.swapToUsdc,
                'tvlProtection.sendTo':                pt.tvlProtection?.sendTo,
                'tvlProtection.cooldownHours':         pt.tvlProtection?.cooldownHours,
            };
            // Nur übernehmen, wenn der Pool-Typ überhaupt gepflegt ist: ein ungepflegter
            // Typ liefert dieselben lauter-null-Werte wie ein bewusst auf „keine Schwelle"
            // gesetzter. Signal dafür sind ausschließlich die drei Felder, die ohne
            // gespeicherte Zeile null bleiben (thresholdPct/thresholdPct2/thresholdUsd) —
            // die übrigen Felder haben non-null-Defaults (z.B. enabled: true) und wären
            // sonst IMMER „belegt", auch ohne je gespeicherte Pool-Typ-Zeile.
            const isConfigured = pt.trailingStop?.thresholdPct != null
                || pt.trailingStop?.thresholdPct2 != null
                || pt.tvlProtection?.level1?.thresholdUsd != null;
            if (isConfigured) {
                Object.assign(overrides, fromType);
            }
        }
        return diffFromDefaults(JSON.parse(row.settings), overrides);
    } catch {
        return [];
    }
}

export function loadSettings(db, botId, poolId) {
    const row = db.prepare(
        `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
    ).get(botId, poolId);

    if (!row) return structuredClone(DEFAULT_SETTINGS);

    try {
        const saved = JSON.parse(row.settings);

        // Deep merge: DEFAULT_SETTINGS als Basis, gespeicherte Werte überschreiben
        return {
            autoCompound: { ...DEFAULT_SETTINGS.autoCompound, ...(saved.autoCompound ?? {}) },
            trailingStop: { ...DEFAULT_SETTINGS.trailingStop, ...(saved.trailingStop ?? {}) },
            cleanup:      { ...DEFAULT_SETTINGS.cleanup,      ...(saved.cleanup      ?? {}) },
            maxInvestment: { ...DEFAULT_SETTINGS.maxInvestment, ...(saved.maxInvestment ?? {}) },
            tvlProtection: {
                ...DEFAULT_SETTINGS.tvlProtection,
                ...(saved.tvlProtection ?? {}),
                level1: { ...DEFAULT_SETTINGS.tvlProtection.level1, ...(saved.tvlProtection?.level1 ?? {}) },
            },
        };
    } catch {
        return structuredClone(DEFAULT_SETTINGS);
    }
}

function loadPoolTypeSettings(db, botId, poolType) {
    const row = db.prepare(
        `SELECT settings FROM pool_type_settings WHERE bot_id = ? AND pool_type = ?`
    ).get(botId, poolType);

    if (!row) return structuredClone(DEFAULT_POOL_TYPE_SETTINGS);

    try {
        const saved = JSON.parse(row.settings);
        return {
            trailingStop: { ...DEFAULT_POOL_TYPE_SETTINGS.trailingStop, ...(saved.trailingStop ?? {}) },
            tvlProtection: {
                ...DEFAULT_POOL_TYPE_SETTINGS.tvlProtection,
                ...(saved.tvlProtection ?? {}),
                level1: { ...DEFAULT_POOL_TYPE_SETTINGS.tvlProtection.level1, ...(saved.tvlProtection?.level1 ?? {}) },
            },
            enabled: saved.enabled ?? DEFAULT_POOL_TYPE_SETTINGS.enabled,
        };
    } catch {
        return structuredClone(DEFAULT_POOL_TYPE_SETTINGS);
    }
}

/** Schreibt Defaults für alle Pools, die noch keinen DB-Eintrag haben.
 *  Wird beim GET /liquidity aufgerufen — sichert konsistenten Stand nach Pool-Änderungen. */
function initMissingPools(db, botId, pools) {
    const insert = db.prepare(`
        INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES (?, ?, ?)
        ON CONFLICT(bot_id, pool_id) DO NOTHING
    `);
    const existing = new Set(
        db.prepare(`SELECT pool_id FROM pool_settings WHERE bot_id = ?`).all(botId).map(r => r.pool_id)
    );
    for (const pool of pools) {
        if (!existing.has(pool.id)) {
            insert.run(botId, pool.id, JSON.stringify(structuredClone(DEFAULT_SETTINGS)));
        }
    }
}

/**
 * Validiert eine eingehende tvlProtection-Konfiguration.
 * Wirft mit aussagekräftiger Meldung, wenn die Regeln verletzt sind.
 *   - withdrawPct: 0–100, nur 10er-Schritte
 * tvlAtActivation wird ignoriert (nur der Bot schreibt diesen Wert).
 */
function validateTvlProtection(merged) {
    const { level1: l1 } = merged;
    const isStep10 = v => Number.isFinite(v) && v >= 0 && v <= 100 && v % 10 === 0;

    if (l1.enabled && !isStep10(l1.withdrawPct))
        throw new Error(t('api.pools.tvl_pct_step_l1'));

    if (l1.enabled) {
        if (!(Number(l1.thresholdUsd) > 0))
            throw new Error(t('api.pools.tvl_threshold_l1'));
    }
}

// Untergrenze und Nachkommastellen der Drawdown-Schwellen. Muss mit
// MIN_THRESHOLD_PCT/MAX_THRESHOLD_PCT in bots/liquidity/lib/trailing-stop.js
// übereinstimmen — der Bot clamped sonst still auf einen anderen Wert, als das UI anzeigt.
const TS_MIN_PCT      = 0.5;
const TS_MAX_PCT      = 90;
const TS_DECIMALS     = 2;

const roundPct = v => Math.round(v * 10 ** TS_DECIMALS) / 10 ** TS_DECIMALS;

/**
 * Validiert und normalisiert die beiden Drawdown-Stufen des Trailing Stops.
 * Mutiert `merged` (rundet die Schwellen auf zwei Nachkommastellen).
 *
 * Regeln:
 *   - beide Schwellen liegen zwischen 0,5 und 90 %
 *   - Stufe 2 ist optional (null = einstufig) und muss strikt enger als Stufe 1 sein
 *   - Stufe 2 ohne Stufe 1 ergibt keinen Sinn: die Scharfschaltung von Stufe 2 wird an
 *     Stufe 1 gemessen, ohne sie gäbe es keinen Auslösepunkt
 */
/**
 * Darf „Auto" für diesen Pool eingeschaltet werden? (LIQ#0351)
 *
 * Zwei Bedingungen, beide notwendig:
 *   1. Es liegt eine belastbare Empfehlung vor (`tsAdvice.available`). Ein Schalter, der
 *      nichts bewirkt, darf nicht einschaltbar sein.
 *   2. Die Empfehlung stammt aus einer Quelle, die es hier wirklich gibt — auf dem Fork
 *      heißt das Premium ('delivered'), auf dem Master rechnet der Advisor selbst ('local').
 *      'none' ist beides nicht.
 *
 * 🔒 Diese Prüfung gehört auf den Server, nicht nur ins UI: Ein `disabled`-Attribut im
 * Browser ist Bedienkomfort, keine Absicherung — ein direkter PUT umginge es.
 */
function canEnableTsAuto(poolId) {
    const advice = loadTsAdvice()[poolId];
    return !!advice?.available && (advice.source === 'local' || advice.source === 'delivered');
}

function validateTrailingStop(merged, poolId = null) {
    const inRange = v => Number.isFinite(v) && v >= TS_MIN_PCT && v <= TS_MAX_PCT;

    // „Auto" nur zulassen, wenn es auch etwas zu übernehmen gibt.
    merged.auto = !!merged.auto;
    if (merged.auto && poolId && !canEnableTsAuto(poolId)) {
        throw new Error(t('api.pools.trailing_auto_unavailable'));
    }

    const p1 = Number(merged.thresholdPct);
    if (!inRange(p1)) throw new Error(t('api.pools.trailing_drawdown_range'));
    merged.thresholdPct = roundPct(p1);

    const raw2 = merged.thresholdPct2;
    if (raw2 == null || raw2 === '') {
        merged.thresholdPct2 = null;
        return;
    }

    const p2 = Number(raw2);
    if (!inRange(p2)) throw new Error(t('api.pools.trailing_drawdown2_range'));
    if (roundPct(p2) >= merged.thresholdPct) throw new Error(t('api.pools.trailing_drawdown2_order'));
    merged.thresholdPct2 = roundPct(p2);
}

/**
 * @param {{source: 'user'|'migration'|'bot'}} opts  Herkunft der Änderung, landet in
 *        settings_history. Bewusst ohne Default (LIQ#0366): ein stillschweigendes
 *        `'user'` würde einen Bulk-Write als Hand-Änderung verbuchen und
 *        `userTouched()` verfälschen. `'strategy'` war ein weiterer möglicher Wert,
 *        bis das Strategie-Feature in LIQ#000921 entfernt wurde — historische Zeilen
 *        in settings_history bleiben davon unberührt.
 */
export function saveSettings(db, botId, poolId, partial, opts = {}) {
    const { source } = opts;
    const current = loadSettings(db, botId, poolId);
    const before  = structuredClone(current);
    // Nur bekannte Sektionen übernehmen
    if (partial.autoCompound !== undefined) current.autoCompound = { ...current.autoCompound, ...partial.autoCompound };
    if (partial.trailingStop !== undefined) {
        const merged = { ...current.trailingStop, ...partial.trailingStop };
        validateTrailingStop(merged, poolId);
        current.trailingStop = merged;
    }
    if (partial.cleanup      !== undefined) current.cleanup      = { ...current.cleanup,      ...partial.cleanup      };
    if (partial.maxInvestment !== undefined) {
        const merged = { ...current.maxInvestment, ...partial.maxInvestment };
        const amt = merged.amountUsdc;
        if (amt !== null && amt !== '' && amt !== undefined) {
            const n = Number(amt);
            if (!Number.isFinite(n) || n <= 0) throw new Error(t('api.pools.max_investment_range'));
            merged.amountUsdc = n;
        } else {
            merged.amountUsdc = null;
        }
        merged.enabled = !!merged.enabled;
        current.maxInvestment = merged;
    }
    if (partial.tvlProtection !== undefined) {
        const p = partial.tvlProtection;
        // Stufen-Objekte auf die erlaubten Felder beschränken (swap/sendTo sind global,
        // nicht pro Stufe → tote Altfelder aus früheren Versionen aussortieren).
        const cleanLevel = (cur, inc) => {
            const m = { ...cur, ...inc };
            return { enabled: !!m.enabled, thresholdUsd: m.thresholdUsd ?? null, withdrawPct: m.withdrawPct };
        };
        const merged = {
            ...current.tvlProtection,
            ...p,
            // tvlAtActivation niemals vom UI überschreiben lassen
            tvlAtActivation: current.tvlProtection.tvlAtActivation,
            level1: cleanLevel(current.tvlProtection.level1, p.level1 ?? {}),
        };
        validateTvlProtection(merged);
        current.tvlProtection = merged;
    }

    db.prepare(`
        INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES (?, ?, ?)
        ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
    `).run(botId, poolId, JSON.stringify(current));

    recordSettingsHistory(db, botId, 'pool', poolId, before, current, source);

    return current;
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();

// ── GET /liquidity ─────────────────────────────────────────────────────────────────
router.get('/liquidity', (req, res) => {
    try {
        const pools = loadPools();
        const db    = openDb();

        initMissingPools(db, 'liquidity', pools);

        const values         = loadCurrentValues();
        const tsStatus       = loadTrailingStopStatus();
        const trendStates    = loadTrendStates();
        const scoreState     = loadScoreState();
        const poolTvls       = loadPoolTvls();
        const tsAdviceMap    = loadTsAdvice();
        const activationTvls = loadActivationTvls();
        const capitalUsdc     = loadCapitalUsdc();

        const result = pools.map(pool => {
            const settings = loadSettings(db, 'liquidity', pool.id);
            // Anzeige-Fallback: tvlAtActivation rückwirkend aus Position-Open rekonstruieren,
            // solange der Bot ihn noch nicht gesetzt hat (nicht in DB persistiert).
            if (settings.tvlProtection?.tvlAtActivation == null && activationTvls[pool.id] != null) {
                settings.tvlProtection.tvlAtActivation = activationTvls[pool.id];
            }

            return {
                id:                 pool.id,
                pair:               pool.pair,
                displayPair:        pool.displayPair ?? pool.pair,
                poolType:           pool.poolType ?? null,
                active:             pool.active,
                enabled:            pool.enabled !== false, // Benutzer-Freigabe (Default: freigegeben)
                enabledChangedAt:   pool.enabledChangedAt ?? null,
                enabledReason:      pool.enabledReason    ?? null,
                btcPricePoolId:     pool.btcPricePoolId  ?? null,
                // Herkunftsmarker: true nur für per Pool-Offer übernommene Pools (LIQ#0380,
                // s. bot-liquidity.js isOfferPool) — NICHT dasselbe wie cleanup.rankingEligible,
                // das der Nutzer auch über den Modus "Cleanup inaktiv" selbst setzen kann.
                premiumOffer:       !!pool.premiumOffer,
                usdcIsTokenA:       pool.usdcIsTokenA    ?? false,
                volatilePair:       pool.volatilePair     ?? false,
                uiDepositDisabled:  pool.uiDepositDisabled ?? false,
                currentValue:       values[pool.id]       ?? null,
                capitalUsdc:        capitalUsdc[pool.id]  ?? null,
                trendState:         trendStates[pool.id]  ?? null,
                scoreSource:        scoreState.source,
                scoreStale:         scoreState.stale,
                // Advisor-Empfehlung + Begründung; steuert die Auto-Checkbox im
                // Trailing-Stop-Tab (verfügbar / gesperrt mit Grund).
                tsAdvice:           tsAdviceMap[pool.id]  ?? { available: false, source: 'none', reason: null },
                currentTvl:         poolTvls[pool.id]     ?? null,
                // Vorbefüllungs-Defaults für den TVL-Schutz (aus pools.json)
                tvlWarnDefault:     pool.tvlWarnThreshold ?? null,
                tvlExitDefault:     pool.tvlExitThreshold ?? null,
                settings,
                // Vom Default abweichende Parameter — das UI markiert sie, weil sie
                // seit 2026-08-15 jeden Kapitalabzug überleben.
                nonDefault:         loadNonDefaults(db, 'liquidity', pool),
                trailingStopStatus: tsStatus[pool.id]    ?? null,
            };
        });

        db.close();
        res.set('Cache-Control', 'no-store');
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /liquidity/scores ──────────────────────────────────────────────────────────
// Liefert den Pool-Score-Snapshot (Netto-APR, Trend, 3-2-1 Allokation).
// Wird vom Cron-Job alle 15 Min via `bin/pool-explorer.js --snapshot` aktualisiert.
router.get('/liquidity/scores', (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        if (!fs.existsSync(SCORES_JSON)) {
            return res.json({ available: false });
        }
        const data = JSON.parse(fs.readFileSync(SCORES_JSON, 'utf-8'));
        const ageMs = Date.now() - (data.generated_ts ?? 0);
        res.json({ available: true, ageMs, ...data });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /liquidity/opportunity ────────────────────────────────────────────────────
// Liefert Opportunity-Scores aller Pools (6h/12h/24h/7d) aus data.json.
// Gleiche Berechnungs-Grundlage wie das Dashboard (kein doppelter Code).
router.get('/liquidity/opportunity', (req, res) => {
    try {
        res.set('Cache-Control', 'no-store');
        if (!fs.existsSync(OPP_DATA)) {
            return res.json({ available: false });
        }
        const data  = JSON.parse(fs.readFileSync(OPP_DATA, 'utf-8'));
        const opp   = data.opportunityScores ?? {};
        const ageMs = Date.now() - (data.generated_ts ?? data.ts ?? 0);
        // Flach als Array: [{id, scores: {6h,12h,24h,7d}}]
        const pools = Object.entries(opp).map(([id, scores]) => ({ id, scores }));
        res.json({ available: pools.length > 0, ageMs, pools });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /liquidity/advisor-hints ──────────────────────────────────────────────────
// Gibt aktuelle Range-Advisor-Empfehlungen zurück – nur wenn actionable.
// Bedingungen (alle erfüllt):
//   - Pool aktiv, nicht locked
//   - nur STABILE Empfehlungen (action_taken = 'notified') — keine rohen, noch
//     schwankenden Zwischenstände (z.B. daily_scan 'rejected_no_change' = „noch
//     nicht stabil"). Verhindert, dass eine instabile Empfehlung im Tooltip landet.
//   - die Empfehlung wurde für die AKTUELL konfigurierte Range berechnet
//     (current_range_pct == fixedPct). Nach einer Range-Änderung wird kein veralteter
//     Hint mehr gegen die neue Range angezeigt (driftFactor koppelt die Empfehlung an
//     die Ist-Range, siehe #0198 — ein gegen eine alte Range berechneter Wert ist
//     hier nicht mehr aussagekräftig).
//   - recommended != current, Konfidenz high oder medium, nicht älter als 48 h
// Format: [{ poolId, currentPct, recommendedPct, confidence, createdAt }]
router.get('/liquidity/advisor-hints', (req, res) => {
    const HINT_STALE_MS = 48 * 60 * 60 * 1000;
    try {
        const pools = loadPools();
        let db;
        try {
            db = new Database(LIQUIDITYBOT_DB, { readonly: true, fileMustExist: true });
        } catch {
            return res.json([]); // DB nicht erreichbar → keine Hints
        }
        const cutoff = Date.now() - HINT_STALE_MS;
        const stmt   = db.prepare(
            `SELECT recommended_range_pct, current_range_pct, confidence, payback_hours, created_at
               FROM advisor_decisions
              WHERE pool_id = ? AND triggered_by IN ('range_hint','daily_scan')
                AND action_taken = 'notified'
                AND created_at >= ?
              ORDER BY created_at DESC LIMIT 1`
        );
        const hints = pools.flatMap(p => {
            if (!p.active) return [];
            if (p.rangeOverride?.locked === true) return []; // manuell fixiert, Advisor greift hier nicht
            const currentPct = p.rangeOverride?.fixedPct ?? null;
            if (currentPct == null) return [];
            const row = stmt.get(p.id, cutoff);
            if (!row) return [];
            if (row.current_range_pct !== currentPct) return []; // gegen alte Range berechnet → veraltet
            if (currentPct === row.recommended_range_pct) return [];
            if (!['high', 'medium'].includes(row.confidence)) return [];
            return [{ poolId: p.id, currentPct, recommendedPct: row.recommended_range_pct,
                      confidence: row.confidence,
                      paybackHours: row.payback_hours ?? null, createdAt: row.created_at }];
        });
        db.close();
        res.json(hints);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /liquidity/:poolId ─────────────────────────────────────────────────────────
// ── GET /liquidity/pool-types ──────────────────────────────────────────────────────
// Default-Werte + Pool-Anzahl je Pool-Typ, für den "Pool Typen"-Tab.
router.get('/liquidity/pool-types', (req, res) => {
    try {
        const pools = loadPools();
        const db    = openDb();
        const result = POOL_TYPES.map(poolType => {
            const typePools = pools.filter(p => p.poolType === poolType);
            const investedPools = typePools
                .filter(p => hasOpenPosition(p.id))
                .map(p => ({ id: p.id, displayPair: p.displayPair ?? p.pair }));
            return {
                poolType,
                poolCount: typePools.length,
                settings:  loadPoolTypeSettings(db, 'liquidity', poolType),
                investedPools,
            };
        });
        db.close();
        res.set('Cache-Control', 'no-store');
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PUT /liquidity/pool-types/:poolType ────────────────────────────────────────────
// Body: {
//   trailingStop:  { enabled, thresholdPct, thresholdPct2, auto, autoSwapToUSDC, sendTo, cooldownHours },
//   tvlProtection: { level1: { enabled, withdrawPct }, swapToUsdc, sendTo, cooldownHours },
//   enabled?: boolean,  // Kapitalannahme des ganzen Typs (unabhängig von den Sektionen oben)
// }
// Schreibt die Werte SOFORT in die individuellen Settings ALLER Pools dieses Typs
// (echter Bulk-Write, kein Template/Override-Konzept — Bestätigung dazu liegt im UI).
// `trailingStop.minimumValueUsd` und `tvlProtection.level1.thresholdUsd` werden NIE
// angefasst (nicht Teil dieser Sektionen — pool-individuell, siehe DEFAULT_POOL_TYPE_SETTINGS-
// Kommentar). Scheitert validateTvlProtection()/validateTrailingStop() dennoch für einen
// einzelnen Pool (z.B. TVL-Schutz aktiviert, aber der Pool hat nie eine eigene Schwelle
// gesetzt → thresholdUsd bleibt null), landet er in `failed` statt die ganze Aktion
// abzubrechen.
router.put('/liquidity/pool-types/:poolType', (req, res) => {
    const { poolType } = req.params;
    if (!POOL_TYPES.includes(poolType)) {
        return res.status(400).json({ error: t('api.pools.unknown_pool_type', { poolType }) });
    }

    const body = req.body;
    if (typeof body !== 'object' || Array.isArray(body) || body === null) {
        return res.status(400).json({ error: t('api.common.body_object') });
    }

    const thresholdPctRaw = body.trailingStop?.thresholdPct;
    if (thresholdPctRaw !== undefined) {
        const v = Number(thresholdPctRaw);
        if (!Number.isFinite(v) || v < TS_MIN_PCT || v > TS_MAX_PCT) {
            return res.status(400).json({ error: t('api.pools.trailing_drawdown_range') });
        }
    }
    // Trailing-Stop-Stufe 2 im Bulk-Pfad: dieselben Regeln wie beim Einzel-Pool. '' und
    // null bedeuten ausdrücklich „zweite Stufe aus", nicht „unverändert" — der Bulk-Tab
    // schreibt immer beide Werte, sonst bliebe bei einzelnen Pools eine alte Stufe 2 stehen.
    const threshold2Raw = body.trailingStop?.thresholdPct2;
    if (threshold2Raw !== undefined && threshold2Raw !== null && threshold2Raw !== '') {
        const v2 = Number(threshold2Raw);
        if (!Number.isFinite(v2) || v2 < TS_MIN_PCT || v2 > TS_MAX_PCT) {
            return res.status(400).json({ error: t('api.pools.trailing_drawdown2_range') });
        }
        if (thresholdPctRaw === undefined || thresholdPctRaw === null || thresholdPctRaw === '') {
            return res.status(400).json({ error: t('api.pools.trailing_drawdown2_needs_first') });
        }
        if (v2 >= Number(thresholdPctRaw)) {
            return res.status(400).json({ error: t('api.pools.trailing_drawdown2_order') });
        }
    }
    const validateCooldown = (raw, errKey) => {
        if (raw === undefined) return undefined;
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 1 || v > 24) {
            throw new Error(t(errKey));
        }
        return v;
    };
    const validateStep10 = (raw, errKey) => {
        if (raw === undefined) return undefined;
        const v = Number(raw);
        if (!Number.isFinite(v) || v < 0 || v > 100 || v % 10 !== 0) {
            throw new Error(t(errKey));
        }
        return v;
    };
    let tsCooldown, tvlCooldown, tvlPct;
    try {
        tsCooldown  = validateCooldown(body.trailingStop?.cooldownHours,  'api.pools.cooldown_range');
        tvlCooldown = validateCooldown(body.tvlProtection?.cooldownHours, 'api.pools.cooldown_range');
        tvlPct      = validateStep10(body.tvlProtection?.level1?.withdrawPct, 'api.pools.tvl_pct_step_l1');
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
        return res.status(400).json({ error: t('api.pools.enabled_boolean') });
    }

    try {
        const pools = loadPools().filter(p => p.poolType === poolType);

        // Deaktivieren des ganzen Pool-Typs nur erlaubt, wenn KEIN Pool dieses Typs
        // eine offene Position hält — bereits ein investierter Pool blockiert die
        // gesamte Aktion (kein Teilerfolg, kein stillschweigendes Überspringen).
        if (body.enabled === false) {
            const invested = pools.filter(p => hasOpenPosition(p.id));
            if (invested.length > 0) {
                return res.status(409).json({
                    error: t('api.pools.pool_type_has_positions', { count: invested.length, pools: invested.map(p => p.id).join(', ') }),
                    poolIds: invested.map(p => p.id),
                });
            }
        }

        // ── Type-Default persistieren (nur Buchhaltung fürs UI) ──
        const db = openDb();
        const oldTypeSettings = loadPoolTypeSettings(db, 'liquidity', poolType);
        const newTypeSettings = {
            trailingStop: {
                enabled:        body.trailingStop?.enabled ?? DEFAULT_POOL_TYPE_SETTINGS.trailingStop.enabled,
                thresholdPct:   thresholdPctRaw != null && thresholdPctRaw !== '' ? Number(thresholdPctRaw) : null,
                thresholdPct2:  threshold2Raw   != null && threshold2Raw   !== '' ? Number(threshold2Raw)   : null,
                auto:           !!body.trailingStop?.auto,
                autoSwapToUSDC: body.trailingStop?.autoSwapToUSDC ?? DEFAULT_POOL_TYPE_SETTINGS.trailingStop.autoSwapToUSDC,
                sendTo:         body.trailingStop?.sendTo ?? '',
                cooldownHours:  tsCooldown ?? DEFAULT_POOL_TYPE_SETTINGS.trailingStop.cooldownHours,
            },
            tvlProtection: {
                level1: {
                    enabled:     !!body.tvlProtection?.level1?.enabled,
                    withdrawPct: tvlPct ?? DEFAULT_POOL_TYPE_SETTINGS.tvlProtection.level1.withdrawPct,
                },
                swapToUsdc:    body.tvlProtection?.swapToUsdc ?? DEFAULT_POOL_TYPE_SETTINGS.tvlProtection.swapToUsdc,
                sendTo:        body.tvlProtection?.sendTo ?? '',
                cooldownHours: tvlCooldown ?? DEFAULT_POOL_TYPE_SETTINGS.tvlProtection.cooldownHours,
            },
            enabled: body.enabled ?? true,
        };
        db.prepare(`
            INSERT INTO pool_type_settings (bot_id, pool_type, settings) VALUES (?, ?, ?)
            ON CONFLICT(bot_id, pool_type) DO UPDATE SET settings = excluded.settings
        `).run('liquidity', poolType, JSON.stringify(newTypeSettings));
        recordSettingsHistory(db, 'liquidity', 'pool_type', poolType, oldTypeSettings, newTypeSettings, 'user');

        // ── Bulk-Write Trailing-Stop/TVL in die individuellen Pool-Settings ──
        const updated = [];
        const failed  = [];
        for (const pool of pools) {
            try {
                const partial = {};
                if (body.trailingStop !== undefined) {
                    // "Drawdown Auto" ist zwingend pool-gebunden (canEnableTsAuto() braucht
                    // eine belastbare Advisor-Empfehlung FÜR DIESEN Pool) — beim Bulk-Write
                    // über einen ganzen Typ hat das selten jeder Pool. Ein hartes Scheitern
                    // des gesamten Pools nur wegen dieses einen Feldes wäre unverhältnismäßig
                    // (Drawdown/Swap/Senden-an/Cooldown würden sonst mit-verworfen) und
                    // erzeugte einen unübersichtlichen Sammel-Fehler-Toast (LIQ#0354,
                    // Befund Rollout 30.08.). Für nicht-qualifizierte Pools wird "auto"
                    // still auf false geklemmt, ohne eigene Rückmeldung — das Info-Icon am
                    // Feld erklärt bereits dauerhaft, wann es greift; ein Toast bei jedem
                    // Speichern wäre reine Wiederholung, und
                    // sichtbar bleibt es ohnehin über den "weicht vom Typ-Default ab"-Hinweis
                    // im Pool-Modal.
                    const autoAllowed = !newTypeSettings.trailingStop.auto || canEnableTsAuto(pool.id);
                    partial.trailingStop = {
                        enabled:        newTypeSettings.trailingStop.enabled,
                        thresholdPct:   Number(thresholdPctRaw),
                        thresholdPct2:  newTypeSettings.trailingStop.thresholdPct2,
                        auto:           autoAllowed && newTypeSettings.trailingStop.auto,
                        autoSwapToUSDC: newTypeSettings.trailingStop.autoSwapToUSDC,
                        sendTo:         newTypeSettings.trailingStop.sendTo,
                        cooldownHours:  newTypeSettings.trailingStop.cooldownHours,
                        // minimumValueUsd bewusst nicht gesetzt — bleibt beim Pool-individuellen Wert.
                    };
                }
                if (body.tvlProtection !== undefined) {
                    partial.tvlProtection = {
                        level1: {
                            enabled:     newTypeSettings.tvlProtection.level1.enabled,
                            withdrawPct: newTypeSettings.tvlProtection.level1.withdrawPct,
                            // thresholdUsd bewusst nicht gesetzt — bleibt beim Pool-individuellen Wert.
                        },
                        swapToUsdc:    newTypeSettings.tvlProtection.swapToUsdc,
                        sendTo:        newTypeSettings.tvlProtection.sendTo,
                        cooldownHours: newTypeSettings.tvlProtection.cooldownHours,
                    };
                }
                if (Object.keys(partial).length > 0) {
                    saveSettings(db, 'liquidity', pool.id, partial, { source: 'user' });
                }
                updated.push(pool.id);
            } catch (err) {
                failed.push({ poolId: pool.id, reason: err.message });
            }
        }
        db.close();

        // ── Bulk-Toggle "Aktiviert" (pools.enabled in liquiditybot.db) ──
        if (body.enabled !== undefined) {
            const rwDb = openLiquidityDbRW();
            try {
                for (const pool of pools) {
                    if (body.enabled === false && hasOpenPosition(pool.id)) {
                        failed.push({ poolId: pool.id, reason: t('api.pools.pool_has_position') });
                        continue;
                    }
                    rwDb.prepare(`UPDATE pools SET enabled = ? WHERE id = ?`).run(body.enabled ? 1 : 0, pool.id);
                }
            } finally {
                rwDb.close();
            }
        }

        res.json({ ok: true, poolType, poolCount: pools.length, updated, failed });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/liquidity/:poolId', (req, res) => {
    try {
        const pools  = loadPools();
        const pool   = pools.find(p => p.id === req.params.poolId);
        if (!pool) return res.status(404).json({ error: t('api.common.pool_not_found') });

        const db         = openDb();
        const settings   = loadSettings(db, 'liquidity', pool.id);
        const nonDefault = loadNonDefaults(db, 'liquidity', pool);
        db.close();

        res.json({ id: pool.id, pair: pool.pair, active: pool.active, settings, nonDefault });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── GET /liquidity/:poolId/history ──────────────────────────────────────────────────
// Änderungshistorie für rückwirkende Auswertung (2026-08-23, siehe recordSettingsHistory()):
// zeigt sowohl direkt am Pool geänderte Felder (scope='pool') als auch Bulk-Änderungen über
// den Reiter "Pool Typen" (scope='pool_type', gilt für ALLE Pools dieses Typs gemeinsam) —
// ohne beide Quellen sähe ein Pool, der nur über seinen Typ geändert wurde, aus, als hätte
// sich nie etwas geändert.
router.get('/liquidity/:poolId/history', (req, res) => {
    try {
        const pools = loadPools();
        const pool  = pools.find(p => p.id === req.params.poolId);
        if (!pool) return res.status(404).json({ error: t('api.common.pool_not_found') });

        const db   = openDb();
        const rows = db.prepare(`
            SELECT scope, scope_id AS scopeId, field, old_value AS oldValue, new_value AS newValue, changed_at AS changedAt
              FROM settings_history
             WHERE bot_id = 'liquidity'
               AND ((scope = 'pool' AND scope_id = ?) OR (scope = 'pool_type' AND scope_id = ?))
             ORDER BY changed_at DESC
             LIMIT 200
        `).all(pool.id, pool.poolType ?? '');
        db.close();

        res.json({
            id: pool.id,
            history: rows.map(r => ({
                ...r,
                oldValue: JSON.parse(r.oldValue ?? 'null'),
                newValue: JSON.parse(r.newValue ?? 'null'),
            })),
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PUT /liquidity/:poolId ─────────────────────────────────────────────────────────
router.put('/liquidity/:poolId', (req, res) => {
    try {
        const pools = loadPools();
        const pool  = pools.find(p => p.id === req.params.poolId);
        if (!pool) return res.status(404).json({ error: t('api.common.pool_not_found') });

        const partial = req.body;
        if (typeof partial !== 'object' || Array.isArray(partial)) {
            return res.status(400).json({ error: t('api.common.body_object') });
        }

        const db      = openDb();
        const updated = saveSettings(db, 'liquidity', pool.id, partial, { source: 'user' });
        db.close();

        res.json({ ok: true, settings: updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── POST /liquidity/:poolId/trailing-stop/reset ────────────────────────────────────
// Markiert einen HWM-Reset-Request in settings.db. Der Liquidity-Bot konsumiert das
// Flag im nächsten Tick und setzt positions.hwm_usd auf den aktuellen lp_value_usd.
// Wir schreiben hier NICHT direkt in liquiditybot.db — der Bot ist alleinige Schreibinstanz.
router.post('/liquidity/:poolId/trailing-stop/reset', (req, res) => {
    try {
        const pools = loadPools();
        const pool  = pools.find(p => p.id === req.params.poolId);
        if (!pool) return res.status(404).json({ error: t('api.common.pool_not_found') });

        const db      = openDb();
        const current = loadSettings(db, 'liquidity', pool.id);
        if (!current.trailingStop?.enabled) {
            db.close();
            return res.status(400).json({ error: t('api.pools.trailing_not_active') });
        }
        const targetHwm = Number(req.body?.targetHwm) || null;
        current.trailingStop = {
            ...current.trailingStop,
            resetRequestedAt: Date.now(),
            ...(targetHwm > 0 ? { resetTargetUsd: targetHwm } : {}),
        };
        db.prepare(`
            INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES (?, ?, ?)
            ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
        `).run('liquidity', pool.id, JSON.stringify(current));
        db.close();

        res.json({ ok: true, resetRequestedAt: current.trailingStop.resetRequestedAt });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
