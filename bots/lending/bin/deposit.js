#!/usr/bin/env node
/**
 * FORGE LendingBot – CLI: Deposit
 *
 * Depositet USDC in ein Lending-Protokoll (Kamino, Jupiter, Loopscale).
 *
 * Verwendung:
 *   node bin/deposit.js --protocol kamino         --amount 500
 *   node bin/deposit.js --protocol kamino-figure  --amount 500
 *   node bin/deposit.js --protocol jupiter        --amount 50
 *   node bin/deposit.js --protocol kamino         --amount 500 --dry-run
 *   node bin/deposit.js --protocol kamino         --amount 500 --yes
 *
 * Optionen:
 *   --protocol  kamino | kamino-figure | kamino-onre | jupiter | loopscale-genesis | ...
 *   --amount    USDC-Betrag (z.B. 500)    (Pflicht)
 *   --dry-run   Zeigt Vorschau, sendet keine TX
 *   --yes       Überspringt Bestätigung   (für Scripting)
 */

import { createInterface }      from 'readline';
import { config } from '../lib/config.js';
import { t, numLocale } from '../../../lib/i18n.js';
import { KaminoProtocol, JupiterLendProtocol, DriftProtocol, LoopscaleProtocol } from '../lib/lending-protocols.js';
import { loadKeypair, signAndSend, assertSufficientSol, getSolBalance, fetchFeeSol } from '../lib/wallet.js';
import { getDb, openPosition, addToPosition, getActivePositions,
         recordTransaction, recordProtocolStat,
         upsertWalletSnapshot, getWalletSnapshot } from '../lib/db.js';

// ─── Argument-Parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : null;
}

const protocol    = getArg('--protocol')?.toLowerCase();
const amount      = parseFloat(getArg('--amount') ?? '0');
const dryRun      = args.includes('--dry-run');
const skipConfirm = args.includes('--yes');
const jsonMode    = args.includes('--json');

function jout(data) { console.log(JSON.stringify(data)); }
function jlog(msg)  { if (jsonMode) process.stderr.write(msg + '\n'); else console.log(msg); }
function jerr(msg)  { if (jsonMode) process.stderr.write(msg + '\n'); else console.error(msg); }

// ─── Validierung ──────────────────────────────────────────────────────────────

const VALID_PROTOCOLS = [
    ...Object.keys(config.kamino.markets),          // kamino, kamino-figure, kamino-onre, ...
    'jupiter', 'drift',
    ...Object.keys(config.loopscale.vaults),         // loopscale-onre, loopscale-genesis, ...
];
if (!protocol || !VALID_PROTOCOLS.includes(protocol)) {
    if (jsonMode) jout({ ok: false, error: t('cli.lend.unknown_protocol', { protocol }) });
    else console.error(t('cli.lend.protocol_required', { list: VALID_PROTOCOLS.join('|') }));
    process.exit(1);
}

