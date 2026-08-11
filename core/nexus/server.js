/**
 * FORGE Nexus Server
 *
 * Zentraler Knotenpunkt für API-Routing, Rate-Limiting, Logging und
 * Notification-Routing aller FORGE-Bots.
 * Lauscht ausschließlich auf 127.0.0.1 (kein externer Zugriff).
 *
 * Routen:
 *   /jup/*       →  https://api.jup.ag/*  (Jupiter Swap, Trigger, Earn)
 *   /kamino/*    →  https://api.kamino.finance/*
 *   /loopscale/* →  https://tars.loopscale.com/v1/*
 *   /gecko/*     →  https://api.geckoterminal.com/api/v2/*
 *   /pyth/price  →  https://hermes.pyth.network/ (SOL/BTC Preis-Oracle, 30s Cache)
 *   POST /rpc        →  Helius RPC (mit Cache)
 *   POST /rpc/fresh  →  Helius RPC (kein Cache)
 *   POST /notify     →  Zentrale Notification-Weiterleitung (DB + Telegram)
 *   GET  /health     →  Status + Rate-Limit-Auslastung
 *
 * Rate Limits:
 *   Jupiter: 5 req/s + 55 req/min  (Burst + Gesamt, doppelte Absicherung)
 *   Helius:   8 req/s    (Free Tier: 10/s, 20% Buffer)
 *
 * Telegram-Notifications:
 *   Nur level=error → Telegram. info/warn werden nur in nexus.db gespeichert.
 *   Format Critical:  🚨 botId → category\nMessage
 *   Format Lifecycle: 🟢/🔴 forge-nexus → running/stopped
 *
 * API Keys:
 *   Werden zentral aus .env geladen und vom Proxy injiziert.
 *   Bots senden keinen Key – der Proxy übernimmt das vollständig.
 *
 * Kein Auth – localhost-only ist ausreichende Isolation.
 */

import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { RateLimiter }       from './rate-limiter.js';
import { TxQueue }           from './tx-queue.js';
import { RpcCache }          from './rpc-cache.js';
import { HttpCache }         from './http-cache.js';
import { record as rpcRecord } from './rpc-stats.js';
import { insertNotification, updateRepeatCount, markNotificationsRead, getNotifySettings, setNotifySetting } from './notify-db.js';
import { checkDedup, setDedupRowId, checkRateLimit, fmtTime } from './dedup.js';
import { readMaintenanceFlag } from '../maintenance.js';
import { envFile } from '../../config/paths.js';

// .env laden (dotenv via require, da wir ESM nutzen)
const require  = createRequire(import.meta.url);
const dotenv   = require('dotenv');
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: envFile('nexus') });

// ─── Konfiguration (zentral, nur hier) ───────────────────────────────────────
const JUPITER_API_KEY    = process.env.JUPITER_API_KEY    ?? '';
const HELIUS_API_KEY     = process.env.HELIUS_API_KEY     ?? '';
const HELIUS_RPC_URL     = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const TELEGRAM_TOKEN     = process.env.TELEGRAM_BOT_TOKEN ?? '';
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID   ?? '';

// ─── Telegram-Helper ──────────────────────────────────────────────────────────

/**
 * Verschickt eine Telegram-Nachricht.
 * @returns {Promise<boolean>} true, wenn sie nachweislich rausging.
 *
 * Der Rückgabewert wird für die Spalte `sent_telegram` gebraucht: die wurde vorher
 * unbesehen auf 1 gesetzt, auch wenn Telegram mit einem HTTP-Fehler abgelehnt hatte
 * (auf forge-pub1 real beobachtet: HTTP 404, Zeile trotzdem als "gesendet" markiert).
 * Damit war die Spalte für jede Auswertung wertlos (Fix 2026-08-04).
 */
async function sendTelegram(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return false;
    const RETRY_DELAYS = [5000, 30000];
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
            const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                    chat_id:                  TELEGRAM_CHAT_ID,
                    text,
                    parse_mode:               'Markdown',
                    disable_web_page_preview: true,
                }),
            });
            if (!res.ok) {
                const errText = await res.text();
                // Markdown-Parsing fehlgeschlagen → Retry plain (kein Netzfehler, daher kein Delay-Retry)
                if (res.status === 400 && errText.includes("can't parse entities")) {
                    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
                        method:  'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body:    JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
                    });
                    return true;
                }
                console.error(`[nexus:telegram] Fehler: HTTP ${res.status} – ${errText}`);
                return false; // HTTP-Fehler nicht wiederholen
            }
            return true; // Erfolg
        } catch (err) {
            if (attempt < RETRY_DELAYS.length) {
                const delay = RETRY_DELAYS[attempt];
                console.warn(`[nexus:telegram] Verbindungsfehler (Versuch ${attempt + 1}/${RETRY_DELAYS.length + 1}), Retry in ${delay / 1000}s: ${err.message}`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                console.error(`[nexus:telegram] Verbindungsfehler (alle Versuche erschöpft): ${err.message}`);
            }
        }
    }
    return false;
}

// ─── fetchWithRetry – Retry für 429 / 5xx / Timeout ──────────────────────────
//
// Zentraler Fetch-Wrapper für alle Upstream-Calls in Nexus.
// Fängt transiente Fehler ab, bevor sie an die Bots weitergegeben werden.
//
// Verhalten:
//   429          → Retry mit Backoff (Retry-After-Header oder 1s/2s/4s)
//   5xx          → Retry mit Backoff (1s/2s/4s)
//   Timeout/Netz → Retry mit Backoff
//   Nach maxRetries: letzten Status/Fehler durchreichen (Bot entscheidet selbst)

const UPSTREAM_TIMEOUT_MS = 15_000; // 15s Timeout pro Einzelversuch

async function fetchWithRetry(url, options = {}, label = '', maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetch(url, {
                ...options,
                signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            });

            if (res.status === 429) {
                if (attempt === maxRetries) return res; // nach maxRetries durchreichen
                const retryAfter = parseInt(res.headers.get('Retry-After') ?? '0', 10);
                const waitMs = retryAfter > 0 ? retryAfter * 1_000 : (2 ** attempt) * 1_000;
                console.warn(`[nexus:retry] 429 ${label} – warte ${waitMs}ms (Versuch ${attempt + 1}/${maxRetries})`);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }

            if (res.status >= 500 && attempt < maxRetries) {
                const waitMs = (2 ** attempt) * 1_000;
                console.warn(`[nexus:retry] ${res.status} ${label} – warte ${waitMs}ms (Versuch ${attempt + 1}/${maxRetries})`);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }

            return res;

        } catch (err) {
            const isTransient = err.name === 'TimeoutError' || err.name === 'AbortError'
                             || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT'
                             || err.code === 'ECONNREFUSED';
            if (isTransient && attempt < maxRetries) {
                const waitMs = (2 ** attempt) * 1_000;
                console.warn(`[nexus:retry] ${err.name ?? err.code} ${label} – warte ${waitMs}ms (Versuch ${attempt + 1}/${maxRetries})`);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }
            throw err;
        }
    }
}

// ─── Throttle-Logging (kein Telegram – nur console.warn) ─────────────────────

