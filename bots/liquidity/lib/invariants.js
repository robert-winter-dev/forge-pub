/**
 * FORGE Liquidity – Code-Invarianten
 *
 * Statische Asserts über Modul-Konstanten. Werden geprüft:
 *   1. Beim Bot-Start (fail-fast in bin/bot.js)
 *   2. Stündlich via FORGE/bin/forge-check.js → Anomaly-Pipeline
 *
 * Hintergrund: 2026-05-08 hat ein USDC_MINT-Typ-Mismatch (PublicKey statt String)
 * einen Cleanup-Crash verursacht, weil die fehlerhafte Annahme erst Stunden nach
 * Bot-Start in einer SQLite-Bindung sichtbar wurde. Diese Datei macht solche
 * Annahmen explizit prüfbar.
 *
 * Erweiterung: bei jedem neu gefundenen stummen Bug eine neue Invariante
 * hier hinzufügen.
 */

import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PublicKey } from '@solana/web3.js';
import { USDC_MINT, USDC_MINT_KEY } from './wallet.js';
import { POOL_TYPE_CONFIG } from './range-advisor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POOLS_CONFIG_PATH = path.join(__dirname, '..', 'config', 'pools.json');

// Felder, die bei ALLEN 51 aktuellen Pools vorkommen (siehe LIQ#000644) — Kandidat für
// ein künftiges neues Pflichtfeld: erst hier eintragen, wenn es wirklich bei jedem Pool
// gesetzt sein muss, sonst schlägt der Import eines Pools ohne dieses Feld fälschlich fehl.
const REQUIRED_POOL_FIELDS = [
    'id', 'poolType', 'protocol', 'address', 'pair', 'tokenA', 'tokenB',
    'decimalsA', 'decimalsB', 'feeTier', 'tickSpacing',
    'tvlWarnThreshold', 'tvlExitThreshold', 'active',
];

/** Wirft Error wenn eine Invariante verletzt ist. */
export function assertTypeInvariants() {
    const violations = [];

    // USDC_MINT muss String sein (für SQLite-Bind, Vergleiche, Jupiter-API).
    if (typeof USDC_MINT !== 'string') {
        violations.push(`USDC_MINT muss String sein, ist aber ${typeof USDC_MINT} (${USDC_MINT?.constructor?.name})`);
    }
    if (USDC_MINT !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') {
        violations.push(`USDC_MINT-Wert weicht ab: ${USDC_MINT}`);
    }

    // USDC_MINT_KEY muss PublicKey sein (für Solana-SDK).
    if (!(USDC_MINT_KEY instanceof PublicKey)) {
        violations.push(`USDC_MINT_KEY muss PublicKey sein, ist aber ${USDC_MINT_KEY?.constructor?.name}`);
    }
    if (USDC_MINT_KEY?.toBase58?.() !== USDC_MINT) {
        violations.push(`USDC_MINT_KEY ↔ USDC_MINT inkonsistent (${USDC_MINT_KEY?.toBase58?.()} vs. ${USDC_MINT})`);
    }

    if (violations.length > 0) {
        const msg = `Code-Invarianten verletzt:\n  - ${violations.join('\n  - ')}`;
        throw new Error(msg);
    }
}

/**
 * Sammelt Verletzungen statt zu werfen — für forge-check.js / Anomaly-Pipeline.
 * @returns {string[]} leere Liste = alles OK.
 */
export function checkTypeInvariants() {
    try {
        assertTypeInvariants();
        return [];
    } catch (err) {
        return err.message
            .split('\n')
            .filter(line => line.startsWith('  - '))
            .map(line => line.slice(4));
    }
}

/**
 * Prüft config/pools.json gegen strukturelle Invarianten (LIQ#000644).
 *
 * Auslöser: Der Import von liq-pyth-sol (LIQ#000641) fehlte `poolType`. Die bisherige
 * Checkliste (KB project_lmb3_new_pool_checklist) ist Prosa und hat das nicht
 * verhindert — getPoolTypeConfig() (range-advisor.js) ist zwar bewusst fail-fast (#0228),
 * schlägt aber erst zur Laufzeit in bin/export.js zu, nicht beim Anlegen des Pools.
 * export.js crashte dadurch 4h lang bei jedem Zyklus, data.json blieb veraltet,
 * Premium-Kunden bekamen keine InvestScores mehr (Fix-Commit c0e0bc89).
 *
 * Wirft Error wenn eine Invariante verletzt ist.
 * @param {Array|null} poolsOverride  Nur für Tests: Pool-Array statt Disk-Read verwenden.
 */
