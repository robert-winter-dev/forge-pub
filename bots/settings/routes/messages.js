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
 *                                      (rein lesend, quittiert nichts – siehe .../read)
 * POST /api/messages/support/thread/:peer/read → Anliegen als gelesen markieren
 * DELETE /api/messages/support/thread/:peer → Konversation lokal löschen
 * POST /api/messages/support/send   → Text-Nachricht per Nostr-DM versenden
 * GET  /api/messages/premium        → Flache Liste humanisierter Premium-Protokoll-
 *                                      Nachrichten (kein JSON-Rohtext im Frontend)
 * GET  /api/messages/premium/unread-count → { unread: N }
 * POST /api/messages/premium/:id/read     → einzelne Premium-Nachricht als gelesen markieren
 * GET  /api/messages/system         → System-Notifications aus nexus.db, fensterweise
 *                                      (?limit=&offset=&q=), bleibt hier, kein Nostr-Bezug.
 *                                      unreadCount + allIds sind ungefenstert (max. 100) –
 *                                      allIds nur noch für die "alle als gelesen"-Bulk-Aktion.
 * POST /api/messages/system/mark-read → { ids:[...] } als gelesen markieren, proxied an
 *                                        den Nexus (schreibt exklusiv auf nexus.db).
 * DELETE /api/messages/system/:id   → einzelne System-Meldung löschen (ebenfalls über den Nexus)
 * DELETE /api/messages/premium/:id  → einzelne Premium-Nachricht löschen (lokale Kopie)
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
import { t } from '../../../lib/i18n.js';
import { notificationText } from '../../../lib/notify-render.js';
import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';

const PREMIUM_BASE = `http://127.0.0.1:${process.env.PREMIUM_PORT || '3110'}`;
const NEXUS_BASE   = `http://127.0.0.1:${process.env.NEXUS_PORT || '3100'}`;
const NEXUS_DB_PATH = PATHS.nexusDb;

/**
 * Anzeigename des betroffenen Bots für die Kopfzeile im Message Center.
 *
 * Bewusst NUR drei mögliche Werte, unabhängig vom frei gewählten display_name
 * jedes einzelnen Absenders (Betreiber-Vorgabe 2026-08-16): der Nutzer soll auf
 * den ersten Blick sehen, ob eine Meldung von einem der beiden Bots kommt oder
 * vom FORGE-Kern — nicht die uneinheitlichen Rohnamen der ~10 verschiedenen
 * Skripte, die an /notify senden (z.B. "Monitoring", "Auto-Update"). Das
 * gespeicherte display_name bleibt in der DB erhalten, wird hier nur ignoriert.
 */
function resolveBotName(displayName, botId) {
    if (botId === 'liquidity') return 'Liquidity Bot';
    if (botId === 'lending')   return 'Lending Bot';
    return 'FORGE';
}

