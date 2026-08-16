/**
 * FORGE – Pool-Settings: Defaults, Session-Felder, Default-Abgleich
 *
 * Gemeinsame Quelle für die Pool-Einstellungen aus `settings.db` (Tabelle
 * `pool_settings`). Bewusst **abhängigkeitsfrei** (keine Imports, keine Env,
 * kein DB-Treiber): Der Settings-Server und der Liquidity Bot importieren
 * dieselbe Datei, ohne sich gegenseitig ihre Laufzeit-Voraussetzungen
 * hereinzuziehen (analog zur Begründung bei POOL_TYPES in
 * bots/settings/routes/pools.js).
 *
 * 🔒 Leitregel für den Pool-Close (seit 2026-08-15):
 * Eine Einstellung, die der Nutzer gesetzt hat, ist **Konfiguration** und
 * überlebt jeden Kapitalabzug (Trailing Stop, TVL-Schutz, Score-Limit,
 * manueller Withdraw). Zurückgesetzt wird ausschließlich, was
 * **Session-Zustand** ist — siehe POOL_SESSION_FIELDS.
 *
 * Vorher galt die umgekehrte Regel („alles weg außer trailingStop +
 * tvlProtection"). Damit fielen bei jedem Exit stillschweigend Nutzer-
 * entscheidungen zurück auf Default: der Reinvest-Anteil und der Mindest-
 * Claim-Betrag (autoCompound), die Score-Schwelle (scoreLimit) und – am
 * folgenreichsten – `cleanup.rankingEligible`: ein bewusst vom Cleanup
 * ausgenommener Pool war nach dem nächsten Exit wieder in der Auswahl.
 */

