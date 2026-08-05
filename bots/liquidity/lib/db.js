/**
 * FORGE Liquidity – Datenbank
 *
 * SQLite (better-sqlite3) mit WAL-Mode.
 *
 * Tabellen:
 *   pools              – konfigurierte Pools: statische Felder gespiegelt aus pools.json,
 *                        dynamische Betriebsfelder (active/enabled/range_override_fixed_pct)
 *                        sind hier Single Source of Truth (siehe syncPools/applyPoolDynamics)
 *   positions          – aktive und historische LP-Positionen (inkl. NFT-Mint)
 *   pool_stats         – stündliche Zeitreihe: APR, TVL, Volume, Preis
 *   volume_hourly      – stündliche Volumen-Candles aus GeckoTerminal (echte Zeitreihe)
 *   fee_history        – geerntete Fees pro Claim
 *   rebalance_history  – Rebalancing-Ereignisse
 *   portfolio_history  – Portfolio-Gesamtwert-Verlauf
 *   transactions       – alle Ereignisse (deposit, withdraw, claim, reinvest, rebalance)
 *   notifications      – Dashboard-Alerts
 *
 * Wichtig: NIEMALS direkte SQL-Manipulationen auf Bot-DBs außerhalb dieses Moduls.
 * Positions-Daten (Ticks, NFT-Mint) nur vom Bot schreiben — Chain ist Quelle der Wahrheit.
 */

import Database          from 'better-sqlite3';
import path              from 'path';
import { fileURLToPath } from 'url';
import { PATHS }         from '../../../config/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── DB öffnen ────────────────────────────────────────────────────────────────

/**
 * Öffnet (oder erstellt) die SQLite-Datenbank.
 * @param {string} [dbPath] - Default: die echte Bot-DB. Überschreibbar für Tests
 *   (z.B. Premium-Ingest-selfTest gegen eine temporäre Datei statt der echten DB).
 * @returns {Database}
 */
