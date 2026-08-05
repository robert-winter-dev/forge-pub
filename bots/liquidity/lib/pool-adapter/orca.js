/**
 * FORGE Liquidity – Orca Whirlpools Adapter
 *
 * Implementiert das Pool-Adapter-Interface für Orca Whirlpools (CLMM).
 *
 * Lese-Operationen (Phase 2):
 *   - getPoolStats()      → Pool-Statistiken via Orca API + On-Chain-Preis
 *   - getPositionState()  → On-Chain-Positionsstatus via SDK
 *
 * Schreib-Operationen (Phase 3):
 *   - openPosition()      → CLMM-Position öffnen + NFT-Mint zurückgeben
 *   - closePosition()     → Position schließen, Liquidität + Fees zurückhalten
 *   - collectFees()       → Fees claimen ohne Position zu schließen
 *   - increaseLiquidity() → Bestehende Position aufstocken (für Reinvest)
 *
 * Wichtig:
 *   - Alle API-Calls über orcaLimiter / rpcLimiter (Rate-Limit-Regel)
 *   - BN-Werte (feeOwed, liquidity) werden als String gespeichert (u128 > MAX_SAFE_INTEGER)
 *   - Position-NFT darf nie extern transferiert werden
 *   - Slippage: 1% Default — bei Out-of-Range-Preisen erhöht sich der tatsächliche Slippage
 */

import {
    WhirlpoolContext,
    buildWhirlpoolClient,
    ORCA_WHIRLPOOL_PROGRAM_ID,
    PDAUtil,
    PriceMath,
    PoolUtil,
    WhirlpoolIx,
    increaseLiquidityQuoteByInputToken,
    decreaseLiquidityQuoteByLiquidityWithParams,
    swapQuoteByInputToken,
    collectFeesQuote,
    TickArrayUtil,
    NO_TOKEN_EXTENSION_CONTEXT,
    MIN_SQRT_PRICE,
    MAX_SQRT_PRICE,
    IGNORE_CACHE,
    TokenType,
} from '@orca-so/whirlpools-sdk';
import { Percentage, TransactionBuilder } from '@orca-so/common-sdk';
import { getAssociatedTokenAddressSync }  from '@solana/spl-token';
import { Wallet }            from '@coral-xyz/anchor';
import { PublicKey }         from '@solana/web3.js';
import Decimal               from 'decimal.js';
import BN                    from 'bn.js';
import { getConnection, getKeypair, assertSufficientSol, assertSufficientSolForExit, getTxFee, getSolBalance, getSolBalanceFresh, getTokenBalance, getTokenBalanceFresh } from '../wallet.js';
import { rpcLimiter, geckoLimiter } from '../rate-limiter.js';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const ORCA_V2_PROXY  = 'http://127.0.0.1:3100/orcav2';
const GECKO_PROXY    = 'http://127.0.0.1:3100/gecko';

/** Standard-Slippage für alle Transaktionen: 1% */
const DEFAULT_SLIPPAGE = Percentage.fromFraction(1, 100);

// ─── Context-Builder ─────────────────────────────────────────────────────────

/**
 * Priority Fee für alle Orca-Transaktionen (collectFees, increaseLiquidity,
 * openPosition, closePosition, decreaseLiquidity).
 * Verhindert "block height exceeded" bei Solana-Netzwerk-Congestion.
 * getTxFee() liest tx.meta.fee (Base + Priority) — wird automatisch korrekt
 * in der Gebühren-Erfassung und im Dashboard ausgewiesen.
 */
const ORCA_PRIORITY_FEE_LAMPORTS = 10_000; // 0.00001 SOL ≈ 0.002 USDC pro TX

/**
 * Baut den WhirlpoolContext mit dem echten Keypair (gecacht pro Adapter-Instanz).
 * Wird für Lese- UND Schreib-Operationen verwendet.
 */
function buildContext(connection, keypair) {
    const wallet = new Wallet(keypair);
    return WhirlpoolContext.from(connection, wallet, undefined, undefined, {
        userDefaultBuildOptions: {
            computeBudgetOption: { type: 'fixed', priorityFeeLamports: ORCA_PRIORITY_FEE_LAMPORTS },
        },
    });
}

// ─── Hilfsfunktionen ─────────────────────────────────────────────────────────

/**
 * Solanas Confirm-Polling kann bei Netzwerk-Congestion aufgeben ("... has expired: block
 * height exceeded" / "Blockhash not found"), OBWOHL die TX tatsächlich on-chain landet — der
 * Client-Timeout ist kein On-Chain-Fakt. Ohne diese Prüfung wird eine real geöffnete/veränderte
 * Position als "fehlgeschlagen" verworfen und bleibt dauerhaft untracked (echtes Kapital ohne
 * DB-Eintrag). Signatur steckt entweder in err.signature oder im Fehlertext ("Signature <sig> ...").
 *
 * @returns {Promise<string|null>} Signatur, falls die TX bestätigt on-chain gelandet ist, sonst null.
 */
async function resolveExpiredTxSignature(err, connection) {
    const msg = typeof err?.message === 'string' ? err.message : '';
    const isExpiryError =
        err?.name === 'TransactionExpiredBlockheightExceededError' ||
        msg.includes('Blockhash not found') ||
        msg.includes('BlockheightExceeded') ||
        /has expired: block height exceeded/i.test(msg);
    if (!isExpiryError) return null;

    const signature = err?.signature ?? msg.match(/Signature ([1-9A-HJ-NP-Za-km-z]{64,88})/)?.[1];
    if (!signature) return null;

    await rpcLimiter.wait();
    const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const status = value?.[0];
    return (status && status.err === null && status.confirmationStatus) ? signature : null;
}

/**
 * Führt einen Orca-TransactionBuilder aus und fängt den Confirm-Timeout-Fall aus
 * resolveExpiredTxSignature() ab — landet die TX trotz Timeout nachweislich on-chain, wird sie
 * als Erfolg gewertet (Signatur zurückgegeben) statt einen echten Fehlschlag vorzutäuschen.
 */
async function execTx(txBuilder, connection, label) {
    try {
        return await txBuilder.buildAndExecute();
    } catch (err) {
        const landedSig = await resolveExpiredTxSignature(err, connection);
        if (!landedSig) throw err;
        console.warn(
            `[orca] ${label}: Confirm-Timeout, TX ist aber on-chain gelandet ` +
            `(${landedSig}) – werte als Erfolg statt als Fehlschlag.`
        );
        return landedSig;
    }
}

/**
 * Menschlich lesbare Token-Menge → BN in kleinster Einheit (Lamports/USDC-atoms).
 * @param {number} amount    z.B. 1.5 (SOL)
 * @param {number} decimals  z.B. 9 (SOL), 6 (USDC)
 * @returns {BN}
 */
function toRawAmount(amount, decimals) {
    return new BN(
        new Decimal(amount).mul(new Decimal(10).pow(decimals)).toFixed(0)
    );
}

/**
 * BN in kleinster Einheit → menschlich lesbare Zahl.
 * @param {BN}     bn
 * @param {number} decimals
 * @returns {number}
 */
function fromRawAmount(bn, decimals) {
    return new Decimal(bn.toString()).div(Math.pow(10, decimals)).toNumber();
}

// ─── OrcaAdapter ─────────────────────────────────────────────────────────────

export class OrcaAdapter {
    constructor() {
        this._ctx    = null;
        this._client = null;
    }

