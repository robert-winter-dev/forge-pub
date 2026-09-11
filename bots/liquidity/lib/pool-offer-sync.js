/**
 * FORGE public Premium – Abgleich übernommener Pools mit der laufenden Offer-Lieferung
 *
 * Beantwortet die beiden am 2026-07-29 entschiedenen Fragen aus pool-offers.md:
 *
 *   1. Der Master stuft einen übernommenen Pool zurück (oder er fehlt in der Liste)
 *      → Kapital raus, in USDC, System-Message. Diese Datei entscheidet NUR OB;
 *        das Ausführen liegt in lib/pool-retirement.js.
 *   2. Der Master ändert Felder eines bereits übernommenen Pools
 *      → automatisch übernehmen, mit System-Message (alt → neu). Angewendet wird
 *        das von bin/pool-offers-sync.js (dort mit erneuter On-Chain-Prüfung).
 *
 * Bewusst frei von DB, Dateisystem, RPC und Uhr: alles kommt als Argument herein.
 * Diese Datei trifft Kapital-Entscheidungen — sie muss vollständig und ohne
 * Infrastruktur testbar sein (siehe selfTest() am Ende, 15 Fälle).
 *
 * ─── Warum der Exit nicht einfach der Lieferung folgt ────────────────────────────
 *
 * Die Produktvorgabe ist eindeutig: zurückgestuft → Kapital raus. Die Rückstufung selbst
 * ist aber ein Urteil des Masters, das der Fork nicht nachrechnen kann (der Master
 * sieht Wochen an Vola- und Fee-Daten). „Chain ist Wahrheit" lässt sich hier also
 * nicht wie beim Ingest anwenden. Stattdessen vier Sperren, die alle greifen müssen,
 * bevor Kapital bewegt wird:
 *
 *   1. HERKUNFT — nur Pools, die nachweislich über den Offer-Pfad übernommen wurden
 *      (`premiumOffer` in der pools.json-Zeile). Ein selbst angelegter Referenzpool
 *      wird nie angefasst, auch wenn er zufällig in keinem Offer vorkommt.
 *   2. FRISCHE — die Lieferung muss aktuell sein. Läuft das Premium-Abo aus oder
 *      fällt die Zustellung aus, veraltet die Datei und es passiert GAR NICHTS.
 *      Ohne diese Sperre würde ein stiller Zustellausfall das Depot liquidieren.
 *   3. VOLLSTÄNDIGKEIT — „Pool fehlt in der Liste" zählt nur, wenn der Master die
 *      Liste als vollständig markiert hat (`meta.complete`). Ein Orca-API-Aussetzer
 *      beim Bau lässt Pools weg; das ist keine Rückstufung.
 *   4. BESTÄTIGUNG — das Signal muss über CONFIRM_MS und über mindestens zwei
 *      verschiedene Blob-Sequenzen stabil bleiben. Ein einzelner defekter oder
 *      untergeschobener Blob bewegt damit kein Kapital.
 *
 * Die Richtung hilft zusätzlich: der Exit geht ausschließlich in USDC in die eigene
 * Wallet des Nutzers (pool-retirement.js sendet bewusst NICHT an `sendTo`). Ein
 * erfolgreich untergeschobenes Retirement kostet Gebühren und Opportunität — es kann
 * aber nichts entwenden. Das ist der Grund, warum hier Verzögerung + Meldung als
 * Schutz genügen, während der Adopt-Pfad (Kapital REIN) den vollen On-Chain-Abgleich
 * verlangt.
 */

// Offers werden nur alle 6h publiziert (core/premium/publish-blob.js). 26h decken
// vier ausgefallene Läufe ab und melden einen echten Zustellausfall trotzdem, bevor
// er einen Tag alt ist.
export const MAX_OFFERS_AGE_MS = 26 * 60 * 60 * 1000;

// Wie lange eine Rückstufung stabil anliegen muss, bevor Kapital bewegt wird.
// Bei 6h Publish-Takt heißt das real: frühestens der übernächste Blob.
export const CONFIRM_MS = 6 * 60 * 60 * 1000;

// … und über wie viele verschiedene Blob-Sequenzen. Zwei genügt: ein einzelner
// manipulierter/kaputter Blob reicht dann nicht mehr aus.
export const CONFIRM_MIN_SEQUENCES = 2;

/** Kam dieser Pool über den Premium-Offer-Übernahmepfad? */
export function isAdoptedFromOffer(pool) {
    return !!pool?.premiumOffer?.offerId;
}

