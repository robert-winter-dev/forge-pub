// ══════════════════════════════════════════════════════════════════════════════
// LMB – gewichtete Blend-Formel (generisch, ohne IP-Bezug)
// ══════════════════════════════════════════════════════════════════════════════
// EIN Wert-Reduzierer, zwei Konsumenten mit unterschiedlichem Zweck:
//   - lib/invest-score.js               → Live-Score (Master, re-exportiert diese Funktion)
//   - bin/export.js (NP-Windows-Fallback)→ simuliert fehlende PnL-Metriken (Fork-sicher)
//
// Warum eine eigene Datei: Die Funktion stand vorher in invest-score.js, das per
// Kopfimport `invest-score-config.js` lädt – und dort liegen die Score-GEWICHTE
// (INVEST_WEIGHTS, INVEST_WEIGHTS_BY_TYPE). Ein direkter Import von `invest-score.js`
// in export.js hätte die Gewichte reimportiert und das R7-/Score-Leck aus
// Commit 84426de reproduziert (gleiches Muster wie bei lib/volume-dust.js).
//
// Diese Funktion selbst hat KEINE Abhängigkeit auf Gewichte oder Kurven – sie ist
// eine generische gewichtete Mittelung mit einer PnL-Null→50-Fallback-Regel und
// einem optionalen Deckel. Die eigentliche IP (Gewichte, Kurvenformen) bleibt in
// invest-score-config.js / invest-score.js, beide NICHT im Fork.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Gewichtete Summe der Sub-Scores → Gesamtscore (0–100) oder null.
 * PnL-Metriken: null → neutral 50 (sonst fiele die Metrik aus der Renormierung).
 * Nicht-PnL-Metriken: null → fällt raus (Gewicht zählt nicht).
 *
 * @param {{score:number|null, weight:number, pnl?:boolean}[]} metrics
 * @param {{hopiumGate?:boolean}} [opts]  hopiumGate → Score auf max. 40 gedeckelt
 * @returns {number|null}
 */
export function blendInvestScore(metrics, { hopiumGate = false } = {}) {
    let tot = 0, sum = 0;
    for (const m of metrics) {
        const eff = m.pnl ? (m.score ?? 50) : m.score;
        if (eff != null) { tot += m.weight; sum += eff * m.weight; }
    }
    let value = tot > 0 ? Math.round(sum / tot) : null;
    if (hopiumGate && value != null) value = Math.min(value, 40);
    return value;
}

export default { blendInvestScore };
