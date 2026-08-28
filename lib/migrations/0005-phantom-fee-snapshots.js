/**
 * Phantom-Fee-Messwerte in `position_snapshots` korrigieren (2026-08-22).
 *
 * `collectFeesQuote()` (Orca) rechnet `feeGrowthInside` aus Whirlpool-, Positions- und
 * Tick-Array-Daten. Bis zum 2026-08-22 las `getPositionState()` diese Accounts in zwei
 * Batches — wurde dazwischen eine Tick-Grenze gekreuzt, kippte `feeGrowthOutside` und der
 * Quote lieferte Phantom-Fees in der Größenordnung des Positionswerts.
 *
 * Vorfall TRUMP/SOL: 283,57 USDC „Pending Fees" auf 254,46 USDC Positionswert (on-chain
 * 0,000026 SOL). Weil `lib/pnl.js` die Wertreihe als `lp_value_usd + fees_pending_usd`
 * bildet, zeigte das Dashboard +114 % PnL seit der Einzahlung.
 *
 * Der slot-konsistente Read verhindert neue Fälle, der Guard in `refresh-state.js` fängt
 * ab, was doch durchkommt. Beides wirkt aber nur nach vorn: Ein einmal geschriebener
 * Messwert bleibt dauerhaft in der Wertreihe und verzerrt jedes Fenster, das ihn enthält.
 * Diese Migration räumt die bereits entstandenen Fälle ab.
 *
 * 🔒 Einstufung `safe`: Korrigiert ausschließlich einen Messwert im Verlauf. Kein
 * Kapitalfluss, keine Einstellung, keine Auslösewirkung auf Exits — der Trailing Stop
 * arbeitet mit `lp_value_usd`, und das bleibt unangetastet.
 *
 * 🔒 Korrigiert wird nur die Fee-Komponente, nie der ganze Snapshot. `lp_value_usd` stammt
 * aus einer unabhängigen Rechnung (Liquidität × Preis) und war im Vorfall korrekt. Die
 * Zeile zu löschen würde eine Lücke in die Wertreihe reißen, wo eine gültige Messung steht.
 *
 * Dieselbe Regel wie der Live-Guard, aus derselben Quelle (`lib/fee-plausibility.js`) —
 * sonst korrigiert die Migration Werte, die der Guard durchgelassen hätte, oder umgekehrt.
 */
import { IMPACT_SAFE } from './runner.js';
import { checkFeeJump } from '../fee-plausibility.js';

/** Beide Tabellen tragen dieselben Spalten — die Archiv-Tabelle existiert erst seit dem 22.08. */
const TABLES = ['position_snapshots', 'position_snapshots_archive'];

function tableExists(db, name) {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

const fmtTs = (ms) => new Date(ms).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour12: false });

/**
 * Sucht in einer Tabelle nach Fee-Sprüngen, die die Plausibilitätsregel verletzen.
 *
 * Pro Pool wird die Reihe zeitlich vorwärts durchlaufen — genau die Blickrichtung des
 * Live-Guards. Als Vorgänger zählt der **korrigierte** Wert: Zwei aufeinanderfolgende
 * Phantom-Werte würden sonst gegeneinander verglichen (der zweite hätte kein auffälliges
 * Delta mehr) und der zweite bliebe stehen.
 */
function findBadRows(db, table) {
    if (!tableExists(db, table)) return [];

    const rows = db.prepare(`
        SELECT id, pool_id, recorded_at, lp_value_usd, fees_pending_usd, fees_pending_a, fees_pending_b
          FROM ${table}
         ORDER BY pool_id, recorded_at
    `).all();

    const bad = [];
    let currentPool = null;
    let prev        = null;

    for (const row of rows) {
        if (row.pool_id !== currentPool) { currentPool = row.pool_id; prev = null; }
        if (!prev) { prev = row; continue; }

        const verdict = checkFeeJump({
            feesUsd:     row.fees_pending_usd,
            prevFeesUsd: prev.fees_pending_usd,
            lpValueUsd:  row.lp_value_usd,
            elapsedMs:   row.recorded_at - prev.recorded_at,
        });

        if (verdict.implausible) {
            bad.push({
                table,
                id:            row.id,
                poolId:        row.pool_id,
                recordedAt:    row.recorded_at,
                lpValueUsd:    row.lp_value_usd,
                measuredUsd:   row.fees_pending_usd,
                impliedAprPct: verdict.impliedAprPct,
                fix: {
                    fees_pending_usd: prev.fees_pending_usd,
                    fees_pending_a:   prev.fees_pending_a,
                    fees_pending_b:   prev.fees_pending_b,
                },
            });
            // Vorgänger bleibt der letzte GÜLTIGE Wert — der Phantom-Wert wird ja ersetzt.
            continue;
        }
        prev = row;
    }
    return bad;
}

function analyse(ctx) {
    if (!ctx.liquidityDb) return [];
    return TABLES.flatMap(t => findBadRows(ctx.liquidityDb, t));
}

export default {
    id:          '0005-phantom-fee-snapshots',
    description: 'Phantom-Fee-Messwerte in der Positions-Wertreihe korrigieren',
    impact:      IMPACT_SAFE,

    async plan(ctx) {
        const bad = analyse(ctx);
        return {
            pending: bad.length > 0,
            summary: bad.length
                ? `${bad.length} Snapshot(s) mit unplausiblen Pending Fees`
                : 'keine unplausiblen Fee-Messwerte gefunden',
            details: bad.map(b =>
                `${b.poolId} · ${fmtTs(b.recordedAt)}: ${b.measuredUsd.toFixed(2)} USDC Fees bei ` +
                `${b.lpValueUsd.toFixed(2)} USDC Positionswert (${Math.round(b.impliedAprPct).toLocaleString('de-DE')} % APR) ` +
                `→ ${b.fix.fees_pending_usd.toFixed(4)} USDC` +
                (b.table === 'position_snapshots_archive' ? ' [Archiv]' : '')),
            warnings: [],
        };
    },

    async up(ctx) {
        const bad = analyse(ctx);
        if (bad.length === 0) return { changed: 0, summary: 'nichts zu korrigieren' };

        const stmts = Object.fromEntries(TABLES
            .filter(t => tableExists(ctx.liquidityDb, t))
            .map(t => [t, ctx.liquidityDb.prepare(
                `UPDATE ${t} SET fees_pending_usd = ?, fees_pending_a = ?, fees_pending_b = ? WHERE id = ?`,
            )]));

        // Eine Transaktion: entweder die ganze Wertreihe ist korrigiert oder keine Zeile —
        // ein halb korrigierter Verlauf wäre schwerer zu deuten als der ursprüngliche Fehler.
        const run = ctx.liquidityDb.transaction((list) => {
            for (const b of list) {
                stmts[b.table].run(b.fix.fees_pending_usd, b.fix.fees_pending_a, b.fix.fees_pending_b, b.id);
            }
        });
        run(bad);

        const pools = [...new Set(bad.map(b => b.poolId))];
        return {
            changed: bad.length,
            summary: `${bad.length} Snapshot(s) in ${pools.length} Pool(s) korrigiert: ${pools.join(', ')}`,
        };
    },
};
