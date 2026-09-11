#!/usr/bin/env node
/**
 * FORGE Liquidity – Dashboard Data Exporter
 *
 * Liest alle relevanten Daten aus SQLite und schreibt sie als JSON
 * nach FORGE/html/liquidity/data/data.json.
 *
 * Wird regelmäßig aus bin/bot.js aufgerufen (alle EXPORT_INTERVAL_MS).
 * Kann auch manuell ausgeführt werden: node bin/export.js
 *
 * Ausgabe-Struktur (erwartet von html/liquidity/js/app.js):
 *   timestamp, version, portfolio, positions,
 *   portfolioHistory, aprHistory, volumeHistory, transactions, notifications
 */

import Database          from 'better-sqlite3';
import { notificationText } from '../../../lib/notify-render.js';
import { roundPrice, quoteSymbol } from '../../../html/js/format-price.js';
import { readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from 'fs';
import { resolve, dirname }  from 'path';
import { fileURLToPath }     from 'url';
import dotenv                from 'dotenv';
import { getSplTokensUsd, getLatestWalletBalance } from '../lib/wallet-monitor-client.js';
import { config, getCleanupTrendGateFromEnv, isPoolEnabled } from '../lib/config.js';
import { checkInvestEligibility } from '../lib/invest-eligibility.js';
import { poolInvestCooldowns } from '../lib/invest-cooldown.js';
import { loadTrendStates, checkTrendGate, parseTrendGate, TREND_TIMEFRAMES } from '../lib/trend-indicators.js';
import { FORGE_TZ, midnightTzMs } from '../../../core/config.js';
import { readMaintenanceFlag, getMaintenanceWindows } from '../../../core/maintenance.js';
import { getActiveProfile }       from '../lib/economic-scorer/config.js';
// PnL: ausschließlich über die zentrale FORGE-Lib (Single Source of Truth).
// Kein PnL-Code in diesem Bot — siehe FORGE/lib/pnl.js.
import { computePnlHistory, pnlForPeriod, pnlByScopeForPeriod, pnlWindows, pnlPeakForPeriod, feeLegForPeriod }
    from '../../../lib/pnl.js';
import { loadOpportunityScores, loadInvestScores } from '../lib/invest-score-provider.js';
import { resolvePnlAnchorMs, resolvePnlAnchorSource } from '../lib/pnl-anchor.js';
import { getPremiumCoverage } from '../../../lib/premium-wallet.js';
// Neutrale Blend-Formel (kein IP-Bezug) – NICHT aus lib/invest-score.js importieren,
// das würde über dessen Kopfimport die Score-Gewichte in invest-score-config.js
// zurück in den Fork ziehen (Befund 2026-07-25, siehe lib/score-blend.js).
import { blendInvestScore } from '../lib/score-blend.js';
import { scoreRange, getPoolTypeConfig }  from '../lib/range-advisor.js';
import { clmmLpValue as _clmmLpValue, clmmLpReturn as _clmmLpReturn,
         clmmLpReturnPath as _clmmLpReturnPath, clmmIlPct as _clmmIlPct }
    from '../lib/clmm-lp.js';
// Dust-Schwelle aus der neutralen Einzelquelle – NICHT aus invest-score-config.js:
// dort liegen die Score-Gewichte, die nicht in den FORGE-public-Fork gelangen dürfen.
import { VOLUME_DUST_USD as VOLUME_MALUS_DUST_USD } from '../lib/volume-dust.js';
import { computeBtcTrend, BTC_POOL_ID, TIMEFRAMES as BTC_TIMEFRAMES, EMA_SPANS as BTC_EMA_SPANS } from '../lib/btc-trend/index.js';
import { PATHS } from '../../../config/paths.js';
import { writeFrontendBundle } from '../../../lib/i18n.js';
import { displayVersion } from '../../../lib/version.js';
import { loadTsAdvice } from '../lib/ts-advice-provider.js';
import { loadTsConfig, evaluateTsTrigger } from '../lib/trailing-stop.js';
import { effectiveFeePct } from '../../../lib/effective-fee.js';

// Zentraler Formatter für FORGE_TZ-Day-Keys (YYYY-MM-DD)
const _dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: FORGE_TZ });

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

// ─── Pfade ────────────────────────────────────────────────────────────────────

const VERSION        = displayVersion();
const DB_PATH        = PATHS.liquidityDb;
const DATA_DIR            = resolve(__dirname, '../../../html/liquidity/data');
const DATA_FILE           = resolve(DATA_DIR, 'data.json');
const HISTORY_FILE        = resolve(DATA_DIR, 'data-history.json');
const PRICE_HISTORY_FILE  = resolve(DATA_DIR, 'price-history.json');
const HISTORY_MAX_AGE_MS  = 5 * 60 * 1000; // History nur alle 5 Minuten schreiben

mkdirSync(DATA_DIR, { recursive: true });

// ─── DB öffnen ────────────────────────────────────────────────────────────────

let db;
try {
    db = new Database(DB_PATH, { readonly: true });
} catch {
    // DB existiert noch nicht (Bot noch nie gestartet) → Skeleton schreiben
    writeFileSync(DATA_FILE, JSON.stringify({
        bot: 'Liquidity Bot', version: VERSION,
        timestamp: null,
        portfolio: { currentValue: null, totalFees: null,
                     impermanentLoss: null, impermanentLossPct: null,
                     avgApr: null, totalRebalances: 0, lastRebalanceAt: null },
        pools: [], positions: [], transactions: [], notifications: [],
    }, null, 2), 'utf-8');
    writeFileSync(HISTORY_FILE, JSON.stringify({
        portfolioHistory: [], aprHistory: [], tvlHistory: [],
        priceHistory: [], myAprHistory: [], posValueHistory: [], npHistory: [], scoreHistory: [], pnlHistory: [], compositionHistory: [], volumeHistory: [],
    }), 'utf-8');
    console.log('export.js: DB noch nicht vorhanden – Skeleton geschrieben.');
    process.exit(0);
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

const round2 = v => v != null ? Math.round(v * 100) / 100 : null;
const round4 = v => v != null ? Math.round(v * 10000) / 10000 : null;
const round6 = v => v != null ? Math.round(v * 1000000) / 1000000 : null;
// 🔒 KURSE nicht mit round4() exportieren, sondern mit roundPrice(): Poolpreise überstreichen
// viele Größenordnungen. round4 machte aus der cbBTC/SOL-Range 0.00119386–0.00126870 die
// Werte 0.0012–0.0013 — priceNow fiel dabei exakt auf priceLower, und die Kurve im
// Range-Chart wurde zur flachen Treppe, weil alle Punkte auf denselben Wert gerundet
// wurden. roundPrice() hält bei großen Werten dieselbe Präzision wie bisher.
// USD-BETRÄGE (Fees, Werte) bleiben bei round2/round4 — sie haben das Problem nicht.

/**
 * Aggregiert die Tier-Übersicht für das Dashboard.
 * Liefert pro Tier (invest/hold/withdraw/observe) eine sortierte Pool-Liste
 * mit den wichtigsten Anzeige-Feldern.
 */
function buildTierOverview(poolsOverview) {
    const tiers = { invest: [], hold: [], withdraw: [], observe: [], unranked: [] };
    for (const p of poolsOverview) {
        const e = p.economic;
        const tier = e?.tier ?? 'unranked';
        tiers[tier].push({
            id:                 p.id,
            displayPair:        p.displayPair,
            displayLabel:       p.displayLabel,
            active:             p.active,
            rankPos:            p.rankPos,
            rankOf:             p.rankOf,
            isActive:           e?.isActive,
            netEconPct:         round2(e?.netEconPct),
            realizedAprPct:     round2(e?.realizedAprPct),
            estimatedAprPct:    round2(e?.estimatedAprPct),
            rebalCostAprPct:    round2(e?.rebalCostAprPct),
            reinvestLossAprPct: round2(e?.reinvestLossAprPct),
            trend7dSlope:       round2(e?.trend7dSlope),
            rangeHitRatePct:    round2(e?.rangeHitRatePct),
            tvlTrendPct:        round2(e?.tvlTrendPct),
            volTvlRatio:        round4(e?.volTvlRatio),
            aprDeltaPct:        round2(e?.aprDeltaPct),
            confidencePct:      round2(e?.confidencePct),
        });
    }
    // Innerhalb jedes Tiers: nach rankPos (Platz 1 = bester)
    for (const k of Object.keys(tiers)) {
        tiers[k].sort((a, b) => (a.rankPos ?? 999) - (b.rankPos ?? 999));
    }
    return tiers;
}

// ─── Daten aus DB lesen ───────────────────────────────────────────────────────

// Alle Pools (aktive + inaktive → Dashboard zeigt verfügbare Pools)
// ORDER BY rowid: SQLite-interne Einfügereihenfolge (syncPools() erhält die rowid
// bestehender Zeilen bei UPSERT) — einzig verfügbarer Proxy für "zuerst aufgenommen",
// siehe displayLabelMap unten (LIQ#0470).
const pools = db.prepare(`SELECT * FROM pools ORDER BY rowid`).all();

// displayPair aus pools.json (Anzeige-Name, kann von pair abweichen, z.B. HYPE/SOL ↔ SOL/HYPE)
const poolsConfigPath = resolve(__dirname, '..', 'config', 'pools.json');
const poolsConfigRaw  = JSON.parse(readFileSync(poolsConfigPath, 'utf8'));
const displayPairMap  = Object.fromEntries(poolsConfigRaw.map(p => [p.id, p.displayPair ?? p.pair]));

// displayLabel: wie displayPair, aber Namensdopplungen (zwei Pools mit demselben
// Anzeigenamen, z.B. HYPE/USDC in unterschiedlichen Fee-Tiers) werden in Aufnahme-
// reihenfolge durchnummeriert: "HYPE/USDC", "HYPE/USDC (2)", "HYPE/USDC (3)", ...
// Eigenes Feld statt displayPair selbst zu ändern, weil das Frontend displayPair.split('/')
// zur Ableitung der Token-Reihenfolge nutzt (siehe "Einheitlicher displayPair-Vertrag"
// unten) — ein angehängtes " (2)" würde dort das zweite Token-Symbol verstümmeln.
const _displayLabelSeen = new Map();
const displayLabelMap   = {};
for (const pool of pools) {
    const base  = displayPairMap[pool.id] ?? pool.pair;
    const count = (_displayLabelSeen.get(base) ?? 0) + 1;
    _displayLabelSeen.set(base, count);
    displayLabelMap[pool.id] = count === 1 ? base : `${base} (${count})`;
}
const volatilePairMap = Object.fromEntries(poolsConfigRaw.map(p => [p.id, !!p.volatilePair]));
const usdcIsTokenAMap  = Object.fromEntries(poolsConfigRaw.map(p => [p.id, !!p.usdcIsTokenA]));
const poolTypeMap     = Object.fromEntries(poolsConfigRaw.map(p => [p.id, p.poolType ?? null]));
// Einheit des Poolpreises (= echtes tokenB). Wird hier abgeleitet und fertig exportiert,
// weil nur der Bot die volle Pool-Config kennt: `pair` ist ein Label-Feld und bei
// liq-eurc-usdc (usdcIsTokenA) invertiert. Dasselbe Prinzip wie beim displayPair-Vertrag
// unten — das Frontend soll nicht raten müssen, ob ein Pool intern gedreht ist.
const priceUnitMap    = Object.fromEntries(poolsConfigRaw.map(p => [p.id, quoteSymbol(p)]));
// active-Flag aus der DB (Single Source of Truth). Der Bot schreibt es unmittelbar
// per Setter, daher gibt es keine Sync-Verzögerung mehr (früher wurde es aus pools.json
// gelesen, weil pools.json der Live-Store war — jetzt ist es die DB).
const activeFromConfig = Object.fromEntries(pools.map(p => [p.id, p.active === 1]));

// ── Einheitlicher displayPair-Vertrag ────────────────────────────────────────
// REGEL: Alle exportierten amountA/amountB-Felder sind IMMER in displayPair-
// Reihenfolge. Das Frontend darf displayPair.split('/') direkt als Labels
// verwenden, ohne zu wissen ob ein Pool intern gedreht ist.
//
// Betroffene Felder: claimHistory, transactions, posValueHistory,
//                    compositionHistory (inkl. pctA), positions.
//
// Neue Pools: displayPair in pools.json != pair → pairFlipMap greift automatisch.
// Neue Datenfelder: pairFlipMap[pool_id] nutzen, analog den bestehenden Stellen.
const pairFlipMap = Object.fromEntries(poolsConfigRaw.map(p => {
    const dp = p.displayPair ?? p.pair ?? '';
    return [p.id, dp && p.pair && dp !== p.pair];
}));

// Offene Positionen mit Pool-Join
const openPositions = db.prepare(`
    SELECT p.*, pl.protocol, pl.pair, pl.token_a, pl.token_b, pl.decimals_a, pl.decimals_b
    FROM positions p
    JOIN pools pl ON p.pool_id = pl.id
    WHERE p.closed_at IS NULL
`).all();

// Historische (geschlossene) Positionen
const closedPositions = db.prepare(`
    SELECT p.*, pl.protocol, pl.pair
    FROM positions p
    JOIN pools pl ON p.pool_id = pl.id
    WHERE p.closed_at IS NOT NULL
    ORDER BY p.closed_at DESC
    LIMIT 10
`).all();

// Letzte Pool-Stats je Pool (für aktuellen Preis + APR)
const latestStats = {};
for (const pool of pools) {
    const row = db.prepare(`
        SELECT * FROM pool_stats WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1
    `).get(pool.id);
    if (row) latestStats[pool.id] = row;
}

// Stale-APR-Erkennung: apr_24h seit >24h unverändert → eigenen Wert berechnen
// Mindestens 5 Einträge + alle identisch (ROUND auf 2 Stellen) → eingefroren
const _24hAgoMs = Date.now() - 24 * 3_600_000;
const staleAprPools = new Set(
    pools.filter(pool => {
        const r = db.prepare(
            `SELECT COUNT(*) as n, COUNT(DISTINCT ROUND(apr_24h, 2)) as d
             FROM pool_stats WHERE pool_id = ? AND recorded_at >= ?`
        ).get(pool.id, _24hAgoMs);
        return r.n >= 5 && r.d <= 1;
    }).map(p => p.id)
);
if (staleAprPools.size > 0)
    console.log(`export.js: Stale APR erkannt: ${[...staleAprPools].join(', ')}`);

// SOL-Preis + Reserve (benötigt für portfolioHistory und Portfolio-Metriken)
const solReserve = parseFloat(process.env.SOL_RESERVE ?? '0.10');
const solPool    = pools.find(p => p.pair === 'SOL/USDC');
const solPrice   = solPool ? (latestStats[solPool.id]?.price ?? 0) : 0;

// Investiertes Kapital je Pool (Summe capital_usdc aus offenen Positionen)
const investedCapital = {};
for (const row of db.prepare(`
    SELECT pool_id, SUM(capital_usdc) as total
    FROM positions
    WHERE closed_at IS NULL AND capital_usdc IS NOT NULL
    GROUP BY pool_id
`).all()) {
    investedCapital[row.pool_id] = row.total;
}

// ─── InvestScore: Hilfsdaten (LMB#0117) ──────────────────────────────────────
// openPosByPool: neueste offene Position je Pool (für capital_usdc als PnL-Basis)
const openPosByPool = {};
for (const pos of openPositions) {
    if (!openPosByPool[pos.pool_id] || pos.opened_at > openPosByPool[pos.pool_id].opened_at)
        openPosByPool[pos.pool_id] = pos;
}

// lastNonZeroCapitalByPool: letztes bekanntes capital_usdc > 0 je Pool (offen ODER geschlossen).
// Fallback-Normalisierer für inaktive Pools, die noch pnlWindows-Daten aus der letzten
// aktiven Phase haben. Ohne diesen Fallback werden PnL-Metriken für alle inaktiven
// Pools null, obwohl echte Performance-Daten vorliegen (z.B. RENDER/SOL nach Schließung).
const lastNonZeroCapitalByPool = {};
for (const row of db.prepare(`
    SELECT pool_id, capital_usdc
    FROM positions
    WHERE capital_usdc > 0
    ORDER BY opened_at DESC
`).all()) {
    if (!lastNonZeroCapitalByPool[row.pool_id])
        lastNonZeroCapitalByPool[row.pool_id] = row.capital_usdc;
}

// Aktuelle Ranking-Position + Economic-Scorer-Daten je Pool (neuester Snapshot pro Pool)
const latestRank = {};
const latestEconomic = {};
for (const row of db.prepare(`
    SELECT psh.*
      FROM pool_score_history psh
      JOIN (
          SELECT pool_id, MAX(recorded_at) AS max_ts
            FROM pool_score_history
           GROUP BY pool_id
      ) latest ON latest.pool_id = psh.pool_id AND latest.max_ts = psh.recorded_at
`).all()) {
    latestRank[row.pool_id] = {
        pos:           row.rank_pos,
        of:            row.rank_of,
        shortTermPos:  row.short_term_rank_pos,
        shortTermOf:   row.short_term_rank_of,
    };
    latestEconomic[row.pool_id] = {
        tier:               row.tier,
        isActive:           row.is_active === null ? null : (row.is_active === 1),
        realizedAprPct:     row.realized_apr_pct,
        estimatedAprPct:    row.estimated_apr_pct,
        rebalCostAprPct:    row.rebal_cost_apr_pct,
        reinvestLossAprPct: row.reinvest_loss_apr_pct,
        netEconPct:         row.net_econ_pct,
        tokenReturnAprPct:  row.token_return_apr_pct,
        tokenReturnConfidence: row.token_return_confidence,
        dailyPnlPct:        row.daily_pnl_pct,
        weeklyPnlPct:       row.weekly_pnl_pct,
        totalReturnAprPct:  row.total_return_apr_pct,
        trend7dSlope:       row.trend_7d_slope,
        rangeHitRatePct:    row.range_hit_rate_pct,
        tvlTrendPct:        row.tvl_trend_pct,
        volTvlRatio:        row.vol_tvl_ratio,
        aprDeltaPct:        row.apr_delta_pct,
        confidencePct:      row.confidence_score,
        recordedAt:         row.recorded_at,
        // Phase-2-Kurzfrist-Tier (für profil-abhängige Sortierung)
        shortTermTier:        row.short_term_tier,
        shortTermNetMetric:   row.short_term_net_metric,
        shortTermAprPct:      row.short_term_apr_pct,
        shortTermConfidence:  row.short_term_confidence,
        entryExitCostAprPct:  row.entry_exit_cost_apr_pct,
    };
}

// Pools-Übersicht für Dashboard (alle Pools mit aktuellen Stats)
const poolsOverview = pools.map(pool => {
    const stats = latestStats[pool.id] ?? null;
    return {
        id:               pool.id,
        protocol:         pool.protocol === 'orca' ? 'Orca Whirlpools' : pool.protocol,
        pair:             pool.pair,
        displayPair:      displayPairMap[pool.id] ?? pool.pair,
        displayLabel:     displayLabelMap[pool.id] ?? pool.pair,
        poolType:         poolTypeMap[pool.id] ?? null,
        active:           activeFromConfig[pool.id] ?? (pool.active === 1),
        address:          pool.address,
        tokenA:           pool.token_a,
        tokenB:           pool.token_b,
        usdcIsTokenA:     usdcIsTokenAMap[pool.id] ?? false,
        volatilePair:     volatilePairMap[pool.id] ?? false,
        feeTier:          pool.fee_tier,
        tickSpacing:      pool.tick_spacing ?? null,
        rankPos:          latestRank[pool.id]?.pos ?? null,
        rankOf:           latestRank[pool.id]?.of  ?? null,
        shortTermRankPos: latestRank[pool.id]?.shortTermPos ?? null,
        shortTermRankOf:  latestRank[pool.id]?.shortTermOf  ?? null,
        economic:         latestEconomic[pool.id] ?? null,
        capitalUSDC:      round2(investedCapital[pool.id] ?? null),
        positionOpenedAt: openPosByPool[pool.id]?.opened_at ?? null,
        price:            roundPrice(stats?.price ?? null),
        apr24h:           round2(stats?.apr_24h ?? null),
        tvl:              round2(stats?.tvl_usd ?? null),
        volume24h:        round2(stats?.volume_24h_usd ?? null),
        lastUpdate:       stats?.recorded_at ?? null,
    };
});

// ─── Opportunity-Score (LMB#0116, Phase 1) ────────────────────────────────────
// Berechnet pro Pool für 3 Profile (short/medium/long) den neuen Score.
// Liest pool_stats über 168 h (max-Fenster), schreibt einen Snapshot je Profil
// in opportunity_scores. Phase 1 = nur Anzeige, keine Bot-Entscheidung.
const _oppNowMs   = Date.now();
const _oppFromMs  = _oppNowMs - 168 * 3600_000;
const _oppStatsByPool = {};
const _oppRows = db.prepare(`
    SELECT pool_id, price, apr_24h, tvl_usd, volume_24h_usd,
           liquidity_in_range, fees_24h_usd, recorded_at
    FROM pool_stats WHERE recorded_at >= ? ORDER BY recorded_at ASC
`).all(_oppFromMs);
for (const r of _oppRows) {
    (_oppStatsByPool[r.pool_id] ??= []).push(r);
}

// usdAvg-Augmentierung (LMB Phase 2): für volatilePair-Pools den USD-Mittelwert
// beider Token je Snapshot anhängen. Quelle = Quote-Pool-Preis aus _oppStatsByPool
// (kein API-Call). Damit kann der Opportunity-Score-Lib den gerichteten USD-Trend
// des Token-Korbs als Slope bestimmen — das Signal, das bei volatilePair-Pools fehlt
// (Ratio-Preis-Slope ist dort kein zuverlässiges Kapital-Drift-Signal).
// Nur Quote-Pools mit direktem USDC-Bezug (tokenB=USDC) werden aufgelöst; abgeleitete
// Referenz-Quotes (z.B. jitosol-ref) bleiben undefiniert → Lib behandelt als neutral.
{
    const _USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const _cfgById = Object.fromEntries(poolsConfigRaw.map(p => [p.id, p]));
    // Quote-USD an Zeitpunkt ts via Binärsuche im Quote-Pool-Snapshot (max. 90-Min-Lücke).
    const _quotePriceAt = (quotePoolId, ts) => {
        const arr = _oppStatsByPool[quotePoolId];
        if (!arr || arr.length === 0) return null;
        let lo = 0, hi = arr.length - 1, idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            arr[mid].recorded_at <= ts ? (idx = mid, lo = mid + 1) : hi = mid - 1;
        }
        if (idx < 0 || ts - arr[idx].recorded_at > 90 * 60_000) return null;
        return arr[idx].price;
    };
    for (const cfg of poolsConfigRaw) {
        if (!cfg.volatilePair || !cfg.quotePricePoolId || !cfg.quoteTokenMint) continue;
        const quoteCfg = _cfgById[cfg.quotePricePoolId];
        // Quote-Pool muss direkten USDC-Bezug haben (price = Quote-Token in USD).
        if (!quoteCfg || quoteCfg.derivedQuote || quoteCfg.usdcIsTokenA
            || quoteCfg.tokenB !== _USDC) continue;
        const quoteIsTokenA = cfg.quoteTokenMint === cfg.tokenA;
        const rows = _oppStatsByPool[cfg.id] ?? [];
        for (const row of rows) {
            const p = row.price;
            if (!p || p <= 0) continue;
            const quoteUsd = _quotePriceAt(cfg.quotePricePoolId, row.recorded_at);
            if (!quoteUsd || quoteUsd <= 0) continue;
            const usdA = quoteIsTokenA ? quoteUsd : p * quoteUsd;
            const usdB = quoteIsTokenA ? quoteUsd / p : quoteUsd;
            if (usdA > 0 && usdB > 0) row.usdAvg = 0.5 * (usdA + usdB);
        }
    }
}

