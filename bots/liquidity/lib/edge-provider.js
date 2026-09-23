// ══════════════════════════════════════════════════════════════════════════════
// LMB – Edge-Provider: die Naht zwischen Master und FORGE-public-Fork (CORE#000931)
// ══════════════════════════════════════════════════════════════════════════════
// EINE Quelle für die Edge-Prognose (npWindows je Pool und Zeitfenster, dazu die
// Unzuverlässig-Flags). bin/export.js fragt nur hier, nie das Rechenmodul direkt:
//
//   Master  → lib/edge-compute.js ist vorhanden          → 'compute'   (rechnet)
//   Fork    → Rechenmodul fehlt, Premium-Daten liegen an → 'delivered' (liest)
//   Fork    → Rechenmodul fehlt, keine Premium-Daten     → 'none'      (Platzhalter)
//
// Gleiches Muster wie lib/invest-score-provider.js: dynamischer Import, damit
// derselbe Code läuft, wenn das Rechenmodul fehlt; der Fork schließt es über
// config/pub-allowlist.json (closureExclude) aus. 'none' ist ein regulärer Zustand,
// kein Fehler, und bleibt sichtbar (Entscheidung 2026-07-25: „Zustand immer
// sichtbar") — `source`/`stale` gehen als edgeSource/edgeStale bis ins Dashboard.
//
// Warum der Fork nicht selbst rechnet: Premium liefert seit CORE#000931 die Edge
// statt des Scores. Rechnete der Fork sie weiter lokal, hätte Premium keinen Mehrwert.
// ══════════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { PATHS } from '../../../config/paths.js';

/** Bezugskapital der Edge-Prognose — Dashboard rechnet auf das Pool-Kapital hoch. */
export const EDGE_CAPITAL_USDC = 1000;

/** Ablage der über den Premium-Kanal gelieferten Edge (Blob-Sektion `edge`). */
export const DELIVERED_EDGE_PATH = path.join(PATHS.liquidityData, 'premium', 'edge.json');
const DELIVERED_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h – wie invest-score-provider.js

// Nur die Modulpräsenz wird gecacht (ändert sich nie zur Laufzeit). Der Fork-Zustand
// wird bei jedem Aufruf frisch gelesen — bin/bot.js wiederholt export.js-Zyklen in
// derselben Node-Instanz, ein gecachtes `stale` bliebe sonst ewig stehen
// (Vorfall 2026-08-01, siehe invest-score-provider.js).
let _computeModule; // undefined = noch nicht ermittelt, null = kein Compute-Modul (Fork)

async function resolveComputeModule() {
    if (_computeModule !== undefined) return _computeModule;
    try {
        _computeModule = await import('./edge-compute.js');
    } catch (err) {
        // ERR_MODULE_NOT_FOUND = erwarteter Fork-Fall. Alles andere ist ein echter Fehler.
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
        _computeModule = null;
    }
    return _computeModule;
}

/**
 * Liest die gelieferte Edge und bringt sie in dieselbe Form wie computeEdge().byPool.
 * Nur die bekannten Felder werden übernommen; eine Lieferung auf anderer Kapitalbasis
 * wird auf EDGE_CAPITAL_USDC umgerechnet. null = nicht vorhanden oder unlesbar.
 */
export function readDeliveredEdge(filePath = DELIVERED_EDGE_PATH, nowMs = Date.now()) {
    if (!existsSync(filePath)) return null;
    let raw;
    try {
        raw = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
    const ageMs = nowMs - new Date(raw.generatedAt ?? 0).getTime();
    const stale = !Number.isFinite(ageMs) || ageMs > DELIVERED_MAX_AGE_MS;
    const factor = raw.capitalUsdc > 0 ? EDGE_CAPITAL_USDC / raw.capitalUsdc : 1;

    const byPool = {};
    for (const [poolId, p] of Object.entries(raw.pools ?? {})) {
        const npWindows = {};
        for (const [tf, v] of Object.entries(p?.npWindows ?? {})) {
            if (Number.isFinite(v)) npWindows[tf] = Math.round(v * factor * 100) / 100;
        }
        byPool[poolId] = {
            npWindows,
            npUnreliableWindows: Array.isArray(p?.npUnreliableWindows) ? p.npUnreliableWindows.filter(w => typeof w === 'string') : [],
            ...(p?.npFeeSource === 'model' || p?.npFeeSource === 'legacy' ? { npFeeSource: p.npFeeSource } : {}),
        };
    }
    return { stale, byPool };
}

/**
 * Edge-Prognose je Pool.
 * @param {object} ctx – siehe computeEdge() in lib/edge-compute.js
 * @returns {Promise<{source:'compute'|'delivered'|'none', stale:boolean, byPool:object,
 *          paramsByPool:object, feeModelCompare:object}>}  paramsByPool/feeModelCompare
 *          sind nur im Master befüllt (Range-Parameter für den InvestScore-Fallback und
 *          den Fee-Modell-Vergleich); im Fork leer.
 */
export async function loadEdge(ctx) {
    const compute = await resolveComputeModule();
    if (compute) {
        return { source: 'compute', stale: false, ...compute.computeEdge(ctx) };
    }

    const delivered = readDeliveredEdge();
    if (delivered) {
        return { source: 'delivered', stale: delivered.stale, byPool: delivered.byPool,
                 paramsByPool: {}, feeModelCompare: {} };
    }
    return { source: 'none', stale: false, byPool: {}, paramsByPool: {}, feeModelCompare: {} };
}

export default { loadEdge, readDeliveredEdge, EDGE_CAPITAL_USDC, DELIVERED_EDGE_PATH };
