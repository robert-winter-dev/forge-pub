/**
 * FORGE – ZENTRALE FEHLERMELDUNGS-FUNKTION
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Wiederholt gab es Nutzer-Meldungen, die entweder (a) unverständlich waren
 * (roher Solana/Anchor-Fehler ohne Übersetzung) oder (b) verständlich, aber bei
 * unbekannten Fehlern nur auf eine Logdatei verwiesen statt die technischen
 * Details direkt mitzugeben. Beides führte dazu, dass der Nutzer nachfragen musste,
 * statt die Meldung direkt per Copy & Paste weiterzugeben.
 *
 * Ziel dieser Funktion: GENAU EINE Stelle für die Übersetzung bekannter
 * Solana/SPL-Fehlercodes in verständliche Sätze. Für alles Unbekannte wird der
 * volle Rohtext (inkl. Programm-Logs) immer direkt in die Meldung eingebettet —
 * nie nur ein Verweis auf ein Logfile. Copy & Paste der Telegram-Meldung muss
 * für die Diagnose immer reichen.
 *
 * Bekannte Fehlercodes sind hier bewusst nicht nach Bot/Protokoll aufgeteilt:
 * aktuell nutzt nur LiquidityMiningBot3 (Orca/Whirlpool) diese Liste. Braucht
 * ein anderer Bot eigene Codes, wird die Liste erweitert oder — falls die
 * Overlaps zu groß werden — aufgeteilt. Nicht vorab abstrahieren.
 *
 * Seit der Mehrsprachigkeit (Schritt 5) liefert die Funktion den Grund als
 * KATALOGSCHLÜSSEL statt als fertigen deutschen Satz — der Text entsteht erst beim
 * Anzeigen (lib/notify-render.js). Die Codes selbst (0x177f, INSUFFICIENT_FUNDS)
 * bleiben unverändert: sie sind Identität, keine Beschriftung.
 *
 * @param {Error|any} err
 * @returns {{reasonKey: string, reasonParams: object|null, detail: string, detailMode: 'none'|'inline'|'logref'}}
 *   reasonKey:  Katalogschlüssel des kurzen, verständlichen Satzes.
 *   detail:     voller Rohtext (Message, ggf. Logs) — immer gesetzt, nie leer.
 *               Für die DB/Diagnose immer verfügbar, unabhängig von detailMode.
 *   detailMode: steuert, ob `detail` in der NUTZER-Meldung erscheinen soll —
 *     'none'   — bekannter, übersetzter Fehler: der `reason`-Satz erklärt schon
 *                alles Nötige, der Rohtext wäre nur redundante Technik.
 *     'inline' — unbekannter Fehler, aber die Rohmeldung ist kurz/lesbar genug,
 *                um sie direkt mitzugeben (bisheriges Verhalten).
 *     'logref' — unbekannter UND technisch verschachtelter Fehler (Stacktrace,
 *                Program-Logs, SDK-Dump) — für einen Nicht-Techniker unlesbar.
 *                Statt sinnlosem Rohtext-Dump soll die Nutzer-Meldung neutral
 *                bleiben und auf das Service-Log verweisen (siehe notify.js).
 */

const MAX_DETAIL_LEN = 1500;

// Ab wann gilt ein unbekannter Rohtext als "zu technisch für eine Kurzmeldung"?
// Grobe Heuristik, kein Anspruch auf Präzision — lieber einmal zu vorsichtig
// (dann bleibt's inline) als eine wirklich kryptische Meldung durchzulassen.
const COMPLEX_MIN_NEWLINES = 3;
const COMPLEX_MAX_LEN      = 400;
const COMPLEX_MARKERS      = /Program log:|at Object\.|at async|at Module\.|SendTransactionError|getLogs\(\)/i;

function isComplexRaw(raw) {
    if (raw.length > COMPLEX_MAX_LEN) return true;
    if ((raw.match(/\n/g) || []).length >= COMPLEX_MIN_NEWLINES) return true;
    return COMPLEX_MARKERS.test(raw);
}

// `code` ist der stabile Schlüssel für Bots, die auf einen bestimmten Fehlertyp gezielt
// reagieren wollen (z.B. Fresh-Balance-Vergleich bei INSUFFICIENT_FUNDS) — siehe matchErrorCode().
const KNOWN_PATTERNS = [
    { code: 'INSUFFICIENT_FUNDS', test: /insufficient funds|0x1\n|0x1\.|0x1"/i,
      reasonKey: 'notify.err.insufficient_funds' },
    { code: 'LIQUIDITY_ZERO', test: /0x177c|LiquidityZero|ZeroLiquidity/i,
      reasonKey: 'notify.err.liquidity_zero' },
    { code: 'LIQUIDITY_UNDERFLOW', test: /0x177f|LiquidityUnderflow/i,
      reasonKey: 'notify.err.liquidity_underflow' },
    { code: 'CLOSE_NOT_EMPTY', test: /0x1775|ClosePositionNotEmpty/i,
      reasonKey: 'notify.err.close_not_empty' },
    { code: 'SLIPPAGE', test: /0x1782|TokenMinSubceeded/i,
      reasonKey: 'notify.err.slippage' },
    { code: 'SLIPPAGE', test: /0x17b5|slippage/i,
      reasonKey: 'notify.err.slippage' },
    { code: 'ROUTING', test: /0x1771|InvalidStartTick/i,
      reasonKey: 'notify.err.routing' },
    { code: 'NETWORK_TIMEOUT', test: /Blockhash not found|BlockheightExceeded/i,
      reasonKey: 'notify.err.network_timeout' },
];

