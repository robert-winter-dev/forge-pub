/**
 * Pool-Einstellung `cleanup.rankingEligible` entfernen — LIQ#000937 (2026-09-23).
 *
 * Das Feld sagte, ob ein Pool am Cleanup „Bester Pool" teilnimmt. Den Modus gibt es seit
 * LIQ#000929 nicht mehr, seit LIQ#000937 investiert der Cleanup überhaupt nicht mehr. Mit
 * der Drei-Stufen-Auswahl der Pool-Zeile (Deaktiviert / Cleanup inaktiv / Cleanup aktiv)
 * entfiel der letzte Schreibpfad, der Code-Default ist gestrichen
 * (lib/pool-settings-defaults.js).
 *
 * Ein Default-Wegfall allein räumt die Datenbank nicht auf: Jede Zeile, die das Feld je
 * geschrieben hat, trägt es explizit weiter. Auf business waren das am 23.09.2026 vier
 * Pools mit `false` (liq-grass-sol, liq-jitosol-ref, liq-kmno-usdc, liq-spx-sol) — eine
 * Sperre, die niemand mehr auswertet, aber in „vom Standard abweichend" und bei jeder
 * künftigen Auswertung wieder auftauchen würde. Diese Migration entfernt den Abschnitt
 * `cleanup` aus jeder pool_settings- und pool_type_settings-Zeile des Liquidity Bots.
 *
 * 🔒 Einstufung `safe`: Kein Code liest das Feld, die Entfernung kann weder Kapital
 * bewegen noch eine Position schließen.
 */
import { IMPACT_SAFE } from './runner.js';
import { ensureSourceColumn, hasSourceColumn } from './_settings-history.js';

const FIELD = 'cleanup.rankingEligible';

function readRows(settingsDb, table, idCol, scope) {
    let rows;
    try {
        rows = settingsDb.prepare(`SELECT ${idCol} AS id, settings FROM ${table} WHERE bot_id = 'liquidity'`).all();
    } catch {
        return [];   // Tabelle fehlt (ältere Installation) → nichts zu tun
    }
    const out = [];
    for (const r of rows) {
        try { out.push({ scope, id: r.id, settings: JSON.parse(r.settings) }); } catch { /* unlesbar → überspringen */ }
    }
    return out;
}

function analyse(ctx) {
    return [
        ...readRows(ctx.settingsDb, 'pool_settings',      'pool_id',   'pool'),
        ...readRows(ctx.settingsDb, 'pool_type_settings', 'pool_type', 'pool_type'),
    ].filter(r => r.settings && Object.prototype.hasOwnProperty.call(r.settings, 'cleanup'));
}

const label = (r) => `${r.scope === 'pool_type' ? 'Typ ' : ''}${r.id}`;

export default {
    id:          '0015-drop-cleanup-ranking-eligible',
    description: 'Pool-Einstellung cleanup.rankingEligible entfernen (LIQ#000937)',
    impact:      IMPACT_SAFE,

    async plan(ctx) {
        const rows = analyse(ctx);
        return {
            pending: rows.length > 0,
            summary: rows.length
                ? `${rows.length} Eintrag/Einträge tragen noch cleanup.rankingEligible`
                : 'kein Eintrag trägt cleanup.rankingEligible',
            details: rows.map(r => `${label(r)}: cleanup ${JSON.stringify(r.settings.cleanup)} → entfernt`),
            warnings: [],
        };
    },

    async up(ctx) {
        // Wie 0006: Spalte `source` sicherstellen, damit die Historienzeile als
        // 'migration' und nicht als Nutzerentscheidung gilt.
        ensureSourceColumn(ctx.settingsDb);

        const rows = analyse(ctx);
        const now  = Date.now();
        const upsertPool = ctx.settingsDb.prepare(`
            INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES ('liquidity', ?, ?)
            ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings`);
        const upsertType = ctx.settingsDb.prepare(`
            INSERT INTO pool_type_settings (bot_id, pool_type, settings) VALUES ('liquidity', ?, ?)
            ON CONFLICT(bot_id, pool_type) DO UPDATE SET settings = excluded.settings`);
        let history = null;
        try {
            history = hasSourceColumn(ctx.settingsDb)
                ? ctx.settingsDb.prepare(`
                    INSERT INTO settings_history (bot_id, scope, scope_id, field, old_value, new_value, changed_at, source)
                    VALUES ('liquidity', ?, ?, ?, ?, ?, ?, 'migration')`)
                : ctx.settingsDb.prepare(`
                    INSERT INTO settings_history (bot_id, scope, scope_id, field, old_value, new_value, changed_at)
                    VALUES ('liquidity', ?, ?, ?, ?, ?, ?)`);
        } catch { /* Tabelle fehlt → ohne Historie fortfahren */ }

        const tx = ctx.settingsDb.transaction(() => {
            for (const r of rows) {
                const old = r.settings.cleanup?.rankingEligible;
                delete r.settings.cleanup;
                (r.scope === 'pool' ? upsertPool : upsertType).run(r.id, JSON.stringify(r.settings));
                if (old !== undefined) history?.run(r.scope, r.id, FIELD, JSON.stringify(old), null, now);
            }
        });
        tx();
        return { changed: rows.length, summary: `cleanup.rankingEligible aus ${rows.length} Eintrag/Einträgen entfernt` };
    },
};