export function openDatabase(dbPath = PATHS.liquidityDb) {
    const db = new Database(dbPath);

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    initSchema(db);
    migrateSchema(db);
    return db;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

function initSchema(db) {
    db.exec(`
        -- Konfigurierte Pools (gespiegelt aus pools.json beim Start)
        CREATE TABLE IF NOT EXISTS pools (
            id           TEXT PRIMARY KEY,
            protocol     TEXT NOT NULL,             -- 'orca' | 'raydium'
            address      TEXT NOT NULL,             -- Pool-Adresse (Pubkey)
            pair         TEXT NOT NULL,             -- z.B. 'SOL/USDC'
            token_a      TEXT NOT NULL,             -- Mint-Adresse Token A
            token_b      TEXT NOT NULL,             -- Mint-Adresse Token B
            decimals_a   INTEGER NOT NULL,
            decimals_b   INTEGER NOT NULL,
            fee_tier     REAL NOT NULL,             -- z.B. 0.04
            tick_spacing INTEGER NOT NULL,
            active       INTEGER NOT NULL DEFAULT 1 -- 1=aktiv, 0=inaktiv
        );

        -- LP-Positionen (aktive + historische)
        -- Jede Orca-Position ist ein NFT: nft_mint ist der eindeutige Identifier
        CREATE TABLE IF NOT EXISTS positions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id         TEXT    NOT NULL REFERENCES pools(id),
            nft_mint        TEXT    NOT NULL UNIQUE, -- Position-NFT (Orca)
            tick_lower      INTEGER NOT NULL,
            tick_upper      INTEGER NOT NULL,
            price_lower     REAL    NOT NULL,        -- Preis bei tick_lower (USD)
            price_upper     REAL    NOT NULL,        -- Preis bei tick_upper (USD)
            liquidity       TEXT    NOT NULL,        -- als String (u128 zu groß für INTEGER)
            capital_usdc    REAL,                    -- eingesetztes Kapital in USDC
            hodl_token_a    REAL,                    -- HODL-Baseline: Token-A-Menge beim Öffnen
            hodl_token_b    REAL,                    -- HODL-Baseline: Token-B-Menge beim Öffnen
            hodl_price_usd  REAL,                    -- HODL-Baseline: Preis beim Öffnen (für IL-Berechnung)
            open_tx         TEXT,                    -- TX-Signatur des openPosition-Calls
            close_tx        TEXT,                    -- TX-Signatur des closePosition-Calls (NULL wenn offen)
            opened_at       INTEGER NOT NULL,        -- Unix-Timestamp (ms)
            closed_at       INTEGER                  -- NULL = Position ist noch offen
        );

        -- Stündliche Pool-Zeitreihe (für Dashboard-Charts)
        CREATE TABLE IF NOT EXISTS pool_stats (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id         TEXT    NOT NULL REFERENCES pools(id),
            price           REAL    NOT NULL,        -- aktueller Preis Token A in USDC
            tvl_usd         REAL    NOT NULL,        -- Total Value Locked in USD
            volume_24h_usd  REAL    NOT NULL,        -- Handelsvolumen 24h in USD
            apr_24h         REAL    NOT NULL,        -- Fee-APR (24h) in %
            recorded_at     INTEGER NOT NULL         -- Unix-Timestamp (ms)
        );

        -- Geerntete Fees pro Claim
        CREATE TABLE IF NOT EXISTS fee_history (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id         TEXT    NOT NULL REFERENCES pools(id),
            position_id     INTEGER NOT NULL REFERENCES positions(id),
            amount_a        REAL    NOT NULL,        -- geclaimte Token-A-Menge
            amount_b        REAL    NOT NULL,        -- geclaimte Token-B-Menge
            usd_value       REAL,                    -- Gesamtwert zum Claim-Zeitpunkt in USDC
            action          TEXT    NOT NULL,        -- 'reinvest' | 'transfer'
            tx_hash         TEXT,                    -- TX-Signatur
            claimed_at      INTEGER NOT NULL         -- Unix-Timestamp (ms)
        );

        -- Rebalancing-Ereignisse
        CREATE TABLE IF NOT EXISTS rebalance_history (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id         TEXT    NOT NULL REFERENCES pools(id),
            reason          TEXT    NOT NULL,        -- 'out_of_range' | 'manual'
            old_position_id INTEGER REFERENCES positions(id),
            new_position_id INTEGER REFERENCES positions(id),
            old_tick_lower  INTEGER NOT NULL,
            old_tick_upper  INTEGER NOT NULL,
            new_tick_lower  INTEGER NOT NULL,
            new_tick_upper  INTEGER NOT NULL,
            price_at_event        REAL    NOT NULL,  -- Preis zum Zeitpunkt des Rebalancings
            cost_sol              REAL,              -- TX-Kosten in SOL (close + open, ohne Swap-Slippage)
            fees_claimed_a        REAL    NOT NULL DEFAULT 0,
            fees_claimed_b        REAL    NOT NULL DEFAULT 0,
            lp_value_before_usdc  REAL,              -- LP-Wert unmittelbar VOR closePosition()
            lp_value_after_usdc   REAL,              -- deployedUsdc nach openPosition() + Reconcile
            rebalanced_at         INTEGER NOT NULL   -- Unix-Timestamp (ms)
        );

        -- Portfolio-Gesamtwert-Verlauf (Snapshot alle N Minuten)
        CREATE TABLE IF NOT EXISTS portfolio_history (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            total_usd       REAL    NOT NULL,        -- Gesamtportfoliowert in USDC
            lp_value_usd    REAL    NOT NULL,        -- Wert aller LP-Positionen
            fees_pending_usd REAL   NOT NULL DEFAULT 0, -- noch nicht geclaimte Fees
            il_usd          REAL    NOT NULL DEFAULT 0, -- Impermanent Loss in USDC
            il_pct          REAL    NOT NULL DEFAULT 0, -- IL in %
            recorded_at     INTEGER NOT NULL         -- Unix-Timestamp (ms)
        );

        -- Alle Ereignisse (vollständiger Audit-Trail)
        CREATE TABLE IF NOT EXISTS transactions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id         TEXT    REFERENCES pools(id),
            type            TEXT    NOT NULL,        -- 'deposit' | 'withdraw' | 'open_position' |
                                                     -- 'close_position' | 'claim' | 'reinvest' |
                                                     -- 'transfer' | 'rebalance'
            amount_a        REAL,
            amount_b        REAL,
            usd_value       REAL,
            tx_hash         TEXT,
            tx_fee_sol      REAL,                    -- Solana TX-Fee in SOL
            note            TEXT,
            created_at      INTEGER NOT NULL         -- Unix-Timestamp (ms)
        );

        -- Dashboard-Alerts (für Browser-Benachrichtigungen)
        CREATE TABLE IF NOT EXISTS notifications (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id         TEXT    REFERENCES pools(id),
            level           TEXT    NOT NULL,        -- 'info' | 'warning' | 'error'
            message         TEXT    NOT NULL,
            read            INTEGER NOT NULL DEFAULT 0,
            created_at      INTEGER NOT NULL         -- Unix-Timestamp (ms)
        );

        -- Stündliche Volumen-Zeitreihe aus GeckoTerminal (echte Candle-Daten)
        CREATE TABLE IF NOT EXISTS volume_hourly (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id    TEXT    NOT NULL REFERENCES pools(id),
            ts         INTEGER NOT NULL,   -- Stunden-Beginn, Unix-Timestamp (ms)
            volume_usd REAL    NOT NULL,   -- Handelsvolumen dieser Stunde in USD
            UNIQUE(pool_id, ts)
        );

        -- Per-Pool-Snapshots (für "Mein Anteil", APR, IL je Pool)
        CREATE TABLE IF NOT EXISTS position_snapshots (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id          TEXT    NOT NULL REFERENCES pools(id),
            lp_value_usd     REAL    NOT NULL,
            fees_pending_usd REAL    NOT NULL DEFAULT 0,
            fees_pending_a   REAL             DEFAULT 0,  -- tokenA-Fees in Token-Einheiten
            fees_pending_b   REAL             DEFAULT 0,  -- tokenB-Fees in Token-Einheiten
            price            REAL             DEFAULT 0,  -- Pool-Preis zum Snapshot-Zeitpunkt
            il_usd           REAL    NOT NULL DEFAULT 0,
            il_pct           REAL    NOT NULL DEFAULT 0,
            recorded_at      INTEGER NOT NULL
        );

        -- Echte Kapital-Zuflüsse (Deposits) und -Abflüsse (Withdrawals).
        -- Seit v0.3.47: Quelle für netDeposited = Σ usdc_amount echter Cashflows.
        -- baseline = netDeposited (Σ deposits − Σ withdraws), nicht mehr balance_snapshot.
        -- balance_snapshot wird beibehalten (Schema-Kompatibilität, Audit), aber nicht
        -- mehr gelesen. Bot-interne Position-Opens schreiben hier keinen Eintrag mehr.
        CREATE TABLE IF NOT EXISTS capital_flows (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id          TEXT    REFERENCES pools(id),
            usdc_amount      REAL    NOT NULL,    -- bei Withdraw negativ
            balance_snapshot REAL,                -- deprecated seit v0.3.47, immer NULL
            tx_hash          TEXT,
            note             TEXT,
            created_at       INTEGER NOT NULL
        );

        -- Stop-Loss Ausführungs-State-Machine
        -- Persistiert jeden Schritt damit nach Bot-Restart fortgesetzt werden kann.
        CREATE TABLE IF NOT EXISTS sl_executions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id         TEXT    NOT NULL,
            triggered_at    INTEGER NOT NULL,
            trigger_price_a REAL,
            trigger_price_b REAL,
            step            TEXT    NOT NULL DEFAULT 'preparing',
            sl_coins_a      REAL,
            sl_coins_b      REAL,
            swapped_usdc    REAL,
            config_snapshot TEXT,
            completed_at    INTEGER,
            error_msg       TEXT
        );

        -- Take-Profit Ausführungs-State-Machine (gleiches Schema wie sl_executions)
        CREATE TABLE IF NOT EXISTS tp_executions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id         TEXT    NOT NULL,
            triggered_at    INTEGER NOT NULL,
            trigger_price_a REAL,
            trigger_price_b REAL,
            step            TEXT    NOT NULL DEFAULT 'preparing',
            tp_coins_a      REAL,
            tp_coins_b      REAL,
            swapped_usdc    REAL,
            config_snapshot TEXT,
            completed_at    INTEGER,
            error_msg       TEXT
        );

        -- Ranking-Exit Ausführungs-State-Machine (analog SL/TP)
        -- streak_hours: wie lange war der Pool durchgehend "withdraw" als der Exit feuerte
        CREATE TABLE IF NOT EXISTS rk_executions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id         TEXT    NOT NULL,
            triggered_at    INTEGER NOT NULL,
            streak_hours    REAL,
            step            TEXT    NOT NULL DEFAULT 'preparing',
            rk_coins_a      REAL,
            rk_coins_b      REAL,
            swapped_usdc    REAL,
            config_snapshot TEXT,
            completed_at    INTEGER,
            error_msg       TEXT
        );

        -- Trailing-Stop Ausführungs-State-Machine (analog SL/TP)
        -- hwm_usd / current_usd / drawdown_pct: Kontext zum Auslösezeitpunkt
        CREATE TABLE IF NOT EXISTS ts_executions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id         TEXT    NOT NULL,
            triggered_at    INTEGER NOT NULL,
            hwm_usd         REAL,
            current_usd     REAL,
            drawdown_pct    REAL,
            step            TEXT    NOT NULL DEFAULT 'preparing',
            ts_coins_a      REAL,
            ts_coins_b      REAL,
            swapped_usdc    REAL,
            config_snapshot TEXT,
            completed_at    INTEGER,
            error_msg       TEXT
        );

        -- Retirement-Exit Ausführungs-State-Machine (analog Ranking-Exit).
        -- Feuert, wenn der Master einen per Premium-Offer übernommenen Pool zurückstuft
        -- (lib/pool-retirement.js). trigger_kind: 'retired' (ausdrücklich zurückgestuft)
        -- oder 'absent' (fehlt in einer nachweislich vollständigen Liste).
        -- observed_tvl_usd / observed_lp_usd: was der Fork zum Auslösezeitpunkt SELBST
        -- gemessen hat — damit im Nachhinein prüfbar bleibt, ob die eigene Datenlage die
        -- Rückstufung gestützt hat oder nicht.
        CREATE TABLE IF NOT EXISTS retire_executions (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id          TEXT    NOT NULL,
            triggered_at     INTEGER NOT NULL,
            trigger_kind     TEXT,
            trigger_reason   TEXT,
            observed_tvl_usd REAL,
            observed_lp_usd  REAL,
            step             TEXT    NOT NULL DEFAULT 'preparing',
            coins_a          REAL,
            coins_b          REAL,
            swapped_usdc     REAL,
            config_snapshot  TEXT,
            completed_at     INTEGER,
            error_msg        TEXT
        );

        -- Merkzettel für den Premium-Offer-Abgleich (lib/pool-offer-sync.js).
        -- Bewusst in der Bot-DB und NICHT in settings.db pool_settings: setPoolActive(false)
        -- löscht dort die komplette Zeile des Pools — das Bestätigungsfenster einer
        -- Rückstufung würde also ausgerechnet beim Deaktivieren verschwinden.
        CREATE TABLE IF NOT EXISTS pool_offer_state (
            pool_id                TEXT PRIMARY KEY,
            retired_first_seen_at  INTEGER,
            retired_sequences      TEXT,
            retired_notified_at    INTEGER,
            last_update_at         INTEGER,
            last_update_sequence   INTEGER
        );

        -- Score-Limit Ausführungs-State-Machine (analog Trailing-Stop)
        -- trigger_score: InvestScore zum Auslösezeitpunkt
        -- apr_score/pnl_score_*: Sub-Scores zum Trigger-Zeitpunkt (#0219-Nachzug, 2026-06-19) —
        -- live aus data.json mitgeschrieben, damit der Pool-Type-Advisor "PnL-getrieben trotz
        -- gesunder APR" auswerten kann, ohne aus position_snapshots zu rekonstruieren (die nach
        -- jedem Reopen via clearPositionSnapshots() gelöscht werden, siehe pool-type-advisor.md).
        CREATE TABLE IF NOT EXISTS score_limit_executions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id         TEXT    NOT NULL,
            triggered_at    INTEGER NOT NULL,
            trigger_score   REAL,
            step            TEXT    NOT NULL DEFAULT 'preparing',
            coins_a         REAL,
            coins_b         REAL,
            swapped_usdc    REAL,
            config_snapshot TEXT,
            completed_at    INTEGER,
            error_msg       TEXT,
            apr_score       REAL,
            pnl_score_6h    REAL,
            pnl_score_12h   REAL,
            pnl_score_24h   REAL
        );

        -- Advisor-Log: vollständige Advisor-Ausgabe pro Pool + Zeitpunkt (14 Tage Retention)
        CREATE TABLE IF NOT EXISTS advisor_log (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id              TEXT    NOT NULL,
            recorded_at          INTEGER NOT NULL,
            range_pct            REAL,
            confidence           TEXT,
            net_apr_pct          REAL,
            gross_apr_pct        REAL,
            rebal_cost_apr_pct   REAL,
            annual_il_pct        REAL,
            hours_until_oor      REAL,
            rebals_per_day       REAL,
            my_share             REAL,
            trend_direction      TEXT,
            trend_strength       REAL,
            ema10                REAL,
            ema20                REAL,
            ema30                REAL,
            volatility_hourly    REAL,
            volatility_annualized REAL,
            is_fallback_vola     INTEGER,
            data_points          INTEGER,
            capital_usdc         REAL,
            is_profitable        INTEGER,
            min_capital_usdc     REAL,
            tvl_usdc             REAL,
            volume_24h_usdc      REAL,
            current_price        REAL,
            current_range_pct    REAL
        );
        CREATE INDEX IF NOT EXISTS idx_advisor_log_pool_time
            ON advisor_log(pool_id, recorded_at DESC);

        -- Advisor-Entscheidungen: jede Advisor-Konsultation für spätere Auswertung (2 Jahre)
        CREATE TABLE IF NOT EXISTS advisor_decisions (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id                 TEXT    NOT NULL REFERENCES pools(id),
            triggered_by            TEXT    NOT NULL,  -- 'rebalance' | 'daily_scan' | 'attrition_check'
            current_range_pct       REAL,              -- aktuell konfigurierte Range
            recommended_range_pct   REAL    NOT NULL,  -- Empfehlung des Advisors
            confidence              TEXT    NOT NULL,  -- 'low' | 'medium' | 'high'
            action_taken            TEXT    NOT NULL,  -- 'range_changed' | 'rejected_hysteresis' | 'rejected_low_confidence' | 'rejected_no_change' | 'notified' | 'attrition_widened'
            rejection_reason        TEXT,              -- Freitext-Begründung wenn nicht übernommen
            net_apr_current         REAL,              -- Netto-APR der aktuellen Range
            net_apr_recommended     REAL,              -- Netto-APR der empfohlenen Range
            swap_cost_empirical     REAL,              -- tatsächlich verwendete Swap-Kosten (null = Fallback)
            model_drift             REAL,              -- driftFactor (null wenn keine Daten)
            attrition_pct_per_month REAL,              -- monatliche Kapital-Attrition in %
            capital_usdc            REAL,              -- Kapital zum Zeitpunkt der Entscheidung
            created_at              INTEGER NOT NULL   -- Unix-Timestamp (ms)
        );
        CREATE INDEX IF NOT EXISTS idx_advisor_decisions_pool
            ON advisor_decisions(pool_id, created_at DESC);

        -- Pool-Score-Snapshots (Pool-Explorer): erlaubt „rot seit X Stunden"-Auswertung
        CREATE TABLE IF NOT EXISTS pool_score_history (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id       TEXT    NOT NULL,
            recorded_at   INTEGER NOT NULL,   -- Unix-Timestamp (ms)
            net_apr_pct   REAL,
            gross_apr_pct REAL,
            verdict       TEXT,               -- strong | ok | weak | bad | unknown
            trend         TEXT,               -- up | down | sideways
            rank_pos      INTEGER,
            rank_of       INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_pool_score_history_pool_time
            ON pool_score_history(pool_id, recorded_at DESC);

        -- Indizes für Performance bei Zeitreihen-Abfragen
        CREATE INDEX IF NOT EXISTS idx_position_snapshots_pool_time
            ON position_snapshots(pool_id, recorded_at DESC);

        CREATE INDEX IF NOT EXISTS idx_pool_stats_pool_time
            ON pool_stats(pool_id, recorded_at DESC);

        CREATE INDEX IF NOT EXISTS idx_volume_hourly_pool_time
            ON volume_hourly(pool_id, ts DESC);

        CREATE INDEX IF NOT EXISTS idx_portfolio_history_time
            ON portfolio_history(recorded_at DESC);

        CREATE INDEX IF NOT EXISTS idx_fee_history_pool
            ON fee_history(pool_id, claimed_at DESC);

        CREATE INDEX IF NOT EXISTS idx_rebalance_history_pool
            ON rebalance_history(pool_id, rebalanced_at DESC);

        CREATE INDEX IF NOT EXISTS idx_positions_pool_open
            ON positions(pool_id, closed_at);
    `);
}

/** Inkrementelle Schema-Migrationen für bestehende DBs. */
function migrateSchema(db) {
    const txCols = db.prepare(`PRAGMA table_info(transactions)`).all().map(c => c.name);
    if (!txCols.includes('tx_fee_sol')) {
        db.exec(`ALTER TABLE transactions ADD COLUMN tx_fee_sol REAL`);
    }

    // Phase 5 (v0.3.47): portfolio_history.wallet_sol/wallet_usdc/sol_price entfernen.
    // Single Source of Truth für Wallet-Werte ist jetzt wallet-monitor.db. Die alten
    // Spalten waren eine zweite, oft veraltete Wallet-Quelle und Ursache wiederkehrender
    // Anzeige-Drift (Bug 2026-05-21: 19,51 vs 33,83 USDC nach Rebalance).
    const phCols = db.prepare(`PRAGMA table_info(portfolio_history)`).all().map(c => c.name);
    if (phCols.includes('wallet_sol')) {
        db.exec(`ALTER TABLE portfolio_history DROP COLUMN wallet_sol`);
    }
    if (phCols.includes('wallet_usdc')) {
        db.exec(`ALTER TABLE portfolio_history DROP COLUMN wallet_usdc`);
    }
    if (phCols.includes('sol_price')) {
        db.exec(`ALTER TABLE portfolio_history DROP COLUMN sol_price`);
    }

    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);

    // volume_hourly: Tabelle für bestehende DBs anlegen falls noch nicht vorhanden
    if (!tables.includes('volume_hourly')) {
        db.exec(`
            CREATE TABLE volume_hourly (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id    TEXT    NOT NULL REFERENCES pools(id),
                ts         INTEGER NOT NULL,
                volume_usd REAL    NOT NULL,
                UNIQUE(pool_id, ts)
            );
            CREATE INDEX idx_volume_hourly_pool_time ON volume_hourly(pool_id, ts DESC);
        `);
        console.log('[db] Migration: Tabelle volume_hourly angelegt.');
    }

    // position_snapshots: Per-Pool-Snapshots für Multi-Pool-Betrieb
    if (!tables.includes('position_snapshots')) {
        db.exec(`
            CREATE TABLE position_snapshots (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id          TEXT    NOT NULL REFERENCES pools(id),
                lp_value_usd     REAL    NOT NULL,
                fees_pending_usd REAL    NOT NULL DEFAULT 0,
                il_usd           REAL    NOT NULL DEFAULT 0,
                il_pct           REAL    NOT NULL DEFAULT 0,
                recorded_at      INTEGER NOT NULL
            );
            CREATE INDEX idx_position_snapshots_pool_time
                ON position_snapshots(pool_id, recorded_at DESC);
        `);
        console.log('[db] Migration: Tabelle position_snapshots angelegt.');
    }

    // position_snapshots: Token-Beträge + Preis für preis-neutrale APR-Berechnung
    const psSnapCols = db.prepare(`PRAGMA table_info(position_snapshots)`).all().map(c => c.name);
    if (!psSnapCols.includes('fees_pending_a')) {
        db.exec(`ALTER TABLE position_snapshots ADD COLUMN fees_pending_a REAL DEFAULT 0`);
        console.log('[db] Migration: position_snapshots.fees_pending_a hinzugefügt.');
    }
    if (!psSnapCols.includes('fees_pending_b')) {
        db.exec(`ALTER TABLE position_snapshots ADD COLUMN fees_pending_b REAL DEFAULT 0`);
        console.log('[db] Migration: position_snapshots.fees_pending_b hinzugefügt.');
    }
    if (!psSnapCols.includes('price')) {
        db.exec(`ALTER TABLE position_snapshots ADD COLUMN price REAL DEFAULT 0`);
        console.log('[db] Migration: position_snapshots.price hinzugefügt.');
    }
    if (!psSnapCols.includes('amount_a')) {
        db.exec(`ALTER TABLE position_snapshots ADD COLUMN amount_a REAL DEFAULT NULL`);
        console.log('[db] Migration: position_snapshots.amount_a hinzugefügt.');
    }
    if (!psSnapCols.includes('amount_b')) {
        db.exec(`ALTER TABLE position_snapshots ADD COLUMN amount_b REAL DEFAULT NULL`);
        console.log('[db] Migration: position_snapshots.amount_b hinzugefügt.');
    }

    // capital_flows: kumulierte Einzahlungen für korrekte Performance-Baseline
    if (!tables.includes('capital_flows')) {
        db.exec(`
            CREATE TABLE capital_flows (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id          TEXT    REFERENCES pools(id),
                usdc_amount      REAL    NOT NULL,
                balance_snapshot REAL,
                tx_hash          TEXT,
                note             TEXT,
                created_at       INTEGER NOT NULL
            );
        `);
        console.log('[db] Migration: Tabelle capital_flows angelegt.');
    }

    // balance_snapshot Spalte für bestehende capital_flows-Tabellen
    if (tables.includes('capital_flows')) {
        const cfCols = db.prepare('PRAGMA table_info(capital_flows)').all().map(c => c.name);
        if (!cfCols.includes('balance_snapshot')) {
            db.exec('ALTER TABLE capital_flows ADD COLUMN balance_snapshot REAL');
            console.log('[db] Migration: capital_flows.balance_snapshot hinzugefügt.');
        }
        // is_external: unterscheidet manuellen Kapitalfluss (1) von internem Reinvest/Cleanup (0).
        // Gesetzt von deposit.js / withdraw.js. Cleanup (deposit-lib.js) lässt Default 0.
        if (!cfCols.includes('is_external')) {
            db.exec(`ALTER TABLE capital_flows ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0`);
            // Backfill: cleanup-Einträge = 0, alles andere (Manueller/Erstdeposit/...) = 1.
            db.exec(`UPDATE capital_flows SET is_external = CASE WHEN note LIKE 'cleanup%' THEN 0 ELSE 1 END`);
            console.log('[db] Migration: capital_flows.is_external hinzugefügt + Backfill.');
        }
    }

    // pnl_daily: Tagesabschluss-Werte für kalender-ausgerichtete PnL-Statistiken.
    // Schreibt der Bot beim ersten Zyklus nach Mitternacht (Vortags-Close).
    // 90 Tage Retention (pruneOldData).
    if (!tables.includes('pnl_daily')) {
        db.exec(`
            CREATE TABLE pnl_daily (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                date       TEXT    NOT NULL UNIQUE,  -- 'YYYY-MM-DD' in FORGE_TZ
                lp_close   REAL    NOT NULL,         -- lp_value_usd + fees_pending_usd aller offenen Positionen
                created_at INTEGER NOT NULL
            );
            CREATE INDEX idx_pnl_daily_date ON pnl_daily(date DESC);
        `);
        console.log('[db] Migration: Tabelle pnl_daily angelegt.');
    }
    // pnl_value: täglicher PnL-Wert (Snapshot-Ansatz). Nachrüstung für bestehende DBs.
    {
        const cols = db.prepare('PRAGMA table_info(pnl_daily)').all().map(c => c.name);
        if (!cols.includes('pnl_value')) {
            db.exec('ALTER TABLE pnl_daily ADD COLUMN pnl_value REAL');
            console.log('[db] Migration: pnl_daily.pnl_value hinzugefügt.');
        }
    }

    // tp_executions: Tabelle für bestehende DBs anlegen falls noch nicht vorhanden
    if (!tables.includes('tp_executions')) {
        db.exec(`
            CREATE TABLE tp_executions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id         TEXT    NOT NULL,
                triggered_at    INTEGER NOT NULL,
                trigger_price_a REAL,
                trigger_price_b REAL,
                step            TEXT    NOT NULL DEFAULT 'preparing',
                tp_coins_a      REAL,
                tp_coins_b      REAL,
                swapped_usdc    REAL,
                config_snapshot TEXT,
                completed_at    INTEGER,
                error_msg       TEXT
            )
        `);
        console.log('[db] Migration: Tabelle tp_executions angelegt.');
    }

    // rebalance_history: lp_value_before/after für echte Kostenerfassung inkl. Swap-Slippage
    const rhCols = db.prepare(`PRAGMA table_info(rebalance_history)`).all().map(c => c.name);
    if (!rhCols.includes('lp_value_before_usdc')) {
        db.exec(`ALTER TABLE rebalance_history ADD COLUMN lp_value_before_usdc REAL`);
        console.log('[db] Migration: rebalance_history.lp_value_before_usdc hinzugefügt.');
    }
    if (!rhCols.includes('lp_value_after_usdc')) {
        db.exec(`ALTER TABLE rebalance_history ADD COLUMN lp_value_after_usdc REAL`);
        console.log('[db] Migration: rebalance_history.lp_value_after_usdc hinzugefügt.');
    }

    // positions.hwm_usd / hwm_at — Trailing-Stop High-Water-Mark (pro offene Position)
    // pools: dynamische Betriebsfelder (Single Source of Truth = DB, nicht mehr pools.json).
    // active existiert bereits; enabled + range_override_fixed_pct sind neu. NULL bedeutet
    // "noch nie gesetzt" → loadPools()/applyPoolDynamics fällt dann auf den pools.json-Wert
    // zurück (Seed). syncPools() backfillt NULLs beim nächsten Lauf aus pools.json.
    const poolCols = db.prepare(`PRAGMA table_info(pools)`).all().map(c => c.name);
    if (!poolCols.includes('enabled')) {
        db.exec(`ALTER TABLE pools ADD COLUMN enabled INTEGER`);
        console.log('[db] Migration: pools.enabled hinzugefügt.');
    }
    if (!poolCols.includes('range_override_fixed_pct')) {
        db.exec(`ALTER TABLE pools ADD COLUMN range_override_fixed_pct REAL`);
        console.log('[db] Migration: pools.range_override_fixed_pct hinzugefügt.');
    }

    const posCols = db.prepare(`PRAGMA table_info(positions)`).all().map(c => c.name);
    if (!posCols.includes('hwm_usd')) {
        db.exec(`ALTER TABLE positions ADD COLUMN hwm_usd REAL`);
        console.log('[db] Migration: positions.hwm_usd hinzugefügt.');
    }
    if (!posCols.includes('hwm_at')) {
        db.exec(`ALTER TABLE positions ADD COLUMN hwm_at INTEGER`);
        console.log('[db] Migration: positions.hwm_at hinzugefügt.');
    }
    if (!posCols.includes('hwm_base_adjustment')) {
        db.exec(`ALTER TABLE positions ADD COLUMN hwm_base_adjustment REAL`);
        console.log('[db] Migration: positions.hwm_base_adjustment hinzugefügt.');
    }

    // score_limit_executions: Score-Limit State-Machine
    if (!tables.includes('score_limit_executions')) {
        db.exec(`
            CREATE TABLE score_limit_executions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id         TEXT    NOT NULL,
                triggered_at    INTEGER NOT NULL,
                trigger_score   REAL,
                step            TEXT    NOT NULL DEFAULT 'preparing',
                coins_a         REAL,
                coins_b         REAL,
                swapped_usdc    REAL,
                config_snapshot TEXT,
                completed_at    INTEGER,
                error_msg       TEXT,
                apr_score       REAL,
                pnl_score_6h    REAL,
                pnl_score_12h   REAL,
                pnl_score_24h   REAL
            )
        `);
        console.log('[db] Migration: Tabelle score_limit_executions angelegt.');
    } else {
        // Sub-Scores zum Trigger-Zeitpunkt (#0219-Nachzug, 2026-06-19) — siehe Kommentar
        // an der initSchema-Definition oben.
        const slCols = db.prepare(`PRAGMA table_info(score_limit_executions)`).all().map(c => c.name);
        for (const col of ['apr_score', 'pnl_score_6h', 'pnl_score_12h', 'pnl_score_24h']) {
            if (!slCols.includes(col)) {
                db.exec(`ALTER TABLE score_limit_executions ADD COLUMN ${col} REAL`);
                console.log(`[db] Migration: score_limit_executions.${col} hinzugefügt.`);
            }
        }
    }

    // ts_executions: Trailing-Stop State-Machine (analog SL/TP/Ranking-Exit)
    if (!tables.includes('ts_executions')) {
        db.exec(`
            CREATE TABLE ts_executions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id         TEXT    NOT NULL,
                triggered_at    INTEGER NOT NULL,
                hwm_usd         REAL,
                current_usd     REAL,
                drawdown_pct    REAL,
                step            TEXT    NOT NULL DEFAULT 'preparing',
                ts_coins_a      REAL,
                ts_coins_b      REAL,
                swapped_usdc    REAL,
                config_snapshot TEXT,
                completed_at    INTEGER,
                error_msg       TEXT
            )
        `);
        console.log('[db] Migration: Tabelle ts_executions angelegt.');
    }

    // tvl_executions: TVL-Schutz State-Machine (zweistufig, pro Position pro Stufe)
    if (!tables.includes('tvl_executions')) {
        db.exec(`
            CREATE TABLE tvl_executions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id         TEXT    NOT NULL,
                position_id     INTEGER,
                level           INTEGER NOT NULL,   -- 1 (L1) oder 2 (L2)
                triggered_at    INTEGER NOT NULL,
                tvl_usd         REAL,               -- Pool-TVL zum Trigger-Zeitpunkt
                threshold_usd   REAL,               -- konfigurierte Schwelle der Stufe
                withdraw_pct    INTEGER,            -- abzuziehender Anteil in %
                step            TEXT    NOT NULL DEFAULT 'preparing',
                coins_a         REAL,
                coins_b         REAL,
                swapped_usdc    REAL,
                config_snapshot TEXT,
                completed_at    INTEGER,
                error_msg       TEXT
            )
        `);
        console.log('[db] Migration: Tabelle tvl_executions angelegt.');
    }

    // rk_executions: Ranking-Exit State-Machine (analog SL/TP)
    if (!tables.includes('rk_executions')) {
        db.exec(`
            CREATE TABLE rk_executions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id         TEXT    NOT NULL,
                triggered_at    INTEGER NOT NULL,
                streak_hours    REAL,
                step            TEXT    NOT NULL DEFAULT 'preparing',
                rk_coins_a      REAL,
                rk_coins_b      REAL,
                swapped_usdc    REAL,
                config_snapshot TEXT,
                completed_at    INTEGER,
                error_msg       TEXT
            )
        `);
        console.log('[db] Migration: Tabelle rk_executions angelegt.');
    }

    // retire_executions + pool_offer_state: Premium-Offer-Rückstufung (2026-07-29)
    if (!tables.includes('retire_executions')) {
        db.exec(`
            CREATE TABLE retire_executions (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id          TEXT    NOT NULL,
                triggered_at     INTEGER NOT NULL,
                trigger_kind     TEXT,
                trigger_reason   TEXT,
                observed_tvl_usd REAL,
                observed_lp_usd  REAL,
                step             TEXT    NOT NULL DEFAULT 'preparing',
                coins_a          REAL,
                coins_b          REAL,
                swapped_usdc     REAL,
                config_snapshot  TEXT,
                completed_at     INTEGER,
                error_msg        TEXT
            )
        `);
        console.log('[db] Migration: Tabelle retire_executions angelegt.');
    }
    if (!tables.includes('pool_offer_state')) {
        db.exec(`
            CREATE TABLE pool_offer_state (
                pool_id                TEXT PRIMARY KEY,
                retired_first_seen_at  INTEGER,
                retired_sequences      TEXT,
                retired_notified_at    INTEGER,
                last_update_at         INTEGER,
                last_update_sequence   INTEGER
            )
        `);
        console.log('[db] Migration: Tabelle pool_offer_state angelegt.');
    }

    // advisor_log: vollständige Advisor-Ausgabe, 14-Tage-Retention
    if (!tables.includes('advisor_log')) {
        db.exec(`
            CREATE TABLE advisor_log (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id              TEXT    NOT NULL,
                recorded_at          INTEGER NOT NULL,
                range_pct            REAL,
                confidence           TEXT,
                net_apr_pct          REAL,
                gross_apr_pct        REAL,
                rebal_cost_apr_pct   REAL,
                annual_il_pct        REAL,
                hours_until_oor      REAL,
                rebals_per_day       REAL,
                my_share             REAL,
                trend_direction      TEXT,
                trend_strength       REAL,
                ema10                REAL,
                ema20                REAL,
                ema30                REAL,
                volatility_hourly    REAL,
                volatility_annualized REAL,
                is_fallback_vola     INTEGER,
                data_points          INTEGER,
                capital_usdc         REAL,
                is_profitable        INTEGER,
                min_capital_usdc     REAL,
                tvl_usdc             REAL,
                volume_24h_usdc      REAL,
                current_price        REAL,
                current_range_pct    REAL
            );
            CREATE INDEX idx_advisor_log_pool_time ON advisor_log(pool_id, recorded_at DESC);
        `);
        console.log('[db] Migration: Tabelle advisor_log angelegt.');
    }

    // advisor_decisions: protokolliert jede Advisor-Konsultation (2-Jahre-Retention)
    if (!tables.includes('advisor_decisions')) {
        db.exec(`
            CREATE TABLE advisor_decisions (
                id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id                 TEXT    NOT NULL REFERENCES pools(id),
                triggered_by            TEXT    NOT NULL,
                current_range_pct       REAL,
                recommended_range_pct   REAL    NOT NULL,
                confidence              TEXT    NOT NULL,
                action_taken            TEXT    NOT NULL,
                rejection_reason        TEXT,
                net_apr_current         REAL,
                net_apr_recommended     REAL,
                swap_cost_empirical     REAL,
                model_drift             REAL,
                attrition_pct_per_month REAL,
                capital_usdc            REAL,
                created_at              INTEGER NOT NULL
            );
            CREATE INDEX idx_advisor_decisions_pool ON advisor_decisions(pool_id, created_at DESC);
        `);
        console.log('[db] Migration: Tabelle advisor_decisions angelegt.');
    }

    // advisor_decisions: payback_hours — Amortisationsdauer in Stunden
    const adCols = db.prepare(`PRAGMA table_info(advisor_decisions)`).all().map(c => c.name);
    if (!adCols.includes('payback_hours')) {
        db.exec(`ALTER TABLE advisor_decisions ADD COLUMN payback_hours REAL`);
        console.log('[db] Migration: advisor_decisions.payback_hours hinzugefügt.');
    }

    // pool_score_history: Score-Snapshots pro Pool für „rot seit X Stunden"-Auswertung
    if (!tables.includes('pool_score_history')) {
        db.exec(`
            CREATE TABLE pool_score_history (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id       TEXT    NOT NULL,
                recorded_at   INTEGER NOT NULL,   -- Unix-Timestamp (ms)
                net_apr_pct   REAL,
                gross_apr_pct REAL,
                verdict       TEXT,               -- strong | ok | weak | bad | unknown
                trend         TEXT,               -- up | down | sideways
                rank_pos      INTEGER,
                rank_of       INTEGER
            );
            CREATE INDEX idx_pool_score_history_pool_time
                ON pool_score_history(pool_id, recorded_at DESC);
        `);
        console.log('[db] Migration: Tabelle pool_score_history angelegt.');
    }

    // pool_score_history: Spalten für Economic-Scorer (2026-05-18)
    const pshCols = db.prepare(`PRAGMA table_info(pool_score_history)`).all().map(c => c.name);
    const pshAdds = [
        ['is_active',              'INTEGER'],
        ['realized_apr_pct',       'REAL'],
        ['estimated_apr_pct',      'REAL'],
        ['rebal_cost_apr_pct',     'REAL'],
        ['reinvest_loss_apr_pct',  'REAL'],
        ['net_econ_pct',           'REAL'],
        ['trend_7d_slope',         'REAL'],
        ['range_hit_rate_pct',     'REAL'],
        ['tvl_trend_pct',          'REAL'],
        ['vol_tvl_ratio',          'REAL'],
        ['apr_delta_pct',          'REAL'],
        ['confidence_score',       'REAL'],
        ['tier',                   'TEXT'],  // observe | invest | hold | withdraw
        // Total-Return-Erweiterung (2026-05-18b): erfasst Token-Wert-Bewegung
        ['token_return_apr_pct',   'REAL'],
        ['token_return_confidence','REAL'],
        ['daily_pnl_pct',          'REAL'],
        ['total_return_apr_pct',   'REAL'],  // net_econ_pct + token_return_apr_pct
        ['weekly_pnl_pct',         'REAL'],  // 7d-PnL (analog daily_pnl_pct, TWR über 168 h)
        // Profil-Refactor Phase 1 (2026-05-19): Kurzfrist-Momentum-Signale +
        // Entry-Exit-Kostenmodell. In Phase 1 nur Datenerfassung — der Tier-
        // Classifier nutzt sie ab Phase 2 für den Kurzfrist-Profil-Pfad.
        ['apr_slope_pct',           'REAL'],  // %-Punkte/Tag, Slope von apr_24h über 1 h
        ['volume_spike_factor',     'REAL'],  // jüngster Candle / 7d-Median
        ['short_term_apr_pct',      'REAL'],  // extrapolierter APR aus letzten 4 h
        ['short_term_confidence',   'REAL'],  // 0–100, Datendichte für Kurzfrist-Signale
        ['entry_exit_slippage_pct', 'REAL'],  // einseitige Slippage-Schätzung
        ['entry_exit_cost_apr_pct', 'REAL'],  // Roundtrip-Kosten amortisiert als APR
        // Profil-Refactor Phase 2 (2026-05-19): Kurzfrist-Tier-Klassifikation.
        // Wird parallel zur Mittelfrist-Bewertung erfasst. Konsumenten lesen
        // tier vs. short_term_tier abhängig vom aktiven Profil (PROFILE-Env).
        ['short_term_tier',             'TEXT'],     // invest | hold | withdraw
        ['short_term_rank_pos',         'INTEGER'],
        ['short_term_rank_of',          'INTEGER'],
        ['short_term_net_metric',       'REAL'],     // shortTermAprPct - entryExitCostAprPct
        ['short_term_tentative_tier',   'TEXT'],     // vor Hysterese
        ['short_term_modified_score',   'REAL'],     // nach Modifikatoren
    ];
    for (const [name, type] of pshAdds) {
        if (!pshCols.includes(name)) {
            db.exec(`ALTER TABLE pool_score_history ADD COLUMN ${name} ${type}`);
            console.log(`[db] Migration: pool_score_history.${name} hinzugefügt.`);
        }
    }

    // opportunity_scores: neues Score-Modell (LMB#0116, Phase 1).
    // Schreibt pro Pool und Timeframe (4h/12h/24h/7d) einen Snapshot.
    // Bewusst getrennt von pool_score_history — Schema, Semantik und
    // Konsumenten sind ein anderes Modell.
    if (!tables.includes('opportunity_scores')) {
        db.exec(`
            CREATE TABLE opportunity_scores (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id         TEXT    NOT NULL,
                timeframe       TEXT    NOT NULL,           -- 4h | 12h | 24h | 7d
                recorded_at     INTEGER NOT NULL,           -- Unix-Timestamp (ms)
                score           REAL,                       -- Endwert (NULL wenn insufficient_data)
                yield_per_tvl   REAL,                       -- gross_apr_pct / 365
                gross_apr_pct   REAL,
                price_slope_pct REAL,                       -- %/h
                yield_slope_pct REAL,                       -- %-Punkte/h
                tvl_slope_pct   REAL,                       -- %/h
                usd_trend_slope_pct REAL,                   -- %/h (USD-Korb-Trend, volatilePair)
                price_factor    REAL,
                yield_factor    REAL,
                tvl_factor      REAL,
                trend_factor    REAL,
                hopium_gate     INTEGER,                    -- 0 | 1
                sample_count    INTEGER,
                window_hours    INTEGER,
                reason          TEXT                        -- ok | insufficient_data | hopium_gate
            );
            CREATE INDEX idx_opp_scores_pool_tf_time
                ON opportunity_scores(pool_id, timeframe, recorded_at DESC);
        `);
        console.log('[db] Migration: Tabelle opportunity_scores angelegt.');
    }

    // Rename: profile → timeframe (LMB#0116, Anschluss-Refactor 2026-05-20).
    // Alte Werte short/medium/long auf 4h/24h/7d mappen; 12h gibt es neu.
    const oppCols = db.prepare(`PRAGMA table_info(opportunity_scores)`).all().map(c => c.name);
    if (oppCols.includes('profile') && !oppCols.includes('timeframe')) {
        db.exec(`
            DROP INDEX IF EXISTS idx_opp_scores_pool_prof_time;
            ALTER TABLE opportunity_scores RENAME COLUMN profile TO timeframe;
            UPDATE opportunity_scores SET timeframe = CASE timeframe
                WHEN 'short'  THEN '4h'
                WHEN 'medium' THEN '24h'
                WHEN 'long'   THEN '7d'
                ELSE timeframe
            END;
            CREATE INDEX IF NOT EXISTS idx_opp_scores_pool_tf_time
                ON opportunity_scores(pool_id, timeframe, recorded_at DESC);
        `);
        console.log('[db] Migration: opportunity_scores.profile → timeframe (Werte gemappt).');
    }

    // Timeframe '4h' → '6h' (LMB#0116, 2026-05-20: Fenster von 4h auf 6h erhöht).
    const has4h = db.prepare(
        `SELECT COUNT(*) AS n FROM opportunity_scores WHERE timeframe = '4h'`
    ).get().n > 0;
    if (has4h) {
        db.exec(`UPDATE opportunity_scores SET timeframe = '6h', window_hours = 6
                  WHERE timeframe = '4h'`);
        console.log('[db] Migration: opportunity_scores timeframe 4h → 6h.');
    }

    // USD-Trend-Spalten (LMB Phase 2): gerichteter USD-Korb-Trend (volatilePair-Pools).
    if (!oppCols.includes('usd_trend_slope_pct')) {
        db.exec(`ALTER TABLE opportunity_scores ADD COLUMN usd_trend_slope_pct REAL`); // %/h
        console.log('[db] Migration: opportunity_scores.usd_trend_slope_pct ergänzt.');
    }
    if (!oppCols.includes('trend_factor')) {
        db.exec(`ALTER TABLE opportunity_scores ADD COLUMN trend_factor REAL`);
        console.log('[db] Migration: opportunity_scores.trend_factor ergänzt.');
    }

    // Schreibweise-Vereinheitlichung (#0229): score_adviser_log → score_advisor_log.
    // SQLite ALTER TABLE RENAME erhält die Daten; der Index wird neu benannt.
    if (tables.includes('score_adviser_log') && !tables.includes('score_advisor_log')) {
        db.exec(`ALTER TABLE score_adviser_log RENAME TO score_advisor_log`);
        db.exec(`DROP INDEX IF EXISTS idx_score_adviser_log_time`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_score_advisor_log_time
                    ON score_advisor_log(evaluated_at DESC)`);
        const idx = tables.indexOf('score_adviser_log');
        if (idx >= 0) tables[idx] = 'score_advisor_log';
        console.log('[db] Migration: score_adviser_log → score_advisor_log umbenannt.');
    }

    // score_advisor_log: kTrend-Backtest-Spalten (LMB Phase 4). Der Score Advisor
    // kalibriert kTrend für volatile_pair gegen die Gesamtrendite (Fee + USD-Korb).
    if (tables.includes('score_advisor_log')) {
        const salCols = db.prepare(`PRAGMA table_info(score_advisor_log)`).all().map(c => c.name);
        if (!salCols.includes('best_k_trend')) {
            db.exec(`ALTER TABLE score_advisor_log ADD COLUMN best_k_trend REAL`);
            console.log('[db] Migration: score_advisor_log.best_k_trend ergänzt.');
        }
        if (!salCols.includes('curr_k_trend')) {
            db.exec(`ALTER TABLE score_advisor_log ADD COLUMN curr_k_trend REAL`);
            console.log('[db] Migration: score_advisor_log.curr_k_trend ergänzt.');
        }
    }

    // invest_score_history: Historische InvestScore-Werte für Chart im Dashboard
    if (!tables.includes('invest_score_history')) {
        db.exec(`
            CREATE TABLE invest_score_history (
                pool_id     TEXT    NOT NULL,
                recorded_at INTEGER NOT NULL,
                score       INTEGER,
                exit_score  INTEGER,
                PRIMARY KEY (pool_id, recorded_at)
            );
            CREATE INDEX idx_invest_score_hist
                ON invest_score_history (pool_id, recorded_at DESC);
        `);
        console.log('[db] Migration: Tabelle invest_score_history angelegt.');
    } else {
        // exit_score (2026-07-03): `score` ist investScore.value (mit Volumen-Malus) —
        // für den Score-Limit-Zyklen-Zähler in ForgeSettings (der bislang fälschlich
        // gegen `score`/value verglich, statt gegen das malus-freie exitValue, das
        // lib/score-limit.js tatsächlich für den Exit-Trigger nutzt) braucht es die
        // getrennte, malus-freie Spalte.
        const cols = db.prepare(`PRAGMA table_info(invest_score_history)`).all().map(c => c.name);
        if (!cols.includes('exit_score')) {
            db.exec(`ALTER TABLE invest_score_history ADD COLUMN exit_score INTEGER`);
            console.log('[db] Migration: invest_score_history.exit_score ergänzt.');
        }
    }

    if (!tables.includes('oracle_prices')) {
        db.exec(`
            CREATE TABLE oracle_prices (
                quote_pool_id TEXT    PRIMARY KEY,
                price         REAL    NOT NULL,
                source        TEXT    NOT NULL DEFAULT 'pyth',
                updated_at    INTEGER NOT NULL
            )
        `);
        console.log('[db] Migration: Tabelle oracle_prices angelegt.');
    }

    if (!tables.includes('cleanup_decisions')) {
        db.exec(`
            CREATE TABLE cleanup_decisions (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                decided_at      INTEGER NOT NULL,
                winner_pool     TEXT    NOT NULL,
                winner_score    REAL    NOT NULL,
                runner_up       TEXT,
                runner_up_score REAL,
                candidates      TEXT    NOT NULL,  -- JSON: [{id, score, hopiumVeto}]
                skipped         INTEGER NOT NULL DEFAULT 0  -- 1 wenn min_score nicht erreicht
            );
            CREATE INDEX idx_cleanup_decisions_time
                ON cleanup_decisions(decided_at DESC);
        `);
        console.log('[db] Migration: Tabelle cleanup_decisions angelegt.');
    }

    if (!tables.includes('score_advisor_log')) {
        db.exec(`
            CREATE TABLE score_advisor_log (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                evaluated_at    INTEGER NOT NULL,
                pool_type       TEXT    NOT NULL,   -- 'usdc_pair' | 'volatile_pair'
                timeframe       TEXT    NOT NULL,   -- '6h' | '12h' | '24h' | '7d'
                spearman_avg    REAL,
                spearman_med    REAL,
                positive_pct    REAL,
                eval_count      INTEGER,
                best_k_price    REAL,
                best_k_yield    REAL,
                best_k_tvl      REAL,
                best_k_trend    REAL,   -- USD-Korb-Trend-Sensitivität (volatile_pair)
                best_hopium     REAL,
                curr_k_price    REAL,
                curr_k_yield    REAL,
                curr_k_tvl      REAL,
                curr_k_trend    REAL,
                curr_hopium     REAL,
                drift_score     REAL,
                action_needed   INTEGER NOT NULL DEFAULT 0,
                pool_outliers   TEXT
            );
            CREATE INDEX idx_score_advisor_log_time
                ON score_advisor_log(evaluated_at DESC);
        `);
        console.log('[db] Migration: Tabelle score_advisor_log angelegt.');
    }

    if (!tables.includes('pool_type_advisor_log')) {
        db.exec(`
            CREATE TABLE pool_type_advisor_log (
                id                       INTEGER PRIMARY KEY AUTOINCREMENT,
                evaluated_at             INTEGER NOT NULL,
                pool_type                TEXT    NOT NULL,   -- rebalance_free | volatil_1 | volatil_2 | volatil_3 | rwa
                pool_count               INTEGER NOT NULL,
                segments_current         INTEGER,
                segments_required        INTEGER,
                days_current             INTEGER,
                days_required            INTEGER,
                sufficiency_eligible     INTEGER NOT NULL DEFAULT 0,
                reassignment_candidates  INTEGER NOT NULL DEFAULT 0,
                missignal_total          INTEGER,
                missignal_candidates     INTEGER,
                missignal_candidate_pct  REAL,
                current_net_pnl          REAL,
                current_max_drawdown_pct REAL,
                best_variant_label       TEXT,
                best_net_pnl             REAL,
                best_max_drawdown_pct    REAL,
                best_combined_score      REAL,
                current_combined_score   REAL,
                counterfactual_indicative_only INTEGER NOT NULL DEFAULT 1,
                avg_pnl_contribution_pct REAL,
                avg_apr_contribution_pct REAL,
                details_json             TEXT
            );
            CREATE INDEX idx_pool_type_advisor_log_time
                ON pool_type_advisor_log(evaluated_at DESC);
            CREATE INDEX idx_pool_type_advisor_log_type_time
                ON pool_type_advisor_log(pool_type, evaluated_at DESC);
        `);
        console.log('[db] Migration: Tabelle pool_type_advisor_log angelegt.');
    }

    if (!tables.includes('np_price_history')) {
        db.exec(`
            CREATE TABLE np_price_history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id     TEXT    NOT NULL,
                recorded_at INTEGER NOT NULL,
                price       REAL    NOT NULL,
                range_pct   REAL    NOT NULL
            );
            CREATE INDEX idx_np_price_pool_time
                ON np_price_history (pool_id, recorded_at);
        `);
        console.log('[db] Migration: Tabelle np_price_history angelegt.');
    }

    if (!tables.includes('np_quality_log')) {
        db.exec(`
            CREATE TABLE np_quality_log (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id       TEXT    NOT NULL,
                recorded_at   INTEGER NOT NULL,
                window_h      INTEGER NOT NULL,
                predicted_usd REAL    NOT NULL,
                actual_usd    REAL    NOT NULL,
                error_usd     REAL    NOT NULL,
                error_pct     REAL,
                np_range_pct         REAL,
                actual_range_pct     REAL,
                predicted_actual_usd REAL,
                error_actual_usd     REAL,
                fee_pred_actual_usd  REAL,
                il_pred_actual_usd   REAL
            );
            CREATE INDEX idx_np_quality_time ON np_quality_log (recorded_at DESC);
        `);
        console.log('[db] Migration: Tabelle np_quality_log angelegt.');
    }

    // Orca-Liquiditätsdaten für präzise NP-Fee-Berechnung
    const psCols = db.prepare(`PRAGMA table_info(pool_stats)`).all().map(c => c.name);
    if (!psCols.includes('liquidity_in_range')) {
        db.exec(`ALTER TABLE pool_stats ADD COLUMN liquidity_in_range TEXT DEFAULT NULL`);
        console.log('[db] Migration: pool_stats.liquidity_in_range angelegt.');
    }
    if (!psCols.includes('fees_24h_usd')) {
        db.exec(`ALTER TABLE pool_stats ADD COLUMN fees_24h_usd REAL DEFAULT NULL`);
        console.log('[db] Migration: pool_stats.fees_24h_usd angelegt.');
    }

    // btc_trend_history: Multi-Timeframe-BTC-Trendmeter (BTC-Korrelation Phase 0).
    // Reine Ableitung aus pool_stats (liq-btc-usdc) — kein eigener API-Call.
    // EMA-Werte je (timeframe, span) gespeichert (auditierbar); die 12 Bits
    // (Preis>EMA) sind daraus + btc_price rekonstruierbar. trend_points zählt die
    // Trues, ema_available die nicht-null EMAs (Warmup), trend_pct = points/available.
    // Siehe lib/btc-trend/index.js.
    if (!tables.includes('btc_trend_history')) {
        db.exec(`
            CREATE TABLE btc_trend_history (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                recorded_at   INTEGER NOT NULL UNIQUE,   -- Unix-Timestamp (ms), Candle-Ende
                btc_price     REAL    NOT NULL,
                ema_1h_20  REAL, ema_1h_30  REAL, ema_1h_50  REAL,
                ema_4h_20  REAL, ema_4h_30  REAL, ema_4h_50  REAL,
                ema_12h_20 REAL, ema_12h_30 REAL, ema_12h_50 REAL,
                ema_24h_20 REAL, ema_24h_30 REAL, ema_24h_50 REAL,
                trend_points  INTEGER NOT NULL,           -- 0..12 (Anzahl Preis>EMA)
                ema_available INTEGER NOT NULL,           -- 0..12 (nicht-null EMAs, Warmup)
                trend_pct     REAL                        -- trend_points / ema_available * 100
            );
            CREATE INDEX idx_btc_trend_time ON btc_trend_history(recorded_at DESC);
        `);
        console.log('[db] Migration: Tabelle btc_trend_history angelegt.');
    }

    // btc_correlation_log: BTC-Korrelations-Advisor (Phase 1, Reporting-only).
    // Eine Zeile pro Token und Lauf — Pearson-Korrelation der stündlichen USD-Returns
    // gegen BTC, vorzeichenbehaftet. source_pool_id = Pool, über dessen Preisreihe
    // die USD-Reihe aufgelöst wurde (direkt oder über quotePricePoolId-Kette).
    // Siehe lib/btc-correlation/index.js.
    if (!tables.includes('btc_correlation_log')) {
        db.exec(`
            CREATE TABLE btc_correlation_log (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                evaluated_at    INTEGER NOT NULL,
                token_mint      TEXT    NOT NULL,
                token_symbol    TEXT,
                source_pool_id  TEXT,
                window_days     INTEGER NOT NULL,
                sample_count    INTEGER NOT NULL,
                correlation     REAL,                       -- NULL wenn insufficient_data
                reason          TEXT                        -- ok | insufficient_data
            );
            CREATE INDEX idx_btc_corr_log_time  ON btc_correlation_log(evaluated_at DESC);
            CREATE INDEX idx_btc_corr_log_token ON btc_correlation_log(token_mint, evaluated_at DESC);
        `);
        console.log('[db] Migration: Tabelle btc_correlation_log angelegt.');
    }

    // swap_fail_state: persistenter Fail-Counter für cleanup.js-Swaps über Cron-Läufe
    // hinweg (cleanup.js ist kein Dauerprozess, ein In-Memory-Zähler würde bei jedem
    // Lauf verlorengehen). Analog zum noteFail()-Muster in bots/lending/bin/bot.js:
    // 1.+2. Fehlschlag in Folge = transient (nur Log), erst der 3. eskaliert zu
    // notify.warn(). Erfolg setzt den Zähler zurück. Siehe #0265.
    if (!tables.includes('swap_fail_state')) {
        db.exec(`
            CREATE TABLE swap_fail_state (
                swap_key          TEXT    PRIMARY KEY,   -- z.B. "liq-pump-sol:USDC→PUMP"
                consecutive_fails INTEGER NOT NULL DEFAULT 0,
                last_fail_at      INTEGER,
                last_error        TEXT
            );
        `);
        console.log('[db] Migration: Tabelle swap_fail_state angelegt.');
    }

    // dust_watch: verfolgt seit wann ein Pool-Token-Rest >= DUST_SWAP_MAX_USDC im
    // Wallet liegt und auf den regulären Ranking-Invest wartet (Score >= CLEANUP_MIN_SCORE).
    // Analyse 2026-07-24 zeigte Score-<65-Phasen von bis zu 72h – ohne Notbremse
    // könnten größere Restbeträge entsprechend lange als volatiles Asset liegen
    // bleiben. sweepDust() in bin/cleanup.js swappt nach CLEANUP_STUCK_HOURS
    // zwangsweise zu USDC, unabhängig vom Score.
    if (!tables.includes('dust_watch')) {
        db.exec(`
            CREATE TABLE dust_watch (
                mint            TEXT    PRIMARY KEY,
                first_seen_at   INTEGER NOT NULL,   -- Unix-ms, erster Lauf mit Rest >= DUST_SWAP_MAX_USDC
                first_seen_usd  REAL    NOT NULL
            );
        `);
        console.log('[db] Migration: Tabelle dust_watch angelegt.');
    }
}

// ─── Swap-Fail-Counter (cleanup.js, cross-run) ────────────────────────────────

/**
 * Erhöht den Fail-Counter für einen Swap-Key und gibt den neuen Stand zurück.
 * @param {Database} db
 * @param {string} swapKey  z.B. "liq-pump-sol:USDC→PUMP"
 * @param {string} errorMsg
 * @returns {number} neuer consecutive_fails-Stand
 */
export function noteSwapFail(db, swapKey, errorMsg) {
    db.prepare(`
        INSERT INTO swap_fail_state (swap_key, consecutive_fails, last_fail_at, last_error)
        VALUES (@swapKey, 1, @now, @errorMsg)
        ON CONFLICT(swap_key) DO UPDATE SET
            consecutive_fails = swap_fail_state.consecutive_fails + 1,
            last_fail_at      = @now,
            last_error        = @errorMsg
    `).run({ swapKey, now: Date.now(), errorMsg });
    return db.prepare(`SELECT consecutive_fails FROM swap_fail_state WHERE swap_key = ?`)
        .get(swapKey).consecutive_fails;
}

/** Setzt den Fail-Counter für einen Swap-Key nach einem erfolgreichen Swap zurück. */
export function resetSwapFail(db, swapKey) {
    db.prepare(`DELETE FROM swap_fail_state WHERE swap_key = ?`).run(swapKey);
}

// ─── Dust-Watch (cleanup.js, cross-run) ───────────────────────────────────────

/** Liefert den dust_watch-Eintrag für einen Mint oder null. */
export function getDustWatch(db, mint) {
    return db.prepare(`SELECT * FROM dust_watch WHERE mint = ?`).get(mint) ?? null;
}

/** Legt den dust_watch-Eintrag für einen Mint an, falls noch nicht vorhanden. */
export function startDustWatch(db, mint, usdValue) {
    db.prepare(`
        INSERT INTO dust_watch (mint, first_seen_at, first_seen_usd)
        VALUES (?, ?, ?)
        ON CONFLICT(mint) DO NOTHING
    `).run(mint, Date.now(), usdValue);
}

/** Löscht den dust_watch-Eintrag für einen Mint (Token investiert/verschwunden/wieder Dust). */
export function clearDustWatch(db, mint) {
    db.prepare(`DELETE FROM dust_watch WHERE mint = ?`).run(mint);
}

// ─── Pool-Sync ────────────────────────────────────────────────────────────────

/**
 * Synchronisiert die pools-Tabelle mit der aktuellen pools.json-Konfiguration.
 * Neue Pools werden eingefügt, bestehende in ihren STATISCHEN Feldern aktualisiert.
 *
 * Wichtig – dynamische Betriebsfelder (Single Source of Truth = DB):
 *   - `active` wird bei bestehenden Pools NICHT aus pools.json überschrieben
 *     (sonst würde ein per Setter geschriebener DB-Zustand jeden Zyklus wieder
 *     durch den eingefrorenen JSON-Wert geclobbert). Nur beim INSERT eines neuen
 *     Pools wird der JSON-Wert als Seed übernommen.
 *   - `enabled` und `range_override_fixed_pct` werden per COALESCE nur befüllt
 *     wenn die DB-Spalte noch NULL ist (Erstbefüllung/Migration aus pools.json);
 *     ein bereits gesetzter DB-Wert bleibt maßgeblich.
 *
 * @param {Database} db
 * @param {Array}    pools   config.pools.all
 */
export function syncPools(db, pools) {
    const upsert = db.prepare(`
        INSERT INTO pools (id, protocol, address, pair, token_a, token_b, decimals_a, decimals_b, fee_tier, tick_spacing, active, enabled, range_override_fixed_pct)
        VALUES (@id, @protocol, @address, @pair, @tokenA, @tokenB, @decimalsA, @decimalsB, @feeTier, @tickSpacing, @active, @enabled, @rangeFixedPct)
        ON CONFLICT(id) DO UPDATE SET
            protocol     = excluded.protocol,
            address      = excluded.address,
            pair         = excluded.pair,
            token_a      = excluded.token_a,
            token_b      = excluded.token_b,
            decimals_a   = excluded.decimals_a,
            decimals_b   = excluded.decimals_b,
            fee_tier     = excluded.fee_tier,
            tick_spacing = excluded.tick_spacing,
            enabled      = COALESCE(pools.enabled, excluded.enabled),
            range_override_fixed_pct = COALESCE(pools.range_override_fixed_pct, excluded.range_override_fixed_pct)
    `);

    const run = db.transaction((pools) => {
        for (const p of pools) {
            const rangeFixedPct = (p.rangeOverride && typeof p.rangeOverride.fixedPct === 'number')
                ? p.rangeOverride.fixedPct
                : null;
            upsert.run({
                id:            p.id,
                protocol:      p.protocol,
                address:       p.address,
                pair:          p.pair,
                tokenA:        p.tokenA,
                tokenB:        p.tokenB,
                decimalsA:     p.decimalsA,
                decimalsB:     p.decimalsB,
                feeTier:       p.feeTier,
                tickSpacing:   p.tickSpacing,
                active:        p.active ? 1 : 0,
                enabled:       p.enabled === false ? 0 : 1,
                rangeFixedPct,
            });
        }
    });

    run(pools);
}

/**
 * Überlagert die dynamischen Pool-Felder (active, enabled, rangeOverride.fixedPct)
 * eines aus pools.json geladenen Pool-Arrays mit den autoritativen DB-Werten und
 * mutiert die Pool-Objekte in-place.
 *
 * DB ist Single Source of Truth für diese drei Felder. Ein DB-Wert NULL bedeutet
 * "noch nie über einen Setter geändert" → der pools.json-Wert (Seed) bleibt stehen.
 * `active` ist in der DB immer gesetzt, sobald eine Zeile existiert.
 *
 * Defensiv: fehlt die pools-Tabelle/Spalte (frühe Boot-/Migrationsphase) oder ist
 * kein DB-Row für einen Pool vorhanden (erster syncPools steht noch aus), bleibt
 * der jeweilige JSON-Wert unangetastet — nie werfen.
 *
 * @param {Database} db     offene liquiditybot.db (read-only genügt)
 * @param {Array}    pools  Pool-Objekte aus pools.json
 * @returns {Array} dieselben, in-place überlagerten Pool-Objekte
 */
export function applyPoolDynamics(db, pools) {
    let rows;
    try {
        rows = db.prepare(`SELECT id, active, enabled, range_override_fixed_pct FROM pools`).all();
    } catch {
        return pools; // Tabelle/Spalten (noch) nicht vorhanden → reine pools.json-Semantik
    }
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const p of pools) {
        const row = byId.get(p.id);
        if (!row) continue; // Pool noch nicht in DB → JSON-Wert behalten
        p.active = row.active === 1;
        if (row.enabled !== null && row.enabled !== undefined) {
            p.enabled = row.enabled === 1;
        }
        if (row.range_override_fixed_pct !== null && row.range_override_fixed_pct !== undefined
            && p.rangeOverride && typeof p.rangeOverride === 'object') {
            p.rangeOverride.fixedPct = row.range_override_fixed_pct;
        }
    }
    return pools;
}

// ─── Positions ────────────────────────────────────────────────────────────────

/**
 * Gibt die aktuell offene Position eines Pools zurück (closed_at IS NULL).
 * @param {Database} db
 * @param {string}   poolId
 * @returns {Object|null}
 */
export function getOpenPosition(db, poolId) {
    return db.prepare(`
        SELECT * FROM positions WHERE pool_id = ? AND closed_at IS NULL LIMIT 1
    `).get(poolId) ?? null;
}

/**
 * Speichert eine neue Position nach dem Öffnen.
 * @param {Database} db
 * @param {Object}   pos
 * @returns {number}  neue Zeilen-ID
 */
export function insertPosition(db, pos) {
    const result = db.prepare(`
        INSERT INTO positions
            (pool_id, nft_mint, tick_lower, tick_upper, price_lower, price_upper,
             liquidity, capital_usdc, hodl_token_a, hodl_token_b, hodl_price_usd,
             open_tx, opened_at)
        VALUES
            (@poolId, @nftMint, @tickLower, @tickUpper, @priceLower, @priceUpper,
             @liquidity, @capitalUsdc, @hodlTokenA, @hodlTokenB, @hodlPriceUsd,
             @openTx, @openedAt)
    `).run(pos);
    return result.lastInsertRowid;
}

/**
 * Aktualisiert das eingesetzte Kapital einer Position (nach manuellem Deposit).
 * @param {Database} db
 * @param {number}   positionId
 * @param {number}   capitalUsdc  Neues Gesamtkapital in USDC
 */
export function updatePositionCapital(db, positionId, capitalUsdc) {
    db.prepare(`UPDATE positions SET capital_usdc = ? WHERE id = ?`).run(capitalUsdc, positionId);
}

/**
 * Synchronisiert die gespeicherte On-Chain-Liquidität einer Position.
 * Muss nach jeder Liquiditätsänderung (increase/decrease) aufgerufen werden — sonst bleibt
 * der beim Öffnen gespeicherte Wert hängen (Reconcile-/Reinvest-increaseLiquidity erhöht die
 * echte On-Chain-Liquidität, ohne dass die DB es mitbekommt). Wird zentral aus
 * writePositionSnapshotFromState bei jedem regulären Tick mit frischem On-Chain-State gerufen.
 * @param {Database} db
 * @param {number}   positionId
 * @param {string}   liquidity  On-Chain-Liquidität (u128 als String)
 */
export function updatePositionLiquidity(db, positionId, liquidity) {
    db.prepare(`UPDATE positions SET liquidity = ? WHERE id = ?`).run(String(liquidity), positionId);
}

/**
 * Aktualisiert die HODL-Baseline einer Position um ein Delta (positiv = Deposit, negativ = Withdraw).
 * Muss nach jedem manuellen deposit/withdraw aufgerufen werden, damit IL korrekt bleibt.
 */
export function updatePositionHodl(db, positionId, deltaA, deltaB) {
    db.prepare(`
        UPDATE positions SET hodl_token_a = hodl_token_a + ?, hodl_token_b = hodl_token_b + ?
        WHERE id = ?
    `).run(deltaA, deltaB, positionId);
}

/**
 * Schließt eine Position (setzt closed_at und close_tx).
 * @param {Database} db
 * @param {number}   positionId
 * @param {string}   closeTx
 */
export function closePosition(db, positionId, closeTx) {
    db.prepare(`UPDATE positions SET closed_at = ?, close_tx = ? WHERE id = ?`)
      .run(Date.now(), closeTx, positionId);
}

/**
 * Löscht position_snapshots eines Pools. Wird beim Öffnen einer neuen Position
 * aufgerufen, damit Charts der neuen Session sauber starten.
 * fee_history, rebalance_history und capital_flows bleiben dauerhaft erhalten.
 */
export function clearPositionSnapshots(db, poolId) {
    db.prepare(`DELETE FROM position_snapshots WHERE pool_id = ?`).run(poolId);
}

// ─── Pool-Stats ───────────────────────────────────────────────────────────────

/**
 * Schreibt einen stündlichen Pool-Stats-Snapshot.
 * @param {Database} db
 * @param {Object}   stats  { poolId, price, tvlUsd, volume24hUsd, apr24h, liquidityInRange?, fees24hUsd? }
 */
export function insertPoolStats(db, stats) {
    db.prepare(`
        INSERT INTO pool_stats
            (pool_id, price, tvl_usd, volume_24h_usd, apr_24h, liquidity_in_range, fees_24h_usd, recorded_at)
        VALUES
            (@poolId, @price, @tvlUsd, @volume24hUsd, @apr24h, @liquidityInRange, @fees24hUsd, @recordedAt)
    `).run({
        liquidityInRange: null,
        fees24hUsd:       null,
        ...stats,
        recordedAt: Date.now(),
    });
}

/**
 * Gibt die letzten N Pool-Stats-Einträge eines Pools zurück.
 * @param {Database} db
 * @param {string}   poolId
 * @param {number}   limit   Default: 48 (48h bei stündlichem Intervall)
 * @returns {Array}
 */
export function getPoolStats(db, poolId, limit = 48) {
    return db.prepare(`
        SELECT * FROM pool_stats WHERE pool_id = ?
        ORDER BY recorded_at DESC LIMIT ?
    `).all(poolId, limit);
}

// ─── Volume-Hourly ────────────────────────────────────────────────────────────

/**
 * Schreibt stündliche Volumen-Candles aus GeckoTerminal.
 * Bereits vorhandene Einträge (pool_id + ts) werden aktualisiert
 * (laufende Stunde kann sich noch ändern).
 *
 * @param {Database} db
 * @param {string}   poolId
 * @param {Array}    candles  Array von { ts: number (ms), volume: number }
 */
export function insertVolumeCandles(db, poolId, candles) {
    if (!candles?.length) return;
    const upsert = db.prepare(`
        INSERT INTO volume_hourly (pool_id, ts, volume_usd)
        VALUES (@poolId, @ts, @volume)
        ON CONFLICT(pool_id, ts) DO UPDATE SET volume_usd = excluded.volume_usd
    `);
    const run = db.transaction(list => {
        for (const c of list) upsert.run({ poolId, ts: c.ts, volume: c.volume });
    });
    run(candles);
}

// ─── Fee-History ──────────────────────────────────────────────────────────────

/**
 * Schreibt einen Claim-Eintrag in die fee_history.
 * @param {Database} db
 * @param {Object}   fee  { poolId, positionId, amountA, amountB, usdValue, action, txHash }
 */
export function insertFeeHistory(db, fee) {
    db.prepare(`
        INSERT INTO fee_history
            (pool_id, position_id, amount_a, amount_b, usd_value, action, tx_hash, claimed_at)
        VALUES
            (@poolId, @positionId, @amountA, @amountB, @usdValue, @action, @txHash, @claimedAt)
    `).run({ ...fee, claimedAt: Date.now() });
}

// ─── Rebalance-History ────────────────────────────────────────────────────────

/**
 * Schreibt ein Rebalancing-Ereignis.
 * @param {Database} db
 * @param {Object}   event
 */
export function insertRebalanceHistory(db, event) {
    db.prepare(`
        INSERT INTO rebalance_history
            (pool_id, reason, old_position_id, new_position_id,
             old_tick_lower, old_tick_upper, new_tick_lower, new_tick_upper,
             price_at_event, cost_sol, fees_claimed_a, fees_claimed_b,
             lp_value_before_usdc, lp_value_after_usdc, rebalanced_at)
        VALUES
            (@poolId, @reason, @oldPositionId, @newPositionId,
             @oldTickLower, @oldTickUpper, @newTickLower, @newTickUpper,
             @priceAtEvent, @costSol, @feesClaimedA, @feesClaimedB,
             @lpValueBefore, @lpValueAfter, @rebalancedAt)
    `).run({
        lpValueBefore: null,
        lpValueAfter:  null,
        ...event,
        rebalancedAt: Date.now(),
    });
}

/**
 * Liefert Minuten seit dem letzten Rebalance eines Pools (Infinity wenn nie).
 * @param {Database} db
 * @param {string}   poolId
 * @returns {number}
 */
export function getMinutesSinceLastRebalance(db, poolId) {
    const row = db.prepare(`
        SELECT MAX(rebalanced_at) AS last FROM rebalance_history WHERE pool_id = ?
    `).get(poolId);
    if (!row || !row.last) return Infinity;
    return (Date.now() - row.last) / 60_000;
}

// ─── Position-Snapshots ───────────────────────────────────────────────────────

/**
 * Schreibt einen Per-Pool-Snapshot (LP-Wert, Fees, IL für einen einzelnen Pool).
 * @param {Database} db
 * @param {Object}   snap  { poolId, lpValueUsd, feesPendingUsd, feesPendingA, feesPendingB, price, ilUsd, ilPct }
 */
export function insertPositionSnapshot(db, snap) {
    db.prepare(`
        INSERT INTO position_snapshots
            (pool_id, lp_value_usd, fees_pending_usd, fees_pending_a, fees_pending_b, price, il_usd, il_pct, amount_a, amount_b, recorded_at)
        VALUES
            (@poolId, @lpValueUsd, @feesPendingUsd, @feesPendingA, @feesPendingB, @price, @ilUsd, @ilPct, @amountA, @amountB, @recordedAt)
    `).run({ feesPendingA: null, feesPendingB: null, price: null, amountA: null, amountB: null, ...snap, recordedAt: Date.now() });
}

// ─── Portfolio-History ────────────────────────────────────────────────────────

/**
 * Schreibt einen Portfolio-Snapshot.
 * Seit v0.3.47: Wallet-Werte werden NICHT mehr in portfolio_history gespeichert —
 * sie kommen ausschließlich aus wallet-monitor.db (Single Source of Truth).
 * @param {Database} db
 * @param {Object}   snap  { totalUsd, lpValueUsd, feesPendingUsd, ilUsd, ilPct }
 */
export function insertPortfolioSnapshot(db, snap) {
    db.prepare(`
        INSERT INTO portfolio_history
            (total_usd, lp_value_usd, fees_pending_usd, il_usd, il_pct, recorded_at)
        VALUES
            (@totalUsd, @lpValueUsd, @feesPendingUsd, @ilUsd, @ilPct, @recordedAt)
    `).run({ ...snap, recordedAt: Date.now() });
}

/**
 * Gibt die letzten N Portfolio-Snapshots zurück.
 * @param {Database} db
 * @param {number}   limit  Default: 288 (24h bei 5-Minuten-Intervall)
 * @returns {Array}
 */
export function getPortfolioHistory(db, limit = 288) {
    return db.prepare(`
        SELECT * FROM portfolio_history ORDER BY recorded_at DESC LIMIT ?
    `).all(limit);
}

/**
 * Löscht portfolio_history-Einträge älter als keepDays Tage.
 */
export function prunePortfolioHistory(db, keepDays = 90) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    db.prepare(`DELETE FROM portfolio_history WHERE recorded_at < ?`).run(cutoff);
}

/**
 * Löscht position_snapshots-Einträge älter als keepDays Tage.
 */
export function prunePositionSnapshots(db, keepDays = 90) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    db.prepare(`DELETE FROM position_snapshots WHERE recorded_at < ?`).run(cutoff);
}

/**
 * Löscht rebalance_history-Einträge älter als keepDays Tage.
 * Default: 730 Tage (2 Jahre). Begründung: Tabelle wächst langsam (~0,8 Events/Tag
 * pro Pool), Daten werden vom Range Advisor und Economic Scorer für Langzeit-Analyse
 * genutzt. 2 Jahre decken mehrere Marktzyklen ab; unbegrenztes Wachstum ist bei
 * diesem Volumen kein Problem, aber ein explizites Limit verhindert Überraschungen.
 */
export function pruneRebalanceHistory(db, keepDays = 730) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    db.prepare(`DELETE FROM rebalance_history WHERE rebalanced_at < ?`).run(cutoff);
}

// ─── Pool-Score-Historie ─────────────────────────────────────────────────────

/**
 * Schreibt einen Score-Snapshot pro Pool. Wird von pool-explorer.js --snapshot
 * für jeden bewerteten Pool aufgerufen.
 *
 * Felder seit 2026-05-18 (Economic-Scorer):
 *   - tier, isActive
 *   - realizedAprPct, estimatedAprPct, rebalCostAprPct, reinvestLossAprPct
 *   - netEconPct (Netto-Wirtschaftlichkeit, ersetzt netAprPct als primäre Zahl)
 *   - trend7dSlope, rangeHitRatePct, tvlTrendPct, volTvlRatio, aprDeltaPct
 *   - confidenceScore
 *
 * Legacy-Felder (netAprPct, grossAprPct, verdict, trend, rankPos, rankOf)
 * bleiben für Rückwärtskompatibilität gefüllt.
 */
export function insertPoolScoreHistory(db, row) {
    db.prepare(`
        INSERT INTO pool_score_history (
            pool_id, recorded_at,
            net_apr_pct, gross_apr_pct, verdict, trend, rank_pos, rank_of,
            is_active, realized_apr_pct, estimated_apr_pct,
            rebal_cost_apr_pct, reinvest_loss_apr_pct, net_econ_pct,
            trend_7d_slope, range_hit_rate_pct, tvl_trend_pct,
            vol_tvl_ratio, apr_delta_pct, confidence_score, tier,
            token_return_apr_pct, token_return_confidence,
            daily_pnl_pct, total_return_apr_pct, weekly_pnl_pct,
            apr_slope_pct, volume_spike_factor,
            short_term_apr_pct, short_term_confidence,
            entry_exit_slippage_pct, entry_exit_cost_apr_pct,
            short_term_tier, short_term_rank_pos, short_term_rank_of,
            short_term_net_metric, short_term_tentative_tier, short_term_modified_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        row.poolId, row.recordedAt,
        row.netAprPct ?? null, row.grossAprPct ?? null,
        row.verdict ?? null, row.trend ?? null,
        row.rankPos ?? null, row.rankOf ?? null,
        row.isActive == null ? null : (row.isActive ? 1 : 0),
        row.realizedAprPct ?? null,
        row.estimatedAprPct ?? null,
        row.rebalCostAprPct ?? null,
        row.reinvestLossAprPct ?? null,
        row.netEconPct ?? null,
        row.trend7dSlope ?? null,
        row.rangeHitRatePct ?? null,
        row.tvlTrendPct ?? null,
        row.volTvlRatio ?? null,
        row.aprDeltaPct ?? null,
        row.confidenceScore ?? null,
        row.tier ?? null,
        row.tokenReturnAprPct ?? null,
        row.tokenReturnConfidence ?? null,
        row.dailyPnlPct ?? null,
        row.totalReturnAprPct ?? null,
        row.weeklyPnlPct ?? null,
        // Profil-Refactor Phase 1
        row.aprSlopePct ?? null,
        row.volumeSpikeFactor ?? null,
        row.shortTermAprPct ?? null,
        row.shortTermConfidence ?? null,
        row.entryExitSlippagePct ?? null,
        row.entryExitCostAprPct ?? null,
        // Profil-Refactor Phase 2
        row.shortTermTier ?? null,
        row.shortTermRankPos ?? null,
        row.shortTermRankOf ?? null,
        row.shortTermNetMetric ?? null,
        row.shortTermTentativeTier ?? null,
        row.shortTermModifiedScore ?? null,
    );
}

/**
 * Liefert die letzten N Score-Einträge eines Pools (neueste zuerst).
 */
export function getPoolScoreHistory(db, poolId, limit = 96) {
    return db.prepare(`
        SELECT recorded_at, net_apr_pct, verdict, trend, rank_pos, rank_of
          FROM pool_score_history
         WHERE pool_id = ?
         ORDER BY recorded_at DESC
         LIMIT ?
    `).all(poolId, limit);
}

/**
 * Liefert die Dauer (Millisekunden), seit der ein Pool durchgehend als "bad"
 * bewertet wurde — oder null wenn aktuell nicht "withdraw" oder noch keine Historie.
 *
 * Logik: Vom neuesten Eintrag rückwärts gehen, solange tier='withdraw' ist.
 * Zeitspanne = newest.recorded_at - earliest_withdraw_in_streak.
 *
 * Hinweis (2026-05-18): Migriert von verdict='bad' (Range-Advisor-Logik) auf
 * tier='withdraw' (Economic-Scorer-Logik mit Total Return). Die neue Bewertung
 * berücksichtigt Token-Wert-Bewegungen, die der Range-Advisor nicht kannte.
 *
 * Phase 2 (2026-05-19): Profil-aware. profile='short' liest short_term_tier,
 * sonst (default) den klassischen tier-Spaltenwert (Mittelfrist).
 *
 * @param {object} db
 * @param {string} poolId
 * @param {number} [lookbackHours=96]
 * @param {'medium'|'short'} [profile='medium']
 */
export function getBadStreakMs(db, poolId, lookbackHours = 96, profile = 'medium') {
    const tierCol = profile === 'short' ? 'short_term_tier' : 'tier';
    const sinceTs = Date.now() - lookbackHours * 60 * 60 * 1000;
    const rows = db.prepare(`
        SELECT recorded_at, ${tierCol} AS tier
          FROM pool_score_history
         WHERE pool_id = ? AND recorded_at >= ?
         ORDER BY recorded_at DESC
    `).all(poolId, sinceTs);
    if (rows.length === 0 || rows[0].tier !== 'withdraw') return null;
    let earliestWithdrawTs = rows[0].recorded_at;
    for (const r of rows) {
        if (r.tier !== 'withdraw') break;
        earliestWithdrawTs = r.recorded_at;
    }
    return Date.now() - earliestWithdrawTs;
}

/**
 * Löscht Score-Historie älter als keepDays Tage.
 */
export function prunePoolScoreHistory(db, keepDays = 30) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    db.prepare(`DELETE FROM pool_score_history WHERE recorded_at < ?`).run(cutoff);
}

