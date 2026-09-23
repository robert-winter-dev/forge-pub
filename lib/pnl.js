/**
 * ════════════════════════════════════════════════════════════════════════════
 *  FORGE – ZENTRALE PnL-BERECHNUNG · SINGLE SOURCE OF TRUTH
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  ⛔ OBERSTE REGEL ⛔
 *  ──────────────────
 *  PnL wird in ganz FORGE AUSSCHLIESSLICH über dieses Modul berechnet.
 *  KEIN Bot (Liquidity, LendingBot, künftige Bots) enthält eigene PnL-Mathematik
 *  oder eigene PnL-Datenbankabfragen. Jede solche Zeile ist ein BUG.
 *
 *  Grund: Der PnL ist der wichtigste Parameter von FORGE. Der Liquidity-Score basiert
 *  zu großen Teilen darauf, Nutzer bewerten das Gesamtergebnis fast ausschließlich
 *  über den PnL. Fehler hier haben katastrophale Folgewirkung. Die Berechnung wurde
 *  in der Vergangenheit mehrfach an verstreuten Stellen dupliziert und dabei
 *  immer wieder falsch reimplementiert. Deshalb: EINE Funktion, EINE Methodik,
 *  zentral getestet. Bots übergeben nur ihr `db`-Handle + Parameter.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  WAS IST PnL?
 * ────────────────────────────────────────────────────────────────────────────
 *  PnL = Veränderung des Positions-/Portfoliowerts, die NICHT aus externen
 *  Kapitalflüssen stammt. Ein- und Auszahlungen sind PnL-NEUTRAL:
 *
 *    • Zahlt der Nutzer 100 USDC ein, steigt der Wert um 100 — das ist KEIN Gewinn.
 *    • Hebt er 100 USDC ab, fällt der Wert um 100 — das ist KEIN Verlust.
 *
 *  PnL entsteht nur durch: Kursänderung der Position (inkl. Impermanent Loss)
 *  + verdiente Fees/Zinsen.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  DAS GEMEINSAME MODELL – DREI EINGABEN PRO BOT
 * ────────────────────────────────────────────────────────────────────────────
 *  Jeder Bot wird über einen "flavor"-Adapter (siehe ADAPTERS) auf drei
 *  Datenquellen reduziert:
 *
 *    1. WERT-ZEITREIHE   value(t)  – der aktuelle Positions-/Portfoliowert
 *         Liquidity:   position_snapshots.lp_value_usd + fees_pending_usd  (pro Pool)
 *                      — inkl. position_snapshots_archive, siehe _snapshotSource()
 *         LendingBot:  portfolio_history.total_value                       (gesamt)
 *
 *    2. EXTERNE KAPITALFLÜSSE  cashflow(t)  – echtes Wallet↔Position-Kapital
 *         (+) Einzahlung, (−) Auszahlung. PnL-NEUTRAL: wird aus value() herausgerechnet.
 *         Liquidity:   transactions deposit/withdraw/withdraw_full
 *         LendingBot:  transactions deposit/withdraw
 *
 *    4. REALISIERTER AUSSTIEGSERLÖS  exitProceeds(t)  – optional, nur Liquidity.
 *         Was ein Auto-Exit (trailing-stop / tvl-schutz / score-limit) beim Verkauf
 *         TATSÄCHLICH eingebracht hat (capital_flows). Ersetzt beim Session-Close den
 *         Snapshot-Schätzwert, siehe Adapter-Kommentar bei exitProceeds().
 *
 *    3. ABGEFLOSSENE ERTRÄGE  earningsOut(t)  – verdiente Erträge die die Position
 *         VERLASSEN haben (z.B. Fee-Claim aufs Wallet statt Reinvest). Diese fehlen
 *         in value(), sind aber echter Gewinn → müssen zum PnL ADDIERT werden.
 *         Liquidity:   SUM(claim) − SUM(reinvest)
 *         LendingBot:  Fee-Transfer aufs Wallet  → HEUTE 0 (siehe Adapter-Hinweis!)
 *
 *  ⚠️  LendingBot-FALLE (vom Nutzer explizit benannt): Sobald wieder Fee-Einnahmen
 *      automatisiert aufs Wallet übertragen werden, MUSS dieser Transfer als
 *      earningsOut (Eingabe 3) erfasst werden — NICHT als externe Auszahlung
 *      (Eingabe 2). Andernfalls verschwindet echter Gewinn aus dem PnL. Der
 *      Adapter erwartet dafür eine eigene, von 'withdraw' unterscheidbare Markierung.
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  DIE METHODIK – ROLLENDER KAPITAL-ANKER ("cap")
 * ────────────────────────────────────────────────────────────────────────────
 *  Pro Position-Session (Liquidity: open→close; LendingBot: eine durchgehende Session)
 *  wird ein Kapital-Anker `cap` geführt:
 *
 *      cap startet beim Einstandskapital der Session (Liquidity: Open-Wert;
 *      LendingBot: 0, die Erst-Einzahlung kommt als cashflow rein) und wird bei
 *      JEDEM externen Kapitalfluss mitgezogen:  cap += cashflow.
 *
 *      unrealized(t) = value(t) − cap          (cashflow-neutral, da cap mitwandert)
 *      pnl(t)        = cumRealized + unrealized(t)
 *
 *  Bei Position-Close wird der letzte unrealized als realisiert eingefroren:
 *      cumRealized += unrealized(close)
 *
 *  Liegt für den Close ein realisierter Ausstiegserlös vor (Eingabe 4), zählt dieser
 *  statt des Snapshot-Werts:  unrealized(close) = exitProceeds − cap.
 *
 *  REBALANCE-KETTEN (LIQ#000865, Liquidity): Setzt eine Position per Rebalance die
 *  vorherige fort, wird cap WEITERGETRAGEN statt neu auf den Eröffnungswert gesetzt, beim
 *  Rebalance nichts realisiert, und Reconcile/Sweep/Verschiebung-Nachzahlung sind kein
 *  cashflow (eigenes Geld der Kette, gedeckelt auf das Freigesetzte). Der Rest der Kette im
 *  Wallet (Verschiebungs-Bilanz) zählt zum Wert:
 *      unrealized(t) = value(t) + walletRest(t) − cap
 *  Rebalance-Kosten werden so zu Verlust statt zu einer stillen Auszahlung. Übergänge
 *  außerhalb eines Plausibilitätsbands (Datenlöcher) trennen die Kette wie früher.
 *  Warum und Belege: KB Liquidity Bot/pnl-rebalance-kette.md.
 *
 *  Daraus ergibt sich eine durchgehende, cashflow-bereinigte PnL-Kurve pnl(t).
 *  JEDER Zeitraum-PnL ist dann nur noch eine Differenz auf dieser Kurve:
 *
 *      pnl(zeitraum) = pnl(t_ende) − pnl(t_start) + earningsOut(zeitraum)
 *
 *  Diese EINE Primitive (pnlForPeriod) speist alles: Heute, rollierende 24h,
 *  Kalendertag (pnl_daily), 6h/12h-Fenster der Opportunity-Tabelle, pro-Pool-PnL.
 *  Dadurch sind alle Anzeigen GARANTIERT konsistent.
 *
 *  SPIKE-SCHUTZ (Transient-Filter): Snapshots in den ersten 60 s nach Open und im
 *  ±60 s-Fenster um jeden Kapitalfluss werden verworfen (Timestamp-Drift zwischen
 *  Snapshot und Transaktion würde sonst Phantom-Sprünge erzeugen).
 *
 * ────────────────────────────────────────────────────────────────────────────
 *  ÖFFENTLICHE API
 * ────────────────────────────────────────────────────────────────────────────
 *    computePnlHistory(db, {flavor, now?, historyWindowMs?})
 *        → vollständiges Bündel: pnlHistory-Kurve, latestPnlByScope, 1d/7d-Metriken,
 *          Fees-Maps. Für Dashboard-Export + Pool-Explorer.
 *
 *    pnlForPeriod(db, {flavor, scope?, fromMs, toMs?})
 *        → eine Zahl (USDC). scope weglassen = Portfolio (Summe aller Pools),
 *          oder scope='<poolId/botId>' für einen einzelnen Scope.
 *          Deckt ab: Heute (fromMs=Tagesstart), rollierend 24h, Kalendertag.
 *
 *    feeLegForPeriod(db, {flavor, scope?, fromMs, toMs?})
 *        → eine Zahl (USDC), Signatur identisch zu pnlForPeriod: der Anteil des PnL,
 *          der aus vereinnahmten Handelsgebühren stammt (nie negativ). Preis-Leg ist
 *          keine eigene Funktion, sondern der Rest: pnlForPeriod(...) − feeLegForPeriod(...).
 *          Nur für flavor='liquidity' implementiert (fee_history/fees_pending_usd sind
 *          liquidity-spezifisch) — andere flavors liefern null (nicht unterstützt).
 *
 *    pnlByScopeForPeriod(db, {flavor, fromMs, toMs?})
 *        → { scopeId: pnlUsd } für denselben Zeitraum (z.B. Tooltip "Anteil").
 *
 *    pnlPeakForPeriod(db, {flavor, scope, fromMs, toMs?})
 *        → { pnlUsd, atMs } historischer Höchststand EINES Scopes im Zeitraum
 *          (z.B. Tooltip-Zeile "Hoch" – wo stand der Trailing-Stop-Bezugspunkt?).
 *
 *    capitalFlowsForPeriod(db, {flavor, scope, fromMs, toMs?})
 *        → eingesetztes Kapital im Zeitraum (Eröffnung + Einzahlungen − Auszahlungen),
 *          exakt die Menge, gegen die der PnL rechnet (Karte „Ein-/Auszahlungen").
 *
 *    pnlBreakdownForPeriod(db, {flavor, scope, fromMs, toMs?})
 *        → Überleitung Eingezahlt → Wert heute: Gebühren, Kursentwicklung (HODL 50/50),
 *          IL/Rebalancing als Rest, Aufschlüsselung Wert heute (Reiter „Details", LIQ#000867).
 *          toMs für abgeschlossene Ketten (LP gegen Halten, LIQ#000869).
 *
 *    pnlWindows(db, {flavor, windows, now?})
 *        → pro Scope ein { windowId: pnlUsd } (Opportunity-Tabelle 6h/12h/…).
 *
 *    lpValueAt(db, {flavor, ts})
 *        → Positions-/Portfoliowert (Summe) zum Zeitpunkt ts (für lp_close etc.).
 *
 *  Alle Funktionen sind reine Lese-Operationen (nur SELECT).
 * ════════════════════════════════════════════════════════════════════════════
 */

const _MIN_MS = 60 * 1000;
const _24H_MS = 24 * 3600 * 1000;
const _7D_MS  =  7 * 24 * 3600 * 1000;
const _30D_MS = 30 * 24 * 3600 * 1000;

// Teardown-Schutz: Snapshots, deren Wert unter diesem Anteil des Kapital-Ankers
// (cap) liegt, sind Rebalance-Artefakte — während eines Rebalance wird die
// Liquidität kurz abgezogen (value → ~0), aber als 'close_position'/'rebalance'
// gebucht, NICHT als 'withdraw'. Dadurch sinkt cap nicht mit, und ein solcher
// Snapshot würde beim nächsten Close als Phantom-Verlust eingefroren.
// 5 %: Eine LP-/Lending-Position kann nicht in einem Snapshot-Intervall 95 %
// gegenüber ihrem Kapital verlieren — so ein Wert ist immer ein Artefakt.
// Wichtig: Echte Ein-/Auszahlungen lösen dies NICHT aus, weil cap mit dem
// Cashflow mitgezogen wird (value und cap fallen/steigen gemeinsam).
const _TEARDOWN_FRAC = 0.05;

// Zuordnungsfenster Session-Close → Auto-Exit-Erlös in capital_flows. Der Erlös wird
// erst nach dem Verkaufs-Swap gebucht (beobachtet: wenige Sekunden nach dem Close),
// bei den State-Machine-Exits kann ein Resume-Schritt dazwischenliegen. Die Zuordnung
// endet zusätzlich hart am Start der nächsten Session, damit nie ein fremder Exit trifft.
const _EXIT_MATCH_MS = 30 * 60 * 1000;

// Plausibilitätsband für den Auto-Exit-Erlös gegenüber dem letzten Snapshot-Wert.
// Der Override soll Swap-Slippage und kurze Kursdrift abbilden (beobachtet: < 1 %),
// nicht eine Neubewertung der Position. 10 % lassen auch einen volatilen Memecoin-Exit
// zwischen Snapshot und Swap durch, fangen aber Datenlücken sicher ab.
const _EXIT_MAX_DEVIATION = 0.10;

// Höchstabstand Auslösen → Erlösbuchung, um einen Auto-Exit-Erlös seiner Trailing-Stop-
// Ausführung zuzuordnen (LIQ#000894). Beobachtet bis 31 min (ORCA/SOL 10.08.2026, Swap-Retry).
const _EXIT_TRIGGER_MS = 2 * 3600 * 1000;

// Einzahlungen, mit denen der Bot Kapital wieder einsetzt, das ein Rebalance derselben Kette
// selbst freigesetzt hat (LIQ#000865). Budget jeweils hart auf das Freigesetzte bzw. die
// Verschiebungs-Bilanz gedeckelt (bots/liquidity/bin/bot.js: _reconcileWalletIntoPosition,
// Residual-Sweep, _shiftTopUpIfDue) — also nie fremdes Geld. 'Auto-Top-Up …' ist der
// Vorgänger des Residual-Sweeps (Altdaten).
const _INTERNAL_DEPOSIT_SQL = `(note LIKE 'Reconcile iter %'
    OR note IN ('Verschiebung-Nachzahlung', 'Residual-Sweep nach Rebalance',
                'Auto-Top-Up nach Rebalance (Idle-Wallet)'))`;

// Fee-Claims, die als abgeflossener Ertrag zählen: alle außer dem Claim direkt vor einem
// Rebalance (siehe earningsOut() im liquidity-Adapter).
const _CLAIM_COUNTS_SQL = `COALESCE(note, '') != 'vor-rebalance'`;

// Plausibilitätsband einer Ketten-Fortsetzung (LIQ#000865): Eröffnungswert der neuen Position
// relativ zum Close-Wert der alten. Gemessen über 304 Rebalances auf Master: 273 liegen unter
// 10 % Abweichung; die Ausreißer sind Datenlöcher der Frühzeit (Close 0,00 USD, Neueröffnung
// mit 0,02 USD, weil das Geld per Cleanup in einen anderen Pool ging). Außerhalb des Bands wird
// wie früher realisiert und neu begonnen — sonst würde das Loch als Phantom-Verlust/-Gewinn in
// voller Positionshöhe eingefroren.
const _CHAIN_MIN_RATIO = 0.8;
const _CHAIN_MAX_RATIO = 1.25;
// Zeitfenster nach dem Open, in dem Reconcile/Residual-Sweep zum Neueinstieg zählen.
const _CHAIN_REFILL_MS = 15 * 60 * 1000;
// Auflösung der Delta-Zeitreihe (edgeSeries in pnlBreakdownForPeriod, LIQ#000891).
const _EDGE_SERIES_BUCKET_MS = 10 * 60 * 1000;

// HODL-Vergleich (LIQ#000867): Ein Kurs aus pool_stats gilt für einen Zeitpunkt nur, wenn der
// Messpunkt höchstens so alt ist (dieselbe Lücke wie _quoteUsdAt() in bin/export.js).
const _PRICE_MAX_AGE_MS = 90 * 60 * 1000;
const _USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const _tableCache = new WeakMap();
function _hasTable(db, name) {
    if (!_tableCache.has(db)) _tableCache.set(db, new Map());
    const m = _tableCache.get(db);
    if (!m.has(name)) {
        m.set(name, !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
    }
    return m.get(name);
}

function _hasColumns(db, table, cols) {
    const key = `cols:${table}`;
    if (!_tableCache.has(db)) _tableCache.set(db, new Map());
    const m = _tableCache.get(db);
    if (!m.has(key)) m.set(key, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)));
    return cols.every(c => m.get(key).has(c));
}

