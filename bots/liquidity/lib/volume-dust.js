// ══════════════════════════════════════════════════════════════════════════════
// LMB – Dust-Schwelle für Stunden-Volumen
// ══════════════════════════════════════════════════════════════════════════════
// EIN Wert, zwei Konsumenten mit unterschiedlichem Zweck:
//   - lib/invest-score-config.js → Volumen-Malus im InvestScore (master-only)
//   - bin/export.js              → Anzeige-Entscheidung „no data" statt irreführender
//                                  ~0,01%-Werte bei Dust-Handel
//
// Warum eine eigene Datei: Die Schwelle stand vorher in invest-score-config.js,
// zusammen mit den Score-GEWICHTEN. Damit hätte der einzelne Import in export.js
// die Gewichte in den öffentlichen FORGE-public-Fork gezogen (Befund 2026-07-25).
// Den Wert zu duplizieren wäre die schlechtere Lösung — Formel-/Wertkopien sind
// genau das Muster, das FORGE bei PnL und Score vermeidet. Deshalb: neutrale
// Einzelquelle, die beide Seiten importieren können.
// ══════════════════════════════════════════════════════════════════════════════

/** Stunden-Volumen ≤ diesem Wert gilt als „kein Handel". */
export const VOLUME_DUST_USD = 100;

export default { VOLUME_DUST_USD };
