/**
 * FORGE Nexus – RPC Call Statistics
 *
 * Sammelt pro Methode und FORGE_TZ-Stunde:
 *   hits    – Antworten aus dem Cache (kein Helius-Credit)
 *   misses  – Upstream-Calls über /rpc (Credit verbraucht, cacheable)
 *   fresh   – Upstream-Calls über /rpc/fresh (Credit verbraucht, bewusst kein Cache)
 *   batches – Batch-Requests (kein einzelnes method-Label)
 *
 * Flusht alle 10 Minuten via Upsert in FORGE/data/rpc-stats.db.
 * Beim Prozess-Ende (SIGTERM/SIGINT) wird ein letzter Flush ausgeführt.
 *
 * Auswertung: node FORGE/bin/rpc-stats-report.js
 *
 * WICHTIG: date/hour werden in FORGE_TZ gespeichert. `rpc-stats-report.js`
 *          liest ebenfalls in FORGE_TZ — Konsistenz ist zwingend.
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath }  from 'url';
import { FORGE_TZ }       from '../config.js';
import { PATHS }          from '../../config/paths.js';

const DB_PATH          = PATHS.rpcStatsDb;
const FLUSH_INTERVAL   = 10 * 60 * 1000;   // 10 Minuten

// In-Memory-Buffer: `method::date::hour` → { method, date, hour, hits, misses, fresh, batches }
const buffer = new Map();

// Wiederverwendbare Formatter (Intl-Instanzen sind nicht gratis)
const _dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: FORGE_TZ });
const _hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: FORGE_TZ, hour12: false, hour: '2-digit' });

function _slot() {
    const d = new Date();
    const h = Number(_hourFmt.format(d)) % 24;  // '24' → '00' in manchen Locales
    return {
        date: _dateFmt.format(d),   // 'YYYY-MM-DD' in FORGE_TZ
        hour: h,                    // 0–23 in FORGE_TZ
    };
}

/**
 * Einen RPC-Call erfassen.
 *
 * @param {string} method   RPC-Methodenname, oder 'batch' bei Array-Body
 * @param {'hit'|'miss'|'fresh'|'batch'} outcome
 */
export function record(method, outcome) {
    const { date, hour } = _slot();
    const key = `${method}::${date}::${hour}`;
    if (!buffer.has(key)) {
        buffer.set(key, { method, date, hour, hits: 0, misses: 0, fresh: 0, batches: 0 });
    }
    const e = buffer.get(key);
    if      (outcome === 'hit')    e.hits++;
    else if (outcome === 'miss')   e.misses++;
    else if (outcome === 'fresh')  e.fresh++;
    else if (outcome === 'batch')  e.batches++;
}

// ── Flush ─────────────────────────────────────────────────────────────────────

function flush() {
    if (buffer.size === 0) return;

    let db;
    try {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.exec(`
            CREATE TABLE IF NOT EXISTS rpc_stats (
                id         INTEGER PRIMARY KEY,
                method     TEXT    NOT NULL,
                date       TEXT    NOT NULL,
                hour       INTEGER NOT NULL,
                hits       INTEGER NOT NULL DEFAULT 0,
                misses     INTEGER NOT NULL DEFAULT 0,
                fresh      INTEGER NOT NULL DEFAULT 0,
                batches    INTEGER NOT NULL DEFAULT 0,
                flushed_at INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_rpc_stats_key
                ON rpc_stats(method, date, hour);
            CREATE INDEX IF NOT EXISTS idx_rpc_stats_date
                ON rpc_stats(date, hour);
        `);

        const upsert = db.prepare(`
            INSERT INTO rpc_stats (method, date, hour, hits, misses, fresh, batches, flushed_at)
            VALUES (@method, @date, @hour, @hits, @misses, @fresh, @batches, @flushedAt)
            ON CONFLICT(method, date, hour) DO UPDATE SET
                hits       = hits    + excluded.hits,
                misses     = misses  + excluded.misses,
                fresh      = fresh   + excluded.fresh,
                batches    = batches + excluded.batches,
                flushed_at = excluded.flushed_at
        `);

        const flushedAt = Date.now();
        db.transaction(() => {
            for (const e of buffer.values()) {
                upsert.run({ ...e, flushedAt });
            }
        })();

        buffer.clear();

    } catch (err) {
        console.error(`[rpc-stats] Flush fehlgeschlagen: ${err.message}`);
    } finally {
        db?.close();
    }
}

setInterval(flush, FLUSH_INTERVAL).unref();
process.on('SIGTERM', flush);
process.on('SIGINT',  flush);
