#!/usr/bin/env node
/**
 * FORGE public Premium – Deposit-Probelauf für übernommene Pools
 *
 * Prüft per `deposit.js --dry-run`, ob ein echter Deposit in einen aus einem Pool-Offer
 * stammenden Pool technisch durchginge – ohne dass dabei Kapital bewegt wird (deposit.js
 * hält im Dry-Run-Modus keinen Lock und führt keine On-Chain-TX aus). Läuft automatisch
 * als Cron (config/cron-jobs.json), kein manueller Button.
 *
 * ── Zwei Rollen, je nach Herkunft des Pools ──────────────────────────────────
 *
 *   SPERRE (Altbestand). Pools, die vor 2026-08-21 über den damaligen Klickpfad
 *   übernommen wurden, tragen `cleanup.rankingEligible:false` und sind gesperrt. Für sie
 *   ist der Probelauf weiterhin ein echtes Gate: erst ein `passed` lässt
 *   `POST .../mode` (pools-actions.js, vormals toggle-enabled, LIQ#0365) die
 *   Kapitalfreigabe zu. Verhalten unverändert.
 *
 *   DIAGNOSE (Automatik-Bestand). Seit 2026-08-21 importierte Pools sind sofort
 *   freigegeben; über Kapital entscheidet allein das Score-Ranking (Begründung in
 *   lib/pool-offer-adopt.js). Hier sperrt der Probelauf nichts – er meldet nur, wenn
 *   eine Einzahlung technisch scheitern würde. Ohne diese Meldung bliebe ein kaputter
 *   Deposit-Pfad (der Klassiker: fehlendes `volatilePair`, IL-Check blockt mit ~99 %,
 *   Bug-Fund 2026-06-02) unsichtbar, bis der Cleanup den Pool erstmals wählt und
 *   scheitert – also womöglich wochenlang.
 *
 * Beide Rollen teilen sich denselben Lauf, dieselbe `dryRunGate`-Zeile in settings.db
 * ({status, checkedAt, error}) und dieselbe Retry-Regel. Sie unterscheiden sich nur
 * darin, WER auf das Ergebnis reagiert: dort die Freigabe-Route, hier der Nutzer.
 *
 * Voraussetzung in beiden Fällen: pool_stats existiert bereits – der laufende Bot
 * schreibt sie auch für inaktive Pools mit jedem Stats-Intervall (siehe bot.js),
 * typischerweise ~1 Zyklus nach der Übernahme.
 *
 * Testbetrag: fester Nominalbetrag PROBE_USDC – deckt sowohl die --new-Mindestsumme
 * (5 USDC) als auch volatilePair-Pools (10 USDC) ab.
 *
 * Ein fehlgeschlagener Probelauf wird nach RETRY_COOLDOWN_MS automatisch erneut versucht
 * (z.B. transiente RPC-Fehler, noch fehlendes SOL). Ein bestandener ist für Altpools
 * final; für Automatik-Pools wird er weiter beobachtet, damit ein später auftretender
 * Fehler nicht unbemerkt bleibt.
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

        // Zuständig ausschließlich für Pools aus dem Offer-Pfad. Die Herkunft ist das
        // Kriterium, nicht die Cleanup-Sperre.
        //
        // Korrigiert 2026-08-21: vorher lautete die Bedingung
        // `settings.cleanup?.rankingEligible !== false → continue`. Diese Sperre wird
        // aber auch für REFERENZPOOLS gesetzt (ihr ursprünglicher Zweck, siehe
        // lib/config.js) — der Job hat dadurch `liq-jitosol-ref` mitgeprüft und ihm ein
        // `dryRunGate: passed` samt Meldung „kann jetzt über Pool aktivieren freigegeben
        // werden" verpasst. Folgenlos geblieben, aber sachlich falsch: in einen
        // Referenzpool soll nie Kapital, für ihn gibt es nichts freizugeben.
        if (!pool.premiumOffer) continue;

        // Welche der beiden Rollen greift? (siehe Kopfkommentar) Gesperrt = Altbestand,
        // das Ergebnis schaltet eine Freigabe. Sonst = Automatik, reine Diagnose.
        const locked = settings.cleanup?.rankingEligible === false;

        const prevGate = settings.dryRunGate;
        // Bestanden bleibt bestanden – auch für Automatik-Pools. Ein stündlicher
        // Wiederholungslauf über alle laufenden Pools wäre dauerhafte RPC-Grundlast
        // ohne Erkenntnisgewinn; ein später auftretender Fehler zeigt sich ohnehin
        // beim echten Deposit-Versuch.
        if (prevGate?.status === 'passed') continue;
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
        results.push({ poolId: pool.id, pair: pool.pair, role: locked ? 'gate' : 'diagnose', ...gate });

        // Nur bei tatsächlichem Statuswechsel benachrichtigen (kein Spam bei jedem Retry).
        if (prevGate?.status === gate.status) continue;

        if (locked) {
            // Altbestand: das Ergebnis schaltet eine Sperre – der Nutzer muss danach
            // selbst handeln, deshalb die Meldung in beide Richtungen.
            if (gate.status === 'passed') {
                await notify.info(pool.displayPair ?? pool.pair,
                    'Dry-Run-Gate bestanden – der Pool kann jetzt über „Pool aktivieren" mit Kapital freigegeben werden.');
            } else {
                await notify.errorRaw(pool.displayPair ?? pool.pair,
                    `Dry-Run-Gate fehlgeschlagen – Kapitalfreigabe noch nicht möglich: ${gate.error}`);
            }
        } else if (gate.status === 'failed') {
            await notify.poolDepositCheckFailed(pool, gate.error);
        } else if (prevGate) {
            // Entwarnung nur, wenn vorher wirklich gewarnt wurde. Der Normalfall –
            // erster Probelauf nach dem Import geht durch – bleibt still: eine
            // Erfolgsmeldung für etwas, das niemand angestoßen hat und das nichts
            // ändert, ist genau die Sorte Nachricht, die den Rest entwertet.
            await notify.poolDepositCheckRecovered(pool);
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
        console.log(`${r.status === 'passed' ? '✅' : '❌'} ${r.pair} [${r.role}]: ${r.status}${r.error ? ` (${r.error})` : ''}`);
    }
} else {
    console.log('[pool-offers-dryrun] nichts zu prüfen.');
}
