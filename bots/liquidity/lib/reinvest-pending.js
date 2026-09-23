/**
 * FORGE Liquidity – ausstehender Fee-Reinvest (LIQ#000868)
 *
 * Der Reinvest läuft nur direkt nach einem Fee-Claim, mit genau den geclaimten Mengen.
 * Scheitert er (increaseLiquidity abgelaufen, 0x17b5, Wallet-Seite 0 nach einseitigem
 * Claim), gab es bis LIQ#000868 keinen zweiten Versuch: Im nächsten Zyklus ist nichts
 * mehr zu claimen, die Tokens blieben im Wallet und zählten in lib/pnl.js als
 * abgeflossene Fees (USELESS/SOL 01.–21.09.2026: 23 Claims, 27,51 USDC).
 *
 * Dieses Modul merkt die nicht reinvestierte Menge je Pool vor. Nachgeholt wird
 *   - beim nächsten Claim (Menge wird zu den Claim-Mengen addiert) und
 *   - ohne Claim alle REINVEST_RETRY_INTERVAL_MS, höchstens REINVEST_RETRY_MAX_ATTEMPTS mal.
 *
 * 🔒 Schutz gegen fremdes Wallet-Kapital: Die Vormerkung ist der Deckel (zusätzlich zum
 * Wallet-Deckel in _reinvest). Sie verfällt nach REINVEST_PENDING_MAX_AGE_MS und sobald die
 * offene Position zu einer anderen Rebalance-Kette gehört (Exit + Neueröffnung): Dann hat
 * der Exit die Tokens bereits verwertet, und was jetzt im Wallet liegt, gehört nicht mehr
 * zu diesem Claim.
 *
 * Reine Rechnung plus DB-Zugriff über eine übergebene Verbindung; kein Netzwerk.
 * Test: bin/test-reinvest-pending.js.
 */

/** Nach dieser Zeit ab dem ältesten nicht reinvestierten Claim wird nicht mehr nachgeholt. */
export const REINVEST_PENDING_MAX_AGE_MS = 48 * 3_600_000;
/** Abstand der Nachhol-Versuche ohne neuen Claim. */
export const REINVEST_RETRY_INTERVAL_MS = 15 * 60_000;
/** Danach nur noch beim nächsten Claim (jeder Versuch kann einen SOL-Topup auslösen). */
export const REINVEST_RETRY_MAX_ATTEMPTS = 6;

export const REINVEST_PENDING_SCHEMA = `
    CREATE TABLE IF NOT EXISTS reinvest_pending (
        pool_id          TEXT    PRIMARY KEY,
        amount_a         REAL    NOT NULL,   -- nicht reinvestierte Token-A-Menge (Reinvest-Anteil)
        amount_b         REAL    NOT NULL,
        usd_value        REAL,               -- Wert beim Vormerken, nur für Log/Anzeige
        reason           TEXT,               -- letzter Fehler
        first_at         INTEGER NOT NULL,   -- ältester nicht reinvestierter Claim (ms)
        attempts         INTEGER NOT NULL DEFAULT 0,  -- Nachhol-Versuche ohne Claim
        last_attempt_at  INTEGER NOT NULL
    )`;

/** @returns {null|{pool_id, amount_a, amount_b, usd_value, reason, first_at, attempts, last_attempt_at}} */
export function getPendingReinvest(db, poolId) {
    return db.prepare(`SELECT * FROM reinvest_pending WHERE pool_id = ?`).get(poolId) ?? null;
}

/**
 * Setzt (ersetzt) die Vormerkung. `amountA/B` ist die GESAMTE noch offene Menge, nicht ein
 * Zuwachs — der Aufrufer hat alte Vormerkung und neuen Claim bereits zusammengezählt.
 */
export function setPendingReinvest(db, { poolId, amountA, amountB, usdValue = null, reason = null, firstAt, attempts = 0, now = Date.now() }) {
    db.prepare(`
        INSERT INTO reinvest_pending (pool_id, amount_a, amount_b, usd_value, reason, first_at, attempts, last_attempt_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pool_id) DO UPDATE SET
            amount_a = excluded.amount_a, amount_b = excluded.amount_b, usd_value = excluded.usd_value,
            reason = excluded.reason, first_at = excluded.first_at, attempts = excluded.attempts,
            last_attempt_at = excluded.last_attempt_at
    `).run(poolId, amountA, amountB, usdValue, reason, firstAt ?? now, attempts, now);
}

export function clearPendingReinvest(db, poolId) {
    db.prepare(`DELETE FROM reinvest_pending WHERE pool_id = ?`).run(poolId);
}

