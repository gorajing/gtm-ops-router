# Cross-repo demo (about 3 minutes)

Two repos, one explicit seam. `gtm-ops-router` decides what revenue work should
happen; `sales` turns the right accounts into evidence-grounded outreach —
**without treating router context as verified evidence.**

## Fast path

From the router repo:

```bash
npm run demo:cross-repo
```

The script finds a sibling `Sales/` or `sales/` checkout, or you can set
`SALES_REPO=/absolute/path/to/Sales`. It runs the router demo, exports
`data/sales-handoff.cross-repo-demo.json`, imports it into Sales, and prints the
two UI commands to run next. The fast-path export includes local operator
links for `http://localhost:8787`; normal exports omit those links unless you
pass `--operator-base-url`. The fast path uses
`data/router.cross-repo-demo.db`, `data/sales-handoff.cross-repo-demo.json`, and
`data/sales.cross-repo-demo.db`, so it does not mix with either repo's normal
local dev database or handoff file.

## Manual path

### 0. One-time setup

Start from the directory that holds both repo clones as siblings
(`gtm-ops-router/` and `Sales/`; substitute `sales` for `Sales` in the commands
below if your local clone is lowercase):

```bash
# router
cd gtm-ops-router && npm install
# sales (sibling dir)
cd ../Sales && pnpm install && pnpm db:migrate
```

The Sales repo uses committed Drizzle migrations; `pnpm db:generate` is for
schema authors, not for running this demo.

The manual path writes to the normal local `data/router.db` and
`data/sales.db`. Use `npm run demo:cross-repo` when you want isolated scratch
databases. Relative `GTM_ROUTER_DB_PATH` values are resolved from the router
repo root.

### 1. Router: process deals, see the operating ledger

> Setup left your cwd in the Sales repo, so section 1 starts with
> `cd ../gtm-ops-router` (both repos are siblings). `npm run serve` is
> long-running — start it in a separate terminal.

```bash
cd ../gtm-ops-router            # (setup left you in ../Sales or ../sales)
npm run run -- data/inbound.seed.jsonl --integrations --demo-outcomes
npm run serve                   # separate terminal — blocks; http://localhost:8787
```

`npm run demo` is still useful as a terminal-only preview, but it uses an
in-memory store. The export in section 2 reads from `data/router.db`, so section
1 uses `npm run run`.

Point at: route mix, quarantine ledger (loud, never dropped), deployment
readiness, agent suggestions (proposed → accepted/rejected, no execution).

### 2. Router: export the handoff

```bash
npm run export:sales -- --limit 10 --out data/sales-handoff.json
```

A versioned, idempotent JSON contract — not a live CRM sync. A frozen public
copy is committed at `data/sales-handoff.sample.json`, so the Sales side can be
demoed even without running sections 1 and 2.

### 3. Sales: import the seed

If you ran section 2, import the freshly generated handoff:

```bash
cd ../Sales
pnpm import:gtm-handoff -- ../gtm-ops-router/data/sales-handoff.json
```

If you want the Sales side without first running the router export, import the
committed sample instead:

```bash
cd ../Sales
pnpm import:gtm-handoff -- ../gtm-ops-router/data/sales-handoff.sample.json
```

Both section 3 paths assume the one-time Sales setup in section 0 has run.

Then start Sales in a separate terminal:

```bash
pnpm dev                        # blocks; http://localhost:3000
```

Open `http://localhost:3000/` (the accounts list is the root route), click an
imported account (e.g. Ryder Digital) → `/accounts/[id]`: the GTM seed context
shows there. Its **Evidence tab (`/accounts/[id]/evidence`) is empty** — router
context is a research seed, not verified evidence.

### 4. Sales: prove the boundary

Capture + audit public evidence, then draft. Only `verified` evidence rows can
be cited; the validator rejects any claim that isn't a verbatim substring of a
snippet. This is the line the system enforces — router context never launders
itself into a cited fact.

### 5. The loop closes (reverse leg) + real enrichment

The forward leg above is runnable end to end. The **reverse leg** — Sales's
observed engagement flowing back to router measurement — is proven by **contract**,
not a single command (the router consumes engagement feedback via
`Store.importEngagementFeedback`; there is no end-to-end CLI runner):

```bash
# Router: byte-for-byte reverse contract — regenerate the committed sample, expect no diff
npx tsx scripts/gen-engagement-sample.ts && git diff --exit-code data/engagement-feedback.sample.json

# Sales: the frozen producer reproduces those SAME bytes (live `export:engagement-feedback`
# stamps a real generatedAt, so it is the live path, not the byte-identical one)
cd ../Sales && pnpm gen:engagement-sample && git diff --exit-code data/engagement-feedback.sample.json

# Router: see the measurement consuming engagement — attribution in the dashboard
cd ../gtm-ops-router
npm run run -- data/inbound.seed.jsonl --demo-engagement   # persistent DB; `demo` is in-memory
npm run serve                                              # http://localhost:8787 → Full-funnel panel
```

**Real enrichment (your own key).** Keyless, enrichment is the deterministic
fixture (so this demo needs no setup). With a key, the real grounded LLM enricher
runs:

```bash
ANTHROPIC_API_KEY=… npx tsx scripts/enrich-smoke.ts stripe.com somenonexistentco.invalid
```

## The one sentence

> Two repos, one explicit seam: the router decides what work happens; Sales
> turns the right accounts into cited outreach without treating router context
> as verified evidence.
