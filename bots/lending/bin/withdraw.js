#!/usr/bin/env node
/**
 * FORGE LendingBot – CLI: Withdraw
 *
 * Hebt USDC aus einem Lending-Protokoll ab (Kamino, Jupiter, Loopscale).
 *
 * Verwendung:
 *   node bin/withdraw.js --protocol kamino         --amount 500
 *   node bin/withdraw.js --protocol kamino-figure  --amount all
 *   node bin/withdraw.js --protocol jupiter        --amount 50
 *   node bin/withdraw.js --protocol loopscale-genesis --amount all
 *
 * Optionen:
 *   --protocol  kamino | kamino-figure | kamino-onre | jupiter | loopscale-genesis | ...
 *   --amount    USDC-Betrag oder 'all'   (Pflicht)
 *   --dry-run   Zeigt Vorschau, sendet keine TX
 *   --yes       Überspringt Bestätigung  (für Scripting)
 */

import { createInterface }      from 'readline';
import { config } from '../lib/config.js';
import { t, numLocale } from '../../../lib/i18n.js';
import { KaminoProtocol, JupiterLendProtocol, DriftProtocol, LoopscaleProtocol } from '../lib/lending-protocols.js';
import { loadKeypair, signAndSend, getSolBalance, fetchFeeSol } from '../lib/wallet.js';
import { getDb, closePosition, updatePosition, getActivePositions,
         createPendingWithdrawal, recordTransaction, recordProtocolStat,
         upsertWalletSnapshot, getWalletSnapshot, addNotification } from '../lib/db.js';
import * as notify from '../lib/notify.js';

// ─── Argument-Parsing ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : null;
}

const protocol    = getArg('--protocol')?.toLowerCase();
const amountRaw   = getArg('--amount');
const dryRun      = args.includes('--dry-run');
const skipConfirm = args.includes('--yes');
const isComplete  = args.includes('--complete');
const pendingId   = getArg('--id');
const jsonMode    = args.includes('--json');

function jout(data) { console.log(JSON.stringify(data)); }
function jlog(msg)  { if (jsonMode) process.stderr.write(msg + '\n'); else console.log(msg); }

// amount: 'all' oder Zahl
const amount = amountRaw === 'all' ? 'all'
    : amountRaw != null ? parseFloat(amountRaw)
    : null;

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

