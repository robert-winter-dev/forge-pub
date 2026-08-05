/**
 * FORGE.pub Premium – eigenen Aktivierungs-Token wiederfinden (FORK-ONLY)
 *
 * Der Master vergibt den Token `T` per Nostr-DM (`{cmd:'premium-token', token}`,
 * siehe core/premium/server.js). Bisher wurde diese Nachricht nur im Message
 * Center angezeigt (humanizePremiumMessage) — es gab keine Stelle, die den Wert
 * für eine spätere PROGRAMMATISCHE Verwendung (Zahl-Skript, Verwalten-Seite)
 * herausgezogen hätte. Diese Datei schließt genau diese Lücke.
 *
 * Bewusst KEINE neue Tabelle/Speicherung: `nostr_support_messages` (category=
 * 'premium') enthält die Nachricht bereits vollständig und dauerhaft. Ein
 * zweiter Speicherort wäre eine zweite Quelle der Wahrheit, die auseinanderlaufen
 * kann (z.B. wenn der Kunde einen neuen Token anfordert — der Master widerruft
 * den alten serverseitig, aber ein lokal gecachter Wert wüsste davon nichts).
 * Stattdessen: immer die NEUESTE eingehende premium-token-Nachricht lesen.
 *
 * Läuft nur sinnvoll auf einem Fork (core/premium/server.js liest die eigene
 * DM-Historie) — auf dem Master gibt es keine eingehenden premium-token-DMs
 * (er verschickt sie nur), die Funktion liefert dort einfach null.
 */

import Database from 'better-sqlite3';
import { PATHS } from '../config/paths.js';

/**
 * @param {object} [opts]
 * @param {string} [opts.dbPath] - Default PATHS.premiumDb; überschreibbar für Tests.
 * @returns {{ token: string, receivedAt: number } | null}
 */
export function getMyActivationToken({ dbPath = PATHS.premiumDb } = {}) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const rows = db.prepare(`
            SELECT text, timestamp FROM nostr_support_messages
             WHERE direction = 'in' AND category = 'premium'
             ORDER BY timestamp DESC
        `).all();
        for (const row of rows) {
            let parsed;
            try {
                parsed = JSON.parse(row.text);
            } catch {
                continue;
            }
            if (parsed?.cmd === 'premium-token' && typeof parsed.token === 'string') {
                return { token: parsed.token, receivedAt: row.timestamp };
            }
        }
        return null;
    } finally {
        db.close();
    }
}

export async function selfTest() {
    const failures = [];
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const fs = await import('fs');
    const { randomBytes } = await import('crypto');

    const dbPath = join(tmpdir(), `premium-token-store-selftest-${randomBytes(4).toString('hex')}.db`);
    try {
        const db = new Database(dbPath);
        db.exec(`
            CREATE TABLE nostr_support_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                direction TEXT, timestamp INTEGER, text TEXT,
                peer_pubkey TEXT, read INTEGER DEFAULT 0, event_id TEXT, category TEXT
            )
        `);
        const ins = db.prepare(`INSERT INTO nostr_support_messages (direction, timestamp, text, category) VALUES (?, ?, ?, ?)`);

        // 1: keine Nachrichten -> null.
        if (getMyActivationToken({ dbPath }) !== null) failures.push('Fall 1: leere Historie sollte null liefern');

        // 2: Freitext-Support-Chat wird ignoriert (kein JSON, category=support).
        ins.run('in', 1000, 'Hallo, wie funktioniert Premium?', 'support');
        if (getMyActivationToken({ dbPath }) !== null) failures.push('Fall 2: Freitext-Chat wurde fälschlich als Token gelesen');

        // 3: ausgehende premium-token-Nachricht (Master->irgendwer) darf NICHT als
        // eigener Token gelesen werden — direction='out'.
        ins.run('out', 2000, JSON.stringify({ cmd: 'premium-token', token: 'ffffffffffffffffffffffffffffffff' }), 'premium');
        if (getMyActivationToken({ dbPath }) !== null) failures.push('Fall 3: ausgehende Nachricht wurde fälschlich als eigener Token gelesen');

        // 4: erste eingehende Aktivierung -> gefunden.
        ins.run('in', 3000, JSON.stringify({ cmd: 'premium-token', token: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }), 'premium');
        const r4 = getMyActivationToken({ dbPath });
        if (r4?.token !== 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') failures.push(`Fall 4: erwartete Token 'aaa…', bekam ${JSON.stringify(r4)}`);

        // 5: Reissue (neuerer Token) -> der NEUERE gewinnt, nicht chronologisch erster.
        ins.run('in', 4000, JSON.stringify({ cmd: 'premium-token', token: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), 'premium');
        const r5 = getMyActivationToken({ dbPath });
        if (r5?.token !== 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') failures.push(`Fall 5: Reissue – erwartete den neueren Token 'bbb…', bekam ${JSON.stringify(r5)}`);

        // 6: andere Premium-Kommandos (premium-blob) dazwischen stören die Suche nicht.
        ins.run('in', 5000, JSON.stringify({ cmd: 'premium-blob', url: 'https://x.invalid', key: 'ab', hourId: 1 }), 'premium');
        const r6 = getMyActivationToken({ dbPath });
        if (r6?.token !== 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb') failures.push('Fall 6: premium-blob-Nachricht störte die Token-Suche');

        db.close();
    } catch (err) {
        failures.push(`Ausnahme: ${err.message}`);
    } finally {
        fs.rmSync(dbPath, { force: true });
        for (const s of ['-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
    }

    return { ok: failures.length === 0, failures };
}
