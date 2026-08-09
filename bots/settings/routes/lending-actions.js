/**
 * /api/lending – Manuelle Aktionen für den LendingBot
 *
 * GET  /api/lending/config
 *     → Protokoll-Liste (name, label, active, enabled, tvlGuard) + auto-deploy-Status
 *
 * PUT  /api/lending/pool-enabled/:protocolId
 *     Body: { enabled: bool }
 *     → Pool-Freigabe setzen. Beim Aktivieren: liegt der aktuelle TVL unter der
 *       TVL-Schutz-Schwelle, wird diese auf 50 % des aktuellen TVL gesenkt.
 *
 * PUT  /api/lending/tvl-guard/:protocolId
 *     Body: { enabled, thresholdUsd, sendTo }
 *     → TVL-Schutz-Settings pro Protokoll speichern
 *
 * POST /api/lending/deposit
 *     Body: { protocol, amount }
 *     → führt bin/deposit.js --json --yes aus
 *
 * POST /api/lending/withdraw
 *     Body: { protocol, amount }  (amount: Zahl oder "all")
 *     → führt bin/withdraw.js --json --yes aus
 *
 * POST /api/lending/rebalance/trigger
 *     → legt data/force-rebalance.flag an
 *
 * GET  /api/lending/auto-deploy
 *     → { paused: bool }
 *
 * POST /api/lending/auto-deploy
 *     Body: { paused: bool }
 *     → legt data/auto-deploy-paused.flag an oder löscht ihn
 */

import { Router }        from 'express';
import fs                from 'fs';
import path              from 'path';
import { fileURLToPath } from 'url';
import { spawn }         from 'node:child_process';
import Database          from 'better-sqlite3';
import { PATHS, envFile } from '../../../config/paths.js';

const __dirname      = path.dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT     = PATHS.root;
const LB_ROOT        = PATHS.lending;
const MOVE_LOCK      = path.join(PATHS.lendingData, 'move.lock');
const AUTO_DEPLOY_PAUSE = path.join(PATHS.lendingData, 'auto-deploy-paused.flag');
// envFile() statt hardcodiertem LB_ROOT/.env – im Fork liegt die .env unter
// local/env/lending.env (siehe config/paths.js).
const LB_CONFIG_PATH = envFile('lending');
const LB_DATA_JSON   = path.join(PATHS.html, 'lending', 'data', 'data.json');
const SETTINGS_DB    = PATHS.settingsDb;

const router = Router();

// ── TVL-Schutz pro Protokoll (settings.db, bot_id='lending') ──────────────────
// Default je Protokoll: aktiv, Schwelle 100K, kein Versand.
const DEFAULT_TVL_GUARD = { enabled: true, thresholdUsd: 100_000, sendTo: '' };

function openSettingsDb() {
    const db = new Database(SETTINGS_DB);
    db.exec(`
        CREATE TABLE IF NOT EXISTS pool_settings (
            bot_id   TEXT NOT NULL,
            pool_id  TEXT NOT NULL,
            settings TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (bot_id, pool_id)
        )
    `);
    return db;
}

/** Liest die tvlGuard-Settings eines Protokolls (mit Default-Merge). */
function loadTvlGuard(db, protocolId) {
    const row = db.prepare(
        `SELECT settings FROM pool_settings WHERE bot_id = 'lending' AND pool_id = ?`
    ).get(protocolId);
    if (!row) return { ...DEFAULT_TVL_GUARD };
    try {
        const tg = JSON.parse(row.settings)?.tvlGuard;
        return { ...DEFAULT_TVL_GUARD, ...(tg ?? {}) };
    } catch {
        return { ...DEFAULT_TVL_GUARD };
    }
}

/** Schreibt die tvlGuard-Settings eines Protokolls (validiert). */
function saveTvlGuard(db, protocolId, partial) {
    const row     = db.prepare(
        `SELECT settings FROM pool_settings WHERE bot_id = 'lending' AND pool_id = ?`
    ).get(protocolId);
    let current = {};
    if (row) { try { current = JSON.parse(row.settings); } catch { current = {}; } }

    const merged = { ...DEFAULT_TVL_GUARD, ...(current.tvlGuard ?? {}), ...partial };
    const threshold = Number(merged.thresholdUsd);
    if (merged.enabled && !(threshold > 0)) {
        throw new Error('TVL-Schwelle muss größer als 0 sein.');
    }
    current.tvlGuard = {
        enabled:      !!merged.enabled,
        thresholdUsd: threshold > 0 ? threshold : DEFAULT_TVL_GUARD.thresholdUsd,
        sendTo:       typeof merged.sendTo === 'string' ? merged.sendTo : '',
    };

    db.prepare(`
        INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES ('lending', ?, ?)
        ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
    `).run(protocolId, JSON.stringify(current));
    return current.tvlGuard;
}

