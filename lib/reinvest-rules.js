/**
 * FORGE – Regeln für „Cleanup > Reinvest" (LIQ#000988), rein und ohne Seiteneffekte.
 *
 * Reinvest zahlt freies Wallet-USDC in eine BESTEHENDE, offene Position ein — den Pool mit dem
 * besten PnL oder dem besten Edge. Neue Positionen eröffnet es nie (Open-only-Regel, LIQ#000937).
 *
 * Diese Datei liegt in FORGE/lib/, weil sie von zwei Seiten gebraucht wird und in beiden
 * dasselbe gelten muss: der Bot (bots/liquidity/lib/cleanup-reinvest.js, bin/cleanup.js) und
 * die Settings-Route (bots/settings/routes/config.js, Validierung und Premium-Sperre).
 * Keine Imports außer Node-Bordmitteln — kein Bot-State, kein DB-Zugriff.
 *
 * Konzept: LIQ#000988, Abschnitt „Reinvest" im Cleanup-Konzept.
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REINVEST_MODES = Object.freeze(['off', 'pnl', 'edge']);

/** Kleinste zulässige Untergrenze (Festlegung 25.09.2026). */
export const REINVEST_MIN_FLOOR_USDC = 1;
export const REINVEST_DEFAULT_MIN_USDC = 10;
export const REINVEST_DEFAULT_MAX_USDC = 200;

/**
 * Fenster der beiden Kennzahlen, fest und unabhängig davon, welches Fenster der Nutzer in der
 * Opportunity-Tabelle gewählt hat (eine Browser-Einstellung darf keine Kapitalentscheidung des
 * Bots steuern). Beides 24h (Festlegung 25.09.2026): „Bester PnL (24h)“ vergleicht den PnL der
 * letzten 24 Stunden in PROZENT (`sharePnl24hPct`, die Spalte „PnL 24H“ der Operativen Metriken,
 * nicht absolute USDC: sonst gewönne immer der Pool mit dem meisten Kapital), „Bester Edge
 * (24h)“ die Edge-Prognose `npWindows['24h']`. Ein anderes Fenster ist eine Finanz-Parameter-
 * Entscheidung (siehe LIQ#000988) und ändert hier nur diese zwei Konstanten und die Beschriftung.
 */
export const REINVEST_EDGE_WINDOW = '24h';
export const REINVEST_PNL_WINDOW = Object.freeze({ id: '24h', ms: 24 * 3_600_000 });

/** Note-Präfix der Buchung; das Dashboard zeigt daran „Cleanup > Reinvest". */
export const REINVEST_NOTE_PREFIX = 'cleanup-reinvest';

/** Ältere data.json gilt als veraltet: der Bot schreibt sie je Zyklus (~5 Min). */
export const REINVEST_DATA_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Dashboard-Daten (vom Export geschrieben), gleiche Quelle wie die Opportunity-Tabelle.
 * `FORGE_LIQUIDITY_DATA_FILE` verlegt sie nur für Tests (Route und Cleanup gegen eine Attrappe).
 */
export const LIQUIDITY_DATA_FILE = process.env.FORGE_LIQUIDITY_DATA_FILE?.trim() || path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), '..', 'html', 'liquidity', 'data', 'data.json');

// ─── Konfiguration ────────────────────────────────────────────────────────────

/**
 * Prüft Modus und Grenzen. Wird von der Settings-Route (Schreiben) und vom Cleanup (Lesen)
 * benutzt, damit eine von Hand ungültig gesetzte .env den Bot nie zum Investieren bringt.
 *
 * @returns {{ok: true} | {ok: false, code: 'mode'|'number'|'min_floor'|'min_ge_max', message: string}}
 */
