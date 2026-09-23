#!/usr/bin/env node
/**
 * bots/lending/lib/emergency-withdraw.js
 *
 * Bot-spezifisches Emergency-Withdraw-Modul für den LendingBot.
 * Wird von bin/emergency-exit.js als separater Subprocess gestartet.
 *
 * Modes (--mode <X>):
 *   A    – Konnektivitätscheck
 *   B    – Dry-Run: Positionen lesen + beschreiben was passieren würde
 *   C    – Dry-Run: buildWithdrawTx + simulateTransaction + Swap-Quote
 *   live – Echter Emergency-Exit: bot_paused setzen, Positionen withdrawen, ggf. swap + send
 *
 * Parameter:
 *   --mode <A|B|C|live>
 *   --swapto:<TOKEN>
 *   --sendto:<ADDR>
 *
 * ⚠ Loopscale-Cooldown: Manche Protokolle haben 7-Tage-Warteperiode.
 */

import path              from 'path';
import { fileURLToPath } from 'url';
import * as web3         from '@solana/web3.js';
import { rpcCallerHeaders } from '../../../lib/rpc-caller.js';

import { createUtils, resolveToken, getQuote, TOKEN_MINTS }
    from '../../../lib/emergency-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_DIR   = path.join(__dirname, '..');

// 🔴 Defensive Absicherung nach dem realen Bug im Liquidity-Zweig (2026-08-04,
// forge-pub1, siehe bots/liquidity/lib/emergency-withdraw.js): dieser Prozess
// schreibt am Ende GENAU EINE JSON-Zeile auf stdout, die bin/emergency-exit.js
// parst. lending-protocols.js hat aktuell keine console.log-Stellen, aber jede
// künftig dort ergänzte würde denselben Fehler reproduzieren — deshalb hier
// bereits jetzt console.log auf stderr umgeleitet, bevor er real auftritt.
console.log = (...args) => console.error(...args);

// ─── Argument-Parsing ─────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const modeIdx = args.findIndex(a => a === '--mode');
let mode = modeIdx >= 0 && args[modeIdx + 1] ? args[modeIdx + 1].toUpperCase() : 'B';
if (mode === 'LIVE') mode = 'live';

const swapToArg = args.find(a => a.startsWith('--swapto:'));
let swapToToken = null;
if (swapToArg) {
    try { swapToToken = resolveToken(swapToArg.slice('--swapto:'.length)); }
    catch (err) { process.stderr.write(`  [LendingBot] ${err.message}\n`); process.exit(1); }
}

const sendToArg  = args.find(a => a.startsWith('--sendto:'));
const sendToAddr = sendToArg ? sendToArg.slice('--sendto:'.length) : null;

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function log(msg) {
    process.stderr.write(`  [LendingBot] ${msg}\n`);
}

async function createProtocolInstance(protocol) {
    const { KaminoProtocol, JupiterLendProtocol, LoopscaleProtocol, DriftProtocol } =
        await import('./lending-protocols.js');
    const { config } = await import('./config.js');

    if (protocol.startsWith('kamino'))    return new KaminoProtocol();
    if (protocol.startsWith('jupiter'))   return new JupiterLendProtocol();
    if (protocol.startsWith('loopscale')) {
        // Direkter Objekt-Lookup wie überall sonst im Code (bot.js, deposit.js,
        // withdraw.js, move.js, lending-protocols.js) — config.loopscale.vaults ist
        // ein Objekt (Vault-ID → Config), kein Array. Der vorherige .find()-Aufruf
        // warf immer einen TypeError (gefunden 2026-08-04, erster echter
        // Emergency-Exit-Dry-Run, betraf die reale loopscale-onre-Position).
        const vaultCfg = config.loopscale?.vaults?.[protocol];
        if (!vaultCfg) throw new Error(`Unbekannter Loopscale-Vault: ${protocol}`);
        return new LoopscaleProtocol({ name: protocol, label: vaultCfg.label, vaultAddress: vaultCfg.address });
    }
    if (protocol.startsWith('drift'))     return new DriftProtocol();
    throw new Error(`Unbekanntes Protokoll: ${protocol}`);
}

