// ══════════════════════════════════════════════════════════════════════════════
// FORGE – Rendering von Bot-Meldungen (Schritt 5 der Mehrsprachigkeit)
// ══════════════════════════════════════════════════════════════════════════════
// ⛔ DIE EINZIGE STELLE, an der aus msgKey + params ein Meldungstext wird.
//
// Warum es diese Datei gibt (Core/forge-pub/i18n.md, E4):
// Bis hierher schrieb `notify.js` fertigen deutschen Fließtext in `nexus.db`.
// Eine Sprachumschaltung erreichte diese Texte nie — die Oberfläche wurde
// englisch, die Meldungen darin blieben deutsch. Seit Schritt 5 schicken die Bots
// **Schlüssel + Daten**; der Satz entsteht erst beim Anzeigen.
//
// ── Das Modell ───────────────────────────────────────────────────────────────
//
//   msgKey  →  Katalogeintrag in lib/i18n/<lang>.json, mehrzeilig erlaubt
//   params  →  reine Daten (Zahlen, Pool-Namen, Fehlertexte)
//
// Drei Konventionen, die den Katalog schlank halten:
//
//   1. **Zeilen mit unbelegtem {platzhalter} fallen weg.** Damit lassen sich
//      optionale Zeilen (z.B. "Getauscht: … USDC" nur wenn getauscht wurde) in
//      EINEM Katalogeintrag abbilden, statt für jede Kombination einen eigenen
//      Key zu pflegen. Wer die Zeile will, übergibt den Wert — sonst nicht.
//
//   2. **Ein Parameter darf selbst ein Katalog-Verweis sein:** `{ k, p }` wird
//      rekursiv übersetzt. Nötig für Textbausteine, die aus dem Code kommen
//      (Fehlergrund aus describeError, "unter"/"über", Tier-Namen).
//
//   3. **`_action`** ist die Handlungsaufforderung als eigener Key. Betreiber-
//      Vorgabe 2026-07-30: jede Meldung endet mit einem Satz, der sagt, was zu
//      tun ist — auch wenn die Antwort "nichts" ist. Als eigener Key steht diese
//      Formulierung genau einmal im Katalog statt vierzigmal.
//
// Der gerenderte Text wird zusätzlich als `message` gespeichert. Das ist der
// Fallback für Altbestand (Zeilen ohne msgKey) und für den Fall, dass ein Key
// später einmal verschwindet — angezeigt wird er nur, wenn kein Key da ist.
// ══════════════════════════════════════════════════════════════════════════════

import { t, getLang, numLocale, hasKey } from './i18n.js';
import { FORGE_TZ }   from '../core/config.js';

/**
 * Kopfzeile jeder Meldung: Datum/Uhrzeit + betroffener Bot.
 *
 * Steht bewusst auf JEDER Meldung, egal wo sie später auftaucht (Message Center,
 * Telegram, Roh-Dump der DB) — in Telegram wusste man sonst oft nicht mehr,
 * wann und von wem eine Meldung kam.
 */
function header(timestamp, displayName, lang) {
    const ts = new Intl.DateTimeFormat(numLocale(lang), {
        timeZone: FORGE_TZ, day: '2-digit', month: '2-digit', year: '2-digit',
        hour: '2-digit', minute: '2-digit',
    }).format(new Date(timestamp ?? Date.now()));
    return `📅 ${ts} · ${displayName}`;
}

/** Löst `{ k, p }`-Verweise in Parameterwerten rekursiv auf (Konvention 2). */
function resolveParams(params, lang) {
    if (!params || typeof params !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(params)) {
        if (value && typeof value === 'object' && typeof value.k === 'string') {
            out[key] = t(value.k, resolveParams(value.p, lang), { lang });
        } else if (value != null) {
            out[key] = value;
        }
        // null/undefined bewusst NICHT übernehmen — genau daran erkennt
        // dropUnfilledLines() eine optionale Zeile (Konvention 1).
    }
    return out;
}