// ─── Score-Naht (2026-07-25) ──────────────────────────────────────────────────
// Opportunity Score und InvestScore kommen ausschließlich über den Provider:
// der Master rechnet (lib/invest-score-compute.js), der FORGE-public-Fork erhält sie
// als Premium-Daten. export.js selbst kennt die Score-Algorithmen nicht mehr.
// `scoreSource` wird bis ins Dashboard durchgereicht ('none' → Platzhalter).
const _oppRes           = await loadOpportunityScores({
    pools, oppStatsByPool: _oppStatsByPool, oppNowMs: _oppNowMs, volatilePairMap,
});
const opportunityScores = _oppRes.opportunityScores;
const _timeframeIds     = _oppRes.timeframeIds;
let   scoreSource       = _oppRes.source;
let   scoreStale        = _oppRes.stale;

// Premium-Deckung (2026-07-29) — siehe getPremiumCoverage() in lib/premium-wallet.js.
const _premiumCoverage = getPremiumCoverage();

// Persistenz: separate writable Connection (WAL erlaubt parallele Writer)
// Throttle auf max. 1 Snapshot pro Stunde — pool_stats wird ohnehin nur stündlich
// aktualisiert, häufigere Snapshots würden nur Duplikate erzeugen.
try {
    const dbWrite = new Database(DB_PATH);
    dbWrite.pragma('journal_mode = WAL');
    const lastSnap = dbWrite.prepare(
        `SELECT MAX(recorded_at) AS ts FROM opportunity_scores`
    ).get();
    const lastTs = lastSnap?.ts ?? 0;
    if (_oppNowMs - lastTs < 55 * 60_000) {
        dbWrite.close();
        throw new Error('skipped: < 55min since last snapshot');
    }
    const insOpp = dbWrite.prepare(`
        INSERT INTO opportunity_scores
        (pool_id, timeframe, recorded_at, score, yield_per_tvl, gross_apr_pct,
         price_slope_pct, yield_slope_pct, tvl_slope_pct, usd_trend_slope_pct,
         price_factor, yield_factor, tvl_factor, trend_factor, hopium_gate,
         sample_count, window_hours, reason)
        VALUES (@pool_id, @timeframe, @recorded_at, @score, @yield_per_tvl, @gross_apr_pct,
                @price_slope_pct, @yield_slope_pct, @tvl_slope_pct, @usd_trend_slope_pct,
                @price_factor, @yield_factor, @tvl_factor, @trend_factor, @hopium_gate,
                @sample_count, @window_hours, @reason)
    `);
    const txn = dbWrite.transaction(() => {
        for (const [poolId, byTimeframe] of Object.entries(opportunityScores)) {
            for (const tfId of _timeframeIds) {
                const s = byTimeframe[tfId];
                insOpp.run({
                    pool_id:         poolId,
                    timeframe:       tfId,
                    recorded_at:     _oppNowMs,
                    score:           s.score ?? null,
                    yield_per_tvl:   s.yieldPerTvl ?? null,
                    gross_apr_pct:   s.grossAprPct ?? null,
                    price_slope_pct:     s.priceSlopePct ?? null,
                    yield_slope_pct:     s.yieldSlopePct ?? null,
                    tvl_slope_pct:       s.tvlSlopePct ?? null,
                    usd_trend_slope_pct: s.usdTrendSlopePct ?? null,
                    price_factor:        s.priceFactor ?? null,
                    yield_factor:        s.yieldFactor ?? null,
                    tvl_factor:          s.tvlFactor ?? null,
                    trend_factor:        s.trendFactor ?? null,
                    hopium_gate:         s.hopiumGate ?? null,
                    sample_count:    s.sampleCount ?? 0,
                    window_hours:    s.windowHours ?? null,
                    reason:          s.reason ?? null,
                });
            }
        }
    });
    txn();
    dbWrite.close();
} catch (e) {
    if (!String(e.message).startsWith('skipped')) {
        console.warn(`export.js: opportunity_scores nicht persistiert (${e.message})`);
    }
}

// BTC-Trendmeter (BTC-Korrelation Phase 0): 12-Punkte-Trend aus der stündlichen
// BTC-Preis-Historie ableiten und stündlich snapshotten. Reine Ableitung aus
// pool_stats (liq-btc-usdc) — kein API-Call. Throttle wie opportunity_scores (55min).
try {
    const dbBtc   = new Database(DB_PATH);
    dbBtc.pragma('journal_mode = WAL');
    const lastBtc = dbBtc.prepare(`SELECT MAX(recorded_at) AS ts FROM btc_trend_history`).get();
    if (Date.now() - (lastBtc?.ts ?? 0) < 55 * 60_000) {
        dbBtc.close();
        throw new Error('skipped: < 55min since last btc_trend snapshot');
    }
    const btcRows = dbBtc.prepare(
        `SELECT recorded_at, price FROM pool_stats
         WHERE pool_id = ? AND price IS NOT NULL
         ORDER BY recorded_at ASC`
    ).all(BTC_POOL_ID);
    const trend = computeBtcTrend(btcRows.map(r => ({ ts: r.recorded_at, price: r.price })));
    if (trend && trend.ema_available >= 1) {
        const emaCols = [];
        for (const tf of BTC_TIMEFRAMES) for (const span of BTC_EMA_SPANS) emaCols.push(`ema_${tf.id}_${span}`);
        const insBtc = dbBtc.prepare(`
            INSERT OR IGNORE INTO btc_trend_history
            (recorded_at, btc_price, ${emaCols.join(', ')}, trend_points, ema_available, trend_pct)
            VALUES
            (@recorded_at, @btc_price, ${emaCols.map(c => '@'+c).join(', ')}, @trend_points, @ema_available, @trend_pct)
        `);
        const row = {
            recorded_at:   trend.recorded_at,
            btc_price:     trend.btc_price,
            trend_points:  trend.trend_points,
            ema_available: trend.ema_available,
            trend_pct:     trend.trend_pct,
        };
        for (const c of emaCols) row[c] = trend.emas[c] ?? null;
        insBtc.run(row);
    }
    dbBtc.close();
} catch (e) {
    if (!String(e.message).startsWith('skipped')) {
        console.warn(`export.js: btc_trend_history nicht persistiert (${e.message})`);
    }
}

// Letztes Portfolio-Snapshot
const latestSnap = db.prepare(`
    SELECT * FROM portfolio_history ORDER BY recorded_at DESC LIMIT 1
`).get();

// Gesamte geclaimte Fees (historisch)
const totalFees = db.prepare(`
    SELECT COALESCE(SUM(usd_value), 0) as total FROM fee_history
`).get();

// Geclaimte Fees: Heute, Gestern, Dieser Monat (Tagesgrenzen in FORGE_TZ)
const _todayIso      = _dayFmt.format(new Date());          // 'YYYY-MM-DD' in FORGE_TZ
const todayStartMs   = midnightTzMs(_todayIso);             // 00:00 FORGE_TZ heute (UTC-ms)
const yesterdayStartMs = todayStartMs - 86_400_000;         // entspr. gestern (nicht DST-exakt, aber ok für Tagesstats)
// Monatsanfang: _todayIso = 'YYYY-MM-DD' → 'YYYY-MM-01'
const monthStartMs   = midnightTzMs(_todayIso.slice(0, 8) + '01');

const feesToday = db.prepare(`
    SELECT COALESCE(SUM(usd_value), 0) as total FROM fee_history
    WHERE claimed_at >= ?
`).get(todayStartMs).total;

const feesYesterday = db.prepare(`
    SELECT COALESCE(SUM(usd_value), 0) as total FROM fee_history
    WHERE claimed_at >= ? AND claimed_at < ?
`).get(yesterdayStartMs, todayStartMs).total;

const feesMonth = db.prepare(`
    SELECT COALESCE(SUM(usd_value), 0) as total FROM fee_history
    WHERE claimed_at >= ?
`).get(monthStartMs).total;

// TX-Fees (Payed Fees): Heute, Gestern, Dieser Monat – aus transactions.tx_fee_sol (SOL)
const txFeesToday = db.prepare(`
    SELECT COALESCE(SUM(tx_fee_sol), 0) as total FROM transactions
    WHERE created_at >= ? AND tx_fee_sol IS NOT NULL
`).get(todayStartMs).total;

const txFeesYesterday = db.prepare(`
    SELECT COALESCE(SUM(tx_fee_sol), 0) as total FROM transactions
    WHERE created_at >= ? AND created_at < ? AND tx_fee_sol IS NOT NULL
`).get(yesterdayStartMs, todayStartMs).total;

const txFeesMonth = db.prepare(`
    SELECT COALESCE(SUM(tx_fee_sol), 0) as total FROM transactions
    WHERE created_at >= ? AND tx_fee_sol IS NOT NULL
`).get(monthStartMs).total;

// Claim-Historie seit Monatsbeginn (für Pool-Claim-History-Modal: Heute/Gestern/Monat)
// Mindestens 25h zurück, damit die 1D-Ansicht (letzte 24h) auch am Monatsanfang vollständig ist.
const poolPairDbMap = Object.fromEntries(pools.map(p => [p.id, p.pair]));
const _claimHistoryCutoff = Math.min(monthStartMs, Date.now() - 25 * 3_600_000);
// position_id geht mit: Das Modal zeigt die Claims der *aktuellen Position*, nicht des Pools
// über alle Sessions hinweg. Ohne diese Grenze summierte „Heute" bei einem Pool, der am selben
// Tag mehrfach geschlossen und wiedereröffnet wurde, die Claims aller Vorgänger-Positionen
// (ZEC/USDC auf forge-pub1, 2026-08-22: 13 Claims angezeigt, Position erst Minuten alt).
const claimHistoryRows = db.prepare(`
    SELECT fh.claimed_at, fh.pool_id, fh.position_id, fh.amount_a, fh.amount_b, fh.usd_value, fh.action, fh.tx_hash
    FROM fee_history fh
    WHERE fh.claimed_at >= ?
    ORDER BY fh.claimed_at DESC
`).all(_claimHistoryCutoff);
const claimHistory = claimHistoryRows.map(r => {
    // amountA/amountB in displayPair-Reihenfolge bringen (siehe pairFlipMap-Kommentar oben)
    const flip = pairFlipMap[r.pool_id] === true;
    return ({
    claimedAt:   r.claimed_at,
    positionId:  r.position_id ?? null,
    poolId:      r.pool_id ?? null,                              // eindeutiges Filter-Matching (LIQ#0471)
    pair:        poolPairDbMap[r.pool_id] ?? r.pool_id,          // DB-Pair, nur für Anzeige
    displayPair: displayPairMap[r.pool_id] ?? poolPairDbMap[r.pool_id] ?? r.pool_id,
    amountA:     round6(flip ? r.amount_b : r.amount_a),
    amountB:     round6(flip ? r.amount_a : r.amount_b),
    usdValue:    round4(r.usd_value),
    action:      r.action,
    txHash:      r.tx_hash ?? null,
    });
});

// Tägliche Fee-Historie (letzte 30 Tage, Tagesgrenzen in FORGE_TZ, für Profit-Chart)
// Vorher: SQLite 'localtime' abhängig von Server-TZ. Jetzt: Node-seitig via FORGE_TZ.
const _feeRawRows = db.prepare(`
    SELECT claimed_at, usd_value FROM fee_history
    WHERE claimed_at >= ?
    ORDER BY claimed_at ASC
`).all(Date.now() - 30 * 86_400_000);
const _feeByDay = new Map();
// Alle 30 Tage mit 0 vorbelegen, damit Chart auch leere Tage anzeigt
for (let i = 29; i >= 0; i--) {
    const day = _dayFmt.format(new Date(Date.now() - i * 86_400_000));
    _feeByDay.set(day, 0);
}
for (const r of _feeRawRows) {
    const day = _dayFmt.format(new Date(r.claimed_at));
    _feeByDay.set(day, (_feeByDay.get(day) ?? 0) + (r.usd_value ?? 0));
}
const dailyFees = [..._feeByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, fees]) => ({ date: day, fees: Math.round(fees * 10000) / 10000 }));

// APR-Gewichtung: nur Pools mit investiertem Kapital (aktive offene Positionen)
const aprValues = pools
    .filter(pool => (investedCapital[pool.id] ?? 0) > 0)
    .map(pool => latestStats[pool.id]?.apr_24h)
    .filter(v => v != null && v > 0);
const avgApr = aprValues.length > 0
    ? aprValues.reduce((a, b) => a + b, 0) / aprValues.length
    : null;

// Rebalancing-Statistik
const rebalanceCount = db.prepare(`SELECT COUNT(*) as cnt FROM rebalance_history`).get();
const lastRebalance  = db.prepare(`
    SELECT rebalanced_at FROM rebalance_history ORDER BY rebalanced_at DESC LIMIT 1
`).get();

// Portfolio-Verlauf (letzte 7 Tage, downgesampelt auf 1 Punkt/5 Minuten).
// total_usd ist bereits das vollständige Portfolio (LP + Fees + Wallet) — der Writer
// in writePortfolioSnapshot summiert diese drei Komponenten. Bis v0.3.46 addierte der
// Chart-Code Wallet nochmals on top → Doppelt-Zählung. Behoben in v0.3.47.
const sevenDaysAgo    = Date.now() -  7 * 24 * 60 * 60 * 1000;
const thirtyDaysAgo   = Date.now() - 30 * 24 * 60 * 60 * 1000;
const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000; // für 24h-Lookback im Chart
const portfolioHistRaw = db.prepare(`
    SELECT total_usd, recorded_at FROM portfolio_history
    WHERE recorded_at >= ? ORDER BY recorded_at ASC
`).all(sevenDaysAgo);

// Downsampling: letzter Wert pro 5-Minuten-Bucket
const portfolioBy5Min = new Map();
for (const row of portfolioHistRaw) {
    portfolioBy5Min.set(Math.floor(row.recorded_at / 300_000), row);
}
const portfolioHistory = [...portfolioBy5Min.values()].map(r => ({
    t: r.recorded_at,
    v: round2(r.total_usd ?? 0),
}));

// APR-Verlauf (letzte 30 Tage, 1 Punkt/Stunde = pool_stats-Intervall)
const aprHistRaw = db.prepare(`
    SELECT pool_id, apr_24h, recorded_at FROM pool_stats
    WHERE recorded_at >= ? ORDER BY recorded_at ASC
`).all(thirtyDaysAgo);

const aprHistory = aprHistRaw.map(r => ({
    t:      r.recorded_at,
    poolId: r.pool_id,
    apr:    round2(r.apr_24h),
}));

// Preis-Verlauf (zentrale prices.db, letzte 30 Tage, downgesampelt auf 5 Min)
const PRICES_DB_PATH = PATHS.pricesDb;
const PRICE_PAIR_MAP = { 'cbBTC/USDC': 'BTC/USDC' };  // Liquidity-Pair → zentrale Pair-Name

let priceHistory = [];
try {
    const pricesDb = new Database(PRICES_DB_PATH, { readonly: true });
    const activePools = pools.filter(p => activeFromConfig[p.id] ?? !!p.active);
    for (const pool of activePools) {
        const centralPair = PRICE_PAIR_MAP[pool.pair] ?? pool.pair;
        const raw = pricesDb.prepare(`
            SELECT price, recorded_at FROM price_history
            WHERE pair = ? AND recorded_at >= ?
            ORDER BY recorded_at ASC
        `).all(centralPair, thirtyDaysAgo);
        // Downsample: 1 Punkt pro 5-Minuten-Bucket
        const buckets = new Map();
        for (const r of raw) buckets.set(Math.floor(r.recorded_at / 300_000), r);
        if (buckets.size > 0) {
            for (const r of buckets.values()) {
                priceHistory.push({ t: r.recorded_at, poolId: pool.id, price: roundPrice(r.price) });
            }
        } else {
            // Kein Eintrag in zentraler DB (z.B. neuer Pool) → Fallback auf pool_stats
            const fallback = db.prepare(
                'SELECT price, recorded_at FROM pool_stats WHERE pool_id = ? AND recorded_at >= ? ORDER BY recorded_at ASC'
            ).all(pool.id, thirtyDaysAgo);
            for (const r of fallback) {
                priceHistory.push({ t: r.recorded_at, poolId: pool.id, price: roundPrice(r.price) });
            }
        }
    }
    pricesDb.close();
    console.log(`export.js: ${priceHistory.length} Preispunkte aus zentraler DB`);
} catch (e) {
    console.warn(`export.js: Zentrale prices.db nicht verfügbar (${e.message}) – Fallback auf pool_stats`);
    // Fallback: pool_stats-Preise direkt (geringe Auflösung, ~1 Punkt/Stunde)
    const fallbackRaw = db.prepare(`
        SELECT pool_id, price, recorded_at FROM pool_stats
        WHERE recorded_at >= ? ORDER BY recorded_at ASC
    `).all(thirtyDaysAgo);
    priceHistory = fallbackRaw.map(r => ({ t: r.recorded_at, poolId: r.pool_id, price: roundPrice(r.price) }));
}

// Fensterbreite für Meine-APR: Live-Anzeige + Chart verwenden denselben Wert.
// Kleiner = reaktiver, aber noiser (Minimum sinnvoll: ~3 Snapshots = 15 Min).
const APR_WINDOW_MS  = 60 * 60 * 1000;   // 60 Minuten (1 Stunde)
const APR_WINDOW_MIN = APR_WINDOW_MS / 2; // Mindestperiode = halbes Fenster (30 Min)

const POOLS_JSON_PATH = resolve(__dirname, '../config/pools.json');
const _allPoolsConfig = JSON.parse(readFileSync(POOLS_JSON_PATH, 'utf-8'));

// volatilePair-Pool-Info für Fee-Umrechnung (z.B. SOL/HYPE):
// Quote=tokenA: tokenA-USD = quotePrice; tokenB-USD = quotePrice / poolPrice
// Quote=tokenB: tokenA-USD = poolPrice * quotePrice; tokenB-USD = quotePrice
const _volatilePoolInfo = {};
for (const p of _allPoolsConfig) {
    if (p.volatilePair && p.quotePricePoolId && p.quoteTokenMint) {
        _volatilePoolInfo[p.id] = {
            quoteIsTokenA:     p.quoteTokenMint === p.tokenA,
            quotePricePoolId:  p.quotePricePoolId,
        };
    }
}
const volatilePairPoolIds = new Set(Object.keys(_volatilePoolInfo));
const usdcIsTokenAPoolIds = new Set(_allPoolsConfig.filter(p => p.usdcIsTokenA).map(p => p.id));

// TVL-Schwellwerte aus pools.json als Fallback in poolsOverview einmergen.
// Werden weiter unten (nach dem Laden von poolSettings) durch die effektiven
// L1/L2-Schwellen des TVL-Schutzes aus settings.db überschrieben.
const _tvlThresholds = Object.fromEntries(
    _allPoolsConfig.map(p => [p.id, { tvlWarnThreshold: p.tvlWarnThreshold ?? null, tvlExitThreshold: p.tvlExitThreshold ?? null }])
);
for (const po of poolsOverview) {
    po.tvlWarnThreshold = _tvlThresholds[po.id]?.tvlWarnThreshold ?? null;
    po.tvlExitThreshold = _tvlThresholds[po.id]?.tvlExitThreshold ?? null;
}
// derivedQuote-Map: quotePricePoolId → "base" pool id (z.B. liq-jitosol-ref → liq-sol-usdc).
// Für solche Pools gilt: quoteUSD = baseUsdAt(ts) / rawPrice (statt rawPrice direkt).
const _poolConfigById = Object.fromEntries(_allPoolsConfig.map(p => [p.id, p]));
const _derivedQuoteBase = {};
for (const info of Object.values(_volatilePoolInfo)) {
    const refCfg = _poolConfigById[info.quotePricePoolId];
    if (refCfg?.derivedQuote) _derivedQuoteBase[info.quotePricePoolId] = refCfg.derivedQuote;
}

