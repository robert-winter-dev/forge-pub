/**
 * Einzellauf-Wächter für Hintergrundaufgaben (LIQ#001114).
 *
 * Macht aus einer async Funktion einen Starter, der die Aufgabe im Hintergrund anstößt und nie
 * abwartet: Läuft sie noch, kehrt ein weiterer Aufruf sofort mit demselben Promise zurück, es
 * entstehen nie zwei Läufe gleichzeitig. Fehler werden an `onError` gemeldet und nicht
 * weitergeworfen — ein Hintergrundlauf darf den Aufrufer (Bot-Hauptloop) nie stoppen.
 *
 * @param {Function} fn  async (...args) => any
 * @param {{ onError?: (err: Error) => void }} [opts]
 * @returns {(...args) => Promise<void>}
 */
export function singleFlight(fn, { onError = () => {} } = {}) {
    let inFlight = null;
    return (...args) => {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            try { await fn(...args); }
            catch (err) { onError(err); }
            finally { inFlight = null; }
        })();
        return inFlight;
    };
}
