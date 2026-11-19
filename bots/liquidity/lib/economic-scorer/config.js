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
 * Konsumenten (cleanup.js, pool-explorer.js) lesen
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
        // klar negativer Bilanz (-500 %) sollen im Tier "withdraw" landen.
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

import { readFileSync, writeFileSync, renameSync, statSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIME_WINDOW_IDS } from '../../../../html/js/time-windows.js';

// Strategie-Werte = die zentralen Zeitfenster 4h/24h/7d (LIQ#002040, Mapping
// freigegeben 18.11.2026). Ältere Werte werden beim Lesen umgedeutet und beim Bot-Start
// per migrateProfileInEnv() in die .env zurückgeschrieben. Jede Zuordnung behält die
// Scorer-Config, die der alte Wert hatte (6h/12h → SHORT_CONFIG, 24h/7d → MEDIUM_CONFIG).
const VALID_PROFILES = TIME_WINDOW_IDS;
export const LEGACY_PROFILE_MAP = Object.freeze({
    '6h': '4h', '12h': '4h', short: '4h',   // vor LIQ#002040 bzw. vor 2026-05-21
    medium: '24h',
});
const DEFAULT_PROFILE = '24h';

// Hot-Reload: PROFILE wird direkt aus .env gelesen statt aus process.env, damit
// ein Profil-Wechsel via ForgeSettings ohne Bot-Restart wirksam wird.
// TTL-Cache (5 s) verhindert dass die Tier-Bewertung bei N Pools pro
// Bot-Zyklus N Filesystem-Reads auslöst — bei 5-Min-Bot-Loop wird die Datei
// in der Praxis einmal pro Loop gelesen.
const _ENV_PATH        = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');
const _PROFILE_CACHE_TTL_MS = 5_000;
let _cachedProfile     = null;
let _cachedAt          = 0;
let _lastWarnedRaw     = null;   // Anti-Spam für „unbekanntes PROFILE"-Warnung

// Akzeptiert PROFILE=short, PROFILE='short', PROFILE="short", auch mit Whitespace
const _PROFILE_LINE_RE = /^\s*PROFILE\s*=\s*['"]?([^'"#\r\n]*)['"]?\s*$/m;

/** Rohwert → gültiges Profil (4h/24h/7d); unbekannt → null. */
export function normalizeProfile(raw) {
    const v = String(raw ?? '').trim().toLowerCase();
    if (!v) return DEFAULT_PROFILE;
    if (VALID_PROFILES.includes(v)) return v;
    return LEGACY_PROFILE_MAP[v] ?? null;
}

function _readProfileFromEnv(envPath = _ENV_PATH) {
    let raw = null;
    try {
        const content = readFileSync(envPath, 'utf8');
        const m = content.match(_PROFILE_LINE_RE);
        if (m) raw = m[1].trim().toLowerCase();
    } catch {
        // Datei nicht lesbar → Fallback auf process.env (z.B. systemd-Env ohne .env)
        raw = (process.env.PROFILE ?? '').trim().toLowerCase();
    }
    const profile = normalizeProfile(raw);
    if (profile == null) {
        if (raw !== _lastWarnedRaw) {
            console.warn(`[scorer-config] PROFILE='${raw}' unbekannt — falle zurück auf '${DEFAULT_PROFILE}'`);
            _lastWarnedRaw = raw;
        }
        return DEFAULT_PROFILE;
    }
    return profile;
}

/**
 * Schreibt einen alten PROFILE-Wert (6h/12h/short/medium) als neuen Wert in die .env
 * (LIQ#002040). Läuft beim Bot-Start; idempotent. Nur die PROFILE-Zeile ändert sich, der
 * Rest der Datei bleibt byteweise gleich. Atomar über Temp-Datei + rename, Rechte bleiben.
 * Unbekannte oder fehlende Werte werden nicht angefasst.
 * @returns {{ changed: boolean, from?: string, to?: string }}
 */
export function migrateProfileInEnv(envPath = _ENV_PATH) {
    let content;
    try { content = readFileSync(envPath, 'utf8'); } catch { return { changed: false }; }
    const m = content.match(_PROFILE_LINE_RE);
    if (!m) return { changed: false };
    const from = m[1].trim().toLowerCase();
    const to = LEGACY_PROFILE_MAP[from];
    if (!to) return { changed: false };
    const next = content.replace(_PROFILE_LINE_RE, line => line.replace(m[1], m[1].replace(m[1].trim(), to)));
    const tmp = `${envPath}.tmp-${process.pid}`;
    const mode = statSync(envPath).mode & 0o777;
    writeFileSync(tmp, next, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, envPath);
    _cachedProfile = null;
    return { changed: true, from, to };
}

/**
 * Liefert das aktive Profil, gelesen aus Liquidity Bot/.env (mit 5 s
 * TTL-Cache). Hot-Reload: Änderungen werden ohne Bot-Restart spätestens
 * 5 s später wirksam.
 *
 * Fallback-Kette:
 *   .env-Datei nicht lesbar → process.env.PROFILE → '24h'
 *
 * Ein Profil-Wechsel mid-flight beeinflusst keine bereits laufenden Exit-Ausführungen
 * (die nutzen ihren config_snapshot zur Wiederaufnahme).
 *
 * Rückgabewert seit LIQ#002040: '4h' | '24h' | '7d'
 * (ältere Werte werden in _readProfileFromEnv über LEGACY_PROFILE_MAP umgedeutet.)
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
 * Mapping: 4h → SHORT_CONFIG (reaktiv), 24h/7d → MEDIUM_CONFIG (träge). Die alten Werte
 * 6h/12h bleiben auf SHORT_CONFIG, falls ein Aufrufer sie noch direkt übergibt.
 * ⚠️ 'short' liefert weiterhin MEDIUM_CONFIG: So verhält es sich seit 2026-05-21, und das
 * Umstellen wäre eine Verhaltensänderung (KB Liquidity Bot/time-windows.md, „Fund am Rand“).
 *
 * @param {'4h'|'24h'|'7d'|'short'|'medium'} [profile]
 */
const _SHORT_PROFILES = new Set(['4h', '6h', '12h']);
export function getScorerConfig(profile = getActiveProfile()) {
    return _SHORT_PROFILES.has(profile) ? SHORT_CONFIG : MEDIUM_CONFIG;
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
