// ══════════════════════════════════════════════════════════════════════════════
// FORGE – Zentrale Mehrsprachigkeit (Node-Seite)
// ══════════════════════════════════════════════════════════════════════════════
// ⛔ DIE EINZIGE STELLE, an der die aktive Sprache bestimmt wird.
//
// Konzept, Entscheidungen und Fallstricke stehen ausführlich in der Doku
// (Core/forge-pub/i18n.md) — vor Änderungen an der Sprachlogik dort nachlesen.
//
// Kurzfassung der tragenden Entscheidungen:
//
//   E2  Fallback bei fehlendem Key = DEUTSCHER Text, niemals der rohe Key.
//       Ein deutscher Satz in englischer Oberfläche ist ein Schönheitsfehler,
//       ein sichtbares "POOL_INACTIVE_REASON" sieht aus wie ein Defekt.
//
//   E3  Die Sprache gilt PRO INSTALLATION, nicht pro Nutzer (FORGE public ist
//       Single-Tenant). Sie liegt daher in DATA_ROOT — nicht in config/:
//         - config/ ist git-versioniert und wird bei jedem Update ersetzt
//         - DATA_ROOT überlebt Updates (Fork: <base>/local/data, siehe paths.js)
//
// Zwei getrennte Kataloge, bewusst:
//   lib/i18n/<lang>.json    Backend-Texte  (Bot-Meldungen, CLI) — bleiben lokal
//   html/i18n/<lang>.json   Frontend-Texte (Dashboard, Settings-UI)
// Der html-Baum wird per rsync auf einen öffentlichen Webserver geschoben
// (bin/sync.sh). Backend-Meldungstexte haben dort nichts zu suchen.
// ══════════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { PATHS, DATA_ROOT } from '../config/paths.js';

/** Unterstützte Sprachen. Reihenfolge = Anzeigereihenfolge in Oberflächen. */
export const SUPPORTED_LANGS = ['de', 'en'];

/** Referenzsprache. Quelle der Wahrheit für den Key-Bestand und E2-Fallback. */
export const DEFAULT_LANG = 'de';

/** Ablageort der Nutzereinstellung (überlebt Updates, siehe Kopfkommentar). */
const LANG_FILE = path.join(DATA_ROOT, 'i18n.json');

const BACKEND_CATALOG_DIR  = path.join(PATHS.lib,  'i18n');
const FRONTEND_CATALOG_DIR = path.join(PATHS.html, 'i18n');

// ── Sprache ermitteln ─────────────────────────────────────────────────────────

/**
 * Aktive Sprache.
 *
 * Reihenfolge: FORGE_LANG (Env-Override für Tests/Sonderfälle) → Datei → Default.
 * Ein unbekannter Wert wird still auf DEFAULT_LANG zurückgesetzt statt zu werfen:
 * eine kaputte Einstellungsdatei darf keinen Bot am Start hindern.
 *
 * @returns {'de'|'en'}
 */
export function getLang() {
    const fromEnv = process.env.FORGE_LANG?.trim().toLowerCase();
    if (fromEnv && SUPPORTED_LANGS.includes(fromEnv)) return fromEnv;

    try {
        const raw = JSON.parse(fs.readFileSync(LANG_FILE, 'utf8'));
        const lang = String(raw?.lang ?? '').toLowerCase();
        if (SUPPORTED_LANGS.includes(lang)) return lang;
    } catch { /* Datei fehlt oder ist unlesbar → Default */ }

    return DEFAULT_LANG;
}

/**
 * Setzt die Sprache der Installation und erneuert das Frontend-Bundle.
 *
 * Das Bundle wird hier mitgeschrieben, damit Backend und Oberfläche nie
 * auseinanderlaufen können — ein separater "jetzt bitte auch das Frontend
 * aktualisieren"-Schritt wäre genau die Art Aufruf, die irgendwann vergessen wird.
 *
 * @param {'de'|'en'} lang
 * @returns {{lang: string, bundleWritten: boolean}}
 */
export function setLang(lang) {
    const normalized = String(lang ?? '').toLowerCase();
    if (!SUPPORTED_LANGS.includes(normalized)) {
        throw new Error(`i18n: nicht unterstützte Sprache "${lang}" (erlaubt: ${SUPPORTED_LANGS.join(', ')})`);
    }

    fs.mkdirSync(path.dirname(LANG_FILE), { recursive: true });
    fs.writeFileSync(LANG_FILE, JSON.stringify({ lang: normalized }, null, 2) + '\n', 'utf8');

    _catalogCache.clear();
    return { lang: normalized, bundleWritten: writeFrontendBundle(normalized) };
}

// ── Kataloge ──────────────────────────────────────────────────────────────────

const _catalogCache = new Map();

/**
 * Lädt einen Katalog von der Platte (mit Prozess-Cache).
 *
 * Ein fehlender oder defekter Katalog ist kein harter Fehler: es wird eine leere
 * Tabelle geliefert, wodurch t() über den E2-Fallback auf Deutsch landet. Ein Bot
 * darf an einer kaputten Übersetzungsdatei nicht sterben.
 *
 * @param {'backend'|'frontend'} scope
 * @param {string} lang
 * @returns {Record<string,string>}
 */
