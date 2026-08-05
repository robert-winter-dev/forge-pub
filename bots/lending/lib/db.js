/**
 * FORGE LendingBot – SQLite Datenbankzugriff
 *
 * Schema:
 *   positions                 – Aktive Lending-Positionen
 *   pending_withdrawals       – Ausstehende Withdrawals mit Cooldown-Prozess
 *   protocol_stats            – APY-Zeitreihe pro Protokoll (für Dashboard-Chart)
 *   wallet_snapshot           – Letzter Portfolio-Snapshot (für Dashboard-Metriken)
 *   transactions              – Alle Events (deposit, withdraw, claim, rebalance)
 *   kv_config                 – Bot-Konfiguration (key-value)
 *   daily_position_snapshots  – Tagesanfangs-Snapshot je Protokoll (für statistics.today)
 *
 * WICHTIG: Niemals direkt UPDATE/INSERT/DELETE auf positions oder transactions
 *          ausführen – alle Änderungen laufen über die Hilfsfunktionen hier.
 */

import Database from 'better-sqlite3';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { config } from './config.js';
import { PATHS }  from '../../../config/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = PATHS.lendingData;
const DB_PATH   = PATHS.lendingDb;

mkdirSync(DATA_DIR, { recursive: true });

// ─── Verbindung ───────────────────────────────────────────────────────────────

let _db = null;

