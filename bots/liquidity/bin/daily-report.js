#!/usr/bin/env node
/**
 * FORGE Liquidity – Tagesbericht der geschlossenen Positionen
 *
 * Läuft täglich um 00:01 und meldet, was am Vortag passiert ist: jede geschlossene Position
 * mit Zeitpunkt, Pool, Ergebnis und dem Grund, aus dem sie geschlossen wurde.
 *
 * 🔒 REIN LESEND. Öffnet alle DBs readonly, schreibt nichts, startet nichts neu.
 *
 * Rechnet **nichts nach** und simuliert nichts — es berichtet, was tatsächlich geschehen ist.
 * (Ein früherer Nachrechnungs-/Regressionsvergleich, `verify-trailing-stop.js`, wurde am
 * 2026-08-23 entfernt: In vier Anläufen kein einziger echter Fund, dafür drei Fehler der
 * Nachrechnung selbst. Siehe KB Core/wirkungsnachweis.md, Abschnitt „Rückbau 2026-08-23".)
 *
 * 🔒 PnL ausschließlich über FORGE/lib/pnl.js (oberste FORGE-Regel). Hier wird keine
 * PnL-Mathematik nachgebaut, auch keine „triviale".
 *
 * Usage:
 *   node bin/daily-report.js                 – Bericht für gestern, Ausgabe auf stdout
 *   node bin/daily-report.js --date TT.MM.JJJJ | JJJJ-MM-TT
 *   node bin/daily-report.js --today         – laufender Tag (für Zwischenstände)
 *   node bin/daily-report.js --notify        – Bericht an Nexus senden (Message Center)
 *   node bin/daily-report.js --json          – Rohdaten
 */

import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'node:fs';

import { pnlForPeriod } from '../../../lib/pnl.js';
import { PATHS } from '../../../config/paths.js';

// ─────────────────────────────────────────────────────────────────────────────
// CLI — Guard vor jedem Seiteneffekt
// ─────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`
FORGE Liquidity – Tagesbericht geschlossener Positionen (rein lesend)

  node bots/liquidity/bin/daily-report.js [Optionen]

  --date <TT.MM.JJJJ|JJJJ-MM-TT>  Bestimmter Tag (Default: gestern)
  --today                         Laufender Tag statt gestern
  --notify                        Bericht an Nexus senden. Ohne dieses Flag wird nie gesendet.
  --json                          Rohdaten als JSON
  --help                          Diese Hilfe