if (!amount || isNaN(amount) || amount <= 0) {
    if (jsonMode) jout({ ok: false, error: t('cli.lend.amount_positive') });
    else console.error(t('cli.lend.amount_positive_hint'));
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

function hr() { console.log('─'.repeat(52)); }

async function confirm(question) {
    if (skipConfirm) return true;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer.trim().toLowerCase() === 'j' || answer.trim().toLowerCase() === 'y');
        });
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const walletAddress = loadKeypair().publicKey.toBase58();

    if (!jsonMode) {
        console.log('');
        console.log('  FORGE LendingBot – Deposit');
        hr();
    }

    // ── Protokoll-Instanz erstellen ───────────────────────────────────────────
    const kaminoMarket   = config.kamino.markets[protocol];
    const loopscaleVault = config.loopscale.vaults[protocol];
    const proto = protocol === 'jupiter' ? new JupiterLendProtocol()
               : protocol === 'drift'   ? new DriftProtocol()
               : kaminoMarket           ? new KaminoProtocol({
                     name:        protocol,
                     label:       kaminoMarket.label,
                     market:      kaminoMarket.market,
                     usdcReserve: kaminoMarket.reserve,
                 })
               : loopscaleVault         ? new LoopscaleProtocol({
                     name:         protocol,
                     label:        loopscaleVault.label,
                     vaultAddress: loopscaleVault.address,
                 })
               : (() => { throw new Error(t('cli.lend.unknown_protocol', { protocol })); })();

    const protoLabel = proto.label;
    const poolType   = proto.poolType ?? proto.name;

    if (!jsonMode) {
        console.log(t('cli.lend.head_protocol', { v: protoLabel }));
        console.log(`  Wallet    : ${walletAddress}`);
        console.log(t('cli.lend.head_amount', { v: `${fmt(amount)} USDC` }));
        if (dryRun) console.log(t('cli.lend.head_mode_dry'));
        hr();
    }

    // ── SOL-Balance prüfen ────────────────────────────────────────────────────
    jlog(`  ${t('cli.lend.step_sol')}`);
    const solBalance = await getSolBalance(walletAddress);

    if (solBalance < config.solReserve) {
        if (jsonMode) jout({ ok: false, error: t('cli.lend.low_sol', { sol: fmt(solBalance, 4), min: config.solReserve }) });
        else { console.error(`\n  ❌ ${t('cli.lend.low_sol_hdr')}`); console.error(`     ${t('cli.lend.low_sol_have', { sol: fmt(solBalance, 4) })}`); }
        process.exit(1);
    }
    if (!jsonMode) console.log(`     → ${fmt(solBalance, 4)} SOL`);

    // ── Aktuellen APY + TVL abfragen ─────────────────────────────────────────
    jlog(`  ${t('cli.lend.step_apy')}`);
    let currentApy = null;
    let currentTvl = null;
    try {
        const stats = await proto.getPoolStats();
        currentApy = stats.apy ?? null;
        currentTvl = stats.tvl ?? null;
        if (!jsonMode) console.log(`     → ${fmt(currentApy, 2)} %`);
    } catch (err) {
        if (!jsonMode) console.log(`     → ⚠ ${t('cli.lend.not_available', { error: err.message })}`);
    }

    // ── Bestehende Position abfragen ──────────────────────────────────────────
    jlog(`  ${t('cli.lend.step_position')}`);
    let existingPosition;
    try {
        existingPosition = await proto.getPosition(walletAddress);
        if (!jsonMode) console.log(existingPosition ? `     → ${fmt(existingPosition.amount)} USDC` : `     → ${t('cli.lend.none')}`);
    } catch (err) {
        if (!jsonMode) console.log(`     → ⚠ ${t('cli.lend.not_queryable', { error: err.message })}`);
        existingPosition = null;
    }

    // ── Dry-Run: Zusammenfassung und Exit ─────────────────────────────────────
    if (dryRun) {
        if (jsonMode) {
            jout({
                ok: true, dryRun: true,
                result: {
                    protocol, protoLabel, amount,
                    currentApy,
                    existingAmount: existingPosition?.amount ?? 0,
                    estimatedYearlyUsdc: currentApy ? amount * (currentApy / 100) : null,
                },
            });
        } else {
            hr();
            console.log(`  📋 ${t('cli.lend.preview')}`);
            console.log(`     ${fmt(amount)} USDC → ${protoLabel}`);
            if (currentApy) {
                console.log(`     ${t('cli.lend.preview_yearly', { usdc: fmt(amount * (currentApy / 100), 2), apy: fmt(currentApy, 2) })}`);
            }
            console.log(`\n  ℹ ${t('cli.lend.dryrun_no_tx')}`);
        }
        process.exit(0);
    }

    // ── Bestätigung einholen (nur im interaktiven Modus) ─────────────────────
    if (!jsonMode) {
        hr();
        console.log(`  ${t('cli.lend.confirm_deposit', { usdc: fmt(amount), label: protoLabel })}`);
        if (currentApy) console.log(`  ${t('cli.lend.expected_apy', { apy: fmt(currentApy, 2) })}`);
        console.log('');
        const ok = await confirm(`  ${t('cli.lend.proceed')} `);
        if (!ok) { console.log(`\n  ${t('cli.lend.aborted')}`); process.exit(0); }
        console.log('');
    }

    // ── TX bauen ──────────────────────────────────────────────────────────────
    jlog(`  ${t('cli.lend.step_build_tx')}`);
    const isLoopscale = proto instanceof LoopscaleProtocol;
    let base64Tx;
    try {
        base64Tx = await proto.buildDepositTx(walletAddress, amount);
    } catch (err) {
        if (jsonMode) jout({ ok: false, error: t('cli.lend.build_tx_failed', { error: err.message }) });
        else console.error(`\n  ❌ ${t('cli.lend.build_tx_failed', { error: err.message })}`);
        process.exit(1);
    }

    // ── TX signieren + senden ─────────────────────────────────────────────────
    jlog(`  ${t('cli.lend.step_sign_send')}`);
    const keypair = loadKeypair();
    let txSig;
    try {
        // Loopscale: Server hat TX bereits co-signiert → Blockhash nicht überschreiben
        txSig = await signAndSend(base64Tx, keypair, { preserveBlockhash: isLoopscale });
    } catch (err) {
        // Siehe withdraw.js: err.technicalDetail = err.message ist bereits vollständig
        // formuliert (aus lib/wallet.js simulate()), kein zusätzlicher Präfix davor.
        if (err.technicalDetail) console.error(`  [debug] ${err.technicalDetail}`);
        const userMsg = err.technicalDetail ? err.message : t('cli.lend.tx_failed', { error: err.message });
        if (jsonMode) jout({ ok: false, error: userMsg });
        else console.error(`\n  ❌ ${userMsg}`);
        process.exit(1);
    }

    // ── DB aktualisieren ──────────────────────────────────────────────────────
    try {
        getDb();
        const existingPos = getActivePositions().find(p => p.protocol === protocol);
        if (existingPos) {
            addToPosition(existingPos.id, amount);
        } else {
            openPosition({ protocol, poolType, asset: 'USDC', amount, txHash: txSig });
        }

        const feeSol = await fetchFeeSol(txSig);
        recordTransaction({ type: 'deposit', protocol, poolType, asset: 'USDC', amount, txHash: txSig, feeSol });

        if (currentApy != null) {
            recordProtocolStat({ protocol, poolType, apy: currentApy, tvl: currentTvl });
        }

        const snap = getWalletSnapshot();
        upsertWalletSnapshot({
            currentValue: (snap?.current_value ?? 0) + amount,
            totalYield:   snap?.total_yield ?? 0,
            avgApy:       currentApy ?? snap?.avg_apy ?? 0,
            walletUsdc:   snap?.wallet_usdc ?? 0,
            walletSol:    solBalance,
        });
    } catch (err) {
        // DB-Fehler nicht fatal – TX ist bereits bestätigt
        jlog(`  ⚠ ${t('cli.lend.db_update_failed', { error: err.message })}`);
    }

    // ── Ergebnis ──────────────────────────────────────────────────────────────
    if (jsonMode) {
        jout({ ok: true, result: { protocol, protoLabel, amount, txSig, currentApy } });
    } else {
        hr();
        console.log(`  ✅ ${t('cli.lend.deposit_ok')}`);
        console.log('');
        console.log(t('cli.lend.head_amount', { v: `${fmt(amount)} USDC` }));
        console.log(t('cli.lend.head_protocol', { v: protoLabel }));
        console.log(`  TX        : ${txSig}`);
        console.log(`  Solscan   : https://solscan.io/tx/${txSig}`);
        hr();
        console.log('');
    }
}

main().catch(err => {
    if (jsonMode) jout({ ok: false, error: err.message });
    else console.error(`\n  ❌ ${t('cli.lend.unexpected', { error: err.message })}`);
    process.exit(1);
});
