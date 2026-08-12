# FORGE public

> English version: [README.md](README.md)

**Automated DEX Trading.**

FORGE public verwaltet Liquiditätspositionen und Lending-Einlagen für dich —
automatisch, rund um die Uhr. Du musst nicht vor einem Chart sitzen und auf
jede Preisbewegung selbst reagieren. Dass das Ganze self-hosted auf deiner
eigenen Maschine läuft, ist dabei Mittel zum Zweck, nicht das Verkaufsargument.

FORGE public ist ein reduzierter, öffentlicher Fork von FORGE — der
Trading-Engine aus dem Roman [Der EXPLOIT](https://uag.de/buch/der-exploit/)
(warum dieses Projekt unter dem Namen „Robert Winter" veröffentlicht wird,
erklärt die [AUTHORS](AUTHORS)-Datei).

## Warum FORGE public

Konzentrierte Liquidität (CLMM, z.B. auf Orca) verdient spürbar höhere
Gebühren als klassische AMM-Pools — aber nur, solange der Preis innerhalb der
gewählten Range bleibt. Läuft er hinaus, verdient die Position nichts mehr und
liegt brach, bis jemand sie von Hand neu zentriert. Wer das ernsthaft
betreibt, muss entweder ständig auf die Charts schauen — oder gibt sein
Kapital samt Schlüsseln in das Backend eines Fremden. Genau diese Lücke
schließt FORGE public: Es automatisiert die Arbeit, die sonst deine
Aufmerksamkeit verlangt, damit dein Kapital ohne dich weiterarbeitet.

## Was FORGE public macht

- **Liquidity Bot** — eröffnet und verwaltet CLMM-Positionen
  (Concentrated Liquidity) auf Orca. Passt die Preis-Range automatisch an,
  wenn der Preis hinausläuft (Rebalancing), reinvestiert verdiente Gebühren
  auf Wunsch automatisch (Autocompounding) und kann optional automatisch in
  Pools investieren, die das Scoring aktuell als aussichtsreich bewertet.
  Mehrstufiges Risikomanagement: TVL-Überwachung, ein Trailing Stop und
  Scoring-basierter Schutz ziehen investiertes Kapital automatisch aus einem
  Pool ab, sobald er sich verschlechtert — auf Wunsch inklusive Rücktausch
  der Token in USDC.
- **Lending Bot** — legt USDC automatisch oder manuell in
  Lending-Protokollen an (Kamino, Jupiter Lend, Loopscale, Drift), wahlweise
  in den aktuell ertragreichsten Pool oder einen selbst gewählten, und
  verfolgt die Erträge über alle Protokolle hinweg.
- **Ein lokales Dashboard** für Positionen, PnL und Erträge — erreichbar nur
  im eigenen Netzwerk, niemals aus dem Internet.
- **Self-hosted auf eigener Hardware** — läuft vollständig auf deiner
  eigenen Maschine, ohne Cloud-Abhängigkeit. Ein Mini-PC mit 4 CPU-Kernen,
  4 GB RAM und rund 256 GB Speicher hinter dem eigenen Router reicht völlig.
  Eine Portfreigabe zur FORGE-Maschine ist nicht nötig: FORGE public wird nie
  von außen kontaktiert, alle Verbindungen (RPC, Börsen-APIs) gehen streng
  nur nach draußen — dein Private Key verlässt dein Zuhause also nie.
  Einzige Voraussetzung ist eine funktionierende Internetverbindung.

## Was FORGE public nicht ist

- Es ist **kein gehosteter Dienst** — deine Schlüssel, deine Datenbank,
  deine Maschine. Es gibt keine Cloud-Komponente, die zum Betrieb nötig wäre.
- Es ist **keine Finanzberatung** und kommt ohne Gewinngarantie. Liquidity
  Mining und Lending tragen beide ein echtes Risiko von Kapitalverlust.
- Es ist **nicht die vollständige FORGE-Codebasis** — dies ist ein
  reduzierter Fork; ein Teil der Scoring-/Ranking-Logik, die FORGE intern
  nutzt, ist bewusst nicht Teil dieser öffentlichen Version (siehe
  „Kostenlos vs. optionaler Datendienst").

## Kostenlos vs. optionaler Datendienst

Alles, was zum Betrieb beider Bots nötig ist — Positionen öffnen und
schließen, Rebalancing, Trailing Stop, TVL-Einbruchschutz — ist kostenlos
und funktioniert vollständig ohne fremde Datenzulieferung.

Ein optionaler, kostenpflichtiger Datendienst (Pool-Scoring/-Ranking auf
Basis serverseitig berechneter Daten) wird von einem unabhängigen externen
Anbieter betrieben und ist nicht Teil des Angebots des Autors. Er ist
standardmäßig deaktiviert; die Bots arbeiten komplett ohne ihn.

## Voraussetzungen

- Linux — entwickelt und getestet auf **Ubuntu 24.04 LTS**. Andere
  Debian-basierte Distributionen funktionieren sehr wahrscheinlich, sind
  aber nicht verifiziert.
- Node.js 22+
- Eine kleine VM oder Maschine genügt — erfolgreich getestet mit 2 Kernen /
  2 GB RAM; 4 Kerne / 4 GB sind komfortabler, vor allem während der
  Installation (das Kompilieren nativer Abhängigkeiten ist der schwerste
  Teil).
- **Zwei API-Keys sind Pflicht — ohne beide kann der Installer nicht
  fertig werden:**
  - Ein API-Key eines Solana-RPC-Anbieters, z.B. von
    [Helius](https://www.helius.dev/) (kostenloser Tarif verfügbar)
  - Ein Jupiter-API-Key aus dem
    [Jupiter API Portal](https://portal.jup.ag/) (kostenloser Tarif
    verfügbar)

## Installation

> **Bevor du startest:** Halte beide API-Keys aus dem Abschnitt oben
> bereit — der Installer fragt danach und kann ohne sie nicht abschließen.

```bash
mkdir forge-pub && cd forge-pub
curl -fsSL https://github.com/robert-winter-dev/forge-pub/releases/latest/download/current.tar.gz | tar xz
sudo bash install.sh
```

Der Installer führt dich durch API-Keys, Wallet-Einrichtung (neu erzeugen
oder bestehendes importieren) und TLS für das lokale Dashboard. Es wird
nichts irgendwohin gesendet außer an die RPC-/API-Anbieter, die du selbst
konfigurierst.

Eine bestehende Installation aktualisieren:

```bash
sudo bin/setup.sh update
```

FORGE public prüft außerdem automatisch auf neue signierte Releases;
standardmäßig meldet es sie nur und wartet auf deine Bestätigung, bevor
irgendetwas installiert wird.

## Lizenz und Sicherheit

- Lizenziert unter der [Apache License 2.0](LICENSE).
- Sicherheitsproblem gefunden, besonders rund um Schlüssel oder Guthaben?
  Bitte lies [SECURITY.md](SECURITY.md), bevor du ein öffentliches Issue
  eröffnest.