const round2 = n => Math.round(n * 100) / 100;

/**
 * Wert-Quelle des liquidity-Adapters: `position_snapshots` PLUS das Archiv.
 *
 * 🔒 Warum das Archiv mitgelesen werden MUSS (Befund 2026-08-23, LIQ#0311):
 * `clearPositionSnapshots()` (bots/liquidity/lib/db.js) räumt die Wertreihe eines Pools bei
 * jedem Reopen ab — bei stündlichem Cleanup also laufend. Seit Ticket #0313 werden die Zeilen
 * dabei nach `position_snapshots_archive` kopiert statt gelöscht, gelesen hat sie aber niemand.
 * Folge hier: Eine geschlossene Session ohne verbliebenen Snapshot durchläuft `_buildCurves()`
 * mit `lastUnrealized = 0` — ihr Ergebnis wird als GENAU NULL realisiert, und weil auch
 * `lastSnapValue` null bleibt, greift zusätzlich der Ausstiegserlös-Override nicht. Gemessen
 * am 2026-08-23: 70 von 83 Auto-Exits hatten keinen Snapshot mehr, der ausgewiesene
 * Gesamt-PnL lag dadurch um 61,42 USDC zu HOCH (Beispiel `liq-fartcoin-sol`: −0,71 statt
 * −37,70 — vier Sessions mit real gemessenen Erlösen, alle als ±0 gebucht).
 *
 * Das Archiv ist eine Kopie der gelöschten Zeilen (`INSERT OR IGNORE` auf `src_id`), also
 * überschneidungsfrei; `MAX(value)` je `recorded_at` deckt den Fall ab, dass eine Zeile
 * archiviert, aber noch nicht gelöscht wurde.
 *
 * Der Bot selbst liest weiterhin ausschließlich `position_snapshots` — das ist Absicht und
 * darf nicht angeglichen werden: `_openingSnapshotMax()` würde sonst alte Reihen in den
 * Höchststand der neuen Position ziehen und einen Sofort-Fehl-Exit auslösen (#0313).
 *
 * Ältere Installationen und Forks ohne die Tabelle fallen auf die reine Live-Quelle zurück.
 */
const _archiveCache = new WeakMap();

/**
 * Wert-Quelle für die Fee-Leg-Zerlegung (LIQ#0360): reine `fees_pending_usd`-Reihe,
 * OHNE `lp_value_usd` — im Unterschied zu `_snapshotSource()` oben, das beides zu
 * einem kombinierten Positionswert addiert. Braucht denselben Archiv-Fallback aus
 * demselben Grund (LIQ#0311, siehe Kommentar bei `_snapshotSource()`): eine Position
 * ohne verbliebenen Snapshot in `position_snapshots` hätte sonst am Close-Zeitpunkt
 * keinen `fees_pending_usd`-Wert mehr, und genau der wird beim Close gebraucht, um
 * die dort noch offenen Gebühren dem Fee-Leg statt dem Preis-Leg zuzuschlagen.
 */
const _pendingArchiveCache = new WeakMap();

function _pendingFeesSource(db) {
    if (!_pendingArchiveCache.has(db)) {
        const hasArchive = !!db.prepare(
            `SELECT 1 FROM sqlite_master WHERE type='table' AND name='position_snapshots_archive'`
        ).get();
        const live = `SELECT pool_id, recorded_at, fees_pending_usd AS value
                        FROM position_snapshots WHERE fees_pending_usd IS NOT NULL`;
        _pendingArchiveCache.set(db, hasArchive
            ? `${live}
               UNION ALL
               SELECT pool_id, recorded_at, fees_pending_usd AS value
                 FROM position_snapshots_archive WHERE fees_pending_usd IS NOT NULL`
            : live);
    }
    return _pendingArchiveCache.get(db);
}

function _snapshotSource(db) {
    if (!_archiveCache.has(db)) {
        const hasArchive = !!db.prepare(
            `SELECT 1 FROM sqlite_master WHERE type='table' AND name='position_snapshots_archive'`
        ).get();
        const live = `SELECT pool_id, recorded_at, lp_value_usd + fees_pending_usd AS value
                        FROM position_snapshots WHERE lp_value_usd IS NOT NULL`;
        _archiveCache.set(db, hasArchive
            ? `${live}
               UNION ALL
               SELECT pool_id, recorded_at, lp_value_usd + fees_pending_usd AS value
                 FROM position_snapshots_archive WHERE lp_value_usd IS NOT NULL`
            : live);
    }
    return _archiveCache.get(db);
}

// ════════════════════════════════════════════════════════════════════════════
//  FLAVOR-ADAPTER
//  Kapseln das bot-spezifische DB-Schema. NUR hier stehen SQL-Strings.
//  Jeder Adapter liefert die drei Modell-Eingaben + Hilfsabfragen.
// ════════════════════════════════════════════════════════════════════════════

