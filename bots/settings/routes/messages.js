/**
 * /api/messages – Message Center (Proof of Concept)
 *
 * Reiner Proxy auf den localhost-Dienst forge-premium (Port 3110), der seit
 * 2026-07-27 die Nostr-Identität + DM-Subscription hält (vorher hier in
 * server.js/messages.js). Grund für die Umkehr: die Auslieferung bezahlter
 * Premium-Keys darf nicht am Neustart der Admin-UI hängen, und eine
 * Nostr-Identität kann nur einem Prozess gehören.
 *
 * GET  /api/messages/support/unread-count → { unread: N }
 * GET  /api/messages/support/threads      → Inbox: eine Zeile pro Gegenstelle
 * GET  /api/messages/support/thread/:peer → Alle Nachrichten mit einer Gegenstelle
 * DELETE /api/messages/support/thread/:peer → Konversation lokal löschen
 * POST /api/messages/support/send   → Text-Nachricht per Nostr-DM versenden
 * GET  /api/messages/premium        → Flache Liste humanisierter Premium-Protokoll-
 *                                      Nachrichten (kein JSON-Rohtext im Frontend)
 * GET  /api/messages/premium/unread-count → { unread: N }
 * POST /api/messages/premium/:id/read     → einzelne Premium-Nachricht als gelesen markieren
 * GET  /api/messages/system         → System-Notifications aus nexus.db, paginiert
 *                                      (?page=&q=), bleibt hier, kein Nostr-Bezug.
 *                                      unreadCount + allIds sind unpaginiert (max. 300) –
 *                                      allIds nur noch für die "alle als gelesen"-Bulk-Aktion.
 * POST /api/messages/system/mark-read → { ids:[...] } als gelesen markieren, proxied an
 *                                        den Nexus (schreibt exklusiv auf nexus.db).
 * GET  /api/messages/notify-settings  → { system, support, premium } Benachrichtigungs-Toggles
 * POST /api/messages/notify-settings  → { type, enabled } einzelnes Toggle setzen (proxied an Nexus)
 * GET  /api/messages/identity       → npub/pubkey/Alias der eigenen Identität
 * GET  /api/messages/identity/qr    → QR-Code (SVG) der eigenen npub
 * POST /api/messages/identity/alias → Anzeigenamen ändern
 * POST /api/messages/identity/regenerate → 🔴 Account neu anlegen (Key + alle Nachrichten weg)
 * GET  /api/messages/contacts       → mitgeliefertes Adressbuch ("FORGE Master")
 * GET  /api/messages/support/stream → Server-Sent Events, gestreamt durchgereicht
 */

import { Router } from 'express';
import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';
import { listBots } from '../../../lib/bot-registry.js';

const PREMIUM_BASE = `http://127.0.0.1:${process.env.PREMIUM_PORT || '3110'}`;
const NEXUS_BASE   = `http://127.0.0.1:${process.env.NEXUS_PORT || '3100'}`;
const NEXUS_DB_PATH = PATHS.nexusDb;

// bot_id → Anzeigename, für Zeilen ohne gespeichertes display_name (alle Meldungen
// von vor dem 30.07.2026 sowie Absender, die den Namen nicht mitschicken).
// Quelle ist config/bots.json über die Registry — kein zweiter Namens-Katalog.
const BOT_DISPLAY_NAMES = Object.fromEntries(
    listBots().map(([id, cfg]) => [id, cfg.displayName]),
);

/**
 * Anzeigename des betroffenen Bots für die Kopfzeile im Message Center.
 * Reihenfolge: gespeichertes display_name → Registry-Name → "System".
 * Nie die rohe botId — "wallet-monitor" ist für einen Nicht-Techniker kein Absender.
 */
function resolveBotName(displayName, botId) {
    return displayName || BOT_DISPLAY_NAMES[botId] || 'System';
}

const router = Router();

