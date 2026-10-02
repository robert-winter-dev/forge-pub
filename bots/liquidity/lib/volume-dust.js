// ══════════════════════════════════════════════════════════════════════════════
// LMB – Dust-Schwelle für Stunden-Volumen
// ══════════════════════════════════════════════════════════════════════════════
// Konsument: bin/export.js → Anzeige-Entscheidung „no data" statt irreführender
// ~0,01%-Werte bei Dust-Handel.
//
// Eigene Datei seit 2026-07-25, damals als neutrale Einzelquelle neben dem Volumen-Malus
// des Scores; der Score ist seit LIQ#000932 entfernt, die Anzeige-Schwelle bleibt.
// ══════════════════════════════════════════════════════════════════════════════

/** Stunden-Volumen ≤ diesem Wert gilt als „kein Handel". */
export const VOLUME_DUST_USD = 100;

export default { VOLUME_DUST_USD };