// ─── Advisor Log ─────────────────────────────────────────────────────────────

/**
 * Schreibt einen Advisor-Ergebnis-Eintrag. Erwartet das direkte analyzePool()-Ergebnis.
 */
export function insertAdvisorLog(db, advice) {
    const opt  = advice.rationale.optimalScore;
    const trd  = advice.rationale.trend;
    const vola = advice.rationale.volatility;
    const be   = advice.rationale.breakEven;
    const mkt  = advice.marketData;

    db.prepare(`
        INSERT INTO advisor_log (
            pool_id, recorded_at,
            range_pct, confidence,
            net_apr_pct, gross_apr_pct, rebal_cost_apr_pct, annual_il_pct,
            hours_until_oor, rebals_per_day, my_share,
            trend_direction, trend_strength, ema10, ema20, ema30,
            volatility_hourly, volatility_annualized, is_fallback_vola, data_points,
            capital_usdc, is_profitable, min_capital_usdc,
            tvl_usdc, volume_24h_usdc, current_price, current_range_pct
        ) VALUES (
            ?, ?,
            ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?
        )
    `).run(
        advice.poolId, advice.timestamp,
        advice.recommendation.rangePct,  advice.recommendation.confidence,
        opt.netAprPct,  opt.grossAprPct,  opt.rebalCostAprPct,  opt.annualIlPct,
        opt.hoursUntilOor,  opt.rebalsPerDay,  opt.myShare,
        trd.direction,  trd.strength,  trd.ema10 ?? null,  trd.ema20 ?? null,  trd.ema30 ?? null,
        vola.hourlyPct ?? null,  vola.annualizedPct ?? null,  vola.isFallback ? 1 : 0,  vola.dataPoints ?? 0,
        be.currentCapitalUsdc,  be.isProfitable ? 1 : 0,  be.minCapitalUsdc ?? null,
        mkt.tvlUsdc,  mkt.vol24h,  mkt.currentPrice,  advice.rationale.currentRange ?? null,
    );
}

