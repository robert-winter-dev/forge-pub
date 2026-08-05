/**
 * FORGE LendingBot – Lending Protocol Abstraktions-Layer
 *
 * Alle Protokolle implementieren dasselbe Interface:
 *
 *   getSupplyAPY()                              → number (APY in %)
 *   getPosition(walletAddress)                  → PositionInfo | null
 *   buildDepositTx(walletAddress, amount)       → string (base64 unsigned TX)
 *   buildWithdrawTx(walletAddress, amount)      → WithdrawResult
 *
 * TX-Signing passiert NICHT hier – die CLI-Scripts übernehmen das.
 * (Wallet-Key bleibt in lib/wallet.js, nicht in diesem Modul)
 *
 * Alle API-Calls laufen über die jeweiligen REST-APIs:
 *   Kamino:    https://api.kamino.finance (via FORGE API Proxy)
 *   Jupiter:   https://api.jup.ag (via FORGE API Proxy)
 *   Loopscale: https://api.loopscale.com (via FORGE API Proxy)
 */

import { config } from './config.js';
import { RateLimiter } from './rate-limiter.js';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const KAMINO_API  = config.kamino.apiBase;

/** Standard-Timeout für API-Calls (ms) */
const TIMEOUT_MS = 10_000;

// ─── Hilfsfunktionen ──────────────────────────────────────────────────────────

