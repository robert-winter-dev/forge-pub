/**
 * ════════════════════════════════════════════════════════════════════════════
 *  CLMM-LP-MATHEMATIK · gemeinsame Modell-Funktionen für NP
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  Reine (zustandslose) Funktionen zur Bewertung einer konzentrierten LP-Position
 *  (Orca CLMM, symmetrische Range). Sie waren ursprünglich privat in bin/export.js;
 *  ausgelagert, damit der NP-Backtest (bin/backtest-np-path.js) EXAKT denselben
 *  Code testet, den der Live-Export verwendet — kein Nachbau, keine Divergenz.
 *  (Genau diese Divergenz war in der Vergangenheit wiederholt Fehlerquelle.)
 *
 *  Konvention: Range symmetrisch in Prozent um den Einstiegspreis P0.
 *  range_pct = Halbbreite in % (z.B. 5 ⇒ [0,95·P0, 1,05·P0]).
 *  Alle Returns sind LP-Wert-Verhältnisse bzw. -Renditen vs. Einstiegskapital,
 *  NICHT IL-vs-HODL (siehe _clmmIlPct für letzteres).
 * ════════════════════════════════════════════════════════════════════════════
 */

// LP-Wert-Faktor einer CLMM-Position: Verhältnis des Positionswerts bei Preis Pt
// zum Einstiegswert bei P0 (=1,0 bei Pt==P0). Bei Verlassen der Range wird am
// jeweiligen Boundary geclampt (Position vollständig in einem Asset).
export function clmmLpValue(P0, Pt, rangePct) {
    if (!P0 || !Pt || P0 <= 0 || Pt <= 0 || rangePct <= 0) return 1;
    const r  = rangePct / 100;
    const pa = 1 - r;
    const pb = 1 + r;
    if (pa <= 0) return 1;
    const k  = Pt / P0;

    const denom = (1 - 1 / Math.sqrt(pb)) + (1 - Math.sqrt(pa));
    if (denom <= 0) return 1;
    const L = 1 / denom;

    if (k < pa) return L * (1 / Math.sqrt(pa) - 1 / Math.sqrt(pb)) * k;
    if (k > pb) return L * (Math.sqrt(pb) - Math.sqrt(pa));
    return L * (1 / Math.sqrt(k) - 1 / Math.sqrt(pb)) * k
         + L * (Math.sqrt(k) - Math.sqrt(pa));
}

// LP-Rendite vs. Einstiegskapital: (lp − 1) × 100.
// Positiv wenn Preis steigt (LP-Wert wächst), negativ wenn er fällt/out-of-range.
// Wird für NP-Berechnung verwendet: misst dieselbe Größe wie pnlWindows
// (Δ LP-Wert vs. investiertes Kapital), nicht IL vs. HODL.
export function clmmLpReturn(P0, Pt, rangePct) {
    return (clmmLpValue(P0, Pt, rangePct) - 1) * 100;
}

// Pfad-/rebalance-bewusster LP-Return (#0198, Phase 3).
// `clmmLpReturn` ist ein Zwei-Punkt-Endpunkt-Modell (entry→jetzt) und ignoriert, dass eine
// reale Position bei Range-Verlassen rebalanciert (Kostenbasis-Reset). Bei volatilen Pools
// kippt dadurch das Vorzeichen des IL-Terms.
// Hier wird stattdessen der gesamte Preispfad (Stützstellen) segmentiert: bei jedem
// Range-Verlassen wird der Segment-Return am Boundary realisiert (clamp in clmmLpValue),
// auf den aktuellen Preis re-zentriert (= Bot-Rebalance) und das nächste Segment beginnt.
// Die Segment-Returns werden multiplikativ kompoundiert. Zusätzlich: time-in-range-Anteil als
// Diagnose für eine spätere Fee-Verfeinerung (Fees fallen nur in-range an).
// `path` = aufsteigend sortierte [{price}, …] über das Fenster. Gibt null bei zu wenig Daten.
// `segments` (LIQ#000871): je Range-Abschnitt Startindex im Pfad, Mittelpreis und LP-Wert-Faktor
// zu Abschnittsbeginn — damit ein Fee-Leg (bin/fee-price-calculator.js) denselben Rebalance-Pfad
// nutzt wie dieser Preis-Leg, statt die Segmentierung nachzubauen. Nur Zusatzausgabe, die übrigen
// Felder sind unverändert.
export function clmmLpReturnPath(path, rangePct) {
    if (!Array.isArray(path) || path.length < 2 || !(rangePct > 0)) return null;
    const r  = rangePct / 100;
    const pa = 1 - r;
    const pb = 1 + r;
    if (pa <= 0) return null;

    let ref = path[0].price;
    if (!(ref > 0)) return null;

    let cum = 1;                 // multiplikativ kompoundierter LP-Wert (Start = 1)
    let inRange = 0, total = 0;
    const segments = [{ startIdx: 0, ref, valueFactor: 1 }];
    for (let i = 1; i < path.length; i++) {
        const P = path[i].price;
        if (!(P > 0)) continue;
        total++;
        const k = P / ref;
        if (k < pa || k > pb) {
            // Range verlassen → Segment am Boundary realisieren (clamp), dann rebalancen.
            cum *= clmmLpValue(ref, P, rangePct);
            ref  = P;            // re-zentrieren auf aktuellen Preis (Bot-Verhalten)
            segments.push({ startIdx: i, ref, valueFactor: cum });
        } else {
            inRange++;
        }
    }
    // letztes offenes Segment bis zum jüngsten Preis schließen
    cum *= clmmLpValue(ref, path[path.length - 1].price, rangePct);

    return {
        lpReturnPct: (cum - 1) * 100,
        timeInRange: total > 0 ? inRange / total : 1,
        segments,
    };
}

