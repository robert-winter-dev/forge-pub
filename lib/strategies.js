/**
 * FORGE – Strategie-Definitionen und Strategie-Logik (LIQ#0368, Baustein B)
 *
 * Eine Strategie ist eine gewählte Risikohaltung. Sie besitzt einen Feldsatz und einen
 * Filter, der sagt, in welchen Pools sie überhaupt gilt. Sie fasst einzelne Pools nie an.
 *
 * Konzept, Begründungen und die getroffenen Entscheidungen (inkl. Entscheidung 1, zweite
 * Hälfte: die gemessene Verteilung neben dem Namen, LIQ#0373) sind projektintern
 * dokumentiert; die Herleitung jedes Werts steht als Kommentar bei der jeweiligen
 * Strategie unten.
 * (LIQ#0387: "Kapitalerhalt" → "Stablecoin" mit engerem Geltungsbereich, "Ereignisfenster"
 * → "Lambo" umbenannt, "Token Maximierung" neu.)
 *
 * 🔒 ZWISCHENLÖSUNG — diese Datei ist als Code-Konstante bewusst temporär.
 * Zielbild laut strategie-auswahl.md, Abschnitt „Auslieferung — Strategien als
 * Premium-Daten": Die Parameter kommen aus dem Premium-Blob (eigene Sektion neben
 * `scores`, `scoreHistory`, `marketTable`, `poolOffers`), damit sie ohne Release
 * nachgeschärft werden können — für ein Thema, das nie fertig wird, ist das der
 * entscheidende Vorteil. Den Blob gibt es noch nicht; bis dahin steht der Satz hier.
 * `STRATEGIES` hat deshalb bereits exakt die Form, die die Blob-Sektion haben wird —
 * beim Umzug wird die Quelle getauscht, nicht die Struktur.
 *
 * ⚠️ Ein Strategie-Parametersatz ist kapitalrelevant (er stellt Exits und Ranges) und
 * fällt damit in dieselbe Klasse wie die Pool-Offers: „die Lieferung ist eine
 * Behauptung". Sobald die Werte aus dem Blob kommen, braucht es Plausibilitätsgrenzen
 * im Fork, die kein gelieferter Wert überschreiten darf. Siehe strategie-auswahl.md.
 *
 * Bewusst abhängigkeitsfrei (keine Imports, keine Env, kein DB-Treiber) — dieselbe
 * Begründung wie bei lib/pool-settings-defaults.js und
 * bots/liquidity/lib/pool-type-boundaries.js: Settings-Server und Liquidity Bot sollen
 * die Datei importieren können, ohne sich gegenseitig Laufzeit-Voraussetzungen
 * hereinzuziehen. Das Anwenden und der Ist-Vergleich liegen deshalb nicht hier, sondern
 * in bots/settings/lib/strategy-apply.js.
 */

/**
 * Version des Definitionssatzes. Wandert mit in die Blob-Sektion; eine Installation kann
 * damit später erkennen, ob die zuletzt gelieferten Parameter neuer sind als die eigenen.
 */
export const STRATEGY_DEFINITIONS_VERSION = 1;

/**
 * Konfidenz je Feldwert — bewusst mitgeführt, nicht nur im Kommentar.
 *   'gemessen'   – steht so (oder als deckungsgleicher Referenzwert) in den Messungen
 *   'abgeleitet' – aus einer vorhandenen, kalibrierten Größe übernommen
 *   'geschätzt'  – von niemandem gemessen; erste Kandidaten für die Nachkalibrierung
 * Die Oberfläche (Baustein C) kann daran zeigen, wie belastbar ein Wert ist; ohne die
 * Angabe sähe eine geschätzte Zahl aus wie eine gemessene (Lehre aus [[wirkungsnachweis]]).
 */
export const CONFIDENCE = ['gemessen', 'abgeleitet', 'geschaetzt'];

// ── Der Filter: Pool-Typ PLUS volatilePair PLUS rebalanceDisabled ────────────
//
// Entscheidung 9 (strategie-auswahl.md): Die Vola-Achse allein kann die vier Strategien
// nicht abbilden — `volatil_2` enthält SOL/USDC ebenso wie SOL/PUMP. Die fehlende
// Dimension existiert bereits als Pool-Feld `volatilePair` (21 von 37 Pools). Sie ist
// eine strukturelle Eigenschaft des Pools, keine gepflegte Liste: Ein neuer Pool fällt
// automatisch auf die richtige Seite. Damit bleibt die Regel „neue Pools nie präventiv
// sperren" gewahrt und Entscheidung 3 unverletzt.
//
// ⚠️ `volatilePair` steht in pools.json NIE explizit auf `false` — 21 Pools tragen `true`,
// die übrigen 16 haben das Feld gar nicht. Der Filterwert `false` bedeutet deshalb
// „falsy oder abwesend", nicht „Feld === false". Siehe poolMatchesScope().
//
// 🔒 LIQ#0387: `rebalanceDisabled` ist das DRITTE Filterkriterium, mit derselben
// falsy/abwesend-Semantik wie `volatilePair`. Grund: `rebalance_free` fasst Pools
// zusammen, deren beide Seiten sich gemeinsam bewegen sollen — aber nicht jeder Pool
// dieses Typs hält dieses Versprechen tatsächlich ein (EURC/USDC ist ein Währungspaar,
// kein Stable-Paar, siehe strategie-stablecoin.md). `rebalanceDisabled` ist bereits eine
// strukturelle Eigenschaft (gesetzt bei Pools, die tatsächlich nie nachgezogen werden
// müssen) — keine neu gepflegte Liste, dieselbe Begründung wie bei `volatilePair`.

/**
 * @typedef {Object} StrategyScope
 * @property {string[]} poolTypes             Zugelassene Pool-Typen.
 * @property {boolean|null} volatilePair       `false` = nur Pools ohne volatile Gegenseite
 *                                             (falsy/abwesend), `true` = nur solche mit,
 *                                             `null` = egal.
 * @property {boolean|null} [rebalanceDisabled] `true` = nur Pools mit dem Flag, `false`/
 *                                             fehlend im Scope = egal (kein Kriterium).
 *                                             Nie als „nur Pools OHNE das Flag" verwendet.
 */

