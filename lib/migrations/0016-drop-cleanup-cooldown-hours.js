/**
 * Pool-Einstellungen `trailingStop.cooldownHours` und `tvlProtection.cooldownHours`
 * entfernen — LIQ#000942 (2026-09-23).
 *
 * Beide Felder sperrten einen Pool nach einem Risk-Management-Exit ausschließlich für den
 * automatischen Cleanup-Invest. Den gibt es seit LIQ#000937 nicht mehr; der Bot eröffnet nur
 * noch beim Rebalance, neues Kapital kommt allein über „Einzahlen". Der Code-Default und die
 * Oberfläche sind gestrichen (lib/pool-settings-defaults.js, bot-liquidity.js).
 *
 * Ein Default-Wegfall allein räumt die Datenbank nicht auf: Jede Zeile, die das Feld je
 * geschrieben hat (Migration 0006 hat bei allen Pools 1 → 6 h gesetzt), trägt es explizit
 * weiter und würde in „vom Standard abweichend" bzw. künftigen Auswertungen auftauchen. Diese
 * Migration entfernt beide Felder aus jeder pool_settings- und pool_type_settings-Zeile des
 * Liquidity Bots — nur die Felder, die übrigen Schlüssel der Abschnitte bleiben unberührt.
 *
 * 🔒 Einstufung `safe`: Kein Code liest die Felder mehr, die Entfernung kann weder Kapital
 * bewegen noch eine Position schließen. Muster: 0015.
 */
import { IMPACT_SAFE } from './runner.js';
import { ensureSourceColumn, hasSourceColumn } from './_settings-history.js';

const SECTIONS = ['trailingStop', 'tvlProtection'];
const field    = (section) => `${section}.cooldownHours`;

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

/** Abschnitte je Zeile, die das Feld noch tragen. */
function analyse(ctx) {
    return [
        ...readRows(ctx.settingsDb, 'pool_settings',      'pool_id',   'pool'),
        ...readRows(ctx.settingsDb, 'pool_type_settings', 'pool_type', 'pool_type'),
    ].map(r => ({
        ...r,
        hits: SECTIONS.filter(sec => r.settings?.[sec] && Object.prototype.hasOwnProperty.call(r.settings[sec], 'cooldownHours')),
    })).filter(r => r.hits.length > 0);
}

const label = (r) => `${r.scope === 'pool_type' ? 'Typ ' : ''}${r.id}`;

export default {
    id:          '0016-drop-cleanup-cooldown-hours',
    description: 'Pool-Einstellungen trailingStop/tvlProtection.cooldownHours entfernen (LIQ#000942)',
    impact:      IMPACT_SAFE,

    async plan(ctx) {
        const rows  = analyse(ctx);
        const count = rows.reduce((n, r) => n + r.hits.length, 0);
        return {
            pending: rows.length > 0,
            summary: rows.length
                ? `${count} Feld/Felder in ${rows.length} Eintrag/Einträgen tragen noch cooldownHours`
                : 'kein Eintrag trägt cooldownHours',
            details: rows.map(r => `${label(r)}: ${r.hits.map(sec => `${sec}.cooldownHours=${r.settings[sec].cooldownHours}`).join(', ')} → entfernt`),
            warnings: [],
        };
    },

    async up(ctx) {
        // Wie 0006/0015: Spalte `source` sicherstellen, damit die Historienzeile als
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

        let removed = 0;
        const tx = ctx.settingsDb.transaction(() => {
            for (const r of rows) {
                for (const sec of r.hits) {
                    const old = r.settings[sec].cooldownHours;
                    delete r.settings[sec].cooldownHours;
                    removed++;
                    if (old !== undefined) history?.run(r.scope, r.id, field(sec), JSON.stringify(old), null, now);
                }
                (r.scope === 'pool' ? upsertPool : upsertType).run(r.id, JSON.stringify(r.settings));
            }
        });
        tx();
        return { changed: rows.length, summary: `cooldownHours: ${removed} Feld/Felder in ${rows.length} Eintrag/Einträgen entfernt` };
    },
};
