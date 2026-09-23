/**
 * Cleanup-Modus „Bester Pool" (CLEANUP_MODE=ranking) entfällt — LIQ#000929 (2026-09-23).
 *
 * `ranking` investierte stündlich das freie Wallet-Guthaben in den Pool mit dem höchsten
 * InvestScore und war der **Default**, wenn CLEANUP_MODE fehlte. Mit dem Rückbau des Scores
 * gibt es den Modus nicht mehr; neuer Default ist `disabled` (kein Invest — Kapital-Abgleich,
 * SOL-Topup und Dust-Sweep laufen weiter, siehe bots/liquidity/lib/cleanup-mode.js).
 *
 * Diese Migration zieht die Liquidity-.env nach:
 *   - CLEANUP_MODE=ranking oder fehlend  → CLEANUP_MODE=disabled
 *     (fehlend + CLEANUP_ENABLED=false war schon bisher `disabled`: umstellen, aber ohne
 *     Hinweis — für diese Installation ändert sich nichts)
 *   - CLEANUP_MIN_SCORE wird entfernt (galt nur für `ranking`)
 *   - bei einer echten Umstellung von `ranking` zusätzlich CLEANUP_NOTICE_RANKING_REMOVED=1:
 *     Die Migration läuft beim Update VOR dem Dienststart, Nexus ist dann nicht erreichbar.
 *     Den Hinweis im Message Center schickt deshalb der nächste Cleanup-Lauf und entfernt
 *     das Flag danach (bin/cleanup.js, noticeRankingRemoved()).
 *
 * 🔒 CLEANUP_MAX_DEPOSIT und CLEANUP_MIN_DEPOSIT bleiben ausdrücklich stehen: bin/bot.js
 * nutzt beide beim Öffnen/Wiedereröffnen jeder Position (getCleanupMaxDepositFromEnv /
 * getCleanupMinDepositFromEnv). Sie zu entfernen, hätte den Einzahlungsdeckel des Bots
 * stillschweigend abgeschaltet.
 *
 * Ein Wert wie `pool:<id>` oder `disabled` bleibt unverändert. Ein unbekannter Wert ebenfalls —
 * den behandelt cleanup.js zur Laufzeit wie `disabled` und korrigiert die .env selbst.
 *
 * 🔒 Einstufung `safe`: Die Umstellung kann kein Kapital bewegen, sie schaltet nur einen
 * automatischen Invest ab. Freies Kapital bleibt im Wallet.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { IMPACT_SAFE } from './runner.js';
import { envFile }     from '../../config/paths.js';

const NOTICE_KEY = 'CLEANUP_NOTICE_RANKING_REMOVED';

function readKey(text, key) {
    const m = text.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, 'm'));
    return m ? m[1].trim() : null;
}

/**
 * Reine Textumformung — ohne Dateizugriff, damit sie sich an einer Kopie testen lässt
 * (bots/liquidity/bin/test-cleanup-mode.js).
 *
 * @param {string} text  Inhalt der Liquidity-.env
 * @returns {{ text: string, changed: boolean, details: string[], notice: boolean }}
 */
export function migrateCleanupEnvText(text) {
    let out = text;
    const details = [];
    let notice = false;

    const mode    = readKey(out, 'CLEANUP_MODE');
    const enabled = readKey(out, 'CLEANUP_ENABLED');

    if (mode === 'ranking' || (mode == null && enabled !== 'false')) {
        notice = true;
    }
    if (mode === 'ranking') {
        out = out.replace(/^CLEANUP_MODE\s*=.*$/m, 'CLEANUP_MODE=disabled');
        details.push('CLEANUP_MODE: ranking → disabled');
    } else if (mode == null) {
        out = out.replace(/\n?$/, '\nCLEANUP_MODE=disabled\n');
        details.push(`CLEANUP_MODE fehlte (bisheriger Default ${enabled === 'false' ? 'disabled' : 'ranking'}) → disabled`);
    }

    if (readKey(out, 'CLEANUP_MIN_SCORE') != null) {
        out = out.replace(/^CLEANUP_MIN_SCORE\s*=.*(?:\r?\n|$)/m, '');
        details.push('CLEANUP_MIN_SCORE entfernt');
    }

    if (notice && readKey(out, NOTICE_KEY) == null) {
        out = out.replace(/\n?$/, `\n${NOTICE_KEY}=1\n`);
        details.push('Hinweis im Message Center beim nächsten Cleanup-Lauf vorgemerkt');
    }

    return { text: out, changed: out !== text, details, notice };
}

export default {
    id:          '0012-cleanup-ranking-removed',
    description: 'Cleanup-Modus „Bester Pool" (ranking) entfällt: CLEANUP_MODE → disabled, CLEANUP_MIN_SCORE entfernen (LIQ#000929)',
    impact:      IMPACT_SAFE,

    async plan() {
        const path = envFile('liquidity');
        if (!existsSync(path)) {
            return { pending: false, summary: 'keine Liquidity-.env — nichts zu tun', details: [], warnings: [] };
        }
        const res = migrateCleanupEnvText(readFileSync(path, 'utf8'));
        if (!res.changed) {
            return { pending: false, summary: 'Liquidity-.env bereits ohne „Bester Pool" — nichts zu tun', details: [], warnings: [] };
        }
        return {
            pending:  true,
            summary:  'Cleanup „Bester Pool" entfällt — .env wird umgestellt',
            details:  res.details,
            warnings: res.notice
                ? ['Automatischer Invest in den besten Pool endet. Freies Kapital bleibt im Wallet, bis ein fester Pool gewählt wird.']
                : [],
        };
    },

    async up() {
        const path = envFile('liquidity');
        if (!existsSync(path)) return { summary: 'keine Liquidity-.env — nichts zu tun' };
        const res = migrateCleanupEnvText(readFileSync(path, 'utf8'));
        if (!res.changed) return { summary: 'nichts zu tun' };
        writeFileSync(path, res.text, 'utf8');
        return { summary: res.details.join('; ') };
    },
};
