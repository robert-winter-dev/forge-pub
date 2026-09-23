/**
 * FORGE Liquidity – Verschiebungs-Bilanz (LIQ#000841)
 *
 * Bei einem Rebalance bleibt ein Teil des freigesetzten Kapitals im Wallet ("Verschiebung").
 * Das ist kein Verlust, arbeitet aber nicht mehr. Dieses Modul führt pro Pool eine Bilanz:
 *
 *   Bilanz = Zugang  (rebalance_history.leftover_usdc seit Kettenstart)
 *          + Startwerte (ledger 'seed')
 *          − Abgang  (ledger 'settle': Nachzahlungen in die Position)
 *
 * Die Bilanz ist zugleich der DECKEL jeder Nachzahlung. Damit muss für volatilePairs keine
 * Wallet-Baseline gemessen werden: Nachgezahlt wird höchstens, was der Bot selbst als
 * nicht reinvestiert gebucht hat, nie fremdes Wallet-Kapital anderer Pools.
 *
 * Nachzahlungen sind KEINE Einzahlung: capital_flows.is_external = 0, sie verschieben weder
 * den PnL-Anker noch zählen sie als neues Kapital (siehe bin/export.js, `_lastDepositAtByPool`).
 *
 * Reine Rechnung + DB-Zugriff über eine übergebene Verbindung; kein Netzwerk. Getestet in
 * bin/test-rebalance-shift.js.
 */
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { PATHS } from '../../../config/paths.js';
import { chainStartOpenedAt } from './pnl-anchor.js';

/** Stufe 1 (direkt nach dem Rebalance): darunter lohnt keine zusätzliche Runde. */
export const SHIFT_STAGE1_MIN_USDC = 5;
/** Stufe 2 (täglicher Check): ab dieser Bilanz wird nachgezahlt (Festlegung 20.09.2026). */
export const SHIFT_TOPUP_MIN_USDC = 10;
/** Höchstens ein Versuch je Pool in diesem Abstand — auch ein gescheiterter zählt. */
export const SHIFT_TOPUP_INTERVAL_MS = 24 * 3_600_000;
/** Nach einem Rebalance erst abwarten: Stufe 1 hat gerade nachgefasst. */
export const SHIFT_TOPUP_MIN_SINCE_REBALANCE_MS = 30 * 60_000;
/** Anteil der Range-Breite an jedem Rand, in dem nicht nachgezahlt wird. */
export const SHIFT_TOPUP_EDGE_MARGIN = 0.15;
/** Dasselbe für den manuell ausgelösten Lauf (force-shift-topup-Flag). */
export const SHIFT_TOPUP_EDGE_MARGIN_FORCE = 0.05;
/** Ab diesem Anteil nicht reinvestierten Kapitals meldet Stufe 1 (und ab SHIFT_STAGE1_MIN_USDC). */
export const SHIFT_ALERT_RATIO = 0.02;

/**
 * Bilanz des Pools in USDC (nie negativ).
 *
 * @param {object} db
 * @param {string} poolId
 * @param {number} chainStartMs  opened_at der ältesten Position der Rebalance-Kette
 */
export function getShiftBalanceUsd(db, poolId, chainStartMs) {
    // Zugang zählt erst ab Go-Live (Marker 'start'): leftover_usdc aus der Zeit davor
    // ignoriert die Bilanz, weil es den volatilePair-Trim nie enthielt und der Rest inzwischen
    // im Wallet anders verwendet worden sein kann. Ein Altbestand kommt nur über 'seed' hinein.
    const goLive = db.prepare(`SELECT MIN(created_at) AS t FROM rebalance_shift_ledger WHERE kind = 'start'`).get()?.t ?? 0;
    const add = db.prepare(`
        SELECT COALESCE(SUM(leftover_usdc), 0) AS s
          FROM rebalance_history
         WHERE pool_id = ? AND rebalanced_at >= ? AND leftover_usdc IS NOT NULL AND leftover_usdc > 0
    `).get(poolId, Math.max(chainStartMs, goLive)).s;
    const led = db.prepare(`
        SELECT kind, COALESCE(SUM(usdc), 0) AS s
          FROM rebalance_shift_ledger
         WHERE pool_id = ? AND created_at >= ? AND kind IN ('seed','settle')
         GROUP BY kind
    `).all(poolId, chainStartMs);
    const seed   = led.find(r => r.kind === 'seed')?.s   ?? 0;
    const settle = led.find(r => r.kind === 'settle')?.s ?? 0;
    return computeShiftBalance({ addUsd: add, seedUsd: seed, settleUsd: settle });
}