/**
 * Liefert die letzten N Advisor-Log-Einträge eines Pools (neueste zuerst).
 */
export function getAdvisorLog(db, poolId, limit = 96) {
    return db.prepare(`
        SELECT * FROM advisor_log
         WHERE pool_id = ?
         ORDER BY recorded_at DESC
         LIMIT ?
    `).all(poolId, limit);
}

/**
 * Löscht Advisor-Log-Einträge älter als keepDays Tage.
 */
export function pruneAdvisorLog(db, keepDays = 14) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    db.prepare(`DELETE FROM advisor_log WHERE recorded_at < ?`).run(cutoff);
}

/**
 * Schreibt eine Advisor-Entscheidung (Konsultation + getroffene/abgelehnte Aktion).
 * @param {Database} db
 * @param {Object}   decision  Felder analog Spalten von advisor_decisions (camelCase).
 */
export function insertAdvisorDecision(db, decision) {
    db.prepare(`
        INSERT INTO advisor_decisions (
            pool_id, triggered_by, current_range_pct, recommended_range_pct,
            confidence, action_taken, rejection_reason,
            net_apr_current, net_apr_recommended,
            swap_cost_empirical, model_drift, attrition_pct_per_month,
            capital_usdc, payback_hours, created_at
        ) VALUES (
            @poolId, @triggeredBy, @currentRangePct, @recommendedRangePct,
            @confidence, @actionTaken, @rejectionReason,
            @netAprCurrent, @netAprRecommended,
            @swapCostEmpirical, @modelDrift, @attritionPctPerMonth,
            @capitalUsdc, @paybackHours, @createdAt
        )
    `).run({
        currentRangePct:     null,
        rejectionReason:     null,
        netAprCurrent:       null,
        netAprRecommended:   null,
        swapCostEmpirical:   null,
        modelDrift:          null,
        attritionPctPerMonth: null,
        capitalUsdc:         null,
        paybackHours:        null,
        ...decision,
        createdAt: Date.now(),
    });
}

