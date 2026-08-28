/**
 * Drawdown-Schwellen aus den Pool-Typ-Vorgaben nachziehen (2026-08-22).
 *
 * Der Tab „Pool Typen" schreibt seine Schwellen per einmaligem Bulk-Write in die
 * `pool_settings` der zu diesem Zeitpunkt vorhandenen Pools. Jeder später aufgenommene Pool
 * erbte nichts und lief im Bot auf dem globalen Fallback von 10 % ohne zweite Stufe — während
 * die Oberfläche die Typ-Werte als Standard auswies. Anzeige und tatsächliches Verhalten
 * fielen damit auseinander.
 *
 * Für neue Pools verhindert `ensureTrailingStopDefaults()` das seit 2026-08-22. Diese
 * Migration korrigiert die bereits entstandenen Fälle.
 *
 * 🔒 Einstufung `financial`: Eine engere Schwelle kann im nächsten Bot-Zyklus einen Exit
 * auslösen. Genau das ist am 2026-08-22 passiert — ein Pool lag 6,33 % unter seinem
 * Höchststand und stieg nach der Korrektur binnen einer Minute aus. Die Vorschau weist
 * betroffene Pools deshalb einzeln mit ihrem aktuellen Abstand aus.
 *
 * 🔒 Eine bewusst abweichend gesetzte Schwelle bleibt unangetastet: geändert wird nur, was
 * exakt auf dem globalen Fallback steht oder gar keine Sektion hat. Alles andere ist eine
 * Nutzerentscheidung.
 */
import { readFileSync } from 'node:fs';

import { IMPACT_FINANCIAL } from './runner.js';
import { PATHS } from '../../config/paths.js';
import { POOL_SETTINGS_DEFAULTS } from '../pool-settings-defaults.js';
import { readPoolSettings, writePoolSettings, openPositionPools, lastLpValue } from './_pool-settings.js';

const FALLBACK = POOL_SETTINGS_DEFAULTS.trailingStop;

function typeThresholds(settingsDb, poolType) {
    try {
        const row = settingsDb.prepare(
            `SELECT settings FROM pool_type_settings WHERE bot_id = 'liquidity' AND pool_type = ?`
        ).get(poolType);
        if (!row) return null;
        const ts = JSON.parse(row.settings)?.trailingStop ?? {};
        const p1 = Number(ts.thresholdPct);
        if (!Number.isFinite(p1) || p1 <= 0) return null;
        const p2 = Number(ts.thresholdPct2);
        return { thresholdPct: p1, thresholdPct2: (Number.isFinite(p2) && p2 > 0) ? p2 : null };
    } catch {
        return null;
    }
}

function analyse(ctx) {
    let pools = [];
    try { pools = JSON.parse(readFileSync(PATHS.liquidityPools, 'utf-8')); } catch { return { touched: [], warnings: [] }; }

    const stored  = new Map(readPoolSettings(ctx.settingsDb).map(p => [p.poolId, p.settings]));
    const open    = openPositionPools(ctx.liquidityDb);
    const touched = [];
    const warnings = [];

    for (const cfg of pools) {
        if (!cfg.poolType) continue;
        const target = typeThresholds(ctx.settingsDb, cfg.poolType);
        if (!target) continue;                       // Typ ungepflegt → nichts vorzugeben

        const settings = stored.get(cfg.id) ?? {};
        const ts       = settings.trailingStop ?? null;
        const p1Now    = ts?.thresholdPct  ?? FALLBACK.thresholdPct;
        const p2Now    = ts?.thresholdPct2 ?? null;

        if (p1Now === target.thresholdPct && p2Now === target.thresholdPct2) continue;

        // Nur korrigieren, was nie gesetzt wurde. Ein abweichender, bewusst gewählter Wert
        // bleibt stehen — sonst überschreibt die Migration eine Nutzerentscheidung.
        const untouched = !ts || (p1Now === FALLBACK.thresholdPct && p2Now === FALLBACK.thresholdPct2);
        if (!untouched) continue;

        const pos  = open.get(cfg.id);
        const lp   = lastLpValue(ctx.liquidityDb, cfg.id);
        const hwm  = pos?.hwm_usd ?? 0;
        const dd   = (hwm > 0 && lp > 0) ? ((hwm - lp) / hwm) * 100 : null;
        const fires = dd != null && dd > target.thresholdPct;

        if (fires) {
            warnings.push(`${cfg.displayPair ?? cfg.pair}: liegt ${dd.toFixed(2)} % unter dem Höchststand, neue Schwelle ${target.thresholdPct} % → EXIT LÖST SOFORT AUS`);
        }
        touched.push({ poolId: cfg.id, name: cfg.displayPair ?? cfg.pair, poolType: cfg.poolType, settings, target, p1Now, p2Now });
    }
    return { touched, warnings };
}

export default {
    id:          '0004-trailing-stop-pool-type-defaults',
    description: 'Drawdown-Schwellen aus den Pool-Typ-Vorgaben nachziehen',
    impact:      IMPACT_FINANCIAL,

    async plan(ctx) {
        const { touched, warnings } = analyse(ctx);
        return {
            pending: touched.length > 0,
            summary: touched.length
                ? `${touched.length} Pool(s) ohne die Schwellen ihres Typs`
                : 'alle Pools tragen die Schwellen ihres Typs',
            details: touched.map(p =>
                `${p.name} (Typ ${p.poolType}): Drawdown 1 ${p.p1Now} % → ${p.target.thresholdPct} %, Drawdown 2 ${p.p2Now ?? 'aus'} → ${p.target.thresholdPct2 ?? 'aus'}`),
            warnings,
        };
    },

    async up(ctx) {
        const { touched } = analyse(ctx);
        for (const p of touched) {
            p.settings.trailingStop = {
                ...FALLBACK,
                ...(p.settings.trailingStop ?? {}),
                thresholdPct:  p.target.thresholdPct,
                thresholdPct2: p.target.thresholdPct2,
            };
            writePoolSettings(ctx.settingsDb, p.poolId, p.settings);
        }
        return { changed: touched.length, summary: `${touched.length} Pool(s) auf die Schwellen ihres Typs gesetzt` };
    },
};
