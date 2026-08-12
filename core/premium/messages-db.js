/**
 * FORGE public Premium – gemeinsame Nachrichten-DB
 *
 * Genutzt von core/premium/server.js (Nostr-DMs, category 'support'/'premium')
 * UND core/premium/premium-pay.js (lokale Ereignis-Einträge OHNE Nostr-Versand,
 * siehe recordPremiumMessage()). Eine ausgeführte Zahlung ist für den Nutzer
 * genauso relevant wie eine empfangene Premium-DM ("was ist rund um den
 * Premium-Service passiert") – landet deshalb im selben "Premium"-Tab des
 * Message Centers, auch wenn dafür nie etwas über Nostr verschickt wurde.
 */

import Database from 'better-sqlite3';
import { PATHS } from '../../config/paths.js';

const DB_PATH = PATHS.premiumDb;

export function openMessagesDb() {
    const db = new Database(DB_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS nostr_support_messages (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            direction    TEXT    NOT NULL,   -- 'in' | 'out'
            timestamp    INTEGER NOT NULL,
            text         TEXT    NOT NULL,
            peer_pubkey  TEXT,
            read         INTEGER NOT NULL DEFAULT 0,
            event_id     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_nostr_support_ts ON nostr_support_messages(timestamp);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_nostr_support_event_id ON nostr_support_messages(event_id)
            WHERE event_id IS NOT NULL;
    `);
    // Grab für gelöschte DMs (2026-07-30): "Anliegen löschen" löscht laut
    // Kommentar in server.js bewusst NUR lokal, nie auf den Relays selbst – die
    // behalten das Event. subscribeMany() (lib/nostr-client.js) liefert nach jedem
    // ECHTEN Reconnect (Backoff-Resubscribe inkl. since-Gap-Fill) UND nach jedem
    // Server-Neustart das Relay-Backlog erneut aus. Der bisherige Dedup (INSERT OR
    // IGNORE über UNIQUE event_id) schützt nur, solange die Zeile noch existiert –
    // nach einem DELETE greift er nicht mehr, die Nachricht kam Stunden später mit
    // dem nächsten Reconnect zurück. Diese Tabelle merkt sich gelöschte event_ids
    // dauerhaft, unabhängig davon, ob die zugehörige Nachrichtenzeile noch existiert.
    db.exec(`
        CREATE TABLE IF NOT EXISTS nostr_deleted_events (
            event_id   TEXT PRIMARY KEY,
            deleted_at INTEGER NOT NULL
        );
    `);
    // premium-blob-sealed-Zustellungen werden seit 2026-08-03 NICHT mehr als Nachricht
    // gespeichert (siehe server.js, Spam-Vermeidung) – der bisherige Dedup-Schutz gegen
    // Relay-Backlog-Replay (INSERT OR IGNORE + event_id auf nostr_support_messages) griff
    // dadurch nicht mehr. Vorfall 2026-08-03 (forge-pub1): ein Reconnect/Neustart lieferte
    // den kompletten Backlog erneut aus, JEDE davon spawnte einen neuen premium-fetch.js-
    // Kindprozess (handleBlobDelivery) OHNE Begrenzung → 310 gleichzeitige Prozesse → OOM-Kill
    // → Neustart → derselbe Backlog erneut → Crash-Loop. Diese eigene, schlanke Dedup-Tabelle
    // ersetzt den verlorenen Schutz, ohne wieder eine sichtbare Nachricht zu erzeugen.
    db.exec(`
        CREATE TABLE IF NOT EXISTS nostr_processed_blob_events (
            event_id      TEXT PRIMARY KEY,
            processed_at  INTEGER NOT NULL
        );
    `);
    // Gleiches Muster für premium-activate-Dedup (MASTER-ONLY) – siehe markActivationEventProcessed().
    db.exec(`
        CREATE TABLE IF NOT EXISTS nostr_processed_activation_events (
            event_id      TEXT PRIMARY KEY,
            processed_at  INTEGER NOT NULL
        );
    `);
    // category/thread_id sind bereits auf allen laufenden Instanzen migriert
    // (2026-07-28 bzw. 2026-07-30) – Spalten-Check bleibt trotzdem idempotent
    // stehen, für den Fall einer frischen Installation aus einem alten Backup.
    const cols = db.prepare(`PRAGMA table_info(nostr_support_messages)`).all().map(c => c.name);
    if (!cols.includes('category')) {
        db.exec(`ALTER TABLE nostr_support_messages ADD COLUMN category TEXT NOT NULL DEFAULT 'support'`);
    }
    if (!cols.includes('thread_id')) {
        db.exec(`ALTER TABLE nostr_support_messages ADD COLUMN thread_id TEXT`);
    }
    return db;
}

/**
 * Speichert eine lokale Premium-Meldung OHNE Nostr-Versand (z.B. eine
 * ausgeführte Zahlung, siehe premium-pay.js). direction='out' + read=1: es gibt
 * keine Gegenstelle, die das als "ungelesen" schicken könnte, und es soll den
 * Premium-Ungelesen-Zähler nicht erhöhen (der ist für eingehende DMs gedacht,
 * siehe unread-count-Query in server.js: direction='in' AND read=0).
 *
 * @param {string} text  Klartext (kein JSON-Kommando) – GET /premium zeigt ihn
 *                        dann unverändert an (classifyPremiumCommand() erkennt
 *                        kein bekanntes cmd-Feld und lässt ihn unangetastet).
 */
/**
 * Merkt event_ids dauerhaft als "vom Nutzer gelöscht" – vor jedem DELETE auf
 * nostr_support_messages aufzurufen (siehe DELETE /support/thread/:peer in
 * server.js), damit ein späterer Relay-Backlog-Replay dieselbe DM nicht erneut
 * einfügt. Nur event_ids ungleich null ergeben Sinn (lokale 'out'-Einträge ohne
 * Nostr-Bezug, z.B. recordPremiumMessage(), haben keine).
 */
export function markEventsDeleted(db, eventIds) {
    const ids = (eventIds ?? []).filter(id => id != null);
    if (!ids.length) return;
    const stmt = db.prepare(
        `INSERT OR IGNORE INTO nostr_deleted_events (event_id, deleted_at) VALUES (?, ?)`
    );
    const now = Date.now();
    const txn = db.transaction(rows => { for (const id of rows) stmt.run(id, now); });
    txn(ids);
}

/** true, wenn diese event_id bereits vom Nutzer gelöscht wurde (Backlog-Replay-Schutz). */
export function isEventDeleted(db, eventId) {
    if (eventId == null) return false;
    return !!db.prepare(`SELECT 1 FROM nostr_deleted_events WHERE event_id = ?`).get(eventId);
}

/**
 * Markiert eine premium-blob-sealed-event_id als bereits verarbeitet – true, wenn sie
 * VORHER noch nicht markiert war (also: jetzt tatsächlich verarbeiten). Atomar durch
 * INSERT OR IGNORE + changes-Check, kein separates SELECT nötig. `eventId == null`
 * (sollte bei echten Relay-Events nie vorkommen) lässt bewusst durch – sonst würde ein
 * fehlendes Feld JEDE Zustellung blockieren statt nur den Dedup zu überspringen.
 */
export function markBlobEventProcessed(db, eventId) {
    if (eventId == null) return true;
    const info = db.prepare(
        `INSERT OR IGNORE INTO nostr_processed_blob_events (event_id, processed_at) VALUES (?, ?)`
    ).run(eventId, Date.now());
    return info.changes === 1;
}

/**
 * Dasselbe Muster wie markBlobEventProcessed(), nur für premium-activate-DMs (MASTER-ONLY,
 * siehe handlePremiumCommand() in server.js). Fund 2026-08-08: der bisherige Dedup-Schutz
 * für Aktivierungs-Reissue lief ausschließlich über INSERT OR IGNORE + event_id auf
 * nostr_support_messages — nach Einführung des Rubriken-Cap-Prunings (pruneMessagesToLimit,
 * 100er-Limit) fiel die uralte premium-activate-Zeile irgendwann aus der Tabelle, ein
 * Relay-Backlog-Replay (Watchdog-Resubscribe, siehe lib/nostr-client.js) zählte danach als
 * "neu" und löste alle ~20 Min einen frischen Token aus (widerrief dabei den vorherigen).
 * Eigene, nie geprunte Tabelle entkoppelt den Protokoll-Dedup bewusst von der reinen
 * Anzeige-Aufbewahrung im Message Center.
 */
export function markActivationEventProcessed(db, eventId) {
    if (eventId == null) return true;
    const info = db.prepare(
        `INSERT OR IGNORE INTO nostr_processed_activation_events (event_id, processed_at) VALUES (?, ?)`
    ).run(eventId, Date.now());
    return info.changes === 1;
}

export function recordPremiumMessage(text) {
    const db = openMessagesDb();
    try {
        db.prepare(`
            INSERT INTO nostr_support_messages (direction, timestamp, text, category, read)
            VALUES ('out', ?, ?, 'premium', 1)
        `).run(Date.now(), text);
        pruneMessagesToLimit(db, 'premium');
    } finally {
        db.close();
    }
}

// Message-Center-UI zeigt max. 10 Seiten à 10 Zeilen (= 100, Vorgabe vom 2026-08-08)
// je Rubrik an – hier hart begrenzt, analog zu MAX_NOTIFICATIONS in
// core/nexus/notify-db.js für die System-Rubrik, damit die Tabelle nicht unbegrenzt
// wächst und die UI-Grenze auch tatsächlich zutrifft, statt nur eine Auslese-
// Obergrenze zu sein.
const MAX_MESSAGES_PER_CATEGORY = 100;

/**
 * Kürzt eine Kategorie ('support' | 'premium') nach jedem Insert auf die 100
 * neuesten Einträge – nach jedem Schreibzugriff auf nostr_support_messages
 * aufzurufen (siehe die Aufrufer in server.js/premium-pay.js).
 *
 * 'support' zählt pro THREAD (peer_pubkey + thread_id), nicht pro Einzelnachricht:
 * die Übersichtsliste zeigt eine Zeile pro Konversation (siehe GET /support/threads),
 * also müssen ganze Threads gemeinsam aus- oder eingehen – sonst blieben angebrochene,
 * unvollständige Verläufe übrig, deren älteste Nachrichten fehlen, neuere aber nicht.
 * 'premium' ist eine flache Nachrichtenliste ohne Thread-Konzept (siehe GET /premium),
 * dort zählt die Grenze pro Zeile.
 */
export function pruneMessagesToLimit(db, category) {
    if (category === 'support') {
        db.prepare(`
            DELETE FROM nostr_support_messages
            WHERE category = 'support'
              AND (peer_pubkey, COALESCE(thread_id, '')) NOT IN (
                  SELECT peer_pubkey, COALESCE(thread_id, '')
                  FROM nostr_support_messages
                  WHERE category = 'support'
                  GROUP BY peer_pubkey, COALESCE(thread_id, '')
                  ORDER BY MAX(timestamp) DESC
                  LIMIT ?
              )
        `).run(MAX_MESSAGES_PER_CATEGORY);
    } else {
        db.prepare(`
            DELETE FROM nostr_support_messages
            WHERE category = ?
              AND id NOT IN (
                  SELECT id FROM nostr_support_messages WHERE category = ? ORDER BY timestamp DESC LIMIT ?
              )
        `).run(category, category, MAX_MESSAGES_PER_CATEGORY);
    }
}
