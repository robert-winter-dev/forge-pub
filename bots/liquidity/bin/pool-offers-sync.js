#!/usr/bin/env node
/**
 * FORGE public Premium – Offer-Updates für bereits übernommene Pools
 *
 * Produktentscheidung 2026-07-29 (pool-offers.md): ändert der Master Angaben zu einem
 * Pool, den dieser Fork bereits übernommen hat (Pool-Typ korrigiert, TVL-Schwellen
 * nachgezogen …), übernimmt der Fork das automatisch — ohne erneute Freigabe, aber mit
 * einer System-Message, die jede Änderung im Klartext alt → neu benennt.
 *
 * Läuft als Cron (config/cron-jobs.json). Der Gegenpart — die Rückstufung mit
 * Kapital-Exit — sitzt bewusst NICHT hier, sondern im Bot-Zyklus
 * (lib/pool-retirement.js): er bewegt Kapital und braucht den Cleanup-Lock.
 *
 * Was hier NIEMALS passiert:
 *   • Kein neuer Pool. Übernahme bleibt eine ausdrückliche Nutzeraktion über die UI.
 *   • Kein Betriebszustand (enabled/active/capitalUSDC) — nie aus Lieferdaten.
 *   • Keine nutzer-autoritativen Werte. Geändert wird ausschließlich die Vorschlags-
 *     ebene in pools.json; was der Nutzer im Risk-Management selbst gesetzt hat
 *     (settings.db `pool_settings`) hat Vorrang und bleibt unberührt.
 *   • Keine Identitätsfelder. Weicht Adresse/Mint/Fee-Tier ab, ist es ein anderer Pool
 *     unter bekannter ID → Alarm, keine Übernahme.
 *
 * Jedes Offer wird vor der Übernahme erneut gegen die Chain geprüft (derselbe
 * Validator wie beim Erst-Ingest) — „die Lieferung ist eine Behauptung, die Chain ist
 * die Wahrheit" gilt für Updates genauso wie für Neu-Übernahmen.
 *
 *   node bin/pool-offers-sync.js [--dry-run] [--json]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../lib/config.js';
import { openDatabase, getOpenPosition, recordOfferUpdate } from '../lib/db.js';
import { loadPoolOffers } from '../lib/premium-offers-store.js';
import { assessDelivery, isAdoptedFromOffer, diffOfferUpdates, checkIdentity } from '../lib/pool-offer-sync.js';
import { validatePoolOffer } from '../lib/pool-offers-validator.js';
import * as notify from '../lib/notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POOLS_JSON = path.resolve(__dirname, '../config/pools.json');
const TOKEN_INFO_OVERLAY = path.resolve(__dirname, '../../../html/liquidity/data/premium/token-info.json');

const dryRun = process.argv.includes('--dry-run');
const jsonOutput = process.argv.includes('--json');

function loadPoolsJson() {
    const raw = JSON.parse(fs.readFileSync(POOLS_JSON, 'utf8'));
    return Array.isArray(raw) ? raw : (raw.pools ?? []);
}

/** Atomar (temp + rename) — der Bot liest die Datei zu Beginn jedes Zyklus neu. */
function writePoolsJsonAtomic(pools) {
    const tmp = `${POOLS_JSON}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(pools, null, 2));
    fs.renameSync(tmp, POOLS_JSON);
}

function mergeTokenInfoOverlay(tokenInfo) {
    if (!tokenInfo || Object.keys(tokenInfo).length === 0) return;
    let existing = { tokens: {} };
    try {
        existing = JSON.parse(fs.readFileSync(TOKEN_INFO_OVERLAY, 'utf8'));
    } catch { /* noch kein Overlay vorhanden */ }
    existing.tokens = { ...(existing.tokens ?? {}), ...tokenInfo };
    fs.mkdirSync(path.dirname(TOKEN_INFO_OVERLAY), { recursive: true });
    fs.writeFileSync(TOKEN_INFO_OVERLAY, JSON.stringify(existing));
}

const { offers, meta } = loadPoolOffers();
const delivery = assessDelivery(meta);
const results = [];

if (!delivery.usable) {
    const msg = `[pool-offers-sync] Lieferung nicht auswertbar (${delivery.reason}) – nichts zu tun.`;
    console.log(jsonOutput ? JSON.stringify({ skipped: delivery.reason, results: [] }, null, 2) : msg);
    process.exit(0);
}

const offerById = new Map(offers.map(o => [o.id, o]));
const db = openDatabase();
let pools = loadPoolsJson();
const localPoolIds = pools.map(p => p.id);
let dirty = false;

try {
    for (const pool of pools) {
        if (!isAdoptedFromOffer(pool)) continue;

        const offer = offerById.get(pool.premiumOffer.offerId);
        // Fehlt das Offer, ist das eine Rückstufungs-Frage — die entscheidet der
        // Bot-Zyklus (lib/pool-retirement.js), nicht dieses Update-Skript.
        if (!offer || offer.lifecycle?.status === 'retired') continue;

        const identity = checkIdentity(pool, offer);
        if (identity.length > 0) {
            console.error(`[pool-offers-sync:${pool.id}] Identitätsbruch – nichts übernommen: ${JSON.stringify(identity)}`);
            await notify.premiumPoolIdentityMismatch(pool, identity).catch(() => {});
            results.push({ poolId: pool.id, status: 'identity-mismatch', changes: identity });
            continue;
        }

        const hasPosition = !!getOpenPosition(db, pool.id);
        const { applicable, deferred } = diffOfferUpdates(pool, offer, hasPosition);
        if (applicable.length === 0) {
            if (deferred.length > 0) {
                console.log(`[pool-offers-sync:${pool.id}] ${deferred.length} Strukturänderung(en) aufgeschoben (Kapital im Pool)`);
            }
            continue;
        }

        // Erst jetzt (es gibt wirklich etwas zu tun) die teure Chain-Prüfung.
        const validation = await validatePoolOffer(offer, { localPoolIds });
        if (validation.status !== 'verified') {
            console.error(`[pool-offers-sync:${pool.id}] Offer nicht verifiziert (${validation.status}) – Update verworfen`);
            results.push({ poolId: pool.id, status: `not-verified:${validation.status}` });
            continue;
        }

        for (const change of applicable) pool[change.field] = change.to;
        dirty = true;
        results.push({ poolId: pool.id, status: 'updated', applied: applicable, deferred });

        if (!dryRun) {
            mergeTokenInfoOverlay(offer.tokenInfo);
            recordOfferUpdate(db, pool.id, meta?.sequence);
            await notify.premiumPoolUpdated(pool, { applied: applicable, deferred }).catch(() => {});
        }
        console.log(`[pool-offers-sync:${pool.id}] ${applicable.length} Feld(er) aktualisiert: `
            + applicable.map(c => `${c.field} ${c.from} → ${c.to}`).join(', '));
    }

    if (dirty && !dryRun) writePoolsJsonAtomic(pools);
} finally {
    db.close();
}

if (jsonOutput) {
    console.log(JSON.stringify({ dryRun, updated: results.length, results }, null, 2));
} else if (results.length === 0) {
    console.log('[pool-offers-sync] keine Änderungen.');
} else if (dryRun) {
    console.log(`[pool-offers-sync] --dry-run: ${results.length} Pool(s) hätten Änderungen bekommen, nichts geschrieben.`);
}
