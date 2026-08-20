/**
 * FORGE LendingBot – Pool-Qualifikation & Auto-Exit
 *
 * Qualifikation:  Pool aktiviert (isPoolEnabled) UND 72h-Durchschnitts-APY ≥ APY_THRESHOLD_PERCENT
 *                 UND weder TVL- noch Liquiditäts-Schutzschwelle unterschritten
 *                 UND ausreichende Datenbasis (minDataPoints / minCoverageHours) —
 *                 ein frisch ins Polling aufgenommener Pool rankt erst mit, wenn sein
 *                 avgApy über genug Messpunkte und Zeit geglättet ist
 * Deposit-Cap:    Pools mit TVL < 1M: max. 2.500 USDC gesamt (Sicherheitsnetz, unverändert)
 * Auto-Exit:      TVL < protokoll-eigene TVL-Schutz-Schwelle → sofortiger Withdraw + Deaktivierung
 *                 Liquidität < Liquiditäts-Schutz-Schwelle → sofortiger Withdraw (ohne Deaktivierung)
 *                 (siehe lib/tvl-guard.js, bin/bot.js checkAndAutoExit)
 *
 * Der frühere hartcodierte TVL-Mindestwert (1M) für die Qualifikation wurde durch
 * die nutzergesteuerte Pool-Freigabe (isPoolEnabled) ersetzt: der Nutzer aktiviert/
 * deaktiviert Pools selbst, und der TVL-Schutz deaktiviert automatisch bei
 * Unterschreitung der individuell eingestellten Schwelle.
 */

import { getDb } from './db.js';
import { config } from './config.js';
import { isPoolEnabled, checkInvestGuards } from './tvl-guard.js';

// ── Konfiguration ─────────────────────────────────────────────────────────────

export const REBALANCER_CONFIG = {
    tvlCapThreshold:  1_000_000,  // TVL ab dem kein Deposit-Cap gilt
    depositCapUsdc:       2_500,  // Max-Gesamtdeposit für Pools mit TVL < tvlCapThreshold
    avgApyHours:             72,  // Zeitfenster für APY-Durchschnitt
    // ── Mindest-Datenbasis für die Qualifikation ─────────────────────────────
    // Der Ranking-Vergleich unterstellt, dass `avgApy` ein geglätteter Wert über
    // das ganze Fenster ist. Für ein gerade erst aufgenommenes Protokoll stimmt
    // das nicht: es hat einen einzigen Messpunkt, und ein einzelner Ausreißer
    // nach oben schickt es an die Ranking-Spitze. Beobachtet am 2026-08-18, als
    // jupiter/kamino-figure/kamino-onre wieder ins Polling kamen — kamino-figure
    // stand nach dem ersten Poll (n=1) mit 6,24 % auf Rang 2, 0,07 Punkte hinter
    // kamino-huma (n=76). Beide Kriterien müssen erfüllt sein:
    minDataPoints:           12,  // Messpunkte im Fenster (Poll läuft stündlich)
    minCoverageHours:        24,  // Beobachtungsdauer: ältester Messpunkt im Fenster
};

// ── 72h-Pool-Statistiken ──────────────────────────────────────────────────────

/**
 * Liest 72h-Durchschnitts-APY sowie neuesten TVL und neueste Liquidität aller
 * Protokolle aus der DB.
 * @returns {Map<string, {avgApy: number, tvl: number|null, liquidity: number|null, dataPoints: number}>}
 */
