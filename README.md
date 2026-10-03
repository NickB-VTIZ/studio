# justPIXIT Studio

Klantopvolging en online afspraken voor justPIXIT, als eigen webapp op https://studio.justpixit.be.

- **`/app`** – jouw beheeromgeving (met wachtwoord): Vandaag, Pipeline, Klanten (fiche, planning, offerte, logboek), Beheer.
- **`/afspraak`** – publieke boekingspagina (je eigen "Calendly"). Een boeking maakt automatisch een klant aan in de fase *Kennismaking ingepland*.
- Een echte database (SQLite, ingebouwd in Node — geen database-server en geen externe pakketten). Alle data staat in de map `data/` naast de compose-file en is zo in één keer te back-uppen.

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

## 2b. Updaten met één klik (versiebeheer)

De app toont haar versienummer (rechtsboven en in **Beheer → Versie & updates**). Elke push naar `main` krijgt automatisch een hoger nummer: `1.1`, `1.2`, `1.3`, …

Zo werkt de kringloop, zonder dat je nog op de server hoeft in te loggen:

1. Jij (of ik) pusht een wijziging naar `main`.
2. GitHub Actions bouwt de nieuwe image en maakt release `v1.N`.
3. In de app zie je in **Beheer → Versie & updates** "Nieuwe versie beschikbaar".
4. Je klikt op **Laad nieuwe versie**. De app haalt de nieuwe image op en herstart zichzelf (±30 sec). Je gegevens blijven bewaard; daarna toont de app het nieuwe nummer.

Dit werkt via de meegeleverde **Watchtower**-container. Eenmalig instellen:
- Zet in `.env` een `UPDATE_TOKEN` (een lange willekeurige tekst: `openssl rand -hex 24`).
- Start opnieuw op met `docker compose -f compose.hostinger.yml up -d` (dan draait ook Watchtower mee).

Zonder `UPDATE_TOKEN` werkt de app gewoon, maar is de knop uitgeschakeld en update je handmatig met `./update.sh`.

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

- Alles staat in `data/`: `studio.db` (SQLite-database met klanten + instellingen), `uploads/` (offertes, afbeeldingen) en `backups/` (automatisch één databasekopie per dag, 30 dagen bewaard). Een bestaand `studio.json` uit een oudere versie wordt bij de eerste start automatisch overgezet naar de database.
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

## 5b. Koppelingen (e-mail, WhatsApp, facturen)

Alle sleutels zet je in `.env` op de server (niet in de app, zo blijven ze veilig). In **Beheer → Koppelingen** zie je wat actief is. Na een wijziging in `.env`: `./restart.sh`.

**E-mail via Resend** (aanbevolen, eenvoudiger dan SMTP). Maak op resend.com een API-sleutel en verifieer je domein of afzender, en zet:
```
RESEND_API_KEY=re_xxxxxxxx
RESEND_FROM=justPIXIT <info@justpixit.be>
```
Staat Resend ingesteld, dan gebruikt de app Resend; anders valt ze terug op SMTP. Beide sturen de bevestigingsmails bij een online boeking.

**WhatsApp via Twilio.** Nodig: een Twilio-account, een geactiveerde WhatsApp-afzender en goedgekeurde berichttemplates.
```
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
TWILIO_WHATSAPP_FROM=+32470000000
```
Op een klantpagina verschijnt dan een WhatsApp-venster waarmee je de klant een bericht stuurt (het nummer wordt automatisch naar +32-formaat gezet). Let op: WhatsApp staat een bedrijf enkel toe om ongevraagd te berichten met een vooraf goedgekeurde template, of binnen 24 uur nadat de klant zelf iets stuurde. Een vrij bericht buiten dat venster wordt door WhatsApp geweigerd — dat is een regel van WhatsApp, niet van de app.

**Facturen via EenvoudigFactureren.** Maak een API-sleutel via *Toegangsbeheer* in EenvoudigFactureren en zet:
```
EF_API_KEY=xxxx
EF_ACCOUNT_ID=Cxxxx      # enkel bij meerdere accounts
```
Op een offerte verschijnt dan de knop **Maak factuur**. De app maakt de klant aan in EenvoudigFactureren (als die er nog niet is) en zet de offerteregels om in een factuur. De link naar de factuur verschijnt bij de offerte.

## 6. Lokaal testen

Zonder Docker:
```bash
ADMIN_PASSWORD=testwachtwoord SESSION_SECRET=een-lange-willekeurige-tekst PORT=3000 node --experimental-sqlite server/index.js
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
