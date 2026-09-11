/**
 * /api/strategy – Strategie-Auswahl (LIQ#0372, Baustein C — die HTTP-Schicht)
 *
 * Dünne Routen um das fertige Backend (lib/strategies.js,
 * bots/settings/lib/strategy-apply.js). Keine eigene Logik, keine Duplikate.
 *
 * GET  /api/strategy                     → die 4 Strategien (Metadaten für die Select-Box,
 *                                          inkl. `distribution` — LIQ#0373, gemessene
 *                                          Verteilung neben dem Namen)
 * GET  /api/strategy/status              → aktive Strategie (getActiveStrategy)
 * POST /api/strategy/standard/preview    → Probelauf der Rücknahme (switchToStandard
 *                                          dryRun:true) — LIQ#0384, dient der
 *                                          Bestätigungsansicht vorm Wechsel auf "Standard".
 *                                          🔒 Muss VOR /:id/preview registriert sein, sonst
 *                                          fängt dessen `:id`-Platzhalter "standard" ab.
 * POST /api/strategy/standard            → wirklich auf "Standard" wechseln (switchToStandard
 *                                          dryRun:false) — nimmt den Feldsatz der bisherigen
 *                                          Strategie zurück, siehe Entscheidung 8
 *                                          (präzisiert 04.09.2026) und LIQ#0384
 * POST /api/strategy/:id/preview         → Probelauf (applyStrategy dryRun:true) — dient
 *                                          sowohl der Anzeige "Was diese Strategie tut" als
 *                                          auch der Bestätigungsansicht vorm Anwenden
 * GET  /api/strategy/:id/deviations      → Abweichungen gegen eine Strategie (deviations)
 * POST /api/strategy/:id/apply           → wirklich schreiben (applyStrategy dryRun:false,
 *                                          setzt intern auch die aktive Strategie) — LIQ#0389:
 *                                          einzige Route mit Berechtigungs-Gate, s.
 *                                          premiumGateError() unten.
 *
 * 🔒 LIQ#0389 — warum nur /:id/apply gesperrt ist, sonst keine Route:
 *   - /standard(/preview) NICHT gesperrt: nimmt nur Felder zurück, schreibt nichts Neues
 *     auf Live-Kapital. Ein Nutzer ohne Premium muss seine Strategie loswerden können,
 *     sonst käme er da nur noch über den 72h-Nachlauf (Entscheidung 6) wieder raus.
 *   - /:id/preview und /:id/deviations NICHT gesperrt: reine dryRun-/Lesevorgänge, die nur
 *     das Detail-Modal ("Was tut diese Strategie") speisen. Ein Gate dort würde die
 *     Anzeige für nicht berechtigte Nutzer kaputtmachen statt nur das Anwenden zu
 *     verhindern.
 */

import { Router } from 'express';
import { STRATEGIES, getStrategy, distributionForStrategy } from '../../../lib/strategies.js';
import {
    applyStrategy, deviations, getActiveStrategy, switchToStandard,
} from '../lib/strategy-apply.js';
import { openDb } from './pools.js';
import { t } from '../../../lib/i18n.js';
import { isForkInstance } from '../../../lib/premium-identity-context.js';
import { hasPremiumEntitlement } from '../../../lib/premium-entitlement.js';

const router = Router();

/**
 * Gate fürs Anwenden einer Strategie (LIQ#0389). Exportiert, damit der Test sie direkt
 * aufrufen kann, ohne HTTP oder applyStrategy() (Live-Schreibvorgang) auszulösen.
 *
 * Dasselbe zweistufige Muster wie rollbackStrategyOnPremiumLoss()
 * (bots/settings/lib/strategy-apply.js): erst isForkInstance() — der Master ist Urheber
 * der Strategien, ein Gate gegen sich selbst wäre sinnlos und hätte ihn bei LIQ#0381
 * bereits einmal ausgesperrt. Erst danach hasPremiumEntitlement() als einzige Quelle für
 * die Berechtigung (LIQ#0388) — kein zweiter Kriteriensatz.
 *
 * @returns {string|null} Fehlertext oder null, wenn die Route durchgelassen wird.
 */
export function premiumGateError() {
    if (!isForkInstance()) return null;
    return hasPremiumEntitlement().entitled ? null : t('api.strategy.premium_required');
}

router.get('/', (_req, res) => {
    res.json(STRATEGIES.map(s => ({
        id:                        s.id,
        notRecommended:            s.notRecommended === true,
        rangeStepOffset:           s.rangeStepOffset ?? 0,
        rangeStepOffsetConfidence: s.rangeStepOffsetConfidence ?? null,
        // LIQ#0383: Deklaration, kein Feldsatz-Eintrag — s. lib/strategies.js,
        // trendGateForPool(). `null` gäbe es hier nicht (jede Strategie deklariert
        // mindestens `[]`), aber defensiv mitgeführt, falls eine fünfte einmal keinen
        // Wert nennt.
        trendGate:           s.trendGate ?? null,
        trendGateConfidence: s.trendGateConfidence ?? null,
        // LIQ#0373: Entscheidung 1, zweite Hälfte — Master-Daten, siehe lib/strategies.js.
        distribution:              distributionForStrategy(s),
        // LIQ#0385: Klartext für den "Funktionsweise"-Tab — die UI ersetzt via i18n-Key
        // `sliq.strategy_summary_<id>`, dieser Wert ist nur der Fallback.
        summary:                   s.summary ?? null,
    })));
});

router.get('/status', (_req, res) => {
    const db = openDb();
    try {
        res.json(getActiveStrategy(db));
    } finally { db.close(); }
});

// 🔒 Reihenfolge ist hier keine Kosmetik: Express matcht `/:id/preview` auch gegen
// `/standard/preview` (id='standard') — registriert vor den beiden `/standard`-Routen
// unten würde jeder Aufruf dort in `getStrategy('standard') → 404` laufen, die
// switchToStandard()-Routen nie erreicht. Deshalb stehen die spezifischeren
// `/standard`-Routen vor den generischen `/:id/...`-Routen.
router.post('/standard/preview', (_req, res) => {
    try {
        res.json(switchToStandard({ dryRun: true }));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/standard', (_req, res) => {
    try {
        res.json(switchToStandard({ dryRun: false }));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/preview', (req, res) => {
    if (!getStrategy(req.params.id)) {
        return res.status(404).json({ error: t('api.strategy.unknown', { id: req.params.id }) });
    }
    try {
        res.json(applyStrategy(req.params.id, { dryRun: true }));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/deviations', (req, res) => {
    // "standard" ist keine Strategie-ID (Entscheidung 8) — deviations() kennt sie nicht,
    // die Antwort ist aber trivial: kein Feldsatz, keine Abweichungen.
    if (req.params.id === 'standard') {
        return res.json({ strategyId: null, pools: [], total: 0 });
    }
    if (!getStrategy(req.params.id)) {
        return res.status(404).json({ error: t('api.strategy.unknown', { id: req.params.id }) });
    }
    try {
        res.json(deviations(req.params.id));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/apply', (req, res) => {
    if (!getStrategy(req.params.id)) {
        return res.status(404).json({ error: t('api.strategy.unknown', { id: req.params.id }) });
    }
    const gateError = premiumGateError();
    if (gateError) return res.status(403).json({ error: gateError });
    try {
        res.json(applyStrategy(req.params.id, { dryRun: false }));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
