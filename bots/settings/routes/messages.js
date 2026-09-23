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
 * GET  /api/messages/bots           → Bot-Meldungen aus nexus.db (Liquidity/Lending),
 *                                      gleiche Parameter und gleiches Antwortformat wie
 *                                      /system – nur die Gegenmenge derselben Query.
 *                                      Gelesen-Markierung und Löschen laufen weiter über
 *                                      /system/... (Notification-IDs sind rubrikunabhängig).
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
import { t, getLang } from '../../../lib/i18n.js';
import { notificationText, formatNumber } from '../../../lib/notify-render.js';
import { pnlForPeriod } from '../../../lib/pnl.js';
import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';
import { getBotConfig } from '../../../lib/bot-registry.js';

const PREMIUM_BASE = `http://127.0.0.1:${process.env.PREMIUM_PORT || '3110'}`;
const NEXUS_BASE   = `http://127.0.0.1:${process.env.NEXUS_PORT || '3100'}`;
const NEXUS_DB_PATH = PATHS.nexusDb;

// Die beiden echten Bots – Anzeigenamen kommen aus der zentralen Registry
// (config/bots.json), damit eine Umbenennung dort nicht hier nachgezogen werden muss.
const BOT_IDS       = ['liquidity', 'lending'];
const BOT_NAMES     = BOT_IDS.map(id => getBotConfig(id).displayName);
const BOT_NAME_BY_ID = Object.fromEntries(BOT_IDS.map(id => [id, getBotConfig(id).displayName]));

// Risk-Management-Kategorien (2026-08-25, Message Center > Einstellungen >
// Benachrichtigungen > "Risk-Management"): alle Meldungen, die ein Risikomanagement-
// Ereignis auslöst – Trailing Stop, TVL-Schutz, Score-Limit, plus die gemeinsame
// rm-warning/rm-executed-Fassade (siehe bots/liquidity/lib/trailing-stop.js). Das
// Score-Limit ist seit LIQ#000925 entfernt; seine Kategorien bleiben hier, damit
// Altmeldungen weiter unter Risk-Management zählen. Anders als
// System/Bots/Support/Premium ist das KEINE eigene Rubrik, sondern ein Unterfilter
// innerhalb von "Bots" (die Kategorien kommen ausschließlich vom Liquidity-Bot) –
// betrifft deshalb nur den Ungelesen-Zähler der Rubrik Bots, nicht die Sichtbarkeit
// der Meldungen selbst (gleiches Prinzip wie bei den anderen vier Toggles).
const RISK_CATEGORIES = [
    'rm-warning', 'rm-executed',
    'trailing-stop', 'trailing-stop-done', 'trailing-stop-partial',
    'tvl', 'tvl-done',
    'score-limit', 'score-limit-done',
];

/**
 * Anzeigename des betroffenen Bots für die Kopfzeile im Message Center.
 *
 * Bewusst NUR drei mögliche Werte ("Liquidity Bot", "Lending Bot", "System"),
 * unabhängig vom frei gewählten display_name
 * jedes einzelnen Absenders (Betreiber-Vorgabe 2026-08-16): der Nutzer soll auf
 * den ersten Blick sehen, ob eine Meldung von einem der beiden Bots kommt oder
 * vom FORGE-Kern — nicht die uneinheitlichen Rohnamen der ~10 verschiedenen
 * Skripte, die an /notify senden (z.B. "Monitoring", "Auto-Update"). Das
 * gespeicherte display_name bleibt in der DB erhalten, wird hier nur ignoriert.
 *
 * Ausnahme seit 2026-08-18 (Rubrik "Bots"): Absender, die selbst kein Bot sind,
 * aber den BETROFFENEN Bot im display_name mitschicken, werden darüber zugeordnet.
 * Praktisch relevant für den SOL-Guthaben-Alert des Wallet-Monitors (botId
 * 'wallet-monitor', display_name 'Liquidity Bot'/'Lending Bot' — siehe
 * core/wallet-monitor/monitor.js). Vorher stand dort als Absender "FORGE", die
 * Meldung wäre also in der falschen Rubrik gelandet.
 */
