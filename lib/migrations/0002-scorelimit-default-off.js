/**
 * Score Limit für Bestands-Pools auf den neuen Default (aus) setzen (2026-08-21).
 *
 * Der Code-Default in `lib/pool-settings-defaults.js` wurde von `true` auf `false` gedreht.
 * Ein Default-Wechsel wirkt aber nicht auf Pools, die bereits eine gespeicherte
 * `scoreLimit`-Sektion haben — und das sind praktisch alle. Ohne diese Migration liefe eine
 * bestehende Installation dauerhaft mit dem alten Verhalten weiter.
 *
 * Einstufung `safe`: Das Score Limit wird ausgeschaltet. Ein ausgeschalteter Exit-Mechanismus
 * kann keine Position schließen — die Richtung ist also unkritisch. (Umgekehrt wäre sie es
 * nicht, siehe 0003.)
 */
import { IMPACT_SAFE } from './runner.js';
import { readPoolSettings, writePoolSettings } from './_pool-settings.js';

function affected(ctx) {
    return readPoolSettings(ctx.settingsDb).filter(p => p.settings.scoreLimit?.enabled === true);
}

export default {
    id:          '0002-scorelimit-default-off',
    description: 'Score Limit auf den Default „aus" ziehen (Bestands-Pools)',
    impact:      IMPACT_SAFE,

    async plan(ctx) {
        const hits = affected(ctx);
        return {
            pending: hits.length > 0,
            summary: hits.length
                ? `${hits.length} Pool(s) mit eingeschaltetem Score Limit → wird ausgeschaltet`
                : 'kein Pool mit eingeschaltetem Score Limit',
            details:  hits.map(p => p.poolId),
            warnings: [],
        };
    },

    async up(ctx) {
        const hits = affected(ctx);
        for (const p of hits) {
            p.settings.scoreLimit.enabled = false;
            writePoolSettings(ctx.settingsDb, p.poolId, p.settings);
        }
        return { changed: hits.length, summary: `${hits.length} Pool(s) auf Score Limit „aus" gesetzt` };
    },
};