`);
    process.exit(0);
}
const arg = (name, def) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const DO_NOTIFY = argv.includes('--notify');
const AS_JSON   = argv.includes('--json');

const BOT_DB = PATHS.liquidityDb;

// ─── Berichtstag bestimmen (Europe/Berlin, nie toISOString — Zeitzonenregel) ──
const TZ = 'Europe/Berlin';
function berlinDayBounds(dateStr) {
    // Tagesgrenzen über die lokale Kalenderdarstellung bilden, damit Sommer-/Winterzeit
    // korrekt fällt. `sv`-Locale liefert YYYY-MM-DD.
    const base = dateStr ? parseDate(dateStr) : new Date();
    const ymd  = base.toLocaleDateString('sv', { timeZone: TZ });
    const from = new Date(`${ymd}T00:00:00${tzOffset(base)}`).getTime();
    const to   = from + 24 * 3600 * 1000;
    return { ymd, from, to };
}
function tzOffset(d) {
    // Offset von Europe/Berlin zum gegebenen Zeitpunkt als "+02:00"/"+01:00".
    const utc   = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
    const local = new Date(d.toLocaleString('en-US', { timeZone: TZ }));
    const min   = Math.round((local - utc) / 60000);
    const sign  = min >= 0 ? '+' : '-';
    const a     = Math.abs(min);
    return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
function parseDate(s) {
    const de = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
    if (de) return new Date(`${de[3]}-${de[2]}-${de[1]}T12:00:00`);
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (iso) return new Date(`${s}T12:00:00`);
    console.error(`Unbekanntes Datumsformat: ${s} (erwartet TT.MM.JJJJ oder JJJJ-MM-TT)`);
    process.exit(1);
}

const dateArg = arg('--date', null);
const dayRef  = dateArg ? dateArg
              : argv.includes('--today') ? new Date().toLocaleDateString('sv', { timeZone: TZ })
              : new Date(Date.now() - 86400_000).toLocaleDateString('sv', { timeZone: TZ });
const { ymd, from, to } = berlinDayBounds(dayRef);

if (!existsSync(BOT_DB)) { console.error(`liquiditybot.db nicht gefunden: ${BOT_DB}`); process.exit(1); }
const db = new Database(BOT_DB, { readonly: true });

// ─── Pool-Namen wie auf Orca (displayPair), nie die interne ID ────────────────
const displayPair = (() => {
    const m = new Map();
    try {
        for (const p of JSON.parse(readFileSync(PATHS.liquidityPools, 'utf8'))) {
            m.set(p.id, p.displayPair ?? p.pair ?? p.id);
        }
    } catch { /* Fallback unten */ }
    return id => m.get(id) ?? String(id).replace(/^liq-/, '');
})();

// ─── Formatierung (deutsch, wie ein Mensch es liest) ──────────────────────────
const de = (n, d = 2) => (n == null || !Number.isFinite(n))
    ? '—' : n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const deSign = (n, d = 2) => (n == null || !Number.isFinite(n))
    ? '—' : (n > 0 ? '+' : '') + de(n, d);
const clock = t => new Date(t).toLocaleTimeString('de-DE',
    { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dayDe = t => new Date(t).toLocaleDateString('de-DE',
    { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });

// ─────────────────────────────────────────────────────────────────────────────
// Exit-Grund bestimmen
//
// Jeder Mechanismus führt eine eigene Ausführungstabelle. Gesucht ist die Ausführung, die
// zeitlich zum Schließen passt (±2 Min Toleranz: Auslösung und Buchung des Schließens liegen
// ein paar Sekunden bis Minuten auseinander, bei gescheiterten Versuchen auch länger).
//
// Die Schwelle wird mitgenannt, weil sie den Grund erst aussagekräftig macht: „Trailing Stop"
// allein sagt nichts, „Trailing Stop 0,75 %" schon.
// ─────────────────────────────────────────────────────────────────────────────
// 🔒 Das Fenster ist bewusst ASYMMETRISCH. Eine Auslösung kann Stunden vor dem Schließen
// liegen, wenn die Transaktion zunächst scheiterte und erst ein Retry sie abschloss (belegt:
// bis zu 356 Min am 2026-08-22). Ein enges symmetrisches Fenster ordnet solche Exits keinem
// Grund zu und meldet „sonstiges" — also ausgerechnet bei den Fällen, die am meisten
// interessieren. Nach hinten reichen wenige Minuten, dort liegt nur der Buchungsversatz.
//
// Die Untergrenze ist zusätzlich die Eröffnung der Position: Eine Auslösung von davor gehört
// zu einer früheren Position desselben Pools und darf nicht zugeordnet werden.
const MATCH_BEFORE_MS = 12 * 3600 * 1000;
const MATCH_AFTER_MS  = 5 * 60 * 1000;

function exitReason(poolId, closedAt, openedAt) {
    // Trailing Stop — Schwelle aus dem Konfigurations-Schnappschuss der Auslösung, also aus
    // dem, was damals tatsächlich galt. Welche Stufe griff, steht im gemessenen Drawdown.
    const ts = one(`SELECT triggered_at, drawdown_pct, config_snapshot, trigger_source, error_msg
                      FROM ts_executions WHERE pool_id = ? AND triggered_at BETWEEN ? AND ?
                     ORDER BY triggered_at DESC LIMIT 1`, poolId, closedAt, openedAt);
    if (ts) {
        let thr = null;
        try {
            const c  = JSON.parse(ts.config_snapshot);
            const t1 = Number(c.thresholdPct);
            const t2 = c.thresholdPct2 != null ? Number(c.thresholdPct2) : null;
            // Die engere Stufe war aktiv, wenn der Drawdown sie überschritt, aber Stufe 1 nicht.
            thr = (t2 != null && ts.drawdown_pct != null && ts.drawdown_pct < t1) ? t2 : t1;
        } catch { /* ohne Schnappschuss ohne Schwelle */ }
        return { kind: 'Trailing Stop', detail: thr != null ? `${de(thr, 2)} %` : null,
                 failed: !!ts.error_msg };
    }

    // TVL-Schutz — die unterschrittene Schwelle in USDC, plus die Stufe (L1 teilweise, L2 voll).
    const tvl = one(`SELECT triggered_at, level, threshold_usd, withdraw_pct, error_msg
                       FROM tvl_executions WHERE pool_id = ? AND triggered_at BETWEEN ? AND ?
                      ORDER BY triggered_at DESC LIMIT 1`, poolId, closedAt, openedAt);
    if (tvl) {
        const t = tvl.threshold_usd != null
            ? `${Number(tvl.threshold_usd).toLocaleString('de-DE', { maximumFractionDigits: 0 })} USDC` : null;
        const stage = tvl.withdraw_pct != null && tvl.withdraw_pct < 100 ? ` (${tvl.withdraw_pct} %)` : '';
        return { kind: 'TVL-Schutz', detail: t ? `${t}${stage}` : null, failed: !!tvl.error_msg };
    }

    // Score-Limit — der Score, bei dem ausgestiegen wurde.
    const sl = one(`SELECT triggered_at, trigger_score, error_msg
                      FROM score_limit_executions WHERE pool_id = ? AND triggered_at BETWEEN ? AND ?
                     ORDER BY triggered_at DESC LIMIT 1`, poolId, closedAt, openedAt);
    if (sl) {
        return { kind: 'Score-Limit', detail: sl.trigger_score != null ? `Score ${de(sl.trigger_score, 1)}` : null,
                 failed: !!sl.error_msg };
    }

    // Pool-Rückstufung (nur auf Forks relevant, hier der Vollständigkeit halber).
    const rt = one(`SELECT triggered_at, trigger_reason, error_msg
                      FROM retire_executions WHERE pool_id = ? AND triggered_at BETWEEN ? AND ?
                     ORDER BY triggered_at DESC LIMIT 1`, poolId, closedAt, openedAt);
    if (rt) return { kind: 'Pool zurückgestuft', detail: rt.trigger_reason ?? null, failed: !!rt.error_msg };

    // Rebalancing schließt die Position ebenfalls — das ist aber kein Ausstieg, sondern ein
    // Umzug in eine neue Range. Wird deshalb ausdrücklich als solcher benannt.
    const rb = one(`SELECT rebalanced_at AS triggered_at, reason
                      FROM rebalance_history WHERE pool_id = ? AND rebalanced_at BETWEEN ? AND ?
                     ORDER BY rebalanced_at DESC LIMIT 1`, poolId, closedAt, openedAt);
    if (rb) return { kind: 'Rebalancing', detail: rb.reason === 'out_of_range' ? 'Range verlassen' : rb.reason,
                     failed: false, isRebalance: true };

    return { kind: 'sonstiges', detail: null, failed: false };
}
function one(sql, poolId, closedAt, openedAt) {
    // Untergrenze: nie vor die Eröffnung zurück — sonst wird die Auslösung einer früheren
    // Position desselben Pools zugeordnet.
    const lower = Math.max(closedAt - MATCH_BEFORE_MS, openedAt ?? 0);
    try { return db.prepare(sql).get(poolId, lower, closedAt + MATCH_AFTER_MS) ?? null; }
    catch { return null; }   // Tabelle in dieser DB-Generation nicht vorhanden
}

// ─────────────────────────────────────────────────────────────────────────────
// Daten sammeln
// ─────────────────────────────────────────────────────────────────────────────
// Hatte die Position überhaupt Messpunkte? Zwei Quellen, weil die Live-Tabelle bis zum
// Archiv-Fix (#0313) bei jedem Reopen geleert wurde: Das Archiv ist positionsgenau, die
// Live-Tabelle nur pool-bezogen — dort entscheidet das Zeitfenster.
const hasArchive = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='position_snapshots_archive'`).get() != null;
function hasSeries(p) {
    if (hasArchive) {
        const a = db.prepare(
            `SELECT 1 FROM position_snapshots_archive WHERE position_id = ? AND lp_value_usd > 0 LIMIT 1`
        ).get(p.id);
        if (a) return true;
    }
    return db.prepare(
        `SELECT 1 FROM position_snapshots WHERE pool_id = ? AND recorded_at BETWEEN ? AND ?
           AND lp_value_usd > 0 LIMIT 1`
    ).get(p.pool_id, p.opened_at, p.closed_at) != null;
}

