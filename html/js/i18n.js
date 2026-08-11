// html/js/i18n.js
// ─────────────────────────────────────────────────────────────────────────────
// ⛔ ZENTRALER I18N-HELPER — DIE EINZIGE STELLE FÜR SPRACHE IM FRONTEND
// ─────────────────────────────────────────────────────────────────────────────
// Gegenstück zu lib/i18n.js (Node). Konzept: Core/forge-pub/i18n.md.
//
// Woher die Texte kommen:
//   html/i18n/active.js  wird von lib/i18n.js erzeugt und setzt window.FORGE_I18N
//   = { lang, catalog }. Die Datei wird SYNCHRON im <head> eingebunden — bewusst
//   kein fetch():
//     - PHP steht nicht zur Verfügung (im Fork wird .php statisch ausgeliefert),
//       das FORGE_TZ-Muster ist hier also nicht anwendbar
//     - ein asynchroner Katalog würde die Seite erst deutsch rendern und dann
//       sichtbar umschreiben ("Flash of German")
//
// ── Die zwei Wege, einen Text zu übersetzen ──────────────────────────────────
//
//   1. Text steht im Markup  →  data-i18n-Attribut, deutscher Text bleibt drin:
//
//        <span data-i18n="overview.total_balance">Gesamtguthaben</span>
//        <th data-i18n-attr="data-tooltip:overview.pnl24h.tip">…</th>
//
//      applyDom() ersetzt den Inhalt NUR, wenn der Katalog den Key kennt. Fehlt
//      der Katalog (z.B. active.js noch nicht erzeugt), bleibt der deutsche
//      Originaltext stehen — die Seite ist nie kaputt, nur nicht übersetzt.
//
//   2. Text entsteht in JS  →  t() mit dem deutschen Text als zweitem Argument:
//
//        t('nav.logout', 'Logout')
//        t('nav.last_update', 'Letztes Update: {time} Uhr', { time: '14:05' })
//
//      Der deutsche Text steht damit direkt an der Verwendungsstelle (lesbar im
//      Code) UND im Katalog. Diese Doppelung ist Absicht und abgesichert:
//      bin/i18n-check.js vergleicht beide und meldet jede Abweichung. Ohne den
//      Fallback im Code würden bei fehlendem Katalog rohe Keys in der Oberfläche
//      erscheinen — genau das verbietet Entscheidung E2.
//
// 🔒 NIEMALS einen Anzeigetext ohne t() bzw. data-i18n neu einbauen.
// ─────────────────────────────────────────────────────────────────────────────

const _bundle  = (typeof window !== 'undefined' && window.FORGE_I18N) || null;

/** Aktive Sprache ('de' | 'en'). Ohne Bundle: Deutsch. */
export const LANG = _bundle?.lang || 'de';

const _catalog = _bundle?.catalog || {};

if (!_bundle) {
    // Kein harter Fehler: ohne Bundle bleibt alles deutsch und bedienbar.
    // Sichtbar in der Konsole, weil es auf einer EN-Installation ein echter
    // Defekt wäre (active.js wird von lib/i18n.js erzeugt).
    // eslint-disable-next-line no-console
    console.warn('[i18n] window.FORGE_I18N fehlt – html/i18n/active.js nicht eingebunden oder nicht erzeugt. Oberfläche bleibt deutsch.');
}

/** Ersetzt {platzhalter}. Unbelegte Platzhalter bleiben sichtbar stehen (Fehlersuche). */
function interpolate(text, params) {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (m, k) =>
        Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m
    );
}

/**
 * Übersetzt einen Key.
 *
 * @param {string} key        Katalog-Schlüssel, z.B. 'nav.logout'
 * @param {string} de         Deutscher Text (Fallback + Vorlage, siehe Kopf)
 * @param {Record<string,any>} [params]  Werte für {platzhalter}
 * @returns {string}
 */
export function t(key, de = '', params = null) {
    const hit = _catalog[key];
    return interpolate(typeof hit === 'string' && hit !== '' ? hit : de, params);
}

/**
 * Übersetzt alle markierten Elemente unterhalb von root.
 *
 * Unterstützt:
 *   data-i18n="key"                          → textContent
 *   data-i18n-html="key"                     → innerHTML (nur für Texte mit Markup)
 *   data-i18n-attr="attr:key,attr2:key2"     → beliebige Attribute (title, placeholder,
 *                                              data-tooltip, data-tooltip-title, aria-label …)
 *
 * Elemente ohne Katalogtreffer bleiben unverändert (deutscher Originaltext).
 * Mehrfacher Aufruf ist unschädlich — nach dem Einfügen von dynamischem DOM
 * einfach erneut aufrufen.
 *
 * @param {ParentNode} [root=document]
 */
