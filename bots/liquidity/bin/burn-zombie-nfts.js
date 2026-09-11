/**
 * burn-zombie-nfts.js
 *
 * Räumt Orca-Position-NFTs auf, die nach einem Rebalancing im Wallet verblieben
 * sind, weil closePosition() das NFT nicht geburnt hat (Bug-Fix v0.2.66).
 *
 * Ablauf:
 *   1. Aktive NFT-Mints aus DB lesen (closed_at IS NULL)
 *   2. Alle NFTs im Wallet scannen
 *   3. Für jedes NFT: Orca-Position-PDA ableiten, On-Chain-Account prüfen
 *   4. Zombies = Orca-Positions, die NICHT in der Aktiv-Liste sind
 *   5. Sicherheitscheck: Liquidität muss 0 sein – außer mit --include-dust
 *      (dann werden Mikrodust-Reste unter --dust-threshold automatisch entfernt;
 *      typisch nach Withdraw --full bei dem ein Slippage-Buffer übrigblieb)
 *   6. Ohne --execute: Dry-Run (zeigt was geburnt würde)
 *      Mit    --execute: NFTs on-chain verbrennen, Rent zurückholen
 *
 * Aufruf:
 *   node bin/burn-zombie-nfts.js
 *   node bin/burn-zombie-nfts.js --execute
 *   node bin/burn-zombie-nfts.js --include-dust --execute
 *   node bin/burn-zombie-nfts.js --include-dust --dust-threshold 50000000 --execute
 *   node bin/burn-zombie-nfts.js --full-close --execute
 *      Zieht die gesamte Liquidität einer Zombie-Position ab (decreaseLiquidity),
 *      leert Fees und brennt dann das NFT. Gilt für jede Liquiditätsmenge.
 */

import { readFileSync }  from 'node:fs';
import { config }        from '../lib/config.js';
import { openDatabase }  from '../lib/db.js';
import {
    getKeypair,
    getConnection,
    assertSufficientSol,
} from '../lib/wallet.js';
import { rpcLimiter }    from '../lib/rate-limiter.js';
import { PATHS }         from '../../../config/paths.js';
import {
    WhirlpoolContext,
    buildWhirlpoolClient,
    ORCA_WHIRLPOOL_PROGRAM_ID,
    PDAUtil,
    WhirlpoolIx,
    collectFeesQuote,
    decreaseLiquidityQuoteByLiquidityWithParams,
    TokenExtensionUtil,
    IGNORE_CACHE,
} from '@orca-so/whirlpools-sdk';
import { Percentage, TransactionBuilder } from '@orca-so/common-sdk';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Wallet }  from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';

const EXECUTE      = process.argv.includes('--execute');
const INCLUDE_DUST = process.argv.includes('--include-dust');
const FULL_CLOSE   = process.argv.includes('--full-close');   // zieht beliebige Liquidität ab
const DUST_THRESHOLD = (() => {
    const idx = process.argv.indexOf('--dust-threshold');
    if (idx > -1 && process.argv[idx + 1]) {
        try { return BigInt(process.argv[idx + 1]); }
        catch { console.error(`[burn-zombie] Ungültiger --dust-threshold: ${process.argv[idx + 1]}`); process.exit(1); }
    }
    return 10_000_000n;  // 10M L – bei BTC-Pools (8 decimals) typisch wenige Cent
})();
// Hohe Slippage-Toleranz beim Dust-Decrease: Dust ist wertmäßig irrelevant,
// strenge Slippage würde den Decrease unnötig oft mit 0x1781 (TokenMinSubceeded) abbrechen.
const DUST_SLIPPAGE = Percentage.fromFraction(10, 100);
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const PRIORITY_FEE_LAMPORTS = 10_000;

// ─── Setup ───────────────────────────────────────────────────────────────────

const db      = openDatabase();
const keypair = getKeypair();
const conn    = getConnection();