/**
 * 🔒 Der Definitionssatz. Struktur = künftige Blob-Sektion.
 *
 * `fields` ist je Pool-Typ getrennt, obwohl heute jede Strategie ihre Werte für alle
 * zugelassenen Typen gleich oder fast gleich setzt: Die Range hängt an der Vola-Klasse,
 * und sobald eine Strategie zwei Klassen zulässt (Ruhiges Kapital), braucht sie zwei
 * Werte. Die Matrix bleibt deshalb, auch wo sie heute nur eine Zeile hat.
 *
 * Nicht im Feldsatz, jeweils mit Grund:
 *   • cleanup.rankingEligible — Entscheidung 9.1: Die Typ-Zulassung der Strategie IST der
 *     Ranking-Filter. `rankingEligible` bleibt die Handübersteuerung des Nutzers für einen
 *     einzelnen Pool. Zwei Mechanismen, zwei Zwecke.
 *   • Mindestkapital — Entscheidung 9: bekommt kein Feld, bleibt Empfehlung im
 *     Strategietext. CLEANUP_MIN_DEPOSIT ist global und liegt in der .env.
 *   • CLEANUP_MODE / CLEANUP_MIN_SCORE / CLEANUP_MAX_DEPOSIT — liegen in der Liquidity-.env
 *     (bots/liquidity/lib/config.js), also einem dritten Speicherort, und kein
 *     Strategietext nennt für sie einen Wert. Einen zu erfinden wäre genau das, was die
 *     Kalibrierungssperre verhindern soll. Geprüft und bestätigt in LIQ#0383 (Befund dort
 *     zusätzlich für score-architektur.md: CLEANUP_MIN_SCORE=70 ist für ruhige Pools
 *     strukturell unerreichbar, keine Kalibrierungsfrage).
 *   • Das automatische Scharfschalten beim ersten Deposit (lib/settings-auto.js) — eigenes
 *     Ticket LIQ#0362.
 *   • trailingStop.minimumValueUsd und tvlProtection.level1.thresholdUsd — pool-individuell,
 *     hängen an der Kapitalgröße. Werden auch vom bestehenden Pool-Typ-Bulk-Write nie
 *     angefasst (bots/settings/routes/pools.js, DEFAULT_POOL_TYPE_SETTINGS).
 *
 * ── CLEANUP_TREND_GATE ist der eine Fall, der die Begründung oben widerlegt (LIQ#0383) ──
 *
 * Anders als CLEANUP_MIN_SCORE/MAX_DEPOSIT nennt hier sehr wohl jeder der vier
 * Strategietexte einen Wert — nur als Prosa, nicht als Feld: „Es gibt kein Timing-Signal"
 * (Ruhiges Kapital, Fee-Ernte wörtlich per Verweis, Kapitalerhalt sinngemäß), „Es gibt kein
 * prädiktives Signal" (Ereignisfenster, dessen eigener Einstiegsauslöser ein beobachteter
 * Fee-APR-Anstieg ist, kein Kurstrend). Alle vier lehnen ein Kurs-Timing-Gate für den
 * Einstieg ab — dieselbe Erkenntnis, die kTrend/Trend-Gewicht im Score bereits einzeln
 * widerlegt hat (KB project_invest_trend_investigation.md), wirkt hier als Vorfilter weiter.
 *
 * Trotzdem KEIN Feldsatz-Eintrag und KEINE Moduls-Regel („Strategie aktiv → Gate immer
 * aus"): Ersteres bräuchte einen dritten Speicherort für eine .env-Größe (Bulk-Write,
 * Rücknahme bei Premium-Ende — die ganze Schreib-Maschinerie greift dort nicht), Letzteres
 * wäre ein verborgener Hebel, der in "Was diese Strategie tut" nicht auftaucht (dasselbe
 * Muster wie der Ranking-Exit ohne Tab, LIQ#0365, und das Dry-Run-Gate, LIQ#0380) und
 * schriebe "kein Timing-Gate" als Struktureigenschaft fest, obwohl es eine Aussage über
 * die heute vier Strategien ist.
 *
 * Stattdessen: `trendGate` ist eine DEKLARATION je Strategie, kein Schreibvorgang — exakt
 * dasselbe Muster wie `rangeStepOffset` unten und wie `poolMatchesScope()` beim
 * Ranking-Filter. `trendGateForPool()` liefert den deklarierten Wert (Array, `[]` = Gate
 * aus) nur, wenn eine Strategie aktiv UND der Pool in ihrem Geltungsbereich ist — sonst
 * `null`, und der Aufrufer (bin/cleanup.js) fällt dann auf CLEANUP_TREND_GATE aus der .env
 * zurück. Bei "Standard" ist das immer der Fall: byte-identisches Verhalten zu heute, siehe
 * bots/liquidity/bin/test-strategy-trend-gate.js.
 */
