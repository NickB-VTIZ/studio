#!/usr/bin/env bash
# Maakt een gedateerd zip-archief van de volledige data-map (klanten, instellingen, uploads) in ./backups-archief/
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups-archief
naam="backups-archief/studio-data-$(date +%Y-%m-%d_%H%M).tar.gz"
tar -czf "$naam" data 2>/dev/null || { echo "Nog geen data-map; niets te back-uppen."; exit 0; }
# Hou de laatste 20 archieven
ls -1t backups-archief/studio-data-*.tar.gz 2>/dev/null | tail -n +21 | xargs -r rm -f
echo "✔ Back-up: $naam"
