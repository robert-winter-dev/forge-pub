#!/usr/bin/env node
/**
 * FORGE LendingBot – Backfill für portfolio_history.positions_value
 * ==============================================================
 * Erstellt: 2026-08-12
 *
 * Hintergrund
 * -----------
 * `portfolio_history.total_value` = Bot-Wallet + Protokoll-Positionen. Für die
 * PnL-Berechnung ist das der falsche Wertbegriff: kein Schreibpfad des
 * LendingBots bewegt Kapital nach außen (deposit/withdraw/move/auto-deploy/
 * auto-exit/emergency verschieben nur zwischen Wallet und Protokoll). Gegen
 * total_value gerechnet ist jede dieser Buchungen wertneutral und erzeugt als
 * cashflow einen Phantom-Verlust in ihrer Höhe.
 *
 * Seit 2026-08-12 schreibt bin/bot.js deshalb zusätzlich `positions_value`
 * (Positionen ohne Wallet). Dieses Script füllt die Spalte für Altzeilen.
 *
 * Quellen, in dieser Reihenfolge:
 *   1. wallet-monitor (FORGE/data/wallet-monitor.db, 10-Min-Raster ab 13.07.2026):
 *      positions_value = total_value − usdc_balance(t).
 *      Nur Snapshots innerhalb MAX_LAG_MS werden akzeptiert.
 *   2. daily_position_snapshots (tagesgenau ab 08.04.2026):
 *      Summe amount_usdc aller Protokolle des Kalendertags — gröber, aber der
 *      direkt gemessene Positionswert.
 *   3. Keine Quelle → Zeile bleibt NULL. lib/pnl.js überspringt solche Zeilen
 *      bewusst (ein Fallback auf total_value würde den Fehler zurückholen).
 *
 * Aufruf:
 *   node bin/backfill-positions-value.js --dry-run   # nur zeigen, nichts schreiben
 *   node bin/backfill-positions-value.js             # schreiben
 *   node bin/backfill-positions-value.js --force     # auch bereits gefüllte Zeilen neu setzen
 *
 * Idempotent: ohne --force werden nur Zeilen mit positions_value IS NULL gefüllt.
 */

import Database from 'better-sqlite3';
import { FORGE_TZ } from '../../../core/config.js';
import { PATHS } from '../../../config/paths.js';

// Pfade über PATHS statt relativ zum Skript: Der Fork legt die Daten NICHT unter
// <bot>/data ab, sondern in einem Geschwister-Verzeichnis der Anwendung
// (`/opt/forge/local/data/lending/…`). Die frühere Ableitung über __dirname traf
// dort ins Leere — das Skript hätte im Fork eine nicht existierende DB geöffnet.
const LEND_DB     = PATHS.lendingDb;
const MONITOR_DB  = PATHS.walletMonitorDb;

// Maximaler Zeitversatz zwischen portfolio_history-Zeile und Wallet-Snapshot.
// Der Monitor läuft alle 10 Min → 15 Min deckt auch einen ausgefallenen Lauf ab,
// ohne einen Wallet-Stand zu verwenden, der zur Zeile nicht mehr passt.
const MAX_LAG_MS = 15 * 60 * 1000;

const args   = process.argv.slice(2);
const DRY    = args.includes('--dry-run');
const FORCE  = args.includes('--force');

if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  Backfill für portfolio_history.positions_value (LendingBot)

    --dry-run   Nur auswerten und Bericht zeigen, nichts schreiben
    --force     Auch bereits gefüllte Zeilen neu berechnen
    --help      Diese Hilfe