/**
 * Entfernt Zeilen, in denen nach dem Einsetzen noch ein `{platzhalter}` steht
 * (Konvention 1).
 *
 * Bewusst nur `{wort}` — ein Fehlerdetail wie `{"InstructionError":…}`, das als
 * Wert eingesetzt wurde, darf die Zeile nicht mitreißen.
 */
function dropUnfilledLines(text) {
    return text
        .split('\n')
        .filter(line => !/\{\w+\}/.test(line))
        .join('\n');
}

/**
 * Baut den vollständigen Meldungstext.
 *
 * @param {object} n
 * @param {string} n.msgKey       Katalogschlüssel des Meldungsrumpfs
 * @param {object} [n.params]     Daten für die Platzhalter (siehe Konventionen)
 * @param {string} n.displayName  Anzeigename des betroffenen Bots
 * @param {number} [n.timestamp]  ms — fehlt er, gilt "jetzt"
 * @param {string} [lang]         Zielsprache (Default: Einstellung der Installation)
 * @returns {string}
 */
export function renderNotification({ msgKey, params, displayName, timestamp }, lang = getLang()) {
    const p = resolveParams(params, lang);

    const body   = dropUnfilledLines(t(msgKey, p, { lang }));
    const action = p._action ? t(String(p._action), p, { lang }) : '';

    return [header(timestamp, displayName, lang), body, action]
        .filter(Boolean)
        .join('\n');
}

/**
 * Anzeigetext einer gespeicherten Notification.
 *
 * Der EINE Ort, an dem entschieden wird, ob neu gerendert oder der gespeicherte
 * Text genommen wird — damit Message Center, Dashboard-Export und Telegram nicht
 * unterschiedlich entscheiden können.
 *
 * Altbestand (vor Schritt 5) hat keinen `msg_key` und fällt auf `message`
 * zurück: keine Migration, kein Datenverlust, keine leeren Meldungen.
 *
 * @param {object} row  Zeile aus notifications (msg_key/msgKey, msg_params/params, message, …)
 * @param {string} [lang]
 * @returns {string}
 */
export function notificationText(row, lang = getLang()) {
    const msgKey = row.msg_key ?? row.msgKey ?? null;
    if (!msgKey) return row.message ?? '';

    // Der Katalogeintrag ist weg, die Meldung nicht: Eine gespeicherte Zeile überlebt den
    // Eintrag, mit dem sie geschrieben wurde — bei jedem Rückbau und jeder Umbenennung.
    // Ohne diese Prüfung liefert `t()` den rohen Key als Meldungstext aus und warnt bei
    // JEDEM Lesen erneut (belegt 2026-08-23: sechs Wirkungsnachweis-Meldungen vom Vortag,
    // vier Warnungen je Export-Lauf, im Message Center stand statt des Textes
    // `notify.liq.wirkungsnachweis`). Der fertige Text steht in `message` daneben — der
    // ist hier die richtige Antwort, nicht der Key.
    //
    // Bewusst still: In diesem Pfad wird ausschließlich Gespeichertes gelesen, ein
    // fehlender Key bedeutet hier immer "nachträglich entfernt" und ist damit behandelt.
    // Ein Tippfehler in NEUEM Code fällt weiterhin auf — der geht durch
    // `renderNotification()` direkt, wo `t()` unverändert warnt.
    if (!hasKey(msgKey, { lang })) return row.message ?? '';

    let params = row.msg_params ?? row.msgParams ?? row.params ?? null;
    if (typeof params === 'string') {
        try { params = JSON.parse(params); } catch { params = null; }
    }

    try {
        return renderNotification({
            msgKey,
            params,
            displayName: row.display_name ?? row.displayName ?? '',
            timestamp:   row.timestamp ?? row.created_at ?? null,
        }, lang);
    } catch (err) {
        // Ein defekter Katalogeintrag darf keine Meldung verschlucken —
        // lieber der gespeicherte deutsche Text als eine leere Zeile.
        console.warn(`[notify-render] "${msgKey}" nicht renderbar (${err.message}) – gespeicherter Text wird verwendet`);
        return row.message ?? '';
    }
}

export default { renderNotification, notificationText };
