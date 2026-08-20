/**
 * FORGE.pub – Aggregator health.db → Report für die Systemdaten-Freigabe
 * (Health-Daten gegen kostenlosen Premium-Zugang).
 *
 * Bewusst OHNE Nostr- und OHNE Premium-Pfad: dieses Modul transformiert nur
 * health.db → Report-JSON nach der dort verbindlich festgeschriebenen Feld-Allowlist.
 * Versand, Freischaltung und Zahlungslogik sind eigene, spätere Bauschritte.
 *
 * buildHealthReport() ist eine reine Funktion (Zeilen rein, Report raus, kein I/O) –
 * einzeln mit einfachen Objekten testbar, ohne DB oder systemctl. Der I/O-Teil
 * (health.db lesen, Versions-/OS-Info holen) ist bewusst in einer dünnen Hülle
 * (buildHealthReportForWindow) abgetrennt.
 */

import Database from 'better-sqlite3';
import os from 'os';
import { PATHS } from '../config/paths.js';
import { readVersion, displayVersion } from './version.js';
import { t, getLang, numLocale } from './i18n.js';

// Feste Liste (Festlegung 2026-08-13, „das eine Leck-Risiko"): `detail` ist
// Freitext und darf nie 1:1 raus – jeder Report-Wert kommt aus dieser Liste, alles
// Unbekannte fällt auf 'other'. Allowlist statt Blockliste, siehe dort.
export const DETAIL_CODES = [
    'http_5xx', 'http_4xx', 'exit_nonzero', 'disk_low', 'mem_low',
    'relay_disconnected', 'no_data', 'ok', 'other',
];

