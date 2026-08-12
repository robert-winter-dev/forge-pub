// ══════════════════════════════════════════════════════════════════════════════
// FORGE public Premium – Blob-Download (host-agnostisch)
// ══════════════════════════════════════════════════════════════════════════════
// Gegenstück zum Upload-Teil in lib/blob-storage.js (dort MASTER-ONLY, mit den
// aktuellen Host-Details). Diese Datei enthält bewusst NUR den reinen HTTPS-GET —
// kein Wissen über den aktuellen Host, keine Konfiguration, keine Host-Details.
// Läuft unverändert im FORGE-public-Fork (Ingest-Seite) UND nach einem künftigen
// Host-Wechsel (Storj/Blossom): die URL kommt immer per Pointer+Key-Modell zur
// Laufzeit, nie hartcodiert.
// ══════════════════════════════════════════════════════════════════════════════

// Reale Ursache (gefunden 2026-07-28 im echten Cross-Machine-Test): der aktuelle
// Ablage-Host übernimmt neue Dateien nur per Minuten-Cron (siehe lib/blob-storage.js),
// die Zustellungs-DM feuert aber sofort nach dem Hochladen – ein Kunde kann also 1-2
// Min lang ein 404 auf eine eigentlich gültige, ganz frische Blob-URL bekommen. Retry
// statt Delay vor dem Senden, weil das Problem host-spezifisch ist und diese Datei
// bewusst host-agnostisch bleiben soll — ein künftiger Host hätte diese Latenz
// möglicherweise gar nicht.
const DEFAULT_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 20_000;

// Läuft standardmäßig über Nexus (core/nexus/server.js /blob-fetch), damit alle
// Downloads einem zentralen Rate-Limiter unterliegen — siehe CLAUDE.md „Alle API-
// Calls laufen über Nexus-Proxy, kein direkter Außenkontakt" sowie den Vorfall
// 2026-08-03 (forge-pub1): ein Backlog-Replay hat Dutzende ungebremste Downloads
// gegen Filebase ausgelöst. Überschreibbar per NEXUS_URL (Tests, isolierte Läufe);
// leer/nicht erreichbar → Fallback auf direkten Fetch, damit ein down-Nexus die
// Zustellung nicht komplett blockiert.
const NEXUS_URL = (process.env.NEXUS_URL?.trim() || 'http://127.0.0.1:3100').replace(/\/+$/, '');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchViaNexus(url, timeoutMs) {
    const proxied = `${NEXUS_URL}/blob-fetch?url=${encodeURIComponent(url)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(proxied, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function fetchDirect(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Lädt einen Blob per HTTPS-GET herunter. Host-agnostisch — funktioniert gegen jeden
 * Host, der die URL per einfachem GET beantwortet. Retried automatisch bei 404 (siehe
 * oben) — andere Fehler (Timeout, 403, 5xx) werden sofort weitergereicht, ein erneuter
 * Versuch würde dort nichts beheben.
 *
 * Geht standardmäßig über Nexus (zentrales Rate-Limiting, `/blob-fetch`). Ist Nexus
 * nicht erreichbar (ECONNREFUSED o.ä. — z.B. lokaler Selfttest ohne laufenden Nexus),
 * fällt EIN EINZIGES Mal pro Aufruf auf direkten Fetch zurück statt die Zustellung
 * ausfallen zu lassen; das Rate-Limiting greift dann für diesen einen Versuch nicht.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] - Default 15000.
 * @param {number} [opts.retries] - Default 4 (nur bei 404).
 * @param {number} [opts.retryDelayMs] - Default 20000.
 * @returns {Promise<Buffer>}
 */
export async function downloadBlob(url, { timeoutMs = 15_000, retries = DEFAULT_RETRIES, retryDelayMs = DEFAULT_RETRY_DELAY_MS } = {}) {
    for (let attempt = 0; ; attempt++) {
        let res;
        try {
            res = await fetchViaNexus(url, timeoutMs);
        } catch (err) {
            console.warn(`downloadBlob: Nexus (${NEXUS_URL}) nicht erreichbar (${err.message}) – Fallback auf Direkt-Fetch.`);
            res = await fetchDirect(url, timeoutMs);
        }

        if (!res.ok) {
            if (res.status === 404 && attempt < retries) {
                console.warn(`downloadBlob: 404 (Versuch ${attempt + 1}/${retries + 1}), retry in ${retryDelayMs / 1000}s – ${url}`);
                await sleep(retryDelayMs);
                continue;
            }
            throw new Error(`downloadBlob: HTTP ${res.status} ${res.statusText} für ${url}`);
        }
        const arrayBuffer = await res.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }
}
