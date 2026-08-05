/**
 * FORGE Liquidity – Exit-Finalizer
 *
 * Gemeinsame Swap- und Transfer-Logik für alle Exit-Mechanismen:
 *   • Score Limit      (lib/score-limit.js)
 *   • Ranking-Exit     (lib/ranking-exit.js)
 *   • Trailing Stop    (lib/trailing-stop.js)
 *
 * Hintergrund: Exit-Module hatten zuvor jeweils eigene `stepSwap`/`stepTransfer`-
 * Funktionen mit nahezu identischem Inhalt (nur Log-Präfixe und State-Machine-
 * Updates unterschieden sich). Diese Datei zentralisiert die Swap+Send-Logik.
 *
 * Verwendung pro Exit-Modul:
 *   1) Eigene `stepWithdraw()` bleibt im Modul (transaction-note unterscheidet sich).
 *   2) Nach erfolgreichem Withdraw: executeSwapStep(pool, opts) und/oder
 *      executeTransferStep(pool, opts) aufrufen.
 *   3) Über die Callbacks `onSwapped` / `onTransferred` schreibt jedes Modul
 *      den Fortschritt in seine eigene State-Machine-Tabelle.
 *
 * Crash-Sicherheit: Beide Steps sind idempotent ausgelegt — der Callback persistiert
 * direkt nach jeder Aktion. Bei Bot-Restart kann das Modul den Step erneut aufrufen,
 * solange der vorherige Step noch nicht abgeschlossen wurde.
 */

import { Transaction, SystemProgram, PublicKey, TransactionInstruction } from '@solana/web3.js';

import { swapTokens, quoteTokens } from './swap.js';
import { getKeypair, getConnection, getTokenBalanceFresh, getUsableSolBalanceFresh, USDC_MINT } from './wallet.js';
import { ensureExitCapableSol } from './sol-topup.js';
import { submitAndConfirm } from '../../../core/tx-queue-client.js';

const WSOL_MINT      = 'So11111111111111111111111111111111111111112';
const USDC_DECIMALS  = 6;
const DEFAULT_SLIPPAGE_BPS = 150;  // 1.5 % – einheitlich für alle Exit-Swaps

// Adaptives Chunking: Slippage-Schwelle pro Swap und Wartezeit zwischen Chunks.
// Überschreitet ein Einzel-Swap die Schwelle, wird in gleich große Tranchen aufgeteilt.
// Max. 5 Chunks, um das Risiko bei Bot-Crash zwischen Chunks zu begrenzen.
const EXIT_SWAP_MAX_SLIPPAGE_PCT = 0.50;
const EXIT_SWAP_MAX_CHUNKS       = 5;
const EXIT_SWAP_CHUNK_DELAY_MS   = 5_000;
// Unter diesem Wert (in Raw-Einheiten des Input-Tokens) wird kein Swap versucht.
// Verhindert Jupiter-400-Fehler für Dust-Beträge (z.B. 1–1000 Lamport nach Reinvest).
const MIN_SWAP_RAW               = 1_000_000; // ≙ 0,001 SOL / 0,001 ORE (je nach Decimals)

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SPL_PROGRAM_ID   = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOC_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function deriveATA(walletPubkey, mintPubkey) {
    const [ata] = PublicKey.findProgramAddressSync(
        [walletPubkey.toBuffer(), SPL_PROGRAM_ID.toBuffer(), mintPubkey.toBuffer()],
        ASSOC_PROGRAM_ID,
    );
    return ata;
}

// ─── Low-level Transaktions-Helfer ───────────────────────────────────────────

// Blockhash-Fehler erkennen (Queue liefert Fehlermeldung als String)
function _isBlockhashExpired(err) {
    return /blockhash not found|BlockhashNotFound/i.test(err?.message ?? '');
}

