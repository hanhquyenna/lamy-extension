#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
if [[ ! -f "$ROOT/.env" ]]; then
  echo "Missing .env. Copy .env.example to .env and set LAMY_LINK_SECRET."
  exit 1
fi
set -a
source "$ROOT/.env"
set +a
exec bun "$ROOT/backend/server.ts"