export const STRATEGIES = [
    {
        id:       'ruhiges_kapital',
        doc:      'Strategien/strategie-ruhiges-kapital.md',
        // Benennung nach Risikohaltung, nie nach Zielrendite (Entscheidung 1). Die
        // Erwartungswerte stehen im Strategietext und werden hier bewusst nicht
        // wiederholt — eine Zahl im Parametersatz läse sich als Zusage.
        //
        // `summary` (LIQ#0385): Ein einmal geschriebener Klartext für den "Funktionsweise"-
        // Tab (Baustein C, überarbeitet) — Ersatz für die vorher dort gezeigte Feldsatz-
        // Tabelle. Fällt via i18n-Key `sliq.strategy_summary_<id>` in en.json/de.json,
        // dieser Wert ist nur der Fallback, falls der Key fehlt.
        summary: 'Diese Strategie legt Kapital in einen ruhigen Pool mit USDC-Seite (z. B. '
               + 'cbBTC/USDC oder SOL/USDC) und lässt es lange liegen. Die Range wird bewusst '
               + 'breit gesetzt, damit Kursschwankungen nicht sofort zum Rebalancing zwingen. '
               + 'Es gibt kein Timing-Signal für den Einstieg und keinen automatischen '
               + 'Kurs-Ausstieg — nur der TVL-Schutz bleibt aktiv, falls der Pool selbst '
               + 'austrocknet.',
        scope: { poolTypes: ['volatil_1', 'volatil_2'], volatilePair: false },
        // LIQ#0371: Die Range kommt bei volatilen Pools in aller Regel vom Range Advisor
        // (bin/bot.js, _getAdvisedRange() — läuft bei jedem Öffnen/Rebalancing neu), nicht
        // von einer festen Prozentzahl. Eine Strategie drückt ihre Range deshalb als
        // Stufenversatz auf der Advisor-Leiter (CANDIDATE_RANGES) aus, nie als `range.fixedPct`
        // — siehe KB Strategien/strategie-auswahl.md, „Wie eine Strategie die Range ausdrückt".
        // +2 Stufen: bewusst breiter als das Gebühren-Optimum, weil der Advisor den Preis-Leg
        // strukturell nicht sieht (IL-Term kürzt sich gegen die Range-Breite heraus). +2 statt
        // +3, um die Fee-Erfassung nicht stärker zu opfern als für die Preis-Leg-Absicherung
        // nötig — ein Kompromiss, keine Messung (Wert bleibt 'abgeleitet').
        rangeStepOffset:           2,
        rangeStepOffsetConfidence: 'abgeleitet',
        // LIQ#0383: „Es gibt kein Timing-Signal … Wer auf den perfekten Einstieg wartet,
        // wartet auf etwas, das in den Daten nicht existiert." — wörtlich gegen ein
        // Kurs-Timing-Gate. Deklaration, kein Feldsatz-Eintrag (siehe Kopfkommentar).
        trendGate:           [],
        trendGateConfidence: 'gemessen',
        // LIQ#0461: Ein Range-Hinweis ist fachlich dieselbe Aufforderung zum Ausstieg wie
        // trailingStop/scoreLimit — „lässt es lange liegen … kein automatischer Kurs-Ausstieg"
        // (Strategietext) gilt für alle drei gleichermaßen. Deshalb aus, unterdrückt sowohl
        // den Hinweis als auch die automatische Range-Änderung (`_advisorRebalanceCheck`).
        rangeHints:           false,
        rangeHintsConfidence: 'abgeleitet',
        fields: {
            volatil_1: {
                'trailingStop.enabled':          { value: false, confidence: 'gemessen'   },
                'scoreLimit.enabled':            { value: false, confidence: 'gemessen'   },
                'tvlProtection.level1.enabled':  { value: true,  confidence: 'gemessen'   },
                'autoCompound.enabled':          { value: true,  confidence: 'gemessen'   },
                'autoCompound.fraction':         { value: 100,   confidence: 'gemessen'   },
            },
            volatil_2: {
                'trailingStop.enabled':          { value: false, confidence: 'gemessen'   },
                'scoreLimit.enabled':            { value: false, confidence: 'gemessen'   },
                'tvlProtection.level1.enabled':  { value: true,  confidence: 'gemessen'   },
                'autoCompound.enabled':          { value: true,  confidence: 'gemessen'   },
                'autoCompound.fraction':         { value: 100,   confidence: 'gemessen'   },
            },
        },
    },
    {
        id:    'fee_ernte',
        doc:   'Strategien/strategie-fee-ernte.md',
        summary: 'Diese Strategie setzt auf enge Ranges in ertragsstarken Pools und zieht sie '
               + 'automatisch nach, sobald der Kurs die Range verlässt. Dadurch verdient sie '
               + 'deutlich mehr Gebühren als eine breite Range — bezahlt das aber mit dem '
               + 'Kursverlust, der bei jedem Nachziehen realisiert wird. Netto lag der Ertrag '
               + 'in den bisher gemessenen Fällen nahe null.',
        scope: { poolTypes: ['volatil_3'], volatilePair: false },
        // LIQ#0371: Versatz 0 — diese Strategie lebt vom Fee-Leg und folgt deshalb dem
        // Gebühren-Optimum des Advisors unverändert. Entscheidung 9.3 bleibt unberührt: Der
        // Advisor-Mindestwert für volatil_3 (6 %) wird dadurch nicht aus diesem Ticket heraus
        // gesenkt, der Versatz verschiebt nur relativ zur jeweils aktuellen Empfehlung.
        rangeStepOffset:           0,
        rangeStepOffsetConfidence: 'abgeleitet',
        // LIQ#0383: „Wie bei [[strategie-ruhiges-kapital]]: kein Timing-Signal."
        trendGate:           [],
        trendGateConfidence: 'gemessen',
        // LIQ#0461: Gegenteil von "Ruhiges Kapital" — Versatz 0 heißt ausdrücklich, dem
        // Gebühren-Optimum des Advisors zu folgen ("lebt vom Fee-Leg", siehe rangeStepOffset
        // oben). Ein Range-Hinweis ist hier keine unerwünschte Ausstiegsaufforderung,
        // sondern genau das Signal, das die Strategie nutzen will. An.
        rangeHints:           true,
        rangeHintsConfidence: 'abgeleitet',
        fields: {
            volatil_3: {
                'trailingStop.enabled':          { value: true,  confidence: 'gemessen'   },
                // Entscheidung 9.4: kein erfundener Zahlenwert für „weit". Der
                // Trailing-Stop-Advisor kalibriert die Schwelle am gemessenen Zittern je
                // Pool — genau die Eigenschaft, die „weit genug, um nicht auf Rauschen zu
                // feuern" braucht. `thresholdPct` steht deshalb NICHT im Feldsatz: Der
                // pool-individuelle Wert bleibt als Rückfallebene stehen (er ist Pflicht,
                // solange trailingStop aktiv ist), der Advisor überschreibt ihn zur Laufzeit.
                'trailingStop.auto':             { value: true,  confidence: 'abgeleitet' },
                // Stufe 2 ist der enger nachziehende Ratchet — das Zitter-Niveau, das der
                // Strategietext ausdrücklich nicht will („Reißleine, kein Ertragsinstrument").
                'trailingStop.thresholdPct2':    { value: null,  confidence: 'gemessen'   },
                // 6 h ist der seit 03.09. kalibrierte Cooldown gegen Sofort-Wiedereinstiege.
                'trailingStop.cooldownHours':    { value: 6,     confidence: 'abgeleitet' },
                'scoreLimit.enabled':            { value: false, confidence: 'gemessen'   },
                'tvlProtection.level1.enabled':  { value: true,  confidence: 'gemessen'   },
                'autoCompound.enabled':          { value: true,  confidence: 'gemessen'   },
                'autoCompound.fraction':         { value: 100,   confidence: 'gemessen'   },
            },
        },
    },
    {
        id:  'stablecoin',
        doc: 'Strategien/strategie-stablecoin.md',
        // LIQ#0387: umbenannt von "Kapitalerhalt" und im Geltungsbereich verengt.
        // "Kapitalerhalt" versprach etwas, das cbBTC/WBTC und SOL/JitoSOL nicht leisten:
        // Ihr Preis-Leg ist nur im Verhältnis der beiden Token null, nicht in USDC — fällt
        // BTC um 40 %, fällt eine cbBTC/WBTC-Position um 40 %. Die gemessenen 0,00 %/Tag
        // (KB Strategien/ertragsanatomie.md) waren ein ruhiges BTC-Fenster, keine
        // Struktureigenschaft. Dieselbe Fehlerklasse wie eine Zielrendite im Namen
        // (Entscheidung 1). Diese beiden Pools gehören jetzt zu "Token Maximierung".
        summary: 'Diese Strategie parkt Kapital in echten Stable-Paaren (USDG/USDC, '
               + 'syrupUSDC/USDC), deren Kursverhältnis strukturell kaum schwankt — beide '
               + 'Seiten hängen am selben USD-Wert. Dadurch ist das Kursrisiko fast null — '
               + 'aber auch der Ertrag: gemessen rund 0,00–0,01 % pro Tag. Kein '
               + 'Ertragsvehikel, sondern ein Parkplatz für Kapital, das gerade nicht '
               + 'anders arbeiten soll.',
        // LIQ#0387: Geltungsbereich verengt auf echte Stable-Paare. Nur `volatilePair:
        // false` reichte nicht — EURC/USDC ist ebenfalls `rebalance_free` ohne
        // `volatilePair`, aber ein Währungspaar (also eine Währungswette),
        // belegt mit −7,45 USDC über 60 Tage im Fee-/Preis-Rechner, weil EUR gegen USD
        // lief. `rebalanceDisabled` trennt genau richtig: USDG/USDC und syrupUSDC/USDC
        // tragen es (müssen tatsächlich nie nachgezogen werden), EURC/USDC nicht — das
        // System wusste das strukturell bereits, es war nur nie Auswahlkriterium.
        // Ausgeschlossen wird EURC/USDC damit NICHT per Pool-Liste (verletzte
        // Entscheidung 3), sondern über dieses strukturelle Feld.
        scope: { poolTypes: ['rebalance_free'], volatilePair: false, rebalanceDisabled: true },
        // LIQ#0371: Versatz 0 — in korrelierten Paaren ist der Preis-Leg strukturell null,
        // die Blindstelle des Advisors (fehlende Preis-Leg-Sicht) hat hier keine Wirkung.
        rangeStepOffset:           0,
        rangeStepOffsetConfidence: 'abgeleitet',
        // LIQ#0383: „Einstieg: jederzeit, kein Signal, kein Timing."
        trendGate:           [],
        trendGateConfidence: 'gemessen',
        // LIQ#0461: Gleiches Feldprofil wie "Ruhiges Kapital" (trailingStop/scoreLimit
        // beide aus) und Strategietext ausdrücklich „kein Ertragsvehikel, sondern ein
        // Parkplatz für Kapital, das gerade nicht anders arbeiten soll" — ein Range-Hinweis
        // wäre hier reine Fee-Feinjustierung auf einem Pool, der bewusst liegen bleiben
        // soll. Kein wörtlicher Beleg wie bei "Ruhiges Kapital", aber dieselbe Haltung
        // (Festlegung 09.09.2026). Aus.
        rangeHints:           false,
        rangeHintsConfidence: 'abgeleitet',
        fields: {
            rebalance_free: {
                'trailingStop.enabled':          { value: false, confidence: 'gemessen'   },
                'scoreLimit.enabled':            { value: false, confidence: 'gemessen'   },
                'tvlProtection.level1.enabled':  { value: true,  confidence: 'gemessen'   },
                'autoCompound.enabled':          { value: true,  confidence: 'gemessen'   },
                'autoCompound.fraction':         { value: 100,   confidence: 'abgeleitet' },
            },
        },
    },
    {
        id:  'token_maximierung',
        doc: 'Strategien/strategie-token-maximierung.md',
        // LIQ#0387: neue Strategie für cbBTC/WBTC und SOL/JitoSOL — Pools, deren beide
        // Seiten volatil sind, deren TOKEN-VERHÄLTNIS sich aber kaum bewegt. Bewusst NICHT
        // "Pools, bei denen keine Anpassung der Range erfolgen muss" — das trifft auf
        // SOL/JitoSOL nicht zu (siehe rebalanceDisabled-Hinweis unten).
        // 🔒 Lohnt sich NUR in Bullenmärkten: Diese Strategie maximiert die TOKEN-ANZAHL,
        // nicht den USDC-Wert — fällt der Basiswert, fällt die Position mit. Das ist die
        // Kernaussage, keine Randnotiz (Ticket-Pflicht für den "Funktionsweise"-Tab).
        summary: 'Diese Strategie hält Kapital in Pools, bei denen sich das Verhältnis der '
               + 'beiden Token kaum bewegt (cbBTC/WBTC, SOL/JitoSOL), und lässt die '
               + 'Token-Anzahl durch Gebühren und — bei SOL/JitoSOL — Staking-Ertrag '
               + 'wachsen. 🔒 Das lohnt sich nur in Bullenmärkten: Diese Strategie '
               + 'maximiert die Token-Anzahl, nicht den USDC-Wert. Fällt der Basiswert '
               + '(BTC bzw. SOL), fällt die Position im USDC-Wert mit.',
        // LIQ#0387: BEWUSST OHNE `rebalanceDisabled` als Kriterium. SOL/JitoSOL trägt das
        // Flag nicht und soll es auch nicht bekommen — gemessen über pool_stats: 94 Tage
        // Drift Anfang→Ende −1,34 % (Monatsschnitt monoton fallend, kein einziger
        // Rücklauf), das ist der Staking-Ertrag von JitoSOL, keine Schwankung. Bei enger
        // Range liefe die Position ohne Rebalancing dauerhaft aus der Range — SOL/JitoSOL
        // wird also weiterhin nachgezogen. cbBTC/WBTC trägt das Flag zwar (154 Tage
        // Spanne 0,41 %, stationär), aber ein gemeinsames Kriterium für beide Pools dieser
        // Strategie gibt es damit nicht — der Filter bleibt bei Pool-Typ + volatilePair.
        scope: { poolTypes: ['rebalance_free'], volatilePair: true },
        // Wie bei "Stablecoin": der Preis-Leg ist im Token-Verhältnis strukturell klein,
        // die Advisor-Blindstelle (fehlende Preis-Leg-Sicht) hat hier kaum Wirkung.
        rangeStepOffset:           0,
        rangeStepOffsetConfidence: 'geschaetzt',
        // Wie bei den übrigen drei Strategien: kein Kurs-Timing-Gate für den Einstieg.
        trendGate:           [],
        trendGateConfidence: 'abgeleitet',
        // LIQ#0461: SOL/JitoSOL braucht laut Text weiterhin Nachziehen gegen den
        // Staking-Drift ("wird also weiterhin nachgezogen") — ein Unterdrücken wäre hier das
        // Gegenteil dessen, was der Strategietext für diesen Pool ausdrücklich will. An.
        rangeHints:           true,
        rangeHintsConfidence: 'geschaetzt',
        fields: {
            rebalance_free: {
                'trailingStop.enabled':          { value: false, confidence: 'geschaetzt' },
                'scoreLimit.enabled':            { value: false, confidence: 'geschaetzt' },
                'tvlProtection.level1.enabled':  { value: true,  confidence: 'geschaetzt' },
                'autoCompound.enabled':          { value: true,  confidence: 'geschaetzt' },
                'autoCompound.fraction':         { value: 100,   confidence: 'geschaetzt' },
            },
        },
    },
    {
        id:  'lambo',
        doc: 'Strategien/strategie-lambo.md',
        // ⚠️ Der Strategietext empfiehlt diese Strategie ausdrücklich NICHT (netto über die
        // Historie negativ; der passende, ertragsseitige Ausstieg fehlt in FORGE — Feature
        // F3 im Strategien-Hub). Sie steht hier, weil sie die einzige ist, in der die 5-
        // und 10-%-Marke überhaupt gemessen wurde.
        // 🔒 `notRecommended` wirkt seit 2026-09-04 NICHT mehr in der Settings-Weboberfläche
        // (Icon in der Select-Box und Warnbox im Anwenden-Modal bewusst entfernt)
        // — bleibt aber als Feld bestehen, weil `bots/settings/bin/strategy.js --list`/
        // `--deviations` (Admin-CLI) weiterhin darauf liest.
        notRecommended: true,
        summary: 'Diese Strategie zielt auf kleine, volatile Pools mit sehr hohen '
               + 'kurzfristigen Gebühren (bis über 20 % pro Tag gemessen). In der Praxis '
               + 'wurde dieser Ertrag bisher durch Kursverluste immer wieder aufgezehrt — '
               + 'FORGE hat noch keinen Ausstieg, der den Gewinn rechtzeitig sichert.',
        // Keine volatilePair-Einschränkung: Vier der fünf gemessenen Pools haben keine
        // USDC-Seite (STONK/SOL, USELESS/SOL, ORE/SOL, PUMP/SOL).
        scope: { poolTypes: ['volatil_3'], volatilePair: null },
        // LIQ#0371: +1 Stufe — „eher weit" laut Strategietext, aber vor allem: hohe
        // Fee-Tiers machen jedes Nachziehen teuer, ein Rebalancing hier ist gegenüber
        // Fee-Ernte spürbar kostspieliger. Kein gemessener Wert.
        rangeStepOffset:           1,
        rangeStepOffsetConfidence: 'geschaetzt',
        // LIQ#0383: „Es gibt kein prädiktives Signal — auch hier nicht." Der eigene
        // Einstiegsauslöser ist ein beobachteter Fee-APR-Anstieg (kein Kurstrend) — die
        // Absage gilt trotzdem, das Kurs-Trend-Gate misst hier eine andere Achse als das,
        // worauf die Strategie tatsächlich reagiert.
        trendGate:           [],
        trendGateConfidence: 'gemessen',
        // LIQ#0461: Dasselbe Argument, das oben rangeStepOffset +1 begründet — „hohe
        // Fee-Tiers machen jedes Nachziehen teuer" —, wörtlich auch bei der Range selbst:
        // „Range 5 % oder mehr … enge Ranges verursachen Dauer-Rebalancing bei hohen
        // Fee-Tiers" (Strategietext). Ein Range-Hinweis würde tendenziell zu genau der
        // engeren, teuren Range raten. Aus (Festlegung 08.09.2026).
        rangeHints:           false,
        rangeHintsConfidence: 'abgeleitet',
        fields: {
            volatil_3: {
                'trailingStop.enabled':          { value: true,  confidence: 'gemessen'   },
                'trailingStop.auto':             { value: true,  confidence: 'abgeleitet' },
                'trailingStop.thresholdPct2':    { value: null,  confidence: 'gemessen'   },
                'trailingStop.cooldownHours':    { value: 6,     confidence: 'abgeleitet' },
                'scoreLimit.enabled':            { value: false, confidence: 'gemessen'   },
                'tvlProtection.level1.enabled':  { value: true,  confidence: 'gemessen'   },
                'autoCompound.enabled':          { value: true,  confidence: 'geschaetzt' },
                'autoCompound.fraction':         { value: 100,   confidence: 'geschaetzt' },
            },
        },
    },
];

