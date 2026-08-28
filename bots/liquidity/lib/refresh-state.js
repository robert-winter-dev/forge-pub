/**
 * FORGE Liquidity – Zentrales State-Refresh nach Bot-Aktionen.
 *
 * Eine Bot-Aktion (Claim+Reinvest, Deposit, Withdraw, Cleanup) ändert den On-Chain-State.
 * Damit das Dashboard konsistent ist, müssen danach drei Snapshots geschrieben werden:
 *
 *   1. `position_snapshots`   – pro Pool: lp_value_usd, Fees, IL, Token-Mengen
 *                                ("Mein Anteil" je Pool, APR-Berechnung)
 *   2. `portfolio_history`    – Aggregat über alle offenen Pools + Wallet
 *                                ("Guthaben", Charts, Performance)
 *   3. Wallet-Monitor-Snapshot – SOL/USDC + Whitelist-Tokens
 *                                (Wallet-Spalte im Dashboard)
 *
 * Danach: `syncDashboard()` (export.js → data.json → rsync zum Webserver).
 *
 * Wird die Sequenz NICHT vollständig durchgeführt, zeigt das Dashboard inkonsistente
 * Werte bis zum nächsten regulären Bot-Tick (bis zu 30 s). Genau das war historisch
 * der Grund warum "Mein Anteil" nach Reinvest verzögert aktualisierte.
 *
 * API:
 *   - `writePositionSnapshotFromState(...)` – State-basierter Pos-Snapshot (Bot-Pfad)
 *   - `writePositionSnapshotFromDelta(...)`  – Delta-basierter Pos-Snapshot (Deposit/Withdraw)
 *   - `writePortfolioSnapshot(db)`           – Aggregat-Snapshot
 *   - `writeFreshWalletSnapshot()`           – Wallet-Monitor-Snapshot
 *   - `refreshAfterAction(db, opts)`         – Orchestrator: Portfolio + Wallet + Sync
 */

import { spawn }             from 'child_process';
import { resolve, dirname }  from 'path';
import { fileURLToPath }     from 'url';

import BN      from 'bn.js';
import Decimal from 'decimal.js';
import { PriceMath, PoolUtil } from '@orca-so/whirlpools-sdk';

import { PublicKey } from '@solana/web3.js';

import {
    insertPositionSnapshot, insertPortfolioSnapshot, updatePositionLiquidity,
    getOpenPosition, scaleReferencesForLiquidityChange, rebaseHwmForCapitalFlow,
    scaleReferencesForQuotePriceChange, kvGet, kvSet,
} from './db.js';
import { updateHwm } from './trailing-stop.js';
import {
    getKeypair, getConnectionFresh,
    USDC_MINT,
} from './wallet.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
import { writeWalletSnapshot, getLatestWalletBalance } from './wallet-monitor-client.js';
import { getTokenUsdPrice } from './deposit-lib.js';
import { config } from './config.js';
import { syncDashboard } from './sync.js';
import { settle } from './settle-promise.js';
import { checkFeeJump } from '../../../lib/fee-plausibility.js';
import { trackQuotePriceSanity } from './price-sanity.js';
import * as notify from './notify.js';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const __dirname          = dirname(fileURLToPath(import.meta.url));
const WALLET_MONITOR_JS  = resolve(__dirname, '../../../core/wallet-monitor/monitor.js');

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Liest den USD-Preis des Quote-Tokens.
 * Quelle 1: oracle_prices (Pyth, max. 5 Min alt) — unabhängig von Pool-Liquidität.
 * Quelle 2: pool_stats des Referenz-Pools (Fallback).
 */
/**
 * Wie alt der Pool-Preis höchstens sein darf, um als Primärquelle zu gelten.
 *
 * `pool_stats` wird pro Bot-Zyklus fortgeschrieben (alle paar Minuten). 30 Minuten lassen
 * einzelne ausgefallene Zyklen durchgehen, schlagen aber an, wenn der Bot längere Zeit stand —
 * dann ist der Oracle-Wert die bessere Wahl. Bewusst großzügiger als die 5 Minuten beim
 * Oracle: Ein Pool-Preis altert langsamer aus der Relevanz, weil er aus demselben Markt
 * stammt, an dem gehandelt wird.
 */
const POOL_PRICE_MAX_AGE_MS = 30 * 60 * 1000;
const ORACLE_MAX_AGE_MS     =  5 * 60 * 1000;

/**
 * USD-Preis des Quote-Tokens.
 *
 * 🔒 **Reihenfolge seit 2026-08-27 (CORE#0334): Pool-Preis zuerst, Oracle als Fallback.**
 * Bis dahin war es umgekehrt, begründet am 2026-05-29 (LMB#0143) mit „`sol-usdc` hat geringe
 * Liquidität, der Pool-Preis kann vom echten Marktpreis abweichen". Beide Hälften dieser
 * Annahme haben der Messung nicht standgehalten:
 *
 *  - Der Referenzpool führt 25,4 Mio USD TVL (am Tag jener Entscheidung bereits 28,2 Mio) —
 *    er ist keiner der dünnen Pools, für die das Argument gedacht war.
 *  - Über 6.237 Vergleichspaare aus dem Zeitraum mit funktionierendem Oracle (22.–26.08.)
 *    liegt die Abweichung im Median bei −0,003 %, zu 97,7 % innerhalb ±0,5 %, im Maximum
 *    bei 1,79 %. Der Pool-Preis war also nie die unzuverlässigere Quelle.
 *
 * Entscheidend ist der Unterschied im Fehlerverhalten, nicht in der Genauigkeit: Der
 * Pool-Preis entsteht aus real ausgeführten Swaps auf der Kette und kann nicht „einfrieren" —
 * fehlt er, ist er sichtbar abwesend. Ein Oracle hinter einem HTTP-Proxy kann dagegen einen
 * plausiblen, aber acht Stunden alten Wert liefern, ohne dass es jemand bemerkt. Genau das
 * ist am 26./27.08. passiert (Hermes HTTP 401, stale Cache mit frischem Zeitstempel).
 *
 * Der Oracle-Wert bleibt als Fallback, wenn der Pool-Preis fehlt oder veraltet ist — etwa
 * nachdem der Bot längere Zeit stand.
 */
