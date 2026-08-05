/**
 * FORGE – Zentrale Konfiguration
 *
 * Konfigurierbar via Umgebungsvariable:
 *   FORGE_TZ=Europe/Berlin   (Standard wenn nicht gesetzt)
 *
 * Kann in jeder Bot-.env oder systemd-Unit überschrieben werden.
 */

export const FORGE_TZ = process.env.FORGE_TZ || 'Europe/Berlin';

/**
 * Heutiges Datum (YYYY-MM-DD) in der konfigurierten Zeitzone.
 * Entspricht dem, was der Nutzer als "heute" versteht.
 */
export function todayTz(tz = FORGE_TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/**
 * Mitternacht der angegebenen Zeitzone als UTC-Timestamp (ms).
 * isoDate: 'YYYY-MM-DD' (optional, Standard: heute)
 */
export function midnightTzMs(isoDate = todayTz(), tz = FORGE_TZ) {
  // UTC-Mitternacht des ISO-Datums als Ausgangspunkt
  const utcMidnight = new Date(isoDate + 'T00:00:00Z').getTime();
  // Stunden-Offset des ISO-Datums 00:00 UTC in der Zielzone ermitteln
  let berlinHour = parseInt(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', hour12: false,
    }).format(new Date(utcMidnight)),
    10
  );
  if (berlinHour === 24) berlinHour = 0;
  return utcMidnight - berlinHour * 3_600_000;
}
