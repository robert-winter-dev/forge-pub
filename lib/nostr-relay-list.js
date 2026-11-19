/**
 * Signed Nostr relay list: lets the master hand a relay swap to every fork without a
 * fork update (CORE#002022, KB Core/nostr-relay-pool, section "Verteilung an die Forks").
 *
 * The master signs its config/nostr-relays.json as a Nostr event (kind 30078, NIP-78
 * app data, d tag "forge-nostr-relays") with the FORGE.Master key and publishes it to the
 * active relays plus the candidate pool (bin/nostr-relay-list-publish.js). Forks fetch it
 * periodically (core/premium/server.js), verify signature and author against the master
 * pubkey shipped in config/nostr-contacts.json, accept only a newer created_at (replay
 * protection) and store the event in the data directory. loadRelays() in
 * lib/nostr-client.js prefers a valid stored list over the built-in one.
 *
 * Pure functions plus two small file helpers; no network here.
 */

import fs from 'fs';
import path from 'path';
import { finalizeEvent, verifyEvent } from 'nostr-tools';

export const RELAY_LIST_KIND = 30078;
export const RELAY_LIST_D_TAG = 'forge-nostr-relays';
export const MIN_RELAYS = 2;
export const MAX_RELAYS = 8;
// Extra relays a fork also asks for the list (the master's candidate pool). Travels
// inside the signed event, so the candidate file itself never has to ship to the fork.
export const MAX_LOOKUP_RELAYS = 20;
// Clock skew tolerance; an event far in the future would block every later list.
export const MAX_FUTURE_SECONDS = 3600;
export const STORED_FILE_NAME = 'nostr-relays.signed.json';

const RELAY_URL_RE = /^wss:\/\/[a-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\-/]*)?$/;

/** Normalised, validated copy of a relay list; throws with a reason on any violation. */
export function validateRelayUrls(relays, { min = MIN_RELAYS, max = MAX_RELAYS } = {}) {
    if (!Array.isArray(relays)) throw new Error('relay list is not an array');
    const out = [];
    for (const raw of relays) {
        if (typeof raw !== 'string') throw new Error('relay entry is not a string');
        const url = raw.trim().replace(/\/+$/, '');
        if (!RELAY_URL_RE.test(url)) throw new Error(`invalid relay url: ${raw}`);
        if (out.includes(url)) throw new Error(`duplicate relay url: ${url}`);
        out.push(url);
    }
    if (out.length < min) throw new Error(`too few relays (${out.length} < ${min})`);
    if (out.length > max) throw new Error(`too many relays (${out.length} > ${max})`);
    return out;
}

export function sameRelays(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const sb = new Set(b);
    return a.every(u => sb.has(u));
}

/** Nostr filter that finds the master's relay list event. */
export function relayListFilter(masterPubkeyHex) {
    return { kinds: [RELAY_LIST_KIND], authors: [masterPubkeyHex], '#d': [RELAY_LIST_D_TAG] };
}

function validateLookup(lookup, relays) {
    const list = validateRelayUrls(lookup ?? [], { min: 0, max: MAX_LOOKUP_RELAYS });
    return list.filter(u => !relays.includes(u));
}

/** MASTER: builds and signs the relay list event. */
export function buildRelayListEvent(relays, lookup, secretKeyBytes, createdAt = Math.floor(Date.now() / 1000)) {
    const list = validateRelayUrls(relays);
    return finalizeEvent({
        kind: RELAY_LIST_KIND,
        created_at: createdAt,
        tags: [['d', RELAY_LIST_D_TAG]],
        content: JSON.stringify({ relays: list, lookup: validateLookup(lookup, list) }),
    }, secretKeyBytes);
}

/**
 * Verifies an event and returns { relays, lookup, createdAt, event }. Throws with a reason if
 * the signature, author, kind, d tag, timestamp or relay list is not acceptable.
 */