// Rohe On-Chain-Liquidity (L) einer hypothetischen Position aus eingesetztem USDC-Kapital
// (LIQ#0361, Fee-/Preis-Rechner). Nötig, um myL gegen pool_stats.liquidity_in_range (rohes,
// dezimalskaliertes On-Chain-L) zu teilen — beide Größen müssen in derselben Einheit stehen.
// Voraussetzung: Token B ist der USD-Quote (z.B. USDC) — gilt NICHT für volatilePair-Pools
// (z.B. cbBTC/WBTC), dort ist die Funktion nicht anwendbar (Aufrufer muss das ausschließen).
//
// Herleitung: Im human-unit-Raum (reale Token-Mengen, realer Preis P0) gilt für eine
// CLMM-Position mit Range [P0·pa, P0·pb] (pa=1−r, pb=1+r):
//   x_human = L_human·(1/√P0 − 1/√(P0·pb)) = L_human/√P0 · (1 − 1/√pb)
//   y_human = L_human·(√P0 − √(P0·pa))     = L_human·√P0 · (1 − √pa)
// Wert in USDC (x in Token A zu P0, y in Token B = USDC 1:1):
//   capitalUsdc = x_human·P0 + y_human = L_human·√P0·[(1−1/√pb) + (1−√pa)] = L_human·√P0·denom
//   ⇒ L_human = capitalUsdc / (√P0 · denom)
// Rohes On-Chain-L skaliert mit den Dezimalstellen beider Token (Uniswap-V3/Orca-Konvention,
// da sqrtPrice_raw = √P0 · 10^((decimalsB−decimalsA)/2) und x_raw = x_human · 10^decimalsA):
//   L_raw = L_human · 10^((decimalsA+decimalsB)/2)
// Der Skalenfaktor ist preisunabhängig (Herleitung geprüft für LIQ#0361).
export function clmmLiquidityFromCapital(P0, capitalUsdc, rangePct, decimalsA, decimalsB) {
    if (!P0 || P0 <= 0 || !(capitalUsdc > 0) || !(rangePct > 0)) return 0;
    const r  = rangePct / 100;
    const pa = 1 - r;
    const pb = 1 + r;
    if (pa <= 0) return 0;
    const denom = (1 - 1 / Math.sqrt(pb)) + (1 - Math.sqrt(pa));
    if (denom <= 0) return 0;

    const lHuman = capitalUsdc / (Math.sqrt(P0) * denom);
    return lHuman * Math.pow(10, (decimalsA + decimalsB) / 2);
}

// IL vs. HODL: nur für die IL-Anzeige in der Position-Detailansicht.
// NICHT für NP-Berechnung verwenden (misst Opportunity Cost, nicht Kapitalrendite).
export function clmmIlPct(P0, Pt, rangePct) {
    const lp = clmmLpValue(P0, Pt, rangePct);
    if (!P0 || !Pt || P0 <= 0 || Pt <= 0 || rangePct <= 0) return 0;
    const r  = rangePct / 100;
    const pa = 1 - r;
    const pb = 1 + r;
    const k  = Pt / P0;
    const denom = (1 - 1 / Math.sqrt(pb)) + (1 - Math.sqrt(pa));
    if (denom <= 0) return 0;
    const L  = 1 / denom;
    const x0   = L * (1 - 1 / Math.sqrt(pb));
    const y0   = L * (1 - Math.sqrt(pa));
    const hodl = x0 * k + y0;
    return (lp - hodl) / hodl * 100;
}
