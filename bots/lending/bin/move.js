#!/usr/bin/env node
/**
 * FORGE LendingBot – CLI: Move (manuelles Umschichten)
 *
 * Verschiebt USDC von einem Pool in einen anderen.
 * Während der Ausführung wird eine Lock-Datei gesetzt, die den Bot daran
 * hindert, Gelder automatisch wieder zu deployen oder umzuschichten.
 *
 * Verwendung:
 *   node bin/move.js --from kamino-huma  --to loopscale-genesis
 *   node bin/move.js --from kamino-figure --to loopscale-genesis --amount 150
 *   node bin/move.js --from kamino-huma  --to loopscale-genesis --dry-run
 *
 * Optionen:
 *   --from      Quell-Pool (Pflicht)
 *   --to        Ziel-Pool  (Pflicht)
 *   --amount    USDC-Betrag oder 'all' (Standard: all)
 *   --dry-run   Zeigt Vorschau, führt keine TXs aus
 *   --yes       Überspringt Bestätigung
 */

import { createInterface }    from 'readline';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, dirname, join }   from 'path';
import { fileURLToPath }      from 'url';

import { config }             from '../lib/config.js';
import {
    KaminoProtocol, JupiterLendProtocol,
    DriftProtocol, LoopscaleProtocol,
} from '../lib/lending-protocols.js';
import { loadKeypair, signAndSend, getSolBalance } from '../lib/wallet.js';
import {
    getDb, openPosition, addToPosition, closePosition,
    getActivePositions, recordTransaction,
    upsertWalletSnapshot, getWalletSnapshot,
} from '../lib/db.js';
import { PATHS } from '../../../config/paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCK_FILE = join(PATHS.lendingData, 'move.lock');

// ─── Argument-Parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : null;
}

const fromProto   = getArg('--from')?.toLowerCase();
const toProto     = getArg('--to')?.toLowerCase();
const amountRaw   = getArg('--amount') ?? 'all';
const dryRun      = args.includes('--dry-run');
const skipConfirm = args.includes('--yes');

const amount = amountRaw === 'all' ? 'all' : parseFloat(amountRaw);

// ─── Validierung ──────────────────────────────────────────────────────────────

const VALID_PROTOCOLS = [
    ...Object.keys(config.kamino.markets),
    'jupiter', 'drift',
    ...Object.keys(config.loopscale.vaults),
];

if (!fromProto || !VALID_PROTOCOLS.includes(fromProto)) {
    console.error(`Fehler: --from muss eines von: ${VALID_PROTOCOLS.join(', ')}`);
    process.exit(1);
}
if (!toProto || !VALID_PROTOCOLS.includes(toProto)) {
    console.error(`Fehler: --to muss eines von: ${VALID_PROTOCOLS.join(', ')}`);
    process.exit(1);
}
if (fromProto === toProto) {
    console.error('Fehler: --from und --to dürfen nicht identisch sein.');
    process.exit(1);
}
if (amount !== 'all' && (isNaN(amount) || amount <= 0)) {
    console.error('Fehler: --amount muss eine positive Zahl oder "all" sein.');
    process.exit(1);
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function fmt(n, decimals = 2) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('de-DE', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
}

function hr() { console.log('─'.repeat(56)); }

async function confirm(question) {
    if (skipConfirm) return true;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(['j', 'y', 'ja', 'yes'].includes(answer.trim().toLowerCase()));
        });
    });
}