export function getDb() {
    if (!_db) {
        _db = new Database(DB_PATH);
        _db.pragma('journal_mode = WAL');
        _db.pragma('foreign_keys = ON');
        initSchema(_db);
    }
    return _db;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

function initSchema(db) {
    db.exec(`
        -- Aktive Lending-Positionen
        CREATE TABLE IF NOT EXISTS positions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id          TEXT    NOT NULL,
            protocol        TEXT    NOT NULL,   -- 'kamino' | 'jupiter' | 'loopscale-genesis' | ...
            pool_type       TEXT    NOT NULL,   -- 'lending' | 'regular' | 'protected'
            asset           TEXT    NOT NULL DEFAULT 'USDC',
            amount          REAL    NOT NULL,   -- Deposit-Betrag in USDC
            current_apy     REAL,               -- Zuletzt bekannter APY (%)
            tx_hash         TEXT,               -- Deposit-TX
            started_at      INTEGER NOT NULL,   -- Unix-Timestamp (ms)
            last_updated_at INTEGER NOT NULL,   -- Letztes APY/Balance-Refresh
            closed_at       INTEGER             -- NULL = aktiv
        );

        -- Ausstehende Withdrawals mit Cooldown-Prozess
        CREATE TABLE IF NOT EXISTS pending_withdrawals (
            id                    INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id                TEXT    NOT NULL,
            protocol              TEXT    NOT NULL,
            pool_type             TEXT    NOT NULL DEFAULT 'regular',
            asset                 TEXT    NOT NULL DEFAULT 'USDC',
            amount                REAL    NOT NULL,   -- angeforderter Betrag
            pending_withdrawal_id INTEGER,            -- on-chain ID für Schritt 2
            initiate_tx_hash      TEXT,               -- TX Schritt 1
            complete_tx_hash      TEXT,               -- TX Schritt 2 (nach Cooldown)
            initiated_at          INTEGER NOT NULL,   -- Unix-Timestamp (ms)
            cooldown_seconds      INTEGER NOT NULL DEFAULT 604800, -- 7 Tage default
            completed_at          INTEGER             -- NULL = noch ausstehend
        );

        -- APY-Zeitreihe (stündlich) – Basis für den APY-Chart im Dashboard
        CREATE TABLE IF NOT EXISTS protocol_stats (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id      TEXT    NOT NULL,
            protocol    TEXT    NOT NULL,   -- 'kamino' | 'drift' | 'loopscale-onre' | ...
            pool_type   TEXT    NOT NULL,   -- 'lending' | 'regular' | 'protected'
            apy         REAL    NOT NULL,   -- APY in %
            tvl         REAL,               -- Total Value Locked in USDC (null = nicht verfügbar)
            recorded_at INTEGER NOT NULL    -- Unix-Timestamp (ms)
        );

        CREATE INDEX IF NOT EXISTS idx_protocol_stats_time
            ON protocol_stats(bot_id, protocol, recorded_at);

        -- Letzter Portfolio-Snapshot (für Dashboard-Metriken)
        CREATE TABLE IF NOT EXISTS wallet_snapshot (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id          TEXT NOT NULL UNIQUE,
            current_value   REAL NOT NULL DEFAULT 0,  -- Aktueller Wert aller Positionen
            total_yield     REAL NOT NULL DEFAULT 0,  -- Kumulierter Yield
            avg_apy         REAL NOT NULL DEFAULT 0,  -- Gewichteter Durchschnitt APY
            wallet_usdc     REAL NOT NULL DEFAULT 0,  -- Freie USDC in Wallet
            wallet_sol      REAL NOT NULL DEFAULT 0,  -- SOL-Balance
            recorded_at     INTEGER NOT NULL          -- Unix-Timestamp (ms)
        );

        -- Portfolio-Verlauf (für Guthaben-Chart)
        CREATE TABLE IF NOT EXISTS portfolio_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id      TEXT NOT NULL,
            total_value REAL NOT NULL,
            recorded_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_portfolio_history_time
            ON portfolio_history(bot_id, recorded_at);

        -- Alle Transaktions-Events
        CREATE TABLE IF NOT EXISTS transactions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id      TEXT NOT NULL,
            type        TEXT NOT NULL,  -- 'deposit' | 'withdraw' | 'claim' | 'rebalance'
            protocol    TEXT NOT NULL,
            pool_type   TEXT NOT NULL,
            asset       TEXT NOT NULL DEFAULT 'USDC',
            amount      REAL NOT NULL,
            tx_hash     TEXT,
            fee_sol     REAL,           -- Solana-Netzwerkgebühr in SOL (aus tx.meta.fee)
            note        TEXT,
            created_at  INTEGER NOT NULL  -- Unix-Timestamp (ms)
        );

        CREATE INDEX IF NOT EXISTS idx_transactions_time
            ON transactions(bot_id, created_at DESC);

        -- Benachrichtigungen (für Dashboard Notification Panel)
        CREATE TABLE IF NOT EXISTS notifications (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id     TEXT NOT NULL,
            level      TEXT NOT NULL DEFAULT 'info',  -- 'info' | 'warn' | 'error'
            message    TEXT NOT NULL,
            ts         INTEGER NOT NULL,
            dismissed  INTEGER NOT NULL DEFAULT 0
        );

        -- Bot-Zustand (key-value store)
        CREATE TABLE IF NOT EXISTS kv_config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- Tagesanfangs-Snapshot je Protokoll (Berlin-Zeit)
        -- Basis für statistics.today: rauschfreies Delta positions.amount − snapshot.
        -- positions.amount steigt monoton (on-chain akkumuliert) → kein API-Rauschen.
        -- Wird einmal pro Kalendertag (Berlin) beim ersten Tick geschrieben.
        CREATE TABLE IF NOT EXISTS daily_position_snapshots (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            bot_id      TEXT    NOT NULL,
            date        TEXT    NOT NULL,  -- 'YYYY-MM-DD' Berlin-Zeit
            protocol    TEXT    NOT NULL,
            amount_usdc REAL    NOT NULL,
            recorded_at INTEGER NOT NULL   -- Unix-Timestamp (ms) – für Debugging
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_snapshots_date_protocol
            ON daily_position_snapshots(bot_id, date, protocol);
    `);

    // ── Migration: tvl-Spalte nachrüsten falls DB vor v0.3.0 erstellt wurde ──
    try {
        db.exec(`ALTER TABLE protocol_stats ADD COLUMN tvl REAL`);
    } catch { /* Spalte existiert bereits – kein Fehler */ }

    // ── Migration: fee_sol-Spalte nachrüsten falls DB vor v0.4.0 erstellt wurde ──
    try {
        db.exec(`ALTER TABLE transactions ADD COLUMN fee_sol REAL`);
    } catch { /* Spalte existiert bereits – kein Fehler */ }

    // ── Migration: sol_price-Spalte für Analyse (portfolio_history) ──
    try {
        db.exec(`ALTER TABLE portfolio_history ADD COLUMN sol_price REAL`);
    } catch { /* Spalte existiert bereits – kein Fehler */ }
}

// ─── Positions ────────────────────────────────────────────────────────────────

/** Alle aktiven Positionen (closed_at IS NULL) */
export function getActivePositions() {
    return getDb()
        .prepare('SELECT * FROM positions WHERE bot_id = ? AND closed_at IS NULL ORDER BY started_at ASC')
        .all(config.botId);
}

/** Position öffnen (Deposit) */
export function openPosition({ protocol, poolType, asset = 'USDC', amount, txHash = null }) {
    const now = Date.now();
    return getDb()
        .prepare(`
            INSERT INTO positions (bot_id, protocol, pool_type, asset, amount, tx_hash, started_at, last_updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(config.botId, protocol, poolType, asset, amount, txHash, now, now);
}

/** Alias für openPosition – für Auto-Deposit und Rebalancer */
export const addPosition = openPosition;

/** Position aktualisieren (APY-Refresh, Wert-Update) */
export function updatePosition(id, { amount, currentApy }) {
    return getDb()
        .prepare(`UPDATE positions SET
            amount          = ?,
            current_apy     = COALESCE(?, current_apy),
            last_updated_at = ?
            WHERE id = ?`)
        .run(amount, currentApy ?? null, Date.now(), id);
}

/** Position schließen (Withdraw abgeschlossen) */
export function closePosition(id) {
    return getDb()
        .prepare('UPDATE positions SET closed_at = ? WHERE id = ?')
        .run(Date.now(), id);
}

/**
 * Betrag einer bestehenden Position erhöhen (erneuter Deposit ins selbe Protokoll).
 */
export function addToPosition(id, additionalAmount) {
    return getDb()
        .prepare(`UPDATE positions SET
            amount          = amount + ?,
            last_updated_at = ?
            WHERE id = ?`)
        .run(additionalAmount, Date.now(), id);
}

/** @deprecated Verwende addToPosition */
export const addToPositionBaseline = addToPosition;

// ─── Pending Withdrawals ────────────────────────────────────────────────────────

/** Alle offenen Pending-Withdrawals */
export function getPendingWithdrawals() {
    return getDb()
        .prepare('SELECT * FROM pending_withdrawals WHERE bot_id = ? AND completed_at IS NULL ORDER BY initiated_at ASC')
        .all(config.botId);
}

/** Pending Withdrawal anlegen (nach Schritt 1) */
export function createPendingWithdrawal({ amount, pendingWithdrawalId = null, initiateTxHash = null, cooldownSeconds = 604800 }) {
    return getDb()
        .prepare(`
            INSERT INTO pending_withdrawals (bot_id, amount, pending_withdrawal_id, initiate_tx_hash, initiated_at, cooldown_seconds)
            VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(config.botId, amount, pendingWithdrawalId, initiateTxHash, Date.now(), cooldownSeconds);
}

/**
 * Pending Withdrawal abschließen (nach Schritt 2 / Cooldown).
 *
 * ⚠️ LB#0161 – Reihenfolge-Invariante für künftige Schritt-2-Implementierung:
 * Die On-Chain-Position MUSS reduziert/geschlossen werden (updatePosition/closePosition)
 * BEVOR die zugehörige `withdraw`-Transaktion via recordTransaction gebucht wird. Sonst
 * sinkt `netInvested` (Σ deposits − withdraws) bevor `positions.amount` fällt, und der
 * Dashboard-Yield (amount − netInvested) springt temporär um den Entnahmebetrag hoch
 * (Phantom-Yield). Vorbild: bin/withdraw.js (immediate) und bin/bot.js (Auto-Exit) ziehen
 * die Position bereits vor recordTransaction ab. Als Sicherheitsnetz deckelt export.js den
 * per-Pool accruedYield zusätzlich auf den plausiblen Lifetime-Yield (APY × Laufzeit).
 */
export function completePendingWithdrawal(id, completeTxHash = null) {
    return getDb()
        .prepare('UPDATE pending_withdrawals SET completed_at = ?, complete_tx_hash = ? WHERE id = ?')
        .run(Date.now(), completeTxHash, id);
}

// ─── Protocol Stats (APY-Zeitreihe) ──────────────────────────────────────────

/** APY- und TVL-Eintrag speichern */
export function recordProtocolStat({ protocol, poolType, apy, tvl = null }) {
    return getDb()
        .prepare('INSERT INTO protocol_stats (bot_id, protocol, pool_type, apy, tvl, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(config.botId, protocol, poolType, apy, tvl ?? null, Date.now());
}

/** APY-Verlauf der letzten N Tage für alle Protokolle */
export function getProtocolStatsHistory(days = 30) {
    const cutoff = Date.now() - days * 86_400_000;
    return getDb()
        .prepare(`
            SELECT protocol, pool_type, apy, tvl, recorded_at
            FROM protocol_stats
            WHERE bot_id = ? AND recorded_at >= ?
            ORDER BY recorded_at ASC
        `)
        .all(config.botId, cutoff);
}

/**
 * Vorheriger (vorletzter) Stat für ein Protokoll – für TVL-Schwellwert-Crossing-Check.
 * Muss NACH recordProtocolStat() aufgerufen werden, damit OFFSET 1 den letzten
 * Wert vor dem aktuellen Tick zurückgibt.
 */
export function getPreviousProtocolStat(protocol) {
    return getDb()
        .prepare(`
            SELECT apy, tvl, recorded_at
            FROM protocol_stats
            WHERE bot_id = ? AND protocol = ?
            ORDER BY recorded_at DESC
            LIMIT 1 OFFSET 1
        `)
        .get(config.botId, protocol);
}

/**
 * Stat aus dem Fenster ~22–26h vor jetzt – für APY-Änderungs-Check über 24h.
 * Gibt null zurück wenn kein Eintrag in diesem Zeitfenster vorhanden ist.
 */
export function getProtocolStatNear24h(protocol) {
    const now = Date.now();
    return getDb()
        .prepare(`
            SELECT apy, tvl, recorded_at
            FROM protocol_stats
            WHERE bot_id = ? AND protocol = ?
              AND recorded_at BETWEEN ? AND ?
            ORDER BY recorded_at DESC
            LIMIT 1
        `)
        .get(config.botId, protocol, now - 26 * 3_600_000, now - 22 * 3_600_000);
}

/** Neuester APY + TVL pro Protokoll (für Position-Cards im Dashboard) */
export function getLatestProtocolStats() {
    return getDb()
        .prepare(`
            SELECT protocol, pool_type, apy, tvl, MAX(recorded_at) AS recorded_at
            FROM protocol_stats
            WHERE bot_id = ?
            GROUP BY protocol, pool_type
        `)
        .all(config.botId);
}

// ─── Wallet Snapshot ──────────────────────────────────────────────────────────

export function getWalletSnapshot() {
    return getDb()
        .prepare('SELECT * FROM wallet_snapshot WHERE bot_id = ?')
        .get(config.botId);
}

export function upsertWalletSnapshot({ currentValue, totalYield, avgApy, walletUsdc, walletSol }) {
    return getDb()
        .prepare(`
            INSERT INTO wallet_snapshot (bot_id, current_value, total_yield, avg_apy, wallet_usdc, wallet_sol, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(bot_id) DO UPDATE SET
                current_value = excluded.current_value,
                total_yield = excluded.total_yield,
                avg_apy = excluded.avg_apy,
                wallet_usdc = excluded.wallet_usdc,
                wallet_sol = excluded.wallet_sol,
                recorded_at = excluded.recorded_at
        `)
        .run(config.botId, currentValue, totalYield, avgApy, walletUsdc, walletSol, Date.now());
}

/** Gesamtsumme aller Deposits und Withdrawals (für transaktionsbasierte Yield-Berechnung) */
export function getTotalDepositsWithdraws() {
    return getDb()
        .prepare(`
            SELECT
                SUM(CASE WHEN type = 'deposit'  THEN amount ELSE 0 END) AS total_deposits,
                SUM(CASE WHEN type = 'withdraw' THEN amount ELSE 0 END) AS total_withdraws
            FROM transactions WHERE bot_id = ?
        `)
        .get(config.botId);
}

// ─── Portfolio History ────────────────────────────────────────────────────────

export function recordPortfolioSnapshot(totalValue, solPrice = null) {
    return getDb()
        .prepare('INSERT INTO portfolio_history (bot_id, total_value, sol_price, recorded_at) VALUES (?, ?, ?, ?)')
        .run(config.botId, totalValue, solPrice, Date.now());
}

/** Löscht portfolio_history-Einträge älter als keepDays Tage. */
export function prunePortfolioHistory(keepDays = 90) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    return getDb()
        .prepare('DELETE FROM portfolio_history WHERE bot_id = ? AND recorded_at < ?')
        .run(config.botId, cutoff);
}

/** Letzte N Portfolio-Snapshots (neueste zuerst) – für gleitenden Durchschnitt */
export function getRecentPortfolioHistory(limit = 3) {
    return getDb()
        .prepare(`
            SELECT total_value, recorded_at
            FROM portfolio_history
            WHERE bot_id = ?
            ORDER BY recorded_at DESC
            LIMIT ?
        `)
        .all(config.botId, limit);
}

export function getPortfolioHistory(days = 30) {
    const cutoff = Date.now() - days * 86_400_000;
    // Downsampling: 1 Punkt pro Stunde behalten
    return getDb()
        .prepare(`
            SELECT total_value, recorded_at
            FROM portfolio_history
            WHERE bot_id = ? AND recorded_at >= ?
            ORDER BY recorded_at ASC
        `)
        .all(config.botId, cutoff);
}

// ─── Transactions ─────────────────────────────────────────────────────────────

export function recordTransaction({ type, protocol, poolType, asset = 'USDC', amount, txHash = null, feeSol = null, note = null }) {
    return getDb()
        .prepare(`
            INSERT INTO transactions (bot_id, type, protocol, pool_type, asset, amount, tx_hash, fee_sol, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(config.botId, type, protocol, poolType, asset, amount, txHash, feeSol, note, Date.now());
}

export function getRecentTransactions(limit = 500) {
    return getDb()
        .prepare(`
            SELECT * FROM transactions
            WHERE bot_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        `)
        .all(config.botId, limit);
}

/** Alle Transaktionen eines Protokolls seit einem Zeitpunkt (aufsteigend für chronologische Auswertung) */
export function getTransactionsByProtocol(protocol, sinceMs = 0) {
    return getDb()
        .prepare(`
            SELECT * FROM transactions
            WHERE bot_id = ? AND protocol = ? AND created_at >= ?
            ORDER BY created_at ASC
        `)
        .all(config.botId, protocol, sinceMs);
}

// ─── Notifications ────────────────────────────────────────────────────────────

export function addNotification({ level = 'info', message }) {
    return getDb()
        .prepare('INSERT INTO notifications (bot_id, level, message, ts) VALUES (?, ?, ?, ?)')
        .run(config.botId, level, message, Date.now());
}

export function getNotifications(limit = 20) {
    return getDb()
        .prepare('SELECT * FROM notifications WHERE bot_id = ? ORDER BY ts DESC LIMIT ?')
        .all(config.botId, limit);
}

// ─── KV Config ────────────────────────────────────────────────────────────────

export function kvGet(key, fallback = null) {
    const row = getDb().prepare('SELECT value FROM kv_config WHERE key = ?').get(key);
    return row ? row.value : fallback;
}

export function kvSet(key, value) {
    return getDb()
        .prepare('INSERT OR REPLACE INTO kv_config (key, value) VALUES (?, ?)')
        .run(key, String(value));
}

// ─── Daily Position Snapshots ─────────────────────────────────────────────────

/** Gibt true zurück wenn für date (YYYY-MM-DD, Berlin) bereits ein Snapshot existiert. */
export function hasDailySnapshot(date) {
    return !!getDb()
        .prepare('SELECT 1 FROM daily_position_snapshots WHERE bot_id = ? AND date = ? LIMIT 1')
        .get(config.botId, date);
}

/**
 * Speichert je Protokoll den aktuellen positions.amount-Wert als Tagesanfangs-Referenz.
 * positions ist ein Array aus getActivePositions() – bereits bereinigt/summiert.
 * Schreibt nur falls noch kein Snapshot für date existiert (UNIQUE-Constraint).
 */
export function recordDailySnapshot(date, positions) {
    const now    = Date.now();
    const insert = getDb().prepare(`
        INSERT OR IGNORE INTO daily_position_snapshots (bot_id, date, protocol, amount_usdc, recorded_at)
        VALUES (?, ?, ?, ?, ?)
    `);
    const tx = getDb().transaction(() => {
        for (const p of positions) {
            insert.run(config.botId, date, p.protocol, p.amount, now);
        }
    });
    tx();
}

/**
 * Liest den Tagesanfangs-Snapshot für date (YYYY-MM-DD, Berlin).
 * Gibt ein Array von { protocol, amount_usdc } zurück, oder [] wenn kein Snapshot existiert.
 */
export function getDailySnapshot(date) {
    return getDb()
        .prepare(`
            SELECT protocol, amount_usdc
            FROM daily_position_snapshots
            WHERE bot_id = ? AND date = ?
        `)
        .all(config.botId, date);
}

/**
 * Gibt eine Map zurück: date (YYYY-MM-DD) → summe aller amount_usdc an diesem Tag.
 * Wird in export.js genutzt, um historische Tages-Yields per Snapshot-Delta zu berechnen
 * (exakt dieselbe Methode wie statistics.today → einheitliche Zahlen).
 * @param {string} fromDate  frühestes Datum (YYYY-MM-DD), inklusiv
 */
export function getDailySnapshotTotals(fromDate) {
    const rows = getDb()
        .prepare(`
            SELECT date, SUM(amount_usdc) AS total
            FROM daily_position_snapshots
            WHERE bot_id = ? AND date >= ?
            GROUP BY date
        `)
        .all(config.botId, fromDate);
    return new Map(rows.map(r => [r.date, r.total]));
}