export function getQuotePriceUsd(db, pool) {
    if (!pool.quoteTokenMint) return 0;
    if (pool.quotePricePoolId) {
        const now = Date.now();
        const poolRow = db.prepare(
            `SELECT price, recorded_at FROM pool_stats WHERE pool_id = ?
             ORDER BY recorded_at DESC LIMIT 1`
        ).get(pool.quotePricePoolId);
        const oracle = db.prepare(
            `SELECT price FROM oracle_prices WHERE quote_pool_id = ? AND updated_at > ?`
        ).get(pool.quotePricePoolId, now - ORACLE_MAX_AGE_MS);

        if (poolRow?.price > 0 && (now - poolRow.recorded_at) <= POOL_PRICE_MAX_AGE_MS) {
            reconcileQuotePriceSource(db, pool.quotePricePoolId, 'pool', poolRow.price, oracle?.price);
            // Die Prüfung läuft weiter, nur ist die Rollenverteilung jetzt umgekehrt: Sie
            // meldet einen abweichenden Oracle-Wert, statt vor der Quelle zu warnen, der
            // gefolgt wird. Nützlich bleibt sie — eine wachsende Divergenz zeigt an, dass
            // eine der beiden Quellen abdriftet, egal welche gerade führt.
            if (oracle) checkQuotePriceSanity(db, pool.quotePricePoolId, oracle.price, poolRow);
            return poolRow.price;
        }
        if (oracle) {
            reconcileQuotePriceSource(db, pool.quotePricePoolId, 'oracle', poolRow?.price, oracle.price);
            console.warn(`[quote-price:${pool.quotePricePoolId}] Pool-Preis fehlt oder ist älter `
                + `als ${POOL_PRICE_MAX_AGE_MS / 60000} Min — weiche auf den Oracle-Wert aus `
                + `(${oracle.price.toFixed(4)} USD).`);
            return oracle.price;
        }
    }
    return getTokenUsdPrice(pool.quoteTokenMint, db);
}

/**
 * Erkennt einen Wechsel der aktiven Bewertungsquelle (Pool-Preis ↔ Referenzpreis-Fallback)
 * für einen Referenzpool und skaliert HWM/Einstieg jeder betroffenen offenen Position mit,
 * bevor die neue Quelle in irgendeine Bewertung einfließt.
 *
 * Läuft bei jedem Aufruf von getQuotePriceUsd() — dem einzigen Ort, durch den jede Bewertung
 * läuft (Bot-Zyklus über writePositionSnapshotFromState UND Schnellprüfung über
 * computeLpValueFromState, siehe Modulkopf beider Funktionen). Ein Wechsel wird dadurch
 * *vor* dem allerersten Snapshot der neuen Quelle abgefangen, nicht erst einen Zyklus später.
 *
 * Läuft mehrmals pro Zyklus (einmal je Pool mit demselben quotePricePoolId) — reine
 * DB-Lese-/Vergleichsoperation, kein Netzwerk-Call. Nur der erste Aufruf nach einem echten
 * Wechsel findet eine Differenz zum gespeicherten Zustand; alle weiteren Aufrufe desselben
 * Zyklus sehen den bereits aktualisierten Zustand und tun nichts.
 *
 * @param {string} quotePricePoolId  z.B. 'liq-sol-usdc'
 * @param {'pool'|'oracle'} currentSource  gerade ermittelte aktive Quelle
 * @param {number|undefined} poolPrice    aktueller Pool-Preis, auch wenn gerade nicht aktiv
 *                                        (Zeilenwert existiert unabhängig von der Frische)
 * @param {number|undefined} oraclePrice  aktueller Referenzpreis, auch wenn gerade nicht aktiv
 */
function reconcileQuotePriceSource(db, quotePricePoolId, currentSource, poolPrice, oraclePrice) {
    const kvKey     = `quote_source:${quotePricePoolId}`;
    const lastSource = kvGet(db, kvKey);

    if (!lastSource) {
        // Erster Aufruf überhaupt (frischer Bot-Start oder frisches Deployment dieses
        // Mechanismus) — nichts zum Vergleichen, nur den Ausgangszustand festhalten.
        kvSet(db, kvKey, currentSource);
        return;
    }
    if (lastSource === currentSource) return;   // kein Wechsel

    const priceBefore = lastSource === 'pool' ? poolPrice : oraclePrice;
    const priceAfter  = currentSource === 'pool' ? poolPrice : oraclePrice;

    console.log(`[quote-source:${quotePricePoolId}] Bewertungsquelle wechselt: `
        + `${lastSource} → ${currentSource}`
        + (priceBefore > 0 && priceAfter > 0
            ? ` (${priceBefore.toFixed(4)} → ${priceAfter.toFixed(4)}, `
              + `${(((priceAfter / priceBefore) - 1) * 100).toFixed(2)} %)`
            : ' (Vergleichspreis fehlt — Referenzen können nicht skaliert werden)'));

    if (priceBefore > 0 && priceAfter > 0) {
        const affectedPools = config.pools.all.filter(p => p.quotePricePoolId === quotePricePoolId);
        for (const p of affectedPools) {
            const position = getOpenPosition(db, p.id);
            if (!position) continue;
            const { applied, factor } = scaleReferencesForQuotePriceChange(
                db, position.id, priceBefore, priceAfter,
            );
            if (applied) {
                console.log(`[quote-source:${quotePricePoolId}] ${p.id}: HWM/Einstieg mit `
                    + `Faktor ${factor.toFixed(4)} nachgezogen (Höchststand/Referenz unverändert `
                    + `relativ zum Positionswert).`);
            } else {
                console.warn(`[quote-source:${quotePricePoolId}] ${p.id}: Skalierung übersprungen `
                    + `(Faktor außerhalb der plausiblen Bandbreite 0,5–2 — Referenz bleibt stehen, `
                    + `bitte manuell prüfen).`);
            }
        }
        notify.info(quotePricePoolId,
            `Bewertungsquelle für ${quotePricePoolId} gewechselt (${lastSource} → ${currentSource}, `
            + `${(((priceAfter / priceBefore) - 1) * 100).toFixed(2)} %). Trailing-Stop-Referenzen `
            + `der betroffenen Pools automatisch nachgezogen.`
        ).catch(() => {});
    }

    kvSet(db, kvKey, currentSource);
}