/**
 * Löscht advisor_decisions-Einträge älter als keepDays Tage (Default: 730 = 2 Jahre,
 * analog rebalance_history).
 */
export function pruneAdvisorDecisions(db, keepDays = 730) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    db.prepare(`DELETE FROM advisor_decisions WHERE created_at < ?`).run(cutoff);
}

// ─── Transactions ─────────────────────────────────────────────────────────────

/**
 * Schreibt einen Audit-Trail-Eintrag.
 * @param {Database} db
 * @param {Object}   tx  { poolId, type, amountA, amountB, usdValue, txHash, note }
 */
export function insertTransaction(db, tx) {
    db.prepare(`
        INSERT INTO transactions
            (pool_id, type, amount_a, amount_b, usd_value, tx_hash, tx_fee_sol, note, created_at)
        VALUES
            (@poolId, @type, @amountA, @amountB, @usdValue, @txHash, @txFeeSol, @note, @createdAt)
    `).run({ txFeeSol: null, ...tx, createdAt: Date.now() });
}

// ─── Capital-Flows ────────────────────────────────────────────────────────────

/**
 * Schreibt einen Kapital-Zufluss (manueller Deposit).
 * balance_snapshot = Gesamtguthaben (LP+Wallet) zum Deposit-Zeitpunkt → wird als Baseline verwendet.
 * @param {Database} db
 * @param {Object}   flow  { poolId, usdcAmount, balanceSnapshot?, txHash?, note? }
 */