// Preisreihen aller Quote-Pools (z.B. liq-sol-usdc) für volatilePair-Fee-Umrechnung.
// Für "derived"-Pools (tokenA=SOL, tokenB≠USDC) wird baseUSD / rawPrice gespeichert.
const _quotePriceArrByPool = {};
const _loadRawPriceSeries = (poolId) => {
    if (_quotePriceArrByPool[poolId]) return;
    const rows = db.prepare(
        `SELECT price, recorded_at FROM pool_stats WHERE pool_id = ? AND recorded_at >= ? ORDER BY recorded_at ASC`
    ).all(poolId, thirtyOneDaysAgo);
    _quotePriceArrByPool[poolId] = rows.map(r => ({ ts: r.recorded_at, price: r.price }));
};
for (const info of Object.values(_volatilePoolInfo)) {
    const baseId = _derivedQuoteBase[info.quotePricePoolId];
    if (baseId) _loadRawPriceSeries(baseId); // Basis zuerst laden
    _loadRawPriceSeries(info.quotePricePoolId);
}
// Derived-Pools: Roh-Preise durch berechnete USD-Preise ersetzen (baseUSD / rawPrice)
for (const [derivedId, baseId] of Object.entries(_derivedQuoteBase)) {
    const rawArr  = _quotePriceArrByPool[derivedId] ?? [];
    const baseArr = _quotePriceArrByPool[baseId]    ?? [];
    if (rawArr.length === 0 || baseArr.length === 0) continue;
    // Für jeden Datenpunkt: baseUSD zum selben Zeitpunkt per Binärsuche (max. 90-Min-Lücke)
    _quotePriceArrByPool[derivedId] = rawArr.map(({ ts, price: raw }) => {
        if (!raw || raw === 0) return { ts, price: 0 };
        let lo = 0, hi = baseArr.length - 1, idx = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; baseArr[m].ts <= ts ? (idx = m, lo = m + 1) : hi = m - 1; }
        if (idx < 0 || ts - baseArr[idx].ts > 90 * 60_000) return { ts, price: 0 };
        return { ts, price: baseArr[idx].price / raw };
    });
}
function _quoteUsdAt(quotePoolId, ts) {
    const arr = _quotePriceArrByPool[quotePoolId];
    if (!arr || arr.length === 0) return 0;
    let lo = 0, hi = arr.length - 1, idx = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].ts <= ts) { idx = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    if (idx < 0) return 0;
    if (ts - arr[idx].ts > 90 * 60_000) return 0;
    return arr[idx].price;
}

// Meine-APR-Verlauf (letzte 30 Tage, rollierende APR_WINDOW_MS-Fenster)
// Schließt auch abgeschlossene Positionen ein (Snapshots innerhalb ihrer Laufzeit)
const myAprAllSnaps = db.prepare(`
    SELECT ps.recorded_at, ps.pool_id, ps.fees_pending_usd,
           ps.fees_pending_a, ps.fees_pending_b, ps.price,
           p.id as position_id, p.capital_usdc, p.opened_at
    FROM position_snapshots ps
    JOIN positions p ON p.pool_id = ps.pool_id
        AND ps.recorded_at >= p.opened_at
        AND (p.closed_at IS NULL OR ps.recorded_at <= p.closed_at)
    WHERE ps.recorded_at >= ?
    ORDER BY ps.pool_id, ps.recorded_at ASC
`).all(thirtyOneDaysAgo);

// Snapshots nach Pool gruppieren (für Delta-Summen-Berechnung)
const _snapsByPool = {};
for (const r of myAprAllSnaps) {
    (_snapsByPool[r.pool_id] ??= []).push(r);
}

// Gibt alle Snapshots im Bereich [from, to] zurück (snaps muss ASC sortiert sein).
function _snapsInRange(snaps, from, to) {
    let lo = 0, hi = snaps.length;
    while (lo < hi) { const m = (lo + hi) >> 1; snaps[m].recorded_at < from ? lo = m + 1 : hi = m; }
    const left = lo;
    lo = 0; hi = snaps.length;
    while (lo < hi) { const m = (lo + hi) >> 1; snaps[m].recorded_at <= to ? lo = m + 1 : hi = m; }
    return snaps.slice(left, lo);
}

// Summe tatsächlich angefallener Fees aus aufeinanderfolgenden Snapshots.
// Verwendet Token-Mengen (fees_pending_a/b) wenn vorhanden → immunisiert gegen
// Preisbewegungen des Basisassets (z.B. SOL/BTC-Kursanstieg).
// Negative Sprünge (Claims) werden in beiden Varianten ignoriert.
function _deltaEarned(windowSnaps, volatileOpts = null, usdcIsTokenA = false) {
    let earned = 0;
    for (let i = 1; i < windowSnaps.length; i++) {
        const cur = windowSnaps[i];
        const prv = windowSnaps[i - 1];
        // Token-Mengen-Variante: preis-neutral (Standard seit Schema-Migration)
        if (cur.fees_pending_a != null && cur.fees_pending_b != null
                && cur.price != null && cur.price > 0) {
            const dA = cur.fees_pending_a - prv.fees_pending_a;
            const dB = cur.fees_pending_b - prv.fees_pending_b;
            // Nur positive Deltas zählen (Claims erscheinen als großer negativer Sprung)
            if (volatileOpts) {
                // volatilePair: quote-aware Umrechnung (z.B. SOL/HYPE).
                // Quote=tokenA: tokenA-USD = quotePrice; tokenB-USD = quotePrice / poolPrice
                // Quote=tokenB: tokenA-USD = poolPrice * quotePrice; tokenB-USD = quotePrice
                if (dA === 0 && dB === 0) {
                    const dUsd = cur.fees_pending_usd - prv.fees_pending_usd;
                    if (dUsd > 0) earned += dUsd;
                } else if (dA > 0 || dB > 0) {
                    const qUsd = volatileOpts.quoteUsdFn(cur.recorded_at);
                    if (qUsd > 0) {
                        const aUsd = volatileOpts.quoteIsTokenA ? qUsd : (cur.price * qUsd);
                        const bUsd = volatileOpts.quoteIsTokenA ? (qUsd / cur.price) : qUsd;
                        earned += Math.max(0, dA) * aUsd + Math.max(0, dB) * bUsd;
                    }
                }
            } else if (usdcIsTokenA) {
                // tokenA=USDC, tokenB=Quote (z.B. EURC). poolPrice = tokenB pro USDC.
                // tokenA-USD = 1 (USDC), tokenB-USD = 1 / poolPrice.
                if (dA > 0) earned += dA;
                if (dB > 0 && cur.price > 0) earned += dB / cur.price;
            } else {
                if (dA > 0) earned += dA * cur.price;
                if (dB > 0) earned += dB;
            }
        } else {
            // Fallback: USD-Delta für alte Snapshots ohne Token-Beträge
            const d = cur.fees_pending_usd - prv.fees_pending_usd;
            if (d > 0) earned += d;
        }
    }
    return earned;
}

// Helper: passende Earn-Optionen für einen Pool (volatileOpts ODER usdcIsTokenA ODER Standard)
function _earnOpts(poolId) {
    if (volatilePairPoolIds.has(poolId)) {
        const info = _volatilePoolInfo[poolId];
        return { volatileOpts: {
            quoteIsTokenA: info.quoteIsTokenA,
            quoteUsdFn:    (ts) => _quoteUsdAt(info.quotePricePoolId, ts),
        }, usdcIsTokenA: false };
    }
    return { volatileOpts: null, usdcIsTokenA: usdcIsTokenAPoolIds.has(poolId) };
}

const myAprHistory = myAprAllSnaps
    .filter(r => r.recorded_at >= thirtyDaysAgo)   // nur Chart-Fenster ausgeben
    .map(r => {
        if (!r.capital_usdc || r.capital_usdc <= 0) return null;
        const ageDays = (r.recorded_at - r.opened_at) / 86_400_000;
        if (ageDays < 1 / 96) return null;  // < ~15 Min: Division durch ~0 vermeiden

        const snaps = _snapsByPool[r.pool_id] ?? [];
        const windowStart = Math.max(r.opened_at, r.recorded_at - APR_WINDOW_MS);
        const windowSnaps = _snapsInRange(snaps, windowStart, r.recorded_at);
        if (windowSnaps.length < 2) return null;

        const periodDays = (windowSnaps.at(-1).recorded_at - windowSnaps[0].recorded_at) / 86_400_000;
        if (periodDays < APR_WINDOW_MIN / 86_400_000) return null;

        const _eo = _earnOpts(r.pool_id);
        const earned = _deltaEarned(windowSnaps, _eo.volatileOpts, _eo.usdcIsTokenA);
        if (earned <= 0) return null;
        const myApr  = round2((earned / r.capital_usdc) * (365 / periodDays) * 100);
        return { t: r.recorded_at, poolId: r.pool_id, myApr };
    })
    .filter(Boolean);

// Positionswert-Verlauf (USDC-Wert der aktuellen Position, letzte 30 Tage)
const posValueHistRaw = db.prepare(`
    SELECT ps.pool_id, ps.lp_value_usd, ps.amount_a, ps.amount_b, ps.il_usd, ps.recorded_at
    FROM position_snapshots ps
    JOIN positions p ON p.pool_id = ps.pool_id AND p.closed_at IS NULL
    WHERE ps.recorded_at >= ? AND ps.lp_value_usd > 0
    ORDER BY ps.pool_id, ps.recorded_at ASC
`).all(thirtyDaysAgo);
// Vertrag: amountA/amountB immer in displayPair-Reihenfolge (pairFlipMap).
const posValueHistory = posValueHistRaw.map(r => {
    const flip = pairFlipMap[r.pool_id] === true;
    const rawA = flip ? r.amount_b : r.amount_a;
    const rawB = flip ? r.amount_a : r.amount_b;
    return {
        t:       r.recorded_at,
        poolId:  r.pool_id,
        value:   round2(r.lp_value_usd),
        amountA: rawA != null ? round6(rawA) : null,
        amountB: rawB != null ? round6(rawB) : null,
        ilUsd:   r.il_usd != null ? round2(r.il_usd) : null,
    };
});

// PnL-Verlauf + 1d/7d-Metriken (Single Source of Truth: FORGE/lib/pnl.js).
// Methodik: per-Position-Lifecycle, cashflow-bereinigt (rollender Kapital-Anker).
// Identisches Ergebnis in pool-explorer.js.
const _pnlData = computePnlHistory(db, { flavor: config.botId, now: Date.now(), historyWindowMs: 30 * 24 * 3600 * 1000 });
const pnlHistory = _pnlData.pnlHistory;

// PnL kalender-ausgerichteter Perioden (Heute/Gestern/Monat).
//
// Heute:   pnlForPeriod() seit Tagesstart (Portfolio, alle Pools).
// Gestern: aus pnl_daily.pnl_value — null wenn noch kein Eintrag (→ "no data").
//          pnl_daily schreibt der Bot selbst über pnlForPeriod, ist also derselbe
//          Wert wie eine direkte Abfrage, nur vorberechnet.
// Monat:   pnlForPeriod() über den Kalendermonat (siehe unten).

const _pnlDailyRow   = date => db.prepare(`SELECT lp_close, pnl_value FROM pnl_daily WHERE date = ?`).get(date);
const _yesterdayIso  = new Intl.DateTimeFormat('en-CA', { timeZone: FORGE_TZ }).format(new Date(todayStartMs - 1));

// Heute: Portfolio-PnL seit 00:00 (Berlin) über die zentrale Lib.
const pnlToday = pnlForPeriod(db, { flavor: config.botId, fromMs: todayStartMs });

// Gestern: direkt aus pnl_daily.pnl_value (null = no data)
const pnlYesterday = _pnlDailyRow(_yesterdayIso)?.pnl_value ?? null;

// Monat: EINE Zeitraum-Abfrage derselben Quelle wie "heute" — nicht die Summe
// der pnl_daily-Tageswerte.
//
// Vereinheitlichung 2026-08-12: Beide Wege liefern seit der additiven
// earningsOut-Rechnung dasselbe Ergebnis, die Summe jedoch nur bis auf
// Rundungsdifferenzen (jeder Tageswert ist auf 2 Stellen gerundet, die Fehler
// addieren sich). Die direkte Abfrage ist die kürzere Kette, deckt Tage ohne
// pnl_daily-Eintrag mit ab und stimmt exakt mit der Übersichtsseite überein
// (analysis/01-export-status.js).
const pnlMonth = pnlForPeriod(db, { flavor: config.botId, fromMs: monthStartMs });

// Rollierender 24h-PnL: Portfolio-PnL über gleitendes 24h-Fenster (zentrale Lib).
const _now24hMs = Date.now() - 24 * 3600 * 1000;
const pnl24h    = pnlForPeriod(db, { flavor: config.botId, fromMs: _now24hMs });

// ─── dailyPnl: 30-Tage-Serie aus pnl_daily (für Dashboard-Übersicht 1W/1M) ──
// pnl_daily.pnl_value = Positionswert-Delta + Fees − TX-Fees (echter PnL).
// pnlToday ergänzt den laufenden heutigen Wert, der noch nicht in pnl_daily steht.
const _dpRows = db.prepare(`
    SELECT date, pnl_value FROM pnl_daily
    WHERE date >= ? AND date < ? AND pnl_value IS NOT NULL
    ORDER BY date ASC
`).all(_dayFmt.format(new Date(Date.now() - 30 * 86_400_000)), _todayIso);
const _dpMap = Object.fromEntries(_dpRows.map(r => [r.date, r.pnl_value]));
if (pnlToday != null) _dpMap[_todayIso] = pnlToday;

const dailyPnl = Array.from({ length: 30 }, (_, i) => {
    const day = _dayFmt.format(new Date(Date.now() - (29 - i) * 86_400_000));
    const pnl = _dpMap[day] ?? null;
    return { date: day, pnl: pnl != null ? round2(pnl) : null };
});

// ─── hourlyPnl: 24 Stunden-Buckets (für Dashboard-Übersicht 1D) ──────────────
// Methodik: Δ(kumulativer Portfolio-PnL aus pnlHistory) + Netto-Fee-Transfers.
// Fee-Transfer = claim − reinvest: Claims verlassen den LP-Wert → Korrektur nötig.
// Reinvestitionen bleiben im LP (lp_value_usd steigt) → kein Doppelzählen.
const hourlyPnl = [];
{
    const _nowHp = Date.now();
    // pnlHistory nach Pool indexieren (pnlHistory = computePnlHistory()-Ergebnis, s.o.)
    const _hpIdx = {};
    for (const e of pnlHistory) (_hpIdx[e.poolId] ??= []).push(e);

    // Kumulierter PnL aller Pools zum Zeitpunkt t (Binärsuche über sortierte Einträge)
    const _sumPnlAt = (t) => {
        let sum = 0;
        for (const arr of Object.values(_hpIdx)) {
            let lo = 0, hi = arr.length - 1, idx = -1;
            while (lo <= hi) { const mid = (lo + hi) >> 1; arr[mid].t <= t ? (idx = mid, lo = mid + 1) : hi = mid - 1; }
            if (idx >= 0) sum += arr[idx].pnlUsd;
        }
        return sum;
    };

    // Netto-Fee-Transfers (claim − reinvest) nach UTC-Stunden-Bucket
    const _feeTransByHour = {};
    for (const r of claimHistoryRows) {
        if (r.claimed_at < _nowHp - 25 * 3_600_000) continue;
        const hKey = Math.floor(r.claimed_at / 3_600_000) * 3_600_000;
        const delta = r.action === 'claim' ? (r.usd_value ?? 0) : -(r.usd_value ?? 0);
        _feeTransByHour[hKey] = (_feeTransByHour[hKey] ?? 0) + delta;
    }

    // 24 Buckets: ältester zuerst (h=23 = vor 23-24h, h=0 = letzte Stunde)
    for (let h = 23; h >= 0; h--) {
        const tEnd   = _nowHp - h * 3_600_000;
        const tStart = tEnd   - 3_600_000;
        const hKey   = Math.floor(tStart / 3_600_000) * 3_600_000;
        const lpDelta   = _sumPnlAt(tEnd) - _sumPnlAt(tStart);
        const feeTrans  = Math.max(0, _feeTransByHour[hKey] ?? 0);
        hourlyPnl.push({ t: tStart, pnl: round2(lpDelta + feeTrans) });
    }
}

// NP-Verlauf (Netto-Performance: kumulierte Fees + IL, inkl. geschlossener Positionen, letzte 30 Tage)
const npSnapshotRaw = db.prepare(`
    SELECT pool_id, il_usd, recorded_at
    FROM position_snapshots
    WHERE recorded_at >= ? AND lp_value_usd > 0 AND il_usd IS NOT NULL
    ORDER BY pool_id, recorded_at ASC
`).all(thirtyDaysAgo);

// Alle Fee-Claims (komplett, für korrekte kumulative Summe). position_id geht mit — für
// npHistory/currentNpUsd bewusst pool-weit über alle Sessions (Netto-Performance des Pools als
// Ganzes), für die tagesbezogenen Zähler unten (todayClaimCount/-Usd) wird auf die aktuelle
// Position eingegrenzt: derselbe Fehler wie im Claims-Modal (2026-08-22) — ein Pool mit
// mehreren Sessions am selben Tag zählte sonst auch hier die Claims aller Vorgänger mit.
const allFeeHistory = db.prepare(`
    SELECT pool_id, position_id, claimed_at, usd_value
    FROM fee_history
    WHERE usd_value IS NOT NULL
    ORDER BY pool_id, claimed_at ASC
`).all();

const feesByPool = {};
for (const f of allFeeHistory) {
    if (!feesByPool[f.pool_id]) feesByPool[f.pool_id] = [];
    feesByPool[f.pool_id].push(f);
}

const npHistory = [];
const npPoolIds = [...new Set(npSnapshotRaw.map(r => r.pool_id))];
for (const poolId of npPoolIds) {
    const snaps = npSnapshotRaw.filter(r => r.pool_id === poolId);
    const fees  = feesByPool[poolId] ?? [];
    let feeSum = 0, feeIdx = 0;
    for (const snap of snaps) {
        while (feeIdx < fees.length && fees[feeIdx].claimed_at <= snap.recorded_at) {
            feeSum += fees[feeIdx].usd_value;
            feeIdx++;
        }
        npHistory.push({ t: snap.recorded_at, poolId, npUsd: round2(feeSum + snap.il_usd) });
    }
}

// Netto-APR-Verlauf (pool_score_history, letzte 30 Tage) — für N-APR-Tab + Spalte
const scoreHistoryRaw = db.prepare(`
    SELECT pool_id, recorded_at, net_apr_pct
    FROM pool_score_history
    WHERE recorded_at >= ? AND net_apr_pct IS NOT NULL
    ORDER BY pool_id, recorded_at ASC
`).all(thirtyDaysAgo);
const scoreHistory = scoreHistoryRaw.map(r => ({
    t: r.recorded_at, poolId: r.pool_id, netAprPct: round2(r.net_apr_pct),
}));
const latestNetAprByPool = {};
for (const r of scoreHistoryRaw) latestNetAprByPool[r.pool_id] = r.net_apr_pct;
// netAprPct auch in poolsOverview eintragen (für "Verfügbare Pools" N-APR 24H-Spalte)
for (const po of poolsOverview) po.netAprPct = latestNetAprByPool[po.id] != null ? round2(latestNetAprByPool[po.id]) : null;

// Trailing-Stop-Advisor-Empfehlung je Pool (LIQ#0351). Geht ins Dashboard-JSON, damit
// ForgeSettings auf Master und Fork denselben Lesepfad hat — genau wie `scoreSource`.
//
// 🔒 „Zustand immer sichtbar": Die Oberfläche muss die Auto-Checkbox sperren können, wenn
// keine belastbare Empfehlung vorliegt, UND begründen warum. Ein Schalter, den man
// einschalten kann, ohne dass er wirkt, ist schlimmer als kein Schalter — dieselbe
// Entscheidung wie beim Score-Limit (Commit bf8c723).
for (const po of poolsOverview) {
    let res = null;
    try { res = loadTsAdvice(db, po.id, po.poolType); } catch { res = null; }
    po.tsAdvice = res?.advice
        ? {
            available:     true,
            source:        res.source,
            thresholdPct:  res.advice.thresholdPct,
            thresholdPct2: res.advice.thresholdPct2,
            // 'pool' = gemessen · 'pool_model' = aus der Preisreihe modelliert · 'pool_type'
            scope:         res.advice.scope,
            episodes:      res.advice.episodes,
            reason:        res.advice.reason,
        }
        : { available: false, source: res?.source ?? 'none', reason: null };
}

// Composition-Verlauf (Token-Anteile, letzte 30 Tage aus position_snapshots)
const compHistRaw = db.prepare(`
    SELECT ps.pool_id, ps.amount_a, ps.amount_b, ps.price, ps.recorded_at
    FROM position_snapshots ps
    JOIN positions p ON p.pool_id = ps.pool_id AND p.closed_at IS NULL
    WHERE ps.recorded_at >= ? AND ps.amount_a IS NOT NULL AND ps.amount_b IS NOT NULL
    ORDER BY ps.pool_id, ps.recorded_at ASC
`).all(thirtyDaysAgo);

// Vertrag: amountA/amountB/pctA immer in displayPair-Reihenfolge (pairFlipMap).
// pctA = % des ersten Tokens des displayPair.
const compositionHistory = compHistRaw.map(r => {
    const cfg   = _allPoolsConfig.find(p => p.id === r.pool_id);
    const flip  = pairFlipMap[r.pool_id] === true;
    let valueA, valueB;
    if (cfg?.usdcIsTokenA) {
        valueA = r.amount_a;
        valueB = r.price > 0 ? r.amount_b / r.price : 0;
    } else if (cfg?.volatilePair) {
        const quoteIsTokenA = cfg.quoteTokenMint === cfg.tokenA;
        if (quoteIsTokenA) {
            valueA = r.amount_a;
            valueB = r.price > 0 ? r.amount_b / r.price : 0;
        } else {
            valueA = r.amount_a * r.price;
            valueB = r.amount_b;
        }
    } else {
        valueA = r.amount_a * r.price;
        valueB = r.amount_b;
    }
    const total = valueA + valueB;
    if (total <= 0) return null;
    const pctInternal = Math.round(valueA / total * 1000) / 10;
    const rawA = flip ? r.amount_b : r.amount_a;
    const rawB = flip ? r.amount_a : r.amount_b;
    return {
        t:       r.recorded_at,
        poolId:  r.pool_id,
        amountA: round6(rawA),
        amountB: round6(rawB),
        pctA:    flip ? Math.round((100 - pctInternal) * 10) / 10 : pctInternal,
    };
}).filter(Boolean);

// TVL-Verlauf (letzte 30 Tage, 1 Punkt/Stunde aus pool_stats)
const tvlHistRaw = db.prepare(`
    SELECT pool_id, tvl_usd, recorded_at FROM pool_stats
    WHERE recorded_at >= ? ORDER BY recorded_at ASC
`).all(Date.now() - 30 * 86_400_000);
const tvlHistory = tvlHistRaw.map(r => ({
    t: r.recorded_at, poolId: r.pool_id, tvl: Math.round(r.tvl_usd ?? 0),
}));

// Volume-Verlauf (letzte 30 Tage, stündliche Candles aus GeckoTerminal)
const volHistRaw = db.prepare(`
    SELECT pool_id, ts, volume_usd FROM volume_hourly
    WHERE ts >= ? ORDER BY ts ASC
`).all(thirtyDaysAgo);

const volumeHistory = volHistRaw.map(r => ({
    t:      r.ts,
    poolId: r.pool_id,
    volume: round2(r.volume_usd),
}));

