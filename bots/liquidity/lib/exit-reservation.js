/**
 * FORGE Liquidity – Exit-Reservierung (lib/exit-reservation.js)
 *
 * Beantwortet genau eine Frage: **Welche Wallet-Bestände gehören gerade zu einem
 * laufenden Exit und dürfen deshalb von niemandem sonst angefasst werden?**
 *
 * ── Warum es das gibt (Ticket LIQ#0310) ─────────────────────────────────────
 * Ein Exit ist mehrstufig: Fee-Claim → decreaseLiquidity → closePosition → Swap →
 * Buchung. Scheitert `closePosition` (NFT-Burn), liegt das Kapital bereits als Token
 * im Wallet — der Exit setzt beim nächsten Durchgang aus 'drained' fort. In genau
 * diesem Fenster war das Geld für jeden anderen Prozess greifbar.
 *
 * Belegt an Position 336 (`liq-orca-sol`, 10.08.2026): Trailing Stop löste um 01:51
 * korrekt aus, `decreaseLiquidity` lief durch, `closePosition` scheiterte. Um 02:05
 * nahm der Cleanup die 811,68 ORCA aus dem Wallet, swappte sie zu 854,71 USDC und
 * investierte sie in `liq-pump-sol` — 17 Minuten bevor der TS-Resume die Position
 * schloss. Kein Kapitalverlust (`portfolio_history` durchgehend stetig), aber der
 * Exit verlor sein Ergebnis und die Pool-PnL beider Pools ist seither falsch (#0311).
 *
 * ── Warum aus der DB abgeleitet und nicht als Lock-Datei ────────────────────
 * Es gibt bereits ein dateibasiertes `rebalance-pending-<poolId>.flag`
 * (`lib/cleanup-lock.js`) für die strukturell gleiche Lage im Rebalancing-Pfad.
 * Für Exits ist ein zweites Flag der falsche Weg — aus drei Gründen:
 *
 *   1. **Keine zweite Wahrheit.** Der Zustand steht bereits in der DB: jede der sechs
 *      Exit-State-Machines legt ihre Zeile mit `step='preparing'` an, *bevor* das erste
 *      Token die Position verlässt, und setzt `step='complete'` erst nach Swap und
 *      Transfer. Eine Flag-Datei daneben könnte davon abdriften.
 *   2. **Kein Lock-Lifecycle.** Kein Setzen, kein Löschen, keine Stale-Timeouts, keine
 *      Leichen nach einem Prozessabbruch — es wird nur gelesen.
 *   3. **Rückwirkend gültig.** Ein Exit, der beim Deploy dieser Datei bereits hing,
 *      ist ab dem ersten Lauf geschützt.
 *
 * Beide Prozesse (`bot.js` als Daemon, `bin/cleanup.js` als Cron) sehen dieselbe
 * SQLite-Datei — die Ableitung ist damit prozessübergreifend sichtbar, was ein
 * In-Memory-Lock in `bot.js` nicht wäre.
 *
 * ── Warum die Prüfung nach MINT geht, nicht nach Pool ───────────────────────
 * Der Cleanup greift ausschließlich mint-basiert zu (`getRelevantTokens()` in
 * `bin/cleanup.js` dedupliziert bewusst nach Mint) — er kennt keine Herkunft eines
 * Wallet-Bestands. Sieben Mints liegen in mehr als einem Pool (cbBTC in dreien; ZEC,
 * HYPE, WBTC, JitoSOL, JLP, Fartcoin in je zweien). Läuft auf `liq-zec-usdc` ein Exit,
 * während der Cleanup in `liq-sol-zec` investiert, sind es physisch dieselben ZEC im
 * Wallet. Eine Prüfung, die nur den Ziel-Pool ansieht, ließe sie durch — deshalb wird
 * pro Pool reserviert, aber pro Mint geprüft.
 *
 * ── Grenze der Maßnahme (bewusst, nicht vergessen) ──────────────────────────
 * Reserviert werden nur die Nicht-USDC- und Nicht-SOL-Mints des Exit-Pools. Das ist
 * deckungsgleich mit dem, was der Cleanup über `getRelevantTokens()` überhaupt
 * anfassen kann. USDC und SOL zu sperren würde den Cleanup bei jedem Exit vollständig
 * stilllegen — USDC ist sein Arbeitsmittel. Ein SOL/USDC-Exit, dessen USDC zwischen
 * Swap und Buchung im Wallet liegen, ist von dieser Maßnahme also nicht abgedeckt;
 * dort ist das Fenster allerdings nur ein Callback breit (`onSwapped` bucht sofort).
 */