export function insertCapitalFlow(db, flow) {
    db.prepare(`
        INSERT INTO capital_flows (pool_id, usdc_amount, balance_snapshot, tx_hash, note, is_external, created_at)
        VALUES (@poolId, @usdcAmount, @balanceSnapshot, @txHash, @note, @isExternal, @createdAt)
    `).run({ txHash: null, note: null, balanceSnapshot: null, isExternal: 1, ...flow, createdAt: Date.now() });
}

// ─── Notifications ────────────────────────────────────────────────────────────

/**
 * Schreibt eine Dashboard-Benachrichtigung.
 * @param {Database} db
 * @param {Object}   notif  { poolId, level, message }
 */
export function insertNotification(db, notif) {
    db.prepare(`
        INSERT INTO notifications (pool_id, level, message, created_at)
        VALUES (@poolId, @level, @message, @createdAt)
    `).run({ ...notif, createdAt: Date.now() });
}

/**
 * Gibt ungelesene Benachrichtigungen zurück.
 * @param {Database} db
 * @param {number}   limit  Default: 20
 * @returns {Array}
 */
// ─── Stop-Loss Executions ─────────────────────────────────────────────────────

export function createSlExecution(db, { poolId, triggerPriceA, triggerPriceB, configSnapshot }) {
    const result = db.prepare(`
        INSERT INTO sl_executions (pool_id, triggered_at, trigger_price_a, trigger_price_b, config_snapshot)
        VALUES (?, ?, ?, ?, ?)
    `).run(poolId, Date.now(), triggerPriceA ?? null, triggerPriceB ?? null, JSON.stringify(configSnapshot));
    return result.lastInsertRowid;
}

