# justPIXIT studio — binnenkort

Een kleine interactieve placeholder voor https://studio.justpixit.be.
Zachte kleuren, een bewegend inspiratiekaartje, drie kleurstemmingen en een uitklapbare teaser. Werkt op mobiel, met toetsenbord en met verminderde animaties. Geen externe fonts, scripts, tracking of inschrijfformulier.

## 1. Op GitHub zetten

Maak bijvoorbeeld `NickB-VTIZ/justpixit-studio` aan met de standaardbranch `main`.
Upload de **inhoud** van deze map, inclusief `.github/workflows/docker.yml`, naar de root van de repository. Met git vanuit deze map:

```bash
git init -b main
git add .
git commit -m "Add justPIXIT studio coming-soon app"
git remote add origin https://github.com/NickB-VTIZ/justpixit-studio.git
git push -u origin main
```

Na een push op `main` bouwt GitHub Actions de image en publiceert die naar `ghcr.io/<eigenaar>/<repository>:latest` (kleine letters). Wacht in het tabblad **Actions** tot de workflow geslaagd is. De workflow gebruikt de ingebouwde `GITHUB_TOKEN`; er is geen extra secret nodig.

Maak na de eerste build het containerpackage openbaar via GitHub → Packages → package → Package settings → Change visibility → Public, als je zonder registry-login wilt downloaden. Een openbare repository maakt het package niet automatisch openbaar. Bij een privépackage moet je op de server inloggen op `ghcr.io` met een token met `read:packages`.

## 2. Op Hostinger starten via gepubliceerde image

De bestaande Traefik-container `traefik-xual-traefik-1` draait in **hostmodus**. Deze app gebruikt zijn eigen standaard Docker-netwerk, interne poort **80** en geen gepubliceerde hostpoorten. Je bar-app hoeft niet aangepast te worden.

Maak `/opt/studio` en plaats daar `compose.hostinger.yml`. Wanneer je een andere repositorynaam/eigenaar koos, maak daarnaast `.env` op basis van `.env.example` en pas `STUDIO_IMAGE` aan.

```bash
mkdir -p /opt/studio
cd /opt/studio
# Plaats hier eerst compose.hostinger.yml en eventueel .env.
docker compose -f compose.hostinger.yml config
docker compose -f compose.hostinger.yml pull
docker compose -f compose.hostinger.yml up -d --no-build
docker compose -f compose.hostinger.yml ps
```

Open https://studio.justpixit.be. Traefik gebruikt de bestaande entrypoint `websecure` en certificaatresolver `letsencrypt`.

De YAML voegt ook een HTTP → HTTPS-redirect toe via entrypoint `web`. Als jouw Traefik geen `web`-entrypoint heeft, verwijder dan de zes labels voor `justpixit-studio-http` en `justpixit-studio-https`; de HTTPS-router blijft werken.

De app luistert met Nginx op `0.0.0.0:80`. Gebruik voor deze app geen poort 3000 en geen `network_mode: host`.

## Alternatief: rechtstreeks op de server bouwen

Met de volledige repository op de server hoef je niet op een gepubliceerde image te wachten:

```bash
cd /opt/studio
docker compose -f compose.hostinger.yml up -d --build
```

## Updaten

Pas de bestanden aan en push naar `main`. Wacht op de succesvolle GitHub-build en voer op de server uit:

```bash
cd /opt/studio
docker compose -f compose.hostinger.yml pull
docker compose -f compose.hostinger.yml up -d --no-build
```

## Lokaal bekijken

Open `site/index.html` direct in je browser, of gebruik Docker:

```bash
docker compose -f compose.local.yml up -d --build
```

Open http://localhost:8080. Lokaal worden geen Traefik-labels gebruikt.

## Tekst en stijl aanpassen

- `site/index.html`: teksten, links en inhoud van de teaser.
- `site/style.css`: kleuren, typografie en layout.
- `site/app.js`: teaser, kleurkeuze en kaartbeweging.
- `compose.hostinger.yml`: domein, image en Traefik-labels.

Er is geen lanceringsdatum verzonnen. De knop toont alleen een teaser en verzamelt geen gegevens.

## Diagnose

```bash
docker compose -f compose.hostinger.yml logs --tail=100
docker logs traefik-xual-traefik-1 --tail=100
```

- `404` van Traefik: controleer domein, labels en entrypoint.
- `502/504`: controleer containerstatus, interne poort 80 en bereikbaarheid vanaf de host.
- Certificaatprobleem: controleer DNS (ook eventuele AAAA-records), poorten 80/443 en Traefik-logs.

## Validatie van dit pakket

YAML is succesvol ingelezen en JavaScript slaagt voor de syntaxcontrole. De teaser en kleurkeuze zijn gecontroleerd met een DOM-simulatie. Een visuele browsercontrole was niet mogelijk omdat de browserdownload in de aanmaakomgeving mislukte. Er is hier ook geen Docker aanwezig: de daadwerkelijke Docker-build, visuele eindcontrole en live certificaataanvraag moeten op GitHub/Hostinger plaatsvinden.

Bronnen: [Traefik Docker routing](https://doc.traefik.io/traefik/reference/routing-configuration/other-providers/docker/), [GitHub Docker publishing](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images), [GHCR](https://docs.github.com/en/packages/working-with-packages/working-with-the-container-registry).