function sendThrottleAlert(api, waitedMs, requestsInWindow, maxInWindow, windowSec = 60) {
    const unit = windowSec >= 60 ? 'req/min' : 'req/s';
    console.warn(`[nexus:${api}] THROTTLE – ${requestsInWindow}/${maxInWindow} ${unit}, gewartet ${waitedMs}ms`);
}

const app  = express();
const PORT = 3100;
const HOST = '127.0.0.1';

app.use(express.json({ limit: '2mb' }));

// ─── Rate Limiters ────────────────────────────────────────────────────────────

// Jupiter Free Tier: doppelte Absicherung – Burst + Gesamt.
//   Burst:  5 req/s  (1s-Fenster)  – verhindert simultane Anfragen-Spitzen
//   Gesamt: 55 req/min (60s-Fenster) – bleibt unter dem Jupiter-Free-Tier-Limit (60/min)
// Beide Limiter werden in proxyToJupiter() in Serie aufgerufen (Burst zuerst, dann Gesamt).
const jupiterBurstLimiter  = new RateLimiter('jupiter-burst',  5,  1_000);
const jupiterMinuteLimiter = new RateLimiter('jupiter-minute', 55, 60_000);

// Jupiter Trigger Query: separates Budget für GET /trigger/v1/getTriggerOrders.
// Verhindert dass Polling das Swap/Order-Budget aufbraucht (und umgekehrt).
// 3 Bots × 2 Richtungen × 2 calls/min = 12/min Baseline → 15/min mit Puffer.
const triggerQueryLimiter = new RateLimiter('trigger-query', 15);

// Kamino: kein dokumentiertes Limit → 40 req/min (konservativ, 20% Puffer)
const kaminoLimiter    = new RateLimiter('kamino',    40);

// GeckoTerminal: Limit empirisch ~6 req/min (sliding window, Free Tier).
// 1 req/20s = 3 req/min → 50% Puffer unter empirischem Limit.
// Hintergrund: Range Advisor fragt alle 8 Pools pro Zyklus ab → Burst-Schutz nötig.
const geckoLimiter     = new RateLimiter('gecko',     1, 20_000);

// Orca v2 REST API: kein dokumentiertes Limit → 30 req/10s konservativ (Orca eigene API)
const orcaV2Limiter    = new RateLimiter('orcav2',   30, 10_000);

// Loopscale: kein dokumentiertes Limit → 40 req/min (konservativ, 20% Puffer)
const loopscaleLimiter = new RateLimiter('loopscale', 40);

// Helius Free Tier: 10 req/s → 8 req/s (20% Sicherheitspuffer), 1-Sekunden-Fenster
const heliusLimiter    = new RateLimiter('helius',    8, 1_000);

// Blob-Fetch (Premium-Auslieferung, Filebase + Backup-Host): kein dokumentiertes
// Limit → konservativ 1 req/s (CLAUDE.md-Vorgabe bei undokumentierten Limits).
// Vorfall 2026-08-03 (forge-pub1): ein Backlog-Replay hat Dutzende parallele,
// ungebremste Downloads gegen Filebase ausgelöst (core/premium/server.js) – dieser
// Limiter deckelt das jetzt zentral, unabhängig davon wie viele Ingest-Prozesse
// gleichzeitig laufen.
const blobFetchLimiter = new RateLimiter('blob-fetch', 1, 1_000);

// Max. Wartezeit in der Rate-Limiter-Queue für transaktionale Jupiter-Calls.
// Ist die Queue länger als 10s voll, antwortet Nexus sofort mit 503 (retryNextTick).
// Polling-Calls (getTriggerOrders) sind davon ausgenommen – dort ist Queuing OK.
const TXNAL_QUEUE_TIMEOUT_MS = 10_000;

/**
 * Wartet auf einen freien Limiter-Slot, bricht aber nach timeoutMs ab.
 * Wirft einen Error mit Präfix "Queue-Timeout" wenn die Zeit abläuft.
 */
async function limiterWaitWithTimeout(limiter, timeoutMs) {
    return new Promise((resolve, reject) => {
        const id = setTimeout(() =>
            reject(new Error(`Queue-Timeout: ${limiter.name} wartet seit >${timeoutMs}ms`)),
            timeoutMs
        );
        limiter.wait()
            .then(ms => { clearTimeout(id); resolve(ms); })
            .catch(err => { clearTimeout(id); reject(err); });
    });
}

// ─── Jupiter Circuit Breaker ──────────────────────────────────────────────────
//
// Schützt vor Request-Flut bei Jupiter-Outages.
// Nach CIRCUIT_FAILURE_THRESHOLD aufeinanderfolgenden Fehlern (5xx/429) wird
// der Circuit für CIRCUIT_COOLDOWN_MS geöffnet – Nexus antwortet sofort 503.
// Nach der Cooldown-Zeit: ein Test-Request (half-open). Bei Erfolg: geschlossen.

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS       = 60_000; // 60s

const jupiterCircuit = {
    state:    'closed',  // 'closed' | 'open' | 'half-open'
    failures: 0,
    openedAt: null,

    isOpen() {
        if (this.state === 'closed' || this.state === 'half-open') return false;
        if (Date.now() - this.openedAt >= CIRCUIT_COOLDOWN_MS) {
            this.state = 'half-open';
            console.log('[nexus:circuit] HALF-OPEN – Test-Request an Jupiter erlaubt');
            return false;
        }
        return true;
    },

    onSuccess() {
        if (this.state !== 'closed') {
            console.log(`[nexus:circuit] CLOSED – Jupiter wieder erreichbar (war ${this.state})`);
        }
        this.state    = 'closed';
        this.failures = 0;
        this.openedAt = null;
    },

    onFailure() {
        this.failures++;
        if (this.state === 'half-open' || this.failures >= CIRCUIT_FAILURE_THRESHOLD) {
            if (this.state !== 'open') {
                console.error(`[nexus:circuit] OPEN – ${this.failures} Fehler in Folge, Jupiter gesperrt für ${CIRCUIT_COOLDOWN_MS / 1000}s`);
            }
            this.state    = 'open';
            this.openedAt = Date.now();
            this.failures = 0;
        }
    },

    getStats() {
        const remainingMs = this.state === 'open'
            ? Math.max(0, CIRCUIT_COOLDOWN_MS - (Date.now() - this.openedAt))
            : 0;
        return { state: this.state, failures: this.failures, remainingSec: Math.ceil(remainingMs / 1000) };
    },
};

// ─── RPC Cache ────────────────────────────────────────────────────────────────
const rpcCache = new RpcCache();

// Abgelaufene Einträge jede Minute bereinigen
setInterval(() => rpcCache.evict(), 60_000);