// Letzte 25 Transaktionen
const txRows = db.prepare(`
    SELECT t.*, pl.pair
    FROM transactions t
    LEFT JOIN pools pl ON t.pool_id = pl.id
    ORDER BY t.created_at DESC LIMIT 25
`).all();

// Letzte 25 Fee-Claims pro Pool (unabhängig vom allgemeinen TX-Limit)
const recentClaimRows = db.prepare(`
    SELECT t.*, pl.pair
    FROM transactions t
    LEFT JOIN pools pl ON t.pool_id = pl.id
    WHERE t.type IN ('claim', 'reinvest')
    ORDER BY t.created_at DESC LIMIT 25
`).all();

// Safety-Net: usd_value-Fallback aus amount_a/amount_b + Pool-Preis berechnen,
// falls bei der Insertion vergessen wurde, damit Dashboard nie "—" zeigt.
// Sollte nicht passieren — daher loggen wir jeden Treffer als Warning,
// damit fehlende usdValue-Zuweisungen sofort sichtbar werden.
const _poolCfgById = Object.fromEntries(poolsConfigRaw.map(p => [p.id, p]));
function _fallbackUsdValue(t) {
    const cfg   = _poolCfgById[t.pool_id];
    const pool  = pools.find(p => p.id === t.pool_id);
    if (!cfg || !pool) return null;
    const aA = t.amount_a, aB = t.amount_b;
    if (aA == null && aB == null) return null;
    const price = latestStats[t.pool_id]?.price ?? 0;
    const a = aA ?? 0, b = aB ?? 0;
    let usd = null;
    if (cfg.usdcIsTokenA) {
        usd = a + (price > 0 ? b / price : 0);
    } else if (cfg.volatilePair) {
        const arr = _quotePriceArrByPool[cfg.quotePricePoolId] ?? [];
        const qP  = arr.length ? arr[arr.length - 1].price : 0;
        if (qP > 0) {
            const quoteIsA = cfg.quoteTokenMint === pool.token_a;
            usd = quoteIsA ? (a + (price > 0 ? b / price : 0)) * qP
                           : (a * price + b) * qP;
        }
    } else {
        usd = a * price + b;
    }
    if (usd != null && Number.isFinite(usd)) {
        console.warn(`export.js: usd_value-Fallback für TX ${t.id ?? t.tx_hash ?? '?'} (${t.type}, pool=${t.pool_id}) → ${usd.toFixed(4)} USDC — bitte usdValue an der Quelle setzen`);
        return usd;
    }
    return null;
}

const mapTx = t => {
    // DB speichert amount_a/amount_b in pair-Reihenfolge (chain-Reihenfolge).
    // Wenn das Pool eine gedrehte displayPair hat (z.B. SOL/HYPE → HYPE/SOL),
    // müssen die Mengen für die Dashboard-Anzeige getauscht werden, damit
    // amount_a zur ersten Token-Spalte und amount_b zur zweiten passt.
    const flip   = pairFlipMap[t.pool_id] === true;
    const rawA   = t.amount_a;
    const rawB   = t.amount_b;
    const dispA  = flip ? rawB : rawA;
    const dispB  = flip ? rawA : rawB;
    // Bei gedrehten Pools ist die "zweite Spalte" oft nicht USDC, sondern ein
    // volatiler Token. round2 wäre dort ein Präzisionsverlust — daher in dem
    // Fall round6 für beide Seiten verwenden.
    return {
        createdAt: t.created_at,
        type:      t.type,
        note:      t.note ?? null,
        pool:      displayPairMap[t.pool_id] ?? t.pair ?? null, // angezeigter Pool-Name (displayPair)
        pair:      t.pair ?? null,                              // internes pair, nur für Anzeige/Spalten-Labels
        poolId:    t.pool_id ?? null,                           // eindeutiges Filter-Matching (data-pool-id, LIQ#0471)
        amount:    round2(t.usd_value ?? _fallbackUsdValue(t)),
        amountA:   dispA != null ? round6(dispA) : null,
        amountB:   dispB != null ? (flip ? round6(dispB) : round2(dispB)) : null,
        txHash:    t.tx_hash ?? null,
        txFeeSol:  t.tx_fee_sol != null ? round6(t.tx_fee_sol) : null,
    };
};
const transactions = txRows.map(mapTx);
const recentClaims = recentClaimRows.map(mapTx);

// Letzte Rebalancings — Fenster: Monatsanfang (Europe/Berlin) bis jetzt.
// Dashboard zeigt Tagescount in "Aktive Pools" + Modal mit Tabs Heute/Gestern/Monat.
// Berlin-Monatsanfang via Intl, dann zurück zu Unix-ms.
const _tzFmt   = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
const _todayBerlin = _tzFmt.format(new Date());     // "2026-05-22"
const _monthStartMs = new Date(`${_todayBerlin.slice(0,7)}-01T00:00:00+02:00`).getTime()
                    || new Date(`${_todayBerlin.slice(0,7)}-01T00:00:00+01:00`).getTime();

// JOIN auf positions.open_tx (neue Position) für Solscan-Link,
// und auf den letzten position_snapshot VOR dem Rebalance-Event für "Mein Anteil".
// Snapshots laufen alle 5 Min, also liegt der Wert max. 5 Min vor dem Close-TX.
const rebalanceRows = db.prepare(`
    SELECT rh.id, rh.pool_id, rh.reason, rh.price_at_event, rh.cost_sol, rh.rebalanced_at,
           rh.old_position_id, rh.new_position_id,
           pl.pair,
           np.open_tx AS tx_hash,
           (SELECT lp_value_usd
              FROM position_snapshots
             WHERE pool_id = rh.pool_id
               AND recorded_at <= rh.rebalanced_at
             ORDER BY recorded_at DESC
             LIMIT 1) AS lp_value_at_event
    FROM rebalance_history rh
    JOIN pools     pl ON rh.pool_id          = pl.id
    LEFT JOIN positions np ON rh.new_position_id = np.id
    WHERE rh.rebalanced_at >= ?
    ORDER BY rh.rebalanced_at DESC
`).all(_monthStartMs);

const rebalances = rebalanceRows.map(r => ({
    id:              r.id,
    poolId:          r.pool_id,
    // pair = INTERNAL pair (für Frontend-Matching gegen pos.pair). displayPair separat.
    pair:            r.pair,
    displayPair:     displayPairMap[r.pool_id] ?? r.pair,
    displayLabel:    displayLabelMap[r.pool_id] ?? r.pair,
    reason:          r.reason,
    priceAtEvent:    roundPrice(r.price_at_event),
    costSol:         round6(r.cost_sol),
    rebalancedAt:    r.rebalanced_at,
    lpValueAtEvent:  r.lp_value_at_event != null ? round2(r.lp_value_at_event) : null,
    txHash:          r.tx_hash ?? null,
}));

// Letzte 50 Benachrichtigungen aus lokaler Bot-DB (direkt geschriebene Einträge)
const notifRows = db.prepare(`
    SELECT id, pool_id, level, message, created_at
    FROM notifications
    WHERE level IN ('warn', 'warning', 'error', 'lifecycle')
      AND read = 0
      AND created_at >= ?
    ORDER BY created_at DESC LIMIT 50
`).all(Date.now() - 12 * 3_600_000);

const localNotifs = notifRows.map(n => ({
    id:      `bot-${n.id}`,
    level:   n.level,
    message: n.message.replace(/\nTX:[^\n]*/g, '').trim(),
    ts:      n.created_at,
}));

// Benachrichtigungen aus zentraler nexus.db (alle via Nexus-Pipeline gesendeten Events)
// Enthält: fee claims (info/trade), rebalancings (lifecycle/trade), Fehler (error) etc.
const NEXUS_DB_PATH = PATHS.nexusDb;
let nexusNotifs = [];
try {
    const nexusDb = new Database(NEXUS_DB_PATH, { readonly: true });
    const nexusRows = nexusDb.prepare(`
        SELECT id, level, category, message, context, timestamp AS created_at,
               timestamp, display_name, msg_key, msg_params
        FROM notifications
        WHERE bot_id = ?
          AND timestamp >= ?
          AND category != 'range-advisor'
        ORDER BY timestamp DESC LIMIT 50
    `).all(config.botId, Date.now() - 12 * 3_600_000);
    nexusNotifs = nexusRows.map(n => {
        let pool = null;
        if (n.context) { try { pool = JSON.parse(n.context)?.pair ?? null; } catch {} }
        return {
            id:      `nx-${n.id}`,
            level:   n.level,
            // Text erst hier erzeugen (Mehrsprachigkeit Schritt 5) – Altzeilen
            // ohne msg_key fallen auf den gespeicherten Text zurück.
            message: notificationText(n).replace(/\nTX:[^\n]*/g, '').trim(),
            ts:      n.created_at,
            pool,
        };
    });
    nexusDb.close();
} catch (e) {
    console.warn(`export.js: nexus.db nicht lesbar – ${e.message}`);
}

// Maintenance-Flag + History: lifecycle-Notifications unterdrücken die während
// eines Wartungsfensters erstellt wurden (auch nach --off persistent).
const maintenanceFlag    = readMaintenanceFlag();
const maintenanceWindows = getMaintenanceWindows();
const _notifRaw = [...nexusNotifs, ...localNotifs]
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
const _isDuringMaintenance = (ts) =>
    maintenanceWindows.some(w => ts >= w.startedAt && ts <= w.endedAt);
const notifications = _notifRaw
    .filter(n => n.level !== 'lifecycle' || !_isDuringMaintenance(n.ts ?? 0))
    .slice(0, 50);

// ─── PnL heute pro Pool (für Tooltip in Operative Metriken) ──────────────────
// Zentrale Lib: identische Kurven-Methodik wie pnlWindows/pnl1d → garantiert
// konsistent mit der Opportunity-Tabelle. Kein PnL-Code in diesem Bot.
const _todayPnlByPool = pnlByScopeForPeriod(db, { flavor: config.botId, fromMs: todayStartMs });

// ─── PnL seit letzter Einzahlung pro Pool (Tooltip-Zeile 2) ──────────────────
// "Letzte Einzahlung" = letzter ECHTER externer Kapitalzufluss (capital_flows,
// is_external=1) — schließt den initialen Pool-Open mit ein, aber NICHT
// interne Reconcile-/Cleanup-Redeploys (is_external=0). Auf die Laufzeit der
// AKTUELL offenen Position begrenzt (created_at >= opened_at): sonst würde nach
// einer vollständigen Withdraw+Reopen-Runde noch eine Einzahlung einer längst
// geschlossenen Vorgänger-Position als "letzte Einzahlung" angezeigt (Kapital
// war zwischenzeitlich komplett draußen). Ohne echte externe Einzahlung seit
// dem aktuellen Reopen (z.B. Withdraw+Cleanup-Reopen) fällt der Bezugspunkt auf
// pos.opened_at zurück — die Kurvenlogik in pnl.js verankert den PnL dann korrekt
// am Einstand der aktuellen Session. Für jeden Pool dann pnlForPeriod ab diesem
// Zeitpunkt — identische Lib wie oben, kein eigener PnL-Code.
const _lastDepositAtByPool = Object.fromEntries(
    db.prepare(`
        SELECT cf.pool_id AS pool_id, MAX(cf.created_at) AS t
          FROM capital_flows cf
          JOIN positions p ON p.pool_id = cf.pool_id AND p.closed_at IS NULL
         WHERE cf.usdc_amount > 0 AND cf.is_external = 1 AND cf.created_at >= p.opened_at
         GROUP BY cf.pool_id
    `).all().map(r => [r.pool_id, r.t])
);
const _sinceDepositPnlByPool = Object.fromEntries(
    openPositions.map(pos => {
        const fromMs = resolvePnlAnchorMs(_lastDepositAtByPool[pos.pool_id], pos.pnl_anchor_reset_at, pos.opened_at);
        return [pos.pool_id, pnlForPeriod(db, { flavor: config.botId, scope: pos.pool_id, fromMs })];
    })
);

// ─── Kapitalfluss-Zähler seit demselben Anker (PnL-Details-Tab, "Einzahlung (gesamt)") ──
// Bewusst OHNE is_external-Filter: ein Cleanup-/Reconcile-Nachschuss (is_external=0) darf
// den PnL-Anker selbst nicht verschieben (siehe pnl-anchor.js, dort verankert für
// trailing-stop.js/exit-finalizer.js) — aber er soll in der Anzeige sichtbar werden, dass
// seit dem Anker mehr als eine Kapitalbewegung stattfand. depositValueUsd (unten) erfasst
// den Betrag ohnehin schon korrekt (Rückrechnung aus der bereits kapitalfluss-bereinigten
// PnL-Kurve) — hier nur Zähler + letztes Datum für die Beschriftung.
const _depositEventsByPool = Object.fromEntries(
    openPositions.map(pos => {
        const fromMs = resolvePnlAnchorMs(_lastDepositAtByPool[pos.pool_id], pos.pnl_anchor_reset_at, pos.opened_at);
        const row = db.prepare(`
            SELECT COUNT(*) AS cnt, MAX(created_at) AS latest
              FROM capital_flows
             WHERE pool_id = ? AND usdc_amount > 0 AND created_at >= ?
        `).get(pos.pool_id, fromMs);
        return [pos.pool_id, { count: row?.cnt ?? 0, latestAt: row?.latest ?? null }];
    })
);

// ─── Nicht reinvestierter Rest seit Anker pro Pool (PnL-Details-Tab, LIQ#000558) ──
// Bei jedem Rebalance kann ein Teil des freigesetzten Kapitals im Wallet liegen bleiben
// (siehe bin/bot.js, insertRebalanceHistory: leftoverUsdc). Das ist KEIN Verlust — das
// Kapital gehört weiterhin dem Nutzer, nur eben nicht in dieser Position. Summe seit
// demselben PnL-Anker wie depositValueUsd, damit beide Zahlen zueinander passen (ein
// Reopen/neue Einzahlung setzt beide zurück).
const _leftoverSinceDepositByPool = Object.fromEntries(
    openPositions.map(pos => {
        const fromMs = resolvePnlAnchorMs(_lastDepositAtByPool[pos.pool_id], pos.pnl_anchor_reset_at, pos.opened_at);
        const row = db.prepare(`
            SELECT COALESCE(SUM(leftover_usdc), 0) AS sum, COUNT(*) AS n
              FROM rebalance_history
             WHERE pool_id = ? AND rebalanced_at >= ? AND leftover_usdc IS NOT NULL AND leftover_usdc > 0
        `).get(pos.pool_id, fromMs);

        if (row?.n > 0) return [pos.pool_id, { sumUsd: row.sum, rebalanceCount: row.n, estimated: false }];

        // 🧪 TEMPORÄRER NÄHERUNGS-FALLBACK, siehe LIQ#000559 (Ticket: entfernen sobald
        // reale leftover_usdc-Daten vorliegen). Für Rebalances VOR diesem Deploy fehlt
        // leftover_usdc (NULL) — hier nur zur sofortigen visuellen Prüfung des Modal-Designs
        // grob genähert aus lp_value_before/after. Verzerrt durch TX-Kosten/Slippage/
        // Preisbewegung während des Rebalance (siehe Ticketrecherche LIQ#000558) — deshalb
        // klar als "geschätzt" markiert, NIE als belastbare PnL-Zahl verwenden.
        const approxRow = db.prepare(`
            SELECT COALESCE(SUM(MAX(lp_value_before_usdc - lp_value_after_usdc, 0)), 0) AS sum, COUNT(*) AS n
              FROM rebalance_history
             WHERE pool_id = ? AND rebalanced_at >= ? AND leftover_usdc IS NULL
               AND lp_value_before_usdc IS NOT NULL AND lp_value_after_usdc IS NOT NULL
        `).get(pos.pool_id, fromMs);
        return [pos.pool_id, { sumUsd: approxRow?.sum ?? 0, rebalanceCount: approxRow?.n ?? 0, estimated: (approxRow?.n ?? 0) > 0 }];
    })
);

// ─── Historischer PnL-Höchststand seit Anker pro Pool (Tooltip-Zeile "Hoch") ──
// Selber Anker (fromMs) wie oben — zeigt, wann/wie hoch der Pool prozentual am
// weitesten im Plus stand. Hilft abzuschätzen, wo ein aktiver Trailing-Stop
// (Referenz: positions.hwm_usd, siehe lib/trailing-stop.js) auslösen würde.
const _peakPnlByPool = Object.fromEntries(
    openPositions.map(pos => {
        const fromMs = resolvePnlAnchorMs(_lastDepositAtByPool[pos.pool_id], pos.pnl_anchor_reset_at, pos.opened_at);
        return [pos.pool_id, pnlPeakForPeriod(db, { flavor: config.botId, scope: pos.pool_id, fromMs })];
    })
);

// ─── Fee-Leg / Preis-Leg pro Pool (LIQ#0360, Tooltip-Zerlegung) ──────────────
// Fee-Leg = vereinnahmte Handelsgebühren (nie negativ), Preis-Leg = Rest von
// pnlForPeriod. Zentrale Lib: feeLegForPeriod() aus lib/pnl.js — Preis-Leg wird
// hier bewusst NICHT eigenständig berechnet, sondern nur als Differenz gebildet.
const _todayFeeLegByPool = Object.fromEntries(
    openPositions.map(pos => [pos.pool_id, feeLegForPeriod(db, { flavor: config.botId, scope: pos.pool_id, fromMs: todayStartMs })])
);
const _sinceDepositFeeLegByPool = Object.fromEntries(
    openPositions.map(pos => {
        const fromMs = resolvePnlAnchorMs(_lastDepositAtByPool[pos.pool_id], pos.pnl_anchor_reset_at, pos.opened_at);
        return [pos.pool_id, feeLegForPeriod(db, { flavor: config.botId, scope: pos.pool_id, fromMs })];
    })
);

// ─── Positions-Objekte aufbauen ────────────────────────────────────────────────

