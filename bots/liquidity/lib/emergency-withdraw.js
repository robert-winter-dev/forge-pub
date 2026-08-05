#!/usr/bin/env node
/**
 * Liquidity Bot/lib/emergency-withdraw.js
 *
 * Bot-spezifisches Emergency-Withdraw-Modul für Liquidity.
 * Wird von bin/emergency-exit.js als separater Subprocess gestartet.
 *
 * Kein kv_config in Liquidity → Restart-Schutz nur via systemctl stop (vom Orchestrator).
 *
 * Modes (--mode <X>):
 *   A    – Konnektivitätscheck
 *   B    – Dry-Run: Positionen aus DB lesen + beschreiben was passieren würde
 *   C    – Dry-Run: Pool-State von Chain + decreaseLiquidity-Quote + Swap-Quote
 *   live – Echter Emergency-Exit: Fees + Liquidität herausziehen, ggf. swappen + senden
 *
 * Parameter:
 *   --mode <A|B|C|live>
 *   --swapto:<TOKEN>
 *   --sendto:<ADDR>
 */

import Database          from 'better-sqlite3';
import path              from 'path';
import { fileURLToPath } from 'url';
import * as web3         from '@solana/web3.js';

import { createUtils, resolveToken, getQuote, TOKEN_MINTS }
    from '../../../lib/emergency-utils.js';
import { PATHS } from '../../../config/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_DIR   = path.join(__dirname, '..');

// 🔴 Root Cause des ersten realen Live-Tests (2026-08-04, forge-pub1): dieser
// Prozess schreibt am Ende GENAU EINE JSON-Zeile auf stdout, die bin/emergency-
// exit.js parst. Geteilte Adapter-Module (allen voran pool-adapter/orca.js, 20+
// Stellen) benutzen aber überall console.log für Fortschrittsmeldungen — im
// normalen Bot-Betrieb (journalctl) richtig so, hier aber tödlich: jede solche
// Zeile landet vor dem JSON auf stdout und macht es unparsbar ("Kein gültiges
// JSON in stdout"). Statt console.log in jedem geteilten Modul umzustellen
// (hohe Streuwirkung, betrifft den produktiven Dauerbetrieb von bot.js) wird es
// NUR in diesem Ein-Schuss-Prozess auf stderr umgeleitet — stdout bleibt
// exklusiv für die finale JSON-Zeile reserviert. Muss vor jedem dynamischen
// Import stehen, der einen Adapter lädt.
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
    catch (err) { process.stderr.write(`  [Liquidity] ${err.message}\n`); process.exit(1); }
}

const sendToArg  = args.find(a => a.startsWith('--sendto:'));
const sendToAddr = sendToArg ? sendToArg.slice('--sendto:'.length) : null;

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

function log(msg) {
    process.stderr.write(`  [Liquidity] ${msg}\n`);
}

function openDb() {
    const db = new Database(PATHS.liquidityDb);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
}

function getAllOpenPositions(db) {
    return db.prepare(`
        SELECT p.*, po.pair, po.address AS pool_address,
               po.token_a, po.token_b, po.decimals_a, po.decimals_b, po.protocol
        FROM   positions p
        JOIN   pools po ON p.pool_id = po.id
        WHERE  p.closed_at IS NULL
        ORDER  BY p.opened_at ASC
    `).all();
}

// ─── Mode A: Konnektivitätscheck ─────────────────────────────────────────────

async function checkConnectivity() {
    let dbOk = false, posCount = 0;
    try {
        const db = openDb();
        posCount = db.prepare(`SELECT COUNT(*) as c FROM positions WHERE closed_at IS NULL`).get()?.c ?? 0;
        db.close();
        dbOk = true;
    } catch (err) { log(`DB-Fehler: ${err.message}`); }

    let rpcOk = false;
    try {
        const { config }     = await import('./config.js');
        const { Connection } = web3;
        await new Connection(config.rpcUrl, 'confirmed').getSlot();
        rpcOk = true;
    } catch (err) { log(`RPC-Fehler: ${err.message}`); }

    let nexusOk = false;
    try {
        const res = await fetch('http://127.0.0.1:3100/health', { signal: AbortSignal.timeout(5000) });
        nexusOk = res.ok;
    } catch { log('Nexus nicht erreichbar'); }

    return { dbOk, rpcOk, nexusOk, openPositions: posCount };
}

