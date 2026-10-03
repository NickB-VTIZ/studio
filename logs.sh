#!/usr/bin/env bash
cd "$(dirname "$0")" && docker compose -f compose.hostinger.yml logs -f --tail=100 studio