import { config } from './config.js';
import {
    getIncompleteTsExecutions,
    getIncompleteTvlExecutions,
    getIncompleteScoreLimitExecutions,
    getIncompleteRetireExecutions,
    getIncompleteSlExecutions,
    getIncompleteTpExecutions,
} from './db.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Die sechs Exit-State-Machines. `sl_executions`/`tp_executions` werden derzeit von
 * keinem Modul mehr geschrieben (Altbestand je eine Zeile, beide 'complete') — sie
 * bleiben trotzdem in der Liste: die Abfrage kostet nichts und ein reaktiviertes
 * Modul wäre sofort mitgeschützt, ohne dass jemand daran denken muss.
 */
const EXIT_SOURCES = [
    { label: 'Trailing Stop', get: getIncompleteTsExecutions },
    { label: 'TVL-Schutz',    get: getIncompleteTvlExecutions },
    { label: 'Score-Limit',   get: getIncompleteScoreLimitExecutions },
    { label: 'Retirement',    get: getIncompleteRetireExecutions },
    { label: 'Stop-Loss',     get: getIncompleteSlExecutions },
    { label: 'Take-Profit',   get: getIncompleteTpExecutions },
];

/**
 * Ab dieser Dauer gilt ein unfertiger Exit als hängend und wird gemeldet.
 *
 * 🔒 Die Reservierung verfällt dabei NICHT. Ein automatischer Verfall würde exakt den
 * Zustand wiederherstellen, den diese Datei verhindern soll — nur zeitverzögert und
 * damit schwerer zuzuordnen. Von den beiden möglichen Fehlern ist „Kapital liegt
 * ungenutzt, bis jemand hinsieht" der deutlich billigere gegenüber „Exit-Erlös auf
 * fremdem Pool gebucht, Pool-PnL dauerhaft falsch". Die Schwelle dient allein dazu,
 * dass niemand den Zustand übersieht.
 *
 * Bemessung: ein Exit läuft normal in Minuten durch, ein hängender wird vom nächsten
 * Bot-Zyklus (5 Min) fortgesetzt. 6 Stunden liegen weit über jedem regulären Ablauf.
 */
export const EXIT_STALE_WARN_MS = 6 * 60 * 60 * 1000;

/**
 * Liest alle unfertigen Exits und leitet daraus die reservierten Mints ab.
 *
 * @param {Database} db  offene Bot-DB
 * @returns {{
 *   mints: Map<string, {mint: string, poolId: string, pair: string, source: string,
 *                       step: string, triggeredAt: number, ageMs: number, stale: boolean}>,
 *   pools: Map<string, Object>,
 *   failures: Array<{source: string, error: string}>,
 *   stale: Array<Object>,
 * }}
 *   `pools` ist nicht aus `mints` ableitbar: ein Exit auf einem reinen USDC/SOL-Pool
 *   (liq-sol-usdc) reserviert keinen einzigen Mint, der Pool selbst ist aber sehr wohl
 *   belegt — in ihn darf der Cleanup nicht investieren, während er geräumt wird.
 *   `failures` ist im Normalfall leer. Ist sie es nicht, konnte mindestens eine
 *   State-Machine nicht gelesen werden — die Reservierung ist dann unvollständig und
 *   der Aufrufer muss konservativ entscheiden (siehe `assertReservationsReadable`).
 */
