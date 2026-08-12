/**
 * FORGE public Premium – Aktivierungs-Token `T`
 *
 * Baustein 2 der Premium-Anbindung (siehe datenaustausch.md
 * „PoC-Spezifikation" + payment.md „Identitäts-/Memo-Modell"). MASTER-ONLY: nur der Master
 * (IDENTITY_NAME === 'FORGE.Master' in server.js) vergibt Tokens, ein FORGE-public-Fork ist immer
 * nur Kunde. Kein closureExclude nötig — server.js importiert diese Datei bedingt (nur wenn
 * IS_MASTER_IDENTITY), ein Fork ruft den Zweig nie auf, daher unkritisch, falls die Datei
 * trotzdem im Fork-Umfang landet (rein passiver Code ohne Master-Geheimnisse).
 *
 * Zweck: `T` ist eine vom Kunden-Nostr-Pubkey entkoppelte, bedeutungslose Referenz fürs
 * Zahlungs-Memo (siehe [[payment]]) — die Zuordnung `T → Kunden-Pubkey` existiert nur hier,
 * in `premium.db`. Ein Kunde kann jederzeit per erneuter "premium-activate"-DM einen neuen
 * Token anfordern; der alte wird dabei ungültig (`revoked_at` gesetzt, nicht gelöscht —
 * Audit-Spur bleibt erhalten).
 */

import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { PATHS } from '../../config/paths.js';

const TOKEN_BYTES = 16; // 128 Bit Entropie, wie in [[payment]] gefordert (≥128 Bit)

