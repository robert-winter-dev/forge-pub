/**
 * TVL-Schutz Stufe 1 auf 100 % (Voll-Exit) ziehen (2026-08-15).
 *
 * Befund: Die meisten Pools hatten `level1.withdrawPct = 50` bei ausgeschalteter Stufe 2.
 * Der TVL-Schutz zog dort im Ernstfall die Hälfte ab — und danach nichts mehr, weil jede
 * Stufe pro Position genau einmal feuert und die zweite Stufe aus war. Einen vollständigen
 * Ausstieg über den TVL-Schutz gab es bei diesen Pools also gar nicht.
 *
 * 🔒 Einstufung `financial`: Liegt ein betroffener Pool mit offener Position bereits unter
 * seiner Schwelle, steigt der nächste Bot-Zyklus danach **voll aus** statt einen Teil
 * abzuziehen. Die Vorschau weist solche Pools einzeln aus.
 *
 * Übersprungen werden Pools mit aktiver Stufe 2: dort gilt „withdrawPct1 + withdrawPct2 = 100",
 * eine Stufe 1 auf 100 % würde diese Regel verletzen.
 */
import { readFileSync } from 'node:fs';

import { IMPACT_FINANCIAL } from './runner.js';
import { PATHS } from '../../config/paths.js';
import { readPoolSettings, writePoolSettings, openPositionPools, latestTvl } from './_pool-settings.js';

function analyse(ctx) {
    let pools = [];
    try { pools = JSON.parse(readFileSync(PATHS.liquidityPools, 'utf-8')); } catch { /* ohne pools.json nur ohne Schwellen-Vorwarnung */ }

    const open     = openPositionPools(ctx.liquidityDb);
    const touched  = [];
    const skipped  = [];
    const warnings = [];

    for (const p of readPoolSettings(ctx.settingsDb)) {
        const tp = p.settings.tvlProtection;
        if (tp?.level1?.enabled !== true) continue;
        if (!(Number(tp.level1.withdrawPct) < 100)) continue;

        if (tp.level2?.enabled === true) {
            skipped.push(`${p.poolId} (Stufe 2 aktiv — Summe muss 100 % ergeben)`);
            continue;
        }

        const cfg       = pools.find(x => x.id === p.poolId) ?? {};
        const threshold = Number(tp.level1.thresholdUsd) || cfg.tvlWarnThreshold || 0;
        const tvl       = latestTvl(ctx.liquidityDb, p.poolId);
        if (open.has(p.poolId) && threshold > 0 && tvl > 0 && tvl < threshold) {
            warnings.push(`${p.poolId}: TVL ${(tvl / 1e6).toFixed(2)}M unter Schwelle ${(threshold / 1e6).toFixed(2)}M → steigt danach VOLL aus`);
        }
        touched.push(p);
    }
    return { touched, skipped, warnings };
}

export default {
    id:          '0003-tvl-level1-full-exit',
    description: 'TVL-Schutz Stufe 1 auf 100 % (Voll-Exit) ziehen',
    impact:      IMPACT_FINANCIAL,

    async plan(ctx) {
        const { touched, skipped, warnings } = analyse(ctx);
        return {
            pending: touched.length > 0,
            summary: touched.length
                ? `${touched.length} Pool(s) mit Stufe 1 unter 100 % → Voll-Exit`
                : 'keine Stufe 1 unter 100 %',
            details:  [...touched.map(p => p.poolId), ...skipped.map(s => `übersprungen: ${s}`)],
            warnings,
        };
    },

    async up(ctx) {
        const { touched } = analyse(ctx);
        for (const p of touched) {
            p.settings.tvlProtection.level1.withdrawPct = 100;
            writePoolSettings(ctx.settingsDb, p.poolId, p.settings);
        }
        return { changed: touched.length, summary: `${touched.length} Pool(s) auf Stufe 1 = 100 % gesetzt` };
    },
};