// ── Standard-Einstellungen (leere Konfiguration) ──────────────────────────────
export const POOL_SETTINGS_DEFAULTS = {
    autoCompound: {
        enabled:      true,
        fraction:     100,   // Reinvest-Anteil in % (10–100, 10er-Schritte)
        minClaimUsdc: 1,     // Mindestbetrag zum Claimen (0,1–10 USDC; 0,1 nur zum Testen, Default 1)
        sendTo:       '',    // Empfänger-Adresse (leer = Wallet)
        swapToUsdc:   false, // Coins vor Transfer in USDC tauschen
    },
    // Score Limit: Position schließen wenn InvestScore unter Schwelle fällt.
    //   minScore    – InvestScore-Schwelle (0–100, Default 30)
    //   swapToUsdc  – nach Close alle Coins in USDC tauschen
    //   sendTo      – optional, Empfänger-Adresse (leer = Wallet)
    scoreLimit: {
        // true, nicht false: Der Bot schaltet das Score Limit bei der Einrichtung eines
        // Pools ohnehin ein (ensureScoreLimitEnabled in bots/liquidity/lib/settings-auto.js) —
        // der wirksame Zustand war also immer „an", während hier „aus" stand. Damit war ein
        // bewusstes Ausschalten durch den Nutzer nicht vom Normalzustand unterscheidbar und
        // tauchte im Abweichungs-Hinweis nicht auf. Angeglichen 2026-08-15.
        enabled:       true,
        minScore:      30,
        swapToUsdc:    true,
        sendTo:        '',
        cooldownHours: 1,      // Sperrfrist für automatisches Cleanup-Reinvest nach Score-Limit-Exit
    },
    // Trailing Stop: Position schließen wenn lp_value_usd vom HWM um thresholdPct fällt.
    //   thresholdPct      – Drawdown-Schwelle Stufe 1 in % (0,5–90, Default 10)
    //   thresholdPct2     – Drawdown-Schwelle Stufe 2 in %, optional (null = aus).
    //                       Muss kleiner als thresholdPct sein und wird erst wirksam, sobald
    //                       der Positionswert den Einstieg um thresholdPct übertroffen hat —
    //                       ab da wird der erreichte Gewinn enger abgesichert.
    //   autoSwapToUSDC    – nach Close alle Coins in USDC tauschen
    //   sendTo            – optional, Empfänger-Adresse (leer = Wallet)
    trailingStop: {
        enabled:         true,
        thresholdPct:    10,
        thresholdPct2:   null,   // zweite Stufe; null = nur einstufig
        minimumValueUsd: null,   // Pool-Mindestwert in USDC; null = deaktiviert
        autoSwapToUSDC:  true,
        sendTo:          '',
        cooldownHours:   1,      // Sperrfrist für automatisches Cleanup-Reinvest nach TS-Exit
    },
    // Cleanup-Berücksichtigung: nimmt der Pool am Ranking-basierten Cleanup teil?
    cleanup: {
        rankingEligible: true,
    },
    // TVL-Schutz: zweistufiger Pool-Exit wenn der Pool-TVL unter eine Schwelle fällt.
    //   Eskalation: L1 (Stufe 1) hat die höhere Schwelle, L2 (Stufe 2) die tiefere.
    //   Beim Unterschreiten einer Schwelle wird withdrawPct % des Kapitals abgezogen.
    //   Sind beide Stufen aktiv, muss die Summe der withdrawPct exakt 100 ergeben
    //   (L1 zieht den ersten Teil, L2 den Rest). L1 ist optional deaktivierbar.
    //   thresholdUsd === null → noch nie konfiguriert; UI füllt mit den pools.json-
    //   Schwellen (tvlWarnThreshold/tvlExitThreshold) vor.
    //   tvlAtActivation wird vom Liquidity-Bot beim ersten Deposit gesetzt (read-only fürs UI).
    //
    // 🔒 Stufenbelegung (angeglichen 2026-08-15): Der Voll-Exit läuft über **Stufe 1**,
    // Stufe 2 ist aus. Vorher stand hier das Gegenteil (L1 aus, L2 macht den Voll-Exit),
    // während alle 28 produktiven Pools über L1 fuhren — ein neu übernommener Pool
    // startete also gegenläufig zum Rest und musste von Hand umgestellt werden.
    // Die Schutzwirkung ist in beiden Varianten identisch: eine Schwelle, 100 % raus.
    // Wichtig dabei: L1 wird mit der **Exit**-Schwelle aus pools.json vorbefüllt, nicht
    // mit der (höheren) Warn-Schwelle — sonst zöge ein neuer Pool früher voll ab als
    // bisher. Siehe ensureTvlProtectionDefaults in bots/liquidity/lib/settings-auto.js.
    tvlProtection: {
        level1: {
            enabled:      true,  // Default: der Voll-Exit läuft über Stufe 1
            thresholdUsd: null,
            withdrawPct:  100,   // 0–100 in 10er-Schritten
        },
        level2: {
            enabled:      false, // optionale zweite, tiefere Stufe – standardmäßig ungenutzt
            thresholdUsd: null,
            withdrawPct:  100,
        },
        swapToUsdc:      true,   // global für beide Stufen: in USDC tauschen
        sendTo:          '',     // global für beide Stufen: Empfänger (leer = Wallet)
        // 12 h, nicht 1 h: Der Bot legt den TVL-Schutz bei jeder (Re-)Aktivierung mit
        // 12 h an (DEFAULT_TVL_PROTECTION in bots/liquidity/lib/settings-auto.js) —
        // mit 1 h durchlief SOL/ZEC am 2026-08-13 binnen sechs Stunden zweimal den
        // Zyklus „reaktiviert → Kapital rein → TVL-Schutz zieht ab → Exit". Hier stand
        // trotzdem weiter 1, wodurch UI-Default und tatsächlicher Wert auseinanderliefen
        // (jeder Pool in der DB trägt 12). Angeglichen 2026-08-15.
        cooldownHours:   12,
        tvlAtActivation: null,   // nur vom Bot geschrieben
    },
    // Entfallen 2026-08-15: die Sektion `ranking` (Ranking-Exit). Das Feature wurde
    // ausgebaut — bestehende DB-Einträge behalten den Schlüssel, er wird von
    // loadSettings() und diffFromDefaults() schlicht ignoriert.
};

