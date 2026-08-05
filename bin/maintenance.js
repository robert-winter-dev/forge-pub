#!/usr/bin/env node
/**
 * FORGE – Maintenance-Modus steuern
 *
 * Setzt/löscht data/maintenance.json. Solange die Datei existiert und nicht
 * abgelaufen ist, unterdrücken Bot-Exporte lifecycle-Notifications (Restarts)
 * im Dashboard.
 *
 * Vor jedem systemctl restart/stop eines FORGE-Services aufrufen:
 *   node bin/maintenance.js --on
 * Danach:
 *   node bin/maintenance.js --off
 *
 * TTL (Default: 10 Min) als Sicherheitsnetz falls --off vergessen wird.
 */

import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolve, dirname }                       from 'path';
import { fileURLToPath }                          from 'url';
import { readMaintenanceFlag, FLAG_FILE, recordMaintenanceWindow } from '../core/maintenance.js';

const DEFAULT_TTL = 10; // Minuten

const args = process.argv.slice(2);
const cmd  = args[0];

if (cmd === '--on') {
    const ttlIdx     = args.indexOf('--minutes');
    const ttlMinutes = ttlIdx >= 0 ? parseInt(args[ttlIdx + 1], 10) : DEFAULT_TTL;
    const reason     = args.find(a => !a.startsWith('--') && args[ttlIdx + 1] !== a) ?? 'Wartung';
    const flag       = { reason, createdAt: Date.now(), ttlMinutes };
    writeFileSync(FLAG_FILE, JSON.stringify(flag, null, 2), 'utf-8');
    const expires = new Date(flag.createdAt + ttlMinutes * 60_000)
        .toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    console.log(`✅ Wartungsmodus aktiv (TTL ${ttlMinutes} Min, läuft ab: ${expires} Uhr)`);
    console.log(`   Grund: ${reason}`);

} else if (cmd === '--off') {
    if (existsSync(FLAG_FILE)) {
        const flag = readMaintenanceFlag();
        if (flag) {
            recordMaintenanceWindow(flag.reason, flag.createdAt, Date.now());
        }
        unlinkSync(FLAG_FILE);
        console.log('✅ Wartungsmodus beendet.');
    } else {
        console.log('ℹ️  Wartungsmodus war nicht aktiv.');
    }

} else if (cmd === '--status') {
    const flag = readMaintenanceFlag();
    if (!flag) {
        console.log('ℹ️  Wartungsmodus: inaktiv');
    } else {
        const remaining = Math.ceil((flag.expiresAt - Date.now()) / 60_000);
        const expires   = new Date(flag.expiresAt)
            .toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        console.log(`🔧 Wartungsmodus: AKTIV`);
        console.log(`   Grund:        ${flag.reason}`);
        console.log(`   Läuft ab in:  ${remaining} Min (${expires} Uhr)`);
    }

} else {
    console.log('Usage:');
    console.log('  node bin/maintenance.js --on [--minutes 10] ["Grund"]');
    console.log('  node bin/maintenance.js --off');
    console.log('  node bin/maintenance.js --status');
}
