/**
 * FORGE Liquidity – Range Advisor
 *
 * Empfiehlt die optimale Range-Breite (±%) für eine CLMM-Position.
 * Berücksichtigt: Volatilität (σ), Trend (EMA 10/20/30), Wirtschaftlichkeit
 * (Break-Even-Kapital), historische Rebalance-Frequenz und Pool-Klasse.
 *
 * Dieses Modul ist der zentrale Berater für alle Range-Entscheidungen.
 * Es wird von anderen Scripten verwendet — keine eigene Range-Logik dort:
 *   - deposit.js / bot._openNewPosition()  → Range beim Öffnen
 *   - bot._doRebalance()                   → Range beim Rebalancing
 *   - bin/range-advisor.js                 → CLI für manuelle Analyse
 *
 * Explizit ausgeschlossen: cbBTC/WBTC (festes Range-Override, anderes Kostenmodell).
 */

const ORCA_V2_BASE = 'http://127.0.0.1:3100/orcav2';

// ─── Modell-Parameter ────────────────────────────────────────────────────────

const SWAP_COST_USDC       = 0.5;   // USDC pro Rebalancing (TX-Fee + Slippage)
const TIME_IN_RANGE_FACTOR = 0.85;  // Schätzung: Position nicht 100% der Zeit aktiv
const POOL_LIQ_SPREAD_PCT  = 10;    // Annahme: Pool-Liquidität über ±10% verteilt
const MIN_PRICE_POINTS     = 48;    // Mindest-DB-Einträge für verlässliche σ/EMA-Werte
const MIN_DRIFT_EVENTS     = 3;     // Mindest-Rebalances (mit echtem Kapital) für driftFactor-Korrektur,
                                    // sonst neutraler Random-Walk (driftFactor=1). Bei Datenarmut
                                    // (taktische Kurzfrist-Pools) ist eine Korrektur reines Rauschen.
const MIN_REAL_CAPITAL_USDC = 50;   // Rebalances unter diesem LP-Wert gelten als Staub und zählen
                                    // weder für driftFactor noch für die empirische Kostenschätzung.
const MAX_DWELL_GAP_MS     = 14 * 24 * 3_600_000; // Max. plausible Verweildauer zwischen zwei
                                    // Rebalances für die driftFactor-Schätzung. Längere Intervalle
                                    // enthalten vermutlich eine kapitallose Lücke (Withdraw/Redeposit)
                                    // und würden die Rate verfälschen → ausgeschlossen.

// Range-Breiten die ausgewertet werden (±%)
export const CANDIDATE_RANGES = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30];

// Markt-Referenzwerte und Grenzen je Pool-Typ (poolType aus pools.json).
// Einziges Klassifizierungssystem für Range-Advisor UND NP-Qualitätsprüfung (#0228).
// Werte hergeleitet aus 30-Tage-pool_stats-Schwankung je Typ:
//   min/max        – engste/breiteste Kandidaten-Range (±%)
//   ref            – Orca-Referenzwert (nur Anzeige)
//   volaDefault    – Stunden-Sigma-Fallback, nur wenn DB-Preisdaten fehlen (Notfall)
//   liqSpreadPct   – angenommene Breite der Pool-Liquiditätsverteilung (±%) → NP-myShare
//   skipMaeAlert   – NP-MAE-Alert unterdrücken (bei wilden Pools ist Abweichung by design)
export const POOL_TYPE_CONFIG = {
    rebalance_free: { min: 0.3, ref:  1.0, max:  3.0, volaDefault: 0.05, liqSpreadPct: 1.5, skipMaeAlert: false },
    volatil_1:      { min: 3.0, ref: 10.0, max: 30.0, volaDefault: 0.45, liqSpreadPct: 10,  skipMaeAlert: false },
    volatil_2:      { min: 4.0, ref: 15.0, max: 30.0, volaDefault: 1.0,  liqSpreadPct: 10,  skipMaeAlert: true  },
    volatil_3:      { min: 6.0, ref: 20.0, max: 30.0, volaDefault: 2.0,  liqSpreadPct: 10,  skipMaeAlert: true  },
    rwa:            { min: 3.0, ref: 15.0, max: 30.0, volaDefault: 1.6,  liqSpreadPct: 10,  skipMaeAlert: true  },
};

// ─── Pool-Typ-Konfiguration ──────────────────────────────────────────────────