/**
 * Darf die Vormerkung noch nachgeholt werden?
 *
 * @param {object} pending       Zeile aus getPendingReinvest
 * @param {number} now
 * @param {number} chainStartMs  opened_at der ältesten Position der aktuellen Rebalance-Kette
 *                               (pnl-anchor.js chainStartOpenedAt); null = keine offene Position
 * @returns {{valid: boolean, reason: string}}
 */
export function pendingValidity(pending, { now, chainStartMs }) {
    if (!pending) return { valid: false, reason: 'keine Vormerkung' };
    if (!(pending.amount_a > 0) && !(pending.amount_b > 0)) return { valid: false, reason: 'Menge 0' };
    if (now - pending.first_at > REINVEST_PENDING_MAX_AGE_MS) {
        return { valid: false, reason: `älter als ${REINVEST_PENDING_MAX_AGE_MS / 3_600_000} h` };
    }
    if (chainStartMs == null) return { valid: false, reason: 'keine offene Position' };
    // Vorgemerkt vor dem Start der aktuellen Kette → dazwischen lag ein Exit, kein Rebalance.
    if (pending.first_at < chainStartMs) return { valid: false, reason: 'Position seit der Vormerkung neu eröffnet (kein Rebalance)' };
    return { valid: true, reason: 'ok' };
}

/**
 * Nachhol-Versuch ohne neuen Claim jetzt fällig? Nur wenn beide Seiten vorgemerkt sind —
 * eine einseitige Menge (einseitiger Claim) lässt sich in einer Range-Position nicht allein
 * einzahlen und wartet auf den nächsten Claim.
 */
export function standaloneRetryDue(pending, now) {
    if (!pending) return false;
    if (!(pending.amount_a > 0) || !(pending.amount_b > 0)) return false;
    if (pending.attempts >= REINVEST_RETRY_MAX_ATTEMPTS) return false;
    return now - pending.last_attempt_at >= REINVEST_RETRY_INTERVAL_MS;
}

/**
 * Menge für den nächsten Reinvest: neuer Claim-Anteil plus gültige Vormerkung.
 * @returns {{amountA, amountB, firstAt, carriedA, carriedB}}
 */
export function mergeWithPending(amountA, amountB, pending, valid, now) {
    const carriedA = valid ? (pending?.amount_a ?? 0) : 0;
    const carriedB = valid ? (pending?.amount_b ?? 0) : 0;
    return {
        amountA:  amountA + carriedA,
        amountB:  amountB + carriedB,
        firstAt:  valid && pending ? pending.first_at : now,
        carriedA, carriedB,
    };
}

/**
 * Was nach einem Reinvest-Versuch mit der Vormerkung passiert.
 *   'retry' → gesamte Menge (Claim + Vormerkung) neu vormerken; ein Nachhol-Versuch ohne
 *             Claim zählt `attempts` hoch, ein neuer Claim setzt sie zurück.
 *   'hold'  → SOL-Guard / fremder Exit: neue Claim-Menge NICHT vormerken (gehört dem Topup
 *             bzw. Exit), eine bestehende Vormerkung bleibt stehen (beim Nachhol-Versuch
 *             als Versuch gezählt).
 *   sonst   → ('ok', 'dust', 'none') eine gültige Vormerkung ist erledigt.
 *
 * @returns {{action: 'set'|'clear'|'keep', row?: object}}
 */
export function pendingAfterOutcome({ status, merged, pending, valid, standalone, reason = null, usdValue = null, poolId, now }) {
    if (status === 'retry') {
        return {
            action: 'set',
            row: {
                poolId, amountA: merged.amountA, amountB: merged.amountB, usdValue, reason,
                firstAt: merged.firstAt,
                attempts: standalone ? ((valid ? pending?.attempts : 0) ?? 0) + 1 : 0,
                now,
            },
        };
    }
    if (status === 'hold' && standalone && valid) {
        // Nachhol-Versuch am SOL-Guard gescheitert: Vormerkung unverändert, aber als Versuch
        // zählen — sonst liefe der Guard (samt möglichem SOL-Topup) in jedem Tick erneut.
        return {
            action: 'set',
            row: {
                poolId, amountA: pending.amount_a, amountB: pending.amount_b, usdValue: pending.usd_value,
                reason: reason ?? pending.reason, firstAt: pending.first_at,
                attempts: (pending.attempts ?? 0) + 1, now,
            },
        };
    }
    if (status === 'hold' || !valid) return { action: 'keep' };
    return { action: 'clear' };
}