const ADAPTERS = {
    // ── Liquidity – Liquidity Mining (Orca CLMM), ein Scope pro Pool ─────────
    liquidity: {
        /** Alle Scopes (= Pool-IDs) mit Positions-Historie. */
        scopes(db) {
            return db.prepare(`SELECT DISTINCT pool_id AS id FROM positions ORDER BY pool_id`)
                     .all().map(r => r.id);
        },

        /**
         * Position-Sessions je Scope: [{start, end, openValue}].
         * openValue = USD-Einstand beim Öffnen (open_tx-Wert, Fallback capital_usdc).
         *
         * openValue === null bedeutet ausdrücklich "Einstand UNBEKANNT" (siehe unten) —
         * nicht "0". Der Unterschied ist sicherheitskritisch: 0 würde bedeuten, dass der
         * gesamte Positionswert Gewinn ist. Der lendingbot-Adapter nutzt bewusst die
         * echte 0 als Startanker (Erst-Einzahlung kommt dort als cashflow) — deshalb ist
         * null das Sentinel und nicht 0.
         */
        sessions(db, scopeId) {
            const positions = db.prepare(`
                SELECT id, opened_at, closed_at, capital_usdc, open_tx, close_tx
                FROM positions WHERE pool_id = ? ORDER BY opened_at ASC
            `).all(scopeId);
            const hasRebHist = _hasTable(db, 'rebalance_history');
            const rebLinked = hasRebHist
                ? db.prepare(`SELECT 1 FROM rebalance_history WHERE new_position_id = ? LIMIT 1`)
                : null;
            const rebClose = db.prepare(`
                SELECT 1 FROM transactions
                 WHERE pool_id = ? AND type = 'close_position' AND note = 'rebalance'
                   AND created_at BETWEEN ? AND ?
                 LIMIT 1
            `);
            // tx_hash IS NOT NULL ist Pflicht: Positionen ohne TX-Hash würden sonst
            // alle den Map-Key null besetzen und sich gegenseitig vergiften.
            const openValByTx = {};
            for (const r of db.prepare(`
                SELECT tx_hash, usd_value FROM transactions
                 WHERE type IN ('open_position','rebalance')
                   AND usd_value IS NOT NULL AND tx_hash IS NOT NULL
            `).all()) openValByTx[r.tx_hash] = r.usd_value;
            const closeValQ = db.prepare(`
                SELECT usd_value FROM transactions
                 WHERE tx_hash = ? AND type = 'close_position' AND usd_value IS NOT NULL LIMIT 1
            `);

            return positions.map((p, i) => {
                // Fortsetzung einer Rebalance-Kette (LIQ#000865)? Dieselbe Definition wie
                // chainStartOpenedAt() in bots/liquidity/lib/pnl-anchor.js: rebalance_history
                // verweist auf diese Position, ODER der direkte Vorgänger wurde per Rebalance
                // geschlossen und das Neu-Öffnen kam erst im nächsten Tick (LIQ#000803).
                const prev = i > 0 ? positions[i - 1] : null;
                const continuesPrev = prev != null && prev.closed_at != null
                    && prev.closed_at <= p.opened_at
                    && (!!rebLinked?.get(p.id)
                        || !!rebClose.get(scopeId, prev.closed_at - 120000, prev.closed_at + 120000));
                // Einstand: TX-Wert bevorzugt, dann capital_usdc. Ein nicht-positiver
                // oder fehlender Wert ist KEIN Einstand von 0, sondern ein unbekannter
                // Einstand — z.B. bei einer aus der Chain rekonstruierten Position, deren
                // Preis beim Adoptieren noch nicht verfügbar war (reconcilePositions).
                // Früher lief das über `?? 0` und machte den vollen Positionswert zu
                // Gewinn (Fund forge-pub1 2026-07-27: +90 USDC Phantom-PnL).
                const raw = (p.open_tx != null ? openValByTx[p.open_tx] : undefined)
                            ?? p.capital_usdc;
                return {
                    start:     p.opened_at,
                    end:       p.closed_at,                                // null = noch offen
                    openValue: Number.isFinite(raw) && raw > 0 ? raw : null,
                    // Erlös des Close laut close_position-TX (null = unbekannt). Nur für die
                    // Plausibilitätsprüfung einer Ketten-Fortsetzung, siehe _buildCurves().
                    closeValue: p.close_tx != null ? (closeValQ.get(p.close_tx)?.usd_value ?? null) : null,
                    continuesPrev,
                };
            });
        },

        /** Wert-Zeitreihe value(t) = lp_value_usd + fees_pending_usd, aufsteigend. */
        valueSeries(db, scopeId) {
            return db.prepare(`
                SELECT recorded_at AS t, MAX(value) AS value
                  FROM (${_snapshotSource(db)})
                 WHERE pool_id = ?
                 GROUP BY recorded_at
                 ORDER BY recorded_at ASC
            `).all(scopeId);
        },

        /**
         * Externe Kapitalflüsse (+ Ein, − Aus), aufsteigend.
         * Quelle = transactions deposit/withdraw/withdraw_full. Begründung:
         *   • Die Open-Einzahlung (type 'open_position') ist KEIN cashflow, sondern
         *     der openValue der Session → hier ausgeschlossen, kein Doppelzählen.
         *   • Auto-Exits (trailing-stop, tvl-schutz) sind volle CLOSES → über die
         *     Session-Grenze (sess.end) + cumRealized abgebildet, NICHT als cashflow.
         *   • Nur echte Teil-Ein/-Auszahlungen einer offenen Session zählen als
         *     cashflow — und die schreibt der Bot in transactions.
         * (Identische Quelle wie die bisher als korrekt bestätigte pnl-history-Kurve.)
         *
         * `internal` (LIQ#000865) markiert Einzahlungen, mit denen der Bot Kapital wieder
         * einsetzt, das ein Rebalance derselben Kette selbst freigesetzt hat: Reconcile,
         * Residual-Sweep, Verschiebung-Nachzahlung. Innerhalb einer fortgesetzten Kette sind
         * sie KEIN Kapitalfluss (das Kapital steckt schon im weitergetragenen cap), siehe
         * _buildCurves(). Außerhalb (z.B. Reconcile nach manuellem close-and-reopen) zählen
         * sie wie bisher.
         */
        cashflows(db, scopeId) {
            return db.prepare(`
                SELECT created_at AS t,
                       CASE WHEN type = 'deposit' THEN usd_value ELSE -usd_value END AS amount,
                       CASE WHEN type = 'deposit' AND ${_INTERNAL_DEPOSIT_SQL} THEN 1 ELSE 0 END AS internal
                  FROM transactions
                 WHERE pool_id = ? AND type IN ('deposit','withdraw','withdraw_full')
                   AND usd_value IS NOT NULL
                 ORDER BY created_at ASC
            `).all(scopeId).map(r => ({ t: r.t, amount: r.amount, internal: r.internal === 1 }));
        },

        /**
         * Rest einer Rebalance-Kette im Wallet als Ereignisse (LIQ#000865): + Rest nach einem
         * Rebalance (rebalance_history.leftover_usdc, erst ab Go-Live-Marker) und + Startwert
         * ('seed'), − Nachzahlung ('settle'). Dieselben Quellen und Regeln wie
         * getShiftBalanceUsd() in bots/liquidity/lib/rebalance-shift.js — der Rest ist Geld
         * des Pools, nur eben nicht in der Position. _buildCurves() summiert ab Kettenstart
         * und begrenzt auf ≥ 0.
         */
        walletRestEvents(db, scopeId) {
            if (!_hasTable(db, 'rebalance_shift_ledger') || !_hasTable(db, 'rebalance_history')) return [];
            const goLive = db.prepare(
                `SELECT MIN(created_at) AS t FROM rebalance_shift_ledger WHERE kind = 'start'`).get()?.t;
            if (goLive == null) return [];
            return db.prepare(`
                SELECT rebalanced_at AS t, leftover_usdc AS amount, 'leftover' AS kind
                  FROM rebalance_history
                 WHERE pool_id = ? AND rebalanced_at >= ? AND leftover_usdc > 0
                UNION ALL
                SELECT created_at AS t, CASE WHEN kind = 'seed' THEN usdc ELSE -usdc END AS amount, kind
                  FROM rebalance_shift_ledger
                 WHERE pool_id = ? AND kind IN ('seed','settle') AND usdc IS NOT NULL
                 ORDER BY t ASC
            `).all(scopeId, goLive, scopeId);
        },

        /**
         * Tatsächlich realisierter Ausstiegserlös je Auto-Exit, aufsteigend.
         *
         * Ein Auto-Exit (trailing-stop, tvl-schutz, score-limit) verkauft die Position
         * on-chain; erst nach dem Swap steht fest, was wirklich ankam. Die close_position-
         * Zeile in `transactions` entsteht VOR dem Swap und trägt deshalb usd_value = NULL
         * (exit-finalizer.js), der Erlös landet stattdessen in capital_flows.
         *
         * Ohne diese Quelle bewertete der Session-Close mit dem letzten Snapshot davor —
         * einem Preis-Schätzwert ohne Swap-Slippage und ohne die Kursbewegung zwischen
         * Snapshot und Verkauf. Befund 22.08.2026 liq-zec-usdc: Snapshot 761,93 USD gegen
         * real 754,91 USDC = 7,01 USDC Phantom-Gewinn, der beim Close als "realisiert"
         * eingefroren wurde. Gegengeprüft an weiteren Exits desselben Tages (liq-trump-sol
         * −1,38 / liq-sol-zec +1,33 / liq-cbtc-sol +1,02) — die Abweichung geht in beide
         * Richtungen, ist also keine Konstante die sich wegkürzt.
         *
         * `triggerUsd` = Positionswert beim Auslösen desselben Exits (ts_executions.current_usd,
         * LIQ#000894), sonst null. Vergleichswert für Sessions ohne verwerteten Snapshot: Dort
         * gab es bisher nichts, woran sich ein einseitig gebuchter Erlös hätte messen lassen
         * (SOL/cbBTC 24.07.2026: 872,64 statt 974,59, nur die SOL-Seite verkauft). Zuordnung:
         * jüngste Ausführung desselben Pools, ausgelöst vor der Buchung und höchstens
         * _EXIT_TRIGGER_MS davor. TVL-/Score-Limit-Exits führen keinen Wert beim Auslösen.
         */
        exitProceeds(db, scopeId) {
            const tsCol = (col) => _hasTable(db, 'ts_executions')
                ? `CASE WHEN note = 'trailing-stop-exit' THEN (
                       SELECT e.${col} FROM ts_executions e
                        WHERE e.pool_id = capital_flows.pool_id
                          AND e.triggered_at <= capital_flows.created_at
                          AND e.triggered_at >= capital_flows.created_at - ${_EXIT_TRIGGER_MS}
                        ORDER BY e.triggered_at DESC LIMIT 1) END`
                : 'NULL';
            return db.prepare(`
                SELECT created_at AS t, -usdc_amount AS usd,
                       ${tsCol('current_usd')} AS triggerUsd, ${tsCol('triggered_at')} AS triggerT
                  FROM capital_flows
                 WHERE pool_id = ? AND is_external = 1
                   AND note IN ('trailing-stop-exit','tvl-protection-exit','score-limit-exit')
                 ORDER BY created_at ASC
            `).all(scopeId);
        },

        /**
         * Abgeflossene Erträge im Zeitraum = SUM(claim) − SUM(reinvest).
         * Reinvestierte Fees bleiben in value() → nur der echte Wallet-Abfluss zählt.
         *
         * ADDITIV: Gerechnet wird als Differenz zweier KUMULATIVER Stände
         * (jeweils ab Beginn der Historie bis zum Zeitpunkt, dort auf ≥ 0 geklemmt) —
         * nicht als geklemmte Fenstersumme.
         *
         * Warum (Befund 2026-08-12): `Math.max(0, claim − reinvest)` je Fenster
         * greift bei täglicher Aggregation an JEDEM Tag einzeln, über einen Monat
         * aber nur einmal. Dadurch war Σ(Tageswerte) ≠ Zeitraumwert — für den
         * August 2026 wies das Liquidity-Dashboard 190,01 USDC aus (Summe aus
         * pnl_daily), die Übersichtsseite 97,83 USDC (Kurvendifferenz), obwohl
         * beide dieselbe Lib benutzten. Über die kumulative Differenz teleskopiert
         * die Summe aufeinanderfolgender Fenster exakt zum Gesamtzeitraum.
         *
         * 🔒 Claims mit note='vor-rebalance' zählen NICHT (LIQ#000865): Der Bot holt die Fees
         * direkt vor dem Schließen ab, sie gehen mit dem freigesetzten Kapital in die neue
         * Position und stehen damit schon im Positionswert. Als Ertrag gezählt, kamen sie
         * doppelt in den PnL (einmal über fees_pending im Snapshot bzw. den neuen
         * Positionswert, einmal hier) — USELESS/SOL 09.–21.09.2026: 17 solche Claims.
         *
         * Die Klemme bleibt sinnvoll: Sie verhindert, dass ein Reinvest von zuvor
         * geclaimten Fees als negativer Ertrag zählt. Kumulativ greift sie nur,
         * solange insgesamt mehr reinvestiert als geclaimt wurde — ein Zustand,
         * der sich mit dem nächsten Claim von selbst auflöst.
         */
        earningsOut(db, scopeId, fromMs, toMs) {
            const where = scopeId != null ? 'pool_id = ? AND ' : '';
            const cumAt = (t) => {
                const args = [...(scopeId != null ? [scopeId] : []), t];
                const claimed = db.prepare(
                    `SELECT COALESCE(SUM(usd_value),0) AS t FROM transactions
                      WHERE ${where}type='claim' AND ${_CLAIM_COUNTS_SQL} AND created_at < ?`).get(...args).t;
                const reinv = db.prepare(
                    `SELECT COALESCE(SUM(usd_value),0) AS t FROM transactions
                      WHERE ${where}type='reinvest' AND created_at < ?`).get(...args).t;
                return Math.max(0, claimed - reinv);
            };
            return cumAt(toMs ?? Date.now()) - cumAt(fromMs);
        },

        /**
         * earningsOut(fromMs, t) als Stufenfunktion, für die Peak-Suche
         * (pnlPeakForPeriod): ein Eintrag je Claim/Reinvest-Event im Fenster,
         * dazwischen bleibt der Wert konstant. Dieselbe kumulative Klemm-Logik
         * wie earningsOut() oben, aber ohne pro Kurvenpunkt neu zu fragen —
         * ein Pool kann hunderte Snapshot-Punkte im Fenster haben, Claims/
         * Reinvests sind dagegen selten.
         */
        earningsOutCurve(db, scopeId, fromMs, toMs) {
            const where = scopeId != null ? 'pool_id = ? AND ' : '';
            const baseArgs = [...(scopeId != null ? [scopeId] : []), fromMs];
            const baseClaimed = db.prepare(
                `SELECT COALESCE(SUM(usd_value),0) AS t FROM transactions
                  WHERE ${where}type='claim' AND ${_CLAIM_COUNTS_SQL} AND created_at < ?`).get(...baseArgs).t;
            const baseReinv = db.prepare(
                `SELECT COALESCE(SUM(usd_value),0) AS t FROM transactions
                  WHERE ${where}type='reinvest' AND created_at < ?`).get(...baseArgs).t;
            const baseline = Math.max(0, baseClaimed - baseReinv);

            const eventArgs = [...(scopeId != null ? [scopeId] : []), fromMs, toMs];
            const events = db.prepare(`
                SELECT created_at AS t, type, usd_value AS v FROM transactions
                 WHERE ${where}(type = 'reinvest' OR (type = 'claim' AND ${_CLAIM_COUNTS_SQL}))
                   AND usd_value IS NOT NULL
                   AND created_at >= ? AND created_at <= ?
                 ORDER BY created_at ASC
            `).all(...eventArgs);

            let claimed = baseClaimed, reinv = baseReinv;
            const curve = [];
            for (const e of events) {
                if (e.type === 'claim') claimed += e.v; else reinv += e.v;
                curve.push({ t: e.t, value: Math.max(0, claimed - reinv) - baseline });
            }
            return curve;
        },

        /** Aktueller Gesamtwert: Summe der jüngsten Snapshots offener Positionen. */
        currentValue(db) {
            return db.prepare(`
                SELECT COALESCE(SUM(ps.lp_value_usd + ps.fees_pending_usd), 0) AS total
                FROM position_snapshots ps
                INNER JOIN (SELECT pool_id, MAX(recorded_at) AS mx FROM position_snapshots GROUP BY pool_id) l
                        ON ps.pool_id = l.pool_id AND ps.recorded_at = l.mx
                INNER JOIN positions p ON ps.pool_id = p.pool_id AND p.closed_at IS NULL
            `).get().total;
        },

        /** Gesamtwert zum Zeitpunkt ts (null wenn keine offene Position vorhanden). */
        valueAt(db, ts) {
            const src = _snapshotSource(db);
            const row = db.prepare(`
                SELECT COALESCE(SUM(ps.value), 0) AS total, COUNT(*) AS cnt
                FROM (${src}) ps
                INNER JOIN (SELECT pool_id, MAX(recorded_at) AS mx FROM (${src})
                            WHERE recorded_at <= ? GROUP BY pool_id) l
                        ON ps.pool_id = l.pool_id AND ps.recorded_at = l.mx
                WHERE EXISTS (SELECT 1 FROM positions p WHERE p.pool_id = ps.pool_id
                              AND p.opened_at <= ? AND (p.closed_at IS NULL OR p.closed_at > ?))
            `).get(ts, ts, ts);
            return row.cnt > 0 ? row.total : null;
        },

        /**
         * Alle Fee-Claim-Ereignisse (LIQ#0360-Fee-Leg), aufsteigend. Ein Eintrag je
         * `collectFees()`-Aufruf, unabhängig davon ob `action` 'reinvest' oder 'transfer'
         * war — Reinvest bleibt zwar in value() stecken, ist aber trotzdem vereinnahmte
         * Gebühr und gehört ins Fee-Leg, nicht ins Preis-Leg.
         *
         * `usd = 0` bei NULL `usd_value` (bekannte Lücke: `close-and-reopen.js` schreibt
         * beim manuellen Reopen eine Zeile ohne USD-Wert) — das Claim-EREIGNIS selbst zählt
         * trotzdem (siehe `_buildFeeLegCurves()`: setzt den laufenden Pending-Zähler zurück
         * auf 0, sonst würde der zuvor „pending" gebuchte Betrag gleich danach nochmal über
         * die stehengebliebene Pending-Snapshot-Zeile gezählt).
         */
        feeClaims(db, scopeId) {
            return db.prepare(`
                SELECT claimed_at AS t, COALESCE(usd_value, 0) AS usd
                  FROM fee_history WHERE pool_id = ? ORDER BY claimed_at ASC
            `).all(scopeId);
        },

        /** Reine `fees_pending_usd`-Zeitreihe (LIQ#0360-Fee-Leg), aufsteigend. */
        pendingFeesSeries(db, scopeId) {
            return db.prepare(`
                SELECT recorded_at AS t, MAX(value) AS value
                  FROM (${_pendingFeesSource(db)})
                 WHERE pool_id = ?
                 GROUP BY recorded_at
                 ORDER BY recorded_at ASC
            `).all(scopeId);
        },

        /**
         * Jüngster Positionswert eines offenen Pools, exakt wie die Spalte „Anteil" im Dashboard
         * (bin/export.js: myValue = lp_value_usd der jüngsten position_snapshots-Zeile, ohne
         * offene Fees). Bewusst NICHT der letzte verwertete Kurvenpunkt: der überspringt Snapshots
         * um Kapitalflüsse (±60 s) und wiche dann ab (LIQ#000867, Festlegung 21.09.2026).
         */
        latestShareValue(db, scopeId) {
            const r = db.prepare(`
                SELECT ps.recorded_at AS t, ps.lp_value_usd AS lp FROM position_snapshots ps
                 WHERE ps.pool_id = ? AND EXISTS (SELECT 1 FROM positions p
                                                   WHERE p.pool_id = ps.pool_id AND p.closed_at IS NULL)
                 ORDER BY ps.recorded_at DESC LIMIT 1
            `).get(scopeId);
            return r && r.lp != null ? { t: r.t, usd: r.lp } : null;
        },

        /**
         * Reinvestierte Fee-Claims im Zeitraum (LIQ#000867, Unterzeile „Gebühren verdient"):
         * type='reinvest' ist jeweils ein Claim, der per increaseLiquidity zurück in die
         * Position ging. Kein Kapitalfluss, nur Aufschlüsselung.
         */
        reinvests(db, scopeId, fromMs, toMs) {
            const r = db.prepare(`
                SELECT COUNT(*) AS n, COALESCE(SUM(usd_value), 0) AS usd FROM transactions
                 WHERE pool_id = ? AND type = 'reinvest' AND created_at >= ? AND created_at <= ?
            `).get(scopeId, fromMs, toMs);
            // Claims direkt vor einem Rebalance gehen mit dem Kapital in die neue Position
            // (siehe _CLAIM_COUNTS_SQL) — also ebenfalls reinvestiert, nur ohne eigene Zeile.
            const c = db.prepare(`
                SELECT COUNT(*) AS n FROM transactions
                 WHERE pool_id = ? AND type = 'claim' AND note = 'vor-rebalance'
                   AND created_at >= ? AND created_at <= ?
            `).get(scopeId, fromMs, toMs);
            return { count: r?.n ?? 0, usd: r?.usd ?? 0, carriedCount: c?.n ?? 0 };
        },

        /**
         * USD-Kurse beider Pool-Token zu einem Zeitpunkt (LIQ#000867, HODL-Vergleich).
         *
         * pool_stats.price ist der Preis von Token A in Token B. USD-Bezug je Token direkt:
         * USDC = 1, sonst ein Pool dieses Tokens gegen USDC (z.B. SOL über liq-sol-usdc, bei
         * mehreren der mit den jüngsten Daten). Fehlt einer Seite der direkte Bezug, folgt sie
         * aus der anderen über den Paarpreis (USELESS = SOL-Kurs / Paarpreis). Ein Kurs gilt nur,
         * wenn der Messpunkt höchstens _PRICE_MAX_AGE_MS vor t liegt — sonst null, nie schätzen.
         *
         * Snapshot vor Stützstelle (LIQ#000895): Liegt ein position_snapshots-Eintrag des Pools
         * näher an t als der älteste dafür benutzte pool_stats-Punkt, gelten die Kurse, mit denen
         * der Bot die Position in diesem Snapshot bewertet hat. Er schreibt lp_value_usd =
         * toUsd(amount_a, amount_b) mit price = Token A in Token B (bots/liquidity/lib/refresh-state.js,
         * makeToUsd), für jeden Pool-Typ also USD(B) = lp / (amount_a · price + amount_b),
         * USD(A) = price · USD(B). Position und HODL-Vergleich zeigen so denselben Moment zu
         * denselben Kursen — sonst landete ein Kursrutsch zwischen letzter Stützstelle (bis 90 min
         * alt) und Stop-Exit im IL statt in der Kursentwicklung. Warum: KB Liquidity
         * Bot/pnl-rebalance-kette.md. Ohne frischeren Snapshot bleibt es bei pool_stats.
         *
         * @returns {((t:number) => {a:number, b:number}|null)|null} null, wenn für den Pool gar
         *   kein USD-Bezug herstellbar ist (z.B. cbBTC/WBTC ohne BTC/USDC-Pool).
         */
        tokenUsdPrices(db, scopeId) {
            if (!_hasTable(db, 'pools') || !_hasTable(db, 'pool_stats')) return null;
            const pool = db.prepare(`SELECT token_a, token_b FROM pools WHERE id = ?`).get(scopeId);
            if (!pool) return null;
            const priceQ = db.prepare(`
                SELECT price, recorded_at FROM pool_stats
                 WHERE pool_id = ? AND recorded_at <= ? ORDER BY recorded_at DESC LIMIT 1`);
            // Messpunkt { p, t } oder null; der Zeitpunkt entscheidet unten, ob ein Snapshot frischer ist.
            const priceAt = (poolId, t) => {
                const r = priceQ.get(poolId, t);
                return r && r.price > 0 && t - r.recorded_at <= _PRICE_MAX_AGE_MS ? { p: r.price, t: r.recorded_at } : null;
            };
            const snapCols = `SELECT recorded_at, price, amount_a, amount_b, lp_value_usd`;
            const snapWhere = `WHERE pool_id = ? AND recorded_at <= ? AND price > 0 AND amount_a IS NOT NULL
                                 AND amount_b IS NOT NULL AND lp_value_usd > 0 ORDER BY recorded_at DESC LIMIT 1`;
            // Ältere Schemata (Forks, Test-Fixtures) ohne price/amount_a: dann nur pool_stats.
            const snapQs = ['position_snapshots', 'position_snapshots_archive']
                .filter(tbl => _hasTable(db, tbl) && _hasColumns(db, tbl, ['price', 'amount_a', 'amount_b']))
                .map(tbl => db.prepare(`${snapCols} FROM ${tbl} ${snapWhere}`));
            const snapAt = (t) => {
                let best = null;
                for (const q of snapQs) {
                    const r = q.get(scopeId, t);
                    if (r && (!best || r.recorded_at > best.recorded_at)) best = r;
                }
                if (!best || t - best.recorded_at > _PRICE_MAX_AGE_MS) return null;
                const den = best.amount_a * best.price + best.amount_b;
                if (!(den > 0)) return null;
                const b = best.lp_value_usd / den;
                return { a: best.price * b, b, t: best.recorded_at };
            };
            const refQ = db.prepare(`
                SELECT id, token_a FROM pools
                 WHERE (token_a = ? AND token_b = ?) OR (token_a = ? AND token_b = ?)
                 ORDER BY (SELECT MAX(recorded_at) FROM pool_stats WHERE pool_id = pools.id) DESC
                 LIMIT 1`);
            const direct = (mint) => {
                if (mint === _USDC_MINT) return () => ({ p: 1, t: null });
                const ref = refQ.get(mint, _USDC_MINT, _USDC_MINT, mint);
                if (!ref) return null;
                if (ref.token_a !== _USDC_MINT) return (t) => priceAt(ref.id, t);
                return (t) => { const r = priceAt(ref.id, t); return r ? { p: 1 / r.p, t: r.t } : null; };
            };
            const da = direct(pool.token_a), db_ = direct(pool.token_b);
            if (!da && !db_) return null;
            const fromStats = (t) => {
                const ra = da ? da(t) : null, rb = db_ ? db_(t) : null;
                let a = ra?.p ?? null, b = rb?.p ?? null;
                const ts = [ra?.t, rb?.t];
                if (a == null || b == null) {
                    const pair = priceAt(scopeId, t);   // Token A in Token B
                    if (pair == null) return null;
                    ts.push(pair.t);
                    if (a == null && b != null) a = pair.p * b;
                    if (b == null && a != null) b = a / pair.p;
                }
                if (!(a > 0 && b > 0)) return null;
                // USDC hat keinen Messpunkt (Kurs 1) — maßgeblich ist der älteste echte.
                return { a, b, t: Math.min(...ts.filter(x => x != null)) };
            };
            return (t) => {
                const s = fromStats(t), snap = snapAt(t);
                const best = snap && (!s || snap.t > s.t) ? snap : s;
                return best && best.a > 0 && best.b > 0 ? { a: best.a, b: best.b } : null;
            };
        },
    },

    // ── LendingBot – ein einziger durchgehender Scope (bot_id) ───────────────
    lendingbot: {
        scopes(db) {
            return db.prepare(`SELECT DISTINCT bot_id AS id FROM portfolio_history ORDER BY bot_id`)
                     .all().map(r => r.id);
        },

        /**
         * Eine einzige durchgehende Session über die gesamte Historie.
         * openValue = 0: die Erst-Einzahlung kommt als cashflow herein, sodass
         * cap = kumulierte Netto-Einzahlungen und value − cap = echter Gewinn.
         */
        sessions(db, scopeId) {
            const first = db.prepare(`
                SELECT MIN(recorded_at) AS t FROM portfolio_history
                 WHERE bot_id = ? AND positions_value IS NOT NULL
            `).get(scopeId);
            if (first?.t == null) return [];
            return [{ start: first.t, end: null, openValue: 0 }];
        },

        /**
         * Wert-Zeitreihe = positions_value (Protokoll-Positionen OHNE Wallet).
         *
         * ⚠️  NICHT total_value verwenden: das enthält das Bot-Wallet. Kein
         * Schreibpfad des LendingBots bewegt Kapital nach außen — deposit,
         * withdraw, move, auto-deploy, auto-exit und emergency-withdraw
         * verschieben ausschließlich zwischen Wallet und Protokoll. Gegen
         * total_value gerechnet wäre jede dieser Buchungen wertneutral und
         * würde als cashflow einen Phantom-Verlust in ihrer Höhe erzeugen
         * (Befund 2026-08-12, identisch zum Liquidity-Bot-Fall am selben Tag).
         * Gegen positions_value sind es echte Zu-/Abflüsse dieser Wertreihe —
         * dieselbe Semantik wie beim liquidity-Adapter.
         *
         * Zeilen ohne positions_value werden übersprungen: ein Fallback auf
         * total_value würde genau den Fehler zurückholen, den diese Spalte
         * behebt. Altzeilen füllt bots/lending/bin/backfill-positions-value.js.
         */
        valueSeries(db, scopeId) {
            return db.prepare(`
                SELECT recorded_at AS t, positions_value AS value
                  FROM portfolio_history
                 WHERE bot_id = ? AND positions_value IS NOT NULL
                 ORDER BY recorded_at ASC
            `).all(scopeId);
        },

        cashflows(db, scopeId) {
            return db.prepare(`
                SELECT created_at AS t,
                       CASE WHEN type = 'deposit' THEN amount ELSE -amount END AS amount
                  FROM transactions
                 WHERE bot_id = ? AND type IN ('deposit','withdraw')
                 ORDER BY created_at ASC
            `).all(scopeId);
        },

        /**
         * Abgeflossene Erträge = Fee-Einnahmen die aufs Wallet übertragen wurden.
         * ⚠️  HEUTE 0: Es existiert aktuell KEIN automatischer Fee-Transfer aufs
         *     Wallet. Wenn dieser reaktiviert wird, MUSS er mit einer eigenen,
         *     von 'withdraw' unterscheidbaren Markierung gebucht werden (eigener
         *     transactions.type, z.B. 'fee_transfer', ODER note LIKE 'fee-transfer%').
         *     Dann hier die passende Abfrage ergänzen — damit der Transfer als
         *     ERTRAG (Eingabe 3) und nicht als externe Auszahlung (Eingabe 2) zählt.
         */
        earningsOut(_db, _scopeId, _fromMs, _toMs) {
            return 0;
        },

        /** Spiegel zu ADAPTERS.liquidity.earningsOutCurve() — hier immer leer, siehe earningsOut() oben. */
        earningsOutCurve(_db, _scopeId, _fromMs, _toMs) {
            return [];
        },

        // currentValue/valueAt liefern denselben Wertbegriff wie valueSeries
        // (Positionen ohne Wallet) — sonst mischten sich in pnl_daily.lp_close
        // und den Anzeigen zwei verschiedene Wertbegriffe.
        currentValue(db) {
            return db.prepare(`
                SELECT positions_value AS v FROM portfolio_history
                 WHERE positions_value IS NOT NULL
                 ORDER BY recorded_at DESC LIMIT 1
            `).get()?.v ?? 0;
        },

        valueAt(db, ts) {
            const row = db.prepare(`
                SELECT positions_value AS v FROM portfolio_history
                 WHERE recorded_at <= ? AND positions_value IS NOT NULL
                 ORDER BY recorded_at DESC LIMIT 1
            `).get(ts);
            return row ? row.v : null;
        },
    },
};

