#!/usr/bin/env node
/**
 * FORGE – Passwortschutz der Settings-Seite (Port 3200) zurücksetzen
 *
 * Notausgang für ein vergessenes Passwort: die Weboberfläche kann sich in dem
 * Fall selbst nicht mehr helfen (siteAuthGate() lässt ohne gültige Session nur
 * noch /login.html durch) – deshalb läuft dieser Weg bewusst NICHT über die
 * Web-API, sondern lokal per SSH auf dem Host, auf dem forge-settings läuft.
 *
 * Wirkung: löscht die einzige Zeile aus settings.db (Tabelle site_auth) –
 * identisch zum "Passwortschutz entfernen"-Button in der Oberfläche, nur ohne
 * dass man sich dafür anmelden muss. Betrifft ausschließlich den Login vor
 * Port 3200, keine Bot-Konfiguration oder -Daten.
 *
 *   node bin/reset-settings-password.js
 *   sudo bin/setup.sh reset-password   (dasselbe, mit Rückfrage + i18n)
 */

import Database from 'better-sqlite3';
import { PATHS } from '../config/paths.js';
import { ensureAuthSchema } from '../bots/settings/lib/site-auth.js';

const db = ensureAuthSchema(new Database(PATHS.settingsDb));
const existed = !!db.prepare('SELECT 1 FROM site_auth WHERE id = 1').get();
db.prepare('DELETE FROM site_auth WHERE id = 1').run();
db.close();

console.log(existed
    ? '✅  Passwortschutz der Settings-Seite (Port 3200) wurde entfernt.'
    : 'ℹ️  Es war kein Passwortschutz aktiv – nichts zu tun.');
