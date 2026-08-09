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
import { KaminoProtocol, JupiterLendProtocol, DriftProtocol, LoopscaleProtocol } from '../lib/lending-protocols.js';
import { loadKeypair, signAndSend, getSolBalance, fetchFeeSol } from '../lib/wallet.js';
import { getDb, closePosition, updatePosition, getActivePositions,
         createPendingWithdrawal, recordTransaction, recordProtocolStat,
         upsertWalletSnapshot, getWalletSnapshot } from '../lib/db.js';

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
    if (jsonMode) jout({ ok: false, error: `Unbekanntes Protokoll: ${protocol}` });
    else console.error(`Fehler: --protocol ${VALID_PROTOCOLS.join('|')} ist Pflicht.`);
    process.exit(1);
}

if (amount == null) {
    if (jsonMode) jout({ ok: false, error: '--amount <Betrag|all> ist Pflicht' });
    else console.error('Fehler: --amount <Betrag|all> ist Pflicht.');
    process.exit(1);
}
if (amount !== 'all' && (isNaN(amount) || amount <= 0)) {
    if (jsonMode) jout({ ok: false, error: '--amount muss eine positive Zahl oder "all" sein' });
    else console.error('Fehler: --amount muss eine positive Zahl oder "all" sein.');
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

function fmtSeconds(s) {
    const days  = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    if (days > 0) return `${days} Tag${days !== 1 ? 'e' : ''} ${hours} Std.`;
    const mins  = Math.floor((s % 3600) / 60);
    return `${hours} Std. ${mins} Min.`;
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
               : (() => { throw new Error(`Unbekanntes Protokoll: ${protocol}`); })();

    const protoLabel = proto.label;
    const poolType   = proto.poolType ?? proto.name;

    if (!jsonMode) {
        console.log(`  Protokoll : ${protoLabel}`);
        console.log(`  Wallet    : ${walletAddress}`);
        if (!isComplete) console.log(`  Betrag    : ${amount === 'all' ? 'Alles' : fmt(amount) + ' USDC'}`);
        else console.log(`  Modus     : Complete Withdraw (Pending ID: ${pendingId})`);
        if (dryRun) console.log('  Modus     : 🔍 DRY-RUN (keine TX wird gesendet)');
        hr();
    }

    // ── SOL-Balance prüfen ────────────────────────────────────────────────────
    jlog('  SOL-Balance prüfen …');
    const solBalance = await getSolBalance(walletAddress);

    if (solBalance < config.solReserve) {
        if (jsonMode) jout({ ok: false, error: `Zu wenig SOL für Fees (${fmt(solBalance, 4)} SOL, Minimum: ${config.solReserve})` });
        else { console.error(`\n  ❌ Fehler: Zu wenig SOL für Fees.`); console.error(`     Vorhanden: ${fmt(solBalance, 4)} SOL`); }
        process.exit(1);
    }
    if (!jsonMode) console.log(`     → ${fmt(solBalance, 4)} SOL`);

    // ── Aktuelle Position abrufen ─────────────────────────────────────────────
    jlog('  Aktuelle Position …');
    let position;
    try {
        position = await proto.getPosition(walletAddress);
        if (!position) {
            if (jsonMode) jout({ ok: false, error: 'Keine aktive Position – Withdraw nicht möglich' });
            else { console.log('keine Position gefunden'); console.error('\n  ❌ Keine aktive Position – Withdraw nicht möglich.'); }
            process.exit(1);
        }
        if (!jsonMode) {
            console.log(`     → ${fmt(position.amount)} USDC`);
            if (position.maxWithdrawable < position.amount) console.log(`  Max. abhebbar: ${fmt(position.maxWithdrawable)} USDC`);
        }
    } catch (err) {
        if (!jsonMode) console.log(`     → ⚠ Nicht abfragbar (${err.message})`);
        position = null;
    }

    // Effektiven Betrag bestimmen
    const effectiveAmount = amount === 'all'
        ? (position?.maxWithdrawable ?? position?.amount ?? null)
        : amount;

    if (effectiveAmount == null) {
        if (jsonMode) jout({ ok: false, error: 'Betrag konnte nicht bestimmt werden' });
        else console.error('\n  ❌ Betrag konnte nicht bestimmt werden.');
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
            console.log('  📋 Vorschau:');
            console.log(`     ${fmt(effectiveAmount)} USDC ← ${protoLabel}`);
            console.log('\n  ℹ Dry-Run: keine Transaktion gesendet.');
        }
        process.exit(0);
    }

    // ── Bestätigung einholen (nur im interaktiven Modus) ─────────────────────
    if (!jsonMode) {
        hr();
        console.log(`  ${fmt(effectiveAmount)} USDC werden aus ${protoLabel} abgehoben.`);
        console.log('');
        const ok = await confirm('  Fortfahren? [j/N] ');
        if (!ok) { console.log('\n  Abgebrochen.'); process.exit(0); }
        console.log('');
    }

    // ── TX bauen ──────────────────────────────────────────────────────────────
    jlog('  TX wird erstellt …');
    let withdrawResult;
    try {
        withdrawResult = await proto.buildWithdrawTx(walletAddress, effectiveAmount);
        if (!jsonMode) console.log(`     → ✓ (${withdrawResult.type})`);
    } catch (err) {
        if (jsonMode) jout({ ok: false, error: `TX-Erstellung fehlgeschlagen: ${err.message}` });
        else console.error(`\n  ❌ TX-Erstellung fehlgeschlagen: ${err.message}`);
        process.exit(1);
    }

    // ── TX signieren + senden ─────────────────────────────────────────────────
    jlog('  TX signieren + senden …');
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
        const userMsg = err.technicalDetail ? err.message : `TX fehlgeschlagen: ${err.message}`;
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
        jlog(`  ⚠ DB-Update fehlgeschlagen (TX war erfolgreich): ${err.message}`);
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
            },
        });
    } else {
        hr();
        if (withdrawResult.type === 'immediate') {
            console.log('  ✅ Withdraw erfolgreich!');
            console.log('');
            console.log(`  Betrag    : ${fmt(effectiveAmount)} USDC`);
            console.log(`  Protokoll : ${protoLabel}`);
            console.log(`  TX        : ${txSig}`);
            console.log(`  Solscan   : https://solscan.io/tx/${txSig}`);
        } else if (withdrawResult.type === 'cooldown') {
            console.log('  ⏳ Cooldown gestartet!');
            console.log('');
            console.log(`  Betrag      : ${fmt(effectiveAmount)} USDC`);
            console.log(`  Protokoll   : ${protoLabel}`);
            console.log(`  TX          : ${txSig}`);
            console.log(`  Cooldown    : ${fmtSeconds(cooldown)}`);
            console.log(`  Bereit ab   : ${new Date(readyAtMs).toLocaleString('de-DE')}`);
            console.log('');
            console.log('  ℹ Nach dem Cooldown: node bin/withdraw.js --protocol <p> --complete --id <ID>');
        }
        hr();
        console.log('');
    }
}

main().catch(err => {
    if (jsonMode) jout({ ok: false, error: err.message });
    else console.error(`\n  ❌ Unerwarteter Fehler: ${err.message}`);
    process.exit(1);
});