/**
 * Prüft den Oracle-Preis gegen den real gehandelten Pool-Preis und meldet eine anhaltende
 * Abweichung. Siehe `lib/price-sanity.js` für Schwellen und Begründung.
 *
 * 🔒 **Meldet, verwirft aber (noch) nicht.** Das ist eine bewusste Entscheidung vom
 * 2026-08-27 und kein halber Fix — der Grund ist die Wirkung des Umschaltens, nicht Vorsicht
 * um ihrer selbst willen:
 *
 * Der Oracle-Wert lag beim Fund 6,1 % unter dem Marktpreis. Würde diese Funktion ihn
 * verwerfen, spränge `lp_value_usd` aller X/SOL-Pools im selben Zyklus um +6,1 % nach oben.
 * `updateHwm()` zöge den Höchststand mit, und `armSecondStageIfReached()` schaltete Stufe 2
 * scharf, sobald der neue Höchststand die Einstiegsreferenz um Stufe 1 (2 %) übertrifft —
 * bei PUMP/SOL war das mit +6,1 % sofort der Fall. Stufe 2 steht dort auf **0,5 %**; die
 * nächste normale Kursschwankung hätte die Position binnen Minuten geschlossen. Genau dieses
 * Muster ist am 23.08. schon einmal eingetreten (Position #410, Exit neun Minuten nach
 * Eröffnung durch eine verschobene Referenz, LIQ#0321).
 *
 * Ein Wechsel der Bewertungsquelle ist weder Gewinn noch Verlust. Bevor er stattfinden darf,
 * müssen Höchststand und Einstiegsreferenz mit demselben Faktor mitskaliert werden — analog
 * zu `scaleReferencesForLiquidityChange()` beim Kapitalfluss (KB-Merksatz aus
 * `rm-exits-wechselwirkungen.md`: „Jeder Eingriff in lp_value_usd zieht HWM und
 * Einstiegsreferenz relativ nach — nie nur zurücksetzen, nie additiv"). Dieser Schritt ist
 * bewusst noch nicht gebaut: er gehört gegen `bin/test-trailing-stop-sim.js` abgesichert,
 * nicht nebenbei eingeführt, während zwei Positionen mit echtem Kapital offen sind.
 *
 * ⚠️ Daraus folgt ein Restrisiko, das NICHT dieser Code erzeugt: Sobald Hermes von selbst
 * wieder liefert, entsteht derselbe Sprung ohne jedes Zutun. Siehe doc/CHANGELOG/2026-08-27.md.
 */
function checkQuotePriceSanity(db, quotePoolId, oraclePrice, poolRow = null) {
    try {
        const ps = poolRow ?? db.prepare(
            `SELECT price, recorded_at FROM pool_stats WHERE pool_id = ?
             ORDER BY recorded_at DESC LIMIT 1`
        ).get(quotePoolId);

        const { verdict, shouldNotify, shouldLog, streak, recovered } =
            trackQuotePriceSanity(quotePoolId, oraclePrice, ps?.price);

        if (recovered) {
            console.log(`[price-sanity:${quotePoolId}] Preisquellen wieder deckungsgleich `
                + `(Oracle ${verdict.oraclePrice.toFixed(4)} USD, Pool ${verdict.poolPrice.toFixed(4)} USD) — `
                + `Bewertung ist ab sofort wieder belastbar.`);
            return;
        }
        if (!verdict.comparable || verdict.plausible || !shouldLog) return;

        const dir  = verdict.divergencePct > 0 ? 'über' : 'unter';
        const line = `[price-sanity:${quotePoolId}] Oracle-Preis ${verdict.oraclePrice.toFixed(4)} USD liegt `
            + `${Math.abs(verdict.divergencePct).toFixed(2)}% ${dir} dem gehandelten Pool-Preis `
            + `${verdict.poolPrice.toFixed(4)} USD (Pool-Stand von ${new Date(ps.recorded_at).toLocaleString('de-DE')}, `
            + `${streak}. Zyklus in Folge). Bewertet wird mit dem Pool-Preis; der Oracle-Wert dient nur `
            + `als Rückfallebene und driftet gerade ab — Ursache prüfen, bevor er wieder gebraucht wird.`;
        console.warn(line);

        if (shouldNotify) {
            // Fertig formulierte Meldung über errorRaw: kein neuer Katalogschlüssel nötig
            // (der bräuchte sonst einen forge-settings-Neustart, siehe Memory
            // feedback_i18n_catalog_process_cache).
            notify.errorRaw(quotePoolId, line).catch(() => {});
        }
    } catch (err) {
        // Eine fehlschlagende Plausibilitätsprüfung darf die Bewertung nie aufhalten —
        // sie ist ein Wächter, kein Bestandteil der Preisermittlung.
        console.warn(`[price-sanity:${quotePoolId}] Prüfung übersprungen: ${err.message}`);
    }
}

/**
 * USD-Konversionsfunktion je nach Pool-Typ.
 *  - usdcIsTokenA: tokenA=USDC, tokenB=EURC o.ä. → a + b/price
 *  - volatilePair: beide Tokens volatil, USD via Quote-Token (z.B. SOL bei HYPE/SOL, BTC bei cbBTC/WBTC).
 *                  Wenn Quote = tokenA: (a + b/price) * quotePriceUsd
 *                  Wenn Quote = tokenB: (a*price + b) * quotePriceUsd
 *  - Standard:     tokenA=SOL/cbBTC, tokenB=USDC → a*price + b
 */
function makeToUsd(pool, price, quotePrice) {
    if (pool.usdcIsTokenA)   return (a, b) => a + (price > 0 ? b / price : 0);
    if (pool.volatilePair) {
        const quoteIsTokenA = pool.quoteTokenMint === pool.tokenA;
        if (quoteIsTokenA) {
            return (a, b) => (a + (price > 0 ? b / price : 0)) * quotePrice;
        }
        return (a, b) => (a * price + b) * quotePrice;
    }
    return (a, b) => a * price + b;
}

// ─── Plausibilitätsprüfung Pending Fees ──────────────────────────────────────
//
// Die Regel selbst steht in FORGE/lib/fee-plausibility.js — sie wird auch rückwirkend von
// der Migration 0005-phantom-fee-snapshots gebraucht, und zwei Kopien würden auseinander
// laufen. Hier bleibt nur die DB-Anbindung: den Vorgänger-Snapshot holen und fragen.

/**
 * Drosselung der Meldung: höchstens eine pro Pool und Stunde. Der Lesefehler tritt
 * gehäuft auf, solange der Preis auf einer Tick-Grenze pendelt — ohne Drosselung
 * bekäme der Nutzer im Minutentakt dieselbe Nachricht und würde sie wegklicken.
 * Der Guard selbst greift natürlich bei jedem einzelnen Messwert.
 */
const NOTIFY_THROTTLE_MS = 60 * 60 * 1000;
const _lastFeeRejectNotify = new Map();   // poolId → ts

/**
 * Prüft einen frisch gemessenen Pending-Fee-Wert gegen den letzten Snapshot des Pools.
 *
 * @returns {{ ok: boolean, impliedAprPct: number|null, prev: Object|null }}
 *          ok=false → der Wert ist unplausibel und darf nicht in die Wertreihe.
 */
function checkFeesPlausible(db, poolId, feesPendingUsd, lpValueUsd) {
    const prev = db.prepare(
        `SELECT fees_pending_usd, fees_pending_a, fees_pending_b, recorded_at
           FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`,
    ).get(poolId);
    if (!prev) return { ok: true, impliedAprPct: null, prev: null };

    const verdict = checkFeeJump({
        feesUsd:     feesPendingUsd,
        prevFeesUsd: prev.fees_pending_usd,
        lpValueUsd,
        elapsedMs:   Date.now() - (prev.recorded_at ?? 0),
    });
    return { ok: !verdict.implausible, impliedAprPct: verdict.impliedAprPct, prev };
}

// ─── Position-Snapshot ────────────────────────────────────────────────────────

