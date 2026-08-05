// ══════════════════════════════════════════════════════════════════════════════
// FORGE – Zentrale Cron-Registry
// ══════════════════════════════════════════════════════════════════════════════
// EINE Quelle der Wahrheit für alle zeitgesteuerten Jobs. Daten liegen in
// config/cron-jobs.json, dieses Modul ist der Node-seitige Zugriff + der
// Fälligkeits-Matcher. Konsument: bin/forge-cron.js (ein crontab-Eintrag ruft
// den Runner jede Minute auf; der Runner fragt hier, welche Jobs jetzt fällig sind).
//
// import { loadJobs, listJobs, getJob, cronMatches } from '<relativ>/lib/cron-registry.js';
//
// Unterstützte Cron-Syntax (5 Felder: min hour dom month dow):
//   *            – jeder Wert
//   */N          – jeder N-te Wert (ab Feld-Minimum)
//   N            – fester Wert
//   a-b          – Bereich (inklusive)
//   a-b/N        – Bereich mit Schrittweite
//   a,b,c        – Kommaliste (jedes Element darf obige Formen haben)
// dow: 0 und 7 sind beide Sonntag. Standard-Cron-Regel für dom+dow:
//   Sind BEIDE eingeschränkt (kein *), matcht der Job, wenn dom ODER dow passt;
//   ist mindestens eines *, gilt die normale UND-Verknüpfung aller Felder.
// Bewusst NICHT unterstützt: Namen (JAN/MON), @-Shortcuts, Sekunden-Feld.
// ══════════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.resolve(__dirname, '..', 'config', 'cron-jobs.json');

/** Liest config/cron-jobs.json frisch von der Platte (kein Cache – Änderungen sofort wirksam). */
export function loadJobs() {
    const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    if (!Array.isArray(raw.jobs)) {
        throw new Error('cron-registry: config/cron-jobs.json hat kein "jobs"-Array');
    }
    return raw.jobs;
}

/** Alle Jobs als Array (inkl. deaktivierte). */
export function listJobs() {
    return loadJobs();
}

/** Liefert einen Job per id (wirft bei unbekannter id). */
export function getJob(id) {
    const job = loadJobs().find(j => j.id === id);
    if (!job) {
        throw new Error(`cron-registry: unbekannte Job-id "${id}" (config/cron-jobs.json)`);
    }
    return job;
}

// ─── Cron-Matcher ─────────────────────────────────────────────────────────────

/**
 * Parst EIN Cron-Feld zu einem Set erlaubter Ganzzahlen.
 * Rückgabe null bedeutet "*" (jeder Wert) – wichtig zur Unterscheidung
 * eingeschränkt/uneingeschränkt für die dom/dow-Sonderregel.
 */
function parseField(spec, min, max) {
    spec = String(spec).trim();
    if (spec === '*') return null;

    const values = new Set();
    for (const part of spec.split(',')) {
        const token = part.trim();
        const stepMatch = token.match(/^(\*|\d+-\d+|\d+)(?:\/(\d+))?$/);
        if (!stepMatch) {
            throw new Error(`cron-registry: ungültiges Cron-Feld "${spec}" (Teil "${token}")`);
        }
        const base = stepMatch[1];
        const step = stepMatch[2] ? parseInt(stepMatch[2], 10) : 1;
        if (step < 1) throw new Error(`cron-registry: Schrittweite < 1 in "${spec}"`);

        let lo, hi;
        if (base === '*') {
            lo = min; hi = max;
        } else if (base.includes('-')) {
            const [a, b] = base.split('-').map(n => parseInt(n, 10));
            lo = a; hi = b;
        } else {
            lo = hi = parseInt(base, 10);
        }
        if (lo > hi) throw new Error(`cron-registry: Bereich rückwärts in "${spec}" (${lo}-${hi})`);

        for (let v = lo; v <= hi; v += step) {
            if (v < min || v > max) {
                throw new Error(`cron-registry: Wert ${v} außerhalb [${min},${max}] in "${spec}"`);
            }
            values.add(v);
        }
    }
    return values;
}

/** true, wenn value zum geparsten Feld passt (null = "*" = immer). */
function fieldMatches(set, value) {
    return set === null || set.has(value);
}

/**
 * Prüft, ob ein 5-Feld-Cron-Ausdruck zum gegebenen Zeitpunkt fällig ist.
 * @param {string} schedule – "min hour dom month dow"
 * @param {Date}   date     – Zeitpunkt (lokale Zeit des Hosts – Cron läuft in Host-TZ)
 * @returns {boolean}
 */
export function cronMatches(schedule, date) {
    const fields = String(schedule).trim().split(/\s+/);
    if (fields.length !== 5) {
        throw new Error(`cron-registry: Cron-Ausdruck braucht 5 Felder, hat ${fields.length}: "${schedule}"`);
    }
    const [minF, hourF, domF, monF, dowF] = fields;

    const minSet   = parseField(minF,  0, 59);
    const hourSet  = parseField(hourF, 0, 23);
    const domSet   = parseField(domF,  1, 31);
    const monSet   = parseField(monF,  1, 12);
    const dowSet   = parseField(dowF,  0, 7);

    // dow: 7 == Sonntag == 0. Set normalisieren, damit getDay() (0-6) matcht.
    if (dowSet && dowSet.has(7)) dowSet.add(0);

    const minute = date.getMinutes();
    const hour   = date.getHours();
    const dom    = date.getDate();
    const month  = date.getMonth() + 1; // JS: 0-11
    const dow    = date.getDay();       // JS: 0 (So) – 6 (Sa)

    if (!fieldMatches(minSet, minute))  return false;
    if (!fieldMatches(hourSet, hour))   return false;
    if (!fieldMatches(monSet, month))   return false;

    // Standard-Cron-Sonderregel für dom + dow:
    const domRestricted = domSet !== null;
    const dowRestricted = dowSet !== null;
    const domHit = fieldMatches(domSet, dom);
    const dowHit = fieldMatches(dowSet, dow);

    if (domRestricted && dowRestricted) {
        return domHit || dowHit;   // ODER, wenn beide eingeschränkt
    }
    return domHit && dowHit;        // sonst normale UND-Verknüpfung (mit * = immer)
}

export default { loadJobs, listJobs, getJob, cronMatches };
