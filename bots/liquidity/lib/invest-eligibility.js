/**
 * FORGE Liquidity – Invest-Guard: darf in diesen Pool überhaupt Kapital hinein?
 *
 * ═══ Warum es dieses Modul gibt ═══════════════════════════════════════════════
 * Die Risk-Management-Regeln (TVL-Schutz, Score-Limit) waren bis 2026-08-20
 * ausschließlich Austritts-Regeln: sie prüfen erst, wenn eine Position existiert
 * (resolveTrigger() steigt bei !getOpenPosition() aus). „Bester Pool" konnte
 * deshalb in einen Pool investieren, den dieselben Regeln Minuten später wieder
 * räumen mussten — am 20.08.2026 geschehen mit HYPE/USDC: 58 K TVL gegen eine
 * konfigurierte 100-K-Exit-Schwelle, Voll-Exit im selben Zyklus, Kosten in beide
 * Richtungen, danach 12 h Cooldown.
 *
 * 🔒 Regel: Jede Regel, die Kapital wieder herausholt, muss VOR dem Hineinlegen
 *    als Filter laufen — und zwar aus derselben Quelle wie der Exit selbst.
 *    Die Schwellen-Auflösung teilt sich dieses Modul mit lib/tvl-protection.js
 *    (lib/tvl-thresholds.js), damit „darf hinein" und „muss heraus" nicht
 *    auseinanderlaufen können.
 *
 * Aufrufer: bin/cleanup.js — im Ranking (Filter VOR dem Sortieren, dadurch rückt
 * automatisch der nächstbeste zulässige Pool nach) und als harte Sperre im
 * Invest-Pfad selbst (Modus 'pool:<id>' läuft am Ranking vorbei).
 *
 * Reine DB-/Datei-Lookups, kein API-Call, kein Rate-Limit-Risiko.
 */

import Database from 'better-sqlite3';

import { config } from './config.js';
import { resolveTvlThresholds } from './tvl-thresholds.js';
import { DEFAULT_TVL_PROTECTION, DEFAULT_SCORE_LIMIT } from './settings-auto.js';
import { POOL_SETTINGS_DEFAULTS } from '../../../lib/pool-settings-defaults.js';
import { getOpenPosition } from './db.js';
import { PATHS } from '../../../config/paths.js';

const SETTINGS_DB = PATHS.settingsDb;

/**
 * Liest die komplette Settings-Zeile eines Pools (eine Query statt je eine pro Regel).
 * Fehlt die Zeile, gelten die Defaults aus settings-auto.js — genau das, was
 * ensureTvlProtectionDefaults()/ensureScoreLimitEnabled() beim Aktivieren schreiben
 * würden. Ein nie aktivierter Pool ist damit nicht ungeschützt.
 */
function loadPoolSettings(poolId) {
    try {
        const sdb = new Database(SETTINGS_DB, { readonly: true, fileMustExist: true });
        const row = sdb.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(config.botId, poolId);
        sdb.close();
        return row ? JSON.parse(row.settings) : {};
    } catch {
        return {};
    }
}

/**
 * Verbleibende Investitionskapazität eines Pools gegen die Max-Investment-Schwelle.
 * `Infinity` wenn die Regel deaktiviert oder keine Schwelle gesetzt ist.
 *
 * Vergleichsgröße ist positions.capital_usdc (gebuchtes Kapital), nicht der
 * Markt-Wert — siehe Begründung im maxInvestment-Kommentar in
 * lib/pool-settings-defaults.js.
 *
 * @param {object} pool
 * @param {object} db       Offene Liquidity-DB
 * @param {object} [settings] vorgeladene Settings-Zeile (spart die Query)
 * @returns {number} verbleibender USDC-Betrag (>= 0) oder Infinity
 */
export function remainingInvestCapacity(pool, db, settings = null) {
    if (!pool) return Infinity;
    const s = settings ?? loadPoolSettings(pool.id);
    const cfg = s?.maxInvestment ?? POOL_SETTINGS_DEFAULTS.maxInvestment;
    const cap = Number(cfg?.amountUsdc);
    if (cfg?.enabled !== true || !Number.isFinite(cap) || cap <= 0) return Infinity;

    const capitalUsdc = getOpenPosition(db, pool.id)?.capital_usdc ?? 0;
    return Math.max(0, cap - capitalUsdc);
}

