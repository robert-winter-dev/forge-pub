#!/usr/bin/env node
/**
 * FORGE public Premium – Dry-Run-Gate vor der Kapitalfreigabe (pool-offers.md Schritt 6/6)
 *
 * Ein übernommener Pool-Offer ist gesperrt (enabled:false, cleanup.rankingEligible:false,
 * siehe bots/settings/routes/pool-offers.js „Drei getrennte Zustände"). Bevor der Nutzer
 * die Kapitalfreigabe (Pool aktivieren, enabled:true) anstoßen kann, prüft dieses Script
 * automatisch per `deposit.js --dry-run`, ob ein echter Deposit technisch durchginge –
 * ohne dass dabei Kapital bewegt wird (deposit.js hält im Dry-Run-Modus keinen Lock und
 * führt keine On-Chain-TX aus).
 *
 * Läuft automatisch als Cron (config/cron-jobs.json) – sobald ein neuer Pool erscheint
 * und es technisch möglich ist (pool_stats liegt vor), wird getestet, kein manueller
 * Button. Voraussetzung: pool_stats existiert bereits – der laufende Bot schreibt sie
 * auch für inaktive Pools mit jedem Stats-Intervall (siehe bot.js), typischerweise
 * ~1 Zyklus nach der Übernahme.
 *
 * Testbetrag: fester Nominalbetrag PROBE_USDC – deckt sowohl die --new-Mindestsumme
 * (5 USDC) als auch volatilePair-Pools (10 USDC) ab.
 *
 * Ergebnis landet in settings.db pool_settings als `dryRunGate` ({status, checkedAt,
 * error}) – gelesen vom Freigabe-Gate in bots/settings/routes/pools-actions.js
 * (toggle-enabled) und von der UI. Ein fehlgeschlagenes Gate wird nach RETRY_COOLDOWN_MS
 * automatisch erneut versucht (z.B. transiente RPC-Fehler, noch fehlendes SOL) – ein
 * bestandenes Gate ist dagegen final (kein erneuter Dry-Run nötig).
 *
 *   node bin/pool-offers-dryrun.js [--json]
 */

import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../lib/config.js';
import { openDatabase, getPoolStats } from '../lib/db.js';
import * as notify from '../lib/notify.js';
import { PATHS } from '../../../config/paths.js';

const __dirname      = path.dirname(fileURLToPath(import.meta.url));
const LIQUIDITY_ROOT = path.resolve(__dirname, '..');
const SETTINGS_DB    = PATHS.settingsDb;
const DEPOSIT_SCRIPT = path.join(LIQUIDITY_ROOT, 'bin', 'deposit.js');

const PROBE_USDC        = 10;                    // fester Testbetrag, siehe Kopf-Kommentar
const RETRY_COOLDOWN_MS = 60 * 60 * 1000;        // 1h zwischen erneuten Versuchen nach 'failed'

const jsonOutput = process.argv.includes('--json');

function loadPoolSettings(sdb, poolId) {
    const row = sdb.prepare(
        `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
    ).get(config.botId, poolId);
    return row ? JSON.parse(row.settings) : {};
}

function writePoolSettings(sdb, poolId, settings) {
    sdb.prepare(`
        INSERT INTO pool_settings (bot_id, pool_id, settings)
        VALUES (?, ?, ?)
        ON CONFLICT (bot_id, pool_id) DO UPDATE SET settings = excluded.settings
    `).run(config.botId, poolId, JSON.stringify(settings));
}

/** Läuft `deposit.js --dry-run --json` als Kindprozess, parst die letzte JSON-Zeile. */
function runDryRun(pool) {
    return new Promise((resolve) => {
        const args = [DEPOSIT_SCRIPT, '--pool', pool.pair, '--usdc', String(PROBE_USDC), '--new', '--dry-run', '--json'];
        const proc = spawn('node', args, { cwd: LIQUIDITY_ROOT });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            try { proc.kill('SIGTERM'); } catch { /* bereits beendet */ }
            resolve({ ok: false, error: 'Timeout nach 90s' });
        }, 90_000);
        proc.stdout.on('data', c => { stdout += c.toString(); });
        proc.stderr.on('data', c => { stderr += c.toString(); });
        proc.on('close', (code) => {
            clearTimeout(timer);
            const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
            const jsonLine = [...lines].reverse().find(l => l.startsWith('{') && l.endsWith('}'));
            if (!jsonLine) {
                resolve({ ok: false, error: `Kein JSON-Output (exit=${code}): ${stderr.slice(0, 300)}` });
                return;
            }
            try {
                resolve(JSON.parse(jsonLine));
            } catch (err) {
                resolve({ ok: false, error: `JSON-Parse fehlgeschlagen: ${err.message}` });
            }
        });
    });
}

const sdb = new Database(SETTINGS_DB);
sdb.exec(`
    CREATE TABLE IF NOT EXISTS pool_settings (
        bot_id   TEXT NOT NULL,
        pool_id  TEXT NOT NULL,
        settings TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (bot_id, pool_id)
    )
`);
const db  = openDatabase();

const results = [];
try {
    for (const pool of config.pools.all) {
        const settings = loadPoolSettings(sdb, pool.id);

        // Nur Pools, die über den Pool-Offer-Übernahmepfad kamen (zweite Sperre gesetzt).
        if (settings.cleanup?.rankingEligible !== false) continue;

        const prevGate = settings.dryRunGate;
        if (prevGate?.status === 'passed') continue; // final, kein erneuter Lauf nötig
        if (prevGate?.status === 'failed' && Date.now() - prevGate.checkedAt < RETRY_COOLDOWN_MS) continue;

        const stats = getPoolStats(db, pool.id, 1);
        if (stats.length === 0) continue; // wartet noch auf den ersten Bot-Zyklus

        const dryRun = await runDryRun(pool);
        const gate = {
            status:    dryRun.ok ? 'passed' : 'failed',
            checkedAt: Date.now(),
            error:     dryRun.ok ? null : (dryRun.error ?? 'unbekannter Fehler'),
        };
        settings.dryRunGate = gate;
        writePoolSettings(sdb, pool.id, settings);
        results.push({ poolId: pool.id, pair: pool.pair, ...gate });

        // Nur bei tatsächlichem Statuswechsel benachrichtigen (kein Spam bei jedem Retry).
        if (prevGate?.status !== gate.status) {
            if (gate.status === 'passed') {
                await notify.info(pool.displayPair ?? pool.pair,
                    'Dry-Run-Gate bestanden – der Pool kann jetzt über „Pool aktivieren" mit Kapital freigegeben werden.');
            } else {
                await notify.errorRaw(pool.displayPair ?? pool.pair,
                    `Dry-Run-Gate fehlgeschlagen – Kapitalfreigabe noch nicht möglich: ${gate.error}`);
            }
        }
    }
} finally {
    sdb.close();
    db.close();
}

if (jsonOutput) {
    console.log(JSON.stringify({ checked: results.length, results }, null, 2));
} else if (results.length > 0) {
    for (const r of results) {
        console.log(`${r.status === 'passed' ? '✅' : '❌'} ${r.pair}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
    }
} else {
    console.log('[pool-offers-dryrun] keine offenen Gates.');
}