const closed = db.prepare(
    `SELECT id, pool_id, opened_at, closed_at, capital_usdc, entry_usd
       FROM positions WHERE closed_at >= ? AND closed_at < ? ORDER BY closed_at`
).all(from, to);

const rows = closed.map(p => {
    const reason = exitReason(p.pool_id, p.closed_at, p.opened_at);
    // 🔒 PnL zentral. Fenster = Lebensdauer genau dieser Position; Ein-/Auszahlungen rechnet
    // lib/pnl.js selbst heraus, sie sind per Definition kein Gewinn.
    let pnlUsd = null;
    try {
        pnlUsd = pnlForPeriod(db, { flavor: 'liquidity', scope: p.pool_id,
                                    fromMs: p.opened_at, toMs: p.closed_at });
    } catch { /* kein PnL ermittelbar */ }
    // 🔒 Ohne Wertreihe liefert die PnL-Kurve exakt 0 — das heißt „keine Messpunkte", nicht
    // „kein Gewinn". Als 0,00 USDC ausgegeben wäre es eine erfundene Zahl, und weil bis zum
    // Archiv-Fix (#0313) die Reihe bei jedem Reopen gelöscht wurde, betrifft das etliche
    // Positionen. Deshalb: keine Messpunkte ⇒ kein Wert.
    if (pnlUsd != null && Math.abs(pnlUsd) < 0.005 && !hasSeries(p)) pnlUsd = null;
    // Bezugsgröße für den Prozentwert: die Einstiegsreferenz der Position, ersatzweise das
    // eingesetzte Kapital. Ohne belastbaren Bezug lieber keine Prozentangabe als eine falsche.
    const base   = p.entry_usd > 0 ? p.entry_usd : (p.capital_usdc > 0 ? p.capital_usdc : null);
    const pnlPct = (pnlUsd != null && base) ? (pnlUsd / base) * 100 : null;
    return {
        id: p.id, pool: p.pool_id, pair: displayPair(p.pool_id),
        openedAt: p.opened_at, closedAt: p.closed_at,
        pnlUsd, pnlPct, base, reason,
    };
});

