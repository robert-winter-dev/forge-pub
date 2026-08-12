/**
 * FORGE public – Master- vs. Fork-Erkennung für geteilten Code
 *
 * `bots/settings/**` ist dieselbe Datei auf dem Master und auf jedem FORGE-public-Fork
 * (siehe tools/pub-export/CLAUDE.md „Bug-Parität ist NICHT automatisch"). Manche
 * Funktionen dürfen aber NUR im Fork sichtbar sein — allen voran das Premium-Wallet:
 * der Master zahlt nicht für sich selbst, ein Premium-Eintrag im Master-Adressbuch
 * wäre bedeutungslos und irreführend.
 *
 * Wiederverwendet exakt das Signal, das core/premium/server.js bereits für denselben
 * Zweck nutzt (`IS_MASTER_IDENTITY`, dort seit 2026-07-27): `NOSTR_IDENTITY` in
 * `core/premium/.env` steht auf dem Master nie (Default `FORGE.Master`), auf jedem
 * Fork setzt der Installer sie explizit auf `forge-pub-nostr`. Kein neues Signal,
 * keine neue Konfigurationsdatei — nur ein zweiter Leser desselben Werts, für
 * Prozesse (bots/settings), die core/premium/.env bisher nicht laden.
 *
 * Bewusst NICHT über `process.env` (das würde bots/settings/.env vermischen),
 * sondern die Datei gezielt geparst — unabhängig davon, ob der aktuelle Prozess sie
 * selbst geladen hat.
 */

import { readFileSync, existsSync } from 'fs';
import { envFile } from '../config/paths.js';

const PREMIUM_ENV_PATH = envFile('premium');

let _cached; // Ergebnis ändert sich nie zur Laufzeit eines Prozesses (Installer schreibt vor dem ersten Start).

/**
 * Minimaler, dependency-freier .env-Zeilenparser (nur `KEY=VALUE`, `#`-Kommentare,
 * optionale An-/Abführungszeichen). `lib/` wird aus mehreren Bot-Verzeichnissen mit je
 * eigenem `node_modules` importiert (core/premium, bots/settings, bots/liquidity) —
 * ein `dotenv`-Import würde hier je nach Aufrufer mal auflösen und mal nicht.
 */
function readNostrIdentityName() {
    if (!existsSync(PREMIUM_ENV_PATH)) return 'FORGE.Master'; // Default, siehe core/premium/server.js
    try {
        const raw = readFileSync(PREMIUM_ENV_PATH, 'utf8');
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eq = trimmed.indexOf('=');
            if (eq === -1) continue;
            const key = trimmed.slice(0, eq).trim();
            if (key !== 'NOSTR_IDENTITY') continue;
            let value = trimmed.slice(eq + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            return value.trim() || 'FORGE.Master';
        }
        return 'FORGE.Master';
    } catch {
        return 'FORGE.Master';
    }
}

/** true auf dem Master (zentrale Support-/Premium-Identität), false auf jedem Fork. */
export function isMasterInstance() {
    if (_cached === undefined) _cached = readNostrIdentityName() === 'FORGE.Master';
    return _cached;
}

/** true auf jedem FORGE-public-Fork. Reine Bequemlichkeit, invers zu isMasterInstance(). */
export function isForkInstance() {
    return !isMasterInstance();
}

/** Nur für Tests: erzwingt eine Neuauswertung statt des gecachten Werts. */
export function _resetCacheForTests() {
    _cached = undefined;
}

export function selfTest() {
    const failures = [];
    _resetCacheForTests();
    // Auf DIESEM System (Master, core/premium/.env ohne NOSTR_IDENTITY oder mit FORGE.Master)
    // muss isMasterInstance() true liefern — echter Zustand, kein Mock.
    if (!isMasterInstance()) {
        failures.push('isMasterInstance() liefert false auf dem Master-Checkout – core/premium/.env NOSTR_IDENTITY prüfen');
    }
    if (isForkInstance() === isMasterInstance()) {
        failures.push('isForkInstance() ist nicht invers zu isMasterInstance()');
    }
    return { ok: failures.length === 0, failures };
}
