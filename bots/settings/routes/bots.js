/**
 * /api/bots – Bot-Status und Task-Queue
 *
 * GET  /api/bots               → Alle Services mit aktuellem systemd-Status
 * POST /api/bots/:svc/:action  → Task in Queue einreihen (start/stop/restart)
 * GET  /api/bots/tasks/:id     → Task-Status abfragen (für Polling)
 */

import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';
import { listBots } from '../../../lib/bot-registry.js';
import { isForkInstance } from '../../../lib/premium-identity-context.js';
import { isAutoPayEnabled, setAutoPayEnabled } from '../../../lib/premium-auto-pay-store.js';
import { recordPremiumMessage } from '../../../core/premium/messages-db.js';
import { t } from '../../../lib/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

const DB_PATH = PATHS.settingsDb;

// Aus config/bots.json (siehe lib/bot-registry.js). "settings-daemon" bleibt
// bewusst außen vor – der Daemon steuert die anderen Services und soll sich
// nicht selbst per Dashboard-Klick neu starten können.
const SERVICES = listBots()
    .filter(([botId]) => botId !== 'settings-daemon')
    .map(([, bot]) => ({ id: bot.service, label: bot.displayName }));

const ALLOWED_ACTIONS = new Set(['start', 'stop', 'restart']);

// ── Kapital-Sperre ────────────────────────────────────────────────────────────
// Verhindert, dass Liquidity/Lending Bot über den Dienst-Schalter gestoppt
// werden, solange irgendein Pool/Protokoll noch Kapital hält — sonst laufen
// TVL-Schutz/Trailing-Stop nicht mehr, während echtes Geld exponiert bleibt.
// Bewusst NUR für 'stop' (nicht 'restart'): ein Restart ist transient und
// selbstheilend (Bot kommt nach wenigen Sekunden zurück), ein Stop lässt das
// Kapital dagegen unbegrenzt lange unbeaufsichtigt. Dieselbe Unterscheidung
// wie die bereits bestehende Pool-Einzel-Sperre in pools-actions.js/pools.js
// (dort: kein Deaktivieren eines Pools mit offener Position).
function liquidityHasCapital() {
    try {
        const db = new Database(PATHS.liquidityDb, { readonly: true, fileMustExist: true });
        const row = db.prepare(`SELECT 1 FROM positions WHERE closed_at IS NULL LIMIT 1`).get();
        db.close();
        return !!row;
    } catch {
        return false;
    }
}

function lendingHasCapital() {
    try {
        const db = new Database(PATHS.lendingDb, { readonly: true, fileMustExist: true });
        const row = db.prepare(`SELECT 1 FROM positions WHERE closed_at IS NULL AND amount > 0 LIMIT 1`).get();
        db.close();
        return !!row;
    } catch {
        return false;
    }
}

const CAPITAL_CHECKS = {
    'forge-liquiditybot': liquidityHasCapital,
    'forge-lendingbot':   lendingHasCapital,
};

function openDb() {
    const db = new Database(DB_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at  INTEGER NOT NULL,
            started_at  INTEGER,
            finished_at INTEGER,
            status      TEXT    NOT NULL DEFAULT 'pending',
            action      TEXT    NOT NULL,
            target      TEXT    NOT NULL,
            output      TEXT,
            error       TEXT
        )
    `);
    return db;
}

const router = Router();

// ── GET /api/bots ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
    const results = await Promise.all(SERVICES.map(async (svc) => {
        const hasCapital = CAPITAL_CHECKS[svc.id]?.() ?? false;
        try {
            const { stdout } = await execFileAsync('/usr/bin/systemctl', ['is-active', svc.id]);
            return { ...svc, status: stdout.trim(), hasCapital };
        } catch (err) {
            // systemctl is-active gibt exit 3 zurück wenn inactive – kein echter Fehler
            return { ...svc, status: err.stdout?.trim() || 'unknown', hasCapital };
        }
    }));
    res.json(results);
});

// ── POST /api/bots/:svc/:action ───────────────────────────────────────────────
router.post('/:svc/:action', (req, res) => {
    const { svc, action } = req.params;

    const known = SERVICES.find(s => s.id === svc);
    if (!known) {
        return res.status(400).json({ error: t('api.bots.unknown_service', { service: svc }) });
    }
    if (!ALLOWED_ACTIONS.has(action)) {
        return res.status(400).json({ error: t('api.bots.action_not_allowed', { action }) });
    }
    if (action === 'stop' && CAPITAL_CHECKS[svc]?.()) {
        return res.status(409).json({
            error: t('api.bots.capital_open'),
        });
    }

    // Manuelles Stoppen des Liquidity Bots deaktiviert auch die automatische
    // Premium-Zahlung mit (Fund 2026-08-07): Premium liefert Daten speziell für
    // diesen Bot, ihn für einen abgeschalteten Bot weiter zu bezahlen wäre sinnlos.
    // Bewusst NUR bei diesem expliziten, vom Nutzer selbst ausgelösten Stop-Klick
    // (dieselbe Route wie POST /disable in premium.js — identisches Verhalten,
    // identische Message-Center-Meldung) — ein Update/Reboot stoppt den Dienst
    // NICHT über diese Route (setup.sh ruft systemctl direkt auf), löst diesen
    // Hook also nie versehentlich aus. Ein zeitweiliges Down durch ein länger
    // laufendes Update wird stattdessen in premium-pay.js selbst abgefangen (dort
    // OHNE enabled anzutasten, siehe Kommentar dort).
    if (svc === 'forge-liquiditybot' && action === 'stop' && isForkInstance() && isAutoPayEnabled()) {
        setAutoPayEnabled(false);
        recordPremiumMessage(JSON.stringify({ cmd: 'premium-autopay-disabled', reason: 'liquiditybot-stopped' }));
    }

    const db = openDb();
    const result = db.prepare(
        `INSERT INTO tasks (created_at, status, action, target) VALUES (?, 'pending', ?, ?)`
    ).run(Date.now(), action, svc);
    db.close();

    res.json({ taskId: result.lastInsertRowid });
});

// ── GET /api/bots/tasks/:id ───────────────────────────────────────────────────
// WICHTIG: Diese Route muss vor /:svc/:action stehen (sonst matcht "tasks" als :svc)
router.get('/tasks/:id', (req, res) => {
    const db = openDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(req.params.id));
    db.close();

    if (!task) return res.status(404).json({ error: t('api.common.task_not_found') });
    res.json(task);
});

export default router;