// Rebalancings sind kein Ausstieg — sie gehören nicht in eine Ergebnisliste, sonst zählt man
// denselben Kapitalstock mehrfach und der Tages-PnL wirkt zerstückelt.
const exits      = rows.filter(r => !r.reason.isRebalance);
const rebalances = rows.filter(r =>  r.reason.isRebalance);
const measured   = exits.filter(r => r.pnlUsd != null);
const sumUsd     = measured.reduce((s, r) => s + r.pnlUsd, 0);
const winners    = measured.filter(r => r.pnlUsd > 0).length;
const losers     = measured.filter(r => r.pnlUsd < 0).length;
const noData     = exits.length - measured.length;
const failed     = exits.filter(r => r.reason.failed).length;

// ─────────────────────────────────────────────────────────────────────────────
// Offene Trades zum Berichtstag (Vorgabe 2026-08-25) — Ergänzung zur Ausstiegs-
// Tabelle oben: was war zum Ende des Berichtstags noch offen. Kriterium bewusst
// NICHT "heute noch offen" (das wäre bei jedem Lauf ein anderer, nicht reproduzierbarer
// Stand), sondern der Zustand exakt zur Tagesgrenze `to`: vor `to` eröffnet UND entweder
// bis heute nie geschlossen oder erst NACH `to` geschlossen (dann war die Position zur
// Tagesgrenze noch offen, taucht aber nicht in der Ausstiegsliste dieses Tages auf).
const open = db.prepare(
    `SELECT id, pool_id, opened_at, capital_usdc, entry_usd
       FROM positions WHERE opened_at < ? AND (closed_at IS NULL OR closed_at >= ?)
      ORDER BY opened_at`
).all(to, to);

