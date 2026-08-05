/**
 * FORGE Liquidity – Zentrales State-Refresh nach Bot-Aktionen.
 *
 * Eine Bot-Aktion (Claim+Reinvest, Deposit, Withdraw, Cleanup) ändert den On-Chain-State.
 * Damit das Dashboard konsistent ist, müssen danach drei Snapshots geschrieben werden:
 *
 *   1. `position_snapshots`   – pro Pool: lp_value_usd, Fees, IL, Token-Mengen
 *                                ("Mein Anteil" je Pool, APR-Berechnung)
 *   2. `portfolio_history`    – Aggregat über alle offenen Pools + Wallet
 *                                ("Guthaben", Charts, Performance)
 *   3. Wallet-Monitor-Snapshot – SOL/USDC + Whitelist-Tokens
 *                                (Wallet-Spalte im Dashboard)
 *
 * Danach: `syncDashboard()` (export.js → data.json → rsync zum Webserver).
 *
 * Wird die Sequenz NICHT vollständig durchgeführt, zeigt das Dashboard inkonsistente
 * Werte bis zum nächsten regulären Bot-Tick (bis zu 30 s). Genau das war historisch
 * der Grund warum "Mein Anteil" nach Reinvest verzögert aktualisierte.
 *
 * API:
 *   - `writePositionSnapshotFromState(...)` – State-basierter Pos-Snapshot (Bot-Pfad)
 *   - `writePositionSnapshotFromDelta(...)`  – Delta-basierter Pos-Snapshot (Deposit/Withdraw)
 *   - `writePortfolioSnapshot(db)`           – Aggregat-Snapshot
 *   - `writeFreshWalletSnapshot()`           – Wallet-Monitor-Snapshot
 *   - `refreshAfterAction(db, opts)`         – Orchestrator: Portfolio + Wallet + Sync
 */

import { spawn }             from 'child_process';
import { resolve, dirname }  from 'path';
import { fileURLToPath }     from 'url';

import BN      from 'bn.js';
import Decimal from 'decimal.js';
import { PriceMath, PoolUtil } from '@orca-so/whirlpools-sdk';

import { PublicKey } from '@solana/web3.js';

import {
    insertPositionSnapshot, insertPortfolioSnapshot, updatePositionLiquidity,
} from './db.js';
import {
    getKeypair, getConnectionFresh,
    USDC_MINT,
} from './wallet.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
import { writeWalletSnapshot, getLatestWalletBalance } from './wallet-monitor-client.js';
import { getTokenUsdPrice } from './deposit-lib.js';
import { config } from './config.js';
import { syncDashboard } from './sync.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const __dirname          = dirname(fileURLToPath(import.meta.url));
const WALLET_MONITOR_JS  = resolve(__dirname, '../../../core/wallet-monitor/monitor.js');

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Liest den USD-Preis des Quote-Tokens.
 * Quelle 1: oracle_prices (Pyth, max. 5 Min alt) — unabhängig von Pool-Liquidität.
 * Quelle 2: pool_stats des Referenz-Pools (Fallback).
 */
function getQuotePriceUsd(db, pool) {
    if (!pool.quoteTokenMint) return 0;
    if (pool.quotePricePoolId) {
        const fresh = Date.now() - 5 * 60 * 1000;
        const oracle = db.prepare(
            `SELECT price FROM oracle_prices WHERE quote_pool_id = ? AND updated_at > ?`
        ).get(pool.quotePricePoolId, fresh);
        if (oracle) return oracle.price;
    }
    return getTokenUsdPrice(pool.quoteTokenMint, db);
}

/**
 * USD-Konversionsfunktion je nach Pool-Typ.
 *  - usdcIsTokenA: tokenA=USDC, tokenB=EURC o.ä. → a + b/price
 *  - volatilePair: beide Tokens volatil, USD via Quote-Token (z.B. SOL bei HYPE/SOL, BTC bei cbBTC/WBTC).
 *                  Wenn Quote = tokenA: (a + b/price) * quotePriceUsd
 *                  Wenn Quote = tokenB: (a*price + b) * quotePriceUsd
 *  - Standard:     tokenA=SOL/cbBTC, tokenB=USDC → a*price + b
 */
