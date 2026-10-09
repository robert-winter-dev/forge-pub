/**
 * FORGE Nexus – API-Auslastung je Rate-Limiter (CORE#001287)
 *
 * Zählt pro API und FORGE_TZ-Stunde:
 *   calls        – Aufrufe, die durch den Limiter gingen (`RateLimiter.wait()`)
 *   throttled    – davon Aufrufe mit Wartezeit > 0
 *   wait_ms_sum  – Summe der Wartezeiten
 *   wait_ms_max  – längste einzelne Wartezeit der Stunde
 *   upstream_429 – 429-Antworten des Upstreams (jeder Versuch, auch Retries)
 *
 * Gleiche Ablage wie rpc-stats.js (`rpc-stats.db`, Flush alle 10 Minuten, letzter Flush bei
 * SIGTERM/SIGINT), damit Skopos den bekannten Pfad nur um eine Tabelle erweitern muss.
 * Keine Zeit-Bereinigung (Begründung: Kopf von rpc-stats.js); die Größe überwacht
 * lib/db-growth.js über `config/db-retention.json`.
 *
 * Zählt nur, ändert nichts am Drossel-Verhalten und macht keine Upstream-Calls.
 * Test: node --test core/nexus/api-stats.test.js
 */

import Database from 'better-sqlite3';
import { FORGE_TZ } from '../config.js';
import { PATHS }    from '../../config/paths.js';

const DB_PATH        = PATHS.rpcStatsDb;
const FLUSH_INTERVAL = 10 * 60 * 1000;   // 10 Minuten

const _dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: FORGE_TZ });
const _hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: FORGE_TZ, hour12: false, hour: '2-digit' });

function _slot(now = new Date()) {
    return { date: _dateFmt.format(now), hour: Number(_hourFmt.format(now)) % 24 };
}

// Puffer: `api::date::hour` → Zähler
const buffer = new Map();

function _entry(api, now) {
    const { date, hour } = _slot(now);
    const key = `${api}::${date}::${hour}`;
    let e = buffer.get(key);
    if (!e) {
        e = { api, date, hour, calls: 0, throttled: 0, wait_ms_sum: 0, wait_ms_max: 0, upstream_429: 0 };
        buffer.set(key, e);
    }
    return e;
}

/** Ein Aufruf hat den Limiter passiert. `waitedMs` = Rückgabewert von `RateLimiter.wait()`. */
export function recordCall(api, waitedMs = 0, now = new Date()) {
    const e = _entry(api, now);
    e.calls++;
    if (waitedMs > 0) {
        e.throttled++;
        e.wait_ms_sum += waitedMs;
        if (waitedMs > e.wait_ms_max) e.wait_ms_max = waitedMs;
    }
}

/** Der Upstream hat mit 429 geantwortet. */
export function recordUpstream429(api, now = new Date()) {
    _entry(api, now).upstream_429++;
}

/** Nur für Tests. */
export function _bufferSnapshot() { return [...buffer.values()].map(e => ({ ...e })); }
export function _bufferClear()    { buffer.clear(); }

/**
 * Legt Tabelle und Index an und rüstet fehlende Spalten per ALTER TABLE nach
 * (CREATE TABLE IF NOT EXISTS erreicht bestehende Tabellen nicht, vgl. rpc-stats.js).
 */
export function ensureSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS api_stats (
            id         INTEGER PRIMARY KEY,
            api        TEXT    NOT NULL,
            date       TEXT    NOT NULL,
            hour       INTEGER NOT NULL,
            calls      INTEGER NOT NULL DEFAULT 0,
            flushed_at INTEGER NOT NULL
        );
    `);
    const cols = new Set(db.prepare(`PRAGMA table_info(api_stats)`).all().map(c => c.name));
    for (const col of ['throttled', 'wait_ms_sum', 'wait_ms_max', 'upstream_429']) {
        if (!cols.has(col)) db.exec(`ALTER TABLE api_stats ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
    }
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_api_stats_key ON api_stats(api, date, hour);
        CREATE INDEX IF NOT EXISTS idx_api_stats_date ON api_stats(date, hour);
    `);
}

/** Puffer in `db` schreiben (Upsert) und leeren. Wirft bei Fehler, der Puffer bleibt dann erhalten. */
export function flushTo(db, flushedAt = Date.now()) {
    if (buffer.size === 0) return 0;
    ensureSchema(db);
    const upsert = db.prepare(`
        INSERT INTO api_stats (api, date, hour, calls, throttled, wait_ms_sum, wait_ms_max, upstream_429, flushed_at)
        VALUES (@api, @date, @hour, @calls, @throttled, @wait_ms_sum, @wait_ms_max, @upstream_429, @flushedAt)
        ON CONFLICT(api, date, hour) DO UPDATE SET
            calls        = calls        + excluded.calls,
            throttled    = throttled    + excluded.throttled,
            wait_ms_sum  = wait_ms_sum  + excluded.wait_ms_sum,
            wait_ms_max  = MAX(wait_ms_max, excluded.wait_ms_max),
            upstream_429 = upstream_429 + excluded.upstream_429,
            flushed_at   = excluded.flushed_at
    `);
    const rows = [...buffer.values()];
    db.transaction(() => { for (const e of rows) upsert.run({ ...e, flushedAt }); })();
    buffer.clear();
    return rows.length;
}

function flush() {
    if (buffer.size === 0) return;
    let db;
    try {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        flushTo(db);
    } catch (err) {
        console.error(`[api-stats] Flush fehlgeschlagen: ${err.message}`);
    } finally {
        db?.close();
    }
}

setInterval(flush, FLUSH_INTERVAL).unref();
process.on('SIGTERM', flush);
process.on('SIGINT',  flush);
