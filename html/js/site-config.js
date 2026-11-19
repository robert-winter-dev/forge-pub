/**
 * FORGE – Seitenkonfiguration (CORE#002084)
 *
 * Liest /forge/data/site-config.json. Die Datei entsteht NUR im Staging-Ordner von
 * bin/sync.sh (SYNC_SOURCE=pub1) und blendet Bots auf der öffentlichen Seite aus:
 *   { "hiddenBots": ["lending"] }
 * Fehlt sie (Master lokal, Port 3200, SYNC_SOURCE=master), ist alles sichtbar wie bisher.
 * Kein Fehler, kein Konsolenlärm: jede Abweichung ergibt die Vorgabe.
 */

let _promise = null;

/** @returns {Promise<{hiddenBots: string[]}>} */
export function loadSiteConfig() {
    if (!_promise) {
        _promise = fetch('/forge/data/site-config.json?v=' + Date.now(), { cache: 'no-store' })
            .then(r => (r.ok ? r.json() : null))
            .catch(() => null)
            .then(c => ({ hiddenBots: Array.isArray(c?.hiddenBots) ? c.hiddenBots.map(String) : [] }));
    }
    return _promise;
}