// ── Gemessene Verteilung (LIQ#0373, Entscheidung 1, zweite Hälfte) ──────────
//
// Entscheidung 1 verlangt neben dem Haltungs-Namen die gemessene Verteilung, damit der
// Name keine unbelegte Behauptung bleibt. Quelle ist bewusst Master-Daten, nicht die
// eigene Installation (Festlegung 2026-09-03) — bei einer frisch
// installierten Instanz wäre die Anzeige sonst leer, ausgerechnet dort, wo sie die
// Entscheidung tragen soll. Dieselbe Weichenstellung wie beim Feldsatz selbst
// (STRATEGY_DEFINITIONS_VERSION, künftig Premium-Blob).
//
// 🔒 Jede Zahl hier steht wortgleich in einem der vier Strategietexte
// (Strategien/strategie-*.md) — nichts wird aggregiert, interpoliert oder aus mehreren
// Messungen zu einer Kennzahl verdichtet. Wo der Text keine Zahl für ein Feld liefert
// (z. B. p10/p90, oder n je Einzelpool bei Ereignisfenster), bleibt das Feld `null` statt
// geschätzt — die Anzeige muss das explizit als „nicht gemessen" zeigen, nicht verschweigen
// oder auf einen Nachbarwert ausweichen.

/**
 * @typedef {Object} DistributionEntry
 * @property {'historie'|'rechner'} source     'historie' = gemessene Episoden, 'rechner' =
 *                                              Fee-/Preis-Rechner auf einem festen Zeitfenster.
 * @property {string} pool                     Betroffener Pool (oder mehrere, kommagetrennt).
 * @property {number|null} n                   Episoden (historie) oder Positionen (rechner).
 *                                              `null` = im Text nicht ausgewiesen.
 * @property {string} periodLabel              Zeitraum/Stichprobe in Textform, immer sichtbar.
 * @property {number|null} nettoPctPerDay      Netto %/Tag, wenn ein einzelner Punktwert im
 *                                              Text steht.
 * @property {string|null} nettoPctPerDayLabel Alternative Darstellung (Spanne, USDC-Betrag),
 *                                              wenn kein einzelner %/Tag-Wert vorliegt.
 * @property {number|null} verlustquotePct     Nur gesetzt, wenn für GENAU diesen Pool/diese
 *                                              Strategie im Text beziffert — nicht aus einer
 *                                              anderen Vergleichsgruppe übernommen.
 * @property {number|null} haltedauerMedianH   Median-Haltedauer in Stunden, falls im Text.
 * @property {'gemessen'|'abgeleitet'|'geschaetzt'} confidence
 * @property {string} caveat                   Die Einschränkung aus dem „Grenzen"-Abschnitt,
 *                                              die diese Zahl trägt (Zeitfenster, Marktlage,
 *                                              Streuung).
 */

