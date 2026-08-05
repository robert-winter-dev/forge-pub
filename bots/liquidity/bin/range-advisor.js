#!/usr/bin/env node
/**
 * FORGE Liquidity – Range Advisor CLI
 *
 * Analysiert einen oder mehrere Pools und gibt Range-Empfehlungen aus.
 *
 * Nutzung:
 *   node bin/range-advisor.js                        # alle aktiven Pools
 *   node bin/range-advisor.js --pool liq-sol-usdc   # einzelner Pool
 *   node bin/range-advisor.js --all                  # alle Pools inkl. inaktiver
 *   node bin/range-advisor.js --capital 2000         # Kapital-Override (USDC)
 *   node bin/range-advisor.js --json                 # JSON-Output
 */

import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';
import { openDatabase }   from '../lib/db.js';
import { loadPools }      from '../lib/config.js';
import { analyzePool } from '../lib/range-advisor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const arg        = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const poolFilter = arg('--pool');
const showAll    = args.includes('--all');
const asJson     = args.includes('--json');
const capitalCli = parseFloat(arg('--capital')) || null;

// ─── Formatierung ────────────────────────────────────────────────────────────

function fmt(n, dp = 1) {
    if (n === null || n === undefined || !isFinite(n)) return '—';
    return n.toLocaleString('de-DE', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

function padL(s, w) { return String(s).padStart(w); }
function padR(s, w) { return String(s).padEnd(w);   }

function verdictLabel(netApr) {
    if (netApr >  50) return '✓ stark';
    if (netApr >  15) return '○ ok';
    if (netApr >   0) return '⚠ schwach';
    return '✗ unwirtschaftlich';
}

function trendLabel(direction, strength) {
    const arrow = direction === 'up' ? '↗' : direction === 'down' ? '↘' : '→';
    const str   = strength > 0.5 ? ' (stark)' : strength > 0.2 ? ' (moderat)' : '';
    return `${arrow} ${direction}${str}`;
}

function confidenceLabel(c) {
    return c === 'high' ? '★★★ hoch' : c === 'medium' ? '★★☆ mittel' : '★☆☆ niedrig';
}

// ─── Report pro Pool ─────────────────────────────────────────────────────────

function printPoolReport(result) {
    if (!result) return;

    const { poolId, pair, poolType, recommendation: rec, rationale: rat, marketData, candidates } = result;

    const changeNeeded = rat.currentRange != null
        && Math.abs(rec.rangePct - rat.currentRange) >= 1.0;

    console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║  ${padR(`${pair}  (${poolId})`, 60)}║`);
    console.log(`╚══════════════════════════════════════════════════════════════╝`);

    // Pool-Metadaten
    console.log(`  Typ: ${poolType.padEnd(14)}  ` +
                `TVL: ${fmt(marketData.tvlUsdc / 1_000_000, 2)}M USDC  ` +
                `Vol24h: ${fmt(marketData.vol24h / 1_000_000, 2)}M USDC`);
    if (marketData.orcaError) {
        console.log(`  ⚠ Orca API nicht erreichbar: ${marketData.orcaError}`);
    }

    // Trend & Volatilität
    const vola = rat.volatility;
    console.log(`  Trend: ${trendLabel(rat.trend.direction, rat.trend.strength)}  ` +
                `(EMA10=${fmt(rat.trend.ema10, 4)}  EMA20=${fmt(rat.trend.ema20, 4)}  EMA30=${fmt(rat.trend.ema30, 4)})`);
    console.log(`  Volatilität: ${fmt(vola.hourlyPct, 3)}%/h  annualisiert: ${fmt(vola.annualizedPct, 0)}%  ` +
                `(${vola.dataPoints} Datenpunkte${vola.isFallback ? ', Fallback' : ''})`);

    // Empfehlung
    console.log(`\n  ┌── Empfehlung ─────────────────────────────────────────────┐`);
    const recLine = rec.asymmetry !== 0
        ? `±${rec.rangePct}%  (↓${rec.pctBelow}% / ↑${rec.pctAbove}% asymmetrisch)`
        : `±${rec.rangePct}%  (symmetrisch)`;
    console.log(`  │  Range:        ${padR(recLine, 46)}│`);
    console.log(`  │  Konfidenz:    ${padR(confidenceLabel(rec.confidence), 46)}│`);
    if (rat.currentRange != null) {
        const hint = changeNeeded ? '  ← Änderung empfohlen' : '  ← bereits optimal';
        console.log(`  │  Aktuell:      ±${rat.currentRange}%${hint.padEnd(40)}│`);
    }
    console.log(`  └───────────────────────────────────────────────────────────┘`);

    // Netto-APR der Empfehlung
    const opt = rat.optimalScore;
    console.log(`\n  Brutto-APR:  ${padL(fmt(opt.grossAprPct, 0), 6)}%   ` +
                `OOR alle ${fmt(opt.hoursUntilOor, 1)}h → ${fmt(opt.rebalsPerDay, 2)} Rebals/Tag`);
    console.log(`  Rebal-Kost:  ${padL(fmt(opt.rebalCostAprPct, 0), 6)}%   ` +
                `IL/Jahr: ${fmt(opt.annualIlPct, 0)}%`);
    console.log(`  ─────────────────────────────────────────────────────────`);
    const netStr = `${fmt(opt.netAprPct, 0)}%`;
    console.log(`  Netto-APR:   ${padL(netStr, 6)}    ${verdictLabel(opt.netAprPct)}`);

    // Break-Even
    const be = rat.breakEven;
    if (be.minCapitalUsdc != null) {
        const beStatus = be.isProfitable ? '✓' : `✗ (${fmt(be.minCapitalUsdc, 0)} USDC nötig)`;
        console.log(`\n  Break-Even:  ${fmt(be.minCapitalUsdc, 0)} USDC Mindestkapital  ` +
                    `Aktuell: ${fmt(be.currentCapitalUsdc, 0)} USDC  ${beStatus}`);
    }

    // Historische Rebalancings
    const hr = rat.historicalRebalances;
    if (hr.count > 0) {
        console.log(`  Historisch:  ${hr.count} Rebalancings in 30 Tagen` +
                    `  (${fmt(hr.perDay, 2)}/Tag${hr.avgCostSol ? ', ⌀' + fmt(hr.avgCostSol * 1000, 2) + ' mSOL/Rebal' : ''})`);
    }

    // Kandidaten-Tabelle
    console.log(`\n  ┌─ Alle Kandidaten ────────────────────────────────────────────────────────────┐`);
    console.log(`  │  Range   Brutto-APR   OOR(h)  Rebals/Tag  Rebal-Kost   IL/Jahr  Netto-APR   │`);
    console.log(`  ├──────────────────────────────────────────────────────────────────────────────┤`);
    for (const c of candidates) {
        const isRec     = c.rangePct === rec.rangePct;
        const isCurrent = c.rangePct === rat.currentRange;
        const tag       = isRec ? ' ◄' : isCurrent ? ' ○' : '';
        const netFmt    = `${fmt(c.netAprPct, 0)}%`;
        const flag      = c.profitable ? '' : ' ✗';
        console.log(
            `  │  ±${padL(c.rangePct, 4)}%  ` +
            `${padL(fmt(c.grossAprPct, 0), 8)}%  ` +
            `${padL(fmt(c.hoursUntilOor, 1), 8)}  ` +
            `${padL(fmt(c.rebalsPerDay, 3), 10)}  ` +
            `${padL(fmt(c.rebalCostAprPct, 0), 9)}%  ` +
            `${padL(fmt(c.annualIlPct, 0), 7)}%  ` +
            `${padL(netFmt, 8)}${flag}${tag.padEnd(5)}│`
        );
    }
    console.log(`  └──────────────────────────────────────────────────────────────────────────────┘`);
    console.log(`  ◄ = Empfehlung  ○ = Aktuelle Range`);
}

// ─── Zusammenfassung ─────────────────────────────────────────────────────────

function printSummary(results) {
    const valid = results.filter(r => r != null);
    if (valid.length <= 1) return;

    console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║  Zusammenfassung                                             ║`);
    console.log(`╚══════════════════════════════════════════════════════════════╝`);
    console.log(`  Pool                     Empfehlung   Aktuell   Netto-APR   Konfidenz`);
    console.log(`  ───────────────────────────────────────────────────────────────────`);
    for (const r of valid) {
        const pair    = padR(r.pair, 20);
        const rec     = `±${r.recommendation.rangePct}%`.padEnd(12);
        const cur     = r.rationale.currentRange != null ? `±${r.rationale.currentRange}%`.padEnd(9) : '—'.padEnd(9);
        const net     = `${fmt(r.rationale.optimalScore.netAprPct, 0)}%`.padStart(8);
        const conf    = r.recommendation.confidence;
        const change  = r.rationale.currentRange != null
            && Math.abs(r.recommendation.rangePct - r.rationale.currentRange) >= 1.0
            ? ' ← ändern' : '';
        console.log(`  ${pair}  ${rec}  ${cur}  ${net}   ${conf}${change}`);
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const { all, active } = loadPools();
    const db = openDatabase();

    let pools = showAll ? all : active;
    if (poolFilter) {
        pools = all.filter(p => p.id === poolFilter || p.pair === poolFilter);
        if (pools.length === 0) {
            console.error(`Pool nicht gefunden: ${poolFilter}`);
            process.exit(1);
        }
    }

    const toAnalyze = pools;

    if (!asJson) {
        console.log(`\nAnalysiere ${toAnalyze.length} Pool(s)…`);
    }

    const opts = capitalCli ? { capitalUsdc: capitalCli } : {};
    const results = [];

    for (const pool of toAnalyze) {
        const result = await analyzePool(pool, db, opts);
        results.push(result);
        if (!asJson && result) {
            printPoolReport(result);
        }
    }

    db.close();

    if (asJson) {
        console.log(JSON.stringify(results.filter(Boolean), null, 2));
    } else {
        printSummary(results.filter(Boolean));
        console.log('');
    }
}

main().catch(err => {
    console.error('Fehler:', err.message);
    process.exit(1);
});