/**
 * Ist die Offer-Lieferung frisch und auswertbar genug, um daraus überhaupt
 * Konsequenzen zu ziehen?
 *
 * @returns {{ usable: boolean, reason: string|null, complete: boolean }}
 */
export function assessDelivery(meta, now = Date.now()) {
    if (!meta) {
        // Nacktes Array (Alt-Fork) oder nie geliefert: Alter und Vollständigkeit
        // unbekannt → nichts ableiten.
        return { usable: false, reason: 'keine Liefer-Metadaten (Alt-Format oder nie geliefert)', complete: false };
    }
    const generatedTs = Date.parse(meta.generatedAt ?? '');
    if (!Number.isFinite(generatedTs)) {
        return { usable: false, reason: 'generatedAt der Lieferung fehlt oder ist ungültig', complete: false };
    }
    const ageMs = now - generatedTs;
    if (ageMs > MAX_OFFERS_AGE_MS) {
        return {
            usable: false,
            reason: `Lieferung ist ${Math.round(ageMs / 3_600_000)}h alt (Grenze ${MAX_OFFERS_AGE_MS / 3_600_000}h)`,
            complete: false,
        };
    }
    return { usable: true, reason: null, complete: meta.complete === true };
}

/**
 * Ermittelt für jeden übernommenen Pool den aktuellen Rückstufungs-Status.
 *
 * @param {object[]} localPools   Einträge aus pools.json (mit premiumOffer-Herkunft).
 * @param {object[]} offers       Gelieferte Offers.
 * @param {object|null} meta      Liefer-Metadaten (premium-offers-store).
 * @param {number} [now]
 * @returns {{ poolId: string, kind: 'retired'|'absent', reason: string }[]}
 *   Pools, für die JETZT ein Rückstufungssignal anliegt (noch ohne Bestätigungsfenster —
 *   das prüft resolveRetirementAction()).
 */
export function detectRetirementSignals(localPools, offers, meta, now = Date.now()) {
    const delivery = assessDelivery(meta, now);
    if (!delivery.usable) return [];

    const byId = new Map(offers.map(o => [o.id, o]));
    const signals = [];

    for (const pool of localPools) {
        if (!isAdoptedFromOffer(pool)) continue;

        const offer = byId.get(pool.premiumOffer.offerId);
        if (offer) {
            if (offer.lifecycle?.status === 'retired') {
                signals.push({
                    poolId: pool.id,
                    kind: 'retired',
                    reason: offer.lifecycle.reason
                        || 'Der Master hat diesen Pool zurückgestuft (kein Grund mitgeliefert).',
                });
            }
            continue;
        }

        // Fehlt komplett — nur verwertbar, wenn die Lieferung sich selbst als
        // vollständig ausweist (sonst: Aussetzer beim Bau, keine Rückstufung).
        if (delivery.complete) {
            signals.push({
                poolId: pool.id,
                kind: 'absent',
                reason: 'Der Pool taucht in der vollständigen Angebotsliste des Masters nicht mehr auf.',
            });
        }
    }
    return signals;
}

/**
 * Entscheidet anhand des gemerkten Verlaufs, was mit einem Signal zu tun ist.
 *
 * @param {object|null} state   Zeile aus pool_offer_state (oder null beim ersten Mal).
 * @param {object} signal       Eintrag aus detectRetirementSignals().
 * @param {number} sequence     Sequenznummer der aktuellen Lieferung.
 * @param {number} [now]
 * @returns {{ action: 'notify'|'wait'|'exit', firstSeenAt: number, sequences: number, waitedMs: number }}
 *   notify = erstes Auftreten, nur melden. wait = Bestätigungsfenster läuft noch.
 *   exit   = alle Sperren offen, Kapital darf raus.
 */
export function resolveRetirementAction(state, signal, sequence, now = Date.now()) {
    const firstSeenAt = state?.retired_first_seen_at ?? now;
    const knownSeqs = new Set((state?.retired_sequences ?? '').split(',').filter(Boolean).map(Number));
    if (Number.isFinite(sequence)) knownSeqs.add(sequence);
    const sequences = knownSeqs.size;
    const waitedMs = now - firstSeenAt;

    if (!state?.retired_first_seen_at) {
        return { action: 'notify', firstSeenAt, sequences, waitedMs };
    }
    if (waitedMs < CONFIRM_MS || sequences < CONFIRM_MIN_SEQUENCES) {
        return { action: 'wait', firstSeenAt, sequences, waitedMs };
    }
    return { action: 'exit', firstSeenAt, sequences, waitedMs };
}

