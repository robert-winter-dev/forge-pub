/**
 * FORGE Liquidity – Fehler-Streak über Prozess-Grenzen hinweg
 *
 * cleanup.js läuft stündlich als eigener Prozess (Cron) – ein In-Memory-Zähler
 * würde bei jedem Lauf verlorengehen. Diese kleine JSON-Datei hält den Streak
 * persistent, damit transiente RPC-Fehler (z.B. Helius 503) erst nach mehreren
 * aufeinanderfolgenden Fehlschlägen einen Telegram-Alert auslösen, statt bei
 * jedem einzelnen (selbstheilenden) Ausfall.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PATHS } from '../../../config/paths.js';

const STATE_FILE = join(PATHS.liquidityData, 'fail-streak.json');

function load() {
    if (!existsSync(STATE_FILE)) return {};
    try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function save(state) {
    try {
        mkdirSync(dirname(STATE_FILE), { recursive: true });
        writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch { /* State-Datei darf nie den Job killen */ }
}

/**
 * Fehlschlag für `key` verbuchen.
 * @returns {number} aktueller Streak (Anzahl aufeinanderfolgender Fehlschläge)
 */
export function recordFailure(key) {
    const state = load();
    state[key] = (state[key] ?? 0) + 1;
    save(state);
    return state[key];
}

/** Streak für `key` zurücksetzen (nach einem erfolgreichen Lauf). */
export function recordSuccess(key) {
    const state = load();
    if (state[key]) {
        delete state[key];
        save(state);
    }
}
