/**
 * FORGE public Premium – Ablage der gelieferten Trailing-Stop-Empfehlungen (LIQ#0351)
 *
 * Eine einzige Schreibstelle für `data/premium/trailing-stop-advice.json`, damit der
 * Ingest nicht sein eigenes Dateiformat erfindet. Gelesen wird die Datei ausschließlich
 * von `lib/ts-advice-provider.js` — dort sitzt auch die Altersgrenze.
 *
 * Dateiformat:
 *     {
 *       "generatedAt": "2026-08-30T12:00:00.000Z",
 *       "meta": { generatedAt, sequence, computedTs } | null,
 *       "pools":     { "<poolId>":   { thresholdPct, thresholdPct2, episodes, reason } },
 *       "poolTypes": { "<poolType>": { thresholdPct, thresholdPct2, episodes, reason } }
 *     }
 *
 * `generatedAt` steht bewusst auf oberster Ebene: Der Provider prüft daran das Alter, und
 * er soll das tun können, ohne das Meta-Objekt zu kennen (das es bei einer künftigen
 * Formatänderung womöglich nicht mehr gibt).
 */

import fs from 'fs';
import path from 'path';
import { PATHS } from '../../../config/paths.js';

export const TS_ADVICE_PATH = path.join(PATHS.liquidityData, 'premium', 'trailing-stop-advice.json');

/**
 * Schreibt die gelieferten Empfehlungen (nur der Ingest ruft das auf).
 *
 * @param {{pools: Object, poolTypes: Object}} advice
 * @param {Object|null} meta        Begleitdaten des Masters
 * @param {string} generatedAt      Erzeugungszeit des Blobs (ISO)
 */
export function writeTsAdvice(advice, meta, generatedAt, advicePath = TS_ADVICE_PATH) {
    fs.mkdirSync(path.dirname(advicePath), { recursive: true });
    fs.writeFileSync(advicePath, JSON.stringify({
        generatedAt: generatedAt ?? new Date().toISOString(),
        meta:        meta ?? null,
        pools:       advice?.pools     ?? {},
        poolTypes:   advice?.poolTypes ?? {},
    }));
}

/**
 * Rohe Lesefunktion. Für die eigentliche Auflösung (Pool vor Pool-Typ, Altersgrenze)
 * `loadTsAdvice()` aus lib/ts-advice-provider.js verwenden — nicht diese hier.
 */
export function readTsAdvice(advicePath = TS_ADVICE_PATH) {
    try {
        return JSON.parse(fs.readFileSync(advicePath, 'utf8'));
    } catch {
        return null;
    }
}
