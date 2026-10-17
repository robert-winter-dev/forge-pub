/**
 * Pool-Advisor des LendingBots (LEN#001366): erkennt Erholung und Ausfall.
 *
 *   ausgelaufener Pool erholt sich  → Ticket "Lending-Pool wieder aufnehmen"
 *   Pool im Angebot fällt aus       → Ticket "Lending-Pool auslaufen lassen"
 *
 * Beide Tickets gehen an den Admin-Agenten, der den Zustand über
 * bin/pool-state.js umstellt. Dieses Modul ändert das Register nie.
 *
 * Teile, alle ohne Bot, DB und Nexus testbar (Abhängigkeiten werden übergeben;
 * bin/bot.js startet beim Import seine main()):
 *
 *   createRecoveryProbe   Messung ausgelaufener Pools: höchstens ein erfolgreicher Aufruf
 *                         je Pool und Tag, bei Fehler genau ein Wiederholversuch mit Abstand.
 *   createErrorLog        Abfragefehler der Pools im Angebot je Tag (für die Ausfall-Prüfung).
 *   evaluateRecovery      bewertet den VERLAUF, nie einen Einzelwert.
 *   evaluateDecline       dasselbe in Gegenrichtung.
 *   runAdvisor            ein Lauf: auswerten, höchstens ein Ticket je Pool.
 *
 * Geprüft wird in beide Richtungen dasselbe, nämlich alles, was den Bot aussteigen lässt:
 * TVL, freie Liquidität, Erreichbarkeit der Schnittstelle (429 getrennt ausgewiesen).
 * Kriterien kommen aus dem Block `pruefung` des Registers (lib/lending-pools.js); ohne
 * Block wird ein Pool nie geprüft. Begründung: pool-register.md in der Projektdokumentation.
 */

/** Anteil freier Liquidität am TVL, darunter gilt der Pool als nicht ok (liquidityLevel() in
 *  html/lending/js/app.js: warn unter 2 % des TVL). */
export const MIN_LIQUIDITY_SHARE = 0.02;
/** Wie weit der TVL zwischen Anfang und Ende des Zeitraums sinken darf, ohne als fallend
 *  zu gelten. */
export const TVL_TOLERANCE = 0.02;
/** So viele Tage im Erholungszeitraum dürfen wegen 429 ohne Messwert sein. Ein 429 sagt
 *  etwas über die Schnittstelle, nichts über den Pool; ohne Toleranz käme ein Pool an
 *  einer gelegentlich drosselnden Schnittstelle nie zurück. */
export const MAX_429_DAYS = 2;
/** Mindestabstand zwischen zwei Versuchen am selben Tag. */
export const RETRY_GAP_MS = 3 * 3_600_000;
/** Aufbewahrte Tage je Pool. */
export const KEEP_DAYS = 60;
/** Empfänger der Tickets (Agora-Akteur des Admin-Agenten auf talos). */
export const TICKET_ASSIGNEE = 'talos:admin-system';
/** Titel-Präfixe: an ihnen erkennt der Admin-Agent seine Routine. Nicht umformulieren. */
export const TITLE_RECOVER = 'Lending-Pool wieder aufnehmen: ';
export const TITLE_RETIRE  = 'Lending-Pool auslaufen lassen: ';

export const kvKeyRecoverySeries = id => `recovery_series:${id}`;
export const kvKeyQueryErrors    = id => `pool_query_errors:${id}`;

// ─── Helfer ───────────────────────────────────────────────────────────────────

/** Liest eine JSON-Liste aus kv; kaputter Inhalt gilt als leer (nie als Erholung). */
export function parseSeries(raw) {
    try {
        const arr = JSON.parse(raw ?? '[]');
        return Array.isArray(arr) ? arr.filter(s => s && typeof s.day === 'string') : [];
    } catch {
        return [];
    }
}

/** Tag (YYYY-MM-DD) um n Tage verschieben; rechnet auf UTC-Mitternacht, daher DST-sicher. */
export function shiftDay(day, n) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/** 429 erkennen: der Nexus reicht den HTTP-Status im Fehlertext durch. */
export const is429 = err => /\b429\b|too many requests|rate.?limit/i.test(String(err?.message ?? err));