function makeToUsd(pool, price, quotePrice) {
    if (pool.usdcIsTokenA)   return (a, b) => a + (price > 0 ? b / price : 0);
    if (pool.volatilePair) {
        const quoteIsTokenA = pool.quoteTokenMint === pool.tokenA;
        if (quoteIsTokenA) {
            return (a, b) => (a + (price > 0 ? b / price : 0)) * quotePrice;
        }
        return (a, b) => (a * price + b) * quotePrice;
    }
    return (a, b) => a * price + b;
}

// ─── Position-Snapshot ────────────────────────────────────────────────────────

/**
 * Schreibt einen Position-Snapshot, berechnet aus On-Chain-State.
 *
 * Verwendet vom Bot-Loop nach Claim+Reinvest: `state.liquidity` ist bereits
 * der neue Gesamt-Wert (nach orca.js v0.3.8 ohne stale Cache-Read).
 *
 * @param {Object} db
 * @param {Object} pool       – aktive Pool-Config (mit quotePricePoolId, usdcIsTokenA, decimalsA/B)
 * @param {Object} position   – DB-Position-Row (hodl_token_a/b für IL-Berechnung)
 * @param {Object} state      – On-Chain-State: { liquidity, tickLower, tickUpper, feesOwedA, feesOwedB }
 * @param {number} price      – aktueller Pool-Preis (tokenB pro tokenA)
 * @returns {boolean}         – true wenn Snapshot geschrieben, false bei Stale-Guard-Skip
 */
export function writePositionSnapshotFromState(db, pool, position, state, price) {
    const liquidityBN = new BN(state.liquidity);
    const sqrtPrice   = PriceMath.priceToSqrtPriceX64(
        new Decimal(price), pool.decimalsA, pool.decimalsB,
    );
    const sqrtLower = PriceMath.tickIndexToSqrtPriceX64(state.tickLower);
    const sqrtUpper = PriceMath.tickIndexToSqrtPriceX64(state.tickUpper);

    const amounts = PoolUtil.getTokenAmountsFromLiquidity(
        liquidityBN, sqrtPrice, sqrtLower, sqrtUpper, false,
    );
    const tokenAAmount = new Decimal(amounts.tokenA.toString()).div(Math.pow(10, pool.decimalsA)).toNumber();
    const tokenBAmount = new Decimal(amounts.tokenB.toString()).div(Math.pow(10, pool.decimalsB)).toNumber();

    const quotePrice = getQuotePriceUsd(db, pool);
    const toUsd      = makeToUsd(pool, price, quotePrice);

    const lpValueUsd     = toUsd(tokenAAmount, tokenBAmount);
    const feesPendingUsd = toUsd(state.feesOwedA ?? 0, state.feesOwedB ?? 0);

    const hodlValue = toUsd(position.hodl_token_a ?? 0, position.hodl_token_b ?? 0);
    const ilUsd     = lpValueUsd - hodlValue;
    const ilPct     = hodlValue > 0 ? (ilUsd / hodlValue) * 100 : 0;

    // Stale-Read-Guard: liquidity=0 bei offener Position ist ein fehlerhafter Zwischenzustand
    if (lpValueUsd <= 0) {
        console.warn(`[refresh-state:${pool.id}] writePositionSnapshotFromState übersprungen: lpValueUsd=${lpValueUsd.toFixed(4)} (liquidity=${state.liquidity}, price=${price})`);
        return false;
    }

    // positions.liquidity mit frischem On-Chain-Wert synchronisieren (sonst bleibt der
    // beim Öffnen gespeicherte Wert hängen, da Reconcile-/Reinvest-increaseLiquidity die
    // echte Liquidität erhöht). Single Point of Truth bei jedem regulären Tick.
    if (position?.id != null) {
        updatePositionLiquidity(db, position.id, state.liquidity);
    }

    insertPositionSnapshot(db, {
        poolId:        pool.id,
        lpValueUsd,
        feesPendingUsd,
        feesPendingA:  state.feesOwedA ?? 0,
        feesPendingB:  state.feesOwedB ?? 0,
        price,
        ilUsd,
        ilPct,
        amountA:       tokenAAmount,
        amountB:       tokenBAmount,
    });
    return true;
}