const openRows = open.map(p => {
    // 🔒 PnL zentral, wie bei den geschlossenen Trades oben. Fenster = seit Eröffnung
    // bis zur Tagesgrenze `to` — nicht bis "jetzt", damit der Bericht für einen
    // bestimmten Tag reproduzierbar bleibt, egal wann er erzeugt/angesehen wird.
    let pnlUsd = null;
    try {
        pnlUsd = pnlForPeriod(db, { flavor: 'liquidity', scope: p.pool_id,
                                    fromMs: p.opened_at, toMs: to });
    } catch { /* kein PnL ermittelbar */ }
    const base   = p.entry_usd > 0 ? p.entry_usd : (p.capital_usdc > 0 ? p.capital_usdc : null);
    const pnlPct = (pnlUsd != null && base) ? (pnlUsd / base) * 100 : null;
    return {
        id: p.id, pool: p.pool_id, pair: displayPair(p.pool_id),
        openedAt: p.opened_at, share: base, pnlUsd, pnlPct,
    };
});
const openMeasured = openRows.filter(r => r.pnlUsd != null);
const openSumUsd   = openMeasured.reduce((s, r) => s + r.pnlUsd, 0);
const openWinners  = openMeasured.filter(r => r.pnlUsd > 0).length;
const openLosers   = openMeasured.filter(r => r.pnlUsd < 0).length;

// ─────────────────────────────────────────────────────────────────────────────
// Status-Kopf (Vorgabe 2026-08-25): Gezahlte/Erhaltene Fees + Gesamt-PnL des Tages,
// unabhängig von Exits/offenen Trades — steht auch an Tagen ohne Ausstieg.
// 🔒 PnL zentral über lib/pnl.js, Portfolio-weit (scope weggelassen).
// ─────────────────────────────────────────────────────────────────────────────
let statusPnlUsd = null;
try {
    statusPnlUsd = pnlForPeriod(db, { flavor: 'liquidity', fromMs: from, toMs: to });
} catch { /* kein PnL ermittelbar */ }
// Bezugsgröße für den Prozentwert: Portfoliowert zu Tagesbeginn (nächster Snapshot ≤ from,
// ersatzweise der nächste danach) — gleiches Prinzip wie base bei den Positionen oben.
const statusBaseUsd = db.prepare(
    `SELECT total_usd FROM portfolio_history WHERE recorded_at <= ? ORDER BY recorded_at DESC LIMIT 1`
).get(from)?.total_usd
    ?? db.prepare(
    `SELECT total_usd FROM portfolio_history WHERE recorded_at > ? ORDER BY recorded_at ASC LIMIT 1`
    ).get(from)?.total_usd
    ?? null;
const statusPnlPct = (statusPnlUsd != null && statusBaseUsd) ? (statusPnlUsd / statusBaseUsd) * 100 : null;

