/**
 * /api/keys – Private-Key-Management
 *
 * GET /api/keys/:bot        → Key-Felder: Name, gesetzt?, Preview (erste 6 + letzte 4 Zeichen)
 * PUT /api/keys/:bot        → Key-Feld setzen (Body: { field, value })
 * GET /api/keys/:bot/export → Vollständige Werte (nur für expliziten Export-Request)
 *
 * Hinweis: Liquidity Bot und LendingBot nutzen KEYPAIR_PATH / SOLANA_KEYPAIR_PATH (Pfad zu einer Datei).
 *          Key-Generierung via BIP39/BIP44 ist für den Installer geplant, nicht hier.
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PATHS, envFile } from '../../../config/paths.js';
import { t } from '../../../lib/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Konfiguration: welche Felder gehören zu welchem Bot?
// type: 'inline'  → Wert steht direkt in der .env
// type: 'file'    → Wert ist ein Pfad zu einer Keypair-Datei
//
// envFile() statt hardcodiertem PATHS.<bot>/.env – im Fork liegt die .env
// unter local/env/<bot>.env (siehe config/paths.js), sonst landet man auf
// einer nicht existierenden Datei und jedes Key-Feld erscheint "nicht gesetzt".
const BOT_KEY_CONFIG = {
    liquiditybot: {
        envPath: envFile('liquidity'),
        fields: [
            { field: 'KEYPAIR_PATH', label: 'Keypair-Pfad', type: 'file' },
        ],
    },
    lendingbot: {
        envPath: envFile('lending'),
        fields: [
            { field: 'SOLANA_KEYPAIR_PATH', label: 'Keypair-Pfad', type: 'file' },
        ],
    },
};

function readEnvField(envPath, field) {
    if (!fs.existsSync(envPath)) return null;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith(field + '=')) {
            return trimmed.slice(field.length + 1).trim();
        }
    }
    return null;
}

function writeEnvField(envPath, field, value) {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const lines = content.split('\n');
    let found = false;
    const updated = lines.map(line => {
        if (line.trim().startsWith(field + '=')) {
            found = true;
            return `${field}=${value}`;
        }
        return line;
    });
    if (!found) updated.push(`${field}=${value}`);
    fs.writeFileSync(envPath, updated.join('\n'), 'utf8');
}

function maskValue(val) {
    if (!val || val.length < 10) return null;
    return val.slice(0, 6) + '…' + val.slice(-4);
}

const router = Router();

// ── GET /api/keys/:bot ────────────────────────────────────────────────────────
router.get('/:bot', (req, res) => {
    const cfg = BOT_KEY_CONFIG[req.params.bot];
    if (!cfg) return res.status(404).json({ error: t('api.common.unknown_bot') });

    const result = cfg.fields.map(({ field, label, type }) => {
        const value = readEnvField(cfg.envPath, field);
        return {
            field,
            label,
            type,
            set: !!value,
            preview: value ? maskValue(value) : null,
        };
    });

    res.json(result);
});

// ── PUT /api/keys/:bot ────────────────────────────────────────────────────────
router.put('/:bot', (req, res) => {
    const cfg = BOT_KEY_CONFIG[req.params.bot];
    if (!cfg) return res.status(404).json({ error: t('api.common.unknown_bot') });

    const { field, value } = req.body;
    if (!field || typeof field !== 'string') {
        return res.status(400).json({ error: t('api.common.missing_field', { field: 'field' }) });
    }
    if (!value || typeof value !== 'string') {
        return res.status(400).json({ error: t('api.common.missing_field', { field: 'value' }) });
    }

    const known = cfg.fields.find(f => f.field === field);
    if (!known) {
        return res.status(400).json({ error: t('api.keys.unknown_field', { field }) });
    }

    writeEnvField(cfg.envPath, field, value.trim());
    res.json({ ok: true });
});

// ── GET /api/keys/:bot/export ─────────────────────────────────────────────────
// Gibt die vollständigen Werte zurück (für Export-Funktion).
router.get('/:bot/export', (req, res) => {
    const cfg = BOT_KEY_CONFIG[req.params.bot];
    if (!cfg) return res.status(404).json({ error: t('api.common.unknown_bot') });

    const result = cfg.fields.map(({ field, label, type }) => {
        const value = readEnvField(cfg.envPath, field);
        return { field, label, type, value: value || null };
    });

    res.json(result);
});

export default router;
