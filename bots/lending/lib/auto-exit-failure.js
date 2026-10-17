/**
 * FORGE Lending – Auto-Exit-Fehlschlag: Ursachenklasse und Meldungs-Takt (LEN#001363)
 *
 * Bis LEN#001363 bekam der Nutzer den Roh-Fehler des Bots (URL, abgeschnittener JSON-Body)
 * und stündlich dieselbe Meldung. Hier entscheidet reiner, testbarer Code:
 *
 *   1. classifyExitFailure() – welche VERSTÄNDLICHE Ursache steckt hinter dem Fehler?
 *      Der Rohtext bleibt im Bot-Log; die Meldung nennt nur die Klasse.
 *   2. createFailureTracker() – wie oft in Folge ist es für dasselbe Protokoll schiefgegangen,
 *      und ist diesmal eine Meldung fällig? Gleicher Fehler stündlich fünfmal ergibt keine
 *      fünf Meldungen.
 */

/** Ursachenklassen. Jede hat einen Katalogtext `notify.len.exit_reason.<klasse>`. */
export const EXIT_REASON = Object.freeze({
    NO_LIQUIDITY: 'no_liquidity',  // im Pool zu wenig frei für die ganze Position
    NETWORK:      'network',       // Verbindung/Timeout
    SIMULATION:   'simulation',    // Transaktion vor dem Senden nicht freigegeben, nichts gesendet
    PROVIDER:     'provider',      // Anbieter (Kamino, Loopscale …) hat Aufruf abgelehnt
    OTHER:        'other',
});

/** Klassen, bei denen der Bot es von selbst weiter versucht UND ein Warten sinnvoll ist. */
const SELF_HEALING = new Set([EXIT_REASON.NO_LIQUIDITY, EXIT_REASON.NETWORK]);

/** @returns {boolean} true: „Du musst nichts tun, der Bot versucht es erneut" */
export function isSelfHealing(reason) {
    return SELF_HEALING.has(reason);
}

const NETWORK_RE = /AbortError|aborted|timed? ?out|timeout|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network/i;

/**
 * Ursachenklasse eines gescheiterten Auto-Exit.
 *
 * Reihenfolge ist Absicht: Netzwerkfehler gehen vor, weil sie keine Aussage über die
 * Liquidität erlauben. Ist danach zu wenig Liquidität frei, ist DAS die Ursache, egal
 * welche Fehlermeldung der Anbieter dazu schickt (Kamino liefert dafür keinen eigenen Code).
 *
 * @param {object}  p
 * @param {Error}   p.err
 * @param {number|null} [p.liquidity]       freie Liquidität des Pools in USDC (null = unbekannt)
 * @param {number|null} [p.positionAmount]  Summe der offenen Positionen in diesem Pool in USDC
 * @returns {string} einer der Werte aus EXIT_REASON
 */
export function classifyExitFailure({ err, liquidity = null, positionAmount = null }) {
    const text = `${err?.name ?? ''} ${err?.message ?? ''}`;

    if (NETWORK_RE.test(text)) return EXIT_REASON.NETWORK;

    if (Number.isFinite(liquidity) && Number.isFinite(positionAmount)
        && positionAmount > 0 && liquidity < positionAmount) {
        return EXIT_REASON.NO_LIQUIDITY;
    }

    // wallet.js simulate() hängt technicalDetail an: Die TX wurde gebaut, aber nicht gesendet.
    if (err?.technicalDetail) return EXIT_REASON.SIMULATION;

    if (/HTTP\s+[45]\d\d/.test(text)) return EXIT_REASON.PROVIDER;

    return EXIT_REASON.OTHER;
}

/**
 * Fällig ist eine Meldung beim 1. Fehlversuch in Folge, beim 6. (nach ~einem halben
 * Tag bei stündlichem Takt) und danach alle 24. Dazwischen bleibt es im Log.
 */
export function shouldNotifyFailure(count) {
    return count === 1 || count === 6 || (count >= 24 && count % 24 === 0);
}

/**
 * Zähler „Fehlversuche in Folge" je Protokoll (nur im Speicher: ein Neustart des Bots
 * meldet den nächsten Fehlversuch bewusst wieder als ersten).
 */
export function createFailureTracker() {
    const counts = new Map();
    return {
        /** @returns {{count: number, notify: boolean}} */
        record(protocol) {
            const count = (counts.get(protocol) ?? 0) + 1;
            counts.set(protocol, count);
            return { count, notify: shouldNotifyFailure(count) };
        },
        /** Nach erfolgreichem Exit oder wenn der Schutz nicht mehr auslöst. */
        reset(protocol) {
            counts.delete(protocol);
        },
        /** Alle Protokolle zurücksetzen, die NICHT in `keep` stehen. */
        resetExcept(keep) {
            for (const protocol of [...counts.keys()]) {
                if (!keep.has(protocol)) counts.delete(protocol);
            }
        },
        count(protocol) {
            return counts.get(protocol) ?? 0;
        },
    };
}
