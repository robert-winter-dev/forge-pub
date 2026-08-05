/**
 * Zentrale Konfiguration des Economic-Scorers.
 *
 * Seit Phase 2 profil-abhängig: zwei Konfigurationen (medium | short)
 * mit unterschiedlichen Zeitfenstern, Schwellen und Modifikatoren.
 *
 * Profil-Wahl:
 *   - Aus process.env.PROFILE (Werte: 'medium' | 'short')
 *   - Default: 'medium' (entspricht dem Vor-Phase-2-Verhalten)
 *
 * Konsumenten (cleanup.js, ranking-exit.js, pool-explorer.js) lesen
 * das aktive Profil über getActiveProfile() bzw. nutzen getScorerConfig().
 *
 * Hot-Reload:
 *   Reine Wert-Änderungen in dieser Datei wirken sich beim nächsten
 *   pool-explorer-Lauf (Cron, 15 Min) aus — kein Bot-Neustart nötig.
 *   Profil-Wechsel via .env benötigt aktuell einen Bot-Restart, weil
 *   process.env zum Bot-Start eingelesen wird.
 */

// ─── Mittelfrist-Profil (Default, entspricht Pre-Phase-2-Werten) ─────────────

const MEDIUM_CONFIG = {
    profile: 'medium',

    // Zeitfenster (in Tagen)
    windows: {
        realizedAprDays:   7,
        rebalLookbackDays: 30,
        trendDays:          7,
        tvlTrendDays:       7,
        rangeHitDays:       7,
        tokenReturnDays:    7,
    },

    // Reinvest-Effizienz
    reinvest: {
        efficiency:       0.80,
        cleanupDelayDays: 1 / 24,
    },

    // Datenqualität / Confidence
    confidence: {
        minDays:   3,
        fullDays: 14,
    },

    // Tier-Klassifikation
    tier: {
        metric:                              'totalReturn',  // = totalReturnAprPct
        holdIfDataDaysBelow:                 3,
        withdrawIfTotalReturnBelowActive:    -20,
        withdrawIfTotalReturnBelowInactive:    0,
        withdrawIfDailyPnlBelow:             -10,
        hysteresisSnapshots:                  3,
    },

    // Modifikatoren für Reihenfolge innerhalb Tier
    modifiers: {
        trendBonusMax:        0.20,
        trendSlopeForMax:     2.0,
        rangeHitMalusBelow:   70,
        rangeHitMalusFactor:  0.30,
        tvlTrendMalusBelow:  -10,
        tvlTrendMalusFactor:  0.20,
        confidenceDampensScore: true,
    },

    // Schätzungen für inaktive Pools
    inactive: {
        volatilityToRebalsCoeff:   0.5,
        defaultAssumedRangePct:    5.0,
        assumedRebalCostUsdc:      0.30,
        maxConfidenceWhenInactive: 60,
    },

    // Notifications
    notifications: {
        notifyOnTierTransition: ['withdraw', 'invest'],
        minHoursBetweenNotifs:   6,
    },
};

// ─── Kurzfrist-Profil ─────────────────────────────────────────────────────────
//
// Bewertet Pools nach 1–4 h Momentum statt 7-Tage-Historie. Reagiert schnell
// auf Volumen-Spikes. Damit Pools mit ungünstiger Ökonomie (niedriger Fee-Tier
// oder hohe Slippage) sich nicht künstlich nach oben spielen, wird vom
// shortTermAprPct der entryExitCostAprPct abgezogen — der Tier-Classifier
// nutzt metric='shortTermNet' für Median + Reihenfolge.

