/**
 * FORGE – Effektiver Fee-Satz eines Orca-Pools (eine Quelle für alle Schätzer)
 *
 * ── Warum es diese Datei gibt ────────────────────────────────────────────────
 * Orca-Whirlpools mit `adaptiveFeeEnabled: true` erheben pro Swap **nicht** den in
 * `pools.json` hinterlegten `feeTier`, sondern die Basis **plus einen variablen
 * Aufschlag**, der mit der Kursvolatilität steigt und über `decayPeriod` (~10 Min)
 * wieder abklingt. Der konfigurierte `feeTier` ist damit nur die **Untergrenze**.
 *
 * Gemessen (Orca `stats.24h`, 2026-07-05 / 2026-09-08): ANSEM/SOL 2,12× des
 * konfigurierten Werts, Fartcoin/SOL 1,09×, whETH/SOL (Kontrolle, kein Adaptive Fee)
 * exakt 1,00×. Auch im Bestand liegen Pools über der Konstante: ZEC/USDC 0,176 %
 * statt 0,16 %, HYPE/SOL 0,318 % statt 0,30 %.
 *
 * Wer mit der Konstante rechnet, unterschätzt also systematisch — bei
 * `bin/estimate-costs.js` (nach CLAUDE.md **Pflicht** vor jeder Finanzaktion) am
 * stärksten genau dann, wenn die Volatilität hoch ist, also genau dann, wenn ein
 * Rebalancing am wahrscheinlichsten ausgelöst wird.
 *
 * 🔒 **Eine Regel, ein Ort.** Der Fee-Satz wird an sechs Stellen gebraucht
 * (estimate-costs, Range Advisor inkl. Rebalance-Kostenmodell, Economic Scorer
 * ×2, Dashboard-APR ×2). Sechs Kopien liefen unweigerlich auseinander — selbe
 * Begründung wie bei `lib/pnl.js` und `lib/fee-plausibility.js`.
 *
 * ── Zwei Quellen, zwei Zwecke ────────────────────────────────────────────────
 * 1. **24h-Ist-Satz** `fees24hUsd / volume24hUsd` — für laufende Schätzungen
 *    (APR, Score, Range-Empfehlung). Kostet keinen zusätzlichen API-Call: die
 *    beiden Werte holt der Bot pro Zyklus ohnehin (`_getOrcaV2Stats`) und legt sie
 *    in `pool_stats.fees_24h_usd` / `volume_24h_usd` ab.
 * 2. **Momentanwert** `feeRate + adaptiveFee.currentRate` — für die
 *    Kostenschätzung unmittelbar vor einer Aktion. Ein 24h-Schnitt glättet genau
 *    den akuten Spike weg, der in diesem Moment zählt.
 *
 * Für die Kostenschätzung wird das **Maximum** beider genommen (`costFeePct`):
 * `currentRate` ist ein Snapshot des letzten Swaps und klingt zwischen Swaps ab,
 * kann also unter dem liegen, was unser eigener Swap tatsächlich auslöst. Eine zu
 * hohe Kostenschätzung kostet nichts, eine zu niedrige ist der dokumentierte Schaden.
 *
 * ── Einheiten ────────────────────────────────────────────────────────────────
 * Nach außen rechnet FORGE durchgehend in **Prozent** (`feeTier: 0.16` = 0,16 %).
 * Orcas API liefert Millionstel (`feeRate: 1600`), deshalb `/ 10_000`.
 */

/** Orca-Rate → Prozent: `feeRate: 1600` = 0,16 %. */
export const ORCA_RATE_PER_PCT = 10_000;

/**
 * Unter diesem 24h-Volumen wird der Ist-Satz nicht verwendet.
 * Bei dünnem Handel ist `fees/volume` überwiegend Rundung: SPYX/USDC zeigte bei
 * 10.179 USD Volumen 0,0205 % gegen einen 0,01-%-Tier (2,05×) — absolut 0,01
 * Prozentpunkte, also Rauschen, kein Aufschlag.
 */
export const MIN_VOLUME_24H_USD = 5_000;

/**
 * Obergrenze des Aufschlags in Prozentpunkten. Orcas `maxRate: 100000` entspricht
 * Basis + 10 Prozentpunkte; alles darüber ist ein Datenfehler, kein Marktzustand.
 */
export const MAX_ADAPTIVE_SURCHARGE_PCT = 10;

/**
 * Klemmt einen gemessenen Satz auf das physikalisch mögliche Fenster
 * [Basis, Basis + 10 Prozentpunkte]. Unterhalb der Basis kann ein Pool nicht
 * abrechnen — ein kleinerer Messwert ist Timing-Versatz zwischen `fees` und
 * `volume`, kein Rabatt.
 */
function clampToFeeWindow(measuredPct, basePct) {
    const upper = basePct + MAX_ADAPTIVE_SURCHARGE_PCT;
    if (measuredPct < basePct) return basePct;
    if (measuredPct > upper)   return upper;
    return measuredPct;
}

