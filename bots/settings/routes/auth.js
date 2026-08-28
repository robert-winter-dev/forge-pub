/**
 * /api/auth – Passwortschutz der Settings-Seite (Port 3200)
 *
 * GET  /status    → { enabled, authenticated } – auch ohne Session abrufbar
 * POST /login      → { password, remember } prüfen, Session-Cookie ausstellen
 * POST /logout      → Session-Cookie löschen (fetch aus settings.js)
 * GET  /logout       → dieselbe Wirkung als GET, für den <a href>-Logout-Link aus nav.js
 * POST /password       → Passwort setzen/ändern (currentPassword nur nötig, wenn schon aktiv)
 * DELETE /password       → Passwortschutz entfernen (nur erreichbar, während bereits angemeldet)
 *
 * siteAuthGate() in server.js lässt /status, /login, /logout ohne Session durch –
 * alles andere hier (POST/DELETE /password) ist dadurch implizit auf "bereits
 * angemeldet ODER Schutz noch nicht aktiv" beschränkt, ganz ohne eigene Prüfung.
 */

import { Router } from 'express';
import {
    openAuthDb, isEnabled, getAuthRow, verifyPassword, setPassword, removePassword,
    issueSessionCookie, clearSessionCookie, verifySessionFromReq,
} from '../lib/site-auth.js';
import { t } from '../../../lib/i18n.js';

const router = Router();

router.get('/status', (req, res) => {
    const db = openAuthDb();
    try {
        const enabled = isEnabled(db);
        res.json({ enabled, authenticated: enabled ? !!verifySessionFromReq(db, req) : true });
    } finally {
        db.close();
    }
});

router.post('/login', (req, res) => {
    const { password, remember } = req.body ?? {};
    const db = openAuthDb();
    try {
        if (!isEnabled(db)) return res.status(400).json({ error: t('api.auth.not_enabled') });
        if (!verifyPassword(db, password)) {
            return res.status(401).json({ error: t('api.auth.invalid_password') });
        }
        issueSessionCookie(res, getAuthRow(db).secret, !!remember);
        res.json({ ok: true });
    } finally {
        db.close();
    }
});

router.post('/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
});

router.get('/logout', (_req, res) => {
    clearSessionCookie(res);
    res.redirect('/login.html');
});

router.post('/password', (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
        return res.status(400).json({ error: t('api.auth.password_too_short') });
    }
    const db = openAuthDb();
    try {
        if (isEnabled(db) && !verifyPassword(db, currentPassword)) {
            return res.status(400).json({ error: t('api.auth.current_password_wrong') });
        }
        setPassword(db, newPassword);
        // Neues Secret invalidiert alle Cookies (auch das eigene, gerade genutzte) –
        // sofort ein frisches ausstellen, sonst sperrt sich der Admin selbst aus.
        issueSessionCookie(res, getAuthRow(db).secret, true);
        res.json({ ok: true });
    } finally {
        db.close();
    }
});

router.delete('/password', (_req, res) => {
    const db = openAuthDb();
    try {
        if (!isEnabled(db)) return res.status(400).json({ error: t('api.auth.not_enabled') });
        removePassword(db);
        clearSessionCookie(res);
        res.json({ ok: true });
    } finally {
        db.close();
    }
});

export default router;
