/**
 * FORGE – Kostenabschätzung vor finanziellen Aktionen
 *
 * Schätzt die voraussichtlichen Kosten einer Aktion anhand von Live-Daten.
 * Immer aufrufen bevor Token-Transaktionen ausgelöst werden.
 *
 * Verwendung:
 *   node FORGE/bin/estimate-costs.js --action rebalance --pool "SOL/USDC"
 *   node FORGE/bin/estimate-costs.js --action deposit   --pool "cbBTC/WBTC" --amount 100
 *   node FORGE/bin/estimate-costs.js --action deposit   --pool "cbBTC/USDC" --amount-a 0.00254253
 *   node FORGE/bin/estimate-costs.js --action open      --pool "SOL/USDC"   --amount 250
 *   node FORGE/bin/estimate-costs.js --action close     --pool "cbBTC/USDC"
 *   node FORGE/bin/estimate-costs.js --action close-reopen --pool "SOL/USDC"
 *   node FORGE/bin/estimate-costs.js --action rebalance (alle Liquidity-Pools)
 *   node FORGE/bin/estimate-costs.js --action swap --from EURC --to USDC --amount 47.50
 *   node FORGE/bin/estimate-costs.js --action swap --from EURC --to SOL  --amount 95
 *   node FORGE/bin/estimate-costs.js --action withdraw-and-swap --pool "cbBTC/WBTC" --amount 100
 *
 * LendingBot:
 *   node FORGE/bin/estimate-costs.js --bot lendingbot --action deposit  --pool kamino-figure     --amount 200
 *   node FORGE/bin/estimate-costs.js --bot lendingbot --action withdraw --pool loopscale-genesis --amount 270
 *   node FORGE/bin/estimate-costs.js --bot lendingbot --action withdraw --pool kamino-onre
 *
 * LendingBot-Protokolle: kamino | kamino-figure | kamino-onre | kamino-huma | jupiter | loopscale-onre | loopscale-genesis
 *
 * Aktionen:
 *   rebalance          CLMM-Rebalancing: Position out-of-range → close + swap + open
 *   deposit       Kapital zu bestehender Position hinzufügen (kein Swap)
 *   open          Neue Position eröffnen (inkl. ~50%-Swap für Token-Split)
 *   close         Position schließen (Fees claimen + Liquidität entfernen)
 *   withdraw      Teilentnahme aus bestehender Position
 *   close-reopen  Manuelles Schließen + Neueröffnen (z.B. für Range-Änderung)
 *   swap          Jupiter-Swap zwischen zwei Tokens (direkt oder via USDC)
 *
 * Ausgabe: Aufgeschlüsselte Kostenschätzung mit Konfidenz-Indikator.
 *
 * ⚠ Alle Werte sind Schätzungen. Echte Kosten können abweichen durch:
 *   - Preisbewegung zwischen Schätzung und Ausführung
 *   - Veränderte Pool-Tiefe / TVL zum Ausführungszeitpunkt
 *   - Netzwerkauslastung (TX-Fees bleiben auf Solana in der Regel minimal)
 */

import { parseArgs }      from 'node:util';
import { join, dirname }  from 'node:path';
import { fileURLToPath }  from 'node:url';
import { createRequire }  from 'node:module';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const FORGE_ROOT = join(__dirname, '..');
import { PATHS } from '../config/paths.js';
const require    = createRequire(import.meta.url);

// better-sqlite3 aus dem Liquidity-Projekt laden (liegt dort in node_modules)
let Database;
try {
    Database = require(join(FORGE_ROOT, 'bots', 'liquidity', 'node_modules', 'better-sqlite3'));
} catch {
    Database = null;
}

// ─── Konstanten ───────────────────────────────────────────────────────────────

/** Typische Solana TX-Kosten in SOL (Priority Fee vernachlässigbar auf Solana) */
const SOL_PER_TX         = 0.000005;

/** Mindest-SOL-Reserve im Wallet — NIEMALS unterschreiten */
const MIN_SOL_RESERVE    = 0.1;

/** Pools die SOL als Token enthalten und daher die Reserve-Prüfung auslösen */
const SOL_POOLS          = new Set(['SOL/USDC', 'HYPE/SOL', 'ORCA/SOL']);

/** Pools die einen Pre-Swap benötigen (USDC → TokenA), aber kein SOL-Reserve-Check */
const PRESWAP_POOLS      = new Set(['ZEC/USDC']);

/** Volatile-Pair-Pools (beide Tokens volatil, kein USDC im Pool) – brauchen ZWEI Pre-Swaps */
const VOLATILE_PAIR_POOLS = new Set(['HYPE/SOL', 'ORCA/SOL']);

/** Aktionen die SOL aus dem Wallet entnehmen (deposit/open benötigen SOL als TokenA) */
const SOL_CONSUMING_ACTIONS = new Set(['deposit', 'open', 'rebalance', 'close-reopen']);

/** Fallback-Preise wenn DB nicht verfügbar */
const FALLBACK_SOL_PRICE = 80;
const FALLBACK_BTC_PRICE = 67_000;

/** Anzahl Transaktionen pro Aktion (empirisch ermittelt) */
const TX_COUNT = {
    rebalance:    5,   // collectFees + decreaseLiquidity + closePosition + (Jupiter swap) + openPosition
    deposit:      1,   // increaseLiquidity
    open:         2,   // (Jupiter swap ~50%) + openPosition
    close:        3,   // collectFees + decreaseLiquidity + closePosition
    withdraw:     1,   // decreaseLiquidity
    'close-reopen': 6, // close (3) + open (3)
    swap:               1,   // Jupiter aggregiert in 1 TX (2 bei komplexen Multi-Hop-Routen)
    'withdraw-and-swap': 1,  // decreaseLiquidity; Swap-TXs werden separat addiert
};

// ─── LendingBot-Protokolle ────────────────────────────────────────────────────
//
// TX-Kosten aus beobachteten On-Chain-Gebühren (konservativ nach oben gerundet).
// cooldown: Loopscale kann je nach Marktlage immediate oder 7-Tage-Cooldown liefern –
//           der Bot erkennt das automatisch; hier zur Info beide Varianten aufgeführt.

const LB_PROTOCOLS = {
    'kamino':            { label: 'Kamino Main',      feeSol: 0.000005, cooldown: false },
    'kamino-figure':     { label: 'Kamino Figure',    feeSol: 0.000005, cooldown: false },
    'kamino-onre':       { label: 'Kamino OnRe',      feeSol: 0.000005, cooldown: false },
    'kamino-huma':       { label: 'Kamino Huma',      feeSol: 0.000005, cooldown: false },
    'jupiter':           { label: 'Jupiter Lend',     feeSol: 0.000005, cooldown: false },
    'loopscale-onre':    { label: 'Loopscale Public', feeSol: 0.000105, cooldown: 'maybe' },
    'loopscale-genesis': { label: 'Loopscale Gen',    feeSol: 0.000105, cooldown: 'maybe' },
};

// ─── Bekannte Token-Symbole (Normalisierung) ──────────────────────────────────

const TOKEN_ALIASES = {
    sol:   'SOL',  Sol:   'SOL',  SOL:   'SOL',
    usdc:  'USDC', Usdc:  'USDC', USDC:  'USDC',
    eurc:  'EURC', Eurc:  'EURC', EURC:  'EURC',
    cbtc:  'cbBTC', cbbtc: 'cbBTC', CBTC: 'cbBTC', cbBTC: 'cbBTC', CBBTC: 'cbBTC',
    wbtc:  'WBTC', Wbtc:  'WBTC', WBTC:  'WBTC',
    zec:   'ZEC',  Zec:   'ZEC',  ZEC:   'ZEC',
    hype:  'HYPE', Hype:  'HYPE', HYPE:  'HYPE',
    orca:  'ORCA', Orca:  'ORCA', ORCA:  'ORCA',
};

function normalizeToken(sym) {
    return TOKEN_ALIASES[sym] ?? sym.toUpperCase();
}