function resolveBotName(displayName, botId) {
    if (BOT_NAME_BY_ID[botId]) return BOT_NAME_BY_ID[botId];
    if (BOT_NAMES.includes(displayName)) return displayName;
    // Alles Übrige landet in der Rubrik "System" und heißt dort auch so (Vorgabe
    // 2026-08-18). Vorher stand "FORGE" – dieselbe Meldung, aber ein Name, der
    // sich nicht mehr auf die Rubrik zurückführen ließ, seit es daneben eine
    // Rubrik "Bots" gibt, deren Meldungen ja ebenso von FORGE stammen.
    return 'System';
}

// Pool-Name neben dem Bot-Namen in der Message-Center-Kopfzeile (Ticket 2026-08-08):
// notify.js-Aufrufer schreiben den Pool strukturiert in den context-JSON-Blob
// (Key "pair", bei tierTransition zusätzlich "pool" — beide werden hier geprüft).
//
// Bis 2026-08-18 gab es zusätzlich einen Regex-Fallback auf den Fließtext
// (/\b[A-Za-z0-9]{2,10}\/[A-Za-z0-9]{2,10}\b/) für Altmeldungen ohne context.
// Der ist ersatzlos entfallen: das Muster trifft auch Nicht-Pools — bei
// englischer Spracheinstellung das Datum ("08/18/2026" → Pool "08/18"), im
// deutschen Fließtext Wortpaare wie "Ein/Aus". Beides stand als "Pool <X>" in
// der Liste bzw. hinter dem Level in der Detailansicht. Nutzen hatte der
// Fallback ohnehin keinen mehr: es werden nur die letzten 100 Notifications
// aufbewahrt (MAX_NOTIFICATIONS in core/nexus/notify-db.js), Meldungen von vor
// 2026-08-08 sind daher längst verdrängt. Fehlt der Pool jetzt in der Kopfzeile,
// steht er weiterhin im Nachrichtentext selbst.
function extractPool(context) {
    if (!context) return null;
    try {
        const parsed = JSON.parse(context);
        return parsed?.pair ?? parsed?.pool ?? null;
    } catch {
        return null;  // kein valides JSON – dann eben kein Pool-Bezug
    }
}

/**
 * Strukturierte Darstellung eines Tagesberichts (n.dailyReport, siehe
 * bots/liquidity/bin/daily-report.js buildReportData()) fürs Message Center —
 * analog zu extractRiskExit() beim Trailing Stop: eigene Frontend-Darstellung
 * (Überschrift, Aufzählung, farbige Tabelle) statt Fließtext mit Pipe-Tabelle.
 *
 * Alle Zahlen kommen bereits fertig formatiert aus daily-report.js (deutsches
 * Zahlenformat, Europe/Berlin-Zeitzone) — hier wird nichts nachgerechnet, nur
 * durchgereicht. Ältere Tagesberichte (vor 2026-08-24) haben kein `data`-Feld in
 * msg_params und fallen auf die Fließtext-Darstellung zurück (liefert `null`).
 */
function extractDailyReport(msgKey, msgParams) {
    if (msgKey !== 'notify.liq.daily_report') return null;
    let p = msgParams;
    if (typeof p === 'string') {
        try { p = JSON.parse(p); } catch { return null; }
    }
    if (!p || typeof p !== 'object' || !p.data) return null;
    return { day: p.day ?? null, ...p.data };
}

/**
 * Betreffzeile für die SOL-Reserve-Warnung/-Erholung (n.solLow, siehe
 * bots/liquidity/lib/notify.js solLow()) — der Fließtext bleibt unverändert
 * (körperlicher Meldungstext, notify.liq.sol_low/_recovered), nur die Kopfzeile
 * der Detailansicht bekommt einen Wiederholungszähler ("Warnung: … (2)") bzw.
 * die Erholungs-Kennzeichnung ("Hinweis: … wiederhergestellt").
 */