/**
 * Effektiver Fee-Satz aus dem 24h-Fenster — für laufende Schätzungen.
 *
 * @param {number|null|undefined} staticPct  Konfigurierter feeTier in % (Untergrenze)
 * @param {Object} [stats]
 * @param {number|null} [stats.fees24hUsd]    Pool-Fees der letzten 24 h (USD)
 * @param {number|null} [stats.volume24hUsd]  Pool-Volumen der letzten 24 h (USD)
 * @returns {{ pct: number|null, source: 'stats24h'|'static'|'none', ratio: number|null }}
 *          `pct` in Prozent; `ratio` = gemessen ÷ konfiguriert (nur bei 'stats24h').
 */
export function effectiveFeePct(staticPct, stats = {}) {
    const basePct = Number.isFinite(staticPct) ? staticPct : null;
    const fees    = stats.fees24hUsd;
    const volume  = stats.volume24hUsd;

    const usable = basePct != null
        && Number.isFinite(fees)   && fees   > 0
        && Number.isFinite(volume) && volume >= MIN_VOLUME_24H_USD;

    if (!usable) {
        return { pct: basePct, source: basePct != null ? 'static' : 'none', ratio: null };
    }

    const measuredPct = (fees / volume) * 100;
    const pct         = clampToFeeWindow(measuredPct, basePct);

    return { pct, source: 'stats24h', ratio: basePct > 0 ? measuredPct / basePct : null };
}

/**
 * Momentaner Fee-Satz aus einer Orca-v2-Pool-Antwort (`json.data`) —
 * Basis + aktueller Adaptive-Fee-Aufschlag.
 *
 * @param {Object|null} data       `data`-Objekt der Orca-v2-Pool-Antwort
 * @param {number|null} [fallbackStaticPct]  feeTier aus der Konfiguration, falls die
 *                                           Antwort keinen `feeRate` enthält
 * @returns {{ pct: number|null, source: 'live'|'static'|'none',
 *             basePct: number|null, surchargePct: number, adaptive: boolean }}
 */
export function liveFeePct(data, fallbackStaticPct = null) {
    const rawRate = data?.feeRate;
    const basePct = Number.isFinite(rawRate) ? rawRate / ORCA_RATE_PER_PCT
                  : Number.isFinite(fallbackStaticPct) ? fallbackStaticPct
                  : null;

    if (basePct == null) {
        return { pct: null, source: 'none', basePct: null, surchargePct: 0, adaptive: false };
    }

    const adaptive    = data?.adaptiveFeeEnabled === true;
    const currentRate = data?.adaptiveFee?.currentRate;
    if (!adaptive || !Number.isFinite(currentRate) || currentRate <= 0) {
        return {
            pct: basePct,
            source: data?.feeRate != null ? 'live' : 'static',
            basePct, surchargePct: 0, adaptive,
        };
    }

    const surchargePct = Math.min(currentRate / ORCA_RATE_PER_PCT, MAX_ADAPTIVE_SURCHARGE_PCT);
    return { pct: basePct + surchargePct, source: 'live', basePct, surchargePct, adaptive };
}

/**
 * Fee-Satz für eine **Kostenschätzung** — das Maximum aus Momentanwert und
 * 24h-Ist-Satz (Begründung im Dateikopf).
 *
 * @param {number|null} staticPct  Konfigurierter feeTier in %
 * @param {Object|null} data       `data` der Orca-v2-Pool-Antwort (optional)
 * @param {Object} [stats]         { fees24hUsd, volume24hUsd } (optional)
 * @returns {{ pct: number|null, source: 'live'|'stats24h'|'static'|'none',
 *             basePct: number|null, live: Object, avg24h: Object }}
 */
export function costFeePct(staticPct, data = null, stats = {}) {
    const live   = liveFeePct(data, staticPct);
    const avg24h = effectiveFeePct(live.basePct ?? staticPct, stats);

    const candidates = [
        { pct: live.pct,   source: live.source   },
        { pct: avg24h.pct, source: avg24h.source },
    ].filter(c => Number.isFinite(c.pct));

    if (candidates.length === 0) {
        return { pct: null, source: 'none', basePct: live.basePct ?? null, live, avg24h };
    }

    const best = candidates.reduce((a, b) => (b.pct > a.pct ? b : a));
    return { pct: best.pct, source: best.source, basePct: live.basePct ?? staticPct ?? null, live, avg24h };
}

/**
 * Ist der effektive Satz nennenswert höher als der konfigurierte? Nur dann lohnt
 * der Zusatz „adaptiv, Basis …" in einer Ausgabe — sonst wäre er in jeder Zeile
 * der Kostenschätzung reines Rauschen. Die 2-%-Toleranz fängt den Timing-Versatz
 * zwischen `fees` und `volume` ab: Pools ohne Adaptive Fee messen 1,000–1,012×,
 * echte Aufschläge liegen darüber (ZEC/USDC 1,10×, HYPE/SOL 1,06×).
 *
 * Die Textausgabe selbst bleibt beim Aufrufer: die CLI übersetzt sie über `lib/i18n.js`.
 */
export function isAdaptiveSurcharge(pct, basePct) {
    return Number.isFinite(pct) && Number.isFinite(basePct) && pct > basePct * 1.02;
}