    /** Lazy-initialisiert Context und Client. */
    _getClient() {
        if (!this._client) {
            const connection = getConnection();
            const keypair    = getKeypair();
            this._ctx        = buildContext(connection, keypair);
            this._client     = buildWhirlpoolClient(this._ctx);
        }
        return this._client;
    }

    // ─── swapExactIn ──────────────────────────────────────────────────────────

    /**
     * Direkter Exact-In-Swap über genau diesen Orca-Whirlpool (umgeht Jupiter).
     *
     * Hintergrund: Token, die praktisch nur in ihrem eigenen Orca-Pool Liquidität
     * haben (z.B. xStocks SPYx/TSLAx/SPCX), lassen sich nicht zuverlässig über
     * Jupiter swappen — Jupiters Transaktions-Builder setzt für solche Whirlpools
     * gelegentlich die Token-Mint-Reihenfolge falsch zusammen; die Swap-Simulation
     * scheitert dann mit Orca-Error 6024 (InvalidTokenMintOrder / 0x1788). Der
     * excludeDexes=Whirlpool-Workaround in lib/swap.js greift hier nicht, weil es
     * keine alternative Route gibt. Das Orca-SDK baut die swapV2-Instruction
     * kanonisch korrekt (richtige Mint-Order, Token-2022-Extensions via
     * swapQuoteByInputToken, Tick-Arrays, Oracle).
     *
     * @param {Object} p
     * @param {string} p.poolAddress    Whirlpool-Adresse
     * @param {string} p.inputMint      Mint des Eingabe-Tokens (muss Pool-Token sein)
     * @param {number} p.inputDecimals
     * @param {string} p.outputMint     Mint des Ausgabe-Tokens (muss Pool-Token sein)
     * @param {number} p.outputDecimals
     * @param {number} p.amount         Eingabemenge (human-readable, z.B. 0.077)
     * @param {number} p.slippageBps    Slippage-Toleranz in Basispunkten (z.B. 150 = 1,5 %)
     * @returns {Promise<{ amountOut:number, txSignature:string }>}
     */
    async swapExactIn({ poolAddress, inputMint, inputDecimals, outputMint, outputDecimals, amount, slippageBps }) {
        const client = this._getClient();

        await rpcLimiter.wait();
        const whirlpool = await client.getPool(new PublicKey(poolAddress), IGNORE_CACHE);
        const data      = whirlpool.getData();

        // Sicherheits-Guard: input/output müssen exakt die beiden Pool-Token sein.
        const poolMints = [data.tokenMintA.toBase58(), data.tokenMintB.toBase58()];
        if (inputMint === outputMint || !poolMints.includes(inputMint) || !poolMints.includes(outputMint)) {
            throw new Error(
                `swapExactIn: Pool ${poolAddress} (${poolMints.join('/')}) passt nicht zu ${inputMint}→${outputMint}`
            );
        }

        await rpcLimiter.wait();
        const quote = await swapQuoteByInputToken(
            whirlpool,
            new PublicKey(inputMint),
            toRawAmount(amount, inputDecimals),
            Percentage.fromFraction(slippageBps, 10_000),
            ORCA_WHIRLPOOL_PROGRAM_ID,
            this._ctx.fetcher,
            IGNORE_CACHE,
        );

        await rpcLimiter.wait();
        const txBuilder   = await whirlpool.swap(quote);
        const txSignature = await execTx(txBuilder, this._ctx.connection, 'swapExactIn');

        return {
            amountOut:   fromRawAmount(quote.estimatedAmountOut, outputDecimals),
            txSignature,
        };
    }

    // ─── getPoolStats ─────────────────────────────────────────────────────────

    /**
     * Ruft aktuelle Pool-Statistiken ab.
     * Preis: On-Chain (immer aktuell).
     * TVL / Volume / APR / Liquidität / Fees: Orca v2 REST-API via Nexus-Proxy (5-min-Cache).
     *
     * @param {Object} pool   Pool-Konfiguration aus pools.json
     * @returns {Promise<{
     *   price: number,
     *   tvlUsd: number|null,
     *   volume24hUsd: number|null,
     *   apr24h: number|null,
     *   liquidityInRange: string|null,  -- in-range Liquidität (Whirlpool-Einheit, als String)
     *   fees24hUsd: number|null,        -- tatsächliche Pool-Fees letzte 24h in USDC
     *   volumeCandles: Array
     * }>}
     */
    async getPoolStats(pool) {
        const [onChain, orcaStats, volumeCandles] = await Promise.all([
            this._getPriceOnChain(pool),
            this._getOrcaV2Stats(pool.address),
            this._getVolumeCandles(pool.address),
        ]);

        return {
            price:            onChain.price,
            tvlUsd:           orcaStats?.tvlUsd            ?? null,
            volume24hUsd:     orcaStats?.volume24h         ?? null,
            apr24h:           orcaStats?.apr24h            ?? null,
            liquidityInRange: orcaStats?.liquidityInRange  ?? null,
            fees24hUsd:       orcaStats?.fees24hUsd        ?? null,
            volumeCandles,
        };
    }

    /**
     * Holt die letzten 24 stündlichen Volume-Candles von GeckoTerminal (für volume_hourly).
     *
     * limit=24 statt 2 (2026-07-03): insertVolumeCandles() upserted per (pool_id, ts) —
     * ein einzelner fehlgeschlagener Zyklus (Timeout/429/Netzwerk) heilt sich dadurch beim
     * nächsten erfolgreichen Zyklus (~5 Min später) automatisch, solange dieser innerhalb von
     * 24h liegt. Mit limit=2 war eine verpasste Stunde dagegen für immer verloren, sobald sie
     * aus dem 2h-Fenster raus war — Ursache eines fälschlichen Volumen-Malus bei cbBTC/SOL
     * (4 Lücken trotz durchgehendem Handel, reine Fetch-Fehler ohne jedes Logging).
     */
    async _getVolumeCandles(poolAddress) {
        try {
            await geckoLimiter.wait();
            const url = `${GECKO_PROXY}/networks/solana/pools/${poolAddress}/ohlcv/hour?limit=24&token=base`;
            // Timeout 90s statt 15s: der Nexus-Throttler kann bei mehreren gleichzeitigen
            // Cache-Misses bis zu 35s Wartezeit aufbauen – 15s reichte dann nicht aus.
            const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
            if (!res.ok) {
                console.warn(`[orca] _getVolumeCandles ${res.status} für ${poolAddress.slice(0, 8)}...`);
                return [];
            }
            const json = await res.json();
            const raw  = json?.data?.attributes?.ohlcv_list ?? [];
            // GeckoTerminal-Format: [timestamp_sec, open, high, low, close, volume_usd]
            return raw.map(c => ({ ts: c[0] * 1000, volume: c[5] }));
        } catch (err) {
            console.warn(`[orca] _getVolumeCandles fehlgeschlagen für ${poolAddress.slice(0, 8)}...: ${err.message}`);
            return [];
        }
    }