// ─── Offer-Updates für bereits übernommene Pools ─────────────────────────────

/**
 * Felder, die eine Aktualisierung anfassen darf — allesamt die VORSCHLAGS-Ebene in
 * pools.json. Die nutzer-autoritative Ebene (settings.db `pool_settings`, die
 * DB-Spalten aus v0.4.85) bleibt unberührt: „Die TVL-Schwelle wird vom Benutzer
 * konfiguriert, da haben wir keinen Einfluss darauf" (Produktentscheidung 2026-07-29). Hat der
 * Nutzer eine eigene Schwelle gesetzt, ändert ein Offer-Update effektiv nichts —
 * es zieht nur den Default nach, der greift solange er nichts eigenes gesetzt hat.
 *
 * Bewusst NICHT dabei:
 *   • rangeOverride.fixedPct — seit v0.4.85 DB-autoritativ und über `locked`
 *     nutzergepinnt; ein pools.json-Schreibvorgang wäre folgenlos und damit eine
 *     Meldung, die etwas verspricht, das nicht passiert.
 *   • enabled / active / capitalUSDC — Betriebszustand, nie aus Lieferdaten.
 *   • address / tokenA / tokenB / decimals* / feeTier / tickSpacing — Identität.
 *     Ändert sich davon etwas, ist es NICHT derselbe Pool (siehe checkIdentity()).
 */
const SOFT_FIELDS = [
    { path: 'poolType',          from: o => o.poolType,                   label: 'Pool-Typ (Scoring)' },
    { path: 'displayPair',       from: o => o.displayPair ?? o.pair,       label: 'Anzeigename' },
    { path: 'aprAlertEnabled',   from: o => o.poolShape?.aprAlertEnabled,  label: 'APR-Alarm aktiviert' },
    // `suggested.*` wird vom Master als null geliefert, wenn er zu diesem Feld gar
    // keinen Vorschlag hat (core/premium/pool-offers.js: `pool.x ?? null`). „Kein
    // Vorschlag" darf den lokalen Wert nicht auf null ziehen — sonst meldet der Sync
    // bei jedem Lauf aufs Neue eine Änderung, die der Adopt-Pfad (der Defaults setzt)
    // sofort wieder herstellt. Deshalb nullMeansAbsent.
    { path: 'proactiveTrigger',  from: o => o.suggested?.proactiveTrigger, label: 'Proaktiver Rebalance-Trigger', nullMeansAbsent: true },
    { path: 'stopLossPctOpen',   from: o => o.suggested?.stopLossPctOpen,  label: 'Stop-Loss-Vorschlag',          nullMeansAbsent: true },
    { path: 'tvlWarnThreshold',  from: o => o.suggested?.tvlWarnThreshold, label: 'TVL-Warnschwelle (Default)',   nullMeansAbsent: true },
    { path: 'tvlExitThreshold',  from: o => o.suggested?.tvlExitThreshold, label: 'TVL-Exit-Schwelle (Default)',  nullMeansAbsent: true },
];

/**
 * Strukturfelder verändern, WIE der Bot rechnet (IL-Prüfung, USD-Preisermittlung).
 * Eine Korrektur daran an einer Position mit Kapital drin wäre ein Eingriff in eine
 * laufende Investition — deshalb nur bei kapitalfreiem Pool automatisch, sonst
 * gemeldet und aufgeschoben.
 */
const STRUCTURAL_FIELDS = [
    { path: 'usdcIsTokenA',     from: o => o.poolShape?.usdcIsTokenA,     label: 'USDC-Seite des Pools' },
    { path: 'volatilePair',     from: o => o.poolShape?.volatilePair,     label: 'Volatiles Paar (IL-Behandlung)' },
    { path: 'quotePricePoolId', from: o => o.poolShape?.quotePricePoolId, label: 'Referenzpool für die USD-Bewertung' },
    { path: 'quoteTokenMint',   from: o => o.poolShape?.quoteTokenMint,   label: 'Quote-Token-Mint für die USD-Bewertung' },
];

const IDENTITY_FIELDS = ['address', 'tokenA', 'tokenB', 'decimalsA', 'decimalsB', 'feeTier', 'tickSpacing'];

/**
 * Weicht ein Identitätsfeld ab, ist das kein Update, sondern ein anderer Pool unter
 * derselben ID — Alarm, nie stille Übernahme.
 * @returns {{field:string, local:*, offered:*}[]}
 */
export function checkIdentity(localPool, offer) {
    return IDENTITY_FIELDS
        .filter(f => offer[f] !== undefined && localPool[f] !== offer[f])
        .map(f => ({ field: f, local: localPool[f], offered: offer[f] }));
}

