/**
 * FORGE Liquidity – Plausibilitätsprüfung der Quote-Preisquelle
 *
 * Vergleicht den Referenzpreis (`oracle_prices`, seit 2026-08-27 von Jupiter) mit dem real
 * gehandelten Pool-Preis (`pool_stats` des Referenzpools). Beide beschreiben dasselbe: den
 * USD-Wert des Quote-Tokens. Laufen sie auseinander, ist eine der beiden Quellen kaputt.
 *
 * Seit der Quellen-Umkehr am 2026-08-27 bewertet `getQuotePriceUsd()` mit dem Pool-Preis;
 * der Referenzpreis ist nur noch Gegenprobe und Rückfallebene. Die Prüfung bleibt trotzdem
 * wichtig — sie ist die einzige Stelle, an der eine abdriftende Quelle überhaupt auffällt,
 * gleich welche der beiden abdriftet.
 *
 * 🔒 **Frisch ist nicht dasselbe wie richtig.** Das ist der Grund für dieses Modul, und der
 * Vorfall, der es ausgelöst hat, ist die beste Erklärung dafür (CORE#0334):
 *
 * Hermes (Pyth) lieferte ab dem 26.08.2026 um 18:11 Uhr durchgehend HTTP 401 — der Dienst
 * verlangt seither einen API-Key. Der damalige Nexus-Proxy gab bei jedem Fehlschlag den
 * letzten gecachten Preis als *normale* Antwort zurück, ohne Kennzeichnung. Der Aufrufer
 * konnte einen Notbehelf nicht von einem frischen Wert unterscheiden und schrieb ihn mit
 * `updated_at = Date.now()` fort; die 5-Minuten-Frischeprüfung hatte damit nichts mehr,
 * woran sie den Ausfall erkennen konnte. Acht Stunden lang galt SOL als 95,8913 wert,
 * während der Markt auf ~101,7 lief — alle X/SOL-Pools rund 6 % zu niedrig bewertet, in
 * Bewertung, PnL und Trailing-Stop-Referenz gleichermaßen.
 *
 * Dasselbe Muster stand schon am 22.08. im Changelog (Position 78, cbBTC/SOL: pool_stats
 * 99,37 vs. Pyth 93,50 = 5,9 %) — dort als veralteter `pool_stats`-Wert eingeordnet und die
 * Buchung auf Pyth umgestellt, statt zu prüfen, ob Pyth selbst stimmt. Das stellte
 * Konsistenz her statt Richtigkeit und nahm dem System die letzte unabhängige Gegenprobe.
 * Genau die stellt dieses Modul wieder her.
 *
 * Pyth und sein Proxy sind seit dem 2026-08-27 entfernt; die Lehre gilt für jeden Cache mit
 * Fallback: Ein ausgelieferter Notbehelf muss als solcher erkennbar sein.
 *
 * Bewusst DB-frei und ohne Seiteneffekte, damit die Entscheidung ohne Bot-Umgebung
 * durchgespielt werden kann — gleiches Prinzip wie `evaluateTsTrigger()` in trailing-stop.js.
 */

/**
 * Schwelle, ab der die beiden Preisquellen als unvereinbar gelten.
 *
 * 🔒 Die Grenze ist die Trailing-Stop-Schwelle, nicht ein „großzügiger" Wert darüber:
 * Stufe 1 liegt bei den volatilen Pools auf 2 %. Ein Bewertungsfehler, der so groß ist wie
 * die Schutzschwelle selbst, macht den Schutz bedeutungslos — er verschiebt genau die
 * Messlatte, gegen die gemessen wird. Deshalb wird bei 2 % gewarnt und nicht erst darüber.
 */
export const DEFAULT_MAX_DIVERGENCE_PCT = 2;

/**
 * Wie viele aufeinanderfolgende Zyklen die Divergenz bestehen muss, bevor gemeldet wird.
 *
 * `pool_stats` wird nur alle paar Minuten fortgeschrieben, der Oracle-Wert alle fünf.
 * Bei einer schnellen Marktbewegung können beide deshalb kurzzeitig 2 % auseinanderliegen,
 * ohne dass etwas kaputt ist. Ein echter Feed-Ausfall hält dagegen an. Drei Zyklen (~15 Min)
 * trennen beides zuverlässig, ohne die Meldung nennenswert zu verzögern — dasselbe Prinzip
 * wie die „2 Fehlschläge in Folge"-Regel in bin/health-check.js.
 */
export const DEFAULT_CONFIRM_CYCLES = 3;

/**
 * Vergleicht Oracle- und Pool-Preis.
 *
 * Referenz ist bewusst der **Pool-Preis**, nicht der Oracle-Wert: Der Pool-Preis entsteht aus
 * real ausgeführten Swaps und wird durch Arbitrage am Markt gehalten. Er ist die Größe, zu
 * der der Bot tatsächlich kauft und verkauft — ein Oracle, das davon abweicht, beschreibt
 * einen Markt, an dem niemand handelt.
 *
 * @param {number|null} oraclePrice  Preis aus oracle_prices (Pyth)
 * @param {number|null} poolPrice    Preis aus pool_stats des Referenzpools
 * @param {number} maxDivergencePct  Toleranz in Prozent
 * @returns {{ comparable: boolean, plausible: boolean, divergencePct: number,
 *             oraclePrice: number|null, poolPrice: number|null }}
 */
