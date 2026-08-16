/**
 * FORGE public Premium – Pool-Offer-Validator (Klasse C, Schritt 4 von 6, siehe
 * pool-offers.md)
 *
 * Läuft NUR im FORGE-public-Fork (bzw. hier zu Testzwecken auch auf dem Master gegen
 * dessen eigene Pools — der Master hat dieselben On-Chain-Daten). Prüft jedes vom
 * Master gelieferte Pool-Offer gegen die Chain, BEVOR es einem Nutzer zur Übernahme
 * angeboten wird: „Die Lieferung ist eine Behauptung, die Chain ist die Wahrheit."
 *
 * Bewusst kein Vertrauen in `compat`/`poolShape` aus dem Offer selbst — jedes on-chain
 * prüfbare Feld wird unabhängig neu ermittelt (Orca-Adapter-Infrastruktur, dieselbe wie
 * für den echten Bot-Betrieb) und verglichen. Eine Abweichung führt zur Ablehnung, nie
 * zu einer stillen Korrektur (siehe pool-offers.md „Sicherheitsmodell").
 *
 * `poolType`/`suggested`/`rationale` sind laut Design NICHT prüfbar — sie werden als
 * `unprovable` durchgereicht, nie automatisch übernommen (reine Anzeige/Vorschlag).
 *
 * Dieses Modul schreibt NICHTS (keine DB, keine pools.json) — reine Prüf-Funktion.
 * Übernahme-UI (Schritt 5) und Dry-Run-Gate (Schritt 6) sind eigene, spätere Bausteine.
 */

import { WhirlpoolContext, IGNORE_CACHE } from '@orca-so/whirlpools-sdk';
import { Wallet } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { getConnection, getKeypair } from './wallet.js';
import { settle } from './settle-promise.js';

const ORCA_V2 = 'http://127.0.0.1:3100/orcav2';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

let _ctx = null;
function getCtx() {
    // Lazy + gecacht: WhirlpoolContext.from() braucht Connection+Keypair, die erst zur
    // Laufzeit (nach .env-Load) verfügbar sind — analog pool-adapter/orca.js buildContext().
    if (!_ctx) {
        _ctx = WhirlpoolContext.from(getConnection(), new Wallet(getKeypair()), undefined);
    }
    return _ctx;
}

/**
 * Liest den echten Whirlpool-Account + beide Mint-Accounts direkt von der Chain.
 * Exportiert, weil auch lib/pool-retirement.js vor dem Kapital-Exit dieselbe
 * unabhängige Chain-Lesung braucht (nie blind auf gelieferte Daten hin handeln).
 */
export async function fetchOnChainPool(address) {
    const ctx = getCtx();
    const pubkey = new PublicKey(address);
    const pool = await ctx.fetcher.getPool(pubkey, IGNORE_CACHE);
    if (!pool) throw new Error(`Whirlpool-Account nicht gefunden: ${address}`);
    const [mintA, mintB] = await Promise.all([
        settle(ctx.fetcher.getMintInfo(pool.tokenMintA, IGNORE_CACHE)),
        settle(ctx.fetcher.getMintInfo(pool.tokenMintB, IGNORE_CACHE)),
    ]);
    if (!mintA || !mintB) throw new Error(`Mint-Account nicht gefunden für ${address}`);
    return {
        tokenMintA: pool.tokenMintA.toBase58(),
        tokenMintB: pool.tokenMintB.toBase58(),
        tickSpacing: pool.tickSpacing,
        feeTier: pool.feeRate / 10_000,
        decimalsA: mintA.decimals,
        decimalsB: mintB.decimals,
        token2022A: mintA.tokenProgram.toBase58() === TOKEN_2022_PROGRAM_ID,
        token2022B: mintB.tokenProgram.toBase58() === TOKEN_2022_PROGRAM_ID,
    };
}

/**
 * adaptiveFeeEnabled steht nicht im geparsten Whirlpool-Account (SDK-Version ohne
 * Adaptive-Fee-Unterstützung, verifiziert 2026-07-28) — kommt stattdessen aus derselben
 * Orca-v2-API, die auch der Master zur Ermittlung nutzt (core/premium/pool-offers.js).
 */
async function fetchAdaptiveFeeEnabled(address) {
    const res = await fetch(`${ORCA_V2}/solana/pools/${address}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Orca-API HTTP ${res.status} für ${address}`);
    const json = await res.json();
    return (json.data ?? json).adaptiveFeeEnabled ?? null;
}

function pushCheck(checks, field, expected, actual) {
    checks.push({ field, expected, actual, match: expected === actual });
}

