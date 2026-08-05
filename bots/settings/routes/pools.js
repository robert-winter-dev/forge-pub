/**
 * /api/pools – Pool-Einstellungen (Score Limit, Trailing Stop, Auto Compounding)
 *
 * GET /api/pools/liquidity              → alle Pools + gespeicherte Einstellungen
 * GET /api/pools/liquidity/:poolId      → Einstellungen eines Pools
 * PUT /api/pools/liquidity/:poolId      → Einstellungen speichern (Body: { autoCompound?, scoreLimit?, trailingStop? })
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
            `SELECT pool_id, hwm_usd, hwm_at FROM positions WHERE closed_at IS NULL`
        ).all();
        const latestSnap = db.prepare(
            `SELECT lp_value_usd, recorded_at FROM position_snapshots
             WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
        );
        for (const p of positions) {
            const snap = latestSnap.get(p.pool_id);
            map[p.pool_id] = {
                hwmUsd:     p.hwm_usd ?? null,
                hwmAt:      p.hwm_at  ?? null,
                currentUsd: snap?.lp_value_usd ?? null,
                snapshotAt: snap?.recorded_at  ?? null,
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

/** InvestScore je poolId aus data.json lesen */
function loadInvestScores() {
    try {
        const data  = JSON.parse(fs.readFileSync(LIQUIDITYBOT_DATA, 'utf8'));
        const pools = data.pools ?? [];
        const map   = {};
        for (const p of pools) {
            if (p.id && p.investScore != null) map[p.id] = p.investScore;
        }
        return map;
    } catch {
        return {};
    }
}

/**
 * Herkunft der Score-Daten aus data.json (siehe bin/export.js, 2026-07-25):
 * 'compute' = lokal gerechnet, 'delivered' = über Premium geliefert, 'none' = kein
 * Score verfügbar. Grundlage für die Sichtbarkeits-Bedingung im Risk-Management-Modal
 * ("Zustand immer sichtbar", FORGE.pub-Entscheidung Commit bf8c723) — ein Nutzer darf
 * nie einen Score-Limit-Schalter aktivieren, ohne zu wissen, dass er wirkungslos ist.
 * Default 'compute': bestehende FORGE-Installationen ohne den neuen Provider-Code
 * (vor Commit dcdb053) haben kein scoreSource-Feld in ihrer data.json.
 */
