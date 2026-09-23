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
 *   reinvest_pending   – nicht reinvestierte Fee-Claim-Mengen je Pool (LIQ#000868, lib/reinvest-pending.js)
 *
 * Wichtig: NIEMALS direkte SQL-Manipulationen auf Bot-DBs außerhalb dieses Moduls.
 * Positions-Daten (Ticks, NFT-Mint) nur vom Bot schreiben — Chain ist Quelle der Wahrheit.
 */

import Database          from 'better-sqlite3';
import path              from 'path';
import { fileURLToPath } from 'url';
import { PATHS }         from '../../../config/paths.js';
import { logChainTx, setChainTxSink } from './chain-tx-log.js';
import { REINVEST_PENDING_SCHEMA } from './reinvest-pending.js';

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

    // Der Pool-Adapter vermerkt die Legs gebündelter Vorgänge über einen Sink, weil
    // er selbst keine DB-Referenz hat (siehe lib/chain-tx-log.js). Nur die echte
    // Bot-DB anmelden — Test-DBs (Premium-Ingest-selfTest) dürfen den Sink nicht
    // auf sich umbiegen.
    if (dbPath === PATHS.liquidityDb) {
        setChainTxSink(leg => logChainTx(db, leg));
    }
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
            leftover_usdc         REAL,              -- freigesetztes Kapital, das NICHT reinvestiert wurde (liegt im Wallet)
            rebalanced_at         INTEGER NOT NULL   -- Unix-Timestamp (ms)
        );

        -- Verschiebungs-Bilanz je Pool (LIQ#000841): Abgänge und Startwerte. Der Zugang steht
        -- schon in rebalance_history.leftover_usdc; hier stehen nur die Buchungen, die ihn
        -- verringern ('settle' = Nachzahlung in die Position), einmalig erhöhen ('seed' =
        -- manueller Startwert) und die Tagesversuche ('attempt', usdc = 0).
        CREATE TABLE IF NOT EXISTS rebalance_shift_ledger (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id     TEXT    NOT NULL,
            kind        TEXT    NOT NULL,            -- 'settle' | 'seed' | 'attempt'
            usdc        REAL    NOT NULL DEFAULT 0,
            tx_hash     TEXT,
            note        TEXT,
            created_at  INTEGER NOT NULL             -- Unix-Timestamp (ms)
        );
        CREATE INDEX IF NOT EXISTS idx_rebalance_shift_ledger_pool
            ON rebalance_shift_ledger(pool_id, created_at);

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
            created_at      INTEGER NOT NULL,        -- Unix-Timestamp (ms)
            -- usd_value_in/usd_value_out (LIQ#0376 Teil 2, nur type='swap'): Eingangs-/
            -- Ausgangswert EINES Swap-Legs, beide aus demselben Preis-Read. usd_value
            -- meint bei 'swap' NICHT durchgehend dasselbe — mal die Eingabe-, mal die
            -- Ausgabeseite (je nachdem, welche Seite zufällig USDC ist), siehe
            -- insertTransaction()-Kopfkommentar. usd_value bleibt deshalb unverändert;
            -- die neuen Spalten sind eigenständig und redundanzfrei. Bei Altzeilen NULL.
            usd_value_in    REAL,
            usd_value_out   REAL
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

        -- Legs eines gebündelten Vorgangs, die bewusst KEINE eigene transactions-Zeile
        -- bekommen (Details + Sicherheitsargument: lib/chain-tx-log.js).
        -- Ein Exit besteht on-chain aus bis zu drei TX (Fee-Claim, decreaseLiquidity,
        -- Burn), gebucht wird davon nur eine gemeinsame close_position-Zeile. Ohne
        -- diesen Log kennt die DB die Hashes der übrigen Legs nicht — der Abgleich
        -- in lib/capital-reconcile.js meldet sie dann als unerklärte Kapitalbewegung.
        CREATE TABLE IF NOT EXISTS chain_tx_log (
            tx_hash     TEXT    PRIMARY KEY,          -- Signatur des Legs
            pool_id     TEXT    NOT NULL,
            position_id INTEGER,                      -- Position, zu der das Leg gehört
            kind        TEXT    NOT NULL,             -- 'exit_fee_claim' | 'exit_decrease' | 'exit_burn'
            note        TEXT,
            created_at  INTEGER NOT NULL              -- Unix-Timestamp (ms)
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
            decrease_tx_hash TEXT,
            close_error     TEXT,
            config_snapshot TEXT,
            completed_at    INTEGER,
            error_msg       TEXT
        );

        -- Retirement-Exit Ausführungs-State-Machine (analog Trailing-Stop).
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

        CREATE INDEX IF NOT EXISTS idx_chain_tx_log_pos
            ON chain_tx_log(position_id, created_at DESC);

        -- Bot-Zustand (key-value store) – bisher nur für 'bot_state' genutzt:
        -- markiert beim Graceful-Shutdown (SIGTERM/SIGINT), dass der Bot bewusst
        -- gestoppt wurde, damit das Dashboard "Bot deaktiviert" statt eines
        -- Alt-Daten-Alarms zeigen kann (siehe bot.js SIGTERM-Handler).
        CREATE TABLE IF NOT EXISTS kv_config (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);
}

/**
 * Tabellen des Trailing-Stop-Advisors (Ticket LIQ#0351).
 *
 * `ts_advisor_episodes` hält je abgeschlossener Position die verdichtete Wertreihe. Sie wird
 * EINMAL geschrieben und nie neu berechnet: Die feinste Quelle (`ts_fast_checks`, 30-s-Takt)
 * wird nach 14 Tagen gelöscht, `position_snapshots_archive` ist mit ~5 Min deutlich gröber.
 * Ohne diese Festschreibung verlöre der Advisor seine beste Datenquelle laufend wieder.
 * Gespeichert wird die Wertreihe, nicht das Ergebnis eines Schwellenrasters: Ein späteres,
 * anderes Raster kann dieselbe Historie so erneut auswerten.
 *
 * Steht hier statt im Advisor-Modul, weil in FORGE alles Schema über migrateSchema() läuft
 * (Konvention aus CLAUDE.md) — und weil ein Import aus dem Advisor hierher zirkulär wäre.
 */
export function ensureTsAdvisorTables(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS ts_advisor_episodes (
            position_id  INTEGER PRIMARY KEY,
            pool_id      TEXT    NOT NULL,
            pool_type    TEXT,
            opened_at    INTEGER NOT NULL,
            closed_at    INTEGER NOT NULL,
            source       TEXT    NOT NULL,   -- 'fast' (30 s) | 'snapshot' (~5 min)
            point_count  INTEGER NOT NULL,
            entry_usd    REAL,
            peak_usd     REAL,
            series_json  TEXT    NOT NULL,   -- [[tRelMs, valueUsd], ...]
            flows_json   TEXT    NOT NULL,   -- [[tRelMs, usdcAmount], ...]
            captured_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tsae_pool ON ts_advisor_episodes (pool_id);
        CREATE INDEX IF NOT EXISTS idx_tsae_type ON ts_advisor_episodes (pool_type);

        CREATE TABLE IF NOT EXISTS ts_advisor_log (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            computed_at    INTEGER NOT NULL,
            scope_kind     TEXT    NOT NULL,   -- 'pool' | 'pool_type'
            scope_id       TEXT    NOT NULL,
            episodes       INTEGER NOT NULL,
            threshold_pct  REAL,               -- NULL = keine belastbare Empfehlung
            threshold_pct2 REAL,
            baseline_pct   REAL,
            baseline_pct2  REAL,
            capture_gain   REAL,               -- Prozentpunkte gegenüber Vergleichswert
            usd_gain       REAL,
            reason         TEXT    NOT NULL    -- Begründung, auch bei "keine Empfehlung"
        );
        CREATE INDEX IF NOT EXISTS idx_tsal_scope ON ts_advisor_log (scope_kind, scope_id, computed_at DESC);
    `);
}

/** Inkrementelle Schema-Migrationen für bestehende DBs. */
function migrateSchema(db) {
    // Wertreihen-Archiv (2026-08-22, Ticket #0313). `clearPositionSnapshots()` löschte die
    // position_snapshots eines Pools bei jedem Reopen — bei stündlichem Cleanup also
    // laufend. Folge: Von 102 in 30 Tagen geschlossenen Positionen waren nur 23 nachträglich
    // auswertbar; 77 % aller Exits ließen sich nicht mehr überprüfen, auch der über Wochen
    // gemeldete Fall „+1,5 % im Plus, geschlossen bei −2,1 %" nicht.
    //
    // 🔒 Bewusst ein Archiv statt „nicht mehr löschen": position_snapshots ist pool- und
    // nicht positionsbezogen. Blieben alte Reihen liegen, läse `_openingSnapshotMax()` sie
    // beim Etablieren des Höchststands mit und löste einen Sofort-Fehl-Exit aus. Das
    // Leseverhalten des Bots bleibt damit exakt unverändert; nur die Historie überlebt.
    db.exec(`
        CREATE TABLE IF NOT EXISTS position_snapshots_archive (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            src_id           INTEGER UNIQUE,
            position_id      INTEGER,
            pool_id          TEXT NOT NULL,
            lp_value_usd     REAL,
            fees_pending_usd REAL,
            il_usd           REAL,
            il_pct           REAL,
            recorded_at      INTEGER NOT NULL,
            fees_pending_a   REAL,
            fees_pending_b   REAL,
            price            REAL,
            amount_a         REAL,
            amount_b         REAL,
            archived_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_psa_position ON position_snapshots_archive (position_id);
        CREATE INDEX IF NOT EXISTS idx_psa_pool_time ON position_snapshots_archive (pool_id, recorded_at);
    `);

    const txCols = db.prepare(`PRAGMA table_info(transactions)`).all().map(c => c.name);
    if (!txCols.includes('tx_fee_sol')) {
        db.exec(`ALTER TABLE transactions ADD COLUMN tx_fee_sol REAL`);
    }

    // usd_value_in/usd_value_out (2026-09-04, LIQ#0376 Teil 2): Eingangs-/Ausgangswert
    // eines Swap-Legs, beide aus demselben Preis-Read — siehe Schema-Kommentar oben und
    // insertTransaction(). Altzeilen bleiben NULL, rückwirkend nicht rekonstruierbar.
    if (!txCols.includes('usd_value_in')) {
        db.exec(`ALTER TABLE transactions ADD COLUMN usd_value_in REAL`);
        console.log('[db] Migration: transactions.usd_value_in hinzugefügt.');
    }
    if (!txCols.includes('usd_value_out')) {
        db.exec(`ALTER TABLE transactions ADD COLUMN usd_value_out REAL`);
        console.log('[db] Migration: transactions.usd_value_out hinzugefügt.');
    }

    // Invest-Guard (2026-08-20): Kandidaten, die TVL-Schutz/Score-Limit vor dem Sortieren
    // aus der Rangliste geworfen haben. Ohne diese Spalte ist in der Historie später nicht
    // mehr erkennbar, dass ein höher bewerteter Pool angetreten war — winner_pool ist seit
    // dem Guard der beste ZULÄSSIGE, nicht der bestbewertete Pool.
    const cdTables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(t => t.name);
    if (cdTables.includes('cleanup_decisions')) {
        const cdCols = db.prepare(`PRAGMA table_info(cleanup_decisions)`).all().map(c => c.name);
        if (!cdCols.includes('excluded')) {
            db.exec(`ALTER TABLE cleanup_decisions ADD COLUMN excluded TEXT`);
            console.log('[db] Migration: cleanup_decisions.excluded ergänzt.');
        }
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
    // leftover_usdc: nicht reinvestiertes Kapital je Rebalance (LIQ#000558) — vor dieser
    // Migration ging der Wert nur transient ins Log/die Notification, nie in die DB.
    if (!rhCols.includes('leftover_usdc')) {
        db.exec(`ALTER TABLE rebalance_history ADD COLUMN leftover_usdc REAL`);
        console.log('[db] Migration: rebalance_history.leftover_usdc hinzugefügt.');
    }

    // Verschiebungs-Bilanz (LIQ#000841): Go-Live-Marker genau einmal je DB. Der Zugang aus
    // rebalance_history zählt erst ab diesem Zeitpunkt (siehe lib/rebalance-shift.js).
    if (!db.prepare(`SELECT 1 FROM rebalance_shift_ledger WHERE kind = 'start' LIMIT 1`).get()) {
        db.prepare(`INSERT INTO rebalance_shift_ledger (pool_id, kind, usdc, note, created_at) VALUES ('*', 'start', 0, 'Go-Live LIQ#000841', ?)`).run(Date.now());
        console.log('[db] Migration: rebalance_shift_ledger Go-Live-Marker gesetzt.');
    }

    // Ausstehender Fee-Reinvest je Pool (LIQ#000868, siehe lib/reinvest-pending.js).
    db.exec(REINVEST_PENDING_SCHEMA);

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
    // enabled_changed_at/_reason: wann + warum wurde die Nutzer-Freigabe zuletzt geändert
    // (manuell, TVL-Schutz, Emergency-Exit, Reaktivierung) – Settings-UI zeigt das im
    // Tooltip am Aktivieren-Button, damit ein gesperrter Pool nicht wie ein stiller Bug
    // aussieht (Fund 2026-08-06: forge-pub1 PUMP/SOL, ohne erkennbaren Grund deaktiviert).
    if (!poolCols.includes('enabled_changed_at')) {
        db.exec(`ALTER TABLE pools ADD COLUMN enabled_changed_at INTEGER`);
        console.log('[db] Migration: pools.enabled_changed_at hinzugefügt.');
    }
    if (!poolCols.includes('enabled_reason')) {
        db.exec(`ALTER TABLE pools ADD COLUMN enabled_reason TEXT`);
        console.log('[db] Migration: pools.enabled_reason hinzugefügt.');
    }
    // pool_type: seit LIQ#0332 ebenfalls DB-autoritativ (Festlegung) — der tägliche
    // Vola-Drift-Check in bot.js korrigiert den Typ bei nachhaltiger Verschiebung, ohne
    // die statische pools.json zu berühren (kein wiederkehrender Git-Diff, siehe setPoolActive
    // in lib/config.js). NULL = "noch nie korrigiert" → Seed aus pools.json bleibt maßgeblich.
    if (!poolCols.includes('pool_type')) {
        db.exec(`ALTER TABLE pools ADD COLUMN pool_type TEXT`);
        console.log('[db] Migration: pools.pool_type hinzugefügt.');
    }
    // notified_new_pool_at: Kante für die "neuer Pool verfügbar"-Premium-Nachricht
    // (bin/notify-new-pool.js) — NULL heißt "noch nicht gemeldet". Beim Hinzufügen der
    // Spalte werden ALLE bestehenden Pools sofort auf `now` gesetzt, sonst würde der
    // erste Lauf nach dem Rollout die komplette Bestandsliste als "neu" verschicken.
    if (!poolCols.includes('notified_new_pool_at')) {
        db.exec(`ALTER TABLE pools ADD COLUMN notified_new_pool_at INTEGER`);
        db.prepare(`UPDATE pools SET notified_new_pool_at = ? WHERE notified_new_pool_at IS NULL`).run(Date.now());
        console.log('[db] Migration: pools.notified_new_pool_at hinzugefügt (Bestand rückwirkend als gemeldet markiert).');
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
    // hwm_flow_ratio — trägt den prozentualen Abstand zum Höchststand über einen
    // Kapitalfluss hinweg (siehe rebaseHwmForCapitalFlow).
    if (!posCols.includes('hwm_flow_ratio')) {
        db.exec(`ALTER TABLE positions ADD COLUMN hwm_flow_ratio REAL`);
        console.log('[db] Migration: positions.hwm_flow_ratio hinzugefügt.');
    }

    // ── Zweistufiger Trailing Stop (Drawdown 1 → Drawdown 2) ────────────────────
    // entry_usd: gemessener Positionswert beim Etablieren der Position — die Referenz,
    // gegen die geprüft wird, ob der Gewinn groß genug für die engere Stufe 2 ist.
    // Bewusst der erste GEMESSENE Snapshot, nicht capital_usdc: letzteres enthält die
    // Swap-Kosten des Einstiegs und kann laut Betriebserfahrung korrupt sein.
    if (!posCols.includes('entry_usd')) {
        db.exec(`ALTER TABLE positions ADD COLUMN entry_usd REAL`);
        console.log('[db] Migration: positions.entry_usd hinzugefügt.');
    }
    // entry_flow_ratio — dasselbe Prinzip wie hwm_flow_ratio: ein Kapitalfluss verschiebt
    // lp_value_usd ohne Marktbewegung, also muss die Einstiegsreferenz relativ mitwandern.
    // Täte sie das nicht, würde jede Cleanup-Einzahlung wie Gewinn aussehen und Stufe 2
    // fälschlich scharf schalten.
    if (!posCols.includes('entry_flow_ratio')) {
        db.exec(`ALTER TABLE positions ADD COLUMN entry_flow_ratio REAL`);
        console.log('[db] Migration: positions.entry_flow_ratio hinzugefügt.');
    }
    // entry_cost_usdc — was der EINSTIEG selbst gekostet hat: Swap-Slippage, Protokoll-
    // Gebühren, TX-Fees und der Rest, der nicht in die Position wanderte. Gemessen als
    // (Wert der eingesetzten Mittel VOR dem Umtausch) − (tatsächlich eingezahltes Kapital),
    // additiv über Nachlagen. Ausschließlich Anzeige: der PnL beginnt laut lib/pnl.js beim
    // eingezahlten Kapital, diese Kosten liegen davor. NULL = nicht gemessen (Altbestand
    // und alle Pfade, die den Bruttoeinsatz nicht kennen) — die Meldung lässt die Zeile
    // dann weg, statt eine 0 zu behaupten (Konvention 1, notify-render.js).
    if (!posCols.includes('entry_cost_usdc')) {
        db.exec(`ALTER TABLE positions ADD COLUMN entry_cost_usdc REAL`);
        console.log('[db] Migration: positions.entry_cost_usdc hinzugefügt.');
    }
    // d2_armed_at — Zeitpunkt, zu dem Stufe 2 scharf wurde. Ratchet: einmal gesetzt,
    // bleibt es für die Lebensdauer der Position stehen. Ein Zurückfallen auf die weite
    // Stufe 1 würde bei Kursen, die um die Schwelle pendeln, zu Flapping führen.
    if (!posCols.includes('d2_armed_at')) {
        db.exec(`ALTER TABLE positions ADD COLUMN d2_armed_at INTEGER`);
        console.log('[db] Migration: positions.d2_armed_at hinzugefügt.');
    }
    // pnl_anchor_reset_at — Zeitpunkt eines manuellen "Höchststand zurücksetzen"-Klicks
    // im Risk-Management-UI. Ausschließlich von processHwmResetIfRequested() gesetzt,
    // NIE von der routinemäßigen monotonen HWM-Fortschreibung (die läuft bei jedem
    // Kursanstieg und würde als PnL-Anker sofort wieder falsch).
    //
    // Grund für die eigene Spalte statt Wiederverwendung von hwm_at: Der Reset-Klick sagt
    // dem Trailing Stop "miss ab hier neu" — dieselbe Aussage gilt für "Anteil"/PnL-seit-
    // Einstieg (bots/liquidity/bin/export.js, computeExitPnl() in exit-finalizer.js), die
    // beide den PnL-Anker sonst nur bei einem ECHTEN externen Kapitalfluss verschieben
    // (capital_flows, is_external=1) — ein Reset ist kein Geldfluss, würde also sonst nie
    // ankommen. Ohne diese Spalte zeigte "Anteil" nach einem Reset weiterhin den Verlust
    // seit dem echten Einstieg, während der Trailing Stop schon wieder bei 0 % stand
    // (Befund 2026-08-22: der Menüpunkt "zurücksetzen" legt genau das nahe). Siehe
    // resolvePnlAnchorMs() (lib/pnl-anchor.js) für die gemeinsame Logik.
    if (!posCols.includes('pnl_anchor_reset_at')) {
        db.exec(`ALTER TABLE positions ADD COLUMN pnl_anchor_reset_at INTEGER`);
        console.log('[db] Migration: positions.pnl_anchor_reset_at hinzugefügt.');
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

    // ts_executions: Trailing-Stop State-Machine (analog SL/TP)
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
                decrease_tx_hash TEXT,
                close_error     TEXT,
                config_snapshot TEXT,
                completed_at    INTEGER,
                error_msg       TEXT
            )
        `);
        console.log('[db] Migration: Tabelle ts_executions angelegt.');
    }

    // ts_executions.trigger_source — woher der Auslöser kam: 'tick' (5-Min-Zyklus) oder
    // 'fast' (Schnellprüfung zwischen zwei Zyklen, lib/fast-stop-check.js). Ohne diese
    // Spalte ließe sich im Nachhinein nicht messen, ob die Schnellprüfung Exits früher
    // fängt — und ein Schutzmechanismus ohne Messung ist per KB-Regel keiner
    // (Core/wirkungsnachweis.md).
    {
        const tsCols = db.prepare(`PRAGMA table_info(ts_executions)`).all().map(c => c.name);
        if (!tsCols.includes('trigger_source')) {
            db.exec(`ALTER TABLE ts_executions ADD COLUMN trigger_source TEXT`);
            console.log('[db] Migration: ts_executions.trigger_source hinzugefügt.');
        }
    }

    // ts_executions.decrease_tx_hash — Signatur der Liquiditaets-Entnahme, sobald sie
    // gelandet ist. Traegt den Zustand 'drained': Coins im Wallet, NFT noch nicht geburnt
    // (LIQ#0312). Ohne diese Spalte war ein Teilfehlschlag von einem folgenlosen Abbruch
    // nicht zu unterscheiden — der Resume buchte den Erloes dann als ~0.
    {
        const tsCols = db.prepare(`PRAGMA table_info(ts_executions)`).all().map(c => c.name);
        if (!tsCols.includes('decrease_tx_hash')) {
            db.exec(`ALTER TABLE ts_executions ADD COLUMN decrease_tx_hash TEXT`);
            console.log('[db] Migration: ts_executions.decrease_tx_hash hinzugefügt.');
        }
    }

    // close_error auch fuer die drei uebrigen Exit-State-Machines (LIQ#0312, Entkopplung
    // 23.08.2026) — dieselbe Trennung wie bei ts_executions: error_msg = „diese Ausführung
    // ist gescheitert", close_error = „es blieb ein leeres NFT übrig".
    // Hinweis: tvl_executions wird weiter unten erst angelegt — bei einer NEUEN DB greift
    // die Schleife dort nicht. Deshalb trägt deren CREATE TABLE die Spalte selbst.
    for (const tbl of ['score_limit_executions', 'tvl_executions', 'retire_executions']) {
        if (!tables.includes(tbl)) continue;
        const cols = db.prepare(`PRAGMA table_info(${tbl})`).all().map(c => c.name);
        if (!cols.includes('close_error')) {
            db.exec(`ALTER TABLE ${tbl} ADD COLUMN close_error TEXT`);
            console.log(`[db] Migration: ${tbl}.close_error hinzugefügt.`);
        }
    }

    // ts_executions.close_error — der Position-Close (NFT-Burn) ist gescheitert, das
    // Kapital wurde aber gerettet (LIQ#0312, Entkopplung 23.08.2026). BEWUSST getrennt von
    // error_msg: dort steht „diese Ausführung ist gescheitert", hier „es blieb ein leeres
    // NFT übrig". Eine abgeschlossene Ausführung darf ein close_error tragen — eine
    // error_msg nicht.
    {
        const tsCols = db.prepare(`PRAGMA table_info(ts_executions)`).all().map(c => c.name);
        if (!tsCols.includes('close_error')) {
            db.exec(`ALTER TABLE ts_executions ADD COLUMN close_error TEXT`);
            console.log('[db] Migration: ts_executions.close_error hinzugefügt.');
        }
    }

    // ts_fast_checks — jede Schnellprüfung des Trailing Stops (alle ~30 s je Pool mit
    // Kapital): Live-Preis, daraus gerechneter Positionswert, Abstand zum Höchststand,
    // Urteil. Das ist die feinere Preis-/Wertreihe, die bisher fehlte (Fartcoin/SOL am
    // 2026-08-22: −9 % in einem einzigen 5-Min-Intervall, nie belegbar, wie früh ein
    // engerer Takt ausgelöst hätte). Aufbewahrung 14 Tage (pruneTsFastChecks).
    db.exec(`
        CREATE TABLE IF NOT EXISTS ts_fast_checks (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            pool_id       TEXT    NOT NULL,
            position_id   INTEGER,
            checked_at    INTEGER NOT NULL,
            price         REAL,
            lp_value_usd  REAL,
            hwm_usd       REAL,
            drawdown_pct  REAL,
            threshold_pct REAL,
            stage         INTEGER,
            triggered     INTEGER NOT NULL DEFAULT 0,
            confirmed     INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_ts_fast_checks_pool_time ON ts_fast_checks (pool_id, checked_at);
    `);

    ensureTsAdvisorTables(db);

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
                error_msg       TEXT,
                close_error     TEXT
            )
        `);
        console.log('[db] Migration: Tabelle tvl_executions angelegt.');
    }

    // rk_executions: Rest des am 2026-08-15 ausgebauten Ranking-Exits.
    // Nur entfernen, wenn die Tabelle leer ist — eine gefüllte bliebe als Historie stehen
    // (auf `business` war sie leer: der Exit ist nie ausgelöst worden).
    if (tables.includes('rk_executions')) {
        const rest = db.prepare(`SELECT COUNT(*) AS n FROM rk_executions`).get().n;
        if (rest === 0) {
            db.exec(`DROP TABLE rk_executions`);
            console.log('[db] Migration: leere Tabelle rk_executions entfernt (Ranking-Exit ausgebaut).');
        } else {
            console.warn(`[db] rk_executions enthält ${rest} Zeile(n) – Tabelle bleibt als Historie erhalten.`);
        }
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
        // LIQ#000836: idx_invest_score_hist (pool_id, recorded_at DESC) war 1:1 der PK-Autoindex
        // (pool_id, recorded_at) und kostete 133 MB. SQLite liest den PK-Index rückwärts.
        const dupIdx = db.prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_invest_score_hist'`
        ).get();
        if (dupIdx) {
            db.exec(`DROP INDEX idx_invest_score_hist`);
            console.log('[db] Migration: redundanter Index idx_invest_score_hist entfernt.');
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
                candidates      TEXT    NOT NULL,  -- JSON: [{id, score, hopiumVeto}] – nur ZULÄSSIGE
                skipped         INTEGER NOT NULL DEFAULT 0, -- 1 wenn min_score nicht erreicht
                excluded        TEXT    -- JSON: [{id, score, rule, reason, ...}] vom Invest-Guard verworfen
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
    // Wallet liegt, ohne dass ein Cleanup-Invest (Modus 'pool:X') ihn aufgenommen hat.
    // Ohne Notbremse könnten größere Restbeträge beliebig lange als volatiles Asset
    // liegen bleiben. sweepDust() in bin/cleanup.js swappt nach CLEANUP_STUCK_HOURS
    // zwangsweise zu USDC (seit LIQ#000929 in jedem Cleanup-Modus).
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

    // sol_low_state: persistenter Zustand der SOL-Reserve-Unterschreitung, über
    // Bot-Neustarts hinweg (notify.js solLow() hatte bisher nur den In-Memory-Cooldown
    // `_lastSolLowNotifyAt`, der bei jedem Neustart verlorenging). Singleton-Zeile
    // (id=1): `active` erlaubt zu erkennen, wann die Reserve sich erholt hat (→ Recovery-
    // Meldung), `count` zählt die Warn-Wiederholungen für die Betreffzeile ("(1)", "(2)", …).
    if (!tables.includes('sol_low_state')) {
        db.exec(`
            CREATE TABLE sol_low_state (
                id     INTEGER PRIMARY KEY CHECK (id = 1),
                active INTEGER NOT NULL DEFAULT 0,
                count  INTEGER NOT NULL DEFAULT 0
            );
        `);
        console.log('[db] Migration: Tabelle sol_low_state angelegt.');
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

// ─── SOL-Reserve-Zustand (notify.js solLow(), cross-run) ──────────────────────

/** Markiert die SOL-Reserve als unterschritten, ohne den Warn-Zähler zu erhöhen. */
export function markSolLowActive(db) {
    db.prepare(`
        INSERT INTO sol_low_state (id, active, count) VALUES (1, 1, 0)
        ON CONFLICT(id) DO UPDATE SET active = 1
    `).run();
}

/** Erhöht den Warn-Wiederholungszähler und gibt den neuen Stand zurück (für die Betreffzeile). */
export function incrementSolLowCount(db) {
    db.prepare(`
        INSERT INTO sol_low_state (id, active, count) VALUES (1, 1, 1)
        ON CONFLICT(id) DO UPDATE SET active = 1, count = sol_low_state.count + 1
    `).run();
    return db.prepare(`SELECT count FROM sol_low_state WHERE id = 1`).get().count;
}

/** True, wenn die SOL-Reserve laut letztem bekannten Zustand aktuell unterschritten ist. */
export function isSolLowActive(db) {
    return !!db.prepare(`SELECT active FROM sol_low_state WHERE id = 1`).get()?.active;
}

/** Setzt den SOL-Reserve-Zustand nach Erholung zurück (Zähler auf 0, inaktiv). */
export function resetSolLow(db) {
    db.prepare(`DELETE FROM sol_low_state WHERE id = 1`).run();
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
        INSERT INTO pools (id, protocol, address, pair, token_a, token_b, decimals_a, decimals_b, fee_tier, tick_spacing, active, enabled, range_override_fixed_pct, pool_type)
        VALUES (@id, @protocol, @address, @pair, @tokenA, @tokenB, @decimalsA, @decimalsB, @feeTier, @tickSpacing, @active, @enabled, @rangeFixedPct, @poolType)
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
            range_override_fixed_pct = COALESCE(pools.range_override_fixed_pct, excluded.range_override_fixed_pct),
            pool_type    = COALESCE(pools.pool_type, excluded.pool_type)
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
                poolType:      p.poolType ?? null,
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
        rows = db.prepare(`SELECT id, active, enabled, range_override_fixed_pct, pool_type FROM pools`).all();
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
        if (row.pool_type !== null && row.pool_type !== undefined) {
            p.poolType = row.pool_type;
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
 * Die Position, zu der eine Exit-Ausführung gehört — auch wenn sie bereits geschlossen ist.
 *
 * 🔒 Warum das nötig ist: `getOpenPosition()` liefert beim WIEDERANLAUF nichts mehr. Ein
 * Resume ab Step 'withdrawn' setzt genau dort an, wo die Position schon geschlossen wurde;
 * die Abschlussmeldung stand dadurch ohne Kapital, ohne Höchststand und ohne PnL da
 * (NATIX/USDC, 30.08.2026, Meldung 7804: „Invest: undefined, PnL: undefined").
 *
 * Bewusst zeitlich verankert und nicht einfach „die letzte geschlossene Position": Zwischen
 * Auslösung und Wiederanlauf kann der Cleanup längst eine neue Position eröffnet und wieder
 * geschlossen haben. Gesucht ist die, die zum Zeitpunkt der Auslösung offen war.
 *
 * @param {Database} db
 * @param {string}   poolId
 * @param {number}   triggeredAt  ts_executions.triggered_at
 */
export function getPositionForExit(db, poolId, triggeredAt) {
    const open = getOpenPosition(db, poolId);
    if (open) return open;
    if (!Number.isFinite(triggeredAt)) return null;
    return db.prepare(`
        SELECT * FROM positions
         WHERE pool_id = ? AND opened_at <= ? AND closed_at IS NOT NULL AND closed_at >= ?
         ORDER BY closed_at ASC LIMIT 1
    `).get(poolId, triggeredAt, triggeredAt) ?? null;
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
 * Addiert die gemessenen Einstiegskosten einer Position (Swap-Slippage, Gebühren,
 * nicht eingezahlter Rest). Additiv, weil eine Position über Nachlagen mehrfach
 * befüllt wird und jede Befüllung eigene Kosten hat.
 *
 * Nur positive, endliche Werte werden gebucht: ein negativer Wert hieße, aus dem
 * Einstieg wäre mehr Kapital geworden als eingesetzt — das ist ein Messfehler
 * (veralteter Preis auf einer der beiden Seiten), keine Ersparnis.
 */
export function addPositionEntryCost(db, positionId, costUsdc) {
    if (!Number.isFinite(costUsdc) || costUsdc <= 0) return;
    db.prepare(
        `UPDATE positions SET entry_cost_usdc = COALESCE(entry_cost_usdc, 0) + ? WHERE id = ?`
    ).run(costUsdc, positionId);
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
 * Zählt Reinvest-Events (Fee-Claim → increaseLiquidity) im Zeitraum einer Position —
 * für die Risk-Management-Abschlussmeldung (Message Center: "Reinvests (N)" mit Link
 * zur Position auf dem Explorer, statt jedes einzelne Event in der Meldung aufzulisten).
 * `transactions` hat keine `position_id`-Spalte, deshalb Abgrenzung über pool_id + Zeitfenster.
 */
export function countReinvestEvents(db, poolId, fromMs, toMs) {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
    const row = db.prepare(`
        SELECT COUNT(*) AS n FROM transactions
         WHERE pool_id = ? AND type IN ('reinvest', 'claim') AND created_at BETWEEN ? AND ?
    `).get(poolId, fromMs, toMs);
    return row?.n ?? 0;
}

/**
 * Summiert transactions.usd_value im Zeitraum einer Position, optional gefiltert
 * auf `type` und/oder einen `note`-Präfix — für die zwei Verlauf-Zeilen der
 * Risk-Management-Abschlussmeldung ("Claim / Reinvest" und "Cleanup > Bester
 * Pool", Vorgabe 2026-09-01):
 *   - Claim/Reinvest:   { types: ['reinvest'] } — nur direkt in DIESE Position
 *     zurückgeflossene Fees (increaseLiquidity), nicht `type='claim'` allein,
 *     sonst zählt ein später per Cleanup reinvestierter Claim doppelt.
 *   - Cleanup > Bester Pool: { types: ['deposit', 'open_position'], notePrefix:
 *     'cleanup' } — was der Cleanup-Lauf ("Bester Pool"-Logik) in DIESE Position
 *     eingezahlt hat. Woher das Kapital stammt, ist in `transactions` nicht
 *     verknüpft (keine Quell-Pool-Spalte) — bewusst nicht versucht.
 * `usd_value` ist nicht bei jeder Zeile gesetzt (z.B. Cleanup-Swaps ohne
 * USDC-Referenz) — SUM() über NULL ist in SQLite ohnehin lückentolerant.
 */
export function sumTransactionUsdValue(db, poolId, fromMs, toMs, { types = null, notePrefix = null } = {}) {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
    const conditions = ['pool_id = ?', 'created_at BETWEEN ? AND ?'];
    const params = [poolId, fromMs, toMs];
    if (types?.length) {
        conditions.push(`type IN (${types.map(() => '?').join(',')})`);
        params.push(...types);
    }
    if (notePrefix) {
        conditions.push('note LIKE ?');
        params.push(`${notePrefix}%`);
    }
    const row = db.prepare(`SELECT SUM(usd_value) AS s FROM transactions WHERE ${conditions.join(' AND ')}`).get(...params);
    return row?.s ?? null;
}

/**
 * Archiviert die position_snapshots eines Pools und leert danach die Live-Tabelle.
 * Wird beim Öffnen einer neuen Position aufgerufen, damit Charts der neuen Session
 * sauber starten. fee_history, rebalance_history und capital_flows bleiben ohnehin erhalten.
 *
 * 🔒 Seit 2026-08-22 (#0313) werden die Zeilen NICHT mehr verworfen, sondern nach
 * position_snapshots_archive kopiert. Ohne diese Historie ist im Nachhinein nicht mehr
 * überprüfbar, ob ein Trailing-Stop-, TVL- oder Score-Limit-Exit richtig lag — genau daran
 * scheiterte jede Untersuchung gemeldeter Fehlfunktionen. Das Leseverhalten des Bots bleibt
 * unverändert: Alle Abfragen laufen weiter ausschließlich gegen position_snapshots.
 *
 * Die Zuordnung erfolgt über den Zeitstempel (die Position, die zum Zeitpunkt der Messung
 * offen war) statt über „die zuletzt geschlossene Position" — das bleibt auch dann richtig,
 * wenn der Aufrufer die Vorgängerposition noch nicht geschlossen hat.
 */
export function clearPositionSnapshots(db, poolId) {
    const archive = db.transaction(() => {
        db.prepare(`
            INSERT OR IGNORE INTO position_snapshots_archive
                (src_id, position_id, pool_id, lp_value_usd, fees_pending_usd, il_usd, il_pct,
                 recorded_at, fees_pending_a, fees_pending_b, price, amount_a, amount_b, archived_at)
            SELECT s.id,
                   (SELECT p.id FROM positions p
                     WHERE p.pool_id = s.pool_id AND p.opened_at <= s.recorded_at
                     ORDER BY p.opened_at DESC LIMIT 1),
                   s.pool_id, s.lp_value_usd, s.fees_pending_usd, s.il_usd, s.il_pct,
                   s.recorded_at, s.fees_pending_a, s.fees_pending_b, s.price, s.amount_a, s.amount_b, ?
              FROM position_snapshots s
             WHERE s.pool_id = ?
        `).run(Date.now(), poolId);
        return db.prepare(`DELETE FROM position_snapshots WHERE pool_id = ?`).run(poolId).changes;
    });
    const n = archive();
    if (n) console.log(`[db:${poolId}] ${n} Snapshot(s) archiviert, Live-Reihe geleert.`);
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
             lp_value_before_usdc, lp_value_after_usdc, leftover_usdc, rebalanced_at)
        VALUES
            (@poolId, @reason, @oldPositionId, @newPositionId,
             @oldTickLower, @oldTickUpper, @newTickLower, @newTickUpper,
             @priceAtEvent, @costSol, @feesClaimedA, @feesClaimedB,
             @lpValueBefore, @lpValueAfter, @leftoverUsdc, @rebalancedAt)
    `).run({
        lpValueBefore: null,
        lpValueAfter:  null,
        leftoverUsdc:  null,
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
 * Retention für die unbegrenzt wachsenden Score-Historien (LIQ#000836).
 * Löscht in Batches, damit der Bot-Writer nicht sekundenlang blockiert wird.
 * invest_score_history: 35 Tage (Dashboard-Chart '1m' liest 31 Tage).
 * @returns {{[table: string]: number}} gelöschte Zeilen je Tabelle
 */
export function pruneScoreHistories(db, { investDays = 35, oppDays = 30, poolScoreDays = 30 } = {}) {
    const DAY = 24 * 60 * 60 * 1000;
    const BATCH = 50_000;
    const now = Date.now();
    const jobs = [
        ['invest_score_history', now - investDays    * DAY],
        ['opportunity_scores',   now - oppDays       * DAY],
        ['pool_score_history',   now - poolScoreDays * DAY],
    ];
    const deleted = {};
    for (const [table, cutoff] of jobs) {
        const stmt = db.prepare(
            `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE recorded_at < ? LIMIT ${BATCH})`
        );
        let total = 0, n;
        do { n = stmt.run(cutoff).changes; total += n; } while (n === BATCH);
        deleted[table] = total;
    }
    return deleted;
}

/**
 * Verdichtet invest_score_history für Zeilen älter als afterDays auf ein Raster von
 * bucketMs (Vorgabe 10 min): je (pool_id, Bucket) bleibt eine Zeile mit dem Bucket-Anfang als
 * recorded_at und dem Mittelwert von score und exit_score (LIQ#000836).
 * Idempotent: verdichtete Zeilen liegen auf einem Vielfachen von bucketMs und werden beim
 * nächsten Lauf nicht mehr angefasst. Läuft in Tages-Chunks, je Chunk eine Transaktion.
 * Lesefenster im Dashboard: 1d im 10-min-Raster, 1w stündlich, 1m täglich — alle mitteln
 * ohnehin; nur ts-what-if/ts-sampling-check verlieren für Zeilen > afterDays die Minutenauflösung.
 * @returns {number} Zeilen, die dadurch weggefallen sind
 */
export function downsampleScoreHistory(db, { afterDays = 7, bucketMs = 600_000 } = {}) {
    const DAY = 86_400_000;                                 // Vielfaches von bucketMs → Chunks bucket-aligned
    const cutoff = Math.floor((Date.now() - afterDays * DAY) / bucketMs) * bucketMs;
    const first = db.prepare(`SELECT MIN(recorded_at) AS t FROM invest_score_history`).get()?.t;
    if (first == null || first >= cutoff) return 0;
    // Steady-State-Kurzschluss: liegt nichts Unverdichtetes mehr vor dem Cutoff, ist nichts zu tun.
    const pending = db.prepare(
        `SELECT 1 FROM invest_score_history WHERE recorded_at < ? AND recorded_at % ? != 0 LIMIT 1`
    ).get(cutoff, bucketMs);
    if (!pending) return 0;

    const agg = db.prepare(`
        SELECT pool_id, (recorded_at / ${bucketMs}) * ${bucketMs} AS b,
               ROUND(AVG(score)) AS score, ROUND(AVG(exit_score)) AS exit_score
        FROM invest_score_history
        WHERE recorded_at >= ? AND recorded_at < ?
        GROUP BY pool_id, recorded_at / ${bucketMs}
        HAVING COUNT(*) > 1 OR MIN(recorded_at) % ${bucketMs} != 0`);
    const del = db.prepare(
        `DELETE FROM invest_score_history WHERE recorded_at >= ? AND recorded_at < ? AND recorded_at % ${bucketMs} != 0`);
    const ins = db.prepare(
        `INSERT OR REPLACE INTO invest_score_history (pool_id, recorded_at, score, exit_score) VALUES (?,?,?,?)`);
    const count = db.prepare(
        `SELECT COUNT(*) AS n FROM invest_score_history WHERE recorded_at >= ? AND recorded_at < ?`);

    let removed = 0;
    for (let from = Math.floor(first / DAY) * DAY; from < cutoff; from += DAY) {
        const to = Math.min(from + DAY, cutoff);
        db.transaction(() => {
            const before = count.get(from, to).n;
            const rows = agg.all(from, to);               // vollständig materialisiert, bevor geschrieben wird
            del.run(from, to);
            for (const r of rows) ins.run(r.pool_id, r.b, r.score, r.exit_score);
            removed += before - count.get(from, to).n;
        })();
    }
    return removed;
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
 *
 * 🔒 KONVENTION: `usdValue` ist immer ein BETRAG (≥ 0). Die Richtung eines
 * Kapitalflusses steckt ausschließlich im `type` ('deposit' vs. 'withdraw'/
 * 'withdraw_full') — niemals im Vorzeichen. `lib/pnl.js` negiert jeden
 * Nicht-Deposit selbst; ein negativ geschriebener Wert wird dort ein zweites Mal
 * gedreht und macht aus einer Entnahme eine Einzahlung (Phantomverlust in Höhe
 * des doppelten Betrags, Vorfall 2026-08-13 via tvl-protection-l1).
 * Deshalb wird ein negativer Wert hart abgelehnt statt still korrigiert.
 *
 * 🔒 `usdValue` bedeutet bei type='swap' NICHT durchgehend dasselbe: die Aufrufer
 * setzen ihn auf die exakte USDC-Seite des Swaps, und die ist je nach Richtung mal
 * die Eingabe, mal die Ausgabe (z.B. cleanup swap USDC→ZEC: amount_a 200, usd_value
 * 200 = Eingang; dust swap ZEC→USDC: amount_b 0,374, usd_value 0,374 = Ausgang).
 * `usdValueIn`/`usdValueOut` (Spalten usd_value_in/usd_value_out, optional, nur für
 * type='swap' befüllt) beheben das: beide IMMER eindeutig Eingangs- bzw. Ausgangswert,
 * aus demselben Preis-Read berechnet (die Nicht-USD-Seite über einen einmalig gelesenen
 * Preis, die USDC-Seite exakt mit Faktor 1 — nie ein Vor-Swap-Preis gegen einen andere
 * Sekunden später gemessenen Wert). `usdValue` bleibt unangetastet — seine Bedeutung
 * nachträglich zu vereinheitlichen würde bestehende Zeilen umdeuten (LIQ#0376 Teil 2,
 * KB „Liquidity Bot/einstiegskosten-messung.md": genau diese Art impliziter Doppel-
 * bedeutung hat entry_cost_usdc unbrauchbar gemacht).
 *
 * @param {Database} db
 * @param {Object}   tx  { poolId, type, amountA, amountB, usdValue, usdValueIn?, usdValueOut?, txHash, note }
 * @throws {Error} wenn usdValue, usdValueIn oder usdValueOut negativ ist
 */
export function insertTransaction(db, tx) {
    for (const field of ['usdValue', 'usdValueIn', 'usdValueOut']) {
        if (Number.isFinite(tx[field]) && tx[field] < 0) {
            throw new Error(
                `[db.insertTransaction] ${field} muss ein Betrag ≥ 0 sein (Richtung über type), ` +
                `erhalten: ${tx[field]} für type='${tx.type}' pool='${tx.poolId}' note='${tx.note ?? ''}'`
            );
        }
    }
    db.prepare(`
        INSERT INTO transactions
            (pool_id, type, amount_a, amount_b, usd_value, usd_value_in, usd_value_out, tx_hash, tx_fee_sol, note, created_at)
        VALUES
            (@poolId, @type, @amountA, @amountB, @usdValue, @usdValueIn, @usdValueOut, @txHash, @txFeeSol, @note, @createdAt)
    `)
    // createdAt ist normalerweise "jetzt" — nachgetragene Buchungen (lib/capital-reconcile.js)
    // müssen aber den echten Zeitpunkt der Transaktion setzen können. lib/pnl.js rollt den
    // Kapital-Anker `cap` entlang der Snapshot-Zeitachse: säße ein nachgetragener Fluss auf
    // "jetzt" statt auf seinem blockTime, bliebe die gesamte Kurve dazwischen falsch.
    .run({ txFeeSol: null, usdValueIn: null, usdValueOut: null, createdAt: Date.now(), ...tx });
}

/**
 * Trägt die TX-Gebühr einer schon geschriebenen transactions-Zeile nach (LIQ#000896).
 * Für Pfade, die die Zeile sofort schreiben müssen und die Gebühr (RPC-Abfrage) nicht
 * abwarten dürfen, z.B. die Exit-Swaps in lib/exit-finalizer.js. Ändert nur Zeilen ohne
 * Gebühr, eine schon gesetzte bleibt unangetastet.
 */
export function setTransactionTxFee(db, { txHash, type, txFeeSol }) {
    if (!txHash || !Number.isFinite(txFeeSol)) return;
    db.prepare(`UPDATE transactions SET tx_fee_sol = ? WHERE tx_hash = ? AND type = ? AND tx_fee_sol IS NULL`)
      .run(txFeeSol, txHash, type);
}

/**
 * Trägt den tatsächlich erzielten Verkaufserlös in die close_position-Zeile eines
 * Auto-Exits nach.
 *
 * Warum nachträglich: `finalizeClosePosition()` schreibt die close_position-Zeile
 * unmittelbar nach dem on-chain Close — zu diesem Zeitpunkt ist der Erlös noch
 * unbekannt, weil der Verkaufs-Swap erst danach läuft. Die Zeile trägt deshalb
 * zunächst usd_value = NULL. Ohne diesen Nachtrag müssen Auswertungen den Wert
 * schätzen: `lib/pnl.js` wich auf den letzten Snapshot vor dem Close aus und fror
 * dadurch die Swap-Slippage als Phantom-Gewinn ein (Befund 22.08.2026, liq-zec-usdc:
 * 761,93 geschätzt gegen 754,91 real = 7,01 USDC zu viel), `bin/export.js` rechnet
 * sich bis heute einen Fallback aus Token-Mengen zusammen.
 *
 * Zuordnung über das Zeitfenster statt über den TX-Hash: die Exits sind
 * State-Machines mit Resume, nach einem Bot-Restart ist der Close-Hash im
 * Swap-Schritt nicht mehr zur Hand. `usd_value IS NULL` macht den Aufruf zugleich
 * idempotent — ein wiederholter Resume überschreibt keinen bereits gesetzten Wert.
 *
 * @param {Database} db
 * @param {Object}   opts  { poolId, usdValue, withinMs? }
 * @returns {boolean} true wenn eine Zeile aktualisiert wurde
 */
export function setCloseProceeds(db, { poolId, usdValue, withinMs = 30 * 60 * 1000 }) {
    if (!Number.isFinite(usdValue) || usdValue <= 0) return false;
    const row = db.prepare(`
        SELECT id FROM transactions
         WHERE pool_id = ? AND type = 'close_position' AND usd_value IS NULL
           AND created_at >= ?
         ORDER BY created_at DESC LIMIT 1
    `).get(poolId, Date.now() - withinMs);
    if (!row) return false;
    db.prepare(`UPDATE transactions SET usd_value = ? WHERE id = ?`).run(usdValue, row.id);
    return true;
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
    const allowed = ['step', 'coins_a', 'coins_b', 'swapped_usdc', 'completed_at',
                     'error_msg', 'close_error'];
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
 * Höchster Positionswert, der zwischen dem Öffnen der Position und dem ersten HWM-Update
 * bereits in `position_snapshots` steht — das Sicherheitsnetz gegen eine verlorene
 * Eröffnungsreferenz.
 *
 * Hintergrund: `updateHwm()` läuft ausschließlich im Snapshot-Pfad des Bot-Loops und wertet
 * dort nur den *neuesten* Snapshot aus. Die Öffnungspfade (Cleanup, Deposit) schreiben aber
 * bereits beim Öffnen einen Sofort-Snapshot. Ohne diese Funktion begann die Wertreihe des
 * Trailing Stops erst beim nächsten Bot-Tick — bis zu fünf Minuten nach dem Einstieg, und
 * alles, was der Markt in diesem Fenster tat, blieb für ihn unsichtbar.
 *
 * Live beobachtet am 2026-08-22 auf forge-pub1 (SOL/ZEC): Position um 07:05:29 mit 66,03 USDC
 * eröffnet, erster Bot-Snapshot um 07:10:20 bei 63,18 USDC (SOL −5,9 %, ZEC −4,2 % in dieser
 * Stunde). Der Höchststand wurde auf 63,18 gesetzt, der Drawdown von 4,3 % lag davor — bei
 * 2 % Schwelle hätte der Stop auslösen müssen und tat es nie.
 *
 * Zwei Einschränkungen halten das Netz sicher:
 *
 *  - 🔒 **Nur ohne aktiven Übertrag.** Liegt `hwm_base_adjustment` oder `hwm_flow_ratio` vor,
 *    stammt die Position aus einem Rebalancing oder einem Kapitalfluss; dort trägt der
 *    Übertrag den Abstand bereits korrekt, und ältere Snapshots stehen auf einem anderen
 *    Kapitalniveau. Sie einzurechnen würde die Referenz zu hoch ansetzen → Sofort-Fehl-Exit.
 *  - 🔒 **Nur ohne Kapitalfluss seit der Eröffnung.** Ein Withdraw, der die HWM hart
 *    zurücksetzt (unplausibles Verhältnis → `hwm_flow_ratio = NULL`), hinterlässt beide
 *    Spalten leer. Die Snapshots davor stehen dann auf einem höheren Kapitalniveau; sie
 *    einzurechnen hieße, gegen eine Referenz zu messen, die es nicht mehr gibt. Sobald seit
 *    der Eröffnung Kapital geflossen ist, bleibt das Netz deshalb ganz aus — dort regelt der
 *    Rebase-Mechanismus, und dessen harter Reset ist die bewusst sichere Richtung. Die 60 s
 *    Toleranz überspringen die Flüsse des Öffnungsvorgangs selbst (Open + Rest-Einzahlung).
 */
function _openingSnapshotMax(db, positionId, row) {
    if (row?.hwm_base_adjustment != null || row?.hwm_flow_ratio != null) return 0;

    const pos = db.prepare(`SELECT pool_id, opened_at FROM positions WHERE id = ?`).get(positionId);
    if (!(pos?.opened_at > 0)) return 0;

    const flow = db.prepare(
        `SELECT 1 FROM capital_flows WHERE pool_id = ? AND created_at > ? LIMIT 1`
    ).get(pos.pool_id, pos.opened_at + 60_000);
    if (flow) return 0;

    const seen = db.prepare(
        `SELECT MAX(lp_value_usd) AS mx FROM position_snapshots
          WHERE pool_id = ? AND recorded_at >= ?`
    ).get(pos.pool_id, pos.opened_at);

    return seen?.mx > 0 ? seen.mx : 0;
}

/**
 * Aktualisiert die High-Water-Mark der offenen Position eines Pools, wenn der
 * aktuelle lp_value_usd höher liegt als der bisher gespeicherte hwm_usd. HWM
 * läuft monoton nach oben; sie wird ausschließlich beim Öffnen einer neuen
 * Position zurückgesetzt (über insertPosition → hwm_usd ist NULL).
 *
 * `hwm_base_adjustment` trägt den Abstand zum Höchststand über eine Neu-Etablierung hinweg —
 * gesetzt beim Rebalancing (bot.js) und bei jedem Kapitalfluss
 * (→ rebaseHwmForCapitalFlow). Es wird genau einmal angewendet: beim ersten Snapshot,
 * der die HWM wieder etabliert.
 *
 * @returns {{ hwmUsd: number, updated: boolean }}  neue HWM + ob ein Update geschrieben wurde
 */
export function updatePositionHwm(db, positionId, currentUsd) {
    if (!(currentUsd > 0)) return { hwmUsd: 0, updated: false };
    const row = db.prepare(
        `SELECT hwm_usd, hwm_base_adjustment, hwm_flow_ratio, entry_usd, entry_flow_ratio FROM positions WHERE id = ?`
    ).get(positionId);
    const prev = row?.hwm_usd ?? 0;

    // Einstiegsreferenz etablieren/fortschreiben — dieselbe Logik wie bei der HWM, nur
    // ohne Monotonie: entry_usd ist ein Fixpunkt, der sich nur bei Kapitalflüssen und
    // Rebalancing verschiebt (dann liegt entry_flow_ratio vor).
    if (!(row?.entry_usd > 0)) {
        const eRatio   = row?.entry_flow_ratio;
        // Kein Plausibilitätsband nach oben nötig: anders als bei der HWM darf der
        // aktuelle Wert über der Einstiegsreferenz liegen — genau das ist der Gewinn,
        // den Stufe 2 messen soll.
        const entryUsd = (eRatio > 0) ? currentUsd / eRatio : currentUsd;
        db.prepare(`UPDATE positions SET entry_usd = ?, entry_flow_ratio = NULL WHERE id = ?`)
          .run(entryUsd, positionId);
    }

    if (!(prev > 0)) {
        // Erster Snapshot dieser Position: gespeicherten Übertrag anwenden.
        // Dadurch stammen HWM und Trailing-Stop-Vergleichswert aus derselben Quelle
        // (beide via getPositionState / position_snapshots), nie aus totalDeployed.
        //
        // Zwei Varianten, es ist immer höchstens eine gesetzt:
        //   hwm_base_adjustment (absolut, Rebalancing)  – Positionswert bleibt praktisch gleich
        //   hwm_flow_ratio      (relativ, Kapitalfluss) – Positionswert ändert sich sprunghaft,
        //                        nur das Verhältnis hält den prozentualen Abstand konstant
        const adj   = row?.hwm_base_adjustment ?? 0;
        const ratio = row?.hwm_flow_ratio;
        const fromRatio = (ratio > 0 && ratio <= 1) ? currentUsd / ratio : 0;
        const openingHwm  = _openingSnapshotMax(db, positionId, row);
        const adjustedHwm = Math.max(currentUsd, currentUsd + adj, fromRatio, openingHwm);
        // Übertrag mit dem Anwenden verbrauchen — er gilt genau für diese eine
        // Neu-Etablierung. Bliebe er stehen, würde ein späterer Kapitalfluss ihn erneut
        // aufschlagen und die Referenz Schritt für Schritt nach oben verschieben.
        db.prepare(
            `UPDATE positions SET hwm_usd = ?, hwm_at = ?, hwm_base_adjustment = NULL, hwm_flow_ratio = NULL WHERE id = ?`
        ).run(adjustedHwm, Date.now(), positionId);
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
 * Der Positionswert, mit dem der Trailing Stop rechnet: LP-Wert **plus offene Fees** aus dem
 * neuesten Snapshot — beide Komponenten desselben Snapshots, beide gemessen (`feesOwed`
 * on-chain, nach der Plausibilitätsprüfung in `writePositionSnapshotFromState`).
 *
 * Warum die Fees dazugehören (Fall PUMP/SOL 2026-08-30): Der Exit claimt die offenen Fees
 * immer mit (`prepareExitAndClaimFees`) — sie sind realisierbarer Positionswert. Ohne sie
 * maß der Stop systematisch weniger als das Dashboard anzeigt (dort rechnet `lib/pnl.js`
 * mit LP-Wert + Fees), und die Stufe-2-Scharfschaltung verfehlte ihre Schwelle, während die
 * Anzeige sie längst überschritten hatte. Der Claim/Reinvest-Zyklus ist in dieser Summe
 * neutral: geclaimte Fees wandern per Reinvest in den LP-Wert, nur der von der
 * Wallet-Balance gekappte Rest (< `minClaimUsdc`, ~0,1 %) verlässt die Summe kurzzeitig.
 *
 * @returns {{ valueUsd: number, lpValueUsd: number, feesUsd: number, recordedAt: number }|null}
 */
export function latestStopValueUsd(db, poolId) {
    const row = db.prepare(
        `SELECT lp_value_usd, fees_pending_usd, recorded_at FROM position_snapshots
          WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
    ).get(poolId);
    if (!row || !(row.lp_value_usd > 0)) return null;
    const fees = row.fees_pending_usd > 0 ? row.fees_pending_usd : 0;
    return {
        valueUsd:   row.lp_value_usd + fees,
        lpValueUsd: row.lp_value_usd,
        feesUsd:    fees,
        recordedAt: row.recorded_at,
    };
}

/**
 * ⚠️ Veraltet seit 2026-08-22 — kein Aufrufer mehr. Der Rebalancing-Übertrag läuft über
 * `carryHwmToRebalancedPosition()` (relativ). Das **Lesen** von `hwm_base_adjustment` in
 * `updatePositionHwm()` bleibt bestehen, damit Positionen, die zum Zeitpunkt eines Deployments
 * zwischen Rebalancing und erstem Snapshot stehen, ihren Übertrag noch sauber anwenden.
 *
 * Nicht für neuen Code verwenden: Ein absoluter USDC-Abstand gegen eine prozentuale Schwelle
 * ist die Fehlerklasse, die den Schutz zweimal ausgehebelt hat (Kapitalflüsse 2026-08-13,
 * Rebalancing 2026-08-22).
 */
export function setPositionHwmBaseAdjustment(db, positionId, adjustment) {
    db.prepare(`UPDATE positions SET hwm_base_adjustment = ? WHERE id = ?`)
      .run(adjustment, positionId);
}

/**
 * Trägt einen Kapitalfluss (Ein-/Auszahlung, Teil-Abzug) in der Trailing-Stop-Referenz nach,
 * OHNE den bereits aufgelaufenen Drawdown-Abstand zu verlieren.
 *
 * Das Problem, das diese Funktion löst: `hwm_usd` ist ein absoluter USDC-Wert und wird gegen
 * `lp_value_usd` verglichen. Jeder Kapitalfluss verschiebt `lp_value_usd`, ohne dass sich der
 * Marktwert geändert hat. Bis 2026-08-13 reagierten die vier betroffenen Pfade darauf auf drei
 * verschiedene Arten — bin/deposit.js, bin/withdraw.js und lib/tvl-protection.js setzten die HWM
 * auf NULL, lib/deposit-lib.js (der stündliche Cleanup-Pfad, mit Abstand der häufigste) gar
 * nicht. Beide Varianten haben denselben Effekt: die Referenz landet auf dem Wert NACH dem
 * Kapitalfluss, der zuvor aufgelaufene Abstand zum Höchststand ist weg.
 *
 * Folge: Stand ein Pool 1,5 % unter seinem Höchststand, als der Cleanup nachgezahlt hat, musste
 * er danach erneut die volle Schwelle fallen — bei stündlichem Cleanup ließ sich der Auslösepunkt
 * so beliebig weit nach unten schieben. Der Schutz konnte praktisch nie greifen.
 *
 * Lösung — dasselbe Muster wie beim Rebalancing, aber relativ statt absolut: Wir merken uns das
 * Verhältnis `lp_value_usd / hwm_usd` VOR dem Eingriff und setzen die HWM auf NULL. Der erste
 * On-Chain-Snapshot danach etabliert `hwm = lp_gemessen / Verhältnis` (siehe updatePositionHwm).
 * Der prozentuale Abstand zum Höchststand bleibt damit exakt erhalten — genau das, was eine
 * prozentuale Schwelle braucht. Ein absoluter USDC-Abstand würde beim Aufstocken prozentual
 * schrumpfen (1,5 USDC sind auf 98 USDC 1,5 %, auf 148 USDC nur noch 1,0 %) und damit dieselbe
 * Lücke nur verkleinern statt schließen.
 *
 * Bewusst wird NICHT der eingezahlte Betrag verrechnet: `depositedUsdc` stammt aus dem
 * Orca-Quote (`tokenEstA/tokenEstB`), ist also eine Schätzung. Bei PUMP/SOL am 2026-08-13 lag
 * sie 0,81 USDC (1,07 %) über dem tatsächlich gemessenen Positionswert — bei einer 2 %-Schwelle
 * wäre über die Hälfte des Budgets allein durch Schätzfehler verbraucht worden, mit Fehl-Exits
 * als Folge. Diese Funktion arbeitet ausschließlich mit gemessenen Werten.
 *
 * @param {Object} db
 * @param {number} positionId
 * @param {number} lpValueBefore  gemessener lp_value_usd VOR dem Kapitalfluss (Pflicht — der
 *                                Aufrufer muss ihn lesen, bevor er einen Delta-Snapshot schreibt)
 * @returns {{ drawdownPct: number, applied: boolean }}
 */
/**
 * Überträgt Einstiegsreferenz und Scharfschaltung der zweiten Drawdown-Stufe auf die
 * Position, die ein Rebalancing neu angelegt hat.
 *
 * Beides hängt an der Position, nicht am Pool — ein Rebalancing würde den bis dahin
 * aufgelaufenen Gewinnfortschritt sonst verwerfen und den Stop auf die weite Stufe 1
 * zurückfallen lassen. Bei regelmäßigem Rebalancing käme Stufe 2 dann nie zum Tragen.
 *
 * Der Übertrag läuft relativ (`entry_flow_ratio`), nicht absolut: Fließt beim Rebalancing
 * weniger Kapital in die neue Position, als vorher drin war (Wallet-Residual), schrumpfen
 * Positionswert und Einstiegsreferenz gemeinsam — der prozentuale Gewinn bleibt korrekt.
 * Ein absoluter Übertrag würde hier denselben Fehler machen wie beim HWM.
 *
 * @param {number} lpValueBefore  gemessener Positionswert vor dem Rebalancing
 * @param {number} entryUsd       Einstiegsreferenz der alten Position
 * @param {number|null} d2ArmedAt Scharfschalt-Zeitpunkt der alten Position (Ratchet)
 */
/**
 * Überträgt den **Höchststand** auf die Position, die ein Rebalancing neu angelegt hat —
 * relativ, nach demselben Muster wie `rebaseHwmForCapitalFlow()` und
 * `carryEntryToRebalancedPosition()`.
 *
 * Ersetzt seit 2026-08-22 den absoluten Übertrag über `hwm_base_adjustment`
 * (`preHwm − preValue − residual`). Der war aus demselben Grund falsch, aus dem die
 * Kapitalfluss-Pfade am 2026-08-13 auf ein Verhältnis umgestellt wurden: Die Schwelle ist
 * prozentual, die Referenz muss es auch sein. Schlimmer noch — verlor das Rebalancing
 * Kapital (Wallet-Residual), wurde der Übertrag negativ und `Math.max(currentUsd, …)` in
 * `updatePositionHwm()` verschluckte ihn vollständig: der Höchststand landete exakt auf dem
 * neuen Positionswert, der aufgelaufene Abstand war auf null.
 *
 * Nachgewiesen mit `bin/test-trailing-stop-sim.js`: Position bei 105 Höchststand und 103,40
 * aktuell (1,52 % Abstand), Rebalancing auf 100,00 → `adj = 105 − 103,40 − 3,40 = −1,80` →
 * Höchststand 100,00 statt korrekt 101,55. Beim nächsten Wert von 99,00 sah der Bot 1,0 %
 * Drawdown statt 2,51 % und löste bei 2 % Schwelle nicht aus. Bei regelmäßigem Rebalancing
 * ließ sich der Auslösepunkt so beliebig weit nach unten schieben.
 *
 * @param {number} lpValueBefore  gemessener Positionswert vor dem Rebalancing
 * @param {number} hwmBefore      Höchststand der alten Position
 * @returns {number|null} das übertragene Verhältnis (null = harter Reset)
 */
export function carryHwmToRebalancedPosition(db, newPositionId, lpValueBefore, hwmBefore) {
    // Plausibilitätsband wie in rebaseHwmForCapitalFlow: ein Abstand über 50 % bedeutet
    // defekte Daten (ein echter 50-%-Drawdown hätte den Stop längst ausgelöst), und eine
    // daraus abgeleitete, viel zu hohe Referenz würde einen sofortigen Fehl-Exit auslösen.
    let ratio = (lpValueBefore > 0 && hwmBefore > 0) ? Math.min(1, lpValueBefore / hwmBefore) : null;
    if (ratio != null && ratio < 0.5) ratio = null;

    db.prepare(
        `UPDATE positions SET hwm_usd = NULL, hwm_at = NULL, hwm_base_adjustment = NULL, hwm_flow_ratio = ? WHERE id = ?`
    ).run(ratio, newPositionId);

    return ratio;
}

export function carryEntryToRebalancedPosition(db, newPositionId, lpValueBefore, entryUsd, d2ArmedAt) {
    let ratio = (lpValueBefore > 0 && entryUsd > 0) ? lpValueBefore / entryUsd : null;
    if (ratio != null && (ratio < 0.5 || ratio > 2)) ratio = null;

    db.prepare(`UPDATE positions SET entry_flow_ratio = ?, d2_armed_at = ? WHERE id = ?`)
      .run(ratio, d2ArmedAt ?? null, newPositionId);
}

/**
 * Zieht die Einstiegsreferenz (`entry_usd`) über einen Kapitalfluss hinweg nach — exakt
 * dasselbe Prinzip wie bei der HWM, nur mit anderem Bezugspunkt.
 *
 * Warum das nötig ist: Die zweite Drawdown-Stufe schaltet scharf, sobald der Positionswert
 * die Einstiegsreferenz um Drawdown 1 übertroffen hat. Eine Cleanup-Einzahlung hebt
 * `lp_value_usd` aber ohne jede Marktbewegung — bliebe `entry_usd` dabei stehen, sähe das
 * wie Gewinn aus und würde die enge Stufe 2 fälschlich scharf schalten. Bei stündlichem
 * Cleanup wäre das nach wenigen Läufen bei praktisch jeder Position der Fall, mit
 * Fehl-Exits als Folge (dieselbe Fehlerklasse wie beim HWM-Vorfall vom 2026-08-13).
 *
 * Wir merken uns `lp_value_usd / entry_usd` VOR dem Eingriff und setzen `entry_usd` auf
 * NULL; der erste Snapshot danach etabliert `entry = lp_gemessen / Verhältnis`
 * (siehe updatePositionHwm). Weil HWM und Einstiegsreferenz damit denselben Faktor
 * erfahren, bleibt ihr Verhältnis — und damit der gemessene Gewinn — über den
 * Kapitalfluss hinweg unverändert.
 *
 * Anders als bei der HWM darf das Verhältnis über 1 liegen (Position im Gewinn). Das
 * Plausibilitätsband ist deshalb beidseitig; außerhalb fallen wir auf einen harten Reset
 * zurück. Das ist die sichere Richtung: die Referenz startet beim nächsten Snapshot neu,
 * Stufe 2 muss erneut verdient werden — ein zu weiter Stop schadet weniger als ein zu enger.
 *
 * `d2_armed_at` bleibt unberührt: einmal scharf, immer scharf (Ratchet).
 */
function rebaseEntryForCapitalFlow(db, positionId, lpValueBefore, entryUsd) {
    if (!(entryUsd > 0)) return;   // noch keine Referenz — der erste Snapshot setzt sie

    let ratio = (lpValueBefore > 0) ? lpValueBefore / entryUsd : null;
    if (ratio != null && (ratio < 0.5 || ratio > 2)) ratio = null;

    db.prepare(`UPDATE positions SET entry_usd = NULL, entry_flow_ratio = ? WHERE id = ?`)
      .run(ratio, positionId);
}

export function rebaseHwmForCapitalFlow(db, positionId, lpValueBefore) {
    const row = db.prepare(`SELECT hwm_usd, entry_usd FROM positions WHERE id = ?`).get(positionId);
    const hwm = row?.hwm_usd ?? 0;

    // Einstiegsreferenz nach demselben Muster mitziehen (siehe rebaseEntryForCapitalFlow).
    // Muss VOR dem Early-Return stehen: eine Position kann eine Einstiegsreferenz haben,
    // während die HWM gerade auf NULL steht (zwei Kapitalflüsse ohne Snapshot dazwischen).
    rebaseEntryForCapitalFlow(db, positionId, lpValueBefore, row?.entry_usd ?? 0);

    // Noch keine Referenz etabliert (frische Position) → nichts zu retten, der erste
    // Snapshot setzt sie ohnehin neu.
    if (!(hwm > 0)) return { drawdownPct: 0, applied: false };

    // Plausibilitätsband: ohne belastbaren Vorher-Wert, oder wenn der Abstand größer als 50 %
    // wäre, lieber auf das alte Verhalten zurückfallen (harter Reset, ratio = null) als einen
    // unsinnigen Referenzwert fortzuschreiben. Ein echter 50-%-Drawdown hätte den Trailing Stop
    // längst ausgelöst — ein solcher Wert bedeutet defekte Daten, und eine daraus abgeleitete,
    // viel zu hohe HWM würde einen sofortigen Fehl-Exit auslösen.
    let ratio = (lpValueBefore > 0) ? Math.min(1, lpValueBefore / hwm) : null;
    if (ratio != null && ratio < 0.5) ratio = null;

    db.prepare(
        `UPDATE positions SET hwm_usd = NULL, hwm_at = NULL, hwm_base_adjustment = NULL, hwm_flow_ratio = ? WHERE id = ?`
    ).run(ratio, positionId);

    return { drawdownPct: ratio != null ? (1 - ratio) * 100 : 0, applied: true };
}

/**
 * Zieht Höchststand und Einstiegsreferenz über einen Kapitalfluss hinweg nach — mit dem
 * **on-chain gemessenen Liquiditätsfaktor** statt mit dem zuletzt gemessenen Positionswert.
 *
 * Warum eine zweite Variante neben `rebaseHwmForCapitalFlow()`: Die Ratio-Variante merkt sich
 * `lp_value_usd / hwm_usd` aus dem *letzten Snapshot* — der ist bis zu fünf Minuten alt. Alles,
 * was der Markt zwischen diesem Snapshot und dem Kapitalfluss tat, liegt damit außerhalb der
 * Messreihe: der erste Snapshot nach dem Fluss etabliert die Referenz neu und nimmt die
 * Bewegung als gegeben hin (Befund 2026-08-22, forge-pub1, Position 81 — die Messlücke bei
 * Aufstockungen; die Ist-Werte stammen seitdem aus der bestätigten Transaktion).
 *
 * Der Wert einer CLMM-Position ist bei festem Range-Paar exakt proportional zu ihrer
 * Liquidität: V = L · g(P). Ein Kapitalfluss ändert L um den Faktor `L_nach / L_vor` — beides
 * on-chain exakt bekannt (Liquidität der Position vor dem Fluss, Liquidität aus den
 * Token-Deltas der bestätigten Transaktion). Skaliert man Höchststand und Einstiegsreferenz
 * mit genau diesem Faktor, bleibt der prozentuale Abstand zum aktuellen Kurs erhalten, und die
 * unmittelbar danach geschriebene **Messung** (Liquidität nach dem Fluss zum Ausführungspreis)
 * zeigt jede Marktbewegung seit dem letzten Snapshot als Drawdown — ohne Quote, ohne Schätzwert.
 *
 * Zwei Dinge, die bewusst so sind:
 *  - Nicht auf NULL setzen. Die Referenz ist sofort wieder gültig; es gibt kein Fenster, in dem
 *    `evaluateTsTrigger()` wegen fehlender HWM „none" liefert.
 *  - Ein noch offener Übertrag aus einem *vorigen* Fluss ohne Snapshot dazwischen (`hwm_flow_ratio`
 *    / `entry_flow_ratio`, HWM dann NULL) bleibt stehen: ein Verhältnis ist dimensionslos und
 *    überlebt eine Skalierung unverändert — der nächste Snapshot löst ihn wie gehabt auf.
 *
 * Plausibilitätsband: Faktor außerhalb [0,01; 100] gilt als defekte Eingabe → nichts anfassen,
 * der Aufrufer fällt auf `rebaseHwmForCapitalFlow()` zurück.
 *
 * @param {number|string|bigint} liquidityBefore  Positions-Liquidität vor dem Fluss (u128 → String)
 * @param {number|string|bigint} liquidityAfter   Positions-Liquidität nach dem Fluss
 * @returns {{ applied: boolean, factor: number|null }}
 */
export function scaleReferencesForLiquidityChange(db, positionId, liquidityBefore, liquidityAfter) {
    const lb = Number(liquidityBefore), la = Number(liquidityAfter);
    if (!(lb > 0) || !(la > 0)) return { applied: false, factor: null };
    const factor = la / lb;
    if (!(factor >= 0.01 && factor <= 100)) return { applied: false, factor: null };

    db.prepare(`
        UPDATE positions
           SET hwm_usd   = CASE WHEN hwm_usd   > 0 THEN hwm_usd   * ? ELSE hwm_usd   END,
               entry_usd = CASE WHEN entry_usd > 0 THEN entry_usd * ? ELSE entry_usd END,
               hwm_base_adjustment = NULL
         WHERE id = ?
    `).run(factor, factor, positionId);

    return { applied: true, factor };
}

/**
 * Skaliert Höchststand und Einstiegsreferenz einer Position bei einem Wechsel der
 * Bewertungsquelle (z.B. Pool-Preis ↔ Referenzpreis-Fallback bei getQuotePriceUsd()).
 *
 * Gleiche Mathematik wie scaleReferencesForLiquidityChange() (Faktor auf hwm_usd und
 * entry_usd, keine Zeitfenster) — bewusst eine eigene, unabhängige Funktion statt
 * Wiederverwendung: Ein Bug hier darf niemals den bereits durch bin/test-trailing-stop-sim.js
 * abgesicherten Kapitalfluss-Pfad mitreißen, und umgekehrt.
 *
 * 🔒 Der Grund, warum das hier existiert (CORE#0334/CORE#0337, 2026-08-27): Der Pool-Preis
 * kann für kurze Zeit ausfallen (>30 Min alt), dann übernimmt der Referenzpreis (Jupiter) —
 * und wenn der Pool-Preis zurückkommt, weicht er vom zuletzt genutzten Referenzpreis meist
 * um ein, zwei Prozent ab. Ohne diese Funktion wandert diese Differenz ungebremst in
 * `lp_value_usd`, `updateHwm()` zieht den Höchststand mit, und `armSecondStageIfReached()`
 * kann eine ohnehin schon enge Stufe 2 scharf schalten — für eine Bewegung, die nie
 * stattgefunden hat. Am 2026-08-27 geschah das durch den vollständigen Pyth-Ausfall
 * ungebremst (Master +5,2 %, pub1 +4,5 % durch einen einzigen Nexus-Neustart).
 *
 * @param {number} priceBefore  Preis der bisher aktiven Quelle, gemessen zum Wechselzeitpunkt
 * @param {number} priceAfter   Preis der neu aktiven Quelle, zum selben Zeitpunkt
 * @returns {{ applied: boolean, factor: number|null }}
 */
export function scaleReferencesForQuotePriceChange(db, positionId, priceBefore, priceAfter) {
    const pb = Number(priceBefore), pa = Number(priceAfter);
    if (!(pb > 0) || !(pa > 0)) return { applied: false, factor: null };
    const factor = pa / pb;
    // Bewusst enger als bei Kapitalflüssen (0,01–100): Zwei Preisquellen für dasselbe Asset
    // dürfen plausibel nur wenig auseinanderliegen. Eine Abweichung außerhalb dieser Bandbreite
    // ist kein normaler Quellenwechsel mehr, sondern ein Datenfehler — dann lieber gar nicht
    // skalieren (Referenz bleibt stehen) als eine grob falsche Zahl in HWM/Einstieg schreiben.
    if (!(factor >= 0.5 && factor <= 2)) return { applied: false, factor: null };

    db.prepare(`
        UPDATE positions
           SET hwm_usd   = CASE WHEN hwm_usd   > 0 THEN hwm_usd   * ? ELSE hwm_usd   END,
               entry_usd = CASE WHEN entry_usd > 0 THEN entry_usd * ? ELSE entry_usd END,
               hwm_base_adjustment = NULL
         WHERE id = ?
    `).run(factor, factor, positionId);

    return { applied: true, factor };
}

export function createTsExecution(db, { poolId, hwmUsd, currentUsd, drawdownPct, configSnapshot, triggerSource = 'tick' }) {
    const result = db.prepare(`
        INSERT INTO ts_executions (pool_id, triggered_at, hwm_usd, current_usd, drawdown_pct, config_snapshot, trigger_source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(poolId, Date.now(), hwmUsd ?? null, currentUsd ?? null, drawdownPct ?? null, JSON.stringify(configSnapshot), triggerSource);
    return result.lastInsertRowid;
}

/** Eine Schnellprüfung des Trailing Stops protokollieren (siehe Tabelle ts_fast_checks). */
export function insertTsFastCheck(db, row) {
    db.prepare(`
        INSERT INTO ts_fast_checks
            (pool_id, position_id, checked_at, price, lp_value_usd, hwm_usd, drawdown_pct, threshold_pct, stage, triggered, confirmed)
        VALUES
            (@poolId, @positionId, @checkedAt, @price, @lpValueUsd, @hwmUsd, @drawdownPct, @thresholdPct, @stage, @triggered, @confirmed)
    `).run({ positionId: null, price: null, lpValueUsd: null, hwmUsd: null, drawdownPct: null,
             thresholdPct: null, stage: null, triggered: 0, confirmed: null, ...row, checkedAt: Date.now() });
}

export function pruneTsFastChecks(db, days = 14) {
    const cutoff = Date.now() - days * 86_400_000;
    return db.prepare(`DELETE FROM ts_fast_checks WHERE checked_at < ?`).run(cutoff).changes;
}

export function updateTsExecution(db, id, fields) {
    const allowed = ['step', 'ts_coins_a', 'ts_coins_b', 'swapped_usdc', 'decrease_tx_hash',
                     'completed_at', 'error_msg', 'close_error'];
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

/** Zeitpunkt der letzten Trailing-Stop-Auslösung für einen Pool (für Cleanup-Cooldown). */
export function getLastTsExecutionAt(db, poolId) {
    const row = db.prepare(
        `SELECT MAX(triggered_at) AS last FROM ts_executions WHERE pool_id = ?`
    ).get(poolId);
    return row?.last ?? 0;
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
    const allowed = ['step', 'coins_a', 'coins_b', 'swapped_usdc', 'completed_at',
                     'error_msg', 'close_error'];
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

/**
 * Zeitpunkt der letzten TVL-Schutz-Auslösung einer BESTIMMTEN Stufe für einen Pool.
 * Basis für den Melde-Cooldown der Stufe-1-Warnung (siehe tvl-protection.js): der
 * poolweite getLastTvlExecutionAt() reicht dafür nicht, weil eine zwischenzeitliche
 * L2-Auslösung sonst die L1-Warnsperre zurücksetzen würde.
 */
export function getLastTvlLevelExecutionAt(db, poolId, level) {
    const row = db.prepare(
        `SELECT MAX(triggered_at) AS last FROM tvl_executions WHERE pool_id = ? AND level = ?`
    ).get(poolId, level);
    return row?.last ?? 0;
}

// ─── KV Config ────────────────────────────────────────────────────────────────

export function kvGet(db, key, fallback = null) {
    const row = db.prepare('SELECT value FROM kv_config WHERE key = ?').get(key);
    return row ? row.value : fallback;
}

export function kvSet(db, key, value) {
    return db
        .prepare('INSERT OR REPLACE INTO kv_config (key, value) VALUES (?, ?)')
        .run(key, String(value));
}
