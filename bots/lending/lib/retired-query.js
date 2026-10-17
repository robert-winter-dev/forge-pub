/**
 * Abfrage-Entscheidung für ausgelaufene Pools (LEN#001365).
 *
 * Ein ausgelaufener Pool wird nur abgefragt, solange dort Guthaben liegt. Ob Guthaben
 * da ist, weiß nur das Protokoll selbst: die Tabelle `positions` führt es nicht
 * verlässlich (ein still geschlossener Eintrag war der Loopscale-Vorfall vom August,
 * siehe loopscale-vault-illiquiditaet.md in der Projektdokumentation). Deshalb:
 *
 *   1. offene DB-Position            → abfragen
 *   2. zuletzt gemeldetes Guthaben   → abfragen (kv `retired_position:<pool>`)
 *   3. seit Prozessstart ungeprüft   → EINE Positionsabfrage, Ergebnis nach kv
 *   4. sonst                         → nicht abfragen
 *
 * Schritt 3 läuft einmal je Bot-Start und Pool. Scheitert die Abfrage, gilt der Pool
 * weiter als ungeprüft und der nächste Tick versucht es erneut. Ein Fehler darf nie als
 * "kein Guthaben" gelesen werden.
 *
 * Abhängigkeiten werden übergeben, damit der Ablauf ohne Bot, DB und Nexus testbar ist
 * (bin/bot.js startet beim Import seine main()).
 */

import { isRetired as registryIsRetired } from '../../../lib/lending-pools.js';

export const kvKeyRetiredPosition = name => `retired_position:${name}`;

/**
 * @param {object} deps
 * @param {(key: string) => (string|null)} deps.kvGet
 * @param {(key: string, value: string) => void} deps.kvSet
 * @param {() => Set<string>} deps.activeDbProtocols   Pools mit offener DB-Position
 * @param {number} deps.dustUsdc
 * @param {(msg: string) => void} deps.log
 * @param {(id: string) => boolean} [deps.isRetired]   Vorgabe: Pool-Register
 */
export function createRetiredQueryGate(deps) {
    const { kvGet, kvSet, activeDbProtocols, dustUsdc, log } = deps;
    const isRetired = deps.isRetired ?? registryIsRetired;
    const probed = new Set();

    function lastKnownAmount(name) {
        const n = parseFloat(kvGet(kvKeyRetiredPosition(name)) ?? '');
        return Number.isFinite(n) ? n : 0;
    }

    /** Vom Tick aufzurufen, sobald das Protokoll einen Positionswert geliefert hat. */
    function notePosition(name, amount) {
        if (!isRetired(name)) return;
        probed.add(name);
        kvSet(kvKeyRetiredPosition(name), String(amount > 0 ? amount : 0));
    }

    /**
     * @param {{name: string, label: string, getPosition: (wallet: string) => Promise<{amount: number}|null>}} proto
     * @param {string} walletAddress
     * @returns {Promise<boolean>} true = in diesem Tick abfragen
     */
    async function shouldQuery(proto, walletAddress) {
        if (!isRetired(proto.name)) return true;
        if (activeDbProtocols().has(proto.name)) return true;
        if (lastKnownAmount(proto.name) >= dustUsdc) return true;
        if (probed.has(proto.name)) return false;

        try {
            const pos = await proto.getPosition(walletAddress);
            const amount = pos?.amount ?? 0;
            notePosition(proto.name, amount);
            if (amount >= dustUsdc) {
                log(`${proto.label}: ausgelaufen, aber ${amount.toFixed(2)} USDC Guthaben gefunden, Pool bleibt abgefragt`);
                return true;
            }
            log(`${proto.label}: ausgelaufen, kein Guthaben, wird nicht mehr abgefragt`);
            return false;
        } catch (err) {
            log(`${proto.label}: Guthaben-Prüfung gescheitert (${err.message}), nächster Tick prüft erneut`);
            return false;
        }
    }

    /** Filtert die Pools, die dieser Tick abfragt. */
    async function select(protocols, walletAddress) {
        const out = [];
        for (const proto of protocols) {
            if (await shouldQuery(proto, walletAddress)) out.push(proto);
        }
        return out;
    }

    return { shouldQuery, select, notePosition };
}