export function parseRelayListEvent(event, masterPubkeyHex, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (!event || typeof event !== 'object') throw new Error('no event');
    if (!masterPubkeyHex || event.pubkey !== masterPubkeyHex) throw new Error('author is not the master');
    if (event.kind !== RELAY_LIST_KIND) throw new Error(`wrong kind ${event.kind}`);
    const d = Array.isArray(event.tags) ? event.tags.find(t => Array.isArray(t) && t[0] === 'd') : null;
    if (!d || d[1] !== RELAY_LIST_D_TAG) throw new Error('wrong d tag');
    // verifyEvent caches its verdict under a symbol on the object (and object spread
    // would copy it); verify a fresh object built from the plain fields only.
    const { id, pubkey, created_at, kind, tags, content: rawContent, sig } = event;
    if (!verifyEvent({ id, pubkey, created_at, kind, tags, content: rawContent, sig })) throw new Error('invalid signature');
    if (!Number.isInteger(event.created_at) || event.created_at <= 0) throw new Error('invalid created_at');
    if (event.created_at > nowSeconds + MAX_FUTURE_SECONDS) throw new Error('created_at in the future');
    let content;
    try { content = JSON.parse(event.content); } catch { throw new Error('content is not JSON'); }
    const relays = validateRelayUrls(content?.relays);
    const lookup = validateLookup(content?.lookup, relays);
    return { relays, lookup, createdAt: event.created_at, event };
}

/** Newest acceptable event out of a list (invalid ones are skipped), or null. */
export function pickNewestValid(events, masterPubkeyHex, nowSeconds) {
    let best = null;
    for (const ev of events ?? []) {
        let parsed;
        try { parsed = parseRelayListEvent(ev, masterPubkeyHex, nowSeconds); } catch { continue; }
        if (!best || parsed.createdAt > best.createdAt) best = parsed;
    }
    return best;
}

/**
 * Decision for a fork that found `candidate` while `current` (stored list or null) is
 * in effect: 'ignore' (not newer), 'store' (newer, same relays) or 'apply' (newer,
 * different relays than the effective ones -> restart needed).
 */
export function decideUpdate(candidate, current, effectiveRelays) {
    if (!candidate) return 'ignore';
    if (current && candidate.createdAt <= current.createdAt) return 'ignore';
    return sameRelays(candidate.relays, effectiveRelays) ? 'store' : 'apply';
}

export function storedRelayListPath(dataDir) {
    return path.join(dataDir, STORED_FILE_NAME);
}

/** Reads and re-verifies the stored event; null if missing or not acceptable. */
export function readStoredRelayList(file, masterPubkeyHex, nowSeconds) {
    try {
        const event = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parseRelayListEvent(event, masterPubkeyHex, nowSeconds);
    } catch {
        return null;
    }
}

// Fallback marker: set by the fork's sync when none of the stored list's relays answers
// but a shipped (built-in) relay does. It is bound to the stored list's created_at, so it
// stops applying by itself as soon as a newer master list is stored (no clearing needed,
// and the stored list's replay protection stays untouched). Plain JSON, not security
// relevant: it can only switch from the signed list to the shipped list, never to a new one.
export const FALLBACK_FILE_NAME = 'nostr-relays.fallback.json';

export function fallbackMarkerPath(dataDir) {
    return path.join(dataDir, FALLBACK_FILE_NAME);
}

export function writeFallbackMarker(file, storedCreatedAt, now = Date.now()) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ storedCreatedAt, since: new Date(now).toISOString() }, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

/** True if a marker exists for exactly this stored list (same created_at). */
export function fallbackActiveFor(file, storedCreatedAt) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')).storedCreatedAt === storedCreatedAt;
    } catch {
        return false;
    }
}

/** Atomic write (tmp + rename) so a reader never sees half a file. */
export function writeStoredRelayList(file, event) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(event, null, 2) + '\n');
    fs.renameSync(tmp, file);
}