if (amount == null) {
    if (jsonMode) jout({ ok: false, error: t('cli.lend.amount_required') });
    else console.error(t('cli.lend.amount_required_hint'));
    process.exit(1);
}
if (amount !== 'all' && (isNaN(amount) || amount <= 0)) {
    if (jsonMode) jout({ ok: false, error: t('cli.lend.amount_positive_or_all') });
    else console.error(t('cli.lend.amount_positive_or_all_hint'));
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

function fmtSeconds(s) {
    const days  = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    if (days === 1) return t('cli.lend.dur_day', { h: hours });
    if (days > 1)   return t('cli.lend.dur_days', { d: days, h: hours });
    const mins  = Math.floor((s % 3600) / 60);
    return t('cli.lend.dur_hours', { h: hours, m: mins });
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
        console.log('  FORGE LendingBot – Withdraw');
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
        if (!isComplete) console.log(t('cli.lend.head_amount', { v: amount === 'all' ? t('cli.lend.all') : fmt(amount) + ' USDC' }));
        else console.log(t('cli.lend.head_mode_complete', { id: pendingId }));
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

    // ── Aktuelle Position abrufen ─────────────────────────────────────────────
    jlog(`  ${t('cli.lend.step_current_position')}`);
    let position;
    try {
        position = await proto.getPosition(walletAddress);
        if (!position) {
            if (jsonMode) jout({ ok: false, error: t('cli.lend.no_position') });
            else { console.log(t('cli.lend.no_position_found')); console.error(`\n  ❌ ${t('cli.lend.no_position')}.`); }
            process.exit(1);
        }
        if (!jsonMode) {
            console.log(`     → ${fmt(position.amount)} USDC`);
            if (position.maxWithdrawable < position.amount) console.log(`  ${t('cli.lend.max_withdrawable', { usdc: fmt(position.maxWithdrawable) })}`);
        }
    } catch (err) {
        if (!jsonMode) console.log(`     → ⚠ ${t('cli.lend.not_queryable', { error: err.message })}`);
        position = null;
    }

    // Effektiven Betrag bestimmen
    const effectiveAmount = amount === 'all'
        ? (position?.maxWithdrawable ?? position?.amount ?? null)
        : amount;

    if (effectiveAmount == null) {
        if (jsonMode) jout({ ok: false, error: t('cli.lend.amount_undetermined') });
        else console.error(`\n  ❌ ${t('cli.lend.amount_undetermined')}.`);
        process.exit(1);
    }

    // ── Dry-Run: Zusammenfassung und Exit ─────────────────────────────────────
    if (dryRun) {
        if (jsonMode) {
            jout({
                ok: true, dryRun: true,
                result: {
                    protocol, protoLabel,
                    requestedAmount: amount,
                    effectiveAmount,
                    positionAmount:    position?.amount ?? null,
                    maxWithdrawable:   position?.maxWithdrawable ?? null,
                },
            });
        } else {
            hr();
            console.log(`  📋 ${t('cli.lend.preview')}`);
            console.log(`     ${fmt(effectiveAmount)} USDC ← ${protoLabel}`);
            console.log(`\n  ℹ ${t('cli.lend.dryrun_no_tx')}`);
        }
        process.exit(0);
    }

    // ── Bestätigung einholen (nur im interaktiven Modus) ─────────────────────
    if (!jsonMode) {
        hr();
        console.log(`  ${t('cli.lend.confirm_withdraw', { usdc: fmt(effectiveAmount), label: protoLabel })}`);
        console.log('');
        const ok = await confirm(`  ${t('cli.lend.proceed')} `);
        if (!ok) { console.log(`\n  ${t('cli.lend.aborted')}`); process.exit(0); }
        console.log('');
    }

    // ── TX bauen ──────────────────────────────────────────────────────────────
    jlog(`  ${t('cli.lend.step_build_tx')}`);
    let withdrawResult;
    try {
        withdrawResult = await proto.buildWithdrawTx(walletAddress, effectiveAmount);
        if (!jsonMode) console.log(`     → ✓ (${withdrawResult.type})`);
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
        txSig = await signAndSend(withdrawResult.transaction, keypair,
            { preserveBlockhash: withdrawResult.preserveBlockhash ?? false });
        if (!jsonMode) console.log('     → ✓');
    } catch (err) {
        // Technische Rohdaten (Solana-Simulation, falls vorhanden) immer ins Log –
        // der Nutzer bekommt nur err.message (siehe lib/wallet.js simulate()).
        // err.technicalDetail = simulate() hat bereits eine vollständige, nutzerfreundliche
        // Meldung als err.message gesetzt (siehe lib/wallet.js) – kein "TX fehlgeschlagen:"
        // davorsetzen, das würde den beruhigenden Ton wieder technisch wirken lassen.
        if (err.technicalDetail) console.error(`  [debug] ${err.technicalDetail}`);
        const userMsg = err.technicalDetail ? err.message : t('cli.lend.tx_failed', { error: err.message });
        if (jsonMode) jout({ ok: false, error: userMsg });
        else console.error(`\n  ❌ ${userMsg}`);
        process.exit(1);
    }

    // ── DB aktualisieren ──────────────────────────────────────────────────────
    try {
        getDb();

        if (withdrawResult.type === 'immediate') {
            const activeForProtocol = getActivePositions().filter(p => p.protocol === protocol);
            const remainingOnChain  = (position?.amount ?? 0) - effectiveAmount;
            const isFullWithdraw    = remainingOnChain <= 0.01;

            if (isFullWithdraw) {
                activeForProtocol.forEach(p => closePosition(p.id));
            } else {
                activeForProtocol.forEach(p => updatePosition(p.id, { amount: p.amount - effectiveAmount }));
            }

            const feeSolImmediate = await fetchFeeSol(txSig);
            recordTransaction({ type: 'withdraw', protocol, poolType, asset: 'USDC', amount: effectiveAmount, txHash: txSig, feeSol: feeSolImmediate });

            const snap = getWalletSnapshot();
            upsertWalletSnapshot({
                currentValue: Math.max(0, (snap?.current_value ?? 0) - effectiveAmount),
                totalYield:   snap?.total_yield ?? 0,
                avgApy:       snap?.avg_apy ?? 0,
                walletUsdc:   (snap?.wallet_usdc ?? 0) + effectiveAmount,
                walletSol:    solBalance,
            });

        } else if (withdrawResult.type === 'cooldown') {
            createPendingWithdrawal({
                amount:              effectiveAmount,
                pendingWithdrawalId: null,
                initiateTxHash:      txSig,
                cooldownSeconds:     withdrawResult.cooldownSeconds ?? 604800,
            });

            const feeSolCooldown = await fetchFeeSol(txSig);
            recordTransaction({
                type: 'withdraw_initiate', protocol, poolType, asset: 'USDC',
                amount: effectiveAmount, txHash: txSig, feeSol: feeSolCooldown,
                note: `Cooldown ${fmtSeconds(withdrawResult.cooldownSeconds ?? 604800)}`,
            });
        }

    } catch (err) {
        jlog(`  ⚠ ${t('cli.lend.db_update_failed', { error: err.message })}`);
    }

    // ── Ungestakte LP-Reste erkennen (nur Loopscale) ──────────────────────────
    // Siehe LoopscaleProtocol.checkLeftoverLp() für Hintergrund. Rein informativ –
    // blockiert nichts, macht nur sichtbar was sonst unbemerkt im Wallet liegen bliebe.
    let leftoverLp = null;
    if (proto instanceof LoopscaleProtocol) {
        leftoverLp = await proto.checkLeftoverLp(walletAddress);
        if (leftoverLp) {
            const usdcStr  = leftoverLp.estimatedUsdc != null ? ` (~${fmt(leftoverLp.estimatedUsdc)} USDC)` : '';
            const lpParams = { pool: protoLabel, lp: leftoverLp.lpAmount.toFixed(6), usdc: usdcStr };
            jlog(`  ${t('notify.len.lp_remainder_short', lpParams)}`);
            addNotification({ level: 'warn', msgKey: 'notify.len.lp_remainder_short', params: lpParams });
            // Katalog-Verweis statt fertigem Text: gerendert wird beim Anzeigen (Konvention 2, i18n.md §3e)
            await notify.lpRemainder(protoLabel, { k: 'notify.len.lp_remainder_short', p: lpParams });
        }
    }

    // ── Ergebnis ──────────────────────────────────────────────────────────────
    const cooldown    = withdrawResult.cooldownSeconds ?? (withdrawResult.type === 'cooldown' ? 604800 : null);
    const readyAtMs   = cooldown ? Date.now() + cooldown * 1000 : null;

    if (jsonMode) {
        jout({
            ok: true,
            result: {
                protocol, protoLabel, effectiveAmount, txSig,
                withdrawType:  withdrawResult.type,
                cooldownSeconds: cooldown,
                readyAt: readyAtMs,
                leftoverLp,
            },
        });
    } else {
        hr();
        if (withdrawResult.type === 'immediate') {
            console.log(`  ✅ ${t('cli.lend.withdraw_ok')}`);
            console.log('');
            console.log(t('cli.lend.head_amount', { v: `${fmt(effectiveAmount)} USDC` }));
            console.log(t('cli.lend.head_protocol', { v: protoLabel }));
            console.log(`  TX        : ${txSig}`);
            console.log(`  Solscan   : https://solscan.io/tx/${txSig}`);
        } else if (withdrawResult.type === 'cooldown') {
            console.log(`  ⏳ ${t('cli.lend.cooldown_started')}`);
            console.log('');
            console.log(t('cli.lend.res12_amount', { v: `${fmt(effectiveAmount)} USDC` }));
            console.log(t('cli.lend.res12_protocol', { v: protoLabel }));
            console.log(`  TX          : ${txSig}`);
            console.log(t('cli.lend.res12_cooldown', { v: fmtSeconds(cooldown) }));
            console.log(t('cli.lend.res12_ready', { v: new Date(readyAtMs).toLocaleString(numLocale()) }));
            console.log('');
            console.log(`  ℹ ${t('cli.lend.after_cooldown_hint')}`);
        }
        if (leftoverLp) {
            console.log('');
            console.log(`  ⚠️  ${t('cli.lend.leftover_line', {
                lp:   leftoverLp.lpAmount.toFixed(6),
                usdc: leftoverLp.estimatedUsdc != null ? ` (~${fmt(leftoverLp.estimatedUsdc)} USDC)` : '',
            })}`);
        }
        hr();
        console.log('');
    }
}

main().catch(err => {
    if (jsonMode) jout({ ok: false, error: err.message });
    else console.error(`\n  ❌ ${t('cli.lend.unexpected', { error: err.message })}`);
    process.exit(1);
});
