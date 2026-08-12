// token-info-store.js v1
// Lädt die Token-Kurzinfos als reine JSON-Daten statt eines ausgeführten Moduls
// (FORGE public Pool-Offers Blocker 1, 2026-07-27): ein künftiger Premium-Datenkanal darf
// niemals Code ausliefern, nur Daten. token-info-data.json bleibt die kuratierte Basis
// (Recherche-Pflicht siehe dortiger _comment); ein optionales Overlay
// (data/premium/token-info.json) kann später zusätzliche/aktualisierte Einträge
// beisteuern, sobald der Premium-Ingest existiert — bis dahin liefert der Fetch
// einfach 404 und wird stillschweigend ignoriert.
//
// Sicherheit: `url` wird beim Laden validiert (nur https://, sonst verworfen) — ein
// fehlerhafter oder böswilliger Overlay-Datensatz darf keine javascript:-URLs in ein
// <a href> einschleusen (die bestehende HTML-Escaping in den Konsumenten schützt nur
// vor Markup-Injection, nicht vor einem bösartigen URL-Schema).

let _cache   = null;
let _loading = null;

function sanitizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const url = typeof raw.url === 'string' && raw.url.startsWith('https://') ? raw.url : null;
    return {
        symbol:      typeof raw.symbol === 'string' ? raw.symbol : null,
        category:    typeof raw.category === 'string' ? raw.category : null,
        description: typeof raw.description === 'string' ? raw.description : null,
        url,
        checkedAt:   typeof raw.checkedAt === 'string' ? raw.checkedAt : null,
    };
}

async function fetchJson(url) {
    try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

/**
 * Lädt die Token-Infos einmalig (Basis + optionales Premium-Overlay). Idempotent —
 * mehrfacher Aufruf (z.B. aus app.js und token-info-modal.js) gibt dieselbe Promise
 * zurück, kein doppelter Fetch.
 */
export function loadTokenInfo() {
    if (_cache) return Promise.resolve(_cache);
    if (_loading) return _loading;

    _loading = (async () => {
        // Basis liegt neben diesem Modul (js/) — modul-relativ auflösen, nicht seiten-relativ
        // wie fetch() es sonst tut (anders als import, das ohnehin modul-relativ auflöst).
        const baseUrl = new URL('token-info-data.json', import.meta.url).href;
        const base    = (await fetchJson(baseUrl))?.tokens ?? {};
        // Overlay liegt (künftig) neben den übrigen generierten Daten — seiten-relativ,
        // analog zu data/data.json.
        const overlay = (await fetchJson('data/premium/token-info.json'))?.tokens ?? {};
        const merged = {};
        for (const [mint, raw] of Object.entries({ ...base, ...overlay })) {
            const clean = sanitizeEntry(raw);
            if (clean) merged[mint] = clean;
        }
        _cache = merged;
        return _cache;
    })();
    return _loading;
}

/** Synchroner Zugriff nach loadTokenInfo() — undefined solange noch nicht geladen. */
export function getTokenInfo(mint) {
    return _cache?.[mint];
}
