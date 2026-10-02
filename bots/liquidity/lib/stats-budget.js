/**
 * Liquidity Bot – Stats-Intervall inaktiver Pools aus Helius-Tagesbudget ableiten (LIQ#000807)
 *
 * Die Pool-Stats von Pools OHNE Kapital speisen nur das Score-Ranking. Ihr Helius-Verbrauch
 * hängt an der Katalog-Größe, nicht am Kapital (CORE#000806): Der Katalog wuchs von 28 Pools
 * (01.08.2026) auf 57 (19.09.2026), und bin/scan-new-pools.js kennt keine Obergrenze. Statt
 * eines festen Intervalls rechnet der Bot deshalb aus, wie oft er sich den Katalog leisten
 * kann. Wächst er, wird der Sweep seltener, der Tagesverbrauch bleibt gleich.
 *
 * Pure Funktion, keine Seiteneffekte, keine DB.
 */

import { ACCOUNTS_PER_CALL } from './pool-price-bulk.js';

/** Gemessen 4,77–4,87 Credits je Pool-Zyklus am 19.09.2026 (Stats-Zyklen ↔ getAccountInfo
 *  über 3 Stunden). Bewusst aufgerundet, damit das Budget eher unter- als überschritten wird.
 *  Neu messen, wenn das Orca-SDK aktualisiert wird oder sich _getPriceOnChain() ändert. */
export const CREDITS_PER_POOL_CYCLE = 5.0;

/** Ergibt bei den heutigen 54 inaktiven Pools ~60 Min: Der Regler friert den Ist-Zustand
 *  gegen Wachstum ein, statt ihn zu ändern. */
export const DAILY_BUDGET_CREDITS = 6_500;

/** Nie häufiger als die Pools mit Kapital (STATS_INTERVAL_MS). */
export const MIN_INTERVAL_MS = 10 * 60 * 1000;

/** Untergrenze der Datenqualität fürs Ranking. */
export const MAX_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Modell „gebündelter Preis-Read" (LIQ#000854, seit 21.09.2026): Ein Sweep kostet
 *  ceil(Pools / 100) getMultipleAccounts-Aufrufe, je 1 Credit. TVL/APR/Fees kommen von der
 *  Orca-v2-REST-API (keine Helius-Credits), Volumen-Kerzen von GeckoTerminal. Gilt nur, wo der
 *  Sweep tatsächlich gebündelt liest (Adapter mit getPricesOnChainBulk). */
export const CREDITS_PER_BULK_CALL = 1;

const DAY_MS = 86_400_000;

/**
 * 🔒 Greift MAX, wird das Budget bewusst überschritten (bei 400 Pools ~8.000 statt 6.500
 * Credits/Tag): lieber eine sichtbare Warnung als eine still unbrauchbare Ranking-Grundlage.
 * Dann muss der Katalog begrenzt oder das Budget angehoben werden — Entscheidung für den
 * Betreiber, nicht für den Regler.
 *
 * @param {number} inactivePoolCount
 * @param {{ bulk?: boolean }} [opts]  bulk = Sweep liest die Preise gebündelt (CREDITS_PER_BULK_CALL)
 * @returns {{ intervalMs: number, clamped: 'min'|'max'|null }}
 */
export function inactiveStatsIntervalMs(inactivePoolCount, { bulk = false } = {}) {
    if (!(inactivePoolCount > 0)) return { intervalMs: MIN_INTERVAL_MS, clamped: 'min' };

    // bulk: Kosten je Sweep = ceil(Pools / 100) Aufrufe statt 5 Credits je Pool (LIQ#001114).
    // Der Regler bleibt aktiv: wüchse der Katalog auf Größenordnungen, in denen selbst das nicht mehr
    // ins Budget passt, würde der Takt wieder seltener. Heute (73 Pools) greift die MIN-Klemme.
    const raw = bulk
        ? DAY_MS * Math.ceil(inactivePoolCount / ACCOUNTS_PER_CALL) * CREDITS_PER_BULK_CALL / DAILY_BUDGET_CREDITS
        : DAY_MS * inactivePoolCount * CREDITS_PER_POOL_CYCLE / DAILY_BUDGET_CREDITS;
    if (raw <= MIN_INTERVAL_MS) return { intervalMs: MIN_INTERVAL_MS, clamped: 'min' };
    if (raw >= MAX_INTERVAL_MS) return { intervalMs: MAX_INTERVAL_MS, clamped: 'max' };
    return { intervalMs: raw, clamped: null };
}
