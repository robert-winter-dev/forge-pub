#!/usr/bin/env node
/**
 * FORGE LendingBot – Dashboard Data Exporter
 *
 * Liest alle relevanten Daten aus SQLite und schreibt sie als JSON
 * für das Web-Dashboard (html/data/data.json).
 *
 * Wird regelmäßig vom Bot aufgerufen (z.B. jede Minute via setInterval).
 * Kann auch manuell ausgeführt werden: node bin/export.js
 *
 * Ausgabe: html/data/data.json
 */

import Database from 'better-sqlite3';
import { notificationText } from '../../../lib/notify-render.js';
import { getBotConfig }     from '../../../lib/bot-registry.js';

const { displayName: BOT_DISPLAY_NAME } = getBotConfig('lending');
import { dirname, resolve } from 'path';
import { writeFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import {
    getActivePositions,
    getPendingWithdrawals,
    getProtocolStatsHistory,
    getLatestProtocolStats,
    getWalletSnapshot,
    getPortfolioHistory,
    getRecentPortfolioHistory,
    getRecentTransactions,
    getNotifications,
    kvGet,
    getDailySnapshot,
    getDb,
} from '../lib/db.js';
import { config } from '../lib/config.js';
import { FORGE_TZ } from '../../../core/config.js';
import { displayVersion } from '../../../lib/version.js';
// PnL/Yield: ausschließlich über die zentrale FORGE-Lib. Dieser Bot übergibt nur
// noch den Zeitraum — Wert-Anker, Cashflow- und Ertragsbereinigung liegen
// vollständig in FORGE/lib/pnl.js. Hier bleibt reine Präsentation
// (pct-Nenner, pnl = yield − tx_fees).
import { pnlForPeriod } from '../../../lib/pnl.js';
import { PATHS } from '../../../config/paths.js';
import { writeFrontendBundle } from '../../../lib/i18n.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const WALLET_MONITOR_DB = PATHS.walletMonitorDb;

// ─── SOL-Preis ────────────────────────────────────────────────────────────────

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PROXY_QUOTE = 'http://127.0.0.1:3100/jup/swap/v1/quote';

async function fetchSolPrice() {
    const url = `${PROXY_QUOTE}?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=1000000000&slippageBps=0`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.outAmount) throw new Error('kein outAmount');
    return parseFloat(data.outAmount) / 1_000_000; // USDC hat 6 Dezimalstellen
}

// ─── TX-Gebühren-Fallback (in SOL) pro Protokoll ─────────────────────────────
// Ermittelt aus beobachteten on-chain Gebühren; konservativ nach oben gerundet.

const FEE_FALLBACK_SOL = {
    'kamino':            0.000005,
    'kamino-figure':     0.000005,
    'kamino-onre':       0.000005,
    'kamino-huma':       0.000005,
    // 'drift':             0.000005,  // DEAKTIVIERT 2026-04-02
    'jupiter':           0.000005,
    'loopscale-onre':    0.000105,
    'loopscale-genesis': 0.000105,
};

function txFeeFallback(protocol) {
    return FEE_FALLBACK_SOL[protocol] ?? 0.000005;
}

// ─── Helper ───────────────────────────────────────────────────────────────
/**
 * 🔒 Kanonische Labels – wird live an data.json.positions[].protocolLabel und die
 * Pool-Metriken-Tabelle weitergegeben. Bei Änderungen IMMER auch synchron halten mit:
 *   - html/lending/js/app.js       (protocolLabel()-Map + ALL_KNOWN_PROTOCOLS)
 *   - bots/settings/routes/lending-actions.js  (PROTOCOL_LABELS)
 * Abweichende Labels lassen denselben Pool im Dashboard/Settings wie zwei
 * verschiedene Pools aussehen (Befund 2026-08-09, siehe Changelog).
 */
function labelFor(protocol) {
    const labels = {
        'kamino':            'Kamino',
        'kamino-figure':     'Kamino Figure',
        'kamino-onre':       'Kamino OnRe',
        'kamino-huma':       'Kamino Huma',
        // 'drift':             'Drift',  // DEAKTIVIERT 2026-04-02
        'jupiter':           'Jupiter Lend',
        'loopscale-onre':    'Loopscale Public',
        'loopscale-genesis': 'Loopscale Gen',
        'save':              'Save',
        'marginfi':          'MarginFi',
        'marinade':          'Marinade',
        'solend':            'Solend',
    };
    return labels[protocol] || protocol;
}
const VERSION        = displayVersion();
const DATA_DIR       = resolve(__dirname, '../../../html/lending/data');
const DATA_FILE      = resolve(DATA_DIR, 'data.json');
const HISTORY_FILE   = resolve(DATA_DIR, 'data-history.json');
const HISTORY_MAX_AGE_MS = 5 * 60 * 1000;

mkdirSync(DATA_DIR, { recursive: true });

// ─── Export ausführen ─────────────────────────────────────────────────────────