function buildPosition(pos, isActive) {
    const stats    = latestStats[pos.pool_id] ?? null;
    const priceNow = stats?.price ?? null;
    const flip     = pairFlipMap[pos.pool_id] === true;

    // Per-Pool-Snapshot für myValue, Fees, IL (Multi-Pool-fähig)
    const posSnap = db.prepare(`
        SELECT * FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1
    `).get(pos.pool_id);

    // Meine APR: Summe positiver Fee-Deltas im APR_WINDOW_MS-Fenster.
    // Kurzes Fenster → zeigt die aktuelle Marktlage, nicht historische Spikes.
    // Claims erscheinen als negativer Sprung und werden ignoriert.
    let myApr = null;
    const poolApr = round2(stats?.apr_24h ?? null);
    if (isActive && pos.capital_usdc > 0) {
        const ageMs = Date.now() - pos.opened_at;
        const ageDays = ageMs / 86_400_000;
        if (ageDays >= 1 / 96) {  // mind. ~15 Min alt
            const periodStart = Math.max(pos.opened_at, Date.now() - APR_WINDOW_MS);
            const periodSnaps = db.prepare(`
                SELECT fees_pending_usd, fees_pending_a, fees_pending_b, price, recorded_at
                FROM position_snapshots
                WHERE pool_id = ? AND recorded_at >= ?
                ORDER BY recorded_at ASC
            `).all(pos.pool_id, periodStart);

            if (periodSnaps.length >= 2) {
                const _eo        = _earnOpts(pos.pool_id);
                const earned     = _deltaEarned(periodSnaps, _eo.volatileOpts, _eo.usdcIsTokenA);
                const periodDays = (periodSnaps.at(-1).recorded_at - periodSnaps[0].recorded_at) / 86_400_000;
                // earned = 0 → nicht als 0% ausgeben (Mess-Artefakt durch Sub-Satoshi-Präzision
                // oder kurze Out-of-Range-Phase). null → Frontend fällt auf pool apr24h zurück.
                if (periodDays >= APR_WINDOW_MIN / 86_400_000 && earned > 0) {
                    myApr = round2((earned / pos.capital_usdc) * (365 / periodDays) * 100);
                }
            }
        }
    }

    // Vertrag: amountA/amountB in displayPair-Reihenfolge (pairFlipMap).
    const posAmtA = (flip ? posSnap?.amount_b : posSnap?.amount_a) ?? null;
    const posAmtB = (flip ? posSnap?.amount_a : posSnap?.amount_b) ?? null;

    // Trailing-Stop-Status für das Hammer-Icon im Dashboard (Anteil-Spalte, Operative
    // Metriken): dieselben Funktionen wie der Bot selbst (evaluateTsTrigger), damit Icon
    // und tatsächliches Auslöseverhalten nie auseinanderlaufen. Nur für offene Positionen —
    // eine geschlossene Position hat keinen aktiven Stop mehr.
    let trailingStop = null;
    if (isActive) {
        try {
            const cfg = loadTsConfig(pos.pool_id, { db, poolType: poolTypeMap[pos.pool_id] ?? null });
            if (cfg?.enabled) {
                const valueUsd = (posSnap?.lp_value_usd ?? 0) + Math.max(posSnap?.fees_pending_usd ?? 0, 0);
                const trig = evaluateTsTrigger(cfg, pos, valueUsd);
                const minValueUsd = Number(cfg.minimumValueUsd) || 0;
                // Auslösung greift bei Unterschreiten des HÖHEREN der beiden Böden
                // (Drawdown ODER absoluter Mindestwert, siehe evaluateTsTrigger).
                const liquidateAtUsd = Math.max(trig.triggerAt ?? 0, minValueUsd);

                // Projizierter PnL bei Auslösung: KEINE neue PnL-Formel — lib/pnl.js führt
                // den PnL der offenen Session als `cumRealized + (Positionswert − Einstand)`
                // (siehe lpValueAt/currentValue, Definition Modulkopf lib/pnl.js). Eine
                // Änderung des Positionswerts um Δ verschiebt den PnL exakt um Δ, weil
                // cumRealized und Einstand vom aktuellen Wert unabhängig sind. Also wird
                // hier lediglich der bereits über pnlForPeriod() ermittelte
                // `sinceDepositPnlUsd` um genau die Wertdifferenz zum Auslöse-Niveau
                // verschoben — dieselbe Kurve, an einem hypothetischen Wert ausgewertet.
                const sinceDepositPnlUsd = _sinceDepositPnlByPool[pos.pool_id] ?? null;
                const liquidatePnlUsd = (liquidateAtUsd > 0 && sinceDepositPnlUsd != null)
                    ? round2(sinceDepositPnlUsd + (liquidateAtUsd - valueUsd))
                    : null;
                const liquidatePnlPct = (liquidatePnlUsd != null && valueUsd > 0)
                    ? round2((liquidatePnlUsd / valueUsd) * 100)
                    : null;

                trailingStop = {
                    enabled:            true,
                    thresholdPct:       Number.isFinite(cfg.thresholdPct) ? round2(cfg.thresholdPct) : null,
                    thresholdPct2:      cfg.thresholdPct2 != null && Number.isFinite(Number(cfg.thresholdPct2)) ? round2(Number(cfg.thresholdPct2)) : null,
                    activeStage:        trig.stage,
                    activeThresholdPct: round2(trig.thresholdPct),
                    drawdownPct:        round2(trig.drawdownPct),
                    liquidateAtUsd:     liquidateAtUsd > 0 ? round2(liquidateAtUsd) : null,
                    liquidatePnlUsd,
                    liquidatePnlPct,
                };
            }
        } catch { trailingStop = null; }
    }

    const myValueUsd = round2(posSnap?.lp_value_usd ?? null);

    return {
        id:                 pos.id,
        poolId:             pos.pool_id,
        protocol:           pos.protocol === 'orca' ? 'Orca Whirlpools' : pos.protocol,
        pair:               pos.pair,
        displayPair:        displayPairMap[pos.pool_id] ?? pos.pair,
        displayLabel:       displayLabelMap[pos.pool_id] ?? pos.pair,
        apr24h:             poolApr,
        myApr,
        myValue:            myValueUsd,
        amountA:            posAmtA != null ? round6(posAmtA) : null,
        amountB:            posAmtB != null ? round6(posAmtB) : null,
        feesPendingUsd:     isActive ? round4(posSnap?.fees_pending_usd ?? null) : null,
        todayClaimCount:    (feesByPool[pos.pool_id] ?? []).filter(f => f.claimed_at >= todayStartMs && (f.position_id == null || f.position_id === pos.id)).length,
        todayClaimUsd:      round2((feesByPool[pos.pool_id] ?? []).filter(f => f.claimed_at >= todayStartMs && (f.position_id == null || f.position_id === pos.id)).reduce((s, f) => s + (f.usd_value ?? 0), 0)),
        todayPnlUsd:        _todayPnlByPool[pos.pool_id] ?? null,
        todayFeeLegUsd:     _todayFeeLegByPool[pos.pool_id] ?? null,
        todayPriceLegUsd:   (_todayPnlByPool[pos.pool_id] != null && _todayFeeLegByPool[pos.pool_id] != null)
                                ? round2(_todayPnlByPool[pos.pool_id] - _todayFeeLegByPool[pos.pool_id]) : null,
        sinceDepositAt:     resolvePnlAnchorMs(_lastDepositAtByPool[pos.pool_id], pos.pnl_anchor_reset_at, pos.opened_at),
        sinceDepositSource: resolvePnlAnchorSource(_lastDepositAtByPool[pos.pool_id], pos.pnl_anchor_reset_at, pos.opened_at),
        // >1, wenn seit dem Anker mehr als eine Kapitalbewegung stattfand (z.B. Cleanup-
        // Nachschuss nach der letzten externen Einzahlung) — steuert das "(gesamt)"-Label
        // im PnL-Details-Tab. depositLatestAt ist das Datum der jüngsten davon (kann von
        // sinceDepositAt abweichen, wenn diese Bewegung intern war).
        depositCount:       _depositEventsByPool[pos.pool_id]?.count ?? null,
        depositLatestAt:    _depositEventsByPool[pos.pool_id]?.latestAt ?? null,
        // Summe der Rebalance-Reste seit dem Anker, die nicht reinvestiert wurden — liegen
        // weiterhin im Wallet (siehe insertRebalanceHistory.leftoverUsdc). 0, wenn seit dem
        // Anker noch kein Rebalance mit Rest stattfand (auch für Altbestände vor LIQ#000558,
        // deren rebalance_history-Zeilen kein leftover_usdc kennen).
        walletLeftoverUsd:      round2(_leftoverSinceDepositByPool[pos.pool_id]?.sumUsd ?? 0),
        walletLeftoverRebalances: _leftoverSinceDepositByPool[pos.pool_id]?.rebalanceCount ?? 0,
        // 🧪 TEMPORÄR, siehe LIQ#000559 — true, solange der Wert oben aus dem
        // Näherungs-Fallback stammt (Altbestand ohne echtes leftover_usdc).
        walletLeftoverEstimated: _leftoverSinceDepositByPool[pos.pool_id]?.estimated ?? false,
        sinceDepositPnlUsd: _sinceDepositPnlByPool[pos.pool_id] ?? null,
        sinceDepositFeeLegUsd:   _sinceDepositFeeLegByPool[pos.pool_id] ?? null,
        sinceDepositPriceLegUsd: (_sinceDepositPnlByPool[pos.pool_id] != null && _sinceDepositFeeLegByPool[pos.pool_id] != null)
                                ? round2(_sinceDepositPnlByPool[pos.pool_id] - _sinceDepositFeeLegByPool[pos.pool_id]) : null,
        // depositValueUsd = Gegenwert zum Einzahlungs-/Anker-Zeitpunkt, aus bereits von
        // lib/pnl.js gelieferten Zahlen zurückgerechnet (myValue − PnL seit Anker) — KEINE
        // eigene PnL-Berechnung, nur Differenzbildung zweier fertiger pnl.js-Werte. Für den
        // Anteil-Modal-Tab "PnL-Details" (LIQ, Anteil-Tooltip-Ablösung).
        depositValueUsd:    (myValueUsd != null && _sinceDepositPnlByPool[pos.pool_id] != null)
                                ? round2(myValueUsd - _sinceDepositPnlByPool[pos.pool_id]) : null,
        peakPnlUsd:         _peakPnlByPool[pos.pool_id]?.pnlUsd ?? null,
        peakPnlAt:          _peakPnlByPool[pos.pool_id]?.atMs ?? null,
        // peakValueUsd = Gegenwert am Höchststand, wieder nur Summe zweier fertiger
        // pnl.js-Werte (depositValueUsd + peakPnlUsd), keine eigene PnL-Berechnung.
        peakValueUsd:       (_peakPnlByPool[pos.pool_id]?.pnlUsd != null && myValueUsd != null && _sinceDepositPnlByPool[pos.pool_id] != null)
                                ? round2((myValueUsd - _sinceDepositPnlByPool[pos.pool_id]) + _peakPnlByPool[pos.pool_id].pnlUsd) : null,
        inRange:            isActive ? (priceNow != null
                                ? priceNow >= pos.price_lower && priceNow <= pos.price_upper
                                : null)
                                : false,
        active:             isActive,
        priceLower:         roundPrice(pos.price_lower),
        priceUpper:         roundPrice(pos.price_upper),
        priceNow:           roundPrice(priceNow),
        priceUnit:          priceUnitMap[pos.pool_id] ?? null,
        impermanentLossUsd: round2(posSnap?.il_usd ?? null),
        impermanentLossPct: round2(posSnap?.il_pct ?? null),
        currentNpUsd:       posSnap?.il_usd != null
                                ? round2((feesByPool[pos.pool_id] ?? []).filter(f => f.claimed_at <= posSnap.recorded_at).reduce((s, f) => s + f.usd_value, 0) + posSnap.il_usd)
                                : null,
        nftMint:            pos.nft_mint,
        positionId:         pos.id,
        openedAt:           pos.opened_at,
        closedAt:           pos.closed_at ?? null,
        trailingStop,
    };
}

const positionsOut = [
    // isActive=false wenn Pool in der DB auf active=false steht (z.B. nach Trailing-Stop-Exit
    // der fehlschlug) — verhindert dass Operative Metriken inaktive Pools weiter anzeigt.
    ...openPositions.map(p => buildPosition(p, activeFromConfig[p.pool_id] !== false)),
    ...closedPositions.map(p => buildPosition(p, false)),
];

// ─── sortApr + geschätzter APR 24H für Pools mit eingefrorenem Orca-Wert ──────

/**
 * Effektiver Fee-Satz eines Pools in % für die APR-Schätzung — der gemessene
 * 24h-Ist-Satz (`fees_24h_usd / volume_24h_usd`), sonst der konfigurierte Tier.
 *
 * ⚠️ Bei Adaptive-Fee-Pools ist `pools.fee_tier` nur die Untergrenze; eine APR-Schätzung
 * auf der Konstante fällt dort systematisch zu niedrig aus (LIQ#0394, `lib/effective-fee.js`).
 */
function _effectiveFeeTier(poolId, staticPct) {
    const row = db.prepare(`
        SELECT fees_24h_usd, volume_24h_usd FROM pool_stats
        WHERE pool_id = ? AND fees_24h_usd IS NOT NULL
        ORDER BY recorded_at DESC LIMIT 1
    `).get(poolId);
    return effectiveFeePct(staticPct, {
        fees24hUsd:   row?.fees_24h_usd   ?? null,
        volume24hUsd: row?.volume_24h_usd ?? null,
    }).pct;
}

// myApr je Pool aus aktiven Positionen sammeln
const myAprByPool = {};
for (const p of positionsOut) {
    if (p.active && p.myApr != null) myAprByPool[p.poolId] = p.myApr;
}

// Für Pools mit eingefrorenem Orca-APR: eigenen APR berechnen.
// Priorisierung:
//   1. Aktive Pools mit investiertem Kapital → APR aus eigenen position_snapshots (genau)
//   2. Alle Pools (aktiv oder inaktiv) → APR aus GeckoTerminal-Volumendaten (Schätzung)
//   3. Fallback: Orca-Wert (auch wenn eingefroren)
for (const po of poolsOverview) {
    const myApr = myAprByPool[po.id] ?? null;
    let selfApr = null;

    if (staleAprPools.has(po.id)) {
        // Variante 1: aktive Pools → position_snapshots
        if ((investedCapital[po.id] ?? 0) > 0) {
            const snaps = (_snapsByPool[po.id] ?? []).filter(s => s.recorded_at >= _24hAgoMs);
            if (snaps.length >= 2) {
                const _eo        = _earnOpts(po.id);
                const earned     = _deltaEarned(snaps, _eo.volatileOpts, _eo.usdcIsTokenA);
                const periodDays = (snaps.at(-1).recorded_at - snaps[0].recorded_at) / 86_400_000;
                // earned kann durch Preis-Schwankungen in den Snapshots negativ werden
                // (kein Filter auf earned > 0 hier, anders als in buildPosition).
                // Negatives selfApr → verwerfen, Fallback auf Variante 2 oder Orca-Wert.
                if (periodDays >= 1 / 24 && earned > 0) {
                    selfApr = round2((earned / investedCapital[po.id]) * (365 / periodDays) * 100);
                }
            }
        }

        // Variante 2: APR aus GeckoTerminal volume_hourly (für alle Pools, auch inaktive)
        if (selfApr == null) {
            const pool    = pools.find(p => p.id === po.id);
            const feeTier = _effectiveFeeTier(po.id, pool?.fee_tier ?? null);
            const tvl     = po.tvl ?? null;
            if (feeTier != null && tvl > 0) {
                const volRows = db.prepare(
                    `SELECT volume_usd FROM volume_hourly WHERE pool_id = ? AND ts >= ?`
                ).all(po.id, _24hAgoMs);
                if (volRows.length >= 12) {   // mind. 12h Daten für sinnvolle Schätzung
                    const vol24h = volRows.reduce((s, r) => s + r.volume_usd, 0)
                                   * (24 / volRows.length);  // auf 24h hochrechnen
                    const aprEst = (vol24h * (feeTier / 100)) / tvl * 365 * 100;
                    if (aprEst > 0) selfApr = round2(aprEst);
                }
            }
        }
    }

    po.apr24hDisplay   = selfApr ?? po.apr24h;  // Anzeigewert (eigener Schätzwert bevorzugt)
    po.apr24hEstimated = selfApr != null;        // true → Tilde-Markierung im Dashboard
    po.sortApr         = po.apr24hDisplay;

    // ── APR 1H je Pool ────────────────────────────────────────────────
    // 1. Aktive Position mit myApr (echtes 1h-Fenster aus position_snapshots)
    // 2. Schätzung aus letztem volume_hourly-Bucket (Gecko, < 2h alt) — auch für
    //    inaktive Pools: braucht nur feeTier (Config) + TVL + letzten Volumen-Bucket,
    //    keine offene Position. Der Bot holt Stats+Candles auch für inaktive Pools
    //    (bot.js, Stats-Loop), die Daten liegen also bereits vor.
    // 3. null → Frontend zeigt "—"
    let apr1h = null;
    let apr1hEstimated = false;
    if (myApr != null) {
        apr1h = myApr;
    } else {
        const pool    = pools.find(p => p.id === po.id);
        const feeTier = _effectiveFeeTier(po.id, pool?.fee_tier ?? null);
        const tvl     = po.tvl ?? null;
        if (feeTier != null && tvl > 0) {
            const volRow = db.prepare(
                `SELECT volume_usd, ts FROM volume_hourly WHERE pool_id = ? ORDER BY ts DESC LIMIT 1`
            ).get(po.id);
            // Nur verwenden wenn jünger als 3h — Stats-Intervall 1h + GeckoTerminal
            // liefert laufende Stunde erst nach Abschluss → Candle kann bis zu ~2h alt
            // sein bevor der nächste Fetch sie ersetzt. 3h gibt ausreichend Puffer.
            // Dust-Schwelle (dieselbe wie beim Volumen-Malus): einzelne Dust-Trades
            // (z.B. 6 USDC in einem 1,1-Mio-USD-Pool) ergäben sonst ein irreführendes
            // ~0,01%-Anzeige statt "no data".
            if (volRow && volRow.volume_usd > VOLUME_MALUS_DUST_USD && (Date.now() - volRow.ts) < 3 * 3_600_000) {
                const aprEst = (volRow.volume_usd * 24 * 365 * (feeTier / 100)) / tvl * 100;
                if (aprEst > 0) {
                    apr1h = round2(aprEst);
                    apr1hEstimated = true;
                }
            }
        }
    }
    // Defensiv-Guard: negative Werte (Mess-Artefakt bei kleinen fee-Deltas oder
    // ungünstigen Preis-Bewegungen im Snapshot-Fenster) → null statt anzeigen.
    po.apr1hDisplay   = (apr1h != null && apr1h >= 0) ? apr1h : null;
    po.apr1hEstimated = apr1hEstimated;
}

// sortApr auf Positionen übertragen → beide Tabellen sortieren immer gleich
const _sortAprByPool = Object.fromEntries(poolsOverview.map(po => [po.id, po.sortApr]));
for (const p of positionsOut) p.sortApr = _sortAprByPool[p.poolId] ?? null;

// ─── sortRank: Tier-basierte Sortierung für Dashboard ────────────────────────
// Niedriger Wert = besser. Tier-Prio × 1000 + rankPos.
// Pools ohne Tier landen am Ende (Prio 9).
//
// Phase 2 (Profil-Refactor): profil-aware. Bei PROFILE=short werden
// short_term_tier und short_term_rank_pos verwendet, sonst die klassischen
// Mittelfrist-Spalten. Dadurch sortiert das Dashboard automatisch nach dem
// gewählten Profil — Pools die im Kurzfrist-Modus auf 'invest' stehen
// erscheinen oben, auch wenn sie im Mittelfrist-Tier 'hold' wären.
const TIER_SORT_PRIO = { invest: 1, hold: 2, observe: 2, withdraw: 3 };
const activeProfile  = getActiveProfile();
const isShortProfile = activeProfile === 'short';

function _sortRank(econ, rankPos, shortRankPos) {
    const tier    = isShortProfile ? econ?.shortTermTier : econ?.tier;
    const usePos  = isShortProfile ? shortRankPos        : rankPos;
    const prio    = TIER_SORT_PRIO[tier] ?? 9;
    const pos     = (usePos != null && usePos > 0) ? usePos : 999;
    return prio * 1000 + pos;
}
for (const po of poolsOverview) {
    po.sortRank = _sortRank(po.economic, po.rankPos, po.shortTermRankPos);
}
const _sortRankByPool = Object.fromEntries(poolsOverview.map(po => [po.id, po.sortRank]));
for (const p of positionsOut) p.sortRank = _sortRankByPool[p.poolId] ?? 9999;
for (const p of positionsOut) p.netAprPct = latestNetAprByPool[p.poolId] != null ? round2(latestNetAprByPool[p.poolId]) : null;
// Geclaimte Fees-Map kommt bereits aus computePnlHistory()

// pnl1d je Position: direkt aus den zentral berechneten 1d-Metriken.
for (const p of positionsOut) {
    p.pnl1d = _pnlData.metricsByPool[p.poolId]?.pnl_1d_usd ?? null;
}

// PnL-Deltas für Opportunity-Score-Timeframes (6h, 12h, 24h, 7d).
// Zentrale Lib: session-begrenzte Fenster-PnL aus derselben Kurve wie pnl1d.
{
    const _winPnl = pnlWindows(db, {
        flavor:  'liquidity',
        now:     Date.now(),
        windows: [
            { id: '1h',  ms:   1 * 3_600_000 },
            { id: '6h',  ms:   6 * 3_600_000 },
            { id: '12h', ms:  12 * 3_600_000 },
            { id: '24h', ms:  24 * 3_600_000 },
            { id: '7d',  ms: 168 * 3_600_000 },
        ],
    });
    for (const po of poolsOverview) po.pnlWindows = _winPnl[po.id] ?? {};
}

// ─── Token-USD-Trend (24h) ────────────────────────────────────────────────────
// Berechnet pro Pool den USD-Preistrend für tokenA und tokenB separat.
// Kein API-Call — nutzt _oppStatsByPool (bereits geladen) und _quoteUsdAt.
// Ergebnis: po.tokenAChange24h, po.tokenBChange24h (% oder null falls keine Daten).
{
    const _24hMs = 24 * 3_600_000;

    // Nächstgelegener pool_stats-Eintrag zum Zeitpunkt ts (max. 90 Min Lücke).
    function _statsAt(poolId, ts) {
        const arr = _oppStatsByPool[poolId] ?? [];
        let lo = 0, hi = arr.length - 1, idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            arr[mid].recorded_at <= ts ? (idx = mid, lo = mid + 1) : hi = mid - 1;
        }
        if (idx < 0 || ts - arr[idx].recorded_at > 90 * 60_000) return null;
        return arr[idx];
    }

    // USD-Preise für tokenA und tokenB eines Pools zum Zeitpunkt ts.
    // Logik spiegelt die bestehenden Formeln in export.js (volatilePair, usdcIsTokenA).
    function _tokenUsdAt(cfg, ts) {
        const snap = _statsAt(cfg.id, ts);
        if (!snap || !snap.price || snap.price <= 0) return { usdA: null, usdB: null };
        const p = snap.price;
        if (cfg.usdcIsTokenA) {
            return { usdA: 1.0, usdB: 1 / p };
        }
        if (cfg.volatilePair && cfg.quotePricePoolId) {
            const quoteUsd = _quoteUsdAt(cfg.quotePricePoolId, ts);
            if (!quoteUsd) return { usdA: null, usdB: null };
            return cfg.quoteTokenMint === cfg.tokenA
                ? { usdA: quoteUsd, usdB: quoteUsd / p }
                : { usdA: p * quoteUsd, usdB: quoteUsd };
        }
        return { usdA: p, usdB: 1.0 };
    }

    function _pct(now, ago) {
        return (now != null && ago != null && ago > 0)
            ? +((now - ago) / ago * 100).toFixed(2)
            : null;
    }

    for (const po of poolsOverview) {
        const cfg = _poolConfigById[po.id];
        if (!cfg) continue;
        const now = _tokenUsdAt(cfg, _oppNowMs);
        const ago = _tokenUsdAt(cfg, _oppNowMs - _24hMs);
        po.tokenAChange24h = _pct(now.usdA, ago.usdA);
        po.tokenBChange24h = _pct(now.usdB, ago.usdB);
        po.tokenAUsd       = now.usdA != null ? +now.usdA.toFixed(4) : null;
        po.tokenBUsd       = now.usdB != null ? +now.usdB.toFixed(4) : null;
    }
}