function _adapter(flavor) {
    const a = ADAPTERS[flavor];
    if (!a) throw new Error(`[FORGE/pnl] Unbekannter flavor: '${flavor}'. Erlaubt: ${Object.keys(ADAPTERS).join(', ')}`);
    return a;
}

// ════════════════════════════════════════════════════════════════════════════
//  KERN: Cashflow-bereinigte PnL-Kurve je Scope aufbauen
// ════════════════════════════════════════════════════════════════════════════

/**
 * Baut für jeden Scope die durchgehende pnl(t)-Kurve nach der Rolling-cap-Methodik.
 * @returns Map<scopeId, { history: Array<{t,pnl}>, latestPnl, latestValue, openSessionStart }>
 *   latestValue      = null wenn der Scope aktuell geschlossen ist.
 *   openSessionStart = Start der aktuell offenen Session, sonst 0 (= keine Begrenzung).
 */
function _buildCurves(db, flavor, now, cutoffHist) {
    const a = _adapter(flavor);
    const byScope = new Map();

    for (const scopeId of a.scopes(db)) {
        const sessions  = a.sessions(db, scopeId);
        const snaps     = a.valueSeries(db, scopeId);
        const cashflows = a.cashflows(db, scopeId);
        const exits     = a.exitProceeds ? a.exitProceeds(db, scopeId) : [];

        let cumRealized = 0;
        let latestPnl   = 0;
        let latestValue = null;   // null = aktuell geschlossen
        let latestRest  = 0;      // Rest der Kette im Wallet am letzten verwerteten Punkt
        let latestT     = null;   // Zeitpunkt dieses Punkts
        const history   = [];
        // Start der aktuell offenen Session (für session-begrenzte Fenster-PnL).
        // 0 wenn aktuell keine Session offen ist → Fenster ohne Begrenzung.
        const openSessionStart = sessions.length && sessions[sessions.length - 1].end == null
            ? sessions[sessions.length - 1].start : 0;

        // Kontinuierlicher Investmentstart: zurückwandern durch aufeinanderfolgende
        // Rebalance-Sessions (Gap < 5 Min). Verhindert dass ein Rebalance das
        // PnL-Fenster zurücksetzt — nur ein echter Investmentunterbruch tut das.
        const _REBALANCE_GAP_MS = 5 * 60_000;
        let continuousStart = openSessionStart;
        if (openSessionStart > 0) {
            for (let i = sessions.length - 2; i >= 0; i--) {
                if (sessions[i].end != null &&
                    (sessions[i + 1].continuesPrev ||
                     sessions[i + 1].start - sessions[i].end <= _REBALANCE_GAP_MS)) {
                    continuousStart = sessions[i].start;
                } else {
                    break;
                }
            }
        }

        // Rebalance-Ketten (LIQ#000865). Bis 21.09.2026 war jede Position eine eigene Session:
        // Beim Rebalance wurde der letzte Snapshot realisiert und die neue Position begann mit
        // cap = ihrem Eröffnungswert. Alles dazwischen — Swap-Kosten, Slippage, Kursdrift
        // zwischen Snapshot und Close, Rest im Wallet — galt damit stillschweigend als
        // PnL-neutrale Auszahlung. Die Nachzahlungen desselben Geldes zählten dann auch noch als
        // neue Einzahlung. Befund USELESS/SOL 09.–21.09.2026: angezeigt +82,91 USDC, real
        // (Positionswert − Einzahlungen) −20,16 USDC.
        //
        // Jetzt: Setzt eine Session die Kette fort (sess.continuesPrev), wird cap weitergetragen
        // statt neu gesetzt, beim Rebalance nichts realisiert, und Reconcile/Sweep/
        // Verschiebung-Nachzahlung sind kein Kapitalfluss (eigenes, schon im cap stehendes Geld).
        // Der Rest der Kette im Wallet (Verschiebungs-Bilanz) zählt zum Wert — er ist Geld des
        // Pools, nur nicht in der Position. Kosten des Rebalancings werden so zu Verlust.
        const restEvents = _backdateSeeds(
            a.walletRestEvents ? a.walletRestEvents(db, scopeId) : [], sessions, cashflows);
        let chainStart     = 0;      // Start der Kette der laufenden Session
        let carryCap       = null;   // cap am Ende einer Session, deren Kette weiterläuft
        let carryUnrealized = 0;
        // Vom Rebalance freigesetztes, nicht sofort wieder eingesetztes Kapital der Kette.
        // Deckel für interne Einzahlungen: nur bis zu dieser Höhe ist es eigenes Geld; was
        // darüber liegt, kam von außen (Vorfall SPCX/USDC 16.06.2026: Reconciler saugte 936 USDC
        // fremdes Wallet-Kapital ein) und zählt als Kapitalfluss.
        let allowance      = 0;
        // Eingesetztes Kapital je Zeitpunkt — Grundlage von capitalFlowsForPeriod(), damit die
        // Anzeige exakt dieselbe Klassifizierung sieht wie die Kurve.
        const flowLog      = [];
        const restAt = (t) => {
            let sum = 0;
            for (const e of restEvents) {
                if (e.t > t) break;
                if (e.t >= chainStart) sum += e.amount;
            }
            return Math.max(0, sum);
        };

        for (let si = 0; si < sessions.length; si++) {
            const sess   = sessions[si];
            const sStart = sess.start;
            const sEnd   = sess.end ?? now;
            const cont   = carryCap != null;   // gesetzt nur bei plausibler Fortsetzung, s.u.
            if (!cont) {
                chainStart = sStart;
                allowance  = 0;
                if (sess.openValue != null) flowLog.push({ t: sStart, kind: 'opening', amount: sess.openValue });
            }

            const sessFlowsAll = cashflows.filter(c => c.t >= sStart && c.t <= sEnd);
            // In einer fortgesetzten Kette ist eine interne Einzahlung eigenes Geld (kein
            // Kapitalfluss), aber nur bis zum Deckel `allowance`; der Überschuss zählt.
            const sessFlows = [];
            for (const c of sessFlowsAll) {
                let amount = c.amount;
                if (cont && c.internal && amount > 0) {
                    const own = Math.min(amount, allowance);
                    allowance -= own;
                    amount    -= own;
                    if (amount <= 0.005) continue;
                }
                sessFlows.push({ t: c.t, amount });
                flowLog.push({ t: c.t, kind: amount >= 0 ? 'deposit' : 'withdraw', amount });
            }
            // Auch interne Flüsse und Wallet-Rest-Buchungen erzeugen Timestamp-Drift zwischen
            // Snapshot und Buchung → dieselbe ±60-s-Sperre.
            const flowTimes = [
                ...sessFlowsAll.map(c => c.t),
                ...restEvents.filter(e => e.t >= sStart && e.t <= sEnd).map(e => e.t),
            ];
            const nearFlow  = t => flowTimes.some(ft => Math.abs(ft - t) <= _MIN_MS);
            const sessSnaps = snaps.filter(s =>
                s.t >= sStart + _MIN_MS &&   // erste 60 s nach Open verwerfen
                s.t <= sEnd &&
                s.value > 0 &&
                !nearFlow(s.t)               // ±60 s um Kapitalflüsse verwerfen
            );

            let cap            = cont ? carryCap : sess.openValue;   // null = Einstand unbekannt
            let flowIdx        = 0;
            let lastUnrealized = cont ? carryUnrealized : 0;
            let lastSnapValue  = null;             // null = kein Snapshot verwertet
            carryCap = null;
            carryUnrealized = 0;
            for (const snap of sessSnaps) {
                // Unbekannter Einstand → am ERSTEN beobachteten Wert ankern. Der PnL
                // zählt dann ab Übernahme der Position statt ab dem (unbekannten)
                // echten Einstieg: ehrlich und stetig, während cap = 0 den kompletten
                // Positionswert als Gewinn ausweisen würde. Kapitalflüsse bis zu diesem
                // Snapshot sind in snap.value bereits enthalten und werden übersprungen,
                // sonst würden sie doppelt zählen.
                if (cap == null) {
                    cap = snap.value;
                    // Für pnlBreakdownForPeriod(): der übernommene Wert als Kapital, abzüglich der
                    // übersprungenen Flüsse (die stehen schon im flowLog). capitalFlowsForPeriod()
                    // lässt diese Art bewusst weg (Karte unverändert).
                    let skipped = 0;
                    while (flowIdx < sessFlows.length && sessFlows[flowIdx].t <= snap.t) skipped += sessFlows[flowIdx++].amount;
                    flowLog.push({ t: snap.t, kind: 'adopted', amount: snap.value - skipped });
                }
                while (flowIdx < sessFlows.length && sessFlows[flowIdx].t <= snap.t) {
                    cap += sessFlows[flowIdx++].amount;   // + Einzahlung, − Auszahlung
                }
                // Teardown-Artefakt verwerfen (value << cap ohne Cashflow → Rebalance).
                // cap erst nach dem Cashflow-Roll prüfen, damit echte Ein-/Auszahlungen
                // (cap zieht mit) nicht fälschlich getroffen werden.
                if (cap > 0 && snap.value < cap * _TEARDOWN_FRAC) continue;
                const rest     = restAt(snap.t);
                lastUnrealized = snap.value + rest - cap;
                lastSnapValue  = snap.value;
                latestPnl      = round2(cumRealized + lastUnrealized);
                latestValue    = snap.value;
                latestRest     = rest;
                latestT        = snap.t;
                // `value` = beobachteter Wert des Pools an diesem Punkt (Position + Rest der
                // Kette im Wallet). Rein additiv mitgeführt (LIQ#000572), damit Auswerter wie
                // pnlPeakForPeriod() die zu einem Zeitpunkt gültige Kapitalbasis zurückrechnen
                // können, ohne eigene PnL-Mathematik zu bauen.
                if (snap.t >= cutoffHist) history.push({ t: snap.t, pnl: latestPnl, value: round2(snap.value + rest) });
            }

            if (sess.end != null) {
                // cap vollständig rollen: auch Kapitalflüsse NACH dem letzten verwerteten
                // Snapshot (oder wenn die Session gar keinen Snapshot verwertet hat) müssen
                // vor dem Close in cap stehen — sonst bildet cap den Kapitalstand beim
                // Close nicht ab (LIQ#0317: 350/403 Sessions ohne verwerteten Snapshot
                // hatten dadurch ein nie fortgeschriebenes cap und realisierten
                // zwangsläufig ±0, auch bei bekanntem Einstand UND Erlös).
                while (flowIdx < sessFlows.length) cap += sessFlows[flowIdx++].amount;

                // Rebalance: Die Kette läuft in der nächsten Session weiter → nichts
                // realisieren, cap und den letzten unrealisierten Stand weitertragen. Die
                // PnL-Kurve bleibt bis zum ersten Snapshot der neuen Position stehen.
                //
                // Nur bei plausiblem Übergang (_CHAIN_MIN/MAX_RATIO): Referenz ist der Close-
                // Erlös, ersatzweise der letzte Snapshot. Was zwischen Close und Neueröffnung
                // fehlt, wird Deckel für spätere interne Nachzahlungen (allowance).
                // Der Reconciler zahlt oft erst Sekunden nach dem Open nach (BNB/SOL 20.09.2026:
                // Open 142,83 bei Close 289,71, danach +147 Reconcile/Sweep) — dieser Teil des
                // Neueinstiegs zählt für die Prüfung mit.
                const nxt      = sessions[si + 1];
                const closeRef = sess.closeValue > 0 ? sess.closeValue : lastSnapValue;
                const refill   = nxt ? cashflows
                    .filter(c => c.internal && c.amount > 0 &&
                                 c.t >= nxt.start && c.t <= nxt.start + _CHAIN_REFILL_MS)
                    .reduce((sum, c) => sum + c.amount, 0) : 0;
                // Als Rest gebuchtes, noch nicht wieder eingesetztes Kapital derselben Rebalance
                // (rebalance_history.leftover_usdc, oder rückwirkend per 'seed' erfasst — siehe
                // _backdateSeeds()) zählt für die Plausibilitätsprüfung wie Refill: Es ist über
                // restEvents/restAt() bereits lückenlos im Kurvenwert enthalten, fehlt aber im
                // bloßen Eröffnungswert der neuen Session. Ohne diesen Posten verließ ein Rebalance
                // mit großem Restanteil fälschlich die Kette (LIQ#000873: USELESS/SOL 17.09.2026,
                // 20,18 von 34,21 USD Close-Erlös sofort neu investiert, Ratio 0,59 < 0,8, obwohl
                // 15,21 USD Leftover unverändert als Wallet-Rest weiterliefen — die Chartlinie
                // „Eingezahlt" brach dadurch für die Dauer der Session Richtung 0 ein). 'seed' zählt
                // mit, weil _backdateSeeds() ihn exakt an dieselbe Stelle (Beginn der neuen Session)
                // legt wie ein 'leftover' — nur eben rückwirkend von Hand nachgetragen.
                const refillRest = nxt ? restEvents
                    .filter(e => (e.kind === 'leftover' || e.kind === 'seed') &&
                                 e.t >= sess.end && e.t <= nxt.start + _CHAIN_REFILL_MS)
                    .reduce((sum, e) => sum + e.amount, 0) : 0;
                const ratio    = (nxt?.openValue > 0 && closeRef > 0)
                    ? (nxt.openValue + refill + refillRest) / closeRef : null;
                if (nxt?.continuesPrev && cap != null && ratio != null &&
                    ratio >= _CHAIN_MIN_RATIO && ratio <= _CHAIN_MAX_RATIO) {
                    carryCap        = cap;
                    carryUnrealized = lastUnrealized;
                    allowance      += Math.max(0, closeRef - nxt.openValue);
                    latestValue     = null;
                    latestRest      = 0;
                    continue;
                }

                // Close: letzten unrealized als realisiert einfrieren.
                //
                // Bei einem Auto-Exit ist der tatsächlich erzielte Verkaufserlös bekannt
                // und schlägt den Snapshot-Schätzwert — sonst friert die Slippage des
                // Verkaufs-Swaps (plus die Kursdrift zwischen letztem Snapshot und Swap)
                // als Phantom-Gewinn/-Verlust ein.
                //
                // 🔒 Der Override korrigiert AUSSCHLIESSLICH diese Ausstiegsdifferenz:
                //   • cap muss bekannt sein (Einstand + alle Zwischenflüsse jetzt immer
                //     vollständig gerollt, s.o.) — sonst wäre `exit − cap` kein
                //     Ausstiegsdelta, sondern Unsinn in voller Positionshöhe.
                //   • Gibt es einen verwerteten Snapshot, muss der Erlös nahe an dessen
                //     Wert liegen. Weicht er stark ab, ist nicht Slippage die Ursache,
                //     sondern eine Datenlücke (Teilverkauf, falsche Zuordnung) — dort ist
                //     der Snapshot-Pfad das ehrlichere Ergebnis.
                //   • Ohne verwerteten Snapshot ist der Wert beim Auslösen (triggerUsd) der
                //     Vergleichswert, mit derselben Schranke (LIQ#000894). Weicht der Erlös
                //     stärker ab, hat der Swap nur eine Token-Seite verkauft, die andere liegt
                //     im Wallet — dann gilt der Auslösewert als Close-Wert, nie der einseitige
                //     Erlös (SOL/cbBTC 24.07. und SPCX/USDC 04.08.2026: zusammen −198 USDC
                //     Scheinverlust). Fehlt auch der, zählt der gemessene Erlös direkt.
                // Der Rest der Kette im Wallet gehört zum Ergebnis dazu (LIQ#000865).
                const nextStart = sessions[si + 1]?.start ?? Infinity;
                const exit      = exits.find(e =>
                    e.t >= sess.end && e.t < Math.min(sess.end + _EXIT_MATCH_MS, nextStart));
                //     Nur bei einem FEHLBETRAG und nur, wenn seit dem Auslösen kein Kapitalfluss
                //     die Position verändert hat: Ein Mehrerlös oder eine Einzahlung nach dem
                //     Auslösen heißt, dass der Auslösewert veraltet ist, nicht der Erlös (ORE/SOL
                //     04.06.2026: ausgelöst bei 504, danach +441 eingezahlt, Erlös 940,67 korrekt).
                const near      = (v, ref) => Math.abs(v - ref) <= ref * _EXIT_MAX_DEVIATION;
                const trigger   = exit?.triggerUsd;
                const trigValid = Number.isFinite(trigger) && trigger > 0 &&
                    !cashflows.some(c => c.t > exit.triggerT && c.t <= exit.t);
                if (exit != null && cap != null && Number.isFinite(exit.usd) && exit.usd >= 0) {
                    if (lastSnapValue != null) {
                        if (exit.usd > 0 && near(exit.usd, lastSnapValue)) {
                            lastUnrealized = exit.usd + restAt(sess.end) - cap;
                        }
                    } else if (trigValid && exit.usd < trigger * (1 - _EXIT_MAX_DEVIATION)) {
                        lastUnrealized = trigger + restAt(sess.end) - cap;
                    } else if (exit.usd > 0) {
                        lastUnrealized = exit.usd + restAt(sess.end) - cap;
                    }
                }
                cumRealized += lastUnrealized;
                latestPnl    = round2(cumRealized);
                latestValue  = null;
                latestRest   = 0;
                // Realisierter Close verlässt die Kapitalbasis (für pnlBreakdownForPeriod(), wie
                // eine Auszahlung des Close-Werts). capitalFlowsForPeriod() lässt ihn weg.
                if (cap != null) flowLog.push({ t: sess.end, kind: 'close', amount: -(cap + lastUnrealized) });
                // Wert beim Close = Kapitalstand + eingefrorener unrealized (also der
                // Exit-Erlös bzw. der letzte Snapshotwert). null, wenn cap unbekannt blieb.
                if (sess.end >= cutoffHist) history.push({
                    t: sess.end, pnl: latestPnl,
                    value: cap != null ? round2(cap + lastUnrealized) : null,
                    closed: true,
                });
            }
        }

        byScope.set(scopeId, { history, latestPnl, latestValue, latestRest, latestT, openSessionStart,
                               continuousStart, flowLog, sessions, cashflows, restEvents });
    }
    return byScope;
}