/**
 * Schreibt einen Position-Snapshot, berechnet aus On-Chain-State.
 *
 * Verwendet vom Bot-Loop nach Claim+Reinvest: `state.liquidity` ist bereits
 * der neue Gesamt-Wert (nach orca.js v0.3.8 ohne stale Cache-Read).
 *
 * @param {Object} db
 * @param {Object} pool       – aktive Pool-Config (mit quotePricePoolId, usdcIsTokenA, decimalsA/B)
 * @param {Object} position   – DB-Position-Row (hodl_token_a/b für IL-Berechnung)
 * @param {Object} state      – On-Chain-State: { liquidity, tickLower, tickUpper, feesOwedA, feesOwedB }
 * @param {number} price      – aktueller Pool-Preis (tokenB pro tokenA)
 * @returns {boolean}         – true wenn Snapshot geschrieben, false bei Stale-Guard-Skip
 */
/**
 * Rechnet den Positionswert aus Liquidität, Range und Pool-Preis — **ohne** etwas zu
 * schreiben. Das ist die eine Formel, mit der jeder Snapshot bewertet wird; die
 * Schnellprüfung des Trailing Stops (`lib/fast-stop-check.js`) nutzt exakt dieselbe,
 * damit ihr Wert mit der Messreihe vergleichbar ist und kein zweites Modell entsteht.
 *
 * @param {Object} state  { liquidity, tickLower, tickUpper }
 * @param {number} price  Pool-Preis (tokenB je tokenA)
 * @returns {{ lpValueUsd: number, tokenAAmount: number, tokenBAmount: number, toUsd: Function }}
 */
export function computeLpValueFromState(db, pool, state, price) {
    const liquidityBN = new BN(String(state.liquidity));
    const sqrtPrice   = PriceMath.priceToSqrtPriceX64(
        new Decimal(price), pool.decimalsA, pool.decimalsB,
    );
    const sqrtLower = PriceMath.tickIndexToSqrtPriceX64(state.tickLower);
    const sqrtUpper = PriceMath.tickIndexToSqrtPriceX64(state.tickUpper);

    const amounts = PoolUtil.getTokenAmountsFromLiquidity(
        liquidityBN, sqrtPrice, sqrtLower, sqrtUpper, false,
    );
    const tokenAAmount = new Decimal(amounts.tokenA.toString()).div(Math.pow(10, pool.decimalsA)).toNumber();
    const tokenBAmount = new Decimal(amounts.tokenB.toString()).div(Math.pow(10, pool.decimalsB)).toNumber();

    const quotePrice = getQuotePriceUsd(db, pool);
    const toUsd      = makeToUsd(pool, price, quotePrice);

    return { lpValueUsd: toUsd(tokenAAmount, tokenBAmount), tokenAAmount, tokenBAmount, toUsd };
}

export function writePositionSnapshotFromState(db, pool, position, state, price) {
    const { lpValueUsd, tokenAAmount, tokenBAmount, toUsd } = computeLpValueFromState(db, pool, state, price);
    let   feesPendingUsd = toUsd(state.feesOwedA ?? 0, state.feesOwedB ?? 0);
    let   feesPendingA   = state.feesOwedA ?? 0;
    let   feesPendingB   = state.feesOwedB ?? 0;

    // Plausibilitätsprüfung der Pending Fees. Verworfen wird nur die Fee-Komponente, nicht
    // der ganze Snapshot: lp_value_usd stammt aus einer unabhängigen Rechnung (Liquidität +
    // Preis) und war im TRUMP/SOL-Vorfall korrekt. Den Snapshot komplett zu verwerfen würde
    // stattdessen den alten Positionswert festhalten — schlechter als der Teil-Verwurf.
    // Die Fees des Vorgängers werden übernommen, der nächste Tick misst sie sauber neu.
    const feeCheck = checkFeesPlausible(db, pool.id, feesPendingUsd, lpValueUsd);
    if (!feeCheck.ok) {
        console.warn(
            `[refresh-state:${pool.id}] Pending Fees unplausibel: ${feesPendingUsd.toFixed(4)} USDC ` +
            `bei ${lpValueUsd.toFixed(2)} USDC Positionswert (Vorgänger ${(feeCheck.prev?.fees_pending_usd ?? 0).toFixed(4)}, ` +
            `entspräche ${Math.round(feeCheck.impliedAprPct).toLocaleString('de-DE')} % APR) — ` +
            `Fee-Wert verworfen, Vorgängerwert übernommen`,
        );
        const lastNotify = _lastFeeRejectNotify.get(pool.id) ?? 0;
        if (Date.now() - lastNotify > NOTIFY_THROTTLE_MS) {
            _lastFeeRejectNotify.set(pool.id, Date.now());
            // Bewusst nicht awaited: der Snapshot-Pfad ist synchron und darf nicht auf den
            // Nexus warten. Ein Fehlschlag der Meldung darf den Snapshot nie verhindern.
            notify.feeMeasurementRejected(pool, {
                measuredUsd:   feesPendingUsd,
                lpValueUsd,
                previousUsd:   feeCheck.prev?.fees_pending_usd ?? 0,
                impliedAprPct: feeCheck.impliedAprPct,
            }).catch(err => console.warn(`[refresh-state:${pool.id}] Meldung zur Fehlmessung fehlgeschlagen: ${err.message}`));
        }
        feesPendingUsd = feeCheck.prev?.fees_pending_usd ?? 0;
        feesPendingA   = feeCheck.prev?.fees_pending_a   ?? 0;
        feesPendingB   = feeCheck.prev?.fees_pending_b   ?? 0;
    }

    const hodlValue = toUsd(position.hodl_token_a ?? 0, position.hodl_token_b ?? 0);
    const ilUsd     = lpValueUsd - hodlValue;
    const ilPct     = hodlValue > 0 ? (ilUsd / hodlValue) * 100 : 0;

    // Stale-Read-Guard: liquidity=0 bei offener Position ist ein fehlerhafter Zwischenzustand
    if (lpValueUsd <= 0) {
        console.warn(`[refresh-state:${pool.id}] writePositionSnapshotFromState übersprungen: lpValueUsd=${lpValueUsd.toFixed(4)} (liquidity=${state.liquidity}, price=${price})`);
        return false;
    }

    // positions.liquidity mit frischem On-Chain-Wert synchronisieren (sonst bleibt der
    // beim Öffnen gespeicherte Wert hängen, da Reconcile-/Reinvest-increaseLiquidity die
    // echte Liquidität erhöht). Single Point of Truth bei jedem regulären Tick.
    if (position?.id != null) {
        updatePositionLiquidity(db, position.id, state.liquidity);
    }

    insertPositionSnapshot(db, {
        poolId:        pool.id,
        lpValueUsd,
        feesPendingUsd,
        feesPendingA,
        feesPendingB,
        price,
        ilUsd,
        ilPct,
        amountA:       tokenAAmount,
        amountB:       tokenBAmount,
    });
    return true;
}

