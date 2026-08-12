#!/usr/bin/env node
/**
 * FORGE public Premium – Pool-Offers gegen die Chain prüfen (manuelles Test-/Diagnose-CLI)
 *
 * Liest data/premium/pool-offers.json (von premium-ingest.js abgelegt, siehe
 * bin/premium-fetch.js) und validiert jeden Eintrag gegen die Chain
 * (lib/pool-offers-validator.js). Reine Leseoperation — keine DB-/pools.json-Änderung,
 * kein Kapitalrisiko. Vorstufe der künftigen Übernahme-UI (Schritt 5, noch nicht gebaut),
 * hier erstmal nur zur Verifikation, dass der Validator gegen echte gelieferte Daten
 * plausible Ergebnisse liefert.
 *
 *   node bin/pool-offers-check.js [--json]
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validatePoolOffers } from '../lib/pool-offers-validator.js';
import { PATHS } from '../../../config/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POOL_OFFERS_PATH = path.join(PATHS.liquidityData, 'premium', 'pool-offers.json');
const POOLS_CONFIG_PATH = path.resolve(__dirname, '../config/pools.json');

const jsonOutput = process.argv.includes('--json');

let offers;
try {
    offers = JSON.parse(readFileSync(POOL_OFFERS_PATH, 'utf8'));
} catch (err) {
    console.error(`pool-offers.json nicht lesbar (${err.message}) – erst premium-fetch.js mit einem Blob laufen lassen, der poolOffers enthält.`);
    process.exit(1);
}

let localPoolIds = [];
try {
    const cfg = JSON.parse(readFileSync(POOLS_CONFIG_PATH, 'utf8'));
    localPoolIds = (cfg.pools ?? cfg).map(p => p.id);
} catch {
    // pools.json optional für den quotePricePoolId-Check – fehlt sie, wird der Check
    // einfach als "nicht vorhanden" gewertet statt das ganze Script abzubrechen.
}

const results = await validatePoolOffers(offers, { localPoolIds });

const summary = {};
for (const r of results) summary[r.status] = (summary[r.status] ?? 0) + 1;

if (jsonOutput) {
    console.log(JSON.stringify({ summary, results }, null, 2));
} else {
    console.log(`Geprüft: ${results.length} Offers — ${JSON.stringify(summary)}`);
    for (const r of results) {
        const marker = r.status === 'verified' ? '✅' : r.status === 'unsupported' ? '⚠️ ' : '❌';
        const extra = r.acceptedException ? ' (Ausnahme akzeptiert)' : '';
        console.log(`${marker} ${r.id}: ${r.status}${extra}`);
        for (const m of r.mismatches) {
            console.log(`    ✗ ${m.field}: erwartet=${JSON.stringify(m.expected)} tatsächlich=${JSON.stringify(m.actual)}${m.error ? ` (${m.error})` : ''}`);
        }
    }
}
