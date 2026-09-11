/**
 * FORGE Liquidity – Herkunft der Trailing-Stop-Empfehlungen (Ticket LIQ#0351)
 *
 * Die Naht zwischen Master und Fork, nach dem Vorbild von `invest-score-provider.js`:
 *
 *   'local'     – FORGE Master: `bin/trailing-stop-advisor.js` rechnet selbst, das Ergebnis
 *                 steht in `ts_advisor_log`.
 *   'delivered' – FORGE public mit Premium: das Ergebnis kommt fertig über den Premium-Blob
 *                 und liegt in `data/premium/trailing-stop-advice.json`.
 *   'none'      – kein Advisor-Ergebnis verfügbar (Fork ohne Premium, oder noch nie gelaufen).
 *
 * 🔒 Der Advisor-Code selbst läuft ausschließlich auf dem FORGE-Master. Diese Installation
 * bekommt fertige Ergebnisse, nie Zwischenschritte — weder die ausgewerteten Positionen
 * noch das durchprobierte Schwellenraster.
 *
 * 🔒 Der Zustand ist immer sichtbar: Jede Antwort trägt `source` und `stale`. Ein Feature,
 * das still auf einen anderen Wert zurückfällt, verdeckt genau die Fehler, die man sehen
 * müsste — ein gesperrter Schalter mit Begründung ist besser als ein wirkungsloser.
 */

import { existsSync, readFileSync } from 'fs';

import { TS_ADVICE_PATH } from './premium-ts-advice-store.js';

/**
 * Ablage der über den Premium-Kanal gelieferten Advisor-Ergebnisse.
 * Der Pfad wird vom Store bezogen und nicht zweitgeschrieben — eine zweite Definition
 * hier hätte sich bei der nächsten Änderung lautlos vom Schreibpfad entfernt.
 */
export const DELIVERED_ADVICE_PATH = TS_ADVICE_PATH;

/**
 * Höchstalter gelieferter Empfehlungen. Der Advisor läuft alle 12 Stunden; mit 36 Stunden
 * sind zwei ausgefallene Läufe verkraftbar, ohne dass eine wochenalte Empfehlung
 * unbemerkt weiterwirkt. Danach gilt sie als veraltet und greift nicht mehr.
 */
const DELIVERED_MAX_AGE_MS = 36 * 60 * 60 * 1000;

/** Liest gelieferte Premium-Empfehlungen, oder null wenn nicht vorhanden/unlesbar. */
function tryLoadDelivered() {
    if (!existsSync(DELIVERED_ADVICE_PATH)) return null;
    try {
        const raw   = JSON.parse(readFileSync(DELIVERED_ADVICE_PATH, 'utf8'));
        const ageMs = Date.now() - new Date(raw.generatedAt ?? 0).getTime();
        const stale = !Number.isFinite(ageMs) || ageMs > DELIVERED_MAX_AGE_MS;
        return { stale, ageMs, data: raw };
    } catch {
        return null;
    }
}