/**
 * Liefert die Typ-Konfiguration für einen Pool. Einziger Zugriffspfad — kein
 * Fallback, keine Alt-Klassifizierung (#0228). Ein fehlender/unbekannter poolType
 * ist ein Konfig-Fehler in pools.json und schlägt bewusst laut fehl.
 * @param {Object} pool  Pool-Konfiguration aus pools.json (mit poolType)
 * @returns {{min:number, ref:number, max:number, volaDefault:number, liqSpreadPct:number, skipMaeAlert:boolean}}
 */
export function getPoolTypeConfig(pool) {
    const cfg = pool?.poolType && POOL_TYPE_CONFIG[pool.poolType];
    if (!cfg) {
        throw new Error(
            `[pool-type] Pool ${pool?.id ?? '?'} hat fehlenden/unbekannten poolType: ${pool?.poolType}. ` +
            `Erlaubt: ${Object.keys(POOL_TYPE_CONFIG).join(', ')}`
        );
    }
    return cfg;
}

// ─── Mathematik-Helfer ───────────────────────────────────────────────────────

function ema(prices, period) {
    if (prices.length === 0) return null;
    const k = 2 / (period + 1);
    let e = prices[0];
    for (let i = 1; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
    return e;
}

function stddev(arr) {
    if (arr.length < 2) return 0;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length);
}

// ─── Preis-Daten aus DB ──────────────────────────────────────────────────────

/**
 * Liest stündliche Preisserie aus pool_stats (chronologisch, älteste zuerst).
 * @param {Database} db
 * @param {string}   poolId
 * @param {number}   hours   Lookback-Fenster (Default: 168h = 7 Tage)
 * @returns {number[]}
 */
function getPriceHistory(db, poolId, hours = 168) {
    const since = Date.now() - hours * 3_600_000;
    return db.prepare(`
        SELECT price FROM pool_stats
        WHERE pool_id = ? AND price > 0 AND recorded_at >= ?
        ORDER BY recorded_at ASC
    `).all(poolId, since).map(r => r.price);
}

// ─── Trend-Analyse ───────────────────────────────────────────────────────────

/**
 * Bewertet den Preistrend anhand von EMA 10/20/30.
 * @param {number[]} prices  Chronologische Preisserie
 * @returns {{ direction: 'up'|'down'|'sideways', strength: number, ema10: number|null, ema20: number|null, ema30: number|null, dataPoints: number }}
 */
export function assessTrend(prices) {
    if (prices.length < 30) {
        return { direction: 'sideways', strength: 0, ema10: null, ema20: null, ema30: null, dataPoints: prices.length };
    }

    const e10   = ema(prices, 10);
    const e20   = ema(prices, 20);
    const e30   = ema(prices, 30);
    const last  = prices[prices.length - 1];

    let direction = 'sideways';
    if (last > e10 && e10 > e20 && e20 > e30) direction = 'up';
    else if (last < e10 && e10 < e20 && e20 < e30) direction = 'down';

    // Stärke: relativer Spread der EMAs zum aktuellen Preis (0 = flach, 1 = stark)
    const spread   = Math.abs(e10 - e30) / last;
    const strength = Math.min(1, spread * 20);

    return { direction, strength, ema10: e10, ema20: e20, ema30: e30, dataPoints: prices.length };
}

// ─── Volatilität ─────────────────────────────────────────────────────────────

/**
 * Berechnet stündliche Volatilität aus Preis-Zeitreihe (pool_stats = 1h-Einträge).
 * @param {number[]} prices
 * @returns {{ hourlyPct: number|null, annualizedPct: number|null }}
 */
function computeVolatility(prices) {
    if (prices.length < 2) return { hourlyPct: null, annualizedPct: null };
    const logReturns = [];
    for (let i = 1; i < prices.length; i++) {
        if (prices[i - 1] > 0 && prices[i] > 0) {
            logReturns.push(Math.log(prices[i] / prices[i - 1]));
        }
    }
    const sigma = stddev(logReturns);
    return {
        hourlyPct:     +(sigma * 100).toFixed(4),
        annualizedPct: +(sigma * Math.sqrt(24 * 365) * 100).toFixed(1),
    };
}

// ─── Historische Rebalance-Statistik ────────────────────────────────────────

