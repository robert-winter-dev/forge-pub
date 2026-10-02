/**
 * Score-Tabellen entfernen — Score-Rückbau (2026-09-23, LIQ#000932).
 *
 * Nach dem Code-Rückbau liest oder schreibt kein Code mehr diese Tabellen der
 * `liquiditybot.db`:
 *   - invest_score_history   InvestScore-Verlauf (Dashboard-Chart, check-entry, entry-log)
 *   - score_advisor_log      Score Adviser (bin/score-advisor.js)
 *   - pool_type_advisor_log  Pool-Type-Advisor (bin/pool-type-advisor.js)
 *   - btc_trend_history      BTC-Trendmeter (lib/btc-trend/)
 *   - btc_correlation_log    BTC-Korrelations-Advisor (lib/btc-correlation/)
 * Freigabe zum Löschen: Projektinhaber, 23.09.2026.
 *
 * 🔒 NICHT dabei: `opportunity_scores` (Name historisch, trägt weiter die Slope-Historie der
 * Opportunity-Tabelle und die Premium-Sektion `slopes`) und `pool_score_history` (Economic
 * Scorer). Beide werden weiter gelesen und geschrieben.
 *
 * 🔒 Einstufung `safe`: reine Schemaänderung ohne Kapitalwirkung, kein Exit- oder Invest-Pfad
 * liest diese Tabellen. `DROP TABLE IF EXISTS`, weil eine Installation einzelne Tabellen nie
 * angelegt haben kann (Fork ohne Master-only-Advisor, Neuinstallation nach LIQ#000932).
 *
 * Den Speicher gibt SQLite erst mit einem VACUUM an das Dateisystem zurück; das ist bewusst
 * nicht Teil der Migration (sperrt die Datei für die Dauer, der Bot schreibt parallel).
 */
import { IMPACT_SAFE } from './runner.js';

export const TABLES = [
    'invest_score_history',
    'score_advisor_log',
    'pool_type_advisor_log',
    'btc_trend_history',
    'btc_correlation_log',
];

function existing(db) {
    if (!db) return [];
    return TABLES.filter(t =>
        !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(t));
}

export default {
    id:          '0013-drop-score-tables',
    description: 'Score-Tabellen der liquiditybot.db entfernen (invest_score_history u. a., LIQ#000932)',
    impact:      IMPACT_SAFE,

    async plan(ctx) {
        const found = existing(ctx.liquidityDb);
        if (!found.length) {
            return { pending: false, summary: 'keine Score-Tabellen vorhanden — nichts zu tun', details: [], warnings: [] };
        }
        return {
            pending:  true,
            summary:  `${found.length} Score-Tabelle(n) werden entfernt`,
            details:  found.map(t => {
                const n = ctx.liquidityDb.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
                return `DROP TABLE IF EXISTS ${t} (${n} Zeilen)`;
            }),
            warnings: [],
        };
    },

    async up(ctx) {
        if (!ctx.liquidityDb) return { summary: 'keine liquiditybot.db — nichts zu tun' };
        const found = existing(ctx.liquidityDb);
        ctx.liquidityDb.transaction(() => {
            for (const t of TABLES) ctx.liquidityDb.exec(`DROP TABLE IF EXISTS ${t}`);
        })();
        const left = existing(ctx.liquidityDb);
        if (left.length) throw new Error(`nach dem DROP noch vorhanden: ${left.join(', ')}`);
        return { summary: found.length ? `entfernt: ${found.join(', ')}` : 'nichts zu tun' };
    },
};
