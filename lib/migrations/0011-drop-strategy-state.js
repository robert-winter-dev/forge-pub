/**
 * Tabelle `strategy_state` entfernen — Strategie-Rückbau Teil 5 (2026-09-23, LIQ#000922).
 *
 * Nach dem vollständigen Code-Rückbau (LIQ#000918–000921) liest oder schreibt kein Code mehr
 * `strategy_state`. Die Tabelle bleibt als totes Schema zurück — diese Migration räumt sie ab.
 *
 * 🔒 Einstufung `safe`: reine Schemaänderung ohne Kapitalwirkung. `strategy_state` enthält nur
 * die zuletzt aktive Strategie-ID; nach dem Rückbau liest niemand mehr diesen Wert.
 *
 * 🔒 `DROP TABLE IF EXISTS` ist Pflicht, kein bloßes `DROP TABLE`: Eine Neuinstallation
 * verbucht Migrationen per `baseline()`, ohne sie auszuführen (siehe Kopfkommentar von
 * 0009-strategy-state.js) — dort hat `strategy_state` unter Umständen nie existiert. Läuft
 * diese Migration doch einmal auf einer Installation vor 0009 nach, existiert die Tabelle
 * erst gar nicht; auch dann darf `up()` nicht scheitern.
 *
 * 0009 und 0010 bleiben unverändert bestehen — Installationen, die noch vor 0009 stehen,
 * durchlaufen sie weiter in Reihenfolge, diese Migration räumt danach auf.
 */
import { IMPACT_SAFE } from './runner.js';

const TABLE = 'strategy_state';

function tableExists(db) {
    try {
        return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(TABLE);
    } catch {
        return false;
    }
}

export default {
    id:          '0011-drop-strategy-state',
    description: `${TABLE}: totes Schema nach dem Strategie-Rückbau entfernen (LIQ#000922)`,
    impact:      IMPACT_SAFE,

    async plan(ctx) {
        if (!tableExists(ctx.settingsDb)) {
            return {
                pending: false,
                summary: `${TABLE} existiert nicht — nichts zu tun`,
                details: [],
                warnings: [],
            };
        }
        return {
            pending: true,
            summary: `${TABLE} wird entfernt (totes Schema nach dem Strategie-Rückbau)`,
            details: ['DROP TABLE IF EXISTS strategy_state'],
            warnings: [],
        };
    },

    async up(ctx) {
        const existed = tableExists(ctx.settingsDb);
        ctx.settingsDb.exec(`DROP TABLE IF EXISTS ${TABLE}`);
        if (tableExists(ctx.settingsDb)) throw new Error(`${TABLE} existiert nach dem DROP noch`);
        return { summary: existed ? `${TABLE} entfernt` : `${TABLE} existierte nicht — nichts zu tun` };
    },
};
