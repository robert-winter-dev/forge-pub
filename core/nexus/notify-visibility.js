/**
 * FORGE Nexus – Sichtbarkeit von Notifications (Message Center vs. nur Logfile)
 *
 * Zweck
 * ─────
 * Im Message Center (Rubriken „System" und „Bot") sollen ausschließlich Meldungen
 * stehen, die entweder eine Handlung erfordern oder deren Informationsgehalt für
 * den Nutzer wirklich wichtig ist. Alles, was sich mit hoher Wahrscheinlichkeit
 * selbst heilt oder reinen Betriebsablauf protokolliert, gehört ins Logfile —
 * nicht vor die Augen des Nutzers.
 *
 * Begründung (Messung vom 20.08.2026, nexus.db, Zeitraum 18.–20.08.2026):
 * Von 65 Notifications waren 55 `info`. Die drei größten Posten:
 *   • 14× `notify.liq.info` — stündlich identisch „Bester Pool EURC/USDC hat
 *     Opportunity Score 58 < 60 – Cleanup übersprungen." Weil `info` kein Dedup
 *     hat (siehe dedup.js) und das Stundenraster unter dem Rate-Limit von 10/h
 *     bleibt, rutschte das ungefiltert durch.
 *   • 19× `out_of_range`/`back_in_range` — PUMP/SOL sprang am 20.08. zwischen
 *     04:57 und 05:55 fünfmal hin und her.
 *   • 22× `trade` (Position geöffnet / Deposit) — interner Bot-Betrieb.
 * Diese Meldungen sagen in ihrem eigenen Text „Es ist nichts zu tun, diese Meldung
 * dient nur zur Information." Genau solche Nachrichten erzeugen beim Nutzer das
 * Gefühl, es liefe etwas schief, das er nicht kontrollieren kann — das Gegenteil
 * des Gewünschten.
 *
 * Abgrenzung zu dedup.js
 * ──────────────────────
 * dedup.js begrenzt die *Frequenz* gleichartiger Meldungen (wie oft darf dieselbe
 * Kategorie durch?). Dieses Modul entscheidet über die *Zielgruppe* (gehört diese
 * Meldungsart überhaupt vor den Nutzer?). Beides greift unabhängig voneinander:
 * eine Meldung, die hier auf `log` steht, durchläuft Dedup/Rate-Limit gar nicht
 * mehr bis zur DB.
 *
 * Kriterium für die Einordnung
 * ────────────────────────────
 * Die Notify-Fassaden der Bots tragen bereits eine Handlungskategorie (`ACTION`
 * in den notify.js der Bots). Daraus leitet sich die Regel fast vollständig ab:
 *
 *   manual · topUp · configure · verify · support · checkPool ·
 *   enablePool · restartHint · inWallet · observe · observePool · waitPool
 *                                              → Message Center (Handlung/wichtig)
 *   retrying · topUpRetry · selfHeal · selfHealed
 *                                              → nur Logfile (heilt sich selbst)
 *   fyi                                        → Einzelfall, siehe unten
 *
 * Für `fyi` (und Meldungen ohne `_action`) gilt: Bewegt sich Kapital zwischen Bot
 * und Nutzer-Wallet, oder hat ein Schutzmechanismus gegriffen (Risk-Management,
 * TVL-Exit, Score-Limit)? → Message Center. Reiner Innenbetrieb (Position auf,
 * Position zu, Range-Wechsel, Gebühren-Claim, Stammdatenpflege)? → Logfile. Den
 * Betriebszustand zeigt das Dashboard ohnehin; das Message Center muss ihn nicht
 * verdoppeln.
 *
 * 🔒 Default ist `mc` — bewusst
 * ─────────────────────────────
 * Nur die hier aufgeführten Keys werden unterdrückt, alles andere ist sichtbar.
 * Wird ein neuer msgKey eingeführt und hier vergessen, sieht der Nutzer eine
 * Meldung zu viel. Der umgekehrte Default würde bedeuten, dass eine vergessene
 * kritische Meldung still verschwindet — das wäre der weitaus teurere Fehler.
 *
 * Warum eine Blockliste und keine Vollklassifikation aller Katalog-Keys:
 * lib/i18n/de.json enthält ~194 `notify.*`-Keys, von denen aber nur ~56 je als
 * msgKey gesendet werden. Der große Rest sind Textbausteine (`notify.act.*`,
 * `notify.err.*`, `notify.liq.rm_label_*`, `*_short`, …), die in andere Meldungen
 * eingesetzt werden. Eine Tabelle über alle Keys müsste diese Unterscheidung
 * dauerhaft mitpflegen, ohne dass sie irgendetwas entscheidet.
 *
 * Eskalation
 * ──────────
 * Dass ein Fehler hier auf `log` steht, heißt nicht, dass er folgenlos bleibt.
 * Für den Fall „Automatik gibt endgültig auf" existieren eigene Meldungen mit
 * ACTION.manual, die selbstverständlich ins Message Center gehen — Beispiel:
 * `notify.liq.open_position_gave_up` („nach {fails} Fehlversuchen gestoppt").
 * Wo ein solcher Zähler heute fehlt (z.B. Trailing Stop), ist das eine bewusst
 * offene, eng abgegrenzte Frage — und kein Grund, den transienten Erstfehler
 * dem Nutzer zu zeigen.
 */

