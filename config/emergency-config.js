/**
 * emergency-config.js – Bot-Registry für das Emergency-Exit-Script.
 *
 * Neue Chain ergänzen: Neuen Key unter BOTS anlegen.
 * Neuen Bot ergänzen: Eintrag unter der entsprechenden Chain.
 */

import { fileURLToPath } from 'url';
import path              from 'path';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
export const FORGE_ROOT = path.resolve(__dirname, '..');

/**
 * Bot-Registry: chain → botId → Konfiguration
 *
 * name:       Anzeigename
 * service:    systemd-Service-Name (forge-xxx)
 * moduleDir:  Arbeitsverzeichnis des Bots (für korrekte node_modules-Auflösung)
 * module:     Absoluter Pfad zum bot-spezifischen emergency-withdraw.js
 * hasPauseFlag: true wenn der Bot bot_paused in DB schreiben kann
 */
export const BOTS = {
    solana: {
        liquiditybot: {
            name:         'Liquidity Bot',
            service:      'forge-liquiditybot',
            moduleDir:    path.join(FORGE_ROOT, 'bots', 'liquidity'),
            module:       path.join(FORGE_ROOT, 'bots/liquidity/lib/emergency-withdraw.js'),
            hasPauseFlag: false, // kein kv_config in Liquidity Bot – nur systemctl stop
        },
        lendingbot: {
            name:         'LendingBot',
            service:      'forge-lendingbot',
            moduleDir:    path.join(FORGE_ROOT, 'bots', 'lending'),
            module:       path.join(FORGE_ROOT, 'bots/lending/lib/emergency-withdraw.js'),
            hasPauseFlag: true,
        },
    },

    // base: { ... }  → Phase 2: Multi-Chain-Architektur (Ticket #9)
};

/** Alle bekannten Chain-Keys */
export const CHAINS = Object.keys(BOTS);