export function validateReinvestSettings({ mode, minUsdc, maxUsdc }) {
    if (!REINVEST_MODES.includes(mode)) {
        return { ok: false, code: 'mode', message: `Modus '${mode}' unbekannt (off|pnl|edge)` };
    }
    if (!Number.isFinite(minUsdc) || !Number.isFinite(maxUsdc)) {
        return { ok: false, code: 'number', message: 'Untergrenze und Obergrenze müssen Zahlen sein' };
    }
    if (minUsdc < REINVEST_MIN_FLOOR_USDC) {
        return { ok: false, code: 'min_floor', message: `Untergrenze mindestens ${REINVEST_MIN_FLOOR_USDC} USDC` };
    }
    if (minUsdc >= maxUsdc) {
        return { ok: false, code: 'min_ge_max', message: 'Untergrenze muss kleiner als die Obergrenze sein' };
    }
    return { ok: true };
}

/**
 * Liest die Reinvest-Einstellungen aus einem Env-Objekt (process.env oder geparste .env).
 * Fehlender Schlüssel = Deaktiviert. Ein ungültiger Wert schaltet auf Deaktiviert und wird
 * gemeldet — nie „irgendwie" investieren.
 *
 * @returns {{mode: 'off'|'pnl'|'edge', minUsdc: number, maxUsdc: number, invalid: string|null}}
 */
export function parseReinvestConfig(env = {}) {
    const rawMode = String(env.CLEANUP_REINVEST_MODE ?? 'off').trim().toLowerCase() || 'off';
    const minUsdc = env.CLEANUP_REINVEST_MIN_USDC == null || env.CLEANUP_REINVEST_MIN_USDC === ''
        ? REINVEST_DEFAULT_MIN_USDC : Number(env.CLEANUP_REINVEST_MIN_USDC);
    const maxUsdc = env.CLEANUP_REINVEST_MAX_USDC == null || env.CLEANUP_REINVEST_MAX_USDC === ''
        ? REINVEST_DEFAULT_MAX_USDC : Number(env.CLEANUP_REINVEST_MAX_USDC);
    if (rawMode === 'off') return { mode: 'off', minUsdc, maxUsdc, invalid: null };

    const v = validateReinvestSettings({ mode: rawMode, minUsdc, maxUsdc });
    if (!v.ok) return { mode: 'off', minUsdc, maxUsdc, invalid: v.message };
    return { mode: rawMode, minUsdc, maxUsdc, invalid: null };
}

// ─── Premium-Daten / Edge ─────────────────────────────────────────────────────

/**
 * Edge-Wert je Pool im Fenster `window`. Ein unzuverlässiges oder fehlendes Fenster zählt als
 * „kein Wert“ (null). Gemeinsam für die data.json (Cleanup, Settings) und das Ergebnis des
 * Edge-Providers (Export), damit beide Seiten denselben Wert sehen.
 *
 * @param {Iterable<{id: string, npWindows?: object, npUnreliableWindows?: string[]}>} pools
 * @returns {Object<string, number|null>}
 */
export function edgeValuesByPool(pools, window = REINVEST_EDGE_WINDOW) {
    const byPool = {};
    for (const p of pools ?? []) {
        const v = p?.npWindows?.[window];
        const unreliable = Array.isArray(p?.npUnreliableWindows) && p.npUnreliableWindows.includes(window);
        byPool[p.id] = (Number.isFinite(v) && !unreliable) ? v : null;
    }
    return byPool;
}

/** Premium-Daten liegen an: Herkunft compute/delivered und nicht veraltet. */
export const edgeIsPremium = (source, stale) => (source === 'compute' || source === 'delivered') && stale !== true;