// ── Pool-Freigabe pro Protokoll (settings.db, gleiche Zeile wie tvlGuard) ─────
// Eigenes Feld `poolEnabled` (NICHT tvlGuard.enabled!): tvlGuard.enabled schaltet
// den TVL-Schutz-Mechanismus selbst an/aus, poolEnabled ist die Nutzer-Freigabe,
// ob überhaupt investiert werden darf. Default true (kein Eintrag = aktiviert).

/** Liest die Pool-Freigabe eines Protokolls. */
function loadPoolEnabled(db, protocolId) {
    const row = db.prepare(
        `SELECT settings FROM pool_settings WHERE bot_id = 'lending' AND pool_id = ?`
    ).get(protocolId);
    if (!row) return true;
    try { return JSON.parse(row.settings)?.poolEnabled !== false; }
    catch { return true; }
}

/** Setzt die Pool-Freigabe eines Protokolls. */
function savePoolEnabled(db, protocolId, enabled) {
    const row = db.prepare(
        `SELECT settings FROM pool_settings WHERE bot_id = 'lending' AND pool_id = ?`
    ).get(protocolId);
    let current = {};
    if (row) { try { current = JSON.parse(row.settings); } catch { current = {}; } }
    current.poolEnabled = !!enabled;
    db.prepare(`
        INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES ('lending', ?, ?)
        ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
    `).run(protocolId, JSON.stringify(current));
}

/**
 * True wenn das Protokoll laut lendingbot.db eine offene Position mit
 * Kapital hält. Analog zur bereits bestehenden Sperre beim Liquidity Bot
 * (bots/settings/routes/pools-actions.js hasOpenPosition()) — dort verhindert
 * dieselbe Prüfung, dass ein Pool mit offener Position deaktiviert wird.
 * Beim Lending Bot fehlte dieses Gegenstück bisher (Fund 2026-08-07): die
 * Route deaktivierte bis jetzt "einfaches Setzen, keine weitere Logik", auch
 * mit `amount > 0`.
 */
function hasProtocolCapital(protocolId) {
    try {
        const db = new Database(PATHS.lendingDb, { readonly: true, fileMustExist: true });
        const row = db.prepare(
            `SELECT 1 FROM positions WHERE protocol = ? AND closed_at IS NULL AND amount > 0 LIMIT 1`
        ).get(protocolId);
        db.close();
        return !!row;
    } catch {
        return false;
    }
}

/**
 * Startet export.js + sync.sh im Hintergrund – Antwort an Client ist bereits raus.
 *
 * Existenz-Checks + error-Handler bewusst: in einem reduzierten Deployment ohne
 * Lending Bot (z.B. FORGE.pub-Fork, aktuell noch scope-bedingt möglich, siehe
 * config/pub-allowlist.json Backlog) existiert LB_ROOT nicht – spawn() liefert
 * dafür ENOENT als ASYNCHRONES 'error'-Event, kein Handler dafür crasht den
 * kompletten forge-settings-Prozess (siehe identischer Fund + Fix in wallet.js,
 * 2026-07-26).
 */
function triggerExportAndSync() {
    const exportPath = path.join(LB_ROOT, 'bin', 'export.js');
    const syncPath    = path.join(FORGE_ROOT, 'bin', 'sync.sh');
    const runSync = () => {
        if (!fs.existsSync(syncPath)) return;
        const syncProc = spawn('bash', [syncPath], { cwd: FORGE_ROOT, detached: true, stdio: 'ignore' });
        syncProc.on('error', err => console.error(`[triggerExportAndSync] sync.sh: ${err.message}`));
        syncProc.unref();
    };
    if (!fs.existsSync(exportPath)) { runSync(); return; }
    const exportProc = spawn('node', [exportPath], { cwd: LB_ROOT, stdio: 'ignore' });
    exportProc.on('error', err => console.error(`[triggerExportAndSync] lending export.js: ${err.message}`));
    exportProc.on('close', runSync);
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────────

function readEnv() {
    try {
        return Object.fromEntries(
            fs.readFileSync(LB_CONFIG_PATH, 'utf8')
                .split('\n')
                .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
                .map(l => { const idx = l.indexOf('='); return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()]; })
        );
    } catch { return {}; }
}

