/**
 * FORK side of the signed relay list (CORE#002022, KB Core/nostr-relay-pool, section
 * "Verteilung an die Forks"): asks the effective relays, the built-in relays and the
 * master's lookup relays for the master's relay list event, keeps the newest valid one
 * and stores it in the data directory. If the relays differ from the effective ones,
 * onApplied() is called (core/premium/server.js exits, systemd restarts it with the new
 * list via loadRelays()).
 *
 * Load: one REQ per relay per run on a short-lived pool, default every 30 minutes.
 */

import { SimplePool } from 'nostr-tools';
import { PATHS } from '../config/paths.js';
import {
    relayListFilter, pickNewestValid, decideUpdate, storedRelayListPath, writeStoredRelayList,
} from './nostr-relay-list.js';
import {
    MASTER_IDENTITY_NAME, identityExists, loadContacts, loadRelays, loadBuiltInRelays, loadStoredRelayList,
} from './nostr-client.js';

export const SYNC_INTERVAL_MS = 30 * 60 * 1000;
export const SYNC_INITIAL_DELAY_MS = 60 * 1000;
const QUERY_MAX_WAIT_MS = 10_000;

/**
 * One run. Returns { decision, relays?, createdAt?, asked } and never throws for
 * network problems (empty answer = 'ignore').
 */
export async function syncRelayListOnce({
    masterPubkeyHex,
    dataDir = PATHS.data,
    query = defaultQuery,
    now = Date.now(),
    loadStored = loadStoredRelayList,
    loadEffective = loadRelays,
    loadBuiltIn = loadBuiltInRelays,
} = {}) {
    const current = loadStored();
    const effective = loadEffective();
    const asked = [...new Set([...effective, ...loadBuiltIn(), ...(current?.lookup ?? [])])];

    let events = [];
    try {
        events = await query(asked, relayListFilter(masterPubkeyHex));
    } catch {
        events = [];
    }
    const candidate = pickNewestValid(events, masterPubkeyHex, Math.floor(now / 1000));
    const decision = decideUpdate(candidate, current, effective);
    if (decision !== 'ignore') writeStoredRelayList(storedRelayListPath(dataDir), candidate.event);
    return { decision, relays: candidate?.relays, createdAt: candidate?.createdAt, asked: asked.length };
}

async function defaultQuery(relays, filter) {
    const pool = new SimplePool();
    try {
        return await pool.querySync(relays, filter, { maxWait: QUERY_MAX_WAIT_MS });
    } finally {
        pool.destroy();
    }
}

/**
 * Starts the periodic sync on a fork. Returns null on the master (its config file is
 * the source) or when the master contact is missing.
 */
export function startRelayListSync({ onApplied, log = console, intervalMs = SYNC_INTERVAL_MS, initialDelayMs = SYNC_INITIAL_DELAY_MS } = {}) {
    if (identityExists(MASTER_IDENTITY_NAME)) return null;
    const master = loadContacts().find(c => c.id === 'forge-master');
    if (!master?.pubkeyHex) {
        log.warn('[relay-list] no master contact in config/nostr-contacts.json, relay list sync off');
        return null;
    }

    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            const r = await syncRelayListOnce({ masterPubkeyHex: master.pubkeyHex });
            if (r.decision === 'apply') {
                log.log(`[relay-list] new signed relay list from master (${new Date(r.createdAt * 1000).toISOString()}): ${r.relays.join(', ')}`);
                onApplied?.(r);
            } else if (r.decision === 'store') {
                log.log('[relay-list] newer signed relay list stored, relays unchanged');
            }
        } catch (err) {
            log.warn(`[relay-list] sync failed: ${err.message}`);
        } finally {
            running = false;
        }
    };

    const first = setTimeout(run, initialDelayMs);
    const timer = setInterval(run, intervalMs);
    first.unref?.();
    timer.unref?.();
    return { stop() { clearTimeout(first); clearInterval(timer); }, run };
}
