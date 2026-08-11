// ══════════════════════════════════════════════════════════════════════════════
// FORGE – Grund für die Freigabe-Sperre eines Pools (pools.enabled_reason)
// ══════════════════════════════════════════════════════════════════════════════
// Die Spalte `pools.enabled_reason` erklärt in der Settings-UI (Tooltip am
// gesperrten Aktivieren-Button), WANN und WARUM ein Pool gesperrt wurde. Der Text
// entsteht beim SCHREIBEN — er kann also nicht wie ein Oberflächentext einfach in
// der gerade aktiven Sprache erzeugt werden: die Sprache kann sich zwischen
// Schreiben und Anzeigen ändern.
//
// Deshalb dasselbe Modell wie bei den Benachrichtigungen (
// Core/forge-pub/i18n.md §3e/§3f): gespeichert wird ein Katalog-Key mit
// Parametern, gerendert wird erst beim Lesen.
//
//   Schreiben:  setPoolEnabled(id, false, reasonPayload('reason.tvl_full_exit', {...}))
//   Lesen:      renderReason(row.enabled_reason)
//
// Altbestand (freier deutscher Text) bleibt unverändert lesbar — renderReason()
// gibt alles, was kein Key-Payload ist, unverändert zurück. Damit braucht es keine
// Migration und keinen Bruch bestehender Zeilen.
// ══════════════════════════════════════════════════════════════════════════════

import { t } from './i18n.js';

/**
 * Baut den zu speichernden Wert für `pools.enabled_reason`.
 *
 * @param {string} key                  Katalog-Key, z.B. 'reason.manual_disable'
 * @param {Record<string,any>} [params] Werte für {platzhalter} im Katalogtext
 * @returns {string} JSON-Payload für die Spalte
 */
export function reasonPayload(key, params) {
    return JSON.stringify(params ? { k: key, p: params } : { k: key });
}

/**
 * Rendert einen gespeicherten Grund in die aktive Sprache.
 *
 * @param {string|null|undefined} stored Spaltenwert
 * @returns {string|null} übersetzter Text, Altbestand unverändert, null wenn leer
 */
export function renderReason(stored) {
    if (!stored) return null;
    if (typeof stored !== 'string' || !stored.startsWith('{')) return stored;
    try {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed.k === 'string') return t(parsed.k, parsed.p);
    } catch { /* kein Payload – Altbestand, unverändert ausgeben */ }
    return stored;
}

export default { reasonPayload, renderReason };
