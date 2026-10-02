/**
 * FORGE – Backend-Schalter = Zustand nach Reboot (CORE#001179)
 *
 * Der An/Aus-Schalter im Backend ist die einzige Stelle, an der ein Nutzer
 * Liquidity Bot und Lending Bot ein- oder ausschaltet. Ein reines
 * `systemctl start|stop` wirkt aber nur bis zum nächsten Reboot — danach
 * entscheidet der systemd-Autostart (`enabled`), den bis CORE#001179 nie
 * jemand außer einem Menschen per Hand gesetzt hat. Folge (pub2, 02.10.2026):
 * Ein im Backend nie gestarteter Lending Bot lief nach dem Update-Reboot mit
 * leerem Wallet los.
 *
 * Deshalb setzt der Daemon für die Bots den Autostart bei jedem Schalten mit:
 * start → start + enable, stop → stop + disable. restart bleibt transient.
 *
 * 🔒 Jede hier erzeugte Kommandozeile muss exakt so in der sudoers-Vorlage
 * stehen (bin/setup-lib/packages.sh, sudoers_content, BOT_SERVICES in
 * bin/setup.sh) — bot-autostart.test.js prüft genau das.
 */

import { getBotConfig } from '../../../lib/bot-registry.js';

/** Dienste, deren Autostart dem Backend-Schalter folgt. */
export const AUTOSTART_SERVICES = new Set([
    getBotConfig('liquidity').service,
    getBotConfig('lending').service,
]);

const AUTOSTART_FOLLOWS = { start: 'enable', stop: 'disable' };

/**
 * Liefert die systemctl-Aktionen, die für einen Backend-Task nacheinander
 * auszuführen sind, z.B. ['start', 'enable']. Die erste Aktion ist die
 * eigentliche, die zweite (falls vorhanden) zieht den Autostart nach.
 */
export function systemctlSteps(action, service) {
    const follow = AUTOSTART_SERVICES.has(service) ? AUTOSTART_FOLLOWS[action] : null;
    return follow ? [action, follow] : [action];
}
