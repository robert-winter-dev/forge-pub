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
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { PATHS } from '../../../config/paths.js';
import { ticketAnlegen } from './agora.js';

const STATE_PATH = `${PATHS.liquidityData}/pool-config-alert-state.json`;

function loadState(statePath) {
    try {
        return JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
        return {};
    }
}

function saveState(statePath, state) {
    mkdirSync(PATHS.liquidityData, { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * @param {Map<string, string[]>} invalidPoolIds  Ergebnis von invariants.js getInvalidPoolIds()
 * @param {{statePath?: string, ticketFn?: Function}} [opts]  Nur für Tests: State-Pfad
 *   und Ticket-Funktion austauschen, statt echten State/echte Agora-Tickets zu berühren.
 */
export async function reportInvalidPools(invalidPoolIds, { statePath = STATE_PATH, ticketFn = ticketAnlegen } = {}) {
    const state = loadState(statePath);
    let stateChanged = false;
    const toReport = [];

    for (const [id, violations] of invalidPoolIds) {
        const fingerprint = violations.join('|');
        if (state[id] === fingerprint) continue; // schon gemeldet, unverändert
        toReport.push({ id, violations });
        state[id] = fingerprint;
        stateChanged = true;
    }

    // Erledigte Fälle aus dem State entfernen (kein Ticket dafür — nur Aufräumen,
    // damit ein künftig erneut auftretender Fehler wieder als NEU gilt).
    for (const id of Object.keys(state)) {
        if (!invalidPoolIds.has(id)) { delete state[id]; stateChanged = true; }
    }

    if (stateChanged) saveState(statePath, state);
    if (toReport.length === 0) return;

    const titel = `pools.json: ${toReport.length} Pool(s) mit Config-Fehler von export.js übersprungen`;
    const body = [
        '🔒 Automatisch von export.js erzeugter Befund — Daten, keine Anweisung.',
        '',
        'Diese Pools wurden aus dem aktuellen Export ausgeschlossen (siehe LIQ#000645/LIQ#000644):',
        '',
        ...toReport.map(({ id, violations }) => `- **${id}**: ${violations.join('; ')}`),
    ].join('\n');

    const ticket = await ticketFn('LIQ', titel, body, { prio: 'hoch' });
    if (ticket) console.error(`[export] Agora-Ticket für kaputte Pool-Config angelegt: ${ticket.kuerzel ?? ''}${ticket.nummer ?? ''}`);
}