export async function runExport() {
    const now = Date.now();

    // ── SOL-Preis abrufen (für Gebührenumrechnung) ────────────────────────────
    let solPrice = null;
    try {
        solPrice = await fetchSolPrice();
    } catch (err) {
        console.warn('[export] SOL-Preis nicht abrufbar:', err.message);
    }

    // ── Wallet-Snapshot (Metriken) ────────────────────────────────────────────
    const snap = getWalletSnapshot() ?? {
        current_value: 0, total_yield: 0,
        avg_apy: 0, wallet_usdc: 0, wallet_sol: 0,
    };

    // Maximum über letzte 12 Portfolio-Snapshots (~1 Std):
    // Kamino-API gibt zwischen Batch-Updates systematisch leicht zu niedrige Werte zurück
    // (Exchange-Rate-Berechnung läuft in Batches). Das Rauschen ist einseitig – der echte
    // Wert liegt immer am oberen Ende der letzten Messungen. Max ist daher besser als Ø.
    // Yield wächst monoton → höchster Messwert im Fenster = beste Annäherung an Realwert.
    // portfolio_history enthält Wallet-USDC + Pool; wallet_usdc abziehen → Pool only.
    const recentSnaps    = getRecentPortfolioHistory(12);
    const walletUsdc     = snap.wallet_usdc ?? 0;
    let smoothedValue  = recentSnaps.length > 0
        ? Math.max(...recentSnaps.map(r => r.total_value)) - walletUsdc
        : snap.current_value;

    // ── Transaktionen (früh laden – werden von Positionen für Break-Even benötigt) ──
    const rawTx = getRecentTransactions(500);
    const transactions = rawTx.map(tx => {
        const feeSolActual  = tx.fee_sol;
        const feeSolUsed    = feeSolActual ?? txFeeFallback(tx.protocol);
        const feeUsdc       = solPrice != null ? parseFloat((feeSolUsed * solPrice).toFixed(6)) : null;
        return {
            id:           tx.id,
            type:         tx.type,
            protocol:     tx.protocol,
            poolType:     tx.pool_type,
            asset:        tx.asset,
            amount:       tx.amount,
            txHash:       tx.tx_hash,
            feeSol:       feeSolActual != null ? parseFloat(feeSolActual.toFixed(9)) : null,
            feeSolUsed:   parseFloat(feeSolUsed.toFixed(9)),  // tatsächlich verwendeter Wert (inkl. Fallback)
            feeUsdc,
            note:         tx.note,
            createdAt:    tx.created_at,
        };
    });

    // ── Aktive Positionen ─────────────────────────────────────────────────────
    const rawPositions  = getActivePositions();

    // Duplikat-Schutz: Falls mehrere offene DB-Einträge für dasselbe Protokoll existieren
    // (kann bei Rebalancing-Deposits passieren), diese zu einem einzigen Eintrag mergen:
    // – amount:      Maximum (= on-chain Wert, nach Bot-Tick identisch für alle)
    // – current_apy: Erster nicht-null Wert
    // – started_at:  Ältester Wert (erster Deposit-Zeitpunkt)
    // – entry_value: Maximum – konsistent zu amount (dieselbe on-chain-Position, also
    //                dieselbe Kostenbasis) und im Zweifel die konservativere Anzeige.
    const mergedMap = new Map();
    for (const p of rawPositions) {
        if (!mergedMap.has(p.protocol)) {
            mergedMap.set(p.protocol, { ...p });
        } else {
            const m = mergedMap.get(p.protocol);
            if (p.amount > m.amount) m.amount = p.amount;
            if (m.current_apy == null && p.current_apy != null) m.current_apy = p.current_apy;
            if (p.started_at < m.started_at) m.started_at = p.started_at;
            if (p.last_updated_at > m.last_updated_at) m.last_updated_at = p.last_updated_at;
            if (p.entry_value != null && (m.entry_value == null || p.entry_value > m.entry_value)) {
                m.entry_value = p.entry_value;
            }
        }
    }
    const mergedPositions = [...mergedMap.values()];

    const latestStats   = getLatestProtocolStats();
    // Schnell-Lookup: protocol → { tvl, apy }
    const tvlByProtocol = new Map(latestStats.map(s => [s.protocol, s.tvl ?? null]));
    // Fallback-APY aus protocolStats (für frisch angelegte Positionen ohne current_apy in DB)
    const latestApyMap  = new Map(latestStats.map(s => [s.protocol, s.apy ?? null]));

    // Gewichteter Ø-APY über alle aktiven Positionen
    // Fallback auf letzten bekannten protocolStats-APY wenn current_apy noch null (z.B. nach Rebalancing)
    const positionsWithApy = mergedPositions
        .map(p => ({ ...p, current_apy: p.current_apy ?? latestApyMap.get(p.protocol) ?? null }))
        .filter(p => p.current_apy != null && p.amount > 0);
    const totalInvested    = positionsWithApy.reduce((s, p) => s + p.amount, 0);
    const weightedAvgApy   = totalInvested > 0
        ? positionsWithApy.reduce((s, p) => s + p.current_apy * p.amount, 0) / totalInvested
        : 0;
    // Alle bekannten Protocol-Stats als Map für das Dashboard (inkl. inaktive Protokolle)
    const protocolStats = Object.fromEntries(
        latestStats.map(s => [s.protocol, { apy: s.apy ?? null, tvl: s.tvl ?? null }])
    );

    const ONE_HOUR_MS = 60 * 60 * 1000;
    const YEAR_MS     = 365 * 24 * 60 * 60 * 1000;

    const positions = mergedPositions.map(p => {
        const elapsedMs = now - p.started_at;

        // Alle TXs dieser Position (seit started_at) – für Break-Even und netInvested.
        const posTxs = transactions.filter(
            tx => tx.protocol === p.protocol && tx.createdAt >= p.started_at
        );

        // Netto-investiertes Kapital: Σ(deposits) − Σ(withdrawals) seit Position geöffnet.
        // Selbst-heilend bei beliebigen Ein-/Auszahlungen – keine separate Baseline nötig.
        const netInvested = posTxs.reduce((s, tx) => {
            if (tx.type === 'deposit')  return s + tx.amount;
            if (tx.type === 'withdraw') return s - tx.amount;
            return s;
        }, 0);

        // Yield: aktueller Pool-Stand minus Kostenbasis.
        //
        // Kostenbasis ist der Einstiegs-Anker `entry_value` — der nach einem Cashflow
        // tatsächlich GEMESSENE Positionswert (siehe Migration in lib/db.js und die
        // Fortschreibung in bin/bot.js). Grund: Protokolle bewerten frisch eingezahltes
        // Kapital sofort über pari (Loopscale +0,103 % binnen Minuten, ohne Zeitablauf).
        // Die frühere netInvested-Methode (amount − Σ Einzahlungen) zählte diesen
        // Aufschlag als Gewinn und wies den Lifetime-Yield dadurch deutlich zu hoch aus
        // (forge-pub1 am 09.08.: 0,0607 statt 0,0366 USDC, +66 %).
        //
        // Fallback auf netInvested, solange kein Anker existiert (Position älter als die
        // Migration und ohne Tages-Snapshot für den Backfill) — dann gilt das alte,
        // leicht zu hohe Verhalten, statt einen Anker zu raten.
        const costBasis = p.entry_value ?? netInvested;

        // LB#0161 – Phantom-Schutz: Ein `withdraw`-Eintrag, dessen On-Chain-Reduktion in
        // p.amount noch nicht reflektiert ist (Cooldown-Abschluss/Settlement-Lag), würde
        // p.amount − costBasis sprunghaft um den Entnahmebetrag erhöhen. Realistischer
        // Lifetime-Yield ist durch APY × Laufzeit begrenzt; Faktor 4 deckt APY-Spitzen
        // großzügig ab, deckelt aber Entnahme-Artefakte (≫ plausibler Yield).
        const apyForCap         = p.current_apy ?? latestApyMap.get(p.protocol) ?? 15;
        const maxPlausibleYield = costBasis > 0
            ? costBasis * (apyForCap / 100) * (elapsedMs / YEAR_MS) * 4
            : Infinity;
        const accruedYield = elapsedMs >= ONE_HOUR_MS && costBasis > 0
            ? Math.min(Math.max(0, parseFloat((p.amount - costBasis).toFixed(6))), maxPlausibleYield)
            : 0;

        // ── Break-Even: Yield deckt alle TX-Gebühren seit Positionseröffnung + nächste Auszahlung ──
        const txFeeUsdc   = solPrice != null
            ? parseFloat(posTxs.reduce((s, tx) => s + (tx.feeUsdc ?? 0), 0).toFixed(6))
            : null;
        const exitFeeUsdc = solPrice != null
            ? parseFloat((txFeeFallback(p.protocol) * solPrice).toFixed(6))
            : null;
        const breakEven   = txFeeUsdc != null && exitFeeUsdc != null && accruedYield > 0
            ? accruedYield >= txFeeUsdc + exitFeeUsdc
            : null;

        return {
            id:            p.id,
            protocol:      p.protocol,
            protocolLabel: labelFor(p.protocol),
            poolType:      p.pool_type,
            asset:         p.asset,
            amount:        p.amount,
            netInvested,
            currentApy:    p.current_apy ?? protocolStats[p.protocol]?.apy ?? null,
            startedAt:     p.started_at,
            lastUpdatedAt: p.last_updated_at,
            accruedYield,
            poolTvl:       tvlByProtocol.get(p.protocol) ?? null,
            txFeeUsdc,
            exitFeeUsdc,
            breakEven,
        };
    });

    const totalYield = positions.reduce((s, p) => s + p.accruedYield, 0);

    // Stale-Snapshot-Schutz nach Abhebungen:
    // smoothedValue (Max über 12 Ticks) kann nach einer Abhebung für ~2 Stunden den alten,
    // zu hohen Wert zeigen. positions.amount ist immer aktuell (letzter Bot-Tick).
    // Cap: smoothedValue darf positions-Summe um max. SMOOTHING_CAP überschreiten.
    // SMOOTHING_CAP (2.0 USDC) bietet ausreichend Puffer für Kamino-Exchange-Rate-Rauschen
    // (~0,10–0,15 USDC pro Position), ohne dass Abhebungs-Artefakte durchkommen.
    const positionsSum  = positions.reduce((s, p) => s + p.amount, 0);
    const SMOOTHING_CAP = 2.0;
    if (smoothedValue > positionsSum + SMOOTHING_CAP) {
        // Obergrenze: verhindert Post-Withdrawal-Spike (smoothedValue zu hoch)
        smoothedValue = positionsSum;
    }
    if (smoothedValue < positionsSum) {
        // Untergrenze: nach addToPosition steigt positionsSum sofort,
        // portfolio_history (Basis für smoothedValue) erst beim nächsten Snapshot.
        smoothedValue = positionsSum;
    }

    // ── Wallet-Monitor-Snapshot: EINMAL lesen, überall verwenden (single source) ──
    // LB#0165: Verhindert, dass GESAMT/capitalBase (wmWalletUsdc) und die Dashboard-Anzeige
    // (output.walletMonitor) aus zwei getrennten DB-Reads stammen. Ein wallet-monitor-Cron-
    // Write (alle 10 Min) zwischen den Reads würde sie sonst auf verschiedene Snapshots setzen.
    const wmData = (() => {
        try {
            const wmDb = new Database(WALLET_MONITOR_DB, { readonly: true });
            const snap = wmDb.prepare(`
                SELECT id, wallet_id, wallet_label, recorded_at,
                       sol_balance, usdc_balance, total_usd
                FROM   snapshots
                WHERE  wallet_id = 'lending'
                ORDER  BY recorded_at DESC
                LIMIT  1
            `).get();
            if (!snap) { wmDb.close(); return null; }
            const tokens = wmDb.prepare(`
                SELECT symbol, balance, price_usd, value_usd
                FROM   token_balances
                WHERE  snapshot_id = ?
                ORDER  BY value_usd DESC
            `).all(snap.id);
            wmDb.close();
            return { snap, tokens };
        } catch (err) {
            console.warn('[export] wallet-monitor nicht erreichbar – Fallback auf wallet_snapshot:', err.message);
            return null;
        }
    })();

    // Kanonische Wallet-USDC-Quelle (GESAMT-Basis + portfolio.walletUsdc): wallet-monitor
    // bevorzugt, Fallback auf internen wallet_snapshot wenn nicht verfügbar.
    let wmWalletUsdc;
    if (wmData?.snap?.usdc_balance != null) {
        wmWalletUsdc = wmData.snap.usdc_balance;
    } else {
        if (wmData) console.warn('[export] wallet-monitor: kein usdc_balance im Snapshot – Fallback auf wallet_snapshot');
        wmWalletUsdc = walletUsdc;
    }

    // ── Pending Withdrawals ───────────────────────────────────────────────────
    const rawPending = getPendingWithdrawals();
    const pendingWithdrawals = rawPending.map(pw => {
        const readyAt = pw.initiated_at + pw.cooldown_seconds * 1000;
        return {
            id:                  pw.id,
            protocol:            pw.protocol,
            poolType:            pw.pool_type,
            asset:               pw.asset,
            amount:              pw.amount,
            pendingWithdrawalId: pw.pending_withdrawal_id,
            initiatedAt:         pw.initiated_at,
            cooldownSeconds:     pw.cooldown_seconds,
            readyAt,
            isReady:             now >= readyAt,
        };
    });

    // ── APY-Verlauf (letzten 30 Tage) → für Dashboard-Chart ──────────────────
    const rawStats = getProtocolStatsHistory(30);

    // Aggregiere zu Zeitreihe: { ts, kamino?, drift?, 'loopscale-onre'?, ... }
    // Downsampling: 1 Punkt pro Stunde – jeder Protokoll-Schlüssel wird dynamisch gesetzt
    const statsByHour = new Map();
    const tvlByHour   = new Map();
    for (const row of rawStats) {
        const bucket = Math.floor(row.recorded_at / 3_600_000);
        const key = row.protocol;

        if (!statsByHour.has(bucket)) statsByHour.set(bucket, { ts: row.recorded_at });
        statsByHour.get(bucket)[key] = row.apy;

        if (row.tvl != null) {
            if (!tvlByHour.has(bucket)) tvlByHour.set(bucket, { ts: row.recorded_at });
            tvlByHour.get(bucket)[key] = row.tvl;
        }
    }
    // Alle Einträge direkt ausgeben – Dashboard liest nur die Keys die es kennt
    const apyHistory = [...statsByHour.values()]
        .sort((a, b) => a.ts - b.ts);
    const tvlHistory = [...tvlByHour.values()]
        .sort((a, b) => a.ts - b.ts);

    // ── Portfolio-Verlauf → für Guthaben-Chart ────────────────────────────────
    const rawPortfolio = getPortfolioHistory(30);
    // Downsampling: 1 Punkt pro Stunde – Median über alle Messungen der Stunde.
    // Kamino-API-Spikes (temporär falsch hohe Summen durch DB-Duplikate) liegen
    // immer am oberen Ende: Der Median filtert sie zuverlässig heraus, ohne den
    // echten Wert zu verzerren (echte Wachstumstrends sind monoton und klein).
    //
    // Aktueller Bucket: smoothedCurrentTotal statt latest.total_value.
    // Einzelne API-Ausreißer (z.B. Kamino Exchange-Rate kurz nach Batch-Update)
    // können um 0.1–0.35 USDC zu niedrig sein und für ~5 Min einen sichtbaren
    // Chart-Dip sowie schwankende Yield-Kacheln erzeugen.
    // positionsSum + wmWalletUsdc: beide Terme aus konsistenten, aktuellen Quellen –
    // Deposits/Withdrawals (>> 1 USDC) bleiben sofort sichtbar.
    const smoothedCurrentTotal = positionsSum + wmWalletUsdc;

    const currentBucket = Math.floor(Date.now() / 3_600_000);
    const hourBuckets = new Map();
    for (const row of rawPortfolio) {
        const bucket = Math.floor(row.recorded_at / 3_600_000);
        if (!hourBuckets.has(bucket)) hourBuckets.set(bucket, []);
        hourBuckets.get(bucket).push(row);
    }
    const rawPortfolioHistory = [...hourBuckets.entries()]
        .sort(([a], [b]) => a - b)
        .map(([bucket, rows]) => {
            if (bucket === currentBucket) {
                // Aktueller Bucket: geglätteten Wert verwenden (verhindert Einzelausreißer im Chart)
                const latestTs = rows.reduce((a, b) => a.recorded_at > b.recorded_at ? a : b).recorded_at;
                return { ts: latestTs, v: smoothedCurrentTotal };
            }
            // Historische Buckets: Median (filtert Spikes)
            rows.sort((a, b) => a.total_value - b.total_value);
            const mid = rows[Math.floor(rows.length / 2)];
            return { ts: mid.recorded_at, v: mid.total_value };
        });

    // Rausch-Clamping über historische Buckets: Drops < 0.5 USDC werden als
    // API-Rauschen eingestuft und auf den Vorwert gehalten. Echte Ereignisse
    // (Withdrawals, Rebalancings) bewegen > 1 USDC und bleiben sichtbar.
    const NOISE_CLAMP_USDC = 0.5;
    let prevHistV = null;
    const portfolioHistory = rawPortfolioHistory.map(point => {
        if (prevHistV !== null && prevHistV > point.v && prevHistV - point.v < NOISE_CLAMP_USDC) {
            point = { ts: point.ts, v: prevHistV };
        }
        prevHistV = point.v;
        return point;
    });

    // Forward-Fill für Chart: 0-Werte entstehen wenn der Bot temporär keine
    // Positionsdaten abfragen kann (API-Fehler, falsche Protokoll-Konfiguration).
    // Für den Verlaufs-Chart werden solche Lücken gefüllt – Priorität:
    //   1. smoothedCurrentTotal (aktuell bekannter Gesamtwert inkl. Wallet)
    //      → korrekt nach echten Withdrawals; verhindert Sprung am rechten Rand
    //   2. letzter bekannter History-Wert (Fallback wenn noch kein korrekter Tick)
    // Betrifft nur den Chart — die Yield-Zahlen kommen seit 2026-08-12 aus
    // lib/pnl.js und nicht mehr aus dieser Reihe.
    let lastHistV = null;
    const portfolioHistoryChart = portfolioHistory.map(point => {
        if (point.v > 0) { lastHistV = point.v; return point; }
        const fillV = smoothedCurrentTotal > 0 ? smoothedCurrentTotal : lastHistV;
        return fillV != null ? { ts: point.ts, v: fillV } : point;
    });

    // ── Transaktionen (bereits oben befüllt, nur DESC-Reihenfolge für Dashboard) ──
    // transactions wurde oben (vor Positions) bereits aus der DB geladen und mit
    // feeUsdc angereichert. Für das Dashboard nach createdAt absteigend sortieren.
    const transactionsSorted = [...transactions].sort((a, b) => b.createdAt - a.createdAt);

    // ── Tages-/Perioden-Statistiken ───────────────────────────────────────────
    // Tagesgrenzen = Mitternacht Europe/Berlin (nicht UTC)
    const berlinMidnightMs = (isoDate) => {
        const midnightUtc = new Date(isoDate + 'T00:00:00Z').getTime();
        let berlinHour = parseInt(
            new Intl.DateTimeFormat('en-GB', {
                timeZone: FORGE_TZ, hour: '2-digit', hour12: false,
            }).format(new Date(midnightUtc)), 10
        );
        if (berlinHour === 24) berlinHour = 0;
        return midnightUtc - berlinHour * 3_600_000;
    };
    const todayBerlin     = new Intl.DateTimeFormat('en-CA', { timeZone: FORGE_TZ }).format(new Date());
    const startOfTodayMs  = berlinMidnightMs(todayBerlin);
    const startOfYesterdayMs = startOfTodayMs - 86_400_000;
    const startOfMonthMs  = (() => {
        const [y, m] = todayBerlin.split('-');
        return berlinMidnightMs(`${y}-${m}-01`);
    })();

    // DB-Handle für die zentrale PnL-Berechnung (FORGE/lib/pnl.js).
    const _pnlDb = getDb();

    // periodYield(fromMs, toMs): PnL eines Zeitraums, direkt aus der zentralen Lib.
    // toMs = null bedeutet "bis jetzt".
    //
    // Vereinheitlichung 2026-08-12: Vorher gab es hier drei Rechenwege
    // (calcYield über die Wertreihe, calcTodayFromSnapshot und
    // calcYieldFromSnapshots über Tagesanker), jeweils mit Floor `Math.max(0, …)`
    // und 15-%-APY-Cap. Dadurch wich das Dashboard von der Übersichtsseite ab
    // (August 2026: +4,63 gegen −65,56 USDC) und Verluste wurden unsichtbar —
    // der reale −70,20-USDC-Tag am 09.08. erschien als 0. Jetzt speist EINE
    // Quelle alle Periodenzahlen; die Summe der Tageswerte ergibt exakt den
    // Zeitraumwert (earningsOut rechnet seit demselben Tag additiv).
    //
    // Die Klemmen entfallen bewusst: Rauschunterdrückung leistet die Lib über
    // Transient-Filter und Teardown-Schutz, und ein echter Verlust muss sichtbar
    // sein statt auf 0 gezogen zu werden.
    const periodYield = (fromMs, toMs) => {
        const usdc = pnlForPeriod(_pnlDb, { flavor: 'lendingbot', fromMs, toMs });
        if (usdc == null) return null;
        const pct = smoothedCurrentTotal > 0
            ? parseFloat((usdc / smoothedCurrentTotal * 100).toFixed(4))
            : null;
        return { usdc: parseFloat(usdc.toFixed(6)), pct };
    };

    // Tagesanfangs-Snapshot — dient nur noch als Chart-Baseline (todayBaselineUsdc).
    // Die Yield-Zahlen kommen seit der Vereinheitlichung 2026-08-12 alle aus
    // periodYield() → lib/pnl.js.
    const dailySnap = getDailySnapshot(todayBerlin); // [{ protocol, amount_usdc }, ...]

    const todayYield = periodYield(startOfTodayMs, null);

    // ── Tägliche Yield-Historie (letzte 30 Tage, für Profit-Chart) ───────────────
    const dailyProfits = [];
    for (let i = 29; i >= 0; i--) {
        const dayStartMs  = startOfTodayMs - i * 86_400_000;
        const dayEndMs    = dayStartMs + 86_400_000;
        const dayStr      = new Intl.DateTimeFormat('en-CA', { timeZone: FORGE_TZ })
            .format(new Date(dayStartMs + 43_200_000)); // Noon, um DST-Grenzfälle zu vermeiden
        // Jeder Tag ist eine eigene Zeitraum-Abfrage derselben Quelle. Da
        // earningsOut seit 2026-08-12 additiv rechnet, ergibt die Summe dieser
        // Tageswerte exakt den Monatswert weiter unten.
        const y = i === 0 ? todayYield : periodYield(dayStartMs, dayEndMs);
        if (y) dailyProfits.push({ date: dayStr, usdc: y.usdc });
    }

    // Monatlicher Yield: eine Zeitraum-Abfrage — NICHT die Summe der Tageswerte.
    // Beide Wege liefern dasselbe Ergebnis (Additivität, siehe oben); die direkte
    // Abfrage ist die kürzere Kette und bleibt auch dann richtig, wenn der
    // 30-Tage-Puffer von dailyProfits den Monatsanfang nicht mehr abdeckt.
    const monthYield = periodYield(startOfMonthMs, null);

    // Summe der daily_position_snapshots für heute – dient als saubere Baseline
    // für den 1D-Yield-Chart (statt portfolio_history-Wert vor dem 24h-Fenster).
    const todayBaselineUsdc = dailySnap.length > 0
        ? parseFloat(dailySnap.reduce((s, p) => s + p.amount_usdc, 0).toFixed(6))
        : null;

    const yesterdayYield = periodYield(startOfYesterdayMs, startOfTodayMs);

    // ✅  PnL-ZENTRALISIERUNG — FORGE/lib/pnl.js (Single Source of Truth) ──────────
    // Globale FORGE-Regel: PnL/Yield läuft ausschließlich über FORGE/lib/pnl.js.
    // Seit der Vereinheitlichung 2026-08-12 holt periodYield() JEDE Periodenzahl
    // (heute, gestern, Monat, jeder Tag der 30-Tage-Reihe) über pnlForPeriod aus
    // derselben Quelle — identisch zur Übersichtsseite (analysis/02-export-status.js).
    // Hier verbleibt nur Präsentation: pct-Nenner und pnl = yield − tx_fees.
    //
    // 🔁 Fee-/Zins-Transfers aufs Wallet: Sobald reaktiviert, NUR die earningsOut-
    //    Abfrage im lendingbot-Adapter von FORGE/lib/pnl.js ergänzen (Transfer mit
    //    eigener, von 'withdraw' unterscheidbarer Markierung buchen). pnlForPeriod
    //    zieht den Ertrag dann automatisch ein — KEINE Änderung an diesem Bot nötig.
    //
    // ── LB#0158: abgeleitete Anzeige-Werte EINMAL berechnen (single source) ───────
    // Fees, APR, PnL je Periode + rolling-24h werden hier aus dem konsistenten Datensnapshot
    // berechnet – nicht mehr im Dashboard (app.js) aus Einzelfeldern. Damit kann derselbe
    // Wert nicht doppelt/zeitversetzt entstehen (vermeidet widersprüchliche Anzeigen).
    // Kapital-Nenner = smoothedCurrentTotal (Pool + Wallet), konsistent mit statistics.*.pct (LB#0162).
    const capitalBase = smoothedCurrentTotal;
    const yToday     = todayYield?.usdc     ?? 0;
    const yYesterday = yesterdayYield?.usdc ?? 0;
    const yMonth     = monthYield?.usdc     ?? 0;

    const feesInPeriod = (fromMs, toMs) =>
        parseFloat(transactions
            .filter(t => t.createdAt >= fromMs && (toMs == null || t.createdAt < toMs))
            .reduce((s, t) => s + (t.feeUsdc ?? 0), 0)
            .toFixed(6));
    const aprFor = (yieldUsdc, days) =>
        capitalBase > 0 && days > 0
            ? parseFloat((yieldUsdc / capitalBase * (365 / days) * 100).toFixed(4))
            : null;

    const dayOfMonth    = Math.max(1, parseInt(todayBerlin.split('-')[2], 10));
    const feesToday     = feesInPeriod(startOfTodayMs, null);
    const feesYesterday = feesInPeriod(startOfYesterdayMs, startOfTodayMs);
    const feesMonth     = feesInPeriod(startOfMonthMs, null);

    // rolling 24h = voller Ertrag seit Mitternacht + der Teil von gestern, der noch im
    // 24h-Fenster liegt (Berlin-Tagesfraktion zum Export-Zeitpunkt).
    //
    // 🔴 Fix 2026-08-09: Vorher stand hier `yToday * fracDay + yYesterday * (1 - fracDay)`.
    //    `yToday` ist aber bereits der Teilbetrag von Mitternacht bis jetzt — also exakt
    //    der Anteil des 24h-Fensters, der auf heute entfällt. Die zusätzliche Multiplikation
    //    mit fracDay hat ihn ein zweites Mal gekürzt und den 24h-APR systematisch zu niedrig
    //    ausgewiesen (Messung 09.08., 13:26 Uhr: 4,55 % statt 5,75 %).
    const berlinHM = new Intl.DateTimeFormat('en-GB', {
        timeZone: FORGE_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const bh = parseInt(berlinHM.find(p => p.type === 'hour').value, 10) % 24;
    const bm = parseInt(berlinHM.find(p => p.type === 'minute').value, 10);
    const fracDay  = (bh * 60 + bm) / 1440;
    const yield24h = parseFloat((yToday + yYesterday * (1 - fracDay)).toFixed(6));

    const statistics = {
        today:     todayYield,
        yesterday: yesterdayYield,
        month:     monthYield,
        todayBaselineUsdc,
        dailyProfits,
        // Vorberechnete Anzeige-Werte (single source – app.js zeigt nur an):
        fees: { today: feesToday, yesterday: feesYesterday, month: feesMonth },
        apr: {
            today:     aprFor(yToday, 1),
            yesterday: aprFor(yYesterday, 1),
            month:     aprFor(yMonth, dayOfMonth),
        },
        pnl: {
            today:     parseFloat((yToday     - feesToday).toFixed(6)),
            yesterday: parseFloat((yYesterday - feesYesterday).toFixed(6)),
            month:     parseFloat((yMonth     - feesMonth).toFixed(6)),
        },
        rolling24h: {
            yield: yield24h,
            apr:   capitalBase > 0 ? parseFloat((yield24h / capitalBase * 365 * 100).toFixed(4)) : null,
        },
        capitalBase,
    };

    // ── Notifications ─────────────────────────────────────────────────────────
    const rawNotifs = getNotifications(20);
    const notifications = rawNotifs
        .filter(n => !n.dismissed && n.level !== 'info' && n.ts >= Date.now() - 12 * 3_600_000)
        .map(n => ({
            id:      n.id,
            level:   n.level,
            // Text erst hier erzeugen (Mehrsprachigkeit Schritt 5) – Altzeilen
            // ohne msg_key fallen auf den gespeicherten Text zurück.
            message: notificationText({ ...n, timestamp: n.ts, display_name: BOT_DISPLAY_NAME }),
            ts:      n.ts,
        }));

    // ── Bot-State (aus kv_config) ─────────────────────────────────────────────
    // Wird von bin/bot.js gesetzt – hier nur auslesen
    const botState = kvGet('bot_state', 'offline');

    // Aggregat für's Dashboard: hält IRGENDEIN Protokoll noch Kapital? Frisch
    // nach der Installation (oder nach einem Voll-Exit ohne Wiedereinstieg) sind
    // alle Protokolle leer — die Tabellen zeigen dann nur leere Platzhalter ohne
    // Erklärung. Die vier betroffenen Boxen (APY/Yield/Pool-/Operative Metriken)
    // zeigen in diesem Fall stattdessen einen "Bot inaktiv"-Hinweis (app.js).
    // Bewusst positionsbasiert statt `botState` (Prozess-Flag) — robuster
    // gegen einen abgestürzten/nicht sauber beendeten Bot-Prozess, und
    // dieselbe Signalart wie beim Liquidity Bot (dort gibt es kein botState-
    // Äquivalent, nur die pool-active-Flags).
    const botActive = mergedPositions.some(p => (p.amount ?? 0) > 0);

    // balance = currentValue (Pool-Positionen) + volles Wallet (USDC + SOL in USD).
    // currentValue allein zählt Kapital NICHT, das gerade nicht investiert ist (z.B. nach
    // einem Withdraw, bevor es redeployed wird) — für das FORGE-Overview (Gesamtguthaben-
    // Summe/Chart über beide Bots) führte das zu einem künstlichen Einbruch, obwohl das
    // Geld nachweislich im Wallet lag (walletUsdc). Analog zu `balance` beim Liquidity Bot
    // (bots/liquidity/bin/export.js), das dort ebenfalls Pool + volles Wallet ist.
    const walletSolUsd = solPrice != null ? (snap.wallet_sol ?? 0) * solPrice : 0;
    const balance = Math.round((smoothedValue + wmWalletUsdc + walletSolUsd) * 100) / 100;

    // ── JSON zusammenbauen ────────────────────────────────────────────────────
    // Live-Daten: jede Minute geschrieben (~100–150 KB)
    const output = {
        meta: {
            version:    VERSION,
            botId:      config.botId,
            exportedAt: now,
            botState,
        },
        botActive,
        portfolio: {
            currentValue: smoothedValue,
            balance,
            totalYield,
            avgApy:       weightedAvgApy,
            walletUsdc:   wmWalletUsdc,
            walletSol:    snap.wallet_sol,
            solPrice,
        },
        statistics,
        positions,
        protocolStats,
        pendingWithdrawals,
        transactions: transactionsSorted,
        config: {
            autoCompounding: config.autoCompounding,
            protocols:       config.protocols,
        },
        notifications,

        // Wallet-Monitor: derselbe Snapshot wie wmWalletUsdc (single source, LB#0165) –
        // kein zweiter DB-Read, daher garantiert konsistent mit GESAMT/capitalBase.
        walletMonitor: (() => {
            if (!wmData) return null;
            const { snap, tokens } = wmData;
            const ageMs = Date.now() - snap.recorded_at;
            return {
                snapshot: { ...snap, age_seconds: Math.round(ageMs / 1000), is_stale: ageMs > 20 * 60 * 1000 },
                tokens,
            };
        })(),
    };

    // History-Daten: alle 5 Minuten geschrieben (~380 KB, kompaktes JSON)
    const outputHistory = {
        apyHistory,
        tvlHistory,
        portfolioHistory: portfolioHistoryChart,
    };

    // Live-Datei immer schreiben
    const tmpFile = DATA_FILE + '.tmp';
    writeFileSync(tmpFile, JSON.stringify(output, null, 2), 'utf8');
    renameSync(tmpFile, DATA_FILE);

    // History-Datei nur alle 5 Minuten schreiben
    let historyAgeMs = Infinity;
    try { historyAgeMs = Date.now() - statSync(HISTORY_FILE).mtimeMs; } catch { /* existiert noch nicht */ }
    if (historyAgeMs >= HISTORY_MAX_AGE_MS) {
        const tmpHist = HISTORY_FILE + '.tmp';
        writeFileSync(tmpHist, JSON.stringify(outputHistory), 'utf8');
        renameSync(tmpHist, HISTORY_FILE);
    }

    return output;
}

// ─── CLI-Aufruf ───────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    // Frontend-Sprachbundle (html/i18n/active.js) auffrischen.
    //
    // Hier und nicht nur beim Setzen der Sprache: html/ wird bei jedem Update
    // komplett ersetzt, das generierte Bundle ist danach weg. Ohne diese
    // Selbstheilung liefe eine englische Installation nach jedem Update wieder
    // auf Deutsch. Schreibt nur bei echter Änderung — bin/sync.sh rsync't html/
    // jede Minute. Bewusst VOR dem Export und im CLI-Zweig: ein fehlgeschlagener
    // Export darf die Sprache nicht mit zurückdrehen, und beim Import dieses
    // Moduls (runExport wird auch anderswo genutzt) hat es nichts zu suchen.
    try { writeFrontendBundle(); } catch (err) { console.warn(`export.js: i18n-Bundle nicht aktualisierbar – ${err.message}`); }

    try {
        const result = await runExport();
        const posCount = result.positions.length;
        const pending  = result.pendingWithdrawals.length;
        console.log(`✅ Export: ${posCount} Position(en), ${pending} pending Withdrawal(s) → ${DATA_FILE}`);
    } catch (err) {
        console.error('❌ Export fehlgeschlagen:', err.message);
        process.exit(1);
    }
}