/** Liefert den stabilen Code (z.B. 'INSUFFICIENT_FUNDS') des ersten passenden Musters, sonst null. */
export function matchErrorCode(err) {
    const raw = extractRawMessage(err);
    return KNOWN_PATTERNS.find(p => p.test.test(raw))?.code ?? null;
}

/** Extrahiert einen Solana-Programmfehlercode (z.B. "0x177f") aus einer rohen Fehlermeldung. */
function extractProgramErrorCode(raw) {
    const match = raw.match(/custom program error:\s*(0x[0-9a-f]+)/i);
    return match ? match[1] : null;
}

/**
 * `connection.confirmTransaction()` liefert einen Fehler eines bestätigten (aber
 * fehlgeschlagenen) Transfers als TransactionError-Objekt, z.B.
 * `{"InstructionError":[1,{"Custom":6018}]}` — der Custom-Code ist dezimal, alle
 * bekannten Codes hier (KNOWN_PATTERNS) sind hex (0x177f etc., Anchor-Konvention).
 * Ergänzt den Rohtext um die Hex-Form, damit die vorhandenen Patterns weiter greifen.
 *
 * 🔒 Regex-Suche statt `JSON.parse(raw)` auf den GANZEN String: Auf dem Standardweg über
 * die tx-queue (core/tx-queue-client.js) ist `raw` nie reines JSON, sondern immer in
 * erklärenden Text eingebettet, z.B. `tx-queue: Transaction failed – Transaction failed
 * on-chain: {"InstructionError":[2,{"Custom":14}]} (Signatur: …)`. Ein `JSON.parse()` auf
 * diesem String scheitert IMMER, wodurch die komplette Codeliste (SLIPPAGE, ROUTING,
 * LIQUIDITY_ZERO, …) für praktisch jeden bestätigten On-Chain-Fehlschlag blind blieb —
 * auch für längst bekannte, dokumentierte Orca-Fehler. Gefunden 2026-08-23 beim PUMP/SOL-
 * Auto-Swap (Custom:14, dort kein bekannter Code, aber die Lücke traf ausnahmslos alle).
 */
function normalizeConfirmTxError(raw) {
    const match = raw.match(/"InstructionError"\s*:\s*\[\s*\d+\s*,\s*\{\s*"Custom"\s*:\s*(\d+)\s*\}\s*\]/);
    if (match) {
        const custom = parseInt(match[1], 10);
        return `${raw} (custom program error: 0x${custom.toString(16)})`;
    }
    return raw;
}

/**
 * Extrahiert eine lesbare Fehlermeldung aus einem beliebigen Thrown-Wert.
 * Behandelt drei Problemfälle des Orca/Solana-SDK:
 *   1. err.message ist ein Objekt → String-Coercion ergibt "[object Object]"
 *   2. JSON.stringify(err) ergibt "{}" weil Error-Properties nicht-enumerable sind
 *   3. err selbst ist kein Error-Objekt sondern ein Plain-Object oder String
 */
function extractRawMessage(err) {
    if (!err) return '(unbekannter Fehler)';
    const msg = err.message;
    if (typeof msg === 'string' && msg && msg !== '[object Object]') return normalizeConfirmTxError(msg);
    try {
        const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err));
        if (serialized && serialized !== '{}' && serialized !== '""') return normalizeConfirmTxError(serialized);
    } catch (_) { /* circular reference — ignorieren */ }
    const str = String(err);
    if (str && str !== '[object Object]') return normalizeConfirmTxError(str);
    return '(Fehler-Details nicht lesbar)';
}

export function describeError(err) {
    const raw = extractRawMessage(err);
    const detail = raw.length > MAX_DETAIL_LEN
        ? `${raw.slice(0, MAX_DETAIL_LEN)}\n… (gekürzt, ${raw.length - MAX_DETAIL_LEN} weitere Zeichen)`
        : raw;

    const known = KNOWN_PATTERNS.find(p => p.test.test(raw));
    if (known) {
        return { reasonKey: known.reasonKey, reasonParams: null, detail, detailMode: 'none' };
    }

    const code = extractProgramErrorCode(raw);
    const detailMode = isComplexRaw(raw) ? 'logref' : 'inline';
    return code
        ? { reasonKey: 'notify.err.unknown_program', reasonParams: { code }, detail, detailMode }
        : { reasonKey: 'notify.err.unexpected',      reasonParams: null,     detail, detailMode };
}