// ─── GeckoTerminal HTTP-Cache ────────────────────────────────────────────────
// TTLs konservativ erhöht um 429-Risiko auf nahe null zu bringen:
//   Pool-Stats: 15 min  – Ranking-Zyklus ist 15 min, 1 Fetch/Pool/Zyklus reicht
//   OHLCV/hour: 2 h     – 168-Bar-Historien für Range Advisor; Buckets schließen stündlich
//   OHLCV/day:  6 h     – Tages-Buckets brauchen keine Stunden-Frische
function geckoTtl(path) {
    if (/\/pools\/[^/]+\/ohlcv\/hour\b/.test(path)) return  7_200_000; // 2 h
    if (/\/pools\/[^/]+\/ohlcv\/day\b/.test(path))  return 21_600_000; // 6 h
    if (/\/pools\/[^/]+$/.test(path))               return    900_000; // 15 min
    return null;
}
const geckoCache = new HttpCache('gecko', geckoTtl);
setInterval(() => geckoCache.evict(), 60_000);

// Orca v2 Pool-Stats: 5 min (Daten ändern sich im Minuten-Takt, aber kein Free-Tier-Limit)
function orcaV2Ttl(path) {
    if (/\/pools\/[^/]+$/.test(path)) return 300_000; // 5 min
    return null;
}
const orcaV2Cache = new HttpCache('orcav2', orcaV2Ttl);
setInterval(() => orcaV2Cache.evict(), 60_000);

// Stündlicher Budget-Check: warnt wenn monatliche Hochrechnung > 800K Credits
setInterval(() => {
    const s = rpcCache.getStats();
    if (s.projectedMonthly === null) return;
    const proj = s.projectedMonthly.toLocaleString('de-DE');
    if (s.overBudget) {
        console.error(`[cache:helius] ⛔ BUDGET ÜBERSCHRITTEN – Hochrechnung: ${proj}/Mo > 1 Mio. Free Tier | Hit-Rate: ${s.hitRatePct}%`);
    } else if (s.nearBudget) {
        console.warn(`[cache:helius] ⚠️  Nahe am Budget – Hochrechnung: ${proj}/Mo (Limit: 1 Mio.) | Hit-Rate: ${s.hitRatePct}%`);
    } else {
        console.log(`[cache:helius] ✅ Budget OK – Hochrechnung: ~${proj}/Mo | Hit-Rate: ${s.hitRatePct}% | Einträge: ${s.entries}`);
    }
}, 60 * 60 * 1_000);

// ─── Transaction Queue ───────────────────────────────────────────────────────
//
// FIFO-Queue für alle Solana-Transaktionen. Bots reichen signierte Txs ein,
// die Queue sendet und bestätigt sie sequenziell über raw JSON-RPC (kein
// @solana/web3.js), damit interne Retries keine 429s verursachen.
//
// Endpunkte:
//   POST /tx/submit          { "serializedTx": "<base64>", "skipPreflight": false }
//   GET  /tx/status/:ticketId
//
const txQueue = new TxQueue(HELIUS_RPC_URL, heliusLimiter);

// ─── Recalibration Lock ───────────────────────────────────────────────────────
//
// Stellt sicher, dass immer nur ein Bot gleichzeitig rekalibriert.
// Verhindert simultane Jupiter-Bursts (Cancel + Create bei mehreren Pairs).
//
// Endpunkte:
//   POST /recal/acquire  { "pair": "SOL/USDC" }
//   POST /recal/release  { "pair": "SOL/USDC" }
//
// Auto-Expire nach RECAL_LOCK_TIMEOUT_MS falls ein Bot ohne Release abstürzt.

const RECAL_LOCK_TIMEOUT_MS = 3 * 60 * 1000;  // 3 Minuten

let recalLock = null;  // { pair: string, acquiredAt: number } | null

