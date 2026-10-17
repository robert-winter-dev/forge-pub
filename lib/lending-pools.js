// ══════════════════════════════════════════════════════════════════════════════
// FORGE – Zentrales Pool-Register des LendingBots (LEN#001365)
// ══════════════════════════════════════════════════════════════════════════════
// EINE Quelle der Wahrheit für die Stammdaten jedes Lending-Pools. Daten liegen in
// config/lending-pools.json, dieses Modul ist der einzige Zugriff darauf (Vorbild:
// lib/bot-registry.js). Zustandsmodell: siehe pool-register.md im Lending-Bot-Ordner
// der Projektdokumentation.
//
// 🔒 Der Zustand ist bewusst NICHT `poolEnabled` (settings.db): Ein per poolEnabled
// deaktivierter Pool zählt im Bot-Tick nicht mehr zum Positionswert. Ein ausgelaufener
// Pool mit Guthaben muss weiter zählen, sonst sieht der Nutzer einen Verlust, den es
// nicht gibt. Das Register entscheidet deshalb nur über Einzahlung, Abfrage und
// Sichtbarkeit, nie über den Positionswert.
//
// 🔒 Ein Pool mit Guthaben bleibt immer abgefragt und sichtbar, egal was im Register
// steht: Sonst wäre der Auszahlungsweg weg.
//
// import { isDepositAllowed, shouldQuery, isVisible } from '<relativ>/lib/lending-pools.js';
// ══════════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_PATH = path.resolve(__dirname, '..', 'config', 'lending-pools.json');

export const STATES       = Object.freeze(['aktiv', 'einzahlung_zu', 'ausgelaufen', 'entfernt']);
export const TYPES        = Object.freeze(['kamino', 'jupiter', 'loopscale']);
export const VISIBILITIES = Object.freeze(['immer', 'bei_position', 'nie']);
export const SURFACES     = Object.freeze(['metriken', 'settings']);
export const TVL_TRENDS   = Object.freeze(['steigend', 'nicht_fallend', 'egal']);
// Warum ein Pool ausgelaufen ist; bestimmt den Text der täglichen Auszahlungsempfehlung.
export const RETIRE_REASONS = Object.freeze(['liquiditaet', 'tvl', 'schnittstelle']);

// Vorgaben des Prüf-Felds für den Pool-Advisor (LEN#001366). Vorschlag, kein gesetzter
// Finanz-Parameter: Sie greifen erst, wenn ein Pool im Register einen Block `pruefung`
// trägt, und den setzt der Betreiber. Derselbe Block gilt in beide Richtungen
// (bots/lending/lib/len-pool-advisor.js):
//   ausgelaufen           → Erholung: `zeitraumTage` lang jeder Tag über den Schwellen
//   aktiv / einzahlung_zu → Ausfall:  `ausfallTage` lang jeder Tag unter einer Schwelle
// Gemessen wird täglich; `intervallTage` ist der Wiederholungsschutz nach einem Ticket.
export const PROBE_DEFAULTS = Object.freeze({
    intervallTage:      30,
    zeitraumTage:       14,
    ausfallTage:        3,
    minLiquiditaetUsd:  100_000,
    minTvlUsd:          100_000,
    tvlTrend:           'nicht_fallend',
    // Ausfall-Prüfung: Messwerte vor diesem Tag (YYYY-MM-DD) gelten als nicht gemessen.
    // Für Pools, deren Historie nachweislich falsch ist (Kamino bis 13.10.2026, LEN#001367).
    messwerteAb:        null,
});

const DEFAULT_COLOR   = '#94a3b8';
const DEFAULT_FEE_SOL = 0.000005;

const ADDRESS_FIELDS = { kamino: ['market', 'reserve'], jupiter: [], loopscale: ['address'] };

function defaultVisibility(state) {
    if (state === 'ausgelaufen') return 'bei_position';
    if (state === 'entfernt')    return 'nie';
    return 'immer';
}

function fail(id, msg) {
    throw new Error(`lending-pools: Pool "${id}": ${msg} (config/lending-pools.json)`);
}