/**
 * Startwerte der Verschiebungs-Bilanz zurückdatieren (LIQ#000865).
 *
 * Ein 'seed' ist ein Wallet-Rest, der VOR dem Go-Live der Bilanz bei Rebalances entstand und
 * erst später von Hand gemessen und eingebucht wurde. Stünde er an seinem Buchungszeitpunkt,
 * zeigte die Kurve bis dahin einen Scheinverlust (das Geld lag ja im Wallet) und beim Seed
 * einen Scheingewinn — USELESS/SOL 20.09.2026: Tiefstand −182 statt ~−65 USDC, 24h-Fenster
 * +118 USDC. Ein Rest kann nur an einer Rebalance-Lücke entstanden sein (Close-Erlös minus
 * Neueinstieg inkl. Reconcile). Der Seed wird deshalb rückwärts auf die Lücken derselben
 * Kette verteilt, je Lücke höchstens ihre Größe abzüglich dort schon gebuchter Reste; was
 * nicht unterzubringen ist, bleibt am Buchungszeitpunkt.
 */
function _backdateSeeds(events, sessions, cashflows) {
    if (!events.some(e => e.kind === 'seed')) return events;
    const gaps = [];   // { t, cap, chainId }
    let chainId = 0;
    for (let i = 1; i < sessions.length; i++) {
        const prev = sessions[i - 1], cur = sessions[i];
        if (!cur.continuesPrev) { chainId++; continue; }
        const refill = cashflows
            .filter(c => c.internal && c.amount > 0 && c.t >= cur.start && c.t <= cur.start + _CHAIN_REFILL_MS)
            .reduce((sum, c) => sum + c.amount, 0);
        const booked = events
            .filter(e => e.kind === 'leftover' && e.t >= cur.start - _CHAIN_REFILL_MS && e.t <= cur.start + _CHAIN_REFILL_MS)
            .reduce((sum, e) => sum + e.amount, 0);
        const gap = prev.closeValue > 0 && cur.openValue > 0
            ? prev.closeValue - cur.openValue - refill - booked : 0;
        gaps.push({ t: cur.start, cap: Math.max(0, gap), chainId });
    }
    const out = [];
    for (const e of events) {
        if (e.kind !== 'seed') { out.push(e); continue; }
        const own = gaps.filter(g => g.t < e.t);
        const chain = own.length ? own[own.length - 1].chainId : null;
        let left = e.amount;
        for (let i = own.length - 1; i >= 0 && left > 0.005; i--) {
            const g = own[i];
            if (g.chainId !== chain) break;
            const take = Math.min(left, g.cap);
            if (take > 0) { out.push({ t: g.t, amount: take, kind: 'seed' }); g.cap -= take; left -= take; }
        }
        if (left > 0.005) out.push({ t: e.t, amount: left, kind: 'seed' });
    }
    return out.sort((x, y) => x.t - y.t);
}

/** Kurvenwert zum Zeitpunkt t: letzter History-Eintrag mit t' ≤ t.
 *  0 wenn der Scope zu t noch nicht existierte (Kurve startet per Definition bei 0).
 *  @param key Feldname im History-Eintrag (Default 'pnl', für die Fee-Leg-Kurve 'feeLeg'). */
function _curveAt(history, t, key = 'pnl') {
    let v = 0;
    for (const e of history) {
        if (e.t <= t) v = e[key];
        else break;
    }
    return v;
}

// ════════════════════════════════════════════════════════════════════════════
//  FEE-LEG-KURVE (LIQ#0360) — separat von _buildCurves(), bewusst nicht verwoben
// ════════════════════════════════════════════════════════════════════════════

/**
 * Baut je Scope die kumulative Fee-Leg-Kurve: den Teil des PnL, der aus vereinnahmten
 * Handelsgebühren stammt (Preis-Leg ist der Rest, siehe feeLegForPeriod()). Bewusst
 * eine EIGENE, von _buildCurves() unabhängige Funktion statt eine Erweiterung dort —
 * _buildCurves() ist die zertifizierte Kernberechnung des PnL (oberste FORGE-Regel),
 * daran wird für dieses Feature nichts verändert. Nutzt dieselben Sessions wie
 * _buildCurves() (identische Scope-/Zeit-Einteilung), aber eigene Datenquellen
 * (Fee-Claims + Pending-Fees statt Wert-Snapshots + Cashflows).
 *
 * METHODIK je Session: ein laufender Zähler `live` (die aktuell in der offenen
 * Position steckenden, noch nicht geclaimten Gebühren) wird bei jedem Claim-Ereignis
 * auf 0 zurückgesetzt und bei jedem Pending-Snapshot auf dessen Wert überschrieben.
 * Bei jedem Claim wird sein USD-Wert zusätzlich permanent in `locked` einsortiert.
 * Am Ende einer Session (Close) wird der dann noch stehende `live`-Rest ebenfalls
 * permanent in `locked` übernommen — das deckt genau die Lücke ab, in der ein
 * Auto-Exit (Trailing-Stop/Score-Limit/TVL-Schutz/Retirement) Fees zwar on-chain
 * claimt, aber WEDER `fee_history` NOCH `transactions.claim` dafür schreibt
 * (exit-finalizer.js bündelt den Betrag undifferenziert in die close_position-Zeile).
 * Ohne diesen Schritt würde dieser Betrag nie das Fee-Leg erreichen und landete
 * fälschlich im Preis-Leg (Rest-Berechnung).
 *
 * `live` startet bei JEDER Session neu bei 0 (kein Übertrag über eine Close→Reopen-
 * Lücke) — sonst würde beim ersten Pending-Snapshot der neuen Position ein scheinbarer
 * RÜCKGANG der Fee-Leg-Kurve entstehen (Fee-Leg darf laut Definition nie sinken).
 * `locked` dagegen läuft scope-übergreifend über die gesamte Historie durch, exakt
 * wie `cumRealized` in _buildCurves() — dieselbe Kontinuität wie beim PnL selbst.
 */
function _buildFeeLegCurves(db, flavor, cutoffHist) {
    const a = _adapter(flavor);
    const byScope = new Map();
    if (!a.feeClaims || !a.pendingFeesSeries) return byScope;   // flavor ohne Fee-Leg-Konzept

    for (const scopeId of a.scopes(db)) {
        const sessions = a.sessions(db, scopeId);
        const claims   = a.feeClaims(db, scopeId);
        const pending  = a.pendingFeesSeries(db, scopeId);

        let locked = 0;
        let latestFeeLeg = 0;
        const history = [];

        for (const sess of sessions) {
            const sStart = sess.start;
            const sEnd   = sess.end ?? Date.now();

            const merged = [
                ...claims.filter(c => c.t >= sStart && c.t <= sEnd)
                         .map(c => ({ t: c.t, type: 'claim', value: c.usd })),
                ...pending.filter(p => p.t >= sStart && p.t <= sEnd)
                          .map(p => ({ t: p.t, type: 'snap', value: p.value })),
            ].sort((x, y) => x.t - y.t || (x.type === 'claim' ? -1 : 1));   // Claim vor Snap bei Gleichstand

            let live = 0;
            for (const e of merged) {
                if (e.type === 'claim') { locked += (e.value ?? 0); live = 0; }
                else                    { live = e.value ?? 0; }
                latestFeeLeg = round2(locked + live);
                if (e.t >= cutoffHist) history.push({ t: e.t, feeLeg: latestFeeLeg });
            }

            if (sess.end != null) {
                locked      += live;   // Rest beim Close permanent einsortieren (deckt Exit-Lücke ab)
                live         = 0;
                latestFeeLeg = round2(locked);
                if (sess.end >= cutoffHist) history.push({ t: sess.end, feeLeg: latestFeeLeg });
            }
        }

        byScope.set(scopeId, { history, latestFeeLeg });
    }
    return byScope;
}