// Klassifiziert ausschließlich über status + die in bin/health-check.js fest verdrahteten
// detail-Textformen (z.B. "HTTP 503", "ist zu 96 % belegt", "Getrennt ("). Diese Formen
// sind Teil des Vertrags dieser Checks, keine beliebige Prosa – ändert sich dort ein Text,
// muss dieselbe Änderung hier nachgezogen werden.
export function classifyDetailCode(status, detail) {
    // 'unknown' (Messung ungültig) und 'disabled' (bewusst abgeschaltet) sind beide
    // "keine belastbare Aussage möglich", nur aus verschiedenen Gründen – für die
    // Refactoring-Auswertung reicht ein gemeinsamer Code.
    if (status === 'unknown' || status === 'disabled') return 'no_data';

    const d = detail ?? '';
    if (/HTTP 5\d\d/.test(d)) return 'http_5xx';
    if (/HTTP 4\d\d/.test(d)) return 'http_4xx';

    if (status === 'ok') return 'ok';

    if (/Exit \d+/.test(d))                 return 'exit_nonzero';
    if (/ist zu .*% belegt/.test(d))        return 'disk_low';       // checkHostDisk warn/error
    if (/Arbeitsspeicher verfügbar/.test(d)) return 'mem_low';        // checkHostMemory warn/error
    if (/^Getrennt \(/.test(d))             return 'relay_disconnected'; // checkNostrRelay
    return 'other';
}

function median(nums) {
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * @param {Array<{service_id:string, timestamp_ms:number, status:string, latency_ms:?number,
 *                 detail:?string, mem_bytes:?number, restarts:?number, uptime_sec:?number,
 *                 detail_code:?string}>} rows
 * @param {{version:string, versionCode:number, os:string, windowFrom:string, windowTo:string}} header
 */
export function buildHealthReport(rows, header) {
    // Wartungsjobs (bin/forge-cron.js, service_id "cron:<jobId>") sind keine überwachten
    // Dienste im Sinn der Freigabe (siehe Kopf-Kommentar von config/health-config.js:
    // dessen `service.type`-Liste kennt keinen Cron-Typ) – sie fließen bewusst nicht in
    // den Report ein.
    const byService = new Map();
    for (const row of rows) {
        if (row.service_id.startsWith('cron:')) continue;
        if (!byService.has(row.service_id)) byService.set(row.service_id, []);
        byService.get(row.service_id).push(row);
    }

    const services  = [];
    const processes = [];

    for (const [serviceId, svcRowsUnsorted] of byService) {
        const svcRows = [...svcRowsUnsorted].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
        const last    = svcRows[svcRows.length - 1];

        const statusCounts = { ok: 0, warn: 0, crit: 0, unknown: 0 };
        for (const r of svcRows) {
            if (r.status === 'error')      statusCounts.crit++;
            else if (r.status === 'ok')    statusCounts.ok++;
            else if (r.status === 'warn')  statusCounts.warn++;
            else                           statusCounts.unknown++; // 'unknown' + 'disabled'
        }

        const latencies = svcRows.map(r => r.latency_ms).filter(v => v != null);

        services.push({
            serviceId,
            statusCounts,
            latencyMedian: latencies.length ? median(latencies)   : null,
            latencyMax:    latencies.length ? Math.max(...latencies) : null,
            // detail_code kommt seit der Mehrsprachigkeits-Umstellung direkt aus
            // bin/health-check.js (an der Quelle bestimmt statt aus Text geraten) —
            // classifyDetailCode() bleibt nur Fallback für Altbestand ohne diese
            // Spalte (garantiert deutscher Text, die Regexes bleiben dafür gültig).
            detailCode:    last.detail_code ?? classifyDetailCode(last.status, last.detail),
        });

        // Nur systemd-Dienste (checkSystemd in bin/health-check.js) füllen mem_bytes –
        // alle anderen Zeilen haben dort NULL, memSamples bleibt dann leer und der
        // Dienst taucht in `processes` schlicht nicht auf.
        const memSamples = svcRows.map(r => r.mem_bytes).filter(v => v != null);
        if (memSamples.length) {
            processes.push({
                serviceId,
                memMedian: Math.round(median(memSamples)),
                memMax:    Math.max(...memSamples),
                // Uptime/Neustarts sind Zählerstände, keine Messreihe – der letzte Wert im
                // Fenster ist der aktuelle Stand, ein Median ergäbe hier keinen Sinn.
                uptimeSec: last.uptime_sec ?? null,
                restarts:  last.restarts   ?? null,
            });
        }
    }

    return {
        version:     header.version,
        versionCode: header.versionCode,
        windowFrom:  header.windowFrom,
        windowTo:    header.windowTo,
        os:          header.os,
        services,
        processes,
    };
}

/**
 * I/O-Hülle um buildHealthReport(): liest health.db (readonly) für [windowFromMs,
 * windowToMs) und ergänzt Versions-/OS-Kopf. windowToMs ist exklusiv.
 */
export function buildHealthReportForWindow(windowFromMs, windowToMs, { dbPath = PATHS.healthDb } = {}) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    let rows;
    try {
        const cols = db.prepare('PRAGMA table_info(health_checks)').all().map(c => c.name);
        const hasProcessCols = ['mem_bytes', 'restarts', 'uptime_sec'].every(c => cols.includes(c));
        const hasDetailCode  = cols.includes('detail_code');
        rows = db.prepare(`
            SELECT service_id, timestamp_ms, status, latency_ms, detail
                   ${hasProcessCols ? ', mem_bytes, restarts, uptime_sec' : ', NULL AS mem_bytes, NULL AS restarts, NULL AS uptime_sec'}
                   ${hasDetailCode ? ', detail_code' : ', NULL AS detail_code'}
            FROM health_checks
            WHERE timestamp_ms >= ? AND timestamp_ms < ?
        `).all(windowFromMs, windowToMs);
    } finally {
        db.close();
    }

    const { versionCode } = readVersion();
    return buildHealthReport(rows, {
        version:     displayVersion(),
        versionCode,
        os:          `${os.platform()} ${os.release()}`,
        windowFrom:  new Date(windowFromMs).toISOString(),
        windowTo:    new Date(windowToMs).toISOString(),
    });
}

function fmtUptimeSec(sec, lang) {
    if (sec == null) return t('cli.upd.unknown_word', null, { lang });
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function fmtMemBytes(bytes, lang) {
    if (bytes == null) return t('cli.upd.unknown_word', null, { lang });
    return `${Math.round(bytes / 1024 / 1024)} MB`;
}

// "Uhr" (Uhrzeit-Suffix) ist eine deutsche Spracheigenheit ohne Entsprechung im
// Englischen — kein Katalog-Roundtrip, weil ein leerer EN-Katalogwert von t()
// als "nicht gesetzt" gälte und auf den deutschen Text zurückfiele (E2).
function fmtWindow(windowFrom, windowTo, lang) {
    const loc    = numLocale(lang);
    const fmt    = iso => new Date(iso).toLocaleString(loc, {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin',
    });
    const suffix = lang === 'de' ? ' Uhr' : '';
    return `${fmt(windowFrom)} – ${new Date(windowTo).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })}${suffix}`;
}

/**
 * Wandelt einen Report aus buildHealthReport()/buildHealthReportForWindow() in einen
 * für Menschen lesbaren Text – exakt das, was tatsächlich übertragen wurde, nichts
 * mehr und nichts weniger (Festlegung 2026-08-13: die Freigabe-Seite verspricht
 * Nachvollziehbarkeit, vorher zeigte die Nachricht dazu nur eine generische Zeile).
 *
 * Bewusst Klartext statt Tabellen-Markup: `.mc-detail-text` im Message Center rendert
 * mit `white-space: pre-line` (Zeilenumbrüche bleiben, mehrfache Leerzeichen nicht) –
 * eine spaltenausgerichtete ASCII-Tabelle liefe dort optisch auseinander.
 */
// msgKey-Bausteine statt fertigem deutschen Fließtext (Schritt 5 der
// Mehrsprachigkeit): dieser Report läuft stündlich über core/premium/server.js
// als Message-Center-Eintrag "Monitoring Daten" — vorher kam er auf einer
// EN-Installation trotzdem deutsch an. Service-IDs und detailCode bleiben
// technische Rohwerte (wie Log-Zeilen), keine Prosa, deshalb unübersetzt.
export function formatHealthReportText(report, lang = getLang()) {
    const opts = { lang };
    const lines = [];
    lines.push(t('health_report.title', null, opts));
    lines.push(t('health_report.window', { window: fmtWindow(report.windowFrom, report.windowTo, lang) }, opts));
    lines.push(t('health_report.version_os', { version: report.version, os: report.os }, opts));
    lines.push('');
    lines.push(t('health_report.services_heading', null, opts));
    for (const s of report.services) {
        const latency = s.latencyMedian != null
            ? t('health_report.service_latency', { median: Math.round(s.latencyMedian), max: Math.round(s.latencyMax) }, opts)
            : '';
        lines.push(t('health_report.service_line', {
            service: s.serviceId,
            ok: s.statusCounts.ok, warn: s.statusCounts.warn, crit: s.statusCounts.crit, unknown: s.statusCounts.unknown,
            latency, detail: s.detailCode,
        }, opts));
    }
    lines.push('');
    lines.push(t('health_report.processes_heading', null, opts));
    for (const p of report.processes) {
        lines.push(t('health_report.process_line', {
            service:  p.serviceId,
            mem:      fmtMemBytes(p.memMedian, lang),
            memMax:   fmtMemBytes(p.memMax, lang),
            uptime:   fmtUptimeSec(p.uptimeSec, lang),
            restarts: p.restarts ?? 0,
        }, opts));
    }
    return lines.join('\n');
}
