# justPIXIT Studio

Klantopvolging en online afspraken voor justPIXIT, als eigen webapp op https://studio.justpixit.be.

- **`/app`** – jouw beheeromgeving (met wachtwoord): Vandaag, Pipeline, Klanten (fiche, planning, offerte, logboek), Beheer.
- **`/afspraak`** – publieke boekingspagina (je eigen "Calendly"). Een boeking maakt automatisch een klant aan in de fase *Kennismaking ingepland*.
- Geen database-server en geen externe pakketten: enkel Node.js. Alle data staat in de map `data/` naast de compose-file.

```
.
├── server/                 Node.js-server (index.js, boeking.js, store.js, smtp.js)
├── public/                 app.html (beheer) en afspraak.html (boeken)
├── Dockerfile              node:22-alpine, luistert op poort 80
├── compose.hostinger.yml   productie: image van GHCR + Traefik-labels (hostmodus)
├── compose.local.yml       lokaal testen op http://localhost:8080
├── .github/workflows/      bouwt bij elke push op main de image ghcr.io/nickb-vtiz/studio:latest
├── .env.example            instellingen (kopieer naar .env)
└── update.sh · restart.sh · backup.sh · logs.sh
```

## 1. Hoe de deploy werkt

1. Je pusht naar `main`.
2. GitHub Actions bouwt de Docker-image en publiceert ze als `ghcr.io/nickb-vtiz/studio:latest` (tabblad **Actions**: wacht tot de workflow groen is).
3. Op de Hostinger-server haal je die image op met `./update.sh`.

> **Eenmalig:** maak het package openbaar via GitHub → je profiel → **Packages** → `studio` → Package settings → *Change visibility* → Public. Anders moet de server eerst inloggen op ghcr.io met een token met `read:packages` (`docker login ghcr.io`).

De bestaande Traefik-container op de server draait in **hostmodus**. De app luistert in de container op poort **80**, zonder gepubliceerde hostpoorten en zonder gedeeld netwerk. Traefik gebruikt entrypoint `websecure` en certresolver `letsencrypt`; de zes `justpixit-studio-http`-labels zorgen voor de omleiding van http naar https via entrypoint `web`.

## 2. Eerste installatie op de server (±10 minuten)

```bash
mkdir -p /opt/studio && cd /opt/studio
# Zet hier compose.hostinger.yml, .env.example en de vier .sh-scripts (via SFTP, of: git clone https://github.com/NickB-VTIZ/studio.git .)
cp .env.example .env
nano .env          # ADMIN_PASSWORD, SESSION_SECRET en BASE_URL invullen (Ctrl+O, Enter, Ctrl+X)
chmod +x *.sh
docker compose -f compose.hostinger.yml pull
docker compose -f compose.hostinger.yml up -d --no-build
docker compose -f compose.hostinger.yml ps
```

Een goede `SESSION_SECRET` maak je met `openssl rand -hex 32`.

Open daarna https://studio.justpixit.be/app en meld je aan met je `ADMIN_PASSWORD`. De boekingspagina staat op https://studio.justpixit.be/afspraak.

**Alternatief zonder GHCR:** met de volledige repository op de server bouw je ter plekke: `docker compose -f compose.hostinger.yml up -d --build`.

## 3. Dagelijks gebruik

| Wat | Commando (in `/opt/studio`) |
|---|---|
| Updaten naar de nieuwste build | `./update.sh` (maakt eerst een back-up) |
| Ter plekke bouwen i.p.v. image ophalen | `./update.sh --build` |
| Herstarten (bv. na een wijziging in `.env`) | `./restart.sh` |
| Logs | `./logs.sh` (stoppen met Ctrl+C) |
| Back-up van alle data | `./backup.sh` → archief in `backups-archief/` |
| Stoppen | `docker compose -f compose.hostinger.yml down` (data blijft) |

## 4. Back-ups en data

- Alles staat in `data/`: `studio.json` (klanten + instellingen), `uploads/` (offertes, afbeeldingen) en `backups/` (automatisch één kopie per dag van `studio.json`, 30 dagen bewaard).
- `./backup.sh` maakt een volledig archief. Download `backups-archief/` af en toe via SFTP naar je eigen computer.
- Terugzetten: stop de app, pak het archief uit over `data/`, start opnieuw.

## 5. Bevestigingsmails (optioneel)

Met een Hostinger-mailbox (bv. `info@justpixit.be`) vul je in `.env` in:
```
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USER=info@justpixit.be
SMTP_PASS=het-wachtwoord-van-die-mailbox
SMTP_FROM=justPIXIT <info@justpixit.be>
ADMIN_EMAIL=info@justpixit.be
```
Dan `./restart.sh`. Bij elke boeking krijgt de klant een bevestiging en jij een melding. Zonder deze regels werkt boeken ook; er wordt dan niets gemaild.

## 6. Lokaal testen

Zonder Docker:
```bash
ADMIN_PASSWORD=testwachtwoord SESSION_SECRET=een-lange-willekeurige-tekst PORT=3000 node server/index.js
```
Open http://localhost:3000/app. Data komt in `data/`.

Met Docker: `cp .env.example .env`, dan `docker compose -f compose.local.yml up -d --build` en open http://localhost:8080.

## 7. Veelgestelde vragen

- **Wachtwoord vergeten.** Pas `ADMIN_PASSWORD` in `.env` aan en voer `./restart.sh` uit.
- **De boekingspagina zegt "Online boeken staat even uit".** Zet in Studio → Beheer → Online afspraken het vinkje aan.
- **Welke momenten staan open?** Beheer → Online afspraken: dagen, tijdsblokken, duur, pauze, hoeveel uur op voorhand en geblokkeerde dagen (bv. verlof `2027-07-01..2027-07-21`). Momenten die al bezet zijn door een geplande kennismaking worden automatisch verborgen; twee klanten kunnen nooit hetzelfde moment boeken.
- **Een klant wil verzetten.** Pas in de klantfiche het veld *Kennismakingsgesprek* aan; het oude moment komt weer vrij.
- **Voorbeeldklanten weg?** Op *Vandaag* staat een knop *Verwijder voorbeelden*.
- **404 van Traefik / geen certificaat.** Controleer DNS (`ping studio.justpixit.be`, ook eventuele AAAA-records), poorten 80/443 in de Hostinger-firewall en `docker logs traefik-xual-traefik-1 --tail=100`.
- **502/504.** `./logs.sh` toont of de app draait; ze moet melden "draait op poort 80".