// ════════════════════════════════════════════════════════════════════════════
//  ÖFFENTLICHE API
// ════════════════════════════════════════════════════════════════════════════

/**
 * PnL eines Zeitraums [fromMs, toMs) als eine Zahl (USDC).
 * scope weglassen → Portfolio (Summe über alle Scopes). scope='<id>' → einzeln.
 * toMs weglassen → jetzt (nutzt den eingefrorenen latestPnl).
 * @returns {number|null} null nur wenn der Bot gar keine Daten hat.
 */
export function pnlForPeriod(db, { flavor, scope = null, fromMs, toMs = null }) {
    const a    = _adapter(flavor);
    const now  = Date.now();
    const end  = toMs ?? now;
    const byScope = _buildCurves(db, flavor, now, 0);

    const ids = scope != null ? [scope] : [...byScope.keys()];
    if (ids.length === 0) return null;

    let sum = 0, any = false;
    for (const id of ids) {
        const c = byScope.get(id);
        if (!c) continue;
        any = true;
        const endPnl   = toMs == null ? c.latestPnl : _curveAt(c.history, end);
        const startPnl = _curveAt(c.history, fromMs);
        sum += (endPnl - startPnl) + a.earningsOut(db, id, fromMs, end);
    }
    return any ? round2(sum) : null;
}

/**
 * Fee-Leg eines Zeitraums [fromMs, toMs) als eine Zahl (USDC) — der Anteil des PnL,
 * der aus vereinnahmten Handelsgebühren stammt (nie negativ, LIQ#0360). Signatur
 * identisch zu pnlForPeriod(). Preis-Leg ist keine eigene Funktion, sondern der Rest:
 *
 *     const priceLeg = pnlForPeriod(db, opts) - feeLegForPeriod(db, opts);
 *
 * @returns {number|null} null wenn der flavor kein Fee-Leg-Konzept hat (z.B.
 *   lendingbot — fee_history/fees_pending_usd sind liquidity-spezifisch) oder der
 *   Bot gar keine Daten hat.
 */
export function feeLegForPeriod(db, { flavor, scope = null, fromMs, toMs = null }) {
    const a = _adapter(flavor);
    if (!a.feeClaims || !a.pendingFeesSeries) return null;
    const now = Date.now();
    const end = toMs ?? now;
    const byScope = _buildFeeLegCurves(db, flavor, 0);

    const ids = scope != null ? [scope] : [...byScope.keys()];
    if (ids.length === 0) return null;

    let sum = 0, any = false;
    for (const id of ids) {
        const c = byScope.get(id);
        if (!c) continue;
        any = true;
        const endLeg   = toMs == null ? c.latestFeeLeg : _curveAt(c.history, end, 'feeLeg');
        const startLeg = _curveAt(c.history, fromMs, 'feeLeg');
        sum += endLeg - startLeg;
    }
    return any ? round2(sum) : null;
}

/**
 * PnL desselben Zeitraums pro Scope: { scopeId: pnlUsd }.
 * Für Tooltips/Tabellen die je Pool einen Wert zeigen.
 */
export function pnlByScopeForPeriod(db, { flavor, fromMs, toMs = null }) {
    const a   = _adapter(flavor);
    const now = Date.now();
    const byScope = _buildCurves(db, flavor, now, 0);
    const out = {};
    for (const [id, c] of byScope) {
        const endPnl   = toMs == null ? c.latestPnl : _curveAt(c.history, toMs);
        const startPnl = _curveAt(c.history, fromMs);
        out[id] = round2((endPnl - startPnl) + a.earningsOut(db, id, fromMs, toMs ?? now));
    }
    return out;
}

/**
 * Historischer Extrempunkt des PnL im Zeitraum [fromMs, jetzt] für EINEN Scope
 * (z.B. Anteil-Modal: seit wann stand der Pool am weitesten im Plus bzw. im Minus,
 * und wie hoch war das). Tastet dieselbe Kurve ab wie pnlForPeriod — Snapshot-Punkte
 * plus etwaige Claim/Reinvest-Sprünge (earningsOutCurve) — sucht darauf den
 * Extrempunkt, statt nur den End-minus-Start-Wert zu bilden.
 *
 * `dir: 'min'` liefert spiegelbildlich den Tiefstand (LIQ#000577) — identische
 * Punktemenge, identische Kapitalbasis-Herleitung, nur der Vergleich dreht sich um.
 * Bewusst dieselbe Funktion statt einer Kopie: Höchst- und Tiefstand müssen exakt
 * denselben Kurvenverlauf abtasten, sonst sind die beiden Zahlen im selben Modal
 * nicht vergleichbar. Der Tiefstand ist nicht zwingend negativ — war der Pool nie
 * im Minus, ist es schlicht der niedrigste gemessene Gewinn.
 *
 * AUSWAHLKRITERIUM = RENDITE IN %, NICHT ABSOLUTE USD (LIQ#000572).
 * Bis dahin gewann schlicht der höchste USD-Betrag. Das verzerrt, sobald innerhalb
 * des Anker-Fensters Kapital nachfließt (Cleanup-Nachschuss ohne Anker-Reset): mehr
 * Kapital erzeugt bei gleicher relativer Performance automatisch mehr USD-PnL, der
 * "Höchststand" wandert also allein wegen der Einzahlung nach hinten.
 *
 * Die Kapitalbasis je Kurvenpunkt wird exakt so hergeleitet wie der Einzahlungs-
 * Gegenwert im Dashboard — Wert minus PnL seit Anker, also
 *   base(t) = value(t) − (pnl(t) − pnl(Anker))
 * — nur eben pro Historienpunkt statt nur für "jetzt". Das ist reine Differenz
 * zweier bereits von dieser Datei berechneter Größen, keine zweite PnL-Mathematik.
 *
 * Punkte ohne verwertbare Basis (kein bekannter Positionswert, base ≤ 0) können
 * keine Rendite liefern. Gibt es im ganzen Fenster keinen solchen Punkt, fällt die
 * Auswahl bewusst auf den USD-Extrempunkt zurück, damit nie "kein Höchststand"
 * herauskommt, wo es offensichtlich einen gibt (erkennbar an pnlPct === null).
 *
 * `by: 'usd'` wählt weiterhin nach absolutem USD-PnL aus. Das ist kein Altlast-Schalter:
 * Wer den Höchststand gegen eine USD-Schwelle stellt (Trailing-Stop-Scharfschaltung),
 * braucht genau diesen Punkt — die Rendite-Auswahl würde dort die Schwelle verschieben.
 *
 * @param {'pct'|'usd'} [by='pct']  Auswahlkriterium.
 * @param {'max'|'min'}  [dir='max'] Höchst- oder Tiefstand.
 * @returns {{pnlUsd:number, pnlPct:number|null, atMs:number, valueUsd:number|null,
 *            baseUsd:number|null}|null} null wenn der Scope keine Daten hat.
 */
export function pnlPeakForPeriod(db, { flavor, scope, fromMs, toMs = null, by = 'pct', dir = 'max' }) {
    const a   = _adapter(flavor);
    const now = Date.now();
    const end = toMs ?? now;
    const byScope = _buildCurves(db, flavor, now, 0);
    const c = byScope.get(scope);
    if (!c) return null;

    const startPnl = _curveAt(c.history, fromMs);
    const eoCurve  = a.earningsOutCurve(db, scope, fromMs, end);
    const eoAt = (t) => {
        let v = 0;
        for (const e of eoCurve) { if (e.t <= t) v = e.value; else break; }
        return v;
    };

    const points = c.history.filter(e => e.t >= fromMs && e.t <= end);
    // Letzter bekannter Positionswert vor/zum Fensterende — Close-Punkte tragen
    // value === null, dann zählt der letzte belastbare Wert davor.
    const _lastValueUpTo = (t) => {
        let v = null;
        for (const e of c.history) { if (e.t <= t) { if (e.value != null) v = e.value; } else break; }
        return v;
    };
    const lastPoint = {
        t: end,
        pnl: toMs == null ? c.latestPnl : _curveAt(c.history, end),
        value: toMs == null ? (c.latestValue ?? _lastValueUpTo(end)) : _lastValueUpTo(end),
    };
    if (!points.length || points[points.length - 1].t < end) points.push(lastPoint);

    // Der einzige Unterschied zwischen Höchst- und Tiefstand: die Richtung des
    // Vergleichs. Bei Gleichstand gewinnt der frühere Punkt (kein Überschreiben),
    // in beide Richtungen gleich — sonst wanderte der Extrempunkt auf einer flachen
    // Kurve je nach Richtung unterschiedlich weit nach hinten.
    const better = dir === 'min' ? (x, y) => x < y : (x, y) => x > y;

    let best     = null;   // bester Punkt nach Rendite
    let bestAbs  = null;   // Rückfallebene: bester Punkt nach absolutem USD
    for (const p of points) {
        const pnlUsd = round2((p.pnl - startPnl) + eoAt(p.t));
        if (bestAbs == null || better(pnlUsd, bestAbs.pnlUsd)) {
            bestAbs = { pnlUsd, pnlPct: null, atMs: p.t, valueUsd: p.value ?? null, baseUsd: null };
        }
        if (p.value == null) continue;
        const baseUsd = round2(p.value - pnlUsd);
        if (!(baseUsd > 0)) continue;
        const pnlPct = round2(pnlUsd / baseUsd * 100);
        if (best == null || better(pnlPct, best.pnlPct)) {
            best = { pnlUsd, pnlPct, atMs: p.t, valueUsd: round2(p.value), baseUsd };
        }
    }
    return by === 'usd' ? bestAbs : (best ?? bestAbs);
}

/**
 * Eingesetztes Kapital eines Scopes im Zeitraum [fromMs, toMs] — genau die Kapitalmenge, gegen
 * die der PnL rechnet (LIQ#000865, Karte „Ein-/Auszahlungen" im Anteil-Modal):
 *
 *   Einzahlungen = Eröffnungswert jeder im Zeitraum neu begonnenen Kette
 *                + jede spätere Einzahlung (auch Cleanup-Nachschuss aus dem Wallet)
 *   Auszahlungen = Teil- und Voll-Auszahlungen
 *
 * NICHT enthalten: reinvestierte Fees (keine Einzahlung) und Wiedereinsatz von Kapital, das ein
 * Rebalance derselben Kette freigesetzt hat (Reconcile, Residual-Sweep, Verschiebung-
 * Nachzahlung) — dieselbe Klassifizierung wie in _buildCurves(), damit Karte und PnL nie
 * auseinanderlaufen. Auto-Exits (Trailing Stop usw.) beenden die Kette und stehen nicht hier.
 *
 * @returns {{openingUsd:number, depositsUsd:number, withdrawalsUsd:number, count:number,
 *            balanceUsd:number}|null} null wenn der Scope keine Sessions hat.
 */
export function capitalFlowsForPeriod(db, { flavor, scope, fromMs, toMs = null }) {
    const end = toMs ?? Date.now();
    const c = _buildCurves(db, flavor, Date.now(), 0).get(scope);
    if (!c) return null;

    let openingUsd = 0, depositsUsd = 0, withdrawalsUsd = 0, count = 0;
    for (const f of c.flowLog) {
        if (f.t < fromMs || f.t > end) continue;
        if (f.kind === 'close' || f.kind === 'adopted') continue;   // nur für pnlBreakdownForPeriod()
        if (f.kind === 'opening')      openingUsd     += f.amount;
        else if (f.kind === 'deposit') depositsUsd    += f.amount;
        else                           withdrawalsUsd -= f.amount;
        count++;
    }
    return {
        openingUsd:     round2(openingUsd),
        depositsUsd:    round2(openingUsd + depositsUsd),
        withdrawalsUsd: round2(withdrawalsUsd),
        count,
        balanceUsd:     round2(openingUsd + depositsUsd - withdrawalsUsd),
    };
}

/**
 * Überleitung „Eingezahlt → Wert heute" für EINEN Scope seit fromMs (LIQ#000867, Reiter
 * „Details" im Anteil-Modal). Zerlegt genau den PnL von pnlForPeriod() in vier Zeilen, die
 * ein Mensch nachrechnen kann:
 *
 *     Eingezahlt + Gebühren + Kursentwicklung + IL/Rebalancing = Wert heute
 *     Wert heute = Position (inkl. offener Gebühren) + Wallet-Rest der Kette + ausgezahlte Fees
 *
 *   • Eingezahlt      = Wert beim Messbeginn (nur bei Anker mitten in der Kette, z.B. Reset)
 *                       + Eröffnung + Einzahlungen − Auszahlungen, dieselbe Klassifizierung wie
 *                       _buildCurves() (flowLog). Ein realisierter Close im Fenster zählt wie
 *                       eine Auszahlung seines Werts.
 *   • Gebühren        = feeLegForPeriod() (vereinnahmte Handelsgebühren).
 *   • Kursentwicklung = HODL-Vergleich: jede Einzahlung zu ihrem Zeitpunkt 50/50 in USD auf
 *                       Token A/B aufgeteilt und gehalten, Auszahlungen ebenso abgezogen, heute
 *                       bewertet, minus Eingezahlt. null, wenn ein Kurs fehlt (nie schätzen).
 *   • IL/Rebalancing  = Preis-Leg − Kursentwicklung (Rest, keine eigene Messung). Ohne
 *                       Kursentwicklung der ganze Preis-Leg.
 *
 * Fürs Anteil-Modal („Mein Anteil" = Spalte Anteil, nur Position): Eingezahlt + feesInShareUsd
 * + Kurs + ilShareUsd + rebalanceShareUsd = shareValueUsd. rebalanceShareUsd = −(Kosten ca. +
 * Wallet-Rest), ilShareUsd = Rest. Ausgezahlte/offene Fees und Wallet-Rest stehen nicht im Anteil.
 * Dazu Unterzeilen-Werte: reinvestierte/ausgezahlte/offene Gebühren, Anzahl Rebalances und
 * deren Kosten näherungsweise (je Übergang Close-Erlös − Neueinstieg inkl. Reconcile/Sweep
 * der ersten 15 min − gebuchter Rest + Verschiebung-Nachzahlung), Kursänderung beider Token.
 *
 * Nur für flavor='liquidity'. Rein lesend.
 *
 * `toMs` (LIQ#000869, für abgeschlossene Ketten, bots/liquidity/bin/lp-vs-hodl.js): Stand zum
 * letzten Kurvenpunkt ≤ toMs statt „jetzt". Endet das Fenster auf einem realisierten Close, ist
 * „Wert heute" nur noch die ausgezahlten Fees, der Close steht als Auszahlung seines Werts in
 * Eingezahlt, und der HODL-Vergleich verkauft zum Close-Zeitpunkt denselben Betrag 50/50 —
 * Kursentwicklung ist dann exakt der HODL-Gewinn bis zum Close. Ohne toMs ist das Ergebnis
 * unverändert; die Anteil-Felder (shareValueUsd …) folgen bei toMs dem Positionswert am Endpunkt
 * statt der Spalte „Anteil".
 * `checkUsd` = Eingezahlt + PnL − Wert heute, muss ≈ 0 sein (bin/test-pnl-rebalance-chain.js).
 * `valueSeries`/`investedSeries` = beide Größen im Zeitverlauf; ihr Abstand ist der PnL.
 * Warum HODL 50/50: KB Liquidity Bot/pnl-rebalance-kette.md.
 *
 * @returns {object|null} null, wenn der Scope keine Daten hat oder der flavor nicht passt.
 */
