/**
 * Senden im Notbetrieb des Nexus (CORE#000992).
 *
 * Ist das Helius-Kontingent erschöpft, weicht der Nexus auf den öffentlichen Solana-RPC
 * aus (core/nexus/rpc-fallback.js, CORE#000814). Wallet-Sendungen der Settings-Oberfläche
 * dürfen dort durch (FALLBACK_SEND_CALLERS), alle anderen Schreibzugriffe nicht.
 *
 * Dieses Modul liefert den Settings-Routen zwei Dinge:
 *   • addFallbackPriorityFee(): Im Notbetrieb bekommt die Transaktion eine Priority Fee.
 *     Der öffentliche RPC leitet ohne bevorzugte Verbindung weiter, bei Netzlast verfallen
 *     Transaktionen ohne Fee dort deutlich öfter. Außerhalb des Notbetriebs bleibt die
 *     Transaktion unverändert.
 *   • respondSendError(): Lehnt der Nexus trotzdem ab (data.forgeFallback), bekommt die
 *     Oberfläche eine übersetzte Meldung mit Status 503 statt des rohen RPC-JSON, das
 *     @solana/web3.js in err.message packt ("503 Service Unavailable: {...}").
 */
import { ComputeBudgetProgram } from '@solana/web3.js';
import { t } from './i18n.js';

const FALLBACK_MARK = /"forgeFallback"\s*:\s*true/;

// Priority Fee im Notbetrieb, in Mikro-Lamports je Compute Unit. Die Spanne begrenzt
// die Kosten auch bei Ausreißern: 200 000 CU × 2 000 000 µL = 0,0004 SOL höchstens.
export const FALLBACK_FEE_MIN_MICROLAMPORTS = 50_000;
export const FALLBACK_FEE_MAX_MICROLAMPORTS = 2_000_000;
// Reicht für ATA-Anlage plus Transfer, auch bei Token-2022 (typisch < 40 000 CU).
export const FALLBACK_CU_LIMIT = 200_000;

export function isFallbackRpcError(err) {
    if (!err) return false;
    if (err.data?.forgeFallback === true || err.error?.data?.forgeFallback === true) return true;
    if (err.cause && err.cause !== err && isFallbackRpcError(err.cause)) return true;
    return typeof err.message === 'string' && FALLBACK_MARK.test(err.message);
}

/**
 * Antwortet auf einen fehlgeschlagenen Sendeversuch: Notbetrieb → 503 mit übersetzter
 * Meldung, alles andere unverändert (`fallbackStatus`, Meldung = err.message).
 */
export function respondSendError(res, err, fallbackStatus = 500) {
    if (isFallbackRpcError(err)) {
        return res.status(503).json({ error: t('api.wallet.send_fallback_rpc') });
    }
    return res.status(fallbackStatus).json({ error: err.message });
}

/**
 * Fragt den Nexus, ob der Notbetrieb aktiv ist. Der Nexus ist derselbe Dienst, an den die
 * Connection ihre RPC-Aufrufe schickt, deshalb wird die Adresse aus deren Endpunkt gebildet.
 * Ein Fehler zählt als „nicht aktiv": dann läuft alles wie vor CORE#000992.
 *
 * @param {string} rpcEndpoint  z. B. http://127.0.0.1:3100/rpc/fresh
 * @returns {Promise<boolean>}
 */
export async function isNexusFallbackActive(rpcEndpoint) {
    try {
        const r = await fetch(new URL('/health', rpcEndpoint), { signal: AbortSignal.timeout(3_000) });
        if (!r.ok) return false;
        const j = await r.json();
        return j?.rpcFallback?.active === true;
    } catch {
        return false;
    }
}

/** 75. Perzentil der jüngsten Priority Fees, auf die Spanne oben begrenzt. */
export function pickFallbackFee(recentFees) {
    const values = (recentFees ?? [])
        .map(f => Number(f?.prioritizationFee))
        .filter(v => Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);
    const p75 = values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.75))] : 0;
    return Math.min(FALLBACK_FEE_MAX_MICROLAMPORTS, Math.max(FALLBACK_FEE_MIN_MICROLAMPORTS, p75));
}

/**
 * Setzt im Notbetrieb Compute-Budget-Anweisungen an den Anfang der Transaktion.
 * Vor dem Signieren aufrufen. Gibt die gewählte Fee zurück (null = nichts geändert).
 *
 * @param {import('@solana/web3.js').Connection} connection
 * @param {import('@solana/web3.js').Transaction} tx
 * @returns {Promise<number|null>}
 */
export async function addFallbackPriorityFee(connection, tx) {
    if (!(await isNexusFallbackActive(connection.rpcEndpoint))) return null;

    let fee = FALLBACK_FEE_MIN_MICROLAMPORTS;
    try {
        fee = pickFallbackFee(await connection.getRecentPrioritizationFees());
    } catch (err) {
        console.warn(`[wallet/send] Priority Fees nicht abrufbar, nehme Mindestwert: ${err.message}`);
    }
    tx.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: FALLBACK_CU_LIMIT }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee }),
    );
    console.log(`[wallet/send] Notbetrieb: Senden über öffentlichen RPC, Priority Fee ${fee} µL/CU`);
    return fee;
}
