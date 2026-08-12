/**
 * FORGE – EINE zentrale Versionsnummer für Master UND FORGE-public-Fork.
 *
 * Ersetzt (seit 2026-08-09) die vorher pro Bot unabhängig gepflegten bots/*​/VERSION-Dateien
 * und package.json-version-Felder (siehe config/version.json Kopf + doc/CHANGELOG/2026-08-09.md
 * für die Begründung). Jede Komponente, die "die aktuelle Version" anzeigen will, importiert
 * dieses Modul statt eine eigene Kopie zu lesen/pflegen.
 *
 * 🔒 cleanVersion() liefert IMMER reines a.b.c – core/premium/premium-pay.js meldet genau diesen
 * String per striktem Semver-Vergleich (lib/premium-min-version.js) an den Master. display()
 * (mit '+buildNumber') ist NUR für Menschen (Logs, Dashboards, artefakt-interne VERSION-Datei),
 * nie für Vergleiche verwenden.
 */

import { readFileSync } from 'fs';
import { PATHS } from '../config/paths.js';

export function readVersion(path = PATHS.version) {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const { version, versionCode, buildNumber, minDataSchema, hasMigrations } = raw;
    if (!version || !Number.isInteger(versionCode)) {
        throw new Error(`${path} ungültig: version=${version} versionCode=${versionCode}`);
    }
    return {
        version,
        versionCode,
        buildNumber: Number.isInteger(buildNumber) ? buildNumber : 0,
        minDataSchema,
        hasMigrations,
    };
}

/** Reines a.b.c – für alles, was verglichen/geparst wird (Semver-Checks, Anti-Downgrade). */
export function cleanVersion() {
    return readVersion().version;
}

/** 'a.b.c' (buildNumber 0, = stabiler Stand) oder 'a.b.c+d' – für Menschen (Logs, UI, Dateien). */
export function displayVersion() {
    const { version, buildNumber } = readVersion();
    return buildNumber > 0 ? `${version}+${buildNumber}` : version;
}
