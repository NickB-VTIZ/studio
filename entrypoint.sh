#!/bin/sh
# Draait als root, zet de rechten op de data-map goed (die is bij een bind-mount van de host vaak van root),
# en start de app daarna als de niet-root gebruiker 'node'.
set -e
DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR" 2>/dev/null || true
exec su-exec node:node node --experimental-sqlite server/index.js