// Pool-Namen wie auf Orca (displayPair), nicht die interne DB-Reihenfolge (pair) —
// gleiche Konvention wie überall sonst in FORGE (notify.js, daily-report.js, export.js).
const displayPairMap = (() => {
    const m = new Map();
    try {
        for (const p of JSON.parse(readFileSync(PATHS.liquidityPools, 'utf8'))) {
            m.set(p.id, p.displayPair ?? p.pair ?? p.id);
        }
    } catch { /* Fallback unten */ }
    return m;
})();

const poolByMintStmt = db.prepare(`
    SELECT po.id AS pool_id, po.pair
    FROM positions p
    JOIN pools po ON po.id = p.pool_id
    WHERE p.nft_mint = ?
    ORDER BY p.id DESC
    LIMIT 1
`);
function displayPairForMint(mintStr) {
    const row = poolByMintStmt.get(mintStr);
    if (!row) return 'unbekannter Pool';
    return displayPairMap.get(row.pool_id) ?? row.pair;
}

// Kurzform eines Burn-Fehlers für die Ergebnis-Spalte der Zombie-Check-Notification
// (run-zombie-check.sh). Die rohe RPC-Fehlermeldung dort ("TX abgelaufen") ließ den
// Leser ratlos zurück (Betreiber-Feedback 2026-08-29) — kein Hinweis, ob etwas zu tun
// ist. Die Zombie-Position bleibt bei jedem Fehler unangetastet im Wallet und taucht
// beim nächsten 00:01-Lauf erneut als Zombie auf, wird also automatisch wiederholt —
// das gehört deshalb IMMER mit in den Text, nicht nur bei den bekannten Mustern unten.
function shortenBurnError(message) {
    const msg = String(message ?? '');
    // Solana: Blockhash der TX war abgelaufen, bevor sie bestätigt wurde – ein
    // Netzwerk-/Timing-Problem, keines mit dem Pool oder dem Guthaben.
    if (/block height exceeded|has expired/i.test(msg)) return 'Netzwerk-Timeout, wiederhole es morgen';
    if (/insufficient|not enough|too low/i.test(msg))   return 'zu wenig SOL, wiederhole es morgen';
    const short = msg.replace(/\s+/g, ' ').trim().slice(0, 40);
    return short ? `${short}, wiederhole es morgen` : 'Fehler, wiederhole es morgen';
}

// Aktive NFT-Mints aus der DB (closed_at IS NULL)
const activeNftMints = new Set(
    db.prepare(`SELECT nft_mint FROM positions WHERE closed_at IS NULL`)
      .all()
      .map(r => r.nft_mint)
);

console.log(`[burn-zombie] Aktive Positionen in DB: ${activeNftMints.size}`);
for (const m of activeNftMints) console.log(`  ✅ aktiv: ${m}`);

// ─── Wallet-NFTs scannen ─────────────────────────────────────────────────────

await rpcLimiter.wait();
const tokenAccounts = await conn.getParsedTokenAccountsByOwner(
    keypair.publicKey, { programId: TOKEN_PROGRAM_ID }
);
const walletNftMints = tokenAccounts.value
    .filter(a => {
        const amt = a.account.data.parsed.info.tokenAmount;
        return amt.uiAmount === 1 && amt.decimals === 0;
    })
    .map(a => new PublicKey(a.account.data.parsed.info.mint));

console.log(`\n[burn-zombie] NFTs im Wallet: ${walletNftMints.length}`);

// ─── Orca-Positions identifizieren ───────────────────────────────────────────

const posPdas = walletNftMints.map(m => PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, m).publicKey);

await rpcLimiter.wait();
const posInfos = await conn.getMultipleAccountsInfo(posPdas);

const zombies = [];