`);
    process.exit(0);
}

const db = new Database(LEND_DB);
db.pragma('busy_timeout = 10000');   // Bot schreibt parallel (nur Inserts)

let monitor = null;
try {
    monitor = new Database(MONITOR_DB, { readonly: true });
} catch (e) {
    console.warn(`  ⚠️  wallet-monitor nicht lesbar (${e.message}) – nur Tagesquelle verfügbar.`);
}

// ─── Quelle 1: Wallet-Snapshots (10-Min-Raster) ──────────────────────────────

const walletSnaps = monitor
    ? monitor.prepare(`
        SELECT recorded_at, usdc_balance
          FROM snapshots
         WHERE wallet_id = 'lending' AND usdc_balance IS NOT NULL
         ORDER BY recorded_at ASC
      `).all()
    : [];

/** Nächstgelegener Wallet-USDC-Stand zu ts, oder null wenn zu weit weg. */
function walletUsdcAt(ts) {
    if (!walletSnaps.length) return null;
    let lo = 0, hi = walletSnaps.length - 1, best = null, bestLag = Infinity;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const lag = Math.abs(walletSnaps[mid].recorded_at - ts);
        if (lag < bestLag) { bestLag = lag; best = walletSnaps[mid]; }
        if (walletSnaps[mid].recorded_at < ts) lo = mid + 1; else hi = mid - 1;
    }
    return bestLag <= MAX_LAG_MS ? best.usdc_balance : null;
}

// ─── Quelle 2: daily_position_snapshots (tagesgenau) ─────────────────────────

const dailyByDate = {};
for (const r of db.prepare(`
    SELECT date, SUM(amount_usdc) AS total
      FROM daily_position_snapshots GROUP BY date
`).all()) dailyByDate[r.date] = r.total;

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: FORGE_TZ });

// ─── Backfill ────────────────────────────────────────────────────────────────

const rows = db.prepare(`
    SELECT id, recorded_at, total_value, positions_value
      FROM portfolio_history
     ${FORCE ? '' : 'WHERE positions_value IS NULL'}
     ORDER BY recorded_at ASC
`).all();

console.log(`\n  FORGE LendingBot – Backfill positions_value${DRY ? '  [DRY-RUN]' : ''}`);
console.log(`  ${'─'.repeat(58)}`);
console.log(`  Zu füllende Zeilen : ${rows.length}`);
console.log(`  Wallet-Snapshots   : ${walletSnaps.length}`);
console.log(`  Tages-Snapshots    : ${Object.keys(dailyByDate).length} Tage\n`);

const upd = db.prepare(`UPDATE portfolio_history SET positions_value = ? WHERE id = ?`);
const stats = { wallet: 0, daily: 0, none: 0, negative: 0 };
const updates = [];

for (const row of rows) {
    let val = null;
    let src = null;

    const walletUsdc = walletUsdcAt(row.recorded_at);
    if (walletUsdc != null) {
        val = row.total_value - walletUsdc;
        src = 'wallet';
    } else {
        const day = dateFmt.format(new Date(row.recorded_at));
        if (dailyByDate[day] != null) { val = dailyByDate[day]; src = 'daily'; }
    }

    if (val == null) { stats.none++; continue; }

    // Ein negativer Positionswert ist unmöglich — dann passen Wallet-Stand und
    // total_value nicht zusammen (z.B. Snapshot mitten in einer Umschichtung).
    // Solche Zeilen bleiben NULL statt einen falschen Wert einzufrieren.
    if (val < 0) { stats.negative++; continue; }

    stats[src]++;
    updates.push([Math.round(val * 1e6) / 1e6, row.id]);
}

if (!DRY && updates.length) {
    const tx = db.transaction(list => { for (const [v, id] of list) upd.run(v, id); });
    tx(updates);
}

console.log(`  aus Wallet-Differenz : ${stats.wallet}`);
console.log(`  aus Tages-Snapshot   : ${stats.daily}`);
console.log(`  ohne Quelle (NULL)   : ${stats.none}`);
console.log(`  negativ verworfen    : ${stats.negative}`);
console.log(`\n  ${DRY ? 'Nichts geschrieben (--dry-run).' : `${updates.length} Zeilen aktualisiert.`}\n`);

// ─── Kontrolle: verbleibende Lücken ──────────────────────────────────────────

const gaps = db.prepare(`
    SELECT COUNT(*) AS c FROM portfolio_history WHERE positions_value IS NULL
`).get().c;
const total = db.prepare(`SELECT COUNT(*) AS c FROM portfolio_history`).get().c;
console.log(`  Abdeckung: ${total - gaps}/${total} Zeilen (${((total - gaps) / total * 100).toFixed(1)} %)\n`);

db.close();
if (monitor) monitor.close();
