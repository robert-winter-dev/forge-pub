/**
 * /api/addresses – Zentrales Adressbuch (bot-übergreifend)
 *
 * GET    /api/addresses        → alle Adressen
 * POST   /api/addresses        → Adresse hinzufügen  (Body: { name, address })
 * PUT    /api/addresses/:id    → Adresse/Name ändern (Body: { name?, address? })
 * DELETE /api/addresses/:id    → Adresse löschen
 *                                 → 409 wenn sie in irgendeinem Bot noch referenziert wird
 *
 * Speicherung in settings.db (Tabelle: shared_addresses).
 * Einmalige Migration: bestehende address_book-Einträge (bot_id='liquidity') werden übernommen.
 *
 * Usage-Check: durchsucht pool_settings (alle Bots) nach autoPayout.address,
 * und trailingStop.sendTo.
 */

import { Router }        from 'express';
import path              from 'path';
import { fileURLToPath } from 'url';
import Database          from 'better-sqlite3';
import { PATHS }         from '../../../config/paths.js';
import { t } from '../../../lib/i18n.js';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_DB = PATHS.settingsDb;

// ── DB öffnen + Schema sicherstellen ──────────────────────────────────────────
function openDb() {
    const db = new Database(SETTINGS_DB);

    db.exec(`
        CREATE TABLE IF NOT EXISTS shared_addresses (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL,
            address    TEXT    NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE TABLE IF NOT EXISTS pool_settings (
            bot_id   TEXT NOT NULL,
            pool_id  TEXT NOT NULL,
            settings TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (bot_id, pool_id)
        );
    `);

    // Einmalige Migration: address_book (liquidity) → shared_addresses
    const isEmpty = db.prepare('SELECT COUNT(*) AS n FROM shared_addresses').get().n === 0;
    if (isEmpty) {
        try {
            const old = db.prepare(
                `SELECT name, address, created_at FROM address_book WHERE bot_id = 'liquidity'`
            ).all();
            const ins = db.prepare(
                `INSERT INTO shared_addresses (name, address, created_at) VALUES (?, ?, ?)`
            );
            const migrate = db.transaction(() => { for (const r of old) ins.run(r.name, r.address, r.created_at); });
            migrate();
        } catch { /* address_book existiert noch nicht – kein Problem */ }
    }

    return db;
}

// ── Validierung ───────────────────────────────────────────────────────────────
function isValidSolanaAddress(addr) {
    return typeof addr === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
}

// ── Usage-Check: findet alle Pool-Einstellungen die diese Adresse referenzieren
function findUsages(db, address) {
    const usages = [];
    const rows   = db.prepare('SELECT bot_id, pool_id, settings FROM pool_settings').all();
    for (const row of rows) {
        try {
            const s     = JSON.parse(row.settings);
            const found = [];
            if (s.trailingStop?.sendTo  === address) found.push('Trailing Stop');
            if (found.length > 0) {
                usages.push({ botId: row.bot_id, poolId: row.pool_id, fields: found });
            }
        } catch { /* fehlerhafte JSON-Zeile ignorieren */ }
    }
    return usages;
}

// DB-Fehler (z.B. Berechtigungsproblem: settings.db root-owned statt forge-owned,
// siehe bin/install.sh) sollen als JSON-Fehler ankommen, nicht als Express'
// HTML-Standardfehlerseite – die bricht `res.json()` im Frontend mit
// "Unexpected token '<'" statt einer verständlichen Meldung.
function wrap(fn) {
    return (req, res) => {
        try {
            fn(req, res);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    };
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();

// GET /api/addresses
router.get('/', wrap((req, res) => {
    const db   = openDb();
    const rows = db.prepare(
        `SELECT id, name, address, created_at FROM shared_addresses ORDER BY name`
    ).all();
    db.close();
    res.json(rows);
}));

// POST /api/addresses
router.post('/', wrap((req, res) => {
    const { name, address } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: t('api.common.missing_field', { field: 'name' }) });
    }
    if (!address || typeof address !== 'string') {
        return res.status(400).json({ error: t('api.common.missing_field', { field: 'address' }) });
    }
    if (!isValidSolanaAddress(address.trim())) {
        return res.status(400).json({ error: t('api.common.invalid_address') });
    }

    const db     = openDb();
    const result = db.prepare(
        `INSERT INTO shared_addresses (name, address) VALUES (?, ?)`
    ).run(name.trim(), address.trim());
    db.close();

    res.json({ id: result.lastInsertRowid, name: name.trim(), address: address.trim() });
}));

// PUT /api/addresses/:id
router.put('/:id', wrap((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: t('api.common.invalid_id') });

    const { name, address } = req.body;
    const db  = openDb();
    const row = db.prepare(`SELECT id FROM shared_addresses WHERE id = ?`).get(id);
    if (!row) { db.close(); return res.status(404).json({ error: t('api.common.address_not_found') }); }

    if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim()) {
            db.close(); return res.status(400).json({ error: t('api.common.invalid_name') });
        }
        db.prepare(`UPDATE shared_addresses SET name = ? WHERE id = ?`).run(name.trim(), id);
    }
    if (address !== undefined) {
        if (!isValidSolanaAddress(address.trim())) {
            db.close(); return res.status(400).json({ error: t('api.common.invalid_address') });
        }
        db.prepare(`UPDATE shared_addresses SET address = ? WHERE id = ?`).run(address.trim(), id);
    }

    db.close();
    res.json({ ok: true });
}));

// DELETE /api/addresses/:id
router.delete('/:id', wrap((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: t('api.common.invalid_id') });

    const db  = openDb();
    const row = db.prepare(`SELECT id, name, address FROM shared_addresses WHERE id = ?`).get(id);
    if (!row) { db.close(); return res.status(404).json({ error: t('api.common.address_not_found') }); }

    // Schutz: Adresse darf nicht gelöscht werden, solange sie irgendwo verwendet wird
    const usages = findUsages(db, row.address);
    if (usages.length > 0) {
        db.close();
        return res.status(409).json({
            error:  t('api.addr.in_use'),
            usages, // [{ botId, poolId, fields: ['Auto Payout', ...] }]
        });
    }

    db.prepare(`DELETE FROM shared_addresses WHERE id = ?`).run(id);
    db.close();
    res.json({ ok: true });
}));

export default router;