const SHORT_CONFIG = {
    profile: 'short',

    windows: {
        // Mittelfrist-Bezugswerte kürzer fassen — werden im Kurzfrist-Profil
        // nur als Sekundärsignale verwendet (Trend, Range-Hit), nicht als
        // Hauptmetrik. Daher konservativ verkleinert.
        realizedAprDays:   2,
        rebalLookbackDays: 14,
        trendDays:        0.5,
        tvlTrendDays:      2,
        rangeHitDays:      2,
        tokenReturnDays:   2,
    },

    reinvest: {
        efficiency:       0.80,
        cleanupDelayDays: 1 / 24,
    },

    confidence: {
        minDays:   0.5,
        fullDays: 14,
    },

    tier: {
        metric:                              'shortTermNet',     // = shortTermAprPct - entryExitCostAprPct
        holdIfDataDaysBelow:                 0.5,                // wenig Vorlauf nötig (Kurzfristblick)
        // Withdraw-Schwellen: shortTermNet ist durch ×2190-Annualisierung
        // stark skaliert; ein „mäßig schlechter" Pool kann leicht bei -50 %
        // APR liegen ohne aktiv ausgestiegen werden zu müssen. Nur Pools mit
        // klar negativer Bilanz (-500 %) sollen ranking-exit auslösen.
        // Mittelfrist-typisch im Vergleich: dort ist -20 % bereits klares Exit-Signal.
        withdrawIfTotalReturnBelowActive:    -500,
        withdrawIfTotalReturnBelowInactive:  -200,
        withdrawIfDailyPnlBelow:            -5,                  // engerer Exit als Mittelfrist
        hysteresisSnapshots:                 1,                  // schnelle Tier-Wechsel
        // Warm-up-Safeguard: Pool ohne ausreichende Kurzfrist-Datenbasis
        // (shortTermConfidence < N) landet automatisch in 'hold' — keine
        // Invest-Empfehlung bevor das Signal verlässlich ist.
        shortTermMinConfidence:              50,
        // Hard-Floor für „Invest": shortTermNet muss positiv sein.
        // Ohne diese Regel könnte das Median-Voting in einem flachen Markt
        // den „besten der schlechten" Pool als invest labeln. Stattdessen
        // bleibt alles auf 'hold' wenn kein Pool die Kosten überdeckt.
        shortTermInvestRequiresPositiveMetric: true,
    },

    // Kurzfrist-spezifischer Block (Phase 1-Komponenten konsumieren das)
    shortTerm: {
        expectedHoldHours:    4,    // Annahme für entryExitCostAprPct-Amortisation
        minVolumeSpike:       1.5,  // Optional als Filter im Tier-Classifier
    },

    modifiers: {
        // Trend-Bonus auf Kurzfristblick: kleinere Empfindlichkeit, da der
        // Slope schon das Hauptsignal mitprägt (volumeSpikeFactor wird hier
        // separat berücksichtigt wenn relevant).
        trendBonusMax:        0.30,
        trendSlopeForMax:     5.0,  // %-Punkte/Tag (kurzfristig steilere Slopes)
        rangeHitMalusBelow:   70,
        rangeHitMalusFactor:  0.30,
        tvlTrendMalusBelow:  -20,   // bei Kurzfrist toleranter — TVL-Schwund über 7d
                                    //   ist weniger relevant als aktuelle Aktivität
        tvlTrendMalusFactor:  0.15,
        confidenceDampensScore: true,
    },

    inactive: {
        volatilityToRebalsCoeff:   0.5,
        defaultAssumedRangePct:    5.0,
        assumedRebalCostUsdc:      0.30,
        maxConfidenceWhenInactive: 60,
    },

    notifications: {
        notifyOnTierTransition: ['withdraw', 'invest'],
        // Im Kurzfristmodus kann ein Pool öfter wechseln — etwas längere
        // Pause damit Telegram nicht zugespammt wird.
        minHoursBetweenNotifs:   2,
    },
};

// ─── Public API ───────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Neue Strategie-Werte (6h/12h/24h/7d) seit Umbau 2026-05-21.
// Legacy-Werte (medium/short) werden on-the-fly migriert.
const VALID_PROFILES = ['6h', '12h', '24h', '7d'];

