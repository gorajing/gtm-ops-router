#!/usr/bin/env bash
set -euo pipefail

ROUTER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SALES_DIR="${SALES_REPO:-}"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required for the companion Sales repo demo." >&2
  echo "Install pnpm, then rerun npm run demo:cross-repo." >&2
  exit 2
fi

if [ -z "$SALES_DIR" ]; then
  if [ -d "$ROUTER_DIR/../Sales" ]; then
    SALES_DIR="$(cd "$ROUTER_DIR/../Sales" && pwd)"
  elif [ -d "$ROUTER_DIR/../sales" ]; then
    SALES_DIR="$(cd "$ROUTER_DIR/../sales" && pwd)"
  else
    echo "Could not find the companion Sales repo." >&2
    echo "Set SALES_REPO=/absolute/path/to/Sales and rerun." >&2
    exit 2
  fi
fi

if [ -n "$SALES_DIR" ]; then
  if [ ! -d "$SALES_DIR" ]; then
    echo "SALES_REPO does not exist or is not a directory: $SALES_DIR" >&2
    exit 2
  fi
  SALES_DIR="$(cd "$SALES_DIR" && pwd)"
fi

if [ ! -f "$SALES_DIR/package.json" ] ||
  ! grep -qE '"import:gtm-handoff"[[:space:]]*:' "$SALES_DIR/package.json" ||
  ! grep -qE '"db:migrate"[[:space:]]*:' "$SALES_DIR/package.json"; then
  echo "SALES_REPO is not the companion Sales repo: $SALES_DIR" >&2
  echo "Expected package.json to define import:gtm-handoff and db:migrate scripts." >&2
  exit 2
fi

cd "$ROUTER_DIR"
mkdir -p "$ROUTER_DIR/data"
DEMO_ROUTER_DB="$ROUTER_DIR/data/router.cross-repo-demo.db"
rm -f "$DEMO_ROUTER_DB" "$DEMO_ROUTER_DB-wal" "$DEMO_ROUTER_DB-shm" "$DEMO_ROUTER_DB-journal"
DEMO_HANDOFF="$ROUTER_DIR/data/sales-handoff.cross-repo-demo.json"
rm -f "$DEMO_HANDOFF"
mkdir -p "$SALES_DIR/data"
DEMO_SALES_DB="$SALES_DIR/data/sales.cross-repo-demo.db"
rm -f "$DEMO_SALES_DB" "$DEMO_SALES_DB-wal" "$DEMO_SALES_DB-shm" "$DEMO_SALES_DB-journal"

echo "-> installing router deps..."
npm ci --no-audit --fund=false

echo "-> router persistent run with dry-run HubSpot/Slack receipts and demo outcomes"
GTM_ROUTER_DB_PATH="$DEMO_ROUTER_DB" npm run run --silent -- data/inbound.seed.jsonl --integrations --demo-outcomes
if [ ! -s "$DEMO_ROUTER_DB" ]; then
  echo "Router run did not create the isolated demo DB at $DEMO_ROUTER_DB." >&2
  echo "Confirm the router CLI honors GTM_ROUTER_DB_PATH." >&2
  exit 2
fi

echo
echo "-> router sales handoff export"
GTM_ROUTER_DB_PATH="$DEMO_ROUTER_DB" npm run export:sales -- --limit 10 --operator-base-url http://localhost:8787 --out "$DEMO_HANDOFF"
if [ ! -s "$DEMO_HANDOFF" ]; then
  echo "Router export did not create the handoff file at $DEMO_HANDOFF." >&2
  exit 2
fi

cd "$SALES_DIR"

echo "-> installing Sales deps..."
pnpm install --frozen-lockfile

echo
echo "-> Sales DB migrations"
SALES_DB_PATH="$DEMO_SALES_DB" pnpm db:migrate
if [ ! -s "$DEMO_SALES_DB" ]; then
  echo "Sales migration did not create the isolated demo DB at $DEMO_SALES_DB." >&2
  echo "Confirm the Sales checkout honors SALES_DB_PATH." >&2
  exit 2
fi

echo
echo "-> Sales GTM handoff import"
IMPORT_RESULT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/gtm-handoff-import.XXXXXX")"
IMPORT_RESULT_FILE="$IMPORT_RESULT_DIR/result.json"
trap 'rm -rf "$IMPORT_RESULT_DIR"' EXIT
if ! SALES_DB_PATH="$DEMO_SALES_DB" pnpm --silent import:gtm-handoff -- "$DEMO_HANDOFF" --out "$IMPORT_RESULT_FILE"; then
  echo "Sales import failed. Update your Sales checkout or set SALES_REPO to a compatible checkout." >&2
  exit 2
fi
if [ ! -s "$IMPORT_RESULT_FILE" ]; then
  echo "Sales import did not honor --out; update SALES_REPO to a checkout that writes result JSON." >&2
  exit 2
fi
if [ ! -s "$DEMO_SALES_DB" ]; then
  echo "Sales import did not write the isolated demo DB at $DEMO_SALES_DB." >&2
  echo "Confirm the Sales checkout honors SALES_DB_PATH." >&2
  exit 2
fi
IMPORTED_ACCOUNTS="$(
GTM_IMPORT_RESULT_FILE="$IMPORT_RESULT_FILE" GTM_EXPECTED_SALES_DB="$DEMO_SALES_DB" node -e '
const resultPath = process.env.GTM_IMPORT_RESULT_FILE;
if (!resultPath) {
  console.error("GTM_IMPORT_RESULT_FILE is required.");
  process.exit(1);
}
const expectedDb = process.env.GTM_EXPECTED_SALES_DB;
if (!expectedDb) {
  console.error("GTM_EXPECTED_SALES_DB is required.");
  process.exit(1);
}
const result = JSON.parse(require("node:fs").readFileSync(resultPath, "utf8"));
if (result.databasePath !== expectedDb) {
  console.error(`Sales import wrote ${result.databasePath || "unknown DB"}, expected ${expectedDb}.`);
  process.exit(1);
}
if (!Array.isArray(result.imported) || result.imported.length === 0) {
  console.error("No Sales accounts were imported; the demo did not prove the handoff.");
  process.exit(1);
}
for (const item of result.imported) {
  for (const field of ["accountId", "accountName", "routerDealId"]) {
    if (typeof item[field] !== "string" || item[field].length === 0) {
      console.error(`Sales handoff contract violation: import result is missing ${field}.`);
      process.exit(1);
    }
  }
  console.log(`  http://localhost:3000/accounts/${item.accountId} (${item.accountName}, router ${item.routerDealId})`);
}
'
)"

echo
echo "Done. Start these in separate terminals to use the same isolated demo DBs:"
printf "  cd %q && SALES_DB_PATH=%q pnpm dev                 # http://localhost:3000\n" "$SALES_DIR" "$DEMO_SALES_DB"
printf "  cd %q && GTM_ROUTER_DB_PATH=%q npm run serve     # http://localhost:8787\n" "$ROUTER_DIR" "$DEMO_ROUTER_DB"
echo
echo "Imported Sales accounts:"
printf "%s\n" "$IMPORTED_ACCOUNTS"