export function get72hPoolStats() {
    const db    = getDb();
    const since = Date.now() - REBALANCER_CONFIG.avgApyHours * 3600 * 1000;

    // MIN(recorded_at) = Beginn der Beobachtung innerhalb des Fensters. Daraus die
    // tatsächliche Abdeckung — die Anzahl Messpunkte allein reicht nicht: 12 Polls
    // in einer Stunde (z.B. nach mehreren Neustarts) sind keine 12 Stunden Historie.
    const apyRows = db.prepare(`
        SELECT protocol, AVG(apy) AS avg_apy, COUNT(*) AS cnt, MIN(recorded_at) AS first_at
        FROM protocol_stats
        WHERE bot_id = ? AND recorded_at > ?
        GROUP BY protocol
    `).all(config.botId, since);

    // Neuestes TVL pro Protokoll (separater Query wegen SQLite-Kompatibilität).
    //
    // 🔒 Auf dasselbe Fenster begrenzt wie die APY-Zeilen. Ohne `recorded_at > since`
    // lieferte der Query den letzten Datensatz mit TVL — beliebig alt. Fällt ein Protokoll
    // aus dem Polling oder liefert es nur noch APY, rechneten TVL-Schutz und Ranking danach
    // mit einem eingefrorenen Wert weiter. Genau dieser Mechanismus zeigte am 18.08. für
    // kamino-onre 44 Mio. USDC an, real waren es 3,80 (der Fix damals saß nur in
    // bin/export.js). Kein Wert im Fenster → null → "nicht gemessen"; der Invest-Guard
    // sperrt darauf, der Exit-Guard bewusst nicht.
    const tvlRows = db.prepare(`
        SELECT p1.protocol, p1.tvl
        FROM protocol_stats p1
        WHERE p1.bot_id = ?
          AND p1.tvl IS NOT NULL
          AND p1.recorded_at > ?
          AND p1.recorded_at = (
              SELECT MAX(p2.recorded_at)
              FROM protocol_stats p2
              WHERE p2.bot_id = p1.bot_id
                AND p2.protocol = p1.protocol
                AND p2.tvl IS NOT NULL
                AND p2.recorded_at > ?
          )
        GROUP BY p1.protocol
    `).all(config.botId, since, since);

    // Neueste Liquidität pro Protokoll – getrennt vom TVL abgefragt, weil sie
    // erst seit 2026-08-18 erfasst wird und für mehrere Protokolle (noch) NULL
    // ist: der jüngste Stat-Datensatz hat also nicht zwingend einen Wert.
    const liqRows = db.prepare(`
        SELECT p1.protocol, p1.liquidity
        FROM protocol_stats p1
        WHERE p1.bot_id = ?
          AND p1.liquidity IS NOT NULL
          AND p1.recorded_at > ?
          AND p1.recorded_at = (
              SELECT MAX(p2.recorded_at)
              FROM protocol_stats p2
              WHERE p2.bot_id = p1.bot_id
                AND p2.protocol = p1.protocol
                AND p2.liquidity IS NOT NULL
                AND p2.recorded_at > ?
          )
        GROUP BY p1.protocol
    `).all(config.botId, since, since);

    // Hat dieses Protokoll die Liquidität JE geliefert? Bewusst ohne Zeitfenster —
    // die Frage ist nicht "wie hoch ist sie gerade", sondern "kann dieses Protokoll die
    // Kennzahl überhaupt". Davon hängt ab, wie der Invest-Guard ein fehlendes
    // `liquidity` liest: als Erfassungslücke (nie geliefert → keine Sperre) oder als
    // ausgefallene Messung (schon einmal geliefert → Sperre, wie beim TVL).
    //
    // Selbstheilend und ohne Schalter: sobald die Erfassung für ein Protokoll gebaut ist
    // und der erste Wert in der DB steht, gilt die Sperre dort automatisch mit. Stand
    // 20.08.2026 liefern alle gepollten Protokolle außer `drift` die Kennzahl.
    const liqEverRows = db.prepare(`
        SELECT protocol, MAX(recorded_at) AS last_at
        FROM protocol_stats
        WHERE bot_id = ? AND liquidity IS NOT NULL
        GROUP BY protocol
    `).all(config.botId);

    const tvlMap    = new Map(tvlRows.map(r => [r.protocol, r.tvl]));
    const liqMap    = new Map(liqRows.map(r => [r.protocol, r.liquidity]));
    const liqEverMap = new Map(liqEverRows.map(r => [r.protocol, r.last_at]));
    const now    = Date.now();
    const result = new Map();
    for (const row of apyRows) {
        result.set(row.protocol, {
            avgApy:     row.avg_apy,
            tvl:        tvlMap.get(row.protocol) ?? null,
            liquidity:  liqMap.get(row.protocol) ?? null,
            // "Liefert dieses Protokoll die Liquidität grundsätzlich?" — siehe liqEverRows.
            liquidityEverSeen:   liqEverMap.has(row.protocol),
            liquidityLastSeenAt: liqEverMap.get(row.protocol) ?? null,
            dataPoints: row.cnt,
            // Abgedeckter Zeitraum in Stunden (ältester Messpunkt im Fenster → jetzt)
            coverageHours: row.first_at != null ? (now - row.first_at) / 3_600_000 : 0,
        });
    }
    return result;
}

