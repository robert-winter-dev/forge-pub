/**
 * FORGE Settings – Strategie anwenden, Abweichungen berechnen, aktive Strategie merken
 * (LIQ#0368, Baustein B — Teilaufgaben 3 bis 5). Plus Rücknahme des Feldsatzes
 * (`rollbackStrategyFields()`, LIQ#0382/LIQ#0384) über zwei Auslöser: Premium-Ende
 * (`rollbackStrategyOnPremiumLoss()`) und Wechsel auf „Standard" (`switchToStandard()`).
 *
 * Die Definitionen liegen in lib/strategies.js (abhängigkeitsfrei, künftig Premium-Blob).
 * Diese Datei ist der Teil, der die drei Speicherorte der Pool-Einstellungen kennt:
 *
 *   1. settings.db → pool_settings          Trailing Stop, Score Limit, TVL-Schutz,
 *                                           Auto-Compound, maxInvestment, cleanup
 *   2. liquiditybot.db → pools.range_override_fixed_pct   die Range (Single Source of Truth
 *                                           seit Liquidity Bot v0.4.85)
 *   3. Liquidity-.env                       CLEANUP_* — von der Strategie NICHT angefasst,
 *                                           siehe lib/strategies.js
 *
 * 🔒 Besitzmodell C-lite (Entscheidung 2 in Strategien/strategie-auswahl.md):
 * Die Strategie schreibt ihren Feldsatz per Bulk-Write wie die heutige Pool-Typ-Ebene und
 * vermerkt in `settings_history`, dass die Änderung strategiegetrieben war
 * (`source = 'strategy'`, LIQ#0366). Es gibt KEINE Auflösungsreihenfolge und keine dritte
 * Einstellungsebene — die Abweichung entsteht durch Vergleich des Ist-Zustands gegen die
 * Definition (deviations() unten). Nutzen von Modell C zum Preis von Modell B.
 *
 * 🔒 Entscheidung 5 — Lockerungen sofort, Verschärfungen nur für neu eröffnete Positionen.
 * Die Einstufung steht in lib/strategies.js (`classifyChange()`/`decideField()`); hier wird
 * sie durchgesetzt:
 * Eine Verschärfung an einem Pool mit offener Position wird NICHT geschrieben. Sie
 * verschwindet dabei nicht, sondern erscheint als Abweichung mit dem Grund
 * `deferred_open_position` — genau das ist der Sinn von C-lite. Ein erneuter Aufruf von
 * applyStrategy(), nachdem die Position geschlossen wurde, holt sie nach; die Funktion ist
 * deshalb idempotent und darf jederzeit wiederholt werden. Es gibt bewusst KEINEN eigenen
 * Speicher für „ausstehende Verschärfungen" — der wäre die dritte Ebene, die C-lite
 * gerade vermeidet.
 *
 * ⚠️ Nicht Teil dieser Datei: das Durchreichen der Typ-Zulassung an das Score-Ranking.
 * Entscheidung 9.1 sagt „die Typ-Zulassung der Strategie IST der Ranking-Filter" — ein
 * Filter, kein geschriebener Zustand. `poolsInScope()` liefert ihn fertig; die einzige
 * offene Frage ist, wo im Liquidity Bot (bots/liquidity/bin/cleanup.js) er greift. Bis das
 * entschieden ist, hat die Zulassung keine Kapitalwirkung.
 */

import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';
import {
    getStrategy, poolMatchesScope, fieldsForPool, decideField, decideRollbackField, getPath, setPath,
    STRATEGY_DEFINITIONS_VERSION,
} from '../../../lib/strategies.js';
import { openDb, loadPools, loadSettings, saveSettings, recordSettingsHistory } from '../routes/pools.js';
import { isForkInstance } from '../../../lib/premium-identity-context.js';
import { hasPremiumEntitlement } from '../../../lib/premium-entitlement.js';
import { recordPremiumMessage } from '../../../core/premium/messages-db.js';

const LIQUIDITYBOT_DB = PATHS.liquidityDb;

/** Der Punkt-Pfad, der nicht in pool_settings lebt, sondern in liquiditybot.db. */
const RANGE_PATH = 'range.fixedPct';

// ── Teilaufgabe 5: aktive Strategie merken ───────────────────────────────────

