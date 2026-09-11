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
    // Preisband- statt Mengenabschlag-Variante: begrenzt, wie weit sich der PREIS zwischen
    // Quote und Ausführung bewegen darf, statt pauschal 1 % von beiden Mengen abzuziehen.
    // Begründung an der Haupt-Quote in closePosition(). Die Standard-Variante
    // (…WithParams) wird bewusst nirgends mehr verwendet.
    decreaseLiquidityQuoteByLiquidityWithParamsUsingPriceSlippage as decreaseLiquidityQuoteUsingPriceSlippage,
    swapQuoteByInputToken,
    collectFeesQuote,
    TickArrayUtil,
    TokenExtensionUtil,
    MIN_SQRT_PRICE,
    MAX_SQRT_PRICE,
    IGNORE_CACHE,
    TokenType,
    ParsableWhirlpool,
    ParsablePosition,
    ParsableTickArray,
} from '@orca-so/whirlpools-sdk';
import { Percentage, TransactionBuilder } from '@orca-so/common-sdk';
import { getAssociatedTokenAddressSync }  from '@solana/spl-token';
import { Wallet }            from '@coral-xyz/anchor';
import { PublicKey }         from '@solana/web3.js';
import Decimal               from 'decimal.js';
import BN                    from 'bn.js';
import { getConnection, getConnectionFresh, getKeypair, assertSufficientSol, assertSufficientSolForExit, getTxFee, getSolBalance, getSolBalanceFresh, getTokenBalance, getTokenBalanceFresh } from '../wallet.js';
import { rpcLimiter, geckoLimiter } from '../rate-limiter.js';
import { settle } from '../settle-promise.js';
import { emitChainTxLeg } from '../chain-tx-log.js';

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

/**
 * Token-Extension-Kontext für einen Pool (Transfer-Fee/Interest/Hook-Info beider Mints).
 *
 * 🔒 Nie `NO_TOKEN_EXTENSION_CONTEXT` an eine Quote-Funktion geben — der Name klingt nach
 * "keine Extensions vorhanden", bedeutet aber "rechne so, ALS OB keine da wären". Bei einem
 * Token-2022-Mint mit TransferFeeConfig unterschätzt das systematisch die tatsächlich
 * bewegte Menge (Quote nimmt den Bruttobetrag an, der Vault bekommt nach Fee weniger) — exakt
 * das under/over-funding-Risiko aus LIQ#0276. Ein einzelner extra Fetcher-Call pro Aufruf
 * (Mint-Accounts beider Seiten), läuft über denselben `ctx.fetcher` wie der Rest der Reads.
 */