/** Rein rechnend: Zugang + Startwerte − Abgang, auf 0 begrenzt. */
export function computeShiftBalance({ addUsd = 0, seedUsd = 0, settleUsd = 0 }) {
    return Math.max(0, addUsd + seedUsd - settleUsd);
}

/**
 * Anzeigewert der Karte "Rebalances", Zeile "Verschiebung": die Bilanz als Minus
 * (Kapital fehlt im Pool), 0 ohne Vorzeichen, wenn nichts aussteht.
 */
export function shiftDisplayUsd(balanceUsd) {
    const v = Math.round((Number(balanceUsd) || 0) * 100) / 100;
    return v > 0 ? -v : 0;
}

/** Bilanz für die offene Position (löst den Kettenstart selbst auf). */
export function getShiftBalanceForPosition(db, position) {
    const chainStart = chainStartOpenedAt(db, position.id, position.opened_at);
    return getShiftBalanceUsd(db, position.pool_id, chainStart);
}

/** Bucht einen Abgang ('settle'), Startwert ('seed'), Versuch ('attempt') oder Go-Live-Marker ('start'); die beiden letzten mit usdc = 0. */
export function insertShiftLedger(db, { poolId, kind, usdc = 0, txHash = null, note = null }) {
    if (!['settle', 'seed', 'attempt', 'start'].includes(kind)) throw new Error(`unbekannte Buchungsart: ${kind}`);
    db.prepare(`
        INSERT INTO rebalance_shift_ledger (pool_id, kind, usdc, tx_hash, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(poolId, kind, usdc, txHash, note, Date.now());
}

/** Zeitpunkt des letzten Nachzahlungs-Versuchs (Versuch oder Abgang) oder null. */
export function lastShiftAttemptMs(db, poolId) {
    const row = db.prepare(`
        SELECT MAX(created_at) AS t FROM rebalance_shift_ledger
         WHERE pool_id = ? AND kind IN ('attempt','settle')
    `).get(poolId);
    return row?.t ?? null;
}

/**
 * Soll der tägliche Check jetzt nachzahlen? Rein rechnend, damit jede Bedingung testbar ist.
 *
 * @returns {{due: boolean, reason: string}}
 */
export function shiftTopUpDecision({
    balanceUsd, inRange, price, priceLower, priceUpper,
    msSinceLastAttempt = Infinity, msSinceLastRebalance = Infinity,
    thresholdUsd = SHIFT_TOPUP_MIN_USDC, force = false,
}) {
    if (!(balanceUsd >= (force ? 1 : thresholdUsd))) {
        return { due: false, reason: `Bilanz ${fmt(balanceUsd)} USDC unter Schwelle ${force ? 1 : thresholdUsd} USDC` };
    }
    if (!inRange) return { due: false, reason: 'Position außerhalb der Range' };
    const width = priceUpper - priceLower;
    if (!(width > 0) || !(price > 0)) return { due: false, reason: 'Range oder Preis unbekannt' };
    const pos = (price - priceLower) / width;
    // Manuell ausgelöst (Flag) gilt ein schmalerer Randabstand: der Auslöser ist beaufsichtigt.
    const edge = force ? SHIFT_TOPUP_EDGE_MARGIN_FORCE : SHIFT_TOPUP_EDGE_MARGIN;
    if (pos < edge || pos > 1 - edge) {
        return { due: false, reason: `Preis nah am Rand (${(pos * 100).toFixed(0)} % der Range)` };
    }
    if (force) return { due: true, reason: 'manuell ausgelöst' };
    if (msSinceLastAttempt < SHIFT_TOPUP_INTERVAL_MS) {
        return { due: false, reason: 'letzter Versuch liegt weniger als 24 h zurück' };
    }
    if (msSinceLastRebalance < SHIFT_TOPUP_MIN_SINCE_REBALANCE_MS) {
        return { due: false, reason: 'Rebalance liegt weniger als 30 min zurück' };
    }
    return { due: true, reason: `Bilanz ${fmt(balanceUsd)} USDC >= ${thresholdUsd} USDC` };
}

/**
 * Wieviel Kapital ein volatilePair-Rebalance wieder einsetzen darf (LIQ#000841).
 * Freigesetzt ist, was der Close geliefert hat (plus im Wallet verbliebene Fees), gedeckelt
 * auf den Wallet-Wert. Der alte Buchwert `capital_usdc` gilt nur noch als Rückfall, wenn
 * die Close-Mengen unbekannt sind — er wächst durch Fee-Reinvest nie und schnitt sonst bei
 * jedem Rebalance den Zuwachs ab (BNB/SOL 18.09.2026: 20,3 von 320,7 USDC).
 */
export function volatileRebalanceCapital({ freedKnownUsd, walletUsd, oldCapitalUsd }) {
    if (freedKnownUsd > 0) return Math.min(freedKnownUsd, walletUsd);
    return oldCapitalUsd > 0 ? Math.min(oldCapitalUsd, walletUsd) : walletUsd;
}

/** Zeitfenster vor dem Close, in dem der Fee-Claim 'vor-rebalance' desselben Rebalances liegt. */
const ABORTED_CLAIM_WINDOW_MS = 15 * 60_000;
/**
 * Höchstalter des Close, damit ein Open noch als nachgeholte Hälfte des Rebalances gilt.
 * Der Regelfall ist der nächste Tick (Minuten). Wer nach einem abgebrochenen Rebalance
 * tagelang geschlossen blieb (z.B. nach MAX_OPEN_POSITION_FAILS deaktiviert), wird bewusst
 * reaktiviert: dann gilt der alte Close-Wert nicht mehr als Ziel, der Max-Einzahlungs-Deckel greift.
 */
export const ABORTED_REBALANCE_MAX_AGE_MS = 24 * 3_600_000;

/**
 * Wurde der letzte Rebalance dieses Pools nach dem Close abgebrochen (LIQ#000866)?
 *
 * Scheitert in `_doRebalance` das Neu-Öffnen (Open-TX abgelaufen, Pre-Swap, Guard), bleibt die
 * alte Position geschlossen, und der nächste Tick eröffnet über `_openNewPosition`. Dieser
 * Wiederholungs-Open ist die zweite Hälfte desselben Rebalances und muss ihn abschließen:
 * Freigesetztes einsetzen, Rest in `rebalance_history.leftover_usdc` buchen. Ohne diese Zeile
 * fehlte der Rest in der Verschiebungs-Bilanz und in lib/pnl.js (walletRestEvents) —
 * Scheinverlust bis zur Nachzahlung (USELESS/SOL 18.09.2026: Close 612,76, Open 538,86 USDC).
 *
 * Bedingungen wie `_abortedRebalancePredecessorId` in pnl-anchor.js (LIQ#000803): jüngste
 * Position des Pools geschlossen, Close-TX mit Notiz 'rebalance' (auch Teilfehlschlag
 * 'rebalance (NFT offen)') innerhalb ±2 min um closed_at. Zusätzlich: noch keine
 * rebalance_history-Zeile mit dieser Position als Vorgänger (sonst ist der Rebalance fertig).
 * Close höchstens ABORTED_REBALANCE_MAX_AGE_MS alt. Aufrufer ruft das nur, wenn keine
 * Position offen ist.
 *
 * @returns {null | {
 *   oldPosition: {id, tick_lower, tick_upper, capital_usdc, hwm_usd, entry_usd, d2_armed_at, closed_at},
 *   closeAmountA: number, closeAmountB: number, closeFeeSol: number,
 *   claimedA: number, claimedB: number, preValueUsd: number|null }}
 */
export function abortedRebalanceContext(db, poolId, nowMs = Date.now()) {
    const prev = db.prepare(`
        SELECT id, tick_lower, tick_upper, capital_usdc, hwm_usd, entry_usd, d2_armed_at, closed_at
          FROM positions WHERE pool_id = ? ORDER BY opened_at DESC LIMIT 1
    `).get(poolId);
    if (!prev || !(prev.closed_at > 0)) return null;
    if (nowMs - prev.closed_at > ABORTED_REBALANCE_MAX_AGE_MS) return null;
    const done = db.prepare(`SELECT 1 FROM rebalance_history WHERE old_position_id = ? LIMIT 1`).get(prev.id);
    if (done) return null;
    const close = db.prepare(`
        SELECT amount_a, amount_b, tx_fee_sol, created_at FROM transactions
         WHERE pool_id = ? AND type = 'close_position' AND note IN ('rebalance', 'rebalance (NFT offen)')
           AND created_at BETWEEN ? AND ?
         ORDER BY created_at DESC LIMIT 1
    `).get(poolId, prev.closed_at - 120000, prev.closed_at + 120000);
    if (!close) return null;
    const claim = db.prepare(`
        SELECT amount_a, amount_b FROM transactions
         WHERE pool_id = ? AND type = 'claim' AND note = 'vor-rebalance'
           AND created_at BETWEEN ? AND ?
         ORDER BY created_at DESC LIMIT 1
    `).get(poolId, close.created_at - ABORTED_CLAIM_WINDOW_MS, close.created_at);
    // Letzter Positionswert vor dem Close: Bezug für den HWM-/Einstiegsübertrag wie in
    // _doRebalance (dort `preValue`). Die Live-Reihe steht noch, geleert wird erst beim Open.
    const snap = db.prepare(`
        SELECT lp_value_usd FROM position_snapshots
         WHERE pool_id = ? AND recorded_at <= ? ORDER BY recorded_at DESC LIMIT 1
    `).get(poolId, prev.closed_at);
    return {
        oldPosition:  prev,
        closeAmountA: Number(close.amount_a) || 0,
        closeAmountB: Number(close.amount_b) || 0,
        closeFeeSol:  Number(close.tx_fee_sol) || 0,
        claimedA:     Number(claim?.amount_a) || 0,
        claimedB:     Number(claim?.amount_b) || 0,
        preValueUsd:  snap?.lp_value_usd ?? null,
    };
}

/**
 * Alarm nach Stufe 1: bleibt nach Reconcile und Sweep noch ein nennenswerter Rest?
 * "Nennenswert" = mindestens SHIFT_STAGE1_MIN_USDC UND mehr als SHIFT_ALERT_RATIO des Kapitals.
 */
export function shiftNeedsAlert(freedUsd, leftoverUsd) {
    return freedUsd > 0 && leftoverUsd >= SHIFT_STAGE1_MIN_USDC && leftoverUsd / freedUsd > SHIFT_ALERT_RATIO;
}

/**
 * Manueller Auslöser: data/force-shift-topup-<pool>.flag. Optionaler JSON-Inhalt
 * `{"seedUsdc": 30.75}` bucht vorab einen einmaligen Startwert (Näherung für Pools, deren
 * Verschiebung vor LIQ#000841 nicht sauber gebucht wurde). Gibt null zurück, wenn kein Flag.
 * @returns {{seedUsdc: number}|null}
 */
export function checkAndClearShiftTopUpFlag(poolId, dir = PATHS.liquidityData) {
    const file = join(dir, `force-shift-topup-${poolId}.flag`);
    if (!existsSync(file)) return null;
    let seedUsdc = 0;
    try {
        const raw = readFileSync(file, 'utf8').trim();
        if (raw) {
            const n = Number(JSON.parse(raw).seedUsdc);
            if (Number.isFinite(n) && n > 0) seedUsdc = n;
        }
    } catch { /* leeres oder ungültiges Flag = ohne Startwert */ }
    try { unlinkSync(file); } catch { /* egal */ }
    return { seedUsdc };
}

function fmt(n) { return Number(n).toFixed(2); }
