/**
 * FORGE LendingBot – Dashboard Data Manager
 *
 * Holt data/data.json alle 60 Sekunden und notifiziert Listener.
 * Graceful fallback wenn die Datei (noch) nicht existiert.
 */

export class DataManager {
    constructor() {
        this.data           = null;
        this.listeners      = [];
        this.lastUpdate     = null;
        this.isLoading      = false;
        this.FETCH_INTERVAL = 60_000; // 60s
        this._sourceUrl     = 'data/data.json';
        this._historyUrl    = 'data/data-history.json';
        this._pollTimer     = null;
    }

    /** Startet regelmäßiges Polling. */
    start() {
        this.fetch();
        this._pollTimer = setInterval(() => this.fetch(), this.FETCH_INTERVAL);
    }

    /** Registriert einen Listener – wird bei jedem Fetch-Erfolg und bei null-Daten aufgerufen. */
    addListener(fn) {
        this.listeners.push(fn);
    }

    notifyListeners() {
        for (const fn of this.listeners) {
            try { fn(this.data); } catch (e) { console.error('DataManager listener error:', e); }
        }
    }

    /**
     * Fetch data.json – bis zu 3 Versuche bei Fehler.
     * Bei 404 (Bot noch nicht gestartet) → null-Daten propagieren (Offline-State).
     */
    async fetch() {
        if (this.isLoading) return;
        this.isLoading = true;

        const maxRetries = 3;
        const baseDelay  = 500;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const t = Date.now();
                const [res, resHist] = await Promise.all([
                    fetch(this._sourceUrl  + '?t=' + t, { headers: { 'Cache-Control': 'no-cache' } }),
                    fetch(this._historyUrl + '?t=' + t, { headers: { 'Cache-Control': 'no-cache' } }),
                ]);

                if (res.status === 404) {
                    // Bot noch nicht gestartet – kein Fehler, einfach offline zeigen
                    this.data = null;
                    this.notifyListeners();
                    break;
                }

                if (!res.ok) throw new Error(`HTTP ${res.status}`);

                const live = await res.json();
                if (resHist.ok) {
                    try { Object.assign(live, await resHist.json()); } catch { /* history parse failed, continue without */ }
                }
                this.data       = live;
                this.lastUpdate = new Date();
                this.notifyListeners();
                break;

            } catch (err) {
                if (attempt === maxRetries) {
                    console.warn('DataManager: Fetch fehlgeschlagen nach', maxRetries, 'Versuchen:', err.message);
                    this.data = null;
                    this.notifyListeners();
                } else {
                    await new Promise(r => setTimeout(r, baseDelay * attempt));
                }
            }
        }

        this.isLoading = false;
    }
}
