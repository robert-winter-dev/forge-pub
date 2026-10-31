/**
 * Passwortschutz der Settings-Seite (Port 3200)
 *
 * Zweck: verhindert, dass jemand im LAN zufällig auf den Admin-Server stößt und
 * dort Konfiguration ändert — kein Schutz gegen einen gezielten Angreifer mit
 * Netzwerkzugriff (siehe Scope-Entscheidung 2026-08-26: nur Port 3200, LAN-only).
 *
 * Ablage: EIN Zeile in settings.db (site_auth, id=1). Existiert die Zeile nicht,
 * ist der Schutz deaktiviert — jede Anfrage läuft durch (siteAuthGate()).
 *
 * Session: signiertes, zustandsloses Cookie (HMAC-SHA256 mit einem Secret, das
 * zusammen mit dem Passwort in derselben Zeile liegt). Ein neues Passwort
 * rotiert das Secret automatisch mit und macht damit alle vorher ausgestellten
 * Cookies ungültig — Passwort ändern loggt also überall aus.
 *
 * Schlüssel-Trennung (CORE#001537): Das Secret in der DB ist NICHT der Signierschlüssel.
 * Der Schlüssel entsteht als HMAC(Schlüsseldatei, DB-Secret). Die Schlüsseldatei
 * (<PATHS.secrets>/site-auth.key) liegt außerhalb des Klartext-Backups der DB und
 * läuft über backup-secrets.sh verschlüsselt ins Offsite-Backup — wer nur ein
 * settings.db-Archiv hat, kann kein Cookie fälschen.
 *
 * Notausgang bei verlorenem Passwort: bin/reset-settings-password.js läuft
 * lokal per SSH (kein Web-API-Weg) und löscht die Zeile — ein Web-Endpunkt
 * dafür wäre gegen die eigene Anmeldesperre nicht erreichbar (Henne-Ei) und
 * bei Erreichbarkeit ein Fernzugriffs-Loch.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';
import { t } from '../../../lib/i18n.js';

export const COOKIE_NAME = 'forge_settings_auth';

const REMEMBER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage
const SESSION_MAX_AGE_MS  = 12 * 60 * 60 * 1000;       // 12h, auch ohne "angemeldet bleiben"

// Pfade, die auch OHNE gültige Session erreichbar sein müssen: die Login-Seite
// selbst, die beiden Endpunkte, mit denen sie sich anmeldet/den Zustand abfragt,
// und das Hammer-Logo, das sie einbindet (liegt unter /forge/, sonst müsste die
// gesamte Dashboard-Statik freigegeben werden statt nur dieser einen Datei).
const EXEMPT_PATHS = new Set([
    '/login.html',
    '/api/auth/login',
    '/api/auth/status',
    '/api/auth/logout',
    '/forge/img/forge-logo.png',
]);

export function ensureAuthSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS site_auth (
            id            INTEGER PRIMARY KEY CHECK (id = 1),
            password_hash TEXT    NOT NULL,
            salt          TEXT    NOT NULL,
            secret        TEXT    NOT NULL,
            updated_at    INTEGER NOT NULL
        )
    `);
    return db;
}

export function openAuthDb() {
    return ensureAuthSchema(new Database(PATHS.settingsDb));
}

// Schlüsseldatei: beim ersten Zugriff angelegt (0600), danach im Speicher gehalten.
// 'wx' statt exists+write: parallele erste Anfragen dürfen sich nicht überschreiben.
const KEY_FILE = path.join(PATHS.secrets, 'site-auth.key');
let fileKey = null;

function getFileKey() {
    if (fileKey) return fileKey;
    try {
        fileKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true, mode: 0o700 });
        try {
            fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
        } catch (werr) {
            if (werr.code !== 'EEXIST') throw werr;
        }
        fileKey = fs.readFileSync(KEY_FILE, 'utf8').trim();
    }
    return fileKey;
}

/** Signierschlüssel für Cookies aus dem DB-Secret der Zeile. */
function signingKey(rowSecret) {
    return crypto.createHmac('sha256', getFileKey()).update(rowSecret).digest();
}

function hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function getAuthRow(db) {
    return db.prepare('SELECT * FROM site_auth WHERE id = 1').get();
}

export function isEnabled(db) {
    return !!getAuthRow(db);
}

export function setPassword(db, password) {
    const salt          = crypto.randomBytes(16).toString('hex');
    const password_hash = hashPassword(password, salt);
    const secret         = crypto.randomBytes(32).toString('hex');
    db.prepare(`
        INSERT INTO site_auth (id, password_hash, salt, secret, updated_at)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            password_hash = excluded.password_hash,
            salt          = excluded.salt,
            secret        = excluded.secret,
            updated_at    = excluded.updated_at
    `).run(password_hash, salt, secret, Date.now());
}

export function removePassword(db) {
    db.prepare('DELETE FROM site_auth WHERE id = 1').run();
}

export function verifyPassword(db, password) {
    const row = getAuthRow(db);
    if (!row || typeof password !== 'string') return false;
    const candidate = Buffer.from(hashPassword(password, row.salt), 'hex');
    const stored     = Buffer.from(row.password_hash, 'hex');
    if (candidate.length !== stored.length) return false;
    return crypto.timingSafeEqual(candidate, stored);
}

// ── Session-Cookie (signiert, kein Server-Zustand außer dem Secret) ───────────

function sign(payload, secret) {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig  = crypto.createHmac('sha256', secret).update(data).digest('base64url');
    return `${data}.${sig}`;
}

function verify(token, secret) {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot === -1) return null;
    const data = token.slice(0, dot);
    const sig  = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
        const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
        if (!payload.exp || payload.exp < Date.now()) return null;
        return payload;
    } catch {
        return null;
    }
}

export function parseCookies(header) {
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    }
    return out;
}

/**
 * @param {boolean} remember true = Cookie übersteht Browser-Neustart (30 Tage),
 *                            false = reines Session-Cookie, serverseitig trotzdem auf 12h gedeckelt.
 */
export function issueSessionCookie(res, secret, remember) {
    const maxAgeMs = remember ? REMEMBER_MAX_AGE_MS : SESSION_MAX_AGE_MS;
    const token = sign({ exp: Date.now() + maxAgeMs }, signingKey(secret));
    const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
    if (remember) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
    res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

export function verifySessionFromReq(db, req) {
    const row = getAuthRow(db);
    if (!row) return null;
    const cookies = parseCookies(req.headers.cookie);
    return verify(cookies[COOKIE_NAME], signingKey(row.secret));
}

/**
 * Express-Middleware – VOR allen anderen Mounts registrieren (server.js), damit
 * wirklich jede Anfrage auf Port 3200 durchläuft: statische Dateien, /forge/-
 * Dashboards und alle /api/-Routen.
 */
export function siteAuthGate(req, res, next) {
    if (EXEMPT_PATHS.has(req.path)) return next();

    const db = openAuthDb();
    let authenticated;
    try {
        authenticated = !isEnabled(db) || !!verifySessionFromReq(db, req);
    } finally {
        db.close();
    }
    if (authenticated) return next();

    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: t('api.auth.not_authenticated') });
    }
    res.redirect('/login.html');
}