/** Holt eine JSON-Antwort vom Premium-Dienst durch, reicht dessen Status/Fehler weiter. */
async function proxyJson(req, res, path, init = {}) {
    try {
        const upstream = await fetch(`${PREMIUM_BASE}${path}`, {
            headers: { 'Content-Type': 'application/json' },
            ...init,
        });
        const body = await upstream.text();
        res.status(upstream.status);
        res.set('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
        res.send(body);
    } catch (err) {
        res.status(503).json({ error: `Premium-Dienst nicht erreichbar: ${err.message}` });
    }
}

/** Wie proxyJson, aber gegen den Nexus (Notifications-Schreibzugriff, siehe notify-db.js). */
async function proxyNexusJson(req, res, path, init = {}) {
    try {
        const upstream = await fetch(`${NEXUS_BASE}${path}`, {
            headers: { 'Content-Type': 'application/json' },
            ...init,
        });
        const body = await upstream.text();
        res.status(upstream.status);
        res.set('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
        res.send(body);
    } catch (err) {
        res.status(503).json({ error: `Nexus nicht erreichbar: ${err.message}` });
    }
}

router.get('/identity', (req, res) => proxyJson(req, res, '/identity'));

router.get('/identity/qr', (req, res) => proxyJson(req, res, '/identity/qr'));

router.get('/contacts', (req, res) => proxyJson(req, res, '/contacts'));

router.post('/identity/alias', (req, res) =>
    proxyJson(req, res, '/identity/alias', { method: 'POST', body: JSON.stringify(req.body ?? {}) }));

// 🔴 Löscht Nostr-Key UND alle Nachrichten – die UI muss vorher explizit rückfragen,
// der Premium-Dienst verlangt zusätzlich confirm=true im Body.
router.post('/identity/regenerate', (req, res) =>
    proxyJson(req, res, '/identity/regenerate', { method: 'POST', body: JSON.stringify(req.body ?? {}) }));

router.get('/support/threads', (req, res) => proxyJson(req, res, '/support/threads'));

router.get('/support/unread-count', (req, res) => proxyJson(req, res, '/support/unread-count'));

router.get('/support/thread/:peer', (req, res) => {
    const qs = typeof req.query.threadId === 'string' ? `?threadId=${encodeURIComponent(req.query.threadId)}` : '';
    proxyJson(req, res, `/support/thread/${encodeURIComponent(req.params.peer)}${qs}`);
});

router.delete('/support/thread/:peer', (req, res) => {
    const qs = typeof req.query.threadId === 'string' ? `?threadId=${encodeURIComponent(req.query.threadId)}` : '';
    proxyJson(req, res, `/support/thread/${encodeURIComponent(req.params.peer)}${qs}`, { method: 'DELETE' });
});

router.post('/support/send', (req, res) =>
    proxyJson(req, res, '/support/send', { method: 'POST', body: JSON.stringify(req.body ?? {}) }));

router.get('/premium', (req, res) => proxyJson(req, res, '/premium'));

router.get('/premium/unread-count', (req, res) => proxyJson(req, res, '/premium/unread-count'));

router.post('/premium/:id/read', (req, res) =>
    proxyJson(req, res, `/premium/${encodeURIComponent(req.params.id)}/read`, { method: 'POST', body: '{}' }));

// SSE muss gestreamt werden (kein einmaliges Response-Body wie bei proxyJson) —
// Chunks vom Premium-Dienst direkt an den Browser weiterreichen, Verbindung offen halten.
router.get('/support/stream', async (req, res) => {
    let upstream;
    try {
        upstream = await fetch(`${PREMIUM_BASE}/support/stream`, {
            signal: AbortSignal.timeout ? undefined : undefined, // kein Timeout, Stream ist absichtlich langlebig
        });
    } catch (err) {
        return res.status(503).json({ error: `Premium-Dienst nicht erreichbar: ${err.message}` });
    }
    if (!upstream.ok || !upstream.body) {
        return res.status(502).json({ error: 'Premium-Dienst lieferte keinen Stream' });
    }

    res.set({
        'Content-Type':      'text/event-stream',
        'Cache-Control':     'no-cache, no-transform',
        Connection:          'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let closed = false;
    req.on('close', () => { closed = true; reader.cancel().catch(() => {}); });

    try {
        while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(decoder.decode(value, { stream: true }));
        }
    } catch {
        // Verbindung vom Client oder Upstream beendet – kein harter Fehler.
    } finally {
        if (!closed) res.end();
    }
});

// GET /system?page=<1-based>&q=<Volltextsuche, optional>
// perPage fest 15 (Message-Center-Redesign 2026-07-29): 20 Seiten × 15 = 300 Zeilen,
// exakt das Fenster, das notify-db.js per Pruning nach jedem Insert offen hält.
// q durchsucht message/category/bot_id/level (2026-07-30: Sender-Dropdown durch
// Live-Volltextsuche ersetzt, praktischer als eine feste Filterliste; level
// dazugenommen, damit sich z.B. "Warnung" im Modal-Titel-Badge auch anklicken/
// nachsuchen lässt – siehe LEVEL_LABEL in message.js).
// level='info' wird hier grundsätzlich ausgeblendet (2026-07-29): die
// zugrundeliegenden Ereignisse (Position/Deposit/Auszahlung/Fee-Claim) stehen
// bereits als Transaktion im Dashboard, wiederholen sich alle paar Minuten und
// hätten sonst auf Dauer zur Abschaltung des ganzen Kanals geführt – inkl. der
// Warn-Meldungen, auf die es eigentlich ankommt.
// APR-Alert (auch level='warn') ebenfalls dauerhaft ausgeblendet (2026-07-29):
// der Alert selbst ist inzwischen Opt-in statt Opt-out (siehe
// bin/bot.js), aber alte bereits gespeicherte Einträge bleiben in der DB.
// Bewusst per Filter statt DELETE auf notifications — die Nexus-DB gehört
// exklusiv dem Nexus-Prozess (siehe notify-db.js), kein Fremdprozess schreibt
// hinein.
router.get('/system', (req, res) => {
    // Reine Lese-Queries auf die Nexus-DB sind laut Konvention erlaubt (exklusiver
    // Schreibzugriff bleibt beim Nexus selbst, siehe notify-db.js). Kein Nostr-Bezug,
    // bleibt deshalb hier statt im Premium-Dienst.
    const PER_PAGE = 15;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const q    = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    let db;
    try {
        db = new Database(NEXUS_DB_PATH, { readonly: true, fileMustExist: true });

        // display_name kam erst am 30.07.2026 dazu (Migration läuft beim Nexus-Start,
        // siehe notify-db.js). Wird forge-settings vor forge-nexus neu gestartet, fehlt
        // die Spalte noch — ohne diese Prüfung würde die SELECT-Query werfen und der
        // catch-Zweig unten lieferte ein LEERES Message Center statt der Meldungen.
        const hasDisplayName = db.prepare('PRAGMA table_info(notifications)')
            .all().some(c => c.name === 'display_name');
        const nameCol = hasDisplayName ? 'display_name' : 'NULL';

        const baseFilter = "level != 'info' AND message NOT LIKE '%APR-Alert%'";
        // Suche schließt den Anzeigenamen mit ein: die UI zeigt "Liquidity Bot", ohne
        // display_name in der Suche wäre genau der sichtbare Text nicht auffindbar.
        const searchCols = ['message', 'category', 'bot_id', 'level', ...(hasDisplayName ? ['display_name'] : [])];
        const whereSql = q
            ? `WHERE ${baseFilter} AND (${searchCols.map(c => `${c} LIKE ?`).join(' OR ')})`
            : `WHERE ${baseFilter}`;
        const like     = `%${q}%`;
        const params   = q ? searchCols.map(() => like) : [];

        const totalCount = db.prepare(`SELECT COUNT(*) AS c FROM notifications ${whereSql}`).get(...params).c;
        const totalPages = Math.max(1, Math.ceil(totalCount / PER_PAGE));

        // read kam erst am 03.08.2026 dazu (Migration läuft beim Nexus-Start, siehe
        // notify-db.js) – gleiche Vorsichtsmaßnahme wie bei display_name oben.
        const hasRead = db.prepare('PRAGMA table_info(notifications)')
            .all().some(c => c.name === 'read');
        const readCol = hasRead ? 'read' : '0';

        const rows = db.prepare(`
            SELECT id, timestamp, bot_id AS botId, level, category, message, ${nameCol} AS displayName, ${readCol} AS read
            FROM notifications
            ${whereSql}
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `).all(...params, PER_PAGE, (page - 1) * PER_PAGE)
          .map(r => ({ ...r, read: !!r.read, botName: resolveBotName(r.displayName, r.botId) }));

        // Für "alle als gelesen"-Bulk-Aktion, auf die aktuelle Suche beschränkt.
        const allIds = db.prepare(`SELECT id FROM notifications ${whereSql}`).all(...params).map(r => r.id);
        // Für Brief-Icon-Badge + Menü-Zähler – server-seitig statt Client-Diff gegen
        // localStorage (siehe message-bell.js), damit der Stand über alle Geräte gleich ist.
        const unreadCount = hasRead
            ? db.prepare(`SELECT COUNT(*) AS c FROM notifications ${whereSql} AND read = 0`).get(...params).c
            : allIds.length;

        res.json({ notifications: rows, page, perPage: PER_PAGE, totalCount, totalPages, allIds, unreadCount });
    } catch {
        // nexus.db existiert noch nicht oder hat noch keine Notification erhalten.
        res.json({ notifications: [], page: 1, perPage: PER_PAGE, totalCount: 0, totalPages: 1, allIds: [], unreadCount: 0 });
    } finally {
        db?.close();
    }
});

// POST /system/mark-read { ids: number[] } – proxied an den Nexus, der exklusiv
// auf nexus.db schreibt (siehe notify-db.js/server.js).
router.post('/system/mark-read', async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length === 0) return res.json({ ok: true, count: 0 });
    proxyNexusJson(req, res, '/notifications/mark-read', { method: 'POST', body: JSON.stringify({ ids }) });
});

// GET  /notify-settings → { system, support, premium } – Benachrichtigungs-Toggles
// aus Einstellungen → Benachrichtigungen. Lagen bis 2026-08-03 in localStorage
// (forge_notifyEnabled_*) und liefen deshalb pro Gerät auseinander (z.B. Premium auf
// einem Rechner stummgeschaltet, auf einem anderen nicht, obwohl dieselbe FORGE-Instanz).
// POST /notify-settings { type, enabled } → einzelnes Toggle setzen.
router.get('/notify-settings', (req, res) => proxyNexusJson(req, res, '/notifications/settings'));

router.post('/notify-settings', (req, res) =>
    proxyNexusJson(req, res, '/notifications/settings', { method: 'POST', body: JSON.stringify(req.body ?? {}) }));

export default router;
