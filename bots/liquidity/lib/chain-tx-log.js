/**
 * ════════════════════════════════════════════════════════════════════════════
 *  FORGE Liquidity – Log der Legs gebündelter On-Chain-Vorgänge
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  WOZU
 *  ────
 *  Ein Ausstieg besteht on-chain aus bis zu drei Transaktionen: Fee-Claim,
 *  `decreaseLiquidity` und dem Burn des Position-NFT. Gebucht wird davon genau
 *  EINE gemeinsame `close_position`-Zeile — die Fees sind darin bewusst mit dem
 *  Close-Betrag gebündelt (siehe `finalizeClosePosition` in exit-finalizer.js).
 *  Die Hashes der übrigen Legs kannte die DB damit überhaupt nicht.
 *
 *  Für `lib/capital-reconcile.js` sind das unerklärte Abflüsse. Bisher half nur
 *  ein Zeitfenster (±3 Min um eine gebuchte Abfluss-Transaktion). Das hält nicht,
 *  sobald ein Exit auseinandergezogen wird: Am 2026-08-15 brach auf forge-pub1 der
 *  Trailing-Stop-Exit von PUMP/SOL nach dem `decreaseLiquidity` an einem
 *  Orca-Stale-Read ab (0x1775 → 0x177f) und wurde erst 5 Minuten später vom
 *  Resume-Mechanismus zu Ende geführt. Das Decrease-Leg (05:44:43) lag damit
 *  außerhalb des Fensters um die gebuchte Close-TX (05:49:43) — Fehlalarm
 *  „Nicht gebuchte Kapitalbewegung", obwohl der Exit vollständig gebucht war.
 *
 *  🔒 WARUM DER LOG NICHT PAUSCHAL „ERKLÄRT" BEDEUTET
 *  ──────────────────────────────────────────────────
 *  Naheliegend wäre, jede vom Bot gesendete Signatur zu protokollieren und alles
 *  Protokollierte als erklärt zu betrachten. Genau das würde den Abgleich
 *  aushebeln: Sein Ur-Fall ist ein Prozess, der NACH dem Senden und VOR dem
 *  Buchen stirbt — die TX wäre dann protokolliert, aber eben nicht gebucht, und
 *  niemand würde es je merken.
 *
 *  Ein Eintrag hier ist deshalb nur eine Zuordnung ("dieses Leg gehört zu Vorgang
 *  X an Position Y"), kein Freibrief. `isLegBooked()` erklärt ein Leg erst, wenn
 *  der Vorgang, zu dem es gehört, auch tatsächlich in `transactions` gebucht ist.
 *  Stirbt der Bot zwischen Decrease und Buchung, meldet der Abgleich weiterhin.
 * ════════════════════════════════════════════════════════════════════════════
 */

/** Toleranz beim Zeitvergleich Leg ↔ Buchung: die Buchung folgt dem Leg, kleine
 *  Uhr-/Reihenfolge-Unschärfen (blockTime vs. lokale Zeit) sollen sie nicht
 *  verwerfen. Nach oben ist der Abstand bewusst unbegrenzt — ein Resume darf
 *  beliebig lange dauern, entscheidend ist DASS gebucht wurde. */
const BOOKING_CLOCK_SKEW_MS = 60 * 1000;

/** Typen, die den Abschluss eines gebündelten Exit-Vorgangs buchen. */
const CLOSING_TYPES = ['close_position', 'withdraw', 'withdraw_full', 'rebalance'];

/**
 * Vermerkt ein Leg, das bewusst keine eigene transactions-Zeile bekommt.
 * Idempotent (mehrfacher Aufruf mit derselben Signatur ist folgenlos) und
 * absichtlich nicht kritisch: ein Fehler hier darf einen laufenden Exit nicht
 * abbrechen — der Abgleich meldet dann eben, das ist die sichere Richtung.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Object}  leg
 * @param {string}  leg.txHash
 * @param {string}  leg.poolId
 * @param {number} [leg.positionId]  positions.id, zu der das Leg gehört
 * @param {string}  leg.kind         'exit_fee_claim' | 'exit_decrease' | 'exit_burn'
 * @param {string} [leg.note]
 */
export function logChainTx(db, { txHash, poolId, positionId = null, kind, note = null }) {
    if (!txHash || !poolId || !kind) return;
    try {
        db.prepare(`
            INSERT OR IGNORE INTO chain_tx_log (tx_hash, pool_id, position_id, kind, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(txHash, poolId, positionId, kind, note, Date.now());
    } catch (err) {
        console.warn(`[chain-tx-log] ${kind} ${String(txHash).slice(0, 12)}… nicht vermerkt: ${err.message}`);
    }
}

// ─── Sink für den Pool-Adapter ───────────────────────────────────────────────

/**
 * Der Adapter (`lib/pool-adapter/orca.js`) hat keine DB-Referenz, muss seine Legs
 * aber SOFORT nach dem Senden vermerken — nicht erst beim Rückgabewert. Grund:
 * Genau im Vorfall vom 2026-08-15 schlug der Burn direkt nach dem gesendeten
 * `decreaseLiquidity` fehl; `closePosition()` kehrte per Exception zurück, und
 * beim Resume 5 Minuten später war die Liquidität bereits 0 — das kapitalbewegende
 * Leg tauchte in keinem Rückgabewert mehr auf. Vermerkt wird deshalb an der
 * Sendestelle, über diesen Sink.
 *
 * Wird von `openDatabase()` (lib/db.js) gesetzt, sobald die echte Bot-DB offen ist.
 */
let sink = null;

/** @param {(leg: Object) => void} fn */
export function setChainTxSink(fn) {
    sink = fn;
}

/** Meldet ein Leg an den registrierten Sink. Ohne Sink (z.B. Dry-Run-Skripte ohne
 *  DB) folgenlos — der Abgleich meldet dann eben, das ist die sichere Richtung. */
export function emitChainTxLeg(leg) {
    if (!sink) return;
    try { sink(leg); } catch (err) {
        console.warn(`[chain-tx-log] Leg nicht vermerkt: ${err.message}`);
    }
}

/**
 * Ist das Leg zu dieser Signatur einem Vorgang zugeordnet, der auch gebucht wurde?
 *
 * Beides muss zutreffen — die Zuordnung allein genügt nicht (siehe Dateikopf):
 *   1. die Signatur steht als Leg im Log, und
 *   2. für dieselbe Position ist der Abschluss danach tatsächlich gebucht worden
 *      (`transactions` mit einem der CLOSING_TYPES im selben Pool).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} txHash
 * @returns {boolean}
 */
export function isLegBooked(db, txHash) {
    const leg = db.prepare(`SELECT pool_id, position_id, created_at FROM chain_tx_log WHERE tx_hash = ?`).get(txHash);
    if (!leg) return false;

    const booked = db.prepare(`
        SELECT 1 FROM transactions
         WHERE pool_id = ?
           AND type IN (${CLOSING_TYPES.map(() => '?').join(',')})
           AND created_at >= ?
         LIMIT 1
    `).get(leg.pool_id, ...CLOSING_TYPES, leg.created_at - BOOKING_CLOCK_SKEW_MS);

    return !!booked;
}