export function pnlBreakdownForPeriod(db, { flavor, scope, fromMs, toMs = null }) {
    const a = _adapter(flavor);
    if (!a.tokenUsdPrices || !a.reinvests) return null;
    const now = Date.now();
    const end = toMs ?? now;
    const c = _buildCurves(db, flavor, now, 0).get(scope);
    if (!c) return null;

    // Endzustand: ohne toMs der eingefrorene jüngste Stand, sonst der letzte Kurvenpunkt ≤ toMs.
    // Dessen `value` enthält den Wallet-Rest; der Positionswert allein ist der Snapshot mit
    // demselben Zeitpunkt (Kurvenpunkte entstehen genau aus diesen Snapshots).
    let latestPnl = c.latestPnl, latestValue = c.latestValue, latestRest = c.latestRest, latestT = c.latestT;
    if (toMs != null) {
        let pEnd = null;
        for (const e of c.history) { if (e.t <= end) pEnd = e; else break; }
        latestPnl = _curveAt(c.history, end);
        latestT   = pEnd?.t ?? null;
        if (pEnd != null && !pEnd.closed && pEnd.value != null) {
            const snap  = a.valueSeries(db, scope).find(s => s.t === pEnd.t);
            latestValue = snap?.value ?? pEnd.value;
            latestRest  = pEnd.value - latestValue;
        } else {
            latestValue = null;
            latestRest  = 0;
        }
    }

    // Startpunkt: letzter Kurvenpunkt ≤ fromMs (derselbe, den pnlForPeriod als Basis nimmt).
    let p0 = null;
    for (const e of c.history) { if (e.t <= fromMs) p0 = e; else break; }
    const startValueUsd = p0 && !p0.closed && p0.value != null ? p0.value : 0;
    const inWindow = f => f.t <= end && (f.t >= fromMs || (p0 != null && f.t > p0.t));
    const flows = c.flowLog.filter(inWindow);

    let openingUsd = 0, depositsUsd = 0, depositCount = 0, withdrawalsUsd = 0, withdrawalCount = 0;
    for (const f of flows) {
        if (f.kind === 'opening' || f.kind === 'adopted') openingUsd += f.amount;
        else if (f.amount >= 0) { depositsUsd += f.amount; depositCount++; }
        else { withdrawalsUsd -= f.amount; withdrawalCount++; }
    }
    const investedUsd = startValueUsd + openingUsd + depositsUsd - withdrawalsUsd;

    const pnlUsd   = latestPnl - _curveAt(c.history, fromMs) + a.earningsOut(db, scope, fromMs, end);
    const feesUsd  = feeLegForPeriod(db, { flavor, scope, fromMs, toMs }) ?? 0;
    const priceLeg = pnlUsd - feesUsd;

    // Wert heute
    const positionUsd  = latestValue ?? 0;
    const walletRestUsd = latestValue != null ? latestRest : 0;
    const paidOutUsd   = a.earningsOut(db, scope, fromMs, end);
    let pendingUsd = 0;
    if (latestValue != null && a.pendingFeesSeries) {
        for (const e of a.pendingFeesSeries(db, scope)) { if (e.t <= latestT) pendingUsd = e.value ?? 0; else break; }
    }
    const valueUsd = positionUsd + walletRestUsd + paidOutUsd;
    const reinv    = a.reinvests(db, scope, fromMs, end);

    // Kursentwicklung (HODL 50/50)
    const usdAt = a.tokenUsdPrices(db, scope);
    const legs  = [];
    if (startValueUsd > 0) legs.push({ t: p0.t, amount: startValueUsd });
    for (const f of flows) legs.push({ t: f.t, amount: f.amount });
    let marketUsd = null, hodlUsd = null, tokenAChangePct = null, tokenBChangePct = null;
    // Heute bewertet zum Zeitpunkt des Positionswerts (letzter verwerteter Snapshot), nicht zur
    // Wanduhr — beide Seiten des Vergleichs zeigen so denselben Moment.
    const pNow = usdAt ? usdAt(latestT ?? end) : null;
    if (pNow && legs.length) {
        let qa = 0, qb = 0, ok = true;
        for (const l of legs) {
            const p = usdAt(l.t);
            if (!p) { ok = false; break; }
            qa += l.amount / 2 / p.a;
            qb += l.amount / 2 / p.b;
        }
        if (ok) {
            hodlUsd   = qa * pNow.a + qb * pNow.b;
            marketUsd = hodlUsd - investedUsd;
            const p1  = usdAt(legs[0].t);
            tokenAChangePct = (pNow.a / p1.a - 1) * 100;
            tokenBChangePct = (pNow.b / p1.b - 1) * 100;
        }
    }

    // Rebalances im Fenster, die die Kette fortgesetzt haben (kein realisierter Close davor).
    const closes = new Set(c.flowLog.filter(f => f.kind === 'close').map(f => f.t));
    let rebalanceCount = 0, rebalanceCostKnown = 0, rebalanceCostUsd = 0;
    for (let i = 1; i < c.sessions.length; i++) {
        const prev = c.sessions[i - 1], cur = c.sessions[i];
        if (!cur.continuesPrev || cur.start < fromMs || cur.start > end || closes.has(prev.end)) continue;
        rebalanceCount++;
        if (!(prev.closeValue > 0 && cur.openValue > 0)) continue;
        const win = t => t >= cur.start - _CHAIN_REFILL_MS && t <= cur.start + _CHAIN_REFILL_MS;
        const refill = c.cashflows.filter(f => f.internal && f.amount > 0 && f.t >= cur.start
                                             && f.t <= cur.start + _CHAIN_REFILL_MS)
                                  .reduce((sum, f) => sum + f.amount, 0);
        // Gebuchter Rest (+ leftover/seed). Eine Verschiebung-Nachzahlung im selben Fenster
        // ('settle', negativ) steckt im refill, gleicht aber Reste FRÜHERER Rebalances aus — sie
        // wird hier wieder abgezogen, sonst erschiene sie als Gewinn dieses Übergangs
        // (BNB/SOL 20.09.2026: −30,97 statt +0,82 USDC).
        const booked = c.restEvents.filter(e => win(e.t)).reduce((sum, e) => sum + e.amount, 0);
        rebalanceCostUsd += prev.closeValue - cur.openValue - refill - booked;
        rebalanceCostKnown++;
    }

    // Anteil im Zeitverlauf für den Chart (Reiter „Pool-Entwicklung"): an jedem Kurvenpunkt der
    // Snapshot-Wert der Position ohne offene Fees — derselbe Begriff wie die Spalte „Anteil" am
    // Endpunkt (Festlegung 21.09.2026). Die Zeitpunkte kommen aus der Kurve und reichen über die
    // ganze Kette; _snapshotSource() liest das Archiv mit (LIQ#0311).
    // 🔒 Ohne Wallet-Rest (LIQ#000910): Früher zählte die Linie ihn mit, der Endpunkt nicht — bei
    // offenem Rest fiel die Linie am rechten Rand um genau diesen Betrag. Der Rest ist aus der
    // Position gefallen und steht in „Rebalancing"; die Verschiebung-Nachzahlung bringt ihn zurück,
    // die Linie steigt dann um den Rest. Close-Punkte ohne Snapshot behalten den Kurvenwert.
    const pendSeries = a.pendingFeesSeries ? a.pendingFeesSeries(db, scope) : [];
    const pendAt  = new Map(pendSeries.map(e => [e.t, e.value ?? 0]));
    const shareAt = new Map();
    for (const s of a.valueSeries(db, scope)) {
        if (s.t >= fromMs && s.t <= end && s.value != null) shareAt.set(s.t, s.value - (pendAt.get(s.t) ?? 0));
    }
    let pIdx = 0, pend = 0;
    const valueSeries = [];
    for (const e of c.history) {
        if (e.t < fromMs || (p0 != null && e.t <= p0.t) || e.t > end || e.value == null) continue;
        while (pIdx < pendSeries.length && pendSeries[pIdx].t <= e.t) pend = pendSeries[pIdx++].value ?? 0;
        const share = e.closed ? null : shareAt.get(e.t);
        valueSeries.push({ t: e.t, usd: round2(share ?? (e.value - (e.closed ? 0 : pend))) });
    }
    // Endpunkt = Spalte „Anteil" (siehe latestShareValue), damit Chart und „Wert heute" enden,
    // wo das Dashboard steht.
    const shareNow = toMs == null && a.latestShareValue ? a.latestShareValue(db, scope) : null;
    const shareValueUsd = shareNow != null ? round2(shareNow.usd) : round2(positionUsd - pendingUsd);
    if (shareNow != null) {
        if (valueSeries.length && valueSeries[valueSeries.length - 1].t >= shareNow.t) valueSeries[valueSeries.length - 1].usd = shareValueUsd;
        else valueSeries.push({ t: shareNow.t, usd: shareValueUsd });
    }

    // Eingezahlt als Stufenlinie für den Chart (Reiter „Pool-Entwicklung").
    const investedSeries = [];
    let cum = startValueUsd;
    if (startValueUsd > 0) investedSeries.push({ t: p0.t, usd: round2(cum) });
    for (const f of flows) { cum += f.amount; investedSeries.push({ t: f.t, usd: round2(cum) }); }

    // Bester/Schlechtester Stand von „Mein Anteil" (Karten im Anteil-Modal, Festlegung
    // 21.09.2026): derselbe Begriff wie sharePnlUsd, also Anteil-Linie − Eingezahlt zum
    // jeweiligen Zeitpunkt, ohne aufs Wallet ausgezahlte Fees. Auswahl nach Rendite auf das
    // damals Eingezahlte (wie pnlPeakForPeriod), bei Gleichstand der frühere Punkt.
    let sharePeak = null, shareTrough = null, iIdx = 0, invNow = 0;
    for (const v of valueSeries) {
        while (iIdx < investedSeries.length && investedSeries[iIdx].t <= v.t) invNow = investedSeries[iIdx++].usd;
        if (!(invNow > 0)) continue;
        const p = { pnlUsd: round2(v.usd - invNow), pnlPct: round2((v.usd - invNow) / invNow * 100), atMs: v.t };
        if (sharePeak == null || p.pnlPct > sharePeak.pnlPct) sharePeak = p;
        if (shareTrough == null || p.pnlPct < shareTrough.pnlPct) shareTrough = p;
    }

    // Vorsprung „Mein Anteil" gegenüber Halten (siehe shareEdgeUsd unten) — hier schon als
    // lokale Variable, damit shareEdgePerHourUsd dieselbe Zahl teilt statt sie zu duplizieren.
    const shareEdgeUsd = hodlUsd != null ? round2(shareValueUsd - hodlUsd) : null;
    // Vorsprung pro Stunde (LIQ#000890, Spalte „Δ" in Operative Metriken): shareEdgeUsd
    // gemittelt über die Laufzeit seit fromMs (Pool-Eröffnung/Reset). Bezugspunkt am oberen
    // Ende ist shareNow?.t (derselbe Zeitpunkt wie shareValueUsd), sonst `end`/jetzt — beide
    // Seiten des Vergleichs müssen denselben Moment zeigen wie shareEdgeUsd selbst.
    // null unter 1 h Laufzeit: der Durchschnitt würde sonst stark schwanken und suggeriert
    // eine falsche Genauigkeit direkt nach einer Eröffnung/einem Rebalance.
    const edgeHours = ((shareNow?.t ?? end) - fromMs) / 3_600_000;
    const shareEdgePerHourUsd = shareEdgeUsd != null && edgeHours >= 1 ? round2(shareEdgeUsd / edgeHours) : null;
    // Dieselbe Rechnung auf Tagesbasis (LIQ#000890, Umschalter Delta/H ↔ Delta/D) — eigene
    // Division statt shareEdgePerHourUsd × 24, sonst würde sich die Cent-Rundung der Stunden-Rate
    // mitverdoppelt fortpflanzen. null unter 24 h Laufzeit aus demselben Grund wie oben: ein
    // Tageswert aus wenigen Stunden hochgerechnet würde eine Genauigkeit vortäuschen, die
    // nicht da ist.
    const shareEdgePerDayUsd = shareEdgeUsd != null && edgeHours >= 24 ? round2(shareEdgeUsd / (edgeHours / 24)) : null;

    // Delta im Zeitverlauf (LIQ#000891, Chart hinter der Spalte „Δ"): für jeden Punkt t der
    // Anteil-Linie dieselbe Rechnung wie oben, nur mit t als Endpunkt — Anteil(t) − HODL(t),
    // HODL(t) = die bis t eingezahlten Legs 50/50 zu ihren Einstiegskursen, bewertet zu den
    // Kursen bei t. Der Anker bleibt fromMs, jeder Punkt ist also die Durchschnittsrate seit
    // Eröffnung, wie sie zu diesem Zeitpunkt in der Spalte gestanden hätte. Ein Punkt je
    // 10 Minuten (der letzte im Fenster) reicht für die Chart-Auflösung; der jüngste Punkt
    // rechnet mit genau den Größen der Spalte, damit Chart und Tabelle am selben Wert enden.
    // Punkte ohne Kurs werden ausgelassen, nie geschätzt; fehlt der Kurs eines Legs, bleibt
    // die Reihe leer (wie hodlUsd = null). Raten auf 4 Nachkommastellen statt auf Cent: bei
    // Stundenwerten um 0,05 USDC zeichnete die Cent-Rundung nur Treppenstufen.
    // Anteil(t) wie in valueSeries (ohne Wallet-Rest, LIQ#000910); Punkte ohne Snapshot (Close)
    // werden ausgelassen statt mit dem Kurvenwert samt Rest gerechnet.
    const edgeSeries = [];
    const round4 = x => Math.round(x * 10_000) / 10_000;
    if (usdAt && legs.length) {
        const legQ = [];
        for (const l of legs) {
            const p = usdAt(l.t);
            if (!p) { legQ.length = 0; break; }
            legQ.push({ t: l.t, qa: l.amount / 2 / p.a, qb: l.amount / 2 / p.b });
        }
        let li = 0, qa = 0, qb = 0;
        for (let i = 0; legQ.length && i < valueSeries.length; i++) {
            const v = valueSeries[i], nxt = valueSeries[i + 1];
            if (nxt && Math.floor(nxt.t / _EDGE_SERIES_BUCKET_MS) === Math.floor(v.t / _EDGE_SERIES_BUCKET_MS)) continue;
            while (li < legQ.length && legQ[li].t <= v.t) { qa += legQ[li].qa; qb += legQ[li].qb; li++; }
            if (!nxt && shareEdgeUsd != null) {
                edgeSeries.push({ t: v.t, usd: shareEdgeUsd,
                                  perHourUsd: shareEdgePerHourUsd != null ? round4(shareEdgeUsd / edgeHours) : null,
                                  perDayUsd:  shareEdgePerDayUsd  != null ? round4(shareEdgeUsd / (edgeHours / 24)) : null });
                continue;
            }
            const share = shareAt.get(v.t);
            const p = usdAt(v.t);
            if (!p || share == null) continue;
            const edge  = share - (qa * p.a + qb * p.b);
            const hours = (v.t - fromMs) / 3_600_000;
            edgeSeries.push({
                t: v.t,
                usd: round2(edge),
                perHourUsd: hours >= 1  ? round4(edge / hours) : null,
                perDayUsd:  hours >= 24 ? round4(edge / (hours / 24)) : null,
            });
        }
    }

    return {
        fromMs,
        startValueUsd:   round2(startValueUsd),
        openingUsd:      round2(openingUsd),
        depositsUsd:     round2(depositsUsd),
        depositCount,
        withdrawalsUsd:  round2(withdrawalsUsd),
        withdrawalCount,
        investedUsd:     round2(investedUsd),
        feesUsd:         round2(feesUsd),
        feesReinvestedUsd:   round2(reinv.usd),
        feesReinvestedCount: reinv.count,
        feesPaidOutUsd:  round2(paidOutUsd),
        feesPendingUsd:  round2(pendingUsd),
        // Rest der Gebühren: beim Rebalance mitgenommen (Claim 'vor-rebalance') bzw. beim Close
        // noch offen gewesen — steckt im Positionswert, ohne eigene Buchung.
        feesCarriedUsd:  round2(feesUsd - reinv.usd - paidOutUsd - pendingUsd),
        marketUsd:       marketUsd != null ? round2(marketUsd) : null,
        hodlUsd:         hodlUsd != null ? round2(hodlUsd) : null,
        tokenAChangePct: tokenAChangePct != null ? round2(tokenAChangePct) : null,
        tokenBChangePct: tokenBChangePct != null ? round2(tokenBChangePct) : null,
        ilRebalanceUsd:  round2(marketUsd != null ? priceLeg - marketUsd : priceLeg),
        // Aufteilung IL / Rebalancing (LIQ#000867): Rebalancing = −(Rebalance-Kosten ca., s.u.),
        // IL = der Rest von ilRebalanceUsd. Die Kosten sind eine Näherung, der IL erbt deren
        // Fehler spiegelbildlich; die Summe beider bleibt exakt.
        rebalanceUsd:    round2(-rebalanceCostUsd),
        ilUsd:           round2((marketUsd != null ? priceLeg - marketUsd : priceLeg) + rebalanceCostUsd),
        // Sicht „Mein Anteil" (Festlegung 21.09.2026): Wert = Spalte Anteil (nur Position).
        // Der Wallet-Rest ist bei Rebalances aus der Position gefallen und zählt zu Rebalancing;
        // IL ist der Rest, damit die Zeilen exakt auf die Spalte Anteil führen:
        //   investedUsd + feesInShareUsd + marketUsd + ilShareUsd + rebalanceShareUsd = shareValueUsd
        rebalanceShareUsd: round2(-rebalanceCostUsd - walletRestUsd),
        ilShareUsd:      round2(shareValueUsd - investedUsd - (reinv.usd + (feesUsd - reinv.usd - paidOutUsd - pendingUsd))
                                - (marketUsd ?? 0) - (-rebalanceCostUsd - walletRestUsd)),
        // Fees außer den reinvestierten Claims: aufs Wallet ausgezahlt, beim Rebalance
        // mitgenommen, noch offen.
        feesOtherUsd:    round2(feesUsd - reinv.usd),
        // „Mein Anteil" (Festlegung 21.09.2026): Position ohne offene Fees (= Spalte
        // Anteil) + Wallet-Rest. Aufs Wallet ausgezahlte und noch offene Fees gehören nicht dazu.
        // In den Anteil geflossen sind die reinvestierten Claims und die Claims vor Rebalances:
        //   investedUsd + feesInShareUsd + marketUsd + ilUsd + rebalanceUsd = shareValueUsd
        //   shareValueUsd + feesOutsideUsd − investedUsd = pnlUsd
        shareValueUsd,
        // Vorsprung „Mein Anteil" gegenüber bloßem Halten (LIQ#000872, Anteil-Modal):
        // Wert heute − (Eingezahlt + Kursentwicklung) = shareValueUsd − hodlUsd. Entspricht
        // exakt feesInShareUsd + ilShareUsd + rebalanceShareUsd (drei Zeilen, die zusammen mit
        // investedUsd + marketUsd auf shareValueUsd führen) — anders als pnlUsd − marketUsd
        // enthält dieser Wert KEINE aufs Wallet ausgezahlten Fees (Modal-Regel: nur Anteil).
        // null, wenn hodlUsd fehlt (Kurslücke), nie schätzen.
        shareEdgeUsd,
        // Vorsprung in % auf Eingezahlt, gleiche Basis wie sharePnlPct — nicht aus
        // sharePnlPct − marketPct zurückrechnen (gleicher Grund wie bei pnlPct oben).
        shareEdgePct:    hodlUsd != null && investedUsd > 0 ? round2((shareValueUsd - hodlUsd) / investedUsd * 100) : null,
        // Vorsprung pro Stunde/Tag seit fromMs (LIQ#000890, Spalte „Δ"), Rechnung siehe oben.
        shareEdgePerHourUsd,
        shareEdgePerDayUsd,
        shareValueAtMs:  shareNow?.t ?? null,   // Zeitpunkt des Snapshots hinter shareValueUsd
        feesInShareUsd:  round2(reinv.usd + (feesUsd - reinv.usd - paidOutUsd - pendingUsd)),
        feesInShareCount: reinv.count + reinv.carriedCount,
        feesOutsideUsd:  round2(paidOutUsd + pendingUsd),
        // PnL von „Mein Anteil" (Festlegung 21.09.2026: das Modal zeigt nur, was zum
        // Anteil gehört, keine Zeile für Nicht-Enthaltenes): Wert heute − Eingezahlt. Ohne die
        // aufs Wallet ausgezahlten/offenen Fees, anders als pnlUsd.
        sharePnlUsd:     round2(shareValueUsd - investedUsd),
        sharePnlPct:     investedUsd > 0 ? round2((shareValueUsd - investedUsd) / investedUsd * 100) : null,
        sharePeak,       // { pnlUsd, pnlPct, atMs } | null
        shareTrough,
        // PnL in % auf Eingezahlt. Nicht aus Anteil − PnL zurückrechnen: Der Anteil enthält
        // die Fees außerhalb nicht, die Basis wäre zu klein (USELESS/SOL 21.09.2026: 3,24 statt 3,16 %).
        pnlPct:          investedUsd > 0 ? round2(pnlUsd / investedUsd * 100) : null,
        rebalanceCount,
        rebalanceCostKnownCount: rebalanceCostKnown,
        rebalanceCostUsd: round2(rebalanceCostUsd),
        pnlUsd:          round2(pnlUsd),
        positionUsd:     round2(positionUsd),
        lpUsd:           round2(positionUsd - pendingUsd),
        walletRestUsd:   round2(walletRestUsd),
        valueUsd:        round2(valueUsd),
        checkUsd:        round2(investedUsd + pnlUsd - valueUsd),
        investedSeries,
        valueSeries,
        edgeSeries,      // [{ t, usd, perHourUsd, perDayUsd }], LIQ#000891
    };
}