export function updateSlExecution(db, id, fields) {
    const allowed = ['step', 'sl_coins_a', 'sl_coins_b', 'swapped_usdc', 'completed_at', 'error_msg'];
    const sets    = Object.keys(fields).filter(k => allowed.includes(k));
    if (!sets.length) return;
    const sql = `UPDATE sl_executions SET ${sets.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...sets.map(k => fields[k]), id);
}

export function getIncompleteSlExecutions(db) {
    return db.prepare(
        `SELECT * FROM sl_executions WHERE step != 'complete' ORDER BY triggered_at ASC`
    ).all();
}

export function getUnreadNotifications(db, limit = 20) {
    return db.prepare(`
        SELECT * FROM notifications WHERE read = 0
        ORDER BY created_at DESC LIMIT ?
    `).all(limit);
}

// ─── Take-Profit Executions ───────────────────────────────────────────────────

export function createTpExecution(db, { poolId, triggerPriceA, triggerPriceB, configSnapshot }) {
    const result = db.prepare(`
        INSERT INTO tp_executions (pool_id, triggered_at, trigger_price_a, trigger_price_b, config_snapshot)
        VALUES (?, ?, ?, ?, ?)
    `).run(poolId, Date.now(), triggerPriceA ?? null, triggerPriceB ?? null, JSON.stringify(configSnapshot));
    return result.lastInsertRowid;
}

export function updateTpExecution(db, id, fields) {
    const allowed = ['step', 'tp_coins_a', 'tp_coins_b', 'swapped_usdc', 'completed_at', 'error_msg'];
    const sets    = Object.keys(fields).filter(k => allowed.includes(k));
    if (!sets.length) return;
    const sql = `UPDATE tp_executions SET ${sets.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...sets.map(k => fields[k]), id);
}

