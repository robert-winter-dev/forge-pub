/**
 * /api/pools/liquidity/pool-offers – Neue-Pool-Angebote aus dem Premium-Datendienst
 * (Klasse C, siehe pool-offers.md „Übernahme-Pfad")
 *
 * GET  /liquidity/pool-offers                  → validierte Liste aller aktuellen Offers
 * POST /liquidity/pool-offers/:offerId/adopt   → übernimmt einen Offer
 *
 * "Übernehmen" != Kapitalfreigabe (pool-offers.md „Drei getrennte Zustände"): schreibt nur
 * einen neuen, deaktivierten pools.json-Eintrag (enabled:false, active:false — beide
 * EXPLIZIT, siehe „Der gefährlichste Fehler: enabled weglassen") + eine unabhängige zweite
 * Sperre (cleanup.rankingEligible:false) in settings.db. Kein Kapital bewegt sich. Die
 * eigentliche Freigabe läuft danach über den bereits bestehenden Weg
 * (PUT /liquidity/:poolId, enabled:true) — bewusst dieselbe Aktion wie bei jedem anderen
 * Pool, keine neue Sonderfunktion für „Kapital freigeben".
 *
 * Server-seitige Neuvalidierung bei jeder Übernahme (nie dem Client-Zustand vertrauen) —
 * der Offer könnte sich seit dem letzten GET geändert haben, oder die Anfrage könnte
 * manuell manipuliert sein.
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { PATHS } from '../../../config/paths.js';
import { validatePoolOffers, validatePoolOffer } from '../../liquidity/lib/pool-offers-validator.js';
import { loadPoolOffers, isRetired } from '../../liquidity/lib/premium-offers-store.js';
import { t } from '../../../lib/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const POOL_OFFERS_JSON = path.join(PATHS.liquidityData, 'premium', 'pool-offers.json');
const POOLS_JSON = PATHS.liquidityPools;
const SETTINGS_DB = PATHS.settingsDb;
const TOKEN_INFO_OVERLAY = path.join(PATHS.html, 'liquidity', 'data', 'premium', 'token-info.json');
const WALLET_MONITOR_CONFIG = path.join(PATHS.core, 'wallet-monitor', 'config.json');
const BOT_ID = 'liquidity';

function openSettingsDb() {
    const db = new Database(SETTINGS_DB);
    db.exec(`
        CREATE TABLE IF NOT EXISTS pool_settings (
            bot_id   TEXT NOT NULL,
            pool_id  TEXT NOT NULL,
            settings TEXT NOT NULL DEFAULT '{}',
            PRIMARY KEY (bot_id, pool_id)
        )
    `);
    return db;
}

/**
 * Fehlt die Datei (Premium noch nie geliefert) → leere Liste, kein Fehler.
 * Normalisiert zugleich das Alt-Format (nacktes Array) — siehe premium-offers-store.js.
 */
function loadOffersRaw() {
    return loadPoolOffers(POOL_OFFERS_JSON).offers;
}

function loadLocalPools() {
    try {
        const cfg = JSON.parse(fs.readFileSync(POOLS_JSON, 'utf8'));
        return Array.isArray(cfg) ? cfg : (cfg.pools ?? []);
    } catch {
        return [];
    }
}

