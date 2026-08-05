/**
 * FORGE.pub Premium – verifizierte Preisliste ablegen/lesen (FORK-ONLY)
 *
 * Gegenstück zu lib/premium-pricing.js `verifyPricing()`: dort wird geprüft, hier
 * wird das Ergebnis persistiert. Getrennt, weil verifyPricing() bewusst rein bleibt
 * (kein DB-Zugriff, voll ohne Infrastruktur testbar) — diese Datei ist der einzige
 * Ort, der die geprüften Werte tatsächlich anfasst.
 *
 * Quelle: die signierte Preisliste kommt aktuell NUR als Anhang der
 * `premium-token`-Antwort (core/premium/server.js `handlePremiumCommand` /
 * Fork-seitiger Handler) — löst das Henne-Ei-Problem, dass der Fork Preis +
 * Empfangsadresse kennen muss, BEVOR er je bezahlt hat. Künftige Preisänderungen
 * sollen auf demselben Weg nachgereicht werden (an alle aktivierten, nicht nur
 * zahlende Kunden — siehe TODO in payment.md).
 *
 * `lastSeenVersion` wird IMMER mitgeführt, auch bei einer abgelehnten Lieferung
 * (falscher Absender, abgelaufen, …) NICHT verändert — der Downgrade-Schutz in
 * verifyPricing() braucht den zuletzt AKZEPTIERTEN Stand, nicht den zuletzt
 * gesehenen.
 */

import Database from 'better-sqlite3';
import { PATHS } from '../config/paths.js';

function openDb(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS premium_pricing_current (
            id           INTEGER PRIMARY KEY CHECK (id = 1),
            version      INTEGER,
            params_json  TEXT,
            received_at  INTEGER
        );
        INSERT OR IGNORE INTO premium_pricing_current (id) VALUES (1);
    `);
    return db;
}

/** @returns {number|null} zuletzt AKZEPTIERTE Version, oder null wenn noch nie eine kam. */
export function getLastSeenPricingVersion({ dbPath = PATHS.premiumDb } = {}) {
    const db = openDb(dbPath);
    try {
        return db.prepare(`SELECT version FROM premium_pricing_current WHERE id = 1`).get()?.version ?? null;
    } finally {
        db.close();
    }
}

/** Speichert bereits verifizierte Preisparameter (verifyPricing().params). */
export function storePricing(params, { dbPath = PATHS.premiumDb, now = Date.now() } = {}) {
    const db = openDb(dbPath);
    try {
        db.prepare(`
            UPDATE premium_pricing_current SET version = ?, params_json = ?, received_at = ? WHERE id = 1
        `).run(params.version, JSON.stringify(params), now);
    } finally {
        db.close();
    }
}

/** @returns {object|null} zuletzt gespeicherte, bereits verifizierte Preisparameter. */
export function getCurrentPricing({ dbPath = PATHS.premiumDb } = {}) {
    const db = openDb(dbPath);
    try {
        const row = db.prepare(`SELECT params_json FROM premium_pricing_current WHERE id = 1`).get();
        return row?.params_json ? JSON.parse(row.params_json) : null;
    } finally {
        db.close();
    }
}

export async function selfTest() {
    const failures = [];
    const dbPath = `/tmp/premium-pricing-store-selftest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

    try {
        if (getLastSeenPricingVersion({ dbPath }) !== null) failures.push('leerer Store sollte lastSeenVersion=null liefern');
        if (getCurrentPricing({ dbPath }) !== null) failures.push('leerer Store sollte getCurrentPricing=null liefern');

        const p1 = { version: 3, priceUsdcPerHour: 0.05, receivingWallet: 'Addr1' };
        storePricing(p1, { dbPath });
        if (getLastSeenPricingVersion({ dbPath }) !== 3) failures.push('Version nach erstem Store falsch');
        if (getCurrentPricing({ dbPath })?.priceUsdcPerHour !== 0.05) failures.push('Preis nach erstem Store falsch');

        const p2 = { version: 4, priceUsdcPerHour: 0.10, receivingWallet: 'Addr1' };
        storePricing(p2, { dbPath });
        if (getLastSeenPricingVersion({ dbPath }) !== 4) failures.push('Version nach Update falsch');
        if (getCurrentPricing({ dbPath })?.priceUsdcPerHour !== 0.10) failures.push('Preis nach Update falsch – altes Update blieb stehen');
    } catch (err) {
        failures.push(`Ausnahme: ${err.message}`);
    } finally {
        const fs = await import('fs');
        for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
    }

    return { ok: failures.length === 0, failures };
}
