/**
 * Tägliche Auszahlungsempfehlung für ausgelaufene Pools (LEN#001352, LEN#001365;
 * Zustand `ausgelaufen` im Pool-Register, lib/lending-pools.js).
 *
 * Höchstens eine Meldung je Pool und Kalendertag. Der Tag steht in kv_config, damit
 * ein Neustart nicht erneut meldet. Nur bei Position ab `dustUsdc`: wer nichts mehr im
 * Pool hat, hört nichts. Abhängigkeiten werden übergeben, damit der Ablauf ohne Bot,
 * DB und Nexus testbar ist (bin/bot.js startet beim Import seine main()).
 */

import { isRetired as registryIsRetired } from '../../../lib/lending-pools.js';

/**
 * @param {{name: string, label: string}} proto
 * @param {number} amount        aktuelle Position in USDC
 * @param {object} deps
 * @param {(key: string) => (string|null)} deps.kvGet
 * @param {(key: string, value: string) => void} deps.kvSet
 * @param {() => string} deps.today                   YYYY-MM-DD in FORGE_TZ
 * @param {(pool: string, amount: string) => Promise<void>} deps.send   Telegram/Nexus
 * @param {(entry: object) => void} deps.addNotification               Dashboard-Glocke
 * @param {(n: number) => string} deps.fmt
 * @param {(msg: string) => void} deps.log
 * @param {number} deps.dustUsdc
 * @param {(id: string) => boolean} [deps.isRetired]   Vorgabe: Pool-Register
 * @returns {Promise<boolean>} true, wenn gemeldet wurde
 */
export async function adviseRetiredPoolOncePerDay(proto, amount, deps) {
    const { kvGet, kvSet, today, send, addNotification, fmt, log, dustUsdc } = deps;
    const isRetired = deps.isRetired ?? registryIsRetired;
    if (!isRetired(proto.name) || !(amount >= dustUsdc)) return false;

    const key = `retired_advice:${proto.name}`;
    const day = today();
    if (kvGet(key) === day) return false;

    // Zuerst merken: scheitert der Versand, gibt es heute keine Wiederholung im Stundentakt.
    kvSet(key, day);
    log(`⚠ ${proto.label}: keine Einzahlungen mehr, Auszahlung empfohlen (${fmt(amount)} USDC)`);
    await send(proto.label, fmt(amount));
    addNotification({
        level: 'warn', msgKey: 'notify.len.pool_retired_short',
        params: { pool: proto.label, amount: fmt(amount) },
    });
    return true;
}