/** Spawnt ein CLI-Script, sammelt stdout, liefert das letzte JSON-Objekt. */
function runCli(scriptRelPath, cliArgs, { timeoutMs = 120_000 } = {}) {
    return new Promise((resolve) => {
        const proc = spawn('node', [path.join(LB_ROOT, scriptRelPath), ...cliArgs], { cwd: LB_ROOT });
        let stdout = '';
        const timer = setTimeout(() => {
            try { proc.kill('SIGTERM'); } catch {}
            resolve({ ok: false, error: `Timeout nach ${timeoutMs / 1000}s` });
        }, timeoutMs);
        // Ohne Handler crasht ein ENOENT (z.B. LB_ROOT fehlt im Fork) den ganzen
        // forge-settings-Prozess über ein unhandled 'error'-Event statt hier
        // sauber als Fehler aufzulösen (siehe triggerExportAndSync() oben).
        proc.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
        proc.stdout.on('data', c => { stdout += c.toString(); });
        proc.on('close', () => {
            clearTimeout(timer);
            const lines    = stdout.split('\n').map(l => l.trim()).filter(Boolean);
            const jsonLine = [...lines].reverse().find(l => l.startsWith('{') && l.endsWith('}'));
            if (!jsonLine) {
                resolve({ ok: false, error: 'Kein JSON-Output vom Script' });
                return;
            }
            try { resolve(JSON.parse(jsonLine)); }
            catch (err) { resolve({ ok: false, error: `JSON-Parse fehlgeschlagen: ${err.message}` }); }
        });
    });
}

/**
 * Bekannte Protokolle mit Labels.
 * 🔒 Muss Wort für Wort mit labelFor() in bots/lending/bin/export.js übereinstimmen —
 * das ist die Quelle, die im Dashboard live angezeigt wird. Abweichende Labels hier
 * ließen denselben Pool im Dashboard und in den Settings wie zwei verschiedene Pools
 * aussehen (Befund 2026-08-09: 'Loopscale Onre' hier vs. 'Loopscale Public' im
 * Dashboard für dasselbe Protokoll `loopscale-onre`).
 */
const PROTOCOL_LABELS = {
    'kamino':             'Kamino',
    'kamino-figure':      'Kamino Figure',
    'kamino-onre':        'Kamino OnRe',
    'kamino-huma':        'Kamino Huma',
    'jupiter':            'Jupiter Lend',
    'loopscale-genesis':  'Loopscale Gen',
    'loopscale-onre':     'Loopscale Public',
};

// ── Routen ────────────────────────────────────────────────────────────────────

