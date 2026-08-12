# Security Policy

FORGE public manages real funds and holds your Solana private keys locally on
your own machine. If you find a security issue — especially anything that
could put a user's keys or funds at risk — please report it responsibly
instead of opening a public GitHub issue.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository
(**Security** tab → **Report a vulnerability**). This opens a private
conversation with the maintainer that isn't visible to the public until a
fix is out.

Please include, as far as you can:

- What the issue is and what it affects (e.g. key handling, the auto-update
  mechanism, a specific bot's transaction logic)
- Steps to reproduce, or a proof of concept
- What you think the impact is (e.g. "an attacker could drain the wallet",
  "an attacker could install unsigned code")

## What we consider in scope

- Anything that could expose or leak a private key, seed phrase, or API key
- Anything that could let an attacker move funds without the wallet owner's
  action
- Anything that could bypass the signature/verification checks in the
  auto-update mechanism (`bin/update-check.js`, `lib/update-verify.js`)
- Anything that could let a malicious pool/token cause unintended fund loss

## What's out of scope

- Issues that require the attacker to already have local shell access to the
  machine FORGE public runs on, or your `local/secrets` directory
- Findings against third-party services FORGE public talks to (Solana RPC
  providers, Jupiter, Orca, lending protocols) — please report those directly
  to the relevant project
- Missing hardening that doesn't lead to a concrete exploit (e.g. "this could
  theoretically be safer") — feel free to raise these as a normal issue

## Response

This is currently maintained by a single person, not a company security team.
There's no guaranteed response time, but real fund-safety issues get
priority. Thank you for reporting responsibly rather than exploiting or
publishing first.
