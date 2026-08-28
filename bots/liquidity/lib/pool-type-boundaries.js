/**
 * FORGE Liquidity – Pool-Typ-Klassifizierung (öffentlich, keine Score-Gewichte)
 *
 * Nur die Frage "welcher Typ passt zur gemessenen Vola?" — keine PnL-/APR-Gewichte.
 * Bewusst aus lib/invest-score-config.js herausgelöst (gleiches Prinzip wie
 * VOLUME_DUST_USD in lib/volume-dust.js): jene Datei darf kein Entry-Point des
 * FORGE-public-Forks importieren, weil sie die Score-Gewichte (INVEST_WEIGHTS_BY_TYPE)
 * enthält (Befund 2026-07-25). Diese Datei ist unkritisch und darf von bot.js (Fork)
 * importiert werden — invest-score-config.js re-exportiert dieselben Konstanten für
 * bestehende (Master-only) Importe, um keinen Call-Site umschreiben zu müssen.
 *
 * Schwellen/Herleitung: siehe Projekt-Dokumentation zu Pool-Typen und Pool-Type-Advisor.
 */

export const POOL_TYPES = ['rebalance_free', 'volatil_1', 'volatil_2', 'volatil_3', 'rwa'];

// Reihenfolge nach Vola-Grad, für Vola-Drift-Neuzuordnungs-Vorschläge (rwa hat keinen Platz
// in dieser Achse — eigene Struktur-Dimension, nicht über Vola klassifizierbar).
export const VOLA_TYPE_ORDER = ['rebalance_free', 'volatil_1', 'volatil_2', 'volatil_3'];

// Vola-Klassifizierungs-Grenzen je Pool-Typ (Median-Tagesvola, MAX/MIN-Preis pro Kalendertag).
// `upper`/`lower` in Prozent, `rwa: null` = kein Vola-Grenzwert (strukturell, nicht über Vola
// klassifizierbar) → computeVolaDrift() überspringt rwa-Pools automatisch (applicable: false).
export const VOLA_TYPE_BOUNDARIES = {
    rebalance_free: { upper: 0.5 },
    volatil_1:      { lower: 0.5, upper: 3.0 },
    volatil_2:      { lower: 3.0, upper: 7.0 },
    volatil_3:      { lower: 7.0 },
    rwa:            null,
};
export const VOLA_BOUNDARY_HYSTERESIS_PP = 0.5;
export const VOLA_BOUNDARY_DRIFT_DAYS    = 30;