/**
 * Prüft, ob ein Pool genug Datenbasis für einen fairen Ranking-Vergleich hat.
 * Siehe REBALANCER_CONFIG.minDataPoints / minCoverageHours.
 * @returns {{ok: boolean, reason: string|null}}
 */
export function checkDataBasis(stats) {
    const { minDataPoints, minCoverageHours } = REBALANCER_CONFIG;
    const points   = stats?.dataPoints    ?? 0;
    const coverage = stats?.coverageHours ?? 0;
    if (points < minDataPoints) {
        return { ok: false, reason: `nur ${points} von ${minDataPoints} Messpunkten` };
    }
    if (coverage < minCoverageHours) {
        return { ok: false, reason: `erst ${coverage.toFixed(1)}h von ${minCoverageHours}h beobachtet` };
    }
    return { ok: true, reason: null };
}

// ── Pool-Qualifikation ────────────────────────────────────────────────────────

/**
 * Gibt qualifizierte Pools zurück: Pool aktiviert (isPoolEnabled) UND 72h-avg
 * APY ≥ Schwelle UND keine Schutzschwelle unterschritten. Sortiert nach avgApy
 * absteigend.
 *
 * Die Schwellenprüfung ist bewusst live und zusätzlich zur Pool-Freigabe: der
 * TVL-Schutz deaktiviert einen Pool erst beim nächsten Bot-Tick (checkAndAutoExit),
 * der Liquiditäts-Schutz deaktiviert gar nicht. Ohne diese Prüfung könnte
 * "Bester Pool" in genau dem Zeitfenster investieren, in dem der Schutz gerade
 * greift — oder dauerhaft in einen Pool ohne abhebbare Liquidität.
 *
 * Jeder Pool enthält zusätzlich `maxDepositUsdc` (unverändertes Sicherheitsnetz):
 *   - TVL < 1M:  2.500 USDC (Deposit-Cap)
 *   - TVL ≥ 1M:  Infinity (kein Cap)
 *
 * @param {Map<string, {avgApy, tvl}>} poolStats72h
 * @returns {Array<{protocol, avgApy, tvl, maxDepositUsdc}>}
 */
export function getQualifiedPools(poolStats72h) {
    const { tvlCapThreshold, depositCapUsdc } = REBALANCER_CONFIG;
    const minApyPct = config.apyThresholdPercent;
    const result = [];
    for (const [protocol, stats] of poolStats72h) {
        const tvl = stats.tvl ?? 0;
        // Invest-Guard statt checkGuards: identisch bei vorhandenen Messwerten, aber ein
        // FEHLENDER TVL sperrt hier. Beim Eintritt bewegt eine Sperre kein Kapital und der
        // nächstbeste Pool rückt nach; beim Austritt wäre dieselbe Regel gefährlich
        // (Begründung in checkInvestGuards, lib/tvl-guard.js).
        if (!checkInvestGuards(protocol, stats).ok) continue;
        // Zu dünne Datenbasis → nicht ranken. Bewusst ein Ausschluss und keine
        // Abwertung: ein Pool mit einem einzigen Messpunkt ist nicht "etwas
        // schlechter", sein avgApy ist schlicht nicht vergleichbar.
        if (!checkDataBasis(stats).ok) continue;
        if (stats.avgApy >= minApyPct && isPoolEnabled(protocol)) {
            const maxDepositUsdc = tvl >= tvlCapThreshold ? Infinity : depositCapUsdc;
            result.push({ protocol, avgApy: stats.avgApy, tvl: stats.tvl, maxDepositUsdc });
        }
    }
    return result.sort((a, b) => b.avgApy - a.avgApy);
}