function fmtMs(ms) {
    const s = Math.round(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

app.post('/recal/acquire', (req, res) => {
    const { pair } = req.body ?? {};
    if (!pair) return res.status(400).json({ error: 'pair fehlt' });

    // Auto-Expire prüfen
    if (recalLock && (Date.now() - recalLock.acquiredAt) > RECAL_LOCK_TIMEOUT_MS) {
        const age = fmtMs(Date.now() - recalLock.acquiredAt);
        console.warn(`[recal-lock] EXPIRED  – pair=${recalLock.pair} | ${age} überschritten → Lock freigegeben`);
        recalLock = null;
    }

    if (recalLock) {
        const heldFor   = fmtMs(Date.now() - recalLock.acquiredAt);
        const remaining = fmtMs(RECAL_LOCK_TIMEOUT_MS - (Date.now() - recalLock.acquiredAt));
        console.warn(`[recal-lock] DENIED   – pair=${pair} | Lock gehalten von: ${recalLock.pair} seit ${heldFor} | Auto-Expire in: ${remaining}`);
        return res.json({ granted: false, lockedBy: recalLock.pair, heldForMs: Date.now() - recalLock.acquiredAt });
    }

    recalLock = { pair, acquiredAt: Date.now() };
    const expiresAt = new Date(recalLock.acquiredAt + RECAL_LOCK_TIMEOUT_MS).toLocaleTimeString('de-DE');
    console.log(`[recal-lock] ACQUIRED – pair=${pair} | Auto-Expire um: ${expiresAt}`);
    return res.json({ granted: true });
});

app.post('/recal/release', (req, res) => {
    const { pair } = req.body ?? {};

    if (!recalLock) {
        console.warn(`[recal-lock] RELEASE  – kein aktiver Lock (pair=${pair}) – ignoriert`);
        return res.json({ ok: true });
    }

    if (recalLock.pair !== pair) {
        console.warn(`[recal-lock] RELEASE  – Konflikt: pair=${pair} will freigeben, Lock gehört ${recalLock.pair} – ignoriert`);
        return res.json({ ok: false, error: 'Lock gehört einem anderen Pair' });
    }

    const heldForMs = Date.now() - recalLock.acquiredAt;
    console.log(`[recal-lock] RELEASED – pair=${pair} | gehalten für: ${fmtMs(heldForMs)}`);
    recalLock = null;
    return res.json({ ok: true, heldForMs });
});

// ─── Transaction Queue Endpoints ─────────────────────────────────────────────
//
// POST /tx/submit          – Signierte Tx einreihen → { ticketId }
// GET  /tx/status/:ticketId – Status abfragen → { status, signature?, error? }

app.post('/tx/submit', (req, res) => {
    const { serializedTx, skipPreflight } = req.body ?? {};

    if (!serializedTx || typeof serializedTx !== 'string') {
        return res.status(400).json({ error: 'serializedTx (base64 string) fehlt' });
    }

    if (!HELIUS_API_KEY) {
        return res.status(503).json({ error: 'HELIUS_API_KEY nicht konfiguriert' });
    }

    const ticketId = txQueue.submit(serializedTx, skipPreflight ?? false);
    return res.status(202).json({ ticketId });
});

app.get('/tx/status/:ticketId', (req, res) => {
    const result = txQueue.getStatus(req.params.ticketId);

    if (!result) {
        return res.status(404).json({ error: 'Ticket nicht gefunden (abgelaufen oder ungültig)' });
    }

    return res.json(result);
});

// ─── Notify Endpoint ──────────────────────────────────────────────────────────
//
// POST /notify  – Zentrale Notification-Weiterleitung
//
// Body: { botId, displayName?, level, category, message, context?, msgKey?, params? }
//   botId:       interner Bezeichner (DB, Dedup, Routing)
//   displayName: optionaler Anzeigename in Telegram-Nachrichten (z.B. "Liquidity Mining")
//   level:    'info' | 'warn' | 'error' | 'lifecycle'
//   category: z.B. 'balance_discrepancy', 'system', 'trade', 'grid'
//   context:  optionales Objekt mit Forensik-Daten (wird als JSON in DB gespeichert)
//   msgKey/params: Katalogschlüssel + Daten der Meldung (Mehrsprachigkeit Schritt 5,
//                  Core/forge-pub/i18n.md E4). Werden ZUSÄTZLICH zum
//                  gerenderten `message` gespeichert; angezeigt wird daraus erst
//                  beim Lesen neu gerendert (lib/notify-render.js). Absender ohne
//                  diese Felder (Skripte, Fremdmelder) funktionieren unverändert.
//                  Telegram nutzt bewusst den mitgelieferten Text: der Versand
//                  passiert im selben Moment wie das Erzeugen, die Sprache kann
//                  zwischen beidem nicht wechseln.
//
// Verhalten:
//   info         → nur in nexus.db speichern, kein Telegram
//   warn         → nur in nexus.db speichern, kein Telegram
//                  Ausnahme: TELEGRAM_WARN_CATEGORIES → nexus.db + Telegram 📈
//   error        → nexus.db + Telegram 🚨 (mit Dedup + Rate-Limit)
//   lifecycle    → nexus.db + Telegram immer (kein Dedup, kein Rate-Limit)
//                  Für Bot-Start/Stop-Meldungen (🟢/🔴)

// warn-Kategorien die trotzdem eine Telegram-Notification auslösen (Exit-Strategien)
const TELEGRAM_WARN_CATEGORIES = new Set([
    'score-limit', 'score-limit-done',
    'ranking-exit', 'ranking-exit-done',
    'trailing-stop', 'trailing-stop-done',
    'range-hint',
    'new-pool-alert',
]);

app.post('/notify', async (req, res) => {
    const { botId, displayName, level, category, message, context, telegramOnly, msgKey, params } = req.body ?? {};
    const i18n = msgKey ? { msgKey, params: params ?? null } : null;

    // Pflichtfelder prüfen
    if (!botId || !level || !category || !message) {
        return res.status(400).json({ error: 'botId, level, category, message sind Pflichtfelder' });
    }
    if (!['info', 'warn', 'error', 'lifecycle'].includes(level)) {
        return res.status(400).json({ error: 'level muss info, warn, error oder lifecycle sein' });
    }

    // ── lifecycle: DB + Telegram, kein Dedup/Rate-Limit ─────────────────────
    // Ausnahme: Wartungsmodus aktiv → nur DB, kein Telegram (verhindert Restart-Spam)
    if (level === 'lifecycle') {
        const maintenance = readMaintenanceFlag();
        // Erst senden, dann speichern — sonst stünde in sent_telegram wieder eine
        // Absichtserklärung statt des tatsächlichen Ergebnisses (Fix 2026-08-04).
        let sentTg = false;
        if (!maintenance) {
            sentTg = await sendTelegram(message);
            console.log(`[nexus:notify] LIFECYCLE | ${botId} | ${category} | telegram=${sentTg}`);
        } else {
            console.log(`[nexus:notify] LIFECYCLE | ${botId} | ${category} | telegram=SUPPRESSED (Wartungsmodus: ${maintenance.reason})`);
        }
        insertNotification(botId, level, category, message, context ?? null, sentTg, displayName ?? null, i18n);
        return res.json({ ok: true, sentTelegram: sentTg });
    }

    // ── Dedup prüfen ──────────────────────────────────────────────────────────
    // Dedup vor Rate-Limit: Duplikate zählen nicht gegen das Rate-Limit-Kontingent.
    const dedupResult = checkDedup(botId, level, category, (bId, lv, cat, state) => {
        const firstTime = fmtTime(state.firstTs);
        const lastTime  = fmtTime(state.lastTs);
        console.log(`[nexus:notify] DEDUP-WINDOW-CLOSED | ${bId} | ${lv} | ${cat} | ${state.count}× unterdrückt (${firstTime}–${lastTime})`);
    });

    if (dedupResult?.isDuplicate) {
        // Dedup-Zähler auf ursprünglicher DB-Zeile erhöhen (kein neuer INSERT)
        updateRepeatCount(dedupResult.state.rowId, dedupResult.state.count);
        console.log(`[nexus:notify] ${level.toUpperCase().padEnd(5)} | ${botId} | ${category} | DEDUP #${dedupResult.state.count}`);
        return res.json({ ok: true, sentTelegram: false, deduplicated: true });
    }

    // ── Rate-Limit prüfen (info/warn/error, nur für neue Occurrences) ────────
    if (!checkRateLimit(botId, level, category)) {
        console.log(`[nexus:notify] ${level.toUpperCase().padEnd(5)} | ${botId} | ${category} | RATE-LIMITED`);
        return res.json({ ok: true, sentTelegram: false, rateLimited: true });
    }

    // ── Erste Occurrence (oder info, kein Dedup): speichern + ggf. Telegram ──
    let sentTelegram = false;

    const pair = context?.pair;
    const tgHeader = displayName
        ? (pair ? `${displayName} · ${pair}:` : `${displayName}:`)
        : `\`${botId}\` → ${category}`;
    if (level === 'error') {
        sentTelegram = await sendTelegram(`🚨 ${tgHeader}\n${message}`);
    } else if (level === 'warn' && TELEGRAM_WARN_CATEGORIES.has(category)) {
        sentTelegram = await sendTelegram(`📈 ${tgHeader}\n${message}`);
    }

    // telegramOnly: Nachricht bewusst nicht in nexus.db (→ keine Dashboard-Glocke),
    // z.B. für den scan-new-pools-Hinweis (nur Telegram-Erinnerung, kein DB-Datensatz).
    if (!telegramOnly) {
        const rowId = insertNotification(botId, level, category, message, context ?? null, sentTelegram, displayName ?? null, i18n);
        if (dedupResult) {
            setDedupRowId(botId, level, category, rowId);
        }
    }

    console.log(`[nexus:notify] ${level.toUpperCase().padEnd(5)} | ${botId} | ${category} | telegram=${sentTelegram}${telegramOnly ? ' | telegramOnly' : ''}`);

    return res.json({ ok: true, sentTelegram });
});

// ─── Pyth / Hermes Preis-Oracle ──────────────────────────────────────────────
//
// GET /pyth/price?ids=sol,btc  →  Hermes API (Pyth price feeds)
//
// Gibt für jeden angeforderten Symbol den aktuellen Pyth-Preis zurück.
// Unterstützte Symbole: sol, btc
// Cache: 30s (Pyth aktualisiert ~1s, aber 30s Freshness reicht für USD-Bewertung)
//
// Hermes API: https://hermes.pyth.network/v2/updates/price/latest
// Kein API-Key nötig, öffentlicher Feed.

const PYTH_FEED_IDS = {
    sol: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    btc: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
};
const PYTH_CACHE_TTL_MS = 30_000;
const pythCache = new Map(); // symbol → { price, ts }

app.get('/pyth/price', async (req, res) => {
    const requested = String(req.query.ids ?? 'sol').split(',').map(s => s.trim().toLowerCase());
    const result = {};

    const toFetch = [];
    const now = Date.now();
    for (const sym of requested) {
        if (!PYTH_FEED_IDS[sym]) continue;
        const cached = pythCache.get(sym);
        if (cached && now - cached.ts < PYTH_CACHE_TTL_MS) {
            result[sym] = cached.price;
        } else {
            toFetch.push(sym);
        }
    }

    if (toFetch.length > 0) {
        try {
            const idsParam = toFetch.map(s => `ids[]=${PYTH_FEED_IDS[s]}`).join('&');
            const url = `https://hermes.pyth.network/v2/updates/price/latest?${idsParam}`;
            console.log(`[nexus:pyth] GET ${url}`);
            const upstream = await fetchWithRetry(url, {
                headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(8_000),
            }, 'pyth/price');
            if (!upstream.ok) throw new Error(`Hermes HTTP ${upstream.status}`);
            const json = await upstream.json();
            for (const entry of (json.parsed ?? [])) {
                const sym = Object.keys(PYTH_FEED_IDS).find(k => PYTH_FEED_IDS[k] === entry.id);
                if (!sym) continue;
                const p = entry.price;
                const price = parseFloat(p.price) * Math.pow(10, p.expo);
                pythCache.set(sym, { price, ts: now });
                result[sym] = price;
                console.log(`[nexus:pyth] ${sym.toUpperCase()}/USD = ${price.toFixed(4)} (conf ±${(parseFloat(p.conf) * Math.pow(10, p.expo)).toFixed(4)})`);
            }
        } catch (err) {
            console.error(`[nexus:pyth] Fehler: ${err.message}`);
            // Stale Cache als Fallback
            for (const sym of toFetch) {
                const cached = pythCache.get(sym);
                if (cached) result[sym] = cached.price;
            }
            if (Object.keys(result).length === 0) {
                return res.status(502).json({ error: 'Pyth nicht erreichbar', message: err.message });
            }
        }
    }

    res.json(result);
});

// ─── Notifications: Gelesen-Status ────────────────────────────────────────────
// Schreibzugriff auf nexus.db bleibt exklusiv beim Nexus-Prozess (Konvention),
// forge-settings (Message Center) ruft diesen Endpoint statt selbst zu schreiben.

app.post('/notifications/mark-read', (req, res) => {
    const { ids } = req.body ?? {};
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'number')) {
        return res.status(400).json({ error: 'ids muss ein Array von Zahlen sein' });
    }
    markNotificationsRead(ids);
    res.json({ ok: true, count: ids.length });
});

