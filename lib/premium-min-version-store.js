/**
 * FORGE.pub Premium – verifizierte Mindestversion ablegen/lesen (FORK-ONLY)
 *
 * Gegenstück zu lib/premium-min-version.js `verifyMinVersion()`: dort wird geprüft, hier
 * wird das Ergebnis persistiert. Exakt dasselbe Muster wie lib/premium-pricing-store.js.
 *
 * Quelle: die signierte Mindestversion kommt als Antwort auf die `premium-version-check`-
 * Meldung, die der Fork bei jedem premium-pay.js-Lauf an den Master schickt (core/premium/
 * server.js `handleVersionCheck` / Fork-seitiger Handler `handleVersionTooOld`).
 */

import Database from 'better-sqlite3';
import { PATHS } from '../config/paths.js';

function openDb(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS premium_min_version_current (
            id           INTEGER PRIMARY KEY CHECK (id = 1),
            version      INTEGER,
            params_json  TEXT,
            received_at  INTEGER
        );
        INSERT OR IGNORE INTO premium_min_version_current (id) VALUES (1);
    `);
    return db;
}

/** @returns {number|null} zuletzt AKZEPTIERTE Version, oder null wenn noch nie eine kam. */
export function getLastSeenMinVersion({ dbPath = PATHS.premiumDb } = {}) {
    const db = openDb(dbPath);
    try {
        return db.prepare(`SELECT version FROM premium_min_version_current WHERE id = 1`).get()?.version ?? null;
    } finally {
        db.close();
    }
}

/** Speichert bereits verifizierte Mindestversions-Parameter (verifyMinVersion().params). */
export function storeMinVersion(params, { dbPath = PATHS.premiumDb, now = Date.now() } = {}) {
    const db = openDb(dbPath);
    try {
        db.prepare(`
            UPDATE premium_min_version_current SET version = ?, params_json = ?, received_at = ? WHERE id = 1
        `).run(params.version, JSON.stringify(params), now);
    } finally {
        db.close();
    }
}

/** @returns {object|null} zuletzt gespeicherte, bereits verifizierte Mindestversions-Parameter. */
export function getCurrentMinVersion({ dbPath = PATHS.premiumDb } = {}) {
    const db = openDb(dbPath);
    try {
        const row = db.prepare(`SELECT params_json FROM premium_min_version_current WHERE id = 1`).get();
        return row?.params_json ? JSON.parse(row.params_json) : null;
    } finally {
        db.close();
    }
}

export async function selfTest() {
    const failures = [];
    const dbPath = `/tmp/premium-min-version-store-selftest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

    try {
        if (getLastSeenMinVersion({ dbPath }) !== null) failures.push('leerer Store sollte lastSeenVersion=null liefern');
        if (getCurrentMinVersion({ dbPath }) !== null) failures.push('leerer Store sollte getCurrentMinVersion=null liefern');

        const p1 = { version: 3, minRequiredVersion: '0.9.0' };
        storeMinVersion(p1, { dbPath });
        if (getLastSeenMinVersion({ dbPath }) !== 3) failures.push('Version nach erstem Store falsch');
        if (getCurrentMinVersion({ dbPath })?.minRequiredVersion !== '0.9.0') failures.push('Mindestversion nach erstem Store falsch');

        const p2 = { version: 4, minRequiredVersion: '1.0.0' };
        storeMinVersion(p2, { dbPath });
        if (getLastSeenMinVersion({ dbPath }) !== 4) failures.push('Version nach Update falsch');
        if (getCurrentMinVersion({ dbPath })?.minRequiredVersion !== '1.0.0') failures.push('Mindestversion nach Update falsch – altes Update blieb stehen');
    } catch (err) {
        failures.push(`Ausnahme: ${err.message}`);
    } finally {
        const fs = await import('fs');
        for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
    }

    return { ok: failures.length === 0, failures };
}
