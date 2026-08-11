#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// FORGE – Sprache der Installation anzeigen/setzen
// ══════════════════════════════════════════════════════════════════════════════
//   node bin/i18n-lang.js            aktuelle Sprache anzeigen
//   node bin/i18n-lang.js de|en      Sprache setzen (+ Frontend-Bundle erneuern)
//
// Die Sprache gilt für die GANZE Installation (Backend + Oberfläche), nicht pro
// Nutzer — FORGE.pub ist Single-Tenant (Core/forge-pub/i18n.md, E3).
// Gespeichert wird in <DATA_ROOT>/i18n.json, damit die Einstellung ein Update
// überlebt (im Fork: <base>/local/data/i18n.json).
//
// Kein Neustart nötig: das Frontend liest html/i18n/active.js beim Seitenaufruf,
// Bot-Prozesse lesen die Einstellung über lib/i18n.js bei jeder Meldung.
// ══════════════════════════════════════════════════════════════════════════════

import { getLang, setLang, SUPPORTED_LANGS } from '../lib/i18n.js';

const arg = process.argv[2]?.trim().toLowerCase();

if (!arg || arg === '--help' || arg === '-h') {
    console.log(`Aktuelle Sprache: ${getLang()}`);
    console.log(`Verfügbar:        ${SUPPORTED_LANGS.join(', ')}`);
    console.log('');
    console.log('Setzen:  node bin/i18n-lang.js <de|en>');
    process.exit(0);
}

if (!SUPPORTED_LANGS.includes(arg)) {
    console.error(`✖ Unbekannte Sprache "${arg}" – erlaubt: ${SUPPORTED_LANGS.join(', ')}`);
    process.exit(1);
}

const before = getLang();
const { lang, bundleWritten } = setLang(arg);

console.log(before === lang
    ? `· Sprache war bereits "${lang}"`
    : `✔ Sprache: ${before} → ${lang}`);
console.log(bundleWritten
    ? '✔ html/i18n/active.js neu erzeugt'
    : '· html/i18n/active.js unverändert');