// ─── Mode A: Konnektivitätscheck ─────────────────────────────────────────────

async function checkConnectivity() {
    await import('./config.js'); // Lädt .env
    const { getActivePositions } = await import('./db.js');

    let dbOk = false, posCount = 0;
    try { posCount = getActivePositions().length; dbOk = true; }
    catch (err) { log(`DB-Fehler: ${err.message}`); }

    let rpcOk = false;
    try {
        const { config }     = await import('./config.js');
        const { Connection } = web3;
        await new Connection(config.rpcUrl, { commitment: 'confirmed', httpHeaders: rpcCallerHeaders() }).getSlot();
        rpcOk = true;
    } catch (err) { log(`RPC-Fehler: ${err.message}`); }

    let nexusOk = false;
    try {
        const res = await fetch('http://127.0.0.1:3100/health', { signal: AbortSignal.timeout(5000) });
        nexusOk = res.ok;
    } catch { log('Nexus nicht erreichbar'); }

    return { dbOk, rpcOk, nexusOk, activePositions: posCount };
}

// ─── Mode B: Dry-Run – Positionen lesen ───────────────────────────────────────

async function readPositions() {
    await import('./config.js');
    const { getActivePositions } = await import('./db.js');
    const positions              = getActivePositions();

    const summary = positions.map(p => ({
        protocol:   p.protocol,
        poolType:   p.pool_type,
        amountUsdc: p.amount,
        currentApy: p.current_apy,
        startedAt:  new Date(p.started_at).toISOString(),
        action:     'withdraw_all',
        swapTo:     swapToToken?.symbol ?? null,
        sendTo:     sendToAddr ? `${sendToAddr.slice(0, 8)}…` : null,
        note:       p.protocol.startsWith('loopscale') ? '⚠ Loopscale-Cooldown (7 Tage)' : null,
    }));

    const totalUsdc = positions.reduce((sum, p) => sum + (p.amount ?? 0), 0);
    log(`${positions.length} Positionen, gesamt ~${totalUsdc.toFixed(2)} USDC`);
    summary.forEach(s => {
        let desc = `${s.protocol}: ${s.amountUsdc?.toFixed(2)} USDC @ ${s.currentApy?.toFixed(2)}% APY`;
        if (swapToToken) desc += ` → swap to ${swapToToken.symbol}`;
        if (sendToAddr)  desc += ` → send to ${sendToAddr.slice(0, 8)}…`;
        if (s.note)      desc += ` (${s.note})`;
        log(`  ${desc}`);
    });

    return { activePositions: positions.length, totalUsdc, positions: summary };
}

// ─── Mode C: Dry-Run – TX simulieren + Swap-Quote ─────────────────────────────

async function simulateLive() {
    await import('./config.js');
    const { getActivePositions }         = await import('./db.js');
    const { loadKeypair, getConnection } = await import('./wallet.js');

    const positions = getActivePositions();
    if (positions.length === 0) {
        return { activePositions: 0, positions: [] };
    }

    const keypair    = loadKeypair();
    const connection = getConnection();
    const results    = [];

    for (const pos of positions) {
        const result = { protocol: pos.protocol, amountUsdc: pos.amount };
        try {
            const instance = await createProtocolInstance(pos.protocol);
            const txData   = await instance.buildWithdrawTx(keypair.publicKey.toBase58(), 'all');
            const txBytes  = Buffer.from(txData.transaction, 'base64');

            const { VersionedTransaction, Transaction } = web3;
            let tx;
            try { tx = VersionedTransaction.deserialize(txBytes); tx.sign([keypair]); }
            catch { tx = Transaction.from(txBytes); tx.sign(keypair); }

            const simResult = await connection.simulateTransaction(tx);
            if (simResult.value.err) throw new Error(`Sim: ${JSON.stringify(simResult.value.err)}`);

            result.simOk       = true;
            result.computeUnits = simResult.value.unitsConsumed ?? null;
            log(`${pos.protocol}: TX simuliert OK (CU: ${result.computeUnits ?? '?'})`);
        } catch (err) {
            result.simOk    = false;
            result.simError = err.message;
            log(`${pos.protocol}: Simulation fehlgeschlagen: ${err.message}`);
        }

        // Swap-Quote (USDC → Ziel-Token, falls angegeben und != USDC)
        if (swapToToken && swapToToken.mint !== TOKEN_MINTS.USDC.mint && pos.amount > 0) {
            try {
                const q = await getQuote(TOKEN_MINTS.USDC.mint, 6, pos.amount, swapToToken.mint);
                result.swapQuote = { expectedOut: q.expectedOut, priceImpact: q.priceImpactPct };
                log(`${pos.protocol}: Quote USDC → ${swapToToken.symbol}: ~${q.expectedOut.toFixed(4)}`);
            } catch (err) { result.swapQuoteError = err.message; }
        }

        results.push(result);
    }

    return { activePositions: positions.length, positions: results };
}