async function apiFetch(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} – ${url}\n${body.slice(0, 200)}`);
        }
        return await res.json();
    } finally {
        clearTimeout(timer);
    }
}

async function apiPost(url, body, extraHeaders = {}) {
    return apiFetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body:    JSON.stringify(body),
    });
}

// ─── Kamino Finance ───────────────────────────────────────────────────────────

/**
 * Kamino USDC Lending Pool.
 *
 * Yield akkumuliert automatisch (kein expliziter Claim).
 * Withdraw ist sofort möglich (1 TX).
 * Aktueller USDC Supply APY: ~1.4% (dynamisch, stündlich prüfen).
 */
export class KaminoProtocol {
    /**
     * @param {object} [opts]
     * @param {string} [opts.name]        – Protokoll-ID (z.B. 'kamino', 'kamino-figure')
     * @param {string} [opts.label]       – Anzeigename (z.B. 'Kamino Figure')
     * @param {string} [opts.market]      – Kamino Lending Market Adresse
     * @param {string} [opts.usdcReserve] – USDC Reserve Adresse in diesem Markt
     */
    constructor(opts = {}) {
        this.market      = opts.market      ?? config.kamino.market;
        this.usdcReserve = opts.usdcReserve ?? config.kamino.usdcReserve;
        this.poolType    = 'lending';
        this.name        = opts.name        ?? 'kamino';
        this.label       = opts.label       ?? 'Kamino';
        this.asset       = 'USDC';
        // Rate-Limiting zentral durch FORGE API Proxy (127.0.0.1:3100/kamino)
    }

    /**
     * APY und TVL in einem API-Call abfragen.
     * @returns {Promise<{apy: number, tvl: number|null}>}
     */
    async getPoolStats() {
        const url  = `${KAMINO_API}/kamino-market/${this.market}/reserves/metrics`;
        const data = await apiFetch(url);

        const usdc = data.find(r =>
            r.liquidityToken === 'USDC' ||
            r.reserve === this.usdcReserve
        );
        if (!usdc) throw new Error('Kamino: USDC Reserve nicht in API-Antwort gefunden');

        const apy = parseFloat(usdc.supplyApy) * 100; // 0.01356 → 1.356 %
        // TVL: totalSupply ist in USDC (nicht Lamports)
        const tvlRaw = usdc.totalSupply ?? usdc.supplyAmount ?? usdc.liquidityAmount ?? null;
        const tvl = tvlRaw != null ? parseFloat(tvlRaw) || null : null;

        return { apy, tvl };
    }

    /**
     * Aktuellen USDC Supply APY von der Kamino REST API abfragen.
     * @returns {Promise<number>} APY in Prozent (z.B. 1.36)
     */
    async getSupplyAPY() {
        const { apy } = await this.getPoolStats();
        return apy;
    }

    /**
     * Aktive Position für eine Wallet abfragen.
     * Gibt null zurück wenn keine Position existiert.
     *
     * @param {string} walletAddress  Base58 Solana Wallet
     * @returns {Promise<PositionInfo|null>}
     */
    async getPosition(walletAddress) {
        const url  = `${KAMINO_API}/kamino-market/${this.market}/users/${walletAddress}/obligations`;
        const data = await apiFetch(url);

        if (!Array.isArray(data) || data.length === 0) return null;

        // Erste Vanilla Obligation (keine Leveraged Position)
        const obligation = data[0];

        // Aktueller USDC-Wert aus refreshedStats (bereits in USDC, nicht in kTokens)
        // obligation.deposits ist ein leeres Objekt {} – nicht nutzbar für Wertabfrage
        const currentAmount = parseFloat(obligation.refreshedStats?.userTotalDeposit ?? 0);

        if (!currentAmount) return null;

        return {
            protocol:        this.name,
            poolType:        this.poolType,
            asset:           'USDC',
            amount:          currentAmount,
            // Kamino akkumuliert Yield automatisch (steigende cToken-Kurse) – kein Claim nötig
            interestEarned:  null,
            maxWithdrawable: currentAmount,
            raw:             obligation,
        };
    }

    /**
     * Unsigned Deposit-Transaktion bauen.
     * @param {string} walletAddress  Base58
     * @param {number} amount         USDC-Betrag
     * @returns {Promise<string>}     base64-codierte unsigned TX
     */
    async buildDepositTx(walletAddress, amount) {
        const data = await apiPost(`${KAMINO_API}/ktx/klend/deposit`, {
            wallet:  walletAddress,
            market:  this.market,
            reserve: this.usdcReserve,
            amount:  String(amount),
        });
        if (!data.transaction) throw new Error('Kamino Deposit: Keine Transaction in API-Antwort');
        return data.transaction;
    }

    /**
     * Unsigned Withdraw-Transaktion bauen.
     * @param {string} walletAddress  Base58
     * @param {number|'all'} amount   USDC-Betrag oder 'all' für vollständigen Withdraw
     * @returns {Promise<WithdrawResult>}
     */
    async buildWithdrawTx(walletAddress, amount) {
        const amountStr = String(amount);

        const data = await apiPost(`${KAMINO_API}/ktx/klend/withdraw`, {
            wallet:  walletAddress,
            market:  this.market,
            reserve: this.usdcReserve,
            amount:  amountStr,
        });
        if (!data.transaction) throw new Error('Kamino Withdraw: Keine Transaction in API-Antwort');

        return {
            type:        'immediate',
            transaction: data.transaction,
        };
    }
}


// ─── Jupiter Lend ─────────────────────────────────────────────────────────────

/**
 * Jupiter Lend USDC Lending Pool.
 *
 * Yield akkumuliert automatisch (kein expliziter Claim).
 * Withdraw ist sofort möglich (1 TX, kein Cooldown).
 * Aktueller USDC Supply APY: ~3–13% (dynamisch, marktabhängig).
 */
export class JupiterLendProtocol {
    constructor() {
        this.name     = 'jupiter';
        this.label    = 'Jupiter Lend';
        this.asset    = 'USDC';
        this.poolType = 'lending';
        this.usdcMint = config.jupiter.usdcMint;
        // @jup-ag/lend Client – wird lazy initialisiert (ESM import)
        this._client  = null;
        // Rate-Limiter: konservativ 48 req/min (20% unter 1 RPS free tier)
        this.limiter  = new RateLimiter('jupiter', 48);
    }

    async _getClient() {
        if (!this._client) {
            const { Client } = await import('@jup-ag/lend/api');
            this._client = new Client(
                config.jupiter.apiKey ? { apiKey: config.jupiter.apiKey } : {},
            );
        }
        return this._client;
    }

    /** USDC-Token-Info aus der Jupiter Earn API holen. */
    async _getUsdcToken() {
        await this.limiter.wait();
        const client = await this._getClient();
        const tokens = await client.earn.getTokens();
        const usdc = tokens.find(t => t.assetAddress === this.usdcMint);
        if (!usdc) throw new Error('Jupiter: USDC nicht in Token-Liste gefunden');
        return usdc;
    }

    /**
     * Aktuellen USDC Supply APY abfragen.
     * totalRate = supplyRate + rewardsRate (beide in BPS, 100 BPS = 1%)
     * @returns {Promise<number>} APY in Prozent
     */
    async getSupplyAPY() {
        const usdc = await this._getUsdcToken();
        return usdc.totalRate / 100;
    }

    /**
     * APY + TVL in einem Call.
     * @returns {Promise<{apy: number, tvl: number}>}
     */
    async getPoolStats() {
        const usdc = await this._getUsdcToken();
        return {
            apy: usdc.totalRate / 100,
            tvl: parseInt(usdc.totalAssets) / 1e6,  // Lamports → USDC
        };
    }

    /**
     * Aktive USDC-Position für eine Wallet abfragen.
     *
     * client.earn.getPositions() liefert leider immer [] zurück (API-Bug).
     * Stattdessen: jlUSDC-Token-Balance direkt via RPC lesen +
     * Exchange Rate (convertToAssets) aus getTokens() berechnen.
     *
     * @param {string} walletAddress  Base58
     * @returns {Promise<PositionInfo|null>}
     */
    async getPosition(walletAddress) {
        const { Connection, PublicKey } = await import('@solana/web3.js');
        const connection = new Connection(config.rpcUrl, { commitment: 'confirmed', wsEndpoint: process.env.HELIUS_WS_URL || undefined });

        // 1) jlUSDC-Token-Info + Exchange Rate aus API holen
        const usdc = await this._getUsdcToken();            // enthält convertToAssets + address (= jlUSDC Mint)
        const jlMint = usdc.address;                        // z.B. 9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D
        const rate   = parseInt(usdc.convertToAssets ?? 1000000); // USDC-Lamports pro 1M jlUSDC-Shares

        // 2) jlUSDC-Balance direkt via RPC lesen
        const walletPubkey = new PublicKey(walletAddress);
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
            walletPubkey,
            { mint: new PublicKey(jlMint) },
        );
        if (tokenAccounts.value.length === 0) return null;

        const rawShares = parseInt(
            tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount ?? '0',
        );
        if (rawShares <= 0) return null;

        // 3) jlUSDC-Shares → USDC: shares * (rate / 1e6) / 1e6
        //    rate = USDC-Lamports pro 1.000.000 jlUSDC-Shares → alles in Lamports
        const amount = (rawShares * rate) / 1e12;
        if (amount <= 0) return null;

        return {
            protocol:        this.name,
            poolType:        this.poolType,
            asset:           'USDC',
            amount,
            interestEarned:  null,
            maxWithdrawable: amount,
            raw:             { jlMint, rawShares, rate },
        };
    }

    /**
     * Deposit-TX bauen via @jup-ag/lend SDK.
     * @param {string} walletAddress  Base58
     * @param {number} amount         USDC-Betrag
     * @returns {Promise<string>}     base64-kodierte unsigned Transaction
     */
    async buildDepositTx(walletAddress, amount) {
        const { getDepositIxs }                       = await import('@jup-ag/lend/earn');
        const BN                                       = (await import('bn.js')).default;
        const { PublicKey, Connection, Transaction }   = await import('@solana/web3.js');

        const walletPubkey = new PublicKey(walletAddress);
        const connection   = new Connection(config.rpcUrl, { commitment: 'confirmed', wsEndpoint: process.env.HELIUS_WS_URL || undefined });
        const amountBN     = new BN(Math.round(amount * 1e6));

        await this.limiter.wait();
        const { ixs } = await getDepositIxs({
            amount:     amountBN,
            asset:      new PublicKey(this.usdcMint),
            signer:     walletPubkey,
            connection,
        });

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction({ recentBlockhash: blockhash, feePayer: walletPubkey });
        tx.add(...ixs);

        return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64');
    }

    /**
     * Withdraw-TX bauen via @jup-ag/lend SDK.
     * @param {string}        walletAddress  Base58
     * @param {number|'all'}  amount         USDC-Betrag oder 'all'
     * @returns {Promise<WithdrawResult>}
     */
    async buildWithdrawTx(walletAddress, amount) {
        const { getWithdrawIxs, getRedeemIxs }        = await import('@jup-ag/lend/earn');
        const BN                                       = (await import('bn.js')).default;
        const { PublicKey, Connection, Transaction }   = await import('@solana/web3.js');

        const walletPubkey = new PublicKey(walletAddress);
        const connection   = new Connection(config.rpcUrl, { commitment: 'confirmed', wsEndpoint: process.env.HELIUS_WS_URL || undefined });

        let ixs;
        if (amount === 'all') {
            // Vollständiger Withdraw: getRedeemIxs mit Share-Anzahl verwenden.
            // getWithdrawIxs erwartet USDC-Lamports → bei rawShares als Argument
            // kommt es zu "insufficient funds" (0x1), da Shares ≠ USDC-Lamports.
            // getRedeemIxs ruft program.methods.redeem(shares) auf → korrekt.
            const pos = await this.getPosition(walletAddress);
            if (!pos) throw new Error('Jupiter: Keine aktive USDC-Position gefunden');
            const sharesBN = new BN(pos.raw.rawShares);
            await this.limiter.wait();
            ({ ixs } = await getRedeemIxs({
                shares:     sharesBN,
                asset:      new PublicKey(this.usdcMint),
                signer:     walletPubkey,
                connection,
            }));
        } else {
            const amountBN = new BN(Math.round(Number(amount) * 1e6));
            await this.limiter.wait();
            ({ ixs } = await getWithdrawIxs({
                amount:     amountBN,
                asset:      new PublicKey(this.usdcMint),
                signer:     walletPubkey,
                connection,
            }));
        }

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        const tx = new Transaction({ recentBlockhash: blockhash, feePayer: walletPubkey });
        tx.add(...ixs);

        return {
            type:        'immediate',
            transaction: Buffer.from(tx.serialize({ requireAllSignatures: false })).toString('base64'),
        };
    }
}

// ─── Drift ────────────────────────────────────────────────────────────────────

// DEAKTIVIERT 2026-04-02: Drift-Exploit ~$270M, Protokoll pausiert
// const DRIFT_PROGRAM_ID = config.drift.programId;
// const DRIFT_USDC_MINT  = config.drift.usdcMint;

/**
 * Drift Protocol – USDC Lending (on-chain)
 *
 * Drift ist ein dezentralisiertes Protokoll auf Solana.
 * Keine REST-API-Limits – nutzt Solana RPC direkt (on-chain).
 * Yield akkumuliert automatisch (kein expliziter Claim nötig).
 *
 * Erster Deposit: UserAccount wird automatisch initialisiert (einmalig ~0,04 SOL).
 * Withdraw:       Sofort (kein Cooldown).
 * USDC APY:       Variable, typisch 5–16% je nach Borrowing-Nachfrage.
 */
export class DriftProtocol {
    constructor() {
        this.name            = 'drift';
        this.label           = 'Drift';
        this.asset           = 'USDC';
        this.poolType        = 'lending';
        this.usdcMarketIndex = config.drift.usdcMarketIndex; // 0
        // Kein lokaler RateLimiter – Drift ist on-chain (Solana RPC).
        // RPC-Calls sind durch den Provider rate-limitiert, nicht durch Drift selbst.
    }

    /** Erstellt einen DriftClient mit read-only Dummy-Wallet (kein Keypair nötig). */
    async _createClient(walletAddress) {
        const { DriftClient } = await import('@drift-labs/sdk');
        const { Connection, PublicKey } = await import('@solana/web3.js');

        const connection = new Connection(config.rpcUrl, { commitment: 'confirmed', wsEndpoint: process.env.HELIUS_WS_URL || undefined });

        return new DriftClient({
            connection,
            wallet: {
                publicKey:           new PublicKey(walletAddress),
                signTransaction:     async (tx) => tx,  // no-op: Signing in wallet.js
                signAllTransactions: async (txs) => txs,
            },
            programID: new PublicKey(DRIFT_PROGRAM_ID),
            // WebSocket-Subscription: keine Batch-Requests (kompatibel mit Free-Tier RPC)
            accountSubscription: { type: 'websocket' },
        });
    }

    /**
     * APY und TVL in einem on-chain Call abfragen.
     * TVL = Gesamte USDC-Deposits im SpotMarket (Index 0).
     * @returns {Promise<{apy: number, tvl: number|null}>}
     */
    async getPoolStats() {
        const {
            calculateDepositRate,
            SPOT_MARKET_RATE_PRECISION,
            SPOT_MARKET_BALANCE_PRECISION,
            SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION,
        } = await import('@drift-labs/sdk');

        // System-Programm PublicKey als Dummy (read-only, kein User-Account nötig)
        const client = await this._createClient('11111111111111111111111111111112');
        try {
            await client.subscribe();
            const spotMarket = client.getSpotMarketAccount(this.usdcMarketIndex);
            if (!spotMarket) throw new Error('Drift: USDC SpotMarket nicht geladen');

            // APY
            const depositRate = calculateDepositRate(spotMarket);
            const apy = depositRate.toNumber() / SPOT_MARKET_RATE_PRECISION.toNumber() * 100;

            // TVL: depositBalance × cumulativeDepositInterest / (BALANCE_PREC × CUMULATIVE_PREC)
            // Ergebnis ist direkt in USDC (SpotBalanceType-Enum defekt im SDK-Export, daher manuell)
            let tvl = null;
            try {
                const bal  = BigInt(spotMarket.depositBalance.toString());
                const cum  = BigInt(spotMarket.cumulativeDepositInterest.toString());
                const bprec = BigInt(SPOT_MARKET_BALANCE_PRECISION.toString());
                const cprec = BigInt(SPOT_MARKET_CUMULATIVE_INTEREST_PRECISION.toString());
                tvl = Number(bal * cum / (bprec * cprec));
            } catch (_) {
                // TVL optional – nicht werfen
            }

            return { apy, tvl };
        } finally {
            await client.unsubscribe();
        }
    }

    /**
     * Aktuellen USDC Deposit-APY von Drift abfragen.
     * Delegiert an getPoolStats() um einen doppelten on-chain Call zu vermeiden.
     * @returns {Promise<number>} APY in Prozent (z.B. 8.34)
     */
    async getSupplyAPY() {
        const { apy } = await this.getPoolStats();
        return apy;
    }

    /**
     * Aktive USDC-Position für eine Wallet abfragen.
     * Gibt null zurück wenn kein Drift-Account oder keine USDC-Position existiert.
     * @param {string} walletAddress  Base58 Solana Wallet
     * @returns {Promise<PositionInfo|null>}
     */
    async getPosition(walletAddress) {
        const { getTokenAmount, SpotBalanceType, getUserAccountPublicKey } =
            await import('@drift-labs/sdk');
        const { PublicKey, Connection } = await import('@solana/web3.js');

        const walletPubkey = new PublicKey(walletAddress);
        const client = await this._createClient(walletAddress);
        try {
            await client.subscribe();

            // Prüfen ob Drift-Account on-chain existiert (bevor wir versuchen zu laden)
            const connection    = new Connection(config.rpcUrl, { commitment: 'confirmed', wsEndpoint: process.env.HELIUS_WS_URL || undefined });
            const userAccountPk = await getUserAccountPublicKey(
                client.program.programId, walletPubkey, 0,
            );
            const accountInfo = await connection.getAccountInfo(userAccountPk);
            if (!accountInfo) return null; // Kein Drift-Account für diese Wallet

            await client.addUser(0, walletPubkey);
            const user = client.getUser(0, walletPubkey);
            if (!user) return null;
            await user.subscribe();

            const spotPosition = user.getSpotPosition(this.usdcMarketIndex);
            if (!spotPosition || spotPosition.scaledBalance.isZero()) return null;

            const spotMarket    = client.getSpotMarketAccount(this.usdcMarketIndex);
            const tokenAmountBN = getTokenAmount(
                spotPosition.scaledBalance,
                spotMarket,
                SpotBalanceType.DEPOSIT,
            );
            const amount = tokenAmountBN.toNumber() / 1e6; // USDC = 6 Dezimalstellen
            if (amount <= 0) return null;

            return {
                protocol:        this.name,
                poolType:        this.poolType,
                asset:           'USDC',
                amount,
                interestEarned:  null, // Yield sichtbar als wachsender tokenAmount
                maxWithdrawable: amount,
                raw:             spotPosition,
            };
        } finally {
            await client.unsubscribe();
        }
    }

    /**
     * Unsigned Deposit-Transaktion bauen.
     * Beim ersten Deposit wird der Drift-UserAccount automatisch in derselben TX
     * initialisiert (spart einen separaten TX + Fees).
     *
     * @param {string} walletAddress  Base58
     * @param {number} amount         USDC-Betrag
     * @returns {Promise<string>}     base64-codierte unsigned TX
     */
    async buildDepositTx(walletAddress, amount) {
        const { BN, getUserAccountPublicKey } = await import('@drift-labs/sdk');
        const { PublicKey, Connection }       = await import('@solana/web3.js');
        const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');

        const walletPubkey           = new PublicKey(walletAddress);
        const associatedTokenAccount = getAssociatedTokenAddressSync(
            new PublicKey(DRIFT_USDC_MINT), walletPubkey,
        );
        const amountBN = new BN(Math.round(amount * 1e6)); // USDC = 6 Dezimalstellen

        const client = await this._createClient(walletAddress);
        try {
            await client.subscribe();

            // Prüfen ob Drift-UserAccount bereits existiert
            const connection = new Connection(config.rpcUrl, { commitment: 'confirmed', wsEndpoint: process.env.HELIUS_WS_URL || undefined });
            const userAccountPk = await getUserAccountPublicKey(
                client.program.programId, walletPubkey, 0,
            );
            const accountInfo = await connection.getAccountInfo(userAccountPk);

            let tx;
            if (!accountInfo) {
                // Erster Deposit: Init + Einzahlung in einer TX
                [tx] = await client.createInitializeUserAccountAndDepositCollateral(
                    amountBN,
                    associatedTokenAccount,
                    this.usdcMarketIndex,
                    0,            // subAccountId
                    'LendingBot', // Name des SubAccounts
                );
            } else {
                // Folgender Deposit
                tx = await client.createDepositTxn(
                    amountBN,
                    this.usdcMarketIndex,
                    associatedTokenAccount,
                );
            }

            return Buffer.from(
                tx.serialize({ requireAllSignatures: false }),
            ).toString('base64');
        } finally {
            await client.unsubscribe();
        }
    }

    /**
     * Unsigned Withdraw-Transaktion bauen.
     * Withdrawals bei Drift sind sofort (kein Cooldown).
     *
     * @param {string}        walletAddress  Base58
     * @param {number|'all'}  amount         USDC-Betrag oder 'all' für kompletten Withdraw
     * @returns {Promise<WithdrawResult>}
     */
    async buildWithdrawTx(walletAddress, amount) {
        const { BN }      = await import('@drift-labs/sdk');
        const { PublicKey } = await import('@solana/web3.js');
        const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');

        const walletPubkey           = new PublicKey(walletAddress);
        const associatedTokenAccount = getAssociatedTokenAddressSync(
            new PublicKey(DRIFT_USDC_MINT), walletPubkey,
        );

        // Betrag ermitteln (bei 'all': aktuelle Position aus Chain lesen)
        let amountBN;
        if (amount === 'all') {
            const pos = await this.getPosition(walletAddress);
            if (!pos) throw new Error('Drift: Keine aktive USDC-Position gefunden');
            amountBN = new BN(Math.round(pos.amount * 1e6));
        } else {
            amountBN = new BN(Math.round(Number(amount) * 1e6));
        }

        const client = await this._createClient(walletAddress);
        try {
            await client.subscribe();
            await client.addUser(0, walletPubkey);

            const withdrawIxs = await client.getWithdrawalIxs(
                amountBN,
                this.usdcMarketIndex,
                associatedTokenAccount,
                false, // reduceOnly
                0,     // subAccountId
            );
            const tx = await client.buildTransaction(withdrawIxs);

            return {
                type:        'immediate',
                transaction: Buffer.from(
                    tx.serialize({ requireAllSignatures: false }),
                ).toString('base64'),
            };
        } finally {
            await client.unsubscribe();
        }
    }
}

// ─── Loopscale ────────────────────────────────────────────────────────────────

const LOOPSCALE_API = config.loopscale.apiBase;

/**
 * Loopscale USDC Lending Vault.
 *
 * Eine Instanz pro Vault (loopscale-onre, loopscale-genesis).
 * Vault-Info (APY, TVL, Position, TX) wird über die Loopscale REST API abgefragt.
 * Transaktionen werden server-seitig als base64 VersionedMessage geliefert und
 * hier in vollständige VersionedTransactions gewrappt (kompatibel mit wallet.js).
 *
 * Kein dokumentiertes Rate-Limit → konservativ 60 req/min (1 req/sec).
 */
export class LoopscaleProtocol {
    /**
     * @param {string} name          – 'loopscale-onre' | 'loopscale-genesis'
     * @param {string} label         – 'Loopscale OnRe' | 'Loopscale Genesis'
     * @param {string} vaultAddress  – Vault PublicKey (base58)
     */
    constructor({ name, label, vaultAddress }) {
        this.name           = name;
        this.label          = label;
        this.vaultAddress   = vaultAddress;
        this.poolType       = 'lending';
        this.asset          = 'USDC';
        this._positionCache = new Map(); // walletAddress → {data, ts}
        // Rate-Limiting zentral durch FORGE API Proxy (127.0.0.1:3100/loopscale)
    }

    /**
     * Vault-Info von der Loopscale API abfragen (APY + TVL in einem Call).
     * @returns {Promise<object>} Rohe Vault-Daten
     */
    async _getVaultInfo() {
        // Loopscale API – bekannte Eigenheiten:
        // 1. Allgemeine Iteration (ohne Filter): liefert ~34 öffentliche Vaults.
        //    Vaults wie Genesis sind dort NICHT enthalten.
        // 2. vaultAddresses-Filter: findet die Vaults (total korrekt), gibt aber bei
        //    pageSize > 1 ein leeres Array zurück (API-Bug). Workaround: pageSize=1,
        //    dann taucht der Vault auf page=1 auf.
        // Strategie: erst allgemein iterieren, bei Miss dann Filter-Fallback.

        const matchAddr = v =>
            v.vault?.address         === this.vaultAddress ||
            v.vault?.vaultIdentifier === this.vaultAddress ||
            v.vaultAddress           === this.vaultAddress ||
            v.address                === this.vaultAddress;

        // ── Schritt 1: allgemeine Iteration ───────────────────────────────────
        const PAGE_SIZE = 10;
        const MAX_PAGES = 5; // 34 Vaults → max. 4 Seiten; 5 als Puffer

        for (let page = 1; page <= MAX_PAGES; page++) {
            const data = await apiPost(`${LOOPSCALE_API}/markets/lending_vaults/info`, {
                page,
                pageSize: PAGE_SIZE,
            });

            // Response: { lendVaults: [...], total: N }
            const vaults = Array.isArray(data) ? data
                : (data.lendVaults ?? data.vaults ?? data.data ?? data.results ?? []);

            if (!Array.isArray(vaults) || vaults.length === 0) break;

            const vault = vaults.find(matchAddr);
            if (vault) return vault;

            // Letzte Seite erreicht?
            const total = data.total ?? 0;
            if (page * PAGE_SIZE >= total) break;
        }

        // ── Schritt 2: Filter-Fallback (für nicht-öffentliche Vaults) ─────────
        // Loopscale API-Bug: vaultAddresses-Filter gibt nur Ergebnisse zurück wenn
        // ≥2 Adressen angegeben werden, die ALLE nicht in der allgemeinen Liste sind.
        // Lösung: this.vaultAddress + config.loopscale.filterCompanionAddress (eine
        // bekannte nicht-öffentliche Adresse) → Server wählt anderen Code-Pfad.
        // Weitere Eigenheiten: pageSize=1 zwingend (höhere Werte → leeres Array).
        const filterAddrs = [
            this.vaultAddress,
            config.loopscale.filterCompanionAddress,
        ];

        for (let page = 1; page <= 3; page++) {
            const data = await apiPost(`${LOOPSCALE_API}/markets/lending_vaults/info`, {
                page,
                pageSize: 1,
                vaultAddresses: filterAddrs,
            });

            const vaults = Array.isArray(data) ? data
                : (data.lendVaults ?? data.vaults ?? data.data ?? data.results ?? []);

            const vault = vaults.find(matchAddr);
            if (vault) return vault;

            const total = data.total ?? 0;
            if (!vaults.length || page >= total) break;
        }

        throw new Error(`${this.label}: Vault nicht in API-Antwort gefunden`);
    }

    /**
     * APY und TVL in einem API-Call abfragen.
     * APY-Format in der Loopscale API: cBPS (100 % = 1.000.000 cBPS).
     * TVL-Format: in Lamports (USDC = 6 Dezimalstellen) oder USDC.
     * @returns {Promise<{apy: number, tvl: number|null}>}
     */
    async getPoolStats() {
        const vault    = await this._getVaultInfo();
        const strategy = vault.vaultStrategy?.strategy;

        // ── APY ──────────────────────────────────────────────────────────────
        // Zwei Vault-Typen mit unterschiedlichen APY-Feldern:
        //
        // Typ A (z.B. USDC Public): interestPerSecond < 100 → direkt der APY in %
        //   Beispiel: interestPerSecond = 7.93 → 7,93 % APY
        //
        // Typ B (z.B. Genesis): interestPerSecond ist eine rohe interne Rate (>>100).
        //   Korrekte Berechnung: gewichteter Durchschnitt der Borrower-APYs aus
        //   vaultStrategy.terms.assetTerms, gewichtet nach currentAllocationAmount.
        //   APY-Einheit in terms: cBPS (10.000 cBPS = 1,00 %)
        let apy;
        const ips = strategy?.interestPerSecond ?? 0;
        if (ips > 0 && ips < 100) {
            // Typ A: interestPerSecond ist direkt der APY in %
            apy = ips;
        } else {
            // Typ B: gewichteter Durchschnitt aus terms.assetTerms
            const assetTerms = vault.vaultStrategy?.terms?.assetTerms ?? {};
            let weightedSum = 0;
            let totalWeight = 0;
            for (const term of Object.values(assetTerms)) {
                // durationAndApys: [[{duration, durationType}, apyCBPS], ...]
                const apyCBPS = term.durationAndApys?.[0]?.[1] ?? 0;
                const weight  = parseFloat(term.allocationInfo?.currentAllocationAmount ?? 0);
                weightedSum  += apyCBPS * weight;
                totalWeight  += weight;
            }
            // cBPS → %: 10.000 cBPS = 1 %
            apy = totalWeight > 0 ? (weightedSum / totalWeight) / 10_000 : 0;
        }

        // ── TVL ──────────────────────────────────────────────────────────────
        // Typ A: externalYieldAmount + currentDeployedAmount = Lender-Kapital (in USDC-μ)
        // Typ B: currentDeployedAmount zählt auch extern besichertes Kapital → überhöht.
        //        externalYieldInfo.balance ist das tatsächliche Lender-Kapital in USDC-μ.
        // Heuristik: wenn (ext+deployed) > 5× externalYieldInfo.balance → Typ B verwenden.
        const extYield    = parseFloat(strategy?.externalYieldAmount ?? 0);
        const deployed    = parseFloat(strategy?.currentDeployedAmount ?? 0);
        const extInfoBal  = parseFloat(vault.vaultStrategy?.externalYieldInfo?.balance ?? 0);
        const standardTvl = (extYield + deployed) / 1e6;
        const tvl = extInfoBal > 0 && standardTvl > (extInfoBal / 1e6) * 5
            ? extInfoBal / 1e6   // Typ B: externalYieldInfo.balance
            : standardTvl;       // Typ A: ext + deployed

        return { apy, tvl };
    }

    /**
     * @returns {Promise<number>} APY in Prozent
     */
    async getSupplyAPY() {
        const { apy } = await this.getPoolStats();
        return apy;
    }

    /**
     * Aktive USDC-Position für eine Wallet abfragen.
     * @param {string} walletAddress  Base58 Solana Wallet
     * @returns {Promise<PositionInfo|null>}
     */
    async getPosition(walletAddress) {
        const CACHE_TTL_MS = 5 * 60 * 1000;
        const cached = this._positionCache.get(walletAddress);
        if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.data;

        const data = await apiPost(
            `${LOOPSCALE_API}/markets/lending_vaults/deposits`,
            { vaultAddresses: [this.vaultAddress] },
            { 'user-wallet': walletAddress },
        );

        // Response: [{vaultAddress, userDeposits: [{userAddress, amountSupplied}]}]
        const vaults = Array.isArray(data) ? data : [data];
        const vaultEntry = vaults.find(v => v.vaultAddress === this.vaultAddress) ?? vaults[0];
        if (!vaultEntry) {
            this._positionCache.set(walletAddress, { data: null, ts: Date.now() });
            return null;
        }

        const userDeposit = (vaultEntry.userDeposits ?? [])
            .find(d => d.userAddress === walletAddress);
        if (!userDeposit) {
            this._positionCache.set(walletAddress, { data: null, ts: Date.now() });
            return null;
        }

        const amountLamports = parseFloat(userDeposit.amountSupplied ?? 0);
        const amount = amountLamports / 1e6;
        if (amount <= 0) {
            this._positionCache.set(walletAddress, { data: null, ts: Date.now() });
            return null;
        }

        const result = {
            protocol:        this.name,
            poolType:        this.poolType,
            asset:           'USDC',
            amount,
            lpAmount:        amountLamports, // Rohbetrag in Lamports – wird für maxAmountLp bei Withdraw benötigt
            interestEarned:  null,           // Loopscale akkumuliert Yield im LP-Token-Kurs
            maxWithdrawable: amount,
            raw:             userDeposit,
        };
        this._positionCache.set(walletAddress, { data: result, ts: Date.now() });
        return result;
    }

    /**
     * Deposit-Transaktion bauen.
     *
     * Die Loopscale API (POST /markets/lending_vaults/deposit) braucht nur user-wallet Header.
     * Response: { transaction: { message: "base64-VersionedMessage", signatures: [{publicKey, signature}] } }
     *
     * Der Server liefert eine teilweise signierte TX (Server-Co-Signaturen bereits drin).
     * Wir bauen die VersionedTransaction mit diesen Signaturen + fügen dann unsere hinzu.
     *
     * @param {string} walletAddress  Base58
     * @param {number} amount         USDC-Betrag
     * @returns {Promise<string>}     base64-codierte VersionedTransaction (server co-signiert)
     */
    async buildDepositTx(walletAddress, amount) {
        const principalAmount = Math.round(amount * 1e6); // USDC → Lamports (u64)

        const data = await apiPost(
            `${LOOPSCALE_API}/markets/lending_vaults/deposit`,
            { vault: this.vaultAddress, principalAmount, minLpAmount: 0 },
            { 'user-wallet': walletAddress },
        );

        const txData = data.transaction;
        if (!txData) throw new Error(`${this.label} Deposit: Keine Transaction in API-Antwort`);

        // Response kann string (vollständige TX) oder Objekt {message, signatures} sein
        if (typeof txData === 'string') {
            return await this._wrapTxMessage(txData);
        }

        const messageBase64 = txData.message ?? txData.transaction;
        if (!messageBase64) throw new Error(`${this.label} Deposit: Keine Message in TX-Antwort`);

        // VersionedTransaction mit Server-Signaturen aufbauen
        const { VersionedTransaction, VersionedMessage } = await import('@solana/web3.js');
        const messageBytes = Buffer.from(messageBase64, 'base64');

        // Prüfen ob es bereits eine vollständige TX ist
        try {
            VersionedTransaction.deserialize(messageBytes);
            return messageBase64;
        } catch { /* nur Message → weiter */ }

        const message = VersionedMessage.deserialize(messageBytes);
        const vTx = new VersionedTransaction(message);

        // Server-Signaturen einsetzen (Loopscale co-signiert als Fee Payer / Authority)
        if (Array.isArray(txData.signatures)) {
            for (const { publicKey, signature } of txData.signatures) {
                if (!signature || !publicKey) continue;
                const idx = message.staticAccountKeys.findIndex(k => k.toBase58() === publicKey);
                if (idx >= 0 && idx < message.header.numRequiredSignatures) {
                    vTx.signatures[idx] = Buffer.from(signature, 'base64');
                }
            }
        }

        return Buffer.from(vTx.serialize()).toString('base64');
    }

    /**
     * Unsigned Withdraw-Transaktion bauen.
     * Withdrawals bei Loopscale sind sofort (kein Cooldown).
     * @param {string}        walletAddress  Base58
     * @param {number|'all'}  amount         USDC-Betrag oder 'all'
     * @returns {Promise<WithdrawResult>}
     */
    async buildWithdrawTx(walletAddress, amount) {
        const isAll = amount === 'all';

        let principalAmount;
        let maxAmountLp;
        if (isAll) {
            const pos = await this.getPosition(walletAddress);
            if (!pos) throw new Error(`${this.label}: Keine aktive Position gefunden`);
            principalAmount = Math.round(pos.amount * 1e6);
            // LP-Token-Betrag direkt aus der API – verhindert MaxAmountInExceeded im Contract
            maxAmountLp = pos.lpAmount ?? principalAmount * 2;
        } else {
            principalAmount = Math.round(Number(amount) * 1e6);
            // Für Teilabhebungen: großzügiger Puffer (2×) als Slippage-Schutz
            maxAmountLp = principalAmount * 2;
        }

        const data = await apiPost(
            `${LOOPSCALE_API}/markets/lending_vaults/withdraw`,
            {
                vault:           this.vaultAddress,
                amountPrincipal: principalAmount,
                maxAmountLp,
                withdrawAll:     isAll,
            },
            { 'user-wallet': walletAddress },
        );

        const txData = data.transaction;
        if (!txData) throw new Error(`${this.label} Withdraw: Keine Transaction in API-Antwort`);

        // Response kann string (vollständige TX) oder Objekt {message, signatures} sein –
        // identisches Format wie beim Deposit, inklusive Server-Co-Signaturen.
        if (typeof txData === 'string') {
            return { type: 'immediate', preserveBlockhash: false, transaction: await this._wrapTxMessage(txData) };
        }

        const messageBase64 = txData.message ?? txData.transaction;
        if (!messageBase64) throw new Error(`${this.label} Withdraw: Keine Message in TX-Antwort`);

        const { VersionedTransaction, VersionedMessage } = await import('@solana/web3.js');
        const messageBytes = Buffer.from(messageBase64, 'base64');

        // Prüfen ob es bereits eine vollständige TX ist
        try {
            VersionedTransaction.deserialize(messageBytes);
            return { type: 'immediate', preserveBlockhash: false, transaction: messageBase64 };
        } catch { /* nur Message → weiter */ }

        const message = VersionedMessage.deserialize(messageBytes);
        const vTx     = new VersionedTransaction(message);

        // Server-Signaturen einsetzen (Loopscale co-signiert – identisch zum Deposit-Flow)
        let hasServerSigs = false;
        if (Array.isArray(txData.signatures)) {
            for (const { publicKey, signature } of txData.signatures) {
                if (!signature || !publicKey) continue;
                const idx = message.staticAccountKeys.findIndex(k => k.toBase58() === publicKey);
                if (idx >= 0 && idx < message.header.numRequiredSignatures) {
                    vTx.signatures[idx] = Buffer.from(signature, 'base64');
                    hasServerSigs = true;
                }
            }
        }

        return {
            type:              'immediate',
            preserveBlockhash: hasServerSigs, // Blockhash nicht überschreiben wenn Server mitgesigned hat
            transaction:       Buffer.from(vTx.serialize()).toString('base64'),
        };
    }

    /**
     * Konvertiert eine base64-Message zu einer vollständigen VersionedTransaction.
     * Die Loopscale API liefert nur die Message (nicht die komplette TX) –
     * wallet.js erwartet eine vollständig serialisierte VersionedTransaction.
     *
     * @param {string} base64  base64-kodierte VersionedMessage oder VersionedTransaction
     * @returns {Promise<string>} base64-kodierte vollständige VersionedTransaction
     */
    async _wrapTxMessage(base64) {
        const { VersionedTransaction, VersionedMessage } = await import('@solana/web3.js');
        const bytes = Buffer.from(base64, 'base64');

        // Erst prüfen ob es schon eine vollständige TX ist
        try {
            VersionedTransaction.deserialize(bytes);
            return base64; // Bereits vollständig – direkt zurückgeben
        } catch {
            // Nur Message → in leere VersionedTransaction wrappen
            const message = VersionedMessage.deserialize(bytes);
            const vTx     = new VersionedTransaction(message);
            return Buffer.from(vTx.serialize()).toString('base64');
        }
    }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Erstellt Protocol-Instanzen basierend auf config.protocols.
 * @returns {Map<string, KaminoProtocol|DriftProtocol|LoopscaleProtocol|JupiterLendProtocol>}
 */
export function createProtocols() {
    const protocols = new Map();
    for (const name of config.protocols) {
        if (name === 'kamino')  protocols.set('kamino',  new KaminoProtocol());
        if (name === 'jupiter') protocols.set('jupiter', new JupiterLendProtocol());
        // if (name === 'drift')   protocols.set('drift',   new DriftProtocol());  // DEAKTIVIERT 2026-04-02

        // Loopscale-Vaults: Schlüssel entspricht dem Vault-Namen in config.loopscale.vaults
        const loopscaleVault = config.loopscale.vaults[name];
        if (loopscaleVault) {
            protocols.set(name, new LoopscaleProtocol({
                name,
                label:        loopscaleVault.label,
                vaultAddress: loopscaleVault.address,
            }));
        }
    }
    return protocols;
}

/**
 * Erstellt eine einzelne Protokoll-Instanz anhand ihres Namens.
 * Wird vom Rebalancer und Auto-Deposit genutzt um auch nicht-aktive Protokolle
 * anzusprechen (z.B. wenn ein neuer Pool als Deposit-Ziel qualifiziert).
 *
 * @param {string} name  Protokoll-Schlüssel (z.B. 'kamino-figure', 'loopscale-onre')
 * @returns {KaminoProtocol|LoopscaleProtocol|DriftProtocol|JupiterLendProtocol}
 * @throws {Error} wenn das Protokoll nicht bekannt ist
 */
export function createProtocolByName(name) {
    if (name === 'kamino')  return new KaminoProtocol();
    if (name === 'jupiter') return new JupiterLendProtocol();
    // if (name === 'drift')   return new DriftProtocol();  // DEAKTIVIERT 2026-04-02

    const kaminoMarket = config.kamino.markets[name];
    if (kaminoMarket) {
        return new KaminoProtocol({
            name,
            label:       kaminoMarket.label,
            market:      kaminoMarket.market,
            usdcReserve: kaminoMarket.reserve,
        });
    }

    const loopscaleVault = config.loopscale.vaults[name];
    if (loopscaleVault) {
        return new LoopscaleProtocol({
            name,
            label:        loopscaleVault.label,
            vaultAddress: loopscaleVault.address,
        });
    }

    throw new Error(`createProtocolByName: Unbekanntes Protokoll '${name}'`);
}

// ─── JSDoc Types ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PositionInfo
 * @property {string}      protocol        – 'kamino' | 'jupiter' | 'loopscale-genesis' | ...
 * @property {string}      poolType        – 'lending' | 'regular' | 'protected'
 * @property {string}      asset           – 'USDC'
 * @property {number}      amount          – Aktueller Wert inkl. Yield
 * @property {number|null} interestEarned  – Kumulierter Yield (null wenn nicht direkt verfügbar)
 * @property {number}      maxWithdrawable – Max. abhebbar (kann kleiner als amount sein)
 * @property {object}      raw             – Rohe API-Antwort
 */

/**
 * @typedef {Object} WithdrawResult
 * @property {'immediate'|'cooldown'|'complete'} type
 * @property {string}   transaction      – base64 unsigned TX
 * @property {number}   [cooldownSeconds] – nur bei type='cooldown'
 */