export function extractSolLow(msgKey, msgParams) {
    if (msgKey !== 'notify.liq.sol_low' && msgKey !== 'notify.liq.sol_recovered') return null;
    let p = msgParams;
    if (typeof p === 'string') {
        try { p = JSON.parse(p); } catch { return null; }
    }
    // Seit LIQ#000886 kommt `reserve` als { n, d }-Objekt (Konvention 4) statt als
    // fertig formatierter String mit hartem Komma — hier für die Betreffzeile in
    // der Sprache der Installation formatiert. Altmeldungen (String) bleiben
    // unverändert durchgereicht.
    const reserve = (p?.reserve && typeof p.reserve === 'object' && typeof p.reserve.n === 'number')
        ? formatNumber(p.reserve.n, getLang(), { d: p.reserve.d })
        : (p?.reserve ?? null);
    if (msgKey === 'notify.liq.sol_recovered') return { recovered: true, reserve };
    return { recovered: false, count: p?.count ?? null, reserve };
}

/**
 * PnL eines Risk-Management-Exits aus lib/pnl.js NACHTRÄGLICH ermitteln – nur für
 * Altmeldungen von vor Einführung der pnlLine (03.08.2026er Mehrsprachigkeits-
 * Umbau kam vor dieser Erweiterung), deren msg_params noch keinen pnl-Wert
 * enthalten. Neue Meldungen liefern pnlLine bereits fertig mit (siehe
 * bots/liquidity/lib/exit-finalizer.js computeExitPnl()).
 *
 * Nur Lesezugriff auf liquiditybot.db (fremde Bot-DB, laut Konvention erlaubt).
 * Bewusst konservativ: ohne einen zeitlich eindeutigen Treffer (Positions-Ende
 * innerhalb weniger Minuten um den Meldungszeitpunkt) lieber gar kein PnL zeigen
 * als eines aus einer falsch zugeordneten Position.
 */
const LEGACY_MATCH_TOLERANCE_MS = 5 * 60_000;

// Token-Reihenfolge egal: notify.js schickt pool.displayPair (Orca-Konvention,
// siehe project_pool_naming_orca), die pools-Tabelle speichert intern eine feste
// (teils andere) Reihenfolge – z.B. Meldung "PUMP/SOL" vs. DB-Zeile "SOL/PUMP"
// für denselben Pool. Ein Set-Vergleich der beiden Symbole ist robust dagegen.
function pairKey(pair) {
    return String(pair ?? '').split('/').map(s => s.trim().toLowerCase()).sort().join('/');
}

function backfillLegacyExitPnl(liquidityDb, pair, notifTimestampMs) {
    if (!liquidityDb || !pair || !Number.isFinite(notifTimestampMs)) return null;
    try {
        const key = pairKey(pair);
        const poolRow = liquidityDb.prepare(`SELECT id, pair FROM pools`).all()
            .find(r => pairKey(r.pair) === key);
        if (!poolRow) return null;
        const pos = liquidityDb.prepare(`
            SELECT opened_at, closed_at FROM positions
             WHERE pool_id = ? AND closed_at IS NOT NULL
             ORDER BY ABS(closed_at - ?) ASC LIMIT 1
        `).get(poolRow.id, notifTimestampMs);
        if (!pos || Math.abs(pos.closed_at - notifTimestampMs) > LEGACY_MATCH_TOLERANCE_MS) return null;

        const lastDeposit = liquidityDb.prepare(`
            SELECT MAX(created_at) AS t FROM capital_flows
             WHERE pool_id = ? AND usdc_amount > 0 AND is_external = 1 AND created_at >= ?
        `).get(poolRow.id, pos.opened_at);
        const fromMs = lastDeposit?.t ?? pos.opened_at;

        return pnlForPeriod(liquidityDb, { flavor: 'liquidity', scope: poolRow.id, fromMs, toMs: pos.closed_at });
    } catch {
        return null;
    }
}

/**
 * Strukturierte Darstellung eines Risk-Management-Exits (Trailing Stop /
 * Score-Limit, siehe bots/liquidity/lib/notify.js rmExecuted()) fürs Message
 * Center – analog zum `payment`-Objekt der Premium-Zahlungen
 * (core/premium/server.js humanizePremiumMessage()): eigene Frontend-Darstellung
 * statt Fließtext, hier für die Exit-Kennzahlen inkl. PnL.
 */