function median(values) {
    const s = [...values].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const measured = s => !!s && !s.error && Number.isFinite(s.tvl) && s.tvl > 0;

/**
 * Welche Ausstiegsschwelle ein Tageswert reißt: 'tvl' | 'liquiditaet' | null. Liquidität,
 * die ein Protokoll gar nicht liefert (null), ist kein Befund.
 *
 * Bewusst nur die absoluten Schwellen, wie beim TVL- und Liquiditäts-Schutz des Bots
 * (lib/tvl-guard.js). Die 2-%-Regel gilt nur für die Erholung: Als Ausfallgrund würfe sie
 * große, gesunde Pools raus (Kamino Figure, 13.10.2026: 600 Tsd. USDC frei bei 35 Mio. TVL).
 */
function breach(s, cfg) {
    if (s.tvl < cfg.minTvlUsd) return 'tvl';
    if (Number.isFinite(s.liquidity) && s.liquidity < cfg.minLiquiditaetUsd) return 'liquiditaet';
    return null;
}

// ─── Auswertung: Erholung ─────────────────────────────────────────────────────

/**
 * @param {Array<{day: string, tvl?: number|null, liquidity?: number|null, error?: string, errorKind?: string}>} series
 * @param {{zeitraumTage: number, minLiquiditaetUsd: number, minTvlUsd: number, tvlTrend: string}} cfg
 * @param {string} today  YYYY-MM-DD in FORGE_TZ
 * @returns {{recovered: boolean, reasons: string[], stats: object}}
 *
 * Geprüft werden die `zeitraumTage` Tage VOR heute (gestern rückwärts). Ein heutiger
 * Messwert zählt mit, fehlt er, ist das keine Lücke: der Tag ist ja noch nicht vorbei.
 * Fehlt ein Tag davor oder steht dort ein Fehler, ist der Pool "nicht erholt"; nur
 * 429-Tage werden bis MAX_429_DAYS hingenommen.
 */
export function evaluateRecovery(series, cfg, today) {
    const reasons = [];
    const byDay = new Map(series.map(s => [s.day, s]));
    const days = [];
    for (let i = cfg.zeitraumTage; i >= 1; i--) days.push(shiftDay(today, -i));
    if (byDay.has(today)) days.push(today);

    const samples = [];
    let missing = 0, failed = 0, throttled = 0;
    for (const day of days) {
        const s = byDay.get(day);
        if (!s) missing++;
        else if (measured(s) && Number.isFinite(s.liquidity)) samples.push(s);
        else if (s.errorKind === '429') throttled++;
        else failed++;
    }
    if (missing)  reasons.push(`Messlücke: ${missing} von ${days.length} Tagen ohne Messwert`);
    if (failed)   reasons.push(`Abfragefehler an ${failed} Tag(en)`);
    if (throttled > MAX_429_DAYS) {
        reasons.push(`Schnittstelle lehnte an ${throttled} Tagen wegen zu vieler Zugriffe ab (429), erlaubt sind ${MAX_429_DAYS}`);
    }

    const stats = {
        days: days.length, samples: samples.length, days429: throttled,
        minLiquidity: samples.length ? Math.min(...samples.map(s => s.liquidity)) : null,
        minTvl:       samples.length ? Math.min(...samples.map(s => s.tvl)) : null,
        tvlStart: null, tvlEnd: null, tvlChange: null,
    };

    if (samples.length) {
        const lowLiq = samples.filter(s => s.liquidity < cfg.minLiquiditaetUsd || s.liquidity < MIN_LIQUIDITY_SHARE * s.tvl);
        if (lowLiq.length) {
            reasons.push(`freie Liquidität an ${lowLiq.length} Tag(en) unter der Schwelle `
                + `(${cfg.minLiquiditaetUsd} USDC oder ${MIN_LIQUIDITY_SHARE * 100} % des TVL), `
                + `Minimum ${stats.minLiquidity.toFixed(0)} USDC`);
        }
        const lowTvl = samples.filter(s => s.tvl < cfg.minTvlUsd);
        if (lowTvl.length) {
            reasons.push(`TVL an ${lowTvl.length} Tag(en) unter ${cfg.minTvlUsd} USDC, Minimum ${stats.minTvl.toFixed(0)} USDC`);
        }

        // Anfang und Ende als Median von bis zu drei Tagen: ein einzelner Ausreißer
        // entscheidet den Trend nicht.
        const edge = Math.min(3, Math.floor(samples.length / 2)) || 1;
        stats.tvlStart  = median(samples.slice(0, edge).map(s => s.tvl));
        stats.tvlEnd    = median(samples.slice(-edge).map(s => s.tvl));
        stats.tvlChange = stats.tvlEnd / stats.tvlStart - 1;
        const need = cfg.tvlTrend === 'steigend' ? TVL_TOLERANCE
            : cfg.tvlTrend === 'nicht_fallend' ? -TVL_TOLERANCE : null;
        if (need !== null && stats.tvlChange < need) {
            reasons.push(`TVL ${cfg.tvlTrend === 'steigend' ? 'nicht gestiegen' : 'gefallen'}: `
                + `${(stats.tvlChange * 100).toFixed(1)} % im Zeitraum`);
        }
    } else if (!reasons.length) {
        reasons.push('keine Messwerte');
    }

    return { recovered: reasons.length === 0, reasons, stats };
}

// ─── Auswertung: Ausfall ──────────────────────────────────────────────────────

/**
 * Fällt ein Pool im Angebot aus? Ja, wenn an JEDEM der letzten `ausfallTage` Tage vor
 * heute ein Ausstiegsgrund vorlag: TVL unter `minTvlUsd`, freie Liquidität unter
 * `minLiquiditaetUsd`, oder der Pool war den ganzen Tag nicht abfragbar. Bewertet wird
 * der Tagesmedian: ein kurzer Einbruch auf 0 (Vollauslastung für eine Stunde) ist bei
 * Lending-Pools normal und kein Ausfall.
 *
 * 🔒 "Nicht gemessen" ist kein Befund: Ein Tag ohne Messwert UND ohne aufgezeichneten
 * Abfragefehler (Bot stand, Wartung) bricht die Kette. Sonst flöge nach drei Tagen
 * Stillstand jeder Pool raus.
 *
 * @param {Array<{day: string, tvl: number|null, liquidity: number|null}>} daily   Tagesmediane
 * @param {Array<{day: string, fail: number, r429: number}>} errors               Abfragefehler je Tag
 * @param {{ausfallTage: number, minLiquiditaetUsd: number, minTvlUsd: number, messwerteAb?: string|null}} cfg
 *        `messwerteAb`: Tage davor gelten als nicht gemessen (nachweislich falsche Historie)
 * @param {string} today
 * @returns {{declined: boolean, grund: ('tvl'|'liquiditaet'|'schnittstelle'|null), reasons: string[], days: object[]}}
 */
export function evaluateDecline(daily, errors, cfg, today) {
    const byDay  = new Map(daily.map(s => [s.day, s]));
    const errDay = new Map(errors.map(e => [e.day, e]));
    const days = [];
    for (let i = cfg.ausfallTage; i >= 1; i--) {
        const day = shiftDay(today, -i);
        const valid = !cfg.messwerteAb || day >= cfg.messwerteAb;
        const s = valid ? byDay.get(day) : undefined;
        const e = valid ? errDay.get(day) : undefined;
        let kind = null;
        if (measured(s)) kind = breach(s, cfg);
        else if ((e?.fail ?? 0) > 0) kind = 'schnittstelle';
        days.push({ day, kind, tvl: s?.tvl ?? null, liquidity: s?.liquidity ?? null, fail: e?.fail ?? 0, r429: e?.r429 ?? 0 });
    }
    const declined = days.length > 0 && days.every(d => d.kind !== null);
    if (!declined) return { declined, grund: null, reasons: [], days };

    const count = kind => days.filter(d => d.kind === kind).length;
    const reasons = [];
    if (count('tvl'))         reasons.push(`TVL an ${count('tvl')} Tag(en) unter ${cfg.minTvlUsd} USDC`);
    if (count('liquiditaet')) reasons.push(`freie Liquidität an ${count('liquiditaet')} Tag(en) unter ${cfg.minLiquiditaetUsd} USDC`);
    if (count('schnittstelle')) {
        const r429 = days.reduce((n, d) => n + (d.kind === 'schnittstelle' ? d.r429 : 0), 0);
        reasons.push(`an ${count('schnittstelle')} Tag(en) nicht abfragbar, davon ${r429} Ablehnung(en) wegen zu vieler Zugriffe (429)`);
    }
    // Der schärfste Grund gewinnt, in der Reihenfolge des Auto-Exits (TVL vor Liquidität).
    const grund = count('tvl') ? 'tvl' : count('liquiditaet') ? 'liquiditaet' : 'schnittstelle';
    return { declined, grund, reasons, days };
}

// ─── Messung ausgelaufener Pools ──────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {(key: string) => (string|null)} deps.kvGet
 * @param {(key: string, value: string) => void} deps.kvSet
 * @param {() => string} deps.today                         YYYY-MM-DD in FORGE_TZ
 * @param {() => number} [deps.now]                         ms, Vorgabe Date.now
 * @param {() => Array<{id: string, pruefung: object}>} deps.probePools   ausgelaufene Pools mit Prüf-Block
 * @param {(msg: string) => void} deps.log
 */
export function createRecoveryProbe(deps) {
    const { kvGet, kvSet, today, probePools, log } = deps;
    const now = deps.now ?? Date.now;

    /**
     * Misst jeden Pool mit Prüf-Block höchstens einmal je Tag erfolgreich.
     * @param {Array<{name: string, label: string, getPoolStats?: () => Promise<{tvl: number|null, liquidity: number|null, apy?: number}>}>} protocols
     * @returns {Promise<number>} Zahl der abgesetzten Abfragen
     */
    async function run(protocols) {
        let calls = 0;
        const day = today();
        for (const pool of probePools()) {
            const proto = protocols.find(p => p.name === pool.id);
            if (!proto || typeof proto.getPoolStats !== 'function') continue;

            const key = kvKeyRecoverySeries(pool.id);
            const series = parseSeries(kvGet(key));
            const todays = series.find(s => s.day === day);
            if (todays && !todays.error) continue;                       // heute schon gemessen
            if (todays && (todays.attempts ?? 1) >= 2) continue;         // Versuche heute aufgebraucht
            if (todays && now() - (todays.ts ?? 0) < RETRY_GAP_MS) continue;

            const entry = { day, ts: now(), attempts: (todays?.attempts ?? 0) + 1 };
            calls++;
            try {
                const st = await proto.getPoolStats();
                entry.tvl = st.tvl ?? null;
                entry.liquidity = st.liquidity ?? null;
                entry.apy = st.apy ?? null;
                if (!Number.isFinite(entry.tvl) || !Number.isFinite(entry.liquidity)) {
                    entry.error = 'TVL oder Liquidität fehlt in der Antwort';
                    entry.errorKind = 'fehler';
                }
            } catch (err) {
                entry.error = String(err.message ?? err).slice(0, 200);
                entry.errorKind = is429(err) ? '429' : 'fehler';
            }
            if (entry.error) log(`${proto.label}: Erholungs-Probe gescheitert (${entry.error})`);
            else log(`${proto.label}: Erholungs-Probe TVL ${entry.tvl.toFixed(0)}, frei ${entry.liquidity.toFixed(0)} USDC`);

            const kept = series.filter(s => s.day !== day && s.day >= shiftDay(day, -KEEP_DAYS));
            kvSet(key, JSON.stringify([...kept, entry].sort((a, b) => a.day.localeCompare(b.day))));
        }
        return calls;
    }

    return { run };
}

// ─── Abfragefehler der Pools im Angebot ───────────────────────────────────────

/**
 * Zählt je Pool und Tag, wie oft die Stats-Abfrage scheiterte. Die Messwerte selbst
 * stehen in protocol_stats; dort hinterlässt ein Fehler aber nur eine Lücke, und eine
 * Lücke allein unterscheidet "Pool nicht erreichbar" nicht von "Bot stand".
 *
 * @param {object} deps
 * @param {(key: string) => (string|null)} deps.kvGet
 * @param {(key: string, value: string) => void} deps.kvSet
 * @param {() => string} deps.today
 * @param {(id: string) => boolean} deps.isWatched   Pool im Angebot mit Prüf-Block
 */
export function createErrorLog(deps) {
    const { kvGet, kvSet, today, isWatched } = deps;
    return {
        note(id, err) {
            if (!isWatched(id)) return;
            const day = today();
            const key = kvKeyQueryErrors(id);
            const list = parseSeries(kvGet(key)).filter(e => e.day >= shiftDay(day, -KEEP_DAYS));
            let entry = list.find(e => e.day === day);
            if (!entry) { entry = { day, fail: 0, r429: 0 }; list.push(entry); }
            entry.fail++;
            if (is429(err)) entry.r429++;
            kvSet(key, JSON.stringify(list));
        },
    };
}

// ─── Tickets ──────────────────────────────────────────────────────────────────

const fmtUsd = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('de-DE') : '-');
const pct = x => `${(x * 100).toFixed(1)} %`;