// ─── Mode B: Dry-Run – Positionen lesen ───────────────────────────────────────

async function readPositions() {
    const db        = openDb();
    const positions = getAllOpenPositions(db);
    db.close();

    const summary = positions.map(p => ({
        pool:        p.pair,
        nftMint:     p.nft_mint,
        capitalUsdc: p.capital_usdc,
        openedAt:    new Date(p.opened_at).toISOString(),
        action:      'close_position_and_collect_fees',
        swapTo:      swapToToken?.symbol ?? null,
        sendTo:      sendToAddr ? `${sendToAddr.slice(0, 8)}…` : null,
    }));

    log(`${positions.length} Positionen gefunden`);
    summary.forEach(s => {
        let desc = `${s.pool}: ~${s.capitalUsdc?.toFixed(2) ?? '?'} USDC`;
        if (swapToToken) desc += ` → swap to ${swapToToken.symbol}`;
        if (sendToAddr)  desc += ` → send to ${sendToAddr.slice(0, 8)}…`;
        log(`  ${desc}`);
    });

    return { openPositions: positions.length, positions: summary };
}

// ─── Mode C: Dry-Run – Pool-State + Quote ─────────────────────────────────────

async function simulateLive() {
    const { config }      = await import('./config.js');
    const db              = openDb();
    const positions       = getAllOpenPositions(db);
    db.close();

    if (positions.length === 0) {
        return { openPositions: 0, positions: [], rpcChecked: true };
    }

    const { OrcaAdapter }   = await import('./pool-adapter/orca.js');
    const {
        ORCA_WHIRLPOOL_PROGRAM_ID,
        PDAUtil,
        IGNORE_CACHE,
        decreaseLiquidityQuoteByLiquidityWithParams,
        NO_TOKEN_EXTENSION_CONTEXT,
    } = await import('@orca-so/whirlpools-sdk');
    const { Percentage }    = await import('@orca-so/common-sdk');
    const { PublicKey }     = web3;

    const adapter  = new OrcaAdapter();
    const client   = adapter._getClient();
    const slippage = Percentage.fromFraction(1, 100);
    const results  = [];

    for (const pos of positions) {
        try {
            const mintPubkey = new PublicKey(pos.nft_mint);
            const posPda     = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mintPubkey);
            const [whirlpool, position] = await Promise.all([
                client.getPool(new PublicKey(pos.pool_address), IGNORE_CACHE),
                client.getPosition(posPda.publicKey, IGNORE_CACHE),
            ]);

            const poolData = whirlpool.getData();
            const posData  = position.getData();
            const quote    = decreaseLiquidityQuoteByLiquidityWithParams({
                liquidity:         posData.liquidity,
                sqrtPrice:         poolData.sqrtPrice,
                tickCurrentIndex:  poolData.tickCurrentIndex,
                tickLowerIndex:    posData.tickLowerIndex,
                tickUpperIndex:    posData.tickUpperIndex,
                slippageTolerance: slippage,
                tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
            });

            const amountA = Number(quote.tokenMinA) / Math.pow(10, pos.decimals_a);
            const amountB = Number(quote.tokenMinB) / Math.pow(10, pos.decimals_b);

            const entry = {
                pool: pos.pair, nftMint: pos.nft_mint,
                estimatedA: amountA, estimatedB: amountB,
                tokenA: pos.token_a, tokenB: pos.token_b, simOk: true,
                swapTo: swapToToken?.symbol ?? null,
            };

            // Swap-Quote
            if (swapToToken && pos.token_a !== swapToToken.mint && amountA > 0.000001) {
                try {
                    const q = await getQuote(pos.token_a, pos.decimals_a, amountA, swapToToken.mint);
                    entry.swapQuoteA = { expectedOut: q.expectedOut, priceImpact: q.priceImpactPct };
                    log(`${pos.pair}: Quote TokenA → ${swapToToken.symbol}: ~${q.expectedOut.toFixed(4)}`);
                } catch (e) { entry.swapQuoteAError = e.message; }
            }

            results.push(entry);
            log(`${pos.pair}: Quote OK – ~${amountA.toFixed(4)} A + ${amountB.toFixed(4)} B`);
        } catch (err) {
            results.push({ pool: pos.pair, nftMint: pos.nft_mint, simOk: false, error: err.message });
            log(`${pos.pair}: Fehler: ${err.message}`);
        }
    }

    return { openPositions: positions.length, positions: results, rpcChecked: true };
}

