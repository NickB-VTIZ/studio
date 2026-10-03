#!/usr/bin/env bash
# Herstart de app (bv. na een wijziging in .env). Data blijft bewaard.
set -euo pipefail
cd "$(dirname "$0")"
docker compose -f compose.hostinger.yml up -d --force-recreate --no-build studio
docker compose -f compose.hostinger.yml ps