// Hot-Reload: PROFILE wird direkt aus .env gelesen statt aus process.env, damit
// ein Profil-Wechsel via ForgeSettings ohne Bot-Restart wirksam wird.
// TTL-Cache (5 s) verhindert dass shouldTriggerRankingExit() bei N Pools pro
// Bot-Zyklus N Filesystem-Reads auslöst — bei 5-Min-Bot-Loop wird die Datei
// in der Praxis einmal pro Loop gelesen.
const _ENV_PATH        = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
const _PROFILE_CACHE_TTL_MS = 5_000;
let _cachedProfile     = null;
let _cachedAt          = 0;
let _lastWarnedRaw     = null;   // Anti-Spam für „unbekanntes PROFILE"-Warnung

function _readProfileFromEnv() {
    let raw = null;
    try {
        const content = readFileSync(_ENV_PATH, 'utf8');
        // Akzeptiert PROFILE=short, PROFILE='short', PROFILE="short", auch mit Whitespace
        const m = content.match(/^\s*PROFILE\s*=\s*['"]?([^'"#\r\n]*)['"]?\s*$/m);
        if (m) raw = m[1].trim().toLowerCase();
    } catch {
        // Datei nicht lesbar → Fallback auf process.env (z.B. systemd-Env ohne .env)
        raw = (process.env.PROFILE ?? '').trim().toLowerCase();
    }
    if (!raw) return '24h';
    // Legacy-Mapping: medium → 24h, short → 6h
    if (raw === 'medium') return '24h';
    if (raw === 'short')  return '6h';
    if (!VALID_PROFILES.includes(raw)) {
        if (raw !== _lastWarnedRaw) {
            console.warn(`[scorer-config] PROFILE='${raw}' unbekannt — falle zurück auf '24h'`);
            _lastWarnedRaw = raw;
        }
        return '24h';
    }
    return raw;
}

/**
 * Liefert das aktive Profil, gelesen aus Liquidity Bot/.env (mit 5 s
 * TTL-Cache). Hot-Reload: Änderungen werden ohne Bot-Restart spätestens
 * 5 s später wirksam.
 *
 * Fallback-Kette:
 *   .env-Datei nicht lesbar → process.env.PROFILE → 'medium'
 *
 * Ein Profil-Wechsel mid-flight beeinflusst keine bereits laufenden
 * rk_executions (die nutzen ihren config_snapshot zur Wiederaufnahme).
 *
 * Rückgabewert seit 2026-05-21: '6h' | '12h' | '24h' | '7d'
 * (Legacy-Werte 'medium'/'short' werden in _readProfileFromEnv migriert.)
 */
export function getActiveProfile() {
    const now = Date.now();
    if (_cachedProfile != null && now - _cachedAt < _PROFILE_CACHE_TTL_MS) {
        return _cachedProfile;
    }
    _cachedProfile = _readProfileFromEnv();
    _cachedAt      = now;
    return _cachedProfile;
}

/**
 * Liefert die Scorer-Config für ein bestimmtes Profil.
 * Ohne Argument: aktives Profil (env-basiert).
 *
 * Mapping: 6h/12h → SHORT_CONFIG (reaktiv), 24h/7d → MEDIUM_CONFIG (träge).
 *
 * @param {'6h'|'12h'|'24h'|'7d'} [profile]
 */
export function getScorerConfig(profile = getActiveProfile()) {
    return (profile === '6h' || profile === '12h') ? SHORT_CONFIG : MEDIUM_CONFIG;
}

/**
 * Rückwärtskompatibilität: bestehender Code importiert SCORER_CONFIG direkt.
 * Bleibt der Mittelfrist-Pfad — Konsumenten, die Profil-Unterscheidung
 * brauchen, rufen explizit getScorerConfig(profile).
 */
export const SCORER_CONFIG = MEDIUM_CONFIG;

/** Eingefrorene Kopie — verhindert versehentliche Mutation. */
export function getConfig() {
    return getScorerConfig();
}
