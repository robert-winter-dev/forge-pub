/**
 * FORGE – Nostr-Verbindungs-Statistik
 *
 * Reiner Beobachter: fragt periodisch den öffentlichen `relay.connected`-Zustand von
 * nostr-tools ab und schreibt Zustandswechsel (verbunden/getrennt) in die DB. Kein
 * Eingriff in nostr-tools-Interna (kein Monkeypatch) — robust gegen Lib-Updates.
 *
 * Hintergrund (Fund 2026-07-28): `forge-premium` verlor auf forge-pub1 lautlos die
 * Relay-Verbindung (>1h ohne jede DM, kein Fehler im Log) — SimplePool hat
 * enableReconnect/enablePing standardmäßig AUS (nostr-tools-Default), ein harter
 * Verbindungsabbruch wurde also nie automatisch geheilt. Fix dafür: lib/nostr-client.js
 * aktiviert beide Optionen jetzt beim Pool-Erzeugen. Dieses Modul liefert zusätzlich
 * echte Uptime-/Reconnect-Statistik als Nebeneffekt (nützlich für Auswertungen).
 */

import Database from 'better-sqlite3';
import { PATHS } from '../config/paths.js';

function openDb(dbPath) {
    const db = new Database(dbPath);
    db.exec(`
        CREATE TABLE IF NOT EXISTS nostr_relay_events (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            relay_url TEXT    NOT NULL,
            event     TEXT    NOT NULL,   -- 'connected' | 'disconnected'
            at        INTEGER NOT NULL    -- Unix-Timestamp (ms)
        );
        CREATE INDEX IF NOT EXISTS idx_nostr_relay_events_url_at ON nostr_relay_events(relay_url, at);
    `);
    return db;
}

function normalize(url) {
    return url.replace(/\/+$/, '');
}

/**
 * Startet den Polling-Monitor. Schreibt beim ersten Poll den initialen Zustand jedes
 * Relays, danach nur noch echte Wechsel (kein Zeilen-Spam bei stabiler Verbindung).
 *
 * @param {import('nostr-tools').SimplePool} pool
 * @param {string[]} relayUrls
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 * @param {number} [opts.intervalMs] - Default 30000 (unter pingFrequency von nostr-tools, 29s).
 * @returns {() => void} Stop-Funktion (clearInterval + DB schließen).
 */
export function startConnectionMonitor(pool, relayUrls, { dbPath = PATHS.premiumDb, intervalMs = 30_000 } = {}) {
    const db = openDb(dbPath);
    const insert = db.prepare(`INSERT INTO nostr_relay_events (relay_url, event, at) VALUES (?, ?, ?)`);
    const normalizedUrls = relayUrls.map(normalize);
    const lastState = new Map();

    function poll() {
        const now = Date.now();
        for (const url of normalizedUrls) {
            let connected = false;
            for (const [poolUrl, relay] of pool.relays) {
                if (normalize(poolUrl) === url) { connected = !!relay.connected; break; }
            }
            const prev = lastState.get(url);
            if (prev === connected) continue;
            lastState.set(url, connected);
            insert.run(url, connected ? 'connected' : 'disconnected', now);
        }
    }

    poll();
    const handle = setInterval(poll, intervalMs);
    return () => { clearInterval(handle); db.close(); };
}

/**
 * Aggregierte Verbindungsstatistik je Relay seit dem ersten beobachteten Event:
 * Uptime/Downtime in ms, Uptime-%, Anzahl Verbindungsabbrüche, aktueller Zustand.
 *
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 * @returns {Record<string, {observedSince:number, disconnectCount:number, uptimeMs:number, downtimeMs:number, uptimePct:number|null, currentlyConnected:boolean}>}
 */
export function getConnectionStats({ dbPath = PATHS.premiumDb } = {}) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        const urls = db.prepare(`SELECT DISTINCT relay_url FROM nostr_relay_events`).all().map(r => r.relay_url);
        const stats = {};
        for (const url of urls) {
            const rows = db.prepare(
                `SELECT event, at FROM nostr_relay_events WHERE relay_url = ? ORDER BY at ASC`
            ).all(url);
            if (rows.length === 0) continue;

            let uptimeMs = 0, downtimeMs = 0, disconnectCount = 0;
            let lastAt = rows[0].at;
            let lastState = rows[0].event;

            for (let i = 1; i < rows.length; i++) {
                const dur = rows[i].at - lastAt;
                if (lastState === 'connected') uptimeMs += dur; else downtimeMs += dur;
                if (rows[i].event === 'disconnected') disconnectCount++;
                lastState = rows[i].event;
                lastAt = rows[i].at;
            }
            const tailDur = Date.now() - lastAt;
            if (lastState === 'connected') uptimeMs += tailDur; else downtimeMs += tailDur;

            const totalMs = uptimeMs + downtimeMs;
            stats[url] = {
                observedSince: rows[0].at,
                disconnectCount,
                uptimeMs,
                downtimeMs,
                uptimePct: totalMs > 0 ? +(uptimeMs / totalMs * 100).toFixed(2) : null,
                currentlyConnected: lastState === 'connected',
            };
        }
        return stats;
    } finally {
        db.close();
    }
}

/** Selbsttest gegen eine temporäre DB mit einem simulierten Pool-Objekt (kein echtes Netzwerk). */
export async function selfTest() {
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const fs = await import('fs');
    const { randomBytes } = await import('crypto');
    const dbPath = join(tmpdir(), `nostr-stats-selftest-${randomBytes(4).toString('hex')}.db`);
    const failures = [];

    const fakeRelay = { connected: true };
    const fakePool = { relays: new Map([['wss://relay.test/', fakeRelay]]) };

    try {
        const stop = startConnectionMonitor(fakePool, ['wss://relay.test/'], { dbPath, intervalMs: 50 });

        await new Promise(r => setTimeout(r, 120));
        fakeRelay.connected = false;
        await new Promise(r => setTimeout(r, 120));
        fakeRelay.connected = true;
        await new Promise(r => setTimeout(r, 120));
        stop();

        const stats = getConnectionStats({ dbPath });
        const s = stats['wss://relay.test'];
        if (!s) failures.push('keine Statistik für das simulierte Relay gefunden');
        else {
            if (s.disconnectCount < 1) failures.push(`erwartete mindestens 1 disconnectCount, bekam ${s.disconnectCount}`);
            if (!s.currentlyConnected) failures.push('currentlyConnected sollte true sein (Relay am Ende wieder verbunden)');
            if (s.uptimeMs <= 0 || s.downtimeMs <= 0) failures.push('erwartete sowohl uptimeMs als auch downtimeMs > 0');
        }
    } catch (err) {
        failures.push(`Ausnahme: ${err.message}`);
    } finally {
        fs.rmSync(dbPath, { force: true });
    }

    return { ok: failures.length === 0, failures };
}