for (let i = 0; i < posInfos.length; i++) {
    const info = posInfos[i];
    const mint = walletNftMints[i];

    // Kein Account → kein Orca-Position-NFT
    if (!info || info.data.length < 100) continue;

    // Liquidität aus Raw-Bytes lesen (Bytes 72–88, zwei u64)
    const d      = info.data;
    const liqRaw = d.readBigUInt64LE(72);    // lower 64 bit
    const liquidity = liqRaw.toString();

    const mintStr = mint.toBase58();

    if (activeNftMints.has(mintStr)) {
        console.log(`  ✅ aktiv (überspringen): ${mintStr}`);
        continue;
    }

    // Sicherheitscheck: Liquidität (lower UND upper 64 bit) muss 0 sein.
    // Ausnahme: --include-dust + Liquidität ≤ DUST_THRESHOLD → Dust-Decrease vor Burn.
    const liqHigh = d.readBigUInt64LE(80);
    const totalLiq = liqHigh * (2n ** 64n) + liqRaw;
    let needsDecrease = false;
    if (liqRaw !== 0n || liqHigh !== 0n) {
        if (FULL_CLOSE) {
            // --full-close: gesamte Liquidität via decreaseLiquidity abziehen, egal wie viel
            needsDecrease = true;
        } else if (INCLUDE_DUST && liqHigh === 0n && liqRaw <= DUST_THRESHOLD) {
            needsDecrease = true;
        } else {
            console.error(`  ⛔ SICHERHEIT: ${mintStr} hat Liquidität ${totalLiq} — nicht geburnt!`);
            if (!INCLUDE_DUST && liqHigh === 0n && liqRaw <= DUST_THRESHOLD) {
                console.error(`             (Liquidität ≤ Dust-Schwelle ${DUST_THRESHOLD}. Mit --include-dust freigeben.)`);
            } else if (!FULL_CLOSE) {
                console.error(`             (Echte Liquidität > Dust. Mit --full-close abziehen und brennen.)`);
            }
            continue;
        }
    }

    // fee_owed prüfen (u64 bei Offset 112 bzw. 136) — kein Blocker, aber Collect-Schritt nötig
    const feeOwedA = d.readBigUInt64LE(112);
    const feeOwedB = d.readBigUInt64LE(136);
    const needsCollect = feeOwedA > 0n || feeOwedB > 0n;

    const posPda = posPdas[i];
    const pair   = displayPairForMint(mintStr);
    zombies.push({ mint, posPda, mintStr, pair, needsCollect, needsDecrease, dustLiq: totalLiq, feeOwedA, feeOwedB, rentLamports: info.lamports });
    const tags = [];
    if (needsDecrease) tags.push(`Dust L=${totalLiq}`);
    if (needsCollect)  tags.push(`Fees ${feeOwedA}A/${feeOwedB}B`);
    const tagStr = tags.length > 0 ? ` (${tags.join(' + ')})` : '';
    console.log(`  🧟 Zombie${tagStr}: ${mintStr} (${pair})`);
}

console.log(`\n[burn-zombie] Zombies gesamt: ${zombies.length}`);

// ─── Aktive Positionen mit niedrigem Guthaben (≤ 1 USDC) ─────────────────────
// Warnung: diese Positionen sind noch aktiv in der DB, aber fast leer.
// Kandidaten für manuelle Prüfung oder erneuten Zombie-Scan nach Schließung.
const lowBalRows = db.prepare(`
    SELECT p.nft_mint, po.pair,
           ps.lp_value_usd, ps.fees_pending_usd,
           (COALESCE(ps.lp_value_usd, 0) + COALESCE(ps.fees_pending_usd, 0)) AS total_usd
    FROM positions p
    JOIN pools po ON po.id = p.pool_id
    LEFT JOIN position_snapshots ps
        ON  ps.pool_id    = p.pool_id
        AND ps.recorded_at = (
            SELECT MAX(recorded_at) FROM position_snapshots WHERE pool_id = p.pool_id
        )
    WHERE p.closed_at IS NULL
      AND (COALESCE(ps.lp_value_usd, 0) + COALESCE(ps.fees_pending_usd, 0)) <= 1.0
    ORDER BY total_usd ASC
`).all();

