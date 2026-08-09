/**
 * FORGE Lending – Notifications
 *
 * Sendet alle Notifications an FORGE Nexus (POST /notify).
 * Level wird aus dem Emoji-Präfix erkannt:
 *   🚨  → error  (DB + Telegram)
 *   ⚠️  → warn   (nur DB)
 *   sonst → info  (nur DB)
 * Category wird aus dem Nachrichtentext erkannt.
 */

import { existsSync }   from 'fs';
import path             from 'path';
import { config }       from './config.js';
import { getBotConfig } from '../../../lib/bot-registry.js';
import { FORGE_TZ }     from '../../../core/config.js';
import { PATHS }        from '../../../config/paths.js';

const NEXUS_URL       = 'http://127.0.0.1:3100';
const { displayName: BOT_DISPLAY_NAME } = getBotConfig('lending');
const NEXUS_BOT_ID    = config.botId ?? 'lending';
const UPDATE_SUPPRESS_FLAG = path.join(PATHS.data, 'update-notify-suppress');

/**
 * Während eines FORGE.pub-Updates gesetzt (bin/setup-lib/common.sh
 * update_notify_suppress_on) – do_update() sendet am Ende EINE Zusammenfassung
 * statt der Einzel-"gestartet"/"gestoppt"-Meldungen jedes neu gestarteten Bots
 * (Fund 2026-08-09). Ein Crash-Restart außerhalb eines Updates hat den Marker
 * nicht gesetzt und meldet sich weiterhin wie bisher.
 */
export function isUpdateInProgress() {
    return existsSync(UPDATE_SUPPRESS_FLAG);
}

function log(msg) {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[${ts}] ${msg}`);
}

function detectLevel(text) {
    if (text.startsWith('🚨')) return 'error';
    if (text.startsWith('⚠️')) return 'warn';
    if (text.startsWith('🟢') || text.startsWith('🔴')) return 'lifecycle';
    return 'info';
}

function detectCategory(text) {
    if (/Auto-Exit/i.test(text))       return 'system';
    if (/Auto-Deploy/i.test(text))     return 'trade';
    if (/TVL/i.test(text))             return 'system';
    if (/gestartet|gestoppt/i.test(text)) return 'system';
    return 'system';
}

// ─── Handlungsaufforderung ────────────────────────────────────────────────────
//
// 🔒 Regel (Betreiber-Vorgabe 2026-07-30): jede Meldung endet mit einem Satz, der
// sagt was zu tun ist — auch wenn die Antwort "nichts" ist. Adressat ist kein
// IT-Fachmann; ein reiner Befund lässt ihn ratlos zurück.
//
// Anders als im Liquidity Bot (dort steht jeder Text in lib/notify.js) formulieren
// hier ~16 Aufrufstellen in bin/bot.js ihren Text selbst. Die Zuordnung sitzt
// deshalb ZENTRAL hier — nach demselben Muster wie detectLevel/detectCategory,
// die den Text ebenfalls schon auswerten. Vorteil: neue Aufrufstellen bekommen
// automatisch mindestens den Level-Default, statt die Aufforderung zu vergessen.
//
// Reihenfolge zählt: die erste passende Regel gewinnt, spezifisch vor allgemein.
const ACTION_RULES = [
    [/SOL-Reserve kritisch/i,
        'Bitte Wallet mit mindestens 0,15 SOL aufladen – ohne SOL kann der Bot keine Transaktionen mehr senden.'],
    [/SOL-Topup fehlgeschlagen/i,
        'Der Bot versucht es im nächsten Zyklus erneut. Bleibt die Meldung, bitte Wallet manuell mit mindestens 0,15 SOL aufladen.'],
    [/SOL-Topup ausgeführt/i,
        'Es ist nichts zu tun, der Bot hat sich selbst versorgt.'],
    [/Auto-Exit ausgeführt/i,
        'Es ist nichts zu tun. Das Kapital liegt in deiner Wallet und wird beim nächsten Auto-Deploy neu angelegt.'],
    [/Auto-Exit .*fehlgeschlagen/i,
        'Das Kapital liegt noch im Pool. Der Bot versucht es erneut – bleibt die Meldung, bitte im Dashboard prüfen.'],
    [/Auto-Deploy übersprungen/i,
        'Es ist nichts zu tun. Das Geld bleibt in der Wallet, bis wieder ein passender Pool verfügbar ist.'],
    [/Auto-Deploy teilweise fehlgeschlagen/i,
        'Der nicht investierte Teil bleibt in deiner Wallet. Der Bot versucht es im nächsten Zyklus erneut.'],
    [/Auto-Deploy abgeschlossen/i,
        'Es ist nichts zu tun, diese Meldung dient nur zur Information.'],
    [/TVL (über|unter)/i,
        'Es ist nichts zu tun. Beobachte den Pool im Dashboard – der Bot steigt selbst aus, wenn die Exit-Schwelle erreicht wird.'],
    [/gestartet/i,
        'Es ist nichts zu tun, diese Meldung dient nur zur Information.'],
    [/gestoppt/i,
        'Es ist nichts zu tun – der Dienst startet automatisch neu. Bleibt eine Startmeldung aus, bitte den Bot-Status im Dashboard prüfen.'],
    [/UnhandledRejection/i,
        'Der Bot läuft weiter. Kommt diese Meldung wiederholt, bitte den Bot neu starten.'],
];

const ACTION_BY_LEVEL = {
    error:     'Bitte im Dashboard prüfen. Kommt die Meldung wiederholt, den Bot neu starten.',
    warn:      'Der Bot versucht es im nächsten Zyklus erneut. Es ist zunächst nichts zu tun.',
    info:      'Es ist nichts zu tun, diese Meldung dient nur zur Information.',
    lifecycle: 'Es ist nichts zu tun, diese Meldung dient nur zur Information.',
};

function detectAction(text, level) {
    for (const [pattern, action] of ACTION_RULES) {
        if (pattern.test(text)) return action;
    }
    return ACTION_BY_LEVEL[level] ?? ACTION_BY_LEVEL.info;
}

// Kopfzeile (Datum/Uhrzeit + Bot) auf JEDE Nachricht – Pool steht i.d.R. schon im
// Text selbst (siehe Aufrufer von sendTelegram), Level/Kategorie werden bewusst
// noch aus dem UNVERÄNDERTEN Text erkannt (detectLevel/-Category prüfen auf
// Emoji-Präfixe wie 🚨/⚠️, die durch die Kopfzeile sonst verdeckt würden).
export async function sendTelegram(text) {
    const level    = detectLevel(text);
    const category = detectCategory(text);
    const timestamp = new Intl.DateTimeFormat('de-DE', {
        timeZone: FORGE_TZ, day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(new Date());
    const fullText = `📅 ${timestamp} · ${BOT_DISPLAY_NAME}\n${text}\n${detectAction(text, level)}`;

    try {
        const res = await fetch(`${NEXUS_URL}/notify`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ botId: NEXUS_BOT_ID, displayName: BOT_DISPLAY_NAME, level, category, message: fullText }),
        });
        if (!res.ok) {
            const err = await res.text();
            log(`[notify] Nexus-Fehler: HTTP ${res.status} – ${err}`);
        }
    } catch (err) {
        log(`[notify] Nexus nicht erreichbar: ${err.message} | ${level} | ${category}`);
    }
}