// Benachrichtigungs-Toggles (System/Support/Premium, Message-Center-Einstellungen) –
// vorher pro Gerät in localStorage, lief deshalb zwischen mehreren Rechnern auseinander.
app.get('/notifications/settings', (_req, res) => {
    res.json(getNotifySettings());
});

app.post('/notifications/settings', (req, res) => {
    const { type, enabled } = req.body ?? {};
    if (!['system', 'support', 'premium'].includes(type) || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'type muss system/support/premium sein, enabled ein Boolean' });
    }
    setNotifySetting(type, enabled);
    res.json({ ok: true });
});

// ─── Health Endpoint ──────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
    const lockAge    = recalLock ? Date.now() - recalLock.acquiredAt : null;
    const cacheStats = rpcCache.getStats();
    res.json({
        status:  'ok',
        uptime:  Math.floor(process.uptime()),
        keys: {
            jupiter: JUPITER_API_KEY ? 'configured' : 'missing',
            helius:  HELIUS_API_KEY  ? 'configured' : 'missing',
        },
        limits: {
            jupiterBurst:  jupiterBurstLimiter.getStats(),
            jupiterMinute: jupiterMinuteLimiter.getStats(),
            triggerQuery: triggerQueryLimiter.getStats(),
            kamino:       kaminoLimiter.getStats(),
            loopscale:    loopscaleLimiter.getStats(),
            helius:       heliusLimiter.getStats(),
            gecko:        geckoLimiter.getStats(),
            orcav2:       orcaV2Limiter.getStats(),
            blobFetch:    blobFetchLimiter.getStats(),
        },
        jupiterCircuit: jupiterCircuit.getStats(),
        recalLock: recalLock
            ? { held: true, pair: recalLock.pair, heldForMs: lockAge, heldFor: fmtMs(lockAge) }
            : { held: false },
        txQueue:   txQueue.getStats(),
        rpcCache: {
            hitRatePct:        cacheStats.hitRatePct,
            entries:           cacheStats.entries,
            projectedMonthly:  cacheStats.projectedMonthly,
            nearBudget:        cacheStats.nearBudget,
            overBudget:        cacheStats.overBudget,
        },
        geckoCache:  geckoCache.getStats(),
        orcaV2Cache: orcaV2Cache.getStats(),
    });
});

// ─── Cache Stats Endpoint ─────────────────────────────────────────────────────
//
// GET /cache-stats → vollständige Cache-Statistiken inkl. Hochrechnung

app.get('/cache-stats', (_req, res) => {
    const s = rpcCache.getStats();
    res.json({
        ...s,
        summary: s.projectedMonthly === null
            ? 'Hochrechnung noch nicht verfügbar (< 60 s Uptime)'
            : s.overBudget
                ? `⛔ BUDGET ÜBERSCHRITTEN: ~${s.projectedMonthly.toLocaleString('de-DE')}/Mo > 1 Mio. Free Tier`
                : s.nearBudget
                    ? `⚠️  Nahe am Budget: ~${s.projectedMonthly.toLocaleString('de-DE')}/Mo (Limit: 1 Mio.)`
                    : `✅ Budget OK: ~${s.projectedMonthly.toLocaleString('de-DE')}/Mo (Limit: 1 Mio.)`,
    });
});

// ─── Test-Endpoint (manueller Alert-Test) ────────────────────────────────────

app.post('/test-alert', async (_req, res) => {
    await sendThrottleAlert('jupiter', 1234, 55, 55, 60);
    res.json({ sent: true });
});

// ─── Jupiter Proxy ────────────────────────────────────────────────────────────
//
// /jup/<path>  →  https://api.jup.ag/<path>
//
// Beispiele:
//   GET  /jup/swap/v1/quote?inputMint=...  →  https://api.jup.ag/swap/v1/quote?...
//   POST /jup/swap/v1/swap                 →  https://api.jup.ag/swap/v1/swap
//   POST /jup/trigger/v1/createOrder       →  https://api.jup.ag/trigger/v1/createOrder
//   GET  /jup/trigger/v1/getTriggerOrders  →  https://api.jup.ag/trigger/v1/getTriggerOrders
//   GET  /jup/earn/tokens                  →  https://api.jup.ag/earn/tokens

/**
 * Gemeinsame Proxy-Logik für alle Jupiter-Calls.
 *
 * @param {object}      req
 * @param {object}      res
 * @param {RateLimiter} limiter          – primärer Limiter (Burst oder triggerQueryLimiter)
 * @param {number|null} queueTimeoutMs   – null = unbegrenzt warten (Polling OK),
 *                                         >0   = 503 nach X ms (transaktionale Calls)
 * @param {RateLimiter|null} minuteLimiter – optionaler zweiter Limiter (Gesamt-Budget)
 */