/**
 * Ermittelt die anzuwendenden Feldänderungen.
 *
 * @param {object} localPool
 * @param {object} offer
 * @param {boolean} hasOpenPosition   Liegt aktuell Kapital in diesem Pool?
 * @returns {{ applicable: object[], deferred: object[] }}
 */
export function diffOfferUpdates(localPool, offer, hasOpenPosition) {
    const applicable = [];
    const deferred = [];

    const collect = (defs, target) => {
        for (const def of defs) {
            const offered = def.from(offer);
            if (offered === undefined) continue;                          // Feld gar nicht geliefert
            if (offered === null && def.nullMeansAbsent) continue;        // geliefert, aber „kein Vorschlag"
            const current = localPool[def.path] ?? null;
            const next = offered ?? null;
            if (current === next) continue;
            target.push({ field: def.path, label: def.label, from: current, to: next });
        }
    };

    collect(SOFT_FIELDS, applicable);
    collect(STRUCTURAL_FIELDS, hasOpenPosition ? deferred : applicable);

    return { applicable, deferred };
}

// ─── Selbsttest ──────────────────────────────────────────────────────────────

export function selfTest() {
    const failures = [];
    const now = Date.parse('2026-07-29T12:00:00Z');
    const fresh = ts => new Date(ts ?? now - 60_000).toISOString();

    const adopted = { id: 'liq-x-usdc', premiumOffer: { offerId: 'liq-x-usdc', adoptedAt: 1 } };
    const ownPool = { id: 'liq-eigener-ref' }; // ohne Herkunft — nie anfassen
    const meta = { generatedAt: fresh(), sequence: 10, complete: true, count: 1 };
    const activeOffer = { id: 'liq-x-usdc', lifecycle: { status: 'active', reason: null } };
    const retiredOffer = { id: 'liq-x-usdc', lifecycle: { status: 'retired', reason: 'Master gesperrt' } };

    // 1: normal geliefert → kein Signal.
    if (detectRetirementSignals([adopted], [activeOffer], meta, now).length !== 0) {
        failures.push('Fall 1: aktives Offer erzeugte fälschlich ein Rückstufungssignal');
    }

    // 2: als retired geliefert → Signal.
    const s2 = detectRetirementSignals([adopted], [retiredOffer], meta, now);
    if (s2.length !== 1 || s2[0].kind !== 'retired') failures.push('Fall 2: retired-Offer wurde nicht erkannt');

    // 3: fehlt, Liste vollständig → Signal 'absent'.
    const s3 = detectRetirementSignals([adopted], [], meta, now);
    if (s3.length !== 1 || s3[0].kind !== 'absent') failures.push('Fall 3: fehlendes Offer bei vollständiger Liste nicht erkannt');

    // 4: fehlt, Liste UNvollständig → kein Signal (Orca-Aussetzer, keine Rückstufung).
    if (detectRetirementSignals([adopted], [], { ...meta, complete: false }, now).length !== 0) {
        failures.push('Fall 4: unvollständige Liste hätte kein Signal erzeugen dürfen');
    }

    // 5: Lieferung zu alt → gar nichts (Abo-Ausfall darf nicht liquidieren).
    const stale = { ...meta, generatedAt: fresh(now - MAX_OFFERS_AGE_MS - 60_000) };
    if (detectRetirementSignals([adopted], [], stale, now).length !== 0) {
        failures.push('Fall 5: veraltete Lieferung hätte kein Signal erzeugen dürfen');
    }

    // 6: gar keine Metadaten (Alt-Format) → gar nichts.
    if (detectRetirementSignals([adopted], [], null, now).length !== 0) {
        failures.push('Fall 6: fehlende Metadaten hätten kein Signal erzeugen dürfen');
    }

    // 7: selbst angelegter Pool ohne Herkunft → NIE anfassen, auch wenn er fehlt.
    if (detectRetirementSignals([ownPool], [], meta, now).length !== 0) {
        failures.push('Fall 7: Pool ohne premiumOffer-Herkunft wurde fälschlich erfasst');
    }

    // 8: erstes Auftreten → nur melden, kein Exit.
    const a8 = resolveRetirementAction(null, s2[0], 10, now);
    if (a8.action !== 'notify') failures.push(`Fall 8: erwartete 'notify', bekam '${a8.action}'`);

    // 9: Fenster läuft noch → warten.
    const state9 = { retired_first_seen_at: now - 60_000, retired_sequences: '10' };
    const a9 = resolveRetirementAction(state9, s2[0], 11, now);
    if (a9.action !== 'wait') failures.push(`Fall 9: erwartete 'wait', bekam '${a9.action}'`);

    // 10: Zeit reicht, aber nur EINE Sequenz gesehen → weiter warten.
    const state10 = { retired_first_seen_at: now - CONFIRM_MS - 1, retired_sequences: '10' };
    const a10 = resolveRetirementAction(state10, s2[0], 10, now);
    if (a10.action !== 'wait') failures.push(`Fall 10: eine einzelne Sequenz hätte nicht zum Exit führen dürfen`);

    // 11: Zeit UND zwei Sequenzen → Exit.
    const a11 = resolveRetirementAction(state10, s2[0], 11, now);
    if (a11.action !== 'exit') failures.push(`Fall 11: erwartete 'exit', bekam '${a11.action}'`);

    // 12: Soft-Update wird angewendet, auch mit offener Position.
    const local = {
        id: 'liq-x-usdc', poolType: 'volatil_2', tvlExitThreshold: 200000,
        volatilePair: false, address: 'Addr1', tokenA: 'A', tokenB: 'B',
    };
    const upd = {
        id: 'liq-x-usdc', address: 'Addr1', tokenA: 'A', tokenB: 'B',
        poolType: 'volatil_3', suggested: { tvlExitThreshold: 150000 },
        poolShape: { volatilePair: true },
    };
    const d12 = diffOfferUpdates(local, upd, true);
    if (!d12.applicable.some(c => c.field === 'poolType' && c.to === 'volatil_3')) {
        failures.push('Fall 12: poolType-Änderung fehlt in applicable');
    }
    if (!d12.applicable.some(c => c.field === 'tvlExitThreshold' && c.to === 150000)) {
        failures.push('Fall 12: tvlExitThreshold-Änderung fehlt in applicable');
    }

    // 13: Strukturfeld bei offener Position → aufgeschoben, nicht angewendet.
    if (!d12.deferred.some(c => c.field === 'volatilePair')) {
        failures.push('Fall 13: volatilePair hätte bei offener Position aufgeschoben werden müssen');
    }
    if (d12.applicable.some(c => c.field === 'volatilePair')) {
        failures.push('Fall 13: volatilePair wurde trotz offener Position angewendet');
    }
    // … ohne Position dagegen anwendbar.
    if (!diffOfferUpdates(local, upd, false).applicable.some(c => c.field === 'volatilePair')) {
        failures.push('Fall 13b: volatilePair hätte ohne offene Position angewendet werden müssen');
    }

    // 14: „kein Vorschlag" (null) zieht den lokalen Default NICHT auf null.
    // Regression: der Master liefert suggested.* als null, wenn er dazu nichts hat —
    // ohne diese Regel meldete der Sync stündlich dieselbe Scheinänderung.
    const withDefaults = { id: 'liq-x-usdc', address: 'Addr1', proactiveTrigger: 0.75, tvlExitThreshold: 200000 };
    const noSuggestions = {
        id: 'liq-x-usdc', address: 'Addr1',
        suggested: { proactiveTrigger: null, stopLossPctOpen: null, tvlWarnThreshold: null, tvlExitThreshold: null },
    };
    const d14 = diffOfferUpdates(withDefaults, noSuggestions, false);
    if (d14.applicable.length !== 0 || d14.deferred.length !== 0) {
        failures.push(`Fall 14: null-Vorschläge erzeugten Änderungen: ${JSON.stringify(d14.applicable)}`);
    }
    // … ein echter Wert dagegen greift weiterhin.
    const d14b = diffOfferUpdates(withDefaults, { ...noSuggestions, suggested: { proactiveTrigger: 0.9 } }, false);
    if (!d14b.applicable.some(c => c.field === 'proactiveTrigger' && c.to === 0.9)) {
        failures.push('Fall 14b: echter proactiveTrigger-Vorschlag wurde nicht übernommen');
    }

    // 15: Identitätsänderung ist kein Update, sondern ein anderer Pool.
    const idChanges = checkIdentity(local, { ...upd, address: 'GanzAndereAdresse' });
    if (!idChanges.some(c => c.field === 'address')) {
        failures.push('Fall 15: geänderte Pool-Adresse wurde nicht als Identitätsbruch erkannt');
    }
    if (checkIdentity(local, upd).length !== 0) {
        failures.push('Fall 15b: unveränderte Identität wurde fälschlich als Bruch gemeldet');
    }

    return { ok: failures.length === 0, failures };
}