// Erhaltene Fees: geclaimte LP-Fees des Tages, bereits in USDC (fee_history.usd_value).
const feesReceivedUsd = db.prepare(
    `SELECT COALESCE(SUM(usd_value), 0) AS total FROM fee_history WHERE claimed_at >= ? AND claimed_at < ?`
).get(from, to).total;

// Gezahlte Fees: Solana-TX-Fees des Tages, nur in SOL gespeichert (transactions.tx_fee_sol) —
// Umrechnung über den SOL/USDC-Kurs aus pool_stats, nächster Wert zum Berichtstag.
const txFeesSol = db.prepare(
    `SELECT COALESCE(SUM(tx_fee_sol), 0) AS total FROM transactions
      WHERE created_at >= ? AND created_at < ? AND tx_fee_sol IS NOT NULL`
).get(from, to).total;
const solPriceUsd = db.prepare(
    `SELECT price FROM pool_stats WHERE pool_id = 'liq-sol-usdc' AND recorded_at < ?
      ORDER BY recorded_at DESC LIMIT 1`
).get(to)?.price
    ?? db.prepare(
    `SELECT price FROM pool_stats WHERE pool_id = 'liq-sol-usdc' AND recorded_at >= ?
      ORDER BY recorded_at ASC LIMIT 1`
    ).get(to)?.price
    ?? null;
const feesPaidUsd = solPriceUsd != null ? txFeesSol * solPriceUsd : null;

