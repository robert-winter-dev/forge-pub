#!/usr/bin/env node
/**
 * FORGE LendingBot – Einmalige Migration: Duplikate in positions konsolidieren
 *
 * Hintergrund:
 *   Mehrfache Deposits in dasselbe Protokoll haben mehrere DB-Einträge erzeugt.
 *   Diese werden zu einem einzigen Eintrag pro Protokoll zusammengeführt:
 *   - Behalten: Ältester Eintrag (niedrigstes started_at)
 *   - amount: unverändert (On-Chain-Wert, gleich für alle Duplikate)
 *   - Schließen: alle neueren Duplikate (closed_at = jetzt)
 *
 * Usage:
 *   node bin/consolidate-positions.js            # Dry-Run (keine Änderungen)
 *   node bin/consolidate-positions.js --execute  # Änderungen anwenden
 */

import { getActivePositions, closePosition } from '../lib/db.js';

const DRY_RUN = !process.argv.includes('--execute');

function fmt(n) {
    return Number(n).toFixed(4);
}

async function main() {
    if (DRY_RUN) {
        console.log('🔍 DRY-RUN – keine Änderungen werden vorgenommen.');
        console.log('   Füge --execute hinzu um tatsächlich zu konsolidieren.\n');
    } else {
        console.log('⚡ EXECUTE – Änderungen werden in die DB geschrieben.\n');
    }

    const allPositions = getActivePositions();

    // Gruppieren nach Protokoll
    const groups = new Map();
    for (const p of allPositions) {
        if (!groups.has(p.protocol)) groups.set(p.protocol, []);
        groups.get(p.protocol).push(p);
    }

    // Nur Gruppen mit Duplikaten
    const duplicateGroups = [...groups.entries()].filter(([, rows]) => rows.length > 1);

    if (duplicateGroups.length === 0) {
        console.log('✅ Keine Duplikate gefunden. Nichts zu tun.');
        return;
    }

    let totalClosed = 0;

    for (const [protocol, rows] of duplicateGroups) {
        // rows sind nach started_at ASC sortiert (getActivePositions-Reihenfolge)
        const keeper = rows[0];
        const dupes  = rows.slice(1);

        console.log(`Protokoll: ${protocol}`);
        console.log(`  Behalten  : ID ${keeper.id}  |  amount=${fmt(keeper.amount)}  |  started=${new Date(keeper.started_at).toISOString()}`);
        for (const d of dupes) {
            console.log(`  Schließen : ID ${d.id}  |  amount=${fmt(d.amount)}`);
        }

        if (!DRY_RUN) {
            for (const d of dupes) {
                closePosition(d.id);
            }
            console.log(`  ✅ Konsolidiert.`);
        } else {
            console.log(`  (keine Änderung – Dry-Run)`);
        }
        console.log();
        totalClosed += dupes.length;
    }

    console.log(`─────────────────────────────────────────────`);
    if (DRY_RUN) {
        console.log(`Dry-Run: ${duplicateGroups.length} Gruppe(n) betroffen, ${totalClosed} Position(en) würden geschlossen.`);
        console.log(`Starte mit --execute um die Migration durchzuführen.`);
    } else {
        console.log(`✅ Migration abgeschlossen: ${duplicateGroups.length} Gruppe(n), ${totalClosed} Position(en) geschlossen.`);
    }
}

main().catch(err => {
    console.error(`❌ Fehler: ${err.message}`);
    process.exit(1);
});