// ─── Bekannte Swap-Routen ─────────────────────────────────────────────────────
//
// Jupiter findet die beste Route automatisch. Für bekannte Pairs können wir
// aber die wahrscheinliche Route und deren Kosten konkret benennen.
//
// Struktur: 'TOKEN_A/TOKEN_B' (alphabetisch sortiert) → Array von Hops
// Jeder Hop: { poolId, address, feeTier (%), correlated }

const SWAP_ROUTES = {
    // ── Direkte Routen (1 Hop) ─────────────────────────────────────────────
    'EURC/USDC': {
        label: 'EURC ↔ USDC — direkt (Orca EURC/USDC 0.01%)',
        hops: [{ poolId: 'liq-eurc-usdc',  address: 'ArisQNcbjXPJD7RgPRvysatX3xcfHPTbcTkfD8kDoZ9i', feeTier: 0.01, correlated: true }],
    },
    'SOL/USDC': {
        label: 'SOL ↔ USDC — direkt (Orca SOL/USDC 0.04%)',
        hops: [{ poolId: 'liq-sol-usdc',   address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', feeTier: 0.04, correlated: false }],
    },
    'USDC/cbBTC': {
        label: 'cbBTC ↔ USDC — direkt (Orca cbBTC/USDC 0.04%)',
        hops: [{ poolId: 'liq-btc-usdc',   address: 'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM', feeTier: 0.04, correlated: false }],
    },
    'WBTC/cbBTC': {
        label: 'cbBTC ↔ WBTC — direkt (Orca cbBTC/WBTC 0.01%)',
        hops: [{ poolId: 'liq-cbtc-wbtc',  address: '4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72', feeTier: 0.01, correlated: true }],
    },
    'USDC/WBTC': {
        label: 'WBTC ↔ USDC — 2 Hops: cbBTC/WBTC (0.01%) + cbBTC/USDC (0.04%)',
        hops: [
            { poolId: 'liq-cbtc-wbtc', address: '4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72', feeTier: 0.01, correlated: true },
            { poolId: 'liq-btc-usdc',  address: 'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM', feeTier: 0.04, correlated: false },
        ],
    },
    // ── Multi-Hop-Routen (2 Hops via USDC) ────────────────────────────────
    'EURC/SOL': {
        label: 'EURC ↔ SOL — 2 Hops: EURC/USDC (0.01%) + SOL/USDC (0.04%)',
        hops: [
            { poolId: 'liq-eurc-usdc', address: 'ArisQNcbjXPJD7RgPRvysatX3xcfHPTbcTkfD8kDoZ9i', feeTier: 0.01, correlated: true },
            { poolId: 'liq-sol-usdc',  address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', feeTier: 0.04, correlated: false },
        ],
    },
    'SOL/cbBTC': {
        label: 'cbBTC ↔ SOL — 2 Hops: cbBTC/USDC (0.04%) + SOL/USDC (0.04%)',
        hops: [
            { poolId: 'liq-btc-usdc',  address: 'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM', feeTier: 0.04, correlated: false },
            { poolId: 'liq-sol-usdc',  address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', feeTier: 0.04, correlated: false },
        ],
    },
    'EURC/cbBTC': {
        label: 'EURC ↔ cbBTC — 2 Hops: EURC/USDC (0.01%) + cbBTC/USDC (0.04%)',
        hops: [
            { poolId: 'liq-eurc-usdc', address: 'ArisQNcbjXPJD7RgPRvysatX3xcfHPTbcTkfD8kDoZ9i', feeTier: 0.01, correlated: true },
            { poolId: 'liq-btc-usdc',  address: 'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM', feeTier: 0.04, correlated: false },
        ],
    },
    'SOL/WBTC': {
        label: 'SOL ↔ WBTC — 3 Hops: SOL/USDC + cbBTC/USDC + cbBTC/WBTC (geschätzt)',
        hops: [
            { poolId: 'liq-sol-usdc',   address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', feeTier: 0.04, correlated: false },
            { poolId: 'liq-btc-usdc',   address: 'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM', feeTier: 0.04, correlated: false },
            { poolId: 'liq-cbtc-wbtc',  address: '4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72', feeTier: 0.01, correlated: true },
        ],
    },
    'HYPE/SOL': {
        label: 'HYPE ↔ SOL — direkt (Orca HYPE/SOL 0.30%)',
        hops: [{ poolId: 'liq-hype-sol', address: '31KrYUDzgEQhEgr1JSNVfHAknWACcF97CtUaU8enKQsy', feeTier: 0.30, correlated: false }],
    },
    'HYPE/USDC': {
        label: 'HYPE ↔ USDC — 2 Hops: HYPE/SOL (0.30%) + SOL/USDC (0.04%)',
        hops: [
            { poolId: 'liq-hype-sol',  address: '31KrYUDzgEQhEgr1JSNVfHAknWACcF97CtUaU8enKQsy', feeTier: 0.30, correlated: false },
            { poolId: 'liq-sol-usdc',  address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', feeTier: 0.04, correlated: false },
        ],
    },
    'ORCA/SOL': {
        label: 'ORCA ↔ SOL — direkt (Orca ORCA/SOL 0.16%)',
        hops: [{ poolId: 'liq-orca-sol', address: 'Hxw77h9fEx598afiiZunwHaX3vYu9UskDk9EpPNZp1mG', feeTier: 0.16, correlated: false }],
    },
    'ORCA/USDC': {
        label: 'ORCA ↔ USDC — 2 Hops: ORCA/SOL (0.16%) + SOL/USDC (0.04%)',
        hops: [
            { poolId: 'liq-orca-sol',  address: 'Hxw77h9fEx598afiiZunwHaX3vYu9UskDk9EpPNZp1mG', feeTier: 0.16, correlated: false },
            { poolId: 'liq-sol-usdc',  address: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', feeTier: 0.04, correlated: false },
        ],
    },
};

/** Kanonischer Routen-Schlüssel: Tokens alphabetisch sortiert */
function routeKey(fromToken, toToken) {
    return [fromToken, toToken].sort().join('/');
}

// ─── Pool-Konfiguration ────────────────────────────────────────────────────────
//
// Alle bekannten Pools mit ihren Eigenschaften.
// Ergänzen wenn neue Bots / Pools aktiviert werden.

const POOLS = {
    // ── Liquidity ──────────────────────────────────────────────────────────────────
    'SOL/USDC': {
        bot:        'liquidity',
        id:         'liq-sol-usdc',
        address:    'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE',
        feeTier:    0.04,    // %
        correlated: false,   // volatile pair → niedrigere effektive Tiefe
        tokenA:     'SOL',
        tokenB:     'USDC',
    },
    'cbBTC/USDC': {
        bot:        'liquidity',
        id:         'liq-btc-usdc',
        address:    'HxA6SKW5qA4o12fjVgTpXdq2YnZ5Zv1s7SB4FFomsyLM',
        feeTier:    0.04,
        correlated: false,
        tokenA:     'cbBTC',
        tokenB:     'USDC',
    },
    'EURC/USDC': {
        bot:        'liquidity',
        id:         'liq-eurc-usdc',
        address:    'ArisQNcbjXPJD7RgPRvysatX3xcfHPTbcTkfD8kDoZ9i',
        feeTier:    0.01,
        correlated: true,   // stablecoin pair → hohe effektive Tiefe
        tokenA:     'EURC',
        tokenB:     'USDC',
    },
    'cbBTC/WBTC': {
        bot:        'liquidity',
        id:         'liq-cbtc-wbtc',
        address:    '4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72',
        feeTier:    0.01,
        correlated: true,   // BTC/BTC pair → sehr hohe effektive Tiefe
        tokenA:     'cbBTC',
        tokenB:     'WBTC',
    },
    'ZEC/USDC': {
        bot:        'liquidity',
        id:         'liq-zec-usdc',
        address:    'GTHKH8s82ZR8GTSFZ1dUu6wfdxhy59wpMShxzG5zjiPm',
        feeTier:    0.16,
        correlated: false,   // volatile pair
        tokenA:     'ZEC',
        tokenB:     'USDC',
    },
    'HYPE/SOL': {
        bot:          'liquidity',
        id:           'liq-hype-sol',
        address:      '31KrYUDzgEQhEgr1JSNVfHAknWACcF97CtUaU8enKQsy',
        feeTier:      0.30,
        correlated:   false,  // beide Tokens volatil
        tokenA:       'SOL',
        tokenB:       'HYPE',
        volatilePair: true,
    },
    'ORCA/SOL': {
        bot:          'liquidity',
        id:           'liq-orca-sol',
        address:      'Hxw77h9fEx598afiiZunwHaX3vYu9UskDk9EpPNZp1mG',
        feeTier:      0.16,
        correlated:   false,  // beide Tokens volatil
        tokenA:       'SOL',
        tokenB:       'ORCA',
        volatilePair: true,
    },
};

// ─── Datenbankzugriff ─────────────────────────────────────────────────────────

function openDb(botName) {
    if (!Database) return null;
    const paths = {
        liquiditybot: PATHS.liquidityDb,
    };
    const dbPath = paths[botName];
    if (!dbPath) return null;
    try {
        return Database(dbPath, { readonly: true });
    } catch {
        return null;
    }
}

function getLatestPrice(db, poolId) {
    if (!db) return null;
    return db.prepare(`
        SELECT price, recorded_at FROM pool_stats
        WHERE pool_id = ?
        ORDER BY recorded_at DESC LIMIT 1
    `).get(poolId)?.price ?? null;
}

function getCachedTvl(db, poolId) {
    if (!db) return null;
    return db.prepare(`
        SELECT tvl_usd, recorded_at FROM pool_stats
        WHERE pool_id = ? AND tvl_usd IS NOT NULL
        ORDER BY recorded_at DESC LIMIT 1
    `).get(poolId)?.tvl_usd ?? null;
}

function getOpenPosition(db, poolId) {
    if (!db) return null;
    return db.prepare(`
        SELECT capital_usdc, price_lower, price_upper
        FROM positions
        WHERE pool_id = ? AND close_tx IS NULL
        ORDER BY opened_at DESC LIMIT 1
    `).get(poolId) ?? null;
}

function getPositionSnapshot(db, poolId) {
    if (!db) return null;
    return db.prepare(`
        SELECT lp_value_usd, amount_a, amount_b
        FROM position_snapshots
        WHERE pool_id = ?
        ORDER BY recorded_at DESC LIMIT 1
    `).get(poolId) ?? null;
}

// ─── CLMM Deposit-Ratio ───────────────────────────────────────────────────────
//
// Berechnet die benötigte TokenB-Menge (USDC) für einen gegebenen TokenA-Betrag,
// basierend auf der aktuellen Preisposition innerhalb der LP-Range.
//
// Formel (Uniswap V3 / Orca Whirlpools):
//   ratio_B_per_A = (sqrt(P) - sqrt(Pa)) × sqrt(P) × sqrt(Pb) / (sqrt(Pb) - sqrt(P))
//
// Wobei P = aktueller Preis, Pa = untere Range-Grenze, Pb = obere Range-Grenze.
// Gilt nur wenn Pa < P < Pb (Preis innerhalb der Range).

function calcDepositRatio(amountA, currentPrice, priceLower, priceUpper) {
    if (currentPrice <= priceLower) {
        // Preis unter Range → Position besteht zu 100% aus TokenA, kein TokenB nötig
        return { requiredB: 0, totalUsdcValue: amountA * currentPrice, outOfRange: 'below' };
    }
    if (currentPrice >= priceUpper) {
        // Preis über Range → Position besteht zu 100% aus TokenB (USDC), kein TokenA nötig
        return { requiredB: null, totalUsdcValue: null, outOfRange: 'above' };
    }

    const sqrtP  = Math.sqrt(currentPrice);
    const sqrtPa = Math.sqrt(priceLower);
    const sqrtPb = Math.sqrt(priceUpper);

    // USDC pro TokenA bei aktuellem Preis und Range
    const ratioUsdcPerTokenA = (sqrtP - sqrtPa) * sqrtP * sqrtPb / (sqrtPb - sqrtP);
    const requiredB           = amountA * ratioUsdcPerTokenA;
    const totalUsdcValue      = amountA * currentPrice + requiredB;

    // Anteil TokenA am Gesamtwert (0% = alles USDC, 100% = alles TokenA)
    const tokenASharePct = (amountA * currentPrice) / totalUsdcValue * 100;

    return { requiredB, totalUsdcValue, tokenASharePct, outOfRange: null };
}

// ─── Wallet-SOL-Balance ───────────────────────────────────────────────────────

async function getWalletSolBalance() {
    try {
        const fs      = await import('node:fs');
        const envPath = join(FORGE_ROOT, 'bots', 'liquidity', '.env');
        const envText = fs.readFileSync(envPath, 'utf8');

        // RPC-URL
        const rpcMatch = envText.match(/^RPC_URL\s*=\s*(.+)$/m);
        const rpcUrl   = rpcMatch?.[1]?.trim() ?? 'http://127.0.0.1:3100/rpc';

        const { Keypair, Connection, LAMPORTS_PER_SOL } =
            require(join(FORGE_ROOT, 'bots', 'liquidity', 'node_modules', '@solana', 'web3.js'));

        // Keypair: entweder direkt als Key-String oder als Pfad zu einer Datei
        let keypair;
        const keyPathMatch = envText.match(/^KEYPAIR_PATH\s*=\s*(.+)$/m);
        const keyRawMatch  = envText.match(/^WALLET_PRIVATE_KEY\s*=\s*(.+)$/m);

        const bs58mod = require(join(FORGE_ROOT, 'bots', 'liquidity', 'node_modules', 'bs58'));
        const bs58    = bs58mod.default ?? bs58mod;

        const decodeKey = (raw) => {
            try   { return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw))); }
            catch { return Keypair.fromSecretKey(bs58.decode(raw)); }
        };

        if (keyPathMatch) {
            const raw = fs.readFileSync(keyPathMatch[1].trim(), 'utf8').trim();
            keypair = decodeKey(raw);
        } else if (keyRawMatch) {
            keypair = decodeKey(keyRawMatch[1].trim());
        } else {
            return null;
        }

        const connection = new Connection(rpcUrl, 'confirmed');
        const lamports   = await connection.getBalance(keypair.publicKey);
        return lamports / LAMPORTS_PER_SOL;
    } catch {
        return null;
    }
}

// ─── Live-TVL von Orca API ────────────────────────────────────────────────────

async function fetchLiveTvl(poolAddress) {
    try {
        const url = `https://api.orca.so/v2/solana/pools/${poolAddress}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
        if (!res.ok) return null;
        const json = await res.json();
        const pool = json?.data ?? json;
        const tvl  = parseFloat(pool?.tvl ?? pool?.tvlUsdc ?? 0);
        return tvl > 0 ? tvl : null;
    } catch {
        return null;
    }
}

// ─── Slippage-Modell ─────────────────────────────────────────────────────────
//
// Näherungsformel für CLMM Price Impact:
//   slippage_pct ≈ swap_amount / (TVL × depth_factor) × 100
//
// depth_factor:
//   - Volatile Pairs (SOL/USDC, BTC/USDC): 2
//     Liquidität ist über breitere Tick-Range verteilt → geringere Tiefe pro %
//   - Korrelierte Pairs (EURC/USDC, cbBTC/WBTC): 10
//     Liquidität extrem konzentriert in ±0.5–2% Range → sehr hohe Tiefe
//
// Beispiel SOL/USDC: $262 Swap / ($32.5M × 2) × 100 = 0.0004% → ~$0.001
// Beispiel cbBTC/WBTC: $250 Swap / ($1.3M × 10) × 100 = 0.002% → ~$0.005

function estimateSlippage(swapAmount, tvl, correlated) {
    if (!tvl || tvl <= 0 || swapAmount <= 0) return null;
    const depthFactor = correlated ? 10 : 2;
    const pct = (swapAmount / (tvl * depthFactor)) * 100;
    return {
        pct:     Math.round(pct * 10_000) / 10_000,   // 4 Dezimalstellen
        usd:     Math.round(swapAmount * pct / 100 * 100) / 100,
    };
}

// ─── Kostenberechnung pro Aktion ─────────────────────────────────────────────

function calcCosts({ action, pool, poolName, capital, amount, amountA, currentPrice, position, solPrice, tvl }) {
    // Wenn --amount-a angegeben: Ratio berechnen und effectiveCapital daraus ableiten
    let ratioInfo = null;
    if (amountA != null && action === 'deposit' && currentPrice != null && position?.price_lower != null) {
        ratioInfo = calcDepositRatio(amountA, currentPrice, position.price_lower, position.price_upper);
        // totalUsdcValue als effectiveCapital verwenden (für TX-Kosten-Berechnung)
        if (ratioInfo.totalUsdcValue != null) {
            amount = ratioInfo.totalUsdcValue;
        }
    }

    const effectiveCapital = amount ?? capital ?? null;
    let txCount     = TX_COUNT[action];
    let txFeeUsd    = Math.round(txCount * SOL_PER_TX * solPrice * 10_000) / 10_000;

    let swapAmount   = 0;
    let protocolFee  = 0;
    let slippage     = null;
    const notes      = [];
    let unknown      = [];

    switch (action) {

        case 'rebalance':
            // Out-of-Range: Position hält 100% eines Tokens → 50% muss geswappt werden
            if (effectiveCapital) {
                swapAmount  = effectiveCapital * 0.5;
                protocolFee = Math.round(swapAmount * (pool.feeTier / 100) * 10_000) / 10_000;
                slippage    = estimateSlippage(swapAmount, tvl, pool.correlated);
                notes.push(`Swap ~50% des Kapitals ($${swapAmount.toFixed(2)}) im ${pool.feeTier}%-Pool`);
            } else {
                unknown.push('Kapital unbekannt → --amount angeben für Swap-Kostenschätzung');
            }
            notes.push('TX-Reihenfolge: collectFees → decreaseLiquidity → close → swap → open');
            break;

        case 'open':
            if (effectiveCapital) {
                swapAmount  = effectiveCapital * 0.5;
                protocolFee = Math.round(swapAmount * (pool.feeTier / 100) * 10_000) / 10_000;
                slippage    = estimateSlippage(swapAmount, tvl, pool.correlated);
                notes.push(`Jupiter-Swap ~50% ($${swapAmount.toFixed(2)}) für Token-Split`);
            } else {
                unknown.push('Kapital unbekannt → --amount angeben');
            }
            break;

        case 'deposit':
            if (VOLATILE_PAIR_POOLS.has(poolName)) {
                // Volatile Pair (z.B. HYPE/SOL): USDC muss in BEIDE Pool-Tokens gesplittet werden
                // Hop A: USDC → tokenA (~50% des Kapitals)  → Route via SWAP_ROUTES
                // Hop B: USDC → tokenB (~50% des Kapitals)  → Route via SWAP_ROUTES (oft Multi-Hop)
                txCount  = 3;  // 2 Swaps + increaseLiquidity (best-case; Multi-Hop kann +1 TX bedeuten)
                txFeeUsd = Math.round(txCount * SOL_PER_TX * solPrice * 10_000) / 10_000;
                if (effectiveCapital) {
                    const halfAmount = effectiveCapital * 0.5;
                    const routeA = SWAP_ROUTES[routeKey('USDC', pool.tokenA)];
                    const feeA   = routeA ? routeA.hops.reduce((s, h) => s + halfAmount * (h.feeTier / 100), 0) : halfAmount * (pool.feeTier / 100);
                    const routeB = SWAP_ROUTES[routeKey('USDC', pool.tokenB)];
                    const feeB   = routeB ? routeB.hops.reduce((s, h) => s + halfAmount * (h.feeTier / 100), 0) : halfAmount * (pool.feeTier / 100);

                    swapAmount  = effectiveCapital;
                    protocolFee = Math.round((feeA + feeB) * 10_000) / 10_000;
                    const slipBase = estimateSlippage(halfAmount, tvl, pool.correlated);
                    slippage = slipBase
                        ? { pct: slipBase.pct * 2, usd: Math.round(slipBase.usd * 2 * 10_000) / 10_000 }
                        : null;
                    notes.push(`Pre-Swap A: $${halfAmount.toFixed(2)} USDC → ${pool.tokenA} (${routeA?.label ?? 'Route unbekannt'})`);
                    notes.push(`Pre-Swap B: $${halfAmount.toFixed(2)} USDC → ${pool.tokenB} (${routeB?.label ?? 'Route unbekannt'})`);
                    notes.push('Slippage als Summe beider Routen veranschlagt.');
                } else {
                    unknown.push('Kapital unbekannt → --amount angeben für Swap-Kostenschätzung');
                }
            } else if (SOL_POOLS.has(poolName) || PRESWAP_POOLS.has(poolName)) {
                // SOL/USDC + ZEC/USDC: ~50% des Betrags muss vorab von USDC → TokenA geswappt werden
                const swapTarget = pool.tokenA;
                txCount  = 2;  // Jupiter-Swap + increaseLiquidity
                txFeeUsd = Math.round(txCount * SOL_PER_TX * solPrice * 10_000) / 10_000;
                if (effectiveCapital) {
                    swapAmount  = effectiveCapital * 0.5;
                    protocolFee = Math.round(swapAmount * (pool.feeTier / 100) * 10_000) / 10_000;
                    slippage    = estimateSlippage(swapAmount, tvl, pool.correlated);
                    notes.push(`Vor-Swap ~50% ($${swapAmount.toFixed(2)}) USDC → ${swapTarget} (Jupiter, ${pool.feeTier}%-Pool)`);
                } else {
                    unknown.push('Kapital unbekannt → --amount angeben für Swap-Kostenschätzung');
                }
            } else {
                // Andere Pools (cbBTC/USDC, EURC/USDC, cbBTC/WBTC): Tokens im Wallet, kein Swap nötig
                notes.push('Kein Swap — Tokens müssen bereits im Wallet in korrekter Ratio vorliegen');
                notes.push('Slippage minimal (nur Token-Ratio-Abweichung durch Tick-Rounding)');
                if (!effectiveCapital) unknown.push('Betrag unbekannt → --amount angeben');
            }
            break;

        case 'close':
        case 'withdraw':
            // Kein Swap: Tokens kommen unkonvertiert zurück
            notes.push('Kein Swap — Tokens werden unkonvertiert zurückgegeben');
            notes.push('Slippage vernachlässigbar (decreaseLiquidity ist rein proportional)');
            break;

        case 'close-reopen':
            // Abhängig davon, ob ein Swap nötig ist:
            // Bei Range-Neuzentrierung um aktuellen Preis → kein Swap nötig
            // Bei starker Preisbewegung → evtl. Swap nötig (wie rebalance)
            notes.push('Kein Swap wenn neue Range um aktuellen Preis zentriert bleibt');
            notes.push('Falls Preis stark außerhalb der neuen Range: wie rebalance kalkulieren');
            if (effectiveCapital) {
                slippage = estimateSlippage(effectiveCapital * 0.01, tvl, pool.correlated);
            }
            break;
    }

    const total = Math.round((txFeeUsd + protocolFee + (slippage?.usd ?? 0)) * 10_000) / 10_000;

    return { txFeeUsd, txCount, swapAmount, protocolFee, slippage, total, notes, unknown, ratioInfo };
}

// ─── Swap-Kostenberechnung ────────────────────────────────────────────────────

async function calcSwapCosts({ fromToken, toToken, amount, solPrice, db }) {
    const key   = routeKey(fromToken, toToken);
    const route = SWAP_ROUTES[key];

    const txFeeUsd = Math.round(TX_COUNT.swap * SOL_PER_TX * solPrice * 10_000) / 10_000;
    const notes    = [];
    const unknown  = [];

    if (!route) {
        return {
            found: false,
            fromToken, toToken, amount, txFeeUsd,
            unknown: [`Keine bekannte Route für ${fromToken} → ${toToken}. Jupiter findet ggf. eine andere Route — Kosten manuell schätzen.`],
        };
    }

    // Pro Hop: Protocol-Fee und Slippage berechnen
    let remainingAmount = amount ?? 0;
    let totalProtocolFee = 0;
    let totalSlippageUsd = 0;
    const hopDetails = [];
    let overallConfidence = 'live';

    for (const hop of route.hops) {
        // TVL für diesen Hop laden
        let tvl       = await fetchLiveTvl(hop.address);
        let tvlSource = 'live';
        if (tvl == null) {
            tvl       = getCachedTvl(db, hop.poolId);
            tvlSource = tvl != null ? 'cached' : 'none';
        }
        if (tvlSource === 'cached' && overallConfidence === 'live') overallConfidence = 'cached';
        if (tvlSource === 'none')  overallConfidence = 'none';

        const fee      = Math.round(remainingAmount * (hop.feeTier / 100) * 10_000) / 10_000;
        const slip     = tvl ? estimateSlippage(remainingAmount, tvl, hop.correlated) : null;

        totalProtocolFee += fee;
        totalSlippageUsd += slip?.usd ?? 0;

        hopDetails.push({
            label:     hop.poolId,
            feeTier:   hop.feeTier,
            fee,
            slip,
            tvl,
            tvlSource,
            amount:    remainingAmount,
        });

        // Nach dem Hop ist der Betrag etwas kleiner (Fee abgezogen)
        remainingAmount = Math.round((remainingAmount - fee) * 10_000) / 10_000;
    }

    if (route.hops.length > 1) {
        notes.push(`Multi-Hop: ${route.hops.length} Pools — TX-Count evtl. ${TX_COUNT.swap + 1}`);
    }
    notes.push(route.label);

    const total = Math.round((txFeeUsd + totalProtocolFee + totalSlippageUsd) * 10_000) / 10_000;

    return {
        found: true,
        fromToken, toToken, amount,
        txFeeUsd, totalProtocolFee, totalSlippageUsd,
        hopDetails, total, notes, unknown,
        confidence: overallConfidence,
    };
}

// ─── Withdraw-and-Swap Berechnung ─────────────────────────────────────────────

async function calcWithdrawAndSwapCosts({ pool, amount, solPrice, btcPrice, db }) {
    const snap = getPositionSnapshot(db, pool.id);
    if (!snap?.lp_value_usd) {
        return { error: 'Kein Positions-Snapshot verfügbar — bitte zuerst den Bot starten.' };
    }

    const posValue = snap.lp_value_usd;
    const fraction = Math.min(amount / posValue, 1.0);
    const amtA     = (snap.amount_a ?? 0) * fraction;
    const amtB     = (snap.amount_b ?? 0) * fraction;

    // USD-Werte der entnommenen Token
    const isBtcPair   = pool.tokenB !== 'USDC' && pool.tokenA !== 'USDC';
    const currentPrice = getLatestPrice(db, pool.id);

    let usdA, usdB;
    if (isBtcPair) {
        usdA = amtA * btcPrice;
        usdB = amtB * btcPrice;
    } else if (pool.tokenB === 'USDC') {
        usdA = currentPrice ? amtA * currentPrice : 0;
        usdB = amtB;  // bereits USDC
    } else {
        usdA = amtA;  // tokenA ist USDC
        usdB = currentPrice ? amtB * currentPrice : 0;
    }

    // Swaps berechnen (nur non-USDC Token)
    const withdrawTxFee = Math.round(SOL_PER_TX * solPrice * 10_000) / 10_000;
    const swaps = [];

    if (pool.tokenA !== 'USDC' && usdA > 0) {
        const swapResult = await calcSwapCosts({ fromToken: pool.tokenA, toToken: 'USDC', amount: usdA, solPrice, db });
        swaps.push({ token: pool.tokenA, amt: amtA, usd: usdA, swapResult });
    }
    if (pool.tokenB !== 'USDC' && usdB > 0) {
        const swapResult = await calcSwapCosts({ fromToken: pool.tokenB, toToken: 'USDC', amount: usdB, solPrice, db });
        swaps.push({ token: pool.tokenB, amt: amtB, usd: usdB, swapResult });
    }

    const swapTxFees    = swaps.length * Math.round(SOL_PER_TX * solPrice * 10_000) / 10_000;
    const totalTxFee    = withdrawTxFee + swapTxFees;
    const totalSwapFee  = swaps.reduce((s, sw) => s + (sw.swapResult.found ? sw.swapResult.totalProtocolFee + sw.swapResult.totalSlippageUsd : 0), 0);
    const totalCosts    = Math.round((totalTxFee + totalSwapFee) * 10_000) / 10_000;
    const netUsdc       = Math.round((amount - totalCosts) * 100) / 100;

    const confidence = swaps.every(sw => sw.swapResult.confidence === 'live')  ? 'live'
                     : swaps.some(sw => sw.swapResult.confidence === 'none')   ? 'none'
                     : 'cached';

    return { posValue, fraction, amtA, amtB, usdA, usdB, isBtcPair, swaps, withdrawTxFee, swapTxFees, totalTxFee, totalSwapFee, totalCosts, netUsdc, confidence };
}

function printWithdrawAndSwapReport({ pool, poolName, amount, result, solPrice, btcPrice }) {
    const W   = 60;
    const SEP = '─'.repeat(W);
    const row = (label, value) => {
        const l = String(label);
        const v = String(value);
        const pad = W - 2 - l.length - v.length;
        return `│ ${l}${' '.repeat(Math.max(1, pad))}${v} │`;
    };

    if (result.error) {
        console.log(`\n⚠ ${result.error}\n`);
        return;
    }

    const btcStr = result.isBtcPair ? ` | BTC $${btcPrice.toFixed(0)}` : '';

    console.log(`┌${SEP}┐`);
    console.log(`│ ${'Kostenabschätzung – Withdraw + Swap zu USDC'.padEnd(W - 2)} │`);
    console.log(`│ ${`Pool: ${poolName}  Anfrage: ${amount.toFixed(2)} USDC`.padEnd(W - 2)} │`);
    console.log(`│ ${`SOL $${solPrice.toFixed(2)}${btcStr} | Positionswert ~${result.posValue.toFixed(2)} USDC`.padEnd(W - 2)} │`);
    console.log(`├${SEP}┤`);

    console.log(`│ ${'Entnahme aus Pool'.padEnd(W - 2)} │`);
    if (result.amtA > 0) {
        console.log(row(`  ~${result.amtA.toFixed(6)} ${pool.tokenA}`, `~$${result.usdA.toFixed(2)} USDC`));
    }
    if (result.amtB > 0) {
        console.log(row(`  ~${result.amtB.toFixed(6)} ${pool.tokenB}`, `~$${result.usdB.toFixed(2)} USDC`));
    }
    console.log(row('  Anteil', `${(result.fraction * 100).toFixed(2)}% der Position`));

    for (const swap of result.swaps) {
        console.log(`├${SEP}┤`);
        if (swap.swapResult.found) {
            const routeNote = swap.swapResult.notes?.find(n => n.includes('↔')) ?? `${swap.token} ↔ USDC`;
            const routeStr  = ('Swap: ' + routeNote.replace('↔', '→')).slice(0, W - 2);
            console.log(`│ ${routeStr.padEnd(W - 2)} │`);
            for (const hop of swap.swapResult.hopDetails) {
                const tvlStr = hop.tvl ? `TVL $${(hop.tvl / 1000).toFixed(0)}K` : 'TVL n/v';
                console.log(row(`  Protokoll-Fee (${hop.feeTier}%, ${tvlStr})`, `$${hop.fee.toFixed(4)} USDC`));
                if (hop.slip) {
                    console.log(row(`  Slippage (est. ${hop.slip.pct.toFixed(4)}%)`, `$${hop.slip.usd.toFixed(4)} USDC`));
                }
            }
        } else {
            console.log(row(`Swap ${swap.token} → USDC`, 'Route nicht modelliert'));
        }
    }

    console.log(`├${SEP}┤`);
    const totalTxs = 1 + result.swaps.length;
    console.log(row(`TX-Fees (${totalTxs} TXs × ${SOL_PER_TX} SOL × $${solPrice.toFixed(0)})`, `$${result.totalTxFee.toFixed(4)} USDC`));
    console.log(`├${SEP}┤`);

    const confidenceStr = result.confidence === 'live'   ? '★★★ HOCH    (Live-TVL)'
                        : result.confidence === 'cached' ? '★★☆ MITTEL  (gecachter TVL)'
                        :                                  '★☆☆ NIEDRIG (kein TVL)';
    console.log(row('Gesamtkosten', `~$${result.totalCosts.toFixed(4)} USDC`));
    console.log(row('NETTO erhalten', `~${result.netUsdc.toFixed(2)} USDC`));
    console.log(row('Konfidenz', confidenceStr));
    console.log(`└${SEP}┘`);
    console.log('  Hinweise:');
    console.log('    • Token-Mengen aus letztem Positions-Snapshot (Näherung)');
    console.log('    • Echte Mengen können leicht abweichen durch Preisentwicklung');
    console.log();
}

// ─── Ausgabe ─────────────────────────────────────────────────────────────────

function printReport({ poolName, pool, action, capital, amount, amountA, currentPrice, costs, solPrice, btcPrice, tvl, tvlSource, walletSol, dataAge = null }) {
    const W   = 60;
    const SEP = '─'.repeat(W);
    const row = (label, value) => {
        const l = String(label);
        const v = String(value);
        const pad = W - 2 - l.length - v.length;
        return `│ ${l}${' '.repeat(Math.max(1, pad))}${v} │`;
    };

    const tvlStr = tvl != null
        ? `$${(tvl / 1_000).toFixed(0)}K${tvlSource === 'cached' ? ' (gecacht)' : ''}`
        : 'n/v';
    const ageStr = dataAge ? ` | Daten: ${dataAge}` : '';

    console.log(`┌${SEP}┐`);
    console.log(`│ ${'Kostenabschätzung'.padEnd(W - 2)} │`);
    console.log(`│ ${`Aktion: ${action.toUpperCase()}  Pool: ${poolName}`.padEnd(W - 2)} │`);
    console.log(`│ ${`SOL $${solPrice.toFixed(2)} | BTC $${btcPrice.toFixed(0)} | TVL ${tvlStr}${ageStr}`.padEnd(W - 2)} │`);
    console.log(`├${SEP}┤`);

    // ── Ratio-Block (nur bei --amount-a) ──────────────────────────────────────
    if (amountA != null && costs.ratioInfo) {
        const ri    = costs.ratioInfo;
        const tA    = pool.tokenA ?? 'TokenA';
        const tB    = pool.tokenB ?? 'TokenB';
        console.log(`├${SEP}┤`);
        console.log(`│ ${'Deposit-Zusammensetzung (--amount-a)'.padEnd(W - 2)} │`);
        if (ri.outOfRange === 'above') {
            console.log(row(`⚠ Preis ÜBER Range`, `nur ${tB} möglich`));
            console.log(row(`  ${tA} nicht einzahlbar`, `Position wäre 100% ${tB}`));
        } else if (ri.outOfRange === 'below') {
            console.log(row(`${amountA} ${tA}`, `100% ${tA} (kein ${tB} nötig)`));
            console.log(row(`Gesamtwert`, `~$${ri.totalUsdcValue.toFixed(2)} USDC`));
        } else {
            const shareA = ri.tokenASharePct?.toFixed(1) ?? '?';
            const shareB = (100 - parseFloat(shareA)).toFixed(1);
            console.log(row(`${amountA} ${tA} einzahlen`, `~$${(amountA * currentPrice).toFixed(2)} USDC`));
            console.log(row(`${ri.requiredB.toFixed(2)} ${tB} beigemischt`, `~$${ri.requiredB.toFixed(2)} USDC`));
            console.log(row(`Gesamtwert Deposit`, `~$${ri.totalUsdcValue.toFixed(2)} USDC`));
            console.log(row(`Ratio (${tA} / ${tB})`, `${shareA}% / ${shareB}%`));
        }
        console.log(`├${SEP}┤`);
    } else {
        const effectiveCapital = amount ?? capital;
        if (effectiveCapital) {
            console.log(row('Kapital / Betrag', `$${effectiveCapital.toFixed(2)} USDC`));
        }
    }

    console.log(row(
        `TX-Fees  (${costs.txCount ?? TX_COUNT[action]} TXs × ${SOL_PER_TX} SOL × $${solPrice.toFixed(0)})`,
        `$${costs.txFeeUsd.toFixed(4)} USDC`
    ));

    if (costs.swapAmount > 0) {
        console.log(row(
            `Swap     ($${costs.swapAmount.toFixed(2)} × ${pool.feeTier}% Fee)`,
            `$${costs.protocolFee.toFixed(4)} USDC`
        ));
        if (costs.slippage) {
            console.log(row(
                `Slippage (est. ${costs.slippage.pct.toFixed(4)}%)`,
                `$${costs.slippage.usd.toFixed(4)} USDC`
            ));
        } else {
            console.log(row('Slippage', 'n/v — TVL nicht verfügbar'));
        }
    }

    console.log(`├${SEP}┤`);
    const confidence = tvlSource === 'live'   ? '★★★ HOCH    (Live-TVL)'
                     : tvlSource === 'cached' ? '★★☆ MITTEL  (gecachter TVL)'
                     :                          '★☆☆ NIEDRIG (kein TVL)';
    console.log(row('GESAMT (geschätzt)', `~$${costs.total.toFixed(4)} USDC`));
    console.log(row('Konfidenz', confidence));
    console.log(`└${SEP}┘`);

    // ── SOL-Reserve-Prüfung ────────────────────────────────────────────────────
    if (SOL_POOLS.has(poolName) && SOL_CONSUMING_ACTIONS.has(action)) {
        const effectiveAmount = amount ?? capital ?? 0;
        // Schätzung: ~50% des Deposit-Betrags wird als SOL benötigt
        const solNeeded  = effectiveAmount * 0.5 / solPrice;
        const solAfter   = walletSol != null ? walletSol - solNeeded : null;
        const solDisplay = walletSol != null ? walletSol.toFixed(4) : 'unbekannt';

        console.log();
        console.log(`  SOL-Reserve-Prüfung (Minimum: ${MIN_SOL_RESERVE} SOL):`);
        console.log(`    Wallet aktuell : ${solDisplay} SOL`);
        console.log(`    Geschätzt nötig: ~${solNeeded.toFixed(4)} SOL (50% des Betrags)`);

        if (walletSol != null) {
            console.log(`    Nach Aktion    : ~${solAfter.toFixed(4)} SOL`);
            if (solAfter < MIN_SOL_RESERVE) {
                const maxSafeUsdc = Math.floor((walletSol - MIN_SOL_RESERVE) * solPrice * 2);
                console.log(`    🚨 WARNUNG: Reserve würde auf ${solAfter.toFixed(4)} SOL fallen — unter Minimum!`);
                console.log(`    💡 Max. sicherer Betrag: ~$${maxSafeUsdc} USDC`);
            } else {
                console.log(`    ✅ Reserve OK (${solAfter.toFixed(4)} SOL > ${MIN_SOL_RESERVE} SOL Minimum)`);
            }
        } else {
            console.log(`    ⚠ SOL-Balance nicht abrufbar — Reserve manuell prüfen!`);
        }
    }

    if (costs.notes.length > 0) {
        console.log('  Hinweise:');
        costs.notes.forEach(n => console.log(`    • ${n}`));
    }
    if (costs.unknown.length > 0) {
        console.log('  ⚠ Unbekannte Größen (Schätzung unvollständig):');
        costs.unknown.forEach(u => console.log(`    ! ${u}`));
    }
    console.log();
}

function printSwapReport(result, solPrice) {
    const W   = 60;
    const SEP = '─'.repeat(W);
    const row = (label, value) => {
        const l = String(label);
        const v = String(value);
        const pad = W - 2 - l.length - v.length;
        return `│ ${l}${' '.repeat(Math.max(1, pad))}${v} │`;
    };

    console.log(`┌${SEP}┐`);
    console.log(`│ ${'Kostenabschätzung'.padEnd(W - 2)} │`);
    console.log(`│ ${`Aktion: SWAP  ${result.fromToken} → ${result.toToken}`.padEnd(W - 2)} │`);
    console.log(`│ ${`SOL $${solPrice.toFixed(2)}`.padEnd(W - 2)} │`);
    console.log(`├${SEP}┤`);

    if (result.amount) {
        console.log(row('Swap-Betrag', `$${result.amount.toFixed(2)} USDC`));
    }
    console.log(row(
        `TX-Fees  (${TX_COUNT.swap} TX × ${SOL_PER_TX} SOL × $${solPrice.toFixed(0)})`,
        `$${result.txFeeUsd.toFixed(4)} USDC`
    ));

    if (result.found && result.hopDetails) {
        for (const [i, hop] of result.hopDetails.entries()) {
            const hopLabel = result.hopDetails.length > 1 ? ` Hop ${i + 1}` : '';
            const tvlStr   = hop.tvl ? `TVL $${(hop.tvl / 1000).toFixed(0)}K` : 'TVL n/v';
            console.log(row(
                `Protokoll-Fee${hopLabel} (${hop.feeTier}%, ${tvlStr})`,
                `$${hop.fee.toFixed(4)} USDC`
            ));
            if (hop.slip) {
                console.log(row(
                    `  Slippage${hopLabel} (est. ${hop.slip.pct.toFixed(4)}%)`,
                    `$${hop.slip.usd.toFixed(4)} USDC`
                ));
            } else {
                console.log(row(`  Slippage${hopLabel}`, 'n/v — kein TVL'));
            }
        }
    }

    console.log(`├${SEP}┤`);

    if (result.found) {
        const confidence = result.confidence === 'live'   ? '★★★ HOCH    (Live-TVL)'
                         : result.confidence === 'cached' ? '★★☆ MITTEL  (gecachter TVL)'
                         :                                  '★☆☆ NIEDRIG (kein TVL)';
        console.log(row('GESAMT (geschätzt)', `~$${result.total.toFixed(4)} USDC`));
        console.log(row('Konfidenz', confidence));
    } else {
        console.log(row('GESAMT', 'unbekannt — Route nicht modelliert'));
        console.log(row('Konfidenz', '★☆☆ NIEDRIG'));
    }
    console.log(`└${SEP}┘`);

    if (result.notes?.length > 0) {
        console.log('  Hinweise:');
        result.notes.forEach(n => console.log(`    • ${n}`));
    }
    if (result.unknown?.length > 0) {
        console.log('  ⚠ Unbekannte Größen:');
        result.unknown.forEach(u => console.log(`    ! ${u}`));
    }
    console.log();
}

// ─── LendingBot: Positions aus data.json laden ───────────────────────────────

function getLbPositions() {
    try {
        const fs      = createRequire(import.meta.url)('node:fs');
        const dataPath = join(FORGE_ROOT, 'html', 'lending', 'data', 'data.json');
        return JSON.parse(fs.readFileSync(dataPath, 'utf8')).positions ?? [];
    } catch {
        return [];
    }
}

// ─── LendingBot: Ausgabe ─────────────────────────────────────────────────────

function printLbReport({ protocolId, proto, action, amount, solPrice, position }) {
    const W   = 60;
    const SEP = '─'.repeat(W);
    const row = (label, value) => {
        const l = String(label);
        const v = String(value);
        const pad = W - 2 - l.length - v.length;
        return `│ ${l}${' '.repeat(Math.max(1, pad))}${v} │`;
    };

    const fmtUsdc = v => `${v.toFixed(4)} USDC`;
    const r4      = v => Math.round(v * 10_000) / 10_000;

    // TX-Kosten berechnen
    const txsImmediate = 1;
    const txsCooldown  = 2;   // initiate + complete
    const feeImmediate = r4(txsImmediate * proto.feeSol * solPrice);
    const feeCooldown  = r4(txsCooldown  * proto.feeSol * solPrice);

    console.log(`┌${SEP}┐`);
    console.log(`│ ${'Kostenabschätzung – LendingBot'.padEnd(W - 2)} │`);
    console.log(`│ ${`Aktion: ${action.toUpperCase()}  Protokoll: ${proto.label}`.padEnd(W - 2)} │`);
    console.log(`│ ${`SOL $${solPrice.toFixed(2)}`.padEnd(W - 2)} │`);
    console.log(`├${SEP}┤`);

    if (amount != null) {
        console.log(row('Betrag', `${amount.toFixed(2)} USDC`));
    }

    // Aktuelle Position aus data.json anzeigen
    if (position) {
        console.log(row('Position aktuell', `${position.amount.toFixed(2)} USDC`));
        console.log(row('  davon investiert', `${position.netInvested.toFixed(2)} USDC`));
        console.log(row('  davon Yield', `${position.accruedYield.toFixed(4)} USDC`));
        if (action === 'withdraw' && amount != null) {
            const remaining = position.amount - amount;
            console.log(row('Position danach (ca.)', `${remaining.toFixed(2)} USDC`));
        }
        if (action === 'deposit' && amount != null) {
            const newTotal = position.amount + amount;
            console.log(row('Position danach (ca.)', `${newTotal.toFixed(2)} USDC`));
        }
    }

    console.log(`├${SEP}┤`);
    console.log(`│ ${'TX-Kosten'.padEnd(W - 2)} │`);

    if (proto.cooldown === false) {
        // Kein Cooldown – immer sofortige TX
        console.log(row(
            `  ${txsImmediate} TX × ${proto.feeSol} SOL × $${solPrice.toFixed(0)}`,
            fmtUsdc(feeImmediate)
        ));
        console.log(`├${SEP}┤`);
        console.log(row('GESAMT', fmtUsdc(feeImmediate)));
        console.log(row('Konfidenz', '★★★ HOCH  (feste TX-Gebühr, kein Swap)'));
    } else {
        // Loopscale: immediate oder 7-Tage-Cooldown – erst bei TX-Ausführung bekannt
        console.log(row(`  Sofort  (1 TX × ${proto.feeSol} SOL × $${solPrice.toFixed(0)})`, fmtUsdc(feeImmediate)));
        console.log(row(`  Cooldown (2 TX × ${proto.feeSol} SOL × $${solPrice.toFixed(0)})`, fmtUsdc(feeCooldown)));
        console.log(`├${SEP}┤`);
        console.log(row('GESAMT sofort / Cooldown', `${fmtUsdc(feeImmediate)} / ${fmtUsdc(feeCooldown)}`));
        console.log(row('Konfidenz', '★★★ HOCH  (feste TX-Gebühr, kein Swap)'));
        console.log(`└${SEP}┘`);
        console.log('  Hinweise:');
        console.log('    • Loopscale entscheidet bei TX-Ausführung ob sofort oder Cooldown');
        console.log('    • Cooldown: 7 Tage bis Geld im Wallet verfügbar');
        console.log();
        return;
    }

    console.log(`└${SEP}┘`);
    if (proto.cooldown === false) {
        console.log('  Hinweise:');
        console.log('    • Kein Swap, keine Slippage – reine TX-Gebühr');
    }
    console.log();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
    options: {
        action:   { type: 'string' },
        pool:     { type: 'string' },
        amount:   { type: 'string' },
        'amount-a': { type: 'string' },  // TokenA-Menge (z.B. cbBTC) statt USDC
        from:     { type: 'string' },
        to:       { type: 'string' },
        bot:      { type: 'string' },
        json:     { type: 'boolean', default: false },
    },
    strict: false,
});

const jsonMode = args.json;
const jsonResults = [];   // wenn jsonMode: pro Pool ein cost-Objekt sammeln

// ── Bot-Validierung ────────────────────────────────────────────────────────────
// Bekannte Bots mit konfiguriertem Kostenmodell im Script.
// Neue Bots hier eintragen wenn sie im Script vollständig modelliert sind.
const CONFIGURED_BOTS = ['liquiditybot', 'lendingbot', 'lb'];

if (args.bot && !CONFIGURED_BOTS.includes(args.bot.toLowerCase())) {
    console.error([
        '',
        `⚠️  LÜCKE: Bot "${args.bot}" ist in estimate-costs.js nicht konfiguriert.`,
        '',
        '   Das Script würde sonst stillschweigend Liquidity-Daten verwenden — das wäre',
        `   ein falsches Kostenmodell für "${args.bot}" und damit irreführend.`,
        '',
        '   Was jetzt zu tun ist (gemäß FORGE/CLAUDE.md):',
        `   1. Frage im ${args.bot}-Projekt-Chat stellen — dort ist der Kontext korrekt geladen`,
        '   2. Lücke melden → Script ggf. um diesen Bot erweitern',
        '',
        `   Konfigurierte Bots: ${CONFIGURED_BOTS.join(' | ')}`,
        '',
    ].join('\n'));
    process.exit(1);
}

if (!args.action) {
    console.error([
        'Verwendung: node FORGE/bin/estimate-costs.js --action <aktion> [--pool <paar>] [--amount <usdc>]',
        '            node FORGE/bin/estimate-costs.js --action swap --from <token> --to <token> [--amount <usdc>]',
        '',
        'Aktionen:  rebalance | deposit | open | close | withdraw | close-reopen | swap',
        'Pools:     "SOL/USDC" | "cbBTC/USDC" | "EURC/USDC" | "cbBTC/WBTC" | "ZEC/USDC" | "HYPE/SOL"',
        'Tokens:    SOL | USDC | EURC | cbBTC | WBTC | ZEC | HYPE',
        '',
        'Ohne --pool: Schätzung für alle bekannten Liquidity-Pools.',
    ].join('\n'));
    process.exit(1);
}

const action = args.action.toLowerCase().replace('_', '-');
if (!TX_COUNT[action]) {
    console.error(`Unbekannte Aktion: "${action}"\nBekannt: ${Object.keys(TX_COUNT).join(' | ')}`);
    process.exit(1);
}

const amount  = args.amount     ? parseFloat(args.amount)      : null;
const amountA = args['amount-a'] ? parseFloat(args['amount-a']) : null;

// Datenbank öffnen (Liquidity als primäre Quelle)
const db = openDb('liquiditybot');

// Preise ermitteln
const solPrice  = getLatestPrice(db, 'liq-sol-usdc') ?? FALLBACK_SOL_PRICE;
const btcPrice  = getLatestPrice(db, 'liq-btc-usdc') ?? FALLBACK_BTC_PRICE;

// Wallet-SOL für Reserve-Prüfung (nur wenn SOL-relevante Aktion)
const needsSolCheck = !args.pool || SOL_POOLS.has(args.pool);
const walletSol     = needsSolCheck ? await getWalletSolBalance() : null;

// ── Swap-Aktion ────────────────────────────────────────────────────────────────
if (action === 'swap') {
    if (!args.from || !args.to) {
        console.error('Für --action swap sind --from <token> und --to <token> erforderlich.');
        console.error('Bekannte Tokens: SOL | USDC | EURC | cbBTC | WBTC | ZEC | HYPE');
        process.exit(1);
    }
    const fromToken = normalizeToken(args.from);
    const toToken   = normalizeToken(args.to);

    const result = await calcSwapCosts({ fromToken, toToken, amount, solPrice, db });
    printSwapReport(result, solPrice);

    if (db) db.close();
    process.exit(0);
}

// ── LendingBot-Aktionen ────────────────────────────────────────────────────────
if (args.bot && ['lendingbot', 'lb'].includes(args.bot.toLowerCase())) {
    const lbAction = action === 'deposit' || action === 'withdraw' ? action : null;
    if (!lbAction) {
        console.error(`LendingBot unterstützt nur: deposit | withdraw\nAngegeben: "${action}"`);
        process.exit(1);
    }
    if (!args.pool) {
        console.error([
            'Für --bot lendingbot ist --pool <protokoll> erforderlich.',
            `Bekannte Protokolle: ${Object.keys(LB_PROTOCOLS).join(' | ')}`,
        ].join('\n'));
        process.exit(1);
    }
    const protocolId = args.pool.toLowerCase();
    const proto      = LB_PROTOCOLS[protocolId];
    if (!proto) {
        console.error(`Unbekanntes LendingBot-Protokoll: "${args.pool}"\nBekannt: ${Object.keys(LB_PROTOCOLS).join(' | ')}`);
        process.exit(1);
    }

    // Aktuelle Position aus data.json laden
    const lbPositions = getLbPositions();
    const position    = lbPositions.find(p => p.protocol === protocolId) ?? null;

    printLbReport({ protocolId, proto, action: lbAction, amount, solPrice, position });
    if (db) db.close();
    process.exit(0);
}

// ── Withdraw-and-Swap ──────────────────────────────────────────────────────────
if (action === 'withdraw-and-swap') {
    if (!args.pool) {
        console.error('Für --action withdraw-and-swap ist --pool <paar> erforderlich.');
        process.exit(1);
    }
    const wsPool = POOLS[args.pool];
    if (!wsPool) {
        console.error(`Unbekannter Pool: "${args.pool}"\nBekannt: ${Object.keys(POOLS).join(' | ')}`);
        process.exit(1);
    }
    if (!amount) {
        console.error('Für --action withdraw-and-swap ist --amount <usdc> erforderlich.');
        process.exit(1);
    }
    const wsResult = await calcWithdrawAndSwapCosts({ pool: wsPool, amount, solPrice, btcPrice, db });
    printWithdrawAndSwapReport({ pool: wsPool, poolName: args.pool, amount, result: wsResult, solPrice, btcPrice });
    if (db) db.close();
    process.exit(0);
}

// ── Pool-Aktionen ──────────────────────────────────────────────────────────────
const specifiedPool = args.pool ? POOLS[args.pool] : null;
if (args.pool && !specifiedPool) {
    console.error(`Unbekannter Pool: "${args.pool}"\nBekannt: ${Object.keys(POOLS).join(' | ')}`);
    process.exit(1);
}

// Pools bestimmen
const poolEntries = specifiedPool
    ? [[args.pool, specifiedPool]]
    : Object.entries(POOLS);

// Pro Pool: TVL laden und Kosten berechnen
for (const [poolName, pool] of poolEntries) {
    // Position aus DB
    const position     = getOpenPosition(db, pool.id);
    const capital      = position?.capital_usdc ?? null;
    const currentPrice = getLatestPrice(db, pool.id);

    // TVL: live → gecacht → null
    let tvl       = await fetchLiveTvl(pool.address);
    let tvlSource = 'live';
    if (tvl == null) {
        tvl       = getCachedTvl(db, pool.id);
        tvlSource = tvl != null ? 'cached' : 'none';
    }

    const costs = calcCosts({ action, pool, poolName, capital, amount, amountA, currentPrice, position, solPrice, tvl });

    if (jsonMode) {
        jsonResults.push({
            poolName, action, capital, amount, amountA, currentPrice,
            solPrice, btcPrice, tvl, tvlSource, walletSol,
            costs,
        });
    } else {
        printReport({ poolName, pool, action, capital, amount, amountA, currentPrice, costs, solPrice, btcPrice, tvl, tvlSource, walletSol });
    }
}

if (jsonMode) {
    // Genau ein Pool angefragt → flach ausgeben; sonst Array
    const out = jsonResults.length === 1 ? jsonResults[0] : { pools: jsonResults };
    console.log(JSON.stringify(out));
}

if (db) db.close();
