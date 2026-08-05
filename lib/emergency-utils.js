/**
 * FORGE lib/emergency-utils.js – Gemeinsame Swap- und Transfer-Utilities
 * für das Emergency-Exit-Script.
 *
 * ─── DESIGN-ENTSCHEIDUNG ───────────────────────────────────────────────────
 * Dieses Modul hat KEINE Imports. @solana/web3.js und submitAndConfirm werden
 * vom Aufrufer per Dependency-Injection übergeben. Grund: @solana/web3.js
 * liegt nur in den jeweiligen Bot-node_modules, nicht auf FORGE-Ebene.
 *
 * Verwendung im Bot-Modul:
 *   import * as web3 from '@solana/web3.js';
 *   import { submitAndConfirm } from '../../core/tx-queue-client.js';
 *   import { createUtils, TOKEN_MINTS, resolveToken, getQuote }
 *     from '../../lib/emergency-utils.js';
 *   const utils = createUtils(web3, submitAndConfirm);
 * ──────────────────────────────────────────────────────────────────────────
 */

// ─── Token-Definitionen ───────────────────────────────────────────────────────
// Neuen Token ergänzen: Symbol als Key, mint + decimals setzen.

export const TOKEN_MINTS = {
    SOL: {
        symbol:   'SOL',
        mint:     'So11111111111111111111111111111111111111112',
        decimals: 9,
    },
    USDC: {
        symbol:   'USDC',
        mint:     'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
    },
    CBBTC: {
        symbol:   'cbBTC',
        mint:     'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
        decimals: 8,
    },
    ETH: {
        symbol:   'ETH',
        mint:     '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
        decimals: 8,
    },
    // Phase 2 / zukünftige Tokens hier ergänzen:
    // EURC: { symbol: 'EURC', mint: '...', decimals: 6 },
    // WBTC: { symbol: 'WBTC', mint: '...', decimals: 8 },
};

/**
 * Löst einen Token-Namen case-insensitiv zu Token-Info auf.
 * @param {string} name  z.B. 'USDC', 'sol', 'cbBTC'
 * @returns {{ symbol, mint, decimals }}
 * @throws Error wenn unbekannt
 */
export function resolveToken(name) {
    const found = Object.values(TOKEN_MINTS).find(
        t => t.symbol.toLowerCase() === name.toLowerCase()
    );
    if (!found) {
        const known = Object.values(TOKEN_MINTS).map(t => t.symbol).join(', ');
        throw new Error(`Unbekannter Token: "${name}". Bekannt: ${known}`);
    }
    return found;
}

// ─── Jupiter-API-Endpunkte ─────────────────────────────────────────────────────

const QUOTE_API    = 'http://127.0.0.1:3100/jup/swap/v1/quote';
const SWAP_API     = 'http://127.0.0.1:3100/jup/swap/v1/swap';
const SLIPPAGE_BPS = 100; // 1% – im Notfall etwas großzügiger als normales Trading

// Minimale SOL-Reserve beim Senden an externe Adresse (für TX-Fees)
const SOL_SEND_FEE_RESERVE = 0.01; // 0.01 SOL ≈ ausreichend für ~5-10 weitere TXs

// Dust-Schwelle: Beträge darunter werden ignoriert
const DUST = {
    SOL:   0.0001,
    SPL:   0.000001,
};

/**
 * Holt ein Jupiter Swap-Quote (read-only, keine Kosten, kein TX).
 * Nützlich für Dry-Run Level C.
 *
 * @param {string} fromMint
 * @param {number} fromDecimals
 * @param {number} fromAmount    In Token-Einheiten (z.B. 1.5 SOL)
 * @param {string} toMint
 * @returns {{ expectedOut: number, toDecimals: number, priceImpactPct: number, quoteResponse }}
 */
export async function getQuote(fromMint, fromDecimals, fromAmount, toMint) {
    const inAmount = Math.round(fromAmount * 10 ** fromDecimals);
    const params   = new URLSearchParams({
        inputMint:        fromMint,
        outputMint:       toMint,
        amount:           String(inAmount),
        slippageBps:      String(SLIPPAGE_BPS),
        onlyDirectRoutes: 'false',
    });

    const res = await fetch(`${QUOTE_API}?${params}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Jupiter Quote: HTTP ${res.status}`);
    const q = await res.json();
    if (!q?.outAmount) throw new Error('Jupiter Quote: kein outAmount in Antwort');

    // outDecimals aus quote ableiten (falls vorhanden)
    const toDecimals = q.outputDecimals ?? 6;

    return {
        expectedOut:     parseFloat(q.outAmount) / 10 ** toDecimals,
        toDecimals,
        priceImpactPct:  Math.abs(parseFloat(q.priceImpactPct ?? '0')),
        quoteResponse:   q,
    };
}

