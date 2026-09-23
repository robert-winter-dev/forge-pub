/**
 * /api/config – Bot-Konfiguration (ohne Private Keys)
 *
 * GET /api/config/:bot   → .env lesen (sensitive Keys ausgeblendet)
 * PUT /api/config/:bot   → .env aktualisieren (sensitive Keys gesperrt)
 *
 * Private Keys werden über /api/keys verwaltet, nicht hier.
 */

import { Router } from 'express';
import fs from 'fs';
import { envFile } from '../../../config/paths.js';
import { t } from '../../../lib/i18n.js';
import { parseEnv, serializeEnv } from '../lib/env-file.js';
import { enqueueRestart } from '../lib/task-queue.js';

// .env-Pfade über envFile() (move-agnostisch + fork-aware: im Fork liegt die
// .env unter local/env/<bot>.env statt neben dem Dienst, siehe config/paths.js).
const BOT_CONFIGS = {
    lendingbot:   envFile('lending'),
    liquiditybot: envFile('liquidity'),
    nexus:        envFile('nexus'),
};

// Bot → systemd-Service (für Auto-Restart nach Config-Änderung)
const BOT_SERVICES = {
    lendingbot: 'forge-lendingbot',
    liquiditybot: 'forge-liquiditybot',
};

// Keys die ohne Bot-Neustart wirken (werden pro Zyklus frisch gelesen).
const NO_RESTART_KEYS = new Set([
    // Liquidity – nur von cleanup.js / Subprozessen gelesen
    'CLEANUP_MODE',
    'CLEANUP_MAX_DEPOSIT',
    'CLEANUP_MIN_DEPOSIT',
    'CLEANUP_ENABLED',
    'CLEANUP_DUST_ENABLED',
    'CLEANUP_DUST_MIN_USDC',
    'CLEANUP_DUST_MAX_USDC',
    'CLEANUP_TREND_GATE',
    // LendingBot – Auto-Deploy: werden per loadAutoDeployConfig() pro Zyklus frisch gelesen
    'AUTO_DEPLOY_MODE',
    'AUTO_DEPLOY_MIN_DEPOSIT',
    'AUTO_DEPLOY_MAX_DEPOSIT',
    'APY_THRESHOLD_PERCENT',
    'FIXED_APY_THRESHOLD_PERCENT',
    'FIXED_AUTO_DEPLOY_MIN_DEPOSIT',
    'FIXED_AUTO_DEPLOY_MAX_DEPOSIT',
]);

// Diese Felder nie über /api/config ausliefern oder schreiben
const SENSITIVE_KEYS = new Set([
    'PRIVATE_KEY',
    'KEYPAIR_PATH',
    'SOLANA_KEYPAIR_PATH',
    'TELEGRAM_BOT_TOKEN',
    'RPC_ENDPOINT',
    'HELIUS_API_KEY',
    'BIRDEYE_API_KEY',
    'JUPITER_API_KEY',
]);

const router = Router();

// ── GET /api/config/:bot ──────────────────────────────────────────────────────
router.get('/:bot', (req, res) => {
    const envPath = BOT_CONFIGS[req.params.bot];
    if (!envPath) return res.status(404).json({ error: t('api.common.unknown_bot') });
    if (!fs.existsSync(envPath)) return res.status(404).json({ error: t('api.common.env_not_found') });

    const raw = fs.readFileSync(envPath, 'utf8');
    const parsed = parseEnv(raw);

    // Sensitive Keys entfernen
    for (const k of SENSITIVE_KEYS) delete parsed[k];
    // Alle Keys die "KEY", "SECRET", "TOKEN", "PASSWORD" enthalten vorsichtshalber entfernen
    for (const k of Object.keys(parsed)) {
        if (/KEY|SECRET|TOKEN|PASSWORD/i.test(k)) delete parsed[k];
    }

    res.json(parsed);
});

// ── PUT /api/config/:bot ──────────────────────────────────────────────────────
router.put('/:bot', (req, res) => {
    const envPath = BOT_CONFIGS[req.params.bot];
    if (!envPath) return res.status(404).json({ error: t('api.common.unknown_bot') });
    if (!fs.existsSync(envPath)) return res.status(404).json({ error: t('api.common.env_not_found') });

    const updates = req.body;
    if (typeof updates !== 'object' || Array.isArray(updates)) {
        return res.status(400).json({ error: t('api.common.body_object') });
    }

    // Sicherstellen dass keine sensitive Keys überschrieben werden
    for (const k of Object.keys(updates)) {
        if (SENSITIVE_KEYS.has(k) || /KEY|SECRET|TOKEN|PASSWORD/i.test(k)) {
            return res.status(400).json({ error: t('api.config.field_forbidden', { field: k }) });
        }
    }

    const existing = fs.readFileSync(envPath, 'utf8');
    const newContent = serializeEnv(existing, updates);
    fs.writeFileSync(envPath, newContent, 'utf8');

    // Bot neu starten — aber nur wenn sich mindestens ein Key ändert,
    // der vom laufenden Bot-Prozess ausgewertet wird.
    const service = BOT_SERVICES[req.params.bot];
    const needsRestart = service && Object.keys(updates).some(k => !NO_RESTART_KEYS.has(k));
    if (needsRestart) enqueueRestart(service);

    res.json({ ok: true, restarting: !!service });
});

export default router;