async function proxyToJupiter(req, res, limiter, queueTimeoutMs = null, minuteLimiter = null) {
    try {
        // Circuit Breaker: bei offenem Circuit sofort 503 zurück (kein Jupiter-Call)
        if (jupiterCircuit.isOpen()) {
            const { remainingSec } = jupiterCircuit.getStats();
            console.warn(`[nexus:circuit] BLOCKED – Jupiter gesperrt, noch ${remainingSec}s`);
            return res.status(503).json({ error: 'Jupiter Circuit Breaker offen', retryAfterSec: remainingSec });
        }

        // Stufe 1: Burst-Limiter (oder triggerQueryLimiter)
        const waitedMs = queueTimeoutMs
            ? await limiterWaitWithTimeout(limiter, queueTimeoutMs)
            : await limiter.wait();

        if (waitedMs > 0) {
            const stats = limiter.getStats();
            await sendThrottleAlert(limiter.name, waitedMs, stats.requestsInWindow, stats.maxInWindow, stats.windowSec);
        }

        // Stufe 2: Minuten-Budget (nur für transaktionale Calls)
        if (minuteLimiter) {
            const waitedMs2 = await minuteLimiter.wait();
            if (waitedMs2 > 0) {
                const stats = minuteLimiter.getStats();
                await sendThrottleAlert(minuteLimiter.name, waitedMs2, stats.requestsInWindow, stats.maxInWindow, stats.windowSec);
            }
        }

        // /jup/swap/v1/quote  →  /swap/v1/quote
        const upstreamPath = req.path.slice('/jup'.length);

        const qs  = new URLSearchParams(req.query).toString();
        const url = `https://api.jup.ag${upstreamPath}${qs ? '?' + qs : ''}`;

        // Outgoing Headers: API Key kommt zentral vom Proxy, nicht von den Bots
        const headers = { 'accept': 'application/json' };
        if (JUPITER_API_KEY) headers['x-api-key'] = JUPITER_API_KEY;

        const fetchOpts = { method: req.method, headers };

        if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
            fetchOpts.body          = JSON.stringify(req.body);
            headers['content-type'] = 'application/json';
        }

        console.log(`[nexus:jupiter] ${req.method} ${url}`);

        const upstream = await fetchWithRetry(url, fetchOpts, `${req.method} ${upstreamPath}`);
        const text     = await upstream.text();

        // Circuit Breaker: Ergebnis auswerten (nach allen internen Retries)
        if (upstream.status >= 500 || upstream.status === 429) {
            jupiterCircuit.onFailure();
        } else {
            jupiterCircuit.onSuccess();
        }

        if (upstream.status >= 400) {
            console.warn(`[nexus:jupiter] ← ${upstream.status} | ${req.method} ${upstreamPath} | Body: ${text.slice(0, 200)}`);
        }

        res
            .status(upstream.status)
            .header('content-type', upstream.headers.get('content-type') ?? 'application/json')
            .send(text);

    } catch (err) {
        // Queue-Timeout: sofort 503 zurück – Bot soll Tick überspringen, nicht eskalieren
        if (err.message.startsWith('Queue-Timeout')) {
            console.warn(`[nexus:jupiter] ${err.message}`);
            return res.status(503).json({ error: 'Queue-Timeout', message: err.message, retryNextTick: true });
        }
        jupiterCircuit.onFailure();
        console.error('[nexus:jupiter] Fehler:', err.message);
        res.status(502).json({ error: 'Proxy-Fehler', message: err.message });
    }
}

// ─── Jupiter: Polling – GET /jup/trigger/v1/getTriggerOrders ─────────────────
//
// Eigener triggerQueryLimiter (15 req/min) – isoliert vom transaktionalen Budget.
// Kein Queue-Timeout: Polling darf in der Queue warten (kein Zeitdruck).
// Muss VOR app.all('/jup/*') registriert sein (Express matched in Reihenfolge).

app.get('/jup/trigger/v1/getTriggerOrders', (req, res) =>
    proxyToJupiter(req, res, triggerQueryLimiter, null));

// ─── Jupiter: Transaktionale Calls – alle anderen /jup/*-Routen ──────────────
//
// Transaktionale Calls: Burst-Limiter (5/s) + Minuten-Limiter (55/min) in Serie.
// Queue-Timeout: 503 nach TXNAL_QUEUE_TIMEOUT_MS (Bot überspringt Tick statt hängen).

app.all('/jup/*', (req, res) =>
    proxyToJupiter(req, res, jupiterBurstLimiter, TXNAL_QUEUE_TIMEOUT_MS, jupiterMinuteLimiter));

// ─── Kamino Proxy ─────────────────────────────────────────────────────────────
//
// /kamino/<path>  →  https://api.kamino.finance/<path>
//
// Beispiele:
//   GET  /kamino/kamino-market/<market>/reserves/metrics  →  APY + TVL
//   GET  /kamino/kamino-market/<market>/users/<wallet>/obligations  →  Position
//   POST /kamino/ktx/klend/deposit  →  Deposit-TX bauen
//   POST /kamino/ktx/klend/withdraw →  Withdraw-TX bauen

app.all('/kamino/*', async (req, res) => {
    try {
        const waitedMs = await kaminoLimiter.wait();
        if (waitedMs > 0) {
            const stats = kaminoLimiter.getStats();
            await sendThrottleAlert('kamino', waitedMs, stats.requestsInWindow, stats.maxInWindow, stats.windowSec);
        }

        const upstreamPath = req.path.slice('/kamino'.length);
        const qs  = new URLSearchParams(req.query).toString();
        const url = `https://api.kamino.finance${upstreamPath}${qs ? '?' + qs : ''}`;

        const headers    = { 'accept': 'application/json' };
        const fetchOpts  = { method: req.method, headers };

        if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
            fetchOpts.body          = JSON.stringify(req.body);
            headers['content-type'] = 'application/json';
        }

        console.log(`[nexus:kamino] ${req.method} ${url}`);

        const upstream = await fetchWithRetry(url, fetchOpts, `${req.method} ${upstreamPath}`);
        const text     = await upstream.text();

        if (upstream.status >= 400) {
            console.warn(`[nexus:kamino] ← ${upstream.status} | ${req.method} ${upstreamPath} | Body: ${text.slice(0, 200)}`);
        }

        res
            .status(upstream.status)
            .header('content-type', upstream.headers.get('content-type') ?? 'application/json')
            .send(text);

    } catch (err) {
        console.error('[nexus:kamino] Fehler:', err.message);
        res.status(502).json({ error: 'Proxy-Fehler', message: err.message });
    }
});

// ─── Loopscale Proxy ──────────────────────────────────────────────────────────
//
// /loopscale/<path>  →  https://tars.loopscale.com/v1/<path>
//
// Beispiele:
//   POST /loopscale/markets/lending_vaults/info     →  APY + TVL (paginiert)
//   POST /loopscale/markets/lending_vaults/deposits →  Position
//   POST /loopscale/markets/lending_vaults/deposit  →  Deposit-TX bauen
//   POST /loopscale/markets/lending_vaults/withdraw →  Withdraw-TX bauen