/**
 * Hebt die gemessene Empfehlung auf die modellierte an, wenn diese weiter ist (LIQ#0399).
 *
 * ── Warum die reine Prioritätsordnung nicht trägt ─────────────────────────────
 * 🔒 Die Zitter-Messung zählt nur Rücksetzer, die sich WIEDER ERHOLT haben. Ein Rücksetzer,
 * der tiefer geht als die gerade aktive Stop-Schwelle, erholt sich in der Messreihe nie —
 * der Stop beendet die Position und damit die Reihe. Er landet in `openEndPct` und wird
 * verworfen. Damit kann der größte messbare erholte Rücksetzer die aktive Schwelle nicht
 * überschreiten: Für jeden Pool, dessen echtes Zittern darüber liegt, ist Stufe 1 eine
 * Funktion des EINGESTELLTEN Werts, keine Messung des Pools.
 *
 * Nachgewiesen am 2026-09-05 (LIQ#0399), indem die zensierungsfreie Modellreihe künstlich
 * mit einem 1,75-%-Stop zerschnitten und identisch ausgewertet wurde. Die Zensierung allein
 * reproduziert die Messung:
 *
 *     Pool           gemessen   Modell unzensiert   Modell künstlich zensiert
 *     STONK/SOL        2,0            4,75                    2,0
 *     USELESS/SOL      2,25           4,25                    2,0
 *     TRUMP/SOL        1,75           2,75                    2,0
 *     ZEC/USDC         1,75           1,75                   1,75   (unverändert)
 *
 * Ø-Abweichung zur Messung: 0,111 pp nach Zensierung gegen 0,833 pp ohne. Betroffen waren
 * 4 der 6 volatil_3-Pools mit Messreihe. Der Pool-Typ hilft nicht: `gatherNoise()` liest
 * dafür dieselbe `ts_fast_checks` und ist identisch zensiert.
 *
 * ── Warum das Maximum die richtige Antwort ist, ohne Erkennungsheuristik ──────
 * 🔒 BEIDE Schätzer sind nach UNTEN verzerrt, aus unabhängigen Gründen:
 *   - die Messung durch die Zensierung oben,
 *   - das Modell, weil es nur mit dem Preis rechnet und weder Fees noch Claim-Sprünge noch
 *     die Rundung des Preisfeeds kennt (dokumentiert an MODEL_MIN_MAX_PCT).
 * Bei zwei gleichgerichtet untertreibenden Schätzern ist das Maximum der bessere Schätzer —
 * und es braucht keinen Detektor, der selbst falsch liegen kann. Geprüfte Alternativen aus
 * LIQ#0399, alle verworfen: eine Schwelle auf die Trailing-Stop-Exit-Quote trennt nicht
 * (58–100 % bei ALLEN Pools), eine Mindeststichprobe trennt nicht (STONK hatte 37 von 30
 * nötigen Rücksetzern — es ist kein Stichproben-, sondern ein Wertebereichsproblem), und
 * ein Floor aus dem Pool-Typ ist selbst zensiert.
 *
 * Das ist zugleich die Fail-safe-Regel aus [[wirkungsnachweis]]: Zu ENG ist bei diesem
 * Parameter die gefährliche Richtung (Fehl-Exit), das Maximum geht nie darunter.
 *
 * ⚠️ Was das NICHT behauptet: dass die Stops zu eng standen. Gegenprobe an der
 * weiterlaufenden Preisreihe — von 12 STONK-Exits war das Vor-Exit-Niveau binnen 6 h nur
 * 3 × wieder erreicht, bei USELESS 0 von 4. Repariert wird der SCHÄTZER, nicht die Schwelle.
 *
 * @param {{thresholdPct:number, thresholdPct2:number|null}|null} gemessen
 * @param {{thresholdPct:number, thresholdPct2:number|null}|null} modelliert
 * @returns {{thresholdPct:number, thresholdPct2:number|null, raised:boolean}|null}
 */
/**
 * Der Zusatz zur Begründung, wenn der Floor gegriffen hat.
 *
 * 🔒 Der Zustand ist immer sichtbar (Leitregel oben im Modul): Ein Wert, der still von einer
 * anderen Quelle stammt als das Etikett sagt, verdeckt genau den Fehler, den man sehen
 * müsste — hier die Zensierung selbst.
 */
export function floorReason(gemessen, modelliert) {
    return `Von der Preisreihe angehoben: Die Messung endet bei ${Number(gemessen.thresholdPct).toFixed(2)} %, `
         + `weil der Stop die Messreihe vorher beendet; das Modell misst ohne diese Grenze `
         + `${Number(modelliert.thresholdPct).toFixed(2)} % (LIQ#0399).`;
}

