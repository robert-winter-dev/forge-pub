// ══════════════════════════════════════════════════════════════════════════════
// FORGE – Zentrale Bot-Registry (Ticket #0266 Teil 2)
// ══════════════════════════════════════════════════════════════════════════════
// EINE Quelle der Wahrheit für Service-Identität (displayName, systemd-Service,
// Arbeitsverzeichnis, DB-Datei, PID-Datei) je Bot. Daten liegen in config/bots.json,
// dieses Modul ist der Node-seitige Zugriff darauf (bash-seitig: bin/svc via jq).
//
// import { getBotConfig, listBots } from '<relativ>/lib/bot-registry.js';
// const { service, dir } = getBotConfig('liquidity');
// ══════════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.resolve(__dirname, '..', 'config', 'bots.json');

const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
const { _comment, ...BOTS } = raw;

/** Liefert die Konfiguration eines Bots/Service (wirft bei unbekannter botId). */
export function getBotConfig(botId) {
    const entry = BOTS[botId];
    if (!entry) {
        throw new Error(`bot-registry: unbekannte botId "${botId}" (config/bots.json)`);
    }
    return entry;
}

/** Liefert alle registrierten Bots als [botId, config][]-Paare. */
export function listBots() {
    return Object.entries(BOTS);
}

export default { getBotConfig, listBots };
