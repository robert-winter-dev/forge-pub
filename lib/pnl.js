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
 *    pnlByScopeForPeriod(db, {flavor, fromMs, toMs?})
 *        → { scopeId: pnlUsd } für denselben Zeitraum (z.B. Tooltip "Anteil").
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
                SELECT id, opened_at, closed_at, capital_usdc, open_tx
                FROM positions WHERE pool_id = ? ORDER BY opened_at ASC
            `).all(scopeId);
            // tx_hash IS NOT NULL ist Pflicht: Positionen ohne TX-Hash würden sonst
            // alle den Map-Key null besetzen und sich gegenseitig vergiften.
            const openValByTx = {};
            for (const r of db.prepare(`
                SELECT tx_hash, usd_value FROM transactions
                 WHERE type IN ('open_position','rebalance')
                   AND usd_value IS NOT NULL AND tx_hash IS NOT NULL
            `).all()) openValByTx[r.tx_hash] = r.usd_value;

            return positions.map(p => {
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
         */
        cashflows(db, scopeId) {
            return db.prepare(`
                SELECT created_at AS t,
                       CASE WHEN type = 'deposit' THEN usd_value ELSE -usd_value END AS amount
                  FROM transactions
                 WHERE pool_id = ? AND type IN ('deposit','withdraw','withdraw_full')
                   AND usd_value IS NOT NULL
                 ORDER BY created_at ASC
            `).all(scopeId);
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
         */
        exitProceeds(db, scopeId) {
            return db.prepare(`
                SELECT created_at AS t, -usdc_amount AS usd
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
                      WHERE ${where}type='claim' AND created_at < ?`).get(...args).t;
                const reinv = db.prepare(
                    `SELECT COALESCE(SUM(usd_value),0) AS t FROM transactions
                      WHERE ${where}type='reinvest' AND created_at < ?`).get(...args).t;
                return Math.max(0, claimed - reinv);
            };
            return cumAt(toMs ?? Date.now()) - cumAt(fromMs);
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
                    sessions[i + 1].start - sessions[i].end <= _REBALANCE_GAP_MS) {
                    continuousStart = sessions[i].start;
                } else {
                    break;
                }
            }
        }

        for (let si = 0; si < sessions.length; si++) {
            const sess   = sessions[si];
            const sStart = sess.start;
            const sEnd   = sess.end ?? now;

            const sessFlows = cashflows.filter(c => c.t >= sStart && c.t <= sEnd);
            const flowTimes = sessFlows.map(c => c.t);
            const nearFlow  = t => flowTimes.some(ft => Math.abs(ft - t) <= _MIN_MS);
            const sessSnaps = snaps.filter(s =>
                s.t >= sStart + _MIN_MS &&   // erste 60 s nach Open verwerfen
                s.t <= sEnd &&
                s.value > 0 &&
                !nearFlow(s.t)               // ±60 s um Kapitalflüsse verwerfen
            );

            let cap            = sess.openValue;   // null = Einstand unbekannt
            let flowIdx        = 0;
            let lastUnrealized = 0;
            let lastSnapValue  = null;             // null = kein Snapshot verwertet
            for (const snap of sessSnaps) {
                // Unbekannter Einstand → am ERSTEN beobachteten Wert ankern. Der PnL
                // zählt dann ab Übernahme der Position statt ab dem (unbekannten)
                // echten Einstieg: ehrlich und stetig, während cap = 0 den kompletten
                // Positionswert als Gewinn ausweisen würde. Kapitalflüsse bis zu diesem
                // Snapshot sind in snap.value bereits enthalten und werden übersprungen,
                // sonst würden sie doppelt zählen.
                if (cap == null) {
                    cap = snap.value;
                    while (flowIdx < sessFlows.length && sessFlows[flowIdx].t <= snap.t) flowIdx++;
                }
                while (flowIdx < sessFlows.length && sessFlows[flowIdx].t <= snap.t) {
                    cap += sessFlows[flowIdx++].amount;   // + Einzahlung, − Auszahlung
                }
                // Teardown-Artefakt verwerfen (value << cap ohne Cashflow → Rebalance).
                // cap erst nach dem Cashflow-Roll prüfen, damit echte Ein-/Auszahlungen
                // (cap zieht mit) nicht fälschlich getroffen werden.
                if (cap > 0 && snap.value < cap * _TEARDOWN_FRAC) continue;
                lastUnrealized = snap.value - cap;
                lastSnapValue  = snap.value;
                latestPnl      = round2(cumRealized + lastUnrealized);
                latestValue    = snap.value;
                if (snap.t >= cutoffHist) history.push({ t: snap.t, pnl: latestPnl });
            }

            if (sess.end != null) {
                // cap vollständig rollen: auch Kapitalflüsse NACH dem letzten verwerteten
                // Snapshot (oder wenn die Session gar keinen Snapshot verwertet hat) müssen
                // vor dem Close in cap stehen — sonst bildet cap den Kapitalstand beim
                // Close nicht ab (LIQ#0317: 350/403 Sessions ohne verwerteten Snapshot
                // hatten dadurch ein nie fortgeschriebenes cap und realisierten
                // zwangsläufig ±0, auch bei bekanntem Einstand UND Erlös).
                while (flowIdx < sessFlows.length) cap += sessFlows[flowIdx++].amount;

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
                //     der Snapshot-Pfad das ehrlichere Ergebnis. Ohne verwerteten Snapshot
                //     gibt es keinen Vergleichswert zum Plausibilisieren — dann zählt der
                //     gemessene Erlös direkt, er ist die einzige belastbare Information.
                const nextStart = sessions[si + 1]?.start ?? Infinity;
                const exit      = exits.find(e =>
                    e.t >= sess.end && e.t < Math.min(sess.end + _EXIT_MATCH_MS, nextStart));
                if (exit != null && cap != null &&
                    Number.isFinite(exit.usd) && exit.usd > 0 &&
                    (lastSnapValue == null ||
                     Math.abs(exit.usd - lastSnapValue) <= lastSnapValue * _EXIT_MAX_DEVIATION)) {
                    lastUnrealized = exit.usd - cap;
                }
                cumRealized += lastUnrealized;
                latestPnl    = round2(cumRealized);
                latestValue  = null;
                if (sess.end >= cutoffHist) history.push({ t: sess.end, pnl: latestPnl });
            }
        }

        byScope.set(scopeId, { history, latestPnl, latestValue, openSessionStart, continuousStart });
    }
    return byScope;
}

/** Kurvenwert zum Zeitpunkt t: letzter History-Eintrag mit t' ≤ t.
 *  0 wenn der Scope zu t noch nicht existierte (Kurve startet per Definition bei 0). */
function _curveAt(history, t) {
    let v = 0;
    for (const e of history) {
        if (e.t <= t) v = e.pnl;
        else break;
    }
    return v;
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