export function assertPoolsConfig(poolsOverride = null) {
    const pools = loadPoolsOrThrow(poolsOverride);
    const perPool = computePoolViolations(pools);
    const violations = perPool.flatMap(p => p.violations);

    if (violations.length > 0) {
        throw new Error(`Pools-Config-Invarianten verletzt:\n  - ${violations.join('\n  - ')}`);
    }
}

function loadPoolsOrThrow(poolsOverride) {
    let pools;
    if (poolsOverride) {
        pools = poolsOverride;
    } else {
        try {
            pools = JSON.parse(readFileSync(POOLS_CONFIG_PATH, 'utf8'));
        } catch (err) {
            throw new Error(`Pools-Config-Invarianten verletzt:\n  - config/pools.json nicht lesbar: ${err.message}`);
        }
    }
    if (!Array.isArray(pools) || pools.length === 0) {
        throw new Error('Pools-Config-Invarianten verletzt:\n  - config/pools.json muss ein nicht-leeres Array sein');
    }
    return pools;
}

/**
 * Gemeinsame Regel-Engine hinter assertPoolsConfig()/getInvalidPoolIds() — EINE Quelle,
 * damit die "gesamte Datei ok?"-Sicht (forge-check.js) und die "welcher einzelne Pool ist
 * kaputt?"-Sicht (export.js, LIQ#000645) niemals auseinanderdriften.
 * @returns {{ id: string|undefined, label: string, violations: string[] }[]}
 */
function computePoolViolations(pools) {
    const allIds = new Set(pools.map(p => p.id));
    const seenIds = new Set();

    return pools.map(pool => {
        const label = pool?.id ?? '(ohne id)';
        const violations = [];

        for (const field of REQUIRED_POOL_FIELDS) {
            if (pool[field] === undefined || pool[field] === null) {
                violations.push(`${label}: Pflichtfeld "${field}" fehlt`);
            }
        }

        if (pool.id) {
            if (seenIds.has(pool.id)) violations.push(`${label}: id ist nicht eindeutig (Duplikat)`);
            seenIds.add(pool.id);
        }

        // poolType gegen dieselbe Quelle prüfen, die export.js zur Laufzeit crashen lässt
        // (POOL_TYPE_CONFIG aus range-advisor.js) — keine zweite, potenziell abweichende Liste.
        if (pool.poolType !== undefined && pool.poolType !== null && !(pool.poolType in POOL_TYPE_CONFIG)) {
            violations.push(`${label}: poolType "${pool.poolType}" unbekannt. Erlaubt: ${Object.keys(POOL_TYPE_CONFIG).join(', ')}`);
        }

        // volatilePair-Pools brauchen eine Referenz-Preisquelle (siehe reference-prices.js) —
        // ohne die fehlt dem Pool jede Preisbasis für Range/Score.
        if (pool.volatilePair === true) {
            for (const field of ['quotePricePoolId', 'quoteTokenMint']) {
                if (!pool[field]) violations.push(`${label}: volatilePair=true erfordert "${field}"`);
            }
            if (pool.quotePricePoolId && !allIds.has(pool.quotePricePoolId)) {
                violations.push(`${label}: quotePricePoolId "${pool.quotePricePoolId}" verweist auf keinen existierenden Pool`);
            }
        }

        return { id: pool.id, label, violations };
    });
}

/**
 * Liefert je Pool mit Verletzung dessen Fehlerliste — Grundlage für "einzelnen Pool
 * überspringen" statt "kompletten Export abbrechen" (LIQ#000645, siehe bin/export.js).
 * Pools ohne `id` lassen sich nicht gezielt überspringen und fehlen hier bewusst —
 * die fallen weiter über assertPoolsConfig()/forge-check.js auf.
 * @param {Array|null} poolsOverride  Nur für Tests: Pool-Array statt Disk-Read verwenden.
 * @returns {Map<string, string[]>}
 */
export function getInvalidPoolIds(poolsOverride = null) {
    const pools = loadPoolsOrThrow(poolsOverride);
    const invalid = new Map();
    for (const { id, violations } of computePoolViolations(pools)) {
        if (id && violations.length > 0) invalid.set(id, violations);
    }
    return invalid;
}

