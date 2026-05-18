#!/usr/bin/env bash
# One command: install (if needed), prove it with tests, then run the demo.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo "→ installing deps (one time)…"
  npm install --silent
fi

echo "→ tests (incl. every failure mode)…"
npm test --silent

echo
echo "→ deterministic demo…"
npm run demo --silent
