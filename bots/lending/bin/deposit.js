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
    if (jsonMode) jout({ ok: false, error: `Unbekanntes Protokoll: ${protocol}` });
    else console.error(`Fehler: --protocol ${VALID_PROTOCOLS.join('|')} ist Pflicht.`);
    process.exit(1);
}

if (!amount || isNaN(amount) || amount <= 0) {
    if (jsonMode) jout({ ok: false, error: `--amount muss eine positive Zahl sein` });
    else console.error('Fehler: --amount muss eine positive Zahl sein (z.B. --amount 500).');
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
               : (() => { throw new Error(`Unbekanntes Protokoll: ${protocol}`); })();

    const protoLabel = proto.label;
    const poolType   = proto.poolType ?? proto.name;

    if (!jsonMode) {
        console.log(`  Protokoll : ${protoLabel}`);
        console.log(`  Wallet    : ${walletAddress}`);
        console.log(`  Betrag    : ${fmt(amount)} USDC`);
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

    // ── Aktuellen APY + TVL abfragen ─────────────────────────────────────────
    jlog('  Aktueller APY …');
    let currentApy = null;
    let currentTvl = null;
    try {
        const stats = await proto.getPoolStats();
        currentApy = stats.apy ?? null;
        currentTvl = stats.tvl ?? null;
        if (!jsonMode) console.log(`     → ${fmt(currentApy, 2)} %`);
    } catch (err) {
        if (!jsonMode) console.log(`     → ⚠ Nicht verfügbar (${err.message})`);
    }

    // ── Bestehende Position abfragen ──────────────────────────────────────────
    jlog('  Bestehende Position …');
    let existingPosition;
    try {
        existingPosition = await proto.getPosition(walletAddress);
        if (!jsonMode) console.log(existingPosition ? `     → ${fmt(existingPosition.amount)} USDC` : '     → keine');
    } catch (err) {
        if (!jsonMode) console.log(`     → ⚠ Nicht abfragbar (${err.message})`);
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
            console.log('  📋 Vorschau:');
            console.log(`     ${fmt(amount)} USDC → ${protoLabel}`);
            if (currentApy) {
                console.log(`     Erwarteter Jahres-Yield: ~${fmt(amount * (currentApy / 100), 2)} USDC (${fmt(currentApy, 2)} % APY)`);
            }
            console.log('\n  ℹ Dry-Run: keine Transaktion gesendet.');
        }
        process.exit(0);
    }

    // ── Bestätigung einholen (nur im interaktiven Modus) ─────────────────────
    if (!jsonMode) {
        hr();
        console.log(`  ${fmt(amount)} USDC werden in ${protoLabel} depositiert.`);
        if (currentApy) console.log(`  Erwarteter APY: ${fmt(currentApy, 2)} %`);
        console.log('');
        const ok = await confirm('  Fortfahren? [j/N] ');
        if (!ok) { console.log('\n  Abgebrochen.'); process.exit(0); }
        console.log('');
    }

    // ── TX bauen ──────────────────────────────────────────────────────────────
    jlog('  TX wird erstellt …');
    const isLoopscale = proto instanceof LoopscaleProtocol;
    let base64Tx;
    try {
        base64Tx = await proto.buildDepositTx(walletAddress, amount);
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
        // Loopscale: Server hat TX bereits co-signiert → Blockhash nicht überschreiben
        txSig = await signAndSend(base64Tx, keypair, { preserveBlockhash: isLoopscale });
    } catch (err) {
        // Siehe withdraw.js: err.technicalDetail = err.message ist bereits vollständig
        // formuliert (aus lib/wallet.js simulate()), kein zusätzlicher Präfix davor.
        if (err.technicalDetail) console.error(`  [debug] ${err.technicalDetail}`);
        const userMsg = err.technicalDetail ? err.message : `TX fehlgeschlagen: ${err.message}`;
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
        jlog(`  ⚠ DB-Update fehlgeschlagen (TX war erfolgreich): ${err.message}`);
    }

    // ── Ergebnis ──────────────────────────────────────────────────────────────
    if (jsonMode) {
        jout({ ok: true, result: { protocol, protoLabel, amount, txSig, currentApy } });
    } else {
        hr();
        console.log('  ✅ Deposit erfolgreich!');
        console.log('');
        console.log(`  Betrag    : ${fmt(amount)} USDC`);
        console.log(`  Protokoll : ${protoLabel}`);
        console.log(`  TX        : ${txSig}`);
        console.log(`  Solscan   : https://solscan.io/tx/${txSig}`);
        hr();
        console.log('');
    }
}

main().catch(err => {
    if (jsonMode) jout({ ok: false, error: err.message });
    else console.error(`\n  ❌ Unerwarteter Fehler: ${err.message}`);
    process.exit(1);
});