export const STRATEGY_DISTRIBUTIONS = {
    ruhiges_kapital: [
        {
            source: 'historie', pool: 'cbBTC/USDC', n: 5,
            periodLabel: 'Historie, Median 176 h gehalten',
            nettoPctPerDay: 0.05, nettoPctPerDayLabel: null,
            verlustquotePct: null, haltedauerMedianH: 176,
            confidence: 'gemessen',
            caveat: 'Nur 5 Episoden — die kleinste Stichprobe der vier Strategien.',
        },
        {
            source: 'rechner', pool: 'cbBTC/USDC', n: null,
            periodLabel: '±10 % Range, 60 Tage, 1.000 USDC',
            nettoPctPerDay: 0.11, nettoPctPerDayLabel: null,
            verlustquotePct: null, haltedauerMedianH: null,
            confidence: 'abgeleitet',
            caveat: 'Ein einzelnes 60-Tage-Fenster, Aufwärtsmarkt (cbBTC +24 %). Ein Pfad, kein Erwartungswert.',
        },
    ],
    fee_ernte: [
        {
            source: 'historie', pool: 'ZEC/USDC', n: 15,
            periodLabel: 'Historie, Median 8,4 h gehalten',
            nettoPctPerDay: 0.01, nettoPctPerDayLabel: null,
            verlustquotePct: null, haltedauerMedianH: 8.4,
            confidence: 'gemessen',
            caveat: 'Überwiegend vor der Trailing-Stop-Kalibrierung vom 30./31.08. — ob frühe Auslösungen seitdem zurückgehen, ist noch nicht nachgemessen.',
        },
    ],
    // LIQ#0387: umbenannt von "kapitalerhalt", Geltungsbereich verengt auf echte
    // Stable-Paare — der cbBTC/WBTC-Historieneintrag ist mit umgezogen zu
    // "token_maximierung" (der Pool gehört jetzt zu dieser Strategie), da bleibt nur
    // noch der USDG/USDC-Rechnerwert.
    stablecoin: [
        {
            source: 'rechner', pool: 'USDG/USDC', n: null,
            periodLabel: '±0,15 % Range, 60 Tage, 1.000 USDC',
            nettoPctPerDay: 0.001, nettoPctPerDayLabel: null,
            verlustquotePct: null, haltedauerMedianH: null,
            confidence: 'abgeleitet',
            caveat: 'Praktisch null — diese Strategie ist ein Kapital-Parkplatz, kein Ertragsvehikel.',
        },
    ],
    // LIQ#0387: cbBTC/WBTC-Historieneintrag von "kapitalerhalt" umgezogen — der Pool
    // gehört jetzt zu dieser Strategie, nicht mehr zu "stablecoin".
    token_maximierung: [
        {
            source: 'historie', pool: 'cbBTC/WBTC', n: 2,
            periodLabel: 'Historie, 457 h gehalten',
            nettoPctPerDay: 0.00, nettoPctPerDayLabel: null,
            verlustquotePct: null, haltedauerMedianH: 457,
            confidence: 'gemessen',
            caveat: 'Nur 2 Episoden, gemessen in einem ruhigen BTC-Fenster — sagt nichts über den USDC-Wert bei fallendem BTC-Kurs.',
        },
    ],
    // Lambo (vormals "ereignisfenster"): kein Rechner-Abgleich möglich (Pools ohne
    // USDC-Seite), deshalb nur Historie — und die auch nur je Einzelpool, nie als
    // Gesamt-Median über alle fünf: Die Pools sind zu unterschiedlich (STONK/SOL allein
    // −10,14 %/Tag gegen +0,85 %/Tag bei HYPE/SOL), ein Mittelwert wäre eine erfundene
    // Kennzahl ohne Gegenstück im Text.
    lambo: [
        {
            source: 'historie', pool: 'STONK/SOL', n: 6,
            periodLabel: 'Historie, Median 1,1 h gehalten',
            nettoPctPerDay: -10.14, nettoPctPerDayLabel: null,
            verlustquotePct: null, haltedauerMedianH: 1.1,
            confidence: 'gemessen',
            caveat: 'Nur 6 Episoden, enorme Streuung (dpd p25 −69,6 %, p90 +10,7 %).',
        },
        {
            source: 'historie', pool: 'USELESS/SOL', n: null,
            periodLabel: 'Historie, Median 11,0 h gehalten',
            nettoPctPerDay: 0.19, nettoPctPerDayLabel: null,
            verlustquotePct: null, haltedauerMedianH: 11.0,
            confidence: 'gemessen',
            caveat: 'Stichprobengröße für diesen Pool im Strategietext nicht einzeln ausgewiesen.',
        },
        {
            source: 'historie', pool: 'HYPE/SOL', n: null,
            periodLabel: 'Historie, Median 14,5 h gehalten',
            nettoPctPerDay: 0.85, nettoPctPerDayLabel: null,
            verlustquotePct: null, haltedauerMedianH: 14.5,
            confidence: 'gemessen',
            caveat: 'Stichprobengröße für diesen Pool im Strategietext nicht einzeln ausgewiesen.',
        },
        {
            source: 'historie', pool: 'ORE/SOL', n: null,
            periodLabel: 'Historie, Median 67,9 h gehalten',
            nettoPctPerDay: -0.75, nettoPctPerDayLabel: null,
            verlustquotePct: null, haltedauerMedianH: 67.9,
            confidence: 'gemessen',
            caveat: 'Stichprobengröße für diesen Pool im Strategietext nicht einzeln ausgewiesen.',
        },
        {
            source: 'historie', pool: 'PUMP/SOL', n: null,
            periodLabel: 'Historie, Median 11,5 h gehalten',
            nettoPctPerDay: -0.28, nettoPctPerDayLabel: null,
            verlustquotePct: null, haltedauerMedianH: 11.5,
            confidence: 'gemessen',
            caveat: 'Stichprobengröße für diesen Pool im Strategietext nicht einzeln ausgewiesen.',
        },
    ],
};