function loadCatalog(scope, lang) {
    const cacheKey = `${scope}:${lang}`;
    if (_catalogCache.has(cacheKey)) return _catalogCache.get(cacheKey);

    const dir  = scope === 'frontend' ? FRONTEND_CATALOG_DIR : BACKEND_CATALOG_DIR;
    const file = path.join(dir, `${lang}.json`);

    let catalog = {};
    try {
        catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* fehlt/defekt → leer, siehe Kopf dieser Funktion */ }

    _catalogCache.set(cacheKey, catalog);
    return catalog;
}

/** Cache leeren — für Tests und für Prozesse, die Kataloge zur Laufzeit neu laden. */
export function clearCatalogCache() {
    _catalogCache.clear();
}

/**
 * Zahlen-/Datums-Locale zur aktiven Sprache — dieselbe Regel wie im Frontend
 * (E10: wer Englisch wählt, erwartet auch englische Zahlen). Einzige Quelle
 * für Backend-Formatierung; kein 'de-DE' mehr von Hand in CLI-Skripten.
 *
 * @param {string} [lang=getLang()]
 * @returns {'de-DE'|'en-US'}
 */
export function numLocale(lang = getLang()) {
    return lang === 'en' ? 'en-US' : 'de-DE';
}

// ── Übersetzen ────────────────────────────────────────────────────────────────

/**
 * Ersetzt {platzhalter} durch Werte aus params.
 *
 * Nicht belegte Platzhalter bleiben unverändert stehen. Das ist Absicht: ein
 * sichtbares "{pool}" im Text zeigt sofort, dass ein Parameter fehlt — stiller
 * Ersatz durch Leerstring würde denselben Fehler unsichtbar machen.
 */
function interpolate(text, params) {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, key) =>
        Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
    );
}

/**
 * Übersetzt einen Backend-Key in die aktive Sprache.
 *
 * @param {string} key           z.B. 'notify.out_of_range.title'
 * @param {Record<string,any>} [params]  Werte für {platzhalter}
 * @param {{lang?: string, scope?: 'backend'|'frontend'}} [opts]
 * @returns {string}
 */
export function t(key, params, opts = {}) {
    const lang  = opts.lang ?? getLang();
    const scope = opts.scope ?? 'backend';

    const hit = loadCatalog(scope, lang)[key];
    if (typeof hit === 'string' && hit !== '') return interpolate(hit, params);

    // E2: auf die Referenzsprache zurückfallen, nie auf den rohen Key.
    const fallback = lang === DEFAULT_LANG ? undefined : loadCatalog(scope, DEFAULT_LANG)[key];
    if (typeof fallback === 'string' && fallback !== '') return interpolate(fallback, params);

    // Weder hier noch dort vorhanden: der Key ist schlicht unbekannt. Sichtbar
    // machen (der Aufrufer hat sich vertippt), aber nicht werfen.
    console.warn(`[i18n] unbekannter Key "${key}" (${scope}/${lang})`);
    return key;
}

// ── Frontend-Bundle ───────────────────────────────────────────────────────────

/**
 * Schreibt html/i18n/active.js — Sprache + Katalog in EINER klassischen
 * JS-Datei, die jede Seite synchron im <head> einbindet.
 *
 * Warum eine generierte Datei und nicht fetch() beim Start:
 *
 *   1. Kein PHP verfügbar. Das Muster von FORGE_TZ (PHP injiziert window.FORGE_TZ
 *      in jede index.php) funktioniert im Fork NICHT — dort wird .php als
 *      statische Datei ausgeliefert, der PHP-Block landet ungeparst im Browser.
 *   2. Kein "Flash of German". Ein asynchrones fetch() würde die Seite erst
 *      deutsch rendern und dann sichtbar umschreiben.
 *   3. Ein Request, kein Wasserfall (erst Sprache holen, dann Katalog).
 *
 * Die Datei ist ein ABBILD, keine Quelle: sie steht nicht in Git (.gitignore) und
 * wird bei jedem Update mit html/ ersetzt. Wahrheit ist DATA_ROOT/i18n.json.
 * Fehlt sie, fällt das Frontend still auf Deutsch zurück (html/js/i18n.js).
 *
 * Schreibt nur bei tatsächlicher Änderung: bin/sync.sh rsync't html/ jede Minute,
 * eine bei jedem Export neu geschriebene Datei würde jede Minute unnötig übertragen.
 *
 * @param {string} [lang=getLang()]
 * @returns {boolean} true, wenn die Datei neu geschrieben wurde
 */
export function writeFrontendBundle(lang = getLang()) {
    // _comment ist reine Pflegehilfe in den Katalogdateien und hat im
    // ausgelieferten Bundle nichts zu suchen.
    const { _comment, ...catalog } = loadCatalog('frontend', lang);
    const target = path.join(FRONTEND_CATALOG_DIR, 'active.js');

    const content =
        '// GENERIERT von lib/i18n.js – nicht von Hand bearbeiten, nicht in Git.\n' +
        `// Sprache: ${lang} | erzeugt: ${new Date().toISOString()}\n` +
        `window.FORGE_I18N = ${JSON.stringify({ lang, catalog })};\n`;

    // Zeitstempel aus dem Vergleich nehmen, sonst ändert sich der Inhalt immer.
    const stripTs = (s) => s.replace(/^\/\/ Sprache:.*$/m, '');
    try {
        if (stripTs(fs.readFileSync(target, 'utf8')) === stripTs(content)) return false;
    } catch { /* existiert noch nicht → schreiben */ }

    fs.mkdirSync(FRONTEND_CATALOG_DIR, { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return true;
}

export default { getLang, setLang, t, writeFrontendBundle, SUPPORTED_LANGS, DEFAULT_LANG };