    /**
     * Holt TVL, 24h-Volumen und APR von der Orca v2 REST-API.
     * Ersetzt GeckoTerminal (war primäre 429-Quelle).
     *
     * APR aus yieldOverTvl (24h) × 365 × 100 — identisches Ergebnis zur alten
     * Gecko-Formel (vol × feeTier × 365 / tvl), aber direkt von Orca geliefert.
     */
    async _getOrcaV2Stats(poolAddress) {
        try {
            const url = `${ORCA_V2_PROXY}/solana/pools/${poolAddress}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
            if (!res.ok) {
                console.warn(`[orcav2] Pool-Stats ${res.status} für ${poolAddress.slice(0, 8)}...`);
                return null;
            }
            const json = await res.json();
            const data = json?.data;
            if (!data) return null;

            const tvlUsd          = parseFloat(data.tvlUsdc) || null;
            const volume24h       = parseFloat(data.stats?.['24h']?.volume) || null;
            const apr24h          = data.stats?.['24h']?.yieldOverTvl != null
                ? parseFloat(data.stats['24h'].yieldOverTvl) * 365 * 100
                : null;
            // in-range Liquidität (Whirlpool-interne Einheit, als String für Präzision)
            const liquidityInRange = data.liquidity != null ? String(data.liquidity) : null;
            // tatsächliche Pool-Fees letzte 24h in USDC
            const fees24hUsd      = parseFloat(data.stats?.['24h']?.fees) || null;

            return { tvlUsd, volume24h, apr24h, liquidityInRange, fees24hUsd };
        } catch (err) {
            console.warn(`[orcav2] Nicht erreichbar: ${err.message}`);
            return null;
        }
    }

    /** Liest den aktuellen Preis direkt von der Chain (sqrtPrice → Preis). */
    async _getPriceOnChain(pool) {
        await rpcLimiter.wait();
        const whirlpool = await this._getClient().getPool(new PublicKey(pool.address), IGNORE_CACHE);
        const data      = whirlpool.getData();

        const price = PriceMath.sqrtPriceX64ToPrice(
            data.sqrtPrice,
            pool.decimalsA,
            pool.decimalsB,
        ).toNumber();

        return { price, tickCurrentIndex: data.tickCurrentIndex };
    }

    // ─── getPositionState ─────────────────────────────────────────────────────

    /**
     * Liest den aktuellen On-Chain-Zustand einer offenen Position.
     *
     * @param {Object} pool            Pool-Konfiguration
     * @param {string} positionNftMint Mint-Adresse des Position-NFTs
     * @returns {Promise<{
     *   inRange:      boolean,
     *   currentPrice: number,
     *   tickLower:    number,
     *   tickUpper:    number,
     *   priceLower:   number,
     *   priceUpper:   number,
     *   liquidity:    string,
     *   feesOwedA:    number,
     *   feesOwedB:    number,
     * }>}
     */
    // positionHint: { tickLowerIndex, tickUpperIndex } – wenn gesetzt, wird der rpcLimiter.wait()
    // vor dem Tick-Array-Fetch übersprungen, um das Slot-Split-Fenster zu minimieren.
    async getPositionState(pool, positionNftMint, positionHint = null) {
        const client     = this._getClient();
        const mintPubkey = new PublicKey(positionNftMint);
        const posPda     = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mintPubkey);
        const poolPubkey = new PublicKey(pool.address);

        // Batch 1: Pool + Position (immer nötig – tickSpacing muss on-chain verifiziert werden)
        await rpcLimiter.wait();
        const [whirlpool, position] = await Promise.all([
            client.getPool(poolPubkey, IGNORE_CACHE),
            client.getPosition(posPda.publicKey, IGNORE_CACHE),
        ]);
        const poolData = whirlpool.getData();
        const posData  = position.getData();

        const tickArrayLowerPda = PDAUtil.getTickArrayFromTickIndex(
            posData.tickLowerIndex, poolData.tickSpacing, poolPubkey, ORCA_WHIRLPOOL_PROGRAM_ID
        );
        const tickArrayUpperPda = PDAUtil.getTickArrayFromTickIndex(
            posData.tickUpperIndex, poolData.tickSpacing, poolPubkey, ORCA_WHIRLPOOL_PROGRAM_ID
        );

        // Batch 2: Tick-Arrays. Mit Hint (normaler Bot-Betrieb): kein rpcLimiter.wait() dazwischen
        // → Fetch startet sofort nach Batch 1, minimiert den Slot-Split-Zeitraum erheblich.
        if (!positionHint) await rpcLimiter.wait();
        const [tickArrayLowerData, tickArrayUpperData] = await Promise.all([
            this._ctx.fetcher.getTickArray(tickArrayLowerPda.publicKey, IGNORE_CACHE),
            this._ctx.fetcher.getTickArray(tickArrayUpperPda.publicKey, IGNORE_CACHE),
        ]);

        const inRange = poolData.tickCurrentIndex >= posData.tickLowerIndex &&
                        poolData.tickCurrentIndex <  posData.tickUpperIndex;

        const priceLower = PriceMath.tickIndexToPrice(
            posData.tickLowerIndex, pool.decimalsA, pool.decimalsB
        ).toNumber();
        const priceUpper = PriceMath.tickIndexToPrice(
            posData.tickUpperIndex, pool.decimalsA, pool.decimalsB
        ).toNumber();

        const tickLowerData = TickArrayUtil.getTickFromArray(
            tickArrayLowerData, posData.tickLowerIndex, poolData.tickSpacing
        );
        const tickUpperData = TickArrayUtil.getTickFromArray(
            tickArrayUpperData, posData.tickUpperIndex, poolData.tickSpacing
        );

        const feesQuote = collectFeesQuote({
            whirlpool:       poolData,
            position:        posData,
            tickLower:       tickLowerData,
            tickUpper:       tickUpperData,
            tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
        });

        const feesOwedA = fromRawAmount(feesQuote.feeOwedA, pool.decimalsA);
        const feesOwedB = fromRawAmount(feesQuote.feeOwedB, pool.decimalsB);

        const currentPrice = PriceMath.sqrtPriceX64ToPrice(
            poolData.sqrtPrice, pool.decimalsA, pool.decimalsB
        ).toNumber();

        return {
            inRange,
            currentPrice,
            tickLower:  posData.tickLowerIndex,
            tickUpper:  posData.tickUpperIndex,
            priceLower,
            priceUpper,
            liquidity:  posData.liquidity.toString(),
            feesOwedA,
            feesOwedB,
        };
    }

    // ─── getPositionStatesBulk ────────────────────────────────────────────────

    /**
     * Liest den On-Chain-Zustand ALLER übergebenen Positionen in genau 3 RPC-Calls
     * (unabhängig von der Pool-Anzahl):
     *   Batch 1a: getMultipleAccounts([poolPubkeys]) → WhirlpoolData    (parallel)
     *   Batch 1b: getMultipleAccounts([posPdas])     → PositionData     (parallel)
     *   Batch 2:  getMultipleAccounts([tickPdas])    → TickArrayData[]
     *
     * @param {Array<{pool: Object, nftMint: string}>} items
     * @returns {Promise<Map<string, Object>>} poolId → state (fehlende Pools fehlen in der Map)
     */
    async getPositionStatesBulk(items) {
        if (items.length === 0) return new Map();
        this._getClient();  // ctx sicherstellen
        const ctx = this._ctx;

        const poolPubkeys = items.map(it => new PublicKey(it.pool.address));
        const posPdas     = items.map(it =>
            PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, new PublicKey(it.nftMint)).publicKey
        );

        // Batch 1: Pool-State + Position-Daten parallel (je 1 getMultipleAccounts = 2 Credits)
        await rpcLimiter.wait();
        const [poolsMap, positionsMap] = await Promise.all([
            ctx.fetcher.getPools(poolPubkeys, IGNORE_CACHE),
            ctx.fetcher.getPositions(posPdas, IGNORE_CACHE),
        ]);

        // Tick-Array-PDAs aus den geladenen Daten ableiten
        // tickPdas[i*2] = lowerPda, tickPdas[i*2+1] = upperPda (null bei Fehler)
        const tickPdas = [];
        for (let i = 0; i < items.length; i++) {
            const poolData = poolsMap.get(poolPubkeys[i].toBase58());
            const posData  = positionsMap.get(posPdas[i].toBase58());
            if (!poolData || !posData) {
                tickPdas.push(null, null);
                continue;
            }
            tickPdas.push(
                PDAUtil.getTickArrayFromTickIndex(
                    posData.tickLowerIndex, poolData.tickSpacing,
                    poolPubkeys[i], ORCA_WHIRLPOOL_PROGRAM_ID
                ).publicKey,
                PDAUtil.getTickArrayFromTickIndex(
                    posData.tickUpperIndex, poolData.tickSpacing,
                    poolPubkeys[i], ORCA_WHIRLPOOL_PROGRAM_ID
                ).publicKey,
            );
        }

        // Batch 2: alle Tick-Arrays (1 getMultipleAccounts = 1 Credit)
        const validPdas  = tickPdas.filter(Boolean);
        const tickArrays = validPdas.length > 0
            ? await ctx.fetcher.getTickArrays(validPdas, IGNORE_CACHE)
            : [];

        // Array zurück in Map überführen (PDA-String → TickArrayData)
        const taMap = new Map();
        validPdas.forEach((pda, i) => taMap.set(pda.toBase58(), tickArrays[i]));

        // States berechnen
        const results = new Map();
        for (let i = 0; i < items.length; i++) {
            const { pool } = items[i];
            const poolData = poolsMap.get(poolPubkeys[i].toBase58());
            const posData  = positionsMap.get(posPdas[i].toBase58());
            const lowerPda = tickPdas[i * 2];
            const upperPda = tickPdas[i * 2 + 1];
            const taLower  = lowerPda ? taMap.get(lowerPda.toBase58()) : null;
            const taUpper  = upperPda ? taMap.get(upperPda.toBase58()) : null;

            if (!poolData || !posData || !taLower || !taUpper) {
                console.warn(`[orca:bulk] Daten unvollständig für ${pool.id} – Fallback auf Einzelabruf`);
                continue;
            }

            const tickLowerData = TickArrayUtil.getTickFromArray(
                taLower, posData.tickLowerIndex, poolData.tickSpacing
            );
            const tickUpperData = TickArrayUtil.getTickFromArray(
                taUpper, posData.tickUpperIndex, poolData.tickSpacing
            );

            const feesQuote = collectFeesQuote({
                whirlpool:         poolData,
                position:          posData,
                tickLower:         tickLowerData,
                tickUpper:         tickUpperData,
                tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
            });

            results.set(pool.id, {
                inRange:      poolData.tickCurrentIndex >= posData.tickLowerIndex &&
                              poolData.tickCurrentIndex <  posData.tickUpperIndex,
                currentPrice: PriceMath.sqrtPriceX64ToPrice(
                    poolData.sqrtPrice, pool.decimalsA, pool.decimalsB
                ).toNumber(),
                priceLower:   PriceMath.tickIndexToPrice(
                    posData.tickLowerIndex, pool.decimalsA, pool.decimalsB
                ).toNumber(),
                priceUpper:   PriceMath.tickIndexToPrice(
                    posData.tickUpperIndex, pool.decimalsA, pool.decimalsB
                ).toNumber(),
                tickLower:    posData.tickLowerIndex,
                tickUpper:    posData.tickUpperIndex,
                liquidity:    posData.liquidity.toString(),
                feesOwedA:    fromRawAmount(feesQuote.feeOwedA, pool.decimalsA),
                feesOwedB:    fromRawAmount(feesQuote.feeOwedB, pool.decimalsB),
            });
        }

        return results;
    }

    // ─── openPosition ─────────────────────────────────────────────────────────

    /**
     * Öffnet eine neue CLMM-Position im angegebenen Tick-Bereich.
     *
     * amountA / amountB sind Maximalbetrage — Orca legt den exakten Mix
     * basierend auf der aktuellen Pool-Preisposition innerhalb der Range fest.
     * Überschuss wird nicht verwendet (bleibt im Wallet).
     *
     * @param {Object} pool
     * @param {number} tickLower    Unterer Tick-Index (muss Vielfaches von tickSpacing sein)
     * @param {number} tickUpper    Oberer Tick-Index
     * @param {number} amountA      Max. Betrag Token A (z.B. SOL, human-readable)
     * @param {number} amountB      Max. Betrag Token B (z.B. USDC, human-readable)
     * @returns {Promise<{nftMint: string, liquidity: string, txHash: string}>}
     */
    async openPosition(pool, tickLower, tickUpper, amountA, amountB, slippage = DEFAULT_SLIPPAGE) {
        await assertSufficientSol(getKeypair().publicKey);

        const client = this._getClient();

        await rpcLimiter.wait();
        const whirlpool = await client.getPool(new PublicKey(pool.address));

        // TickArrays für die Ziel-Range müssen existieren, bevor increaseLiquidity darauf
        // zugreifen kann — sonst schlägt die On-Chain-Simulation mit 0xbbf
        // (AccountOwnedByWrongProgram, Account ist noch System-Program-owned) fehl.
        // Bei etablierten, viel gehandelten Pools sind die Arrays für gängige Ranges längst
        // initialisiert; bei Pools mit frischem Preissprung (z.B. MPLX/USDC, 2026-07-03) kann
        // die Ziel-Range aber noch nie berührt worden sein.
        await rpcLimiter.wait();
        const initTickArrayTxBuilder = await whirlpool.initTickArrayForTicks(
            [tickLower, tickUpper], getKeypair().publicKey,
        );
        if (initTickArrayTxBuilder) {
            console.log(`[orca:${pool.pair}] Initialisiere fehlende TickArrays für Range ${tickLower}–${tickUpper}...`);
            await rpcLimiter.wait();
            await execTx(initTickArrayTxBuilder, this._ctx.connection, `${pool.pair} initTickArray`);
        }

        // Dynamischer Anker: beide Quotes berechnen, den bindenden (niedrigere Liquidity) nehmen.
        //
        // Hintergrund: CLMM-Positionen bestehen aus einem Mix beider Token. Wenn der Wallet-Bestand
        // eines Tokens unter dem 50/50-Soll liegt (z.B. nach Out-of-Range-Close), würde ein fester
        // Anker auf tokenB (USDC) eine cbBTC-Menge anfordern, die die Wallet nicht hat → 0x1 (InsufficientFunds).
        //
        // Lösung: Quote von beiden Ankern berechnen, den mit weniger Liquidity verwenden.
        // Das ist der bindende Engpass — der andere Token wird entsprechend reduziert.
        //
        // Edge-Case: falls ein Quote 0 Liquidity liefert (Preis vollständig außerhalb der Range
        // für diesen Token), wird der andere (nicht-null) Quote bevorzugt.
        //
        // Hinweis: minSqrtPrice/maxSqrtPrice werden manuell via getSlippageBoundForSqrtPrice gesetzt,
        // da increaseLiquidityQuoteByInputToken diese nicht zurückgibt — ohne sie schlägt der
        // On-Chain-Check mit PriceSlippageOutOfBounds (0x17b5) fehl.
        const poolData = whirlpool.getData();

        const quoteB = increaseLiquidityQuoteByInputToken(
            new PublicKey(pool.tokenB),
            new Decimal(amountB),
            tickLower, tickUpper, slippage, whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
        );
        const quoteA = increaseLiquidityQuoteByInputToken(
            new PublicKey(pool.tokenA),
            new Decimal(amountA),
            tickLower, tickUpper, slippage, whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
        );

        // Bindenden Anker wählen: der mit weniger Liquidity bestimmt den tatsächlichen Einsatz.
        // Falls ein Quote 0 Liquidity hat (Edge-Case), den anderen verwenden.
        const aIsBinding = quoteA.liquidityAmount.gtn(0) && (
            quoteB.liquidityAmount.eqn(0) ||
            quoteA.liquidityAmount.lte(quoteB.liquidityAmount)
        );
        const quote = aIsBinding ? quoteA : quoteB;

        const [symA, symB] = pool.pair.split('/');
        console.log(
            `[orca:${pool.pair}] openPosition Anker: token${aIsBinding ? 'A' : 'B'}` +
            ` (${aIsBinding ? amountA.toFixed(8) + ' ' + symA : amountB.toFixed(2) + ' ' + symB})` +
            ` liquidity=${quote.liquidityAmount.toString()}`
        );

        // Slippage-Bounds für den aktuellen Pool-Preis berechnen
        let minSqrtPrice, maxSqrtPrice;
        try {
            const bounds = PriceMath.getSlippageBoundForSqrtPrice(poolData.sqrtPrice, slippage);
            minSqrtPrice = bounds.lowerBound[0];
            maxSqrtPrice = bounds.upperBound[0];
        } catch {
            // Fallback: globale Grenzen (kein Preisslippage-Check)
            minSqrtPrice = new BN(MIN_SQRT_PRICE);
            maxSqrtPrice = new BN(MAX_SQRT_PRICE);
        }

        const liquidityInput = { ...quote, minSqrtPrice, maxSqrtPrice };

        const { positionMint, tx } = await whirlpool.openPosition(
            tickLower,
            tickUpper,
            liquidityInput,
        );

        await rpcLimiter.wait();
        const txHash = await execTx(tx, this._ctx.connection, `${pool.pair} openPosition`);

        // Position-Daten nach dem Öffnen auslesen (IGNORE_CACHE: Account ist neu, nicht im Cache).
        // Retry mit exponentiellem Backoff: RPC-Propagation kann nach TX-Bestätigung kurz verzögert sein.
        const posPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMint);
        let position;
        for (let attempt = 1; attempt <= 5; attempt++) {
            await rpcLimiter.wait();
            try {
                position = await client.getPosition(posPda.publicKey, IGNORE_CACHE);
                break;
            } catch (err) {
                if (attempt === 5) throw err;
                const delayMs = attempt * 2000;
                console.log(`[orca] Position-Readback Versuch ${attempt}/5 fehlgeschlagen – warte ${delayMs}ms (${err.message})`);
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
        const liquidity = position.getData().liquidity.toString();

        console.log(`[orca] Position geöffnet: NFT=${positionMint.toBase58()} TX=${txHash}`);

        return {
            nftMint:   positionMint.toBase58(),
            liquidity,
            txHash,
        };
    }

    // ─── closePosition ────────────────────────────────────────────────────────

    /**
     * Schließt eine Position vollständig: Fees claimen + Liquidität entfernen + NFT verbrennen.
     * Gibt alle Tokens + aufgelaufene Fees ans Wallet zurück.
     *
     * client.closePosition() gibt ein Array von TransactionBuildern zurück,
     * da mehrere TXs nötig sein können (TickArrays initialisieren, etc.).
     *
     * @param {Object} pool
     * @param {string} positionNftMint
     * @returns {Promise<{amountA: number, amountB: number, feesA: number, feesB: number, txHash: string}>}
     */
    async closePosition(pool, positionNftMint) {
        // Kapitalfreigabe → nur physikalischer Boden, nicht die SOL-Reserve.
        // Siehe assertSufficientSolForExit() in ../wallet.js.
        await assertSufficientSolForExit(getKeypair().publicKey);

        const client     = this._getClient();
        const mintPubkey = new PublicKey(positionNftMint);
        const posPda     = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mintPubkey);

        // Position + Pool laden
        await rpcLimiter.wait();
        const [whirlpool, position] = await Promise.all([
            this._getClient().getPool(new PublicKey(pool.address), IGNORE_CACHE),
            client.getPosition(posPda.publicKey, IGNORE_CACHE),
        ]);

        const poolData = whirlpool.getData();
        const posData  = position.getData();

        // Quote für vollständige Liquiditätsentnahme
        const quote = decreaseLiquidityQuoteByLiquidityWithParams({
            liquidity:        posData.liquidity,
            sqrtPrice:        poolData.sqrtPrice,
            tickCurrentIndex: poolData.tickCurrentIndex,
            tickLowerIndex:   posData.tickLowerIndex,
            tickUpperIndex:   posData.tickUpperIndex,
            slippageTolerance: DEFAULT_SLIPPAGE,
            tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
        });

        // Liquidität vollständig entfernen (Fees müssen VOR dem Close geclaimed sein)
        // Guard: on-chain liquidity kann bereits 0 sein (z.B. nach Dust-Entnahme im vorherigen
        // Rebalancing-Versuch) — decreaseLiquidity(0) wirft 0x177c (LiquidityZero).
        // Defensiver Catch: Bei Netzwerk-Congestion kann der RPC-Snapshot veraltet sein
        // (IGNORE_CACHE ignoriert nur den SDK-Cache, nicht stale Validator-Slots). Drei
        // Richtungen des Stale-Read werden unten abgefangen.
        let decreaseTxHash = null;
        if (!posData.liquidity.isZero()) {
            await rpcLimiter.wait();
            try {
                const decreaseTx = await position.decreaseLiquidity(quote);
                decreaseTxHash = await execTx(decreaseTx, this._ctx.connection, `decreaseLiquidity NFT=${positionNftMint}`);
                console.log(`[orca] Liquidität entfernt: NFT=${positionNftMint} TX=${decreaseTxHash}`);
            } catch (err) {
                // Stale read (Fall 1): posData zeigte Liquidität, on-chain ist sie bereits 0
                if (/0x177c|LiquidityZero/i.test(err.message)) {
                    console.log(`[orca] decreaseLiquidity 0x177c (stale read, on-chain bereits 0) – überspringe: NFT=${positionNftMint}`);
                } else if (/0x177f|LiquidityUnderflow/i.test(err.message)) {
                    // Stale read (Fall 3): posData zeigte mehr Liquidität als on-chain tatsächlich
                    // vorhanden ist (z.B. zwischenzeitliche Teil-Entnahme) — Quote wollte mehr
                    // entfernen als die Position noch hält → Underflow. Frische Daten holen und
                    // mit der tatsächlichen Liquidität erneut versuchen.
                    console.log(`[orca] decreaseLiquidity 0x177f (stale read, weniger Liquidität on-chain) – hole frische Daten: NFT=${positionNftMint}`);
                    await rpcLimiter.wait();
                    const freshPos  = await client.getPosition(posPda.publicKey, IGNORE_CACHE);
                    const freshData = freshPos.getData();
                    if (!freshData.liquidity.isZero()) {
                        const freshQuote = decreaseLiquidityQuoteByLiquidityWithParams({
                            liquidity:         freshData.liquidity,
                            sqrtPrice:         poolData.sqrtPrice,
                            tickCurrentIndex:  poolData.tickCurrentIndex,
                            tickLowerIndex:    freshData.tickLowerIndex,
                            tickUpperIndex:    freshData.tickUpperIndex,
                            slippageTolerance: DEFAULT_SLIPPAGE,
                            tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
                        });
                        await rpcLimiter.wait();
                        const retryTx = await freshPos.decreaseLiquidity(freshQuote);
                        decreaseTxHash = await execTx(retryTx, this._ctx.connection, `retry decreaseLiquidity NFT=${positionNftMint}`);
                        console.log(`[orca] Retry decreaseLiquidity OK: NFT=${positionNftMint} TX=${decreaseTxHash}`);
                    } else {
                        console.log(`[orca] Frische Liquidität ist 0 – überspringe decreaseLiquidity: NFT=${positionNftMint}`);
                    }
                } else {
                    throw err;
                }
            }
        } else {
            console.log(`[orca] Liquidität bereits 0, überspringe decreaseLiquidity: NFT=${positionNftMint}`);
        }

        // Position-Account schließen und NFT verbrennen → gibt ~0.002 SOL Rent zurück
        const keypairClose         = getKeypair();
        const positionTokenAccount = getAssociatedTokenAddressSync(mintPubkey, keypairClose.publicKey);
        const burnIx = WhirlpoolIx.closePositionIx(this._ctx.program, {
            positionAuthority:    keypairClose.publicKey,
            receiver:             keypairClose.publicKey,
            position:             posPda.publicKey,
            positionMint:         mintPubkey,
            positionTokenAccount,
        });
        await rpcLimiter.wait();
        let burnTxHash;
        try {
            const burnTx = new TransactionBuilder(this._ctx.connection, this._ctx.wallet, this._ctx.txBuilderOpts)
                .addInstruction(burnIx);
            burnTxHash = await execTx(burnTx, this._ctx.connection, `closePositionIx NFT=${positionNftMint}`);
            console.log(`[orca] Position-NFT geburnt (Rent zurück): TX=${burnTxHash}`);
        } catch (err) {
            // Stale read (Fall 2): posData zeigte liquidity=0, on-chain hat sie noch Liquidität
            if (/0x1775|ClosePositionNotEmpty/i.test(err.message)) {
                console.log(`[orca] closePositionIx 0x1775 (stale read, on-chain noch Liquidität) – hole frische Daten: NFT=${positionNftMint}`);
                await rpcLimiter.wait();
                const freshPos  = await client.getPosition(posPda.publicKey, IGNORE_CACHE);
                const freshData = freshPos.getData();
                if (!freshData.liquidity.isZero()) {
                    const freshQuote = decreaseLiquidityQuoteByLiquidityWithParams({
                        liquidity:         freshData.liquidity,
                        sqrtPrice:         poolData.sqrtPrice,
                        tickCurrentIndex:  poolData.tickCurrentIndex,
                        tickLowerIndex:    freshData.tickLowerIndex,
                        tickUpperIndex:    freshData.tickUpperIndex,
                        slippageTolerance: DEFAULT_SLIPPAGE,
                        tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
                    });
                    await rpcLimiter.wait();
                    const retryTx = await freshPos.decreaseLiquidity(freshQuote);
                    decreaseTxHash = await execTx(retryTx, this._ctx.connection, `retry decreaseLiquidity NFT=${positionNftMint}`);
                    console.log(`[orca] Retry decreaseLiquidity OK: NFT=${positionNftMint} TX=${decreaseTxHash}`);
                }
                await rpcLimiter.wait();
                const retryBurnTx = new TransactionBuilder(this._ctx.connection, this._ctx.wallet, this._ctx.txBuilderOpts)
                    .addInstruction(burnIx);
                burnTxHash = await execTx(retryBurnTx, this._ctx.connection, `retry closePositionIx NFT=${positionNftMint}`);
                console.log(`[orca] Retry closePositionIx OK: TX=${burnTxHash}`);
            } else {
                throw err;
            }
        }

        return {
            amountA: fromRawAmount(quote.tokenMinA, pool.decimalsA),
            amountB: fromRawAmount(quote.tokenMinB, pool.decimalsB),
            txHash: decreaseTxHash ?? burnTxHash,
        };
    }

    // ─── collectFees ─────────────────────────────────────────────────────────

    /**
     * Claimt aufgelaufene Fees ohne die Position zu schließen.
     * Die geclaimten Tokens landen direkt im Wallet.
     *
     * @param {Object} pool
     * @param {string} positionNftMint
     * @param {Object} [opts]
     * @param {number} [opts.expectedA] – Erwartete Token-A-Menge (aus pre-TX `feesOwedA`).
     *   Fallback bei Wallet-Delta=0 trotz erfolgreicher TX (RPC-Propagation > Retry-Budget).
     * @param {number} [opts.expectedB] – Erwartete Token-B-Menge (aus pre-TX `feesOwedB`).
     * @returns {Promise<{amountA: number, amountB: number, txHash: string, txFeeSol: number, fallback?: boolean}>}
     */
    async collectFees(pool, positionNftMint, opts = {}) {
        // Niedrigerer Floor als solReserve: Claimen ist auch bei unterschrittener Reserve erlaubt,
        // aber nicht wenn SOL so niedrig ist, dass selbst eine TX-Fee nicht mehr bezahlbar wäre.
        const SOL_MIN_FLOOR = 0.01;
        const solForClaim = await getSolBalance(getKeypair().publicKey);
        if (solForClaim < SOL_MIN_FLOOR) {
            throw new Error(
                `collectFees abgebrochen: SOL-Balance (${solForClaim.toFixed(4)}) unter absolutem Minimum (${SOL_MIN_FLOOR} SOL).`
            );
        }

        const keypair    = getKeypair();
        const client     = this._getClient();
        const mintPubkey = new PublicKey(positionNftMint);
        const posPda     = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mintPubkey);

        await rpcLimiter.wait();
        const position = await client.getPosition(posPda.publicKey);

        // Wallet-Balance VOR dem Claim (Basis für Delta-Berechnung)
        // collectFees(updateFeesAndRewards=true) schreibt on-chain mehr gut als posData.feeOwedA
        // enthält — daher Wallet-Delta statt pre-TX-Positionswert verwenden.
        // SOL: rohe Balance (kein Reserve-Abzug) – verhindert Clamping auf 0 wenn SOL < solReserve.
        // WICHTIG: Fresh-Varianten verwenden – Cache kann durch parallele Operationen veraltet sein
        // und würde das Delta verfälschen (Bug: Withdraw + collectFees innerhalb Cache-TTL → aufgeblasenes Delta).
        const isSolA = pool.pair.toUpperCase().startsWith('SOL/');
        await rpcLimiter.wait();
        const balABefore = isSolA
            ? await getSolBalanceFresh(keypair.publicKey)
            : await getTokenBalanceFresh(keypair.publicKey, pool.tokenA, pool.decimalsA);
        await rpcLimiter.wait();
        const balBBefore = await getTokenBalanceFresh(keypair.publicKey, pool.tokenB, pool.decimalsB);

        // updateFeesAndRewards=true: On-Chain-Fees aktualisieren, dann claimen
        const collectTx = await position.collectFees(true);

        await rpcLimiter.wait();
        const txHash = await execTx(collectTx, this._ctx.connection, `${pool.pair} collectFees`);

        // TX-Fee lesen
        await rpcLimiter.wait();
        const txFeeSol = await getTxFee(txHash);

        // Wallet-Balance NACH dem Claim – Retry-Loop bis Balance sich ändert.
        // Fresh-Varianten umgehen den 30 s Proxy-Cache (Bug #37).
        // Retry nötig weil RPC-Propagation nach TX-Bestätigung kurz verzögert sein kann →
        // sonst lesen beide Fresh-Reads denselben Stand → Delta = 0 (Bug #38).
        // Erweitert auf 6 Versuche (Backoff 1s/2s/3s/4s/5s = bis 15s) gegen langsame Propagation.
        const MAX_ATTEMPTS = 6;
        let balAAfter = balABefore, balBAfter = balBBefore;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            if (attempt > 1) await new Promise(r => setTimeout(r, (attempt - 1) * 1000));
            await rpcLimiter.wait();
            balAAfter = isSolA
                ? await getSolBalanceFresh(keypair.publicKey)
                : await getTokenBalanceFresh(keypair.publicKey, pool.tokenA, pool.decimalsA);
            await rpcLimiter.wait();
            balBAfter = await getTokenBalanceFresh(keypair.publicKey, pool.tokenB, pool.decimalsB);
            if (balAAfter !== balABefore || balBAfter !== balBBefore) break;
            if (attempt < MAX_ATTEMPTS) console.log(`[orca] collectFees Balance-Readback Versuch ${attempt}/${MAX_ATTEMPTS} – warte ${attempt * 1000}ms`);
        }

        // Tatsächlich geclaimte Mengen aus Wallet-Delta
        // Bei SOL: TX-Fee wurde vom Guthaben abgezogen → zurückaddieren
        let amountA = Math.max(0, (balAAfter - balABefore) + (isSolA ? txFeeSol : 0));
        let amountB = Math.max(0, balBAfter - balBBefore);

        // Fallback: Wenn Wallet-Delta trotz aller Retries 0 ist (RPC-Propagation > Retry-Budget),
        // aber pre-TX feesOwed > 0 waren, war der Claim sehr wahrscheinlich erfolgreich (TX wurde
        // bestätigt). Auf Pre-TX-Erwartung zurückfallen, damit fee_history nicht 0/0/0 enthält.
        let fallback = false;
        const expectedA = +opts.expectedA || 0;
        const expectedB = +opts.expectedB || 0;
        if (amountA === 0 && amountB === 0 && (expectedA > 0 || expectedB > 0)) {
            amountA  = expectedA;
            amountB  = expectedB;
            fallback = true;
            console.warn(
                `[orca] collectFees Wallet-Delta=0 nach ${MAX_ATTEMPTS} Versuchen – Fallback auf pre-TX feesOwed: ` +
                `${expectedA.toFixed(6)} TokenA + ${expectedB.toFixed(2)} TokenB. TX=${txHash}`
            );
        }

        console.log(
            `[orca] Fees geclaimed: ${amountA.toFixed(6)} TokenA + ${amountB.toFixed(2)} TokenB` +
            ` (TX-Fee: ${txFeeSol.toFixed(6)} SOL${fallback ? ', fallback' : ''}) TX=${txHash}`
        );

        return { amountA, amountB, txHash, txFeeSol, fallback };
    }

    // ─── increaseLiquidity ────────────────────────────────────────────────────

    /**
     * Fügt einer bestehenden Position zusätzliche Liquidität hinzu.
     * Wird für Fee-Reinvestition verwendet: geclaimte Fees → mehr Liquidität.
     *
     * Orca berechnet den exakten Mix (A/B) basierend auf der aktuellen Preisposition.
     * Wir geben beide Token-Mengen als Maximum an — Orca verwendet was passt.
     *
     * @param {Object} pool
     * @param {string} positionNftMint
     * @param {number} amountA    Verfügbare Token-A-Menge (human-readable, z.B. 0.5 SOL)
     * @param {number} amountB    Verfügbare Token-B-Menge (human-readable, z.B. 40 USDC)
     * @returns {Promise<{addedLiquidity: string, txHash: string}>}
     */
    async increaseLiquidity(pool, positionNftMint, amountA, amountB, slippage = DEFAULT_SLIPPAGE) {
        await assertSufficientSol(getKeypair().publicKey);

        const client     = this._getClient();
        const mintPubkey = new PublicKey(positionNftMint);
        const posPda     = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mintPubkey);

        await rpcLimiter.wait();
        const position = await client.getPosition(posPda.publicKey);
        const posData  = position.getData();

        // Whirlpool-Daten laden für Quote-Berechnung
        await rpcLimiter.wait();
        const whirlpoolPubkey = posData.whirlpool;
        const whirlpool       = await client.getPool(whirlpoolPubkey);
        const poolData        = whirlpool.getData();

        // Fix 2: Dynamischer Anker-Token — beide Quotes berechnen, bindenden Engpass wählen.
        // Verhindert InsufficientFunds (0x1) wenn ein Token fast leer ist.
        const quoteB = increaseLiquidityQuoteByInputToken(
            new PublicKey(pool.tokenB), new Decimal(amountB),
            posData.tickLowerIndex, posData.tickUpperIndex,
            slippage, whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
        );
        const quoteA = increaseLiquidityQuoteByInputToken(
            new PublicKey(pool.tokenA), new Decimal(amountA),
            posData.tickLowerIndex, posData.tickUpperIndex,
            slippage, whirlpool, NO_TOKEN_EXTENSION_CONTEXT,
        );
        // Fix 3: quoteB darf nie mehr tokenA fordern als der Caller übergeben hat.
        // tokenEstA aus quoteB kann > amountA sein wenn USDC binding ist und der Pool
        // nahe/außerhalb der Range liegt — das führt zu "insufficient funds (0x1)".
        const rawAmountA = toRawAmount(amountA, pool.decimalsA);
        const aIsBindingInc = quoteA.liquidityAmount.gtn(0) && (
            quoteB.liquidityAmount.eqn(0) ||
            quoteA.liquidityAmount.lte(quoteB.liquidityAmount) ||
            quoteB.tokenEstA.gt(rawAmountA)
        );
        const quote = aIsBindingInc ? quoteA : quoteB;

        // Slippage-Bounds manuell hinzufügen — ohne sie schlägt der
        // On-Chain-Check mit PriceSlippageOutOfBounds (0x17b5) fehl.
        let minSqrtPrice, maxSqrtPrice;
        try {
            const bounds = PriceMath.getSlippageBoundForSqrtPrice(poolData.sqrtPrice, slippage);
            minSqrtPrice = bounds.lowerBound[0];
            maxSqrtPrice = bounds.upperBound[0];
        } catch {
            minSqrtPrice = new BN(MIN_SQRT_PRICE);
            maxSqrtPrice = new BN(MAX_SQRT_PRICE);
        }

        const liquidityInput = { ...quote, minSqrtPrice, maxSqrtPrice };

        console.log(
            `[orca] increaseLiquidity Quote: tokenEstA=${fromRawAmount(quote.tokenEstA, pool.decimalsA).toFixed(6)}` +
            ` tokenEstB=${fromRawAmount(quote.tokenEstB, pool.decimalsB).toFixed(2)}`
        );

        // Guard: Whirlpool lehnt increaseLiquidity(0) mit 0x177c (ZeroLiquidityError) ab.
        // Tritt auf wenn geclaimte Fees zu gering sind um messbare Liquidität zu ergeben
        // (z.B. 0.00001 SOL + 0 USDC → Quote = 0/0 → Transaktion würde fehlschlagen).
        if (quote.tokenEstA === 0n && quote.tokenEstB === 0n) {
            console.log('[orca] increaseLiquidity: Quote ergibt 0 – Staub-Reinvest übersprungen');
            return { addedLiquidity: '0', txHash: null, tokenEstA: 0, tokenEstB: 0 };
        }

        const increaseTx = await position.increaseLiquidity(liquidityInput);

        await rpcLimiter.wait();
        const txHash = await execTx(increaseTx, this._ctx.connection, `${pool.pair} increaseLiquidity`);

        // Neue Gesamt-Liquidität direkt aus posData + Quote-Delta berechnen.
        // Kein client.getPosition() Re-Read: der würde durch den 30 s Proxy-Cache
        // stale Daten liefern, dadurch wäre state.liquidity nach Reinvest weiterhin
        // der alte Wert und "Mein Anteil" im Dashboard würde sich erst ~5 Min später
        // (beim nächsten regulären Snapshot mit frischem Read) aktualisieren.
        const addedLiquidity = posData.liquidity.add(quote.liquidityAmount).toString();

        const actualA = fromRawAmount(quote.tokenEstA, pool.decimalsA);
        const actualB = fromRawAmount(quote.tokenEstB, pool.decimalsB);

        console.log(
            `[orca] Liquidität erhöht: +${actualA.toFixed(6)} TokenA / +${actualB.toFixed(2)} TokenB` +
            ` TX=${txHash}`
        );

        return { addedLiquidity, txHash, tokenEstA: actualA, tokenEstB: actualB };
    }

    // ─── decreaseLiquidity ────────────────────────────────────────────────────

    /**
     * Entnimmt einen Teil der Liquidität aus einer bestehenden Position.
     * Die Position bleibt offen — nur der angegebene USDC-Betrag wird herausgenommen.
     *
     * usdcAmount bestimmt welcher Anteil der Position entnommen wird:
     *   Fraktion = usdcAmount / Gesamtpositionswert (max. 100 %)
     *   liquidityToRemove = totalLiquidity × Fraktion
     *
     * Funktioniert auch out-of-range (dann bekommt man nur den verbleibenden Token zurück).
     *
     * @param {Object}     pool
     * @param {string}     positionNftMint
     * @param {number}     usdcAmount    Zu entnehmender Betrag in USDC-Äquivalent
     * @param {Percentage} slippage
     * @returns {Promise<{tokenEstA: number, tokenEstB: number, fraction: number, txHash: string}>}
     */
    async decreaseLiquidity(pool, positionNftMint, usdcAmount, slippage = DEFAULT_SLIPPAGE, refPriceUsd = 0) {
        // Kapitalfreigabe (Teil-Entnahme, TVL-Schutz L1, manueller Withdraw) →
        // nur physikalischer Boden. Siehe assertSufficientSolForExit() in ../wallet.js.
        await assertSufficientSolForExit(getKeypair().publicKey);

        const client     = this._getClient();
        const mintPubkey = new PublicKey(positionNftMint);
        const posPda     = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mintPubkey);

        await rpcLimiter.wait();
        const [whirlpool, position] = await Promise.all([
            client.getPool(new PublicKey(pool.address), IGNORE_CACHE),
            client.getPosition(posPda.publicKey, IGNORE_CACHE),
        ]);

        const poolData = whirlpool.getData();
        const posData  = position.getData();

        // Aktuellen Positionswert in USDC berechnen
        const sqrtPrice = poolData.sqrtPrice;
        const sqrtLower = PriceMath.tickIndexToSqrtPriceX64(posData.tickLowerIndex);
        const sqrtUpper = PriceMath.tickIndexToSqrtPriceX64(posData.tickUpperIndex);
        const amounts   = PoolUtil.getTokenAmountsFromLiquidity(
            posData.liquidity, sqrtPrice, sqrtLower, sqrtUpper, false
        );
        const currentA = fromRawAmount(amounts.tokenA, pool.decimalsA);
        const currentB = fromRawAmount(amounts.tokenB, pool.decimalsB);

        const price = PriceMath.sqrtPriceX64ToPrice(
            sqrtPrice, pool.decimalsA, pool.decimalsB
        ).toNumber();

        // Positionswert in USDC: berücksichtigt volatilePair (z.B. cbBTC/WBTC) und usdcIsTokenA (EURC/USDC)
        const positionValueUsdc = pool.volatilePair
            ? (() => {
                const quoteIsTokenA = pool.quoteTokenMint === pool.tokenA;
                if (quoteIsTokenA) return (currentA + (price > 0 ? currentB / price : 0)) * refPriceUsd;
                return (currentA * price + currentB) * refPriceUsd;
            })()
            : pool.usdcIsTokenA
                ? currentA + (price > 0 ? currentB / price : 0)
                : currentA * price + currentB;

        if (positionValueUsdc <= 0) {
            throw new Error('Positionswert ist 0 – keine Liquidität vorhanden.');
        }

        // Anteil der zu entnehmenden Liquidität
        const fraction          = Math.min(usdcAmount / positionValueUsdc, 1.0);
        const liquidityToRemove = new BN(
            new Decimal(posData.liquidity.toString()).mul(fraction).toFixed(0)
        );

        const quote = decreaseLiquidityQuoteByLiquidityWithParams({
            liquidity:         liquidityToRemove,
            sqrtPrice:         poolData.sqrtPrice,
            tickCurrentIndex:  poolData.tickCurrentIndex,
            tickLowerIndex:    posData.tickLowerIndex,
            tickUpperIndex:    posData.tickUpperIndex,
            slippageTolerance: slippage,
            tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
        });

        const estA = fromRawAmount(quote.tokenMinA, pool.decimalsA);
        const estB = fromRawAmount(quote.tokenMinB, pool.decimalsB);

        console.log(
            `[orca] decreaseLiquidity Quote: tokenEstA=${estA.toFixed(6)}` +
            ` tokenEstB=${estB.toFixed(6)}` +
            ` (${(fraction * 100).toFixed(2)}% der Position)`
        );

        let txHash;
        try {
            const decreaseTx = await position.decreaseLiquidity(quote);
            await rpcLimiter.wait();
            txHash = await execTx(decreaseTx, this._ctx.connection, `decreaseLiquidity NFT=${positionNftMint}`);
        } catch (err) {
            // 0x1782 = TokenMinSubceeded: Preis hat sich zwischen Quote und TX verschoben.
            // Retry mit frischen Pool-Daten und großzügigerer Slippage (1%).
            if (!err.message?.includes('0x1782')) throw err;

            console.log(
                `[orca] decreaseLiquidity 0x1782 (TokenMinSubceeded) – ` +
                `hole frische Pool-Daten und retry mit 1% Slippage: NFT=${positionNftMint}`
            );
            await rpcLimiter.wait();
            const freshWhirlpool = await client.getPool(new PublicKey(pool.address), IGNORE_CACHE);
            const freshPoolData  = freshWhirlpool.getData();

            const retrySlippage = Percentage.fromFraction(1, 100); // 1 %
            const retryQuote    = decreaseLiquidityQuoteByLiquidityWithParams({
                liquidity:         liquidityToRemove,
                sqrtPrice:         freshPoolData.sqrtPrice,
                tickCurrentIndex:  freshPoolData.tickCurrentIndex,
                tickLowerIndex:    posData.tickLowerIndex,
                tickUpperIndex:    posData.tickUpperIndex,
                slippageTolerance: retrySlippage,
                tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
            });
            const freshPos   = await client.getPosition(posPda.publicKey, IGNORE_CACHE);
            const retryTx    = await freshPos.decreaseLiquidity(retryQuote);
            await rpcLimiter.wait();
            txHash = await execTx(retryTx, this._ctx.connection, `retry decreaseLiquidity NFT=${positionNftMint}`);
            console.log(`[orca] Retry decreaseLiquidity OK: NFT=${positionNftMint} TX=${txHash}`);
        }

        console.log(
            `[orca] Liquidität reduziert: -${estA.toFixed(6)} TokenA / -${estB.toFixed(6)} TokenB TX=${txHash}`
        );

        return { tokenEstA: estA, tokenEstB: estB, fraction, txHash };
    }
}