app.all('/loopscale/*', async (req, res) => {
    try {
        const waitedMs = await loopscaleLimiter.wait();
        if (waitedMs > 0) {
            const stats = loopscaleLimiter.getStats();
            await sendThrottleAlert('loopscale', waitedMs, stats.requestsInWindow, stats.maxInWindow, stats.windowSec);
        }

        const upstreamPath = req.path.slice('/loopscale'.length);
        const qs  = new URLSearchParams(req.query).toString();
        const url = `https://tars.loopscale.com/v1${upstreamPath}${qs ? '?' + qs : ''}`;

        const headers    = { 'accept': 'application/json' };
        const fetchOpts  = { method: req.method, headers };

        if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body) {
            fetchOpts.body          = JSON.stringify(req.body);
            headers['content-type'] = 'application/json';
        }

        // Loopscale benötigt 'user-wallet' Header für positions/deposit/withdraw
        if (req.headers['user-wallet']) {
            headers['user-wallet'] = req.headers['user-wallet'];
        }

        console.log(`[nexus:loopscale] ${req.method} ${url}`);

        const upstream = await fetchWithRetry(url, fetchOpts, `${req.method} ${upstreamPath}`);
        const text     = await upstream.text();

        if (upstream.status >= 400) {
            console.warn(`[nexus:loopscale] ← ${upstream.status} | ${req.method} ${upstreamPath} | Body: ${text.slice(0, 200)}`);
        }

        res
            .status(upstream.status)
            .header('content-type', upstream.headers.get('content-type') ?? 'application/json')
            .send(text);

    } catch (err) {
        console.error('[nexus:loopscale] Fehler:', err.message);
        res.status(502).json({ error: 'Proxy-Fehler', message: err.message });
    }
});

// ─── Blob-Fetch Proxy (FORGE.pub Premium-Auslieferung) ───────────────────────
//
// GET /blob-fetch?url=<encoded-url>  →  https-GET auf die übergebene URL
//
// Host-agnostisch (Presigned-URL des Objektspeichers oder Backup-Host, siehe
// lib/blob-download.js) – Nexus kennt hier bewusst KEIN Filebase-Wissen, nur
// "eine URL, die gerade angefragt wird". Zweck ist ausschließlich das zentrale
// Rate-Limiting (blobFetchLimiter), nicht Caching oder Auth. Antwort wird binär
// durchgereicht (Blob-Inhalt ist verschlüsselt, kein Text/JSON).
//
// 404 wird NICHT über fetchWithRetry erneut versucht – der Aufrufer
// (lib/blob-download.js) hat dafür bereits eine eigene, host-spezifische
// Retry-Logik (Ablage-Host übernimmt neue Dateien nur per Minuten-Cron).

