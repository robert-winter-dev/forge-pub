#!/usr/bin/env node
/**
 * FORGE LendingBot – Auto-Deposit CLI
 *
 * Zahlt USDC-Beträge automatisch nach der 3-Stufen-Logik ein:
 *
 *   Stufe 1:  < 50 USDC  → alles in besten Pool (1 TX)
 *   Stufe 2: 50–99 USDC  → Smart Deposit: in untergewichtetsten Top-3-Pool (1 TX)
 *   Stufe 3: ≥ 100 USDC  → 3:2:1 Split auf Top-3 (bis zu 3 TXs)
 *
 * Verwendung:
 *   node bin/auto-deposit.js --amount 400
 *   node bin/auto-deposit.js --amount 400 --dry-run
 *   node bin/auto-deposit.js --diagnose
 */

import { parseArgs }   from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { config }                                         from '../lib/config.js';
import { getDb, getActivePositions, addPosition, addToPosition,
         recordTransaction }                              from '../lib/db.js';
import { loadKeypair, signAndSend, getUsdcBalance }       from '../lib/wallet.js';
import { createProtocolByName }                           from '../lib/lending-protocols.js';
import { get72hPoolStats, getQualifiedPools,
         computeDepositPlan, diagnose,
         REBALANCER_CONFIG }                              from '../lib/rebalancer.js';

// ── CLI-Argumente ─────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        amount:    { type: 'string'  },
        'dry-run': { type: 'boolean', default: false },
        diagnose:  { type: 'boolean', default: false },
        help:      { type: 'boolean', default: false },
    },
});

