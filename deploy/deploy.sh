#!/usr/bin/env bash
# Build the console off the server and ship the service. Usage: deploy/deploy.sh [ssh-host]
# The server needs uv and a filled .env in ~/apps/holdforme; it runs no Node.
set -euo pipefail
HOST="${1:-hetzner-agent}"
APP_DIR="apps/holdforme"
cd "$(dirname "$0")/.."

pnpm --dir client install --frozen-lockfile
pnpm --dir client exec tsc --noEmit
pnpm --dir client exec expo export --platform web

# Tracked files plus the built console. data/ and .env on the server are never touched.
{ git ls-files; find client/dist -type f; } | tar -czf - -T - | ssh "$HOST" "mkdir -p ~/$APP_DIR && rm -rf ~/$APP_DIR/client/dist && tar -xzf - -C ~/$APP_DIR"
ssh "$HOST" "cd ~/$APP_DIR && ~/.local/bin/uv sync --frozen --no-dev && sudo systemctl restart holdforme && for i in \$(seq 30); do curl -sf http://127.0.0.1:3020/callenvoy/healthz && exit 0; sleep 1; done; echo 'health check failed'; exit 1"
