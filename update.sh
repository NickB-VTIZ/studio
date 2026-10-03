#!/usr/bin/env bash
# Update op de server: haalt de nieuwste image van GHCR (gebouwd door GitHub Actions) en herstart zonder dataverlies.
# Gebruik ./update.sh --build om in plaats daarvan ter plekke te bouwen uit de bestanden in deze map (bv. na git pull).
set -euo pipefail
cd "$(dirname "$0")"
C="docker compose -f compose.hostinger.yml"
[ -f .env ] || { echo "Geen .env gevonden. Doe eerst: cp .env.example .env && nano .env"; exit 1; }
echo "▸ Back-up van de data maken…"; ./backup.sh
if [ "${1:-}" = "--build" ]; then
  [ -d .git ] && { echo "▸ Nieuwste code ophalen…"; git pull --ff-only || true; }
  echo "▸ Image bouwen…"; $C build --pull
  $C up -d --remove-orphans
else
  echo "▸ Nieuwste image ophalen van GHCR…"; $C pull
  $C up -d --no-build --remove-orphans
fi
docker image prune -f >/dev/null
echo; $C ps; echo
echo "✔ Klaar. Logs volgen met: ./logs.sh"
