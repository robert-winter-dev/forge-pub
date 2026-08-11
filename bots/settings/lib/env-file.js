/**
 * FORGE – .env-Datei parsen/aktualisieren (gemeinsam für routes/config.js + routes/timezone.js)
 *
 * Erhält Kommentare und Zeilenreihenfolge einer bestehenden .env-Datei; unbekannte
 * Keys werden ans Ende angehängt statt die Datei neu aufzubauen.
 */

export function parseEnv(content) {
    const result = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx === -1) continue;
        const key = trimmed.slice(0, idx).trim();
        const val = trimmed.slice(idx + 1).trim();
        result[key] = val;
    }
    return result;
}

/**
 * @param {string} existing Bisheriger Dateiinhalt
 * @param {Record<string,string>} updates Zu setzende Keys
 * @param {Set<string>} [forbidden] Keys, die trotz Angabe in updates NIE geschrieben werden
 */
export function serializeEnv(existing, updates, forbidden = new Set()) {
    const lines = existing.split('\n');
    const applied = new Set();

    const updated = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const idx = trimmed.indexOf('=');
        if (idx === -1) return line;
        const key = trimmed.slice(0, idx).trim();
        if (key in updates && !forbidden.has(key)) {
            applied.add(key);
            return `${key}=${updates[key]}`;
        }
        return line;
    });

    for (const [k, v] of Object.entries(updates)) {
        if (!applied.has(k) && !forbidden.has(k)) {
            updated.push(`${k}=${v}`);
        }
    }

    return updated.join('\n');
}
