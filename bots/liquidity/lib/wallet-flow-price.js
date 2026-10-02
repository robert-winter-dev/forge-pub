/**
 * FORGE Liquidity – USD-Preis eines Mints für wallet_flows (LIQ#001063)
 *
 * Eigenständig statt deposit-lib.js::getTokenUsdPrice() wiederzuverwenden: Diese
 * Funktion wird auch aus Prozessen aufgerufen, die NICHT der Liquidity-Bot selbst sind
 * (forge-settings für /liquidity/send, bin/transfer.js als eigenständiges CLI) — dort
 * würde ein Import von deposit-lib.js über wallet.js/config.js Modul-weite
 * Seiteneffekte (Keypair-/Config-Load relativ zum Liquidity-Bot-Arbeitsverzeichnis)
 * auslösen, die in einem fremden Prozess ins Leere greifen oder falsch greifen.
 *
 * Reine SQL-Abfrage auf eine übergebene, bereits geöffnete DB-Verbindung — keine
 * Seiteneffekte, kein Netzwerk. Deckt nur direkt/invers gegen USDC und den
 * SOL-Bridge-Fall ab (reicht für alles, was über /liquidity/send, einen Exit-Transfer
 * oder bin/transfer.js verschickt werden kann); der volle 4-stufige Fallback
 * (inkl. BTC-Peg) bleibt deposit-lib.js::getTokenUsdPrice() für den Bot-Prozess selbst
 * vorbehalten.
 */

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Für Backfill/Chain-Scan: ein Preis darf höchstens so alt sein (LIQ#001063,
 *  Abnahmekriterium „nächster Wert ≤ t, max. 90 Min alt"). Für den laufenden
 *  10-Min-Scan ist das faktisch nie die Grenze — dort ist praktisch immer ein
 *  frischer Snapshot da. */
export const WALLET_FLOW_PRICE_MAX_AGE_MS = 90 * 60 * 1000;
/** Gibt es vor atMs keinen Kurs (Bot lief zum Zeitpunkt der Einzahlung noch nicht — pub2
 *  25.09.2026: 0,15 SOL Ersteinzahlung vor dem ersten pool_stats-Eintrag), gilt der erste
 *  Kurs danach, höchstens so viel später. Eine ungebuchte Einzahlung zählte sonst voll als
 *  Gewinn (LIQ#001062); ein paar Stunden Kursdrift sind dagegen ein kleiner Fehler. */
export const WALLET_FLOW_PRICE_MAX_LEAD_MS = 6 * 3600 * 1000;

/**
 * @param {import('better-sqlite3').Database} db  readonly reicht
 * @param {string} mint
 * @param {number} [atMs]       Zeitpunkt, zu dem der Kurs gelten soll (Default: jetzt)
 * @param {number} [maxAgeMs]   ältester zulässiger Snapshot vor atMs (Default: 90 Min)
 * @returns {number|null}
 */
export function getWalletFlowUsdPrice(db, mint, atMs = Date.now(), maxAgeMs = WALLET_FLOW_PRICE_MAX_AGE_MS) {
    return _priceAt(db, mint, atMs, maxAgeMs, false)
        ?? _priceAt(db, mint, atMs, WALLET_FLOW_PRICE_MAX_LEAD_MS, true);
}

/** after=false: letzter Kurs in [atMs − window, atMs]; after=true: erster in [atMs, atMs + window]. */
function _priceAt(db, mint, atMs, window, after) {
    if (mint === USDC_MINT) return 1;
    const lo = after ? atMs : atMs - window;
    const hi = after ? atMs + window : atMs;
    const ord = after ? 'ASC' : 'DESC';

    const direct = db.prepare(`
        SELECT ps.price FROM pool_stats ps
        JOIN pools p ON ps.pool_id = p.id
        WHERE p.token_a = ? AND p.token_b = ? AND ps.recorded_at <= ? AND ps.recorded_at >= ?
        ORDER BY ps.recorded_at ${ord} LIMIT 1
    `).get(mint, USDC_MINT, hi, lo);
    if (direct) return direct.price;

    const inverse = db.prepare(`
        SELECT ps.price FROM pool_stats ps
        JOIN pools p ON ps.pool_id = p.id
        WHERE p.token_a = ? AND p.token_b = ? AND ps.recorded_at <= ? AND ps.recorded_at >= ?
        ORDER BY ps.recorded_at ${ord} LIMIT 1
    `).get(USDC_MINT, mint, hi, lo);
    if (inverse?.price > 0) return 1 / inverse.price;

    if (mint === WSOL_MINT) {
        const solUsd = db.prepare(`
            SELECT price FROM pool_stats
             WHERE pool_id = 'liq-sol-usdc' AND recorded_at <= ? AND recorded_at >= ?
             ORDER BY recorded_at ${ord} LIMIT 1
        `).get(hi, lo);
        if (solUsd?.price > 0) return solUsd.price;
    }
    return null;
}

export { USDC_MINT, WSOL_MINT };