/** Atomarer Schreibvorgang (temp + rename) — pools.json wird vom Bot jeden Zyklus gelesen. */
function writePoolsJsonAtomic(pools) {
    const tmp = `${POOLS_JSON}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(pools, null, 2));
    fs.renameSync(tmp, POOLS_JSON);
}

/** Ergänzt die kuratierten Token-Infos des Offers als Overlay (siehe token-info-store.js). */
function mergeTokenInfoOverlay(tokenInfo) {
    if (!tokenInfo || Object.keys(tokenInfo).length === 0) return;
    let existing = { tokens: {} };
    try {
        existing = JSON.parse(fs.readFileSync(TOKEN_INFO_OVERLAY, 'utf8'));
    } catch { /* Datei existiert noch nicht — erster Premium-Pool-Adopt */ }
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
function registerTokensIfMissing(offer) {
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

const router = Router();

router.get('/liquidity/pool-offers', async (_req, res) => {
    try {
        const offers = loadOffersRaw();
        const localPools = loadLocalPools();
        const localPoolIds = localPools.map(p => p.id);
        const results = await validatePoolOffers(offers, { localPoolIds });

        const byId = new Map(offers.map(o => [o.id, o]));
        const merged = results.map(r => {
            const offer = byId.get(r.id) ?? {};
            return {
                id: r.id,
                // Ein zurückgestufter Pool ist nie übernehmbar — unabhängig davon, wie
                // sauber er sich gegen die Chain prüfen lässt. Die Chain-Prüfung sagt
                // „dieser Pool existiert wie beschrieben", nicht „der Datendienst steht
                // noch dahinter".
                status: isRetired(offer) ? 'retired' : r.status,
                retired: isRetired(offer),
                retiredReason: offer.lifecycle?.reason ?? null,
                acceptedException: r.acceptedException,
                acceptedReason: r.acceptedReason,
                checks: r.checks,
                mismatches: r.mismatches,
                unprovable: r.unprovable,
                alreadyKnown: localPoolIds.includes(r.id),
                display: {
                    pair: offer.pair ?? null,
                    displayPair: offer.displayPair ?? offer.pair ?? null,
                    address: offer.address ?? null,
                    protocol: offer.protocol ?? null,
                    tokenInfo: offer.tokenInfo ?? {},
                },
            };
        });

        res.json({ offers: merged });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/liquidity/pool-offers/:offerId/adopt', async (req, res) => {
    try {
        const offers = loadOffersRaw();
        const offer = offers.find(o => o.id === req.params.offerId);
        if (!offer) {
            return res.status(404).json({ error: t('api.offers.not_available') });
        }

        const localPools = loadLocalPools();
        if (localPools.some(p => p.id === offer.id)) {
            return res.status(409).json({ error: t('api.offers.pool_known') });
        }
        if (isRetired(offer)) {
            return res.status(422).json({
                error: t('api.offers.retired'),
                reason: offer.lifecycle?.reason ?? null,
            });
        }

        const result = await validatePoolOffer(offer, { localPoolIds: localPools.map(p => p.id) });
        if (result.status !== 'verified') {
            return res.status(422).json({
                error: t('api.offers.not_verified', { status: result.status }),
                result,
            });
        }

        const newPoolEntry = {
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
            // Herkunftsnachweis. Nur Pools mit diesem Marker unterliegen später dem
            // automatischen Exit bei Rückstufung und den Offer-Updates
            // (bots/liquidity/lib/pool-offer-sync.js). Ein von Hand angelegter Pool —
            // etwa ein Referenzpool — bleibt dadurch garantiert unangetastet, auch wenn
            // er in keiner Angebotsliste auftaucht.
            //
            // Steht bewusst hier in pools.json und NICHT in settings.db pool_settings:
            // setPoolActive(id,false) löscht dort die ganze Zeile des Pools (lib/config.js),
            // die Herkunft würde also ausgerechnet beim Deaktivieren verschwinden.
            premiumOffer: {
                offerId: offer.id,
                adoptedAt: Date.now(),
            },
            // Nicht verhandelbar (pool-offers.md „Der gefährlichste Fehler: enabled weglassen"):
            // beide Sperren EXPLIZIT, nie implizit über ein fehlendes Feld.
            enabled: false,
            active: false,
        };

        writePoolsJsonAtomic([...localPools, newPoolEntry]);

        // Zweite, unabhängige Sperre gegen den Ranking-Cleanup.
        const db = openSettingsDb();
        try {
            const row = db.prepare(`SELECT settings FROM pool_settings WHERE bot_id = ? AND pool_id = ?`).get(BOT_ID, offer.id);
            const settings = row ? JSON.parse(row.settings) : {};
            settings.cleanup = { ...(settings.cleanup ?? {}), rankingEligible: false };
            db.prepare(`
                INSERT INTO pool_settings (bot_id, pool_id, settings) VALUES (?, ?, ?)
                ON CONFLICT(bot_id, pool_id) DO UPDATE SET settings = excluded.settings
            `).run(BOT_ID, offer.id, JSON.stringify(settings));
        } finally {
            db.close();
        }

        mergeTokenInfoOverlay(offer.tokenInfo);
        registerTokensIfMissing(offer);

        res.json({ ok: true, pool: newPoolEntry });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
