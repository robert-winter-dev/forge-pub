/**
 * /api/i18n – Sprache der Installation
 *
 * GET  /api/i18n   → { lang, supported }
 * PUT  /api/i18n   → { lang } setzen
 *
 * Die Sprache gilt für die GANZE Installation, nicht pro Nutzer (FORGE.pub ist
 * Single-Tenant – Core/forge-pub/i18n.md, Entscheidung E3). Sie
 * liegt in <DATA_ROOT>/i18n.json und überlebt damit ein Update.
 *
 * Kein Bot-Neustart nötig: setLang() erneuert html/i18n/active.js gleich mit,
 * Bot-Prozesse lesen die Einstellung über lib/i18n.js bei jeder Meldung frisch.
 */

import { Router } from 'express';
import { getLang, setLang, SUPPORTED_LANGS, t } from '../../../lib/i18n.js';
import { isMasterLocked } from '../lib/master-lock.js';

const router = Router();

router.get('/', (_req, res) => {
    res.json({ lang: getLang(), supported: SUPPORTED_LANGS, masterLocked: isMasterLocked() });
});

router.put('/', (req, res) => {
    // Sprache gilt pro Installation – auf dem FORGE Master gesperrt (siehe lib/master-lock.js).
    if (isMasterLocked()) {
        return res.status(403).json({ error: t('api.i18n.master_locked') });
    }
    const lang = String(req.body?.lang ?? '').toLowerCase();
    if (!SUPPORTED_LANGS.includes(lang)) {
        return res.status(400).json({ error: t('api.i18n.unsupported_lang', { lang }) });
    }
    try {
        const result = setLang(lang);
        res.json({ ok: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
