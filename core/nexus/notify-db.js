/**
 * FORGE Nexus – Notifications-Datenbank
 *
 * Verwaltet die zentrale SQLite-DB für alle Bot-Notifications.
 * DB-Pfad: FORGE/data/nexus.db
 */

import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';
import { PATHS }           from '../../config/paths.js';

const require   = createRequire(import.meta.url);
const Database  = require('better-sqlite3');
const __dirname = dirname(fileURLToPath(import.meta.url));

const DB_PATH = PATHS.nexusDb;

let _db = null;

export function getDb() {
    if (_db) return _db;

    _db = new Database(DB_PATH);
    _db.exec(`
        CREATE TABLE IF NOT EXISTS notifications (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp     INTEGER NOT NULL,
            bot_id        TEXT    NOT NULL,
            level         TEXT    NOT NULL,
            category      TEXT    NOT NULL,
            message       TEXT    NOT NULL,
            context       TEXT,
            sent_telegram INTEGER NOT NULL DEFAULT 0,
            repeat_count  INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_bot_id   ON notifications(bot_id);
        CREATE INDEX IF NOT EXISTS idx_notifications_level    ON notifications(level);
        CREATE INDEX IF NOT EXISTS idx_notifications_timestamp ON notifications(timestamp);
    `);

    // display_name (2026-07-30): Der Absender wird im Message Center als eigene
    // Zeile angezeigt ("Liquidity Bot", nicht "liquidity"). Die Bots schicken den
    // Anzeigenamen schon lange mit (`displayName` im /notify-Body, bisher nur für
    // die Telegram-Kopfzeile genutzt) — ab jetzt wird er auch gespeichert.
    // Wichtig für Absender wie `wallet-monitor`, die MEHRERE Bots überwachen: die
    // botId sagt dort nichts über den betroffenen Bot aus, displayName schon.
    // Alt-Zeilen bleiben NULL, die Anzeige fällt dort über die Bot-Registry zurück
    // (siehe bots/settings/routes/messages.js).
    const cols = _db.prepare('PRAGMA table_info(notifications)').all().map(c => c.name);
    if (!cols.includes('display_name')) {
        _db.exec('ALTER TABLE notifications ADD COLUMN display_name TEXT');
    }

    // read (2026-08-03): Server-seitiger Gelesen-Status statt localStorage-ID-Set
    // im Frontend (forge_msgCenterReadSystemIds) – das lief pro Browser auseinander,
    // ein am PC gelesenes Message Center blieb auf dem Laptop bei "99+". Alt-Zeilen
    // gelten bewusst als ungelesen (0), damit beim Rollout keine echten neuen
    // Meldungen verschluckt werden.
    if (!cols.includes('read')) {
        _db.exec('ALTER TABLE notifications ADD COLUMN read INTEGER NOT NULL DEFAULT 0');
    }

    // msg_key / msg_params (2026-08-11, Mehrsprachigkeit Schritt 5): die Bots
    // schicken seither Schlüssel + Daten statt fertigem Text (
    // Core/forge-pub/i18n.md, E4). Der gerenderte Text bleibt zusätzlich in
    // `message` stehen — das ist der Fallback für Altbestand und für einen später
    // verschwundenen Key. ZUSÄTZLICHE Spalten statt Ersatz: keine Migration,
    // keine unlesbaren Alt-Meldungen.
    if (!cols.includes('msg_key')) {
        _db.exec('ALTER TABLE notifications ADD COLUMN msg_key TEXT');
    }
    if (!cols.includes('msg_params')) {
        _db.exec('ALTER TABLE notifications ADD COLUMN msg_params TEXT');
    }

    // settings (2026-08-03): generische Key/Value-Ablage, erster Nutzer sind die
    // Benachrichtigungs-Toggles (System/Support/Premium) aus dem Message Center.
    // Gleicher Grund wie bei read oben: lag vorher in localStorage
    // (forge_notifyEnabled_*) und lief deshalb pro Gerät auseinander – z.B. auf
    // einem Gerät "Premium" abgeschaltet, auf dem anderen an, obwohl es dieselbe
    // FORGE-Installation ist.
    _db.exec(`
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);

    return _db;
}

/**
 * Speichert eine Notification in der DB.
 *
 * @param {string}  botId
 * @param {string}  level         – 'info' | 'warn' | 'error'
 * @param {string}  category      – z.B. 'balance_discrepancy', 'system', 'trade'
 * @param {string}  message
 * @param {object|null} context   – optionale Forensik-Daten (wird als JSON gespeichert)
 * @param {boolean} sentTelegram  – wurde die Meldung zu Telegram gesendet?
 * @param {string|null} displayName – Anzeigename des BETROFFENEN Bots ("Liquidity Bot").
 *                                    Nicht zwingend der Absender: `wallet-monitor`
 *                                    meldet für mehrere Bots.
 * @param {{msgKey?: string|null, params?: object|null}} [i18n]
 *        Schlüssel + Daten der Meldung (Mehrsprachigkeit Schritt 5). Fehlen sie,
 *        bleibt es beim gespeicherten Text — Absender ohne i18n-Unterstützung
 *        (z.B. Skripte) funktionieren unverändert weiter.
 * @param {number} [timestamp=Date.now()] – nur für Backfill/Migration von Alt-
 *        Ereignissen mit bekanntem, vergangenem Zeitpunkt (z.B. bin/health-share-
 *        migrate-reports.js). Normale Aufrufer lassen das weg.
 * @returns {number} Inserted ID
 */
// Message-Center-UI zeigt max. 10 Seiten à 10 Zeilen (= 100, Vorgabe vom 2026-08-08)
// an (siehe messages.js GET /system) — hier hart begrenzt, damit die Tabelle nicht
// unbegrenzt wächst und die UI-Grenze auch tatsächlich zutrifft, statt nur eine
// Auslese-Obergrenze zu sein.
const MAX_NOTIFICATIONS = 100;

export function insertNotification(botId, level, category, message, context, sentTelegram, displayName = null, i18n = null, timestamp = Date.now()) {
    const db   = getDb();
    const stmt = db.prepare(`
        INSERT INTO notifications (timestamp, bot_id, level, category, message, context, sent_telegram, display_name, msg_key, msg_params)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
        timestamp,
        botId,
        level,
        category,
        message,
        context != null ? JSON.stringify(context) : null,
        sentTelegram ? 1 : 0,
        displayName ?? null,
        i18n?.msgKey ?? null,
        i18n?.params != null ? JSON.stringify(i18n.params) : null,
    );

    db.prepare(`
        DELETE FROM notifications
        WHERE id NOT IN (SELECT id FROM notifications ORDER BY id DESC LIMIT ?)
    `).run(MAX_NOTIFICATIONS);

    return result.lastInsertRowid;
}