/**
 * Liest Edge-Werte und Premium-Zustand aus der data.json des Dashboards — dieselbe Quelle wie
 * die Opportunity-Tabelle, damit der Nutzer jede Entscheidung dort nachvollziehen kann.
 *
 *   edgeSource 'compute'   → Master, rechnet selbst
 *   edgeSource 'delivered' → Fork mit gelieferten Premium-Daten
 *   edgeSource 'none'      → keine Premium-Daten → nicht verfügbar
 *
 * `available` verlangt zusätzlich: Edge nicht `stale` und data.json jünger als maxAgeMs.
 * Fehlen die Premium-Daten, ist Reinvest gesperrt (Premium-Funktion).
 *
 * @param {string} [dataFile]
 * @param {number} [nowMs]
 * @param {string} [window]  Edge-Fenster (npWindows-Schlüssel)
 * @returns {{available: boolean, reason: 'ok'|'no_file'|'unreadable'|'data_stale'|'no_premium'|'edge_stale',
 *            source: string|null, byPool: Object<string, number|null>}}
 */
export function readEdgeSnapshot(dataFile = LIQUIDITY_DATA_FILE, nowMs = Date.now(),
                                 window = REINVEST_EDGE_WINDOW, maxAgeMs = REINVEST_DATA_MAX_AGE_MS) {
    const out = (reason, source = null, byPool = {}) => ({ available: reason === 'ok', reason, source, byPool });
    let raw;
    try {
        statSync(dataFile);
    } catch {
        return out('no_file');
    }
    let d;
    try {
        raw = readFileSync(dataFile, 'utf8');
        d = JSON.parse(raw);
    } catch {
        return out('unreadable');
    }
    const source = d?.edgeSource ?? null;
    const ts = Date.parse(d?.timestamp ?? '');
    if (!Number.isFinite(ts) || nowMs - ts > maxAgeMs) return out('data_stale', source);
    if (source !== 'compute' && source !== 'delivered') return out('no_premium', source);
    if (d.edgeStale === true) return out('edge_stale', source);

    return out('ok', source, edgeValuesByPool(d.pools, window));
}

/**
 * Vorschau „in welchen Pool ginge Reinvest jetzt“ je Modus, vom Export in die data.json
 * geschrieben (`reinvestPreview`), für die Anzeige neben den Optionen im Reiter „Reinvest“.
 * null, wenn keine aktuellen Premium-Daten anliegen oder die Vorschau fehlt.
 *
 * @returns {{pnl: object|null, edge: object|null}|null}
 */
export function readReinvestPreview(dataFile = LIQUIDITY_DATA_FILE, nowMs = Date.now(), maxAgeMs = REINVEST_DATA_MAX_AGE_MS) {
    try {
        const d = JSON.parse(readFileSync(dataFile, 'utf8'));
        const ts = Date.parse(d?.timestamp ?? '');
        if (!Number.isFinite(ts) || nowMs - ts > maxAgeMs) return null;
        if (!edgeIsPremium(d?.edgeSource, d?.edgeStale)) return null;
        return d.reinvestPreview ?? null;
    } catch {
        return null;
    }
}

// ─── Auswahl des Zielpools ────────────────────────────────────────────────────

/**
 * „Gleicher Wert" heißt gleich auf der gespeicherten und angezeigten Genauigkeit:
 * PnL 24h auf 0,01 %-Punkte, Edge auf round2 je 1.000 USDC. Kein Toleranzband.
 */
const key = v => (Number.isFinite(v) ? Math.round(v * 100) : null);

/**
 * Wählt den Zielpool. Verglichen wird immer der AKTUELLE Wert.
 *
 *   Modus 'pnl':  Hauptkriterium PnL (≥ 0), bei Gleichstand höherer Edge.
 *   Modus 'edge': Hauptkriterium Edge (≥ 0), bei Gleichstand höherer PnL.
 *   Auch im zweiten Kriterium gleich (oder dort kein gültiger Wert bei allen Gleichplatzierten):
 *   niemand — Kapital bleibt liquide. Bei mehr als zwei Pools mit dem Höchstwert gilt dieselbe
 *   Regel unter allen; gewinnt nicht genau einer eindeutig, wird nichts investiert.
 *   Ein Pool ohne gültigen Zweitwert verliert gegen einen mit gültigem Zweitwert.
 *   Die ≥ 0-Bedingung gilt nur für das Hauptkriterium, der Zweitwert darf negativ sein.
 *
 * @param {{mode: 'pnl'|'edge', candidates: Array<{poolId: string, pnl: number|null, edge: number|null}>}} args
 * @returns {{target: object|null, reason: 'unique'|'tie_secondary'|'no_candidate'|'tie_unresolved',
 *            primary: 'pnl'|'edge', ranking: Array<object>}}
 */
