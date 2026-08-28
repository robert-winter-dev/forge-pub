/**
 * FORGE Liquidity – Exit-Finalizer
 *
 * Gemeinsame Swap- und Transfer-Logik für alle Exit-Mechanismen:
 *   • Score Limit      (lib/score-limit.js)
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
import { getKeypair, getConnection, getTokenBalanceFresh, getUsableSolBalanceFresh, USDC_MINT, getTxFee } from './wallet.js';
import { ensureExitCapableSol } from './sol-topup.js';
import { insertTransaction, insertCapitalFlow, setCloseProceeds } from './db.js';
import { logChainTx } from './chain-tx-log.js';
// Nur für die Entnahmeprüfung unten. notify.js importiert exit-finalizer.js nicht — kein Zyklus.
import * as notify from './notify.js';
import { submitAndConfirm } from '../../../core/tx-queue-client.js';
import { settle } from './settle-promise.js';
import { config } from './config.js';
import { pnlForPeriod } from '../../../lib/pnl.js';
import { resolvePnlAnchorMs } from './pnl-anchor.js';

const WSOL_MINT      = 'So11111111111111111111111111111111111111112';
const USDC_DECIMALS  = 6;
const DEFAULT_SLIPPAGE_BPS = 150;  // 1.5 % – einheitlich für alle Exit-Swaps

// Adaptives Chunking: Slippage-Schwelle pro Swap und Wartezeit zwischen Chunks.
// Überschreitet ein Einzel-Swap die Schwelle, wird in gleich große Tranchen aufgeteilt.
// Max. 5 Chunks, um das Risiko bei Bot-Crash zwischen Chunks zu begrenzen.
const EXIT_SWAP_MAX_SLIPPAGE_PCT = 0.50;
const EXIT_SWAP_MAX_CHUNKS       = 5;
const EXIT_SWAP_CHUNK_DELAY_MS   = 5_000;
// Unter diesem Wert (in Raw-Einheiten des Input-Tokens) wird nie ein Swap versucht –
// echte Lamport-/Rundungsreste, für die sich nicht mal eine Jupiter-Quote lohnt.
// Verhindert Jupiter-400-Fehler für Dust-Beträge (z.B. 1–100 Lamport nach Reinvest).
const MIN_SWAP_RAW_ABSOLUTE      = 100;
// Zwischen MIN_SWAP_RAW_ABSOLUTE und MIN_SWAP_RAW ist unklar, ob der Betrag Dust ist –
// hängt vom Tokenpreis ab (z.B. hochpreisige RWA-Token wie SPCX mit wenig Decimals).
// Vorher wurde hier pauschal anhand der Raw-Einheiten verworfen ("≙ 0,001 SOL"),
// was für andere Token denselben Raw-Wert auf einen völlig anderen USD-Gegenwert
// abbildet – ein SPCX-Rest von 0,67 Token (~95 USDC) galt so fälschlich als Dust
// und blieb beim Trailing-Stop-Exit ungeswappt im Wallet liegen (Vorfall 2026-08-08,
// Pool liq-spcx-usdc). Ab hier deshalb per Quote den tatsächlichen USD-Wert prüfen.
const MIN_SWAP_RAW                = 1_000_000; // ≙ 0,001 SOL / 0,001 ORE (je nach Decimals)
const MIN_SWAP_USDC               = 0.5;       // Dust-Schwelle in USD, analog cleanup.js DUST_SWAP_MIN_USDC
// Spielraum, den der Exit-Deckel über die von der Position freigegebene Menge hinaus zulässt.
// Begründung: siehe capToPosition().
const EXIT_CAP_TOLERANCE_PCT      = 0.5;
// Ab welchem Fehlbetrag auf BEIDEN Token die Entnahme als unplausibel gilt (Anteil, nicht %).
// 0,3 % liegt klar über Rundung/Messrauschen und klar unter dem Fehler, der die Prüfung
// veranlasst hat (0,990 % = tokenEst × 100/101). Begründung: siehe
// checkExitAmountsAgainstLastMeasurement().
const EXIT_AMOUNT_TOLERANCE         = 0.003;
const EXIT_AMOUNT_CHECK_MAX_AGE_MS  = 15 * 60 * 1000;

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
            settle(quoteTokens({ inputMint: token.mint, outputMint: USDC_MINT,
                          inputDecimals: token.decimals, outputDecimals: USDC_DECIMALS,
                          amount: probeRaw / 10 ** token.decimals })),
            settle(quoteTokens({ inputMint: token.mint, outputMint: USDC_MINT,
                          inputDecimals: token.decimals, outputDecimals: USDC_DECIMALS,
                          amount: totalAmount })),
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
    if (fullRaw < MIN_SWAP_RAW_ABSOLUTE) {
        console.log(`${logPrefix} Swap ${label}: Betrag zu gering (${fullRaw} Raw-Units) – übersprungen`);
        return { amountOut: 0 };
    }
    if (fullRaw < MIN_SWAP_RAW) {
        // Raw-Einheiten allein sagen nichts über den USD-Wert aus (Decimals/Preis
        // variieren pro Token) – per Quote den tatsächlichen Gegenwert prüfen,
        // statt pauschal als Dust zu verwerfen.
        try {
            const quote    = await quoteTokens({
                inputMint: token.mint, outputMint: USDC_MINT,
                inputDecimals: token.decimals, outputDecimals: USDC_DECIMALS,
                amount: totalAmount,
            });
            const usdValue = quote.outAmountRaw / 10 ** USDC_DECIMALS;
            if (usdValue < MIN_SWAP_USDC) {
                console.log(`${logPrefix} Swap ${label}: ~${usdValue.toFixed(4)} USDC (${fullRaw} Raw-Units) – Dust, übersprungen`);
                return { amountOut: 0 };
            }
            console.log(`${logPrefix} Swap ${label}: ${fullRaw} Raw-Units, aber ~${usdValue.toFixed(2)} USDC wert – Swap wird trotzdem ausgeführt`);
        } catch (err) {
            console.warn(`${logPrefix} Swap ${label}: Quote fehlgeschlagen (${err.message}) – als Dust behandelt, übersprungen`);
            return { amountOut: 0 };
        }
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

/**
 * PnL der soeben geschlossenen Position seit der letzten externen Einzahlung
 * (oder seit Eröffnung, falls keine) – identische Herleitung wie das Tooltip
 * "PnL seit Einzahlung" in bin/export.js. Ausschließlich über lib/pnl.js
 * (CLAUDE.md-Pflicht) – hier steht keine eigene PnL-Mathematik.
 *
 * @param {object} db
 * @param {object} pool      braucht pool.id
 * @param {object} position  braucht position.opened_at (vor dem Withdraw gelesen)
 * @returns {number|null}
 */