/**
 * Felder, die beim Pool-Close (setPoolActive(false)) entfernt werden.
 *
 * Kriterium: **an das konkrete Engagement gebundener Zustand**, nicht an den Pool.
 * Bleibt so ein Wert stehen, wirkt er nach der nächsten – ggf. viel kleineren –
 * Einzahlung falsch weiter.
 *
 *   trailingStop.minimumValueUsd  Absoluter USD-Betrag, an die Kapitalgröße der
 *                                 damaligen Position gebunden. Bliebe er stehen,
 *                                 griffe er nach einer kleineren Neueinzahlung sofort.
 *   trailingStop.resetRequestedAt Einmalige HWM-Reset-Anforderung. Überlebte sie den
 *   trailingStop.resetTargetUsd   Close, würde der erste Snapshot nach Reaktivierung
 *                                 den frischen HWM sofort wieder überschreiben.
 *   tvlProtection.tvlAtActivation TVL zum Zeitpunkt des Einstiegs; wird bei jeder
 *                                 (Re-)Aktivierung ohnehin neu geschrieben.
 *
 * 🔒 Bewusst NICHT hier: `tvlProtection.level*.thresholdUsd`. Die Schwelle beschreibt
 * eine strukturelle Eigenschaft des Pools (TVL-arme RWA-Pools brauchen dauerhaft
 * niedrigere Werte), nicht das Engagement. Ein Reset führte 2026-07-30 auf forge-pub1
 * (SPCX/USDC) zum Zyklus Deposit → Notfall-Exit → Deposit, jedes Mal mit TX-Kosten.
 */
export const POOL_SESSION_FIELDS = [
    'trailingStop.minimumValueUsd',
    'trailingStop.resetRequestedAt',
    'trailingStop.resetTargetUsd',
    'tvlProtection.tvlAtActivation',
];

function getPath(obj, path) {
    return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/**
 * Entfernt alle POOL_SESSION_FIELDS aus einem Settings-Objekt (ohne das Original
 * zu verändern). Alles andere bleibt unangetastet.
 *
 * @param {Object} settings  Geparste pool_settings-Zeile
 * @returns {{ settings: Object, removed: string[] }} bereinigte Kopie + entfernte Pfade
 */
export function stripSessionFields(settings) {
    const clone   = structuredClone(settings ?? {});
    const removed = [];
    for (const path of POOL_SESSION_FIELDS) {
        const parts  = path.split('.');
        const field  = parts.pop();
        const parent = getPath(clone, parts.join('.'));
        if (parent && typeof parent === 'object' && parent[field] != null) {
            removed.push(path);
            delete parent[field];
        }
    }
    return { settings: clone, removed };
}

/**
 * Vergleicht gespeicherte Pool-Settings mit POOL_SETTINGS_DEFAULTS und liefert
 * jeden Parameter, der den Default überschreibt.
 *
 * Grundlage für den Hinweis in ForgeSettings: seit Einstellungen einen
 * Kapitalabzug überleben, muss auf einen Blick erkennbar sein, wo ein
 * abweichender Wert dauerhaft weiterwirkt.
 *
 * Session-Felder (POOL_SESSION_FIELDS) werden übersprungen — sie sind kein
 * Nutzer-Setting, sondern Bot-Zustand.
 *
 * @param {Object} settings  Geparste pool_settings-Zeile (roh, ungemergt)
 * @param {Object} [overrides]  Pfad → abweichender Default für diesen Pool. Nötig für
 *   `tvlProtection.level*.thresholdUsd`: dort ist der wirksame Default nicht `null`,
 *   sondern die Vorbefüllung aus pools.json (tvlWarnThreshold/tvlExitThreshold).
 *   Ohne das meldete jeder Pool seine vorbefüllte Schwelle als „vom Nutzer geändert".
 * @returns {Array<{path: string, value: *, defaultValue: *}>}
 */
export function diffFromDefaults(settings, overrides = {}) {
    const out = [];
    const walk = (defaults, saved, prefix) => {
        for (const [key, rawDefault] of Object.entries(defaults)) {
            const path = prefix ? `${prefix}.${key}` : key;
            if (POOL_SESSION_FIELDS.includes(path)) continue;
            const defValue   = Object.prototype.hasOwnProperty.call(overrides, path)
                ? overrides[path]
                : rawDefault;
            const savedValue = saved?.[key];
            if (defValue !== null && typeof defValue === 'object' && !Array.isArray(defValue)) {
                walk(defValue, savedValue ?? {}, path);
                continue;
            }
            // Fehlender Wert = Default greift (loadSettings merged genauso).
            if (savedValue === undefined) continue;
            // Leerer String und null sind für sendTo/Schwellen bedeutungsgleich „nicht gesetzt".
            const norm = v => (v === '' || v === null ? null : v);
            if (norm(savedValue) !== norm(defValue)) {
                out.push({ path, value: savedValue, defaultValue: defValue });
            }
        }
    };
    walk(POOL_SETTINGS_DEFAULTS, settings ?? {}, '');
    return out;
}
