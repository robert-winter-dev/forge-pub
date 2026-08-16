#!/usr/bin/env node
/**
 * generate-html.js – Konvertiert FORGE-Dashboard PHP-Dateien in statische HTML
 *
 * Wird von forge-settings benötigt damit alle Dashboards intern ohne PHP-Server
 * ausgeliefert werden können (https://<LAN-IP>:3200/dashboard/).
 *
 * Was wird entfernt / ersetzt:
 *   - <?php ... ?> Blöcke am Dateianfang (Session-Check, Auth)
 *   - <?= htmlspecialchars(getenv('FORGE_TZ') ?: 'Europe/Berlin') ?>
 *     → Wert aus Umgebungsvariable FORGE_TZ (Standard: Europe/Berlin)
 *
 * Aufruf:
 *   node bots/settings/bin/generate-html.js
 *
 * Wird aufgerufen von:
 *   bots/settings/bin/install.sh  (einmalig bei Installation / nach PHP-Änderungen)
 *
 * phpToHtml() ist zusätzlich als Funktion exportiert: tools/pub-export/build-artifact.js
 * (FORGE-public-Fork) ruft sie zur EXPORT-Zeit auf, damit der Fork von vornherein nur
 * .html statt .php ausliefert (dort gibt es nie einen PHP-Bezug, siehe CLAUDE.md
 * tools/pub-export). Diese Datei selbst bleibt unverändert für den Master-Betrieb.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PATHS } from '../../../config/paths.js';

// Nur diese Dateien konvertieren (api/, login, logout, auth nicht)
export const TARGETS = [
    'index.php',
    'health.php',
    'lending/index.php',
    'liquidity/index.php',
];

/** Reine Transform-Funktion: PHP-Quelltext → statisches HTML. */
export function phpToHtml(content, forgeTz) {
    // ── 1. PHP-Blöcke am Dateianfang entfernen (<?php ... ?> inkl. Leerzeile) ──
    // Greedy-Match für alle führenden PHP-Blöcke
    content = content.replace(/^(<\?php[\s\S]*?\?>[\r\n]*)+/, '');

    // ── 2. <?= FORGE_TZ ?> ersetzen ───────────────────────────────────────────
    // [\s\S]*? (nicht [^?]*): der PHP-Ternary "?: 'Europe/Berlin'" enthält selbst ein
    // '?' – [^?]* bricht dort ab und matcht nie bis zum echten '?>', wodurch Schritt 3
    // (Sicherheitsnetz) den ganzen Block statt nur der Tags leer räumt (gefunden
    // 2026-07-26 beim Export-Zeit-Umbau: window.FORGE_TZ = ''; statt 'Europe/Berlin').
    content = content.replace(
        /<\?=\s*htmlspecialchars\(getenv\('FORGE_TZ'\)[\s\S]*?\?>/g,
        forgeTz
    );

    // ── 3. Alle verbleibenden PHP-Tags als Sicherheitsnetz entfernen ──────────
    content = content.replace(/<\?php[\s\S]*?\?>/g, '');
    content = content.replace(/<\?=[\s\S]*?\?>/g, '');

    return content;
}

function main() {
    const FORGE_HTML = PATHS.html;
    const FORGE_TZ   = process.env.FORGE_TZ || 'Europe/Berlin';

    let converted = 0;
    let skipped   = 0;

    for (const rel of TARGETS) {
        const src  = path.join(FORGE_HTML, rel);
        const dest = src.replace(/\.php$/, '.html');

        if (!fs.existsSync(src)) {
            console.warn(`⚠  Nicht gefunden, übersprungen: ${rel}`);
            skipped++;
            continue;
        }

        const content = phpToHtml(fs.readFileSync(src, 'utf8'), FORGE_TZ);
        fs.writeFileSync(dest, content, 'utf8');
        console.log(`✅  ${rel} → ${path.basename(dest)}`);
        converted++;
    }

    console.log(`\nFertig: ${converted} Dateien konvertiert, ${skipped} übersprungen.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
