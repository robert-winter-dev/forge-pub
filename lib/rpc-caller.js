/**
 * FORGE – Verursacher-Kennung für RPC-Aufrufe (CORE#000846)
 *
 * `rpc_stats` schlüsselte den Helius-Verbrauch bis 2026-09-21 nur nach Methode auf.
 * Welcher Prozess die Credits verbraucht, war damit nur über Korrelation mit Bot-Logs
 * zu ermitteln — das funktioniert, solange ein Verursacher dominiert, und wird bei zwei
 * ähnlich großen uneindeutig (Befund CORE#000806, Punkt 4). Genau daran scheiterte am
 * 20.09.2026 die Zuordnung des größten Kostenblocks: `getAccountInfo` machte auf
 * forge-pub1 47 % aller Aufrufe aus, ohne dass sich der Auslöser benennen ließ.
 *
 * Jeder Client hängt seine Kennung als Header `x-forge-caller` an die Connection
 * (`httpHeaders`, siehe rpcCallerHeaders()), der Nexus schreibt sie als Spalte mit.
 *
 * 🔒 Bewusst ohne systemd-Änderung: Die Ableitung aus dem Skriptpfad funktioniert auf
 * Master und Fork identisch und braucht kein Deployment. Ein vergessener Env-Eintrag
 * würde sonst still zu `unknown` führen — also genau zu dem Zustand, den dieses Modul
 * beheben soll. `FORGE_RPC_CALLER` bleibt als Übersteuerung für Sonderfälle.
 */

import { dirname, resolve, relative, basename } from 'path';
import { fileURLToPath } from 'url';

/** Dieses Modul liegt in <root>/lib/ — damit ist das Repo-Wurzelverzeichnis bekannt. */
const FORGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const UNKNOWN_CALLER = 'unknown';

/**
 * Erlaubte Form einer Kennung: klein, kurz, ohne Sonderzeichen.
 *
 * 🔒 Gilt auch auf der Nexus-Seite für den empfangenen Header. Er kommt von localhost,
 * landet aber in einer DB-Spalte und in Reports — ein ungeprüfter Wert hätte dort nichts
 * zu suchen.
 */
const CALLER_PATTERN = /^[a-z0-9:_-]{1,32}$/;

/**
 * Prüft eine Kennung und bildet alles Unerlaubte auf `unknown` ab.
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeCaller(value) {
    if (typeof value !== 'string') return UNKNOWN_CALLER;
    const v = value.trim().toLowerCase();
    return CALLER_PATTERN.test(v) ? v : UNKNOWN_CALLER;
}

/**
 * Leitet die Kennung aus einem Skriptpfad relativ zum Repo-Wurzelverzeichnis ab.
 *
 * Reine Funktion, damit sie ohne laufenden Prozess testbar ist.
 *
 *   bots/liquidity/bin/bot.js      → 'liquidity'
 *   bots/lending/lib/wallet.js     → 'lending'
 *   core/wallet-monitor/monitor.js → 'wallet-monitor'
 *   bin/export.js                  → 'cli:export'
 *   (alles andere)                 → 'unknown'
 *
 * @param {string} relPath  Pfad relativ zum Repo-Wurzelverzeichnis, mit '/'
 * @returns {string}
 */
export function callerFromPath(relPath) {
    if (typeof relPath !== 'string' || relPath.length === 0) return UNKNOWN_CALLER;
    // Windows-Trenner gleichziehen, führendes './' entfernen
    const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');

    // Ein Pfad, der aus dem Repo herausführt, sagt nichts über den Verursacher.
    if (p.startsWith('../')) return UNKNOWN_CALLER;

    const parts = p.split('/').filter(Boolean);

    // bots/<name>/… und core/<name>/… → <name>
    if ((parts[0] === 'bots' || parts[0] === 'core') && parts.length >= 2) {
        return sanitizeCaller(parts[1]);
    }

    // bin/<script>.js → cli:<script>. Eigene Vorsilbe, weil ein CLI-Aufruf ein anderer
    // Verbrauchstyp ist als ein Dauerdienst: einmalig, oft manuell ausgelöst.
    if (parts[0] === 'bin' && parts.length >= 2) {
        return sanitizeCaller(`cli:${basename(parts[parts.length - 1], '.js')}`);
    }

    return UNKNOWN_CALLER;
}

/**
 * Kennung des laufenden Prozesses.
 *
 * Reihenfolge: `FORGE_RPC_CALLER` schlägt die Pfad-Ableitung. Das Ergebnis wird einmal
 * berechnet und gemerkt — es kann sich zur Laufzeit nicht ändern.
 *
 * @returns {string}
 */
let _cached = null;
export function rpcCaller() {
    if (_cached !== null) return _cached;

    const fromEnv = process.env.FORGE_RPC_CALLER;
    if (fromEnv) {
        const clean = sanitizeCaller(fromEnv);
        if (clean !== UNKNOWN_CALLER) return (_cached = clean);
    }

    const entry = process.argv[1];
    if (!entry) return (_cached = UNKNOWN_CALLER);

    return (_cached = callerFromPath(relative(FORGE_ROOT, resolve(entry))));
}

/**
 * Header-Objekt für `new Connection(url, { httpHeaders: rpcCallerHeaders() })`.
 *
 * Geprüft am 21.09.2026: @solana/web3.js sendet `httpHeaders` bei JEDEM HTTP-Request
 * mit, nicht nur beim ersten — ohne das wäre der ganze Ansatz wertlos.
 *
 * @returns {{ 'x-forge-caller': string }}
 */
export function rpcCallerHeaders() {
    return { 'x-forge-caller': rpcCaller() };
}

/** Nur für Tests: gemerkte Kennung verwerfen. */
export function _resetCallerCache() {
    _cached = null;
}