// ─── Mode live: Echter Emergency-Exit ────────────────────────────────────────

async function executeWithdraw() {
    await import('./config.js');
    const { kvSet, getActivePositions, closePosition, createPendingWithdrawal, recordTransaction } = await import('./db.js');
    const { loadKeypair, signAndSend, getConnection } = await import('./wallet.js');

    kvSet('bot_paused',        'true');
    kvSet('bot_paused_reason', 'emergency_exit');
    log('bot_paused=true gesetzt');

    const positions = getActivePositions();
    if (positions.length === 0) {
        return { activePositions: 0, withdrawn: 0, failed: 0, positions: [] };
    }

    const keypair  = loadKeypair();
    const results  = [];
    let withdrawnCount = 0, failedCount = 0;

    for (const pos of positions) {
        log(`${pos.protocol}: ${pos.amount?.toFixed(2)} USDC wird abgezogen...`);
        const result = { protocol: pos.protocol, amountUsdc: pos.amount };

        try {
            const instance = await createProtocolInstance(pos.protocol);
            const txData   = await instance.buildWithdrawTx(keypair.publicKey.toBase58(), 'all');
            const txSig    = await signAndSend(txData.transaction, keypair);
            result.txHash  = txSig;
            result.success = true;
            withdrawnCount++;
            log(`${pos.protocol}: Withdraw OK (TX: ${txSig.slice(0, 12)}…)`);

            // 🔴 Bisher schrieb dieser Pfad NIE in die eigene DB zurück (gefunden
            // 2026-08-04, analog zum bereits gefixten Liquidity-Gegenstück) —
            // Spiegelbild von bin/withdraw.js "── DB aktualisieren ──": 'immediate'
            // schließt die Position sofort, 'cooldown' (Loopscale, 7 Tage) legt
            // stattdessen eine pending_withdrawal an. Ohne das bliebe die Position
            // nach einem echten Emergency-Exit in der DB fälschlich offen — exakt
            // die Inkonsistenz, die beim Liquidity-Live-Test real auftrat.
            try {
                if (txData.type === 'immediate') {
                    closePosition(pos.id);
                    recordTransaction({
                        type: 'withdraw', protocol: pos.protocol, poolType: pos.pool_type,
                        asset: 'USDC', amount: pos.amount, txHash: txSig, note: 'emergency-exit',
                    });
                } else if (txData.type === 'cooldown') {
                    createPendingWithdrawal({
                        amount: pos.amount, pendingWithdrawalId: null, initiateTxHash: txSig,
                        cooldownSeconds: txData.cooldownSeconds ?? 604800,
                    });
                    recordTransaction({
                        type: 'withdraw_initiate', protocol: pos.protocol, poolType: pos.pool_type,
                        asset: 'USDC', amount: pos.amount, txHash: txSig,
                        note: `emergency-exit, Cooldown ${txData.cooldownSeconds ?? 604800}s`,
                    });
                }
            } catch (dbErr) {
                log(`${pos.protocol}: DB-Update fehlgeschlagen (TX war erfolgreich, Kapital NICHT verloren): ${dbErr.message}`);
            }

            if (pos.protocol.startsWith('loopscale')) {
                result.note = '⚠ Loopscale: Cooldown-Periode läuft (7 Tage bis Freigabe)';
                log(`${pos.protocol}: ⚠ Cooldown aktiv – Kapital nach 7 Tagen verfügbar`);
            }
        } catch (err) {
            result.success = false;
            result.error   = err.message;
            failedCount++;
            log(`${pos.protocol}: FEHLER: ${err.message}`);
        }
        results.push(result);
    }

    // Post-Processing: Swap + Send
    let postProcessing = null;
    if (swapToToken || sendToAddr) {
        const { submitAndConfirm } = await import('../../../core/tx-queue-client.js');
        const utils      = createUtils(web3, submitAndConfirm);
        const connection = getConnection();
        postProcessing   = {};

        if (swapToToken) {
            log(`Tausche alle Tokens → ${swapToToken.symbol}...`);
            try {
                postProcessing.swaps = await utils.swapAllToTarget(keypair, connection, swapToToken);
                for (const s of postProcessing.swaps) {
                    if (s.success) log(`  ${s.from} → ${swapToToken.symbol}: ${s.fromAmount?.toFixed(6)} (TX: ${s.txHash?.slice(0, 12) ?? '?'}…)`);
                    else log(`  ${s.from} FEHLER: ${s.error}`);
                }
            } catch (err) { postProcessing.swapsError = err.message; }
        }

        if (sendToAddr) {
            log(`Sende alle Tokens an ${sendToAddr.slice(0, 8)}…`);
            try {
                postProcessing.sends = await utils.sendAllTokensTo(keypair, connection, sendToAddr);
                for (const s of postProcessing.sends) {
                    if (s.success) log(`  ${s.token}: ${s.amount?.toFixed(6)} gesendet`);
                    else log(`  ${s.token} FEHLER: ${s.error}`);
                }
            } catch (err) { postProcessing.sendsError = err.message; }
        }
    }

    return {
        activePositions: positions.length,
        withdrawn: withdrawnCount, failed: failedCount,
        positions: results, postProcessing,
    };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    log(`Mode: ${mode}${swapToToken ? ` | swapto: ${swapToToken.symbol}` : ''}${sendToAddr ? ` | sendto: ${sendToAddr.slice(0, 8)}…` : ''}`);

    let data, errors = [];
    try {
        if      (mode === 'A')    data = await checkConnectivity();
        else if (mode === 'B')    data = await readPositions();
        else if (mode === 'C')    data = await simulateLive();
        else if (mode === 'live') data = await executeWithdraw();
        else throw new Error(`Unbekannter Mode: ${mode}`);
    } catch (err) {
        errors = [{ error: err.message }];
        data   = {};
        log(`Fatal: ${err.stack ?? err.message}`);
    }

    // 🔴 success darf NICHT nur einen Absturz von main() ausschließen — sonst
    // meldet der Aufrufer "✅ Erfolgreich", obwohl JEDE Position beim Withdraw
    // (mode 'live', p.success===false) oder der Simulation (mode 'C',
    // p.simOk===false) gescheitert ist. Gefunden 2026-08-04 beim ersten echten
    // Emergency-Exit-Dry-Run (Loopscale-Vault-Config-Bug, s.u.) — das
    // Gesamtergebnis stand fälschlich auf "success" trotz gescheiterter Position.
    const posFailed = (data.positions ?? []).some(p => p.success === false || p.simOk === false);
    const output = {
        bot: 'lendingbot', chain: 'solana', mode,
        ts:  new Date().toISOString(),
        success: errors.length === 0 && !posFailed,
        ...data, errors,
    };

    process.stdout.write(JSON.stringify(output) + '\n');
    process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(err => {
    process.stderr.write(`  [LendingBot] Fatal: ${err.stack ?? err.message}\n`);
    process.stdout.write(JSON.stringify({
        bot: 'lendingbot', chain: 'solana', mode,
        ts:  new Date().toISOString(),
        success: false, errors: [{ error: err.message }],
    }) + '\n');
    process.exit(1);
});