/** Letzter bekannter Pool-TVL aus pool_stats (0 = nie gemessen). */
function latestTvl(db, poolId) {
    const row = db.prepare(
        `SELECT tvl_usd FROM pool_stats WHERE pool_id = ? AND tvl_usd > 0
         ORDER BY recorded_at DESC LIMIT 1`
    ).get(poolId);
    return row?.tvl_usd ?? 0;
}

/**
 * Prüft alle Regeln, die einem Invest entgegenstehen.
 *
 * @param {object} pool        Pool aus config.pools.all
 * @param {object} db          Offene Liquidity-DB (lesend genutzt)
 * @param {object} [opts]
 * @param {number|null} [opts.exitScore] investScore.exitValue aus data.json — derselbe
 *        Wert, den shouldTriggerScoreLimit() auswertet (NICHT investScore.value, der
 *        trägt den Volumen-Malus und darf keinen Exit auslösen).
 * @param {object} [opts.settings] vorgeladene Settings-Zeile (spart die Query)
 * @returns {{ok: boolean, rule: string|null, reason: string|null, detail: object}}
 *          `rule`: 'tvl' | 'tvl_unknown' | 'score_limit' | 'max_investment' — maschinenlesbar für
 *          Dashboard und Entscheidungs-Log; `reason` ist deutscher Klartext fürs Log.
 */
export function checkInvestEligibility(pool, db, { exitScore = null, settings = null } = {}) {
    const ok = { ok: true, rule: null, reason: null, detail: {} };
    if (!pool) return ok;

    const s   = settings ?? loadPoolSettings(pool.id);
    const tvlCfg = s?.tvlProtection ?? DEFAULT_TVL_PROTECTION;
    const th     = resolveTvlThresholds(pool, tvlCfg);
    const tvl    = latestTvl(db, pool.id);

    // Greift der TVL-Schutz überhaupt? Nur dann ist ein fehlender Messwert relevant.
    const tvlArmed = th.l1.enabled && th.l1.threshold;

    if (tvlArmed && !(tvl > 0)) {
        // Kein Messwert. Beim Exit heißt „nicht gemessen" bewusst „nichts tun" (ein
        // API-Ausfall darf kein Kapital bewegen) — beim Invest ist die sichere Richtung
        // die umgekehrte: es wird nichts bewegt, kein Kapital ist in Gefahr, und der
        // nächstbeste Pool rückt ohne Verlust nach.
        return {
            ok: false, rule: 'tvl_unknown',
            reason: 'kein TVL-Messwert vorhanden',
            detail: { tvl: null },
        };
    }

    if (th.l1.enabled && th.l1.threshold && tvl < th.l1.threshold) {
        return {
            ok: false, rule: 'tvl',
            reason: `TVL ${Math.round(tvl).toLocaleString('de-DE')} USDC unter Schutz-Schwelle `
                  + `${Math.round(th.l1.threshold).toLocaleString('de-DE')} USDC`,
            detail: { tvl, threshold: th.l1.threshold, level: 1 },
        };
    }

    // Score-Limit: ein Pool, den das Score-Limit sofort wieder verlassen würde, darf
    // nicht Ziel eines Invests sein. Bewusst gegen exitValue geprüft — der Ranking-Score
    // (investScore.value) misst gegen CLEANUP_MIN_SCORE eine andere Größe.
    const slCfg = s?.scoreLimit ?? DEFAULT_SCORE_LIMIT;
    const minScore = Number.isFinite(Number(slCfg?.minScore)) ? Number(slCfg.minScore) : 30;
    if (slCfg?.enabled === true && exitScore != null && exitScore < minScore) {
        return {
            ok: false, rule: 'score_limit',
            reason: `Exit-Score ${exitScore} unter Score-Limit ${minScore}`,
            detail: { exitScore, minScore },
        };
    }

    // Max Investment: bei voll ausgeschöpfter Kapazität kein Invest mehr — der
    // Teil-Invest bis zur Kante (Restkapazität < angefragter Betrag) läuft nicht
    // hier, sondern über remainingInvestCapacity() direkt in cleanup.js/deposit.js.
    const remaining = remainingInvestCapacity(pool, db, s);
    if (remaining <= 0) {
        const miCfg = s?.maxInvestment ?? POOL_SETTINGS_DEFAULTS.maxInvestment;
        return {
            ok: false, rule: 'max_investment',
            reason: `Max Investment (${Math.round(Number(miCfg.amountUsdc)).toLocaleString('de-DE')} USDC) erreicht`,
            detail: { capUsdc: Number(miCfg.amountUsdc) },
        };
    }

    return ok;
}