// ─── Mode live: Echter Emergency-Exit ────────────────────────────────────────

async function executeWithdraw() {
    const { config, setPoolActive, setPoolEnabled } = await import('./config.js');
    const { OrcaAdapter } = await import('./pool-adapter/orca.js');
    const { getKeypair, getConnection, getSolBalanceFresh, SOL_EXIT_FLOOR } = await import('./wallet.js');
    const { EXIT_SOL_COMFORT } = await import('./sol-topup.js');

    const db        = openDb();
    const positions = getAllOpenPositions(db);
    db.close();

    if (positions.length === 0) {
        log('Keine offenen Positionen');
        return { openPositions: 0, closed: 0, failed: 0, positions: [] };
    }

    const adapter = new OrcaAdapter();
    const results = [];
    let closedCount = 0, failedCount = 0;

    for (const pos of positions) {
        log(`${pos.pair}: Position ${pos.nft_mint.slice(0, 8)}…`);
        const result = { pool: pos.pair, nftMint: pos.nft_mint };

        // Bei knappem SOL den Fee-Claim auslassen: er kostet selbst SOL, und bei
        // mehreren Positionen würde er das Budget für die restlichen Closes
        // aufbrauchen. Die Fees gehen nicht verloren — closePosition zahlt sie
        // ohnehin mit aus. Kein Abbruch: der Exit hat immer Vorrang (2026-07-29).
        let solNow = Infinity;
        try { solNow = await getSolBalanceFresh(getKeypair().publicKey); } catch { /* Best-effort */ }
        const solTight = solNow < EXIT_SOL_COMFORT;
        if (solTight) {
            result.feesSkipped = true;
            log(`${pos.pair}: SOL knapp (${solNow.toFixed(4)}) – Fee-Claim übersprungen, Close hat Vorrang`);
            if (solNow < SOL_EXIT_FLOOR) {
                log(`${pos.pair}: ⚠️  SOL unter dem physikalischen Boden (${SOL_EXIT_FLOOR}) – Close wird vermutlich scheitern`);
            }
        }

        if (!solTight) {
            try {
                const fees = await adapter.collectFees(
                    { address: pos.pool_address, pair: pos.pair,
                      tokenA: pos.token_a, tokenB: pos.token_b,
                      decimalsA: pos.decimals_a, decimalsB: pos.decimals_b },
                    pos.nft_mint,
                );
                result.feesTxHash = fees.txHash;
                result.feesA = fees.amountA;
                result.feesB = fees.amountB;
                log(`${pos.pair}: Fees geclaimed – ${fees.amountA} A + ${fees.amountB} B`);
            } catch (err) {
                result.feesError = err.message;
                log(`${pos.pair}: Fee-Claim fehlgeschlagen (nicht kritisch): ${err.message}`);
            }
        }

        try {
            const closed = await adapter.closePosition(
                { address: pos.pool_address, pair: pos.pair,
                  tokenA: pos.token_a, tokenB: pos.token_b,
                  decimalsA: pos.decimals_a, decimalsB: pos.decimals_b },
                pos.nft_mint,
            );
            result.closeTxHash = closed.txHash;
            result.amountA = closed.amountA;
            result.amountB = closed.amountB;
            result.success = true;
            closedCount++;
            log(`${pos.pair}: Position geschlossen (TX: ${closed.txHash.slice(0, 12)}…)`);

            // Pool sperren wie beim TVL-Schutz-Voll-Exit (lib/tvl-protection.js) —
            // sonst öffnet der nächste bot.js-Zyklus aus dem soeben abgezogenen
            // Wallet-Guthaben klaglos eine neue Position (real beobachtet 2026-08-04:
            // Emergency-Exit + späterer manueller Bot-Neustart → sofortige
            // Reinvestition). enabled=false ist die Benutzer-Sperre, die bot.js vor
            // jedem Neu-Eröffnen prüft — manuelle Freigabe im Backend nötig, exakt
            // wie nach einem TVL-Voll-Exit.
            try {
                setPoolActive(pos.pool_id, false);
                setPoolEnabled(pos.pool_id, false);
                log(`${pos.pair}: Pool gesperrt (enabled=false) – manuelle Freigabe im Backend nötig, sonst keine Reinvestition`);
            } catch (err) {
                log(`${pos.pair}: Pool-Sperre fehlgeschlagen (nicht kritisch): ${err.message}`);
            }
        } catch (err) {
            result.closeError = err.message;
            result.success    = false;
            failedCount++;
            log(`${pos.pair}: FEHLER: ${err.message}`);
        }
        results.push(result);
    }

    // Post-Processing: Swap + Send
    let postProcessing = null;
    if (swapToToken || sendToAddr) {
        const { submitAndConfirm } = await import('../../../core/tx-queue-client.js');
        const utils      = createUtils(web3, submitAndConfirm);
        const wallet     = getKeypair();
        const connection = getConnection();
        postProcessing   = {};

        if (swapToToken) {
            log(`Tausche alle Tokens → ${swapToToken.symbol}...`);
            try {
                postProcessing.swaps = await utils.swapAllToTarget(wallet, connection, swapToToken);
                for (const s of postProcessing.swaps) {
                    if (s.success) log(`  ${s.from} → ${swapToToken.symbol}: ${s.fromAmount.toFixed(6)} (TX: ${s.txHash?.slice(0, 12) ?? '?'}…)`);
                    else log(`  ${s.from} FEHLER: ${s.error}`);
                }
            } catch (err) { postProcessing.swapsError = err.message; }
        }

        if (sendToAddr) {
            log(`Sende alle Tokens an ${sendToAddr.slice(0, 8)}…`);
            try {
                postProcessing.sends = await utils.sendAllTokensTo(wallet, connection, sendToAddr);
                for (const s of postProcessing.sends) {
                    if (s.success) log(`  ${s.token}: ${s.amount.toFixed(6)} gesendet`);
                    else log(`  ${s.token} FEHLER: ${s.error}`);
                }
            } catch (err) { postProcessing.sendsError = err.message; }
        }
    }

    return {
        openPositions: positions.length,
        closed: closedCount, failed: failedCount,
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
    // Emergency-Exit-Dry-Run (LendingBot, Loopscale-Vault-Config-Bug) — das
    // Gesamtergebnis stand fälschlich auf "success" trotz gescheiterter Position.
    const posFailed = (data.positions ?? []).some(p => p.success === false || p.simOk === false);
    const output = {
        bot: 'liquiditybot', chain: 'solana', mode,
        ts:  new Date().toISOString(),
        success: errors.length === 0 && !posFailed,
        ...data, errors,
    };

    process.stdout.write(JSON.stringify(output) + '\n');
    process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(err => {
    process.stderr.write(`  [Liquidity] Fatal: ${err.stack ?? err.message}\n`);
    process.stdout.write(JSON.stringify({
        bot: 'liquiditybot', chain: 'solana', mode,
        ts:  new Date().toISOString(),
        success: false, errors: [{ error: err.message }],
    }) + '\n');
    process.exit(1);
});