/** Gibt Protokoll-Liste + aktuellen Auto-Deploy-Status zurück. */
router.get('/config', (req, res) => {
    const env        = readEnv();
    const autoDeploy = !fs.existsSync(AUTO_DEPLOY_PAUSE);
    const moveLocked = fs.existsSync(MOVE_LOCK);

    let protocolStats = {};
    let positions     = [];
    try {
        const data    = JSON.parse(fs.readFileSync(LB_DATA_JSON, 'utf8'));
        protocolStats = data.protocolStats ?? {};
        positions     = data.positions     ?? [];
    } catch { /* data.json nicht verfügbar */ }

    // Aktiv = offene Position mit amount > 0
    const activeAmounts = new Map();
    for (const pos of positions) {
        if ((pos.amount ?? 0) > 0) {
            activeAmounts.set(pos.protocol, (activeAmounts.get(pos.protocol) ?? 0) + pos.amount);
        }
    }

    // Qualifiziert = Pool freigegeben (enabled) + APY-Schwelle erfüllt.
    // Der frühere hartcodierte TVL-Mindestwert wurde durch die nutzergesteuerte
    // Pool-Freigabe (enabled) ersetzt, siehe lib/tvl-guard.js.
    const apyThreshold = parseFloat(env.APY_THRESHOLD_PERCENT ?? '5') || 5;

    // TVL bei Aktivierung pro Protokoll (poolTvl der offenen Position, falls vorhanden)
    const activationTvl = new Map();
    for (const pos of positions) {
        if ((pos.amount ?? 0) > 0 && pos.poolTvl > 0 && !activationTvl.has(pos.protocol)) {
            activationTvl.set(pos.protocol, pos.poolTvl);
        }
    }

    const sdb = openSettingsDb();
    const protocols = Object.entries(PROTOCOL_LABELS).map(([id, label]) => {
        const stats     = protocolStats[id] ?? {};
        const apy       = stats.apy  ?? null;
        const tvl       = stats.tvl  ?? 0;
        const amount    = activeAmounts.get(id) ?? 0;
        const active    = amount > 0;
        const enabled   = loadPoolEnabled(sdb, id);
        const qualified = enabled && apy != null && apy >= apyThreshold;

        // Nutzbar = qualifiziert (Einzahlen möglich) ODER aktive Position vorhanden.
        // Sonst: Pool ist nur informativ gelistet → Grund für die Anzeige ableiten.
        let disabledReason = null;
        if (!qualified && !active) {
            const reasons = [];
            if (!enabled)                  reasons.push('Pool deaktiviert');
            if (apy == null)               reasons.push('keine APY-Daten');
            else if (apy < apyThreshold)   reasons.push(`APY ${apy.toFixed(2)} % unter ${apyThreshold} %`);
            disabledReason = reasons.length ? reasons.join(' · ') : 'erfüllt die internen Kriterien nicht';
        }

        return {
            id, label, active, enabled, qualified, apy, amount, disabledReason,
            currentTvl:      tvl || null,
            tvlGuard:        loadTvlGuard(sdb, id),
            tvlAtActivation: activationTvl.get(id) ?? null,
        };
    });
    sdb.close();

    res.json({ protocols, autoDeploy, moveLocked });
});

// ── PUT /api/lending/tvl-guard/:protocolId – TVL-Schutz pro Protokoll speichern ──
router.put('/tvl-guard/:protocolId', (req, res) => {
    const { protocolId } = req.params;
    if (!PROTOCOL_LABELS[protocolId]) {
        return res.status(404).json({ ok: false, error: 'Protokoll unbekannt' });
    }
    const body = req.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ ok: false, error: 'Body muss ein Objekt sein' });
    }
    try {
        const db    = openSettingsDb();
        const saved = saveTvlGuard(db, protocolId, body);
        db.close();
        res.json({ ok: true, tvlGuard: saved });
    } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
    }
});

// ── PUT /api/lending/pool-enabled/:protocolId – Pool aktivieren/deaktivieren ──
//
// Deaktivieren: blockiert, solange das Protokoll noch Kapital hält (s.u.
// hasProtocolCapital) — davor "einfaches Setzen, keine weitere Logik".
// Aktivieren (Reaktivierung): liegt der aktuelle TVL unter der konfigurierten
// TVL-Schutz-Schwelle, wird die Schwelle auf 50 % des aktuellen TVL gesenkt –
// sonst würde der Pool durch den TVL-Schutz beim nächsten Bot-Tick sofort
// wieder deaktiviert werden.
router.put('/pool-enabled/:protocolId', (req, res) => {
    const { protocolId } = req.params;
    if (!PROTOCOL_LABELS[protocolId]) {
        return res.status(404).json({ ok: false, error: 'Protokoll unbekannt' });
    }
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
        return res.status(400).json({ ok: false, error: 'enabled (bool) fehlt' });
    }
    if (enabled === false && hasProtocolCapital(protocolId)) {
        return res.status(409).json({
            ok: false,
            error: 'Protokoll hat eine offene Position (Kapital) – erst auszahlen, dann deaktivieren.',
        });
    }

    const db = openSettingsDb();
    try {
        let adjustedTvlGuard = null;

        if (enabled) {
            let currentTvl = null;
            try {
                const data = JSON.parse(fs.readFileSync(LB_DATA_JSON, 'utf8'));
                currentTvl = data.protocolStats?.[protocolId]?.tvl ?? null;
            } catch { /* data.json nicht verfügbar */ }

            const guard = loadTvlGuard(db, protocolId);
            if (currentTvl != null && currentTvl > 0 && guard.enabled && currentTvl < guard.thresholdUsd) {
                // Mindestens 1 USDC (Fund 2026-08-07): bei sehr niedrigem TVL (< 2 USDC)
                // rundet Math.floor(currentTvl * 0.5) auf 0 ab — saveTvlGuard() lehnt
                // eine aktivierte Schwelle von 0 als ungültig ab, die Reaktivierung
                // schlug dadurch komplett fehl, obwohl der Guard-Zweck (Schwelle unter
                // dem aktuellen TVL halten) mit 1 USDC genauso erfüllt ist.
                adjustedTvlGuard = saveTvlGuard(db, protocolId, {
                    ...guard,
                    thresholdUsd: Math.max(1, Math.floor(currentTvl * 0.5)),
                });
            }
        }

        savePoolEnabled(db, protocolId, enabled);
        db.close();
        res.json({ ok: true, enabled, tvlGuard: adjustedTvlGuard });
    } catch (err) {
        db.close();
        res.status(400).json({ ok: false, error: err.message });
    }
});