function buildProtocol(name) {
    const kaminoMarket   = config.kamino.markets[name];
    const loopscaleVault = config.loopscale.vaults[name];
    if (name === 'jupiter') return new JupiterLendProtocol();
    if (name === 'drift')   return new DriftProtocol();
    if (kaminoMarket)       return new KaminoProtocol({
        name,
        label:       kaminoMarket.label,
        market:      kaminoMarket.market,
        usdcReserve: kaminoMarket.reserve,
    });
    if (loopscaleVault)     return new LoopscaleProtocol({
        name,
        label:        loopscaleVault.label,
        vaultAddress: loopscaleVault.address,
    });
    throw new Error(`Unbekanntes Protokoll: ${name}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const walletAddress = loadKeypair().publicKey.toBase58();
    const protoFrom     = buildProtocol(fromProto);
    const protoTo       = buildProtocol(toProto);

    console.log('');
    console.log('  FORGE LendingBot – Move');
    hr();
    console.log(`  Von      : ${protoFrom.label}`);
    console.log(`  Nach     : ${protoTo.label}`);
    console.log(`  Betrag   : ${amount === 'all' ? 'Alles' : fmt(amount) + ' USDC'}`);
    console.log(`  Wallet   : ${walletAddress}`);
    if (dryRun) console.log('  Modus    : 🔍 DRY-RUN (keine TXs werden gesendet)');
    hr();

    // ── SOL-Balance prüfen ────────────────────────────────────────────────────
    process.stdout.write('  SOL-Balance … ');
    const solBalance = await getSolBalance(walletAddress);
    console.log(`${fmt(solBalance, 4)} SOL`);
    if (solBalance < config.solReserve) {
        console.error(`\n  ❌ Zu wenig SOL für Fees (min. ${config.solReserve} SOL)`);
        process.exit(1);
    }

    // ── Quell-Position prüfen ─────────────────────────────────────────────────
    process.stdout.write(`  Position ${protoFrom.label} … `);
    let position;
    try {
        position = await protoFrom.getPosition(walletAddress);
        if (position) {
            console.log(`${fmt(position.amount)} USDC`);
        } else {
            console.log('keine Position gefunden');
            console.error(`\n  ❌ Keine aktive Position in ${protoFrom.label} – Abbruch.`);
            process.exit(1);
        }
    } catch (err) {
        console.log(`⚠ Nicht abfragbar: ${err.message}`);
        position = null;
    }

    const effectiveAmount = amount === 'all'
        ? (position?.maxWithdrawable ?? position?.amount ?? null)
        : amount;

    if (effectiveAmount == null) {
        console.error('\n  ❌ Betrag konnte nicht bestimmt werden.');
        process.exit(1);
    }

    // ── Ziel-Pool: APY vorab prüfen ───────────────────────────────────────────
    process.stdout.write(`  APY ${protoTo.label} … `);
    let targetApy = null;
    let targetTvl = null;
    try {
        const stats = await protoTo.getPoolStats();
        targetApy = stats.apy ?? null;
        targetTvl = stats.tvl ?? null;
        console.log(`${fmt(targetApy, 2)} %`
            + (targetTvl != null ? ` | TVL: $${targetTvl >= 1e6
                ? (targetTvl/1e6).toFixed(1)+'M'
                : (targetTvl/1e3).toFixed(0)+'K'}` : ''));
    } catch (err) {
        console.log(`⚠ Nicht abfragbar: ${err.message}`);
    }

    hr();

    // ── Dry-Run: Zusammenfassung ──────────────────────────────────────────────
    if (dryRun) {
        console.log('  📋 Vorschau:');
        console.log(`     ${fmt(effectiveAmount)} USDC aus ${protoFrom.label} abheben`);
        console.log(`     ${fmt(effectiveAmount)} USDC in ${protoTo.label} einzahlen`);
        if (targetApy) {
            const yearly = effectiveAmount * (targetApy / 100);
            console.log(`     Erwarteter Jahres-Yield: ~${fmt(yearly)} USDC (${fmt(targetApy, 2)} % APY)`);
        }
        console.log('');
        console.log('  ℹ Dry-Run: keine Transaktionen gesendet.');
        process.exit(0);
    }

    // ── Bestätigung ───────────────────────────────────────────────────────────
    console.log(`  ${fmt(effectiveAmount)} USDC werden umgeschichtet:`);
    console.log(`    ${protoFrom.label}  →  ${protoTo.label}`);
    if (targetApy) console.log(`  Ziel-APY: ${fmt(targetApy, 2)} %`);
    console.log('');
    console.log('  ⚠  Auto-Deploy und Auto-Rebalancing werden für die Dauer pausiert.');
    console.log('');

    const ok = await confirm('  Fortfahren? [j/N] ');
    if (!ok) {
        console.log('\n  Abgebrochen.');
        process.exit(0);
    }
    console.log('');

    // ── Lock setzen ───────────────────────────────────────────────────────────
    const lockInfo = JSON.stringify({
        pid:     process.pid,
        from:    fromProto,
        to:      toProto,
        amount:  effectiveAmount,
        startedAt: new Date().toISOString(),
    });
    writeFileSync(LOCK_FILE, lockInfo, 'utf-8');
    console.log('  🔒 Lock gesetzt – Auto-Deploy + Auto-Rebalancing pausiert');
    console.log('');

    try {
        // ── Schritt 1: Withdraw ───────────────────────────────────────────────
        console.log(`  [1/2] Withdraw aus ${protoFrom.label} …`);
        process.stdout.write('        TX wird erstellt … ');
        const withdrawResult = await protoFrom.buildWithdrawTx(walletAddress, effectiveAmount);
        console.log(`✓ (${withdrawResult.type})`);

        process.stdout.write('        TX signieren + senden … ');
        const keypair = loadKeypair();
        const txSigWithdraw = await signAndSend(
            withdrawResult.transaction, keypair,
            { preserveBlockhash: withdrawResult.preserveBlockhash ?? false }
        );
        console.log('✓');
        console.log(`        TX: ${txSigWithdraw}`);

        // DB: Quell-Position schließen
        try {
            getDb();
            getActivePositions()
                .filter(p => p.protocol === fromProto)
                .forEach(p => closePosition(p.id));
            recordTransaction({
                type:     'withdraw',
                protocol: fromProto,
                poolType: protoFrom.poolType ?? fromProto,
                asset:    'USDC',
                amount:   effectiveAmount,
                txHash:   txSigWithdraw,
                note:     `Move → ${toProto}`,
            });
        } catch (dbErr) {
            console.warn(`        ⚠ DB-Update (Withdraw) fehlgeschlagen: ${dbErr.message}`);
        }

        console.log(`        ✅ Withdraw erfolgreich (${fmt(effectiveAmount)} USDC)`);
        console.log('');

        // ── Schritt 2: Deposit ────────────────────────────────────────────────
        console.log(`  [2/2] Deposit in ${protoTo.label} …`);
        process.stdout.write('        TX wird erstellt … ');
        const isLoopscale = protoTo instanceof LoopscaleProtocol;
        const depositTxData = await protoTo.buildDepositTx(walletAddress, effectiveAmount);
        console.log('✓');

        process.stdout.write('        TX signieren + senden … ');
        const txSigDeposit = await signAndSend(depositTxData, keypair, {
            preserveBlockhash: isLoopscale,
        });
        console.log('✓');
        console.log(`        TX: ${txSigDeposit}`);

        // DB: Ziel-Position öffnen oder Betrag erhöhen
        try {
            getDb();
            const existingPos = getActivePositions().find(p => p.protocol === toProto);
            if (existingPos) {
                addToPosition(existingPos.id, effectiveAmount);
            } else {
                openPosition({
                    protocol: toProto,
                    poolType: protoTo.poolType ?? toProto,
                    asset:    'USDC',
                    amount:   effectiveAmount,
                    txHash:   txSigDeposit,
                });
            }
            recordTransaction({
                type:     'deposit',
                protocol: toProto,
                poolType: protoTo.poolType ?? toProto,
                asset:    'USDC',
                amount:   effectiveAmount,
                txHash:   txSigDeposit,
                note:     `Move ← ${fromProto}`,
            });

            // Wallet-Snapshot: Kapital bleibt gleich, nur Protokoll wechselt
            const snap = getWalletSnapshot();
            if (snap) {
                upsertWalletSnapshot({
                    currentValue: snap.current_value,
                    totalYield:   snap.total_yield ?? 0,
                    avgApy:       targetApy ?? snap.avg_apy ?? 0,
                    walletUsdc:   Math.max(0, (snap.wallet_usdc ?? 0) - effectiveAmount),
                    walletSol:    solBalance,
                });
            }
        } catch (dbErr) {
            console.warn(`        ⚠ DB-Update (Deposit) fehlgeschlagen: ${dbErr.message}`);
        }

        console.log(`        ✅ Deposit erfolgreich (${fmt(effectiveAmount)} USDC)`);
        console.log('');

        // ── Ergebnis ──────────────────────────────────────────────────────────
        hr();
        console.log('  ✅ Move abgeschlossen!');
        console.log('');
        console.log(`  Betrag     : ${fmt(effectiveAmount)} USDC`);
        console.log(`  Von        : ${protoFrom.label}`);
        console.log(`  Nach       : ${protoTo.label}`);
        console.log(`  Withdraw TX: https://solscan.io/tx/${txSigWithdraw}`);
        console.log(`  Deposit TX : https://solscan.io/tx/${txSigDeposit}`);
        hr();
        console.log('');

    } catch (err) {
        if (err.technicalDetail) console.error(`  [debug] ${err.technicalDetail}`);
        console.error(`\n  ❌ Fehler: ${err.message}`);
        console.error('     Lock wird trotzdem entfernt.');
        process.exitCode = 1;
    } finally {
        // Lock immer entfernen – auch bei Fehlern
        try { unlinkSync(LOCK_FILE); } catch { /* bereits gelöscht oder nie angelegt */ }
        console.log('  🔓 Lock entfernt – Auto-Deploy + Auto-Rebalancing wieder aktiv.');
    }
}

main().catch(err => {
    console.error(`\n  ❌ Unerwarteter Fehler: ${err.message}`);
    try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    process.exit(1);
});