/**
 * 🔒 WARUM DER FLOOR NICHT FÜR `pool_type` GILT (geprüft 2026-09-05, LIQ#0399)
 *
 * Der Typ-Wert ist von derselben Zensierung betroffen — `gatherNoise()` liest für
 * `scope_kind='pool_type'` dieselbe `ts_fast_checks`. Unzensiert läge er höher:
 *
 *     volatil_1   zensiert 1,50 %   unzensiert 0,75 %
 *     volatil_2   zensiert 2,00 %   unzensiert 2,50 %
 *     volatil_3   zensiert 2,25 %   unzensiert 4,75 %
 *
 * Ihn trotzdem anzuheben wäre eine VERSCHLECHTERUNG, und zwar aus einem strukturellen
 * Grund: Der Typ-Wert wird nur von Pools gelesen, die WEDER Messung NOCH Modell haben —
 * und die Modellstufe enthält sich fast immer mit `abstained: 'quiet'`, also genau dann,
 * wenn der Pool zu leise ist. Die Leser des Typ-Werts sind damit systematisch die ruhigen
 * Pools. Am 2026-09-05 lag der eigene modellierte Höchstwert aller 15 Rückfall-Pools
 * zwischen 0,00 % und 0,67 %; für sie ist der zensierte Wert bereits zu WEIT. Ein Floor auf
 * 4,75 % nähme ZBCN/SOL (eigenes Zittern 0,59 %) und HYPE/USDC (0,38 %) den Notausgang.
 *
 * ⚠️ Die eine Lücke, die bleibt: Der zweite Enthaltungsgrund `abstained: 'samples'` (zu
 * wenige modellierte Rücksetzer oder gar keine Referenz-Range) trifft nicht die leisen,
 * sondern die NEUEN Pools. Ein frisch aufgenommener, wirklich wilder Pool bekäme in seinen
 * ersten Stunden den zensierten Typ-Wert und damit einen zu ENGEN Stop — die gefährliche
 * Richtung. Nicht behoben, bewusst: Für einen Pool ohne jede eigene Datenlage gibt es keine
 * bessere Quelle als den Typ.
 *
 * ⚠️ Das Fenster schliesst sich NICHT immer schnell — HYPE/USDC stand 12 Advisor-Läufe
 * (6 Tage) in diesem Zweig, NATIX/USDC und SPCX/USDC je unter einem Tag. In allen drei
 * Fällen war der Typ-Wert dennoch weit genug. Eine Anomalie-Regel darauf wurde erwogen und
 * verworfen: Bei einem Alarm gäbe es nichts zu tun, und triagierbar wäre er auch nicht —
 * HYPE/USDC ist als `volatil_3` eingestuft (Vola > 7 %) und zittert im LP-Wert nur 0,38 %.
 * 🔒 Die Pool-Typ-Zuordnung misst Preisvolatilität, nicht stop-relevantes Zittern.
 */

export function applyModelFloor(gemessen, modelliert) {
    if (!gemessen) return null;
    const m1 = Number(gemessen.thresholdPct);
    if (!Number.isFinite(m1)) return null;
    const f1 = modelliert ? Number(modelliert.thresholdPct) : NaN;
    if (!Number.isFinite(f1) || f1 <= m1) {
        return { thresholdPct: m1, thresholdPct2: gemessen.thresholdPct2 ?? null, raised: false };
    }

    // Stufe 2 wandert mit — sonst bliebe die enge Stufe 2 unter einer angehobenen Stufe 1
    // stehen und löste weiterhin im Rauschen aus, gegen das Stufe 1 gerade breiter wurde.
    const g2 = Number(gemessen.thresholdPct2);
    const f2 = modelliert.thresholdPct2 == null ? NaN : Number(modelliert.thresholdPct2);
    const kandidaten = [g2, f2].filter(Number.isFinite);
    let d2 = kandidaten.length ? Math.max(...kandidaten) : null;

    // Dieselbe Invariante wie in recommendFromNoise(): Stufe 2 muss ENGER sein als Stufe 1,
    // sonst würde das Scharfschalten von Stufe 2 den Schutz lockern statt ihn zu verschärfen.
    if (d2 != null && d2 >= f1) d2 = f1 > 0.5 ? Math.max(0.5, f1 - 0.25) : null;
    if (d2 != null && d2 >= f1) d2 = null;

    return { thresholdPct: f1, thresholdPct2: d2, raised: true };
}

