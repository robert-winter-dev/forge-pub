/**
 * /api/timezone – FORGE_TZ der Installation
 *
 * GET  /api/timezone   → { tz, masterLocked }
 * PUT  /api/timezone   → { tz } setzen
 *
 * FORGE_TZ steuert Tagesgrenzen/Anzeige der App (core/config.js), NICHT die
 * Server-Systemzeit (dafür bräuchte es root/timedatectl – bewusst außerhalb
 * dieser Route, siehe bin/setup-lib/packages.sh do_timezone()). Gilt pro
 * Installation, deshalb wie die Sprache auf dem FORGE Master gesperrt
 * (lib/master-lock.js).
 *
 * Wird in jede Komponenten-.env geschrieben (envFile()), zusätzlich in die
 * Crontab-Zeile FORGE_TZ= aktualisiert (einmalige Cron-Skripte laden kein
 * dotenv, siehe bin/setup-lib/services.sh do_cron()) und stößt einen Neustart
 * aller Services an, damit der neue Wert überall greift.
 */

import { Router } from 'express';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { envFile } from '../../../config/paths.js';
import { t } from '../../../lib/i18n.js';
import { parseEnv, serializeEnv } from '../lib/env-file.js';
import { enqueueRestart } from '../lib/task-queue.js';
import { isMasterLocked } from '../lib/master-lock.js';
import { listBots } from '../../../lib/bot-registry.js';

const TZ_COMPONENTS = ['nexus', 'settings', 'liquidity', 'lending', 'premium'];

function updateCrontabTz(tz) {
    let existing = '';
    try {
        existing = execFileSync('crontab', ['-l'], { encoding: 'utf8' });
    } catch { /* keine Crontab bisher – leer starten */ }

    const lines = existing.split('\n').filter(l => l.trim() && !l.startsWith('FORGE_TZ='));
    lines.push(`FORGE_TZ=${tz}`);
    execFileSync('crontab', ['-'], { input: lines.join('\n') + '\n' });
}

const router = Router();

router.get('/', (_req, res) => {
    // Bewusst die tatsächlich aktive OS-Zone (nicht process.env.FORGE_TZ) als
    // Vorbelegung: Node/ICU liest dafür /etc/localtime bzw. die Standard-TZ-
    // Variable, die von unserem eigenen FORGE_TZ unberührt bleibt (Nutzer-
    // Feedback 2026-08-11 – "vorselektiert ist die Zone, die auf der VM aktiv
    // ist", nicht der zuletzt über diese Route gesetzte App-Wert, falls beide
    // je auseinanderlaufen sollten).
    res.json({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, masterLocked: isMasterLocked() });
});

router.put('/', (req, res) => {
    if (isMasterLocked()) {
        return res.status(403).json({ error: t('api.timezone.master_locked') });
    }

    const tz = String(req.body?.tz ?? '').trim();
    if (!tz || !Intl.supportedValuesOf('timeZone').includes(tz)) {
        return res.status(400).json({ error: t('api.timezone.invalid', { tz }) });
    }

    for (const component of TZ_COMPONENTS) {
        const envPath = envFile(component);
        if (!fs.existsSync(envPath)) continue;
        const existing = fs.readFileSync(envPath, 'utf8');
        fs.writeFileSync(envPath, serializeEnv(existing, { FORGE_TZ: tz }), 'utf8');
    }

    try {
        updateCrontabTz(tz);
    } catch (err) {
        // Crontab-Update ist ein Zusatznutzen (nur für standalone Cron-Skripte
        // relevant) – ein Fehlschlag darf das eigentliche FORGE_TZ-Update nicht
        // blockieren, die .env-Dateien sind bereits geschrieben.
        console.error('[timezone] Crontab konnte nicht aktualisiert werden:', err.message);
    }

    for (const [, cfg] of listBots()) {
        enqueueRestart(cfg.service);
    }

    res.json({ ok: true, tz, restarting: true });
});

export default router;