/**
 * Die gemessene Verteilung einer Strategie, oder `[]` wenn keine hinterlegt ist
 * (z. B. „Standard").
 *
 * @param {Object|null} strategy  getStrategy()-Ergebnis oder null.
 * @returns {DistributionEntry[]}
 */
export function distributionForStrategy(strategy) {
    if (!strategy) return [];
    return STRATEGY_DISTRIBUTIONS[strategy.id] ?? [];
}

/** Alle Strategie-IDs. `null` (= „Standard") ist bewusst KEINE davon, siehe getStrategy(). */
export const STRATEGY_IDS = STRATEGIES.map(s => s.id);

/**
 * 🔒 „Standard" ist die ABWESENHEIT einer Strategie (Entscheidung 8): kein Feldsatz, kein
 * Bulk-Write, keine Abweichungs-Anzeige. Die Rückkehr zu Standard lässt die zuletzt
 * gesetzten Werte stehen — sie gehören danach nur niemandem mehr. Wäre „Standard" ein
 * Feldsatz, würde seine Auswahl alle handgepflegten Werte auf Defaults zurücksetzen, und
 * eine Rückkehr wäre ein Eingriff ins Live-Kapital.
 *
 * @param {string|null} id
 * @returns {Object|null} Die Definition, oder null für „Standard"/unbekannt.
 */
export function getStrategy(id) {
    if (id == null || id === '') return null;
    return STRATEGIES.find(s => s.id === id) ?? null;
}

/**
 * Gehört ein Pool in den Geltungsbereich einer Strategie?
 *
 * @param {{poolType?: string, volatilePair?: boolean}} pool  Pool aus pools.json.
 * @param {StrategyScope} scope
 */
export function poolMatchesScope(pool, scope) {
    if (!scope.poolTypes.includes(pool?.poolType)) return false;
    if (scope.volatilePair !== null && scope.volatilePair !== undefined) {
        // Bewusst über Wahrheitswert, nicht über ===: das Feld fehlt bei 16 von 37 Pools
        // vollständig und ist nie explizit `false`.
        if (!!pool.volatilePair !== scope.volatilePair) return false;
    }
    if (scope.rebalanceDisabled) {
        // LIQ#0387: nur als „muss gesetzt sein"-Kriterium verwendet, nie umgekehrt —
        // dieselbe Wahrheitswert-Logik wie oben.
        if (!pool?.rebalanceDisabled) return false;
    }
    return true;
}

/** Der Feldsatz, den eine Strategie für einen konkreten Pool vorsieht. */
export function fieldsForPool(strategy, pool) {
    if (!strategy || !poolMatchesScope(pool, strategy.scope)) return null;
    return strategy.fields[pool.poolType] ?? null;
}

// ── Range als Stufenversatz (LIQ#0371) ───────────────────────────────────────
//
// Eine Strategie gibt volatilen Pools keine feste Range-Prozentzahl vor — die Range kommt
// in aller Regel vom Range Advisor (bin/bot.js, _getAdvisedRange(), läuft bei jedem
// Öffnen/Rebalancing neu). Eine Strategie drückt ihre Risikohaltung stattdessen als Versatz
// in Stufen gegenüber der jeweils aktuellen Advisor-Empfehlung aus. Siehe KB
// Strategien/strategie-auswahl.md, Abschnitt „Wie eine Strategie die Range ausdrückt".
//
// 🔒 Das Anwenden auf der CANDIDATE_RANGES-Leiter (Index verschieben, auf Pool-Typ-Grenzen
// clampen) liegt bewusst NICHT hier, sondern in bots/liquidity/bin/bot.js, wo diese Werte
// schon vorhanden sind — sonst müsste diese Datei lib/range-advisor.js importieren und wäre
// nicht mehr abhängigkeitsfrei (Kommentar am Dateikopf).

/**
 * Liefert den Stufenversatz, den eine Strategie für einen konkreten Pool vorsieht.
 * 0 wenn keine Strategie aktiv ist ("Standard") oder der Pool außerhalb ihres
 * Geltungsbereichs liegt — beides bedeutet: keine Wirkung auf die Range.
 *
 * @param {Object|null} strategy  Aktive Strategie (getStrategy()-Ergebnis) oder null.
 * @param {{poolType?: string, volatilePair?: boolean}} pool
 * @returns {number}
 */
export function rangeStepOffsetForPool(strategy, pool) {
    if (!strategy || !poolMatchesScope(pool, strategy.scope)) return 0;
    return strategy.rangeStepOffset ?? 0;
}

// ── Trend-Gate als Deklaration (LIQ#0383) ─────────────────────────────────────
//
// CLEANUP_TREND_GATE liegt in der Liquidity-.env, nicht in dieser Datei (siehe
// Kopfkommentar, „CLEANUP_TREND_GATE ist der eine Fall …") — trendGateForPool() liest also
// nichts, das hier geschrieben wird, sondern liefert nur die Auskunft, OB und WORAUF eine
// aktive Strategie den .env-Wert überstimmt. Der Schreibvorgang bleibt dort, wo er heute
// ist; nur die Entscheidung, welcher Wert gilt, wandert hierher.

/**
 * Deklarierter Trend-Gate-Wert einer Strategie für einen konkreten Pool.
 *
 * `null` bedeutet „keine Deklaration" — keine Strategie aktiv ("Standard") oder der Pool
 * liegt außerhalb ihres Geltungsbereichs. Der Aufrufer fällt dann auf CLEANUP_TREND_GATE
 * aus der .env zurück, exakt das heutige Verhalten.
 *
 * Ein Array (auch `[]`) bedeutet „diese Strategie deklariert einen Wert" — `[]` heißt
 * dabei ausdrücklich „Gate aus", nicht „keine Angabe". Die Unterscheidung `null` vs. `[]`
 * ist deshalb absichtlich, nicht redundant.
 *
 * @param {Object|null} strategy  Aktive Strategie (getStrategy()-Ergebnis) oder null.
 * @param {{poolType?: string, volatilePair?: boolean}} pool
 * @returns {string[]|null}
 */
export function trendGateForPool(strategy, pool) {
    if (!strategy || !poolMatchesScope(pool, strategy.scope)) return null;
    return strategy.trendGate ?? null;
}

