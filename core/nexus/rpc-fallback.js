/**
 * FORGE Nexus – Fallback-RPC bei erschöpftem Helius-Kontingent (CORE#000814)
 *
 * Reine Logik ohne Netzwerk- und Zeitzugriff, damit testbar. Verdrahtung in server.js.
 * Warum, Grenzen und Betrieb: KB Core/helius-credit-budget.md, Abschnitt „Fallback-RPC".
 *
 * Grundsätze:
 *   • Nur LESENDE Methoden aus FALLBACK_ALLOWED. Alles andere (getAsset, sendTransaction,
 *     unbekannte Methoden) scheitert im Fallback-Betrieb laut mit einem JSON-RPC-Fehler,
 *     nie mit leerer oder erfundener Antwort. Allowlist statt Denylist: eine neue Methode
 *     ist im Fallback erst dann erlaubt, wenn jemand sie bewusst einträgt.
 *   • Umgeschaltet wird nur bei „max usage reached" (Monatskontingent leer), nicht bei
 *     Störungen. Die sind meist selbstheilend (siehe Memory project_helius_outage_handling).
 *   • Zurückgeschaltet wird automatisch, aber mit Hysterese: Helius wird periodisch
 *     sondiert, erst mehrere Erfolge hintereinander und eine Mindestdauer im Fallback
 *     schalten zurück. Pendeln wäre schlimmer als ein klarer Zustand.
 */

export const FALLBACK_URL_DEFAULT = 'https://api.mainnet-beta.solana.com';

// Öffentlicher Solana-RPC: dokumentiert 100 req/10 s je IP gesamt und 40 req/10 s je Methode.
// 32 req/10 s liegen unter dem Methodenlimit minus 20 % Puffer (CLAUDE.md, API-Rate-Limits),
// damit ein Burst einer einzelnen Methode das Limit nicht reißt.
export const FALLBACK_LIMIT = { maxRequests: 32, windowMs: 10_000 };

export const FALLBACK_ALLOWED = new Set([
    'getAccountInfo',
    'getMultipleAccounts',
    'getBalance',
    'getTokenAccountBalance',
    'getTokenAccountsByOwner',
    'getTokenSupply',
    'getProgramAccounts',
    'getSignaturesForAddress',
    'getSignatureStatuses',
    'getTransaction',
    'getLatestBlockhash',
    'getMinimumBalanceForRentExemption',
    'getRecentPrioritizationFees',
    'getSlot',
    'getBlockHeight',
    'getEpochInfo',
    'getHealth',
]);

export function isAllowedInFallback(method) {
    return typeof method === 'string' && FALLBACK_ALLOWED.has(method);
}

/** JSON-RPC-Fehlerobjekt für eine im Fallback nicht verfügbare Methode. */
export function unavailableError(id, method) {
    return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
            code: -32000,
            message: `FORGE: ${method ?? '?'} im Fallback-RPC nicht verfügbar (Helius-Kontingent erschöpft)`,
            data: { forgeFallback: true, method: method ?? null },
        },
    };
}

/**
 * Zerlegt einen RPC-Body in erlaubte und nicht erlaubte Aufrufe.
 * @returns {{ isBatch: boolean, items: object[], allowed: object[], denied: object[] }}
 */
export function splitRequest(body) {
    const isBatch = Array.isArray(body);
    const items   = isBatch ? body : [body];
    const allowed = items.filter(i => isAllowedInFallback(i?.method));
    const denied  = items.filter(i => !isAllowedInFallback(i?.method));
    return { isBatch, items, allowed, denied };
}

/**
 * Setzt die Antwort zusammen: Upstream-Antworten der erlaubten Aufrufe (nach id) plus
 * Fehlerobjekte der abgelehnten, in der Reihenfolge der Anfrage.
 * @param {object[]} items          ursprüngliche Aufrufe
 * @param {object[]} upstreamItems  Antwortobjekte des Fallback-RPC (Batch-Antwort oder [Einzelantwort])
 */
export function mergeResponses(items, upstreamItems) {
    const byId = new Map(upstreamItems.map(r => [r?.id, r]));
    return items.map(i => isAllowedInFallback(i?.method)
        ? (byId.get(i.id) ?? unavailableError(i.id, i.method))   // Antwort fehlt → Fehler statt Lücke
        : unavailableError(i?.id, i?.method));
}

const MIN = 60_000;

export class FallbackState {
    /**
     * @param {object} o
     * @param {number} [o.probeIntervalMs]  Abstand der Helius-Sondierungen im Fallback
     * @param {number} [o.minActiveMs]      frühester Rückschaltzeitpunkt nach Aktivierung
     * @param {number} [o.probesNeeded]     aufeinanderfolgende Erfolge für die Rückschaltung
     */
    constructor({ probeIntervalMs = 10 * MIN, minActiveMs = 10 * MIN, probesNeeded = 2 } = {}) {
        this.probeIntervalMs = probeIntervalMs;
        this.minActiveMs     = minActiveMs;
        this.probesNeeded    = probesNeeded;
        this.active     = false;
        this.since      = null;
        this.lastProbe  = null;
        this.okProbes   = 0;
        this.served     = 0;   // im Fallback beantwortete Aufrufe
        this.refused    = 0;   // im Fallback abgelehnte Aufrufe (nicht verfügbar)
    }

    /** @returns {boolean} true, wenn dadurch NEU aktiviert wurde (→ Meldung senden) */
    activate(now) {
        if (this.active) return false;
        this.active = true;
        this.since = now;
        this.lastProbe = now;   // erste Sondierung erst nach einem vollen Intervall
        this.okProbes = 0;
        return true;
    }

    probeDue(now) {
        return this.active && now - this.lastProbe >= this.probeIntervalMs;
    }

    /**
     * @param {boolean} ok  Helius hat die Sondierung regulär beantwortet
     * @returns {null | { activeMs: number }}  gesetzt, wenn zurückgeschaltet wurde
     */
    recordProbe(ok, now) {
        if (!this.active) return null;
        this.lastProbe = now;
        this.okProbes = ok ? this.okProbes + 1 : 0;
        if (this.okProbes < this.probesNeeded || now - this.since < this.minActiveMs) return null;
        const activeMs = now - this.since;
        this.active = false;
        this.since = null;
        this.okProbes = 0;
        return { activeMs };
    }

    snapshot(now = Date.now()) {
        return {
            active:   this.active,
            since:    this.since,
            activeForMs: this.active ? now - this.since : 0,
            okProbes: this.okProbes,
            served:   this.served,
            refused:  this.refused,
        };
    }
}
