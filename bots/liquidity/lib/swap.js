/**
 * FORGE Liquidity – Jupiter Swap-Utility
 *
 * Generischer Token-Swap via FORGE API Proxy (localhost:3100 → Jupiter v1).
 * Wird für den Setup-Swap (USDC → SOL) und ggf. künftige Rebalancing-Swaps verwendet.
 *
 * Endpoint: http://127.0.0.1:3100/jup/swap/v1
 */

import { VersionedTransaction } from '@solana/web3.js';
import { submitAndConfirm } from '../../../core/tx-queue-client.js';
import { rpcLimiter } from './rate-limiter.js';

const QUOTE_API = 'http://127.0.0.1:3100/jup/swap/v1/quote';
const SWAP_API  = 'http://127.0.0.1:3100/jup/swap/v1/swap';

// Slippage für Setup-Swaps: 0.5% — ausreichend für USDC/SOL (hohe Liquidität)
const SLIPPAGE_BPS = 50;

// Retry-Konfiguration für transiente Jupiter-/RPC-Fehler. Frisches Quote pro Versuch
// (Routen werden zeitlich invalidiert — alter Quote nach 1-2s oft "invalid instruction data").
const DEFAULT_RETRIES = 3;
const RETRY_BACKOFF_MS = [1000, 3000, 8000];

function headers(apiKey) {
    const h = { 'Content-Type': 'application/json' };
    if (apiKey) h['x-api-key'] = apiKey;
    return h;
}

/**
 * Klassifiziert ob ein Fehler retry-fähig ist.
 * Retry: Simulation-Fehler, "invalid instruction data", Timeout, 5xx, Blockheight-Expired.
 * Kein Retry: 4xx-Quote-Fehler (kein Route gefunden), explizite Slippage-Überschreitung.
 */
// Exportiert, damit der Doppel-Swap-Schutz direkt prüfbar ist, ohne dafür einen
// echten Swap auszulösen. Nicht zum Aufruf von außen gedacht.
export function isRetryableSwapError(err) {
    const msg = err?.message ?? String(err);
    // Ein zweiter Sendeversuch würde denselben Tausch ein zweites Mal ausführen.
    // Wird von _doSwapOnce gesetzt, wenn nach einem Confirm-Timeout NICHT sicher
    // geklärt werden konnte, ob die erste Transaktion on-chain gelandet ist.
    // Muss vor allen anderen Regeln stehen — 'timeout' weiter unten würde sonst greifen.
    if (err?.doubleSpendRisk) return false;
    if (msg.includes('Jupiter Quote API: HTTP 4')) return false;
    if (msg.includes('Slippage tolerance exceeded')) return false;
    if (msg.includes('invalid instruction data'))   return true;
    if (msg.includes('simulation failed'))          return true;
    if (msg.includes('Blockheight'))                return true;
    if (msg.includes('TransactionExpired'))         return true;
    if (msg.includes('HTTP 5'))                     return true;
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) return true;
    // Bei unbekannten Fehlern lieber retrien als sofort scheitern — Jupiter-Routen
    // sind so volatil, dass die meisten transiens-Fehler beim 2. Versuch verschwinden.
    return true;
}