export function getExitReservations(db) {
    const mints    = new Map();
    const pools    = new Map();
    const failures = [];
    const stale    = [];
    const now      = Date.now();
    const poolById = new Map(config.pools.all.map(p => [p.id, p]));

    for (const source of EXIT_SOURCES) {
        let rows;
        try {
            rows = source.get(db) ?? [];
        } catch (err) {
            // Einzeln abfangen: eine unlesbare Tabelle darf die übrigen fünf nicht
            // mitreißen — jede zusätzliche gelesene Quelle schützt mehr Kapital.
            failures.push({ source: source.label, error: err.message });
            continue;
        }

        for (const row of rows) {
            const pool = poolById.get(row.pool_id);
            if (!pool) {
                // Pool aus der Config entfernt, Exit-Zeile blieb stehen. Die Mints sind
                // ohne Config nicht auflösbar; der Cleanup kann sie über
                // getRelevantTokens() aber ebenfalls nicht mehr sehen — kein Risiko.
                continue;
            }

            const ageMs    = Math.max(0, now - (row.triggered_at ?? now));
            const isStale  = ageMs >= EXIT_STALE_WARN_MS;
            const entryBase = {
                poolId:      pool.id,
                pair:        pool.pair,
                source:      source.label,
                step:        row.step,
                triggeredAt: row.triggered_at,
                ageMs,
                stale:       isStale,
            };
            if (isStale) stale.push({ ...entryBase });

            const knownPool = pools.get(pool.id);
            if (!knownPool || knownPool.triggeredAt > entryBase.triggeredAt) {
                pools.set(pool.id, { ...entryBase });
            }

            for (const mint of [pool.tokenA, pool.tokenB]) {
                // USDC/SOL bewusst ausgenommen — siehe „Grenze der Maßnahme" im Kopf.
                if (!mint || mint === USDC_MINT || mint === WSOL_MINT) continue;
                const existing = mints.get(mint);
                // Bei mehreren Exits auf demselben Mint gewinnt der ältere: er ist der
                // dringlichere Fall und die aussagekräftigere Log-Zeile.
                if (existing && existing.triggeredAt <= entryBase.triggeredAt) continue;
                mints.set(mint, { mint, ...entryBase });
            }
        }
    }

    return { mints, pools, failures, stale };
}

/**
 * Formuliert eine Reservierung als Log-Zeile.
 */
export function describeReservation(entry) {
    const ageMin = entry.ageMs / 60_000;
    const age    = ageMin >= 120 ? `${(ageMin / 60).toFixed(1)}h` : `${ageMin.toFixed(0)} Min`;
    return `${entry.source} auf ${entry.pair} (step='${entry.step}', seit ${age})`;
}

/**
 * Prüft, ob eines der beiden Pool-Token gerade zu einem Exit auf einem ANDEREN Pool
 * gehört (Ticket LIQ#0316, Fortsetzung von LIQ#0310 für bot.js/deposit-lib.js: dort
 * war nur der separate Cleanup-Cron abgesichert, der Bot-Daemon selbst nicht).
 *
 * Bewusst binär (blockiert die ganze Aktion) statt den reservierten Anteil vom
 * verfügbaren Bestand abzuziehen — `getExitReservations` kennt nur ja/nein pro Mint,
 * keine Beträge. Gleiche Kosten-Nutzen-Abwägung wie bei `runCleanupInvestPool` in
 * bin/cleanup.js: ein übersprungener Zyklus ist folgenlos, ein falsch investierter
 * Exit-Erlös nicht.
 *
 * @param {Database} db
 * @param {Object} pool       Pool, für den gerade Kapital bewegt werden soll
 * @param {string} logPrefix
 * @returns {{blocked: boolean, reason: string|null}}
 */
export function foreignExitBlock(db, pool, logPrefix = '[exit-reservation]') {
    const reservations = getExitReservations(db);
    if (!assertReservationsReadable(reservations, logPrefix)) {
        return { blocked: true, reason: 'Exit-Zustand unbekannt' };
    }
    for (const mint of [pool.tokenA, pool.tokenB]) {
        if (!mint) continue;
        const entry = reservations.mints.get(mint);
        if (entry && entry.poolId !== pool.id) {
            return { blocked: true, reason: describeReservation(entry) };
        }
    }
    return { blocked: false, reason: null };
}

/**
 * Prüft, ob die Reservierungen vollständig gelesen werden konnten.
 *
 * Konnte eine State-Machine nicht gelesen werden, ist unbekannt, ob gerade ein Exit
 * läuft. Der Aufrufer muss dann so handeln, als liefe einer — nicht investieren ist
 * folgenlos, falsch investieren nicht.
 *
 * @returns {boolean} true = Reservierungen belastbar
 */
export function assertReservationsReadable(reservations, logPrefix = '[exit-reservation]') {
    if (reservations.failures.length === 0) return true;
    for (const f of reservations.failures) {
        console.error(`${logPrefix} State-Machine '${f.source}' nicht lesbar: ${f.error}`);
    }
    console.error(
        `${logPrefix} Reservierungen unvollständig (${reservations.failures.length} von `
        + `${EXIT_SOURCES.length} Quellen unlesbar) – es ist unbekannt, ob gerade ein Exit läuft.`,
    );
    return false;
}