// ─── InvestScore (LMB#0117) ───────────────────────────────────────────────────
// 6 Metriken, je auf 0–100 normiert, dann gewichtet (Summe Gewichte = 100%).
// PnL null (keine offene Position) → Score 50 (neutral statt herausrechnen).
// Andere null-Metriken → Gewichte proportional umverteilt.
// APR-Slope bei < 1 Tag Daten unterdrückt (Einführungsspike verfälscht den Slope).
// 6h-Hopium-Gate (Preis↓ + APR↓ gleichzeitig) wirkt als Score-Veto → max. 40.
// Ergebnis: po.investScore = { value, arrow, confidence, dataDays, metrics, hopiumVeto }
// Timestamp geteilt mit npWindows-Fixup (INSERT OR REPLACE braucht exakt denselben Wert).
//
// Trend-Zustand einmal geladen, zwei Konsumenten: das Trend-Feinsignal im InvestScore
// hier UND die Dashboard-Trend-Gate-Anzeige weiter unten (Opportunity 2.0, 2026-08-25) —
// dieselbe Berechnung, keine zweite Kopie (siehe lib/trend-indicators.js Kopf-Kommentar).
const _investScoreNowMs = Date.now();
const _trendStatesForExport = loadTrendStates(db, _allPoolsConfig);
{
    const _invRes = await loadInvestScores({
        pools, poolsOverview, volHistRaw, poolTypeMap, openPosByPool,
        lastNonZeroCapitalByPool, oppStatsByPool: _oppStatsByPool, volatilePairMap,
        trendStates: _trendStatesForExport,
    }, opportunityScores);
    if (_invRes.source !== 'compute') { scoreSource = _invRes.source; scoreStale = _invRes.stale; }

    for (const po of poolsOverview) {
        po.investScore = _invRes.investScores.get(po.id) ?? null;
    }

    // Persist investScore to invest_score_history
    try {
        const nowMs  = _investScoreNowMs;
        const histDb = new Database(DB_PATH);
        const ins    = histDb.prepare(
            `INSERT OR REPLACE INTO invest_score_history (pool_id, recorded_at, score, exit_score)
             VALUES (@pool_id, @recorded_at, @score, @exit_score)`);
        histDb.transaction(rows => { for (const r of rows) ins.run(r); })(
            poolsOverview
                .filter(po => po.investScore?.value != null)
                .map(po => ({
                    pool_id: po.id, recorded_at: nowMs,
                    score: po.investScore.value, exit_score: po.investScore.exitValue ?? po.investScore.value,
                }))
        );
        histDb.close();
    } catch (e) {
        console.warn(`export.js: invest_score_history nicht persistiert (${e.message})`);
    }

    // Query historical score data for dashboard chart (10-min 1D, daily 1W/1M)
    try {
        const nowMs   = Date.now();
        const cut1d   = nowMs - 86_400_000;
        const cut7d   = nowMs - 7  * 86_400_000;
        const cut31d  = nowMs - 31 * 86_400_000;
        const q10min  = db.prepare(`
            SELECT CAST(recorded_at / 600000 AS INTEGER) * 600000 AS ts,
                   ROUND(AVG(score)) AS v
            FROM invest_score_history
            WHERE pool_id = ? AND recorded_at > ? AND score IS NOT NULL
            GROUP BY CAST(recorded_at / 600000 AS INTEGER)
            ORDER BY ts`);
        const qHourly = db.prepare(`
            SELECT CAST(recorded_at / 3600000 AS INTEGER) * 3600000 AS ts,
                   ROUND(AVG(score)) AS v
            FROM invest_score_history
            WHERE pool_id = ? AND recorded_at > ? AND score IS NOT NULL
            GROUP BY CAST(recorded_at / 3600000 AS INTEGER)
            ORDER BY ts`);
        const qDaily  = db.prepare(`
            SELECT CAST(recorded_at / 86400000 AS INTEGER) * 86400000 AS ts,
                   ROUND(AVG(score)) AS v
            FROM invest_score_history
            WHERE pool_id = ? AND recorded_at > ? AND score IS NOT NULL
            GROUP BY CAST(recorded_at / 86400000 AS INTEGER)
            ORDER BY ts`);
        for (const po of poolsOverview) {
            const currentScore = po.investScore?.value ?? null;
            // Letzten Bucket immer mit dem aktuellen Score überschreiben.
            // Tages-/Stunden-Buckets werden über AVG gemittelt — bei starken Intraday-Bewegungen
            // weicht der Durchschnitt massiv vom tatsächlichen Stand ab (z.B. 70→20 an einem Tag).
            const withCurrentEnd = (pts) => {
                if (!pts.length || currentScore == null) return pts;
                pts[pts.length - 1] = { ...pts[pts.length - 1], v: currentScore };
                return pts;
            };
            po.scoreHistory = {
                '1d': withCurrentEnd(q10min .all(po.id, cut1d)  .map(r => ({ ts: r.ts, v: r.v }))),
                '1w': withCurrentEnd(qHourly.all(po.id, cut7d)  .map(r => ({ ts: r.ts, v: r.v }))),
                '1m': withCurrentEnd(qDaily .all(po.id, cut31d) .map(r => ({ ts: r.ts, v: r.v }))),
            };
        }
    } catch (e) {
        console.warn(`export.js: scoreHistory nicht abgefragt (${e.message})`);
    }

    // Query metric history for PnL / Slope charts (5-min 6H, 10-min 12H/1D, hourly 1W, daily 1M)
    // PnL-Werte werden um kumulierte fee_transfers (claim − reinvest) korrigiert, damit
    // der letzte Chart-Punkt exakt mit dem pnlWindows-Tabellenwert übereinstimmt.
    try {
        const nowMs  = Date.now();
        const cut6h  = nowMs -  6 * 3_600_000;
        const cut12h = nowMs - 12 * 3_600_000;
        const cut1d  = nowMs - 86_400_000;
        const cut7d  = nowMs - 7  * 86_400_000;
        const cut31d = nowMs - 31 * 86_400_000;

        const bucketSizes = { '6h': 300_000, '12h': 600_000, '1d': 600_000, '1w': 3_600_000, '1m': 86_400_000 };
        const cuts = { '6h': cut6h, '12h': cut12h, '1d': cut1d, '1w': cut7d, '1m': cut31d };

        // pnlHistory nach Pool indexieren (Entries aufsteigend sortiert)
        const _mhPnlIdx = {};
        for (const e of pnlHistory) (_mhPnlIdx[e.poolId] ??= []).push(e);

        // Kumulative fee_transfers (= claim − reinvest) pro Pool, aufsteigend sortiert.
        // Wird zu jedem pnlUsd-Wert addiert, damit der Chart-Endpunkt mit pnlWindows übereinstimmt:
        //   chart_delta(window) = (pnlUsd(now) + cumFee(now)) − (pnlUsd(start) + cumFee(start))
        //                       = pnlDelta + feeTransfers_in_window  ← identisch zu pnlWindows
        const _cumFeeEvts = {}; // poolId → [{t, cum}]
        {
            const rows = db.prepare(`
                SELECT pool_id, created_at AS t, type, COALESCE(usd_value,0) AS usd
                FROM transactions
                WHERE type IN ('claim','reinvest') AND created_at >= ?
                ORDER BY pool_id, created_at
            `).all(cut31d);
            for (const r of rows) {
                const arr = (_cumFeeEvts[r.pool_id] ??= []);
                const prev = arr.length ? arr[arr.length - 1].cum : 0;
                const delta = r.type === 'claim' ? r.usd : -r.usd;
                arr.push({ t: r.t, cum: Math.max(0, prev + delta) });
            }
        }
        // Gibt den kumulierten fee-Transfer-Wert zum Zeitpunkt t zurück (Binärsuche).
        const _getCumFee = (poolId, t) => {
            const arr = _cumFeeEvts[poolId];
            if (!arr || !arr.length) return 0;
            let lo = 0, hi = arr.length - 1, result = 0;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (arr[mid].t <= t) { result = arr[mid].cum; lo = mid + 1; }
                else hi = mid - 1;
            }
            return result;
        };

        // Gibt den letzten pnlHistory-Eintrag (pnlUsd + cumFee) zum Zeitpunkt t <= cut zurück.
        // Entspricht exakt der Baseline aus pnlWindows → letzer Chart-Punkt = pnlWindows-Wert.
        const _getWindowBase = (entries, poolId, cut) => {
            for (let i = entries.length - 1; i >= 0; i--) {
                if (entries[i].t <= cut) return entries[i].pnlUsd + _getCumFee(poolId, entries[i].t);
            }
            return null;
        };

        const _bucketize = (entries, poolId, cut, bucket) => {
            const buckets = new Map();
            for (const e of entries) {
                if (e.t <= cut) continue;
                const b = Math.floor(e.t / bucket) * bucket;
                if (!buckets.has(b)) buckets.set(b, []);
                // pnlUsd + kumulierter fee-Transfer-Korrektur zum Zeitpunkt dieses Snapshots
                buckets.get(b).push(e.pnlUsd + _getCumFee(poolId, e.t));
            }
            return [...buckets.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([ts, vals]) => ({ ts, v: parseFloat((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2)) }));
        };

        // Slopes: price_slope_pct / yield_slope_pct / tvl_slope_pct from opportunity_scores (timeframe=24h)
        const qSlope = (col, bucket) => db.prepare(`
            SELECT CAST(recorded_at / ${bucket} AS INTEGER) * ${bucket} AS ts,
                   ROUND(AVG(${col}), 3) AS v
            FROM opportunity_scores
            WHERE pool_id = ? AND timeframe = '24h' AND recorded_at > ? AND ${col} IS NOT NULL
            GROUP BY CAST(recorded_at / ${bucket} AS INTEGER)
            ORDER BY ts`);

        const B5m = 300_000, B10m = 600_000, B1h = 3_600_000, B1d = 86_400_000;
        const psQ  = { '6h': qSlope('price_slope_pct', B5m), '12h': qSlope('price_slope_pct', B10m), '1d': qSlope('price_slope_pct', B10m), '1w': qSlope('price_slope_pct', B1h), '1m': qSlope('price_slope_pct', B1d) };
        const asQ  = { '6h': qSlope('yield_slope_pct', B5m), '12h': qSlope('yield_slope_pct', B10m), '1d': qSlope('yield_slope_pct', B10m), '1w': qSlope('yield_slope_pct', B1h), '1m': qSlope('yield_slope_pct', B1d) };
        const tvlQ = { '6h': qSlope('tvl_slope_pct',   B5m), '12h': qSlope('tvl_slope_pct',   B10m), '1d': qSlope('tvl_slope_pct',   B10m), '1w': qSlope('tvl_slope_pct',   B1h), '1m': qSlope('tvl_slope_pct',   B1d) };
        // volatilePair-Pools (z.B. PUMP/SOL): price_slope_pct ist die Token/Token-Ratio,
        // kein USD-Trend — für die Preis-Slope-Historie dort usd_trend_slope_pct nehmen
        // (gleiche Weiche wie die aktuelle Tabellenzelle und invest-score-compute.js).
        const utQ  = { '6h': qSlope('usd_trend_slope_pct', B5m), '12h': qSlope('usd_trend_slope_pct', B10m), '1d': qSlope('usd_trend_slope_pct', B10m), '1w': qSlope('usd_trend_slope_pct', B1h), '1m': qSlope('usd_trend_slope_pct', B1d) };

        const toPoints = rows => rows.map(r => ({ ts: r.ts, v: r.v }));

        for (const po of poolsOverview) {
            po.metricHistory = {};
            const pnlEntries = _mhPnlIdx[po.id] ?? [];
            for (const range of ['6h', '12h', '1d', '1w', '1m']) {
                const cut    = cuts[range];
                const bucket = bucketSizes[range];
                const rawPnl = _bucketize(pnlEntries, po.id, cut, bucket);
                // Basis = letzter pnlHistory-Eintrag VOR dem Fenster (identisch zu pnlWindows).
                // Fallback auf ersten Bucket falls kein Eintrag vor dem Fenster existiert.
                const windowBase = _getWindowBase(pnlEntries, po.id, cut);
                const base = windowBase ?? (rawPnl.length ? rawPnl[0].v : 0);
                po.metricHistory[range] = {
                    pnl:        rawPnl.map(p => ({ ts: p.ts, v: parseFloat((p.v - base).toFixed(2)) })),
                    priceSlope: toPoints((po.volatilePair ? utQ : psQ)[range].all(po.id, cut)),
                    aprSlope:   toPoints(asQ[range] .all(po.id, cut)),
                    tvlSlope:   toPoints(tvlQ[range].all(po.id, cut)),
                };
            }
        }
    } catch (e) {
        console.warn(`export.js: metricHistory nicht abgefragt (${e.message})`);
    }
}

// Inaktive Pools: pnlWindows leeren – historische PnL-Daten sind für nicht investierte Pools
// irreführend (keine offene Position → Werte spiegeln vergangene Sessions wider, nicht die
// aktuelle Marktlage). InvestScore hat sie intern bereits ausgewertet.
for (const po of poolsOverview) {
    if (!openPosByPool[po.id]) po.pnlWindows = {};
}

// ─── NP: gemeinsame Konstanten ────────────────────────────────────────────────
const NP_CAPITAL    = 1000;
// NP-Klassenparameter (min/max/sigmaFallback/liqSpreadPct/skipMaeAlert) kommen seit #0228
// zentral aus POOL_TYPE_CONFIG (lib/range-advisor.js) über getPoolTypeConfig(poolCfg).
// volaDefault dort = sigmaFallback hier (gleiche Stunden-Sigma-Reserve).
const NP_CANDIDATES = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30];
const NP_WINDOWS    = [
    { id: '1h',  h:   1, ms:   1 * 3_600_000 },
    { id: '6h',  h:   6, ms:   6 * 3_600_000 },
    { id: '12h', h:  12, ms:  12 * 3_600_000 },
    { id: '24h', h:  24, ms:  24 * 3_600_000 },
    { id: '7d',  h: 168, ms: 168 * 3_600_000 },
];

// ─── NP: echte Fee-APR aus Orca-Liquiditätsdaten ─────────────────────────────
// Berechnet grossAprPct für einen Pool wenn liquidity_in_range + fees_24h_usd
// vorhanden sind. Formel: fee_APR = (L_pos / L_pool) × fees_24h / capital × 365 × 100
//
// L_pos wird aus dem GESAMTKAPITAL über die exakte CLMM-Mengenformel abgeleitet:
//   x_raw = L·(1/√P − 1/√Pb),  y_raw = L·(√P − √Pa)   (Whirlpool-Einheiten, raw)
//   V     = x_raw/10^decA · usdA + y_raw/10^decB · usdB
// → L_pos = V / (perL_A + perL_B). Keine 50/50-Annahme (die bei breiten Ranges
//   bis zu ~16 % Fehler erzeugt — Token-A-Wertanteil ist nur bei engen Ranges ≈50 %).
// usdB folgt aus der Parität usdA = P_human · usdB.
// Gibt null zurück wenn Eingangsdaten fehlen → Fallback auf scoreRange().
function _npFeeAprPct(poolCfg, pHuman, rangePct, usdA, liquidityInRangeStr, fees24hUsd) {
    if (!liquidityInRangeStr || !fees24hUsd || fees24hUsd <= 0) return null;
    if (!usdA || usdA <= 0 || !pHuman || pHuman <= 0) return null;
    const L_pool = parseFloat(liquidityInRangeStr);
    if (!L_pool || L_pool <= 0) return null;

    const decA = poolCfg.decimalsA ?? 9;
    const decB = poolCfg.decimalsB ?? 6;
    // Preis in Whirlpool-internen Einheiten: P_raw = P_human × 10^(decB − decA)
    const P_raw = pHuman * Math.pow(10, decB - decA);
    if (P_raw <= 0) return null;

    const r = rangePct / 100;
    if (r <= 0 || r >= 1) return null;
    const sqrtP  = Math.sqrt(P_raw);
    const sqrtPa = Math.sqrt(P_raw * (1 - r));
    const sqrtPb = Math.sqrt(P_raw * (1 + r));

    const usdB = usdA / pHuman;   // Parität: usdA = P_human · usdB

    // USD-Wert je Liquiditätseinheit (beide Token, exakt):
    const perL_A = (1 / sqrtP - 1 / sqrtPb) / Math.pow(10, decA) * usdA;
    const perL_B = (sqrtP - sqrtPa)         / Math.pow(10, decB) * usdB;
    const perL   = perL_A + perL_B;
    if (perL <= 0) return null;
    const L_pos = NP_CAPITAL / perL;

    const grossAprPct = (L_pos / L_pool) * fees24hUsd / NP_CAPITAL * 365 * 100;

    // Plausibilitäts-Guard: kein negatives/NaN oder unrealistisch hohes Ergebnis
    if (!Number.isFinite(grossAprPct) || grossAprPct <= 0 || grossAprPct > 100_000) return null;
    return grossAprPct;
}

// ─── NP: sigma + optimale Range für alle Pools vorausberechnen ────────────────
// Ergebnis wird in np_price_history-Schreiblogik UND im NP-Block verwendet.
const _npParamsByPool = {};
// USDC-Mint (für usdA-Lookup bei USDC-Pairs)
const _NP_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

for (const po of poolsOverview) {
    const poolCfg = poolsConfigRaw.find(p => p.id === po.id);
    if (!poolCfg) continue;
    const stats  = _oppStatsByPool[po.id] ?? [];
    const latest = stats[stats.length - 1];
    if (!latest?.price || latest.price <= 0 || !latest.tvl_usd || !latest.volume_24h_usd) continue;

    const prices = stats.map(s => s.price).filter(p => p > 0);
    let sigmaHourlyPct = null;
    if (prices.length >= 2) {
        const lr = [];
        for (let i = 1; i < prices.length; i++) lr.push(Math.log(prices[i] / prices[i - 1]));
        if (lr.length > 1) {
            const mean = lr.reduce((s, v) => s + v, 0) / lr.length;
            const variance = lr.reduce((s, v) => s + (v - mean) ** 2, 0) / lr.length;
            sigmaHourlyPct = Math.sqrt(variance) * 100;
        }
    }
    const classCfg  = getPoolTypeConfig(poolCfg);
    if (!sigmaHourlyPct || sigmaHourlyPct <= 0) sigmaHourlyPct = classCfg.volaDefault;

    // Effektiver Fee-Satz aus demselben pool_stats-Eintrag statt der Konstante —
    // bei Adaptive-Fee-Pools liegt der Ist-Satz darüber (LIQ#0394).
    const npFeeTierPct = effectiveFeePct(poolCfg.feeTier, {
        fees24hUsd:   latest.fees_24h_usd   ?? null,
        volume24hUsd: latest.volume_24h_usd ?? null,
    }).pct;

    const scanParams = { vol24h: latest.volume_24h_usd, tvl: latest.tvl_usd,
                         feeTierPct: npFeeTierPct, sigmaHourlyPct, capitalUsdc: NP_CAPITAL,
                         liqSpreadPct: classCfg.liqSpreadPct };
    const candidates = NP_CANDIDATES
        .filter(r => r >= classCfg.min && r <= classCfg.max)
        .map(r => scoreRange(r, scanParams));
    let optimal = candidates.reduce((best, c) => c.netAprPct > best.netAprPct ? c : best);

    // USD-Preis von Token A (für _npFeeAprPct).
    let usdA = null;
    if (poolCfg.tokenA === _NP_USDC_MINT) {
        usdA = 1.0;                       // Token A ist USDC
    } else if (poolCfg.tokenB === _NP_USDC_MINT) {
        usdA = latest.price;              // price = USD-Preis von Token A
    } else if (poolCfg.quotePricePoolId) {
        // _quoteUsdAt löst derivedQuote-Ketten korrekt auf (z.B. JitoSOL: baseUSD/rawPrice).
        // qLatest.price wäre für derived-Pools nur das rohe Pool-Ratio, nicht der USD-Preis.
        const quoteUsd = _quoteUsdAt(poolCfg.quotePricePoolId, latest.recorded_at);
        if (quoteUsd > 0) {
            usdA = poolCfg.quoteTokenMint === poolCfg.tokenA
                ? quoteUsd
                : latest.price * quoteUsd;
        }
    }

    // Echte Fee-APR aus Orca-Liquiditätsdaten. Die exakte Zwei-Token-Formel in
    // _npFeeAprPct wurde 2026-06-12 gegen frische On-Chain-Liquidität validiert:
    // ORE/SOL 0,01 %, SOL/ZEC 2,5 % Abweichung — L_pos stimmt mit der Kette überein.
    // (Der zwischenzeitlich vermutete „L-Konventions-Bug" war ein Messartefakt: er
    //  beruhte auf der veralteten positions.liquidity + rebalance-kontaminierten 24h-Fees,
    //  nicht auf der Formel. Siehe CHANGELOG 2026-06-12.)
    // Fallback auf scoreRange() solange liquidity_in_range/fees_24h_usd NULL sind.
    const NP_USE_REAL_FEES = true;
    if (NP_USE_REAL_FEES) {
        const realGrossAprPct = _npFeeAprPct(
            poolCfg, latest.price, optimal.rangePct, usdA,
            latest.liquidity_in_range, latest.fees_24h_usd
        );
        if (realGrossAprPct !== null) {
            optimal = { ...optimal, grossAprPct: realGrossAprPct,
                        netAprPct: realGrossAprPct - optimal.rebalCostAprPct };
        }
    }

    _npParamsByPool[po.id] = { poolCfg, latest, optimal, usdA, scanParams };
}

// ─── np_price_history schreiben (alle Pools, max. alle 10 min) ───────────────
{
    const NP_WRITE_INTERVAL_MS = 10 * 60_000;
    const NP_RETENTION_MS      = 25 * 3_600_000;
    try {
        const npDb    = new Database(DB_PATH);
        npDb.pragma('journal_mode = WAL');
        // Tabelle bei Bedarf anlegen (export.js nutzt keine zentrale migrateSchema)
        npDb.exec(`
            CREATE TABLE IF NOT EXISTS np_price_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pool_id TEXT NOT NULL, recorded_at INTEGER NOT NULL,
                price REAL NOT NULL, range_pct REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_np_price_pool_time
                ON np_price_history (pool_id, recorded_at);
        `);
        const lastTs  = npDb.prepare(`SELECT MAX(recorded_at) AS ts FROM np_price_history`).get()?.ts ?? 0;
        if (_oppNowMs - lastTs >= NP_WRITE_INTERVAL_MS) {
            const ins = npDb.prepare(
                `INSERT INTO np_price_history (pool_id, recorded_at, price, range_pct) VALUES (?,?,?,?)`);
            const del = npDb.prepare(`DELETE FROM np_price_history WHERE recorded_at < ?`);
            npDb.transaction(() => {
                del.run(_oppNowMs - NP_RETENTION_MS);
                for (const [poolId, p] of Object.entries(_npParamsByPool)) {
                    ins.run(poolId, _oppNowMs, p.latest.price, p.optimal.rangePct);
                }
            })();
            npDb.close();
        } else {
            npDb.close();
        }
    } catch (e) {
        console.warn(`export.js: np_price_history nicht geschrieben (${e.message})`);
    }
}

// ─── CLMM-Formeln (echte Preisbewegung, symmetrische Range) ──────────────────
// _clmmLpValue / _clmmLpReturn / _clmmLpReturnPath / _clmmIlPct sind nach
// ../lib/clmm-lp.js ausgelagert (oben importiert), damit der NP-Backtest
// (bin/backtest-np-path.js) exakt denselben Code testet — kein Nachbau.

// ─── NP: np_price_history lesen (NP-Block + Qualitäts-Protokoll) ─────────────
const _npHistory = {};
try {
    const rows = db.prepare(`
        SELECT pool_id, recorded_at, price, range_pct
          FROM np_price_history
         WHERE recorded_at >= ?
         ORDER BY pool_id, recorded_at ASC
    `).all(_oppNowMs - 25 * 3_600_000);
    for (const r of rows) (_npHistory[r.pool_id] ??= []).push(r);
} catch (_) { /* Erste Ausführung: Tabelle existiert noch nicht */ }

