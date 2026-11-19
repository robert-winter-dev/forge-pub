/**
 * Slope rows of the 4h window back from '6h' to '4h' — LIQ#002040 (2026-11-18).
 *
 * Since May 2026 (LMB#0116) `bots/liquidity/lib/db.js` renamed every `opportunity_scores` row
 * with timeframe '4h' to '6h' on each DB open. LIQ#002039 (17.11.2026) made 4h a slope window
 * again, so every new 4h row became a second '6h' row at the same timestamp at the next start
 * (master: 1,176 rows; forks too, as soon as the Premium blob delivered 4h slopes). The rename
 * is gone with LIQ#002040; this migration restores the rows already renamed.
 *
 * Which row of a pair was 4h: the one with the smaller `sample_count` (same cadence, a 4h window
 * holds fewer points than a 6h window). Pairs with equal counts or more than two rows are left
 * alone and reported — nothing is guessed. KB: Liquidity Bot/time-windows.md.
 *
 * 🔒 `safe`: opportunity_scores only feeds slope history charts and the Premium `slopes`
 * section; no bot decision reads it, nothing can move capital.
 */
import { IMPACT_SAFE } from './runner.js';

function analyse(db) {
    if (!db) return { fix: [], skipped: [] };
    let groups;
    try {
        groups = db.prepare(`
            SELECT pool_id, recorded_at,
                   json_group_array(json_object('id', id, 'n', sample_count)) AS rows_json
              FROM opportunity_scores
             WHERE timeframe = '6h'
             GROUP BY pool_id, recorded_at
            HAVING COUNT(*) > 1`).all();
    } catch {
        return { fix: [], skipped: [] };   // table missing (older or fresh install) → nothing to do
    }
    const fix = [], skipped = [];
    for (const g of groups) {
        const rows = JSON.parse(g.rows_json);
        const [a, b] = rows;
        if (rows.length !== 2 || a.n == null || b.n == null || a.n === b.n) {
            skipped.push({ poolId: g.pool_id, recordedAt: g.recorded_at, rows });
            continue;
        }
        fix.push({ id: a.n < b.n ? a.id : b.id, poolId: g.pool_id, recordedAt: g.recorded_at });
    }
    return { fix, skipped };
}

export default {
    id:          '0017-opportunity-scores-4h-restore',
    description: 'Slope-Zeilen des 4h-Fensters von 6h zurück auf 4h (LIQ#002040)',
    impact:      IMPACT_SAFE,

    async plan(ctx) {
        const { fix, skipped } = analyse(ctx.liquidityDb);
        const pools = new Set(fix.map(f => f.poolId)).size;
        return {
            pending: fix.length > 0,
            summary: fix.length
                ? `${fix.length} als 6h gespeicherte 4h-Slope-Zeile(n) in ${pools} Pool(s) zurück auf 4h`
                : 'keine doppelten 6h-Slope-Zeilen',
            details: fix.length ? [`Zeitraum ${new Date(Math.min(...fix.map(f => f.recordedAt))).toISOString()} bis ${new Date(Math.max(...fix.map(f => f.recordedAt))).toISOString()}`] : [],
            warnings: skipped.map(s => `${s.poolId} @ ${new Date(s.recordedAt).toISOString()}: nicht eindeutig (${JSON.stringify(s.rows)}), bleibt unverändert`),
        };
    },

    async up(ctx) {
        const db = ctx.liquidityDb;
        const { fix, skipped } = analyse(db);
        if (!fix.length) return { changed: 0, summary: 'nichts zu tun' };
        const upd = db.prepare(`UPDATE opportunity_scores SET timeframe = '4h', window_hours = 4
                                 WHERE id = ? AND timeframe = '6h'`);
        let changed = 0;
        db.transaction(() => { for (const f of fix) changed += upd.run(f.id).changes; })();
        return {
            changed,
            summary: `${changed} Slope-Zeile(n) von 6h auf 4h zurückgesetzt` + (skipped.length ? `, ${skipped.length} nicht eindeutige Paare unverändert` : ''),
        };
    },
};
