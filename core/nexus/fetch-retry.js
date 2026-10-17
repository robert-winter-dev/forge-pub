/**
 * fetchWithRetry – Retry für 429 / 5xx / Timeout (CORE#001333, ausgelagert aus server.js).
 *
 * Zentraler Fetch-Wrapper für alle Upstream-Calls in Nexus.
 * Fängt transiente Fehler ab, bevor sie an die Bots weitergegeben werden.
 *
 * Verhalten:
 *   429          → Retry mit Backoff (Retry-After-Header oder 1s/2s/4s)
 *   5xx          → Retry mit Backoff (1s/2s/4s)
 *   Timeout/Netz → Retry mit Backoff
 *   Nach maxRetries: letzten Status/Fehler durchreichen (Bot entscheidet selbst)
 *
 * Endet die Kette mit 429, steht genau eine Zeile "[nexus:retry] Retry erschöpft 429 …" im
 * Journal. Der Text "Retry erschöpft" ist ein fester Marker: Die Skopos-Wochenauswertung
 * (Talos, Stufe 12, SYS#001332) sucht ihn per Textmuster. Nicht umformulieren.
 */

import { recordUpstream429 } from './api-stats.js';

export const UPSTREAM_TIMEOUT_MS = 15_000; // 15s Timeout pro Einzelversuch

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {object} [options]            fetch-Optionen
 * @param {string} [label]              Text für Logzeilen ("POST /v1/…")
 * @param {number} [maxRetries=3]       Wiederholungen nach dem ersten Versuch
 * @param {string|null} [api]           Name für recordUpstream429 (null = nicht zählen)
 * @param {object} [deps]               Nur für Tests: { fetchImpl, sleep, warn, record }
 */
export async function fetchWithRetry(url, options = {}, label = '', maxRetries = 3, api = null, deps = {}) {
    const fetchImpl = deps.fetchImpl ?? fetch;
    const sleep     = deps.sleep     ?? defaultSleep;
    const warn      = deps.warn      ?? ((m) => console.warn(m));
    const record    = deps.record    ?? recordUpstream429;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const res = await fetchImpl(url, {
                ...options,
                signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            });

            if (res.status === 429) {
                if (api) record(api);   // CORE#001287: jeder 429-Versuch zählt
                if (attempt === maxRetries) {
                    // CORE#001333: Ende der Kette sichtbar machen (nach maxRetries durchreichen).
                    warn(`[nexus:retry] Retry erschöpft 429 ${label} – ${maxRetries + 1} Versuche ohne Erfolg`);
                    return res;
                }
                const retryAfter = parseInt(res.headers.get('Retry-After') ?? '0', 10);
                const waitMs = retryAfter > 0 ? retryAfter * 1_000 : (2 ** attempt) * 1_000;
                warn(`[nexus:retry] 429 ${label} – warte ${waitMs}ms (Versuch ${attempt + 1}/${maxRetries})`);
                await sleep(waitMs);
                continue;
            }

            if (res.status >= 500 && attempt < maxRetries) {
                const waitMs = (2 ** attempt) * 1_000;
                warn(`[nexus:retry] ${res.status} ${label} – warte ${waitMs}ms (Versuch ${attempt + 1}/${maxRetries})`);
                await sleep(waitMs);
                continue;
            }

            return res;

        } catch (err) {
            const isTransient = err.name === 'TimeoutError' || err.name === 'AbortError'
                             || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT'
                             || err.code === 'ECONNREFUSED';
            if (isTransient && attempt < maxRetries) {
                const waitMs = (2 ** attempt) * 1_000;
                warn(`[nexus:retry] ${err.name ?? err.code} ${label} – warte ${waitMs}ms (Versuch ${attempt + 1}/${maxRetries})`);
                await sleep(waitMs);
                continue;
            }
            throw err;
        }
    }
}