function isPositiveNumber(v) {
    return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** Prüft einen Block `pruefung` und füllt fehlende Felder mit PROBE_DEFAULTS. */
function normalizeProbe(id, raw) {
    if (raw == null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) fail(id, 'pruefung muss ein Objekt sein');
    const unknown = Object.keys(raw).filter(k => !(k in PROBE_DEFAULTS));
    if (unknown.length) fail(id, `pruefung: unbekanntes Feld ${unknown.join(', ')}`);
    const probe = { ...PROBE_DEFAULTS, ...raw };
    for (const field of ['intervallTage', 'zeitraumTage', 'ausfallTage']) {
        if (!Number.isInteger(probe[field]) || probe[field] < 1) {
            fail(id, `pruefung.${field} muss eine ganze Zahl ab 1 sein`);
        }
    }
    for (const field of ['minLiquiditaetUsd', 'minTvlUsd']) {
        if (typeof probe[field] !== 'number' || !Number.isFinite(probe[field]) || probe[field] < 0) {
            fail(id, `pruefung.${field} muss eine Zahl ab 0 sein`);
        }
    }
    if (probe.messwerteAb !== null
        && (typeof probe.messwerteAb !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(probe.messwerteAb)
            || Number.isNaN(Date.parse(probe.messwerteAb)))) {
        fail(id, 'pruefung.messwerteAb muss ein Datum YYYY-MM-DD sein');
    }
    if (!TVL_TRENDS.includes(probe.tvlTrend)) {
        fail(id, `pruefung.tvlTrend muss eines von ${TVL_TRENDS.join(' | ')} sein`);
    }
    return Object.freeze(probe);
}

function normalizePool(id, raw) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(id, 'ID nur aus Kleinbuchstaben, Ziffern und Bindestrich');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(id, 'Eintrag muss ein Objekt sein');
    if (typeof raw.label !== 'string' || !raw.label.trim()) fail(id, 'label fehlt');
    if (!TYPES.includes(raw.typ)) fail(id, `typ muss eines von ${TYPES.join(' | ')} sein`);
    if (!STATES.includes(raw.zustand)) fail(id, `zustand muss eines von ${STATES.join(' | ')} sein`);
    for (const field of ADDRESS_FIELDS[raw.typ]) {
        if (typeof raw[field] !== 'string' || !raw[field].trim()) fail(id, `${field} fehlt (typ ${raw.typ})`);
    }
    if (raw.feeSol != null && !isPositiveNumber(raw.feeSol)) fail(id, 'feeSol muss eine positive Zahl sein');

    const sichtbarRaw = raw.sichtbar ?? {};
    if (typeof sichtbarRaw !== 'object' || Array.isArray(sichtbarRaw)) fail(id, 'sichtbar muss ein Objekt sein');
    const sichtbar = {};
    for (const surface of SURFACES) {
        const value = sichtbarRaw[surface] ?? defaultVisibility(raw.zustand);
        if (!VISIBILITIES.includes(value)) {
            fail(id, `sichtbar.${surface} muss eines von ${VISIBILITIES.join(' | ')} sein`);
        }
        sichtbar[surface] = value;
    }
    const unknownSurface = Object.keys(sichtbarRaw).filter(k => !SURFACES.includes(k));
    if (unknownSurface.length) fail(id, `sichtbar: unbekanntes Feld ${unknownSurface.join(', ')}`);

    let hinweis = null;
    if (raw.hinweis != null) {
        const { titel, text } = raw.hinweis;
        if (typeof titel !== 'string' || typeof text !== 'string') {
            fail(id, 'hinweis braucht titel und text (i18n-Schlüssel)');
        }
        hinweis = Object.freeze({ titel, text });
    }

    if (raw.grund != null && !RETIRE_REASONS.includes(raw.grund)) {
        fail(id, `grund muss eines von ${RETIRE_REASONS.join(' | ')} sein`);
    }

    return Object.freeze({
        id,
        label:    raw.label,
        typ:      raw.typ,
        market:   raw.market  ?? null,
        reserve:  raw.reserve ?? null,
        address:  raw.address ?? null,
        farbe:    raw.farbe   ?? DEFAULT_COLOR,
        feeSol:   raw.feeSol  ?? DEFAULT_FEE_SOL,
        cooldown: raw.cooldown ?? false,
        hinweis,
        zustand:  raw.zustand,
        grund:    raw.grund ?? null,
        sichtbar: Object.freeze(sichtbar),
        pruefung: normalizeProbe(id, raw.pruefung),
    });
}

/**
 * Baut ein Register aus dem Inhalt von config/lending-pools.json. Eigene Fabrik, damit
 * Tests einen Pool ergänzen können, ohne die Datei anzufassen.
 *
 * @param {{pools: Record<string, object>}} raw
 */
