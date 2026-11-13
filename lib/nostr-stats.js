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

/** Live-Zustand eines Relays direkt aus dem Pool (gleiche Quelle wie der Watchdog). */
function lookupConnected(pool, url) {
    for (const [poolUrl, relay] of pool.relays) {
        if (normalize(poolUrl) === url) return !!relay.connected;
    }
    return false;
}

// Letzter laufender Monitor in diesem Prozess: /nostr/stats legt den Live-Zustand darüber,
// damit ein hängender Poller (CORE#001966) keinen Fehlalarm "alle getrennt" mehr auslöst.
let activeMonitor = null;

/**
 * Live-Zustand je Relay (URL ohne Schlusszeichen "/") und Alter des letzten Poll-Laufs,
 * oder null, wenn in diesem Prozess kein Monitor läuft.
 */
export function getLiveConnection() {
    if (!activeMonitor) return null;
    const relays = {};
    for (const url of activeMonitor.urls) relays[url] = lookupConnected(activeMonitor.pool, url);
    return { relays, pollAgeMs: Date.now() - activeMonitor.lastPollAt };
}

/**
 * Startet den Polling-Monitor. Schreibt beim ersten Poll den initialen Zustand jedes
 * Relays, danach nur noch echte Wechsel (kein Zeilen-Spam bei stabiler Verbindung).
 * Jeder Wechsel steht zusätzlich im Journal (`nostr-stats: relay <url> verbunden|getrennt`).
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
    const monitor = { pool, urls: normalizedUrls, lastPollAt: Date.now() };

    function poll() {
        monitor.lastPollAt = Date.now();
        const now = monitor.lastPollAt;
        for (const url of normalizedUrls) {
            const connected = lookupConnected(pool, url);
            if (lastState.get(url) === connected) continue;
            // lastState erst NACH erfolgreichem Insert nachziehen: scheitert der Insert
            // (z.B. SQLITE_BUSY), bleibt der Wechsel offen und wird im nächsten Lauf
            // wiederholt. Vorher blieb die Tabelle für immer auf dem alten Zustand
            // stehen (CORE#001966).
            try {
                insert.run(url, connected ? 'connected' : 'disconnected', now);
            } catch (err) {
                console.warn(`nostr-stats: Zustand von relay ${url} nicht gespeichert (${err.message}), neuer Versuch im nächsten Lauf.`);
                continue;
            }
            const first = !lastState.has(url);
            lastState.set(url, connected);
            if (!first) console.log(`nostr-stats: relay ${url} ${connected ? 'verbunden' : 'getrennt'}`);
        }
    }

    poll();
    const handle = setInterval(poll, intervalMs);
    activeMonitor = monitor;
    return () => {
        clearInterval(handle);
        if (activeMonitor === monitor) activeMonitor = null;
        db.close();
    };
}

/**
 * Aggregierte Verbindungsstatistik je Relay seit dem ersten beobachteten Event:
 * Uptime/Downtime in ms, Uptime-%, Anzahl Verbindungsabbrüche, aktueller Zustand.
 *
 * @param {object} [opts]
 * @param {string} [opts.dbPath]
 * @param {Record<string, boolean>} [opts.live] - Live-Zustand aus dem Pool (siehe getLiveConnection);
 *   überstimmt `currentlyConnected` aus der Tabelle, `dbConnected` behält den Tabellenwert.
 * @returns {Record<string, {observedSince:number, disconnectCount:number, uptimeMs:number, downtimeMs:number, uptimePct:number|null, currentlyConnected:boolean}>}
 */
export function getConnectionStats({ dbPath = PATHS.premiumDb, live = null } = {}) {
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
            if (live && typeof live[url] === 'boolean') {
                stats[url].dbConnected = stats[url].currentlyConnected;
                stats[url].currentlyConnected = live[url];
            }
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
