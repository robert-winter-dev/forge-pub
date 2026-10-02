// ══════════════════════════════════════════════════════════════════════════════
// LMB – Slopes-Provider: die Naht zwischen Master und FORGE-public-Fork
// ══════════════════════════════════════════════════════════════════════════════
// EINE Quelle für die Pool-Slopes der Opportunity-Tabelle (Preis-, APR-, TVL-Slope je
// Zeitfenster). bin/export.js fragt nur hier, nie das Rechenmodul direkt:
//
//   Master  → lib/pool-slopes/ ist vorhanden             → 'compute'   (rechnet)
//   Fork    → Rechenmodul fehlt, Premium-Daten liegen an → 'delivered' (liest)
//   Fork    → Rechenmodul fehlt, keine Premium-Daten     → 'none'      (leer)
//
// Warum der Import DYNAMISCH ist: Nur so kann derselbe Code laufen, wenn das
// Rechenmodul fehlt. Der Fork schließt es über config/pub-allowlist.json
// (closureExclude) aus; der Import-Closure-Check kennt diese Ausnahme.
//
// Herkunft: bis LIQ#000932 (23.09.2026) der Score-Provider, der zusätzlich die beiden
// Scores lieferte. Den Premium-Zugang im Dashboard steuert
// seit CORE#000931 edgeSource (lib/edge-provider.js); die Slopes kommen im selben Blob
// und brauchen deshalb keinen eigenen Zustand im Dashboard.
// ══════════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { PATHS } from '../../../config/paths.js';

/** Ablage der über den Premium-Kanal gelieferten Slopes (Blob-Sektion `slopes`). */
export const DELIVERED_SLOPES_PATH = path.join(PATHS.liquidityData, 'premium', 'slopes.json');
const DELIVERED_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h – danach als veraltet behandeln

// Nur die MODULPRÄSENZ wird gecacht (Master hat lib/pool-slopes/, Fork nie – ändert
// sich nie zur Laufzeit eines Prozesses). Der Fork-Zustand wird bei jedem Aufruf frisch
// gelesen: bin/bot.js wiederholt export.js-Zyklen in derselben Node-Instanz, ein
// gecachtes `stale:true` bliebe sonst bis zum Neustart stehen (Vorfall 2026-08-01).
let _computeModule; // undefined = noch nicht ermittelt, null = kein Compute-Modul (Fork)

async function resolveComputeModule() {
    if (_computeModule !== undefined) return _computeModule;
    try {
        _computeModule = await import('./pool-slopes/index.js');
    } catch (err) {
        // ERR_MODULE_NOT_FOUND = erwarteter Fork-Fall. Alles andere ist ein echter
        // Fehler und darf nicht als „keine Slopes" durchrutschen.
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
        _computeModule = null;
    }
    return _computeModule;
}

/** Liest gelieferte Premium-Slopes, oder null wenn nicht vorhanden/unlesbar. */
function tryLoadDelivered() {
    if (!existsSync(DELIVERED_SLOPES_PATH)) return null;
    try {
        const raw = JSON.parse(readFileSync(DELIVERED_SLOPES_PATH, 'utf8'));
        const ageMs = Date.now() - new Date(raw.generatedAt ?? 0).getTime();
        const stale = !Number.isFinite(ageMs) || ageMs > DELIVERED_MAX_AGE_MS;
        return { stale, data: raw };
    } catch {
        return null;
    }
}

/**
 * Pool-Slopes je Pool über alle Zeitfenster.
 * @param {{pools:Array, statsByPool:object, poolsConfig:Array, nowMs:number}} ctx
 * @returns {Promise<{source:string, stale:boolean, timeframeIds:string[], poolSlopes:object}>}
 */
export async function loadPoolSlopes(ctx) {
    const compute = await resolveComputeModule();
    if (compute) {
        return {
            source: 'compute',
            stale: false,
            timeframeIds: compute.TIMEFRAME_IDS,
            poolSlopes: compute.computePoolSlopes(ctx),
        };
    }

    const delivered = tryLoadDelivered();
    if (delivered) {
        const poolSlopes = delivered.data.pools ?? {};
        // Zeitfenster aus den gelieferten Daten ableiten – der Fork kennt TIMEFRAME_IDS
        // nicht (steht im ausgeschlossenen pool-slopes-Modul).
        const timeframeIds = delivered.data.timeframeIds
            ?? [...new Set(Object.values(poolSlopes).flatMap(o => Object.keys(o ?? {})))];
        return { source: 'delivered', stale: delivered.stale, timeframeIds, poolSlopes };
    }

    return { source: 'none', stale: false, timeframeIds: [], poolSlopes: {} };
}

export default { loadPoolSlopes, DELIVERED_SLOPES_PATH };
