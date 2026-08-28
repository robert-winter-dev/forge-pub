/**
 * FORGE Liquidity – Auflösung der TVL-Schutz-Schwellen (pure, ohne Abhängigkeiten)
 *
 * Bewusst ein eigenes Modul: dieselbe Auflösung wird an zwei Stellen gebraucht,
 * die nichts miteinander zu tun haben —
 *   - lib/tvl-protection.js  → „muss ich Kapital JETZT herausholen?" (Position vorhanden)
 *   - lib/invest-eligibility.js → „darf hier überhaupt Kapital hinein?" (vor dem Invest)
 * Läge die Logik nur beim Exit, müsste der Invest-Pfad sie nachbauen. Genau diese
 * Doppelung hat am 2026-08-20 dazu geführt, dass „Bester Pool" HYPE/USDC bei 58 K TVL
 * gegen eine 100-K-Exit-Schwelle befüllt hat — der Exit feuerte Minuten später.
 *
 * Keine Imports: das Modul ist ohne Bot-Umgebung testbar (bin/test-invest-eligibility.js).
 */

/** Effektive Schwelle einer Stufe: konfiguriert, sonst pools.json-Fallback. */
export function effectiveThreshold(levelCfg, fallback) {
    const t = Number(levelCfg?.thresholdUsd);
    if (Number.isFinite(t) && t > 0) return t;
    const f = Number(fallback);
    return Number.isFinite(f) && f > 0 ? f : null;
}

/**
 * Löst die TVL-Schutz-Schwelle eines Pools auf.
 *
 * @param {object} pool  Pool aus pools.json (tvlWarnThreshold / tvlExitThreshold)
 * @param {object} cfg   tvlProtection-Objekt aus den Pool-Settings
 * @returns {{l1:{enabled:boolean,threshold:number|null,withdrawPct:number}}}
 */
export function resolveTvlThresholds(pool, cfg) {
    const l1 = cfg?.level1 ?? {};

    // Fallback-Schwelle für Stufe 1: normalerweise die Warn-Schwelle aus pools.json.
    // Zieht Stufe 1 aber 100 % (seit 2026-08-15 der Default — der Voll-Exit läuft über
    // Stufe 1), dann ist sie keine Warnstufe mehr und muss beim Ernstfall-Wert greifen.
    // Sonst liquidierte ein Pool ohne eigene Schwelle bereits bei der höheren Warnschwelle
    // komplett.
    const l1Fallback = Number(l1.withdrawPct) >= 100
        ? (pool?.tvlExitThreshold ?? pool?.tvlWarnThreshold)
        : pool?.tvlWarnThreshold;

    return {
        l1: {
            enabled:     l1.enabled === true,
            threshold:   effectiveThreshold(l1, l1Fallback),
            withdrawPct: Number(l1.withdrawPct) || 0,
        },
    };
}