/**
 * 🔒 „Standard" ist die ABWESENHEIT einer Strategie (Entscheidung 8) — es gibt dafür keine
 * ID und keine Zeile mit einem Sonderwert. `strategy_id IS NULL` (oder gar keine Zeile) ist
 * der Standard: kein eigener Feldsatz, keine Abweichungs-Anzeige. Der Wechsel DAHIN ist
 * seit LIQ#0384 aber keine reine Zustandsänderung mehr — `switchToStandard()` nimmt vorher
 * den Feldsatz der bisherigen Strategie zurück (`rollbackStrategyFields()`), damit nicht
 * die Werte einer nicht mehr aktiven Strategie unbemerkt liegen bleiben.
 *
 * Das Anlegen der Tabelle geschieht hier idempotent bei jedem Zugriff, zusätzlich zur
 * formalen Migration `0009-strategy-state.js`. Grund ist die Lehre aus LIQ#0366:
 * `baseline()` überspringt Schema-Migrationen auf einer Neuinstallation, der Zielzustand
 * muss deshalb im Code mitkommen — sonst wäre die Tabelle auf frischen Installationen
 * dauerhaft nicht vorhanden und keine Migration holte es nach.
 */
export function ensureStrategyState(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS strategy_state (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            strategy_id TEXT,              -- NULL = "Standard" (Abwesenheit einer Strategie)
            applied_at  INTEGER,
            version     INTEGER
        );
    `);
}

/** @returns {{strategyId: string|null, appliedAt: number|null, version: number|null}} */
export function getActiveStrategy(db) {
    ensureStrategyState(db);
    const row = db.prepare(`SELECT strategy_id, applied_at, version FROM strategy_state WHERE id = 1`).get();
    return {
        strategyId: row?.strategy_id ?? null,
        appliedAt:  row?.applied_at  ?? null,
        version:    row?.version     ?? null,
    };
}

/**
 * Merkt die aktive Strategie. Schreibt KEINE Pool-Einstellungen — das tut applyStrategy().
 * Getrennt gehalten, damit „welche Strategie ist gewählt" und „was wurde damit geschrieben"
 * zwei Vorgänge bleiben: Ein fehlgeschlagener Bulk-Write darf die Auswahl nicht verlieren,
 * und die Auswahl allein darf kein Kapital bewegen.
 *
 * @param {string|null} strategyId  null = Standard.
 */
export function setActiveStrategy(db, strategyId) {
    if (strategyId != null && !getStrategy(strategyId)) {
        throw new Error(`Unbekannte Strategie: ${JSON.stringify(strategyId)}`);
    }
    ensureStrategyState(db);
    db.prepare(`
        INSERT INTO strategy_state (id, strategy_id, applied_at, version) VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET strategy_id = excluded.strategy_id,
                                      applied_at  = excluded.applied_at,
                                      version     = excluded.version
    `).run(strategyId ?? null, Date.now(), strategyId == null ? null : STRATEGY_DEFINITIONS_VERSION);
    return getActiveStrategy(db);
}

// ── Ist-Zustand lesen ────────────────────────────────────────────────────────

/**
 * Ein Lesevorgang auf liquiditybot.db für alle Pools: offene Position, autoritativer
 * Pool-Typ und die autoritative Range. Einmal statt 37-mal geöffnet.
 *
 * 🔒 Zwei Dinge werden hier bewusst selbst gelesen statt über `loadPools()`:
 *
 * 1. **`pool_type`.** Seit [LIQ#0378] (04.09.2026) überlagert `loadPools()` in
 *    routes/pools.js `pool_type` ebenfalls aus der DB — der eigene Read hier ist also
 *    nicht mehr die einzige Quelle der Wahrheit, sondern eine zweite, unabhängige. Er
 *    bleibt bewusst bestehen: Strategie-Anwendung ist die Stelle mit der größten
 *    Kapitalwirkung, und ein direkter Read ohne Umweg über den Settings-Server-Zustand
 *    ist robuster, falls sich dort künftig wieder eine Lücke einschleicht. Kein Grund,
 *    das zu entfernen, solange keine Kosten daraus entstehen.
 *
 * 2. **Die effektive Range.** Der Überlagerungsschritt setzt `rangeOverride.fixedPct` nur,
 *    wenn der Pool in pools.json bereits ein `rangeOverride`-Objekt hat. Genau so verhält
 *    sich auch der Bot (db.js `applyPoolDynamics()`). Ein Pool ohne diesen strukturellen
 *    Slot hat also keine feste Range — und kann auch keine bekommen:
 *    `updatePoolRangeOverride()` in bots/liquidity/lib/config.js wirft dafür ausdrücklich.
 *    Der effektive Ist-Wert ist DB-Spalte, sonst JSON-Seed (dieselbe Reihenfolge wie dort).
 */
function loadPoolFacts() {
    const facts = { open: new Set(), poolType: new Map(), rangePct: new Map(), readable: false };
    try {
        const db = new Database(LIQUIDITYBOT_DB, { readonly: true, fileMustExist: true });
        for (const r of db.prepare(`SELECT pool_id FROM positions WHERE closed_at IS NULL`).all()) {
            facts.open.add(r.pool_id);
        }
        for (const r of db.prepare(`SELECT id, pool_type, range_override_fixed_pct AS pct FROM pools`).all()) {
            if (r.pool_type != null) facts.poolType.set(r.id, r.pool_type);
            if (r.pct != null)       facts.rangePct.set(r.id, r.pct);
        }
        db.close();
        facts.readable = true;
    } catch { /* DB nicht lesbar → siehe isOpen() */ }
    return facts;
}

/**
 * Hält der Pool eine offene Position?
 * 🔒 Ist die Bot-DB nicht lesbar, lautet die Antwort „ja". Dann unterbleiben alle
 * Verschärfungen — der teure Fehler ist nur in eine Richtung möglich (dieselbe Begründung
 * wie beim `default` in classifyChange()).
 */
function isOpen(facts, poolId) {
    return facts.readable ? facts.open.has(poolId) : true;
}

/** Der autoritative Pool-Typ (DB vor pools.json-Seed), für den Geltungsbereich. */
function effectivePoolType(facts, pool) {
    return facts.poolType.get(pool.id) ?? pool.poolType;
}

/** Hat der Pool überhaupt einen Slot für eine feste Range? Ohne ihn ist sie nicht setzbar. */
function hasRangeSlot(pool) {
    return !!pool.rangeOverride && typeof pool.rangeOverride.fixedPct === 'number';
}

/**
 * Der aktuelle Wert eines Strategie-Feldpfads.
 * Range: DB-Spalte, sonst JSON-Seed, sonst null (kein Slot). Alles andere: pool_settings.
 */
function readCurrent(facts, pool, settings, path) {
    if (path === RANGE_PATH) {
        return facts.rangePct.get(pool.id) ?? (hasRangeSlot(pool) ? pool.rangeOverride.fixedPct : null);
    }
    return getPath(settings, path);
}

/** Setzt `range_override_fixed_pct` in liquiditybot.db — identisch zu writeFixedPct() in routes/pools-actions.js. */
function writeFixedPct(poolId, newPct) {
    const db = new Database(LIQUIDITYBOT_DB);
    db.pragma('busy_timeout = 5000');
    try {
        const row = db.prepare(`SELECT id FROM pools WHERE id = ?`).get(poolId);
        if (!row) throw new Error(`Pool-Zeile fehlt in liquiditybot.db: ${poolId}`);
        db.prepare(`UPDATE pools SET range_override_fixed_pct = ? WHERE id = ?`).run(newPct, poolId);
    } finally {
        db.close();
    }
}

// ── Geltungsbereich ──────────────────────────────────────────────────────────

/**
 * Die Pool-Liste mit autoritativem Pool-Typ, plus die einmal gelesenen Bot-Fakten.
 * Jeder Einstiegspunkt dieser Datei geht hierüber — nur so ist sichergestellt, dass
 * Geltungsbereich und Ist-Vergleich denselben Typ sehen wie der Bot.
 */
function loadPoolsEffective() {
    const facts = loadPoolFacts();
    const pools = loadPools().map(p => ({ ...p, poolType: effectivePoolType(facts, p) }));
    return { pools, facts };
}

/**
 * Die Pools, in denen eine Strategie gilt — Pool-Typ PLUS `volatilePair` (Entscheidung 9).
 * Das ist zugleich der Ranking-Filter: Lässt eine Strategie einen Typ nicht zu, hat das
 * Ranking dort nichts zu suchen.
 *
 * @param {string|null} strategyId  null („Standard") → alle Pools, kein Filter.
 */
export function poolsInScope(strategyId, pools = loadPoolsEffective().pools) {
    const strategy = getStrategy(strategyId);
    if (!strategy) return pools;
    return pools.filter(p => poolMatchesScope(p, strategy.scope));
}

// ── Teilaufgabe 3: Anwenden ──────────────────────────────────────────────────

/**
 * Schreibt den Feldsatz der Strategie in alle Pools ihres Geltungsbereichs.
 *
 * 🔒 `dryRun` ist der Default. Ein Aufruf ohne Argumente ändert nichts und liefert nur den
 * Bericht — Schreiben ist die ausdrückliche Ausnahme, nicht der Normalfall. Der Feldsatz
 * greift in Live-Kapital ein (Exits und Ranges); ein versehentlich scharfer Aufruf wäre
 * teurer als jede vergessene Wiederholung.
 *
 * @param {string} strategyId
 * @param {{dryRun?: boolean}} opts
 * @returns {{strategyId, dryRun, pools: Array, summary: Object}}
 */
export function applyStrategy(strategyId, { dryRun = true } = {}) {
    const strategy = getStrategy(strategyId);
    if (!strategy) throw new Error(`Unbekannte Strategie: ${JSON.stringify(strategyId)}`);

    const { pools, facts } = loadPoolsEffective();
    const scope  = poolsInScope(strategyId, pools);
    const db     = openDb();
    const report = [];

    try {
        for (const pool of scope) {
            const fields   = fieldsForPool(strategy, pool);
            if (!fields) continue;
            const settings = loadSettings(db, 'liquidity', pool.id);
            const open     = isOpen(facts, pool.id);
            // rangeOverride.locked ist eine ausdrückliche Handfestlegung (Entscheidung 9):
            // nicht überschreiben, sondern als Abweichung melden.
            const locked   = pool.rangeOverride?.locked === true;

            const entry = { poolId: pool.id, pair: pool.pair, poolType: pool.poolType,
                            hasOpenPosition: open, written: [], skipped: [], unchanged: [], failed: [] };

            const partial      = {};
            let   rangeNext    = null;
            let   rangeCurrent = null;

            for (const [path, spec] of Object.entries(fields)) {
                const current = readCurrent(facts, pool, settings, path);
                const target  = spec.value;

                // Die Entscheidung selbst liegt in lib/strategies.js — reine Funktion,
                // vollständig geprüft in bin/test-strategies.js. Hier steht nur noch,
                // was mit dem Ergebnis geschieht.
                //
                // ⚠️ `no_range_slot`: Die DB-Spalte trotzdem zu setzen wäre der schlimmere
                // Fehler — ohne `rangeOverride`-Objekt in pools.json liest weder Bot noch
                // Settings sie, der Wert wäre lautlos wirkungslos.
                const { action, kind, reason } = decideField(path, current, target, {
                    hasOpenPosition: open,
                    rangeLocked:     locked,
                    rangeWritable:   hasRangeSlot(pool),
                });
                const item = { field: path, from: current, to: target, kind, confidence: spec.confidence };

                if (action === 'unchanged') { entry.unchanged.push({ field: path, value: current }); continue; }
                if (action === 'skip')      { entry.skipped.push({ ...item, reason });               continue; }

                if (path === RANGE_PATH) { rangeNext = target; rangeCurrent = current; }
                else                     setPath(partial, path, target);
                entry.written.push(item);
            }

            if (!dryRun && entry.written.length) {
                try {
                    if (Object.keys(partial).length) {
                        // 🔒 source: 'strategy' — die ganze Existenzberechtigung von LIQ#0366.
                        // Ohne sie hielte userTouched() in lib/migrations/0006-… jeden von
                        // einer Strategie berührten Pool für „vom Nutzer von Hand gesetzt"
                        // und ließe künftige Default-Korrekturen dort überall aussetzen.
                        saveSettings(db, 'liquidity', pool.id, partial, { source: 'strategy' });
                    }
                    if (rangeNext !== null) {
                        writeFixedPct(pool.id, rangeNext);
                        // 🔒 Anders als die pool_settings-Felder oben trägt range.fixedPct
                        // keine automatische Historie (liegt in liquiditybot.db, nicht unter
                        // saveSettings()). Ohne diese Zeile könnte eine spätere Rücknahme
                        // (LIQ#0382) Regel 2 ("nur zurücknehmen, was seither unverändert ist")
                        // für die Range nie prüfen — derselbe Pfad `range.fixedPct` wie überall
                        // sonst, damit ein Leser der Historie keinen Sonderfall kennen muss.
                        recordSettingsHistory(db, 'liquidity', 'pool', pool.id,
                            { range: { fixedPct: rangeCurrent } }, { range: { fixedPct: rangeNext } },
                            'strategy');
                    }
                } catch (err) {
                    entry.failed = entry.written.map(i => ({ ...i, reason: err.message }));
                    entry.written = [];
                }
            }

            report.push(entry);
        }

        if (!dryRun) setActiveStrategy(db, strategyId);
    } finally {
        db.close();
    }

    const summary = {
        poolsInScope: report.length,
        written:      report.reduce((n, p) => n + p.written.length,   0),
        skipped:      report.reduce((n, p) => n + p.skipped.length,   0),
        unchanged:    report.reduce((n, p) => n + p.unchanged.length, 0),
        failed:       report.reduce((n, p) => n + p.failed.length,    0),
    };
    return { strategyId, dryRun, pools: report, summary };
}

// ── Teilaufgabe 4: Abweichungen ──────────────────────────────────────────────

/**
 * Vergleicht den Ist-Zustand gegen die Definition der Strategie und liefert die
 * abweichenden Felder. Das ist der Kern von C-lite: Es gibt keine gespeicherte Wahrheit
 * darüber, was „strategiekonform" ist — die Abweichung entsteht durch Vergleich.
 *
 * Gründe, die eine Abweichung tragen kann:
 *   'manual'                 – von Hand anders gesetzt (oder nie angewendet)
 *   'deferred_open_position' – eine Verschärfung, die auf das Ende der Position wartet
 *                              (Entscheidung 5). Keine Nachlässigkeit, sondern die Regel.
 *   'locked'                 – rangeOverride.locked: ausdrückliche Handfestlegung, wird
 *                              nie überschrieben (Entscheidung 9).
 *
 * 🔒 Für „Standard" gibt es keine Abweichungen (Entscheidung 8): ohne Feldsatz gibt es
 * nichts, wovon abgewichen werden könnte. Liefert dann eine leere Liste, keinen Fehler.
 *
 * @param {string|null} strategyId  Ohne Angabe: die aktive Strategie.
 */
export function deviations(strategyId = undefined) {
    const db = openDb();
    try {
        const id       = strategyId === undefined ? getActiveStrategy(db).strategyId : strategyId;
        const strategy = getStrategy(id);
        if (!strategy) return { strategyId: null, pools: [], total: 0 };

        const { pools, facts } = loadPoolsEffective();
        const result = [];
        for (const pool of poolsInScope(id, pools)) {
            const fields = fieldsForPool(strategy, pool);
            if (!fields) continue;
            const settings = loadSettings(db, 'liquidity', pool.id);
            const open     = isOpen(facts, pool.id);
            const locked   = pool.rangeOverride?.locked === true;

            const items = [];
            for (const [path, spec] of Object.entries(fields)) {
                const current = readCurrent(facts, pool, settings, path);
                if (current === spec.value) continue;

                // Derselbe Entscheidungspfad wie beim Anwenden — sonst könnte die Anzeige
                // eine Abweichung anders begründen, als applyStrategy() sie behandelt.
                const { kind, reason: skipReason } = decideField(path, current, spec.value, {
                    hasOpenPosition: open,
                    rangeLocked:     locked,
                    rangeWritable:   hasRangeSlot(pool),
                });
                // Kein Hinderungsgrund → der Wert steht von Hand anders (oder die Strategie
                // wurde nie angewendet).
                const reason = skipReason ?? 'manual';

                items.push({ field: path, is: current, should: spec.value, kind, reason,
                             confidence: spec.confidence });
            }
            if (items.length) {
                result.push({ poolId: pool.id, pair: pool.pair, poolType: pool.poolType,
                              hasOpenPosition: open, deviations: items });
            }
        }
        return { strategyId: id, pools: result,
                 total: result.reduce((n, p) => n + p.deviations.length, 0) };
    } finally {
        db.close();
    }
}

// ── Rücknahme des Feldsatzes (LIQ#0382) ──────────────────────────────────────

/**
 * Nimmt den Feldsatz einer Strategie zurück — reine Rückrichtung von applyStrategy() (die
 * dortigen Kommentare zu den drei Speicherorten gelten unverändert), dieselbe
 * Asymmetrie-Regel (`decideField()`, hier über `decideRollbackField()` mit vertauschten
 * Rollen). Extrahiert aus `rollbackStrategyOnPremiumLoss()` (LIQ#0382) für LIQ#0384, weil
 * derselbe Endzustand — Strategie nicht mehr aktiv — jetzt über zwei Auslöser erreicht
 * wird (Premium-Ende, Wechsel auf „Standard") und beide DIESELBEN vier Sicherheitsregeln
 * brauchen. Wer einen der beiden Auslöser baut, ohne diese Funktion aufzurufen, baut die
 * Regeln ein zweites Mal nach — genau das soll diese Extraktion verhindern.
 *
 * Die vier Sicherheitsregeln aus dem LIQ#0382-Ticket, hart im Code:
 *
 * 1. **Nur zurücknehmen, was seither unverändert ist.** Referenz ist die JEWEILS LETZTE
 *    settings_history-Zeile je (Pool, Feld). Nur wenn ihre `source` `'strategy'` ist UND
 *    ihr `new_value` exakt dem aktuellen Ist-Wert entspricht, gilt das Feld als seit dem
 *    Anwenden unverändert — Ziel ist dann ihr `old_value`. Hat der Nutzer (oder eine
 *    andere Quelle) seither etwas anderes gesetzt, bleibt sein Wert stehen.
 * 2. **Asymmetrie gilt auch rückwärts.** `decideField(path, current, oldValue, ctx)` —
 *    dieselbe Funktion wie beim Anwenden, nur mit vertauschten Rollen. Eine Rücknahme,
 *    die klassifikatorisch eine Verschärfung ist, wird bei offener Position übersprungen
 *    (`deferred_open_position`) und bleibt als normale Abweichung sichtbar. 🔒 Genau
 *    hier ist die Rücknahme brenzliger als das Anwenden: „Trailing Stop wieder an" auf
 *    einer offenen Position kann sie sofort über die Kante schieben.
 * 3. **`dryRun` ist der Default**, dieselbe Begründung wie bei `applyStrategy()`: ein
 *    Rückgängig-Machen greift ebenso in Live-Kapital ein wie das Anwenden selbst.
 * 4. **Setzt bei `!dryRun` immer auch die aktive Strategie auf „Standard"** — beide
 *    Auslöser wollen exakt das als Endzustand, keiner braucht einen eigenen Aufruf von
 *    `setActiveStrategy()` danach.
 *
 * Was NICHT hier passiert, weil es pro Auslöser verschieden ist: der Master-Ausschluss
 * und die Premium-Prüfung (nur `rollbackStrategyOnPremiumLoss()`), die
 * Message-Center-Meldung (nur dort — ein Nutzer, der selbst auf „Standard" wechselt, sieht
 * die Rücknahme bereits im Bestätigungsdialog, ein stiller Premium-Wegfall dagegen nicht).
 *
 * 🔒 Bewusst OHNE Test-Override-Parameter für die DB-Pfade (anders als z.B. `{ dbPath }`
 * bei lib/premium-auto-pay-store.js): `openDb()`/`loadPools()` sind fest auf die echten
 * DB-Pfade verdrahtet. Getestet wird deshalb nur die reine Entscheidung je Feld
 * (`decideRollbackField()` in lib/strategies.js, DB-frei) — derselbe Schreibpfad ist auch
 * bei `applyStrategy()` nur manuell über `bots/settings/bin/strategy.js --commit` geprüft,
 * nie automatisiert gegen eine echte DB.
 *
 * @param {import('better-sqlite3').Database} db  Offene Verbindung, wird NICHT geschlossen.
 * @param {string} strategyId
 * @param {{dryRun?: boolean}} opts
 * @returns {{strategyId, dryRun, pools: Array, summary: {reverted: number, skipped: number, failed: number}}}
 */
export function rollbackStrategyFields(db, strategyId, { dryRun = true } = {}) {
    const strategy = getStrategy(strategyId);
    if (!strategy) {
        // Definition nicht mehr auffindbar (z.B. Code-Stand geändert) — ohne Feldsatz gibt
        // es nichts zurückzunehmen, aber "Standard" muss trotzdem greifen.
        if (!dryRun) setActiveStrategy(db, null);
        return { strategyId, dryRun, pools: [], summary: { reverted: 0, skipped: 0, failed: 0 } };
    }

    const { pools, facts } = loadPoolsEffective();
    const scope  = poolsInScope(strategyId, pools);
    const report = [];

    const latestHistoryRow = (poolId, path) => db.prepare(`
        SELECT old_value AS oldValue, new_value AS newValue, source
          FROM settings_history
         WHERE bot_id = 'liquidity' AND scope = 'pool' AND scope_id = ? AND field = ?
         ORDER BY changed_at DESC LIMIT 1
    `).get(poolId, path);

    for (const pool of scope) {
        const fields = fieldsForPool(strategy, pool);
        if (!fields) continue;
        const settings = loadSettings(db, 'liquidity', pool.id);
        const open     = isOpen(facts, pool.id);
        const locked   = pool.rangeOverride?.locked === true;

        const entry = { poolId: pool.id, pair: pool.pair, poolType: pool.poolType,
                         hasOpenPosition: open, reverted: [], skipped: [], failed: [] };

        const partial = {};
        let rangeRevertTo   = null;
        let rangeCurrentVal = null;

        for (const path of Object.keys(fields)) {
            const row = latestHistoryRow(pool.id, path);
            const current = readCurrent(facts, pool, settings, path);
            const historyRow = row && {
                oldValue: JSON.parse(row.oldValue ?? 'null'),
                newValue: JSON.parse(row.newValue ?? 'null'),
                source:   row.source,
            };

            // Die Entscheidung selbst (Regel 1 + Regel 2 oben) liegt in lib/strategies.js —
            // reine Funktion, geprüft in bin/test-strategy-premium-rollback.js.
            const { action, to, kind, reason } = decideRollbackField(path, current, historyRow, {
                hasOpenPosition: open,
                rangeLocked:     locked,
                rangeWritable:   hasRangeSlot(pool),
            });

            if (action === 'none') continue;
            const item = { field: path, from: current, to, kind };
            if (action === 'skip') { entry.skipped.push({ ...item, reason }); continue; }

            if (path === RANGE_PATH) { rangeRevertTo = to; rangeCurrentVal = current; }
            else                     setPath(partial, path, to);
            entry.reverted.push(item);
        }

        if (!dryRun && entry.reverted.length) {
            try {
                if (Object.keys(partial).length) {
                    saveSettings(db, 'liquidity', pool.id, partial, { source: 'strategy' });
                }
                if (rangeRevertTo !== null) {
                    writeFixedPct(pool.id, rangeRevertTo);
                    recordSettingsHistory(db, 'liquidity', 'pool', pool.id,
                        { range: { fixedPct: rangeCurrentVal } }, { range: { fixedPct: rangeRevertTo } },
                        'strategy');
                }
            } catch (err) {
                entry.failed = entry.reverted.map(i => ({ ...i, reason: err.message }));
                entry.reverted = [];
            }
        }

        if (entry.reverted.length || entry.skipped.length || entry.failed.length) report.push(entry);
    }

    if (!dryRun) setActiveStrategy(db, null);

    const summary = {
        reverted: report.reduce((n, p) => n + p.reverted.length, 0),
        skipped:  report.reduce((n, p) => n + p.skipped.length,  0),
        failed:   report.reduce((n, p) => n + p.failed.length,   0),
    };
    return { strategyId, dryRun, pools: report, summary };
}

// ── Premium-Ende: Rücknahme (LIQ#0382, kehrt Entscheidung 6 um) ─────────────

/**
 * Fällt Premium weg, schaltet auf „Standard" zurück und nimmt die von der Strategie
 * geschriebenen Felder zurück. Die eigentliche Rücknahme (Feldsatz, vier
 * Sicherheitsregeln) liegt seit LIQ#0384 in `rollbackStrategyFields()` oben — hier nur
 * noch die zwei Auslöser-Prüfungen, die ausschließlich für den Premium-Wegfall gelten:
 *
 * 1. **Auslöser.** `isForkInstance() === false` (Master) → sofort zurück, nichts
 *    angefasst — geprüft als allererstes, unabhängig von allem Weiteren. Ausgelöst wird
 *    danach über `hasPremiumEntitlement() === false` (lib/premium-entitlement.js), also
 *    über die BERECHTIGUNG, nicht über den Autopay-Schalter.
 *
 *    🔒 LIQ#0388 — hier stand bis zum 04.09.2026 `isAutoPayEnabled() === false`, mit
 *    einer ausdrücklichen Begründung, die für einen ZAHLENDEN Fork stimmte und sonst
 *    für keinen: `premium_settings.enabled` beantwortet „zahlt dieser Host stündlich
 *    USDC?". `forge-pub1` ist über die Systemdaten-Freigabe berechtigt und zahlt seit
 *    dem 13.08.2026 nicht mehr (Wallet leergelaufen) — der alte Auslöser hätte dort
 *    eine berechtigte Strategie beim nächsten Cron-Tick zurückgesetzt. Autopay bleibt
 *    die URSACHE eines Berechtigungsendes (kein Zahlen → keine gedeckten Stunden mehr
 *    → Deckung läuft aus), nie das Kriterium.
 *
 *    `isOutagePaused()` bleibt weiterhin ausgeschlossen — jetzt ausdrücklich statt
 *    nebenbei: `decideEntitlement()` liefert bei einer erkannten Störung `entitled:
 *    true`, und eine ausgelaufene Deckung gilt erst nach `ENTITLEMENT_GRACE_MS` (72 h)
 *    als Berechtigungsende. Ohne diesen Nachlauf wäre der Auslöser ein Ausfall-Detektor.
 * 2. **Keine automatische Re-Aktivierung.** Kommt Premium zurück, bleibt „Standard"
 *    stehen — dieselbe Funktion wird dann gar nicht mehr aufgerufen (`strategyId` ist
 *    bereits `null`), sie enthält keinen Re-Apply-Pfad.
 *
 * Idempotent: Ein zweiter Aufruf sieht `strategyId === null` (Standard) und tut nichts.
 * Meldet sich im Message Center (`recordPremiumMessage`, Kommando
 * `premium-strategy-rollback`) — ein stiller Eingriff in Live-Kapital wäre genau das,
 * was FORGE sonst vermeidet. (Der Wechsel per UI auf „Standard", LIQ#0384, meldet sich
 * NICHT im Message Center — der Nutzer sieht die Rücknahme dort bereits im
 * Bestätigungsdialog, ein stiller Premium-Wegfall dagegen nicht.)
 *
 * @returns {{triggered: boolean, reason?: string, entitlement?: string, strategyId?: string,
 *            pools?: Array, summary?: {reverted: number, skipped: number, failed: number}}}
 *          `entitlement` ist der Grund aus `decideEntitlement()` — bei
 *          `triggered: false, reason: 'premium_active'` sagt er, WORAUS die Berechtigung
 *          stammt ('covered' | 'grace' | 'outage' | 'awaiting_first_delivery'), bei
 *          `triggered: true` warum sie endete ('expired' | 'never_activated').
 */
export function rollbackStrategyOnPremiumLoss() {
    if (!isForkInstance()) return { triggered: false, reason: 'master' };

    const db = openDb();
    try {
        const { strategyId } = getActiveStrategy(db);
        if (strategyId == null) return { triggered: false, reason: 'already_standard' };

        const entitlement = hasPremiumEntitlement();
        if (entitlement.entitled) return { triggered: false, reason: 'premium_active', entitlement: entitlement.reason };

        const result = rollbackStrategyFields(db, strategyId, { dryRun: false });

        recordPremiumMessage(JSON.stringify({
            cmd: 'premium-strategy-rollback', strategyId, entitlement: entitlement.reason,
            reverted: result.summary.reverted, skipped: result.summary.skipped, failed: result.summary.failed,
        }));

        return { triggered: true, entitlement: entitlement.reason, ...result };
    } finally {
        db.close();
    }
}

// ── Wechsel auf „Standard" (LIQ#0384, präzisiert Entscheidung 8) ────────────

/**
 * Wechselt auf „Standard" und nimmt dabei den Feldsatz der bisherigen Strategie zurück —
 * derselbe Endzustand, den `rollbackStrategyOnPremiumLoss()` beim Premium-Wegfall
 * herstellt, hier über `rollbackStrategyFields()` (LIQ#0382) wiederverwendet statt
 * nachgebaut. Damit gelten automatisch dieselben vier Sicherheitsregeln — insbesondere
 * die Asymmetrie: „Trailing Stop wieder an" auf einer offenen Position wird zurückgestellt
 * (`deferred_open_position`), nicht sofort scharf geschaltet.
 *
 * 🔒 `dryRun` ist der Default, dieselbe Begründung wie bei `applyStrategy()` — der Wechsel
 * schreibt auf Live-Kapital und gehört hinter dieselbe Bestätigung: Probelauf zeigen (UI:
 * `POST /api/strategy/standard/preview`), dann erst wirklich schreiben
 * (`POST /api/strategy/standard`).
 *
 * @param {{dryRun?: boolean}} opts
 * @returns {{triggered: boolean, reason?: string, strategyId?: string, dryRun?: boolean,
 *            pools?: Array, summary?: {reverted: number, skipped: number, failed: number}}}
 */
export function switchToStandard({ dryRun = true } = {}) {
    const db = openDb();
    try {
        const { strategyId } = getActiveStrategy(db);
        if (strategyId == null) return { triggered: false, reason: 'already_standard' };

        const result = rollbackStrategyFields(db, strategyId, { dryRun });
        return { triggered: true, ...result };
    } finally {
        db.close();
    }
}
