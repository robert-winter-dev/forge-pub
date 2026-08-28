#!/usr/bin/env node
/**
 * FORGE – Migrationen anzeigen und anwenden.
 *
 * Datenkorrekturen, die eine neue Programmversion voraussetzt, laufen über diesen Runner
 * genau einmal pro Installation. Hintergrund und Aufbau: `lib/migrations/runner.js`.
 *
 *   node bin/migrate.js                     Übersicht: was ist erledigt, was steht an
 *   node bin/migrate.js --dry-run           offene Migrationen prüfen, nichts schreiben
 *   node bin/migrate.js --apply             offene `safe`-Migrationen anwenden
 *   node bin/migrate.js --apply --financial auch Migrationen anwenden, die Kapital bewegen
 *   node bin/migrate.js --apply --id <id>   genau eine Migration anwenden
 *   node bin/migrate.js --baseline          alle als angewendet verbuchen (Neuinstallation)
 *
 * 🔒 Ohne `--apply` wird nichts geschrieben.
 * 🔒 `--financial` ist Pflicht für Migrationen, die eine Position schließen oder Kapital
 *    bewegen können. Der automatische Aufruf aus dem Update-Pfad setzt das nie.
 */

import {
    openContext, planAll, applyAll, baseline, looksLikeFreshInstall,
    IMPACT_FINANCIAL,
} from '../lib/migrations/runner.js';

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`
FORGE-Migrationen

  (ohne Argument)      Übersicht: erledigt / offen
  --dry-run            offene Migrationen prüfen, nichts schreiben
  --apply              offene 'safe'-Migrationen anwenden
  --apply --financial  auch Migrationen anwenden, die Kapital bewegen können
  --apply --id <id>    genau eine Migration anwenden
  --baseline           alle als angewendet verbuchen, ohne sie auszuführen
  --json               maschinenlesbare Ausgabe (nur mit --dry-run / ohne Argument)
  --help               diese Hilfe

Ohne --apply wird nichts geschrieben.
`.trim());
    process.exit(0);
}

const apply       = argv.includes('--apply');
const financial   = argv.includes('--financial');
const wantBase    = argv.includes('--baseline');
const jsonMode    = argv.includes('--json');
const onlyId      = argv.includes('--id') ? argv[argv.indexOf('--id') + 1] : null;

const ctx = openContext({ readonly: !apply && !wantBase });

function impactTag(m) {
    return m.impact === IMPACT_FINANCIAL ? '⚠ bewegt Kapital' : 'unkritisch';
}

try {
    // ── Baseline ─────────────────────────────────────────────────────────────
    if (wantBase) {
        if (!looksLikeFreshInstall(ctx)) {
            console.log('⚠️  Diese Installation hat bereits Pool-Einstellungen — --baseline würde offene');
            console.log('    Korrekturen dauerhaft als erledigt verbuchen, ohne sie auszuführen.');
            console.log('    Wenn das gewollt ist, die Einstellungen vorher sichern.\n');
        }
        await baseline(ctx);
        process.exit(0);
    }

    // ── Übersicht / Vorschau ─────────────────────────────────────────────────
    const entries = await planAll(ctx);

    if (jsonMode) {
        console.log(JSON.stringify(entries.map(e => ({
            id: e.migration.id, description: e.migration.description,
            impact: e.migration.impact, applied: e.applied, plan: e.plan,
        })), null, 2));
        process.exit(0);
    }

    const open = entries.filter(e => !e.applied && e.plan?.pending);

    if (!apply) {
        console.log('\nFORGE-Migrationen\n');
        for (const e of entries) {
            const m = e.migration;
            if (e.applied)            { console.log(`  ✓ ${m.id}  (erledigt)`); continue; }
            if (m.superseded)         { console.log(`  ○ ${m.id}  (${m.supersededNote})`); continue; }
            if (e.plan?.error)        { console.log(`  ✗ ${m.id}  Prüfung fehlgeschlagen: ${e.plan.error}`); continue; }
            if (!e.plan?.pending)     { console.log(`  ○ ${m.id}  (nichts zu tun)`); continue; }

            console.log(`  ● ${m.id}  [${impactTag(m)}]`);
            console.log(`      ${m.description}`);
            console.log(`      ${e.plan.summary}`);
            for (const d of e.plan.details  ?? []) console.log(`        · ${d}`);
            for (const w of e.plan.warnings ?? []) console.log(`        ⚠ ${w}`);
        }

        if (!open.length) {
            console.log('\nAlles erledigt — keine offenen Migrationen.\n');
        } else {
            const fin = open.filter(e => e.migration.impact === IMPACT_FINANCIAL).length;
            console.log(`\n${open.length} offen. Mit --apply anwenden.`);
            if (fin) console.log(`⚠ Davon ${fin}, die Kapital bewegen können — dafür zusätzlich --financial.`);
            console.log('');
        }
        process.exit(0);
    }

    // ── Anwenden ─────────────────────────────────────────────────────────────
    console.log('\nWende Migrationen an…\n');
    const res = await applyAll(ctx, { includeFinancial: financial, onlyId });

    if (res.deferred.length) {
        console.log('\n⚠ Zurückgestellt (bewegen Kapital, brauchen --financial):');
        for (const d of res.deferred) {
            console.log(`  ● ${d.m.id} — ${d.plan.summary}`);
            for (const w of d.plan.warnings ?? []) console.log(`      ⚠ ${w}`);
        }
    }
    if (res.failed.length) {
        console.log('\n✗ Fehlgeschlagen:');
        for (const f of res.failed) console.log(`  ${f.m.id}: ${f.error}`);
    }

    console.log(`\n${res.applied.length} angewendet, ${res.deferred.length} zurückgestellt, ${res.failed.length} fehlgeschlagen.\n`);
    process.exit(res.failed.length ? 1 : 0);
} finally {
    ctx.close();
}
