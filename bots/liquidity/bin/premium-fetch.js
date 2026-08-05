#!/usr/bin/env node
/**
 * FORGE.pub Premium – manueller Fetch+Ingest-Test
 *
 * Ruft fetchAndIngest() gegen die ECHTE Bot-DB dieser Installation auf (openDatabase()
 * ohne Override). Für den echten Produktivbetrieb übernimmt später der Zahlungs-Watcher
 * K_H+URL aus der Gift-Wrap-DM automatisch (noch nicht gebaut) — bis dahin manuell:
 *
 *   node bin/premium-fetch.js --url <blob-url> --key <K_H-hex> [--backup-url <url>] [--dry-run]
 *
 * --backup-url: optionaler Failover-Host (host-agnostisch, siehe lib/blob-download.js).
 * Wird nur versucht, wenn der Download über --url fehlschlägt.
 *
 * --dry-run: lädt + entschlüsselt + validiert, schreibt aber NICHTS in die DB (kein
 * ingestBlob()-Aufruf) — sicherer erster Schritt, bevor echte pool_score_history-Zeilen
 * entstehen (Fork-DB: ranking-exit.js liest u.U. sofort).
 */

import { openDatabase } from '../lib/db.js';
import { downloadBlob } from '../../../lib/blob-download.js';
import { decryptBlob } from '../../../lib/premium-blob.js';
import { validateEnvelope, ingestBlob, getLastSequence } from '../lib/premium-ingest.js';

function arg(name) {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : process.argv[i + 1];
}

const url = arg('--url');
const backupUrl = arg('--backup-url');
const keyHex = arg('--key');
const dryRun = process.argv.includes('--dry-run');

if (!url || !keyHex) {
    console.error('Usage: node bin/premium-fetch.js --url <blob-url> --key <K_H-hex> [--backup-url <url>] [--dry-run]');
    process.exit(1);
}

let buffer;
try {
    buffer = await downloadBlob(url);
} catch (err) {
    if (!backupUrl) throw err;
    console.warn(`[premium-fetch] Primäre URL fehlgeschlagen (${err.message}) – Failover auf Backup-URL.`);
    buffer = await downloadBlob(backupUrl);
}
const data = decryptBlob(buffer, Buffer.from(keyHex, 'hex'));
console.log(`Blob entschlüsselt: schemaVersion=${data.schemaVersion} sequence=${data.sequence} generatedAt=${data.generatedAt} pools=${data.marketTable?.length ?? 0}`);

if (dryRun) {
    const db = openDatabase();
    const lastSequence = getLastSequence(db);
    db.close();
    const check = validateEnvelope(data, lastSequence);
    console.log(`--dry-run: keine Schreibaktion. Validierung: ${check.valid ? 'OK' : 'ABGELEHNT – ' + check.reason}`);
    process.exit(0);
}

const db = openDatabase();
try {
    const result = ingestBlob(db, data);
    console.log(JSON.stringify(result, null, 2));
} finally {
    db.close();
}
