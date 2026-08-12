/**
 * FORGE public Premium – Zahlungs-Memo: bauen (Fork) und parsen (Master)
 *
 * Format:  FP1:<token>:<hourId>
 *
 *   FP1      Präfix + Version. Steigt, wenn sich das Format ändert (payment.md
 *            `memoVersion`). Der Master akzeptiert bewusst nur bekannte Versionen —
 *            ein unbekanntes Präfix ist keine Zahlung, die man „irgendwie" deuten darf.
 *   token    Aktivierungs-Token `T`, 32 hex (128 Bit). Bedeutungslos für Dritte; die
 *            Zuordnung `T → Kunden-Pubkey` existiert nur in premium.db des Masters.
 *            Genau deshalb steht hier NICHT der Nostr-Pubkey: sonst könnte jeder
 *            Chain-Beobachter Wallet und Nostr-Identität verketten (payment.md
 *            „Adressierung / Anonymität").
 *   hourId   Abgerechnete Stunde als Unix-Stunden (floor(ms / 3_600_000)). Macht die
 *            Zahlung eindeutig einer Abrechnungsperiode zuordenbar — ohne diese Angabe
 *            wäre bei zwei Zahlungen kurz vor/nach einem Stundenwechsel nicht
 *            entscheidbar, welche Stunde gemeint war.
 *
 * Beide Seiten brauchen dieselbe Wahrheit über das Format, deshalb lib/ statt core/premium/.
 */

export const MEMO_PREFIX = 'FP1';
export const MEMO_VERSION = 1;

/** Unix-Stunde eines Zeitpunkts — die Abrechnungseinheit von FORGE public Premium. */
export function hourIdOf(ms = Date.now()) {
    return Math.floor(ms / 3_600_000);
}

export function buildMemo(token, hourId) {
    if (!/^[0-9a-f]{32}$/i.test(token)) {
        throw new Error('buildMemo: token muss 32 hex-Zeichen haben');
    }
    if (!Number.isInteger(hourId) || hourId <= 0) {
        throw new Error('buildMemo: hourId muss eine positive Ganzzahl sein');
    }
    return `${MEMO_PREFIX}:${token.toLowerCase()}:${hourId}`;
}

/**
 * Zerlegt ein Memo. Bewusst streng: alles, was nicht exakt passt, ist `null` und damit
 * keine zuordenbare Zahlung. Ein Memo kommt von außen und ist nicht vertrauenswürdig —
 * hier wird nichts „repariert" oder erraten.
 *
 * @returns {{ token: string, hourId: number } | null}
 */
export function parseMemo(memo) {
    if (typeof memo !== 'string') return null;
    const parts = memo.trim().split(':');
    if (parts.length !== 3) return null;
    const [prefix, token, hourRaw] = parts;
    if (prefix !== MEMO_PREFIX) return null;
    if (!/^[0-9a-f]{32}$/i.test(token)) return null;
    if (!/^\d{1,10}$/.test(hourRaw)) return null;         // kein Vorzeichen, keine Exponenten
    const hourId = Number(hourRaw);
    if (!Number.isSafeInteger(hourId) || hourId <= 0) return null;
    return { token: token.toLowerCase(), hourId };
}

/**
 * Ist die im Memo genannte Stunde relativ zur Ausführungszeit plausibel?
 *
 * Ein Kunde zahlt für die laufende (oder unmittelbar bevorstehende) Stunde. Weit in der
 * Vergangenheit liegende Stunden dürfen nicht mehr gutgeschrieben werden — sonst könnte
 * jemand eine alte, nie eingelöste Zahlung nachträglich „aktivieren". Weit in der Zukunft
 * liegende ebenso wenig: das wäre Vorauszahlung und damit genau das Prepaid-Modell, das
 * pay-per-fetch bewusst vermeidet (payment.md).
 */
export const MEMO_HOUR_PAST_TOLERANCE = 2;   // Stunden
export const MEMO_HOUR_FUTURE_TOLERANCE = 1; // Stunden (Zahlung kurz vor Stundenwechsel)

export function isHourPlausible(hourId, atMs = Date.now()) {
    const nowHour = hourIdOf(atMs);
    return hourId >= nowHour - MEMO_HOUR_PAST_TOLERANCE
        && hourId <= nowHour + MEMO_HOUR_FUTURE_TOLERANCE;
}

export function selfTest() {
    const failures = [];
    const token = 'a'.repeat(32);
    const hour = hourIdOf(Date.parse('2026-07-29T05:30:00Z'));

    const memo = buildMemo(token, hour);
    if (memo !== `FP1:${token}:${hour}`) failures.push(`buildMemo lieferte "${memo}"`);

    const parsed = parseMemo(memo);
    if (parsed?.token !== token || parsed?.hourId !== hour) {
        failures.push(`Rundlauf fehlgeschlagen: ${JSON.stringify(parsed)}`);
    }

    // Alles Abweichende muss null sein — keine Kulanz bei Geld.
    const mustBeNull = [
        null, undefined, 42, '', 'FP1', 'FP1:x:1',
        `FP2:${token}:${hour}`,                       // unbekannte Version
        `fp1:${token}:${hour}`,                       // Präfix case-sensitiv
        `FP1:${token}`,                               // Feld fehlt
        `FP1:${token}:${hour}:extra`,                 // Feld zu viel
        `FP1:${'z'.repeat(32)}:${hour}`,              // kein hex
        `FP1:${'a'.repeat(31)}:${hour}`,              // zu kurz
        `FP1:${token}:-5`,                            // negative Stunde
        `FP1:${token}:1e5`,                           // Exponentialschreibweise
        `FP1:${token}:0`,                             // Stunde 0
        `FP1:${token}:99999999999999`,                // absurd groß
    ];
    for (const bad of mustBeNull) {
        if (parseMemo(bad) !== null) failures.push(`parseMemo(${JSON.stringify(bad)}) hätte null sein müssen`);
    }

    // Groß geschriebener Token wird normalisiert (Chain-Memos können beides liefern).
    if (parseMemo(`FP1:${'A'.repeat(32)}:${hour}`)?.token !== 'a'.repeat(32)) {
        failures.push('Großgeschriebener Token wurde nicht normalisiert');
    }

    // Plausibilitätsfenster.
    const now = Date.parse('2026-07-29T05:30:00Z');
    const h = hourIdOf(now);
    if (!isHourPlausible(h, now)) failures.push('laufende Stunde gilt als unplausibel');
    if (!isHourPlausible(h + 1, now)) failures.push('nächste Stunde hätte plausibel sein müssen');
    if (isHourPlausible(h + 2, now)) failures.push('zwei Stunden im Voraus wären Prepaid – muss abgelehnt werden');
    if (!isHourPlausible(h - 2, now)) failures.push('zwei Stunden Rückstand hätte toleriert werden müssen');
    if (isHourPlausible(h - 3, now)) failures.push('drei Stunden alte Zahlung darf nicht mehr zählen');

    return { ok: failures.length === 0, failures };
}
