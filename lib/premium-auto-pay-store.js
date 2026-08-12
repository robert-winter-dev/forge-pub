/**
 * FORGE public Premium – Ein/Aus-Schalter für die automatische Stundenzahlung (FORK-ONLY)
 *
 * Eine einzige Wahrheit für zwei Konsumenten:
 *   - bots/settings/routes/premium.js (setzt ihn über die Verwalten-Seite)
 *   - core/premium/premium-pay.js (fragt ihn vor jeder ECHTEN Zahlung ab)
 *
 * Ursprünglich lag diese Logik direkt in premium.js — als premium-pay.js denselben
 * Zustand lesen musste, wäre eine zweite Kopie derselben Tabelle/Query entstanden,
 * die bei einer künftigen Schemaänderung stillschweigend hätte auseinanderlaufen
 * können. Ein Konsument, eine Datei.
 *
 * Bewusst GETRENNT vom Aktivierungs-Token (lib/premium-token-store.js): ein Kunde
 * kann aktiviert sein (Token vorhanden), die automatische Zahlung aber bewusst noch
 * nicht freigeben wollen. Kapital bewegt sich nie ohne diese ausdrückliche zweite
 * Zustimmung — dasselbe Prinzip wie „Übernehmen != Kapitalfreigabe" bei Pool-Offers.
 */

import Database from 'better-sqlite3';
import { PATHS } from '../config/paths.js';

function openDb(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS premium_settings (
            id      INTEGER PRIMARY KEY CHECK (id = 1),
            enabled INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO premium_settings (id, enabled) VALUES (1, 0);
    `);

    // outage_paused (2026-08-03): vom System GESONDERT von `enabled` gesetzter Pausier-
    // Zustand, wenn core/premium/blob-health-check.js länger als 2h keine neuen Daten
    // (und keinen frischen öffentlichen Heartbeat) mehr gesehen hat. Bewusst eine EIGENE
    // Spalte statt `enabled` selbst umzuschalten: `enabled` bleibt ausschließlich der
    // Nutzerwille (Verwalten-Seite). Würde ein Systemausfall stattdessen `enabled`
    // direkt auf 0 setzen, könnte ein automatisches Wieder-Einschalten bei Erholung
    // nicht mehr von einem bewussten Nutzer-Stopp während desselben Zeitraums
    // unterschieden werden. premium-pay.js prüft beide Spalten unabhängig voneinander.
    //
    // pay_failure_notified: Kante für die "Zahlung fehlgeschlagen"-Nachricht (zu wenig
    // USDC/SOL) – verhindert, dass ein anhaltendes Guthabenproblem stündlich dieselbe
    // Nachricht erneut ins Message Center schreibt. Wird bei jeder erfolgreichen Zahlung
    // zurückgesetzt, damit ein SPÄTERES erneutes Scheitern wieder meldet.
    const cols = db.prepare(`PRAGMA table_info(premium_settings)`).all().map(c => c.name);
    if (!cols.includes('outage_paused')) {
        db.exec(`ALTER TABLE premium_settings ADD COLUMN outage_paused INTEGER NOT NULL DEFAULT 0`);
    }
    if (!cols.includes('pay_failure_notified')) {
        db.exec(`ALTER TABLE premium_settings ADD COLUMN pay_failure_notified INTEGER NOT NULL DEFAULT 0`);
    }

    return db;
}

export function isAutoPayEnabled({ dbPath = PATHS.settingsDb } = {}) {
    const db = openDb(dbPath);
    try {
        return db.prepare(`SELECT enabled FROM premium_settings WHERE id = 1`).get()?.enabled === 1;
    } finally {
        db.close();
    }
}

export function setAutoPayEnabled(value, { dbPath = PATHS.settingsDb } = {}) {
    const db = openDb(dbPath);
    try {
        db.prepare(`UPDATE premium_settings SET enabled = ? WHERE id = 1`).run(value ? 1 : 0);
    } finally {
        db.close();
    }
}

export function isOutagePaused({ dbPath = PATHS.settingsDb } = {}) {
    const db = openDb(dbPath);
    try {
        return db.prepare(`SELECT outage_paused FROM premium_settings WHERE id = 1`).get()?.outage_paused === 1;
    } finally {
        db.close();
    }
}

export function setOutagePaused(value, { dbPath = PATHS.settingsDb } = {}) {
    const db = openDb(dbPath);
    try {
        db.prepare(`UPDATE premium_settings SET outage_paused = ? WHERE id = 1`).run(value ? 1 : 0);
    } finally {
        db.close();
    }
}

export function isPayFailureNotified({ dbPath = PATHS.settingsDb } = {}) {
    const db = openDb(dbPath);
    try {
        return db.prepare(`SELECT pay_failure_notified FROM premium_settings WHERE id = 1`).get()?.pay_failure_notified === 1;
    } finally {
        db.close();
    }
}

export function setPayFailureNotified(value, { dbPath = PATHS.settingsDb } = {}) {
    const db = openDb(dbPath);
    try {
        db.prepare(`UPDATE premium_settings SET pay_failure_notified = ? WHERE id = 1`).run(value ? 1 : 0);
    } finally {
        db.close();
    }
}

export async function selfTest() {
    const failures = [];
    const dbPath = `/tmp/premium-auto-pay-store-selftest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

    try {
        if (isAutoPayEnabled({ dbPath }) !== false) failures.push('frischer Store sollte disabled sein (Default 0)');

        setAutoPayEnabled(true, { dbPath });
        if (isAutoPayEnabled({ dbPath }) !== true) failures.push('enable() wurde nicht übernommen');

        setAutoPayEnabled(false, { dbPath });
        if (isAutoPayEnabled({ dbPath }) !== false) failures.push('disable() wurde nicht übernommen');

        if (isOutagePaused({ dbPath }) !== false) failures.push('frischer Store sollte outage_paused=false sein');
        setOutagePaused(true, { dbPath });
        if (isOutagePaused({ dbPath }) !== true) failures.push('setOutagePaused(true) wurde nicht übernommen');
        setOutagePaused(false, { dbPath });
        if (isOutagePaused({ dbPath }) !== false) failures.push('setOutagePaused(false) wurde nicht übernommen');

        if (isPayFailureNotified({ dbPath }) !== false) failures.push('frischer Store sollte pay_failure_notified=false sein');
        setPayFailureNotified(true, { dbPath });
        if (isPayFailureNotified({ dbPath }) !== true) failures.push('setPayFailureNotified(true) wurde nicht übernommen');
        setPayFailureNotified(false, { dbPath });
        if (isPayFailureNotified({ dbPath }) !== false) failures.push('setPayFailureNotified(false) wurde nicht übernommen');
    } catch (err) {
        failures.push(`Ausnahme: ${err.message}`);
    } finally {
        const fs = await import('fs');
        for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
    }

    return { ok: failures.length === 0, failures };
}