function loadScoreState() {
    try {
        const data = JSON.parse(fs.readFileSync(LIQUIDITYBOT_DATA, 'utf8'));
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
 * Liest die letzten n invest_score_history-Einträge je Pool aus liquiditybot.db (read-only).
 * Gibt { poolId: [{ score, exitScore, recorded_at }, ...] } zurück (neueste zuerst).
 * exitScore fällt auf score zurück, wenn exit_score (Spalte seit 2026-07-03) noch
 * nicht befüllt ist (ältere/rückwirkend gebackfillte Zeilen).
 */
function loadRecentScores(poolIds, n = 5) {
    const map = {};
    if (!poolIds.length) return map;
    try {
        const db   = new Database(LIQUIDITYBOT_DB, { readonly: true, fileMustExist: true });
        const stmt = db.prepare(
            `SELECT score, COALESCE(exit_score, score) AS exitScore, recorded_at FROM invest_score_history
             WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT ?`
        );
        for (const id of poolIds) map[id] = stmt.all(id, n);
        db.close();
    } catch {
        // best-effort – UI zeigt "keine Daten"
    }
    return map;
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

// ── Standard-Einstellungen (leere Konfiguration) ──────────────────────────────
const DEFAULT_SETTINGS = {
    autoCompound: {
        enabled:      true,
        fraction:     100,   // Reinvest-Anteil in % (10–100, 10er-Schritte)
        minClaimUsdc: 1,     // Mindestbetrag zum Claimen (0,1–10 USDC; 0,1 nur zum Testen, Default 1)
        sendTo:       '',    // Empfänger-Adresse (leer = Wallet)
        swapToUsdc:   false, // Coins vor Transfer in USDC tauschen
    },
    // Score Limit: Position schließen wenn InvestScore unter Schwelle fällt.
    //   minScore    – InvestScore-Schwelle (0–100, Default 30)
    //   swapToUsdc  – nach Close alle Coins in USDC tauschen
    //   sendTo      – optional, Empfänger-Adresse (leer = Wallet)
    scoreLimit: {
        enabled:    false,
        minScore:   30,
        swapToUsdc: true,
        sendTo:     '',
    },
    // Ranking-Exit: Pool schließen wenn er X Stunden durchgehend als "bad" bewertet ist
    //  (Tab wurde 2026-05-22 aus dem UI entfernt — Funktion wird neu gebaut.
    //   Sektion bleibt im Schema, damit bestehende DB-Einträge nicht verworfen werden.)
    ranking: {
        enabled:          false,
        badDurationHours: 12,    // 6 | 12 | 24 | 72
    },
    // Trailing Stop: Position schließen wenn lp_value_usd vom HWM um thresholdPct fällt.
    //   thresholdPct      – Drawdown-Schwelle in % (1–90, Default 10)
    //   autoSwapToUSDC    – nach Close alle Coins in USDC tauschen
    //   sendTo            – optional, Empfänger-Adresse (leer = Wallet)
    trailingStop: {
        enabled:         true,
        thresholdPct:    10,
        minimumValueUsd: null,   // Pool-Mindestwert in USDC; null = deaktiviert
        autoSwapToUSDC:  true,
        sendTo:          '',
    },
    // Cleanup-Berücksichtigung: nimmt der Pool am Ranking-basierten Cleanup teil?
    cleanup: {
        rankingEligible: true,
    },
    // TVL-Schutz: zweistufiger Pool-Exit wenn der Pool-TVL unter eine Schwelle fällt.
    //   Eskalation: L1 (Stufe 1) hat die höhere Schwelle, L2 (Stufe 2) die tiefere.
    //   Beim Unterschreiten einer Schwelle wird withdrawPct % des Kapitals abgezogen.
    //   Sind beide Stufen aktiv, muss die Summe der withdrawPct exakt 100 ergeben
    //   (L1 zieht den ersten Teil, L2 den Rest). L1 ist optional deaktivierbar.
    //   thresholdUsd === null → noch nie konfiguriert; UI füllt mit den pools.json-
    //   Schwellen (tvlWarnThreshold/tvlExitThreshold) vor.
    //   tvlAtActivation wird vom Liquidity-Bot beim ersten Deposit gesetzt (read-only fürs UI).
    tvlProtection: {
        level1: {
            enabled:      false,
            thresholdUsd: null,
            withdrawPct:  50,    // 0–100 in 10er-Schritten
        },
        level2: {
            enabled:      true,  // Default: jeder Pool hat L2 aktiv
            thresholdUsd: null,
            withdrawPct:  100,   // Default: 100 % abziehen
        },
        swapToUsdc:      true,   // global für beide Stufen: in USDC tauschen
        sendTo:          '',     // global für beide Stufen: Empfänger (leer = Wallet)
        cooldownHours:   1,
        tvlAtActivation: null,   // nur vom Bot geschrieben
    },
};

// Pool-Typen: bewusst dupliziert statt aus bots/liquidity/lib/pool-type-advisor.js importiert
// (POOL_TYPES) — dieses Modul lädt beim Import u.a. config.js/pnl.js des Liquidity Bots und
// würde damit liquidity-bot-spezifische Env-Voraussetzungen in den Settings-Server-Prozess
// hineinziehen. Bei Änderung der Pool-Typen beide Stellen synchron halten.
const POOL_TYPES = ['rebalance_free', 'volatil_1', 'volatil_2', 'volatil_3', 'rwa'];

// Default für den "Pool Typen"-Tab: nur Buchhaltung des zuletzt eingetragenen Bulk-Werts,
// nicht der tatsächliche (danach ggf. wieder abweichende) Zustand der Einzel-Pools.
const DEFAULT_POOL_TYPE_SETTINGS = {
    trailingStop: { thresholdPct: null },
    tvlProtection: {
        level1: { thresholdUsd: null },
        level2: { thresholdUsd: null },
    },
    enabled: true,
};

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function openDb() {
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
        )
    `);
    return db;
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
function loadPools() {
    const pools = JSON.parse(fs.readFileSync(POOLS_JSON, 'utf8'));

    let db;
    try {
        db = new Database(LIQUIDITYBOT_DB, { readonly: true, fileMustExist: true });
        const rows = db.prepare(`SELECT id, active, enabled, range_override_fixed_pct FROM pools`).all();
        const byId = new Map(rows.map(r => [r.id, r]));
        for (const p of pools) {
            const row = byId.get(p.id);
            if (!row) continue; // Pool noch nicht in DB → JSON-Wert behalten
            p.active = row.active === 1;
            if (row.enabled !== null && row.enabled !== undefined) {
                p.enabled = row.enabled === 1;
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

function loadSettings(db, botId, poolId) {
    const row = db.prepare(
        `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
    ).get(botId, poolId);

    if (!row) return structuredClone(DEFAULT_SETTINGS);

    try {
        const saved = JSON.parse(row.settings);

        // Deep merge: DEFAULT_SETTINGS als Basis, gespeicherte Werte überschreiben
        return {
            autoCompound: { ...DEFAULT_SETTINGS.autoCompound, ...(saved.autoCompound ?? {}) },
            scoreLimit:   { ...DEFAULT_SETTINGS.scoreLimit,   ...(saved.scoreLimit   ?? {}) },
            ranking:      { ...DEFAULT_SETTINGS.ranking,      ...(saved.ranking      ?? {}) },
            trailingStop: { ...DEFAULT_SETTINGS.trailingStop, ...(saved.trailingStop ?? {}) },
            cleanup:      { ...DEFAULT_SETTINGS.cleanup,      ...(saved.cleanup      ?? {}) },
            tvlProtection: {
                ...DEFAULT_SETTINGS.tvlProtection,
                ...(saved.tvlProtection ?? {}),
                level1: { ...DEFAULT_SETTINGS.tvlProtection.level1, ...(saved.tvlProtection?.level1 ?? {}) },
                level2: { ...DEFAULT_SETTINGS.tvlProtection.level2, ...(saved.tvlProtection?.level2 ?? {}) },
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
                level1: { ...DEFAULT_POOL_TYPE_SETTINGS.tvlProtection.level1, ...(saved.tvlProtection?.level1 ?? {}) },
                level2: { ...DEFAULT_POOL_TYPE_SETTINGS.tvlProtection.level2, ...(saved.tvlProtection?.level2 ?? {}) },
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
 *   - L1-Schwelle muss strikt größer als L2-Schwelle sein (Eskalation)
 *   - sind beide Stufen aktiv, muss withdrawPct1 + withdrawPct2 === 100 sein
 * tvlAtActivation wird ignoriert (nur der Bot schreibt diesen Wert).
 */
function validateTvlProtection(merged) {
    const { level1: l1, level2: l2 } = merged;
    const isStep10 = v => Number.isFinite(v) && v >= 0 && v <= 100 && v % 10 === 0;

    if (l1.enabled && !isStep10(l1.withdrawPct))
        throw new Error('TVL-Schutz Stufe 1: Prozentwert muss 0–100 in 10er-Schritten sein.');
    if (l2.enabled && !isStep10(l2.withdrawPct))
        throw new Error('TVL-Schutz Stufe 2: Prozentwert muss 0–100 in 10er-Schritten sein.');

    if (l1.enabled) {
        if (!(Number(l1.thresholdUsd) > 0))
            throw new Error('TVL-Schutz Stufe 1: TVL-Schwelle muss größer als 0 sein.');
    }
    if (l2.enabled) {
        if (!(Number(l2.thresholdUsd) > 0))
            throw new Error('TVL-Schutz Stufe 2: TVL-Schwelle muss größer als 0 sein.');
    }
    // Eskalation: L1 > L2 nur prüfbar wenn beide aktiv und beide gesetzt
    if (l1.enabled && l2.enabled && Number(l1.thresholdUsd) <= Number(l2.thresholdUsd))
        throw new Error('TVL-Schutz: Schwelle Stufe 1 muss größer als Stufe 2 sein (Eskalation).');

    // Summe-100-Regel nur wenn beide Stufen aktiv
    if (l1.enabled && l2.enabled && (Number(l1.withdrawPct) + Number(l2.withdrawPct)) !== 100)
        throw new Error('TVL-Schutz: Prozentwerte von Stufe 1 und Stufe 2 müssen zusammen 100 % ergeben.');
}

function saveSettings(db, botId, poolId, partial) {
    const current = loadSettings(db, botId, poolId);
    // Nur bekannte Sektionen übernehmen
    if (partial.autoCompound !== undefined) current.autoCompound = { ...current.autoCompound, ...partial.autoCompound };
    if (partial.scoreLimit   !== undefined) current.scoreLimit   = { ...current.scoreLimit,   ...partial.scoreLimit   };
    if (partial.ranking      !== undefined) current.ranking      = { ...current.ranking,      ...partial.ranking      };
    if (partial.trailingStop !== undefined) current.trailingStop = { ...current.trailingStop, ...partial.trailingStop };
    if (partial.cleanup      !== undefined) current.cleanup      = { ...current.cleanup,      ...partial.cleanup      };
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
            level2: cleanLevel(current.tvlProtection.level2, p.level2 ?? {}),
        };
        validateTvlProtection(merged);
        current.tvlProtection = merged;
    }

    db.prepare(`
        INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES (?, ?, ?)
        ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
    `).run(botId, poolId, JSON.stringify(current));

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
        const investScores   = loadInvestScores();
        const scoreState     = loadScoreState();
        const poolTvls       = loadPoolTvls();
        const activationTvls = loadActivationTvls();
        const recentScores   = loadRecentScores(pools.map(p => p.id), 5);
        const checkIntervalMs = parseInt(process.env.CHECK_INTERVAL_MS ?? '300000', 10);

        const result = pools.map(pool => {
            const settings = loadSettings(db, 'liquidity', pool.id);
            // Anzeige-Fallback: tvlAtActivation rückwirkend aus Position-Open rekonstruieren,
            // solange der Bot ihn noch nicht gesetzt hat (nicht in DB persistiert).
            if (settings.tvlProtection?.tvlAtActivation == null && activationTvls[pool.id] != null) {
                settings.tvlProtection.tvlAtActivation = activationTvls[pool.id];
            }

            // Score-Limit-Status: consecutiveBelow aus invest_score_history rekonstruieren.
            // Muss gegen exitScore (malus-frei) prüfen, nicht score (=value, mit Volumen-
            // Malus) — lib/score-limit.js triggert selbst ausschließlich auf exitValue,
            // der Malus darf laut Design nie in die Exit-Entscheidung einfließen (s.
            // score-architektur.md). Sonst zeigt die UI einen näher wirkenden Exit an,
            // als der Bot tatsächlich auslösen würde (Befund 2026-07-03, cbBTC/SOL).
            const history      = recentScores[pool.id] ?? [];
            const slMinScore   = Number.isFinite(Number(settings.scoreLimit?.minScore)) ? Number(settings.scoreLimit.minScore) : 30;
            let consecutiveBelow = 0;
            for (const h of history) {
                if (h.exitScore < slMinScore) consecutiveBelow++;
                else break;
            }
            const scoreLimitState = {
                consecutiveBelow,
                lastCheckedAt: history[0]?.recorded_at ?? null,
                checkIntervalMs,
            };

            return {
                id:                 pool.id,
                pair:               pool.pair,
                displayPair:        pool.displayPair ?? pool.pair,
                poolType:           pool.poolType ?? null,
                active:             pool.active,
                enabled:            pool.enabled !== false, // Benutzer-Freigabe (Default: freigegeben)
                btcPricePoolId:     pool.btcPricePoolId  ?? null,
                usdcIsTokenA:       pool.usdcIsTokenA    ?? false,
                volatilePair:       pool.volatilePair     ?? false,
                uiDepositDisabled:  pool.uiDepositDisabled ?? false,
                currentValue:       values[pool.id]       ?? null,
                investScore:        investScores[pool.id] ?? null,
                scoreSource:        scoreState.source,
                scoreStale:         scoreState.stale,
                currentTvl:         poolTvls[pool.id]     ?? null,
                // Vorbefüllungs-Defaults für den TVL-Schutz (aus pools.json)
                tvlWarnDefault:     pool.tvlWarnThreshold ?? null,
                tvlExitDefault:     pool.tvlExitThreshold ?? null,
                settings,
                trailingStopStatus: tsStatus[pool.id]    ?? null,
                scoreLimitState,
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
// Body: { trailingStop: { thresholdPct }, tvlProtection: { level1: { thresholdUsd }, level2: { thresholdUsd } }, enabled? }
// Schreibt die Werte SOFORT in die individuellen Settings ALLER Pools dieses Typs
// (echter Bulk-Write, kein Template/Override-Konzept — Bestätigung dazu liegt im UI).
// `withdrawPct` der TVL-Stufen wird nicht angefasst (nicht Teil dieser Tabelle); dadurch
// kann validateTvlProtection() für einzelne Pools fehlschlagen (z.B. wenn beide Stufen
// aktiv werden, deren bestehende withdrawPct-Werte sich aber nicht zu 100 summieren) —
// solche Pools landen in `failed` statt die ganze Aktion abzubrechen.
router.put('/liquidity/pool-types/:poolType', (req, res) => {
    const { poolType } = req.params;
    if (!POOL_TYPES.includes(poolType)) {
        return res.status(400).json({ error: `Unbekannter Pool-Typ: ${poolType}` });
    }

    const body = req.body;
    if (typeof body !== 'object' || Array.isArray(body) || body === null) {
        return res.status(400).json({ error: 'Body muss ein Objekt sein' });
    }

    const thresholdPctRaw = body.trailingStop?.thresholdPct;
    if (thresholdPctRaw !== undefined) {
        const v = Number(thresholdPctRaw);
        if (!Number.isFinite(v) || v < 1 || v > 90) {
            return res.status(400).json({ error: 'Trailing-Stop-Drawdown muss zwischen 1 und 90 % liegen.' });
        }
    }
    for (const level of ['level1', 'level2']) {
        const raw = body.tvlProtection?.[level]?.thresholdUsd;
        if (raw !== undefined && raw !== null && raw !== '') {
            const v = Number(raw);
            if (!Number.isFinite(v) || v <= 0) {
                return res.status(400).json({ error: `TVL-Schwelle (${level}) muss größer als 0 sein.` });
            }
        }
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
        return res.status(400).json({ error: '"enabled" muss ein boolean sein.' });
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
                    error: `Pool-Typ kann nicht deaktiviert werden – ${invested.length} Pool(s) mit offener Position: ${invested.map(p => p.id).join(', ')}. Erst auszahlen, dann deaktivieren.`,
                    poolIds: invested.map(p => p.id),
                });
            }
        }

        // ── Type-Default persistieren (nur Buchhaltung fürs UI) ──
        const db = openDb();
        const newTypeSettings = {
            trailingStop: {
                thresholdPct: thresholdPctRaw != null && thresholdPctRaw !== '' ? Number(thresholdPctRaw) : null,
            },
            tvlProtection: {
                level1: { thresholdUsd: Number(body.tvlProtection?.level1?.thresholdUsd) || null },
                level2: { thresholdUsd: Number(body.tvlProtection?.level2?.thresholdUsd) || null },
            },
            enabled: body.enabled ?? true,
        };
        db.prepare(`
            INSERT INTO pool_type_settings (bot_id, pool_type, settings) VALUES (?, ?, ?)
            ON CONFLICT(bot_id, pool_type) DO UPDATE SET settings = excluded.settings
        `).run('liquidity', poolType, JSON.stringify(newTypeSettings));

        // ── Bulk-Write Trailing-Stop/TVL in die individuellen Pool-Settings ──
        const updated = [];
        const failed  = [];
        for (const pool of pools) {
            try {
                const partial = {};
                if (thresholdPctRaw !== undefined) {
                    partial.trailingStop = { thresholdPct: Number(thresholdPctRaw) };
                }
                if (body.tvlProtection !== undefined) {
                    const l1Usd = Number(body.tvlProtection?.level1?.thresholdUsd) || null;
                    const l2Usd = Number(body.tvlProtection?.level2?.thresholdUsd) || null;
                    partial.tvlProtection = {
                        level1: { enabled: l1Usd != null && l1Usd > 0, thresholdUsd: l1Usd },
                        level2: { enabled: l2Usd != null && l2Usd > 0, thresholdUsd: l2Usd },
                    };
                }
                if (Object.keys(partial).length > 0) {
                    saveSettings(db, 'liquidity', pool.id, partial);
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
                        failed.push({ poolId: pool.id, reason: 'Pool hat eine offene Position – erst auszahlen, dann deaktivieren.' });
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
        if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });

        const db       = openDb();
        const settings = loadSettings(db, 'liquidity', pool.id);
        db.close();

        res.json({ id: pool.id, pair: pool.pair, active: pool.active, settings });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PUT /liquidity/:poolId ─────────────────────────────────────────────────────────
router.put('/liquidity/:poolId', (req, res) => {
    try {
        const pools = loadPools();
        const pool  = pools.find(p => p.id === req.params.poolId);
        if (!pool) return res.status(404).json({ error: 'Pool nicht gefunden' });

        const partial = req.body;
        if (typeof partial !== 'object' || Array.isArray(partial)) {
            return res.status(400).json({ error: 'Body muss ein Objekt sein' });
        }

        const db      = openDb();
        const updated = saveSettings(db, 'liquidity', pool.id, partial);
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
        if (!pool) return res.status(404).json({ error: 'Pool unbekannt' });

        const db      = openDb();
        const current = loadSettings(db, 'liquidity', pool.id);
        if (!current.trailingStop?.enabled) {
            db.close();
            return res.status(400).json({ error: 'Trailing Stop ist für diesen Pool nicht aktiv' });
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