/**
 * Gibt tatsächliche Rebalance-Häufigkeit aus der DB zurück (letzte 30 Tage).
 */
function getHistoricalRebalanceStats(db, poolId) {
    const since = Date.now() - 30 * 24 * 3_600_000;
    const rows  = db.prepare(`
        SELECT cost_sol FROM rebalance_history
        WHERE pool_id = ? AND rebalanced_at >= ?
    `).all(poolId, since);

    const count      = rows.length;
    const validCosts = rows.filter(r => r.cost_sol != null);
    const avgCostSol = validCosts.length > 0
        ? validCosts.reduce((s, r) => s + r.cost_sol, 0) / validCosts.length
        : null;

    return { count, perDay: +(count / 30).toFixed(2), perMonth: count, avgCostSol };
}

// ─── Rebalancing-Kosten (Modell) ─────────────────────────────────────────────

// Slippage-Modell 1:1 aus FORGE/bin/estimate-costs.js (auch lib/economic-scorer nutzt es,
// damit Scoring und Kostenschätzung konsistent bleiben):
//   slippagePct = swapAmount / (tvl × depthFactor) × 100
// depthFactor: 10 für korrelierte Pairs (Liquidität stark konzentriert), sonst 2.
const STABLE_TOKENS       = new Set(['USDC', 'USDT', 'EURC', 'PYUSD', 'DAI']);
const DEPTH_CORRELATED    = 10;
const DEPTH_VOLATILE      = 2;
const REBAL_SWAP_FRACTION = 0.5;      // beim Rebalance wird ~50% des Kapitals umgeschichtet
const FALLBACK_TX_SOL     = 0.00004;  // On-Chain-Gebühr/Rebalance falls keine Historie (beobachtet ~3,5e-5)

/** Beide Token stabil (Stable/Stable) → hohe Liquiditätskonzentration → depthFactor 10. */
function isCorrelatedPair(pool) {
    const pair = pool.displayPair ?? pool.pair ?? '';
    const [a, b] = pair.split('/').map(s => (s ?? '').trim().toUpperCase());
    return !!a && !!b && STABLE_TOKENS.has(a) && STABLE_TOKENS.has(b);
}

/** Letzter SOL/USDC-Oracle-Preis (für Umrechnung der On-Chain-Gebühr). null wenn nicht vorhanden. */
function getSolUsd(db) {
    const row = db.prepare(
        `SELECT price FROM oracle_prices WHERE quote_pool_id = 'liq-sol-usdc' ORDER BY updated_at DESC LIMIT 1`
    ).get();
    return row?.price > 0 ? row.price : null;
}

/**
 * Modellierte Rebalancing-Kosten pro Rebalance (USDC) — ehrliche Zerlegung statt
 * lp_value_before−after.
 *
 * ⚠️ Historie: Früher wurde die Kost als AVG(lp_value_before−after) geschätzt. Das misst
 * aber überwiegend Marktbewegung/IL über den Rebalance hinweg, NICHT die Kosten — bei
 * trendbehafteten Pools systematisch verzerrt (before>after fast immer wahr bei fallendem
 * Kurs). Verifiziert 2026-07-07 an SPCX/USDC: ø 5,45 USDC „Kost" bei realer On-Chain-Gebühr
 * ~0,005 USDC → rebalCostAprPct auf 91–232% aufgebläht → Advisor UND Attrition-Regelkreis
 * empfahlen fälschlich Weiten, obwohl die enge Range real ~480% Brutto-APR lieferte.
 *
 * Neu, aus echten/robusten Größen zusammengesetzt:
 *   Kost = On-Chain-Gebühr (ø cost_sol × SOL-Preis, echt aus rebalance_history/oracle_prices)
 *        + Swap-Fee   (swapAmount × feeTier)
 *        + Slippage   (swapAmount × slippagePct; slippagePct aus realer Pool-TVL, estimate-costs-Modell)
 * mit swapAmount = capital × REBAL_SWAP_FRACTION (halbes Kapital wird umgeschichtet).
 *
 * @param {Database} db
 * @param {Object}   pool           Pool-Konfig (id, feeTier, pair/displayPair)
 * @param {number}   capitalUsdc    Positionskapital (USDC)
 * @param {Object}   [opts]
 * @param {number}   [opts.tvl]     Pool-TVL (USDC); fehlt → letzter pool_stats-Wert
 * @returns {{ avgCostUsdc:number, sampleSize:number, isFallback:boolean, source:'model'|'fallback', breakdown:Object|null }}
 *          sampleSize = Anzahl realer Rebalances (30d, Kapital ≥ MIN_REAL_CAPITAL_USDC) —
 *          Datenverfügbarkeits-Signal für Regelkreise, NICHT mehr eine Kosten-Stichprobe.
 */