/**
 * Aktualisiert repeat_count einer bestehenden Notification (Dedup-Zähler).
 *
 * @param {number} id           – Row-ID der ursprünglichen Notification
 * @param {number} repeatCount  – neue Anzahl unterdrückter Duplikate
 */
export function updateRepeatCount(id, repeatCount) {
    if (id == null) return;
    const db = getDb();
    db.prepare('UPDATE notifications SET repeat_count = ? WHERE id = ?').run(repeatCount, id);
}

/**
 * Markiert einzelne Notifications (per ID-Liste) als gelesen.
 * @param {number[]} ids
 */
export function markNotificationsRead(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE notifications SET read = 1 WHERE id IN (${placeholders})`).run(...ids);
}

/**
 * Löscht einzelne Notifications (per ID-Liste) endgültig.
 *
 * Gegenstück zu markNotificationsRead(): das Message Center (forge-settings) darf
 * nicht selbst auf nexus.db schreiben, ruft dafür POST /notifications/delete auf.
 * Die Zeilen sind danach unwiederbringlich weg — anders als bei den Nostr-Kanälen
 * gibt es hier keine Relay-Kopie, aus der sie zurückkommen könnten (und damit auch
 * keine Tombstone-Tabelle wie nostr_deleted_events im Premium-Dienst).
 *
 * @param {number[]} ids
 * @returns {number} Anzahl tatsächlich gelöschter Zeilen
 */
export function deleteNotifications(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    const db = getDb();
    const placeholders = ids.map(() => '?').join(',');
    return db.prepare(`DELETE FROM notifications WHERE id IN (${placeholders})`).run(...ids).changes;
}

// 'bots' kam am 18.08.2026 mit der eigenen Rubrik für Bot-Meldungen dazu.
const NOTIFY_TYPES = ['system', 'bots', 'support', 'premium'];

/**
 * Liest die Benachrichtigungs-Toggles (System/Bots/Support/Premium). Default AN
 * (kein gespeicherter Wert = true), wie zuvor bei den localStorage-Keys.
 * @returns {{system: boolean, bots: boolean, support: boolean, premium: boolean}}
 */
export function getNotifySettings() {
    const db = getDb();
    const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'notify_%'").all();
    const stored = Object.fromEntries(rows.map(r => [r.key.slice('notify_'.length), r.value === '1']));
    return Object.fromEntries(NOTIFY_TYPES.map(t => [t, stored[t] ?? true]));
}

/** @param {string} type – 'system' | 'bots' | 'support' | 'premium' */
export function setNotifySetting(type, enabled) {
    if (!NOTIFY_TYPES.includes(type)) return;
    const db = getDb();
    db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(`notify_${type}`, enabled ? '1' : '0');
}
