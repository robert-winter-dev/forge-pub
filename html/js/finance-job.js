/**
 * Finanzaktionen der Settings-Oberfläche (Einzahlung, Entnahme, Burn) — CORE#000993.
 *
 * Der Server führt sie als losgelösten Job aus (bots/settings/lib/finance-jobs.js). Das
 * hier kapselt die zwei Fälle, in denen die erste Antwort noch kein Ergebnis ist:
 *   - HTTP 202 `{ pending, jobId }`: Die Aktion läuft länger als die Wartezeit der Route
 *     → /api/jobs/:id abfragen, bis sie fertig ist.
 *   - Verbindung bricht ab (Neustart von forge-settings): Die Aktion läuft auf dem Server
 *     weiter → über Schlüssel + mitgeschickte clientRef wiederfinden und abfragen.
 *
 * Rückgabe ist immer das JSON, das die Route früher direkt geliefert hätte.
 */

import { t as tr } from './i18n.js?v=20260811a';

const POLL_MS      = 3_000;
const GIVE_UP_MS   = 15 * 60_000;   // länger läuft keine Finanzaktion; danach „nicht abfragbar“
const NOT_FOUND_MS = 60_000;        // Server antwortet, kennt die clientRef aber nicht

const sleep = ms => new Promise(r => setTimeout(r, ms));

function newClientRef() {
    try { return crypto.randomUUID(); } catch { /* ältere Browser ohne crypto.randomUUID */ }
    return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

async function pollJob(query, onStatus) {
    const started = Date.now();
    let notFoundSince = null;
    while (Date.now() - started < GIVE_UP_MS) {
        await sleep(POLL_MS);
        try {
            const r = await fetch(query, { cache: 'no-store' });
            if (r.status === 404) {
                notFoundSince ??= Date.now();
            } else if (r.ok) {
                const { job } = await r.json();
                if (job?.status === 'done') return { ...job.result, jobId: job.id };
                if (job) { notFoundSince = null; onStatus('running'); }
                else     { notFoundSince ??= Date.now(); }
            }
            if (notFoundSince && Date.now() - notFoundSince > NOT_FOUND_MS) break;
        } catch {
            onStatus('reconnecting');   // Server gerade nicht erreichbar (Neustart) – weiter versuchen
        }
    }
    return { ok: false, error: tr('sjob.lost', 'Das Ergebnis konnte nicht abgefragt werden. Prüfe Wallet und Position, bevor du die Aktion wiederholst.') };
}

/**
 * @param {string} url     POST-Route der Aktion
 * @param {object} body    Request-Body (clientRef wird ergänzt)
 * @param {object} opts
 * @param {string} opts.key         Job-Schlüssel wie serverseitig: `liq:<poolId>`, `lending`, `burn:<flavor>`
 * @param {(state: 'running'|'reconnecting', text: string) => void} [opts.onStatus]
 * @returns {Promise<object>} Ergebnis-JSON der Aktion
 */
export async function runFinanceAction(url, body, { key, onStatus = () => {} } = {}) {
    const clientRef = newClientRef();
    const status = state => onStatus(state, state === 'reconnecting'
        ? tr('sjob.reconnecting', 'Verbindung unterbrochen – die Aktion läuft auf dem Server weiter, Ergebnis wird abgefragt…')
        : tr('sjob.still_running', 'Läuft noch – das Ergebnis erscheint automatisch, sobald die Aktion fertig ist…'));

    let data;
    try {
        const r = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, clientRef }),
        });
        data = await r.json();
    } catch {
        // Antwort verloren — die Aktion kann trotzdem laufen oder schon fertig sein.
        status('reconnecting');
        return pollJob(`/api/jobs?key=${encodeURIComponent(key)}&ref=${encodeURIComponent(clientRef)}`, status);
    }
    if (data?.pending && data.jobId && !data.busy) {
        status('running');
        return pollJob(`/api/jobs/${encodeURIComponent(data.jobId)}`, status);
    }
    return data;
}