/**
 * Etabliert die Trailing-Stop-Referenz einer frisch geöffneten Position aus einem
 * **gemessenen** On-Chain-Read, statt damit auf den nächsten Bot-Tick zu warten.
 *
 * Das Problem, das diese Funktion löst: `updateHwm()` läuft nur im Snapshot-Pfad des
 * Bot-Loops, also alle ~5 Minuten. Zwischen dem Öffnen einer Position und diesem Tick war
 * der Trailing Stop blind — seine Wertreihe begann erst beim ersten Bot-Snapshot, ein
 * Kursrutsch unmittelbar nach dem Einstieg lag damit vor seinem ersten Datenpunkt und
 * konnte den Stop nicht auslösen. Auf forge-pub1 kostete das am 2026-08-22 bei SOL/ZEC
 * 4,3 % (Eröffnung 66,03 USDC um 07:05:29, erster Bot-Snapshot 63,18 USDC um 07:10:20),
 * ohne dass die 2 %-Schwelle je griff. Details: KB `rm-exits-wechselwirkungen.md`.
 *
 * 🔒 **Gemessen, nicht geschätzt.** Der Wert entsteht über denselben Pfad wie jeder spätere
 * Snapshot (`getPositionState` → `writePositionSnapshotFromState`, Bewertung via
 * `getQuotePriceUsd` aus Pyth). Ein Quote-basierter Einstiegswert wäre mit den Snapshots
 * nicht vergleichbar und würde laut KB rund einen Prozentpunkt der Schwelle allein durch
 * Schätzfehler verbrauchen — genau das, was `rebaseHwmForCapitalFlow()` bewusst vermeidet.
 *
 * Schlägt der On-Chain-Read fehl, bleibt es beim bisherigen Verhalten: Der Aufrufer
 * schreibt seinen Quote-Snapshot, die Referenz folgt beim nächsten Bot-Tick. Eine frisch
 * geöffnete Position darf an einem RPC-Fehler nicht scheitern.
 *
 * @param {Object} db
 * @param {Object} pool
 * @param {Object} adapter   Pool-Adapter (muss `getPositionState` können)
 * @param {string} nftMint   Position-NFT der frisch geöffneten Position
 * @param {number} price     aktueller Pool-Preis
 * @returns {Promise<boolean>} true = Snapshot + Referenz gesetzt, false = Aufrufer-Fallback nötig
 */
export async function establishPositionBaseline(db, pool, adapter, nftMint, price, { logPrefix = '[baseline]' } = {}) {
    try {
        const position = getOpenPosition(db, pool.id);
        if (!position || !(price > 0)) return false;

        // fresh: true – ein Sweep/eine Rest-Einzahlung kann Sekunden vorher denselben
        // Account gelesen haben (In-Range-Check in sweepResidualIntoPosition) und damit den
        // 10-s-Proxy-Cache mit der alten Liquidität gefüllt haben. Ohne den Bypass würde die
        // Referenz auf dem Wert VOR dem Kapitalfluss stehen (siehe Kopf von orca.js#getPositionState).
        const state = await adapter.getPositionState(pool, nftMint, null, { fresh: true });
        if (!state || !(Number(state.liquidity) > 0)) {
            console.warn(`${logPrefix} ${pool.id}: Referenzmessung übersprungen – kein verwertbarer On-Chain-Zustand`);
            return false;
        }

        // Stale-Read-Guard steckt im Helper: bei lpValueUsd <= 0 wird nichts geschrieben.
        if (!writePositionSnapshotFromState(db, pool, position, state, price)) return false;

        const snap = db.prepare(
            `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ?
             ORDER BY recorded_at DESC LIMIT 1`
        ).get(pool.id);
        const lpUsd = snap?.lp_value_usd ?? 0;
        if (!(lpUsd > 0)) return false;

        updateHwm(db, pool, position, lpUsd);
        console.log(`${logPrefix} ${pool.id}: Referenzwert gemessen ${lpUsd.toFixed(2)} USDC – Höchststand und Einstiegsreferenz stehen ab sofort`);
        return true;
    } catch (err) {
        console.warn(`${logPrefix} ${pool.id}: Referenzmessung fehlgeschlagen, Höchststand folgt beim nächsten Bot-Tick – ${err.message}`);
        return false;
    }
}

/**
 * Schließt einen Kapitalfluss in eine **bestehende** Position ab: Trailing-Stop-Referenzen
 * nachziehen und den ersten Messwert nach dem Fluss schreiben — in dieser Reihenfolge.
 *
 * Gilt für jede Aufstockung per `increaseLiquidity` (stündlicher Cleanup, manueller Deposit,
 * Rest-Einzahlung, Reconcile-Top-up). Ersetzt die bisherige Sequenz „`rebaseHwmForCapitalFlow`
 * mit dem letzten Snapshot + Delta-Schätz-Snapshot + warten auf den nächsten Tick", die zwei
 * Lücken hatte (Befund 2026-08-22, forge-pub1 Position 81):
 *
 *  1. **Messlücke.** Das Verhältnis zum letzten Snapshot ist bis zu fünf Minuten alt; fiel der
 *     Kurs dazwischen, nahm der nächste Snapshot den niedrigeren Stand als neue Referenz hin.
 *  2. **Schätzwert als Vergleichsbasis.** Der Delta-Snapshot addierte Quote-Mengen; die
 *     wichen on-chain um 3,5 % ab, die Buchung (`capital_usdc`, `usd_value`) war falsch.
 *
 * Hier stattdessen: Die Liquidität der Position vor dem Fluss (on-chain, aus
 * `getPositionState`) und die Liquidität jedes Legs (aus den Vault-Deltas der bestätigten
 * Transaktion, `readLiquidityLegsFromTx`) ergeben den exakten Faktor
 * `L_nach / L_vor`; Höchststand und Einstiegsreferenz werden damit skaliert
 * (`scaleReferencesForLiquidityChange`). Danach wird der Positionswert **zum
 * Ausführungspreis des letzten Legs** aus `L_nach` berechnet und als Snapshot geschrieben —
 * derselbe Pfad wie jeder Bot-Tick (`writePositionSnapshotFromState`, Bewertung via Pyth),
 * nur mit dem on-chain belegten Preis der Transaktion statt eines späteren Reads hinter dem
 * Proxy-Cache. Der erste Messwert der neuen Kapitalstufe steht damit **sofort**, und jede
 * Kursbewegung seit dem letzten Snapshot erscheint als Drawdown.
 *
 * Sind nicht alle Legs gemessen (Transaktion nicht lesbar), fällt die Funktion auf die alte
 * Sequenz zurück und sagt das im Rückgabewert — niemals halb-gemessen mischen.
 *
 * @param {Object}   position         offene Position (DB-Zeile, vor dem Fluss gelesen)
 * @param {string}   liquidityBefore  Positions-Liquidität vor dem Fluss (`state.liquidity`)
 * @param {Array}    legs             Ergebnisse von `adapter.increaseLiquidity()` (Haupt + Rest …)
 * @param {Object}   fallback         { lpBefore, deltaA, deltaB, price } für die alte Sequenz
 * @returns {{ mode: 'measured'|'legacy', factor: number|null, lpUsd: number|null }}
 */