function criteriaLine(cfg) {
    return `Kriterien aus dem Register (\`pruefung\`): TVL mindestens ${fmtUsd(cfg.minTvlUsd)} USDC, `
        + `freie Liquidität mindestens ${fmtUsd(cfg.minLiquiditaetUsd)} USDC. `
        + `Erholung: ${cfg.zeitraumTage} Tage lang jeder Tag darüber, zusätzlich mindestens ${MIN_LIQUIDITY_SHARE * 100} % des TVL frei, `
        + `TVL-Verlauf \`${cfg.tvlTrend}\`, höchstens ${MAX_429_DAYS} Tage mit 429. `
        + `Ausfall: ${cfg.ausfallTage} Tage in Folge darunter (Tagesmedian) oder nicht abfragbar.`;
}

/** Ticket "wieder aufnehmen". Reine Funktion. */
export function draftRecoveryTicket(pool, cfg, series, evaluation, today) {
    const { stats } = evaluation;
    const rows = series
        .filter(s => s.day >= shiftDay(today, -cfg.zeitraumTage))
        .map(s => `| ${s.day} | ${s.error ? (s.errorKind === '429' ? '429' : 'Fehler') : fmtUsd(s.tvl)} | ${s.error ? '-' : fmtUsd(s.liquidity)} |`);
    return {
        kuerzel: 'LEN',
        zu: TICKET_ASSIGNEE,
        titel: `${TITLE_RECOVER}${pool.label}`,
        kurz: `${pool.label} war aus dem Angebot genommen und hat sich ${cfg.zeitraumTage} Tage lang stabil erholt `
            + `(freie Liquidität mindestens ${fmtUsd(stats.minLiquidity)} USDC, TVL ${pct(stats.tvlChange)}). `
            + 'Der Admin-Agent nimmt den Pool wieder auf; Geld wird dabei nicht bewegt. '
            + 'Du musst erst etwas tun, wenn das Ticket zur Abnahme bei dir ankommt.',
        body: [
            `Pool-ID: \`${pool.id}\``,
            `Zielzustand: \`aktiv\` (bisher \`ausgelaufen\`)`,
            '',
            criteriaLine(cfg),
            '',
            `Messwerte: Minimum freie Liquidität ${fmtUsd(stats.minLiquidity)} USDC, Minimum TVL ${fmtUsd(stats.minTvl)} USDC, `
            + `TVL von ${fmtUsd(stats.tvlStart)} auf ${fmtUsd(stats.tvlEnd)} USDC (${pct(stats.tvlChange)}), `
            + `${stats.samples} von ${stats.days} Tagen gemessen, ${stats.days429} Tag(e) mit 429.`,
            '',
            '| Tag | TVL (USDC) | frei (USDC) |',
            '|---|---|---|',
            ...rows,
        ].join('\n'),
    };
}