// Orca-Whirlpool-Error 6024 (0x1788) "InvalidTokenMintOrder": Jupiters Transaktions-Builder
// setzt bei manchen Whirlpool-Hops die Token-Mint-Reihenfolge falsch zusammen (beobachtet u.a.
// bei JTO/JitoSOL- und ORE/SOL-Routen). Kein Slippage-/Betragsproblem – die Route ist defekt.
// Workaround: betroffene Route beim nächsten Versuch per excludeDexes=Whirlpool umfahren.
export function isWhirlpoolMintOrderError(err) {
    const msg = err?.message ?? String(err);
    return msg.includes('0x1788');
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Landing-Check nach Confirm-Timeout ──────────────────────────────────────
// Wie lange nach einem Timeout noch auf das Landen gewartet wird. Eine Solana-TX
// kann nur solange bestätigt werden, wie ihr Blockhash gültig ist (150 Slots,
// ~60–80 s ab Abholung). Die tx-queue hat davon bereits ~60 s verbraucht, der
// Client-Timeout liegt bei 90 s. Wer danach 45 s nichts findet, findet nichts mehr.
const LANDING_POLL_MS      = 5_000;
const LANDING_TIMEOUT_MS   = 45_000;

/**
 * Klärt nach einem unbestätigten Ausgang, ob die Transaktion on-chain gelandet ist.
 *
 * Hintergrund: `submitAndConfirm()` wirft bei Timeout mit `err.unconfirmed === true`
 * und `err.signature` — ausdrücklich KEIN "fehlgeschlagen" (siehe Kopf von
 * core/tx-queue-client.js). Wer daraufhin blind neu sendet, tauscht doppelt.
 * Genau das ist am 2026-08-15 im Cleanup-Lauf um 08:05 passiert: der erste
 * USDC→SOL-Swap lief zweimal, der anschließende Cross-Swap verbrauchte mehr SOL
 * als der Wallet-Bestand plus dem einen gebuchten Swap hergab.
 *
 * @returns {Promise<'landed'|'failed'|'gone'|'unknown'>}
 *   landed  – bestätigt und fehlerfrei → der Tausch hat stattgefunden
 *   failed  – bestätigt, aber mit On-Chain-Fehler → nichts getauscht, Retry sicher
 *   gone    – innerhalb des Blockhash-Fensters nicht aufgetaucht → Retry sicher
 *   unknown – Status nicht ermittelbar (RPC down) → Retry NICHT sicher
 */
export async function resolveUnconfirmedSwap(connection, signature) {
    if (!connection || !signature) return 'unknown';
    const deadline = Date.now() + LANDING_TIMEOUT_MS;
    let rpcReachable = false;

    while (Date.now() < deadline) {
        try {
            await rpcLimiter.wait();
            const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
            rpcReachable = true;
            const status = value?.[0];
            if (status) {
                if (status.err) return 'failed';
                if (status.confirmationStatus) return 'landed';
            }
        } catch (e) {
            console.warn(`[swap] Landing-Check: Status nicht lesbar (${e.message})`);
        }
        await sleep(LANDING_POLL_MS);
    }
    // Nur "gone" behaupten, wenn wir den Status überhaupt lesen konnten — sonst
    // war die Abwesenheit kein Befund, sondern ein blinder Fleck.
    return rpcReachable ? 'gone' : 'unknown';
}

/**
 * Holt eine Jupiter-Quote ohne Swap auszuführen.
 * Gibt outAmount (formatiert) sowie Roh-Werte zurück, die für Slippage-Berechnung
 * (Raten-Vergleich zwischen kleiner und großer Menge) benötigt werden.
 *
 * @param {object} params
 * @param {string} params.inputMint
 * @param {string} params.outputMint
 * @param {number} params.inputDecimals
 * @param {number} params.outputDecimals
 * @param {number} params.amount          Zu tauschende Menge in Token-Einheiten
 * @returns {Promise<{ outAmount: number, outAmountRaw: number, inAmountRaw: number }>}
 */
export async function quoteTokens({ inputMint, outputMint, inputDecimals, outputDecimals, amount }) {
    const inAmountRaw = Math.round(amount * 10 ** inputDecimals);
    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount:      String(inAmountRaw),
        slippageBps: '300',   // großzügig – nur für Probe, beeinflusst Quote-Rate nicht
    });
    const res = await fetch(`${QUOTE_API}?${params}`);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Jupiter Quote: HTTP ${res.status} – ${text}`);
    }
    const q = await res.json();
    if (!q?.outAmount) throw new Error('Jupiter Quote: kein outAmount in Antwort');
    return {
        outAmount:    parseFloat(q.outAmount) / 10 ** outputDecimals,
        outAmountRaw: parseFloat(q.outAmount),
        inAmountRaw,
    };
}

/**
 * Tauscht inputToken gegen outputToken via Jupiter.
 *
 * @param {object} params
 * @param {string} params.inputMint       Mint-Adresse des Input-Tokens
 * @param {string} params.outputMint      Mint-Adresse des Output-Tokens
 * @param {number} params.inputDecimals   Decimals des Input-Tokens
 * @param {number} params.outputDecimals  Decimals des Output-Tokens
 * @param {number} params.amount          Zu tauschende Menge in Token-Einheiten (z.B. 100.0 USDC)
 * @param {import('@solana/web3.js').Keypair}    params.wallet
 * @param {import('@solana/web3.js').Connection} params.connection
 * @param {string|null} [params.apiKey]   Optionaler API-Key für den Proxy
 * @returns {Promise<{ amountOut: number, txSignature: string }>}
 */
export async function swapTokens({ inputMint, outputMint, inputDecimals, outputDecimals,
                                   amount, wallet, connection, apiKey = null,
                                   slippageBps = SLIPPAGE_BPS,
                                   retries = DEFAULT_RETRIES }) {
    let lastErr;
    let excludeDexes = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await _doSwapOnce({
                inputMint, outputMint, inputDecimals, outputDecimals,
                amount, wallet, connection, apiKey, slippageBps, excludeDexes,
            });
        } catch (err) {
            lastErr = err;
            const retryable = isRetryableSwapError(err);
            if (attempt < retries && retryable) {
                if (!excludeDexes && isWhirlpoolMintOrderError(err)) {
                    excludeDexes = 'Whirlpool';
                    console.warn('[swap] Whirlpool-Routing-Fehler (0x1788) erkannt — nächster Versuch ohne Whirlpool-Route');
                }
                const wait = RETRY_BACKOFF_MS[attempt - 1] ?? 8000;
                console.warn(`[swap] Versuch ${attempt}/${retries} fehlgeschlagen (${err.message}) — Retry in ${wait}ms`);
                await sleep(wait);
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

async function _doSwapOnce({ inputMint, outputMint, inputDecimals, outputDecimals,
                              amount, wallet, connection, apiKey, slippageBps, excludeDexes = null }) {
    const inAmount = Math.round(amount * 10 ** inputDecimals);

    // 1. Quote holen — jeder Retry-Versuch holt frisches Quote (Routes invalidieren schnell)
    const quoteParams = new URLSearchParams({
        inputMint,
        outputMint,
        amount:           String(inAmount),
        slippageBps:      String(slippageBps),
        onlyDirectRoutes: 'false',
    });
    if (excludeDexes) quoteParams.set('excludeDexes', excludeDexes);

    const quoteRes = await fetch(`${QUOTE_API}?${quoteParams}`, { headers: headers(apiKey) });
    if (!quoteRes.ok) {
        const err = await quoteRes.text();
        throw new Error(`Jupiter Quote API: HTTP ${quoteRes.status} – ${err}`);
    }

    const quote = await quoteRes.json();
    if (!quote?.outAmount) {
        throw new Error('Jupiter Quote API: kein outAmount in Antwort');
    }

    // 2. Swap-Transaktion holen
    const swapRes = await fetch(SWAP_API, {
        method:  'POST',
        headers: headers(apiKey),
        body:    JSON.stringify({
            quoteResponse:             quote,
            userPublicKey:             wallet.publicKey.toBase58(),
            wrapAndUnwrapSol:          true,
            dynamicComputeUnitLimit:   true,
            prioritizationFeeLamports: 'auto',
        }),
    });

    if (!swapRes.ok) {
        const err = await swapRes.text();
        throw new Error(`Jupiter Swap API: HTTP ${swapRes.status} – ${err}`);
    }

    const swapData = await swapRes.json();
    if (!swapData?.swapTransaction) {
        throw new Error('Jupiter Swap API: keine swapTransaction in Antwort');
    }

    // 3. Signieren + senden
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx    = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    // Unbestätigter Ausgang ist KEIN Fehlschlag: erst on-chain nachsehen, dann
    // entscheiden. Ohne diese Klärung würde der Retry in swapTokens denselben
    // Tausch ein zweites Mal ausführen (siehe resolveUnconfirmedSwap).
    let sig;
    try {
        sig = await submitAndConfirm(tx.serialize());
    } catch (err) {
        if (!err?.unconfirmed || !err?.signature) throw err;

        console.warn(`[swap] Confirm-Timeout — prüfe on-chain ob ${err.signature.slice(0, 12)}… gelandet ist…`);
        const outcome = await resolveUnconfirmedSwap(connection, err.signature);

        if (outcome === 'landed') {
            console.warn(`[swap] TX ist trotz Timeout gelandet (${err.signature}) – werte als Erfolg, KEIN zweiter Swap.`);
            sig = err.signature;
        } else if (outcome === 'failed' || outcome === 'gone') {
            console.warn(`[swap] TX ist nicht wirksam geworden (${outcome}) – Retry ist gefahrlos.`);
            throw err;
        } else {
            // Ausgang offen: ein Retry könnte doppelt tauschen. Lieber hier abbrechen
            // und den Aufrufer scheitern lassen — der Cleanup holt es eine Stunde
            // später nach, ein Doppel-Swap wäre dagegen sofort verlorenes Geld.
            err.doubleSpendRisk = true;
            err.message = `${err.message} — Ausgang on-chain nicht klärbar, kein Retry (Doppel-Swap-Gefahr). Signatur: ${err.signature}`;
            throw err;
        }
    }

    const amountOut = parseFloat(quote.outAmount) / 10 ** outputDecimals;
    return { amountOut, txSignature: sig };
}