// ── Diagnose ──────────────────────────────────────────────────────────────────

export function diagnose() {
    const stats72h  = get72hPoolStats();
    const qualified = getQualifiedPools(stats72h);
    const { tvlCapThreshold, depositCapUsdc } = REBALANCER_CONFIG;
    const minApyPct = config.apyThresholdPercent;

    const fmtTvl = tvl => tvl == null ? '—' :
        tvl >= 1e6 ? `$${(tvl / 1e6).toFixed(1)}M` : `$${(tvl / 1e3).toFixed(0)}K`;

    const lines = [
        'Pool-Diagnose',
        `  Schwellwerte : APY ≥ ${minApyPct}%  |  Pool muss aktiviert sein (Settings-UI) + TVL-Schutz + Liquiditäts-Schutz (pro Pool, siehe Settings)`,
        `  Datenbasis   : mind. ${REBALANCER_CONFIG.minDataPoints} Messpunkte und ${REBALANCER_CONFIG.minCoverageHours}h Beobachtung im ${REBALANCER_CONFIG.avgApyHours}h-Fenster`,
        `  Deposit-Cap  : max. ${depositCapUsdc.toLocaleString('de-DE')} USDC bei TVL < ${fmtTvl(tvlCapThreshold)}`,
        '',
        '  Alle bekannten Pools (72h-Daten):',
    ];

    for (const [protocol, stats] of stats72h) {
        const tvl      = stats.tvl ?? 0;
        const apyOk    = stats.avgApy >= minApyPct ? '✅' : '❌';
        const enabled  = isPoolEnabled(protocol);
        const enabledOk = enabled ? '✅' : '❌';
        // Dieselbe Funktion wie im Ranking — die Diagnose muss denselben Grund nennen,
        // aus dem ein Pool tatsächlich übersprungen wird, sonst erklärt sie das Falsche.
        const invest    = checkInvestGuards(protocol, stats);
        const guardNote = invest.ok ? '' : ` [gesperrt: ${invest.reason}]`;
        const capNote = (tvl < tvlCapThreshold)
            ? ` [Cap: ${depositCapUsdc.toLocaleString('de-DE')} USDC]` : '';
        const basis     = checkDataBasis(stats);
        const basisNote = basis.ok ? '' : ` [Datenbasis: ${basis.reason}]`;
        lines.push(
            `    ${protocol.padEnd(22)} APY: ${stats.avgApy.toFixed(2).padStart(5)}% ${apyOk}  ` +
            `TVL: ${fmtTvl(stats.tvl).padStart(7)}  ` +
            // Zwei Gründe für einen fehlenden Liquiditätswert, die verschieden zu lesen
            // sind: "nie erfasst" ist eine Erfassungslücke (kein Sperrgrund), ein
            // fehlender Wert bei sonst lieferndem Protokoll ist ein Ausfall (Sperrgrund).
            `Liq: ${(stats.liquidity == null
                ? (stats.liquidityEverSeen ? 'keine Messung' : 'nie erfasst')
                : fmtTvl(stats.liquidity)).padStart(13)}  ` +
            `Aktiviert: ${enabledOk}${guardNote}${basisNote}${capNote}  ` +
            `(${stats.dataPoints} Messpunkte / ${stats.coverageHours.toFixed(1)}h)`
        );
    }

    lines.push('', `  Qualifiziert: ${qualified.length} von ${stats72h.size} Pools`);
    qualified.forEach((p, i) =>
        lines.push(`    ${i + 1}. ${p.protocol}  ${p.avgApy.toFixed(2)}% APY  TVL ${fmtTvl(p.tvl)}`)
    );

    return lines.join('\n');
}