// ─────────────────────────────────────────────────────────────────────────────
// Ausgabe
// ─────────────────────────────────────────────────────────────────────────────
function buildReport() {
    const L = [];
    const dayLabel = dayDe(from + 12 * 3600 * 1000);

    L.push(`Status ${dayLabel}`);
    L.push(`- Gezahlte Fees: ${feesPaidUsd == null ? '—' : de(feesPaidUsd)} USDC`);
    L.push(`- Erhaltene Fees: ${de(feesReceivedUsd)} USDC`);
    L.push(`- PnL: ${statusPnlUsd == null ? '—' : deSign(statusPnlUsd)} USDC` +
           (statusPnlPct != null ? ` / ${deSign(statusPnlPct, 1)} %` : ''));
    L.push('');

    if (exits.length === 0) {
        L.push(`Am ${dayLabel} wurde keine Position geschlossen.`);
        if (rebalances.length) {
            L.push(`(${rebalances.length}x Rebalancing — das ist ein Range-Wechsel, kein Ausstieg.)`);
        }
        return L.join('\n');
    }

    L.push(`Am ${dayLabel} ${exits.length === 1 ? 'wurde 1 Position' : `wurden ${exits.length} Positionen`} geschlossen.`);
    // Fett wie das Ergebnis in der Trailing-Stop-Meldung (Vorgabe 2026-08-24, gleiches
    // Prinzip: die Kernzahl soll ohne Suchen ins Auge fallen) — *…* wird von
    // inlineMarkdown() (js/message.js) zu <strong>, Telegram interpretiert es nativ als fett.
    L.push(`*Ergebnis zusammen: ${deSign(sumUsd)} USDC* (${winners} im Plus, ${losers} im Minus).`);
    // Ohne diesen Hinweis liest sich die Summe wie das Tagesergebnis aller Exits.
    if (noData) L.push(`Bei ${noData} davon fehlt die Wertreihe — sie sind in der Summe NICHT enthalten.`);
    L.push('');

    // Pipe-Tabelle: Das Message Center rendert daraus eine echte Tabelle mit Spalten und
    // Linien, Telegram zeigt einen Monospace-Block. `---:` = rechtsbündige Zahlenspalte.
    L.push('```');
    L.push('| Zeit | Pool | PnL | Exit-Grund |');
    L.push('|------|------|----:|------------|');
    for (const r of exits) {
        const pnl = r.pnlUsd == null ? '—'
            : `${deSign(r.pnlUsd)} USDC${r.pnlPct != null ? ` (${deSign(r.pnlPct, 1)} %)` : ''}`;
        // Kurzer Marker statt Fließtext in der Zelle (der frühere Zusatz "(Ausfuehrung
        // fehlgeschlagen)" sprengte die Spaltenbreite und blieb für sich genommen unklar —
        // "fehlgeschlagen" klang nach einem offenen Problem, dabei ist die Position ja
        // geschlossen). Die Erklärung dazu steht einmalig in der Fußnote unten.
        const grund = [r.reason.kind, r.reason.detail].filter(Boolean).join(' ')
            + (r.reason.failed ? ' *' : '');
        L.push(`| ${dayDe(r.closedAt)} ${clock(r.closedAt)} Uhr | ${r.pair} | ${pnl} | ${grund} |`);
    }
    L.push('```');

    if (failed) {
        L.push('');
        L.push(`* ${failed === 1 ? 'Bei diesem Ausstieg ist' : `Bei ${failed} dieser Ausstiege ist`} der erste Versuch ` +
               'fehlgeschlagen — der Bot hat es automatisch erneut versucht und die Position damit doch geschlossen.');
    }
    if (rebalances.length) {
        L.push('');
        L.push(`Zusätzlich ${rebalances.length}x Rebalancing (Range-Wechsel, kein Ausstieg) — nicht in der Tabelle.`);
    }

    if (openRows.length) {
        L.push('');
        L.push(`Offene Trades vom ${dayLabel}:`);
        L.push(`${openRows.length} Positionen offen. Davon:`);
        L.push(`*Ergebnis: ${deSign(openSumUsd)} USDC* (${openWinners} im Plus, ${openLosers} im Minus).`);
        L.push('');
        L.push('```');
        L.push('| Eröffnet | Pool | Anteil | PnL |');
        L.push('|----------|------|-------:|----:|');
        for (const r of openRows) {
            const share = r.share == null ? '—' : `${de(r.share)} USDC`;
            const pnl = r.pnlUsd == null ? '—'
                : `${deSign(r.pnlUsd)} USDC${r.pnlPct != null ? ` (${deSign(r.pnlPct, 1)} %)` : ''}`;
            L.push(`| ${dayDe(r.openedAt)} ${clock(r.openedAt)} Uhr | ${r.pair} | ${share} | ${pnl} |`);
        }
        L.push('```');
    }
    return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Strukturierte Daten für die Message-Center-Detailansicht (Vorgabe 2026-08-24,
// analog zu extractRiskExit()/riskExitHtml() bei der Trailing-Stop-Meldung): eigene
// Überschrift, Aufzählung, Tabelle mit getrennten PnL-Spalten und farbigen Zeilen.
// buildReport() bleibt unverändert bestehen — der Fließtext ist weiterhin der
// Fallback für Alt-Clients/Suche (siehe notificationText() in notify-render.js) und
// die einzige Quelle für Telegram, falls die Kategorie dort je freigeschaltet wird.
// Formatierung (deutsches Zahlenformat, Zeitzone) passiert HIER, nicht nochmal in
// bots/settings/routes/messages.js — eine Formatierungsquelle für dieselben Zahlen.
// ─────────────────────────────────────────────────────────────────────────────
function buildReportData() {
    return {
        // Status-Kopf (Vorgabe 2026-08-25), unabhängig von Exits/offenen Trades.
        status: {
            feesPaidText:     feesPaidUsd == null ? null : `${de(feesPaidUsd)} USDC`,
            feesReceivedText: `${de(feesReceivedUsd)} USDC`,
            pnlUsdText:       statusPnlUsd == null ? null : `${deSign(statusPnlUsd)} USDC`,
            pnlPctText:       statusPnlPct == null ? null : `${deSign(statusPnlPct, 1)} %`,
            pnlSign: statusPnlUsd == null ? 0 : (statusPnlUsd > 0 ? 1 : (statusPnlUsd < 0 ? -1 : 0)),
        },
        count: exits.length, winners, losers, noData, failedCount: failed,
        rebalanceCount: rebalances.length,
        sumText: `${deSign(sumUsd)} USDC`,
        sumSign: sumUsd > 0 ? 1 : (sumUsd < 0 ? -1 : 0),
        rows: exits.map(r => ({
            timeText: `${dayDe(r.closedAt)} ${clock(r.closedAt)} Uhr`,
            pair: r.pair,
            pnlUsdText: r.pnlUsd == null ? null : `${deSign(r.pnlUsd)} USDC`,
            pnlPctText: r.pnlPct == null ? null : `${deSign(r.pnlPct, 1)} %`,
            pnlSign: r.pnlUsd == null ? 0 : (r.pnlUsd > 0 ? 1 : (r.pnlUsd < 0 ? -1 : 0)),
            reason: [r.reason.kind, r.reason.detail].filter(Boolean).join(' ') + (r.reason.failed ? ' *' : ''),
        })),
        // Offene Trades zum Ende des Berichtstags (Vorgabe 2026-08-25) — eigene Tabelle
        // im Message Center unterhalb der Ausstiegs-Tabelle, siehe openRows oben.
        openCount: openRows.length,
        openWinners, openLosers,
        openSumText: `${deSign(openSumUsd)} USDC`,
        openSumSign: openSumUsd > 0 ? 1 : (openSumUsd < 0 ? -1 : 0),
        openRows: openRows.map(r => ({
            openedText: `${dayDe(r.openedAt)} ${clock(r.openedAt)} Uhr`,
            pair: r.pair,
            shareText: r.share == null ? null : `${de(r.share)} USDC`,
            pnlUsdText: r.pnlUsd == null ? null : `${deSign(r.pnlUsd)} USDC`,
            pnlPctText: r.pnlPct == null ? null : `${deSign(r.pnlPct, 1)} %`,
            pnlSign: r.pnlUsd == null ? 0 : (r.pnlUsd > 0 ? 1 : (r.pnlUsd < 0 ? -1 : 0)),
        })),
    };
}

if (AS_JSON) {
    process.stdout.write(JSON.stringify({ day: ymd, from, to, exits, rebalances, sumUsd }, null, 2) + '\n');
} else {
    console.log('\n' + buildReport() + '\n');
}

if (DO_NOTIFY) {
    // Message Center > Einstellungen: Tagesbericht ist standardmäßig AN, kann pro
    // FORGE-Installation abgeschaltet werden (feature_daily_report in nexus.db).
    const featureEnabled = await isDailyReportEnabled();
    // 🔒 Keine „nichts passiert"-Meldung: Ein Tag ohne Exit erzeugt keine Nachricht. Sonst
    // gewöhnt man sich an eine tägliche Meldung ohne Inhalt und übersieht die mit Inhalt.
    if (!featureEnabled) {
        console.log('[daily-report] Feature in Einstellungen deaktiviert — keine Meldung.');
    } else if (exits.length === 0) {
        console.log('[daily-report] Keine geschlossene Position — keine Meldung (wie vorgesehen).');
    } else {
        const notify = await import('../lib/notify.js');
        await notify.dailyReport(dayDe(from + 12 * 3600 * 1000), buildReport(), buildReportData());
        console.log('[daily-report] Tagesbericht an Nexus gesendet.');
    }
}

/**
 * Fragt Nexus, ob der Tagesbericht in den Einstellungen aktiv ist. Default AN,
 * auch bei Netzwerkfehlern — das Feature soll nicht durch einen kurzzeitig
 * nicht erreichbaren Nexus stumm ausfallen.
 */
async function isDailyReportEnabled() {
    try {
        const res = await fetch('http://127.0.0.1:3100/features/daily_report');
        if (!res.ok) return true;
        const data = await res.json();
        return data.enabled !== false;
    } catch {
        return true;
    }
}

db.close();