async function sendSplToken(wallet, connection, toAddr, mintAddr, decimals, amount) {
    const mintPubkey = new PublicKey(mintAddr);
    const destPubkey = new PublicKey(toAddr);
    const sourceATA  = deriveATA(wallet.publicKey, mintPubkey);
    const destATA    = deriveATA(destPubkey, mintPubkey);

    const destATAInfo = await connection.getAccountInfo(destATA);

    const rawAmount = BigInt(Math.round(amount * 10 ** decimals));
    const data      = Buffer.alloc(9);
    data.writeUInt8(3, 0);
    data.writeBigUInt64LE(rawAmount, 1);

    // Einmal Retry bei abgelaufenem Blockhash (frischen Blockhash holen + neu signieren)
    for (let attempt = 1; attempt <= 2; attempt++) {
        const tx = new Transaction();
        if (!destATAInfo) {
            tx.add(new TransactionInstruction({
                programId: ASSOC_PROGRAM_ID,
                keys: [
                    { pubkey: wallet.publicKey,         isSigner: true,  isWritable: true  },
                    { pubkey: destATA,                  isSigner: false, isWritable: true  },
                    { pubkey: destPubkey,               isSigner: false, isWritable: false },
                    { pubkey: mintPubkey,               isSigner: false, isWritable: false },
                    { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false },
                    { pubkey: SPL_PROGRAM_ID,           isSigner: false, isWritable: false },
                ],
                data: Buffer.alloc(0),
            }));
        }
        tx.add(new TransactionInstruction({
            programId: SPL_PROGRAM_ID,
            keys: [
                { pubkey: sourceATA,        isSigner: false, isWritable: true  },
                { pubkey: destATA,          isSigner: false, isWritable: true  },
                { pubkey: wallet.publicKey, isSigner: true,  isWritable: false },
            ],
            data,
        }));
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer        = wallet.publicKey;
        tx.sign(wallet);
        try {
            const txHash = await submitAndConfirm(tx.serialize());
            return { txHash, amount };
        } catch (err) {
            if (attempt < 2 && _isBlockhashExpired(err)) {
                console.warn('[exit-finalizer] sendSplToken: Blockhash abgelaufen, neuer Versuch…');
                continue;
            }
            throw err;
        }
    }
}

async function sendNativeSol(wallet, connection, toAddr, lamports) {
    // Einmal Retry bei abgelaufenem Blockhash
    for (let attempt = 1; attempt <= 2; attempt++) {
        const tx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey:   new PublicKey(toAddr),
                lamports,
            })
        );
        const { blockhash } = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = blockhash;
        tx.feePayer        = wallet.publicKey;
        tx.sign(wallet);
        try {
            return await submitAndConfirm(tx.serialize());
        } catch (err) {
            if (attempt < 2 && _isBlockhashExpired(err)) {
                console.warn('[exit-finalizer] sendNativeSol: Blockhash abgelaufen, neuer Versuch…');
                continue;
            }
            throw err;
        }
    }
}

/**
 * Teilt einen Gesamtbetrag in nChunks gleich große Teile auf (in Raw-Einheiten).
 * Der letzte Chunk erhält ggf. den Rundungsrest.
 */
function splitIntoChunks(totalAmount, nChunks, decimals) {
    const totalRaw = Math.round(totalAmount * 10 ** decimals);
    const baseRaw  = Math.floor(totalRaw / nChunks);
    const lastRaw  = totalRaw - baseRaw * (nChunks - 1);
    return Array.from({ length: nChunks }, (_, i) =>
        (i < nChunks - 1 ? baseRaw : lastRaw) / 10 ** decimals
    );
}

/**
 * Misst die effektive Slippage eines Swaps durch Vergleich zweier Quotes:
 * 1% der Menge (Referenzpreis) vs. Gesamtmenge.
 * Gibt 0 zurück falls die Probe fehlschlägt (fail-safe: kein Chunking).
 */