// Pool-Name neben dem Bot-Namen in der Message-Center-Kopfzeile (Ticket 2026-08-08):
// die meisten notify.js-Aufrufer schreiben den Pool bereits strukturiert in den
// context-JSON-Blob (Key "pair", bei tierTransition zusätzlich "pool" — beide
// werden hier geprüft). Für ältere, bereits gespeicherte Nachrichten, die den
// Pool nur im Fließtext haben (context war zum Sendezeitpunkt leer), greift als
// Fallback eine Regex auf den Nachrichtentext — deckt das gängige "TOKEN/TOKEN"-
// Format ab, das jede Pool-Pair-Bezeichnung in FORGE hat.
const PAIR_TEXT_RE = /\b[A-Za-z0-9]{2,10}\/[A-Za-z0-9]{2,10}\b/;
function extractPool(context, message) {
    if (context) {
        try {
            const parsed = JSON.parse(context);
            const pool = parsed?.pair ?? parsed?.pool ?? null;
            if (pool) return pool;
        } catch { /* kein valides JSON – Fallback greift unten */ }
    }
    return message?.match(PAIR_TEXT_RE)?.[0] ?? null;
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
        res.status(503).json({ error: t('msg.support.premium_unreachable', { error: err.message }) });
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
        res.status(503).json({ error: t('msg.support.nexus_unreachable', { error: err.message }) });
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

// Markiert ein Anliegen als gelesen. Eigener Aufruf, weil der GET oben seit
// 2026-08-16 nichts mehr quittiert – nur eine Nutzeraktion darf das (Klick auf die
// Konversation oder auf den "alle als gelesen"-Haken, siehe message.js).
router.post('/support/thread/:peer/read', (req, res) => {
    const qs = typeof req.query.threadId === 'string' ? `?threadId=${encodeURIComponent(req.query.threadId)}` : '';
    proxyJson(req, res, `/support/thread/${encodeURIComponent(req.params.peer)}/read${qs}`, { method: 'POST', body: '{}' });
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

router.delete('/premium/:id', (req, res) =>
    proxyJson(req, res, `/premium/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' }));

// SSE muss gestreamt werden (kein einmaliges Response-Body wie bei proxyJson) —
// Chunks vom Premium-Dienst direkt an den Browser weiterreichen, Verbindung offen halten.
router.get('/support/stream', async (req, res) => {
    let upstream;
    try {
        upstream = await fetch(`${PREMIUM_BASE}/support/stream`, {
            signal: AbortSignal.timeout ? undefined : undefined, // kein Timeout, Stream ist absichtlich langlebig
        });
    } catch (err) {
        return res.status(503).json({ error: t('msg.support.premium_unreachable', { error: err.message }) });
    }
    if (!upstream.ok || !upstream.body) {
        return res.status(502).json({ error: t('msg.support.premium_no_stream') });
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

// GET /system?limit=<1..100>&offset=<0-based>&q=<Volltextsuche, optional>
// Seit 2026-08-16 ein reines Fenster (limit/offset) statt fester Seiten à 10 Zeilen:
// die Liste im Message Center lädt beim Herunterscrollen nach (Infinite Scroll,
// siehe loadMoreSystem() in message.js), es gibt keine Seitenzahlen mehr. Der
// Höchstwert 100 entspricht dem Fenster, das notify-db.js per Pruning nach jedem
// Insert offen hält (MAX_NOTIFICATIONS) – mehr Zeilen kann es gar nicht geben.
// page= wird weiterhin akzeptiert (1-basiert, mit perPage=limit), damit ältere
// geöffnete Tabs nach einem Deploy nicht ins Leere laufen.
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
//
// Ausnahme von der level='info'-Blende (2026-08-13): der stündliche
// Systemdaten-Report (category 'health-share-report', Absender "Monitoring
// Daten") ist bewusst 'info' – kein Alarm, aber trotzdem die eine Meldung, die
// diese Rubrik laut Freigabe-Tab ("Daten teilen") verspricht sichtbar zu machen.
// Ohne diese Ausnahme verschwand er lautlos hinter demselben Filter wie die
// Positions-/Deposit-Rauschmeldungen, die die Blende ursprünglich abstellen
// sollte (Fund 2026-08-13: Report kam korrekt in der DB an, war aber nie sichtbar).
router.get('/system', (req, res) => {
    // Reine Lese-Queries auf die Nexus-DB sind laut Konvention erlaubt (exklusiver
    // Schreibzugriff bleibt beim Nexus selbst, siehe notify-db.js). Kein Nostr-Bezug,
    // bleibt deshalb hier statt im Premium-Dienst.
    const MAX_LIMIT = 100;
    const limit  = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 10));
    // offset hat Vorrang; page nur als Rückfallebene für Alt-Clients (siehe Kommentar oben).
    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = Number.isInteger(parseInt(req.query.offset, 10))
        ? Math.max(0, parseInt(req.query.offset, 10))
        : (page - 1) * limit;
    const q      = typeof req.query.q === 'string' ? req.query.q.trim() : '';

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

        const baseFilter = "(level != 'info' OR category = 'health-share-report') AND message NOT LIKE '%APR-Alert%'";
        // Suche schließt Anzeigename UND context mit ein: die UI zeigt "Liquidity Bot"
        // sowie (seit 2026-08-08) den Pool aus dem context-JSON-Blob in der Thema-Spalte
        // (siehe extractPool()) – ohne beide Spalten in der Suche wäre genau der
        // sichtbare Text nicht auffindbar. Der Pool steckt bei neueren Meldungen NUR in
        // context (structured "pair"/"pool"-Feld), nicht mehr im Fließtext von message
        // – LIKE auf dem rohen context-JSON reicht, weil der Pair-String dort als
        // Klartext-Wert steht (z.B. `"pair":"PUMP/SOL"`).
        const searchCols = ['message', 'category', 'bot_id', 'level', 'context', ...(hasDisplayName ? ['display_name'] : [])];
        const whereSql = q
            ? `WHERE ${baseFilter} AND (${searchCols.map(c => `${c} LIKE ?`).join(' OR ')})`
            : `WHERE ${baseFilter}`;
        const like     = `%${q}%`;
        const params   = q ? searchCols.map(() => like) : [];

        const totalCount = db.prepare(`SELECT COUNT(*) AS c FROM notifications ${whereSql}`).get(...params).c;

        // read kam erst am 03.08.2026 dazu (Migration läuft beim Nexus-Start, siehe
        // notify-db.js) – gleiche Vorsichtsmaßnahme wie bei display_name oben.
        const hasRead = db.prepare('PRAGMA table_info(notifications)')
            .all().some(c => c.name === 'read');
        const readCol = hasRead ? 'read' : '0';

        // msg_key/msg_params kamen mit der Mehrsprachigkeit dazu (Schritt 5,
        // Migration beim Nexus-Start) – gleiche Vorsichtsmaßnahme wie oben.
        const hasI18n  = db.prepare('PRAGMA table_info(notifications)')
            .all().some(c => c.name === 'msg_key');
        const i18nCols = hasI18n ? 'msg_key, msg_params' : 'NULL AS msg_key, NULL AS msg_params';

        const rows = db.prepare(`
            SELECT id, timestamp, bot_id AS botId, level, category, message, context, ${nameCol} AS displayName, ${readCol} AS read, ${i18nCols}
            FROM notifications
            ${whereSql}
            ORDER BY timestamp DESC
            LIMIT ? OFFSET ?
        `).all(...params, limit, offset)
          // notificationText() entscheidet als EINZIGE Stelle, ob aus msg_key neu
          // gerendert oder der gespeicherte Text genommen wird (Altbestand).
          .map(({ context, msg_key, msg_params, ...r }) => ({
              ...r,
              message: notificationText({ ...r, msg_key, msg_params }),
              read:    !!r.read,
              botName: resolveBotName(r.displayName, r.botId),
              pool:    extractPool(context, r.message),
          }));

        // Für "alle als gelesen"-Bulk-Aktion, auf die aktuelle Suche beschränkt.
        const allIds = db.prepare(`SELECT id FROM notifications ${whereSql}`).all(...params).map(r => r.id);
        // Für Brief-Icon-Badge + Menü-Zähler – server-seitig statt Client-Diff gegen
        // localStorage (siehe message-bell.js), damit der Stand über alle Geräte gleich ist.
        const unreadCount = hasRead
            ? db.prepare(`SELECT COUNT(*) AS c FROM notifications ${whereSql} AND read = 0`).get(...params).c
            : allIds.length;
        // Zeitstempel der ältesten ungelesenen Nachricht – Brief-Icon (message-bell.js)
        // vergleicht das mit Support/Premium, um bei Klick auf Icon/Badge zur Rubrik
        // mit der am längsten offenen ungelesenen Nachricht zu springen, statt fest
        // auf eine Rubrik zu verlinken.
        const oldestUnread = hasRead
            ? (db.prepare(`SELECT MIN(timestamp) AS t FROM notifications ${whereSql} AND read = 0`).get(...params).t ?? null)
            : null;

        // hasMore statt totalPages: der Client hängt beim Scrollen an, statt zu blättern.
        res.json({ notifications: rows, limit, offset, totalCount, hasMore: offset + rows.length < totalCount, allIds, unreadCount, oldestUnread });
    } catch {
        // nexus.db existiert noch nicht oder hat noch keine Notification erhalten.
        res.json({ notifications: [], limit, offset, totalCount: 0, hasMore: false, allIds: [], unreadCount: 0 });
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

// DELETE /system/:id – löscht eine einzelne System-Meldung. Nach außen (UI) ein
// REST-DELETE wie beim Support-Thread, nach innen der ID-Listen-Endpoint des
// Nexus, der als einziger Prozess auf nexus.db schreibt (siehe notify-db.js).
router.delete('/system/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: t('msg.support.invalid_id') });
    proxyNexusJson(req, res, '/notifications/delete', { method: 'POST', body: JSON.stringify({ ids: [id] }) });
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