if (args.help) {
    const c = REBALANCER_CONFIG;
    console.log(`
FORGE LendingBot – Auto-Deposit

  node bin/auto-deposit.js --amount <USDC>   Deposit mit automatischer Aufteilung
  node bin/auto-deposit.js --diagnose        Pool-Qualifikation anzeigen
  node bin/auto-deposit.js --dry-run ...     Nur Vorschau, keine TX

Stufen:
  Stufe 1: <  ${c.depositSmallMax} USDC  → alles in besten Pool (1 TX)
  Stufe 2: ${c.depositSmallMax}–${c.depositLargeMin - 1} USDC  → Smart Deposit: untergewichtetster Pool (1 TX)
  Stufe 3: ≥ ${c.depositLargeMin} USDC  → ${c.ratios.join(':')}-Split auf Top-3 (bis zu 3 TXs)

Qualifikation:
  APY (72h-Ø) ≥ ${c.minApyPct}%  |  TVL ≥ ${(c.minTvlUsdc / 1e6).toFixed(0)}M  |  mind. ${c.minQualifiedPools} Pools
`);
    process.exit(0);
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

const SEP = '─'.repeat(52);

function fmtUsdc(n) {
    return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' USDC';
}

function fmtApy(n) {
    return n != null ? n.toFixed(2) + '% ⌀72h' : '—';
}

// ── Aktuelle Positionen als Map aufbauen (Duplikate zusammenführen) ───────────

function buildCurrentAmounts() {
    const map = new Map();
    for (const p of getActivePositions()) {
        map.set(p.protocol, (map.get(p.protocol) ?? 0) + p.amount);
    }
    return map;
}

// ── Hauptprogramm ─────────────────────────────────────────────────────────────

async function main() {
    getDb(); // DB initialisieren

    // ── Diagnose-Modus ────────────────────────────────────────────────────────
    if (args.diagnose) {
        console.log('');
        console.log(diagnose());
        console.log('');
        process.exit(0);
    }

    // ── Amount prüfen ─────────────────────────────────────────────────────────
    const amount = parseFloat(args.amount ?? '0');
    if (!amount || amount <= 0 || isNaN(amount)) {
        console.error('❌ Bitte --amount angeben (z.B. --amount 400)');
        process.exit(1);
    }

    const isDryRun = args['dry-run'];
    const keypair  = loadKeypair();
    const wallet   = keypair.publicKey.toBase58();

    // ── USDC-Balance prüfen ───────────────────────────────────────────────────
    let usdcBalance = 0;
    try {
        usdcBalance = await getUsdcBalance(wallet);
    } catch (err) {
        console.error(`❌ USDC-Balance nicht abrufbar: ${err.message}`);
        process.exit(1);
    }
    if (!isDryRun && usdcBalance < amount) {
        console.error(`❌ Nicht genug USDC: Wallet hat ${fmtUsdc(usdcBalance)}, benötigt ${fmtUsdc(amount)}`);
        process.exit(1);
    }

    // ── Pool-Qualifikation ────────────────────────────────────────────────────
    const stats72h       = get72hPoolStats();
    const qualified      = getQualifiedPools(stats72h);
    const currentAmounts = buildCurrentAmounts();

    // ── Deposit-Plan berechnen ────────────────────────────────────────────────
    const plan = computeDepositPlan(amount, qualified, currentAmounts);

    // ── Anzeige ───────────────────────────────────────────────────────────────
    console.log('');
    console.log('  FORGE LendingBot – Auto-Deposit');
    console.log(SEP);
    console.log(`  Wallet          : ${wallet}`);
    console.log(`  Einzuzahlen     : ${fmtUsdc(amount)}`);
    console.log(`  Wallet-Guthaben : ${fmtUsdc(usdcBalance)}`);
    console.log(`  Qualif. Pools   : ${qualified.length}`);
    console.log(SEP);

    if (plan.length === 0) {
        console.log('  ⚠️  Kein Deposit möglich – keine qualifizierten Pools verfügbar.');
        console.log('  Tipp: node bin/auto-deposit.js --diagnose');
        console.log('');
        process.exit(1);
    }

    console.log('  Deposit-Plan:');
    for (const step of plan) {
        const stats = stats72h.get(step.protocol);
        console.log(`    → ${step.protocol.padEnd(24)} ${fmtUsdc(step.amount).padStart(14)}  (${fmtApy(stats?.avgApy)})`);
        console.log(`       ${step.reason}`);
    }
    console.log(SEP);

    if (isDryRun) {
        console.log('  [DRY RUN] Keine Transaktion ausgeführt.');
        console.log('');
        process.exit(0);
    }

    // ── Bestätigung ───────────────────────────────────────────────────────────
    const rl     = createInterface({ input, output });
    const answer = await rl.question('  Fortfahren? [j/N] ');
    rl.close();
    if (answer.trim().toLowerCase() !== 'j') {
        console.log('  Abgebrochen.');
        console.log('');
        process.exit(0);
    }

    // ── Deposits ausführen ────────────────────────────────────────────────────
    let allOk = true;
    for (const step of plan) {
        process.stdout.write(`\n  Deposit ${fmtUsdc(step.amount)} → ${step.protocol} … `);
        try {
            const proto  = createProtocolByName(step.protocol);
            const txData = await proto.buildDepositTx(wallet, step.amount);

            // buildDepositTx kann entweder einen string (base64) oder ein Objekt zurückgeben
            const base64            = typeof txData === 'string' ? txData : (txData.transaction ?? txData);
            const preserveBlockhash = typeof txData === 'object' ? (txData.preserveBlockhash ?? true) : true;

            const txSig = await signAndSend(base64, keypair, { preserveBlockhash });
            console.log('✅');
            console.log(`     TX: https://solscan.io/tx/${txSig}`);

            // Position in DB erfassen – bestehende Position erhöhen, sonst neu anlegen.
            // addToPosition verhindert, dass der Stale-API-Schutz in bot.js fälschlicherweise
            // triggert (Deposit-Sprung sieht wie stale API-Response aus wenn zwei Einträge existieren).
            const proto2 = createProtocolByName(step.protocol); // frische Instanz für poolType
            const existingPos = getActivePositions().filter(p => p.protocol === step.protocol);
            if (existingPos.length > 0) {
                addToPosition(existingPos[0].id, step.amount);
            } else {
                addPosition({
                    protocol: step.protocol,
                    poolType: proto2.poolType ?? 'lending',
                    asset:    'USDC',
                    amount:   step.amount,
                    txHash:   txSig,
                });
            }
            recordTransaction({
                type:     'deposit',
                protocol: step.protocol,
                poolType: proto2.poolType ?? 'lending',
                amount:   step.amount,
                txHash:   txSig,
                note:     `Auto-Deposit (${step.reason})`,
            });

        } catch (err) {
            console.error(`❌ ${err.message}`);
            allOk = false;
        }
    }

    console.log('');
    console.log(SEP);
    if (allOk) {
        const total = plan.reduce((s, p) => s + p.amount, 0);
        console.log(`  ✅ Deposit abgeschlossen: ${fmtUsdc(total)} investiert.`);
    } else {
        console.log('  ⚠️  Einige Deposits fehlgeschlagen – Logs prüfen.');
    }
    console.log('');
}

main().catch(err => {
    console.error(`\n❌ Kritischer Fehler: ${err.message}`);
    console.error(err);
    process.exit(1);
});