async function probeSlippage(token, totalAmount, logPrefix) {
    // 1 % als Referenzprobe, mindestens 1 Raw-Einheit
    const probeRaw = Math.max(1, Math.round(totalAmount * 0.01 * 10 ** token.decimals));
    const fullRaw  = Math.round(totalAmount * 10 ** token.decimals);
    if (fullRaw < MIN_SWAP_RAW) return 0; // Dust – Jupiter-Quote unnötig
    try {
        const [small, full] = await Promise.all([
            quoteTokens({ inputMint: token.mint, outputMint: USDC_MINT,
                          inputDecimals: token.decimals, outputDecimals: USDC_DECIMALS,
                          amount: probeRaw / 10 ** token.decimals }),
            quoteTokens({ inputMint: token.mint, outputMint: USDC_MINT,
                          inputDecimals: token.decimals, outputDecimals: USDC_DECIMALS,
                          amount: totalAmount }),
        ]);
        const smallRate   = small.outAmountRaw / probeRaw;
        const fullRate    = full.outAmountRaw  / fullRaw;
        return Math.max(0, (smallRate - fullRate) / smallRate * 100);
    } catch (err) {
        console.warn(`${logPrefix} Slippage-Probe fehlgeschlagen (${err.message}) – Einzel-Swap`);
        return 0;
    }
}

/**
 * Tauscht `totalAmount` Token gegen USDC. Ermittelt zuerst die effektive Slippage
 * per Jupiter-Quote und teilt den Swap in Chunks auf, falls die Schwelle
 * EXIT_SWAP_MAX_SLIPPAGE_PCT überschritten wird.
 */
async function adaptiveSwapToUsdc(token, totalAmount, keypair, connection, label, logPrefix, slippageBps) {
    const fullRaw = Math.round(totalAmount * 10 ** token.decimals);
    if (fullRaw < MIN_SWAP_RAW) {
        console.log(`${logPrefix} Swap ${label}: Betrag zu gering (${fullRaw} Raw-Units) – übersprungen`);
        return { amountOut: 0 };
    }

    // Slippage messen und ggf. Chunk-Anzahl bestimmen
    let nChunks = 1;
    const slippagePct = await probeSlippage(token, totalAmount, logPrefix);
    if (slippagePct > EXIT_SWAP_MAX_SLIPPAGE_PCT) {
        nChunks = Math.min(EXIT_SWAP_MAX_CHUNKS, Math.ceil(slippagePct / EXIT_SWAP_MAX_SLIPPAGE_PCT));
        console.log(`${logPrefix} Adaptiver Swap: ${slippagePct.toFixed(2)}% Slippage bei Vollbetrag → ${nChunks} Chunks à ~${(totalAmount / nChunks).toFixed(4)} ${label}`);
    }

    const chunks   = splitIntoChunks(totalAmount, nChunks, token.decimals);
    let   totalOut = 0;

    for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
            console.log(`${logPrefix} Chunk ${i + 1}/${nChunks}: warte ${EXIT_SWAP_CHUNK_DELAY_MS / 1000}s…`);
            await sleep(EXIT_SWAP_CHUNK_DELAY_MS);
        }

        const chunkLabel = nChunks > 1 ? `${label} [${i + 1}/${nChunks}]` : label;
        console.log(`${logPrefix} Swap: ${chunks[i].toFixed(6)} ${chunkLabel} → USDC`);

        const { amountOut, txSignature } = await swapTokens({
            inputMint:      token.mint,
            outputMint:     USDC_MINT,
            inputDecimals:  token.decimals,
            outputDecimals: USDC_DECIMALS,
            amount:         chunks[i],
            wallet:         keypair,
            connection,
            apiKey:         null,
            slippageBps,
        });

        console.log(`${logPrefix} Swap ✓: ${amountOut.toFixed(2)} USDC erhalten  TX: ${txSignature}`);
        totalOut += amountOut;
    }

    if (nChunks > 1) {
        console.log(`${logPrefix} Swap gesamt: ${totalOut.toFixed(2)} USDC (${nChunks} Chunks)`);
    }
    return { amountOut: totalOut };
}

// ─── High-level Step-Funktionen (für State-Machines) ─────────────────────────