export function extractRiskExit(msgKey, msgParams, timestamp, liquidityDb) {
    if (msgKey !== 'notify.liq.rm_executed') return null;
    let p = msgParams;
    if (typeof p === 'string') {
        try { p = JSON.parse(p); } catch { return null; }
    }
    if (!p || typeof p !== 'object') return null;

    try {
        // scenario ist normalerweise ein Katalog-Verweis {k,p} (siehe rmScenario()
        // in notify.js), Altbestand kann noch einen rohen String enthalten.
        const scenario = p.scenario == null ? null
            : (typeof p.scenario === 'object' && p.scenario.k) ? t(p.scenario.k, p.scenario.p)
            : String(p.scenario);
        const actionText = p._action ? t(String(p._action)) : null;
        // Seit LIQ#000886 kommen Beträge in msg_params als { n, d, sign }-Objekt
        // (Konvention 4, lib/notify-render.js) statt als fertig formatierter String
        // (`toFixed()`). numOf() liest beide Formen: das neue Objekt über `.n`, den
        // alten String/die alte Zahl weiter über parseFloat() — Altmeldungen vor
        // diesem Ticket bleiben so lesbar, ohne Migration.
        const numOf = (v) => {
            if (v == null) return null;
            if (typeof v === 'object' && typeof v.n === 'number') return v.n;
            const n = parseFloat(v);
            return Number.isFinite(n) ? n : null;
        };
        // pnlUsdcNum bleibt die Rohzahl (für die %-Berechnung unten), pnlUsdc die
        // formatierte Anzeige – Backfill nur wenn msg_params noch keinen PnL trägt
        // (Altmeldungen von vor dieser Erweiterung).
        let pnlUsdcNum = p.pnlLine?.p?.pnl != null ? numOf(p.pnlLine.p.pnl) : null;
        if (pnlUsdcNum == null) pnlUsdcNum = backfillLegacyExitPnl(liquidityDb, p.pair, timestamp);
        const pnlUsdc = pnlUsdcNum != null ? `${pnlUsdcNum >= 0 ? '+' : ''}${pnlUsdcNum.toFixed(2)}` : null;

        // 🔒 Bezugsgröße des PnL-Prozentwerts ist das eingezahlte Kapital
        // (positions.capital_usdc) — exakt der Nenner, mit dem lib/pnl.js auch den
        // Zähler bildet. Vorher war es der Poolwert bei Schließung; zusammen mit der
        // damaligen Zeile "Guthaben Start" (= positions.entry_usd, die über
        // Kapitalflüsse hochskalierte Trailing-Stop-Referenz) standen in derselben
        // Tabelle drei verschiedene Nullpunkte. Ergebnis am 30.08.2026, STONK/SOL:
        // "Start 409,04 → nach Exit 411,05" bei ausgewiesenem PnL −0,23 USDC — die
        // Meldung widersprach sich selbst (LIQ#0353). Altmeldungen ohne
        // capitalUsdcRaw fallen auf den alten Nenner zurück, damit ihr Prozentwert
        // zu ihrer eigenen Zahl passt.
        const investNum  = p.capitalUsdcRaw ?? null;
        const lpValueNum = p.lpValue != null ? numOf(p.lpValue) : null;
        const pctBase    = investNum ?? lpValueNum;
        const pnlPct = (pnlUsdcNum != null && pctBase != null && pctBase !== 0)
            ? `${pnlUsdcNum >= 0 ? '+' : ''}${(pnlUsdcNum / pctBase * 100).toFixed(2)}%`
            : null;

        // "Ausstieg Betrag" ist der tatsächlich realisierte Gegenwert – nach Swap,
        // falls einer stattfand, sonst der letzte gemessene Poolwert (kein Swap
        // konfiguriert/nötig). Bewusst der Betrag, der in der Wallet ankam: zusammen
        // mit "Invest Betrag" oben ergibt er genau den PnL.
        const swappedNum = p.exitAmountRaw
            ?? (p.swappedLine?.p?.usdc != null ? numOf(p.swappedLine.p.usdc) : null);
        const exitAmountNum = swappedNum ?? lpValueNum;

        const fix2 = (v) => (v != null && Number.isFinite(v) ? v.toFixed(2) : null);
        // 🔒 Ein Geldbetrag von 0 ist in dieser Meldung immer eine FEHLENDE Messung, nie
        // ein Messergebnis: die Aufrufer setzen `hwmUsd: position?.hwm_usd ?? 0`, und ein
        // Einstieg über 0 USDC oder ein Ausstieg mit 0 USDC Erlös existiert nicht.
        //
        // Die Prüfung MUSS hier stehen und nicht nur in notify.js: msg_params sind
        // gespeichert. Meldung 7804 trug bereits `hwmUsdRaw: 0` und zeigte deshalb weiter
        // „Guthaben Betrag 0,00 USDC", nachdem der Schreibpfad längst korrigiert war —
        // ein Fix im Schreibpfad allein repariert keine einzige bestehende Meldung.
        //
        // Ausdrücklich NICHT für die Kostenzeilen: Ein- und Ausstiegskosten dürfen 0 oder
        // negativ sein (negativ = es kam mehr an als gemessen), das sind echte Werte.
        const amount2 = (v) => (v != null && Number.isFinite(v) && v > 0 ? v.toFixed(2) : null);

        const hwmUsdc2 = amount2(p.hwmUsdRaw ?? null);
        // Bezugsgröße wie bei pnlPct oben: das eingezahlte Kapital (investNum), nicht
        // der Poolwert bei Schließung — derselbe Nenner in derselben Tabelle.
        const hwmRaw = p.hwmUsdRaw ?? null;
        const hwmPct = (hwmUsdc2 != null && hwmRaw != null && investNum != null && investNum !== 0)
            ? `${hwmRaw >= investNum ? '+' : ''}${((hwmRaw - investNum) / investNum * 100).toFixed(2)}%`
            : null;
        // Absoluter Abstand zum eingezahlten Kapital, eigene Zeile neben dem Prozentwert
        // (Vorgabe 2026-09-01) — dieselbe Bezugsgröße wie hwmPct, nur unskaliert.
        const hwmDeltaUsdc = (hwmUsdc2 != null && hwmRaw != null && investNum != null)
            ? fix2(hwmRaw - investNum)
            : null;

        return {
            pair:      p.pair ?? null,
            scenario,
            pnlUsdc,
            pnlPct,
            // ── Einstieg ──────────────────────────────────────────────────────
            openedAtMs:    p.openedAtMs ?? null,
            investUsdc:    amount2(investNum),
            // NULL bei jedem Einstieg, dessen Bruttoeinsatz nicht feststeht (Altbestand
            // und Pfade mit Budget-Deckel, siehe recordEntryCost() in deposit-lib.js) —
            // die Zeile entfällt dann, statt eine 0 zu behaupten.
            entryCostUsdc: amount2(p.entryCostRaw ?? null),
            // ── Maximum ───────────────────────────────────────────────────────
            // Zeitpunkt nur zusammen mit dem Betrag, auf den er sich bezieht.
            hwmAtMs:       hwmUsdc2 != null ? (p.hwmAtMs ?? null) : null,
            hwmUsdc:       hwmUsdc2,
            hwmPct,
            hwmDeltaUsdc,
            // ── Ausstieg ──────────────────────────────────────────────────────
            exitStartedAtMs: p.exitStartedAtMs ?? null,
            exitAmountUsdc:  amount2(exitAmountNum),
            exitCostUsdc:    fix2(p.exitCostRaw ?? (p.swappedLine?.p?.cost != null ? numOf(p.swappedLine.p.cost) : null)),
            // Abschluss der Meldung = Ende der Laufzeit (für die Zusammenfassung oben).
            exitAtMs:      timestamp ?? null,
            actionText,
            // ── Nachvollziehbarkeit (Solscan-Links) ──────────────────────────────
            openTx:        p.openTxRaw ?? null,
            closeTx:       p.closeTxRaw ?? null,
            nftMint:       p.nftMintRaw ?? null,
            reinvestCount: p.reinvestCountRaw ?? null,
            reinvestUsdc:  fix2(p.reinvestUsdcRaw ?? null),
            bestPoolUsdc:  fix2(p.bestPoolUsdcRaw ?? null),
        };
    } catch {
        return null;
    }
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
// Höchstwert 100 entspricht dem Fenster, das notify-db.js per Pruning je Rubrik
// (System/Bots getrennt) nach jedem Insert offen hält (MAX_NOTIFICATIONS_PER_CATEGORY,
// CORE#000719) – mehr Zeilen der jeweiligen Rubrik kann es gar nicht geben.
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
//
// Zweite Ausnahme (2026-08-23): der tägliche Tagesbericht (category
// 'daily-report') wurde an diesem Tag von 'warn' auf 'info' korrigiert (er ist
// keine Warnung, sondern reine Rückschau) — dieselbe Blende hätte ihn dadurch
// ungewollt komplett aus System UND Bots verschwinden lassen (Fund 2026-08-23:
// Nachricht stand korrekt in der DB, war aber in keiner Rubrik zu sehen).
// Positions-/Deposit-Rauschmeldungen, die die Blende ursprünglich abstellen
// sollte (Fund 2026-08-13: Report kam korrekt in der DB an, war aber nie sichtbar).
//
// Dritte Ausnahme (2026-08-24): Trailing-Stop-Abschlussmeldung (category
// 'rm-executed') von 'warn' auf 'info' korrigiert (normales Bot-Verhalten, keine
// Warnung) — derselbe Fehler wie beim Tagesbericht am 23.08., diesmal direkt beim
// Umstellen entdeckt statt erst durch "die Nachricht ist weg".
//
// Vierte Ausnahme (2026-08-26): Scam-Token-Fund im Wallet (category 'scam_token',
// Wallet-Monitor) ist bewusst 'info' (kein Telegram, siehe Kommentar in
// core/wallet-monitor/monitor.js) — sollte aber im Message Center sichtbar sein,
// da es die einzige aktive Anzeige für den Fund ist. Derselbe Fehler ein drittes
// Mal: neue info-Kategorie eingeführt, hier vergessen (Fund 2026-08-26: Meldung
// stand korrekt in der DB, war aber in keiner Rubrik zu sehen).
//
// Fünfte Ausnahme (2026-08-27): Zombie-NFT-Cleanup (category 'zombie-check',
// bin/run-zombie-check.sh) wurde am 24.08. im Zuge von LIQ#0327 korrekt von
// 'warn' auf 'info' umgestellt (reiner Erfolgsfall) — genau derselbe Fehler ein
// viertes Mal: die Blende hier wurde beim Umstellen nicht mitgezogen, seitdem
// unsichtbar trotz korrekt geburnter Zombies (Fund 2026-08-27: seit dem
// Umstellen keine Nachricht mehr gesehen, obwohl 26.08. zwei Zombies geburnt
// wurden — Meldungen standen korrekt in der DB).
function handleNotificationWindow(req, res, scope) {
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
    // Nur bei Bedarf geöffnet (Legacy-PnL-Backfill, siehe extractRiskExit) – die
    // meisten Requests haben keine rm_executed-Zeile im Fenster.
    let liquidityDb = null;
    const getLiquidityDb = () => {
        if (liquidityDb === null) {
            try { liquidityDb = new Database(PATHS.liquidityDb, { readonly: true, fileMustExist: true }); }
            catch { liquidityDb = false; }
        }
        return liquidityDb || null;
    };
    try {
        db = new Database(NEXUS_DB_PATH, { readonly: true, fileMustExist: true });

        // display_name kam erst am 30.07.2026 dazu (Migration läuft beim Nexus-Start,
        // siehe notify-db.js). Wird forge-settings vor forge-nexus neu gestartet, fehlt
        // die Spalte noch — ohne diese Prüfung würde die SELECT-Query werfen und der
        // catch-Zweig unten lieferte ein LEERES Message Center statt der Meldungen.
        const columns        = db.prepare('PRAGMA table_info(notifications)').all().map(c => c.name);
        const hasDisplayName = columns.includes('display_name');
        const nameCol = hasDisplayName ? 'display_name' : 'NULL';

        // read und msg_key/msg_params kamen ebenfalls per Migration dazu (03.08. bzw.
        // mit der Mehrsprachigkeit) – gleiche Vorsichtsmaßnahme wie bei display_name.
        const hasRead  = columns.includes('read');
        const readCol  = hasRead ? 'read' : '0';
        const hasI18n  = columns.includes('msg_key');
        const i18nCols = hasI18n ? 'msg_key, msg_params' : 'NULL AS msg_key, NULL AS msg_params';

        // Rubriken-Trennung System/Bots (Vorgabe 2026-08-18): dieselbe Zuordnung wie
        // resolveBotName() oben, nur in SQL – gefiltert wird serverseitig, damit
        // Fenster (limit/offset), Trefferzahl und Ungelesen-Zähler je Rubrik stimmen.
        // Die display_name-Spalte muss mit hinein, weil Absender wie der Wallet-Monitor
        // ihre SOL-Meldungen unter eigener botId, aber mit dem Bot-Anzeigenamen senden.
        const botListSql = BOT_IDS.map(() => '?').join(',');
        const botNameSql = BOT_NAMES.map(() => '?').join(',');
        // COALESCE ist Pflicht, nicht Kosmetik: bei display_name IS NULL (Zeilen von
        // vor der 30.07.-Migration) liefert `display_name IN (...)` SQL-NULL, damit
        // wird auch das umgebende NOT (...) zu NULL — die Zeile fiele aus BEIDEN
        // Rubriken heraus statt in "System" zu landen.
        const isBotSql   = hasDisplayName
            ? `(COALESCE(bot_id,'') IN (${botListSql}) OR COALESCE(display_name,'') IN (${botNameSql}))`
            : `(COALESCE(bot_id,'') IN (${botListSql}))`;
        const scopeParams = hasDisplayName ? [...BOT_IDS, ...BOT_NAMES] : [...BOT_IDS];
        const scopeSql    = scope === 'bots' ? isBotSql : `NOT ${isBotSql}`;

        // Start-/Stop-Meldungen der Bots erscheinen in KEINER Rubrik (Vorgabe
        // 2026-08-18): sie sagen dem Nutzer nichts, was er tun müsste, und ein
        // Deploy/Auto-Restart hätte die Bot-Rubrik regelmäßig zugemüllt. Neu erzeugt
        // werden sie ohnehin nicht mehr (notify.startup()/shutdown() sind seit
        // 2026-08-14 leer, siehe bots/*/lib/notify.js) – der Filter räumt den
        // Altbestand aus der Anzeige, ohne auf der Nexus-DB zu löschen (fremde DB,
        // nur Lesezugriff erlaubt). Zwei Wege, weil ältere Zeilen noch kein msg_key
        // haben: Katalogschlüssel für neue, Textmuster (DE/EN) für alte.
        const restartKeys = ['notify.liq.startup', 'notify.liq.shutdown_expected',
                             'notify.liq.shutdown_unexpected', 'notify.len.startup', 'notify.len.shutdown'];
        const restartTexts = ['%Bot gestartet%', '%Bot gestoppt%', '%Bot started%', '%Bot stopped%'];
        const restartSql = (hasI18n ? `COALESCE(msg_key,'') NOT IN (${restartKeys.map(() => '?').join(',')}) AND ` : '')
            + restartTexts.map(() => "COALESCE(message,'') NOT LIKE ?").join(' AND ');
        const restartParams = hasI18n ? [...restartKeys, ...restartTexts] : [...restartTexts];

        const baseFilter = `(level != 'info' OR category IN ('health-share-report', 'daily-report', 'rm-executed', 'scam_token', 'zombie-check'))`
            + ` AND message NOT LIKE '%APR-Alert%' AND ${scopeSql} AND ${restartSql}`;
        const baseParams = [...scopeParams, ...restartParams];
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
        const params   = q ? [...baseParams, ...searchCols.map(() => like)] : [...baseParams];

        const totalCount = db.prepare(`SELECT COUNT(*) AS c FROM notifications ${whereSql}`).get(...params).c;

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
              message:  notificationText({ ...r, msg_key, msg_params }),
              read:     !!r.read,
              botName:  resolveBotName(r.displayName, r.botId),
              pool:        extractPool(context),
              riskExit:    extractRiskExit(msg_key, msg_params, r.timestamp, getLiquidityDb()),
              dailyReport: extractDailyReport(msg_key, msg_params),
              solLow:      extractSolLow(msg_key, msg_params),
          }));

        // Für "alle als gelesen"-Bulk-Aktion, auf die aktuelle Suche beschränkt.
        const allIds = db.prepare(`SELECT id FROM notifications ${whereSql}`).all(...params).map(r => r.id);

        // "Risk-Management" (Einstellungen > Benachrichtigungen) ausgeschaltet? Nur
        // relevant für die Rubrik "Bots" (siehe RISK_CATEGORIES oben) und nur für die
        // beiden Zähler unten – Messages bleiben immer in `rows` sichtbar, gleiches
        // Prinzip wie bei den anderen vier Toggles.
        // settings-Tabelle kann bei einer frisch erzeugten nexus.db theoretisch noch
        // fehlen (wird erst bei getDb() im Nexus-Prozess angelegt) – gleiche
        // Vorsichtsmaßnahme wie bei hasDisplayName/hasRead oben, sonst würde die ganze
        // Rubrik über den äußeren catch-Zweig leer laufen statt nur den Toggle zu ignorieren.
        const hasSettingsTable = db.prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'"
        ).get() != null;
        const riskDisabled = scope === 'bots' && hasSettingsTable
            && db.prepare("SELECT value FROM settings WHERE key = 'notify_risk'").get()?.value === '0';
        const riskExclSql    = riskDisabled ? ` AND category NOT IN (${RISK_CATEGORIES.map(() => '?').join(',')})` : '';
        const riskExclParams = riskDisabled ? RISK_CATEGORIES : [];

        // Für Brief-Icon-Badge + Menü-Zähler – server-seitig statt Client-Diff gegen
        // localStorage (siehe message-bell.js), damit der Stand über alle Geräte gleich ist.
        const unreadCount = hasRead
            ? db.prepare(`SELECT COUNT(*) AS c FROM notifications ${whereSql}${riskExclSql} AND read = 0`).get(...params, ...riskExclParams).c
            : allIds.length;
        // Zeitstempel der ältesten ungelesenen Nachricht – Brief-Icon (message-bell.js)
        // vergleicht das mit Support/Premium, um bei Klick auf Icon/Badge zur Rubrik
        // mit der am längsten offenen ungelesenen Nachricht zu springen, statt fest
        // auf eine Rubrik zu verlinken.
        const oldestUnread = hasRead
            ? (db.prepare(`SELECT MIN(timestamp) AS t FROM notifications ${whereSql}${riskExclSql} AND read = 0`).get(...params, ...riskExclParams).t ?? null)
            : null;

        // hasMore statt totalPages: der Client hängt beim Scrollen an, statt zu blättern.
        res.json({ notifications: rows, limit, offset, totalCount, hasMore: offset + rows.length < totalCount, allIds, unreadCount, oldestUnread });
    } catch {
        // nexus.db existiert noch nicht oder hat noch keine Notification erhalten.
        res.json({ notifications: [], limit, offset, totalCount: 0, hasMore: false, allIds: [], unreadCount: 0 });
    } finally {
        db?.close();
        liquidityDb?.close?.();
    }
}

// Zwei Rubriken, eine Query: /system liefert alles, was NICHT von einem der beiden
// Bots stammt, /bots genau die Gegenmenge (siehe handleNotificationWindow()).
router.get('/system', (req, res) => handleNotificationWindow(req, res, 'system'));
router.get('/bots',   (req, res) => handleNotificationWindow(req, res, 'bots'));

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

// GET  /features/:feature → { enabled } – Feature-Toggle aus Einstellungen, das
// nicht nur die Badge-Sichtbarkeit steuert, sondern ob eine Meldung überhaupt
// erzeugt wird (erster Nutzer: Liquidity-Tagesbericht, feature = 'daily_report').
// POST /features/:feature { enabled } → Toggle setzen.
router.get('/features/:feature', (req, res) =>
    proxyNexusJson(req, res, `/features/${encodeURIComponent(req.params.feature)}`));

router.post('/features/:feature', (req, res) =>
    proxyNexusJson(req, res, `/features/${encodeURIComponent(req.params.feature)}`, { method: 'POST', body: JSON.stringify(req.body ?? {}) }));

export default router;
