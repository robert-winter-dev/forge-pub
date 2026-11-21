// token-info-store.js v2
// Lädt die Token-Kurzinfos als reine JSON-Daten statt eines ausgeführten Moduls
// (FORGE public Pool-Offers Blocker 1, 2026-07-27): ein Premium-Datenkanal darf niemals
// Code ausliefern, nur Daten.
//
// Zwei Quellen (CORE#002114):
//   - js/token-info-data.json: kuratierte Basis, nur auf dem Master. Liegt seit CORE#002114
//     nicht mehr im Fork-Archiv (Premium-Vorteil).
//   - data/premium/token-info.json: Overlay, im Fork vom Premium-Ingest aus dem Blob
//     geschrieben (bots/liquidity/lib/premium-ingest.js).
// Welche davon existiert, steht in data.json (`tokenInfoSources`, bin/export.js). Abgerufen
// wird nur, was dort als vorhanden gemeldet ist: kein 404 im Webserver-Log (WEB#002104).
//
// Sicherheit: `url` wird beim Laden validiert (nur https://, sonst verworfen) — ein
// fehlerhafter oder böswilliger Overlay-Datensatz darf keine javascript:-URLs in ein
// <a href> einschleusen (die bestehende HTML-Escaping in den Konsumenten schützt nur
// vor Markup-Injection, nicht vor einem bösartigen URL-Schema).

import { LANG } from '../../js/i18n.js?v=20260811a';

let _cache    = null;
let _loading  = null;
let _cacheKey = null; // Quellen-Stand, aus dem _cache stammt (siehe sourcesKey)

function sourcesKey(sources) {
    return `${sources?.base ? 1 : 0}:${sources?.overlayVersion ?? ''}`;
}

function sanitizeEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const url = typeof raw.url === 'string' && raw.url.startsWith('https://') ? raw.url : null;
    // Zweisprachig (LIQ#001176): category/description sind Deutsch, categoryEn/descriptionEn
    // Englisch. Hier wird einmal nach LANG aufgelöst, damit die Konsumenten unverändert
    // category/description lesen. Fehlt die englische Fassung (z.B. ein älteres Premium-Overlay),
    // fällt es auf Deutsch zurück statt auf eine leere Anzeige.
    const en = LANG === 'en';
    const pick = (de, enVal) => (en && typeof enVal === 'string' && enVal ? enVal : (typeof de === 'string' ? de : null));
    return {
        symbol:      typeof raw.symbol === 'string' ? raw.symbol : null,
        category:    pick(raw.category, raw.categoryEn),
        description: pick(raw.description, raw.descriptionEn),
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
 * Lädt die Token-Infos laut `sources` (data.json → tokenInfoSources). Idempotent: derselbe
 * Quellen-Stand gibt dieselbe Promise bzw. denselben Cache zurück; ändert sich der Stand
 * (Overlay neu geschrieben, Premium aktiviert), wird neu geladen.
 *
 * Ohne `sources` (z. B. aus token-info-modal.js) wird nichts abgerufen, nur der vorhandene
 * Stand zurückgegeben: das Modal öffnet ohnehin erst, nachdem app.js mit data.json geladen hat.
 */
export function loadTokenInfo(sources) {
    if (sources === undefined) return _loading ?? Promise.resolve(_cache ?? {});
    const key = sourcesKey(sources);
    if (_cacheKey === key && (_cache || _loading)) return _loading ?? Promise.resolve(_cache);

    _cacheKey = key;
    const loading = (async () => {
        // Basis liegt neben diesem Modul (js/) — modul-relativ auflösen, nicht seiten-relativ
        // wie fetch() es sonst tut (anders als import, das ohnehin modul-relativ auflöst).
        const base = sources?.base
            ? ((await fetchJson(new URL('token-info-data.json', import.meta.url).href))?.tokens ?? {})
            : {};
        // Overlay liegt neben den übrigen generierten Daten — seiten-relativ, analog zu
        // data/data.json. Die Version im Query umgeht Zwischen-Caches nach einem neuen Ingest.
        const overlay = sources?.overlayVersion
            ? ((await fetchJson(`data/premium/token-info.json?v=${encodeURIComponent(sources.overlayVersion)}`))?.tokens ?? {})
            : {};
        const merged = {};
        for (const [mint, raw] of Object.entries({ ...base, ...overlay })) {
            const clean = sanitizeEntry(raw);
            if (clean) merged[mint] = clean;
        }
        // Nur übernehmen, wenn inzwischen kein neuerer Quellen-Stand angefordert wurde.
        if (_cacheKey === key) { _cache = merged; _loading = null; }
        return merged;
    })();
    _loading = loading;
    return loading;
}

/** Synchroner Zugriff nach loadTokenInfo() — undefined solange noch nicht geladen. */
export function getTokenInfo(mint) {
    return _cache?.[mint];
}