/**
 * Schreibt einen Position-Snapshot via Delta-Arithmetik (kein On-Chain-Read nötig).
 *
 * Verwendet von Deposit/Withdraw/Cleanup direkt nach increase-/decreaseLiquidity:
 *  - Liest letzten Snapshot des Pools (amount_a/b)
 *  - Addiert/subtrahiert Delta-Token-Beträge
 *  - Berechnet lp_value_usd mit aktuellem Preis
 *
 * Fees werden aus dem vorherigen Snapshot übernommen: `increaseLiquidity`/`decreaseLiquidity`
 * setzen die on-chain `feesOwed` nicht zurück (nur `update_fees_and_rewards` wird intern aufgerufen,
 * was die Werte sogar leicht erhöhen kann). Der nächste reguläre Bot-Tick überschreibt
 * `fees_pending_*` mit dem präzisen on-chain-Wert.
 * IL bleibt 0 (wird beim nächsten regulären Bot-Tick präzise neu berechnet).
 *
 * @param {Object} db
 * @param {Object} pool
 * @param {number} deltaA    – Token-A-Änderung in Einheiten (positiv=Einzahlung, negativ=Auszahlung)
 * @param {number} deltaB    – Token-B-Änderung
 * @param {number} price     – aktueller Pool-Preis
 * @returns {boolean}
 */
export function writePositionSnapshotFromDelta(db, pool, deltaA, deltaB, price) {
    const prev = db.prepare(
        `SELECT amount_a, amount_b, fees_pending_a, fees_pending_b, fees_pending_usd, recorded_at
         FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`,
    ).get(pool.id);

    // Staleness-Guard: Ein Delta-Snapshot ist nur valide, wenn er auf einen FRISCHEN
    // On-Chain-Basis-Snapshot aufsetzt. Ist der letzte Snapshot veraltet (z.B. weil ein
    // abgebrochenes Rebalancing die regulären Tick-Snapshots unterdrückt hat), würde das
    // Delta auf einen falschen Basiswert addiert — das erzeugt physikalisch unmögliche
    // Token-Mengen und einen Wert-Spike (siehe PUMP/SOL-Vorfall 2026-06-28: +153 USDC
    // Phantom-Sprung auf 310). Dann lieber den Delta-Write überspringen und den nächsten
    // regulären On-Chain-Snapshot die Wahrheit etablieren lassen (= Verhalten vor dem
    // Delta-Write, kein Schaden — nur kein Sofort-Update im Dashboard).
    const STALE_BASE_MS = 15 * 60 * 1000;
    if (prev && (Date.now() - (prev.recorded_at ?? 0)) > STALE_BASE_MS) {
        const ageMin = ((Date.now() - prev.recorded_at) / 60000).toFixed(0);
        console.warn(`[refresh-state:${pool.id}] writePositionSnapshotFromDelta übersprungen: Basis-Snapshot ${ageMin} Min alt (> 15 Min) → On-Chain-Recompute beim nächsten Tick`);
        return false;
    }

    const snapAmtA = Math.max(0, (prev?.amount_a ?? 0) + deltaA);
    const snapAmtB = Math.max(0, (prev?.amount_b ?? 0) + deltaB);

    const quotePrice = getQuotePriceUsd(db, pool);
    const toUsd      = makeToUsd(pool, price, quotePrice);
    const lpValueUsd = toUsd(snapAmtA, snapAmtB);

    if (lpValueUsd <= 0) {
        console.warn(`[refresh-state:${pool.id}] writePositionSnapshotFromDelta übersprungen: lpValueUsd=${lpValueUsd.toFixed(4)}`);
        return false;
    }

    insertPositionSnapshot(db, {
        poolId:         pool.id,
        lpValueUsd,
        feesPendingUsd: prev?.fees_pending_usd ?? 0,
        feesPendingA:   prev?.fees_pending_a   ?? 0,
        feesPendingB:   prev?.fees_pending_b   ?? 0,
        price,
        ilUsd:          0,
        ilPct:          0,
        amountA:        snapAmtA,
        amountB:        snapAmtB,
    });
    return true;
}

