# Cross-repo demo (about 3 minutes)

Two repos, one explicit seam. `gtm-ops-router` decides what revenue work should
happen; `sales` turns the right accounts into evidence-grounded outreach —
**without treating router context as verified evidence.**

## 0. One-time setup

Start from the directory that holds both repo clones as siblings
(`gtm-ops-router/` and `sales/`):

```bash
# router
cd gtm-ops-router && npm install
# sales (sibling dir)
cd ../sales && pnpm install && pnpm db:generate && pnpm db:migrate
```

## 1. Router: process deals, see the operating ledger

> Setup left your cwd in the Sales repo, so §1 starts with `cd ../gtm-ops-router`
> (both repos are siblings). `npm run serve` and `pnpm dev` are long-running —
> start each in a separate terminal.

```bash
cd ../gtm-ops-router            # (setup left you in ../sales)
npm run demo                    # deterministic batch: 13 intake / 9 routed / 4 quarantined
npm run run -- data/inbound.seed.jsonl --integrations --demo-outcomes
npm run serve                   # separate terminal — blocks; http://localhost:8787
```

Point at: route mix, quarantine ledger (loud, never dropped), deployment
readiness, agent suggestions (proposed → accepted/rejected, no execution).

## 2. Router: export the handoff

```bash
npm run export:sales -- --limit 10 --out data/sales-handoff.json
```

A versioned, idempotent JSON contract — not a live CRM sync. A frozen public
copy is committed at `data/sales-handoff.sample.json`, so the Sales side can be
demoed even without running §1–§2.

## 3. Sales: import the seed (use the committed sample directly)

```bash
cd ../sales
pnpm import:gtm-handoff ../gtm-ops-router/data/sales-handoff.sample.json
pnpm dev                        # separate terminal — blocks; http://localhost:3000
```

Open `http://localhost:3000/` (the accounts list is the root route), click an
imported account (e.g. Ryder Digital) → `/accounts/[id]`: the GTM seed context
shows there. Its **Evidence tab (`/accounts/[id]/evidence`) is empty** — router
context is a research seed, not verified evidence.

## 4. Sales: prove the boundary

Capture + audit public evidence, then draft. Only `verified` evidence rows can
be cited; the validator rejects any claim that isn't a verbatim substring of a
snippet. This is the line the system enforces — router context never launders
itself into a cited fact.

## The one sentence

> Two repos, one explicit seam: the router decides what work happens; Sales
> turns the right accounts into cited outreach without treating router context
> as verified evidence.
