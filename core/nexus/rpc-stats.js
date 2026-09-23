/**
 * FORGE Nexus – RPC Call Statistics
 *
 * Sammelt pro Methode, Verursacher und FORGE_TZ-Stunde:
 *   hits    – Antworten aus dem Cache (kein Helius-Credit)
 *   misses  – Upstream-Calls über /rpc (Credit verbraucht, cacheable)
 *   fresh   – Upstream-Calls über /rpc/fresh (Credit verbraucht, bewusst kein Cache)
 *   batches – Batch-Requests (kein einzelnes method-Label)
 *   quota_denied  – 429 mit „max usage" im Body: Helius-Kontingent aufgebraucht (CORE#000811)
 *   quota_suspect – 429 nach erschöpften Retries OHNE „max usage": Kontingent-Verdacht, falls
 *                   Helius den Wortlaut ändert (getrennt, damit beide Signale unterscheidbar bleiben)
 *
 * `caller` – Kennung des aufrufenden Prozesses aus dem Header `x-forge-caller`
 *            (CORE#000846, Ableitung in FORGE/lib/rpc-caller.js). 'unknown' für
 *            Aufrufer ohne Header und für alle Zeilen aus der Zeit davor.
 *
 * Flusht alle 10 Minuten via Upsert in FORGE/data/rpc-stats.db.
 * Beim Prozess-Ende (SIGTERM/SIGINT) wird ein letzter Flush ausgeführt.
 * Alte Zeilen werden NICHT gelöscht — Begründung am Konstantenblock unten.
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
import { sanitizeCaller, UNKNOWN_CALLER } from '../../lib/rpc-caller.js';

const DB_PATH          = PATHS.rpcStatsDb;
const FLUSH_INTERVAL   = 10 * 60 * 1000;   // 10 Minuten

/**
 * 🔒 KEIN automatisches Löschen alter Zeilen — bewusst, nach einem Vorfall.
 *
 * Beim Einbau der Verursacher-Dimension (CORE#000846) stand hier ein Prune auf 120 Tage.
 * Er hat am 21.09.2026 beim ersten Lauf 9.266 Zeilen vom 06.04. bis 23.05. entfernt,
 * also 694.072 erfasste Aufrufe. Wiederhergestellt aus einem Schnappschuss.
 *
 * Die Lehre ist nicht „Prune war zu scharf eingestellt", sondern: Diese Tabelle ist die
 * EINZIGE Quelle für den Helius-Verbrauch (Helius selbst liefert keinen Kontostand, siehe
 * CORE#000808). Eine lange Reihe ist bei jeder Kontingentfrage das Wertvollste, was da
 * ist — und sie kostet fast nichts: 4,8 MB für 168 Tage, also ~10 MB im Jahr.
 *
 * Begrenzt wird deshalb über die Größe, nicht über die Zeit: Eintrag `unbounded` mit
 * `maxMb` in `config/db-retention.json`, überwacht von lib/db-growth.js (CORE#000837).
 * Wer hier wieder einen Zeit-Prune einbaut, muss erst erklären, warum die Historie
 * weniger wert ist als die gesparten Megabyte.
 */

// In-Memory-Buffer: `method::date::hour::caller`
//   → { method, caller, date, hour, hits, misses, fresh, batches, quota_denied, quota_suspect }
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
 * @param {'hit'|'miss'|'fresh'|'batch'|'quota_denied'|'quota_suspect'} outcome
 * @param {string} [caller] Kennung des Aufrufers (Header `x-forge-caller`). Fehlt sie
 *                          oder ist sie unerlaubt geformt, wird 'unknown' gezählt — der
 *                          Call verschwindet nie, nur seine Zuordnung.
 */
export function record(method, outcome, caller = UNKNOWN_CALLER) {
    const { date, hour } = _slot();
    const who = sanitizeCaller(caller);
    const key = `${method}::${date}::${hour}::${who}`;
    if (!buffer.has(key)) {
        buffer.set(key, { method, caller: who, date, hour, hits: 0, misses: 0, fresh: 0, batches: 0, quota_denied: 0, quota_suspect: 0 });
    }
    const e = buffer.get(key);
    if      (outcome === 'hit')    e.hits++;
    else if (outcome === 'miss')   e.misses++;
    else if (outcome === 'fresh')  e.fresh++;
    else if (outcome === 'batch')  e.batches++;
    else if (outcome === 'quota_denied')  e.quota_denied++;
    else if (outcome === 'quota_suspect') e.quota_suspect++;
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
        `);

        // 🔒 Nachrüsten per ALTER TABLE: CREATE TABLE IF NOT EXISTS erreicht bestehende DBs nicht
        // (gleiche Falle wie ticket_key in CORE#000530, last_ticketed_at in CORE#000809).
        const cols = new Set(db.prepare(`PRAGMA table_info(rpc_stats)`).all().map(c => c.name));
        for (const col of ['quota_denied', 'quota_suspect']) {
            if (!cols.has(col)) db.exec(`ALTER TABLE rpc_stats ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
        }
        // CORE#000846: Verursacher-Dimension. Bestandszeilen tragen danach 'unknown' —
        // ihre Summen bleiben unverändert, sie sind nur nicht mehr zuordenbar.
        if (!cols.has('caller')) {
            db.exec(`ALTER TABLE rpc_stats ADD COLUMN caller TEXT NOT NULL DEFAULT '${UNKNOWN_CALLER}'`);
        }

        // 🔒 Der UNIQUE-Index MUSS die Verursacher-Spalte enthalten, sonst summiert der
        // Upsert unten verschiedene Verursacher in dieselbe Zeile und die Aufschlüsselung
        // wäre wertlos. `CREATE UNIQUE INDEX IF NOT EXISTS` prüft nur den NAMEN, nicht die
        // Spalten — ein bestehender Drei-Spalten-Index bliebe also unbemerkt liegen.
        // Deshalb die Definition lesen und bei Bedarf gezielt ersetzen.
        const idx = db.prepare(
            `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_rpc_stats_key'`
        ).get();
        if (idx && !/\bcaller\b/i.test(idx.sql ?? '')) {
            db.exec(`DROP INDEX idx_rpc_stats_key`);
        }
        db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_rpc_stats_key
                ON rpc_stats(method, date, hour, caller);
            CREATE INDEX IF NOT EXISTS idx_rpc_stats_date
                ON rpc_stats(date, hour);
        `);

        const upsert = db.prepare(`
            INSERT INTO rpc_stats (method, caller, date, hour, hits, misses, fresh, batches, quota_denied, quota_suspect, flushed_at)
            VALUES (@method, @caller, @date, @hour, @hits, @misses, @fresh, @batches, @quota_denied, @quota_suspect, @flushedAt)
            ON CONFLICT(method, date, hour, caller) DO UPDATE SET
                hits       = hits    + excluded.hits,
                misses     = misses  + excluded.misses,
                fresh      = fresh   + excluded.fresh,
                batches    = batches + excluded.batches,
                quota_denied  = quota_denied  + excluded.quota_denied,
                quota_suspect = quota_suspect + excluded.quota_suspect,
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
