/**
 * FORGE Liquidity – Schutz vor „verwaisten" Promise.all-Legs
 *
 * `Promise.all([a, b])` wirft, sobald das ERSTE Leg ablehnt — der äußere try/catch
 * fängt das sauber. Das ZWEITE Leg läuft aber im Hintergrund weiter (z.B. noch
 * laufende RPC-Retries). Lehnt es später ebenfalls ab, hat niemand mehr eine
 * .catch-Handhabe dafür: Node meldet eine `unhandledRejection`, unabhängig vom
 * längst abgeschlossenen try/catch.
 *
 * Befund 2026-08-13: Genau dieses Muster erzeugte während des Helius-Ausfalls
 * (12.08., ~05:45–06:20 Uhr) drei UnhandledRejection-Alerts, obwohl der
 * eigentliche Fehler (Bulk-State-Fetch) längst korrekt behandelt war — Quelle war
 * Promise.all in getPositionStatesBulk() (orca.js). Das Muster fand sich an
 * 15 weiteren Stellen im Liquidity Bot.
 *
 * `settle()` hängt einen No-Op-.catch() an das ORIGINAL-Promise (nicht an eine
 * Kopie), bevor es in Promise.all landet. Node markiert das Promise damit als
 * „behandelt", sobald irgendein Handler daran hängt — das Aggregat-Verhalten von
 * Promise.all (erstes Reject wirft, Werte kommen wie gehabt durch) bleibt
 * unverändert.
 */

/**
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T>} dasselbe Promise, unverändert im Wert/Fehlerverhalten
 */
export function settle(promise) {
    promise.catch(() => {});
    return promise;
}
