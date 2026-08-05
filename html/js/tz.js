// html/js/tz.js
// ─────────────────────────────────────────────────────────────────────────────
// ⛔ ZENTRALER TIMEZONE-HELPER — DIE EINZIGE STELLE FÜR ZEITZONE IM FRONTEND
// ─────────────────────────────────────────────────────────────────────────────
// Regel (siehe memory/project_timezone_fix.md):
//   - Die Zeitzone wird exakt EINMAL definiert (in .env als FORGE_TZ).
//   - PHP injiziert sie als `window.FORGE_TZ` in jede index.php.
//   - Dieser Helper re-exportiert sie als `TZ` + liefert Convenience-Funktionen.
//   - NIEMALS irgendwo eine Zeitzone hartcodieren ('Europe/Berlin', 'UTC', …).
//   - NIEMALS setUTCHours/setUTCDate/getUTCDate für Tagesgrenzen verwenden.
//   - NIEMALS `timeZone: 'UTC'` für Datumsberechnungen nutzen.
//
// Alle Frontend-Module importieren aus diesem File:
//   import { TZ, todayISO, startOfDayMs, fmtDE, fmtDateDE } from '/js/tz.js';
// ─────────────────────────────────────────────────────────────────────────────

if (typeof window === 'undefined' || !window.FORGE_TZ) {
  // Harter Fehler: Ohne FORGE_TZ rechnet nichts korrekt. PHP muss es injizieren.
  // eslint-disable-next-line no-console
  console.error('[tz.js] window.FORGE_TZ ist nicht gesetzt — PHP-Injektion fehlt!');
}

/** Zentrale Zeitzone — einzige Quelle der Wahrheit im Frontend. */
export const TZ = (typeof window !== 'undefined' && window.FORGE_TZ) || undefined;

/**
 * Heute als 'YYYY-MM-DD' in FORGE_TZ.
 * @param {Date} [d=new Date()]
 * @returns {string} e.g. '2026-04-14'
 */
export const todayISO = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

/**
 * UTC-ms-Timestamp für Mitternacht (00:00) in FORGE_TZ eines gegebenen Datums.
 * Beispiel: startOfDayMs() → UTC-ms für heute 00:00 lokale Zeit.
 * @param {Date} [d=new Date()]
 * @returns {number} UTC-ms
 */
export const startOfDayMs = (d = new Date()) => {
  const ymd = todayISO(d); // 'YYYY-MM-DD' in FORGE_TZ
  return zonedWallClockToMs(ymd + 'T00:00:00');
};

/**
 * Wandelt eine Wanduhrzeit in FORGE_TZ ('YYYY-MM-DDTHH:mm:ss') in UTC-ms um.
 * @param {string} dateStr 'YYYY-MM-DD' oder 'YYYY-MM-DDTHH:mm:ss'
 * @returns {number} UTC-ms
 */
export const zonedWallClockToMs = (dateStr) => {
  const [datePart, timePart = '00:00:00'] = dateStr.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);
  // Naive UTC-Interpretation als Ausgangspunkt
  const naiveUtcMs = Date.UTC(y, m - 1, d, h, mi, s);
  // Differenz zwischen FORGE_TZ und UTC zu genau diesem Zeitpunkt ermitteln:
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(naiveUtcMs));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const hh = get('hour') === 24 ? 0 : get('hour');
  const tzMs = Date.UTC(get('year'), get('month') - 1, get('day'), hh, get('minute'), get('second'));
  const offsetMs = tzMs - naiveUtcMs; // positiver Offset bei TZ=UTC+x
  return naiveUtcMs - offsetMs;
};

/**
 * Getter für die aktuelle Stunde (0–23) in FORGE_TZ.
 * @param {Date} [d=new Date()]
 * @returns {number} 0–23
 */
export const hourInTZ = (d = new Date()) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, hour: '2-digit' }).format(d)) % 24;

/**
 * Getter für Tag-im-Monat (1–31) in FORGE_TZ.
 * @param {Date} [d=new Date()]
 * @returns {number} 1–31
 */
export const dayOfMonthInTZ = (d = new Date()) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, day: '2-digit' }).format(d));

/**
 * Wochentag-Index (0=So, 1=Mo, …, 6=Sa) in FORGE_TZ.
 * @param {Date} [d=new Date()]
 * @returns {number}
 */
export const weekdayInTZ = (d = new Date()) => {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
};

/**
 * Liefert UTC-ms der Mitternacht DES nächsten Tages in FORGE_TZ (Ende von heute).
 * @param {Date} [d=new Date()]
 * @returns {number}
 */
export const endOfDayMs = (d = new Date()) => {
  const tomorrow = new Date(startOfDayMs(d) + 26 * 3600_000); // sicher >24h weiter
  return startOfDayMs(tomorrow);
};

/**
 * Factory für `Intl.DateTimeFormat` mit timeZone = FORGE_TZ (Convenience).
 * @param {string|string[]} locale
 * @param {Intl.DateTimeFormatOptions} [opts]
 */
export const makeFmt = (locale, opts = {}) =>
  new Intl.DateTimeFormat(locale, { ...opts, timeZone: TZ });

/** Formatter: 'de-DE', Datum + Uhrzeit. */
export const fmtDE = (ms, opts = { dateStyle: 'short', timeStyle: 'short' }) =>
  makeFmt('de-DE', opts).format(new Date(ms));

/** Formatter: 'de-DE', nur Datum. */
export const fmtDateDE = (ms, opts = { dateStyle: 'short' }) =>
  makeFmt('de-DE', opts).format(new Date(ms));

/** Formatter: 'de-DE', nur Uhrzeit. */
export const fmtTimeDE = (ms, opts = { timeStyle: 'short' }) =>
  makeFmt('de-DE', opts).format(new Date(ms));

/**
 * Liefert Datums-Parts (year, month, day, hour, minute, second) in FORGE_TZ.
 * Nützlich für Bucket-Keys, lokale Mitternacht-Berechnung etc.
 * @param {Date|number} [d=new Date()]
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number}}
 */
export const partsInTZ = (d = new Date()) => {
  const date = typeof d === 'number' ? new Date(d) : d;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return {
    year: get('year'), month: get('month'), day: get('day'),
    hour: get('hour') === 24 ? 0 : get('hour'),
    minute: get('minute'), second: get('second'),
  };
};

/**
 * Bucket-Key 'YYYY-MM-DD-HH' in FORGE_TZ (für Aggregation je Stunde).
 * @param {Date|number} [d=new Date()]
 * @returns {string}
 */
export const hourBucketKey = (d = new Date()) => {
  const p = partsInTZ(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}-${String(p.hour).padStart(2, '0')}`;
};