export function computeExitPnl(db, pool, position) {
    const lastDeposit = db.prepare(`
        SELECT MAX(created_at) AS t FROM capital_flows
         WHERE pool_id = ? AND usdc_amount > 0 AND is_external = 1 AND created_at >= ?
    `).get(pool.id, position.opened_at);
    const fromMs = resolvePnlAnchorMs(lastDeposit?.t, position.pnl_anchor_reset_at, position.opened_at);
    return pnlForPeriod(db, { flavor: config.botId, scope: pool.id, fromMs });
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
 *   1. Keine SOL-Vorsicherung — Trailing-Stop, TVL-Schutz,
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
        // Dieser Claim bekommt bewusst KEINE eigene transactions-Zeile — sein Betrag
        // fließt gebündelt in die close_position-Zeile (finalizeClosePosition). Damit
        // der Abgleich in lib/capital-reconcile.js den Abfluss trotzdem zuordnen kann,
        // wird die Signatur vermerkt (lib/chain-tx-log.js).
        logChainTx(db, {
            txHash:     feeResult.txHash,
            poolId:     pool.id,
            positionId: position.id,
            kind:       'exit_fee_claim',
            note:       'gebündelt in close_position',
        });
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
 * Schließt die on-chain Position und schreibt die close_position-Transaktion.
 *
 * Bündelt den im Withdraw-Step zuvor geclaimten Fee-Anteil (feesA/feesB) mit dem
 * reinen Close-Betrag (closed.amountA/B) zusammen — beide zusammen ergeben, was die
 * Position beim Ausstieg tatsächlich freigibt. Zuvor bauten trailing-stop.js,
 * score-limit.js und der (2026-08-15 ausgebaute) Ranking-Exit diesen Block jeweils
 * eigenständig nach und
 * schrieben dabei versehentlich nur closed.amountA/B in die DB, wodurch der im
 * selben Schritt geclaimte Fee-Anteil aus der Transaktionshistorie verschwand
 * (sichtbar z.B. wenn die Position beim finalen Resume-Schritt bereits leer war
 * und nur noch der Fee-Claim einen Restwert hatte).
 *
 * @param {Object} adapter   Pool-Adapter (getAdapter(pool))
 * @param {Object} pool
 * @param {Object} position  Zeile aus getOpenPosition() (braucht nft_mint)
 * @param {Object} db
 * 🔒 Teilfehlschlag (LIQ#0312): Wirft `adapter.closePosition` NACHDEM die Entnahme
 * gelandet ist, traegt der Fehler `partialExit` (siehe pool-adapter/orca.js). Hier wird
 * er um die bereits geclaimten Fees zu den ECHTEN Wallet-Mengen ergaenzt und
 * weitergeworfen — der Aufrufer persistiert sie und darf den Withdraw NICHT wiederholen.
 * Ohne das fand ein Resume on-chain 0 Liquiditaet und buchte den Erloes als ~0.
 *
 * @param {Object} opts
 *   @param {number} opts.feesA      Im Withdraw-Step geclaimter Fee-Anteil Token A
 *   @param {number} opts.feesB      Im Withdraw-Step geclaimter Fee-Anteil Token B
 *   @param {string} opts.note       transactions.note, z.B. 'trailing-stop'
 *   @param {string} opts.logPrefix  z.B. '[trailing-stop:liq-...]'
 * @returns {Promise<{closed: Object, coinsA: number, coinsB: number}>}
 */
/**
 * 🔒 Prüft die entnommenen Mengen gegen die letzte Messung derselben Position.
 *
 * Warum es das gibt: Bis 2026-08-23 meldete `closePosition()` die On-Chain-Schutzuntergrenze
 * (`tokenMin`) statt des Ergebnisses — rund 1 % jeder Position blieb dadurch unverkauft und
 * wurde zu niedrig gebucht. Der Fehler lief WOCHEN, weil jede vorhandene Prüfung den
 * *Auslöser* kontrollierte und keine das *Ergebnis*. Genau diese Lücke schließt diese Funktion.
 *
 * Warum der Vergleich über Token-Mengen läuft und nicht über USD: Zwischen Auslösung und
 * Entnahme vergehen ~10 s, in denen sich der Kurs bewegt — ein USD-Vergleich
 * (`current_usd` gegen `swapped_usdc`) trüge diese Bewegung mit und müsste so tolerant
 * gestellt werden, dass er einen 1-%-Versatz nicht mehr sieht. Genau daran ist meine erste
 * Analyse gescheitert: Über 43 Exits gemittelt verschwand der konstante Versatz im Rauschen.
 *
 * 🔒 Die Invariante nutzt den Fingerabdruck des Fehlers: Eine Kursbewegung verschiebt in einer
 * CLMM-Position den Token-MIX — die eine Menge steigt, die andere fällt, immer gegenläufig.
 * Ein systematischer Abschlag senkt dagegen BEIDE Mengen um denselben Faktor. Deshalb schlägt
 * nur an, was **beide** Legs gleichzeitig unter die letzte Messung drückt. Kursbewegung kann
 * das nicht auslösen, ein Mengenabschlag immer.
 *
 * Zusätzlich in der sicheren Richtung: `coinsA/coinsB` enthalten die vorher geclaimten Fees,
 * liegen also normalerweise ÜBER den gemessenen Positionsmengen.
 *
 * Blockiert nie einen Exit — ein Diagnosewert darf den Schutzmechanismus nicht aufhalten.
 *
 * @returns {{ ok: boolean, shortfallA: number, shortfallB: number, reason: string|null }}
 *          `shortfall*` als Anteil (0,01 = 1 % zu wenig), negativ = mehr als gemessen.
 */
export function checkExitAmountsAgainstLastMeasurement(db, pool, coinsA, coinsB, { maxAgeMs = EXIT_AMOUNT_CHECK_MAX_AGE_MS } = {}) {
    const skip = reason => ({ ok: true, shortfallA: 0, shortfallB: 0, reason });

    let row;
    try {
        row = db.prepare(
            `SELECT amount_a, amount_b, recorded_at FROM position_snapshots
             WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
        ).get(pool.id);
    } catch (err) {
        return skip(`Snapshot nicht lesbar: ${err.message}`);
    }

    if (!row) return skip('keine Messung vorhanden');
    if (!(row.amount_a > 0) || !(row.amount_b > 0)) return skip('Messung ohne Mengen (Alt-Snapshot)');
    // Eine alte Messung sagt nichts über diese Entnahme — z.B. wenn ein Resume Stunden
    // später läuft. Lieber nicht prüfen als falsch alarmieren.
    if (Date.now() - row.recorded_at > maxAgeMs) return skip('letzte Messung zu alt');

    const shortfallA = (row.amount_a - coinsA) / row.amount_a;
    const shortfallB = (row.amount_b - coinsB) / row.amount_b;

    if (shortfallA > EXIT_AMOUNT_TOLERANCE && shortfallB > EXIT_AMOUNT_TOLERANCE) {
        return {
            ok: false, shortfallA, shortfallB,
            reason: `beide Token-Mengen unter der letzten Messung `
                + `(A −${(shortfallA * 100).toFixed(2)} %, B −${(shortfallB * 100).toFixed(2)} %)`,
        };
    }
    return { ok: true, shortfallA, shortfallB, reason: null };
}
export async function finalizeClosePosition(adapter, pool, position, db, { feesA, feesB, note, logPrefix }) {
    let closed;
    try {
        closed = await adapter.closePosition(pool, position.nft_mint);
    } catch (err) {
        if (err.partialExit) {
            // Fees sind vor der Entnahme geclaimed worden und liegen ebenfalls im Wallet.
            err.partialExit.coinsA = feesA + (err.partialExit.amountA ?? 0);
            err.partialExit.coinsB = feesB + (err.partialExit.amountB ?? 0);
            console.error(
                `${logPrefix} 🔒 TEILFEHLSCHLAG: Liquidität entnommen (TX=${err.partialExit.decreaseTxHash}), `
                + `Position-NFT NICHT geschlossen. ${err.partialExit.coinsA.toFixed(6)} A + `
                + `${err.partialExit.coinsB.toFixed(6)} B liegen im Wallet.`
            );
        }
        throw err;
    }

    const coinsA = feesA + (closed.amountA ?? 0);
    const coinsB = feesB + (closed.amountB ?? 0);

    console.log(`${logPrefix} Position geschlossen: ${coinsA.toFixed(6)} A + ${coinsB.toFixed(6)} B  TX: ${closed.txHash}`);

    // Ergebnis gegen die letzte Messung prüfen. Best-effort und niemals blockierend:
    // ein Diagnosewert darf den schützenden Exit nicht aufhalten.
    try {
        const check = checkExitAmountsAgainstLastMeasurement(db, pool, coinsA, coinsB);
        if (!check.ok) {
            const msg = `Entnahme unplausibel: ${check.reason}. `
                + `Eine Kursbewegung verschiebt den Token-Mix gegenläufig und kann beide Mengen `
                + `nicht gleichzeitig senken — das deutet auf einen systematischen Mengenabschlag `
                + `(z.B. tokenMin statt tokenEst) hin. Kapital ist entnommen, der Exit läuft weiter; `
                + `die Differenz bleibt im Wallet und wird zu niedrig gebucht.`;
            console.error(`${logPrefix} 🔒 ${msg} TX=${closed.txHash}`);
            notify.warn(`Exit ${pool.displayPair ?? pool.pair}`, new Error(msg))
                .catch(e => console.warn(`${logPrefix} Meldung zur Entnahmeprüfung fehlgeschlagen: ${e.message}`));
        }
    } catch (err) {
        console.warn(`${logPrefix} Entnahmeprüfung übersprungen: ${err.message}`);
    }

    const closeFee = await getTxFee(closed.txHash).catch(() => null);
    insertTransaction(db, {
        poolId:   pool.id,
        type:     'close_position',
        amountA:  coinsA,
        amountB:  coinsB,
        usdValue: null,
        txHash:   closed.txHash,
        txFeeSol: closeFee,
        note,
    });

    return { closed, coinsA, coinsB };
}

/**
 * Schließt die Position — und rettet das Kapital, wenn NUR der NFT-Burn scheitert.
 *
 * 🔒 Der gemeinsame Ausstiegspfad aller vier Exit-Module (Trailing Stop, Score-Limit,
 * TVL-Schutz, Retirement). Der Ausstieg besteht aus zwei on-chain-Legs: `decreaseLiquidity`
 * holt das Kapital heraus, `closePositionIx` verbrennt danach das leere NFT. Nur das erste
 * bewegt Geld — das zweite holt ~0,002 SOL Rent zurück.
 *
 * Bis 23.08.2026 hing der schützende Verkauf am Gelingen des zweiten: scheiterte der Burn,
 * brach der ganze Exit ab und das Kapital lag bis zum nächsten Wiederanlauf ungetauscht im
 * Wallet — mit vollem Kursrisiko, obwohl der Exit genau das beenden soll. 0,002 SOL Rent
 * blockierten den Schutz dreistelliger Beträge.
 *
 * Jetzt gilt Kapital zuerst: Ist die Entnahme gelandet, wird die `close_position`-Zeile
 * sofort geschrieben (Anker der späteren Erlösbuchung, siehe `recordDrainedClose()`) und
 * der Aufrufer kann mit Swap und Transfer weitermachen. Das leere NFT übernimmt der
 * tägliche Zombie-Cron (`bin/run-zombie-check.sh`).
 *
 * 🔒 Ohne `err.partialExit` hat die Entnahme NICHT stattgefunden — dann steht das Kapital
 * unverändert in der Position, der Fehler wird durchgereicht und darf niemals als
 * entnommen gebucht werden. Diese Unterscheidung trägt die Sicherheit des Verfahrens.
 *
 * @returns {Promise<{coinsA: number, coinsB: number, closeTxHash: string,
 *                    closePending: {decreaseTxHash: string, reason: string}|null}>}
 *          `closePending` beschreibt ein liegengebliebenes NFT (sonst null). `closeTxHash`
 *          ist dann die Signatur der Entnahme — die TX, die das Kapital bewegt hat.
 */
export async function closePositionOrRescue(adapter, pool, position, db, { feesA, feesB, note, logPrefix }) {
    try {
        const { closed, coinsA, coinsB } = await finalizeClosePosition(adapter, pool, position, db, {
            feesA, feesB, note, logPrefix,
        });
        return { coinsA, coinsB, closeTxHash: closed.txHash, closePending: null };
    } catch (err) {
        if (!err.partialExit) throw err;

        const { coinsA, coinsB, decreaseTxHash } = err.partialExit;
        recordDrainedClose(db, pool, {
            coinsA, coinsB, txHash: decreaseTxHash, note: `${note} (NFT offen)`,
        });
        console.warn(
            `${logPrefix} 🔒 Position-Close gescheitert, Kapital wird trotzdem gesichert: `
            + `${coinsA.toFixed(6)} A + ${coinsB.toFixed(6)} B im Wallet, Exit läuft weiter. `
            + `Das leere NFT räumt der Zombie-Cron ab. Grund: ${err.message}`
        );
        return {
            coinsA, coinsB,
            closeTxHash:  decreaseTxHash,
            closePending: { decreaseTxHash, reason: err.message },
        };
    }
}

/**
 * Schreibt die `close_position`-Zeile für Kapital, das die Position über ein gelandetes
 * `decreaseLiquidity` verlassen hat, OBWOHL der NFT-Burn danach scheiterte (LIQ#0312).
 *
 * 🔒 Warum das gebucht werden MUSS, obwohl die Position on-chain formal noch existiert:
 * `recordExitProceeds()` trägt den Verkaufserlös über `setCloseProceeds()` in genau diese
 * Zeile nach. Fehlt sie, sucht der Nachtrag im Zeitfenster — und trifft dort im
 * schlimmsten Fall die close_position-Zeile eines FREMDEN Exits. Die leere Zeile ist also
 * kein Schönheitsfehler, sondern der Anker der gesamten Erlösbuchung.
 *
 * `txHash` ist bewusst die Signatur der Entnahme, nicht die eines Burns — sie ist die
 * Transaktion, die das Kapital tatsächlich bewegt hat.
 *
 * Das leere Position-NFT bleibt liegen und wird vom täglichen Zombie-Cron
 * (`bin/run-zombie-check.sh` → `burn-zombie-nfts.js --full-close --execute`) abgeräumt.
 * Es bindet nur die Rent von ~0,002 SOL.
 */
export function recordDrainedClose(db, pool, { coinsA, coinsB, txHash, note }) {
    insertTransaction(db, {
        poolId:   pool.id,
        type:     'close_position',
        amountA:  coinsA,
        amountB:  coinsB,
        usdValue: null,          // wird von setCloseProceeds() nach dem Swap nachgetragen
        txHash,
        txFeeSol: null,
        note,
    });
}

/**
 * Bucht den realisierten Erlös eines Auto-Exits — an EINER Stelle für alle Exit-Module.
 *
 * Zwei Schreibvorgänge, die zusammengehören und deshalb nicht mehr getrennt aufgerufen
 * werden sollten:
 *   1. capital_flows: der Kapitalabgang aus der Position (unverändert zum bisherigen
 *      Verhalten der Module, is_external = 1).
 *   2. transactions.close_position.usd_value: derselbe Betrag als Wert des Closes —
 *      bis 22.08.2026 blieb das NULL und zwang jede Auswertung zu einer Schätzung.
 *
 * `isFullClose` muss false sein, wenn der Erlös aus einem TEIL-Abzug stammt
 * (decreaseLiquidity, Position bleibt offen — TVL-Schutz Level 1). Dort gehört der
 * Betrag ausschließlich in die eigene withdraw-Zeile; eine close_position-Zeile
 * gibt es nicht, und ein Nachtrag könnte im Fenster nur eine FREMDE Zeile treffen.
 *
 * @param {Object} db
 * @param {Object} opts  { poolId, swappedUsdc, note, isFullClose }
 *                       note = capital_flows-Notiz, z.B. 'trailing-stop-exit'
 */
export function recordExitProceeds(db, { poolId, swappedUsdc, note, isFullClose = true }) {
    insertCapitalFlow(db, { poolId, usdcAmount: -swappedUsdc, note, isExternal: 1 });
    if (isFullClose) setCloseProceeds(db, { poolId, usdValue: swappedUsdc });
}

/**
 * Begrenzt die zu verkaufende SOL-Menge auf das, was tatsächlich aus der Position kam.
 *
 * 🔒 Warum nicht der gesamte nutzbare Wallet-Bestand (Zustand bis 2026-08-13):
 * `getUsableSolBalanceFresh()` zieht nur `config.solReserve` ab — alles darüber galt als
 * verkaufbarer Rest. Damit hat jeder Ausstieg aus einem SOL-Pool auch den Puffer
 * mitverkauft, den die Selbstheilung kurz zuvor extra gekauft hatte. Belegt auf
 * forge-pub1 2026-08-13:
 *
 *   16:09:24  SOL-Self-Heal: 0.0979 → 0.1913 SOL   (USDC → SOL gekauft)
 *   16:09:25  decreaseLiquidity: tokenEstA = 0.158604 SOL aus der Position
 *   16:09:27  TVL-Schutz: Swap 0.250656 SOL → USDC (= Position + kompletter Topup)
 *
 * Ergebnis: SOL wieder auf der Reserve, Swap-Gebühren und Slippage zweimal bezahlt, und
 * beim nächsten Zyklus beginnt derselbe Rundlauf von vorn. Das ist exakt die Pathologie,
 * die `SOL_TOPUP_TARGET` (lib/sol-topup.js) für den Cleanup-Pfad bereits beseitigt hat:
 * „auffüllen bis X" und „abbauen auf Y" müssen dieselbe Zahl meinen. Der Ausstieg
 * verkauft deshalb nur noch das Positionskapital; der Wallet-Puffer bleibt dem nächsten
 * Öffnen erhalten.
 *
 * 🔴 Bis 2026-08-22 griff die Kappung nur für SOL; bei jedem anderen Token wurde der
 * komplette Wallet-Bestand geswappt, mit der impliziten Annahme „ein Wallet-Rest dieses
 * Mints ist immer Dust aus früheren Swaps derselben Position". Die Annahme bricht, sobald
 * zwei aktive Pools denselben Nicht-USDC-Mint halten (`liq-sol-zec` und `liq-zec-usdc`
 * teilen sich ZEC; `liq-btc-usdc`/`liq-cbtc-wbtc` teilen sich cbBTC; `liq-cbtc-wbtc`/
 * `liq-wbtc-sol` teilen sich WBTC).
 *
 * Vorfall: Ein Cleanup-Deposit in `liq-zec-usdc` deployte nur 0,0596 von 0,3884 gekauften
 * ZEC — die restlichen 0,328 ZEC (≈264 USD) blieben als Wallet-Guthaben dieser Position
 * liegen. 41 Minuten später riss ein völlig unabhängiger Trailing-Stop-Exit von
 * `liq-sol-zec` (das ebenfalls ZEC hält) diesen Rest mit, weil der Fetch für die
 * Nicht-SOL-Seite ungedeckelt war. Zwei Folgen: die Exit-Meldung von `liq-sol-zec` zeigte
 * „Exit-Kosten: −264,94 USDC" (`lpValueUsd − swappedUsdc`, siehe `notify.js
 * exitMetricsParams`) — rechnerisch korrekt, aber sinnlos, weil `swappedUsdc` fremdes
 * Kapital enthielt; und `insertCapitalFlow()` (siehe `stepSwap()` in `trailing-stop.js`)
 * hat diesen kompletten Betrag als Abfluss von `liq-sol-zec` gebucht — die PnL-Historie
 * beider Pools war damit verfälscht, nicht nur die Anzeige.
 *
 * Die Kappung gilt jetzt für **jedes** Token gleich: Ein Exit swappt nie mehr, als die
 * eigene Position gerade freigegeben hat. Echter Dust aus früheren Swaps derselben
 * Position bleibt dabei im Wallet liegen, statt undeterministisch beim nächsten Exit
 * irgendeines Pools mit demselben Mint aufzutauchen — das ist der sichere Tausch.
 *
 * Kleiner Spielraum auf `fromPosition` (EXIT_CAP_TOLERANCE_PCT): Die Menge stammt aus
 * `tokenEst` der Orca-Quote — einer Schätzung zum Preis im Moment der Quote. Bewegt sich der
 * Preis in den ~3 s bis zur Ausführung, liegt die tatsächlich erhaltene Menge minimal darüber.
 * Ohne Spielraum bliebe genau diese Differenz wieder liegen, also derselbe Fehlertyp, den der
 * Fix vom 23.08.2026 beseitigt hat — nur kleiner. Beobachtete Drift über ~3 s: < 0,1 %.
 *
 * Warum der Spielraum trotzdem eng bleibt: Der Deckel schützt fremde Bestände desselben Mints
 * (SOL steckt in jedem volatilePair-Pool, cbBTC in zwei). 0,5 % liegt weit über der Drift und
 * weit unter allem, was einem anderen Pool spürbar wehtun könnte. Die SOL-Seite ist zusätzlich
 * durch getUsableSolBalanceFresh() begrenzt, das die Reserve ohnehin zurückhält.
 *
 * @param {number} usableAmount  Wallet-Bestand (SOL: abzüglich Reserve)
 * @param {number} fromPosition  Menge, die die Position gerade freigegeben hat
 * @returns {number} zu swappende Menge (nie negativ, nie mehr als fromPosition + Toleranz)
 */
function capToPosition(usableAmount, fromPosition) {
    const cap = fromPosition * (1 + EXIT_CAP_TOLERANCE_PCT / 100);
    return Math.max(0, Math.min(usableAmount, cap));
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
        // Fresh statt der von stepWithdraw zurückgegebenen Menge, weil zwischen Withdraw und
        // Swap noch etwas dazukommen kann (z.B. ein claimter Fee-Rest) — aber immer gedeckelt
        // auf das, was DIESE Position freigegeben hat (siehe capToPosition oben).
        const fetchBal = async (mint, decimals, fromPosition) => capToPosition(
            mint === WSOL_MINT
                ? await getUsableSolBalanceFresh(keypair.publicKey)
                : await getTokenBalanceFresh(keypair.publicKey, mint, decimals),
            fromPosition,
        );

        if (coinsA > 0) {
            // Mit sendTo/forceCoins: nur die aus Pool entnommenen Coins (keine pre-existing
            // Wallet-Bestände) — ergibt hier dasselbe wie fetchBal, weil beide auf coinsA
            // gedeckelt sind, macht die Absicht aber explizit.
            const swapA = useCoinsOnly ? coinsA : await fetchBal(pool.tokenA, pool.decimalsA, coinsA);
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
            const swapB = useCoinsOnly ? coinsB : await fetchBal(pool.tokenB, pool.decimalsB, coinsB);
            if (swapB > 0) {
                const r = await adaptiveSwapToUsdc(
                    { mint: pool.tokenB, decimals: pool.decimalsB },
                    swapB, keypair, connection, symB, logPrefix, slippageBps,
                );
                swappedUsdc += r.amountOut;
            }
        }
    } else {
        // Standard X/USDC: nur tokenA → USDC; tokenB ist bereits USDC.
        // Gedeckelt auf coinsA wie im volatilePair-Zweig — betrifft z.B. cbBTC/USDC, das sich
        // den Mint mit cbBTC/WBTC teilt.
        const swapAmount = useCoinsOnly ? coinsA
            : capToPosition(
                pool.tokenA === WSOL_MINT
                    ? await getUsableSolBalanceFresh(keypair.publicKey)
                    : await getTokenBalanceFresh(keypair.publicKey, pool.tokenA, pool.decimalsA),
                coinsA,
              );

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