if (lowBalRows.length > 0) {
    console.log(`\n[burn-zombie] ⚠️  Aktive Positionen mit Guthaben ≤ 1 USDC:`);
    for (const row of lowBalRows) {
        const lp    = (row.lp_value_usd    ?? 0).toFixed(4);
        const fees  = (row.fees_pending_usd ?? 0).toFixed(4);
        const total = (row.total_usd        ?? 0).toFixed(4);
        console.log(`  💸 ${(row.pair ?? '?').padEnd(14)} NFT=${row.nft_mint}  LP=${lp} + Fees=${fees} = ${total} USDC`);
    }
} else {
    console.log('[burn-zombie] Alle aktiven Positionen haben Guthaben > 1 USDC. ✓');
}

if (zombies.length === 0) {
    console.log('[burn-zombie] Nichts zu tun.');
    db.close();
    process.exit(0);
}

if (!EXECUTE) {
    console.log('\n[burn-zombie] Dry-Run – kein On-Chain-Effekt.');
    const hasFullClose = zombies.some(z => z.needsDecrease && z.dustLiq > DUST_THRESHOLD);
    const hasDust      = zombies.some(z => z.needsDecrease && z.dustLiq <= DUST_THRESHOLD);
    if (hasFullClose) {
        console.log('             Zum Verbrennen (inkl. echter Liquidität): node bin/burn-zombie-nfts.js --full-close --execute');
    } else if (hasDust) {
        console.log('             Zum Verbrennen (inkl. Dust): node bin/burn-zombie-nfts.js --include-dust --execute');
    } else {
        console.log('             Zum tatsächlichen Verbrennen: node bin/burn-zombie-nfts.js --execute');
    }
    db.close();
    process.exit(0);
}

// ─── Verbrennen ───────────────────────────────────────────────────────────────
// SOL-Check VOR dem ersten On-Chain-Call: burn/decrease/collect kosten alle Fees,
// ein Abbruch mitten in der Zombie-Liste würde einen Teil-Zustand hinterlassen.
// Sauberer Abbruch statt ungefangener Exception (die crashte den Cron-Job bisher
// mit vollem Stacktrace, siehe LIQ#0341-Folgevorfall 2026-08-28) — jede gefundene
// Zombie-Position wird als [burn-pending] geloggt, damit der Wrapper
// (run-zombie-check.sh) trotz Abbruch weiß, welche Pools betroffen sind.
try {
    await assertSufficientSol(keypair.publicKey);
} catch (err) {
    console.error(`\n[burn-zombie] ${err.message}`);
    for (const z of zombies) {
        console.log(`[burn-pending] pool=${z.pair} mint=${z.mintStr}`);
    }
    console.log(`\n[burn-zombie] Abgebrochen: ${zombies.length} Zombie(s) gefunden, 0 geburnt (zu wenig SOL).`);
    db.close();
    process.exit(1);
}

const wallet = new Wallet(keypair);
const ctx    = WhirlpoolContext.from(conn, wallet, undefined, undefined, {
    userDefaultBuildOptions: {
        computeBudgetOption: { type: 'fixed', priorityFeeLamports: PRIORITY_FEE_LAMPORTS },
    },
});

const client = buildWhirlpoolClient(ctx);

