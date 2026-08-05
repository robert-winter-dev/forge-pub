/**
 * FORGE.pub Premium – Ablage der gelieferten Pool-Offers (Klasse C)
 *
 * Eine einzige Lesestelle für `data/premium/pool-offers.json`, damit Validator,
 * Übernahme-UI, Offer-Update-Sync und Retirement-Erkennung nicht je eigene
 * Datei-Parser mit je eigenen Sonderfällen haben.
 *
 * Dateiformat (seit 2026-07-29):
 *     { "meta": { generatedAt, sequence, complete, count }, "offers": [ … ] }
 *
 * Ältere Forks haben dort ein nacktes Array liegen (die Ablage aus dem ersten
 * Klasse-C-Schritt). Das wird weiterhin gelesen und als `meta: null` normalisiert —
 * ohne Meta gilt die Liste als „Vollständigkeit unbekannt", was jede Auto-Exit-
 * Entscheidung bewusst blockiert (siehe pool-offer-sync.js).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PATHS } from '../../../config/paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const POOL_OFFERS_PATH = path.join(PATHS.liquidityData, 'premium', 'pool-offers.json');

/**
 * @param {string} [offersPath]
 * @returns {{ offers: object[], meta: {generatedAt?:string, sequence?:number, complete?:boolean, count?:number}|null }}
 */
export function loadPoolOffers(offersPath = POOL_OFFERS_PATH) {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(offersPath, 'utf8'));
    } catch {
        // Premium nie geliefert / Datei unlesbar → leere Liste, kein Fehler. Aufrufer
        // unterscheiden „keine Offers" über `meta === null` von einer echten leeren Liste.
        return { offers: [], meta: null };
    }
    if (Array.isArray(raw)) return { offers: raw, meta: null };
    return {
        offers: Array.isArray(raw?.offers) ? raw.offers : [],
        meta: raw?.meta ?? null,
    };
}

/** Schreibt die normalisierte Form (nur der Ingest ruft das auf). */
export function writePoolOffers(offersPath, offers, meta) {
    fs.mkdirSync(path.dirname(offersPath), { recursive: true });
    fs.writeFileSync(offersPath, JSON.stringify({ meta: meta ?? null, offers }));
}

/** Ein Offer ist übernehmbar/gültig nur solange der Master ihn nicht zurückgestuft hat. */
export function isRetired(offer) {
    return offer?.lifecycle?.status === 'retired';
}
