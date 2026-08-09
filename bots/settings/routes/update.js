/**
 * /api/update – Status des Auto-Update-Orchestrators (bin/update-check.js)
 *
 * GET /status → { available, latestVersion, latestVersionCode, releaseUrl, notifiedAt }
 *   Liest lediglich die von update-check.js geschriebene local/data/update-status.json
 *   (kein eigener Netzwerk-/GitHub-Zugriff hier). Läuft auf Master UND Fork (geteilte
 *   Datei) — auf dem Master existiert die Datei nie (update-check.js läuft dort nicht,
 *   siehe dessen Kopfkommentar), die Route liefert dann einfach { available: false }.
 *
 * Konsument: html/js/nav.js (Nav-Panel) — lässt die installierte Versionsnummer sanft
 * pulsieren, wenn ein geprüftes, noch nicht eingespieltes Update bereitliegt.
 */

import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { PATHS } from '../../../config/paths.js';

const router = Router();

const UPDATE_STATUS_PATH = path.join(PATHS.data, 'update-status.json');

router.get('/status', (_req, res) => {
    if (!existsSync(UPDATE_STATUS_PATH)) {
        return res.json({ available: false });
    }
    try {
        const status = JSON.parse(readFileSync(UPDATE_STATUS_PATH, 'utf8'));
        res.json({ available: true, ...status });
    } catch (err) {
        res.status(500).json({ available: false, error: err.message });
    }
});

export default router;