let burned = 0;
for (const { mint, posPda, mintStr, pair, needsCollect, needsDecrease, dustLiq, rentLamports } of zombies) {
    try {
        // Liquidität abziehen falls noch >0 (sonst wirft closePosition 0x178b ClosePositionNotEmpty)
        // Bei --full-close: echte Position inkl. Kapital; bei --include-dust: nur Dust-Rest
        if (needsDecrease) {
            const position  = await client.getPosition(posPda, IGNORE_CACHE);
            const posData   = position.getData();
            await rpcLimiter.wait();
            const whirlpool = await client.getPool(posData.whirlpool, IGNORE_CACHE);
            const poolData  = whirlpool.getData();

            // Für echte Positionen (> Dust) engere Slippage zum Kapitalschutz
            const slippage = (dustLiq > DUST_THRESHOLD)
                ? Percentage.fromFraction(1, 100)
                : DUST_SLIPPAGE;

            // Echter Extension-Kontext statt NO_TOKEN_EXTENSION_CONTEXT (LIQ#0276) — sonst
            // unterschätzt die Quote bei Token-2022-Transfer-Fee-Mints die Vault-Fee.
            const tokenExtCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
                ctx.fetcher, poolData.tokenMintA, poolData.tokenMintB, IGNORE_CACHE,
            );
            const quote = decreaseLiquidityQuoteByLiquidityWithParams({
                liquidity:         posData.liquidity,
                sqrtPrice:         poolData.sqrtPrice,
                tickCurrentIndex:  poolData.tickCurrentIndex,
                tickLowerIndex:    posData.tickLowerIndex,
                tickUpperIndex:    posData.tickUpperIndex,
                slippageTolerance: slippage,
                tokenExtensionCtx: tokenExtCtx,
            });

            const decTx = await position.decreaseLiquidity(quote);
            await rpcLimiter.wait();
            const decHash = await decTx.buildAndExecute();
            const label = dustLiq > DUST_THRESHOLD ? 'Liquidität abgezogen' : 'Dust entfernt';
            console.log(`  🧹 ${label} (L=${dustLiq}): ${mintStr} TX=${decHash}`);
        }

        // Fees leeren, falls noch fee_owed vorhanden ODER nach Dust-Decrease (immer sicher)
        // collectFees(false): UpdateFeesAndRewards wird NICHT aufgerufen – nötig wenn Liquidität
        // bereits 0 ist (z.B. nach needsDecrease oder bei bereits leer gezogenen Positionen),
        // da UpdateFeesAndRewards bei Liquidität=0 mit 0x177c (LiquidityZero) fehlschlägt.
        if (needsCollect || needsDecrease) {
            const position = await client.getPosition(posPda, IGNORE_CACHE);
            const collectTx = await position.collectFees(false);
            await rpcLimiter.wait();
            const collectHash = await collectTx.buildAndExecute();
            console.log(`  💰 Fees geleert: ${mintStr} TX=${collectHash}`);
        }

        const positionTokenAccount = getAssociatedTokenAddressSync(mint, keypair.publicKey);

        const burnIx = WhirlpoolIx.closePositionIx(ctx.program, {
            positionAuthority:    keypair.publicKey,
            receiver:             keypair.publicKey,
            position:             posPda,
            positionMint:         mint,
            positionTokenAccount,
        });

        await rpcLimiter.wait();
        const burnTx = new TransactionBuilder(ctx.connection, ctx.wallet, ctx.txBuilderOpts)
            .addInstruction(burnIx);
        const txHash = await burnTx.buildAndExecute();

        const rentSol = (rentLamports / 1e9).toFixed(5);
        console.log(`  🔥 Geburnt: ${mintStr} | TX=${txHash}`);
        console.log(`[burn-result] pool=${pair} mint=${mintStr} rentSol=${rentSol}`);
        burned++;
    } catch (err) {
        console.error(`  ❌ Fehler bei ${mintStr}: ${err.message}`);
        // Kurzform für die Pool-Tabelle im Wrapper (run-zombie-check.sh) — ohne diese
        // Zeile kennt der Wrapper bei Einzel-Fehlern nur die Aggregatzahl, keinen Pool.
        console.log(`[burn-fail] pool=${pair} mint=${mintStr} reason=${shortenBurnError(err.message)}`);
    }
}

console.log(`\n[burn-zombie] Fertig: ${burned}/${zombies.length} NFTs geburnt.`);
console.log(`[burn-zombie] Rent zurückgeholt: ~${(burned * 0.002).toFixed(3)} SOL`);

db.close();