export function createPoolRegistry(raw) {
    if (!raw || typeof raw.pools !== 'object' || raw.pools === null || Array.isArray(raw.pools)) {
        throw new Error('lending-pools: "pools" fehlt (config/lending-pools.json)');
    }
    const pools = new Map(Object.entries(raw.pools).map(([id, entry]) => [id, normalizePool(id, entry)]));
    const norm  = id => String(id ?? '').toLowerCase();

    /** @returns {object|null} Eintrag, auch für entfernte Pools (Namen in der Historie) */
    const getPool = id => pools.get(norm(id)) ?? null;

    /** Alle Pools, die es für den Betrieb noch gibt (alles außer `entfernt`). */
    const listPools = () => [...pools.values()].filter(p => p.zustand !== 'entfernt');

    /** Wirklich alle, auch entfernte: für Schutzlisten, die nie schrumpfen dürfen. */
    const listAllPools = () => [...pools.values()];

    const isKnown = id => { const p = getPool(id); return !!p && p.zustand !== 'entfernt'; };

    /** Anzeigename; unbekannte IDs (alte Transaktionen) kommen unverändert zurück. */
    const poolLabel = id => getPool(id)?.label ?? String(id ?? '');

    /** Einzahlen, Verschieben hinein, Auto-Deploy: nur im Zustand `aktiv`. */
    const isDepositAllowed = id => getPool(id)?.zustand === 'aktiv';

    /** Pool nimmt keine Einzahlungen mehr an (bekannter Pool, aber nicht `aktiv`). */
    const isDepositClosed = id => { const p = getPool(id); return !!p && p.zustand !== 'aktiv'; };

    const isRetired = id => getPool(id)?.zustand === 'ausgelaufen';

    /**
     * Soll der Bot APY/TVL/Position dieses Pools abfragen?
     * `ausgelaufen` nur mit Guthaben, `entfernt` nie.
     */
    const shouldQuery = (id, { hasPosition = false } = {}) => {
        const p = getPool(id);
        if (!p || p.zustand === 'entfernt') return false;
        if (p.zustand === 'ausgelaufen') return !!hasPosition;
        return true;
    };

    /**
     * Erscheint der Pool in der Tabelle "Pool Metriken" bzw. in der Settings-Pool-Liste?
     * Mit Guthaben immer (außer `entfernt`, dort kann es keins geben).
     *
     * @param {string} id
     * @param {'metriken'|'settings'} surface
     */
    const isVisible = (id, surface, { hasPosition = false } = {}) => {
        if (!SURFACES.includes(surface)) throw new Error(`lending-pools: unbekannte Fläche "${surface}"`);
        const p = getPool(id);
        if (!p || p.zustand === 'entfernt') return false;
        if (hasPosition) return true;
        return p.sichtbar[surface] === 'immer';
    };

    /**
     * Zählt eine gemeldete Position zum Positionswert? Für jeden Pool, den es noch
     * gibt: ja. Steht hier als eigene Funktion, damit ein Test die Zusage festhält,
     * dass der Zustand den Wert nie anfasst.
     */
    const countsToPositionValue = id => isKnown(id);

    /** Prüf-Einstellung des Erholungs-Advisors; null = wird nie geprüft. */
    const probeConfig = id => {
        const p = getPool(id);
        return p?.zustand === 'ausgelaufen' ? p.pruefung : null;
    };

    /** Pools, die der Erholungs-Advisor überhaupt ansehen darf. */
    const listProbePools = () => listPools().filter(p => probeConfig(p.id) !== null);

    /** Ausfall-Überwachung eines Pools im Angebot; null = wird nie überwacht. */
    const watchConfig = id => {
        const p = getPool(id);
        return p && (p.zustand === 'aktiv' || p.zustand === 'einzahlung_zu') ? p.pruefung : null;
    };

    /** Pools im Angebot, die der Advisor auf Ausfall überwacht. */
    const listWatchPools = () => listPools().filter(p => watchConfig(p.id) !== null);

    /** Warum der Pool ausgelaufen ist (RETIRE_REASONS) oder null. */
    const retireReason = id => {
        const p = getPool(id);
        return p?.zustand === 'ausgelaufen' ? p.grund : null;
    };

    const listByType = typ => [...pools.values()].filter(p => p.typ === typ);

    /**
     * Stammdaten fürs Dashboard (geht über data.json, das Dashboard liest das Register
     * nicht selbst). Enthält auch entfernte Pools: alte Transaktionen brauchen den Namen.
     *
     * @param {(id: string) => boolean} hasPosition
     */
    const dashboardPools = (hasPosition = () => false) => Object.fromEntries(
        [...pools.values()].map(p => {
            const pos = !!hasPosition(p.id);
            return [p.id, {
                label:     p.label,
                color:     p.farbe,
                state:     p.zustand,
                note:      p.hinweis,
                inMetrics: isVisible(p.id, 'metriken', { hasPosition: pos }),
                queried:   shouldQuery(p.id, { hasPosition: pos }),
            }];
        })
    );

    return Object.freeze({
        getPool, listPools, listAllPools, listByType, isKnown, poolLabel,
        isDepositAllowed, isDepositClosed, isRetired,
        shouldQuery, isVisible, countsToPositionValue,
        probeConfig, listProbePools, watchConfig, listWatchPools, retireReason, dashboardPools,
    });
}

const registry = createPoolRegistry(JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')));

export const {
    getPool, listPools, listAllPools, listByType, isKnown, poolLabel,
    isDepositAllowed, isDepositClosed, isRetired,
    shouldQuery, isVisible, countsToPositionValue,
    probeConfig, listProbePools, watchConfig, listWatchPools, retireReason, dashboardPools,
} = registry;

export default registry;
