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
import { t, numLocale } from '../../../lib/i18n.js';
import {
    KaminoProtocol, JupiterLendProtocol,
    DriftProtocol, LoopscaleProtocol,
} from '../lib/lending-protocols.js';
import { loadKeypair, signAndSend, getSolBalance } from '../lib/wallet.js';
import {
    getDb, openPosition, addToPosition, closePosition,
    getActivePositions, recordTransaction,
    upsertWalletSnapshot, getWalletSnapshot, addNotification,
} from '../lib/db.js';
import * as notify from '../lib/notify.js';
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
    console.error(t('cli.lend.from_required', { list: VALID_PROTOCOLS.join(', ') }));
    process.exit(1);
}
if (!toProto || !VALID_PROTOCOLS.includes(toProto)) {
    console.error(t('cli.lend.to_required', { list: VALID_PROTOCOLS.join(', ') }));
    process.exit(1);
}
if (fromProto === toProto) {
    console.error(t('cli.lend.from_to_distinct'));
    process.exit(1);
}
if (amount !== 'all' && (isNaN(amount) || amount <= 0)) {
    console.error(t('cli.lend.amount_positive_or_all_hint'));
    process.exit(1);
}

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function fmt(n, decimals = 2) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString(numLocale(), {
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
    throw new Error(t('cli.lend.unknown_protocol', { protocol: name }));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const walletAddress = loadKeypair().publicKey.toBase58();
    const protoFrom     = buildProtocol(fromProto);
    const protoTo       = buildProtocol(toProto);

    console.log('');
    console.log('  FORGE LendingBot – Move');
    hr();
    console.log(t('cli.lend.mv_from', { v: protoFrom.label }));
    console.log(t('cli.lend.mv_to', { v: protoTo.label }));
    console.log(t('cli.lend.mv_amount', { v: amount === 'all' ? t('cli.lend.all') : fmt(amount) + ' USDC' }));
    console.log(`  Wallet   : ${walletAddress}`);
    if (dryRun) console.log(t('cli.lend.mv_mode_dry'));
    hr();

    // ── SOL-Balance prüfen ────────────────────────────────────────────────────
    process.stdout.write(`  ${t('cli.lend.mv_sol')} `);
    const solBalance = await getSolBalance(walletAddress);
    console.log(`${fmt(solBalance, 4)} SOL`);
    if (solBalance < config.solReserve) {
        console.error(`\n  ❌ ${t('cli.lend.mv_low_sol', { min: config.solReserve })}`);
        process.exit(1);
    }

    // ── Quell-Position prüfen ─────────────────────────────────────────────────
    process.stdout.write(`  ${t('cli.lend.mv_position', { label: protoFrom.label })} `);
    let position;
    try {
        position = await protoFrom.getPosition(walletAddress);
        if (position) {
            console.log(`${fmt(position.amount)} USDC`);
        } else {
            console.log(t('cli.lend.no_position_found'));
            console.error(`\n  ❌ ${t('cli.lend.mv_no_position', { label: protoFrom.label })}`);
            process.exit(1);
        }
    } catch (err) {
        console.log(`⚠ ${t('cli.lend.not_queryable', { error: err.message })}`);
        position = null;
    }

    const effectiveAmount = amount === 'all'
        ? (position?.maxWithdrawable ?? position?.amount ?? null)
        : amount;

    if (effectiveAmount == null) {
        console.error(`\n  ❌ ${t('cli.lend.amount_undetermined')}.`);
        process.exit(1);
    }

    // ── Ziel-Pool: APY vorab prüfen ───────────────────────────────────────────
    process.stdout.write(`  ${t('cli.lend.mv_apy', { label: protoTo.label })} `);
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
        console.log(`⚠ ${t('cli.lend.not_queryable', { error: err.message })}`);
    }

    hr();

    // ── Dry-Run: Zusammenfassung ──────────────────────────────────────────────
    if (dryRun) {
        console.log(`  📋 ${t('cli.lend.preview')}`);
        console.log(`     ${t('cli.lend.mv_prev_withdraw', { usdc: fmt(effectiveAmount), label: protoFrom.label })}`);
        console.log(`     ${t('cli.lend.mv_prev_deposit', { usdc: fmt(effectiveAmount), label: protoTo.label })}`);
        if (targetApy) {
            const yearly = effectiveAmount * (targetApy / 100);
            console.log(`     ${t('cli.lend.preview_yearly', { usdc: fmt(yearly), apy: fmt(targetApy, 2) })}`);
        }
        console.log('');
        console.log(`  ℹ ${t('cli.lend.dryrun_no_tx')}`);
        process.exit(0);
    }

    // ── Bestätigung ───────────────────────────────────────────────────────────
    console.log(`  ${t('cli.lend.mv_confirm', { usdc: fmt(effectiveAmount) })}`);
    console.log(`    ${protoFrom.label}  →  ${protoTo.label}`);
    if (targetApy) console.log(`  ${t('cli.lend.mv_target_apy', { apy: fmt(targetApy, 2) })}`);
    console.log('');
    console.log(`  ⚠  ${t('cli.lend.mv_pause_warn')}`);
    console.log('');

    const ok = await confirm(`  ${t('cli.lend.proceed')} `);
    if (!ok) {
        console.log(`\n  ${t('cli.lend.aborted')}`);
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
    console.log(`  🔒 ${t('cli.lend.mv_lock_set')}`);
    console.log('');

    try {
        // ── Schritt 1: Withdraw ───────────────────────────────────────────────
        console.log(`  [1/2] ${t('cli.lend.mv_step1', { label: protoFrom.label })}`);
        process.stdout.write(`        ${t('cli.lend.step_build_tx')} `);
        const withdrawResult = await protoFrom.buildWithdrawTx(walletAddress, effectiveAmount);
        console.log(`✓ (${withdrawResult.type})`);

        process.stdout.write(`        ${t('cli.lend.step_sign_send')} `);
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
            console.warn(`        ⚠ ${t('cli.lend.mv_db_failed', { step: 'Withdraw', error: dbErr.message })}`);
        }

        console.log(`        ✅ ${t('cli.lend.mv_withdraw_ok', { usdc: fmt(effectiveAmount) })}`);

        // Ungestakte LP-Reste erkennen (nur Loopscale) – siehe
        // LoopscaleProtocol.checkLeftoverLp() in lib/lending-protocols.js für Hintergrund.
        if (protoFrom instanceof LoopscaleProtocol) {
            const leftoverLp = await protoFrom.checkLeftoverLp(walletAddress);
            if (leftoverLp) {
                const usdcStr  = leftoverLp.estimatedUsdc != null ? ` (~${fmt(leftoverLp.estimatedUsdc)} USDC)` : '';
                const lpParams = { pool: protoFrom.label, lp: leftoverLp.lpAmount.toFixed(6), usdc: usdcStr };
                console.log(`        ${t('notify.len.lp_remainder_short', lpParams)}`);
                try {
                    addNotification({ level: 'warn', msgKey: 'notify.len.lp_remainder_short', params: lpParams });
                } catch { /* Best-Effort */ }
                // Katalog-Verweis statt fertigem Text: gerendert wird beim Anzeigen (Konvention 2, i18n.md §3e)
                await notify.lpRemainder(protoFrom.label, { k: 'notify.len.lp_remainder_short', p: lpParams });
            }
        }
        console.log('');

        // ── Schritt 2: Deposit ────────────────────────────────────────────────
        console.log(`  [2/2] ${t('cli.lend.mv_step2', { label: protoTo.label })}`);
        process.stdout.write(`        ${t('cli.lend.step_build_tx')} `);
        const isLoopscale = protoTo instanceof LoopscaleProtocol;
        const depositTxData = await protoTo.buildDepositTx(walletAddress, effectiveAmount);
        console.log('✓');

        process.stdout.write(`        ${t('cli.lend.step_sign_send')} `);
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
            console.warn(`        ⚠ ${t('cli.lend.mv_db_failed', { step: 'Deposit', error: dbErr.message })}`);
        }

        console.log(`        ✅ ${t('cli.lend.mv_deposit_ok', { usdc: fmt(effectiveAmount) })}`);
        console.log('');

        // ── Ergebnis ──────────────────────────────────────────────────────────
        hr();
        console.log(`  ✅ ${t('cli.lend.mv_done')}`);
        console.log('');
        console.log(t('cli.lend.mv_res_amount', { v: `${fmt(effectiveAmount)} USDC` }));
        console.log(t('cli.lend.mv_res_from', { v: protoFrom.label }));
        console.log(t('cli.lend.mv_res_to', { v: protoTo.label }));
        console.log(`  Withdraw TX: https://solscan.io/tx/${txSigWithdraw}`);
        console.log(`  Deposit TX : https://solscan.io/tx/${txSigDeposit}`);
        hr();
        console.log('');

    } catch (err) {
        if (err.technicalDetail) console.error(`  [debug] ${err.technicalDetail}`);
        console.error(`\n  ❌ ${t('cli.lend.mv_error', { error: err.message })}`);
        console.error(`     ${t('cli.lend.mv_lock_removed_anyway')}`);
        process.exitCode = 1;
    } finally {
        // Lock immer entfernen – auch bei Fehlern
        try { unlinkSync(LOCK_FILE); } catch { /* bereits gelöscht oder nie angelegt */ }
        console.log(`  🔓 ${t('cli.lend.mv_lock_removed')}`);
    }
}

main().catch(err => {
    console.error(`\n  ❌ ${t('cli.lend.unexpected', { error: err.message })}`);
    try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
    process.exit(1);
});
