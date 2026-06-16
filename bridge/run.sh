#!/usr/bin/env bash
# Run the reader bridge. Configuration comes from bridge/.env; see .env.example.
# Needs the `mercury` module, which install.sh sets up.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] && set -a && . ./.env && set +a

exec python3 m7e_bridge.py
