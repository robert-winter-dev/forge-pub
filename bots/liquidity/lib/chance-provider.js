/**
 * FORGE Liquidity – Provider für den Chance-Wert (LIQ#001953), gleiche Naht wie edge-provider.js.
 *
 *   Master → lib/chance-score.js vorhanden → 'compute' (rechnet)
 *   Fork   → Modul fehlt (closureExclude)   → 'delivered' (Premium-Blob-Sektion `chance`)
 *
 * 🔒 Regel LIQ#000938: Der Fork rechnet nie selbst, auch keine Vorstufe.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../../config/paths.js';

export const DELIVERED_CHANCE_PATH = path.join(PATHS.liquidityData, 'premium', 'chance.json');
const DELIVERED_MAX_AGE_MS = 2 * 60 * 60 * 1000; // wie edge-provider.js
const STATUSES = new Set(['met', 'unmet', 'nodata']);

let _mod; // undefined = unbekannt, null = Fork

async function resolveModule() {
    if (_mod !== undefined) return _mod;
    try {
        _mod = await import('./chance-score.js');
    } catch (err) {
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
        _mod = null;
    }
    return _mod;
}

/** Nur bekannte Felder und Typen übernehmen (Lieferung ist Fremddaten). */
function sanitizeEntry(e) {
    if (!e || !Number.isFinite(e.value) || !Array.isArray(e.signals)) return null;
    const valid = e.signals
        .filter(s => (s?.src === 'edge' || s?.src === 'tv') && typeof s.tf === 'string' && STATUSES.has(s.status));
    // LIQ#001963: Trend 2h gibt es nicht mehr. Liefert ein noch nicht aktualisierter Master es mit, wird das
    // Signal verworfen (nicht der ganze Eintrag) und Zähler/Wert aus den verbleibenden Signalen nachgezogen.
    const signals = valid
        .filter(s => !(s.src === 'tv' && s.tf === '2h'))
        .map(s => ({ src: s.src, tf: s.tf, raw: Number.isFinite(s.raw) ? s.raw : null, status: s.status,
                     ...(Number.isFinite(s.score) ? { score: Math.max(0, Math.min(1, s.score)) } : {}),
                     ...(s.src === 'edge' && Number.isFinite(s.ref) && s.ref > 0 ? { ref: s.ref } : {}),
                     ...(s.unreliable === true ? { unreliable: true } : {}) }));
    const dropped = valid.length !== signals.length;
    const metN = signals.filter(s => s.status === 'met').length;
    // Mit Teilpunkten (LIQ#001964) ist der Durchschnitt der Wert, bei Altlieferung der Anteil erfüllter Signale
    const scored = signals.length > 0 && signals.every(s => Number.isFinite(s.score));
    const recomputed = scored ? Math.round(signals.reduce((a, s) => a + s.score, 0) / signals.length * 100)
        : Math.round(metN / signals.length * 100);
    return {
        value: dropped && signals.length ? recomputed : Math.max(0, Math.min(100, Math.round(e.value))),
        met: dropped ? metN : Number.isFinite(e.met) ? e.met : metN,
        applicable: dropped ? signals.length : Number.isFinite(e.applicable) ? e.applicable : signals.length,
        edgeOnly: e.edgeOnly === true,
        signals,
        tv: {
            status: typeof e.tv?.status === 'string' ? e.tv.status : 'missing',
            symbol: typeof e.tv?.symbol === 'string' ? e.tv.symbol : null,
            source: typeof e.tv?.source === 'string' ? e.tv.source : null,
            fetchedAt: Number.isFinite(e.tv?.fetchedAt) ? e.tv.fetchedAt : null,
        },
    };
}

/** @returns {{stale:boolean, byPool:object}|null} null = nicht vorhanden/unlesbar */
export function readDeliveredChance(filePath = DELIVERED_CHANCE_PATH, nowMs = Date.now()) {
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
 * @param {{id:string,npWindows?:object,npUnreliableWindows?:string[]}[]} pools
 * @returns {Promise<{source:'compute'|'delivered'|'none', stale:boolean, byPool:object}>}
 */
export async function loadChance(pools, { nowMs = Date.now() } = {}) {
    const mod = await resolveModule();
    if (mod) return { source: 'compute', stale: false, byPool: mod.computeChanceForPools(pools, { nowMs }) };
    const d = readDeliveredChance(DELIVERED_CHANCE_PATH, nowMs);
    if (d && !d.stale) return { source: 'delivered', stale: false, byPool: d.byPool };
    return { source: d ? 'delivered' : 'none', stale: !!d, byPool: {} };
}

export default { loadChance, readDeliveredChance, DELIVERED_CHANCE_PATH };