async function buildPoolTokenExtCtx(ctx, poolData) {
    return TokenExtensionUtil.buildTokenExtensionContextForPool(
        ctx.fetcher, poolData.tokenMintA, poolData.tokenMintB, IGNORE_CACHE,
    );
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

// ─── Ist-Werte einer Liquiditäts-Transaktion ─────────────────────────────────
//
// Die Orca-Quote (`tokenEstA/B`, `liquidityAmount`) ist eine Vorhersage zum Pool-Preis im
// Moment der Quote-Berechnung. Liegen zwischen Quote und Ausführung eigene Swaps im selben
// Pool oder ein Cache-Read, weicht der on-chain tatsächlich bewegte Mix ab — in einer engen
// Range um mehrere Prozent einer Seite (Befund 2026-08-22, forge-pub1, ZEC/USDC: Quote
// 0,0701 ZEC, tatsächlich 0,0653 ZEC; 3,5 USDC „Einzahlung" blieben im Wallet, wurden aber
// als Kapital gebucht). Deshalb liest der Adapter nach jeder Liquiditäts-Transaktion die
// **Ist-Werte aus der bestätigten Transaktion**: die Token-Deltas der Pool-Vaults (Konten mit
// owner === Whirlpool) sind exakt die Mengen, die in die Position geflossen sind — unabhängig
// von WSOL-Temp-Konten auf Wallet-Seite, die in pre/post-Balances nicht auftauchen.
//
// Aus den beiden Mengen und der Range folgt die hinzugefügte Liquidität und der
// Ausführungs-Sqrt-Preis eindeutig (zwei Gleichungen, zwei Unbekannte):
//     a = L · (√Pb − √P) / (√P · √Pb)        b = L · (√P − √Pa)
// Das ist das Maß, mit dem `scaleReferencesForLiquidityChange()` den Trailing Stop
// nachzieht — kein Quote-Wert, kein zweiter RPC-Read hinter dem 10-s-Proxy-Cache.

/**
 * Liquidität und Ausführungs-√Preis aus den tatsächlich bewegten Token-Mengen einer Range.
 * @param {BN|string|number} rawA  tokenA in kleinster Einheit
 * @param {BN|string|number} rawB  tokenB in kleinster Einheit
 * @returns {{ liquidity: BN, sqrtPriceX64: BN, oneSided: boolean }|null}
 */
export function liquidityFromTokenAmounts(rawA, rawB, tickLower, tickUpper) {
    const a   = Number(rawA.toString());
    const b   = Number(rawB.toString());
    const Q64 = 2 ** 64;
    const spa = Number(PriceMath.tickIndexToSqrtPriceX64(tickLower).toString()) / Q64;
    const spb = Number(PriceMath.tickIndexToSqrtPriceX64(tickUpper).toString()) / Q64;
    if (!(spb > spa) || !(a >= 0) || !(b >= 0) || (a === 0 && b === 0)) return null;

    let sp, L, oneSided = false;
    if (a === 0) {                      // Preis auf/über der Obergrenze: nur tokenB
        sp = spb; L = b / (spb - spa); oneSided = true;
    } else if (b === 0) {               // Preis auf/unter der Untergrenze: nur tokenA
        sp = spa; L = a * spa * spb / (spb - spa); oneSided = true;
    } else {
        const A = a * spb, B = b - a * spa * spb, C = -b * spb;
        const disc = B * B - 4 * A * C;
        if (!(disc >= 0)) return null;
        sp = (-B + Math.sqrt(disc)) / (2 * A);
        if (!(sp > spa && sp < spb)) {
            // Rundung an der Range-Grenze: auf die Grenze klemmen, L aus der vorhandenen Seite
            sp = Math.min(Math.max(sp, spa), spb);
            oneSided = true;
        }
        L = sp > spa ? b / (sp - spa) : a * spa * spb / (spb - spa);
    }
    if (!(L > 0) || !Number.isFinite(L)) return null;
    return {
        liquidity:    new BN(new Decimal(L).toFixed(0)),
        sqrtPriceX64: new BN(new Decimal(sp).mul(new Decimal(2).pow(64)).toFixed(0)),
        oneSided,
    };
}

/**
 * Ist-Werte einer bestätigten openPosition-/increaseLiquidity-Transaktion.
 *
 * Liest die Transaktion (mit kurzem Retry — direkt nach der Bestätigung kann der RPC sie noch
 * nicht indexiert haben) und bestimmt aus den Vault-Deltas des Whirlpools die tatsächlich in die
 * Position geflossenen Mengen, daraus Liquidität und Ausführungspreis. Liefert `null`, wenn die
 * Transaktion nicht lesbar ist oder keine Vault-Bewegung enthält — der Aufrufer fällt dann auf
 * die Quote zurück und kennzeichnet das (`measured: false`).
 *
 * @returns {Promise<{amountA:number, amountB:number, liquidity:string, sqrtPriceX64:string,
 *                    priceExec:number, txFeeSol:number, measured:true}|null>}
 */
export async function readLiquidityLegsFromTx(connection, txHash, pool, tickLower, tickUpper) {
    let tx = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
        await rpcLimiter.wait();
        try {
            tx = await connection.getTransaction(txHash, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
        } catch { tx = null; }
        if (tx?.meta) break;
        if (attempt < 4) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
    if (!tx?.meta || tx.meta.err) return null;

    const key  = b => `${b.owner}|${b.mint}`;
    const pre  = new Map((tx.meta.preTokenBalances  ?? []).map(b => [key(b), b.uiTokenAmount.amount ?? '0']));
    const post = new Map((tx.meta.postTokenBalances ?? []).map(b => [key(b), b.uiTokenAmount.amount ?? '0']));
    let rawA = new BN(0), rawB = new BN(0), seen = false;
    for (const k of new Set([...pre.keys(), ...post.keys()])) {
        const [owner, mint] = k.split('|');
        if (owner !== pool.address) continue;
        const delta = new BN(post.get(k) ?? '0').sub(new BN(pre.get(k) ?? '0'));
        if (mint === pool.tokenA) { rawA = delta; seen = true; }
        if (mint === pool.tokenB) { rawB = delta; seen = true; }
    }
    // Zuflüsse sind positiv (Vault gewinnt). Negative Deltas wären Abflüsse (Fee-Collect im
    // selben TX) — für eine Einzahlung nicht vorgesehen, dann lieber Quote als falsches Maß.
    if (!seen || rawA.isNeg() || rawB.isNeg() || (rawA.isZero() && rawB.isZero())) return null;

    const solved = liquidityFromTokenAmounts(rawA, rawB, tickLower, tickUpper);
    if (!solved) return null;

    return {
        amountA:      fromRawAmount(rawA, pool.decimalsA),
        amountB:      fromRawAmount(rawB, pool.decimalsB),
        liquidity:    solved.liquidity.toString(),
        sqrtPriceX64: solved.sqrtPriceX64.toString(),
        priceExec:    PriceMath.sqrtPriceX64ToPrice(solved.sqrtPriceX64, pool.decimalsA, pool.decimalsB).toNumber(),
        txFeeSol:     (tx.meta.fee ?? 0) / 1e9,
        measured:     true,
    };
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
    // includeVolumeCandles = false überspringt den GeckoTerminal-Call: Preis (RPC) und
    // TVL/APR/Fees (Orca v2) haben reichlich Rate-Limit-Spielraum (Nexus: 8 req/s bzw.
    // 30 req/10s) und können deshalb häufiger abgefragt werden als die Volume-Candles,
    // die am knappen, undokumentierten Gecko-Limit hängen (Nexus: 1 req/20s zentral für
    // alle Pools). Aufrufer steuert die beiden Kadenzen getrennt (siehe bot.js).
    async getPoolStats(pool, { includeVolumeCandles = true } = {}) {
        const [onChain, orcaStats, volumeCandles] = await Promise.all([
            settle(this._getPriceOnChain(pool)),
            settle(this._getOrcaV2Stats(pool.address)),
            includeVolumeCandles ? settle(this._getVolumeCandles(pool.address)) : Promise.resolve(null),
        ]);

        return {
            price:            onChain.price,
            tvlUsd:           orcaStats?.tvlUsd            ?? null,
            volume24hUsd:     orcaStats?.volume24h         ?? null,
            apr24h:           orcaStats?.apr24h            ?? null,
            liquidityInRange: orcaStats?.liquidityInRange  ?? null,
            fees24hUsd:       orcaStats?.fees24hUsd        ?? null,
            volumeCandles:    includeVolumeCandles ? volumeCandles : null,
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

    /**
     * Aktueller Pool-Preis von der Chain — ein einzelner Account-Read (Whirlpool), kein
     * Positions-/Tick-Array-Read. Bewusst so leicht: die Schnellprüfung des Trailing Stops
     * (`lib/fast-stop-check.js`) ruft das alle ~30 s je kapitalhaltendem Pool auf.
     * @returns {Promise<number>} Preis in tokenB je tokenA
     */
    async getPoolPrice(pool) {
        return (await this._getPriceOnChain(pool)).price;
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
    // positionHint: { tickLowerIndex, tickUpperIndex } – historischer Parameter aus der Zeit
    // des zweistufigen Reads. Wird seit dem Slot-konsistenten Read (siehe unten) nicht mehr
    // ausgewertet; die Signatur bleibt erhalten, damit die Aufrufer unverändert bleiben.
    // fresh=true: umgeht den 10-s-Proxy-Cache (/rpc/fresh statt /rpc). Nötig für
    // establishPositionBaseline() direkt nach einer Rest-Einzahlung/einem Sweep — der
    // In-Range-Check in sweepResidualIntoPosition liest denselben Account (Pool + Position)
    // bereits VOR der increaseLiquidity-TX und füllt den Cache mit der alten Liquidität.
    // Ein normaler Re-Read Sekunden später bekäme exakt diesen stale Eintrag zurück (siehe
    // Kommentar bei increaseLiquidity: "Kein client.getPosition() Re-Read: der liefe in den
    // 10-s-Proxy-Cache"). Live beobachtet 2026-08-23, liq-pump-sol: Trailing-Stop-Referenz
    // stand dadurch auf dem Wert VOR der Rest-Einzahlung (453,81 statt 490,16 USDC) und
    // schaltete Stufe 2 fälschlich sofort scharf (+8 % "Gewinn" durch reinen Kapitalfluss).
    async getPositionState(pool, positionNftMint, positionHint = null, { fresh = false } = {}) {  // eslint-disable-line no-unused-vars
        this._getClient();  // ctx sicherstellen
        const conn       = fresh ? getConnectionFresh() : this._ctx.connection;
        const mintPubkey = new PublicKey(positionNftMint);
        const posPda     = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, mintPubkey);
        const poolPubkey = new PublicKey(pool.address);

        // Schritt 1: Pool + Position lesen — nur, um tickSpacing und die Tick-Indizes zu
        // erfahren, aus denen sich die Tick-Array-PDAs ableiten. Die hier gelesenen Daten
        // gehen NICHT in den Fee-Quote ein (siehe Schritt 2).
        await rpcLimiter.wait();
        const pre = await conn.getMultipleAccountsInfo([poolPubkey, posPda.publicKey]);
        const prePool = ParsableWhirlpool.parse(poolPubkey, pre[0]);
        const prePos  = ParsablePosition.parse(posPda.publicKey, pre[1]);
        if (!prePool) throw new Error(`Whirlpool-Account ${pool.address} nicht lesbar`);
        if (!prePos)  throw new Error(`Position-Account ${posPda.publicKey.toBase58()} nicht lesbar`);

        // Schritt 2: 🔒 Slot-konsistenter Read. Whirlpool, Position und beide Tick-Arrays
        // kommen aus EINEM getMultipleAccounts-Call und damit garantiert aus demselben Slot.
        // Grund: collectFeesQuote() rechnet feeGrowthInside aus feeGrowthGlobal (Whirlpool),
        // feeGrowthCheckpoint (Position) und feeGrowthOutside (Tick-Arrays). Stammen diese
        // Accounts aus verschiedenen Slots und wird dazwischen eine Tick-Grenze gekreuzt,
        // kippt feeGrowthOutside und der Quote liefert Phantom-Fees in der Größenordnung des
        // Positionswerts (TRUMP/SOL am 2026-08-22, 19:29:06: 283,57 USDC „Pending Fees" auf
        // 254,46 USDC Positionswert, on-chain tatsächlich 0,000026 SOL — die Position stand
        // exakt auf ihrer unteren Tick-Grenze). Vorher liefen Pool/Position und Tick-Arrays
        // in zwei getrennten Batches, im Bot-Betrieb (positionHint gesetzt) sogar ohne
        // rpcLimiter.wait() dazwischen — das Fenster war klein, aber nie null.
        let poolData = prePool;
        let posData  = prePos;
        let taLowerData = null;
        let taUpperData = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            const taLowerPda = PDAUtil.getTickArrayFromTickIndex(
                posData.tickLowerIndex, poolData.tickSpacing, poolPubkey, ORCA_WHIRLPOOL_PROGRAM_ID
            ).publicKey;
            const taUpperPda = PDAUtil.getTickArrayFromTickIndex(
                posData.tickUpperIndex, poolData.tickSpacing, poolPubkey, ORCA_WHIRLPOOL_PROGRAM_ID
            ).publicKey;

            await rpcLimiter.wait();
            const infos = await conn.getMultipleAccountsInfo(
                [poolPubkey, posPda.publicKey, taLowerPda, taUpperPda]
            );
            const nextPool = ParsableWhirlpool.parse(poolPubkey, infos[0]);
            const nextPos  = ParsablePosition.parse(posPda.publicKey, infos[1]);
            if (!nextPool || !nextPos) throw new Error(`Pool/Position ${pool.id} im Slot-konsistenten Read nicht lesbar`);

            // Passen die PDAs noch zu den im selben Slot gelesenen Pool-/Positionsdaten?
            // (tickSpacing oder Tick-Indizes zwischen Schritt 1 und 2 geändert → neu ableiten)
            const stillValid = nextPool.tickSpacing     === poolData.tickSpacing &&
                               nextPos.tickLowerIndex   === posData.tickLowerIndex &&
                               nextPos.tickUpperIndex   === posData.tickUpperIndex;
            poolData = nextPool;
            posData  = nextPos;
            if (!stillValid) {
                console.warn(`[orca:${pool.id}] Tick-Array-PDAs veraltet (Range/tickSpacing geändert) – Read wird wiederholt`);
                continue;
            }

            taLowerData = ParsableTickArray.parse(taLowerPda, infos[2]);
            taUpperData = ParsableTickArray.parse(taUpperPda, infos[3]);
            if (!taLowerData || !taUpperData) {
                throw new Error(`Tick-Arrays für ${pool.id} nicht lesbar (lower=${!!taLowerData}, upper=${!!taUpperData})`);
            }
            break;
        }
        if (!taLowerData || !taUpperData) {
            throw new Error(`Slot-konsistenter Read für ${pool.id} nach 2 Versuchen fehlgeschlagen`);
        }

        const inRange = poolData.tickCurrentIndex >= posData.tickLowerIndex &&
                        poolData.tickCurrentIndex <  posData.tickUpperIndex;

        const priceLower = PriceMath.tickIndexToPrice(
            posData.tickLowerIndex, pool.decimalsA, pool.decimalsB
        ).toNumber();
        const priceUpper = PriceMath.tickIndexToPrice(
            posData.tickUpperIndex, pool.decimalsA, pool.decimalsB
        ).toNumber();

        const tickLowerData = TickArrayUtil.getTickFromArray(
            taLowerData, posData.tickLowerIndex, poolData.tickSpacing
        );
        const tickUpperData = TickArrayUtil.getTickFromArray(
            taUpperData, posData.tickUpperIndex, poolData.tickSpacing
        );

        const feesQuote = collectFeesQuote({
            whirlpool:       poolData,
            position:        posData,
            tickLower:       tickLowerData,
            tickUpper:       tickUpperData,
            tokenExtensionCtx: await buildPoolTokenExtCtx(this._ctx, poolData),
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
     * Liest den On-Chain-Zustand ALLER übergebenen Positionen in 3 RPC-Calls
     * (unabhängig von der Pool-Anzahl):
     *   Vorab-Batch a: getMultipleAccounts([poolPubkeys]) → WhirlpoolData  (parallel)
     *   Vorab-Batch b: getMultipleAccounts([posPdas])     → PositionData   (parallel)
     *   Haupt-Batch:   getMultipleAccounts([pool, pos, tickLower, tickUpper] je Position)
     *
     * 🔒 Der Haupt-Batch liest Pool, Position und beide Tick-Arrays einer Position in
     * EINEM Call und damit garantiert aus demselben Slot — nur diese Daten gehen in den
     * Fee-Quote ein. Die Vorab-Batches dienen ausschließlich der PDA-Ableitung
     * (tickSpacing + Tick-Indizes). Begründung siehe getPositionState().
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

        // Vorab-Batch: Pool-State + Position-Daten parallel (je 1 getMultipleAccounts = 2 Credits).
        // Nur zur PDA-Ableitung — die Werte selbst werden im Haupt-Batch frisch gelesen.
        await rpcLimiter.wait();
        const [poolsMap, positionsMap] = await Promise.all([
            settle(ctx.fetcher.getPools(poolPubkeys, IGNORE_CACHE)),
            settle(ctx.fetcher.getPositions(posPdas, IGNORE_CACHE)),
        ]);

        // Je Position ein 4er-Block [pool, position, tickArrayLower, tickArrayUpper].
        // Positionen ohne lesbare Vorab-Daten fallen raus (Fallback auf Einzelabruf).
        const blocks = [];
        for (let i = 0; i < items.length; i++) {
            const presPool = poolsMap.get(poolPubkeys[i].toBase58());
            const prePos   = positionsMap.get(posPdas[i].toBase58());
            if (!presPool || !prePos) {
                console.warn(`[orca:bulk] Vorab-Daten unvollständig für ${items[i].pool.id} – Fallback auf Einzelabruf`);
                continue;
            }
            blocks.push({
                item:     items[i],
                keys: [
                    poolPubkeys[i],
                    posPdas[i],
                    PDAUtil.getTickArrayFromTickIndex(
                        prePos.tickLowerIndex, presPool.tickSpacing,
                        poolPubkeys[i], ORCA_WHIRLPOOL_PROGRAM_ID
                    ).publicKey,
                    PDAUtil.getTickArrayFromTickIndex(
                        prePos.tickUpperIndex, presPool.tickSpacing,
                        poolPubkeys[i], ORCA_WHIRLPOOL_PROGRAM_ID
                    ).publicKey,
                ],
                expect: {
                    tickSpacing: presPool.tickSpacing,
                    tickLower:   prePos.tickLowerIndex,
                    tickUpper:   prePos.tickUpperIndex,
                },
            });
        }
        if (blocks.length === 0) return new Map();

        // Haupt-Batch. getMultipleAccounts akzeptiert max. 100 Accounts pro Call → in
        // Gruppen zu 25 Positionen (= 100 Accounts) chunken. Die Slot-Konsistenz, auf die
        // es ankommt, gilt innerhalb eines 4er-Blocks und bleibt dabei erhalten.
        const BLOCKS_PER_CALL = 25;
        const infos = [];
        for (let off = 0; off < blocks.length; off += BLOCKS_PER_CALL) {
            const chunk = blocks.slice(off, off + BLOCKS_PER_CALL);
            await rpcLimiter.wait();
            const got = await ctx.connection.getMultipleAccountsInfo(chunk.flatMap(b => b.keys));
            infos.push(...got);
        }

        // States berechnen
        const results = new Map();
        for (let i = 0; i < blocks.length; i++) {
            const { item, keys, expect } = blocks[i];
            const { pool } = item;
            const slice    = infos.slice(i * 4, i * 4 + 4);

            const poolData = ParsableWhirlpool.parse(keys[0], slice[0]);
            const posData  = ParsablePosition.parse(keys[1], slice[1]);
            const taLower  = ParsableTickArray.parse(keys[2], slice[2]);
            const taUpper  = ParsableTickArray.parse(keys[3], slice[3]);

            if (!poolData || !posData || !taLower || !taUpper) {
                console.warn(`[orca:bulk] Daten unvollständig für ${pool.id} – Fallback auf Einzelabruf`);
                continue;
            }
            // Range/tickSpacing zwischen Vorab- und Haupt-Batch geändert → die Tick-Array-PDAs
            // gehören nicht mehr zu dieser Position. Lieber auslassen als falsch rechnen;
            // der Einzelabruf (getPositionState) leitet sie frisch ab.
            if (poolData.tickSpacing   !== expect.tickSpacing ||
                posData.tickLowerIndex !== expect.tickLower   ||
                posData.tickUpperIndex !== expect.tickUpper) {
                console.warn(`[orca:bulk] Range/tickSpacing für ${pool.id} zwischenzeitlich geändert – Fallback auf Einzelabruf`);
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
                tokenExtensionCtx: await buildPoolTokenExtCtx(ctx, poolData),
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

        // IGNORE_CACHE: die Quote rechnet mit poolData.sqrtPrice — ein gecachter Pool-Stand
        // (z. B. von vor dem eigenen Pre-Swap im selben Pool) verschiebt den Token-Mix der Quote.
        await rpcLimiter.wait();
        const whirlpool = await client.getPool(new PublicKey(pool.address), IGNORE_CACHE);

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
        const tokenExtCtx = await buildPoolTokenExtCtx(this._ctx, poolData);

        const quoteB = increaseLiquidityQuoteByInputToken(
            new PublicKey(pool.tokenB),
            new Decimal(amountB),
            tickLower, tickUpper, slippage, whirlpool, tokenExtCtx,
        );
        const quoteA = increaseLiquidityQuoteByInputToken(
            new PublicKey(pool.tokenA),
            new Decimal(amountA),
            tickLower, tickUpper, slippage, whirlpool, tokenExtCtx,
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

        // Jedes gesendete Leg SOFORT vermerken, nicht erst über den Rückgabewert:
        // Bricht der Vorgang zwischen zwei Legs ab (Stale-Read-Fehler, Prozesstod),
        // gibt es keinen Rückgabewert mehr — das bereits gesendete Leg wäre für
        // lib/capital-reconcile.js dann ein unerklärter Abfluss (Vorfall 2026-08-15).
        const sendLeg = async (kind, txBuilder, label) => {
            const hash = await execTx(txBuilder, this._ctx.connection, label);
            emitChainTxLeg({ txHash: hash, poolId: pool.id, kind, note: `NFT=${positionNftMint}` });
            return hash;
        };

        // Position + Pool laden
        await rpcLimiter.wait();
        const [whirlpool, position] = await Promise.all([
            settle(this._getClient().getPool(new PublicKey(pool.address), IGNORE_CACHE)),
            settle(client.getPosition(posPda.publicKey, IGNORE_CACHE)),
        ]);

        const poolData = whirlpool.getData();
        const posData  = position.getData();
        const tokenExtCtx = await buildPoolTokenExtCtx(this._ctx, poolData);

        // Quote für vollständige Liquiditätsentnahme.
        //
        // 🔒 …UsingPriceSlippage, nicht die Standard-Variante (Fix 2026-08-23).
        // Die Standard-Variante rechnet `tokenMin` als pauschalen Mengenabschlag
        // (tokenEst × 100/101). Bewegt sich der Preis zwischen Quote und Ausführung, verschiebt
        // sich der Token-MIX der Entnahme — eine der beiden Mengen rutscht unter ihr Minimum
        // und die TX bricht mit 0x1782 (TokenMinSubceeded) ab. Seit dem 01.08. traf das ~14
        // Exits, also rund jeden vierten.
        //
        // Für einen VOLL-Exit ist das der falsche Guard: Der Mix ist gleichgültig, es wird
        // ohnehin alles nach USDC getauscht. Gefährlich ist nur ein manipulierter PREIS — und
        // genau den begrenzt diese Variante, indem sie tokenMin als Minimum über das Preisband
        // ±slippageTolerance bildet statt über einen Mengenabschlag. Toleranz bleibt bei 1 %:
        // eine Mix-Verschiebung läuft jetzt durch, eine Preismanipulation bricht weiter ab.
        // Dieselbe Preisband-Logik nutzt openPosition() über getSlippageBoundForSqrtPrice().
        const quote = decreaseLiquidityQuoteUsingPriceSlippage({
            liquidity:        posData.liquidity,
            sqrtPrice:        poolData.sqrtPrice,
            tickCurrentIndex: poolData.tickCurrentIndex,
            tickLowerIndex:   posData.tickLowerIndex,
            tickUpperIndex:   posData.tickUpperIndex,
            slippageTolerance: DEFAULT_SLIPPAGE,
            tokenExtensionCtx: tokenExtCtx,
        });

        // Liquidität vollständig entfernen (Fees müssen VOR dem Close geclaimed sein)
        // Guard: on-chain liquidity kann bereits 0 sein (z.B. nach Dust-Entnahme im vorherigen
        // Rebalancing-Versuch) — decreaseLiquidity(0) wirft 0x177c (LiquidityZero).
        // Defensiver Catch: Bei Netzwerk-Congestion kann der RPC-Snapshot veraltet sein
        // (IGNORE_CACHE ignoriert nur den SDK-Cache, nicht stale Validator-Slots). Drei
        // Richtungen des Stale-Read werden unten abgefangen.
        let decreaseTxHash = null;
        // Welche Quote die tatsaechlich gesendete Entnahme beschreibt. Die Stale-Read-
        // Pfade unten rechnen mit frischen Daten neu — fuer die Teilfehlschlag-Meldung
        // (partialExit) muss die Menge aus DERSELBEN Quote stammen wie die gesendete TX,
        // sonst buchte ein Resume erneut die verworfene Schaetzung.
        let effectiveQuote = quote;
        if (!posData.liquidity.isZero()) {
            await rpcLimiter.wait();
            try {
                const decreaseTx = await position.decreaseLiquidity(quote);
                decreaseTxHash = await sendLeg('exit_decrease', decreaseTx, `decreaseLiquidity NFT=${positionNftMint}`);
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
                        // Preisband-Variante wie die Haupt-Quote oben — sonst bräche der
                        // Stale-Read-Retry an genau der Mix-Verschiebung ab, die ihn ausgelöst hat.
                        const freshQuote = decreaseLiquidityQuoteUsingPriceSlippage({
                            liquidity:         freshData.liquidity,
                            sqrtPrice:         poolData.sqrtPrice,
                            tickCurrentIndex:  poolData.tickCurrentIndex,
                            tickLowerIndex:    freshData.tickLowerIndex,
                            tickUpperIndex:    freshData.tickUpperIndex,
                            slippageTolerance: DEFAULT_SLIPPAGE,
                            tokenExtensionCtx: tokenExtCtx,
                        });
                        effectiveQuote = freshQuote;
                        await rpcLimiter.wait();
                        const retryTx = await freshPos.decreaseLiquidity(freshQuote);
                        decreaseTxHash = await sendLeg('exit_decrease', retryTx, `retry decreaseLiquidity NFT=${positionNftMint}`);
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

        // 🔒 Teilfehlschlag kenntlich machen (LIQ#0312).
        //
        // Ist decreaseLiquidity gelandet und scheitert danach der Burn, liegt echtes
        // Kapital bereits im Wallet — die Position ist leer, das NFT aber noch da.
        // Fuer den Aufrufer sah das bis 2026-08-22 aus wie jeder andere Exit-Fehler:
        // gleiche Exception, gleiche Meldung, kein Hinweis darauf, dass Coins bewegt
        // wurden. Ein Resume startete deshalb den Withdraw von vorn, fand on-chain 0
        // Liquiditaet und buchte den Erloes als ~0 (Pos 336: 11,34 statt ~996 USDC).
        //
        // Deshalb: die Mengen der gesendeten Entnahme an den Fehler haengen, damit der
        // Aufrufer sie persistieren kann statt sie beim naechsten Versuch neu zu raten.
        const withPartialExit = (err) => {
            if (!decreaseTxHash) return err;   // nichts gesendet → sauberer Abbruch
            err.partialExit = {
                decreaseTxHash,
                // tokenEst, NICHT tokenMin — siehe Begründung am return unten.
                amountA: fromRawAmount(effectiveQuote.tokenEstA, pool.decimalsA),
                amountB: fromRawAmount(effectiveQuote.tokenEstB, pool.decimalsB),
            };
            return err;
        };

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
        // Aeusserer Rahmen nur fuer withPartialExit(): auch die Stale-Read-Retries
        // im inneren catch senden ggf. noch ein decreaseLiquidity und koennen danach
        // scheitern — dieser Fall muss denselben Teilfehlschlag-Marker tragen.
        try {
            try {
                const burnTx = new TransactionBuilder(this._ctx.connection, this._ctx.wallet, this._ctx.txBuilderOpts)
                    .addInstruction(burnIx);
                burnTxHash = await sendLeg('exit_burn', burnTx, `closePositionIx NFT=${positionNftMint}`);
                console.log(`[orca] Position-NFT geburnt (Rent zurück): TX=${burnTxHash}`);
            } catch (err) {
                // Stale read (Fall 2): posData zeigte liquidity=0, on-chain hat sie noch Liquidität.
                // Stale read (Fall 4, LIQ#0322): closePositionIx nimmt selbst keine Liquiditätsdaten
                // entgegen — 0x177f hier bedeutet nicht "zu viel entnommen" (das faengt der
                // decreaseLiquidity-Zweig oben ab), sondern dass der vorangegangene decreaseLiquidity
                // bereits gelandet ist und der Validator-Snapshot fuer die Simulation dieser TX nur
                // noch nicht nachgezogen hat. In allen 17 beobachteten Faellen (23.08.–30.08.2026)
                // war decreaseTxHash zu diesem Zeitpunkt schon gesetzt — die Liquiditaet ist also
                // vermutlich schon 0, es fehlt nur ein frischer Read vor dem Retry. Deshalb dieselbe
                // Behandlung wie bei 0x1775: frische Daten holen, bei echtem Rest zur Sicherheit noch
                // abziehen, dann den Burn erneut senden.
                if (/0x1775|ClosePositionNotEmpty|0x177f|LiquidityUnderflow/i.test(err.message)) {
                    const code = /0x1775|ClosePositionNotEmpty/i.test(err.message) ? '0x1775' : '0x177f';
                    console.log(`[orca] closePositionIx ${code} (stale read) – hole frische Daten: NFT=${positionNftMint}`);
                    await rpcLimiter.wait();
                    const freshPos  = await client.getPosition(posPda.publicKey, IGNORE_CACHE);
                    const freshData = freshPos.getData();
                    if (!freshData.liquidity.isZero()) {
                        // Preisband-Variante wie die Haupt-Quote oben — sonst bräche der
                        // Stale-Read-Retry an genau der Mix-Verschiebung ab, die ihn ausgelöst hat.
                        const freshQuote = decreaseLiquidityQuoteUsingPriceSlippage({
                            liquidity:         freshData.liquidity,
                            sqrtPrice:         poolData.sqrtPrice,
                            tickCurrentIndex:  poolData.tickCurrentIndex,
                            tickLowerIndex:    freshData.tickLowerIndex,
                            tickUpperIndex:    freshData.tickUpperIndex,
                            slippageTolerance: DEFAULT_SLIPPAGE,
                            tokenExtensionCtx: tokenExtCtx,
                        });
                        effectiveQuote = freshQuote;
                        await rpcLimiter.wait();
                        const retryTx = await freshPos.decreaseLiquidity(freshQuote);
                        decreaseTxHash = await sendLeg('exit_decrease', retryTx, `retry decreaseLiquidity NFT=${positionNftMint}`);
                        console.log(`[orca] Retry decreaseLiquidity OK: NFT=${positionNftMint} TX=${decreaseTxHash}`);
                    }
                    await rpcLimiter.wait();
                    const retryBurnTx = new TransactionBuilder(this._ctx.connection, this._ctx.wallet, this._ctx.txBuilderOpts)
                        .addInstruction(burnIx);
                    burnTxHash = await sendLeg('exit_burn', retryBurnTx, `retry closePositionIx NFT=${positionNftMint}`);
                    console.log(`[orca] Retry closePositionIx OK: TX=${burnTxHash}`);
                } else {
                    throw err;
                }
            }
        } catch (err) {
            throw withPartialExit(err);
        }

        // 🔒 tokenEst, NICHT tokenMin (Fix 2026-08-23).
        //
        // `tokenMinA/B` ist der On-Chain-SCHUTZPARAMETER („mindestens so viel muss
        // herauskommen, sonst brich ab") = tokenEst × 100/101 bei DEFAULT_SLIPPAGE = 1 %.
        // Es ist NICHT das Ergebnis der Entnahme. Wer ihn als Ergebnis zurückgibt, meldet
        // bei JEDEM Exit exakt 0,990 % zu wenig — auf beiden Token, unabhängig vom Markt.
        //
        // Folgekette bis zum Fund am 23.08.2026: exit-finalizer.js bildet daraus coinsA/coinsB,
        // executeSwapStep() deckelt den Verkauf per capToPosition() auf genau diese Zahl →
        // rund 1 % jeder Position wurde nie verkauft, blieb im volatilen Token liegen und
        // wurde als Erlös zu niedrig gebucht. Ein Trailing Stop mit 0,5 % Drawdown realisierte
        // dadurch ~1,5 %. Belegt an Exit #75 (PUMP/SOL) und #73 (Fartcoin/SOL): gemessene
        // On-Chain-Mengen zu gemeldeten = 0,990100 bzw. 0,990098 — 100/101 auf sechs
        // Nachkommastellen, auf beiden Legs. Die tatsächlichen Swap-Kosten lagen bei 0,015 %.
        //
        // `effectiveQuote` statt `quote`: Die Stale-Read-Pfade oben senden die Entnahme mit
        // einer NEU berechneten Quote. Der Rückgabewert muss aus derselben Quote stammen wie
        // die tatsächlich gesendete TX — sonst meldet ein 0x177f-Retry die Mengen der
        // verworfenen (größeren) Quote. Dieselbe Regel gilt schon für withPartialExit() oben.
        return {
            amountA: fromRawAmount(effectiveQuote.tokenEstA, pool.decimalsA),
            amountB: fromRawAmount(effectiveQuote.tokenEstB, pool.decimalsB),
            txHash: decreaseTxHash ?? burnTxHash,
            // Beide Legs einzeln: gebucht wird nur `txHash`, aber der Abgleich in
            // lib/capital-reconcile.js muss auch das andere Leg zuordnen können
            // (lib/chain-tx-log.js). Setzt ein Resume den Exit fort, ist das
            // kapitalbewegende Decrease sogar aus einem FRÜHEREN Durchlauf und
            // taucht hier gar nicht mehr auf — deshalb wird es dort protokolliert,
            // wo es gesendet wird, nicht erst hier.
            txHashes: { decrease: decreaseTxHash, burn: burnTxHash },
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

        // IGNORE_CACHE an beiden Reads: Position (Liquidität vor dem Fluss) und Pool-Preis
        // müssen den Stand *jetzt* zeigen. Ohne das rechnete die Quote hier mit dem Pool-Stand
        // von vor dem eigenen Pre-Swap — Befund 2026-08-22 (siehe readLiquidityLegsFromTx).
        await rpcLimiter.wait();
        const position = await client.getPosition(posPda.publicKey, IGNORE_CACHE);
        const posData  = position.getData();

        // Whirlpool-Daten laden für Quote-Berechnung
        await rpcLimiter.wait();
        const whirlpoolPubkey = posData.whirlpool;
        const whirlpool       = await client.getPool(whirlpoolPubkey, IGNORE_CACHE);
        const poolData        = whirlpool.getData();
        const tokenExtCtx     = await buildPoolTokenExtCtx(this._ctx, poolData);

        // Fix 2: Dynamischer Anker-Token — beide Quotes berechnen, bindenden Engpass wählen.
        // Verhindert InsufficientFunds (0x1) wenn ein Token fast leer ist.
        const quoteB = increaseLiquidityQuoteByInputToken(
            new PublicKey(pool.tokenB), new Decimal(amountB),
            posData.tickLowerIndex, posData.tickUpperIndex,
            slippage, whirlpool, tokenExtCtx,
        );
        const quoteA = increaseLiquidityQuoteByInputToken(
            new PublicKey(pool.tokenA), new Decimal(amountA),
            posData.tickLowerIndex, posData.tickUpperIndex,
            slippage, whirlpool, tokenExtCtx,
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

        // Ist-Werte aus der bestätigten Transaktion (Vault-Deltas), Quote nur als Fallback.
        // Kein client.getPosition() Re-Read: der liefe in den 10-s-Proxy-Cache und zeigte die
        // alte Liquidität — genau der Wert, der hier *nicht* als Referenz dienen darf.
        const quoteEstA = fromRawAmount(quote.tokenEstA, pool.decimalsA);
        const quoteEstB = fromRawAmount(quote.tokenEstB, pool.decimalsB);
        const legs   = await readLiquidityLegsFromTx(
            this._ctx.connection, txHash, pool, posData.tickLowerIndex, posData.tickUpperIndex,
        );
        const actualA       = legs?.amountA ?? quoteEstA;
        const actualB       = legs?.amountB ?? quoteEstB;
        const liquidityAdd  = legs ? new BN(legs.liquidity) : quote.liquidityAmount;
        const addedLiquidity = posData.liquidity.add(liquidityAdd).toString();

        console.log(
            `[orca] Liquidität erhöht: +${actualA.toFixed(6)} TokenA / +${actualB.toFixed(2)} TokenB` +
            (legs
                ? ` (on-chain; Quote war ${quoteEstA.toFixed(6)} / ${quoteEstB.toFixed(2)}, Ausführungspreis ${legs.priceExec.toFixed(6)})`
                : ' (⚠ Quote-Werte – Transaktion nicht lesbar, Ist-Mengen unbekannt)') +
            ` TX=${txHash}`
        );

        return {
            addedLiquidity, txHash,
            tokenEstA: actualA, tokenEstB: actualB,           // = Ist-Mengen, Name aus Kompatibilität
            quoteA: quoteEstA, quoteB: quoteEstB,
            liquidityBefore: posData.liquidity.toString(),
            liquidityAdded:  liquidityAdd.toString(),
            tickLower:       posData.tickLowerIndex,
            tickUpper:       posData.tickUpperIndex,
            priceExec:       legs?.priceExec ?? null,
            txFeeSol:        legs?.txFeeSol ?? null,
            measured:        !!legs,
        };
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
            settle(client.getPool(new PublicKey(pool.address), IGNORE_CACHE)),
            settle(client.getPosition(posPda.publicKey, IGNORE_CACHE)),
        ]);

        const poolData = whirlpool.getData();
        const posData  = position.getData();
        const tokenExtCtx = await buildPoolTokenExtCtx(this._ctx, poolData);

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

        // Preisband-Variante + tokenEst statt tokenMin — dieselbe Begründung wie in
        // closePosition() (Fix 2026-08-23). Hier wiegt der Mengenabschlag sogar schwerer:
        // Die zurückgegebenen Mengen sind für bin/withdraw.js die Grundlage von
        // insertCapitalFlow(), updatePositionHodl(), dem Snapshot-Delta und der
        // Transaktionsbuchung. Ein um 1 % zu niedriger Abfluss verfälscht damit den PnL und
        // skaliert über rebaseHwmForCapitalFlow() sogar die Trailing-Stop-Referenz falsch.
        const quote = decreaseLiquidityQuoteUsingPriceSlippage({
            liquidity:         liquidityToRemove,
            sqrtPrice:         poolData.sqrtPrice,
            tickCurrentIndex:  poolData.tickCurrentIndex,
            tickLowerIndex:    posData.tickLowerIndex,
            tickUpperIndex:    posData.tickUpperIndex,
            slippageTolerance: slippage,
            tokenExtensionCtx: tokenExtCtx,
        });

        // Welche Quote die tatsächlich gesendete TX beschreibt (analog closePosition()):
        // der 0x1782-Retry unten rechnet mit frischen Pool-Daten neu, und die gemeldeten
        // Mengen müssen aus DERSELBEN Quote stammen wie die gesendete Entnahme.
        let effectiveQuote = quote;

        console.log(
            `[orca] decreaseLiquidity Quote: tokenEstA=${fromRawAmount(quote.tokenEstA, pool.decimalsA).toFixed(6)}` +
            ` tokenEstB=${fromRawAmount(quote.tokenEstB, pool.decimalsB).toFixed(6)}` +
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
            const retryQuote    = decreaseLiquidityQuoteUsingPriceSlippage({
                liquidity:         liquidityToRemove,
                sqrtPrice:         freshPoolData.sqrtPrice,
                tickCurrentIndex:  freshPoolData.tickCurrentIndex,
                tickLowerIndex:    posData.tickLowerIndex,
                tickUpperIndex:    posData.tickUpperIndex,
                slippageTolerance: retrySlippage,
                tokenExtensionCtx: tokenExtCtx,
            });
            effectiveQuote   = retryQuote;
            const freshPos   = await client.getPosition(posPda.publicKey, IGNORE_CACHE);
            const retryTx    = await freshPos.decreaseLiquidity(retryQuote);
            await rpcLimiter.wait();
            txHash = await execTx(retryTx, this._ctx.connection, `retry decreaseLiquidity NFT=${positionNftMint}`);
            console.log(`[orca] Retry decreaseLiquidity OK: NFT=${positionNftMint} TX=${txHash}`);
        }

        const estA = fromRawAmount(effectiveQuote.tokenEstA, pool.decimalsA);
        const estB = fromRawAmount(effectiveQuote.tokenEstB, pool.decimalsB);

        console.log(
            `[orca] Liquidität reduziert: -${estA.toFixed(6)} TokenA / -${estB.toFixed(6)} TokenB TX=${txHash}`
        );

        return { tokenEstA: estA, tokenEstB: estB, fraction, txHash };
    }
}