/**
 * Die geltende Empfehlung für einen Pool.
 *
 * Vier Stufen, absteigend nach Beweiskraft — je konkreter die Datenlage, desto konkreter
 * die Empfehlung:
 *
 *   'pool'       gemessen  – aus der 30-s-Reihe des Pools (`ts_fast_checks`). Entsteht nur,
 *                            solange Kapital im Pool liegt.
 *   'pool_floor' angehoben  – wie 'pool', aber von der Modellstufe nach oben korrigiert,
 *                            weil die Messung an der aktiven Stop-Schwelle abgeschnitten
 *                            war (LIQ#0399, siehe applyModelFloor()).
 *   'pool_model' modelliert – aus der Preisreihe des Pools (`pool_stats`), die der Bot auch
 *                            für Pools OHNE Kapital führt. Existiert für jeden Pool.
 *   'pool_type'  Pool-Typ  – die gemessene Empfehlung der Geschwisterpools.
 *   (keine)                – der Aufrufer fällt auf Nutzerwerte bzw. den Default zurück.
 *
 * 🔒 Die Modellstufe steht bewusst UNTER der Messung und ÜBER dem Pool-Typ. Sie ersetzt
 * keine Messung — wo eine vorliegt, gewinnt diese immer. Sie ersetzt den Pool-Typ, und
 * genau dagegen wurde sie geprüft: über die acht gegenprüfbaren Pools trifft das Modell die
 * gemessene Empfehlung im Mittel auf 0,250 pp, der Pool-Typ auf 0,281 pp (2026-08-31) — bei
 * gleichzeitig pool-eigenem statt gemitteltem Wert.
 *
 * 🔒 Seit LIQ#0399 gilt dabei eine Einschränkung: Wo BEIDE vorliegen, hebt das Modell die
 * Messung an, wenn es weiter ist (`applyModelFloor()`). Die Messung bleibt die Basis — sie
 * kennt Fees und Claim-Sprünge, die das Modell nicht kennt —, aber sie darf nicht unter dem
 * Modell liegen, weil sie an der aktiven Stop-Schwelle abgeschnitten ist. Das ist KEINE
 * Umkehr der Rangfolge: Ist die Messung weiter, gewinnt sie unverändert.
 *
 * @param {Database|null} db        Bot-DB (Master); im Fork nicht nötig
 * @param {string} poolId
 * @param {string|null} poolType
 * @returns {{ source: 'local'|'delivered'|'none', stale: boolean,
 *             advice: { thresholdPct: number, thresholdPct2: number|null,
 *                       scope: 'pool'|'pool_floor'|'pool_model'|'pool_type', episodes: number, reason: string }|null }}
 */