export function settleCapitalFlow(db, pool, position, { liquidityBefore, legs, fallback, logPrefix = '[flow]' }) {
    const real = (legs ?? []).filter(Boolean);
    const allMeasured = real.length > 0 && real.every(l => l.measured && Number(l.liquidityAdded) > 0 && l.priceExec > 0);

    if (!allMeasured || !(Number(liquidityBefore) > 0)) {
        const why = !(Number(liquidityBefore) > 0) ? 'Liquidität vor dem Fluss unbekannt' : 'Transaktion nicht vollständig lesbar';
        console.warn(`${logPrefix} ${pool.pair}: Kapitalfluss ohne Ist-Messung (${why}) – Referenz über letzten Snapshot, Schätz-Snapshot bis zum nächsten Tick`);
        const r = rebaseHwmForCapitalFlow(db, position.id, fallback?.lpBefore ?? 0);
        if (fallback && fallback.price > 0) {
            writePositionSnapshotFromDelta(db, pool, fallback.deltaA ?? 0, fallback.deltaB ?? 0, fallback.price);
        }
        return { mode: 'legacy', factor: null, lpUsd: null, rebase: r };
    }

    let liquidityAfter = new BN(String(liquidityBefore));
    for (const l of real) liquidityAfter = liquidityAfter.add(new BN(String(l.liquidityAdded)));

    const scaled = scaleReferencesForLiquidityChange(db, position.id, String(liquidityBefore), liquidityAfter.toString());
    if (!scaled.applied) {
        console.warn(`${logPrefix} ${pool.pair}: Liquiditätsfaktor unplausibel (${liquidityBefore} → ${liquidityAfter}) – Referenz über letzten Snapshot`);
        rebaseHwmForCapitalFlow(db, position.id, fallback?.lpBefore ?? 0);
    }

    // Messwert der neuen Kapitalstufe: L_nach zum Ausführungspreis des letzten Legs. Fees aus
    // dem letzten Snapshot übernehmen — increaseLiquidity verändert feesOwed nicht; der nächste
    // Tick liest sie präzise.
    const last = real[real.length - 1];
    const prev = db.prepare(
        `SELECT fees_pending_a, fees_pending_b FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
    ).get(pool.id);
    const state = {
        liquidity: liquidityAfter.toString(),
        tickLower: last.tickLower ?? position.tick_lower,
        tickUpper: last.tickUpper ?? position.tick_upper,
        feesOwedA: prev?.fees_pending_a ?? 0,
        feesOwedB: prev?.fees_pending_b ?? 0,
    };
    const written = writePositionSnapshotFromState(db, pool, position, state, last.priceExec);
    if (!written) return { mode: 'measured', factor: scaled.factor, lpUsd: null };

    const lpUsd = db.prepare(
        `SELECT lp_value_usd FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`
    ).get(pool.id)?.lp_value_usd ?? 0;
    if (lpUsd > 0) updateHwm(db, pool, position, lpUsd);

    const factorPct = scaled.factor != null ? ((scaled.factor - 1) * 100).toFixed(2) : 'n/a';
    console.log(`${logPrefix} ${pool.pair}: Kapitalfluss gemessen – Liquidität ${liquidityBefore} → ${liquidityAfter} (${factorPct} %), Referenzen skaliert, Positionswert ${lpUsd.toFixed(2)} USDC zum Ausführungspreis ${last.priceExec.toFixed(6)}`);
    return { mode: 'measured', factor: scaled.factor, lpUsd };
}

/**
 * Schreibt einen Position-Snapshot via Delta-Arithmetik (kein On-Chain-Read nötig).
 *
 * Verwendet von Deposit/Withdraw/Cleanup direkt nach increase-/decreaseLiquidity:
 *  - Liest letzten Snapshot des Pools (amount_a/b)
 *  - Addiert/subtrahiert Delta-Token-Beträge
 *  - Berechnet lp_value_usd mit aktuellem Preis
 *
 * Fees werden aus dem vorherigen Snapshot übernommen: `increaseLiquidity`/`decreaseLiquidity`
 * setzen die on-chain `feesOwed` nicht zurück (nur `update_fees_and_rewards` wird intern aufgerufen,
 * was die Werte sogar leicht erhöhen kann). Der nächste reguläre Bot-Tick überschreibt
 * `fees_pending_*` mit dem präzisen on-chain-Wert.
 * IL bleibt 0 (wird beim nächsten regulären Bot-Tick präzise neu berechnet).
 *
 * @param {Object} db
 * @param {Object} pool
 * @param {number} deltaA    – Token-A-Änderung in Einheiten (positiv=Einzahlung, negativ=Auszahlung)
 * @param {number} deltaB    – Token-B-Änderung
 * @param {number} price     – aktueller Pool-Preis
 * @returns {boolean}
 */
export function writePositionSnapshotFromDelta(db, pool, deltaA, deltaB, price) {
    const prev = db.prepare(
        `SELECT amount_a, amount_b, fees_pending_a, fees_pending_b, fees_pending_usd, recorded_at
         FROM position_snapshots WHERE pool_id = ? ORDER BY recorded_at DESC LIMIT 1`,
    ).get(pool.id);

    // Staleness-Guard: Ein Delta-Snapshot ist nur valide, wenn er auf einen FRISCHEN
    // On-Chain-Basis-Snapshot aufsetzt. Ist der letzte Snapshot veraltet (z.B. weil ein
    // abgebrochenes Rebalancing die regulären Tick-Snapshots unterdrückt hat), würde das
    // Delta auf einen falschen Basiswert addiert — das erzeugt physikalisch unmögliche
    // Token-Mengen und einen Wert-Spike (siehe PUMP/SOL-Vorfall 2026-06-28: +153 USDC
    // Phantom-Sprung auf 310). Dann lieber den Delta-Write überspringen und den nächsten
    // regulären On-Chain-Snapshot die Wahrheit etablieren lassen (= Verhalten vor dem
    // Delta-Write, kein Schaden — nur kein Sofort-Update im Dashboard).
    const STALE_BASE_MS = 15 * 60 * 1000;
    if (prev && (Date.now() - (prev.recorded_at ?? 0)) > STALE_BASE_MS) {
        const ageMin = ((Date.now() - prev.recorded_at) / 60000).toFixed(0);
        console.warn(`[refresh-state:${pool.id}] writePositionSnapshotFromDelta übersprungen: Basis-Snapshot ${ageMin} Min alt (> 15 Min) → On-Chain-Recompute beim nächsten Tick`);
        return false;
    }

    const snapAmtA = Math.max(0, (prev?.amount_a ?? 0) + deltaA);
    const snapAmtB = Math.max(0, (prev?.amount_b ?? 0) + deltaB);

    const quotePrice = getQuotePriceUsd(db, pool);
    const toUsd      = makeToUsd(pool, price, quotePrice);
    const lpValueUsd = toUsd(snapAmtA, snapAmtB);

    if (lpValueUsd <= 0) {
        console.warn(`[refresh-state:${pool.id}] writePositionSnapshotFromDelta übersprungen: lpValueUsd=${lpValueUsd.toFixed(4)}`);
        return false;
    }

    insertPositionSnapshot(db, {
        poolId:         pool.id,
        lpValueUsd,
        feesPendingUsd: prev?.fees_pending_usd ?? 0,
        feesPendingA:   prev?.fees_pending_a   ?? 0,
        feesPendingB:   prev?.fees_pending_b   ?? 0,
        price,
        ilUsd:          0,
        ilPct:          0,
        amountA:        snapAmtA,
        amountB:        snapAmtB,
    });
    return true;
}

// ─── Portfolio-Snapshot ───────────────────────────────────────────────────────

/**
 * Schreibt einen Aggregat-Snapshot über alle offenen Pools + Wallet.
 *
 * Single Source of Truth: Wallet-Werte (SOL/USDC/SPL-Tokens) kommen ausschließlich
 * aus wallet-monitor.db. Dazu wird VOR dem Aggregat ein frischer Wallet-Snapshot
 * geschrieben (writeFreshWalletSnapshot → on-chain). Damit kann das Aggregat nie
 * mehr von einer veralteten parallelen Wallet-Quelle abweichen.
 *
 * portfolio_history speichert seit v0.3.47 nur noch total/LP/Fees/IL — die
 * früheren wallet_*-Spalten sind entfernt (Phase 5 Migration).
 */
export async function writePortfolioSnapshot(db) {
    // 1. Frischer Wallet-Snapshot in wallet-monitor.db (SOL + alle SPL-Tokens via Bulk-Call).
    await writeFreshWalletSnapshot(db);

    // 2. Aggregat der offenen Positionen aus den jüngsten position_snapshots.
    const allPoolSnaps = db.prepare(`
        SELECT ps.lp_value_usd, ps.fees_pending_usd, ps.il_usd
        FROM position_snapshots ps
        INNER JOIN (
            SELECT pool_id, MAX(recorded_at) AS max_ts
            FROM position_snapshots GROUP BY pool_id
        ) latest ON ps.pool_id = latest.pool_id AND ps.recorded_at = latest.max_ts
        INNER JOIN positions p ON ps.pool_id = p.pool_id AND p.closed_at IS NULL
    `).all();

    const aggLpValue = allPoolSnaps.reduce((s, r) => s + r.lp_value_usd,    0);
    const aggFees    = allPoolSnaps.reduce((s, r) => s + r.fees_pending_usd, 0);
    const aggIlUsd   = allPoolSnaps.reduce((s, r) => s + r.il_usd,           0);

    // 3. Wallet-Summe aus wallet-monitor.db (gerade geschrieben → frisch).
    const wallet    = getLatestWalletBalance(config.botId);
    let walletVal   = wallet ? wallet.totalUsd : 0;

    // 4. Spike-Guard: verhindert Ausschläge wenn Rebalancing-Kapital kurz im Wallet liegt.
    //    Auslöser: total_usd würde mehr als 500 USDC steigen, ohne dass lp_value entsprechend
    //    gestiegen ist → Wallet-Spike, kein externer Zufluss.
    //    In diesem Fall walletVal auf den zuletzt bekannten Wallet-Anteil einfrieren.
    const _lastSnap = db.prepare(
        `SELECT total_usd, lp_value_usd, fees_pending_usd FROM portfolio_history
         ORDER BY recorded_at DESC LIMIT 1`
    ).get();
    if (_lastSnap) {
        const prevWallet   = Math.max(0, _lastSnap.total_usd - _lastSnap.lp_value_usd - _lastSnap.fees_pending_usd);
        const lpIncrease   = aggLpValue - _lastSnap.lp_value_usd;
        const totalIncrease = (aggLpValue + aggFees + walletVal) - _lastSnap.total_usd;
        if (totalIncrease > 500 && totalIncrease > lpIncrease + 200) {
            console.warn(`[portfolio] Wallet-Spike gedämpft: total wäre +${totalIncrease.toFixed(0)} USDC (LP +${lpIncrease.toFixed(0)}) — walletVal ${walletVal.toFixed(0)} → ${prevWallet.toFixed(0)}`);
            walletVal = prevWallet;
        }
    }

    insertPortfolioSnapshot(db, {
        totalUsd:       aggLpValue + aggFees + walletVal,
        lpValueUsd:     aggLpValue,
        feesPendingUsd: aggFees,
        ilUsd:          aggIlUsd,
        ilPct:          0,
    });
}

// ─── Wallet-Snapshot (Dashboard-Wallet-Spalte) ────────────────────────────────

/**
 * Liefert alle Pool-Tokens (tokenA + tokenB) aus der Pool-Konfiguration, ohne USDC
 * und WSOL (die werden separat als usdcBalance/solBalance behandelt). Dedup über Map
 * nach Mint. Quelle ist `config.pools.all` (inkl. inaktiver Pools), damit residuale
 * Tokens deaktivierter Pools korrekt erfasst werden.
 */
function getWalletWhitelistTokens() {
    const tokens = new Map();
    for (const pool of config.pools.all) {
        if (pool.tokenA && pool.tokenA !== WSOL_MINT && pool.tokenA !== USDC_MINT) {
            tokens.set(pool.tokenA, {
                mint:     pool.tokenA,
                decimals: pool.decimalsA,
                symbol:   pool.pair.split('/')[0],
            });
        }
        if (pool.tokenB && pool.tokenB !== WSOL_MINT && pool.tokenB !== USDC_MINT) {
            tokens.set(pool.tokenB, {
                mint:     pool.tokenB,
                decimals: pool.decimalsB,
                symbol:   pool.usdcIsTokenA ? pool.pair.split('/')[0] : pool.pair.split('/')[1],
            });
        }
    }
    return [...tokens.values()];
}

/**
 * Schreibt einen frischen Wallet-Snapshot. SOL und ALLE SPL-Token-Balances (USDC +
 * Whitelist) werden mit einem einzigen Bulk-RPC-Call gelesen — keine Pro-Token-Schleife.
 *
 * Hintergrund: Carry-Over aus alten Snapshots führte zu Wallet-Wert-Drift
 * (alte Balance × neuer Preis). Vor v0.3.46 machte diese Funktion N Einzel-Calls
 * (1 pro Whitelist-Token), was bei jeder Bot-Action den Helius-RPC unnötig belastete.
 * Jetzt: 3 RPCs (getBalance für SOL + TOKEN_PROGRAM + TOKEN_2022_PROGRAM parallel).
 * Token-2022-Tokens (PUMP, USDG) werden seit v0.3.54 korrekt erfasst.
 */
export async function writeFreshWalletSnapshot(db, { walletId = 'liquidity', walletLabel = 'Liquidity Bot' } = {}) {
    const keypair  = getKeypair();
    const conn     = getConnectionFresh();

    // 3 parallele RPCs: SOL + SPL-Token-Accounts (TOKEN_PROGRAM) + Token-2022-Accounts
    // Token-2022 (TokenzQd...) ist ein separates Program — getParsedTokenAccountsByOwner
    // mit programId=TOKEN_PROGRAM_ID übersieht Token-2022-Accounts vollständig (PUMP, USDG).
    const [lamports, tokenAccounts, token22Accounts] = await Promise.all([
        settle(conn.getBalance(keypair.publicKey, 'confirmed')),
        settle(conn.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: TOKEN_PROGRAM_ID })),
        settle(conn.getParsedTokenAccountsByOwner(keypair.publicKey, { programId: TOKEN_2022_PROGRAM_ID })),
    ]);
    const solBalance = lamports / 1_000_000_000;

    // mint → uiAmount aus dem Bulk-Result extrahieren (beide Program-Typen)
    const balByMint = new Map();
    for (const { account } of [...tokenAccounts.value, ...token22Accounts.value]) {
        const info = account.data.parsed.info;
        const amt  = info.tokenAmount.uiAmount ?? 0;
        if (amt > 0) balByMint.set(info.mint, amt);
    }
    const usdcBalance = balByMint.get(USDC_MINT) ?? 0;

    const solPriceRow = db.prepare(
        `SELECT price FROM pool_stats WHERE pool_id = 'liq-sol-usdc' ORDER BY recorded_at DESC LIMIT 1`,
    ).get();

    // Alle Whitelist-Tokens schreiben — auch balance=0. Damit zeigt das Dashboard
    // nach jeder Bot-Aktion konsistent alle Pool-Coins (analog zum 10-Min-Cron in
    // core/wallet-monitor/monitor.js). Andernfalls überschreibt jede Bot-Aktion den
    // vollständigen Cron-Snapshot mit einem reduzierten.
    const splTokens = [];
    for (const tok of getWalletWhitelistTokens()) {
        const bal = balByMint.get(tok.mint) ?? 0;
        const priceUsd = getTokenUsdPrice(tok.mint, db);
        splTokens.push({
            symbol:   tok.symbol,
            mint:     tok.mint,
            balance:  bal,
            priceUsd,
            valueUsd: bal * priceUsd,
        });
    }

    writeWalletSnapshot({
        walletId,
        walletLabel,
        walletAddress: keypair.publicKey.toBase58(),
        solBalance,
        usdcBalance,
        solPriceUsd:   solPriceRow?.price ?? 0,
        tokens:        splTokens,
    });
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Führt `core/wallet-monitor/monitor.js --once` als Subprocess aus.
 * Der monitor.js liest frische On-Chain-Daten mit eigener RPC-Connection
 * und Jupiter-Preisen — proven reliable auch wenn /rpc/fresh noch stale war.
 */
function runWalletMonitorOnce() {
    return new Promise((res, rej) => {
        const child = spawn('node', [WALLET_MONITOR_JS, '--once'], {
            env:   process.env,
            stdio: 'pipe',  // stdout/stderr nicht auf Cleanup-Console ausgeben
        });
        child.on('close', code => code === 0 ? res() : rej(new Error(`wallet-monitor exit ${code}`)));
        child.on('error', rej);
        setTimeout(() => { child.kill(); rej(new Error('wallet-monitor timeout')); }, 30_000);
    });
}

/**
 * Vollständiges Dashboard-Refresh nach einer Bot-Aktion.
 *
 * Reihenfolge ist wichtig: Position-Snapshot zuerst (vom Caller), dann
 * Portfolio-Aggregat (liest die neuen Pos-Snapshots), dann Wallet, dann Sync.
 *
 * Der Position-Snapshot muss vom Caller VOR diesem Aufruf geschrieben werden
 * (mit `writePositionSnapshotFromState` oder `writePositionSnapshotFromDelta`),
 * weil nur der Caller den passenden Kontext (state vs. delta) kennt.
 *
 * Zwei-Phasen-Refresh:
 *   Phase 1 (T+settleMs):  writeFreshWalletSnapshot via /rpc/fresh → sofortiger
 *                           Snapshot, ggf. noch leicht stale bei neuen Token-Accounts.
 *                           syncDashboard → Dashboard zeigt sofort annähernde Werte.
 *   Phase 2 (T+settleMs+10s): wallet-monitor --once Subprocess → zuverlässiger
 *                           zweiter Read mit frischer Connection + Jupiter-Preisen.
 *                           syncDashboard → Dashboard jetzt korrekt.
 *
 * Hintergrund: Helius-RPC braucht für getParsedTokenAccountsByOwner nach
 * Multi-Step-Operationen (withdraw + swaps + deposit) manchmal 15–30 Sekunden bis
 * der aktuelle Stand propagiert ist. Mit Zwei-Phasen-Refresh ist das Dashboard
 * spätestens nach ~16 Sekunden korrekt statt nach dem 10-Min-Cron.
 *
 * @param {Object} db
 * @param {Object} opts
 * @param {Function} [opts.log]      – Logger für syncDashboard-Status
 * @param {number}  [opts.settleMs]  – Phase-1-Wartezeit in ms (default: 6000)
 */
export async function refreshAfterAction(db, opts = {}) {
    const settleMs = opts.settleMs ?? 6000;

    // ─── Phase 1: sofortiger Snapshot (ggf. leicht stale) ────────────────────
    if (settleMs > 0) await new Promise(r => setTimeout(r, settleMs));
    await writePortfolioSnapshot(db);
    await syncDashboard(opts.log);

    // ─── Phase 2: zuverlässiger Wallet-Snapshot via externem monitor.js ───────
    // Weitere 10s warten damit Helius Token-Account-Balances sicher propagiert hat.
    await new Promise(r => setTimeout(r, 10_000));
    try {
        await runWalletMonitorOnce();
        // Nach frischem Wallet-Snapshot: Portfolio-Aggregat neu berechnen + nochmal syncen.
        await writePortfolioSnapshot(db);
        await syncDashboard(opts.log);
    } catch (e) {
        console.warn(`[refresh-state] Phase-2 wallet-monitor fehlgeschlagen: ${e.message}`);
    }
}
