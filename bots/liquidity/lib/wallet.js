/**
 * FORGE Liquidity – Wallet
 *
 * Verantwortlichkeiten:
 *   - Keypair aus Datei laden (JSON-Array oder Base58-String)
 *   - Solana-Connection bereitstellen (gecacht)
 *   - SOL- und Token-Balances abfragen
 *   - SOL-Reserve prüfen (wird niemals für LP-Positionen angetastet)
 *
 * Hinweis: Transaktionen für Orca Whirlpools werden über den Whirlpools-SDK
 * signiert — diese Datei stellt das Keypair bereit, signiert aber nicht direkt.
 * Der Private Key verlässt diese Datei nie. Keine Logs mit Key-Inhalten.
 */

import {
    Connection,
    Keypair,
    PublicKey,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { readFileSync }     from 'fs';
import bs58                 from 'bs58';
import { config }           from './config.js';
import { settle }           from './settle-promise.js';

// ─── Konstanten ───────────────────────────────────────────────────────────────

const COMMITMENT = 'confirmed';

// USDC_MINT als String (Wahrheit für SQLite-Bindings, Vergleiche, Jupiter-API).
// USDC_MINT_KEY ist die PublicKey-Variante für Solana-SDK-Calls (RPC, Whirlpools-SDK).
// Hintergrund: vor v0.2.85 war USDC_MINT eine PublicKey-Instanz — das hat zu stummen
// String-Vergleichen (z.B. `pool.tokenA !== USDC_MINT`, immer true) und zu einem
// SQLite-Bind-Crash (08:01-Cleanup-Run) geführt. Siehe doc/CHANGELOG/2026-05-08.md.
export const USDC_MINT     = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_MINT_KEY = new PublicKey(USDC_MINT);

// ─── Keypair laden ────────────────────────────────────────────────────────────

/**
 * Lädt das Keypair aus der in config.keypairPath konfigurierten Datei.
 * Unterstützt:
 *   - Base58-String:  "5Kb8kLf9..."  (Format in FORGE/.tmp/lmining3.txt)
 *   - JSON-Array:     [12, 34, 56, ...]  (Solana CLI Standard)
 *
 * @returns {Keypair}
 */
export function loadKeypair() {
    const filePath = config.keypairPath;
    let raw;
    try {
        raw = readFileSync(filePath, 'utf-8').trim();
    } catch (err) {
        throw new Error(`Keypair-Datei nicht lesbar (${filePath}): ${err.message}`);
    }

    try {
        if (raw.startsWith('[')) {
            return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
        } else {
            return Keypair.fromSecretKey(bs58.decode(raw));
        }
    } catch (err) {
        throw new Error(`Keypair-Format unbekannt (${filePath}): ${err.message}`);
    }
}

// ─── Gecachtes Keypair ────────────────────────────────────────────────────────

let _keypair = null;

/** Gibt das einmal geladene Keypair zurück (lazy, gecacht). */
export function getKeypair() {
    if (!_keypair) _keypair = loadKeypair();
    return _keypair;
}

// ─── Connection ───────────────────────────────────────────────────────────────

let _connection      = null;
let _connectionFresh = null;

/** Gibt die gecachte Connection zum konfigurierten RPC-Endpunkt zurück (/rpc, mit Cache). */
export function getConnection() {
    if (!_connection) {
        _connection = new Connection(config.rpcUrl, {
            commitment:  COMMITMENT,
            wsEndpoint:  process.env.HELIUS_WS_URL || undefined,
        });
    }
    return _connection;
}

/**
 * Gibt eine Connection zurück, die den Cache des Proxys umgeht (/rpc/fresh).
 * Für balance-kritische Calls nach On-Chain-Aktionen (closePosition, collectFees).
 */
export function getConnectionFresh() {
    if (!_connectionFresh) {
        const freshUrl = config.rpcUrl.replace(/\/rpc$/, '/rpc/fresh');
        _connectionFresh = new Connection(freshUrl, { commitment: COMMITMENT });
    }
    return _connectionFresh;
}

// ─── Balance-Abfragen ─────────────────────────────────────────────────────────

/**
 * SOL-Balance einer Wallet in SOL (z.B. 0.42).
 * @param {PublicKey|string} pubkey
 * @returns {Promise<number>}
 */
export async function getSolBalance(pubkey) {
    const key      = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
    const lamports = await getConnection().getBalance(key, COMMITMENT);
    return lamports / LAMPORTS_PER_SOL;
}

/**
 * USDC-Balance einer Wallet (SPL-Token-Account).
 * @param {PublicKey|string} pubkey
 * @returns {Promise<number>}  USDC-Betrag (z.B. 500.00)
 */
export async function getUsdcBalance(pubkey) {
    const key      = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
    const accounts = await getConnection().getParsedTokenAccountsByOwner(key, {
        mint: USDC_MINT_KEY,
    });
    if (accounts.value.length === 0) return 0;
    return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
}

/**
 * Balance eines beliebigen SPL-Tokens.
 * @param {PublicKey|string} walletPubkey
 * @param {PublicKey|string} mintPubkey
 * @param {number}           decimals
 * @returns {Promise<number>}
 */
export async function getTokenBalance(walletPubkey, mintPubkey, decimals) {
    const wallet = typeof walletPubkey === 'string' ? new PublicKey(walletPubkey) : walletPubkey;
    const mint   = typeof mintPubkey   === 'string' ? new PublicKey(mintPubkey)   : mintPubkey;
    const accounts = await getConnection().getParsedTokenAccountsByOwner(wallet, { mint });
    if (accounts.value.length === 0) return 0;
    const raw = accounts.value[0].account.data.parsed.info.tokenAmount.amount;
    return Number(raw) / Math.pow(10, decimals);
}

/**
 * Alle SPL-Token-Balances der Wallet in einem einzigen RPC-Call.
 * Ersetzt N × getTokenBalance()-Aufrufe in Loops (z.B. cleanup.js).
 *
 * @param {PublicKey|string} walletPubkey
 * @returns {Promise<Map<string, number>>}  mint (string) → uiAmount
 */
export async function getAllTokenBalances(walletPubkey) {
    const wallet = typeof walletPubkey === 'string' ? new PublicKey(walletPubkey) : walletPubkey;
    const conn = getConnection();
    const [spl, t22] = await Promise.all([
        settle(conn.getParsedTokenAccountsByOwner(wallet, { programId: TOKEN_PROGRAM_ID })),
        settle(conn.getParsedTokenAccountsByOwner(wallet, { programId: TOKEN_2022_PROGRAM_ID })),
    ]);
    const map = new Map();
    for (const { account } of [...spl.value, ...t22.value]) {
        const info     = account.data.parsed.info;
        const uiAmount = info.tokenAmount.uiAmount ?? 0;
        if (uiAmount > 0) map.set(info.mint, uiAmount);
    }
    return map;
}

/**
 * Cache-bypassing Varianten für balance-kritische Calls nach On-Chain-Aktionen.
 * Verwende diese nach closePosition() oder collectFees(), um stale Cache-Werte
 * zu vermeiden (Proxy /rpc/fresh umgeht den 30 s Balance-Cache).
 */

export async function getTokenBalanceFresh(walletPubkey, mintPubkey, decimals) {
    const wallet = typeof walletPubkey === 'string' ? new PublicKey(walletPubkey) : walletPubkey;
    const mint   = typeof mintPubkey   === 'string' ? new PublicKey(mintPubkey)   : mintPubkey;
    const accounts = await getConnectionFresh().getParsedTokenAccountsByOwner(wallet, { mint });
    if (accounts.value.length === 0) return 0;
    const raw = accounts.value[0].account.data.parsed.info.tokenAmount.amount;
    return Number(raw) / Math.pow(10, decimals);
}

export async function getSolBalanceFresh(pubkey) {
    const key      = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
    const lamports = await getConnectionFresh().getBalance(key, COMMITMENT);
    return lamports / LAMPORTS_PER_SOL;
}

export async function getUsdcBalanceFresh(pubkey) {
    return getTokenBalanceFresh(pubkey, USDC_MINT, 6);
}

export async function getUsableSolBalanceFresh(pubkey) {
    const sol = await getSolBalanceFresh(pubkey);
    return Math.max(0, sol - config.solReserve);
}

/**
 * Gibt den investierbaren USDC-Betrag zurück (Gesamtbalance minus Premium-Reserve).
 * Die Reserve ist für den restlichen Code unsichtbar — analog getUsableSolBalanceFresh.
 * Default-Reserve 0 (config.premiumReserveUsdc) → ohne aktivierte FORGE-public-Premium-
 * Zahlung identisch zu getUsdcBalanceFresh.
 */
export async function getUsableUsdcBalanceFresh(pubkey) {
    const usdc = await getUsdcBalanceFresh(pubkey);
    return Math.max(0, usdc - config.premiumReserveUsdc);
}

// ─── TX-Fee ──────────────────────────────────────────────────────────────────

/**
 * Liest die TX-Fee einer bestätigten Transaktion von der Chain.
 * @param {string} txHash  Transaktionssignatur
 * @returns {Promise<number>}  Fee in SOL (z.B. 0.000005)
 */
export async function getTxFee(txHash) {
    const tx = await getConnection().getTransaction(txHash, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta) return 0;
    return tx.meta.fee / LAMPORTS_PER_SOL;
}

// ─── SOL-Reserve ─────────────────────────────────────────────────────────────

/**
 * Gibt den nutzbaren SOL-Betrag zurück (Gesamtbalance minus Reserve).
 * Die Reserve ist für den restlichen Code unsichtbar — analog SpotGridBot.
 *
 * @param {PublicKey|string} pubkey
 * @returns {Promise<number>}  nutzbares SOL (>= 0)
 */
export async function getUsableSolBalance(pubkey) {
    const balance = await getSolBalance(pubkey);
    return Math.max(0, balance - config.solReserve);
}

/**
 * Prüft ob genug SOL für TX-Fees vorhanden ist.
 * Wirft einen Fehler wenn die Balance unter config.solReserve liegt.
 *
 * NUR für kapitalBINDENDE Operationen (openPosition, increaseLiquidity, Deposit).
 * Dort ist ein Abbruch unter der Reserve richtig: die Reserve existiert, damit im
 * Ernstfall noch ausgestiegen werden kann — neues Kapital zu binden, während dieses
 * Polster fehlt, wäre genau verkehrt.
 *
 * Für kapitalFREIGEBENDE Operationen (closePosition, decreaseLiquidity) NICHT
 * verwenden — dafür assertSufficientSolForExit(). Siehe dort.
 *
 * @param {PublicKey|string} pubkey
 * @throws {Error}
 */
export async function assertSufficientSol(pubkey) {
    const key     = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
    const lamports = await getConnectionFresh().getBalance(key, COMMITMENT);
    const balance  = lamports / LAMPORTS_PER_SOL;
    if (balance < config.solReserve) {
        const err = new Error(
            `Zu wenig SOL für Fees: ${balance.toFixed(4)} SOL` +
            ` (Minimum: ${config.solReserve} SOL). Aktion abgebrochen.`
        );
        err.solBalance = balance;
        throw err;
    }
}

/**
 * Absoluter Boden für kapitalfreigebende Transaktionen (Ausstiege).
 *
 * Deutlich unter config.solReserve (0,1 SOL) — bewusst. Ein Close kostet ~0,00001–
 * 0,0005 SOL Fee und gibt Rent zurück (Position-Account + NFT), die SOL-Balance
 * steigt danach in aller Regel. Der Wert deckt Fee + einmalige ATA-Rent (~0,002 SOL)
 * mit Puffer ab; darunter kann die TX physisch nicht landen.
 */
export const SOL_EXIT_FLOOR = 0.005;

/**
 * Guard für kapitalFREIGEBENDE Operationen (closePosition, decreaseLiquidity).
 *
 * 🔒 Kernregel: Ein Ausstieg darf NIEMALS an der SOL-Reserve scheitern.
 *
 * Die 0,1-SOL-Reserve wurde genau dafür geschaffen, dass im Markteinbruch/Black-Swan
 * das Kapital noch aus den Pools geholt und in USDC getauscht werden kann. Bis
 * 2026-07-29 lief hier derselbe assertSufficientSol() wie beim Öffnen — die Reserve
 * hat den Ausstieg damit nicht ermöglicht, sondern verhindert (Score-Limit-Exit
 * blockiert bei 0,0975 SOL, siehe doc/CHANGELOG/2026-07-29.md). Diese Umkehrung darf
 * nicht zurückkommen: hier gilt nur der physikalische Boden, nicht die Reserve.
 *
 * @param {PublicKey|string} pubkey
 * @throws {Error} nur unterhalb SOL_EXIT_FLOOR
 */
export async function assertSufficientSolForExit(pubkey) {
    const key      = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
    const lamports = await getConnectionFresh().getBalance(key, COMMITMENT);
    const balance  = lamports / LAMPORTS_PER_SOL;
    if (balance < SOL_EXIT_FLOOR) {
        const err = new Error(
            `Zu wenig SOL für den Ausstieg: ${balance.toFixed(5)} SOL` +
            ` (absoluter Boden: ${SOL_EXIT_FLOOR} SOL). TX kann nicht landen.`
        );
        err.solBalance = balance;
        throw err;
    }
}