// ── Range-Hinweise als Deklaration (LIQ#0461) ─────────────────────────────────
//
// Ein Range-Hinweis (bot.js, _advisorRangeHintScan()) ist fachlich eine Aufforderung zum
// Close-and-Reopen — dieselbe Kategorie wie trailingStop/scoreLimit, nur ohne eigenen
// Schalter, weil er formal keine Automatik ist. `_advisorRebalanceCheck()` kann bei
// gesetzter `rangeOverride.fixedPct` dieselbe Empfehlung sogar automatisch anwenden. Beide
// Pfade lesen denselben deklarierten Wert — anders als bei `trendGateForPool()` gibt es
// hier keinen .env-Fallback, „keine Deklaration" bedeutet deshalb `true` (heutiges
// Verhalten), nicht `null`.

/**
 * Deklarierter Range-Hinweis-Wert einer Strategie für einen konkreten Pool.
 *
 * `true` (auch ohne aktive Strategie oder außerhalb des Geltungsbereichs — „Standard"):
 * Range-Hinweise und die automatische Range-Änderung laufen wie heute. `false`: Beide
 * Pfade schalten für diesen Pool still.
 *
 * @param {Object|null} strategy  Aktive Strategie (getStrategy()-Ergebnis) oder null.
 * @param {{poolType?: string, volatilePair?: boolean}} pool
 * @returns {boolean}
 */
export function rangeHintsForPool(strategy, pool) {
    if (!strategy || !poolMatchesScope(pool, strategy.scope)) return true;
    return strategy.rangeHints ?? true;
}

// ── Entscheidung 5: Lockerung sofort, Verschärfung nur für neue Positionen ────
//
// „Lockerungen gelten sofort für alle Positionen, Verschärfungen nur für neu eröffnete."
// Die Gefahr ist einseitig: Eine engere Stop-Schwelle kann eine bestehende Position sofort
// über die Kante schieben — ausgerechnet beim Wechsel von offensiv auf konservativ, also
// genau dann, wenn der Nutzer vorsichtiger werden will. Eine Lockerung kann nie einen Exit
// auslösen.
//
// 🔒 Das Prüfkriterium ist deshalb NICHT „ist der Wert strenger?", sondern die eine Frage:
//    Kann diese Änderung einen Kapitalabzug auslösen, der sonst nicht stattgefunden hätte?
// Danach ist ein längerer Cooldown neutral (er bremst den Wiedereinstieg, nicht den
// Ausstieg), und ein abgeschalteter TVL-Schutz eine Lockerung, obwohl er das Risiko erhöht.

export const CHANGE_KINDS = ['loosening', 'tightening', 'neutral'];

/**
 * Wie wirkt die Änderung eines Feldes auf eine BESTEHENDE Position?
 *
 * @returns {'loosening'|'tightening'|'neutral'}
 */
export function classifyChange(path, oldValue, newValue) {
    if (oldValue === newValue) return 'neutral';

    switch (path) {
        // Ein Exit-Mechanismus wird eingeschaltet → kann feuern. Ausgeschaltet → nie.
        case 'trailingStop.enabled':
        case 'scoreLimit.enabled':
        case 'tvlProtection.level1.enabled':
        case 'tvlProtection.level2.enabled':
            return newValue ? 'tightening' : 'loosening';

        // Größerer Drawdown-Spielraum = später feuern.
        case 'trailingStop.thresholdPct':
            return numericDirection(oldValue, newValue, 'higherIsLooser');

        // Stufe 2 ist der enger nachziehende Ratchet. Setzen/verschärfen = früher feuern,
        // löschen (null) = nie feuern.
        case 'trailingStop.thresholdPct2':
            if (newValue == null) return 'loosening';
            if (oldValue == null) return 'tightening';
            return numericDirection(oldValue, newValue, 'higherIsLooser');

        // Höhere Score-Schwelle = früher feuern.
        case 'scoreLimit.minScore':
            return numericDirection(oldValue, newValue, 'lowerIsLooser');

        // Eine engere Range erzwingt ein Rebalancing: Die alte Position wird geschlossen und
        // der aufgelaufene Kursverlust dabei realisiert. Für eine bestehende Position ist das
        // derselbe Schaden wie ein zu enger Stop — siehe strategie-fee-ernte.md, „Das
        // Nachziehen ist der Preis". Deshalb behandelt wie eine Exit-Schwelle.
        case 'range.fixedPct':
            return numericDirection(oldValue, newValue, 'higherIsLooser');

        // Der Advisor stellt die Schwelle zur Laufzeit; die Richtung ist zum Zeitpunkt des
        // Anwendens unbekannt. Unbekannt heißt hier: wie eine Verschärfung behandeln.
        case 'trailingStop.auto':
            return newValue ? 'tightening' : 'loosening';

        // Kein Einfluss darauf, OB ein Exit stattfindet:
        //   *.cooldownHours  – bremst den Wiedereinstieg
        //   *.withdrawPct    – bestimmt nur, wie viel abgezogen wird, wenn es soweit ist
        //   *.swapToUsdc / *.autoSwapToUSDC / *.sendTo – Nachbehandlung
        //   autoCompound.*   – Ertragsverwendung
        //   maxInvestment.*  – Deckel für NEUES Kapital
        case 'trailingStop.cooldownHours':
        case 'scoreLimit.cooldownHours':
        case 'tvlProtection.cooldownHours':
        case 'tvlProtection.level1.withdrawPct':
        case 'tvlProtection.level2.withdrawPct':
        case 'tvlProtection.swapToUsdc':
        case 'trailingStop.autoSwapToUSDC':
        case 'scoreLimit.swapToUsdc':
        case 'autoCompound.enabled':
        case 'autoCompound.fraction':
        case 'autoCompound.minClaimUsdc':
        case 'autoCompound.swapToUsdc':
        case 'maxInvestment.enabled':
        case 'maxInvestment.amountUsdc':
            return 'neutral';

        // Die Typ-Zulassung selbst. `pools.enabled = false` sperrt einen Pool ausschließlich
        // vom Investieren und Reaktivieren — es schließt nie eine Position (nachgelesen in
        // bots/liquidity/bin/cleanup.js:646 und :880). Damit kann die Zulassung nach dem
        // Kriterium oben keinen Exit auslösen und gilt sofort.
        //
        // ⚠️ Das weicht bewusst von PUT /liquidity/pool-types/:poolType ab: Die Route lehnt
        // ein `enabled: false` für Pools mit offener Position mit 409 ab. Das ist dort eine
        // UI-Vorsichtsregel, keine Kapitalregel — für den Strategie-Pfad wäre sie falsch,
        // weil sonst ein Typwechsel an einer einzigen offenen Position hängen bliebe.
        case 'poolEnabled':
            return 'neutral';

        default:
            // 🔒 Unbekanntes Feld = wie eine Verschärfung behandeln. Ein neues Feld, das
            // jemand hier zu ergänzen vergisst, wird dann höchstens zu spät wirksam — nie
            // zu früh auf einer offenen Position. Der teure Fehler ist nur in eine Richtung
            // möglich, also fällt der Default in die andere.
            return 'tightening';
    }
}

/** Zahlenvergleich mit expliziter Richtungsangabe; nicht-numerisch → 'tightening'. */
function numericDirection(oldValue, newValue, rule) {
    const a = Number(oldValue);
    const b = Number(newValue);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 'tightening';
    if (a === b) return 'neutral';
    const looser = rule === 'higherIsLooser' ? b > a : b < a;
    return looser ? 'loosening' : 'tightening';
}

// ── Die Entscheidung je Feld ─────────────────────────────────────────────────

