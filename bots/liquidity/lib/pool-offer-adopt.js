/**
 * FORGE public Premium – Automatische Übernahme neuer Pool-Offers
 *
 * ── Produktentscheidung 2026-08-21: Übernahme ist Automatik ──────────────────
 *
 * Bis hierher war die Übernahme eine ausdrückliche Nutzeraktion: der Fork zeigte
 * geprüfte Angebote in einer Settings-Karte, der Nutzer klickte „Übernehmen", und
 * der Pool landete doppelt gesperrt (`enabled:false` + `cleanup.rankingEligible:false`)
 * in der Konfiguration. Erst ein zweiter Klick gab ihn für Kapital frei.
 *
 * Diese Doppelfreigabe ist entfallen. Der Grund ist keine Lockerung des
 * Sicherheitsmodells, sondern die Einsicht, dass der Klick nichts absicherte, was
 * nicht ohnehin abgesichert war: **über Kapital entscheidet das Score-Ranking, nicht
 * die Freigabe.** Ein übernommener Pool bekommt nur dann Geld, wenn er im stündlichen
 * Cleanup-Ranking auf Platz 1 steht (`CLEANUP_MODE=ranking`) — ein schlecht bewerteter
 * Pool bleibt auch mit `enabled:true` unangetastet. Der Klick verlangte dem Nutzer also
 * ein Urteil über Prüfergebnisse ab, die er nicht beurteilen kann (siehe pool-offers.md
 * „Die Freigabe muss substanziell sein, nicht dekorativ") und verzögerte dabei nur den
 * Zeitpunkt, zu dem das Ranking übernehmen durfte.
 *
 * Was dadurch NICHT wegfällt — die Sperren, die tatsächlich tragen:
 *   • Die On-Chain-Verifikation jedes prüfbaren Feldes. Eine Abweichung zwischen
 *     Lieferung und Chain führt weiterhin zur Ablehnung, nie zur Korrektur.
 *   • Die Abbruchkriterien (Token-2022, adaptive Fees) samt der `accepted`-Ausnahme.
 *   • Der Herkunftsmarker `premiumOffer`, an dem Rückstufung und Offer-Updates hängen.
 *   • Das Score-Ranking als alleiniger Kapital-Gatekeeper.
 *
 * Der Nutzer erfährt von jeder Übernahme über eine Nachricht im Message Center
 * (notify.premiumPoolsAdopted) — informiert, statt gefragt.
 *
 * Dieses Modul kapselt ausschließlich das Schreiben. Die Entscheidung, OB ein Offer
 * übernommen wird (Validierung, Retirement-Status, Dublettenprüfung), trifft der
 * Aufrufer — bin/pool-offers-sync.js.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';

const POOLS_JSON          = PATHS.liquidityPools;
const SETTINGS_DB         = PATHS.settingsDb;
const TOKEN_INFO_OVERLAY  = path.join(PATHS.html, 'liquidity', 'data', 'premium', 'token-info.json');
const WALLET_MONITOR_CONFIG = path.join(PATHS.core, 'wallet-monitor', 'config.json');
const BOT_ID = 'liquidity';

export function loadLocalPools() {
    try {
        const cfg = JSON.parse(fs.readFileSync(POOLS_JSON, 'utf8'));
        return Array.isArray(cfg) ? cfg : (cfg.pools ?? []);
    } catch {
        return [];
    }
}

/** Atomarer Schreibvorgang (temp + rename) — pools.json wird vom Bot jeden Zyklus gelesen. */
export function writePoolsJsonAtomic(pools) {
    const tmp = `${POOLS_JSON}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(pools, null, 2));
    fs.renameSync(tmp, POOLS_JSON);
}

/** Ergänzt die kuratierten Token-Infos des Offers als Overlay (siehe token-info-store.js). */
export function mergeTokenInfoOverlay(tokenInfo) {
    if (!tokenInfo || Object.keys(tokenInfo).length === 0) return;
    let existing = { tokens: {} };
    try {
        existing = JSON.parse(fs.readFileSync(TOKEN_INFO_OVERLAY, 'utf8'));
    } catch { /* Datei existiert noch nicht — erste Premium-Pool-Übernahme */ }
    existing.tokens = { ...(existing.tokens ?? {}), ...tokenInfo };
    fs.mkdirSync(path.dirname(TOKEN_INFO_OVERLAY), { recursive: true });
    fs.writeFileSync(TOKEN_INFO_OVERLAY, JSON.stringify(existing));
}

/**
 * Registriert bislang unbekannte Tokens des Offers in wallet-monitor/config.json
 * (Blocker 2, siehe pool-offers.md) — ohne diesen Eintrag lehnt „Guthaben senden" den
 * neuen Token mit „Unbekannter Token" ab. Symbol kommt aus dem Offer-tokenInfo, wenn
 * vorhanden, sonst aus den ersten 6 Zeichen der Mint-Adresse (Platzhalter, nie geraten).
 */
export function registerTokensIfMissing(offer) {
    let cfg;
    try {
        cfg = JSON.parse(fs.readFileSync(WALLET_MONITOR_CONFIG, 'utf8'));
    } catch {
        return; // Datei fehlt (untypisch) — Übernahme nicht daran scheitern lassen
    }
    cfg.tokens = cfg.tokens ?? [];
    const knownMints = new Set(cfg.tokens.map(t => t.mint));

    const candidates = [
        { mint: offer.tokenA, decimals: offer.decimalsA },
        { mint: offer.tokenB, decimals: offer.decimalsB },
    ];
    let changed = false;
    for (const { mint, decimals } of candidates) {
        if (!mint || knownMints.has(mint)) continue;
        const symbol = offer.tokenInfo?.[mint]?.symbol ?? mint.slice(0, 6);
        cfg.tokens.push({ symbol, mint, decimals });
        changed = true;
    }
    if (changed) fs.writeFileSync(WALLET_MONITOR_CONFIG, JSON.stringify(cfg, null, 2));
}

/**
 * Baut den pools.json-Eintrag aus einem verifizierten Offer.
 *
 * `enabled: true` steht hier bewusst und explizit — nicht als weggelassenes Feld.
 * pool-offers.md warnte unter „Der gefährlichste Fehler: `enabled` weglassen" genau
 * davor, dass ein fehlendes Feld als Freigabe gilt. Diese Warnung bleibt richtig: das
 * Feld ist gesetzt, weil die Freigabe gewollt ist, nicht weil sie vergessen wurde.
 *
 * `active` bleibt false — das ist der operative Zustand („offene Position vorhanden"),
 * den ausschließlich die Bot-Automatik schreibt. Er darf nie aus Lieferdaten kommen.
 */
export function buildPoolEntry(offer, now = Date.now()) {
    return {
        id: offer.id,
        poolType: offer.poolType,
        protocol: offer.protocol,
        address: offer.address,
        pair: offer.pair,
        displayPair: offer.displayPair ?? offer.pair,
        tokenA: offer.tokenA,
        tokenB: offer.tokenB,
        decimalsA: offer.decimalsA,
        decimalsB: offer.decimalsB,
        feeTier: offer.feeTier,
        tickSpacing: offer.tickSpacing,
        usdcIsTokenA: offer.poolShape?.usdcIsTokenA ?? false,
        volatilePair: offer.poolShape?.volatilePair ?? false,
        quotePricePoolId: offer.poolShape?.quotePricePoolId ?? null,
        quoteTokenMint: offer.poolShape?.quoteTokenMint ?? null,
        aprAlertEnabled: offer.poolShape?.aprAlertEnabled ?? false,
        proactiveTrigger: offer.suggested?.proactiveTrigger ?? 0.75,
        rangeOverride: {
            mode: 'fixed',
            fixedPct: offer.suggested?.rangePct ?? 5,
            locked: false,
        },
        stopLossPctOpen: offer.suggested?.stopLossPctOpen ?? null,
        tvlWarnThreshold: offer.suggested?.tvlWarnThreshold ?? null,
        tvlExitThreshold: offer.suggested?.tvlExitThreshold ?? null,
        capitalUSDC: 0,
        // Herkunftsnachweis. Nur Pools mit diesem Marker unterliegen dem automatischen
        // Exit bei Rückstufung und den Offer-Updates (lib/pool-offer-sync.js). Ein von
        // Hand angelegter Pool — etwa ein Referenzpool — bleibt dadurch garantiert
        // unangetastet, auch wenn er in keiner Angebotsliste auftaucht.
        //
        // Steht bewusst hier in pools.json und NICHT in settings.db pool_settings:
        // setPoolActive(id,false) löscht dort die ganze Zeile des Pools (lib/config.js),
        // die Herkunft würde also ausgerechnet beim Deaktivieren verschwinden.
        premiumOffer: {
            offerId: offer.id,
            adoptedAt: now,
            // Unterscheidet die Automatik von den vor 2026-08-21 per UI-Klick
            // übernommenen Pools — die tragen weiterhin ihre Doppelsperre und sollen
            // nicht rückwirkend freigeschaltet werden.
            autoAdopted: true,
        },
        enabled: true,
        active: false,
    };
}

/**
 * Nebenwirkungen einer Übernahme außerhalb von pools.json.
 *
 * Bewusst getrennt vom Schreiben des Pool-Eintrags: der Aufrufer sammelt mehrere
 * Übernahmen in einem Durchlauf und schreibt pools.json genau einmal am Ende
 * (bin/pool-offers-sync.js). Würde diese Funktion die Datei mitschreiben, überschriebe
 * der abschließende Sammel-Write jede vorher geschriebene Übernahme wieder.
 *
 * Der Aufrufer hat zu diesem Zeitpunkt bereits geprüft: Offer nicht retired, Pool noch
 * nicht bekannt, `validatePoolOffer()` liefert 'verified'.
 */
export function applyAdoptSideEffects(offer) {
    // Kein `cleanup.rankingEligible:false` mehr (die zweite Sperre des alten
    // Klick-Pfads). Der Pool soll am Ranking teilnehmen — genau dort fällt die
    // Kapitalentscheidung. Der Default aus lib/pool-settings-defaults.js ist `true`;
    // eine bestehende Zeile aus einem früheren Leben des Pools wird bereinigt, damit
    // eine alte Sperre die Übernahme nicht stillschweigend aushebelt.
    const db = new Database(SETTINGS_DB);
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS pool_settings (
                bot_id   TEXT NOT NULL,
                pool_id  TEXT NOT NULL,
                settings TEXT NOT NULL DEFAULT '{}',
                PRIMARY KEY (bot_id, pool_id)
            )
        `);
        const row = db.prepare(
            `SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`
        ).get(BOT_ID, offer.id);
        if (row) {
            const settings = JSON.parse(row.settings);
            if (settings.cleanup?.rankingEligible === false) {
                settings.cleanup = { ...settings.cleanup, rankingEligible: true };
                db.prepare(`
                    INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES (?, ?, ?)
                    ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
                `).run(BOT_ID, offer.id, JSON.stringify(settings));
            }
        }
    } finally {
        db.close();
    }

    mergeTokenInfoOverlay(offer.tokenInfo);
    registerTokensIfMissing(offer);
}