// ─── Notional Profit (NP) für alle Pools ─────────────────────────────────────
// 6h/12h/24h: echte CLMM-IL aus np_price_history + Fee-Schätzung
// 7d: CLMM-IL aus pool_stats (stündlich ausreichend) + Fee-Schätzung
// Aktive Pools: NP dient als Fallback wenn pnlWindows für ein Zeitfenster fehlt.
{
    // Evidenzbasiert: welche (Pool, Fenster) haben GEMESSEN Richtungstreffer < 50 % (n ≥ MIN)?
    // Treibt das Frontend-Flag „unzuverlässig". Selbstkorrigierend — bessert sich das Modell,
    // verschwindet das Flag automatisch. Ehrlicher als eine statische Klassen-Heuristik
    // (`volatilePair` meint mechanisch Nicht-USDC-Quote, nicht ökonomisch hohen IL).
    //
    const _NP_UNRELIABLE_MIN_N = 30;
    const _npUnreliableByPool = {};
    try {
        const _wlabel = { 1: '1h', 6: '6h', 12: '12h', 24: '24h' };
        for (const r of db.prepare(`
            SELECT pool_id, window_h,
                   COUNT(*) AS n,
                   AVG(CASE WHEN (predicted_usd > 0) = (actual_usd > 0) THEN 1.0 ELSE 0.0 END) AS dir_acc
            FROM np_quality_log
            GROUP BY pool_id, window_h
        `).all()) {
            if (r.n < _NP_UNRELIABLE_MIN_N || r.dir_acc >= 0.5) continue;
            const lbl = _wlabel[r.window_h];
            if (lbl) (_npUnreliableByPool[r.pool_id] ??= []).push(lbl);
        }
    } catch { /* np_quality_log evtl. noch leer */ }

    for (const po of poolsOverview) {
        po.npWindows = {};
        po.npUnreliableWindows = _npUnreliableByPool[po.id] ?? [];

        const params = _npParamsByPool[po.id];
        if (!params) continue;
        const { poolCfg, latest, optimal } = params;
        const Pt = latest.price;

        for (const w of NP_WINDOWS) {
            // Fee-Anteil: (grossAPR − Rebalance-Kosten) aus Range-Advisor, statistisch
            const feeUsdc = (optimal.grossAprPct - optimal.rebalCostAprPct)
                            / 100 / 365 / 24 * w.h * NP_CAPITAL;

            // LP-Rendite vs. Einstiegskapital (echte Preisbewegung oder 0 als Fallback).
            // _clmmLpReturn statt _clmmIlPct: misst dieselbe Größe wie pnlWindows
            // (Δ LP-Wert vs. Kapital), nicht Opportunity Cost vs. HODL.
            let lpReturnUsdc;
            if (w.h <= 24) {
                // Einstiegs-Snapshot aus np_price_history suchen
                const hist   = _npHistory[po.id] ?? [];
                const target = _oppNowMs - w.ms;
                let entry = null;
                for (let i = hist.length - 1; i >= 0; i--) {
                    if (hist[i].recorded_at <= target) { entry = hist[i]; break; }
                }
                if (!entry && hist.length > 0) entry = hist[0]; // ältester als Notfall-Fallback

                lpReturnUsdc = entry
                    ? _clmmLpReturn(entry.price, Pt, entry.range_pct) / 100 * NP_CAPITAL
                    : 0; // Noch keine History: Preis als stabil angenommen
            } else {
                // 7d: pool_stats-Preisreihe als P0-Quelle (stündlich, 168h vorhanden)
                const pStats = _oppStatsByPool[po.id] ?? [];
                const target = _oppNowMs - w.ms;
                let p0Entry  = null;
                for (let i = 0; i < pStats.length; i++) {
                    if (pStats[i].recorded_at >= target) { p0Entry = pStats[i]; break; }
                }
                lpReturnUsdc = (p0Entry?.price > 0)
                    ? _clmmLpReturn(p0Entry.price, Pt, optimal.rangePct) / 100 * NP_CAPITAL
                    : 0; // Kein Preisverlauf: Preis als stabil angenommen
            }

            po.npWindows[w.id] = round2(feeUsdc + lpReturnUsdc);
        }
    }
}

// ─── InvestScore: npWindows-Fallback für stable/major Pools ──────────────────
// Pools deren PnL-Metriken noch null sind (kein echtes pnlWindows für ein Fenster),
// erhalten einen simulierten Wert aus npWindows — nur für stable/major (volatile
// hat by design hohe MAE und ist über skipMaeAlert=true markiert).
// Läuft nach npWindows-Berechnung, damit po.npWindows befüllt ist.
{
    const _clampSim = (v, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(v)));
    const WIN_LABEL  = { 'PnL 6h': '6h', 'PnL 12h': '12h', 'PnL 24h': '24h' };

    for (const po of poolsOverview) {
        if (!po.investScore) continue;
        const params = _npParamsByPool[po.id];
        if (!params) continue;
        if (getPoolTypeConfig(params.poolCfg).skipMaeAlert) continue; // volatil_2/3 + rwa → MAE by design

        const metrics = po.investScore.metrics;
        let changed = false;
        for (const m of metrics) {
            const win = WIN_LABEL[m.label];
            if (!win) continue;            // kein PnL-Metrik
            if (m.score !== null) continue; // echte Daten vorhanden → nicht überschreiben
            const raw = po.npWindows?.[win];
            if (raw == null) continue;
            m.pct       = raw / NP_CAPITAL * 100;
            m.score     = _clampSim(50 + m.pct * 10);
            m.simulated = true;
            changed = true;
        }
        if (!changed) continue;

        // InvestScore-Wert neu normalisieren – über die zentrale Blend-Funktion
        // (lib/score-blend.js), nicht mehr von Hand nachgerechnet (Befund 2026-07-25:
        // war eine Formelkopie von blendInvestScore, siehe Changelog).
        const blended = blendInvestScore(
            metrics.map(m => ({ score: m.score, weight: m.weight, pnl: m.label.startsWith('PnL') })),
        );
        let value = blended ?? po.investScore.value;
        if (!openPosByPool[po.id] && value != null) value = Math.max(10, Math.min(90, value));
        if (po.investScore.hopiumVeto && value != null) value = Math.min(value, 40);

        po.investScore.value     = value;
        po.investScore.simulated = true;
        po.investScore.arrow     = value == null ? 'flat' : value >= 60 ? 'up' : value <= 34 ? 'down' : 'flat';
    }

    // Korrigierte Scores in invest_score_history nachschreiben (gleicher Timestamp →
    // INSERT OR REPLACE überschreibt den zuvor geschriebenen Eintrag exakt).
    const toFix = poolsOverview.filter(po => po.investScore?.simulated);
    if (toFix.length > 0) {
        try {
            const fixDb = new Database(DB_PATH);
            const upd   = fixDb.prepare(
                `INSERT OR REPLACE INTO invest_score_history (pool_id, recorded_at, score, exit_score) VALUES (?,?,?,?)`
            );
            fixDb.transaction(() => {
                // exitValue bleibt von der NP-Simulation unberührt (nur `value` wird oben neu
                // normalisiert) — muss aber explizit mitgeschrieben werden, sonst würde
                // INSERT OR REPLACE die Zeile komplett ersetzen und exit_score auf NULL setzen.
                for (const po of toFix) {
                    upd.run(po.id, _investScoreNowMs, po.investScore.value, po.investScore.exitValue ?? po.investScore.value);
                }
            })();
            fixDb.close();
        } catch (e) {
            console.warn(`export.js: investScore-Fixup nicht persistiert (${e.message})`);
        }
    }
}