/** Ticket "auslaufen lassen". Reine Funktion. */
export function draftRetireTicket(pool, cfg, evaluation) {
    const rows = evaluation.days.map(d =>
        `| ${d.day} | ${fmtUsd(d.tvl)} | ${fmtUsd(d.liquidity)} | ${d.fail} (429: ${d.r429}) | ${d.kind} |`);
    return {
        kuerzel: 'LEN',
        zu: TICKET_ASSIGNEE,
        titel: `${TITLE_RETIRE}${pool.label}`,
        kurz: `${pool.label} erfüllt seit ${cfg.ausfallTage} Tagen in Folge die Bedingungen nicht mehr: ${evaluation.reasons.join('; ')}. `
            + 'Der Admin-Agent nimmt den Pool aus dem Angebot: keine Einzahlungen mehr, unsichtbar für alle ohne Guthaben. '
            + 'Wer dort Guthaben hat, bekommt täglich eine Auszahlungsempfehlung mit Grund.',
        body: [
            `Pool-ID: \`${pool.id}\``,
            `Zielzustand: \`ausgelaufen\` (bisher \`${pool.zustand}\`)`,
            `Grund: \`${evaluation.grund}\``,
            '',
            criteriaLine(cfg),
            '',
            '| Tag | TVL (USDC, Median) | frei (USDC, Median) | Abfragefehler | Befund |',
            '|---|---|---|---|---|',
            ...rows,
        ].join('\n'),
    };
}