import { createRequire } from 'module';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * msgKeys, die NICHT ins Message Center gehören (nur Logfile).
 * Jeder Eintrag mit Grund — wer hier etwas ergänzt, begründet es ebenfalls.
 */
export const LOG_ONLY = new Set([
    // ── Liquidity Bot ────────────────────────────────────────────────────────
    // Reiner Betriebsablauf, im Dashboard sichtbar
    'notify.liq.info',                // generischer Info-Kanal, u.a. stündlich „Cleanup übersprungen"
    'notify.liq.out_of_range',        // Range-Wechsel, heilt sich mit der nächsten Preisbewegung
    'notify.liq.back_in_range',       // Gegenstück dazu
    'notify.liq.position_opened',     // Innenbetrieb; Position steht im Dashboard
    'notify.liq.deposit_added',       // der BOT legt Kapital in den Pool — keine Nutzer-Einzahlung
    'notify.liq.fees_claimed',        // laufender Ertrag, gehört ins Dashboard
    'notify.liq.range_hint',          // Bot stellt die Range beim nächsten Lauf selbst nach
    'notify.liq.sol_low',             // Vorstufe; sol_low_critical meldet weiterhin
    'notify.liq.premium_reinstated',  // Stammdatenpflege des Datendienstes
    'notify.liq.premium_updated',     // dito
    'notify.liq.tvl_exit',            // Vorab-Warnung vor Voll-Exit; deckt sich inhaltlich
                                       // vollständig mit tvl_exit_done (jetzt inkl. PnL) direkt
                                       // danach — Festlegung 2026-08-20



    // ACTION.retrying / ACTION.selfHeal — der Bot versucht es erneut
    'notify.liq.error',
    'notify.liq.error_raw',
    'notify.liq.warn',
    'notify.liq.reinvest_error',      // Gebühren bleiben in der Position, nächster Lauf holt sie
    'notify.liq.open_position_error', // Eskalation läuft über open_position_gave_up (ACTION.manual)
    'notify.liq.score_limit_error',
    'notify.liq.trailing_stop_error', // Auslöser dieser Änderung: Slippage-Fehler beim Exit-Versuch
    'notify.liq.premium_exit_error',

    // ── LendingBot ───────────────────────────────────────────────────────────
    'notify.len.sol_topup_done',      // ACTION.selfHealed — Bot hat sich selbst versorgt
    'notify.len.task_failed',         // ACTION.retrying — nächster Zyklus versucht es erneut
    'notify.len.deploy_done',         // ACTION.fyi, alles glattgelaufen (deploy_partial bleibt sichtbar)
]);

/**
 * Entscheidet, ob eine Meldung ins Message Center gehört.
 *
 * @param   {string|null|undefined} msgKey  Katalogschlüssel der Meldung
 * @returns {'mc'|'log'}  'log' = nur Nexus-Logfile, kein DB-Eintrag
 */
export function visibility(msgKey) {
    if (!msgKey) return 'mc';           // Altaufrufer ohne msgKey bleiben sichtbar
    return LOG_ONLY.has(msgKey) ? 'log' : 'mc';
}

/**
 * Selbstprüfung beim Start: stehen alle Einträge der Blockliste noch im Katalog?
 *
 * Der teure Fehlerfall ist die Umbenennung: wird ein msgKey in lib/i18n/de.json
 * umbenannt und hier nicht mitgezogen, greift der Filter still nicht mehr und die
 * Meldung taucht ohne Vorwarnung wieder im Message Center auf. Andersherum bleibt
 * ein verwaister Eintrag wirkungslos liegen. Beides fällt hier sofort auf, statt
 * erst dem Nutzer.
 *
 * Nur Warnung, kein harter Abbruch — der Nexus ist zentral, ein Tippfehler in
 * dieser Liste darf das Routing aller Bots nicht verhindern.
 *
 * @returns {string[]} Keys, die im Katalog fehlen (leer = alles in Ordnung)
 */
export function checkLogOnlyKeys() {
    let catalog;
    try {
        catalog = require(resolve(__dirname, '../../lib/i18n/de.json'));
    } catch (err) {
        console.warn(`[nexus:visibility] Katalog nicht lesbar, Prüfung übersprungen: ${err.message}`);
        return [];
    }

    // Der Katalog ist flach: die Punkte sind Teil des Schlüssels, keine Verschachtelung.
    const missing = [...LOG_ONLY].filter(key => typeof catalog[key] !== 'string');

    if (missing.length > 0) {
        console.warn(`[nexus:visibility] ⚠️  ${missing.length} Key(s) aus LOG_ONLY fehlen im Katalog `
            + `— der Filter greift dort nicht mehr: ${missing.join(', ')}`);
    }
    return missing;
}
