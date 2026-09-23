/**
 * FORGE Nexus – Entscheidung, wann die Helius-Budget-Warnung ins Message Center geht
 *
 * Hintergrund (CORE#000806): Der stündliche Budget-Check schrieb nur per console.error ins
 * Journal. Die Warnung lief tagelang, ohne dass sie jemand las. Der Check läuft weiterhin
 * stündlich, die Meldung im Message Center darf aber nicht stündlich kommen.
 *
 * Regeln (reine Funktion, ohne Zeit- oder DB-Zugriff, damit testbar):
 *   • Erste Warnstufe (near/over) nach einem OK-Zustand → sofort melden.
 *   • Gleiche Stufe erneut → erst nach COOLDOWN_MS wieder (Erinnerung, kein Dauerfeuer).
 *   • Eskalation near → over → sofort, auch innerhalb des Cooldowns.
 *   • Rückstufung over → near → still. `prev` bleibt bei der höchsten gemeldeten Stufe,
 *     sonst würde eine Hochrechnung, die um die 1-Mio.-Grenze pendelt, stündlich
 *     abwechselnd „near" und „over" melden.
 *   • Zurück unter die Warnschwelle → einmal „entwarnt" (info: nichts mehr zu tun,
 *     siehe Memory feedback_notify_level_resolved_vs_warn), danach ist prev geleert.
 */

export const COOLDOWN_MS = 24 * 60 * 60 * 1000;

const RANK = { near: 1, over: 2 };

/** Zustand aus den Stats des RpcCache. */
export function budgetState(stats) {
    if (stats.projectedMonthly == null) return null;
    if (stats.overBudget) return 'over';
    if (stats.nearBudget) return 'near';
    return 'ok';
}

/**
 * @param {{state:'near'|'over', ts:number}|null} prev  zuletzt gemeldete Warnstufe
 * @param {object} stats  RpcCache.getStats()
 * @param {number} now
 * @returns {{send: null|{msgKey:string, level:'error'|'warn'|'info'}, next: object|null}}
 */
export function decideBudgetAlert(prev, stats, now) {
    const cur = budgetState(stats);
    if (cur === null) return { send: null, next: prev };

    if (cur === 'ok') {
        if (!prev) return { send: null, next: null };
        return { send: { msgKey: 'notify.sys.helius_budget_ok', level: 'info' }, next: null };
    }

    const escalated  = !prev || RANK[cur] > RANK[prev.state];
    const cooledDown = prev && cur === prev.state && now - prev.ts >= COOLDOWN_MS;
    if (!escalated && !cooledDown) return { send: null, next: prev };

    return {
        send: {
            msgKey: cur === 'over' ? 'notify.sys.helius_budget_over' : 'notify.sys.helius_budget_near',
            level:  cur === 'over' ? 'error' : 'warn',
        },
        next: { state: cur, ts: now },
    };
}

/** Zustand aus der zuletzt gespeicherten Meldung wiederherstellen (Nexus-Neustart). */
export function prevFromRow(row) {
    if (!row) return null;
    const state = { 'notify.sys.helius_budget_over': 'over', 'notify.sys.helius_budget_near': 'near' }[row.msg_key];
    return state ? { state, ts: row.timestamp } : null;
}
