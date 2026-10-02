/**
 * Status losgelöster Finanzaktionen (CORE#000993, lib/finance-jobs.js)
 *
 *   GET /api/jobs/:id              → { job }  Status + Ergebnis eines Jobs
 *   GET /api/jobs?key=…&ref=…      → { job }  Job zu Schlüssel + Kennung der Oberfläche (clientRef)
 *
 * Der zweite Weg ist für den Wiederanschluss: Bricht die Verbindung während einer Aktion
 * ab (Neustart von forge-settings), kennt die Oberfläche die Job-ID nicht — wohl aber den
 * Schlüssel (`liq:<poolId>`, `lending`, `burn:<flavor>`) und die clientRef, die sie mitgeschickt hat.
 */

import { Router } from 'express';
import { getJob, jobByRef, publicJob } from '../lib/finance-jobs.js';

const router = Router();

router.get('/:id', async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'job_not_found' });
    res.json({ job: publicJob(job) });
});

router.get('/', async (req, res) => {
    const key = String(req.query.key ?? '');
    if (!/^(liq:[\w-]+|lending|burn:[\w-]+)$/.test(key)) return res.status(400).json({ error: 'invalid_key' });
    const job = await jobByRef(key, String(req.query.ref ?? ''));
    res.json({ job: publicJob(job) });
});

export default router;