// ─── Portfolio-Snapshot ───────────────────────────────────────────────────────

/**
 * Schreibt einen Aggregat-Snapshot über alle offenen Pools + Wallet.
 *
 * Single Source of Truth: Wallet-Werte (SOL/USDC/SPL-Tokens) kommen ausschließlich
 * aus wallet-monitor.db. Dazu wird VOR dem Aggregat ein frischer Wallet-Snapshot
 * geschrieben (writeFreshWalletSnapshot → on-chain). Damit kann das Aggregat nie
 * mehr von einer veralteten parallelen Wallet-Quelle abweichen.
 *
 * portfolio_history speichert seit v0.3.47 nur noch total/LP/Fees/IL — die
 * früheren wallet_*-Spalten sind entfernt (Phase 5 Migration).
 */
export async function writePortfolioSnapshot(db) {
    // 1. Frischer Wallet-Snapshot in wallet-monitor.db (SOL + alle SPL-Tokens via Bulk-Call).
    await writeFreshWalletSnapshot(db);

    // 2. Aggregat der offenen Positionen aus den jüngsten position_snapshots.
    const allPoolSnaps = db.prepare(`
        SELECT ps.lp_value_usd, ps.fees_pending_usd, ps.il_usd
        FROM position_snapshots ps
        INNER JOIN (
            SELECT pool_id, MAX(recorded_at) AS max_ts
            FROM position_snapshots GROUP BY pool_id
        ) latest ON ps.pool_id = latest.pool_id AND ps.recorded_at = latest.max_ts
        INNER JOIN positions p ON ps.pool_id = p.pool_id AND p.closed_at IS NULL
    `).all();

    const aggLpValue = allPoolSnaps.reduce((s, r) => s + r.lp_value_usd,    0);
    const aggFees    = allPoolSnaps.reduce((s, r) => s + r.fees_pending_usd, 0);
    const aggIlUsd   = allPoolSnaps.reduce((s, r) => s + r.il_usd,           0);

    // 3. Wallet-Summe aus wallet-monitor.db (gerade geschrieben → frisch).
    const wallet    = getLatestWalletBalance(config.botId);
    let walletVal   = wallet ? wallet.totalUsd : 0;

    // 4. Spike-Guard: verhindert Ausschläge wenn Rebalancing-Kapital kurz im Wallet liegt.
    //    Auslöser: total_usd würde mehr als 500 USDC steigen, ohne dass lp_value entsprechend
    //    gestiegen ist → Wallet-Spike, kein externer Zufluss.
    //    In diesem Fall walletVal auf den zuletzt bekannten Wallet-Anteil einfrieren.
    const _lastSnap = db.prepare(
        `SELECT total_usd, lp_value_usd, fees_pending_usd FROM portfolio_history
         ORDER BY recorded_at DESC LIMIT 1`
    ).get();
    if (_lastSnap) {
        const prevWallet   = Math.max(0, _lastSnap.total_usd - _lastSnap.lp_value_usd - _lastSnap.fees_pending_usd);
        const lpIncrease   = aggLpValue - _lastSnap.lp_value_usd;
        const totalIncrease = (aggLpValue + aggFees + walletVal) - _lastSnap.total_usd;
        if (totalIncrease > 500 && totalIncrease > lpIncrease + 200) {
            console.warn(`[portfolio] Wallet-Spike gedämpft: total wäre +${totalIncrease.toFixed(0)} USDC (LP +${lpIncrease.toFixed(0)}) — walletVal ${walletVal.toFixed(0)} → ${prevWallet.toFixed(0)}`);
            walletVal = prevWallet;
        }
    }

    insertPortfolioSnapshot(db, {
        totalUsd:       aggLpValue + aggFees + walletVal,
        lpValueUsd:     aggLpValue,
        feesPendingUsd: aggFees,
        ilUsd:          aggIlUsd,
        ilPct:          0,
    });
}

// ─── Wallet-Snapshot (Dashboard-Wallet-Spalte) ────────────────────────────────