export function estimateRebalanceCost(db, pool, capitalUsdc, opts = {}) {
    const since  = Date.now() - 30 * 24 * 3_600_000;
    const rebals = db.prepare(`
        SELECT cost_sol, lp_value_before_usdc AS capital
        FROM rebalance_history
        WHERE pool_id = ? AND rebalanced_at >= ?
    `).all(pool.id, since);
    const real       = rebals.filter(r => (r.capital ?? 0) >= MIN_REAL_CAPITAL_USDC);
    const sampleSize = real.length;

    // On-Chain-Gebühr: Durchschnitt echter cost_sol, sonst Konstante
    const txSols   = real.map(r => r.cost_sol).filter(v => v != null && v > 0);
    const avgTxSol = txSols.length ? txSols.reduce((s, v) => s + v, 0) / txSols.length : FALLBACK_TX_SOL;
    const solUsd    = getSolUsd(db);
    const txFeeUsdc = solUsd ? avgTxSol * solUsd : 0;

    // TVL: übergeben (Advisor: live Orca) oder letzter pool_stats-Wert
    let tvl = opts.tvl;
    if (!(tvl > 0)) {
        const row = db.prepare(
            `SELECT tvl_usd FROM pool_stats WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
        ).get(pool.id);
        tvl = row?.tvl_usd ?? null;
    }

    // Ohne TVL/Kapital/feeTier kein Modell möglich → sichere Fallback-Konstante
    if (!(tvl > 0) || !(capitalUsdc > 0) || pool.feeTier == null) {
        return { avgCostUsdc: SWAP_COST_USDC, sampleSize, isFallback: true, source: 'fallback', breakdown: null };
    }

    const swapAmount  = capitalUsdc * REBAL_SWAP_FRACTION;
    const depthFactor = isCorrelatedPair(pool) ? DEPTH_CORRELATED : DEPTH_VOLATILE;
    const slippagePct = (swapAmount / (tvl * depthFactor)) * 100;
    const swapFeeUsdc = swapAmount * (pool.feeTier / 100);
    const slipUsdc    = swapAmount * (slippagePct / 100);
    const avgCostUsdc = txFeeUsdc + swapFeeUsdc + slipUsdc;

    return {
        avgCostUsdc: +avgCostUsdc.toFixed(4),
        sampleSize,
        isFallback:  false,
        source:      'model',
        breakdown: {
            txFeeUsdc:   +txFeeUsdc.toFixed(4),
            swapFeeUsdc: +swapFeeUsdc.toFixed(4),
            slipUsdc:    +slipUsdc.toFixed(4),
            slippagePct: +slippagePct.toFixed(4),
            swapAmount:  +swapAmount.toFixed(2),
            depthFactor,
        },
    };
}

/**
 * Schätzt, wie stark der reale Preisprozess die Rebalance-Frequenz gegenüber dem
 * reinen Random-Walk-Modell verstärkt ("Trend-Verstärkung"). Reality-Check, der die
 * Lehrbuch-Annahme (richtungsloses Zappeln) gegen das tatsächliche Verhalten dieses
 * Pools korrigiert. Ergebnis ist ein dimensionsloser Faktor:
 *   1.0  = Modell stimmt; >1 = häufiger draußen als erwartet (Trend); <1 = seltener.
 *
 * ⚠️ RANGE-UNABHÄNGIG & DWELL-BASIERT (#0198, Fix 2026-06-20): Verglichen wird die
 * tatsächliche VERWEILDAUER einer Position (Zeit zwischen zwei aufeinanderfolgenden
 * Rebalances) mit der theoretischen Verweildauer T = (R/σ)² bei der RANGE, die DAMALS
 * aktiv war (rekonstruiert aus den Ticks). Aggregat über alle gültigen Paare:
 *   driftFactor = Σ theoretische Dwell / Σ tatsächliche Dwell
 *   >1 = Position fliegt schneller raus als das Lehrbuch erwartet (Trend); <1 = ruhiger.
 *
 * Warum dwell-basiert statt „Events / 30 Tage": Bei taktischen Pools liegt Kapital nur
 * sporadisch im Pool. „Events / 30" unterschätzt die Rate massiv (Nenner zu groß) und
 * liefert einen künstlich niedrigen driftFactor (Zeitbasis-Artefakt). Die Dwell-Methode
 * misst nur ECHTE Haltephasen und ist unabhängig davon, wie lange insgesamt Kapital drin war.
 * Range-Unabhängigkeit verhindert die selbsterregte Oszillation (früher koppelte
 * `theoreticalPerDay ∝ 1/currentRange²` die Empfehlung an die Ist-Range zurück).
 *
 * Datenarmut/Robustheit: Nur Paare mit echtem Kapital (≥ MIN_REAL_CAPITAL_USDC),
 * rekonstruierbarer Range und plausibler Verweildauer (≤ MAX_DWELL_GAP_MS — längere
 * Intervalle enthalten vermutlich eine kapitallose Lücke durch Withdraw/Redeposit) zählen.
 * Weniger als MIN_DRIFT_EVENTS gültige Paare → `null` → Aufrufer nutzt den neutralen
 * Random-Walk (driftFactor=1). So „erfindet" der Schätzer keine Korrektur aus Rauschen.
 *
 * @param {Database} db
 * @param {string}   poolId
 * @param {number}   sigmaHourlyPct
 * @param {number}   [_currentRangePct]  (nicht mehr verwendet — Signatur für Rückwärts-
 *                                        kompatibilität erhalten; der Schätzer ist range-unabhängig)
 * @returns {{ theoreticalPerDay: number, actualPerDay: number, driftFactor: number, dataPoints: number }|null}
 *          null wenn weniger als MIN_DRIFT_EVENTS belastbare Dwell-Paare vorliegen.
 */
export function getModelDrift(db, poolId, sigmaHourlyPct, _currentRangePct) {
    if (!(sigmaHourlyPct > 0)) return null;
    const since = Date.now() - 30 * 24 * 3_600_000;
    const rows = db.prepare(`
        SELECT old_tick_lower, old_tick_upper, lp_value_before_usdc AS capital, rebalanced_at
        FROM rebalance_history
        WHERE pool_id = ? AND rebalanced_at >= ?
        ORDER BY rebalanced_at ASC
    `).all(poolId, since);

    // Paare aufeinanderfolgender Rebalances bilden. Die Verweildauer bis zu Event i wurde in
    // der Position verbracht, die bei Event i geschlossen wurde → deren Range = old_ticks von i.
    let sumTheoH = 0, sumActualH = 0, pairs = 0;
    for (let i = 1; i < rows.length; i++) {
        const cur = rows[i], prev = rows[i - 1];
        if (cur.capital == null || cur.capital < MIN_REAL_CAPITAL_USDC) continue;     // Staub
        if (prev.capital == null || prev.capital < MIN_REAL_CAPITAL_USDC) continue;   // Lücke davor
        const gapMs = cur.rebalanced_at - prev.rebalanced_at;
        if (!(gapMs > 0) || gapMs > MAX_DWELL_GAP_MS) continue; // zu lang → kapitallose Lücke
        if (!Number.isFinite(cur.old_tick_lower) || !Number.isFinite(cur.old_tick_upper)
                || cur.old_tick_upper <= cur.old_tick_lower) continue;
        // Halb-Range (±%) aus der Tick-Breite: price = 1.0001^tick
        const eventRangePct = (Math.pow(1.0001, (cur.old_tick_upper - cur.old_tick_lower) / 2) - 1) * 100;
        if (!(eventRangePct > 0)) continue;
        sumTheoH   += (eventRangePct / sigmaHourlyPct) ** 2; // theoretische Verweildauer (h)
        sumActualH += gapMs / 3_600_000;                     // tatsächliche Verweildauer (h)
        pairs += 1;
    }

    if (pairs < MIN_DRIFT_EVENTS || !(sumActualH > 0)) return null; // zu wenig Daten → Aufrufer nutzt 1.0

    const driftFactor       = sumTheoH / sumActualH;
    const theoreticalPerDay = 24 / (sumTheoH / pairs);   // mittlere theoretische Rate
    const actualPerDay      = 24 / (sumActualH / pairs); // mittlere tatsächliche Rate
    return {
        theoreticalPerDay: +theoreticalPerDay.toFixed(3),
        actualPerDay:      +actualPerDay.toFixed(3),
        driftFactor:       +driftFactor.toFixed(2),
        dataPoints:        pairs,
    };
}

// ─── Range-Scoring ───────────────────────────────────────────────────────────

/**
 * Berechnet Brutto/Netto-APR und alle relevanten Metriken für eine Range-Breite.
 *
 * Modell-Annahmen (konsistent mit pool-explorer.js):
 *   - Pool-Liquidität über ±liqSpreadPct gleichverteilt → MyShare-Berechnung
 *     (Default: POOL_LIQ_SPREAD_PCT=10 für volatile Pairs; für Stablecoins <<10 übergeben,
 *      da Liquidität dort auf ±0.5–1.5% konzentriert ist)
 *   - Time-to-OOR ≈ (rangePct / σ_h)²  (Random-Walk / Brownian-Motion-Näherung)
 *   - IL pro Rebalancing ≈ rangePct² / 800  (geometrische Näherung für kleine %)
 *   - Break-Even-Kapital: Näherung für kleine Positionen (C << TVL × r/liqSpreadPct)
 *
 * @param {number} rangePct   Range-Breite in % (±)
 * @param {{ vol24h: number, tvl: number, feeTierPct: number, sigmaHourlyPct: number, capitalUsdc: number, liqSpreadPct?: number, empiricalCostUsdc?: number, driftFactor?: number|null }} params
 * @returns {Object}
 */
export function scoreRange(rangePct, params) {
    const { vol24h, tvl, feeTierPct, sigmaHourlyPct, capitalUsdc,
            liqSpreadPct = POOL_LIQ_SPREAD_PCT,
            empiricalCostUsdc = null,
            driftFactor = null } = params;

    // Modellierte Rebalancing-Kosten (estimate-costs) bevorzugen, sonst Fallback-Konstante.
    const swapCostUsdc   = (typeof empiricalCostUsdc === 'number' && empiricalCostUsdc > 0)
        ? empiricalCostUsdc : SWAP_COST_USDC;
    const swapCostSource = (typeof empiricalCostUsdc === 'number' && empiricalCostUsdc > 0)
        ? 'model' : 'fallback';

    // MyShare: unser Kapitalanteil an der Pool-Liquidität im Range
    const poolLiqInRange = tvl * (rangePct / liqSpreadPct);
    const myShare        = capitalUsdc / (capitalUsdc + poolLiqInRange);

    // Brutto-Fees
    const dailyFeesPool   = vol24h * (feeTierPct / 100);
    const dailyMyFees     = dailyFeesPool * myShare * TIME_IN_RANGE_FACTOR;
    const grossAprPct     = (dailyMyFees * 365 / capitalUsdc) * 100;

    // Rebalance-Frequenz (Random-Walk: T_OOR = (r/σ_h)²), korrigiert um gemessenen
    // Model-Drift falls vorhanden (driftFactor = actual/theoretical aus letzten 30 Tagen).
    // Ohne Korrektur unterschätzt das Modell die Kosten bei trendbehafteten Pools stark.
    const hoursUntilOor   = sigmaHourlyPct > 0 ? (rangePct / sigmaHourlyPct) ** 2 : Infinity;
    const rawRebalsPerDay = isFinite(hoursUntilOor) ? 24 / hoursUntilOor : 0;
    const rebalsPerDay    = rawRebalsPerDay * (driftFactor != null && driftFactor > 0 ? driftFactor : 1.0);
    const dailyCostUsdc   = rebalsPerDay * swapCostUsdc;
    const rebalCostAprPct = (dailyCostUsdc * 365 / capitalUsdc) * 100;

    // Monatliche Kapital-Attrition: Anteil des Kapitals, der pro Monat durch
    // Rebalancing-Kosten (Fees + Slippage) verloren geht.
    const attritionPctPerMonth = capitalUsdc > 0
        ? (swapCostUsdc / capitalUsdc) * rebalsPerDay * 30 * 100
        : 0;

    // IL-Annualisierung (Näherung: ~rangePct²/800 pro Rebalancing, in % des Kapitals)
    const ilPerRebalPct = (rangePct ** 2) / 800;
    const annualIlPct   = ilPerRebalPct * rebalsPerDay * 365;

    // Netto-APR
    const netAprPct = grossAprPct - rebalCostAprPct - annualIlPct;

    // Break-Even-Kapital (Näherung für kleine Positionen, unter Einbezug von IL):
    // rebalCostAprPct ∝ 1/C; gross- und ilAprPct ≈ const für C << TVL×r/10
    // minCapital = dailyCost×365×100 / (grossAprPct - annualIlPct)
    const profitableMargin = grossAprPct - annualIlPct;
    const minCapitalUsdc   = profitableMargin > 0
        ? Math.ceil((dailyCostUsdc * 365 * 100) / profitableMargin)
        : null;

    return {
        rangePct,
        myShare,
        grossAprPct:          +grossAprPct.toFixed(1),
        hoursUntilOor:        isFinite(hoursUntilOor) ? +hoursUntilOor.toFixed(1) : null,
        rawRebalsPerDay:      +rawRebalsPerDay.toFixed(3),
        rebalsPerDay:         +rebalsPerDay.toFixed(3),
        driftFactorApplied:   driftFactor != null ? +driftFactor.toFixed(2) : null,
        rebalCostAprPct:      +rebalCostAprPct.toFixed(1),
        annualIlPct:          +annualIlPct.toFixed(1),
        netAprPct:            +netAprPct.toFixed(1),
        minCapitalUsdc,
        profitable:           netAprPct > 0,
        swapCostSource,
        attritionPctPerMonth: +attritionPctPerMonth.toFixed(2),
    };
}

// ─── Haupt-Funktion ──────────────────────────────────────────────────────────

/**
 * Analysiert einen Pool und empfiehlt die optimale Range-Breite.
 *
 * @param {Object}   pool              Pool-Konfiguration aus pools.json
 * @param {Database} db                SQLite-Datenbankinstanz
 * @param {Object}   [opts]
 * @param {number}   [opts.capitalUsdc]  Override Kapital in USDC
 * @returns {Promise<Object|null>}     Advisor-Ergebnis, oder null wenn Pool ausgeschlossen
 */
export async function analyzePool(pool, db, opts = {}) {
    const poolType = pool.poolType;

    // cbBTC/WBTC hat rangeOverride: fixed → wird vor dem DB-Lookup bereits abgefangen
    const classCfg = getPoolTypeConfig(pool);

    // Kapital: Priorität opts > offene Position in DB > pools.json-Wert > 1000 USDC Fallback
    const openPos = db.prepare(
        `SELECT capital_usdc FROM positions WHERE pool_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`
    ).get(pool.id);
    const capitalUsdc = opts.capitalUsdc ?? openPos?.capital_usdc ?? pool.capitalUSDC ?? 1000;

    // ── Orca-Daten ────────────────────────────────────────────────────────────
    let tvl = 0, vol24h = 0, currentPrice = 0, change24hPct = 0;
    let orcaError = null;
    try {
        const resp = await fetch(`${ORCA_V2_BASE}/solana/pools/${pool.address}`, {
            signal: AbortSignal.timeout(30_000),
        });
        if (resp.ok) {
            const d      = (await resp.json())?.data;
            tvl          = parseFloat(d?.tvlUsdc)                      || 0;
            vol24h       = parseFloat(d?.stats?.['24h']?.volume)       || 0;
            currentPrice = parseFloat(d?.price)                        || 0;
            change24hPct = parseFloat(d?.stats?.['24h']?.priceDelta) * 100 || 0;
        } else {
            orcaError = `Orca API ${resp.status}`;
        }
    } catch (err) {
        orcaError = err.message;
    }

    // ── Preis-Historie + Volatilität + Trend ─────────────────────────────────
    const prices            = getPriceHistory(db, pool.id);
    const hasSufficientData = prices.length >= MIN_PRICE_POINTS;
    const vola              = computeVolatility(prices);
    const trend             = assessTrend(prices);

    // Fallback-Volatilität wenn DB-Daten fehlen
    const sigmaHourlyPct = (hasSufficientData && vola.hourlyPct)
        ? vola.hourlyPct
        : classCfg.volaDefault;

    // ── Historische Rebalance-Frequenz ────────────────────────────────────────
    const rebalStats = getHistoricalRebalanceStats(db, pool.id);

    // ── Modellierte Rebalancing-Kosten + Modell-Drift ─────────────────────────
    // Kosten aus estimate-costs-Modell (cost_sol + Swap-Fee + TVL-basierte Slippage),
    // Drift range-unabhängig aus Dwell-Zeiten. Beide unkonditional berechenbar.
    const empiricalRebalCost = estimateRebalanceCost(db, pool, capitalUsdc, { tvl });
    const modelDrift = getModelDrift(db, pool.id, sigmaHourlyPct);

    // ── Kandidaten-Scan ───────────────────────────────────────────────────────
    const empiricalCostUsdc = empiricalRebalCost.isFallback ? null : empiricalRebalCost.avgCostUsdc;
    const scanParams = { vol24h, tvl, feeTierPct: pool.feeTier, sigmaHourlyPct, capitalUsdc,
                         empiricalCostUsdc, driftFactor: modelDrift?.driftFactor ?? null };

    const candidates = CANDIDATE_RANGES
        .filter(r => r >= classCfg.min && r <= classCfg.max)
        .map(r => scoreRange(r, scanParams));

    // Optimum = höchste Netto-APR
    const optimal = candidates.reduce((best, c) => c.netAprPct > best.netAprPct ? c : best);

    // Konfidenz. 'high' verlangt nicht nur genug PREIS-Historie (≥168h), sondern auch
    // belastbare FREQUENZ-Evidenz: die Rebalance-Kost ist jetzt immer modelliert (deterministisch),
    // also ist das verbleibende empirische Signal, ob die Rebalance-HÄUFIGKEIT real gedeckt ist —
    // gemessen am dwell-basierten Modell-Drift. Ohne genug echte Rebalance-Historie (modelDrift=null)
    // bleibt die Empfehlung 'medium', damit der Tooltip keine unsichere Empfehlung als 'high' durchlässt.
    const costDataOk = (modelDrift != null);
    const confidence = !hasSufficientData            ? 'low'
        : (prices.length >= 168 && costDataOk)       ? 'high'
        :                                              'medium';

    // Asymmetrie-Faktor für spätere asymmetrische Range-Berechnung:
    //   -1.0 = stark abwärts → mehr Spielraum nach unten
    //   +1.0 = stark aufwärts → mehr Spielraum nach oben
    const asymmetry = trend.direction === 'up'   ?  +(trend.strength * 0.5).toFixed(2)
                    : trend.direction === 'down'  ? -+(trend.strength * 0.5).toFixed(2)
                    : 0;

    // Asymmetrische Aufschlüsselung: wie viel % Spielraum nach unten / oben
    const pctBelow = +(optimal.rangePct * (1 - asymmetry * 0.3)).toFixed(2);
    const pctAbove = +(optimal.rangePct * (1 + asymmetry * 0.3)).toFixed(2);

    // Aktuell konfigurierte Range (falls rangeOverride gesetzt)
    const currentRangePct = pool.rangeOverride?.fixedPct ?? null;
    const currentScore    = currentRangePct != null
        ? scoreRange(currentRangePct, scanParams)
        : null;

    return {
        poolId:    pool.id,
        pair:      pool.displayPair ?? pool.pair,
        poolType,
        timestamp: Date.now(),

        recommendation: {
            rangePct:   optimal.rangePct,
            pctBelow,
            pctAbove,
            asymmetry,
            confidence,
        },

        rationale: {
            trend,
            volatility: {
                hourlyPct:     vola.hourlyPct ?? sigmaHourlyPct,
                annualizedPct: vola.annualizedPct,
                isFallback:    !hasSufficientData || !vola.hourlyPct,
                dataPoints:    prices.length,
            },
            orcaReference:   classCfg.ref,
            currentRange:    currentRangePct,
            currentScore,
            optimalScore:    optimal,
            breakEven: {
                minCapitalUsdc:     optimal.minCapitalUsdc,
                currentCapitalUsdc: capitalUsdc,
                capitalSource:      opts.capitalUsdc ? 'override' : openPos?.capital_usdc ? 'db_position' : pool.capitalUSDC ? 'pools_json' : 'fallback',
                isProfitable:       capitalUsdc >= (optimal.minCapitalUsdc ?? 0),
            },
            historicalRebalances: rebalStats,
            empiricalRebalCost,
            modelDrift,
        },

        marketData: { tvlUsdc: tvl, vol24h, currentPrice, change24hPct, orcaError },
        candidates,
    };
}
