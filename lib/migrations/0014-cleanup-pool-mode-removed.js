/**
 * Cleanup-Modus „Manuell" (CLEANUP_MODE=pool:<id>) entfällt — LIQ#000937 (2026-09-23).
 *
 * Mit „Bester Pool" (0012, LIQ#000929) war `pool:<id>` der letzte Invest-Modus des
 * stündlichen Cleanups: ein fester Zielpool, in den freies Wallet-Guthaben jede Stunde
 * floss. Er entfällt mit dem Reiter „Manuell". Der Cleanup investiert danach nie mehr, er
 * macht nur noch Kapital-Abgleich, SOL-Topup und Dust-Sweep. Neues Kapital kommt nur über
 * „Einzahlen“; der Bot eröffnet nur noch wieder (Rebalance, bin/bot.js).
 *
 * Diese Migration zieht die Liquidity-.env nach:
 *   - CLEANUP_MODE wird entfernt, egal mit welchem Wert — er steuert nichts mehr
 *     (bots/liquidity/lib/cleanup-mode.js).
 *   - CLEANUP_TREND_GATE wird entfernt: das Trend-Gate galt seit 0012 nur noch für den
 *     festen Pool.
 *   - CLEANUP_MIN_DEPOSIT und CLEANUP_MAX_DEPOSIT werden entfernt. 0012 ließ sie bewusst
 *     stehen, weil bin/bot.js beide beim Öffnen einer Position nutzte. Seit LIQ#000937
 *     eröffnet der Bot nur noch WIEDER (Rebalance, manueller close-and-reopen); neues
 *     Kapital kommt ausschließlich über „Einzahlen“. Für das Wiedereröffnen galt die
 *     Max-Einzahlung nie, und die Min-Einzahlung hätte dort nur bestehendes Kapital im
 *     Wallet festgehalten. bin/bot.js liest beide nicht mehr.
 *   - War ein fester Pool gewählt, zusätzlich CLEANUP_NOTICE_POOL_REMOVED=<poolId>: Die
 *     Migration läuft beim Update VOR dem Dienststart, Nexus ist dann nicht erreichbar.
 *     Den Hinweis im Message Center schickt deshalb der nächste Cleanup-Lauf und entfernt
 *     das Flag danach (bin/cleanup.js, noticeInvestModeRemoved()).
 *
 * 🔒 Einstufung `safe`: Die Umstellung kann kein Kapital bewegen, sie schaltet nur einen
 * automatischen Invest ab. Freies Kapital bleibt im Wallet.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { IMPACT_SAFE } from './runner.js';
import { envFile }     from '../../config/paths.js';

const NOTICE_KEY = 'CLEANUP_NOTICE_POOL_REMOVED';

function readKey(text, key) {
    const m = text.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
    return m ? m[1].trim() : null;
}

function dropKey(text, key) {
    return text.replace(new RegExp(`^${key}\\s*=.*(?:\\r?\\n|$)`, 'm'), '');
}

/**
 * Reine Textumformung — ohne Dateizugriff, damit sie sich an einer Kopie testen lässt
 * (bots/liquidity/bin/test-cleanup-mode.js).
 *
 * @param {string} text  Inhalt der Liquidity-.env
 * @returns {{ text: string, changed: boolean, details: string[], poolId: string|null }}
 */
export function migrateCleanupPoolModeText(text) {
    let out = text;
    const details = [];
    let poolId = null;

    const mode = readKey(out, 'CLEANUP_MODE');
    if (mode != null) {
        if (mode.startsWith('pool:') && mode.length > 'pool:'.length) poolId = mode.slice('pool:'.length);
        out = dropKey(out, 'CLEANUP_MODE');
        details.push(`CLEANUP_MODE=${mode} entfernt`);
    }

    for (const key of ['CLEANUP_TREND_GATE', 'CLEANUP_MIN_DEPOSIT', 'CLEANUP_MAX_DEPOSIT']) {
        const v = readKey(out, key);
        if (v != null) {
            out = dropKey(out, key);
            details.push(`${key}=${v} entfernt`);
        }
    }

    if (poolId && readKey(out, NOTICE_KEY) == null) {
        out = out.replace(/\n?$/, `\n${NOTICE_KEY}=${poolId}\n`);
        details.push('Hinweis im Message Center beim nächsten Cleanup-Lauf vorgemerkt');
    }

    return { text: out, changed: out !== text, details, poolId };
}

export default {
    id:          '0014-cleanup-pool-mode-removed',
    description: 'Cleanup-Modus „Manuell" (pool:<id>) entfällt: CLEANUP_MODE, CLEANUP_TREND_GATE und CLEANUP_MIN/MAX_DEPOSIT entfernen (LIQ#000937)',
    impact:      IMPACT_SAFE,

    async plan() {
        const path = envFile('liquidity');
        if (!existsSync(path)) {
            return { pending: false, summary: 'keine Liquidity-.env — nichts zu tun', details: [], warnings: [] };
        }
        const res = migrateCleanupPoolModeText(readFileSync(path, 'utf8'));
        if (!res.changed) {
            return { pending: false, summary: 'Liquidity-.env bereits ohne Cleanup-Invest-Modus — nichts zu tun', details: [], warnings: [] };
        }
        return {
            pending:  true,
            summary:  'Cleanup „Manuell" entfällt — .env wird bereinigt',
            details:  res.details,
            warnings: res.poolId
                ? [`Der stündliche Invest in ${res.poolId} endet. Freies Kapital bleibt im Wallet; neue Positionen nur noch über „Einzahlen“.`]
                : [],
        };
    },

    async up() {
        const path = envFile('liquidity');
        if (!existsSync(path)) return { summary: 'keine Liquidity-.env — nichts zu tun' };
        const res = migrateCleanupPoolModeText(readFileSync(path, 'utf8'));
        if (!res.changed) return { summary: 'nichts zu tun' };
        writeFileSync(path, res.text, 'utf8');
        return { summary: res.details.join('; ') };
    },
};