/**
 * Pflicht-Auftakt jedes Ausstiegs: SOL sichern, dann (nur wenn es SOL-mäßig
 * vertretbar ist) die aufgelaufenen Fees claimen.
 *
 * 🔒 Warum das zusammengehört und warum es genau HIER sitzt:
 * Die Exit-Module riefen früher direkt `adapter.collectFees()` auf und schlossen
 * danach. Das hatte zwei Löcher (2026-07-29, siehe doc/CHANGELOG/2026-07-29.md):
 *
 *   1. Keine SOL-Vorsicherung — Ranking-Exit, Trailing-Stop, TVL-Schutz,
 *      Retirement und Emergency-Withdraw liefen ohne jede Prüfung in den
 *      Reserve-Guard und brachen ab. Der Ausstieg scheiterte an genau der
 *      Reserve, die ihn ermöglichen sollte.
 *   2. Der Fee-Claim lief VOR dem Close und kostet selbst SOL. Bei knappem
 *      Bestand hat der 15-Minuten-Resume damit in jeder Runde SOL verbrannt,
 *      für Fee-Beträge im Zehntel-Cent-Bereich — der Rettungsmechanismus hat
 *      seine eigene Rettungsreserve aufgefressen.
 *
 * Deshalb kapselt dieser Helfer beides an der Stelle, an der die Module ohnehin
 * schon `collectFees` aufriefen: So greift er automatisch für den normalen wie
 * für den Resume-Pfad, ohne dass ein Modul ein Flag durchreichen muss.
 *
 * Der Fee-Claim ist bewusst optional (nice-to-have), der Ausstieg nicht.
 *
 * Voraussetzung: Aufrufer hält den SL-Lock.
 *
 * @param {Object} adapter   Pool-Adapter (getAdapter(pool))
 * @param {Object} pool
 * @param {Object} position  Zeile aus getOpenPosition() (braucht nft_mint)
 * @param {Object} db
 * @param {Object} opts
 *   @param {string} opts.logPrefix   z.B. '[scoreLimit:liq-...]'
 * @returns {Promise<{amountA: number, amountB: number, skipped: boolean, sol: number}>}
 * @throws {Error} nur wenn der Ausstieg physisch unmöglich ist (SOL < SOL_EXIT_FLOOR)
 */
export async function prepareExitAndClaimFees(adapter, pool, position, db, { logPrefix }) {
    const keypair    = getKeypair();
    const connection = getConnection();

    const sol = await ensureExitCapableSol(db, keypair, connection, {
        log: msg => console.log(`${logPrefix} ${msg}`),
    });

    if (!sol.ok) {
        const err = new Error(
            `Ausstieg nicht möglich: nur ${sol.sol.toFixed(5)} SOL im Wallet und Topup fehlgeschlagen.`
        );
        err.solBalance = sol.sol;
        err.exitBlocked = true;
        throw err;
    }

    // Knapp bei Kasse → Fee-Claim auslassen. Die Fees gehen nicht verloren: sie
    // werden beim Close ohnehin mit ausgezahlt (closePosition claimt implizit).
    if (sol.tight) {
        console.warn(`${logPrefix} SOL knapp (${sol.sol.toFixed(4)}) – Fee-Claim übersprungen, Close hat Vorrang`);
        return { amountA: 0, amountB: 0, skipped: true, sol: sol.sol };
    }

    try {
        const feeResult = await adapter.collectFees(pool, position.nft_mint);
        return {
            amountA: feeResult.amountA ?? 0,
            amountB: feeResult.amountB ?? 0,
            skipped: false,
            sol:     sol.sol,
        };
    } catch (err) {
        console.warn(`${logPrefix} Fee-Claim fehlgeschlagen (nicht kritisch): ${err.message}`);
        return { amountA: 0, amountB: 0, skipped: true, sol: sol.sol };
    }
}

