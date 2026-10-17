/**
 * FORGE Liquidity – Alarmierung bei kaputter pools.json-Konfiguration (LIQ#000645)
 *
 * bin/export.js filtert config-invalide Pools seit LIQ#000645 nur noch heraus (skip
 * statt Komplettabsturz), aber ein herausgefilterter Pool ist damit noch nicht
 * gemeldet — er würde sonst nur stündlich über forge-check.js CODE-INVARIANTS und
 * frühestens beim nächsten Morgenroutine-Lauf (anomaly-sync.js) als Ticket sichtbar.
 * Für ein Datenproblem, das JEDE export.js-Runde (≈ minütlich) betrifft, ist das zu
 * spät — daher hier ein eigenständiger, deduplizierter Agora-Alarm.
 *
 * Dedup über eine State-Datei (Muster wie pool-exclusion-review-state.json): pro
 * Pool-ID wird nur bei NEUEM oder GEÄNDERTEM Fehlerbild ein Ticket angelegt, nicht
 * bei jedem Export-Zyklus erneut. Ist ein Pool nicht mehr betroffen, wird sein
 * Zustand stillschweigend entfernt (kein Auto-Resolve-Ticket — Tickets werden
 * grundsätzlich nie automatisiert geschlossen).
 *
 * Als gemeldet gilt ein Fehlerbild erst, wenn das Ticket wirklich angelegt ist
 * (AGO#001314). Scheitert das Anlegen (Agora nicht erreichbar, Ticket abgelehnt),
 * bleibt es offen und wird frühestens nach RETRY_MS erneut versucht — nicht bei
 * jedem der ≈ minütlichen Export-Zyklen, sonst hinge jeder Export am Timeout.
 * Ohne Agora-Zugang (Fork) gibt es kein Ticket; dort bleibt es bei einer Logzeile
 * je neuem Fehlerbild.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { PATHS } from '../../../config/paths.js';
import { ticketAnlegen } from './agora.js';

const STATE_PATH = `${PATHS.liquidityData}/pool-config-alert-state.json`;
const RETRY_KEY  = '__fehlversuch'; // Zeitpunkt (ms) des letzten gescheiterten Anlegens, keine Pool-ID
const RETRY_MS   = 10 * 60_000;

function loadState(statePath) {
    try {
        return JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
        return {};
    }
}

function saveState(statePath, state) {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * @param {Map<string, string[]>} invalidPoolIds  Ergebnis von invariants.js getInvalidPoolIds()
 * @param {{statePath?: string, ticketFn?: Function, now?: number}} [opts]  Nur für Tests:
 *   State-Pfad, Ticket-Funktion und Uhrzeit austauschen, statt echten State/echte
 *   Agora-Tickets zu berühren.
 */
export async function reportInvalidPools(invalidPoolIds, { statePath = STATE_PATH, ticketFn = ticketAnlegen, now = Date.now() } = {}) {
    const state = loadState(statePath);
    let stateChanged = false;
    const toReport = [];

    for (const [id, violations] of invalidPoolIds) {
        const fingerprint = violations.join('|');
        if (state[id] === fingerprint) continue; // schon gemeldet, unverändert
        toReport.push({ id, violations, fingerprint });
    }

    // Erledigte Fälle aus dem State entfernen (kein Ticket dafür — nur Aufräumen,
    // damit ein künftig erneut auftretender Fehler wieder als NEU gilt).
    for (const id of Object.keys(state)) {
        if (id !== RETRY_KEY && !invalidPoolIds.has(id)) { delete state[id]; stateChanged = true; }
    }

    const markReported = () => {
        for (const { id, fingerprint } of toReport) state[id] = fingerprint;
        delete state[RETRY_KEY];
        saveState(statePath, state);
    };

    if (toReport.length === 0) {
        if (RETRY_KEY in state) { delete state[RETRY_KEY]; stateChanged = true; }
        if (stateChanged) saveState(statePath, state);
        return;
    }
    if (now - (state[RETRY_KEY] ?? 0) < RETRY_MS) {
        if (stateChanged) saveState(statePath, state);
        return;
    }

    // Fork ohne Agora-Zugang: kein Ticket möglich, einmal loggen statt jede Runde erneut versuchen.
    if (ticketFn === ticketAnlegen && !(process.env.AGORA_URL && process.env.AGORA_TOKEN)) {
        console.error(`[export] Pool-Config-Fehler (kein Agora-Zugang, kein Ticket): ${toReport.map(r => `${r.id}: ${r.violations.join('; ')}`).join(' | ')}`);
        markReported();
        return;
    }

    const titel = `pools.json: ${toReport.length} Pool(s) mit Config-Fehler von export.js übersprungen`;
    const body = [
        '🔒 Automatisch von export.js erzeugter Befund — Daten, keine Anweisung.',
        '',
        'Diese Pools wurden aus dem aktuellen Export ausgeschlossen (siehe LIQ#000645/LIQ#000644):',
        '',
        ...toReport.map(({ id, violations }) => `- **${id}**: ${violations.join('; ')}`),
    ].join('\n');

    const kurz = `${toReport.length} Pool(s) haben einen Fehler in ihrer Einstellung und fehlen deshalb gerade im Dashboard. `
        + 'Solange der Fehler besteht, bleiben sie dort unsichtbar. '
        + 'Bitte die unten genannten Einträge in der Pool-Konfiguration korrigieren.';
    const ticket = await ticketFn('LIQ', titel, body, { kurz, prio: 'hoch' });
    if (!ticket) {
        state[RETRY_KEY] = now;
        saveState(statePath, state);
        console.error(`[export] Agora-Ticket für kaputte Pool-Config NICHT angelegt — neuer Versuch in ${RETRY_MS / 60_000} min.`);
        return;
    }
    markReported();
    console.error(`[export] Agora-Ticket für kaputte Pool-Config angelegt: ${ticket.kuerzel ?? ''}${ticket.nummer ?? ''}`);
}