// ─── NP-Qualitäts-Protokoll (stündlich, nur aktive Pools) ────────────────────
// Vergleicht Modell-NP (wie bei inaktiven Pools berechnet) mit realem PnL
// aus pnlWindows (kapitalfluss-korrigiert). Schreibt Fehlermetriken in
// np_quality_log. Warnt per console.warn wenn MAE > 40% über 24h.
{
    const NP_QUALITY_INTERVAL_MS  = 60 * 60_000; // stündlich
    const NP_QUALITY_MAE_WARN_PCT = 40;           // Warnschwelle MAE in %
    const NP_QUALITY_WARN_MIN_N   = 6;            // Mindest-Einträge für Alert

    try {
        const qDb = new Database(DB_PATH);
        qDb.pragma('journal_mode = WAL');
        qDb.exec(`
            CREATE TABLE IF NOT EXISTS np_quality_log (
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
                il_pred_actual_usd   REAL,
                lp_path_actual_usd       REAL,
                predicted_path_actual_usd REAL,
                error_path_actual_usd    REAL,
                time_in_range_pct        REAL
            );
            CREATE INDEX IF NOT EXISTS idx_np_quality_time
                ON np_quality_log (recorded_at DESC);
        `);
        // Idempotente Migration für bestehende DBs: fehlende Diagnose-Spalten ergänzen.
        // predicted_usd/error_usd bleiben NP@optimal-range (Ranking inaktiver Pools);
        // die *_actual_*-Spalten sind NP@actual-range (validierbar gegen aktive Position) +
        // Fee/IL-Zerlegung. Trennt Modellfehler vom Range-Mismatch.
        {
            const _cols = new Set(qDb.prepare(`PRAGMA table_info(np_quality_log)`).all().map(c => c.name));
            for (const [col, type] of [
                ['np_range_pct', 'REAL'], ['actual_range_pct', 'REAL'],
                ['predicted_actual_usd', 'REAL'], ['error_actual_usd', 'REAL'],
                ['fee_pred_actual_usd', 'REAL'], ['il_pred_actual_usd', 'REAL'],
                // #0198 Shadow: pfad-/rebalance-bewusster LP-Return (A/B gegen il_pred_actual_usd)
                ['lp_path_actual_usd', 'REAL'], ['predicted_path_actual_usd', 'REAL'],
                ['error_path_actual_usd', 'REAL'], ['time_in_range_pct', 'REAL'],
            ]) {
                if (!_cols.has(col)) qDb.exec(`ALTER TABLE np_quality_log ADD COLUMN ${col} ${type}`);
            }
        }

        const lastTs = qDb.prepare(
            `SELECT MAX(recorded_at) AS ts FROM np_quality_log`
        ).get()?.ts ?? 0;

        if (_oppNowMs - lastTs >= NP_QUALITY_INTERVAL_MS) {
            const ins = qDb.prepare(`
                INSERT INTO np_quality_log
                    (pool_id, recorded_at, window_h, predicted_usd, actual_usd, error_usd, error_pct,
                     np_range_pct, actual_range_pct, predicted_actual_usd, error_actual_usd,
                     fee_pred_actual_usd, il_pred_actual_usd,
                     lp_path_actual_usd, predicted_path_actual_usd, error_path_actual_usd, time_in_range_pct)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            // Kurzfrist-Fenster (6h/12h/24h) — np_price_history deckt genau das ab
            const qualityWindows = NP_WINDOWS.filter(w => w.h <= 24);
            const rows = [];

            for (const po of poolsOverview) {
                if (!openPosByPool[po.id]) continue; // nur aktive Pools

                const params  = _npParamsByPool[po.id];
                if (!params) continue;

                const capital = openPosByPool[po.id].capital_usdc;
                if (!capital || capital <= 0) continue;

                const { optimal, latest, poolCfg, usdA, scanParams } = params;
                const Pt = latest.price;

                // ── NP@actual-range: gegen die reale Position validierbar ──────────────
                // Die aktive Position läuft auf ihrer konfigurierten Range (z.B. ORE/SOL ±5 %),
                // nicht auf der optimalen Range, die NP fürs Ranking annimmt. Reale Range exakt
                // aus den Position-Ticks (symmetrische Halbbreite in %). Trennt Modellfehler
                // vom Range-Mismatch.
                const _pos = openPosByPool[po.id];
                let actualRangePct = optimal.rangePct;
                if (_pos && Number.isFinite(_pos.tick_lower) && Number.isFinite(_pos.tick_upper)
                        && _pos.tick_upper > _pos.tick_lower) {
                    actualRangePct = (Math.pow(1.0001, (_pos.tick_upper - _pos.tick_lower) / 2) - 1) * 100;
                }
                const _sAct = scoreRange(actualRangePct, scanParams);
                let _grossAct = _sAct.grossAprPct;
                const _realGrossAct = _npFeeAprPct(poolCfg, latest.price, actualRangePct, usdA,
                                                   latest.liquidity_in_range, latest.fees_24h_usd);
                if (_realGrossAct !== null) _grossAct = _realGrossAct;
                const _netFeeAprAct = _grossAct - _sAct.rebalCostAprPct;

                for (const w of qualityWindows) {
                    // Realer PnL aus pnlWindows (kapitalfluss-korrigiert), auf 1.000 USDC normiert
                    const rawPnl = po.pnlWindows?.[w.id];
                    if (rawPnl == null) continue;
                    const actualUsd = rawPnl / capital * NP_CAPITAL;

                    // Modell-NP: gleiche Logik wie bei inaktiven Pools
                    const feeUsdc = (optimal.grossAprPct - optimal.rebalCostAprPct)
                                    / 100 / 365 / 24 * w.h * NP_CAPITAL;

                    const hist   = _npHistory[po.id] ?? [];
                    const target = _oppNowMs - w.ms;
                    let entry    = null;
                    for (let i = hist.length - 1; i >= 0; i--) {
                        if (hist[i].recorded_at <= target) { entry = hist[i]; break; }
                    }
                    if (!entry && hist.length > 0) entry = hist[0];

                    const lpReturnUsdc = entry
                        ? _clmmLpReturn(entry.price, Pt, entry.range_pct) / 100 * NP_CAPITAL
                        : 0; // Kein Preisverlauf: Preis als stabil angenommen

                    const predictedUsd = feeUsdc + lpReturnUsdc;
                    const errorUsd     = predictedUsd - actualUsd;
                    const errorPct     = Math.abs(actualUsd) >= 0.01
                        ? errorUsd / Math.abs(actualUsd) * 100 : null;

                    // NP@actual-range: Fee-Teil + IL-Teil getrennt (Diagnose Fee- vs. IL-Fehler)
                    const feeUsdcAct = _netFeeAprAct / 100 / 365 / 24 * w.h * NP_CAPITAL;
                    const ilUsdcAct  = entry
                        ? _clmmLpReturn(entry.price, Pt, actualRangePct) / 100 * NP_CAPITAL
                        : 0;
                    const predictedActualUsd = feeUsdcAct + ilUsdcAct;
                    const errorActualUsd     = predictedActualUsd - actualUsd;

                    // ── #0198 SHADOW: pfad-/rebalance-bewusster LP-Return @actual-range ──
                    // Gleicher Fee-Term wie oben, nur der LP-/IL-Term wird durch das
                    // Pfad-Modell ersetzt → isoliert den Effekt des LP-Terms im A/B.
                    // Voller Fensterpfad (alle Stützstellen >= target), nicht nur entry→Pt.
                    let lpPathActualUsd       = null;
                    let predictedPathActualUsd = null;
                    let errorPathActualUsd     = null;
                    let timeInRangePct         = null;
                    const winPath = hist.filter(h => h.recorded_at >= target && h.price > 0);
                    const pathRes = _clmmLpReturnPath(winPath, actualRangePct);
                    if (pathRes) {
                        lpPathActualUsd        = pathRes.lpReturnPct / 100 * NP_CAPITAL;
                        predictedPathActualUsd = feeUsdcAct + lpPathActualUsd;
                        errorPathActualUsd     = predictedPathActualUsd - actualUsd;
                        timeInRangePct         = pathRes.timeInRange * 100;
                    }

                    rows.push({ poolId: po.id, wh: w.h, predictedUsd, actualUsd, errorUsd, errorPct,
                                npRangePct: optimal.rangePct, actualRangePct,
                                predictedActualUsd, errorActualUsd,
                                feePredActualUsd: feeUsdcAct, ilPredActualUsd: ilUsdcAct,
                                lpPathActualUsd, predictedPathActualUsd, errorPathActualUsd, timeInRangePct });
                }
            }

            if (rows.length > 0) {
                qDb.transaction(() => {
                    for (const r of rows) {
                        ins.run(r.poolId, _oppNowMs, r.wh,
                                r.predictedUsd, r.actualUsd, r.errorUsd, r.errorPct ?? null,
                                r.npRangePct ?? null, r.actualRangePct ?? null,
                                r.predictedActualUsd ?? null, r.errorActualUsd ?? null,
                                r.feePredActualUsd ?? null, r.ilPredActualUsd ?? null,
                                r.lpPathActualUsd ?? null, r.predictedPathActualUsd ?? null,
                                r.errorPathActualUsd ?? null, r.timeInRangePct ?? null);
                    }
                })();

                // MAE-Alert: volatile Pools by design ungenau → nur stable/major prüfen
                const recentAll = qDb.prepare(`
                    SELECT pool_id, ABS(error_pct) AS ae FROM np_quality_log
                    WHERE recorded_at >= ? AND error_pct IS NOT NULL
                `).all(_oppNowMs - 24 * 3_600_000);

                const recent = recentAll.filter(r => {
                    const cfg = _npParamsByPool[r.pool_id]?.poolCfg;
                    if (!cfg) return true; // unbekannt → konservativ einschließen
                    return !getPoolTypeConfig(cfg).skipMaeAlert;
                });

                if (recent.length >= NP_QUALITY_WARN_MIN_N) {
                    const mae = recent.reduce((s, r) => s + r.ae, 0) / recent.length;
                    if (mae > NP_QUALITY_MAE_WARN_PCT) {
                        console.warn(
                            `export.js: NP-Modell-Qualität degradiert — ` +
                            `MAE ${mae.toFixed(1)}% > Schwelle ${NP_QUALITY_MAE_WARN_PCT}% ` +
                            `(n=${recent.length}, letzte 24h, nur stable/major)`
                        );
                    }
                }
            }
        }
        qDb.close();
    } catch (e) {
        console.warn(`export.js: np_quality_log nicht geschrieben (${e.message})`);
    }
}

// ─── Portfolio-Metriken ────────────────────────────────────────────────────────

// Baseline = netDeposited (Summe aller echten Cashflows: Deposits − Withdrawals).
// Seit v0.3.47 wird die Baseline NICHT mehr aus capital_flows.balance_snapshot abgeleitet
// (war anfällig für stale Wallet-Reads und wurde bei jedem bot-internen Position-Open
// neu gesetzt, was die kumulierte Performance zerstückelte).
//
// Echte Cashflows erkennen — capital_flows hat keinen type-Column, daher Pattern-Match
// auf note. usdc_amount ist bereits signiert: Withdraws stehen mit negativem Vorzeichen.
// Bot-interne Pseudo-Flows ('Neue Position automatisch...', 'Baseline-Reset/Fix...')
// werden ausgefiltert — sie wurden bis v0.3.46 vom alten _openNewPosition geschrieben
// und sind seit v0.3.47 nicht mehr vorhanden — die Altbestände wurden damals einmalig
// bereinigt (Skript nach Gebrauch entfernt, siehe doc/CHANGELOG/2026-08-15.md).
const _isRealFlow = (note) => {
    if (!note) return false;
    return /^Manueller Deposit/i.test(note)
        || /^Manueller Withdraw/i.test(note)
        || /^Erstdeposit/i.test(note)
        || /^Deposit Position \d+ – netto neu/i.test(note);
};

const _allFlows = db.prepare(`
    SELECT usdc_amount, note, created_at FROM capital_flows ORDER BY created_at ASC
`).all();

const _netDepositedAt = (ts) => {
    let net = 0;
    for (const f of _allFlows) {
        if (f.created_at > ts) break;
        if (_isRealFlow(f.note)) net += (f.usdc_amount ?? 0);
    }
    return net;
};

// Periodenspezifisches Arbeitskapital für APR-Berechnung:
// Zeitgewichteter Durchschnitt des Portfolio-Werts aus portfolio_history für die Periode.
// Das ist das Kapital, das tatsächlich gearbeitet hat — unverzerrt durch Einzahlungen
// die erst mittendrin erfolgten (Modified Dietz). Fallback: netDeposited zum Periodenbeginn.
const getTimeWeightedCapital = (fromTs, toTs) => {
    const snaps = db.prepare(`
        SELECT total_usd, recorded_at FROM portfolio_history
        WHERE recorded_at >= ? AND recorded_at <= ?
        ORDER BY recorded_at ASC
    `).all(fromTs, toTs ?? Date.now());

    if (snaps.length >= 2) {
        let weightedSum = 0, totalTime = 0;
        for (let i = 0; i < snaps.length - 1; i++) {
            const dt = snaps[i + 1].recorded_at - snaps[i].recorded_at;
            weightedSum += snaps[i].total_usd * dt;
            totalTime   += dt;
        }
        if (totalTime > 0) return round2(weightedSum / totalTime);
    }
    if (snaps.length === 1) return round2(snaps[0].total_usd);

    // Fallback: netDeposited zum Periodenbeginn
    const nd = _netDepositedAt(fromTs);
    return nd > 0 ? round2(nd) : null;
};

const capitalToday     = getTimeWeightedCapital(todayStartMs);
const capitalYesterday = getTimeWeightedCapital(yesterdayStartMs, todayStartMs);
const capitalMonth     = getTimeWeightedCapital(monthStartMs);

// ── Abgeleitete Statistik-Werte EINMAL berechnen (single source, LMB#0167) ────
// APR, Netto-Fees und Payed-Fees-in-USDC werden hier aus dem konsistenten Snapshot
// berechnet (FORGE_TZ-Datum + solPrice von oben) – nicht mehr im Dashboard (app.js),
// das sonst mit Browser-Uhr (daysThisMonth) und Browser-solPrice rechnen würde.
const _daysThisMonth = Math.max(1, parseInt(_todayIso.slice(8, 10), 10));
const _aprFor = (claimedFees, txFeeSol, days, capital) =>
    (!capital || capital <= 0) ? 0
        : round2(((claimedFees - txFeeSol * solPrice) / capital) * (365 / days) * 100);
const statsApr = {
    today:     _aprFor(feesToday,     txFeesToday,     1,              capitalToday),
    yesterday: _aprFor(feesYesterday, txFeesYesterday, 1,              capitalYesterday),
    month:     _aprFor(feesMonth,     txFeesMonth,     _daysThisMonth, capitalMonth),
};
const statsNetto = {
    today:     round2(feesToday     - txFeesToday     * solPrice),
    yesterday: round2(feesYesterday - txFeesYesterday * solPrice),
    month:     round2(feesMonth     - txFeesMonth     * solPrice),
};
const statsPayedFeesUsdc = {
    today:     round2(txFeesToday     * solPrice),
    yesterday: round2(txFeesYesterday * solPrice),
    month:     round2(txFeesMonth     * solPrice),
};
// rolling-24h APR (heute anteilig + gestern anteilig, FORGE_TZ-Tagesfraktion)
const _nowParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: FORGE_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
}).formatToParts(new Date());
const _bh = parseInt(_nowParts.find(x => x.type === 'hour').value, 10) % 24;
const _bm = parseInt(_nowParts.find(x => x.type === 'minute').value, 10);
const _fracDay24h = (_bh * 60 + _bm) / 1440;
const _net24h     = statsNetto.today * _fracDay24h + statsNetto.yesterday * (1 - _fracDay24h);
const statsApr24h = capitalToday > 0 ? round2((_net24h / capitalToday) * 365 * 100) : null;

const currentValue       = round2(latestSnap?.total_usd ?? null);
const feesPendingUsd     = round4(latestSnap?.fees_pending_usd ?? null);
const impermanentLoss    = round2(latestSnap?.il_usd ?? null);
const impermanentLossPct = round2(latestSnap?.il_pct ?? null);

// Wallet-Werte aus wallet-monitor.db (Single Source of Truth seit v0.3.47).
// total_usd in portfolio_history enthält Wallet bereits — balance == currentValue.
const wallet          = getLatestWalletBalance(config.botId);
const walletSol       = wallet?.sol ?? null;
const walletUsdc      = wallet?.usdc ?? null;
const usableWalletSol = walletSol != null ? Math.max(0, walletSol - solReserve) : null;
const splTokensUsd    = wallet?.splTokensUsd ?? 0;
const walletValueUsd  = wallet
    ? round2(wallet.usdc + Math.max(0, wallet.sol - solReserve) * (wallet.solPriceUsd || solPrice) + wallet.splTokensUsd)
    : null;
// balance = LP (undampiert aus portfolio_history) + walletValueUsd (gleiche Quelle wie WALLET-Anzeige).
// NICHT currentValue/total_usd verwenden: der Spike-Damper kann dessen Wallet-Anteil reduzieren,
// wodurch GESAMT < WALLET möglich wird. Stattdessen beide Terme aus konsistenten Quellen addieren.
//
// Voraussetzung dafür, dass dies während eines Rebalance NICHT doppelt zählt: bin/bot.js
// erzwingt direkt nach closePosition() einen Portfolio-Snapshot (refreshAfterAction), bevor
// die neue Position eröffnet wird. portfolio_history ist dadurch nie länger als den
// Refresh-Vorgang selbst stale — die geschlossene Position fällt sofort aus dem
// LP-Aggregat (Join auf closed_at IS NULL), das Kapital erscheint nur einmal im Wallet.
const lpAndFees = round2((latestSnap?.lp_value_usd ?? 0) + (latestSnap?.fees_pending_usd ?? 0));
const balance   = walletValueUsd != null ? round2(lpAndFees + walletValueUsd) : currentValue;

// ─── Per-Pool-Settings aus ForgeSettings (settings.db) ───────────────────────

const SETTINGS_DB_PATH = PATHS.settingsDb;
const poolSettings = {};
try {
    const settingsDb = new Database(SETTINGS_DB_PATH, { readonly: true });
    const settingsRows = settingsDb.prepare(
        `SELECT pool_id, settings FROM pool_settings WHERE bot_id = ?`
    ).all(config.botId);
    for (const row of settingsRows) {
        try { poolSettings[row.pool_id] = JSON.parse(row.settings); }
        catch { /* ungültiges JSON überspringen */ }
    }
    settingsDb.close();
} catch {
    // settings.db nicht vorhanden → poolSettings bleibt leer
}

// Sicherheitsnetz: ForgeSettings initialisiert beim GET /api/pools/liquidity alle Pools.
// Falls export.js vor dem ersten ForgeSettings-Aufruf läuft, greifen hier die Defaults.
for (const pool of _allPoolsConfig) {
    if (!poolSettings[pool.id]) {
        poolSettings[pool.id] = { autoCompound: { enabled: true } };
    }
}

// TVL-Schutz: effektive L1/L2-Schwellen aus settings.db überschreiben die
// pools.json-Fallbacks. Im Dashboard-Chart werden diese als „L1" (gestrichelt)
// und „L2" (durchgezogen) gezeichnet. Eine deaktivierte Stufe → null (keine Linie).
for (const po of poolsOverview) {
    const tp = poolSettings[po.id]?.tvlProtection;
    if (!tp) continue; // kein Eintrag → pools.json-Fallback behalten
    const l1 = tp.level1 ?? {};
    const l2 = tp.level2 ?? {};
    po.tvlWarnThreshold = (l1.enabled && Number(l1.thresholdUsd) > 0) ? Number(l1.thresholdUsd) : null;
    po.tvlExitThreshold = (l2.enabled && Number(l2.thresholdUsd) > 0) ? Number(l2.thresholdUsd) : null;
}

// Invest-Guard fürs Dashboard: welche Pools würde „Bester Pool" jetzt überspringen,
// weil TVL-Schutz oder Score-Limit sie sofort wieder räumen würden (lib/invest-
// eligibility.js — dieselbe Funktion, die bin/cleanup.js vor dem Sortieren aufruft).
//
// 🔒 Jedes Tor, das „Bester Pool" schließt, braucht eine Entsprechung im Dashboard:
// ein still übersprungener Pool ist für den Betreiber sonst nicht von einem defekten
// zu unterscheiden. Bewusst nur Zahlen + maschinenlesbare Regel — die Oberfläche ist
// zweisprachig und formuliert den Satz selbst.
for (const po of poolsOverview) {
    try {
        const poolCfg = _allPoolsConfig.find(p => p.id === po.id);
        if (!poolCfg) continue;
        const elig = checkInvestEligibility(poolCfg, db, {
            exitScore: po.investScore?.exitValue ?? po.investScore?.value ?? null,
            settings:  poolSettings[po.id] ?? {},
        });
        po.investBlocked = elig.ok ? null : { rule: elig.rule, ...elig.detail };
    } catch { po.investBlocked = null; }

    // Zweites Tor derselben Klasse: nach einem Risk-Management-Exit ist der Pool für
    // `cooldownHours` vom Invest ausgeschlossen (lib/invest-cooldown.js — dieselbe
    // Funktion, mit der bin/cleanup.js seine Rangliste filtert). Ohne Anzeige gewinnt
    // im Ranking scheinbar grundlos ein niedriger bewerteter Pool.
    // Nur Schlüssel + Endzeitpunkt: die Restzeit rechnet die Oberfläche beim Rendern
    // aus, sonst wäre sie bis zum nächsten Export-Lauf veraltet.
    try {
        const cds = poolInvestCooldowns(db, po.id, { settings: poolSettings[po.id] ?? null });
        po.investCooldowns = cds.length ? cds.map(c => ({ key: c.key, untilMs: c.untilMs })) : null;
    } catch { po.investCooldowns = null; }
}

// Drittes Tor derselben Klasse: das optionale Trend-Gate (.env CLEANUP_TREND_GATE).
// Es entscheidet nicht über Kapital, das schon im Pool liegt — es entscheidet, ob
// welches hinein darf. Ohne Anzeige wäre für den Betreiber wieder nicht erkennbar,
// warum ein Pool mit Spitzen-Score übersprungen wurde (dieselbe Lücke wie beim
// Invest-Cooldown am 2026-08-23).
//
// Der Trendzustand wird IMMER exportiert (auch bei ausgeschaltetem Gate) — die
// Opportunity-Tabelle zeigt ihn dann als reine Information, und der Betreiber kann
// vor dem Einschalten sehen, was das Gate tun würde. Nur `required`/`ok` hängen an
// der Konfiguration.
try {
    const required = parseTrendGate(getCleanupTrendGateFromEnv());
    const states   = _trendStatesForExport;
    for (const po of poolsOverview) {
        const state = states.get(po.id) ?? null;
        if (!state) { po.trendGate = null; continue; }
        const gate = checkTrendGate(state, required);
        po.trendGate = {
            required,
            ok: gate.ok,
            failing: gate.failing,
            unknown: gate.unknown,
            // Nur das, was die Oberfläche für Icon und Tooltip braucht — keine
            // EMA-Rohwerte, die sonst je Minute das data.json aufblähen.
            state: Object.fromEntries(TREND_TIMEFRAMES.map(tf => [tf, {
                up:   state[tf]?.up ?? null,
                rsi:  state[tf]?.rsi == null ? null : Math.round(state[tf].rsi),
                reason: state[tf]?.reason ?? 'insufficient_data',
            }])),
        };
    }
} catch (err) {
    console.warn(`[export] Trend-Zustand nicht ermittelbar: ${err.message}`);
    for (const po of poolsOverview) po.trendGate ??= null;
}

// ─── "Bester Pool" jetzt: Vorschau fürs Dashboard (Hammer-Icon) ──────────────
// Zeigt, welchen Pool der nächste stündliche Cleanup-Lauf (Modus 'ranking') mit dem
// aktuellen Datenstand wählen würde. Nutzt bewusst dieselben, oben bereits berechneten
// Tore (investBlocked, trendGate, investCooldowns) statt sie ein weiteres Mal zu
// berechnen — zwei Kopien derselben Regel liefen in der Vergangenheit auseinander
// (siehe checkInvestEligibility-Kommentar oben). Deckt nur den Modus 'ranking' ab;
// bei 'pool:<id>' (fest gewählter Pool) oder 'disabled' gibt es keine „Wahl" zu zeigen.
{
    const cleanupModeNow     = process.env.CLEANUP_MODE
        ?? (process.env.CLEANUP_ENABLED === 'false' ? 'disabled' : 'ranking');
    const cleanupMinScoreNow = Math.max(0, parseInt(process.env.CLEANUP_MIN_SCORE ?? '65', 10));
    const cleanupTrendRequired = parseTrendGate(getCleanupTrendGateFromEnv());

    let cleanupWinnerPoolId = null;
    if (cleanupModeNow === 'ranking') {
        const candidates = poolsOverview.filter(po => {
            // Bewusst über config.pools.all (DB-überlagert), nicht _allPoolsConfig (rohe
            // pools.json): Bei jedem forge-pub-Fork setzt tools/pub-export/sanitize-pools-config.js
            // enabled/active in der JSON hart auf false, autoritativ ist aber die DB. Mit der
            // rohen JSON blieb das Hammer-Icon auf dem Fork immer aus, selbst wenn der Betreiber
            // den Pool über die Settings-UI freigeschaltet hatte (2026-08-24).
            const poolCfg = config.pools.all.find(p => p.id === po.id);
            if (!poolCfg || !isPoolEnabled(poolCfg)) return false;
            if (poolSettings[po.id]?.cleanup?.rankingEligible === false) return false;
            if (po.investScore?.value == null) return false;
            if (po.investScore.value < cleanupMinScoreNow) return false;

            // Ab hier hat der Pool den Score erreicht — ein Ausschluss ab jetzt ist für den
            // Betreiber sonst nicht von einem schlicht schwächeren Pool zu unterscheiden.
            // Grund merken (dieselbe Prüfreihenfolge wie die eigentliche Sperre unten), Basis
            // für das graue Info-Icon in der Opportunity-Tabelle (2026-08-31, LIQ#0351-Folge —
            // ersetzt das separate Cooldown-Icon, siehe app.js _cleanupBlockedIcon).
            if (po.investCooldowns?.length) { po._cleanupBlockedRule = 'cooldown'; return false; }
            if (cleanupTrendRequired.length && !po.trendGate?.ok) { po._cleanupBlockedRule = 'trend_gate'; return false; }
            if (po.investBlocked) { po._cleanupBlockedRule = po.investBlocked.rule ?? 'invest_blocked'; return false; }
            return true;
        }).sort((a, b) => b.investScore.value - a.investScore.value);
        cleanupWinnerPoolId = candidates[0]?.id ?? null;
    }
    for (const po of poolsOverview) {
        po.cleanupWinner = (po.id === cleanupWinnerPoolId)
            ? { score: po.investScore.value, minScore: cleanupMinScoreNow }
            : null;
        po.cleanupBlocked = (po.id !== cleanupWinnerPoolId && po._cleanupBlockedRule)
            ? po._cleanupBlockedRule
            : null;
        delete po._cleanupBlockedRule;
    }
}

// ─── Zusammenführen ───────────────────────────────────────────────────────────

// Aggregat für's Dashboard: hat IRGENDEIN Pool eine offene Position? Frisch nach
// der Installation (oder nach einem Voll-Exit ohne Wiedereinstieg) sind alle
// Pools inaktiv — die Tabellen zeigen dann nur leere Platzhalter ohne Erklärung.
// Die vier betroffenen Boxen (Volumen/Fees/Pool-/Operative Metriken) zeigen in
// diesem Fall stattdessen einen "Bot inaktiv"-Hinweis (app.js). Bewusst NICHT
// die Opportunity-Box — deren Premium-Sperre ist unabhängig vom Bot-Zustand.
const botActive = poolsOverview.some(p => p.active);

// bot_state kommt aus kv_config: 'offline' wird NUR vom SIGTERM/SIGINT-Handler
// in bot.js gesetzt (bewusster Stop über bin/svc bzw. Settings) und dort direkt
// vor dem letzten Export geschrieben. Fehlt der Eintrag (Tabelle noch nicht
// angelegt, z.B. manueller export.js-Lauf vor dem ersten Bot-Start) → 'running'
// als Default, damit das Dashboard dann normal über das Datenalter alarmiert.
let botState = 'running';
try {
    const row = db.prepare(`SELECT value FROM kv_config WHERE key = 'bot_state'`).get();
    if (row?.value) botState = row.value;
} catch { /* kv_config existiert noch nicht */ }

// ─── Live-Daten (jede Minute geschrieben) ────────────────────────────────────
const data = {
    bot:           'Liquidity Bot',
    botActive,
    botState,
    version:       VERSION,
    timestamp:     new Date().toISOString(),
    activeProfile,   // 'medium' | 'short' — Sortierung in pools/positions ist profil-aware

    portfolio: {
        capitalToday,
        capitalYesterday,
        capitalMonth,
        currentValue,
        balance,
        walletValueUsd,
        feesPendingUsd,
        totalFees:          round2(totalFees.total),
        feesToday:          round2(feesToday),
        feesYesterday:      round2(feesYesterday),
        feesMonth:          round2(feesMonth),
        txFeesToday:        round6(txFeesToday),
        txFeesYesterday:    round6(txFeesYesterday),
        txFeesMonth:        round6(txFeesMonth),
        pnlToday,
        pnlYesterday,
        pnlMonth,
        pnl24h,
        impermanentLoss,
        impermanentLossPct,
        avgApr:             round2(avgApr),
        totalRebalances:    rebalanceCount.cnt,
        lastRebalanceAt:    lastRebalance?.rebalanced_at ?? null,
        // Vorberechnete Anzeige-Werte (single source – app.js zeigt nur an, LMB#0167):
        apr:                statsApr,
        netto:              statsNetto,
        payedFeesUsdc:      statsPayedFeesUsdc,
        apr24h:             statsApr24h,
    },
    dailyFees,
    dailyPnl,
    hourlyPnl,
    claimHistory,

    botConfig: {
        rewardAction:         process.env.REWARD_ACTION ?? 'reinvest',
        rebalanceEnabled:     (process.env.REBALANCE_ENABLED ?? 'true') === 'true',
        rebalanceThresholdPct: parseFloat(process.env.REBALANCE_THRESHOLD_PCT ?? '2'),
        rebalanceCooldownMin: parseInt(process.env.REBALANCE_COOLDOWN_MINUTES ?? '120', 10),
        rangeMode:            process.env.RANGE_MODE ?? 'fixed',
        rangeFixedPct:        parseFloat(process.env.RANGE_FIXED_PCT ?? '20'),
        rangeAtrPeriod:       parseInt(process.env.RANGE_ATR_PERIOD ?? '14', 10),
        rangeAtrMultiplier:   parseFloat(process.env.RANGE_ATR_MULTIPLIER ?? '2.0'),
    },

    poolSettings,
    maintenance: maintenanceFlag ? {
        active:    true,
        reason:    maintenanceFlag.reason,
        expiresAt: maintenanceFlag.expiresAt,
    } : null,

    pools:       poolsOverview,
    opportunityScores,
    // Herkunft der Scores für das Dashboard (Entscheidung 2026-07-25 „Zustand immer
    // sichtbar"): 'compute' = lokal gerechnet (Master), 'delivered' = über Premium
    // geliefert, 'none' = kein Score verfügbar → Dashboard zeigt Platzhalter statt
    // einer unerklärten Lücke. `scoreStale` = gelieferte Daten älter als 2h.
    scoreSource,
    scoreStale,
    // Premium-Deckung fürs Dashboard (2026-07-29): auf dem Master immer
    // { autoPayEnabled:false, coveredUntilMs:null } (getPremiumCoverage() liefert
    // das sauber, kein Sonderfall hier nötig). Auf dem Fork die exakte, bereits
    // feststehende UTC-Stundengrenze der letzten echten Zahlung — siehe
    // getPremiumCoverage() in lib/premium-wallet.js für die volle Herleitung.
    premiumAutoPayEnabled: _premiumCoverage.autoPayEnabled,
    premiumCoveredUntilMs: _premiumCoverage.coveredUntilMs,
    // 'paid' | 'shared' | null — trennt „bezahlte Stunde" von „Deckung über die
    // Systemdaten-Freigabe". Ohne diese Unterscheidung läse das Dashboard eine
    // Freigabe-Deckung als „Auto-Pay aus, Restlaufzeit läuft" und meldete dem
    // Nutzer fälschlich, der Premium Service sei deaktiviert (siehe app.js).
    premiumCoverageSource: _premiumCoverage.coverageSource,
    // Nur bei echtem outagePaused (Master/Netzwerk nicht erreichbar) darf das
    // Dashboard veraltete Daten als "Premium Service derzeit nicht erreichbar"
    // erklären. Fehlendes Guthaben ist eine ANDERE Ursache (premiumAutoPayEnabled
    // fällt dabei auf false, outagePaused bleibt false) — siehe app.js.
    premiumOutagePaused: _premiumCoverage.outagePaused,
    tierOverview: buildTierOverview(poolsOverview),
    positions:   positionsOut,
    transactions,
    recentClaims,
    notifications,
    rebalances,

    // Single Source (LMB#0166): derselbe Snapshot wie balance/walletValueUsd oben
    // (getLatestWalletBalance), kein zweiter wallet-monitor-Read. Garantiert, dass
    // GESAMT (balance) und WALLET (total_usd) aus demselben Snapshot stammen – sonst
    // kann ein wallet-monitor-Cron-Write zwischen zwei Reads GESAMT < WALLET erzeugen.
    walletMonitor: (() => {
        if (!wallet?.snapshot) return null;
        const snap   = wallet.snapshot;
        const tokens = wallet.tokens ?? [];
        const ageMs  = Date.now() - snap.recorded_at;
        const solOracle = db.prepare(
            `SELECT price FROM oracle_prices WHERE quote_pool_id = 'liq-sol-usdc' LIMIT 1`
        ).get();
        const solPriceUsd = solOracle?.price ?? null;
        return {
            snapshot: { ...snap, sol_price_usd: solPriceUsd, age_seconds: Math.round(ageMs / 1000), is_stale: ageMs > 20 * 60 * 1000 },
            tokens,
        };
    })(),
};

// ─── History-Daten (alle 5 Minuten geschrieben) ───────────────────────────────
const dataHistory = {
    portfolioHistory,
    aprHistory,
    tvlHistory,
    priceHistory,
    myAprHistory,
    posValueHistory,
    npHistory,
    scoreHistory,
    pnlHistory,
    compositionHistory,
    volumeHistory,
};

// ─── Atomic Write ─────────────────────────────────────────────────────────────

// Live-Datei: immer schreiben (klein, ~20–30 KB)
const tmpFile = `${DATA_FILE}.${process.pid}.tmp`;
writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
renameSync(tmpFile, DATA_FILE);

// History-Datei: nur alle 5 Minuten schreiben (groß, ~2–3 MB)
// rsync überspringt Dateien mit unverändertem mtime → 5× weniger Transfer
let historyAgeMs = Infinity;
try { historyAgeMs = Date.now() - statSync(HISTORY_FILE).mtimeMs; } catch { /* existiert noch nicht */ }

if (historyAgeMs >= HISTORY_MAX_AGE_MS) {
    const tmpHist = `${HISTORY_FILE}.${process.pid}.tmp`;
    writeFileSync(tmpHist, JSON.stringify(dataHistory), 'utf-8'); // kompaktes JSON, kein pretty-print
    renameSync(tmpHist, HISTORY_FILE);
    console.log(`export.js: data-history.json geschrieben (${priceHistory.length} Preispunkte)`);
}

// ─── Price-History-Export (für Chart-Modal) ────────────────────────────────
// Stündlich gesampelt, letzte 30 Tage, ~160 KB raw / ~60 KB gzip.
// Enthält tokenA/tokenB pro Pool damit der Browser den passenden Pool für
// USD-Charts (Token vs. USDC) clientseitig finden kann.
{
    const rows = db.prepare(`
        SELECT ps.pool_id, ps.recorded_at AS ts, ps.price
        FROM pool_stats ps
        INNER JOIN (
            SELECT pool_id,
                   CAST(recorded_at / 3600000 AS INTEGER) AS hour_bucket,
                   MAX(recorded_at) AS max_ts
            FROM pool_stats
            WHERE recorded_at > (strftime('%s','now') * 1000 - 30 * 86400000)
            GROUP BY pool_id, hour_bucket
        ) h ON ps.pool_id = h.pool_id AND ps.recorded_at = h.max_ts
        ORDER BY ps.pool_id, ps.recorded_at
    `).all();

    const byPool = {};
    for (const { pool_id, ts, price } of rows) {
        (byPool[pool_id] ??= []).push([ts, price]);
    }

    const poolMeta = {};
    for (const p of pools) {
        if (byPool[p.id]) {
            poolMeta[p.id] = { tokenA: p.token_a, tokenB: p.token_b, data: byPool[p.id] };
        }
    }

    const tmpPH = `${PRICE_HISTORY_FILE}.${process.pid}.tmp`;
    writeFileSync(tmpPH, JSON.stringify({ generated: Date.now(), pools: poolMeta }), 'utf-8');
    renameSync(tmpPH, PRICE_HISTORY_FILE);
}

db.close();
// Frontend-Sprachbundle (html/i18n/active.js) auffrischen.
//
// Hier und nicht nur beim Setzen der Sprache: html/ wird bei jedem Update komplett
// ersetzt, das generierte Bundle ist danach weg. Ohne diese Selbstheilung liefe
// eine englische Installation nach jedem Update wieder auf Deutsch. Schreibt nur
// bei echter Änderung — bin/sync.sh rsync't html/ jede Minute.
try { writeFrontendBundle(); } catch (err) { console.warn(`export.js: i18n-Bundle nicht aktualisierbar – ${err.message}`); }

console.log(`export.js: data.json geschrieben (${positionsOut.filter(p=>p.active).length} aktive Positionen)`);
