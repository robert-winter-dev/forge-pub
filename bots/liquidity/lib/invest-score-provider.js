// ══════════════════════════════════════════════════════════════════════════════
// LMB – Score-Provider: die Naht zwischen Master und FORGE.pub-Fork
// ══════════════════════════════════════════════════════════════════════════════
// EINE Quelle für Opportunity Score + InvestScore. bin/export.js fragt nur hier,
// nie die Rechenmodule direkt — dadurch existiert genau eine Stelle, an der sich
// Master und Fork unterscheiden:
//
//   Master  → lib/invest-score-compute.js ist vorhanden  → 'compute'   (rechnet)
//   Fork    → Rechenmodul fehlt, Premium-Daten liegen an → 'delivered' (liest)
//   Fork    → Rechenmodul fehlt, keine Premium-Daten     → 'none'      (Platzhalter)
//
// Zwei Aufrufe statt einem, weil export.js die Scores zu verschiedenen Zeitpunkten
// braucht: die Opportunity Scores früh (nur Pool-Statistiken nötig), die
// InvestScores später (brauchen poolsOverview + die Opportunity Scores). Das
// Backend wird dabei einmal ermittelt und gecacht.
//
// Warum der Import DYNAMISCH ist: Nur so kann derselbe Code laufen, wenn das
// Rechenmodul fehlt. Der Fork schließt es über config/pub-allowlist.json
// (closureExclude) aus; der Import-Closure-Check kennt diese Ausnahme.
//
// 'none' ist ein regulärer Zustand, kein Fehler: der freie Fork ohne Premium hat
// keinen Score. Er MUSS sichtbar bleiben (Entscheidung 2026-07-25: „Zustand immer
// sichtbar") — deshalb liefert der Provider `source` mit, das bis ins Dashboard
// durchgereicht und dort als Platzhalter angezeigt wird. Ein Notausstieg, der auf
// dem Score beruht, feuert in diesem Zustand nicht (fail-safe, siehe score-limit.js).
// ══════════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PATHS } from '../../../config/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ablage der über den Premium-Kanal gelieferten Score-Daten.
// ⚠️ Schema noch vorläufig — endgültige Festlegung im Premium-Blob-Datenschema
//.
export const DELIVERED_SCORES_PATH = path.join(PATHS.liquidityData, 'premium', 'scores.json');
const DELIVERED_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2h – danach als veraltet behandeln

// Nur die MODULPRÄSENZ wird gecacht (Master hat invest-score-compute.js, Fork nie –
// ändert sich nie zur Laufzeit eines Prozesses). NICHT gecacht werden darf dagegen
// der Fork-Zustand 'delivered'/'none' samt `stale`: bin/bot.js ist ein dauerhafter
// Prozess, der export.js-Zyklen über EXPORT_INTERVAL_MS in derselben Node-Instanz
// wiederholt – ein einmal gecachtes `stale:true` (z.B. weil zum allerersten Aufruf
// noch keine/veraltete Premium-Daten vorlagen) hätte sonst NIE wieder aktualisiert,
// selbst wenn zwischenzeitlich frische Daten eintreffen. Vorfall 2026-08-01: nach
// erfolgreichem Ingest blieb das "Score-Daten veraltet"-Banner trotzdem stehen, weil
// genau dieser Cache seit Prozessstart nie neu gelesen wurde.
let _computeModule; // undefined = noch nicht ermittelt, null = kein Compute-Modul (Fork)

/** Ermittelt einmalig, ob das Compute-Modul existiert (Master vs. Fork). */
async function resolveComputeModule() {
    if (_computeModule !== undefined) return _computeModule;
    try {
        _computeModule = await import('./invest-score-compute.js');
    } catch (err) {
        // ERR_MODULE_NOT_FOUND = erwarteter Fork-Fall. Alles andere ist ein echter
        // Fehler und darf nicht als „kein Score" durchrutschen.
        if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
        _computeModule = null;
    }
    return _computeModule;
}

/** Ermittelt das Backend – Fork-Zweig (delivered/none inkl. stale) IMMER frisch. */
async function getBackend() {
    const compute = await resolveComputeModule();
    if (compute) return { kind: 'compute', compute, stale: false };

    const delivered = tryLoadDelivered();
    return delivered
        ? { kind: 'delivered', delivered: delivered.data, stale: delivered.stale }
        : { kind: 'none', stale: false };
}

/** Liest gelieferte Premium-Score-Daten, oder null wenn nicht vorhanden/unlesbar. */
function tryLoadDelivered() {
    if (!existsSync(DELIVERED_SCORES_PATH)) return null;
    try {
        const raw = JSON.parse(readFileSync(DELIVERED_SCORES_PATH, 'utf8'));
        const ageMs = Date.now() - new Date(raw.generatedAt ?? 0).getTime();
        const stale = !Number.isFinite(ageMs) || ageMs > DELIVERED_MAX_AGE_MS;
        return { stale, ageMs, data: raw };
    } catch {
        return null;
    }
}

/**
 * Opportunity Scores je Pool über alle Zeitfenster.
 * @param {{pools:Array, oppStatsByPool:object, oppNowMs:number, volatilePairMap:object}} ctx
 * @returns {Promise<{source:string, stale:boolean, timeframeIds:string[], opportunityScores:object}>}
 */
export async function loadOpportunityScores(ctx) {
    const be = await getBackend();

    if (be.kind === 'compute') {
        return {
            source: 'compute',
            stale: false,
            timeframeIds: be.compute.TIMEFRAME_IDS,
            opportunityScores: be.compute.computeOpportunityScores(ctx),
        };
    }

    if (be.kind === 'delivered') {
        const opportunityScores = be.delivered.opportunityScores ?? {};
        // Zeitfenster aus den gelieferten Daten ableiten – der Fork kennt
        // TIMEFRAME_IDS nicht (steht im ausgeschlossenen opportunity-score-Modul).
        const timeframeIds = be.delivered.timeframeIds
            ?? [...new Set(Object.values(opportunityScores).flatMap(o => Object.keys(o ?? {})))];
        return { source: 'delivered', stale: be.stale, timeframeIds, opportunityScores };
    }

    return { source: 'none', stale: false, timeframeIds: [], opportunityScores: {} };
}

/**
 * InvestScore je Pool.
 * @param {object} ctx – { pools, poolsOverview, volHistRaw, poolTypeMap, openPosByPool,
 *                         lastNonZeroCapitalByPool, oppStatsByPool, volatilePairMap }
 * @param {object} opportunityScores – Ergebnis von loadOpportunityScores()
 * @returns {Promise<{source:string, stale:boolean, investScores:Map<string,object>}>}
 */
export async function loadInvestScores(ctx, opportunityScores) {
    const be = await getBackend();

    if (be.kind === 'compute') {
        return {
            source: 'compute',
            stale: false,
            investScores: be.compute.computeInvestScores({ ...ctx, opportunityScores }),
        };
    }

    if (be.kind === 'delivered') {
        return {
            source: 'delivered',
            stale: be.stale,
            investScores: new Map(Object.entries(be.delivered.investScores ?? {})),
        };
    }

    return { source: 'none', stale: false, investScores: new Map() };
}

export default { loadOpportunityScores, loadInvestScores, DELIVERED_SCORES_PATH };