/**
 * Prüft ein einzelnes Pool-Offer gegen die Chain.
 *
 * @param {object} offer - ein Eintrag aus data/premium/pool-offers.json.
 * @param {object} [opts]
 * @param {string[]} [opts.localPoolIds] - IDs der lokal bekannten Pools (für den
 *   quotePricePoolId-Referenz-Check).
 * @param {(address: string) => Promise<object>} [opts.fetchChain] - überschreibbar für Tests.
 * @param {(address: string) => Promise<boolean|null>} [opts.fetchAdaptiveFee] - überschreibbar für Tests.
 * @returns {Promise<{id:string, status:'verified'|'unsupported'|'rejected', acceptedException:boolean, checks:object[], mismatches:object[], unprovable:object}>}
 */
export async function validatePoolOffer(offer, {
    localPoolIds = [],
    fetchChain = fetchOnChainPool,
    fetchAdaptiveFee = fetchAdaptiveFeeEnabled,
} = {}) {
    const checks = [];
    const onChain = await fetchChain(offer.address);

    pushCheck(checks, 'tokenA', offer.tokenA, onChain.tokenMintA);
    pushCheck(checks, 'tokenB', offer.tokenB, onChain.tokenMintB);
    pushCheck(checks, 'tickSpacing', offer.tickSpacing, onChain.tickSpacing);
    pushCheck(checks, 'feeTier', offer.feeTier, onChain.feeTier);
    pushCheck(checks, 'decimalsA', offer.decimalsA, onChain.decimalsA);
    pushCheck(checks, 'decimalsB', offer.decimalsB, onChain.decimalsB);
    pushCheck(checks, 'compat.token2022.a', offer.compat?.token2022?.a ?? false, onChain.token2022A);
    pushCheck(checks, 'compat.token2022.b', offer.compat?.token2022?.b ?? false, onChain.token2022B);

    let actualAdaptiveFee = null;
    try {
        actualAdaptiveFee = await fetchAdaptiveFee(offer.address);
        pushCheck(checks, 'compat.adaptiveFeeEnabled', offer.compat?.adaptiveFeeEnabled ?? null, actualAdaptiveFee);
    } catch (err) {
        checks.push({
            field: 'compat.adaptiveFeeEnabled',
            expected: offer.compat?.adaptiveFeeEnabled ?? null, actual: null, match: false,
            error: `Orca-API nicht erreichbar: ${err.message}`,
        });
    }

    if (offer.poolShape?.quotePricePoolId) {
        const exists = localPoolIds.includes(offer.poolShape.quotePricePoolId);
        checks.push({
            field: 'poolShape.quotePricePoolId', expected: offer.poolShape.quotePricePoolId,
            actual: exists ? 'lokal vorhanden' : 'lokal NICHT vorhanden', match: exists,
        });
    }

    const mismatches = checks.filter(c => !c.match);
    const blockerTriggered = onChain.token2022A || onChain.token2022B || actualAdaptiveFee === true;
    const acceptedException = blockerTriggered && offer.compat?.accepted != null;

    let status;
    if (mismatches.length > 0) status = 'rejected';
    else if (blockerTriggered && !acceptedException) status = 'unsupported';
    else status = 'verified';

    return {
        id: offer.id,
        status,
        acceptedException,
        acceptedReason: acceptedException ? offer.compat?.acceptedReason ?? null : null,
        checks,
        mismatches,
        unprovable: {
            poolType: offer.poolType ?? null,
            suggested: offer.suggested ?? null,
            rationale: offer.rationale ?? null,
        },
    };
}

/**
 * Validiert eine ganze Liste von Offers (z.B. den Inhalt von pool-offers.json).
 * Läuft die Offers nacheinander durch (nicht parallel) — schont RPC/API-Rate-Limits,
 * Menge ist klein (aktuell max. ~30 Offers, kein Zeitdruck).
 */
export async function validatePoolOffers(offers, opts = {}) {
    const results = [];
    for (const offer of offers) {
        try {
            results.push(await validatePoolOffer(offer, opts));
        } catch (err) {
            results.push({
                id: offer.id, status: 'rejected', acceptedException: false, acceptedReason: null,
                checks: [], mismatches: [{ field: 'fetchChain', expected: null, actual: null, match: false, error: err.message }],
                unprovable: { poolType: offer.poolType ?? null, suggested: offer.suggested ?? null, rationale: offer.rationale ?? null },
            });
        }
    }
    return results;
}

