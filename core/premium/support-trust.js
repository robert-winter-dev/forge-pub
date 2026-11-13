/**
 * FORGE Premium – Vertrauensstufe von Support-Absendern (nur Master relevant).
 *
 * Der Master nimmt Support-DMs bewusst von JEDER Gegenstelle an (das ist sein
 * Posteingang, siehe server.js). Seit 13.11.2026 landen dort Link-Köder-Spam-DMs
 * (Kurzlink + unsichtbare Zeichen gegen Stichwortfilter). Statt Absender
 * auszusperren, werden sie in "bekannt" und "unbekannt" getrennt: Unbekannte
 * bleiben lesbar, lösen aber weder Zähler noch Push aus und zählen nicht gegen
 * das 100er-Limit echter Anliegen.
 *
 * "Bekannt" wird dynamisch aus den Daten abgeleitet, nicht gespeichert:
 *   stark: wir haben dem Absender geantwortet (direction 'out'), oder er steht in
 *          health_share_participants / premium_activation_tokens
 *   schwach: er setzt den Thread-Tag (unsichtbarer U+2063-Marker, den nur FORGE-
 *          Installationen schreiben) UND hat nie ein Spam-Merkmal gezeigt
 * Ein Absender, dem wir geantwortet haben, wird damit automatisch bekannt.
 *
 * Auf Forks (nicht Master) kommen Support-DMs ohnehin nur vom Master-Kontakt –
 * dort ist jeder Absender bekannt.
 */

// Kurzlink-Dienste: tarnen das Ziel, in legitimen Support-Anfragen unüblich.
const SHORTLINK_RE = new RegExp(
    '(?:^|[^a-z0-9.-])(?:is\\.gd|bit\\.ly|tinyurl\\.com|t\\.co|cutt\\.ly|rb\\.gy|shorturl\\.at|' +
    'tiny\\.cc|ow\\.ly|buff\\.ly|rebrand\\.ly|v\\.gd|s\\.id|t\\.ly|soo\\.gd|qr\\.ae|lnkd\\.in)/',
    'i'
);

// Zero-Width-/Soft-Hyphen-Zeichen, mit denen Spam Stichwortfilter umgeht.
// U+2063 (INVISIBLE SEPARATOR) ist der eigene Thread-Tag und fehlt hier bewusst –
// der wird vor der Prüfung ohnehin entfernt (extractThreadTag).
const INVISIBLE_RE = /[​‌‍⁠﻿­᠎]/;

/**
 * Liefert den Grund (String) oder null. Prüft den bereits vom Thread-Tag befreiten Text.
 * @param {string} text
 */
export function detectSpamReason(text) {
    const s = String(text ?? '');
    const reasons = [];
    if (INVISIBLE_RE.test(s)) reasons.push('invisible-chars');
    if (SHORTLINK_RE.test(s)) reasons.push('shortlink');
    return reasons.length ? reasons.join('+') : null;
}

function tableExists(db, name) {
    return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

/**
 * SQL-Bedingung "diese Gegenstelle ist bekannt" für die Spalte `peerCol`
 * (voll qualifiziert, z.B. 'm1.peer_pubkey' oder 'nostr_support_messages.peer_pubkey').
 * Auf Forks ('1'): jeder Absender gilt als bekannt.
 */
export function knownPeerSql(db, peerCol, isMaster) {
    if (!isMaster) return '1';
    const strong = [
        `EXISTS (SELECT 1 FROM nostr_support_messages x WHERE x.peer_pubkey = ${peerCol} AND x.direction = 'out' AND x.category = 'support')`,
    ];
    if (tableExists(db, 'health_share_participants')) {
        strong.push(`EXISTS (SELECT 1 FROM health_share_participants h WHERE h.pubkey_hex = ${peerCol})`);
    }
    if (tableExists(db, 'premium_activation_tokens')) {
        strong.push(`EXISTS (SELECT 1 FROM premium_activation_tokens a WHERE a.customer_pubkey = ${peerCol})`);
    }
    const weak =
        `(EXISTS (SELECT 1 FROM nostr_support_messages x WHERE x.peer_pubkey = ${peerCol} AND x.direction = 'in' AND x.thread_id IS NOT NULL)` +
        ` AND NOT EXISTS (SELECT 1 FROM nostr_support_messages x WHERE x.peer_pubkey = ${peerCol} AND x.spam_reason IS NOT NULL))`;
    return `(${[...strong, weak].join(' OR ')})`;
}

/** true, wenn diese Gegenstelle bekannt ist (Einzelabfrage, z.B. direkt nach dem Eingang einer DM). */
export function isPeerKnown(db, peerHex, isMaster) {
    if (!isMaster) return true;
    return !!db.prepare(`SELECT 1 FROM (SELECT ? AS peer_pubkey) p WHERE ${knownPeerSql(db, 'p.peer_pubkey', true)}`).get(peerHex);
}

/** Selbsttest (node core/premium/support-trust.js): Spam-Muster der echten Fälle vom 13.11.2026. */
if (import.meta.url === `file://${process.argv[1]}`) {
    const cases = [
        ['I bet you wo​n​\'t dare to open it. https://is.gd/KT4Thh', true],
        ['This link won\'t stay here long. https://is.gd/6BvFSg', true],
        ['Hallo, mein Bot startet nicht. Siehe https://github.com/foo/bar/issues/1', false],
        ['Wie aktiviere ich Premium?', false],
    ];
    let bad = 0;
    for (const [text, spam] of cases) {
        const got = detectSpamReason(text) != null;
        if (got !== spam) { bad++; console.error(`FEHLER: erwartet spam=${spam}, war ${got}: ${text}`); }
    }
    console.log(bad ? `${bad} Fehler` : 'OK');
    process.exit(bad ? 1 : 0);
}