/**
 * Tauscht alle Coins der Position in USDC um.
 *
 * @param {Object} pool      Pool-Config (braucht tokenA/tokenB, decimalsA/B, volatilePair)
 * @param {Object} opts
 *   @param {number}   opts.coinsA          Aus stepWithdraw zurückgegebener Coin-Bestand A
 *   @param {number}   opts.coinsB          Aus stepWithdraw zurückgegebener Coin-Bestand B
 *   @param {string}   opts.sendTo          Empfänger-Adresse (oder leer). Beeinflusst Swap-Menge.
 *   @param {string}   opts.logPrefix       z.B. '[tp:liq-...]'
 *   @param {Function} [opts.onSwapped]     Callback(swappedUsdc) — persistiert Fortschritt in DB
 *   @param {number}   [opts.slippageBps]   Default 150 (= 1,5 %)
 *   @param {boolean}  [opts.forceCoins]    Immer nur coinsA/coinsB swappen (wie mit sendTo),
 *                                          auch ohne sendTo. Für Teil-Entnahmen (manueller
 *                                          Withdraw), bei denen der restliche Wallet-Bestand
 *                                          unangetastet bleiben muss.
 * @returns {Promise<number>}  Summe USDC nach Swap
 */
export async function executeSwapStep(pool, opts) {
    const {
        coinsA, coinsB,
        sendTo,
        logPrefix,
        onSwapped,
        slippageBps = DEFAULT_SLIPPAGE_BPS,
        forceCoins = false,
    } = opts;

    const keypair    = getKeypair();
    const connection = getConnection();
    const [symA]     = pool.pair.split('/');
    let swappedUsdc  = 0;
    const useCoinsOnly = !!sendTo || forceCoins;

    // volatilePair (HYPE/SOL, cbBTC/WBTC etc.): beide Tokens swappen
    if (pool.volatilePair) {
        const fetchBal = async (mint, decimals) => mint === WSOL_MINT
            ? getUsableSolBalanceFresh(keypair.publicKey)
            : getTokenBalanceFresh(keypair.publicKey, mint, decimals);

        if (coinsA > 0) {
            // Mit sendTo/forceCoins: nur die aus Pool entnommenen Coins (keine pre-existing
            // Wallet-Bestände). Sonst: gesamter Wallet-Bestand (Cleanup reinvestiert Rest).
            const swapA = useCoinsOnly ? coinsA : await fetchBal(pool.tokenA, pool.decimalsA);
            if (swapA > 0) {
                const r = await adaptiveSwapToUsdc(
                    { mint: pool.tokenA, decimals: pool.decimalsA },
                    swapA, keypair, connection, symA, logPrefix, slippageBps,
                );
                swappedUsdc += r.amountOut;
            }
        }
        if (coinsB > 0) {
            const [, symB] = pool.pair.split('/');
            const swapB = useCoinsOnly ? coinsB : await fetchBal(pool.tokenB, pool.decimalsB);
            if (swapB > 0) {
                const r = await adaptiveSwapToUsdc(
                    { mint: pool.tokenB, decimals: pool.decimalsB },
                    swapB, keypair, connection, symB, logPrefix, slippageBps,
                );
                swappedUsdc += r.amountOut;
            }
        }
    } else {
        // Standard X/USDC: nur tokenA → USDC; tokenB ist bereits USDC
        const swapAmount = useCoinsOnly ? coinsA
            : pool.tokenA === WSOL_MINT
                ? Math.max(0, await getUsableSolBalanceFresh(keypair.publicKey))
                : await getTokenBalanceFresh(keypair.publicKey, pool.tokenA, pool.decimalsA);

        if (swapAmount > 0) {
            const r = await adaptiveSwapToUsdc(
                { mint: pool.tokenA === WSOL_MINT ? WSOL_MINT : pool.tokenA, decimals: pool.decimalsA },
                swapAmount, keypair, connection, symA, logPrefix, slippageBps,
            );
            swappedUsdc = r.amountOut + coinsB; // coinsB ist bereits USDC
        } else {
            swappedUsdc = coinsB;
        }
    }

    if (onSwapped) onSwapped(swappedUsdc);
    return swappedUsdc;
}