/** Manuelles Deposit in ein Protokoll. */
router.post('/deposit', async (req, res) => {
    const { protocol, amount } = req.body ?? {};
    if (!protocol) return res.status(400).json({ ok: false, error: 'protocol fehlt' });
    if (amount == null) return res.status(400).json({ ok: false, error: 'amount fehlt' });

    // Deaktivierte Pools sind für JEDEN Deposit-Weg gesperrt, nicht nur Auto-Deploy.
    {
        const sdb = openSettingsDb();
        const enabled = loadPoolEnabled(sdb, protocol);
        sdb.close();
        if (!enabled) {
            return res.status(409).json({ ok: false, error: `Pool "${protocol}" ist deaktiviert – im Settings-UI wieder aktivieren.` });
        }
    }

    // move.lock setzen → Bot deployed während der TX nicht automatisch
    const lockInfo = JSON.stringify({ pid: process.pid, startedAt: Date.now(), reason: 'manual-deposit' });
    try { fs.writeFileSync(MOVE_LOCK, lockInfo, 'utf8'); } catch { /* ignorieren */ }

    try {
        const result = await runCli('bin/deposit.js', [
            '--protocol', protocol,
            '--amount',   String(amount),
            '--yes', '--json',
        ]);
        if (result.ok) triggerExportAndSync();
        res.status(result.ok ? 200 : 409).json(result);
    } finally {
        try { fs.unlinkSync(MOVE_LOCK); } catch { /* bereits gelöscht */ }
    }
});

/** Manueller Withdraw aus einem Protokoll. */
router.post('/withdraw', async (req, res) => {
    const { protocol, amount } = req.body ?? {};
    if (!protocol) return res.status(400).json({ ok: false, error: 'protocol fehlt' });
    if (amount == null) return res.status(400).json({ ok: false, error: 'amount fehlt' });

    // move.lock setzen → Bot deployed während der TX nicht automatisch
    const lockInfo = JSON.stringify({ pid: process.pid, startedAt: Date.now(), reason: 'manual-withdraw' });
    try { fs.writeFileSync(MOVE_LOCK, lockInfo, 'utf8'); } catch { /* ignorieren */ }

    try {
        const result = await runCli('bin/withdraw.js', [
            '--protocol', protocol,
            '--amount',   String(amount),
            '--yes', '--json',
        ]);
        if (result.ok) triggerExportAndSync();
        res.status(result.ok ? 200 : 409).json(result);
    } finally {
        try { fs.unlinkSync(MOVE_LOCK); } catch { /* bereits gelöscht */ }
    }
});


/** Aktuelle Positionen (Protokoll + eingesetzter Betrag) aus dem Dashboard-JSON. */
router.get('/positions', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(LB_DATA_JSON, 'utf8'));
        res.json({ positions: data.positions ?? [] });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

/** Liest den aktuellen Auto-Deploy-Status. */
router.get('/auto-deploy', (req, res) => {
    res.json({ paused: fs.existsSync(AUTO_DEPLOY_PAUSE) });
});

/** Setzt oder löscht den Auto-Deploy-Pause-Flag. */
router.post('/auto-deploy', (req, res) => {
    const { paused } = req.body ?? {};
    if (typeof paused !== 'boolean') return res.status(400).json({ ok: false, error: 'paused (bool) fehlt' });

    try {
        if (paused) {
            fs.writeFileSync(AUTO_DEPLOY_PAUSE, '', 'utf8');
        } else {
            if (fs.existsSync(AUTO_DEPLOY_PAUSE)) fs.unlinkSync(AUTO_DEPLOY_PAUSE);
        }
        res.json({ ok: true, paused });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

export default router;