export function loadTsAdvice(db, poolId, poolType) {
    // ── Fork: geliefertes Ergebnis ────────────────────────────────────────────
    const delivered = tryLoadDelivered();
    if (delivered) {
        const byPool  = delivered.data?.pools?.[poolId];
        const byModel = delivered.data?.poolModels?.[poolId];
        const byType  = poolType ? delivered.data?.poolTypes?.[poolType] : null;
        const hit     = byPool ?? byModel ?? byType ?? null;

        // Der Blob liefert Messung und Modell getrennt (core/premium/trailing-stop-advice.js),
        // der Floor kann deshalb hier genauso greifen wie auf dem Master — eine zweite
        // Rechenstelle im Master-Assembler wäre eine zweite Wahrheit.
        const gehoben = byPool ? applyModelFloor(byPool, byModel) : null;

        return {
            source: 'delivered',
            stale:  delivered.stale,
            // Eine veraltete Empfehlung wird nicht ausgeliefert — sie darf nicht
            // stillschweigend weiterwirken.
            advice: delivered.stale || !hit ? null : {
                thresholdPct:  gehoben ? gehoben.thresholdPct  : hit.thresholdPct,
                thresholdPct2: gehoben ? gehoben.thresholdPct2 : (hit.thresholdPct2 ?? null),
                scope:         byPool ? (gehoben.raised ? 'pool_floor' : 'pool')
                                      : (byModel ? 'pool_model' : 'pool_type'),
                episodes:      hit.episodes ?? 0,
                reason:        byPool && gehoben.raised
                                   ? `${hit.reason ?? ''} ${floorReason(byPool, byModel)}`.trim()
                                   : (hit.reason ?? ''),
            },
        };
    }

    // ── Master: eigenes Ergebnis aus ts_advisor_log ───────────────────────────
    //
    // Gelesen wird die TABELLE, nicht das Advisor-Modul. Das ist bewusst: Das Rechenmodul
    // ist Master-only und im Fork nicht vorhanden — ein Import von hier aus (dieses Modul
    // läuft in beiden Welten) wäre dort ein Ladefehler, ein dynamischer Import wäre
    // asynchron und beantwortete den ersten Aufruf still mit "keine Empfehlung".
    // Die Tabelle gibt es über migrateSchema() überall; im Fork ist sie schlicht leer.
    if (!db) return { source: 'none', stale: false, advice: null };

    const cutoff = Date.now() - DELIVERED_MAX_AGE_MS;

    /** Jüngste belastbare, frische Zeile eines Geltungsbereichs — oder null. */
    const lies = (scopeKind, scopeId) => {
        if (!scopeId) return null;
        const row = db.prepare(`
            SELECT threshold_pct, threshold_pct2, episodes, reason, computed_at
              FROM ts_advisor_log
             WHERE scope_kind = ? AND scope_id = ?
             ORDER BY computed_at DESC LIMIT 1
        `).get(scopeKind, scopeId);
        if (!row || row.threshold_pct == null) return null;   // kein belastbares Ergebnis
        if (row.computed_at < cutoff)          return null;   // veraltet → wirkt nicht mehr
        return { thresholdPct: row.threshold_pct, thresholdPct2: row.threshold_pct2 ?? null,
                 episodes: row.episodes ?? 0, reason: row.reason ?? '' };
    };

    let gemessen, modelliert, vomTyp;
    try {
        gemessen   = lies('pool',       poolId);
        modelliert = lies('pool_model', poolId);
        vomTyp     = lies('pool_type',  poolType);
    } catch {
        return { source: 'none', stale: false, advice: null };   // Tabelle fehlt
    }

    // Messung zuerst — aber nie unter dem Modell (LIQ#0399, siehe applyModelFloor()).
    if (gemessen) {
        const g = applyModelFloor(gemessen, modelliert);
        return {
            source: 'local', stale: false,
            advice: {
                thresholdPct:  g.thresholdPct,
                thresholdPct2: g.thresholdPct2,
                scope:         g.raised ? 'pool_floor' : 'pool',
                episodes:      gemessen.episodes,
                reason:        g.raised ? `${gemessen.reason} ${floorReason(gemessen, modelliert)}`.trim()
                                        : gemessen.reason,
            },
        };
    }

    for (const [scope, treffer] of [['pool_model', modelliert], ['pool_type', vomTyp]]) {
        if (!treffer) continue;
        return {
            source: 'local', stale: false,
            advice: { thresholdPct: treffer.thresholdPct, thresholdPct2: treffer.thresholdPct2,
                      scope, episodes: treffer.episodes, reason: treffer.reason },
        };
    }
    return { source: 'local', stale: false, advice: null };
}