// ─── Advisor-Lauf (CLI, täglich) ──────────────────────────────────────────────

/**
 * Wertet alle Pools mit Prüf-Block aus und legt bei Erholung bzw. Ausfall höchstens ein
 * Ticket je Pool und Richtung an.
 *
 * Wiederholungsschutz: Nach einem Ticket gibt es für denselben Pool und dieselbe Richtung
 * `intervallTage` Tage lang kein neues. Der Stand liegt in einer eigenen Datei (`state`),
 * nicht in der Bot-DB: der Bot ist der einzige Schreiber seiner DB.
 *
 * @param {object} deps
 * @param {() => Array<{id: string, label: string, pruefung: object}>} deps.probePools   ausgelaufen
 * @param {() => Array<{id: string, label: string, zustand: string, pruefung: object}>} deps.watchPools   im Angebot
 * @param {(id: string) => Array} deps.readSeries       Erholungs-Messreihe
 * @param {(id: string) => Array} deps.readDaily        Tagesmediane aus protocol_stats
 * @param {(id: string) => Array} deps.readErrors       Abfragefehler je Tag
 * @param {string} deps.today
 * @param {{get: (key: string) => ({day: string, ticket: string}|undefined), set: (key: string, v: object) => void}} deps.state
 * @param {(draft: object) => Promise<string|null>} deps.createTicket   liefert den Ticketschlüssel
 * @param {boolean} [deps.dryRun]  nur anzeigen: kein Ticket, kein Stand
 * @returns {Promise<Array<{pool: string, richtung: string, result: string, draft?: object, reasons?: string[]}>>}
 */