/** Selbsttest mit injizierten Fake-Chain-Antworten (kein echtes Netzwerk/RPC). */
export async function selfTest() {
    const failures = [];

    const baseOffer = {
        id: 'liq-test-usdc', address: 'FakeAddr111',
        tokenA: 'MintA111', tokenB: 'MintB222', decimalsA: 9, decimalsB: 6,
        feeTier: 0.16, tickSpacing: 64,
        poolShape: { quotePricePoolId: null },
        compat: { token2022: { a: false, b: false }, adaptiveFeeEnabled: false, accepted: null, acceptedReason: null },
    };
    const matchingChain = {
        tokenMintA: 'MintA111', tokenMintB: 'MintB222', tickSpacing: 64, feeTier: 0.16,
        decimalsA: 9, decimalsB: 6, token2022A: false, token2022B: false,
    };

    // Fall 1: alles stimmt überein → verified, kein acceptedException.
    const r1 = await validatePoolOffer(baseOffer, {
        fetchChain: async () => matchingChain,
        fetchAdaptiveFee: async () => false,
    });
    if (r1.status !== 'verified') failures.push(`Fall 1 (alles stimmt): erwartete 'verified', bekam '${r1.status}'`);
    if (r1.acceptedException) failures.push('Fall 1: acceptedException sollte false sein');

    // Fall 2: Mismatch bei tokenA → rejected, unabhängig von allem anderen.
    const r2 = await validatePoolOffer(baseOffer, {
        fetchChain: async () => ({ ...matchingChain, tokenMintA: 'EinAndererMint' }),
        fetchAdaptiveFee: async () => false,
    });
    if (r2.status !== 'rejected') failures.push(`Fall 2 (Mint-Mismatch): erwartete 'rejected', bekam '${r2.status}'`);
    if (!r2.mismatches.some(m => m.field === 'tokenA')) failures.push('Fall 2: tokenA-Mismatch nicht in mismatches gefunden');

    // Fall 3: Blocker triggert (adaptiveFee=true, vom Offer korrekt so gemeldet), aber KEIN
    // accepted → unsupported. adaptiveFeeEnabled im Offer muss mit der Chain übereinstimmen,
    // sonst wäre es ein Mismatch (siehe Fall 5) statt eines reinen Blocker-Falls.
    const blockedOffer = { ...baseOffer, compat: { ...baseOffer.compat, adaptiveFeeEnabled: true } };
    const r3 = await validatePoolOffer(blockedOffer, {
        fetchChain: async () => matchingChain,
        fetchAdaptiveFee: async () => true,
    });
    if (r3.status !== 'unsupported') failures.push(`Fall 3 (Blocker ohne accepted): erwartete 'unsupported', bekam '${r3.status}'`);

    // Fall 4: Blocker triggert, Offer HAT accepted, alle Felder stimmen → verified + acceptedException.
    const acceptedOffer = { ...blockedOffer, compat: { ...blockedOffer.compat, accepted: 'master-operates-pool', acceptedReason: 'Test' } };
    const r4 = await validatePoolOffer(acceptedOffer, {
        fetchChain: async () => matchingChain,
        fetchAdaptiveFee: async () => true,
    });
    if (r4.status !== 'verified') failures.push(`Fall 4 (Blocker mit accepted): erwartete 'verified', bekam '${r4.status}'`);
    if (!r4.acceptedException) failures.push('Fall 4: acceptedException sollte true sein');

    // Fall 5: Blocker triggert UND ein Mismatch → rejected gewinnt über accepted (Sicherheit vor Bequemlichkeit).
    const r5 = await validatePoolOffer(acceptedOffer, {
        fetchChain: async () => ({ ...matchingChain, decimalsA: 3 }),
        fetchAdaptiveFee: async () => true,
    });
    if (r5.status !== 'rejected') failures.push(`Fall 5 (Blocker+Mismatch): erwartete 'rejected' (Mismatch hat Vorrang), bekam '${r5.status}'`);

    // Fall 6: quotePricePoolId referenziert einen lokal unbekannten Pool → Mismatch.
    const refOffer = { ...baseOffer, poolShape: { quotePricePoolId: 'liq-nicht-vorhanden' } };
    const r6 = await validatePoolOffer(refOffer, {
        fetchChain: async () => matchingChain,
        fetchAdaptiveFee: async () => false,
        localPoolIds: ['liq-sol-usdc'],
    });
    if (r6.status !== 'rejected') failures.push(`Fall 6 (fehlender Referenz-Pool): erwartete 'rejected', bekam '${r6.status}'`);

    // Fall 7: validatePoolOffers() fängt einen werfenden fetchChain pro Offer ab (kein Abbruch der ganzen Liste).
    const r7 = await validatePoolOffers([baseOffer, { ...baseOffer, id: 'liq-broken', address: 'FakeAddrBroken' }], {
        fetchChain: async (addr) => { if (addr === 'FakeAddr111') return matchingChain; throw new Error('RPC down'); },
        fetchAdaptiveFee: async () => false,
    });
    if (r7.length !== 2) failures.push('Fall 7: erwartete 2 Ergebnisse');
    if (r7[0].status !== 'verified') failures.push('Fall 7: erstes Offer sollte verified sein');
    if (r7[1].status !== 'rejected') failures.push('Fall 7: zweites (RPC-Fehler) Offer sollte rejected sein');

    return { ok: failures.length === 0, failures };
}
