/**
 * Score-Limit-Zustand für Bestands-Pools festschreiben (2026-08-15).
 *
 * Historisch: Bis dahin schaltete `ensureScoreLimitEnabled()` das Score Limit bei jeder
 * Pool-Aktivierung wieder ein — ein gespeichertes `false` bedeutete „seit dem letzten Exit
 * noch nicht wieder eingeschaltet", nicht „bewusst aus". Ab 2026-08-15 wird ein gespeichertes
 * `false` respektiert, weshalb der real wirksame Zustand einmalig festgeschrieben werden musste.
 *
 * 🔒 Abgelöst durch 0002: Am 2026-08-21 wurde der Default auf `aus` gedreht. Diese Migration
 * würde einen Zustand herstellen, den die nächste sofort wieder zurücknimmt — sie wird deshalb
 * nur verbucht, nie ausgeführt. Sie bleibt als Eintrag stehen, damit die Nummernfolge und die
 * Historie lückenlos bleiben.
 */
import { IMPACT_SAFE } from './runner.js';

export default {
    id:          '0001-scorelimit-enabled-restore',
    description: 'Score Limit für Bestands-Pools auf den damals wirksamen Zustand setzen',
    impact:      IMPACT_SAFE,
    superseded:     true,
    supersededNote: 'durch 0002 abgelöst (Default seit 2026-08-21 aus) — bewusst nicht ausgeführt',
    async plan() { return { pending: false, summary: 'abgelöst', details: [], warnings: [] }; },
    async up()   { return { changed: 0, summary: 'abgelöst, nichts ausgeführt' }; },
};