app.get('/blob-fetch', async (req, res) => {
    const target = req.query.url;
    if (typeof target !== 'string' || !target.startsWith('https://')) {
        return res.status(400).json({ error: 'blob-fetch: query-Parameter "url" fehlt oder ist keine https-URL' });
    }

    try {
        const waitedMs = await blobFetchLimiter.wait();
        if (waitedMs > 0) {
            const stats = blobFetchLimiter.getStats();
            await sendThrottleAlert('blob-fetch', waitedMs, stats.requestsInWindow, stats.maxInWindow, stats.windowSec);
        }

        console.log(`[nexus:blob-fetch] GET ${target}`);
        const upstream = await fetch(target, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
        const buffer = Buffer.from(await upstream.arrayBuffer());

        if (upstream.status >= 400) {
            console.warn(`[nexus:blob-fetch] ← ${upstream.status} | ${target}`);
        }

        res
            .status(upstream.status)
            .header('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream')
            .send(buffer);

    } catch (err) {
        console.error('[nexus:blob-fetch] Fehler:', err.message);
        res.status(502).json({ error: 'Proxy-Fehler', message: err.message });
    }
});

// ─── GeckoTerminal Proxy ──────────────────────────────────────────────────────
//
// /gecko/<path>  →  https://api.geckoterminal.com/api/v2/<path>
//
// Beispiele:
//   GET /gecko/networks/solana/pools/<addr>/ohlcv/hour?limit=168
//   GET /gecko/networks/solana/pools/<addr>/ohlcv/day?limit=30

app.all('/gecko/*', async (req, res) => {
    try {
        const upstreamPath = req.path.slice('/gecko'.length);

        // ── Cache-Lookup (nur GET, nur gecachte Pfade) ───────────────────────
        const cached = geckoCache.get(req.method, upstreamPath, req.query);
        if (cached) {
            res
                .status(cached.status)
                .header('content-type', cached.contentType)
                .header('x-cache', 'HIT')
                .send(cached.body);
            return;
        }

        // ── Cache-Miss → Throttle + Upstream ─────────────────────────────────
        const waitedMs = await geckoLimiter.wait();
        if (waitedMs > 0) {
            const stats = geckoLimiter.getStats();
            await sendThrottleAlert('gecko', waitedMs, stats.requestsInWindow, stats.maxInWindow, stats.windowSec);
        }

        const qs  = new URLSearchParams(req.query).toString();
        const url = `https://api.geckoterminal.com/api/v2${upstreamPath}${qs ? '?' + qs : ''}`;

        const headers   = { 'accept': 'application/json' };
        const fetchOpts = { method: req.method, headers, signal: AbortSignal.timeout(25_000) };

        console.log(`[nexus:gecko] ${req.method} ${url}`);

        const upstream    = await fetch(url, fetchOpts);
        const text        = await upstream.text();
        const contentType = upstream.headers.get('content-type') ?? 'application/json';

        if (upstream.status >= 400) {
            console.warn(`[nexus:gecko] ← ${upstream.status} | ${upstreamPath} | Body: ${text.slice(0, 200)}`);

            // Stale-While-Error: bei 429/5xx letzten erfolgreichen Cache-Eintrag servieren
            // (auch wenn TTL abgelaufen). Verhindert dass jeder Bot-Loop bei dauerhaftem
            // Gecko-Limit erneut 429 ans Backend durchreicht.
            if (upstream.status === 429 || upstream.status >= 500) {
                const stale = geckoCache.getStale(req.method, upstreamPath, req.query);
                if (stale) {
                    const ageSec = Math.floor(stale.ageMs / 1000);
                    console.log(`[nexus:gecko] STALE serviert (${ageSec}s alt) für ${upstreamPath}`);
                    res
                        .status(stale.status)
                        .header('content-type', stale.contentType)
                        .header('x-cache', 'STALE')
                        .header('x-cache-age', String(ageSec))
                        .send(stale.body);
                    return;
                }
            }
        } else {
            geckoCache.set(req.method, upstreamPath, req.query, upstream.status, text, contentType);
        }

        res
            .status(upstream.status)
            .header('content-type', contentType)
            .header('x-cache', 'MISS')
            .send(text);

    } catch (err) {
        console.error('[nexus:gecko] Fehler:', err.message);
        res.status(502).json({ error: 'Proxy-Fehler', message: err.message });
    }
});

// ─── Orca v2 REST API Proxy ───────────────────────────────────────────────────
//
// /orcav2/<path>  →  https://api.orca.so/v2/<path>
//
// Beispiel:
//   GET /orcav2/solana/pools/<addr>
//   → liefert tvlUsdc, stats.24h.volume, stats.24h.yieldOverTvl, price etc.

app.all('/orcav2/*', async (req, res) => {
    try {
        const upstreamPath = req.path.slice('/orcav2'.length);

        const cached = orcaV2Cache.get(req.method, upstreamPath, req.query);
        if (cached) {
            res
                .status(cached.status)
                .header('content-type', cached.contentType)
                .header('x-cache', 'HIT')
                .send(cached.body);
            return;
        }

        await orcaV2Limiter.wait();

        const qs  = new URLSearchParams(req.query).toString();
        const url = `https://api.orca.so/v2${upstreamPath}${qs ? '?' + qs : ''}`;

        const headers   = { 'accept': 'application/json' };
        const fetchOpts = { method: req.method, headers, signal: AbortSignal.timeout(25_000) };

        console.log(`[nexus:orcav2] ${req.method} ${url}`);

        const upstream    = await fetch(url, fetchOpts);
        const text        = await upstream.text();
        const contentType = upstream.headers.get('content-type') ?? 'application/json';

        if (upstream.status >= 400) {
            console.warn(`[nexus:orcav2] ← ${upstream.status} | ${upstreamPath}`);
        } else {
            orcaV2Cache.set(req.method, upstreamPath, req.query, upstream.status, text, contentType);
        }

        res
            .status(upstream.status)
            .header('content-type', contentType)
            .header('x-cache', 'MISS')
            .send(text);

    } catch (err) {
        console.error('[nexus:orcav2] Fehler:', err.message);
        res.status(502).json({ error: 'Proxy-Fehler', message: err.message });
    }
});

// ─── Helius RPC Proxy ─────────────────────────────────────────────────────────
//
// POST /rpc        →  mit Cache (TTL per Methode: 30 s Balance, 5 s AccountInfo)
// POST /rpc/fresh  →  immer Upstream, kein Cache (für Post-Swap-Verifizierungen)
//
// Bots setzen ihren RPC_URL / RPC_ENDPOINT auf http://127.0.0.1:3100/rpc.
// Für balance-kritische Calls nach Swaps: http://127.0.0.1:3100/rpc/fresh
//
// Hinweis: Nur HTTP-JSON-RPC wird proxied. WebSocket-Subscriptions (onAccountChange etc.)
// gehen weiterhin direkt zu Helius – diese zählen nicht gegen das HTTP-Limit.

/**
 * Gemeinsamer Handler für /rpc und /rpc/fresh.
 * @param {boolean} useCache  true = Cache-Lookup + Cache-Write, false = immer Upstream
 */
async function handleRpc(req, res, useCache) {
    if (!HELIUS_API_KEY) {
        return res.status(503).json({ error: 'HELIUS_API_KEY nicht konfiguriert' });
    }

    const waitedMs = await heliusLimiter.wait();
    if (waitedMs > 0) {
        const stats = heliusLimiter.getStats();
        await sendThrottleAlert('helius', waitedMs, stats.requestsInWindow, stats.maxInWindow, stats.windowSec);
    }

    const body    = req.body;
    const isBatch = Array.isArray(body);
    const method  = isBatch ? null : body?.method;
    const params  = isBatch ? null : body?.params;

    // ── Cache-Lookup (nur Single-Requests) ───────────────────────────────────
    if (useCache && method) {
        const cached = rpcCache.get(method, params);
        if (cached !== null) {
            console.log(`[nexus:helius] CACHE HIT  ${method}`);
            rpcRecord(method, 'hit');
            return res
                .header('content-type', 'application/json')
                .header('X-Forge-Cache', 'HIT')
                .send(cached);
        }
    }

    // ── Upstream-Call ─────────────────────────────────────────────────────────
    rpcCache.recordUpstream();
    const label = isBatch ? `batch(${body.length})` : (method ?? '?');
    console.log(`[nexus:helius] UPSTREAM   ${label}${useCache ? '' : ' [fresh]'}`);
    if (isBatch)        rpcRecord('batch',  'batch');
    else if (!useCache) rpcRecord(method,   'fresh');
    else                rpcRecord(method,   'miss');

    const upstream = await fetchWithRetry(
        HELIUS_RPC_URL,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        label,
    );

    const text = await upstream.text();

    if (upstream.status >= 400) {
        console.warn(`[nexus:helius] ← ${upstream.status} | ${label} | Body: ${text.slice(0, 200)}`);
        if (upstream.status === 429) {
            heliusLimiter.penalize(2_000);
            console.warn('[nexus:helius] 429 upstream – Backoff 2 s aktiviert (nach Retries erschöpft)');
        }
    }

    // ── Cache-Write (nur erfolgreiche, fehlerfreie Antworten) ────────────────
    if (useCache && method && upstream.status === 200) {
        try {
            const parsed = JSON.parse(text);
            if (parsed.result !== undefined && parsed.error === undefined) {
                rpcCache.set(method, params, text);
            }
        } catch { /* kein gültiges JSON – nicht cachen */ }
    }

    return res
        .status(upstream.status)
        .header('content-type', upstream.headers.get('content-type') ?? 'application/json')
        .header('X-Forge-Cache', 'MISS')
        .send(text);
}

app.post('/rpc',       async (req, res) => {
    try { await handleRpc(req, res, true);  }
    catch (err) { console.error('[nexus:helius] Fehler:', err.message); res.status(502).json({ error: 'Proxy-Fehler', message: err.message }); }
});

app.post('/rpc/fresh', async (req, res) => {
    try { await handleRpc(req, res, false); }
    catch (err) { console.error('[nexus:helius] Fehler:', err.message); res.status(502).json({ error: 'Proxy-Fehler', message: err.message }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, HOST, async () => {
    const started = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const jupKey  = JUPITER_API_KEY ? '✅' : '⚠️  kein Key';
    const helKey  = HELIUS_API_KEY  ? '✅' : '⚠️  kein Key';
    const tgKey   = (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) ? '✅' : '⚠️  nicht konfiguriert';
    console.log(`[FORGE Nexus] ✅ Bereit – http://${HOST}:${PORT}  (${started})`);
    console.log(`[FORGE Nexus] Jupiter:        5 req/s + 55 req/min | Key: ${jupKey}`);
    console.log(`[FORGE Nexus] Kamino:        40 req/min  | Loopscale: 40 req/min`);
    console.log(`[FORGE Nexus] GeckoTerminal:  3 req/min  | kein Key erforderlich`);
    console.log(`[FORGE Nexus] Helius:         8 req/s    | Key: ${helKey}  → ${HELIUS_RPC_URL.split('?')[0]}`);
    console.log(`[FORGE Nexus] Telegram:       ${tgKey}`);
    await sendTelegram('🟢 forge-nexus → running');
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal) {
    console.log(`[FORGE Nexus] ${signal} empfangen – fahre herunter…`);
    await sendTelegram('🔴 forge-nexus → stopped');
    server.close(() => process.exit(0));
    // Fallback: nach 5s hart beenden falls server.close hängt
    setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