/**
 * Liefert alle Pool-Tokens (tokenA + tokenB) aus der Pool-Konfiguration, ohne USDC
 * und WSOL (die werden separat als usdcBalance/solBalance behandelt). Dedup über Map
 * nach Mint. Quelle ist `config.pools.all` (inkl. inaktiver Pools), damit residuale
 * Tokens deaktivierter Pools korrekt erfasst werden.
 */
function getWalletWhitelistTokens() {
    const tokens = new Map();
    for (const pool of config.pools.all) {
        if (pool.tokenA && pool.tokenA !== WSOL_MINT && pool.tokenA !== USDC_MINT) {
            tokens.set(pool.tokenA, {
                mint:     pool.tokenA,
                decimals: pool.decimalsA,
                symbol:   pool.pair.split('/')[0],
            });
        }
        if (pool.tokenB && pool.tokenB !== WSOL_MINT && pool.tokenB !== USDC_MINT) {
            tokens.set(pool.tokenB, {
                mint:     pool.tokenB,
                decimals: pool.decimalsB,
                symbol:   pool.usdcIsTokenA ? pool.pair.split('/')[0] : pool.pair.split('/')[1],
            });
        }
    }
    return [...tokens.values()];
}

/**
 * Schreibt einen frischen Wallet-Snapshot. SOL und ALLE SPL-Token-Balances (USDC +
 * Whitelist) werden mit einem einzigen Bulk-RPC-Call gelesen — keine Pro-Token-Schleife.
 *
 * Hintergrund: Carry-Over aus alten Snapshots führte zu Wallet-Wert-Drift
 * (alte Balance × neuer Preis). Vor v0.3.46 machte diese Funktion N Einzel-Calls
 * (1 pro Whitelist-Token), was bei jeder Bot-Action den Helius-RPC unnötig belastete.
 * Jetzt: 3 RPCs (getBalance für SOL + TOKEN_PROGRAM + TOKEN_2022_PROGRAM parallel).
 * Token-2022-Tokens (PUMP, USDG) werden seit v0.3.54 korrekt erfasst.
 */
export async function writeFreshWalletSnapshot(db, { walletId = 'liquidity', walletLabel = 'Liquidity Bot' } = {}) {
    const keypair  = getKeypair();
    const conn     = getConnectionFresh();

    // 3 parallele RPCs: SOL + SPL-Token-Accounts (TOKEN_PROGRAM) + Token-2022-Accounts
    // Token-2022 (TokenzQd...) ist ein separates Program — getParsedTokenAccountsByOwner
    // mit programId=TOKEN_PROGRAM_ID übersieht Token-2022-Accounts vollständig (PUMP, USDG).
    const [lamports, tokenAccounts, token22Accounts] = await Promise.all([
        conn.getBalance(keypair.publicKey, 'confirmed'),
        conn.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: TOKEN_PROGRAM_ID }),
        conn.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);
    const solBalance = lamports / 1_000_000_000;

    // mint → uiAmount aus dem Bulk-Result extrahieren (beide Program-Typen)
    const balByMint = new Map();
    for (const { account } of [...tokenAccounts.value, ...token22Accounts.value]) {
        const info = account.data.parsed.info;
        const amt  = info.tokenAmount.uiAmount ?? 0;
        if (amt > 0) balByMint.set(info.mint, amt);
    }
    const usdcBalance = balByMint.get(USDC_MINT) ?? 0;

    const solPriceRow = db.prepare(
        `SELECT price FROM pool_stats WHERE pool_id = 'liq-sol-usdc' ORDER BY recorded_at DESC LIMIT 1`,
    ).get();

    // Alle Whitelist-Tokens schreiben — auch balance=0. Damit zeigt das Dashboard
    // nach jeder Bot-Aktion konsistent alle Pool-Coins (analog zum 10-Min-Cron in
    // core/wallet-monitor/monitor.js). Andernfalls überschreibt jede Bot-Aktion den
    // vollständigen Cron-Snapshot mit einem reduzierten.
    const splTokens = [];
    for (const tok of getWalletWhitelistTokens()) {
        const bal = balByMint.get(tok.mint) ?? 0;
        const priceUsd = getTokenUsdPrice(tok.mint, db);
        splTokens.push({
            symbol:   tok.symbol,
            mint:     tok.mint,
            balance:  bal,
            priceUsd,
            valueUsd: bal * priceUsd,
        });
    }

    writeWalletSnapshot({
        walletId,
        walletLabel,
        walletAddress: keypair.publicKey.toBase58(),
        solBalance,
        usdcBalance,
        solPriceUsd:   solPriceRow?.price ?? 0,
        tokens:        splTokens,
    });
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Führt `core/wallet-monitor/monitor.js --once` als Subprocess aus.
 * Der monitor.js liest frische On-Chain-Daten mit eigener RPC-Connection
 * und Jupiter-Preisen — proven reliable auch wenn /rpc/fresh noch stale war.
 */