export function getIncompleteTpExecutions(db) {
    return db.prepare(
        `SELECT * FROM tp_executions WHERE step != 'complete' ORDER BY triggered_at ASC`
    ).all();
}

// ─── Ranking-Exit State-Machine ───────────────────────────────────────────────

export function createRkExecution(db, { poolId, streakHours, configSnapshot }) {
    const result = db.prepare(`
        INSERT INTO rk_executions (pool_id, triggered_at, streak_hours, config_snapshot)
        VALUES (?, ?, ?, ?)
    `).run(poolId, Date.now(), streakHours ?? null, JSON.stringify(configSnapshot));
    return result.lastInsertRowid;
}

export function updateRkExecution(db, id, fields) {
    const allowed = ['step', 'rk_coins_a', 'rk_coins_b', 'swapped_usdc', 'completed_at', 'error_msg'];
    const sets    = Object.keys(fields).filter(k => allowed.includes(k));
    if (!sets.length) return;
    const sql = `UPDATE rk_executions SET ${sets.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...sets.map(k => fields[k]), id);
}

export function getIncompleteRkExecutions(db) {
    return db.prepare(
        `SELECT * FROM rk_executions WHERE step != 'complete' ORDER BY triggered_at ASC`
    ).all();
}

// ─── Retirement-Exit State-Machine (Premium-Offer zurückgestuft) ─────────────

export function createRetireExecution(db, { poolId, triggerKind, triggerReason, observedTvlUsd, observedLpUsd, configSnapshot }) {
    const result = db.prepare(`
        INSERT INTO retire_executions
            (pool_id, triggered_at, trigger_kind, trigger_reason, observed_tvl_usd, observed_lp_usd, config_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(poolId, Date.now(), triggerKind ?? null, triggerReason ?? null,
           observedTvlUsd ?? null, observedLpUsd ?? null, JSON.stringify(configSnapshot ?? {}));
    return result.lastInsertRowid;
}

export function updateRetireExecution(db, id, fields) {
    const allowed = ['step', 'coins_a', 'coins_b', 'swapped_usdc', 'completed_at', 'error_msg'];
    const sets    = Object.keys(fields).filter(k => allowed.includes(k));
    if (!sets.length) return;
    const sql = `UPDATE retire_executions SET ${sets.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...sets.map(k => fields[k]), id);
}

export function getIncompleteRetireExecutions(db) {
    return db.prepare(
        `SELECT * FROM retire_executions WHERE step != 'complete' ORDER BY triggered_at ASC`
    ).all();
}

/** Hat dieser Pool bereits einen abgeschlossenen Retirement-Exit? Dann nie erneut. */
export function hasCompletedRetireExecution(db, poolId) {
    return !!db.prepare(
        `SELECT 1 FROM retire_executions WHERE pool_id = ? AND step = 'complete' LIMIT 1`
    ).get(poolId);
}

// ─── Merkzettel für den Premium-Offer-Abgleich ───────────────────────────────

export function getPoolOfferState(db, poolId) {
    return db.prepare(`SELECT * FROM pool_offer_state WHERE pool_id = ?`).get(poolId) ?? null;
}

/**
 * Hält das Bestätigungsfenster einer Rückstufung fest: wann zum ersten Mal gesehen
 * und in welchen Blob-Sequenzen (kommagetrennt, dedupliziert).
 */
export function recordRetirementSighting(db, poolId, { firstSeenAt, sequence, notifiedAt }) {
    const prev = getPoolOfferState(db, poolId);
    const seqs = new Set((prev?.retired_sequences ?? '').split(',').filter(Boolean));
    if (Number.isFinite(sequence)) seqs.add(String(sequence));
    db.prepare(`
        INSERT INTO pool_offer_state (pool_id, retired_first_seen_at, retired_sequences, retired_notified_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(pool_id) DO UPDATE SET
            retired_first_seen_at = COALESCE(pool_offer_state.retired_first_seen_at, excluded.retired_first_seen_at),
            retired_sequences     = excluded.retired_sequences,
            retired_notified_at   = COALESCE(excluded.retired_notified_at, pool_offer_state.retired_notified_at)
    `).run(poolId, firstSeenAt ?? Date.now(), [...seqs].join(','), notifiedAt ?? null);
}

/** Rückstufung ist weg (Master bietet den Pool wieder an) → Fenster zurücksetzen. */
export function clearRetirementSighting(db, poolId) {
    db.prepare(`
        UPDATE pool_offer_state
           SET retired_first_seen_at = NULL, retired_sequences = NULL, retired_notified_at = NULL
         WHERE pool_id = ?
    `).run(poolId);
}

export function recordOfferUpdate(db, poolId, sequence) {
    db.prepare(`
        INSERT INTO pool_offer_state (pool_id, last_update_at, last_update_sequence)
        VALUES (?, ?, ?)
        ON CONFLICT(pool_id) DO UPDATE SET
            last_update_at       = excluded.last_update_at,
            last_update_sequence = excluded.last_update_sequence
    `).run(poolId, Date.now(), Number.isFinite(sequence) ? sequence : null);
}

// ─── Trailing-Stop State-Machine + HWM ────────────────────────────────────────

/**
 * Aktualisiert die High-Water-Mark der offenen Position eines Pools, wenn der
 * aktuelle lp_value_usd höher liegt als der bisher gespeicherte hwm_usd. HWM
 * läuft monoton nach oben; sie wird ausschließlich beim Öffnen einer neuen
 * Position zurückgesetzt (über insertPosition → hwm_usd ist NULL).
 *
 * @returns {{ hwmUsd: number, updated: boolean }}  neue HWM + ob ein Update geschrieben wurde
 */
export function updatePositionHwm(db, positionId, currentUsd) {
    if (!(currentUsd > 0)) return { hwmUsd: 0, updated: false };
    const row = db.prepare(`SELECT hwm_usd, hwm_base_adjustment FROM positions WHERE id = ?`).get(positionId);
    const prev = row?.hwm_usd ?? 0;

    if (!(prev > 0)) {
        // Erster Snapshot dieser Position: gespeichertes Adjustment anwenden.
        // Dadurch stammen HWM und Trailing-Stop-Vergleichswert aus derselben Quelle
        // (beide via getPositionState / position_snapshots), nie aus totalDeployed.
        const adj = row?.hwm_base_adjustment ?? 0;
        const adjustedHwm = Math.max(currentUsd, currentUsd + adj);
        db.prepare(`UPDATE positions SET hwm_usd = ?, hwm_at = ? WHERE id = ?`)
          .run(adjustedHwm, Date.now(), positionId);
        return { hwmUsd: adjustedHwm, updated: true };
    }

    if (currentUsd > prev) {
        db.prepare(`UPDATE positions SET hwm_usd = ?, hwm_at = ? WHERE id = ?`)
          .run(currentUsd, Date.now(), positionId);
        return { hwmUsd: currentUsd, updated: true };
    }
    return { hwmUsd: prev, updated: false };
}

/**
 * Speichert das HWM-Basisadjustment für die neue Position nach einem Rebalancing.
 * Wert: preHwm − preValue (wie weit die HWM über dem letzten Snapshot lag).
 * Wird beim ersten updatePositionHwm-Aufruf (erster echter Snapshot) angewendet.
 */
export function setPositionHwmBaseAdjustment(db, positionId, adjustment) {
    db.prepare(`UPDATE positions SET hwm_base_adjustment = ? WHERE id = ?`)
      .run(adjustment, positionId);
}

export function createTsExecution(db, { poolId, hwmUsd, currentUsd, drawdownPct, configSnapshot }) {
    const result = db.prepare(`
        INSERT INTO ts_executions (pool_id, triggered_at, hwm_usd, current_usd, drawdown_pct, config_snapshot)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(poolId, Date.now(), hwmUsd ?? null, currentUsd ?? null, drawdownPct ?? null, JSON.stringify(configSnapshot));
    return result.lastInsertRowid;
}

export function updateTsExecution(db, id, fields) {
    const allowed = ['step', 'ts_coins_a', 'ts_coins_b', 'swapped_usdc', 'completed_at', 'error_msg'];
    const sets    = Object.keys(fields).filter(k => allowed.includes(k));
    if (!sets.length) return;
    const sql = `UPDATE ts_executions SET ${sets.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...sets.map(k => fields[k]), id);
}

export function getIncompleteTsExecutions(db) {
    return db.prepare(
        `SELECT * FROM ts_executions WHERE step != 'complete' ORDER BY triggered_at ASC`
    ).all();
}

// ─── TVL-Schutz State-Machine ─────────────────────────────────────────────────

export function createTvlExecution(db, { poolId, positionId, level, tvlUsd, thresholdUsd, withdrawPct, configSnapshot }) {
    const result = db.prepare(`
        INSERT INTO tvl_executions
            (pool_id, position_id, level, triggered_at, tvl_usd, threshold_usd, withdraw_pct, config_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(poolId, positionId ?? null, level, Date.now(),
           tvlUsd ?? null, thresholdUsd ?? null, withdrawPct ?? null, JSON.stringify(configSnapshot));
    return result.lastInsertRowid;
}

export function updateTvlExecution(db, id, fields) {
    const allowed = ['step', 'coins_a', 'coins_b', 'swapped_usdc', 'completed_at', 'error_msg'];
    const sets    = Object.keys(fields).filter(k => allowed.includes(k));
    if (!sets.length) return;
    const sql = `UPDATE tvl_executions SET ${sets.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...sets.map(k => fields[k]), id);
}

export function getIncompleteTvlExecutions(db) {
    return db.prepare(
        `SELECT * FROM tvl_executions WHERE step != 'complete' ORDER BY triggered_at ASC`
    ).all();
}

/** Hat eine bestimmte Stufe für diese Position bereits gefeuert (laufend oder fertig)?
 *  Verhindert wiederholtes Auslösen derselben Stufe auf derselben Position. */
export function isTvlLevelExecutedForPosition(db, positionId, level) {
    if (positionId == null) return false;
    const row = db.prepare(
        `SELECT id FROM tvl_executions WHERE position_id = ? AND level = ? LIMIT 1`
    ).get(positionId, level);
    return !!row;
}

/** Zeitpunkt der letzten TVL-Schutz-Auslösung für einen Pool (für Cooldown). */
export function getLastTvlExecutionAt(db, poolId) {
    const row = db.prepare(
        `SELECT MAX(triggered_at) AS last FROM tvl_executions WHERE pool_id = ?`
    ).get(poolId);
    return row?.last ?? 0;
}

// ─── Score-Limit State-Machine ────────────────────────────────────────────────

export function createScoreLimitExecution(db, { poolId, triggerScore, configSnapshot, subScores = null }) {
    const result = db.prepare(`
        INSERT INTO score_limit_executions (
            pool_id, triggered_at, trigger_score, config_snapshot,
            apr_score, pnl_score_6h, pnl_score_12h, pnl_score_24h
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        poolId, Date.now(), triggerScore ?? null, JSON.stringify(configSnapshot),
        subScores?.aprScore ?? null, subScores?.pnl6hScore ?? null,
        subScores?.pnl12hScore ?? null, subScores?.pnl24hScore ?? null,
    );
    return result.lastInsertRowid;
}

export function updateScoreLimitExecution(db, id, fields) {
    const allowed = ['step', 'coins_a', 'coins_b', 'swapped_usdc', 'completed_at', 'error_msg'];
    const sets    = Object.keys(fields).filter(k => allowed.includes(k));
    if (!sets.length) return;
    const sql = `UPDATE score_limit_executions SET ${sets.map(k => `${k} = ?`).join(', ')} WHERE id = ?`;
    db.prepare(sql).run(...sets.map(k => fields[k]), id);
}

export function getIncompleteScoreLimitExecutions(db) {
    return db.prepare(
        `SELECT * FROM score_limit_executions WHERE step != 'complete' ORDER BY triggered_at ASC`
    ).all();
}