export async function runAdvisor(deps) {
    const { probePools, watchPools, readSeries, readDaily, readErrors, today, state, createTicket, dryRun = false } = deps;
    const out = [];

    async function handle(pool, richtung, hit, reasons, makeDraft) {
        const base = { pool: pool.id, richtung };
        const key = `${richtung}:${pool.id}`;
        const last = state.get(key);
        if (last && last.day > shiftDay(today, -pool.pruefung.intervallTage)) {
            out.push({ ...base, result: `Ticket ${last.ticket} vom ${last.day}, Wiederholungsschutz bis `
                + shiftDay(last.day, pool.pruefung.intervallTage) });
            return;
        }
        if (!hit) { out.push({ ...base, result: richtung === 'erholung' ? 'nicht erholt' : 'gesund', reasons }); return; }
        const draft = makeDraft();
        if (dryRun) { out.push({ ...base, result: 'Trockenlauf, kein Ticket', draft }); return; }
        const ticket = await createTicket(draft);
        if (!ticket) { out.push({ ...base, result: 'Ticket konnte nicht angelegt werden', draft }); return; }
        state.set(key, { day: today, ticket });
        out.push({ ...base, result: `Ticket ${ticket} angelegt`, draft });
    }

    for (const pool of probePools()) {
        const series = readSeries(pool.id);
        const ev = evaluateRecovery(series, pool.pruefung, today);
        await handle(pool, 'erholung', ev.recovered, ev.reasons,
            () => draftRecoveryTicket(pool, pool.pruefung, series, ev, today));
    }
    for (const pool of watchPools()) {
        const ev = evaluateDecline(readDaily(pool.id), readErrors(pool.id), pool.pruefung, today);
        await handle(pool, 'ausfall', ev.declined, ev.reasons,
            () => draftRetireTicket(pool, pool.pruefung, ev));
    }
    return out;
}
