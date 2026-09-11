/**
 * Strategie-IDs umbenennen: `kapitalerhalt` → `stablecoin`, `ereignisfenster` → `lambo`
 * (2026-09-04, LIQ#0387).
 *
 * Keine reine Umbenennung — der Geltungsbereich von "Kapitalerhalt" wurde im selben Ticket
 * verengt (cbBTC/WBTC und SOL/JitoSOL gehören jetzt zur neuen Strategie "Token
 * Maximierung", `lib/strategies.js` trägt die neue ID `stablecoin` nur noch für echte
 * Stable-Paare). Eine ID, die weiter `kapitalerhalt` hieße, würde auf einer Installation
 * mit aktiver Strategie einen veränderten Feldsatz unter dem alten Namen laufen lassen —
 * dieselbe Fehlerklasse wie ein irreführender Anzeigename, nur unsichtbar in DB und CLI.
 * `ereignisfenster` → `lambo` ist dagegen eine reine Umbenennung (Feldsatz unverändert).
 *
 * 🔒 Einstufung `safe`: Es ändert sich ausschließlich der String in `strategy_state.
 * strategy_id`. Kein Pool-Setting wird geschrieben, keine Position angefasst —
 * `applyStrategy()` läuft hier nicht mit. `getStrategy()` in lib/strategies.js kennt die
 * alten IDs nach diesem Ticket nicht mehr; ohne diese Migration würde eine Installation mit
 * `strategy_id = 'kapitalerhalt'` oder `'ereignisfenster'` beim nächsten Zugriff auf eine
 * unbekannte Strategie laufen (`getStrategy()` liefert dann `null`, äquivalent zu
 * „Standard" — siehe strategy-apply.js). Das wäre ein stiller Rückfall auf individuelle
 * Einstellungen, nicht laut angekündigt wie beim bewussten Wechsel auf Standard
 * (Entscheidung 8, strategie-auswahl.md).
 *
 * Betroffen ist laut Ticket keine bekannte Installation (business steht auf
 * `ruhiges_kapital`) — diese Migration ist die Absicherung für pub1/pub2 und künftige
 * Installationen, kein bekannter Rückstand.
 */
import { IMPACT_SAFE } from './runner.js';

const RENAMES = [
    { from: 'kapitalerhalt',   to: 'stablecoin' },
    { from: 'ereignisfenster', to: 'lambo' },
];

function tableExists(db) {
    try {
        return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'strategy_state'`).get();
    } catch {
        return false;
    }
}

/** @returns {{from: string, to: string}[]} Umbenennungen, die auf dieser Installation greifen. */
function pending(db) {
    if (!tableExists(db)) return [];
    const row = db.prepare(`SELECT strategy_id FROM strategy_state WHERE id = 1`).get();
    if (!row?.strategy_id) return [];
    return RENAMES.filter(r => r.from === row.strategy_id);
}

export default {
    id:          '0010-strategy-id-rename',
    description: 'strategy_state: alte Strategie-IDs kapitalerhalt/ereignisfenster auf stablecoin/lambo ummappen (LIQ#0387)',
    impact:      IMPACT_SAFE,

    async plan(ctx) {
        const todo = pending(ctx.settingsDb);
        if (!todo.length) {
            return {
                pending: false,
                summary: 'nichts zu tun — keine aktive Strategie mit alter ID',
                details: [],
                warnings: [],
            };
        }
        return {
            pending: true,
            summary: `strategy_id '${todo[0].from}' wird auf '${todo[0].to}' umgestellt`,
            details: [`aktive Zeile (id=1) trägt noch die alte ID`],
            warnings: [],
        };
    },

    async up(ctx) {
        const todo = pending(ctx.settingsDb);
        if (!todo.length) return { changed: 0, summary: 'nichts zu tun — keine aktive Strategie mit alter ID' };

        const { from, to } = todo[0];
        const stmt = ctx.settingsDb.prepare(
            `UPDATE strategy_state SET strategy_id = ? WHERE id = 1 AND strategy_id = ?`
        );
        const changed = stmt.run(to, from).changes;
        return { changed, summary: changed ? `strategy_id '${from}' → '${to}'` : 'nichts zu tun' };
    },
};