/**
 * Pro Scope ein PnL je Zeitfenster: { scopeId: { windowId: pnlUsd } }.
 * windows = [{ id, ms }].
 *
 * SESSION-BEGRENZT: Als Fenster-Basis (pnlPast) wird nur ein Kurvenpunkt INNERHALB
 * der aktuell offenen Session akzeptiert. Verhindert, dass das Schlussevent einer
 * alten, geschlossenen Position als Basis einer neuen Position dient (sonst zeigt
 * das Fenster direkt nach Re-Open fälschlich identische Werte). Ein Fenster wird nur
 * geliefert, wenn der Scope darin aktiv war (mind. ein Kurvenpunkt im Fenster und in
 * der aktuellen Session) — sonst bleibt es weg ("noch keine Daten").
 */
export function pnlWindows(db, { flavor, windows, now = Date.now() }) {
    const a = _adapter(flavor);
    const byScope = _buildCurves(db, flavor, now, 0);
    const out = {};
    for (const [id, c] of byScope) {
        out[id] = {};
        if (c.history.length === 0) continue;
        const openedAt = c.continuousStart;   // inkl. Rebalance-Sessions zurück
        for (const w of windows) {
            const cutoff = now - w.ms;
            // pnlPast = letzter Kurvenpunkt mit t ≤ cutoff UND t ≥ openedAt.
            let pnlPast = null;
            for (let i = c.history.length - 1; i >= 0; i--) {
                const e = c.history[i];
                if (e.t <= cutoff && e.t >= openedAt) { pnlPast = e.pnl; break; }
            }
            if (pnlPast == null) continue;
            // Position muss im Fenster aktiv gewesen sein (Punkt > cutoff und ≥ openedAt).
            if (!c.history.some(e => e.t > cutoff && e.t >= openedAt)) continue;
            out[id][w.id] = round2((c.latestPnl - pnlPast) + a.earningsOut(db, id, cutoff, now));
        }
    }
    return out;
}

/** Positions-/Portfoliowert (Summe) zum Zeitpunkt ts. null wenn keine Daten. */
export function lpValueAt(db, { flavor, ts }) {
    return _adapter(flavor).valueAt(db, ts);
}

/**
 * USD-Kurse beider Token eines Scopes über die Zeit — reine Weitergabe an den Adapter
 * (tokenUsdPrices, HODL-Vergleich in pnlBreakdownForPeriod). Freigegeben für Werkzeuge, die
 * hypothetische Positionen bewerten (Fee-/Preis-Rechner, lib/fee-lvr.js, LIQ#000871), damit
 * dort keine zweite Kursquelle entsteht. Keine eigene Logik.
 * @returns {((t:number) => {a:number, b:number}|null)|null}
 */
export function tokenUsdPrices(db, { flavor, scope }) {
    const a = _adapter(flavor);
    return a.tokenUsdPrices ? a.tokenUsdPrices(db, scope) : null;
}

/** Aktueller Positions-/Portfoliowert (Summe). */
export function currentValue(db, { flavor }) {
    return _adapter(flavor).currentValue(db);
}

/** Netto-Kapitalfluss (Σ Einzahlungen − Auszahlungen) über alle Scopes im Zeitraum [fromMs, toMs). */
function _netCashflow(db, flavor, fromMs, toMs) {
    const a = _adapter(flavor);
    let net = 0;
    for (const scopeId of a.scopes(db)) {
        for (const c of a.cashflows(db, scopeId)) {
            if (c.t >= fromMs && c.t < toMs) net += c.amount;   // + Ein, − Aus
        }
    }
    return net;
}

/** Abgeflossene Erträge (earningsOut) über alle Scopes im Zeitraum. */
function _earningsOutAll(db, flavor, fromMs, toMs) {
    const a = _adapter(flavor);
    let sum = 0;
    for (const scopeId of a.scopes(db)) sum += a.earningsOut(db, scopeId, fromMs, toMs);
    return sum;
}

/**
 * Cashflow- und Ertrags-Bereinigung für EXTERN gewählte Wert-Anker.
 *
 * Für Bots, die ihre eigenen (rauschreduzierten) Wert-Anker bestimmen — z.B. der
 * LendingBot mit Tagesanfangs-Snapshots — aber die Bereinigung NICHT selbst rechnen
 * sollen. Liefert den cashflow- und ertragsbereinigten Wertzuwachs:
 *
 *   ergebnis = (endValue − startValue) − netto_kapitalfluss + abgeflossene_erträge
 *
 * Damit wandert der fehleranfällige Teil (Was ist ein Kapitalfluss? Welcher Abfluss
 * ist verdienter Ertrag?) in die zentrale Lib — der Bot liefert nur Anker + Zeitraum
 * und behält seine Präsentations-Schicht (Floor, Glättung, Sanity-Cap, fees).
 *
 * ⚠️  Sobald der LendingBot wieder Fee-Einnahmen aufs Wallet überträgt, MUSS die
 *     earningsOut-Abfrage im lendingbot-Adapter ergänzt werden (siehe dort) — dann
 *     fließt der Transfer hier automatisch als Ertrag ein und verschwindet NICHT
 *     aus dem PnL. KEINE Änderung an den Bots nötig.
 *
 * @returns {number} ungerundet (der Aufrufer rundet/floort nach Bedarf).
 */
export function adjustForCashflows(db, { flavor, startValue, endValue, fromMs, toMs }) {
    const net = _netCashflow(db, flavor, fromMs, toMs);
    const out = _earningsOutAll(db, flavor, fromMs, toMs);
    return (endValue - startValue) - net + out;
}

/**
 * Vollständiges PnL-Bündel für Dashboard-Export & Pool-Explorer.
 * Liefert die Kurve + Komfort-Aggregate, alle aus derselben Methodik.
 *
 * @returns {{
 *   pnlHistory: Array<{t, poolId, pnlUsd}>,        // flache, aufsteigende Kurve aller Scopes
 *   latestPnlByPool: Object<string, number>,
 *   latestLpValueByPool: Object<string, number|null>,
 *   pnl24hAgoByPool: Object<string, number>,
 *   pnl7dAgoByPool:  Object<string, number>,
 *   fees24hByPool: Object<string, number>,
 *   fees7dByPool:  Object<string, number>,
 *   metricsByPool: Object<string, {lp_value_now, pnl_1d_usd, pnl_1d_pct, pnl_7d_usd, pnl_7d_pct}>,
 * }}
 *
 * Hinweis: Die Keys heißen aus historischen Gründen *ByPool / poolId — für
 * LendingBot ist der "Pool" der bot_id-Scope. Inhaltlich identisch.
 */
export function computePnlHistory(db, { flavor, now = Date.now(), historyWindowMs = _30D_MS } = {}) {
    const a          = _adapter(flavor);
    const cutoffHist = now - historyWindowMs;
    const cutoff24h  = now - _24H_MS;
    const cutoff7d   = now - _7D_MS;

    const byScope = _buildCurves(db, flavor, now, cutoffHist);

    const pnlHistory          = [];
    const latestPnlByPool     = {};
    const latestLpValueByPool = {};
    const pnl24hAgoByPool     = {};
    const pnl7dAgoByPool      = {};
    const fees24hByPool       = {};
    const fees7dByPool        = {};

    for (const [poolId, c] of byScope) {
        for (const e of c.history) pnlHistory.push({ t: e.t, poolId, pnlUsd: e.pnl });
        latestPnlByPool[poolId]     = c.latestPnl;
        latestLpValueByPool[poolId] = c.latestValue;
        fees24hByPool[poolId]       = a.earningsOut(db, poolId, cutoff24h, now);
        fees7dByPool[poolId]        = a.earningsOut(db, poolId, cutoff7d, now);

        const past24 = c.history.filter(e => e.t <= cutoff24h);
        if (past24.length) pnl24hAgoByPool[poolId] = past24[past24.length - 1].pnl;
        const past7 = c.history.filter(e => e.t <= cutoff7d);
        if (past7.length) pnl7dAgoByPool[poolId] = past7[past7.length - 1].pnl;
    }
    pnlHistory.sort((x, y) => x.t - y.t);

    const metricsByPool = {};
    for (const poolId of Object.keys(latestPnlByPool)) {
        const cur = latestPnlByPool[poolId];
        const lp  = latestLpValueByPool[poolId];
        const pnl1dUsd = pnl24hAgoByPool[poolId] != null
            ? round2(cur - pnl24hAgoByPool[poolId] + (fees24hByPool[poolId] ?? 0)) : null;
        const pnl7dUsd = pnl7dAgoByPool[poolId] != null
            ? round2(cur - pnl7dAgoByPool[poolId] + (fees7dByPool[poolId] ?? 0)) : null;
        metricsByPool[poolId] = {
            lp_value_now: lp,
            pnl_1d_usd:   pnl1dUsd,
            pnl_1d_pct:   (pnl1dUsd != null && lp > 0) ? round2(pnl1dUsd / lp * 100) : null,
            pnl_7d_usd:   pnl7dUsd,
            pnl_7d_pct:   (pnl7dUsd != null && lp > 0) ? round2(pnl7dUsd / lp * 100) : null,
        };
    }

    return {
        pnlHistory, latestPnlByPool, latestLpValueByPool,
        pnl24hAgoByPool, pnl7dAgoByPool, fees24hByPool, fees7dByPool, metricsByPool,
    };
}