export function evaluateQuotePriceSanity(oraclePrice, poolPrice,
                                         maxDivergencePct = DEFAULT_MAX_DIVERGENCE_PCT) {
    const o = Number(oraclePrice);
    const p = Number(poolPrice);

    // Fehlt eine der beiden Quellen, gibt es nichts zu vergleichen. Das ist ausdrücklich
    // KEIN Befund: ein neuer Pool ohne pool_stats-Historie darf keine Warnung auslösen.
    if (!(o > 0) || !(p > 0)) {
        return { comparable: false, plausible: true, divergencePct: 0,
                 oraclePrice: o > 0 ? o : null, poolPrice: p > 0 ? p : null };
    }

    const divergencePct = ((o - p) / p) * 100;
    return {
        comparable: true,
        plausible:  Math.abs(divergencePct) <= maxDivergencePct,
        divergencePct,
        oraclePrice: o,
        poolPrice:   p,
    };
}

/**
 * Zustandsbehafteter Zähler je Referenzpool — hält fest, wie oft die Divergenz in Folge
 * bestand, und entscheidet, ob jetzt gemeldet werden soll.
 *
 * Absichtlich nur im Prozessspeicher: Der Zustand beschreibt „wie lange läuft die Störung
 * schon", nicht „was ist passiert". Nach einem Bot-Neustart neu zu zählen ist richtig — die
 * Meldung käme dann eben 15 Minuten später erneut, statt einen Stand aus einer früheren
 * Laufzeit fortzuschreiben, der vielleicht gar nicht mehr gilt.
 */
const _streak = new Map();   // quotePoolId → { count, notified }

/**
 * Nach den ersten Zyklen nur noch jeder N-te Durchlauf ins Log.
 *
 * 🔒 Der Bot-Zyklus läuft alle ~30 Sekunden, nicht alle fünf Minuten. Eine Zeile je Zyklus
 * wären rund 2.600 pro Tag — dieselbe Fehlerklasse, die in derselben Nacht in
 * `forge-settings` 27.000 `ECONNREFUSED`-Zeilen erzeugt und den eigentlichen Befund darin
 * begraben hat (siehe doc/CHANGELOG/2026-08-27.md). Eine Störung, die anhält, muss lesbar
 * bleiben, nicht laut sein: die ersten Zyklen vollständig (dort entsteht die Meldung),
 * danach ein Statuseintrag alle ~15 Minuten.
 */
const LOG_EVERY_N_CYCLES = 30;

/**
 * @returns {{ verdict: Object, shouldNotify: boolean, shouldLog: boolean, streak: number }}
 *   `shouldNotify` ist genau EINMAL true, sobald die Divergenz `confirmCycles` Zyklen
 *   angehalten hat — nicht in jedem weiteren Zyklus. Sonst käme alle 30 Sekunden dieselbe
 *   Meldung, und laut Meldungs-Konvention verwässert eine sich wiederholende Warnung ohne
 *   neue Information genau die Aufmerksamkeit, die sie braucht.
 *   `shouldLog` steuert dasselbe für das Logfile, nur großzügiger (siehe oben).
 */
export function trackQuotePriceSanity(quotePoolId, oraclePrice, poolPrice, {
    maxDivergencePct = DEFAULT_MAX_DIVERGENCE_PCT,
    confirmCycles    = DEFAULT_CONFIRM_CYCLES,
} = {}) {
    const verdict = evaluateQuotePriceSanity(oraclePrice, poolPrice, maxDivergencePct);
    const prev    = _streak.get(quotePoolId) ?? { count: 0, notified: false };

    if (!verdict.comparable || verdict.plausible) {
        // Erholt: Zähler zurücksetzen, damit eine spätere Störung wieder meldet. Der Wechsel
        // zurück in den plausiblen Bereich wird selbst einmal geloggt — sonst endet die
        // Störung im Log ohne erkennbaren Schluss und niemand weiß, ob sie noch läuft.
        if (prev.count > 0) {
            _streak.set(quotePoolId, { count: 0, notified: false });
            return { verdict, shouldNotify: false, shouldLog: true, streak: 0, recovered: true };
        }
        return { verdict, shouldNotify: false, shouldLog: false, streak: 0 };
    }

    const count        = prev.count + 1;
    const shouldNotify = count >= confirmCycles && !prev.notified;
    const shouldLog    = count <= confirmCycles || count % LOG_EVERY_N_CYCLES === 0;
    _streak.set(quotePoolId, { count, notified: prev.notified || shouldNotify });
    return { verdict, shouldNotify, shouldLog, streak: count };
}

/** Nur für Tests: setzt die Zähler zurück. */
export function _resetSanityState() {
    _streak.clear();
}