function runWalletMonitorOnce() {
    return new Promise((res, rej) => {
        const child = spawn('node', [WALLET_MONITOR_JS, '--once'], {
            env:   process.env,
            stdio: 'pipe',  // stdout/stderr nicht auf Cleanup-Console ausgeben
        });
        child.on('close', code => code === 0 ? res() : rej(new Error(`wallet-monitor exit ${code}`)));
        child.on('error', rej);
        setTimeout(() => { child.kill(); rej(new Error('wallet-monitor timeout')); }, 30_000);
    });
}

/**
 * Vollständiges Dashboard-Refresh nach einer Bot-Aktion.
 *
 * Reihenfolge ist wichtig: Position-Snapshot zuerst (vom Caller), dann
 * Portfolio-Aggregat (liest die neuen Pos-Snapshots), dann Wallet, dann Sync.
 *
 * Der Position-Snapshot muss vom Caller VOR diesem Aufruf geschrieben werden
 * (mit `writePositionSnapshotFromState` oder `writePositionSnapshotFromDelta`),
 * weil nur der Caller den passenden Kontext (state vs. delta) kennt.
 *
 * Zwei-Phasen-Refresh:
 *   Phase 1 (T+settleMs):  writeFreshWalletSnapshot via /rpc/fresh → sofortiger
 *                           Snapshot, ggf. noch leicht stale bei neuen Token-Accounts.
 *                           syncDashboard → Dashboard zeigt sofort annähernde Werte.
 *   Phase 2 (T+settleMs+10s): wallet-monitor --once Subprocess → zuverlässiger
 *                           zweiter Read mit frischer Connection + Jupiter-Preisen.
 *                           syncDashboard → Dashboard jetzt korrekt.
 *
 * Hintergrund: Helius-RPC braucht für getParsedTokenAccountsByOwner nach
 * Multi-Step-Operationen (withdraw + swaps + deposit) manchmal 15–30 Sekunden bis
 * der aktuelle Stand propagiert ist. Mit Zwei-Phasen-Refresh ist das Dashboard
 * spätestens nach ~16 Sekunden korrekt statt nach dem 10-Min-Cron.
 *
 * @param {Object} db
 * @param {Object} opts
 * @param {Function} [opts.log]      – Logger für syncDashboard-Status
 * @param {number}  [opts.settleMs]  – Phase-1-Wartezeit in ms (default: 6000)
 */
export async function refreshAfterAction(db, opts = {}) {
    const settleMs = opts.settleMs ?? 6000;

    // ─── Phase 1: sofortiger Snapshot (ggf. leicht stale) ────────────────────
    if (settleMs > 0) await new Promise(r => setTimeout(r, settleMs));
    await writePortfolioSnapshot(db);
    await syncDashboard(opts.log);

    // ─── Phase 2: zuverlässiger Wallet-Snapshot via externem monitor.js ───────
    // Weitere 10s warten damit Helius Token-Account-Balances sicher propagiert hat.
    await new Promise(r => setTimeout(r, 10_000));
    try {
        await runWalletMonitorOnce();
        // Nach frischem Wallet-Snapshot: Portfolio-Aggregat neu berechnen + nochmal syncen.
        await writePortfolioSnapshot(db);
        await syncDashboard(opts.log);
    } catch (e) {
        console.warn(`[refresh-state] Phase-2 wallet-monitor fehlgeschlagen: ${e.message}`);
    }
}