export function selectReinvestTarget({ mode, candidates }) {
    const primary   = mode === 'edge' ? 'edge' : 'pnl';
    const secondary = primary === 'pnl' ? 'edge' : 'pnl';

    const ranking = candidates
        .map(c => ({ ...c, pk: key(c[primary]), sk: key(c[secondary]) }))
        .filter(c => c.pk != null)
        .sort((a, b) => b.pk - a.pk);

    const eligible = ranking.filter(c => c.pk >= 0);
    if (eligible.length === 0) return { target: null, reason: 'no_candidate', primary, ranking };

    const tops = eligible.filter(c => c.pk === eligible[0].pk);
    if (tops.length === 1) return { target: tops[0], reason: 'unique', primary, ranking };

    const withSecond = tops.filter(c => c.sk != null);
    if (withSecond.length === 0) return { target: null, reason: 'tie_unresolved', primary, ranking };
    const bestSk  = Math.max(...withSecond.map(c => c.sk));
    const winners = withSecond.filter(c => c.sk === bestSk);
    if (winners.length !== 1) return { target: null, reason: 'tie_unresolved', primary, ranking };
    return { target: winners[0], reason: 'tie_secondary', primary, ranking };
}

// ─── Aufruf von bin/deposit.js ────────────────────────────────────────────────

/**
 * Argumente für den Aufstock-Aufruf von bin/deposit.js. 🔒 Enthalten NIE `--new`: ohne
 * `--new` bricht deposit.js ohne offene Position ab, statt eine zu eröffnen. `--expect-position`
 * bindet den Aufruf zusätzlich an genau die Position, die der Cleanup gesehen hat — ist sie
 * inzwischen weg oder eine andere, bricht deposit.js vor dem ersten Swap ab.
 *
 * @returns {string[]} Argumente ohne Skriptpfad
 */
export function buildDepositArgs({ poolId, usdc, nftMint, note }) {
    if (!poolId || !nftMint) throw new Error('buildDepositArgs: poolId und nftMint sind Pflicht');
    if (!(usdc > 0)) throw new Error('buildDepositArgs: usdc muss > 0 sein');
    if (!String(note ?? '').startsWith(REINVEST_NOTE_PREFIX)) {
        throw new Error(`buildDepositArgs: note muss mit '${REINVEST_NOTE_PREFIX}' beginnen`);
    }
    const args = ['--pool', poolId, '--usdc', usdc.toFixed(2), '--expect-position', nftMint,
                  '--note', note, '--json'];
    if (args.includes('--new')) throw new Error('buildDepositArgs: --new ist für Reinvest verboten');
    return args;
}

/**
 * Text der Buchungs-Note: Modus, Kennzahl des gewählten Pools, bei Edge das Fenster, bei einer
 * Entscheidung per Gleichstandsregel ein Hinweis darauf. Dient dem Nutzer zur Nachvollziehbarkeit.
 */
export function formatReinvestNote({ mode, pnl, edge, tie }) {
    const sign = v => (v >= 0 ? '+' : '−');
    const num = (v, digits) => Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    let text;
    if (mode === 'edge') text = `Bester Edge (${REINVEST_EDGE_WINDOW}) ${sign(edge)}${num(edge / 10, 3)} %`;
    else                 text = `Bester PnL (${REINVEST_PNL_WINDOW.id}) ${sign(pnl)}${num(pnl, 3)} %`;
    if (tie) text += mode === 'edge' ? ', Gleichstand: PnL entschied' : ', Gleichstand: Edge entschied';
    return `${REINVEST_NOTE_PREFIX}: ${text}`;
}