/**
 * Sammelt Verletzungen statt zu werfen — für forge-check.js / Anomaly-Pipeline.
 * @returns {string[]} leere Liste = alles OK.
 */
export function checkPoolsConfigViolations() {
    try {
        assertPoolsConfig();
        return [];
    } catch (err) {
        return err.message
            .split('\n')
            .filter(line => line.startsWith('  - '))
            .map(line => line.slice(4));
    }
}

// Pflichtfelder jedes pool_stats-Schreibers (LIQ#000774). insertPoolStats() (lib/db.js)
// setzt fehlende Felder still auf null; export.js nimmt für die NP-Schätzung aber die
// NEUESTE Zeile — ohne diese Felder fällt sie auf den Schätz-APR zurück und der
// InvestScore bricht bis zur nächsten vollständigen Zeile ein. Explizites `?? null`
// (API liefert nichts) ist erlaubt; vergessen nicht.
const POOL_STATS_REQUIRED_KEYS = ['liquidityInRange', 'fees24hUsd'];
const SOURCE_DIRS = ['bin', 'lib'];

/**
 * Quellcode-Invariante: jeder insertPoolStats(...)-Aufruf übergibt alle Pflichtfelder,
 * und außerhalb von lib/db.js schreibt niemand roh per SQL in pool_stats.
 * Testskripte (test-*.js) sind ausgenommen — sie bauen Fixture-DBs.
 *
 * @param {Array<{file:string, source:string}>|null} sourcesOverride  Nur für Tests.
 * @returns {string[]} leere Liste = alles OK.
 */
export function checkPoolStatsWriters(sourcesOverride = null) {
    const sources = sourcesOverride ?? loadBotSources();
    const violations = [];
    for (const { file, source } of sources) {
        if (/(^|\/)test-[^/]*\.m?js$/.test(file) || /(^|\/)lib\/invariants\.js$/.test(file)) continue;

        const callRe = /\binsertPoolStats\s*\(/g;
        let m;
        while ((m = callRe.exec(source)) !== null) {
            const before = source.slice(Math.max(0, m.index - 16), m.index);
            if (/function\s+$/.test(before)) continue;               // Definition in lib/db.js
            const lineStart = source.lastIndexOf('\n', m.index) + 1;
            const prefix = source.slice(lineStart, m.index);
            if (/^\s*(\*|\/\*)/.test(prefix) || prefix.includes('//')) continue; // Kommentar
            const line = source.slice(0, m.index).split('\n').length;
            const args = balancedArgs(source, m.index + m[0].length);
            if (args == null) {
                violations.push(`${file}:${line}: insertPoolStats-Aufruf nicht auswertbar (Klammer nicht geschlossen)`);
                continue;
            }
            if (!args.includes('{')) {
                violations.push(`${file}:${line}: insertPoolStats ohne Objektliteral — Pflichtfelder nicht prüfbar`);
                continue;
            }
            const missing = POOL_STATS_REQUIRED_KEYS.filter(k => !new RegExp(`\\b${k}\\b`).test(args));
            if (missing.length) {
                violations.push(`${file}:${line}: insertPoolStats ohne ${missing.join(', ')} (NP-Schätzung/InvestScore bricht ein, LIQ#000774)`);
            }
        }

        if (!/(^|\/)lib\/db\.js$/.test(file)) {
            const rawRe = /INSERT\s+(OR\s+\w+\s+)?INTO\s+pool_stats\b/gi;
            while ((m = rawRe.exec(source)) !== null) {
                const line = source.slice(0, m.index).split('\n').length;
                violations.push(`${file}:${line}: rohes INSERT in pool_stats — nur über insertPoolStats() schreiben`);
            }
        }
    }
    return violations;
}

/** Text zwischen der öffnenden Klammer (bereits konsumiert) und ihrem Gegenstück. */
function balancedArgs(source, start) {
    let depth = 1;
    for (let i = start; i < source.length; i++) {
        const c = source[i];
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) return source.slice(start, i);
    }
    return null;
}

function loadBotSources() {
    const root = path.join(__dirname, '..');
    const out = [];
    const walk = (rel) => {
        for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
            const childRel = `${rel}/${e.name}`;
            if (e.isDirectory()) walk(childRel);
            else if (/\.m?js$/.test(e.name)) out.push({ file: childRel, source: readFileSync(path.join(root, childRel), 'utf8') });
        }
    };
    for (const dir of SOURCE_DIRS) walk(dir);
    return out;
}
