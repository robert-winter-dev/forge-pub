/**
 * FORGE LendingBot – Wallet: Keypair laden, TX signieren, senden
 *
 * Verantwortlichkeiten:
 *   - Keypair aus Datei laden (JSON-Array oder Base58-String)
 *   - Unsigned base64-TX aus Protokoll-API deserialisieren
 *   - TX signieren (VersionedTransaction oder Legacy-Transaction)
 *   - TX zum Solana-Netzwerk senden + auf Bestätigung warten
 *   - Fehlerfälle klar melden (Simulation, InsufficientFunds, Timeout)
 *
 * Signing passiert NUR hier — lending-protocols.js baut nur unsigned TXs.
 *
 * Wichtig:
 *   Der Private Key verlässt diese Datei nie. Keine Logs mit Key-Inhalten.
 */

import {
    Connection,
    Keypair,
    VersionedTransaction,
    Transaction,
    sendAndConfirmRawTransaction,
    PublicKey,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { readFileSync }   from 'fs';
import bs58               from 'bs58';
import { config }         from './config.js';

// ─── Konstanten ───────────────────────────────────────────────────────────────

/** Maximale Wartezeit auf TX-Bestätigung (ms) */
const CONFIRM_TIMEOUT_MS = 60_000;

/** Anzahl Bestätigungen die wir abwarten */
const COMMITMENT = 'confirmed';

// ─── Keypair laden ────────────────────────────────────────────────────────────

/**
 * Lädt das Keypair aus der in config.keypairPath konfigurierten Datei.
 * Unterstützt beide gängigen Formate:
 *   - JSON-Array:    [12, 34, 56, ...]  (Solana CLI Standard)
 *   - Base58-String: "5Kb8kLf9zgWQ..."
 *
 * @returns {Keypair}
 * @throws  {Error} wenn Datei nicht lesbar oder Format unbekannt
 */
export function loadKeypair() {
    const path = config.keypairPath;
    let raw;
    try {
        raw = readFileSync(path, 'utf-8').trim();
    } catch (err) {
        throw new Error(`Keypair-Datei nicht lesbar (${path}): ${err.message}`);
    }

    try {
        if (raw.startsWith('[')) {
            // JSON-Array: Standard-Format des Solana CLI
            return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
        } else {
            // Base58-kodierter Private Key
            return Keypair.fromSecretKey(bs58.decode(raw));
        }
    } catch (err) {
        throw new Error(`Keypair-Format unbekannt (${path}): ${err.message}`);
    }
}

// ─── Solana-Connection ────────────────────────────────────────────────────────

/** Gibt eine Connection zum konfigurierten RPC-Endpunkt zurück (gecacht). */
let _connection = null;
export function getConnection() {
    if (!_connection) {
        _connection = new Connection(config.rpcUrl, {
            commitment:  COMMITMENT,
            wsEndpoint:  process.env.HELIUS_WS_URL || undefined,
        });
    }
    return _connection;
}

// ─── TX signieren + senden ────────────────────────────────────────────────────

/**
 * Signiert eine base64-kodierte unsigned Transaction und sendet sie.
 *
 * Unterstützt sowohl VersionedTransaction (v0) als auch Legacy-Transactions.
 * Der Blockhash wird automatisch auf Aktualität geprüft und ggf. aktualisiert.
 *
 * @param {string}  base64Tx   Unsigned TX aus Protokoll-API (base64)
 * @param {Keypair} keypair    Signing-Keypair
 * @returns {Promise<string>}  TX-Signature (Solscan-Link: solscan.io/tx/<sig>)
 * @throws  {Error}            bei Simulation-Fehler, Timeout oder RPC-Fehler
 */
export async function signAndSend(base64Tx, keypair, { preserveBlockhash = false } = {}) {
    const connection = getConnection();
    const txBytes    = Buffer.from(base64Tx, 'base64');

    // Versuche zuerst VersionedTransaction (neuerer Standard)
    let tx;
    let isVersioned = false;
    try {
        tx         = VersionedTransaction.deserialize(txBytes);
        isVersioned = true;
    } catch {
        // Fallback: Legacy Transaction
        tx = Transaction.from(txBytes);
    }

    // Blockhash holen (für Confirmation-Tracking immer nötig)
    const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash(COMMITMENT);

    if (isVersioned) {
        // preserveBlockhash=true: Server hat TX bereits co-signiert → Blockhash NICHT ändern
        if (!preserveBlockhash) tx.message.recentBlockhash = blockhash;
        tx.sign([keypair]);
    } else {
        if (!preserveBlockhash) {
            tx.recentBlockhash = blockhash;
            tx.feePayer        = keypair.publicKey;
        }
        tx.sign(keypair);
    }

    // Simulation vorab (fängt InsufficientFunds und Logik-Fehler ab)
    await simulate(connection, tx, isVersioned);

    // Senden + auf Bestätigung warten
    const rawTx  = tx.serialize();
    const txSig  = await sendAndConfirmRawTransaction(
        connection,
        rawTx,
        {
            blockhash,
            lastValidBlockHeight,
            signature: isVersioned ? bs58.encode(tx.signatures[0]) : undefined,
        },
        { commitment: COMMITMENT, maxRetries: 3 }
    );

    return txSig;
}

// ─── Simulation ───────────────────────────────────────────────────────────────

/**
 * Simuliert eine TX und wirft einen sprechenden Fehler wenn sie scheitern würde.
 * Verhindert verlorene Fees für offensichtlich fehlerhafte TXs.
 */
async function simulate(connection, tx, isVersioned) {
    let result;
    try {
        if (isVersioned) {
            result = await connection.simulateTransaction(tx, { commitment: COMMITMENT });
        } else {
            result = await connection.simulateTransaction(tx, undefined, { commitment: COMMITMENT });
        }
    } catch (err) {
        // Simulation selbst fehlgeschlagen (RPC-Problem) – nicht blockieren
        console.warn(`[wallet] Simulation nicht verfügbar: ${err.message}`);
        return;
    }

    if (result.value.err) {
        const errStr = JSON.stringify(result.value.err);
        const logs   = (result.value.logs ?? []).slice(-5).join('\n  ');
        throw new Error(
            `TX-Simulation fehlgeschlagen: ${errStr}\n  Logs:\n  ${logs}`
        );
    }
}

// ─── SOL-Balance prüfen ───────────────────────────────────────────────────────

/**
 * Gibt die SOL-Balance einer Wallet zurück.
 * Nützlich um vor einer TX zu prüfen ob genug SOL für Fees da ist.
 *
 * @param {PublicKey|string} pubkey
 * @returns {Promise<number>} SOL-Balance (z.B. 0.042)
 */
export async function getSolBalance(pubkey) {
    const key      = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
    const lamports = await getConnection().getBalance(key, COMMITMENT);
    return lamports / LAMPORTS_PER_SOL;
}

/**
 * Gibt die USDC-Balance einer Wallet zurück (SPL-Token-Account).
 *
 * @param {PublicKey|string} pubkey
 * @returns {Promise<number>} USDC-Balance (z.B. 50.00)
 */
export async function getUsdcBalance(pubkey) {
    const key      = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
    const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    const accounts = await getConnection().getParsedTokenAccountsByOwner(key, {
        mint: USDC_MINT,
    });
    if (accounts.value.length === 0) return 0;
    return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
}

/** USDC-Mint (Mainnet) + Dezimalstellen */
const USDC_MINT     = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDC_DECIMALS = 6;

/**
 * Überträgt USDC vom Bot-Wallet an eine externe Adresse (SPL-Token-Transfer).
 * Legt das Empfänger-Token-Konto an, falls es noch nicht existiert.
 * Nutzt die bestehende signAndSend-Infrastruktur (Simulation, Confirmation).
 *
 * @param {Keypair} keypair    Bot-Keypair (Absender + Fee-Payer)
 * @param {string}  toAddress  Empfänger-Wallet (Base58)
 * @param {number}  uiAmount   Betrag in USDC (z.B. 1379.16)
 * @returns {Promise<string>}  TX-Signatur
 */
export async function sendUsdc(keypair, toAddress, uiAmount) {
    if (!(uiAmount > 0)) throw new Error('sendUsdc: Betrag muss größer als 0 sein.');
    await assertSufficientSol(keypair.publicKey);

    const {
        getAssociatedTokenAddressSync,
        createTransferCheckedInstruction,
        createAssociatedTokenAccountInstruction,
    } = await import('@solana/spl-token');

    const connection = getConnection();
    const dest       = new PublicKey(toAddress);
    const fromAta    = getAssociatedTokenAddressSync(USDC_MINT, keypair.publicKey);
    const toAta      = getAssociatedTokenAddressSync(USDC_MINT, dest);
    const rawAmount  = BigInt(Math.round(uiAmount * 10 ** USDC_DECIMALS));

    const tx = new Transaction();
    const toAtaInfo = await connection.getAccountInfo(toAta);
    if (!toAtaInfo) {
        // Empfänger-USDC-Konto existiert noch nicht → anlegen (Bot zahlt die Rent)
        tx.add(createAssociatedTokenAccountInstruction(keypair.publicKey, toAta, dest, USDC_MINT));
    }
    tx.add(createTransferCheckedInstruction(
        fromAta, USDC_MINT, toAta, keypair.publicKey, rawAmount, USDC_DECIMALS,
    ));

    // Blockhash/Fee-Payer für die Serialisierung; signAndSend setzt den Blockhash neu.
    const { blockhash } = await connection.getLatestBlockhash(COMMITMENT);
    tx.recentBlockhash = blockhash;
    tx.feePayer        = keypair.publicKey;

    const base64Tx = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    return signAndSend(base64Tx, keypair);
}

/**
 * Liest die tatsächliche Solana-Netzwerkgebühr einer TX aus der Chain.
 *
 * @param {string} txSig  TX-Signatur (Base58)
 * @returns {Promise<number|null>}  Fee in SOL, oder null wenn nicht abrufbar
 */
export async function fetchFeeSol(txSig) {
    try {
        const tx = await getConnection().getTransaction(txSig, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
        });
        if (tx?.meta?.fee == null) return null;
        return tx.meta.fee / 1e9; // Lamports → SOL
    } catch {
        return null;
    }
}

/**
 * Prüft ob genug SOL für Fees vorhanden ist (Mindest-Reserve aus config).
 * Wirft einen Fehler wenn das Guthaben zu niedrig ist.
 *
 * @param {PublicKey|string} pubkey
 * @throws {Error} wenn SOL-Balance unter config.solReserve
 */
export async function assertSufficientSol(pubkey) {
    const balance = await getSolBalance(pubkey);
    if (balance < config.solReserve) {
        throw new Error(
            `Zu wenig SOL für Fees: ${balance.toFixed(4)} SOL` +
            ` (Minimum: ${config.solReserve} SOL). TX abgebrochen.`
        );
    }
}