/**
 * Überträgt Coins an die `sendTo`-Adresse.
 * Wenn swapToUsdc=true: nur USDC senden.
 * Wenn swapToUsdc=false: Original-Coins (tokenA + tokenB) senden.
 *
 * @param {Object} pool
 * @param {Object} opts
 *   @param {number}   opts.coinsA, opts.coinsB
 *   @param {number}   opts.swappedUsdc    Aus executeSwapStep (oder null wenn kein Swap)
 *   @param {string}   opts.sendTo         Empfänger-Adresse (Pflicht)
 *   @param {boolean}  opts.swapToUsdc     War vorher Swap aktiv?
 *   @param {string}   opts.logPrefix
 *   @param {Function} [opts.onTransferred]  Callback() — persistiert Fortschritt
 */
export async function executeTransferStep(pool, opts) {
    const {
        coinsA, coinsB,
        swappedUsdc,
        sendTo,
        swapToUsdc,
        logPrefix,
        onTransferred,
    } = opts;

    const keypair    = getKeypair();
    const connection = getConnection();
    const [symA, symB] = pool.pair.split('/');

    let lastTxHash = null;

    if (swapToUsdc) {
        if (swappedUsdc > 0) {
            // Tatsächliche on-chain Balance lesen statt Quote-Summe zu verwenden –
            // sonst führt minimale Swap-Slippage zu InsufficientFunds (0x1).
            const actualUsdc = await getTokenBalanceFresh(keypair.publicKey, new PublicKey(USDC_MINT), USDC_DECIMALS);
            const transferAmount = Math.min(swappedUsdc, actualUsdc);
            if (transferAmount <= 0) {
                console.warn(`${logPrefix} Transfer übersprungen: USDC-Balance = ${actualUsdc}`);
            } else {
                if (actualUsdc < swappedUsdc) {
                    console.warn(`${logPrefix} Transfer-Betrag auf tatsächliche Balance korrigiert: ${swappedUsdc.toFixed(6)} → ${actualUsdc.toFixed(6)} USDC`);
                }
                console.log(`${logPrefix} Transfer: ${transferAmount.toFixed(2)} USDC → ${sendTo.slice(0, 8)}…`);
                const r = await sendSplToken(keypair, connection, sendTo, USDC_MINT, USDC_DECIMALS, transferAmount);
                lastTxHash = r.txHash;
                console.log(`${logPrefix} Transfer ✓  TX: ${r.txHash}`);
            }
        }
    } else {
        if (coinsA > 0) {
            if (pool.tokenA === WSOL_MINT) {
                const lamports = Math.floor(coinsA * 1e9);
                console.log(`${logPrefix} Transfer: ${coinsA.toFixed(4)} SOL → ${sendTo.slice(0, 8)}…`);
                lastTxHash = await sendNativeSol(keypair, connection, sendTo, lamports);
                console.log(`${logPrefix} Transfer SOL ✓  TX: ${lastTxHash}`);
            } else {
                console.log(`${logPrefix} Transfer: ${coinsA.toFixed(6)} ${symA} → ${sendTo.slice(0, 8)}…`);
                const r = await sendSplToken(keypair, connection, sendTo, pool.tokenA, pool.decimalsA, coinsA);
                lastTxHash = r.txHash;
                console.log(`${logPrefix} Transfer ${symA} ✓  TX: ${r.txHash}`);
            }
        }
        if (coinsB > 0) {
            console.log(`${logPrefix} Transfer: ${coinsB.toFixed(6)} ${symB} → ${sendTo.slice(0, 8)}…`);
            const r = await sendSplToken(keypair, connection, sendTo, pool.tokenB, pool.decimalsB, coinsB);
            lastTxHash = r.txHash;
            console.log(`${logPrefix} Transfer ${symB} ✓  TX: ${r.txHash}`);
        }
    }

    if (onTransferred) onTransferred();
    return lastTxHash;
}
