/**
 * FORGE Liquidity – Provider für die Chart-Links des Chart-Dialogs (LIQ#001954),
 * gleiche Naht wie chance-provider.js.
 *
 *   Master → lib/tv-sentiment/pool-listings.js vorhanden → 'compute' (liest den täglichen Abgleich)
 *   Fork   → Modul fehlt (closureExclude)                  → 'delivered' (Premium-Blob-Sektion `tvLinks`)
 *
 * Ergebnis je Pool: { pool: <Symbol>|null, tokens: { <Mint>: <Symbol> }, similar?: { symbol, kind, note } }. Fehlt ein Eintrag, bleibt der
 * Dialog bei GeckoTerminal.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../../config/paths.js';

export const DELIVERED_TVLINKS_PATH = path.join(PATHS.liquidityData, 'premium', 'tv-links.json');
const DELIVERED_MAX_AGE_MS = 2 * 60 * 60 * 1000; // wie chance-provider.js
/** Erlaubte Form eines Symbols (EXCHANGE:TICKER). Gilt auch für Fremddaten (Blob). */
export const SYMBOL_RE = /^[A-Za-z0-9_.-]{1,40}:[A-Za-z0-9_.!-]{1,80}$/;

let _mod; // undefined = unbekannt, null = Fork

async function resolveModule() {
    if (_mod !== undefined) return _mod;
    try {
        _mod = await import('./tv-sentiment/pool-listings.js');
    } catch (err) {
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
        _mod = null;
    }
    return _mod;
}

/** Erlaubte Arten eines ähnlichen Charts (LIQ#001961). */
export const SIMILAR_KINDS = ['otherDex', 'underlying'];
export const NOTE_MAX = 80;

/** `similar` aus Fremddaten: gültiges Symbol, feste Art, Notiz ohne HTML-Zeichen und mit Längengrenze. */
export function sanitizeSimilar(s) {
    if (!s || typeof s !== 'object') return null;
    if (typeof s.symbol !== 'string' || !SYMBOL_RE.test(s.symbol)) return null;
    if (!SIMILAR_KINDS.includes(s.kind)) return null;
    if (typeof s.note !== 'string') return null;
    const note = s.note.trim();
    if (!note || note.length > NOTE_MAX || /[<>&"'`\\]|[\u0000-\u001f]/.test(note)) return null;
    return { symbol: s.symbol, kind: s.kind, note };
}

/** Nur bekannte Felder und gültige Symbole übernehmen (Lieferung ist Fremddaten). */
export function sanitizeEntry(e) {
    if (!e || typeof e !== 'object') return null;
    const pool = typeof e.pool === 'string' && SYMBOL_RE.test(e.pool) ? e.pool : null;
    const tokens = {};
    for (const [mint, sym] of Object.entries(e.tokens ?? {})) {
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) && typeof sym === 'string' && SYMBOL_RE.test(sym)) tokens[mint] = sym;
    }
    const similar = sanitizeSimilar(e.similar);
    if (!pool && Object.keys(tokens).length === 0 && !similar) return null;
    return similar ? { pool, tokens, similar } : { pool, tokens };
}

/** @returns {{stale:boolean, byPool:object}|null} null = nicht vorhanden/unlesbar */
export function readDeliveredTvLinks(filePath = DELIVERED_TVLINKS_PATH, nowMs = Date.now()) {
    if (!existsSync(filePath)) return null;
    let raw;
    try { raw = JSON.parse(readFileSync(filePath, 'utf8')); } catch { return null; }
    const ageMs = nowMs - new Date(raw.generatedAt ?? 0).getTime();
    const stale = !Number.isFinite(ageMs) || ageMs > DELIVERED_MAX_AGE_MS;
    const byPool = {};
    for (const [id, e] of Object.entries(raw.pools ?? {})) {
        const s = sanitizeEntry(e);
        if (s) byPool[id] = s;
    }
    return { stale, byPool };
}

/**
 * @param {{id:string}[]} pools
 * @returns {Promise<{source:'compute'|'delivered'|'none', stale:boolean, byPool:object}>}
 */
export async function loadTvLinks(pools, { nowMs = Date.now() } = {}) {
    const mod = await resolveModule();
    if (mod) return { source: 'compute', stale: false, byPool: mod.buildTvLinks(pools) };
    const d = readDeliveredTvLinks(DELIVERED_TVLINKS_PATH, nowMs);
    if (d && !d.stale) return { source: 'delivered', stale: false, byPool: d.byPool };
    return { source: d ? 'delivered' : 'none', stale: !!d, byPool: {} };
}

export default { loadTvLinks, readDeliveredTvLinks, DELIVERED_TVLINKS_PATH };