export function applyDom(root = document) {
    if (LANG === 'de' && !Object.keys(_catalog).length) return;  // nichts zu tun

    for (const el of root.querySelectorAll('[data-i18n]')) {
        const hit = _catalog[el.dataset.i18n];
        if (typeof hit === 'string' && hit !== '') el.textContent = hit;
    }

    for (const el of root.querySelectorAll('[data-i18n-html]')) {
        const hit = _catalog[el.dataset.i18nHtml];
        if (typeof hit === 'string' && hit !== '') el.innerHTML = hit;
    }

    for (const el of root.querySelectorAll('[data-i18n-attr]')) {
        for (const pair of el.dataset.i18nAttr.split(',')) {
            const idx = pair.indexOf(':');
            if (idx === -1) continue;
            const attr = pair.slice(0, idx).trim();
            const key  = pair.slice(idx + 1).trim();
            const hit  = _catalog[key];
            if (typeof hit === 'string' && hit !== '') el.setAttribute(attr, hit);
        }
    }
}

// ── Zahlen- und Datumsformate ────────────────────────────────────────────────
// Bewusst hier zentralisiert und nicht in den einzelnen Dashboards: vor diesem
// Umbau stand 'de-DE' allein in html/js/forge.js an zehn Stellen fest verdrahtet.
//
// Entscheidung: das Format folgt der Sprache (en → 1,234.56 / Aug 11).
// Wer Englisch wählt, erwartet auch englische Zahlen; eine getrennte
// Format-Einstellung wäre eine zweite Stellschraube ohne erkennbaren Nutzen.
// 🔒 USDC bleibt in beiden Sprachen das Währungssymbol (nie "$").

/** BCP-47-Locale für toLocaleString/Intl — einzige Quelle im Frontend. */
export const NUM_LOCALE = LANG === 'en' ? 'en-US' : 'de-DE';

const MONTHS_SHORT = {
    de: ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'],
    en: ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],
};

/**
 * Kurzer Monatsname in der aktiven Sprache.
 * @param {number} idx 0 = Januar
 */
export function monthShort(idx) {
    return (MONTHS_SHORT[LANG] ?? MONTHS_SHORT.de)[idx] ?? '';
}

/**
 * Tag + Monat, z.B. "11. Aug" (de) / "Aug 11" (en).
 * Die Wortstellung unterscheidet sich — deshalb eine Funktion und kein Template.
 * @param {number} day 1-basiert
 * @param {number} monthIdx 0-basiert
 */
export function dayMonth(day, monthIdx) {
    return LANG === 'en'
        ? `${monthShort(monthIdx)} ${day}`
        : `${day}. ${monthShort(monthIdx)}`;
}

/**
 * Uhrzeit-Label, z.B. "14:00 Uhr" (de) / "14:00" (en).
 *
 * Eigene Funktion statt t() an der Aufrufstelle, weil das anrufende Modul
 * html/js/forge.js `t` durchgängig als Variablennamen für Timestamps verwendet —
 * ein Import gleichen Namens wäre dort eine Verwechslungsfalle.
 *
 * @param {string} hhmm z.B. "14:00"
 */
export function hourLabel(hhmm) {
    return t('time.hour_label', '{time} Uhr', { time: hhmm });
}

/**
 * Setzt das lang-Attribut des Dokuments passend zur aktiven Sprache.
 * Wichtig für Screenreader und die Silbentrennung des Browsers — das statische
 * lang="de" im Markup wäre auf einer englischen Installation schlicht falsch.
 */
function syncDocumentLang() {
    if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.lang = LANG;
    }
}

// Automatisch anwenden: jede Seite, die dieses Modul lädt, ist damit übersetzt,
// ohne dass jeder Einstiegspunkt daran denken muss. Dynamisch nachgeladenes DOM
// (z.B. das per innerHTML gebaute Nav-Panel) muss applyDom() selbst nachrufen —
// dort wird ohnehin meist direkt t() verwendet.
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { syncDocumentLang(); applyDom(); });
    } else {
        syncDocumentLang();
        applyDom();
    }
}

export default { t, applyDom, LANG };