function openDb(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS premium_activation_tokens (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            token            TEXT    NOT NULL UNIQUE,
            customer_pubkey  TEXT    NOT NULL,
            created_at       INTEGER NOT NULL,
            revoked_at       INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_pat_pubkey ON premium_activation_tokens(customer_pubkey);
        -- Höchstens ein aktiver (nicht widerrufener) Token pro Kunde gleichzeitig.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pat_active_pubkey
            ON premium_activation_tokens(customer_pubkey) WHERE revoked_at IS NULL;
    `);
    return db;
}

/**
 * Vergibt einen neuen Aktivierungs-Token für einen Kunden-Pubkey. Ein evtl. vorhandener
 * aktiver Token desselben Kunden wird dabei widerrufen (nicht gelöscht) — pro Kunde ist
 * immer nur ein Token gültig, wie in [[payment]] „jederzeit neu anforderbar" festgelegt.
 *
 * @param {string} customerPubkeyHex - 64-stelliger hex-Pubkey des Kunden (Nostr-Identität).
 * @param {object} [opts]
 * @param {string} [opts.dbPath] - Default PATHS.premiumDb; überschreibbar für Tests.
 * @returns {string} der neue Token (32-stelliger Hex-String, 128 Bit).
 */
export function issueActivationToken(customerPubkeyHex, { dbPath = PATHS.premiumDb } = {}) {
    if (!/^[0-9a-f]{64}$/i.test(customerPubkeyHex)) {
        throw new Error('issueActivationToken: customerPubkeyHex muss ein 64-stelliger hex-Pubkey sein');
    }
    const db = openDb(dbPath);
    try {
        const token = randomBytes(TOKEN_BYTES).toString('hex');
        const now = Date.now();
        const txn = db.transaction(() => {
            db.prepare(`
                UPDATE premium_activation_tokens SET revoked_at = ?
                WHERE customer_pubkey = ? AND revoked_at IS NULL
            `).run(now, customerPubkeyHex);
            db.prepare(`
                INSERT INTO premium_activation_tokens (token, customer_pubkey, created_at)
                VALUES (?, ?, ?)
            `).run(token, customerPubkeyHex, now);
        });
        txn();
        return token;
    } finally {
        db.close();
    }
}

/**
 * Zeitpunkt der letzten Token-Ausstellung für einen Kunden-Pubkey — WIDERRUFENE Tokens
 * zählen mit (anders als lookupActivationToken/listActiveActivations), da es hier nur um
 * "wann zuletzt ausgestellt" geht, nicht um "was ist gerade gültig". Grundlage für das
 * Rate-Limit in handlePremiumCommand() (server.js): Fund 2026-08-08, eine wiederholte
 * premium-activate-DM (Backlog-Replay, aber auch ein hektisch klickender echter Client)
 * widerruft bei jeder Ausstellung sofort den vorherigen Token — ohne Bremse kann das laufende
 * Zahlungen ins Leere laufen lassen und erzeugt sinnlosen DB-/Relay-Traffic.
 *
 * @param {string} customerPubkeyHex
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 * @returns {number | null} `created_at` (ms) der letzten Ausstellung, oder null wenn noch nie.
 */
export function getLastIssuedAt(customerPubkeyHex, { dbPath = PATHS.premiumDb } = {}) {
    const db = openDb(dbPath);
    try {
        const row = db.prepare(`
            SELECT MAX(created_at) AS lastIssuedAt
            FROM premium_activation_tokens
            WHERE customer_pubkey = ?
        `).get(customerPubkeyHex);
        return row?.lastIssuedAt ?? null;
    } finally {
        db.close();
    }
}

/**
 * Schlägt einen Token nach — genutzt vom Zahlungs-Watcher (Memo = T), um den Kunden-Pubkey
 * zu finden, an den K_H per Gift-Wrap-DM geliefert werden muss.
 *
 * @param {string} token
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 * @returns {{ customerPubkeyHex: string, createdAt: number } | null} null bei unbekanntem
 *   oder widerrufenem Token.
 */
export function lookupActivationToken(token, { dbPath = PATHS.premiumDb } = {}) {
    const db = openDb(dbPath);
    try {
        const row = db.prepare(`
            SELECT customer_pubkey AS customerPubkeyHex, created_at AS createdAt
            FROM premium_activation_tokens
            WHERE token = ? AND revoked_at IS NULL
        `).get(token);
        return row ?? null;
    } finally {
        db.close();
    }
}

/**
 * Alle aktuell aktiven (nicht widerrufenen) Aktivierungen — genutzt für die
 * Test-Zustellung ohne Zahlungs-Watcher (core/premium/deliver-blob.js): jeder
 * aktivierte Kunde bekommt den Blob, unabhängig von einer Zahlung. Übergangszustand,
 * bis der echte Zahlungs-Watcher die Zustellung an eine bestätigte Zahlung bindet.
 *
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 * @returns {{ token: string, customerPubkeyHex: string, createdAt: number }[]}
 */
export function listActiveActivations({ dbPath = PATHS.premiumDb } = {}) {
    const db = openDb(dbPath);
    try {
        return db.prepare(`
            SELECT token, customer_pubkey AS customerPubkeyHex, created_at AS createdAt
            FROM premium_activation_tokens
            WHERE revoked_at IS NULL
        `).all();
    } finally {
        db.close();
    }
}

/**
 * Selbsttest gegen eine temporäre SQLite-Datei (nicht die echte premium.db): Issue+Lookup,
 * Reissue widerruft den alten Token, widerrufener Token liefert null, unbekannter Token
 * liefert null.
 */
export async function selfTest() {
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const fs = await import('fs');
    const dbPath = join(tmpdir(), `premium-activation-selftest-${randomBytes(4).toString('hex')}.db`);
    const failures = [];
    const pubkey = randomBytes(32).toString('hex');

    try {
        const t1 = issueActivationToken(pubkey, { dbPath });
        const lookup1 = lookupActivationToken(t1, { dbPath });
        if (!lookup1 || lookup1.customerPubkeyHex !== pubkey) {
            failures.push('Lookup nach Issue liefert nicht den erwarteten Kunden-Pubkey');
        }

        const t2 = issueActivationToken(pubkey, { dbPath });
        if (t2 === t1) failures.push('Reissue lieferte denselben Token wie vorher');

        const lookupOld = lookupActivationToken(t1, { dbPath });
        if (lookupOld !== null) failures.push('Alter Token ist nach Reissue noch aktiv (sollte widerrufen sein)');

        const lookupNew = lookupActivationToken(t2, { dbPath });
        if (!lookupNew || lookupNew.customerPubkeyHex !== pubkey) {
            failures.push('Neuer Token nach Reissue nicht auffindbar');
        }

        const unknown = lookupActivationToken(randomBytes(16).toString('hex'), { dbPath });
        if (unknown !== null) failures.push('Unbekannter Token liefert nicht null');

        const lastIssued = getLastIssuedAt(pubkey, { dbPath });
        if (lastIssued == null) failures.push('getLastIssuedAt liefert null nach zwei Ausstellungen');
        const neverPubkey = randomBytes(32).toString('hex');
        if (getLastIssuedAt(neverPubkey, { dbPath }) !== null) {
            failures.push('getLastIssuedAt liefert nicht null für einen Pubkey ohne jede Ausstellung');
        }

        const active = listActiveActivations({ dbPath });
        if (active.length !== 1 || active[0].customerPubkeyHex !== pubkey) {
            failures.push(`listActiveActivations() erwartete genau 1 aktive Aktivierung, bekam ${JSON.stringify(active)}`);
        }
    } finally {
        fs.rmSync(dbPath, { force: true });
    }

    return { ok: failures.length === 0, failures };
}