/** Gründe, aus denen ein Feld nicht geschrieben wird. */
export const SKIP_REASONS = ['no_range_slot', 'locked', 'deferred_open_position'];

/**
 * Wird dieses eine Feld geschrieben — und wenn nicht, warum nicht?
 *
 * 🔒 Bewusst eine reine Funktion ohne DB und ohne Seiteneffekt, obwohl sie nur an einer
 * Stelle aufgerufen wird (applyStrategy()). Sie ist die Regel, die eine bestehende Position
 * davor schützt, durch einen Strategiewechsel über die Kante geschoben zu werden — und
 * damit die einzige Stelle dieses Bausteins, an der ein Fehler unmittelbar Kapital kostet.
 * Als reine Funktion ist sie vollständig prüfbar (bin/test-strategies.js); eingebettet in
 * die Schreibschleife wäre sie es nur gegen eine echte Datenbank mit offener Position.
 * „Laut scheiternder Code schlägt Prosa."
 *
 * Die Reihenfolge der Prüfungen ist Absicht: Erst was strukturell unmöglich ist
 * (kein Slot), dann was der Nutzer ausdrücklich festgelegt hat (locked), dann die
 * Asymmetrie aus Entscheidung 5. Ein von Hand fixierter Wert bleibt damit auch dann
 * unangetastet, wenn die Änderung eine harmlose Lockerung wäre.
 *
 * @param {string} path
 * @param {*} current
 * @param {*} target
 * @param {{hasOpenPosition: boolean, rangeLocked?: boolean, rangeWritable?: boolean}} ctx
 * @returns {{action: 'unchanged'|'write'|'skip', kind: string, reason: string|null}}
 */
export function decideField(path, current, target, ctx) {
    const kind = classifyChange(path, current, target);
    if (current === target) return { action: 'unchanged', kind: 'neutral', reason: null };

    if (path === 'range.fixedPct') {
        if (ctx.rangeWritable === false) return { action: 'skip', kind, reason: 'no_range_slot' };
        if (ctx.rangeLocked   === true)  return { action: 'skip', kind, reason: 'locked' };
    }
    // Entscheidung 5: Eine Verschärfung darf eine bestehende Position nicht treffen.
    // Sie geht nicht verloren — sie erscheint als Abweichung und wird beim nächsten
    // applyStrategy() nach dem Positionsende nachgeholt.
    if (kind === 'tightening' && ctx.hasOpenPosition) {
        return { action: 'skip', kind, reason: 'deferred_open_position' };
    }
    return { action: 'write', kind, reason: null };
}

/**
 * Reine Rückrichtungs-Entscheidung für LIQ#0382 (Premium-Ende nimmt Strategie-Felder
 * zurück, kehrt Entscheidung 6 um): soll EIN Feld zurückgenommen werden, und wohin?
 * DB-frei und ohne Seiteneffekt, damit sie ohne echte Installation testbar ist —
 * bots/settings/lib/strategy-apply.js (`rollbackStrategyOnPremiumLoss()`) liest dafür
 * die jeweils letzte `settings_history`-Zeile je (Pool, Feld) und reicht sie hier durch.
 *
 * Kapselt zwei der vier Sicherheitsregeln aus dem Ticket:
 *   Regel 2 — nur zurücknehmen, wenn der Ist-Wert noch exakt dem entspricht, was die
 *             Strategie zuletzt geschrieben hat (sonst hat der Nutzer seither selbst
 *             etwas gesetzt, sein Wert bleibt stehen).
 *   Regel 3 — dieselbe Asymmetrie wie beim Anwenden (`decideField()`), nur mit
 *             vertauschten Rollen: „current" ist der Strategie-Wert, „target" der
 *             Alt-Wert von davor. Eine Rücknahme, die eine Verschärfung wäre, wird bei
 *             offener Position übersprungen statt geschrieben.
 *
 * @param {string} path
 * @param {*} current  aktueller Ist-Wert
 * @param {{oldValue: *, newValue: *, source: string}|null|undefined} historyRow
 *   die letzte settings_history-Zeile für dieses Feld, oder null/undefined ohne Zeile.
 * @param {{hasOpenPosition: boolean, rangeLocked?: boolean, rangeWritable?: boolean}} ctx
 * @returns {{action: 'revert'|'skip'|'none', to?: *, kind?: string, reason?: string}}
 *   'none'  – keine strategiegetriebene Zeile, oder seither von Hand anders gesetzt
 *             (Regel 2 greift nicht, das Feld bleibt schlicht unangetastet).
 *   'skip'  – strategiegetrieben und unverändert, aber die Rücknahme selbst ist laut
 *             decideField() gerade nicht schreibbar (Regel 3, oder `locked`/kein Slot).
 *   'revert'– schreiben, `to` ist der Zielwert (das alte `oldValue`).
 */
export function decideRollbackField(path, current, historyRow, ctx) {
    if (!historyRow || historyRow.source !== 'strategy') return { action: 'none' };
    if (current !== historyRow.newValue) return { action: 'none' };

    const { action, kind, reason } = decideField(path, current, historyRow.oldValue, ctx);
    if (action === 'skip') return { action: 'skip', to: historyRow.oldValue, kind, reason };
    // action ist hier nie 'unchanged': decideField() liefert das nur bei current === target,
    // was Regel 2 oben (current === historyRow.newValue) bereits ausschließt, außer
    // newValue === oldValue — das kann recordSettingsHistory() aber gar nicht erst
    // schreiben (diffChangedFields() lässt unveränderte Felder aus).
    return { action: 'revert', to: historyRow.oldValue, kind };
}

// ── Hilfen für Punkt-Pfade ───────────────────────────────────────────────────

// ── Ranking-Filter (LIQ#0369) ────────────────────────────────────────────────
//
// Entscheidung 9.1: Die Typ-Zulassung der Strategie IST der Ranking-Filter. Angewendet wird
// sie in bots/liquidity/bin/cleanup.js, runCleanupByRanking() — als Kandidaten-Filter, nicht
// als Schreibvorgang auf pools.enabled (das wäre eine dritte, gepflegte Sperre und würde mit
// der Handübersteuerung `cleanup.rankingEligible` kollidieren).

/**
 * Ist ein Pool ein zulässiger Kandidat für das Score-Ranking unter der aktiven Strategie?
 *
 * 🔒 Bewusst OHNE Positionsstatus im Signature: Diese Funktion kennt `hasOpenPosition` nicht
 * und kann strukturell keinen Exit auslösen. Ein Pool außerhalb des Geltungsbereichs bekommt
 * kein neues Kapital mehr — seine offene Position läuft unangetastet weiter und wird nie
 * zwangsweise geschlossen (Entscheidung 5, „Standard" bleibt bei fehlender Strategie ohnehin
 * unverändert: `strategy` ist dann `null`, jeder Pool bleibt Kandidat).
 *
 * @param {Object|null} strategy  Aktive Strategie (getStrategy()-Ergebnis) oder null für "Standard".
 * @param {{poolType?: string, volatilePair?: boolean}} pool
 */
export function poolRankingEligible(strategy, pool) {
    if (!strategy) return true;
    return poolMatchesScope(pool, strategy.scope);
}

/** Liest einen Punkt-Pfad ('trailingStop.enabled') aus einem verschachtelten Objekt. */
export function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Baut aus einem Punkt-Pfad ein verschachteltes Teil-Objekt: ('a.b', 1) → { a: { b: 1 } }. */
export function setPath(target, path, value) {
    const keys = path.split('.');
    let node = target;
    for (const key of keys.slice(0, -1)) {
        if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
        node = node[key];
    }
    node[keys.at(-1)] = value;
    return target;
}
