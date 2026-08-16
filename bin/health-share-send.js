#!/usr/bin/env node
/**
 * FORGE public – stündlicher Systemdaten-Report (FORK-ONLY)
 *
 * Sendet einen aggregierten Health-Report an den Master. Bei freigeschalteten
 * Installationen deckt ein Report genau eine Stunde Premium ab, weil `K_H` ohnehin
 * stündlich rotiert.
 *
 * Cron: stündlich (config/cron-jobs.json).
 *
 * ─── Drei Regeln, die hier zusammenkommen ───────────────────────────────────
 *
 * 1. **Der Haken sendet, sonst nichts.** `maySendReports()` verlangt nur den Haken,
 *    nicht zusätzlich die Freischaltung. Ein Widerruf sperrt weiterhin: der Master
 *    verwirft die Reports eines Widerrufenen ohnehin, weiter zu senden wäre
 *    Funkverkehr ins Leere.
 *
 * 2. **Max. 3 Sendeversuche, dann Abbruch für diesen Zyklus.** Senden kostet nichts
 *    (anders als eine Doppelzahlung), deshalb sind Wiederholungen unkritisch — sie
 *    brauchen aber den Master-seitigen Dedup über die Event-ID, damit derselbe Report
 *    nicht mehrfach im Log landet (siehe handleHealthShareReport in
 *    core/premium/server.js).
 *
 * 3. **Keine Straflogik bei Fehlschlag.** Kein Report → kein neuer Key → Premium läuft
 *    nach 60 Minuten von selbst aus. Der Client kann einen eigenen Ausfall nicht von
 *    einem Relay-Abbruch unterscheiden (empirisch 26–69 Abbrüche), eine Bestrafung
 *    träfe deshalb regelmäßig Unbeteiligte.
 */

import { hourIdOf } from '../lib/premium-memo.js';
import { buildHealthReportForWindow } from '../lib/health-report.js';
import { maySendReports, recordReportAttempt, getShareState } from '../lib/health-share-state.js';
import { isForkInstance } from '../lib/premium-identity-context.js';

const PREMIUM_BASE = `http://127.0.0.1:${process.env.PREMIUM_PORT || '3110'}`;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = process.argv.includes('--json');

function out(payload) {
    if (json) console.log(JSON.stringify(payload));
    else console.log(`[health-share] ${payload.message}`);
}

async function main() {
    if (!isForkInstance()) {
        out({ ok: true, skipped: true, message: 'Kein FORGE-public-Fork – nichts zu senden.' });
        return 0;
    }
    if (!maySendReports()) {
        const { phase } = getShareState();
        out({ ok: true, skipped: true, phase, message: `Nicht freigeschaltet (Zustand: ${phase}) – es wird nichts gesendet.` });
        return 0;
    }

    // Das ABGESCHLOSSENE letzte Stundenfenster: die laufende Stunde ist unvollständig,
    // ihr Report wäre je nach Sendezeitpunkt unterschiedlich lang und damit zwischen
    // Installationen nicht vergleichbar — genau die Vergleichbarkeit ist der Zweck.
    const hourMs = 3_600_000;
    const to   = hourIdOf() * hourMs;
    const from = to - hourMs;

    let report;
    try {
        report = buildHealthReportForWindow(from, to);
    } catch (err) {
        recordReportAttempt(`Report konnte nicht erzeugt werden: ${err.message}`);
        out({ ok: false, message: `Report konnte nicht erzeugt werden: ${err.message}` });
        return 1;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const res = await fetch(`${PREMIUM_BASE}/health-share/send`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ report }),
                signal:  AbortSignal.timeout(20000),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                recordReportAttempt(null);
                out({ ok: true, attempt, services: report.services.length, processes: report.processes.length,
                      message: `Report gesendet (Versuch ${attempt}, ${report.services.length} Dienste, ${report.processes.length} Prozesse).` });
                return 0;
            }
            lastError = data.error ?? `HTTP ${res.status}`;
        } catch (err) {
            lastError = err.message;
        }
        if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }

    // Abbruch für diesen Zyklus — bewusst OHNE Eskalation: der nächste Stundenlauf
    // versucht es ohnehin erneut, und ein Relay-Ausfall ist kein Fehler des Nutzers.
    recordReportAttempt(lastError);
    out({ ok: false, attempts: MAX_ATTEMPTS, error: lastError,
          message: `Report nach ${MAX_ATTEMPTS} Versuchen nicht zugestellt (${lastError}). Nächster Versuch zur nächsten Stunde.` });
    return 1;
}

process.exit(await main());
