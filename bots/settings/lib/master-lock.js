/**
 * FORGE – Master-vs-Fork-Erkennung für gesperrte Einstellungen
 *
 * Sprache und Zeitzone gelten pro Installation (nicht pro Nutzer) und dürfen auf
 * dem FORGE Master nicht verstellt werden – andere Nostr-Clients (u.a. FORGE-public-
 * Forks) verlassen sich auf seine feste Identität/Konfiguration. Gleiches Muster
 * wie config/health-config.js:74 (IS_FORK) und core/premium/server.js
 * (IS_MASTER_IDENTITY/resetLocked): die Master-Identität "FORGE.Master" existiert
 * ausschließlich auf dem Master, ihre Anwesenheit ist ein robuster, pfadunabhängiger
 * Indikator.
 */

import { identityExists } from '../../../lib/nostr-client.js';

/** true auf dem FORGE Master (Einstellung gesperrt), false auf einem Fork. */
export function isMasterLocked() {
    return identityExists('FORGE.Master');
}