// ─── SPL-Token-Hilfsfunktionen (statisch, kein web3-Inject nötig) ────────────

const SPL_TOKEN_PROGRAM_STR = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// Token-2022: eigenes Programm mit eigener Account-Liste. Wer nur das Legacy-
// Programm abfragt, sieht solche Tokens ÜBERHAUPT NICHT (real 2026-08-04:
// 20.637 PUMP blieben beim Emergency-Exit unbemerkt liegen, weil PUMP hier liegt).
const TOKEN_2022_PROGRAM_STR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOC_TOKEN_PROGRAM_STR = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSVAR_RENT_STR = 'SysvarRent111111111111111111111111111111111';

// ─── Utility-Factory ──────────────────────────────────────────────────────────

/**
 * Erstellt alle operativen Utility-Funktionen mit injizierten Abhängigkeiten.
 *
 * @param {object}   web3           – Gesamtes @solana/web3.js Modul
 * @param {Function} submitConfirm  – submitAndConfirm aus core/tx-queue-client.js
 * @returns {object} Utility-Funktionen
 */
export function createUtils(web3, submitConfirm) {
    const {
        PublicKey,
        Transaction,
        VersionedTransaction,
        SystemProgram,
        TransactionInstruction,
        LAMPORTS_PER_SOL,
    } = web3;

    const SPL_PROGRAM       = new PublicKey(SPL_TOKEN_PROGRAM_STR);
    const TOKEN_2022_PROGRAM = new PublicKey(TOKEN_2022_PROGRAM_STR);
    const ASSOC_PROGRAM     = new PublicKey(ASSOC_TOKEN_PROGRAM_STR);
    const RENT_PUBKEY       = new PublicKey(SYSVAR_RENT_STR);

    // ── ATA ableiten ──────────────────────────────────────────────────────────
    // tokenProgram muss zum jeweiligen Mint passen (Legacy oder Token-2022) —
    // die ATA-Adresse selbst hängt vom Programm ab, ein falsches Programm liefert
    // eine falsche (nicht existierende) Adresse statt eines Fehlers.

    function deriveATA(walletKey, mintKey, tokenProgram = SPL_PROGRAM) {
        const [ata] = PublicKey.findProgramAddressSync(
            [walletKey.toBuffer(), tokenProgram.toBuffer(), mintKey.toBuffer()],
            ASSOC_PROGRAM
        );
        return ata;
    }

    // ── Balances lesen ────────────────────────────────────────────────────────

    async function getSolBalance(connection, pubkey) {
        const key      = typeof pubkey === 'string' ? new PublicKey(pubkey) : pubkey;
        const lamports = await connection.getBalance(key, 'confirmed');
        return lamports / LAMPORTS_PER_SOL;
    }

    async function getSplBalance(connection, walletPubkey, mintPubkey) {
        const accounts = await connection.getParsedTokenAccountsByOwner(
            walletPubkey, { mint: mintPubkey }
        );
        if (!accounts.value.length) return 0;
        return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0;
    }

    // ── Swap via Jupiter ──────────────────────────────────────────────────────

    /**
     * Tauscht Tokens über Jupiter (Live-Mode).
     */
    async function swapToken(wallet, connection, fromMint, fromDecimals, fromAmount, toMint) {
        const { quoteResponse } = await getQuote(fromMint, fromDecimals, fromAmount, toMint);

        const swapRes = await fetch(SWAP_API, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                quoteResponse,
                userPublicKey:             wallet.publicKey.toBase58(),
                wrapAndUnwrapSol:          true,
                dynamicComputeUnitLimit:   true,
                prioritizationFeeLamports: 'auto',
            }),
            signal: AbortSignal.timeout(15_000),
        });

        if (!swapRes.ok) throw new Error(`Jupiter Swap: HTTP ${swapRes.status}`);
        const { swapTransaction } = await swapRes.json();
        if (!swapTransaction) throw new Error('Jupiter Swap: keine swapTransaction in Antwort');

        const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
        tx.sign([wallet]);
        const txHash = await submitConfirm(tx.serialize());

        return {
            txHash,
            fromAmount,
            expectedOut: parseFloat(quoteResponse.outAmount),
        };
    }

    // ── SOL-Transfer ──────────────────────────────────────────────────────────

    /**
     * Sendet SOL von der Bot-Wallet an eine externe Adresse.
     * Behält automatisch SOL_SEND_FEE_RESERVE für TX-Fees zurück.
     */
    async function sendSol(wallet, connection, toAddr, amountSol) {
        const toPubkey = new PublicKey(toAddr);
        const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

        const tx = new Transaction();
        tx.add(SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey,
            lamports,
        }));

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer        = wallet.publicKey;
        tx.sign(wallet);

        const txHash = await submitConfirm(tx.serialize());
        return { txHash, amountSol };
    }

    // ── SPL-Token-Transfer ────────────────────────────────────────────────────

    /**
     * Sendet SPL-Token von der Bot-Wallet an eine externe Adresse.
     * Erstellt Ziel-ATA automatisch falls nicht vorhanden (~0.002 SOL Rent).
     *
     * @param {string} [tokenProgramStr] – Legacy (Default) oder Token-2022. Muss
     *   zum Mint passen (siehe getAllBalances → programId je Balance-Eintrag),
     *   sonst zeigen alle abgeleiteten ATAs ins Leere.
     */
    async function sendSplToken(wallet, connection, toAddr, mintAddr, decimals, amount, tokenProgramStr = SPL_TOKEN_PROGRAM_STR) {
        const tokenProgram = tokenProgramStr === TOKEN_2022_PROGRAM_STR ? TOKEN_2022_PROGRAM : SPL_PROGRAM;
        const mintPubkey = new PublicKey(mintAddr);
        const destPubkey = new PublicKey(toAddr);
        const sourceATA  = deriveATA(wallet.publicKey, mintPubkey, tokenProgram);
        const destATA    = deriveATA(destPubkey, mintPubkey, tokenProgram);
        const tx         = new Transaction();

        // Ziel-ATA erstellen falls nicht vorhanden
        const destATAInfo = await connection.getAccountInfo(destATA);
        if (!destATAInfo) {
            tx.add(new TransactionInstruction({
                programId: ASSOC_PROGRAM,
                keys: [
                    { pubkey: wallet.publicKey,       isSigner: true,  isWritable: true  },
                    { pubkey: destATA,                isSigner: false, isWritable: true  },
                    { pubkey: destPubkey,             isSigner: false, isWritable: false },
                    { pubkey: mintPubkey,             isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: tokenProgram,           isSigner: false, isWritable: false },
                    { pubkey: RENT_PUBKEY,            isSigner: false, isWritable: false },
                ],
                data: Buffer.alloc(0),
            }));
        }

        // TransferChecked (discriminator 12) statt des alten Transfer (discriminator
        // 3): TransferChecked prüft Mint+Decimals mit und läuft auf BEIDEN Programmen
        // (Legacy + Token-2022) identisch — Voraussetzung dafür, dass diese Funktion
        // für jedes von getAllBalances() gefundene Token funktioniert, nicht nur für
        // die vier vorher fest hinterlegten.
        const rawAmount = BigInt(Math.round(amount * 10 ** decimals));
        const data      = Buffer.alloc(10);
        data.writeUInt8(12, 0);
        data.writeBigUInt64LE(rawAmount, 1);
        data.writeUInt8(decimals, 9);

        tx.add(new TransactionInstruction({
            programId: tokenProgram,
            keys: [
                { pubkey: sourceATA,          isSigner: false, isWritable: true  },
                { pubkey: mintPubkey,         isSigner: false, isWritable: false },
                { pubkey: destATA,            isSigner: false, isWritable: true  },
                { pubkey: wallet.publicKey,   isSigner: true,  isWritable: false },
            ],
            data,
        }));

        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer        = wallet.publicKey;
        tx.sign(wallet);

        const txHash = await submitConfirm(tx.serialize());
        return { txHash, amount };
    }

    // ── Hochrangige Helfer ────────────────────────────────────────────────────

    /**
     * Liest ALLE Token-Balances der Wallet — dynamischer Scan, keine feste Liste.
     *
     * 🔴 Vorher wurde nur über TOKEN_MINTS (SOL/USDC/cbBTC/ETH) iteriert. Jedes
     * andere Pool-Token war damit für den Emergency-Exit unsichtbar: real am
     * 2026-08-04 blieben 20.637 PUMP nach einem Live-Exit unbemerkt im Wallet
     * liegen, weil PUMP weder in der Liste stand NOCH unter dem Legacy-Token-
     * Programm liegt. Bei SOL/ORE, cbBTC/WBTC usw. wäre exakt dasselbe passiert.
     *
     * Deshalb jetzt: beide Token-Programme (Legacy + Token-2022) direkt abfragen.
     * Decimals kommen von der Chain statt aus der Liste — das ist zugleich die
     * einzige Quelle, die für unbekannte Tokens überhaupt korrekt sein kann.
     *
     * Ausgeschlossen werden:
     *   - decimals === 0  → NFT-Schutz. Position-NFTs (Orca) liegen im selben
     *     Wallet; ein Swap-Versuch darauf wäre im schlimmsten Fall ein realer
     *     Kapitalverlust. Echte fungible Tokens haben praktisch immer decimals > 0.
     *   - Wrapped-SOL-Token-Accounts → native SOL wird separat geführt (unten),
     *     beides zu addieren würde einen Betrag ergeben, der gar nicht swapbar ist.
     *
     * @returns {Array<{ symbol, mint, decimals, balance, programId }>}
     */
    async function getAllBalances(connection, walletPubkey) {
        const key    = typeof walletPubkey === 'string' ? new PublicKey(walletPubkey) : walletPubkey;
        const byMint = new Map();

        // Natives SOL (kein Token-Account)
        try {
            const sol = await getSolBalance(connection, key);
            if (sol > 0) byMint.set(TOKEN_MINTS.SOL.mint, { ...TOKEN_MINTS.SOL, balance: sol, programId: null });
        } catch { /* Best-effort */ }

        for (const progStr of [SPL_TOKEN_PROGRAM_STR, TOKEN_2022_PROGRAM_STR]) {
            let accounts;
            try {
                accounts = await connection.getParsedTokenAccountsByOwner(key, { programId: new PublicKey(progStr) });
            } catch { continue; } // ein ausgefallenes Programm darf den Rest nicht blockieren
            for (const acc of accounts.value) {
                const info = acc.account.data.parsed?.info;
                const amt  = info?.tokenAmount;
                if (!amt) continue;

                const balance = amt.uiAmount ?? 0;
                if (balance <= 0) continue;
                if (amt.decimals === 0) continue;                 // NFT-Schutz, siehe oben
                if (info.mint === TOKEN_MINTS.SOL.mint) continue; // WSOL: natives SOL zählt

                const known = Object.values(TOKEN_MINTS).find(t => t.mint === info.mint);
                const prev  = byMint.get(info.mint);
                byMint.set(info.mint, {
                    symbol:   known?.symbol ?? `${info.mint.slice(0, 4)}…${info.mint.slice(-4)}`,
                    mint:     info.mint,
                    decimals: amt.decimals,
                    // Mehrere Accounts pro Mint sind zulässig → aufsummieren.
                    balance:  (prev?.balance ?? 0) + balance,
                    programId: progStr,
                });
            }
        }

        return [...byMint.values()];
    }

    /**
     * Tauscht alle Tokens in der Wallet zu einem Ziel-Token.
     * SOL: behält SOL_SEND_FEE_RESERVE zurück.
     * Tokens unter Dust-Schwelle werden übersprungen.
     *
     * @param {Keypair}    wallet
     * @param {Connection} connection
     * @param {{ symbol, mint, decimals }} targetToken – Ziel-Token aus resolveToken()
     * @returns {Array} Swap-Ergebnisse
     */
    async function swapAllToTarget(wallet, connection, targetToken, opts = {}) {
        const results  = [];

        // 🔴 Settle-Wartezeit VOR dem Balance-Read (2026-08-04): Der Aufrufer hat
        // unmittelbar davor Positionen geschlossen. Deren Erlös ist zwar bestätigt,
        // steht als natives SOL aber erst zur Verfügung, wenn das temporäre
        // Wrapped-SOL-Konto geschlossen/entpackt ist. Ohne diese Pause las der
        // Scan real 0,1622 SOL statt 0,8127 SOL — getauscht wurden dadurch nur
        // 0,1522 statt ~0,80 SOL, der Rest blieb unbemerkt liegen. Das ist der
        // gefährlichste Fehlerfall dieses Pfads, weil er still passiert: der
        // Emergency-Exit meldet Erfolg, sichert aber nur einen Bruchteil.
        const settleMs = opts.settleMs ?? 5_000;
        if (settleMs > 0) await new Promise(r => setTimeout(r, settleMs));

        const balances = await getAllBalances(connection, wallet.publicKey);

        // Erst alle Nicht-SOL-Tokens tauschen (brauchen wenig SOL für Fees)
        const nonSol = balances.filter(t => t.mint !== TOKEN_MINTS.SOL.mint && t.mint !== targetToken.mint);

        for (const token of nonSol) {
            if (token.balance <= DUST.SPL) continue;
            try {
                const res = await swapToken(
                    wallet, connection,
                    token.mint, token.decimals, token.balance,
                    targetToken.mint,
                );
                results.push({ from: token.symbol, amount: token.balance, ...res, success: true });
            } catch (err) {
                // Nicht-fatal: unbekannte/illiquide Tokens (z.B. eingestreute Scam-
                // Airdrops) haben oft keine Jupiter-Route. Jeder Fehlschlag wird als
                // eigener Eintrag gemeldet, blockiert aber die übrigen Swaps nicht.
                results.push({ from: token.symbol, amount: token.balance, success: false, error: err.message });
            }
        }

        // SOL zuletzt (falls SOL nicht selbst das Ziel ist).
        if (targetToken.mint !== TOKEN_MINTS.SOL.mint) {
            // Frischer Read statt des Werts von oben: die Token-Swaps eben haben
            // selbst SOL an Gebühren verbraucht, ein Wert von vor der Schleife wäre
            // zu hoch und der Swap könnte an fehlender Deckung scheitern.
            let solNow = 0;
            try { solNow = await getSolBalance(connection, wallet.publicKey); } catch { /* siehe unten */ }

            // Reserve bleibt bewusst im Wallet: ohne SOL lässt sich das erlöste USDC
            // später weder swappen noch überhaupt bewegen — der Nutzer säße auf
            // Kapital, an das er ohne Nachschuss nicht herankommt.
            const swappable = Math.max(0, solNow - SOL_SEND_FEE_RESERVE);
            if (swappable > DUST.SOL) {
                try {
                    const res = await swapToken(
                        wallet, connection,
                        TOKEN_MINTS.SOL.mint, TOKEN_MINTS.SOL.decimals, swappable,
                        targetToken.mint,
                    );
                    results.push({ from: 'SOL', amount: swappable, ...res, success: true });
                } catch (err) {
                    results.push({ from: 'SOL', amount: swappable, success: false, error: err.message });
                }
            }
        }

        return results;
    }

    /**
     * Sendet alle Tokens der Wallet an eine Zieladresse.
     * SOL: behält SOL_SEND_FEE_RESERVE (0.01 SOL) für weitere TX-Fees zurück.
     *
     * @param {Keypair}    wallet
     * @param {Connection} connection
     * @param {string}     toAddr – Ziel-Wallet-Adresse (Base58)
     * @returns {Array} Transfer-Ergebnisse
     */
    async function sendAllTokensTo(wallet, connection, toAddr) {
        const results  = [];
        const balances = await getAllBalances(connection, wallet.publicKey);

        for (const token of balances) {
            let sendAmount = token.balance;

            if (token.mint === TOKEN_MINTS.SOL.mint) {
                sendAmount = Math.max(0, token.balance - SOL_SEND_FEE_RESERVE);
                if (sendAmount <= DUST.SOL) continue;
            } else {
                if (sendAmount <= DUST.SPL) continue;
            }

            try {
                let res;
                if (token.mint === TOKEN_MINTS.SOL.mint) {
                    res = await sendSol(wallet, connection, toAddr, sendAmount);
                } else {
                    res = await sendSplToken(
                        wallet, connection, toAddr,
                        token.mint, token.decimals, sendAmount,
                        token.programId,
                    );
                }
                results.push({ token: token.symbol, amount: sendAmount, ...res, success: true });
            } catch (err) {
                results.push({ token: token.symbol, amount: sendAmount, success: false, error: err.message });
            }
        }

        return results;
    }

    return {
        getSolBalance,
        getSplBalance,
        getAllBalances,
        swapToken,
        sendSol,
        sendSplToken,
        swapAllToTarget,
        sendAllTokensTo,
        SOL_SEND_FEE_RESERVE,
    };
}
