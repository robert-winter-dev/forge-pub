/**
 * Release-Liste des Update-Prüfers: Kandidatenwahl und Vollständigkeitsprüfung
 * (CORE#000940). Getrennt von bin/update-check.js, weil dessen main() beim Import
 * läuft und sich nicht ohne echten Lauf testen lässt.
 *
 * GitHub listet ein neues Release, bevor promote.js die Dateien hochgeladen hat.
 * Eine solche Liste darf nicht 10 Minuten zwischengespeichert werden — sonst sieht
 * jeder Klick auf "Jetzt prüfen" in dieser Zeit dasselbe leere Release (v0.9.13, 23.09.2026).
 */

export class ReleaseIncompleteError extends Error {
    constructor(tag) {
        super(`Release ${tag} wird gerade veröffentlicht.`);
        this.name = 'ReleaseIncompleteError';
        this.tag = tag;
    }
}

/** Erstes Release des Kanals (staging = Prerelease), sonst undefined. */
export function pickCandidate(releases, channel) {
    const wantPrerelease = channel === 'staging';
    return releases.find((r) => Boolean(r.prerelease) === wantPrerelease);
}

/** Pflichtdateien vorhanden: manifest.json, manifest.json.sig und ein *.tar.gz. */
export function isReleaseComplete(release) {
    const names = (release?.assets ?? []).map((a) => a.name);
    return names.includes('manifest.json')
        && names.includes('manifest.json.sig')
        && names.some((n) => n.endsWith('.tar.gz'));
}

/** Nur cachen, wenn das neueste Release des Kanals vollständig ist. */
export function shouldCacheReleaseList(releases, channel) {
    const candidate = pickCandidate(releases, channel);
    return Boolean(candidate) && isReleaseComplete(candidate);
}
