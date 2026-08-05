/**
 * FORGE Nexus – Spam-Prevention: Deduplication + Rate-Limiting
 *
 * Deduplication:
 *   Gleiche botId + level + category innerhalb eines konfigurierbaren Fensters
 *   werden unterdrückt. Nach Ablauf des Fensters wird eine Summary-Meldung
 *   gesendet (nur wenn mind. 1 Duplikat unterdrückt wurde).
 *
 *   Scope: error (2 min), warn (5 min), info: kein Dedup
 *   Dedup-Key: botId + level + category (nicht Message-Hash – robuster, besser
 *   für Auswertung)
 *
 *   🔴 Das `level` MUSS Teil des Schlüssels sein (Fix 2026-08-04). Vorher lautete
 *   er nur botId+category, während die Fensterlänge bereits levelabhängig war —
 *   eine Kombination, die nur mit getrennten Fenstern je Level Sinn ergibt. Folge
 *   des alten Verhaltens: die ERSTE Meldung eines Paares öffnete das Fenster und
 *   verschluckte danach alle anderen Level derselben Kategorie. Praktisch hieß
 *   das, dass eine harmlose `warn` fünf Minuten lang jeden `error` desselben Bots
 *   in derselben Kategorie unterdrückte — die niedrigere Stufe brachte also die
 *   höhere zum Schweigen. Zusätzlich landete der repeat_count des unterdrückten
 *   Errors auf der DB-Zeile der Warnung. Real reproduziert am 2026-08-04 auf
 *   forge-pub1: der Alarm „Tarball-Hash-Mismatch" (error) wurde von der davor
 *   abgesetzten Warnung „Release mit Recovery-Key signiert" geschluckt.
 *
 * Rate-Limiting:
 *   info:  max 10/h pro Bot (Key: botId:level)
 *   warn:  max  5/h pro Bot (Key: botId:level)
 *   error: max  3/h pro botId:category — verhindert Spam bei dauerhaft wiederkehrenden
 *          Fehlern (z.B. balance_discrepancy alle 5 Min). Erste Occurrence kommt immer durch.
 *
 * Konfiguration (via .env):
 *   DEDUP_WINDOW_ERROR_MS     (default: 120000 = 2 min)
 *   DEDUP_WINDOW_WARN_MS      (default: 300000 = 5 min)
 *   RATE_LIMIT_INFO_PER_HOUR  (default: 10)
 *   RATE_LIMIT_WARN_PER_HOUR  (default: 5)
 *   RATE_LIMIT_ERROR_PER_HOUR (default: 3)
 */

const DEDUP_WINDOW_ERROR_MS   = parseInt(process.env.DEDUP_WINDOW_ERROR_MS     ?? '120000');
const DEDUP_WINDOW_WARN_MS    = parseInt(process.env.DEDUP_WINDOW_WARN_MS      ?? '300000');
const RATE_LIMIT_INFO_PER_H   = parseInt(process.env.RATE_LIMIT_INFO_PER_HOUR  ?? '10');
const RATE_LIMIT_WARN_PER_H   = parseInt(process.env.RATE_LIMIT_WARN_PER_HOUR  ?? '5');
const RATE_LIMIT_ERROR_PER_H  = parseInt(process.env.RATE_LIMIT_ERROR_PER_HOUR ?? '3');

// ─── Deduplication ────────────────────────────────────────────────────────────

/** Einziger Ort, an dem der Dedup-Schlüssel gebildet wird (checkDedup + setDedupRowId
 *  müssen zwingend denselben verwenden — sonst wird der rowId unter einem anderen
 *  Schlüssel abgelegt als er gelesen wird). */
function dedupKey(botId, level, category) {
    return `${botId}:${level}:${category}`;
}

/**
 * In-Memory-State pro Dedup-Key (botId:level:category):
 * { count, firstTs, lastTs, rowId, timer }
 *
 * rowId: DB-ID der ersten Notification in diesem Fenster (wird nachträglich gesetzt).
 * count: Anzahl unterdrückter Duplikate (erste Meldung zählt NICHT).
 */
const dedupWindows = new Map();

/**
 * Prüft ob eine eingehende Notification ein Duplikat ist.
 *
 * Gibt zurück:
 *   { isDuplicate: false, state: DedupState } – erste Occurrence, Fenster geöffnet
 *   { isDuplicate: true,  state: DedupState } – Duplikat im offenen Fenster
 *   null                                       – kein Dedup (level=info)
 *
 * @param {string}   botId
 * @param {string}   level
 * @param {string}   category
 * @param {Function} onWindowExpired  – (botId, level, category, state) → void
 *                                      Wird async aufgerufen wenn Fenster abläuft und count > 0
 */
export function checkDedup(botId, level, category, onWindowExpired) {
    if (level === 'info') return null;

    const key     = dedupKey(botId, level, category);
    const windowMs = level === 'error' ? DEDUP_WINDOW_ERROR_MS : DEDUP_WINDOW_WARN_MS;
    const now     = Date.now();
    const existing = dedupWindows.get(key);

    if (existing) {
        existing.count++;
        existing.lastTs = now;
        return { isDuplicate: true, state: existing };
    }

    // Erste Occurrence: Fenster öffnen
    const state = { count: 0, firstTs: now, lastTs: now, rowId: null };
    const timer = setTimeout(() => {
        const s = dedupWindows.get(key);
        if (s && s.count > 0) {
            onWindowExpired(botId, level, category, s);
        }
        dedupWindows.delete(key);
    }, windowMs);
    timer.unref(); // blockiert kein graceful shutdown

    state.timer = timer;
    dedupWindows.set(key, state);
    return { isDuplicate: false, state };
}

/**
 * Setzt die DB-Row-ID der ersten Notification im Dedup-Fenster.
 * Muss nach dem INSERT aufgerufen werden.
 */
export function setDedupRowId(botId, level, category, rowId) {
    const state = dedupWindows.get(dedupKey(botId, level, category));
    if (state) state.rowId = rowId;
}

// ─── Rate-Limiting ────────────────────────────────────────────────────────────

/**
 * In-Memory-Rate-Limit-Counter pro (botId, level):
 * { count, windowStart }
 */
const rateLimitCounters = new Map();

/**
 * Prüft ob eine Notification das Rate-Limit überschreitet.
 *
 * @param {string} botId
 * @param {string} level
 * @param {string} [category]  – Pflicht für level=error (Key: botId:error:category)
 * @returns {boolean} true = erlaubt, false = rate-limited
 */
export function checkRateLimit(botId, level, category) {
    let limitPerHour, key;

    if (level === 'error') {
        // Errors: Rate-Limit per botId:category — max 3/h, erste Occurrence kommt immer durch
        limitPerHour = RATE_LIMIT_ERROR_PER_H;
        key = `${botId}:error:${category ?? '_'}`;
    } else {
        limitPerHour = level === 'info' ? RATE_LIMIT_INFO_PER_H : RATE_LIMIT_WARN_PER_H;
        key = `${botId}:${level}`;
    }

    const now    = Date.now();
    const hourMs = 3_600_000;
    const state  = rateLimitCounters.get(key);

    if (!state || (now - state.windowStart) > hourMs) {
        rateLimitCounters.set(key, { count: 1, windowStart: now });
        return true;
    }

    if (state.count >= limitPerHour) {
        return false;
    }

    state.count++;
    return true;
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

/**
 * Formatiert einen Unix-Timestamp als HH:MM (lokale Zeit).
 */
export function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}
