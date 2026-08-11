# FORGE.pub

> Deutsche Fassung: [README.de.md](README.de.md)

**Automated DEX Trading.**

FORGE.pub manages liquidity positions and lending deposits for you,
automatically, around the clock — so you don't have to sit in front of a
chart reacting to every price move yourself. It happens to run self-hosted,
on your own machine.

It's a reduced, public fork of FORGE — the trading engine explained in the
novel [Der EXPLOIT](https://uag.de/buch/der-exploit/) (see [AUTHORS](AUTHORS)
for why this project is published under the name "Robert Winter").

## Why FORGE.pub

Concentrated liquidity (CLMM, e.g. on Orca) earns noticeably higher fees than
classic AMM pools — but only as long as the price stays inside the chosen
range. Once it drifts out, the position stops earning fees and sits idle
until someone re-centers it by hand. Anyone doing this seriously either needs
to watch the charts constantly, or hands their capital — and keys — to
someone else's backend. FORGE.pub closes exactly that gap: it automates the
parts that would otherwise demand your attention, so your capital keeps
working without you having to.

## What FORGE.pub does

- **Liquidity Bot** — opens and manages concentrated-liquidity (CLMM)
  positions on Orca. Automatically adjusts the price range whenever it
  drifts (rebalancing), optionally reinvests earned fees automatically
  (autocompounding), and can optionally auto-invest into pools the scoring
  currently rates as promising. Multi-layer risk management: TVL
  monitoring, a trailing stop, and scoring-based protection automatically
  pull invested capital out of a pool once it deteriorates, and can
  optionally also swap the tokens back into USDC.
- **Lending Bot** — invests USDC automatically or manually into lending
  protocols (Kamino, Jupiter Lend, Loopscale, Drift), either into whichever
  pool currently yields best or one you pick yourself, and tracks yield
  across all of them.
- **A local dashboard** to watch positions, PnL, and yield — reachable only
  inside your own network, never exposed to the internet.
- **Self-hosted on your own hardware** — runs entirely on your own machine,
  no cloud dependency. A mini PC with 4 CPU cores, 4 GB RAM, and roughly
  256 GB of storage behind your own router is plenty. No port forwarding to
  the machine FORGE runs on is required: FORGE.pub is never contacted from
  outside, all connections (RPC, exchange APIs) are strictly outbound — so
  your private key never leaves your home. The only requirement is a
  working internet connection.

## What FORGE.pub is not

- It is **not a hosted service** — your keys, your database, your machine.
  There is no cloud component required to run it.
- It is **not financial advice** and comes with no guarantee of profit.
  Liquidity mining and lending both carry real risk of capital loss.
- It is **not the full FORGE codebase** — this is a reduced fork; some
  scoring/ranking logic that FORGE uses internally is deliberately not part
  of this public version (see "Free vs. optional data tier" below).

## Free vs. optional data tier

Everything needed to run both bots — opening/closing positions, rebalancing,
the trailing stop, and the TVL-drop protection — is free and works fully
offline from any third-party data feed.

An optional paid data tier (pool scoring/ranking based on server-side
calculated data) is operated by an independent external provider and is not
provided by the author. It is disabled by default; the bots work completely
without it.

## Requirements

- Linux — developed and tested on **Ubuntu 24.04 LTS**. Other Debian-based
  distributions will very likely work but haven't been verified.
- Node.js 22+
- A small VM or machine is enough — successfully tested on 2 cores / 2 GB
  RAM; 4 cores / 4 GB is more comfortable, especially during installation
  (native dependency compilation is the heaviest part).
- **Two API keys are required — the installer cannot complete without
  both:**
  - A Solana RPC provider API key, e.g. from [Helius](https://www.helius.dev/)
    (free tier available)
  - A Jupiter API key from the [Jupiter API Portal](https://portal.jup.ag/)
    (free tier available)

## Installation

> **Before you start:** have both API keys from the section above ready —
> the installer will ask for them and cannot finish without them.

```bash
mkdir forge-pub && cd forge-pub
curl -fsSL https://github.com/robert-winter-dev/forge-pub/releases/latest/download/current.tar.gz | tar xz
sudo bash install.sh
```

The installer walks you through API keys, wallet setup (generate a new one
or import an existing one), and TLS for the local dashboard. Nothing is
sent anywhere except the RPC/API providers you configure yourself.

Updating an existing installation:

```bash
sudo bin/setup.sh update
```

FORGE.pub also checks for new signed releases automatically; by default it
only notifies you and waits for confirmation before installing anything.

## License and security

- Licensed under the [Apache License 2.0](LICENSE).
- Found a security issue, especially anything touching keys or funds? Please
  read [SECURITY.md](SECURITY.md) before opening a public issue.
