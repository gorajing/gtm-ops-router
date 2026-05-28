# System Map

Two repos, one explicit seam:

```text
inbound deal -> route/work item -> sales handoff JSON -> evidence research -> drafted outreach -> critic review
        gtm-ops-router                         gorajing/sales
```

`gtm-ops-router` is the GTM operating ledger. It decides what work should
happen, records why it happened, and keeps every failure visible.

`gorajing/sales` is the evidence-grounded sales execution tool. It turns the
right account context into public evidence, audited facts, cited drafts, critic
review, and export-ready outreach.

The handoff between them is a versioned JSON file, not a hidden live sync. See
[SALES_HANDOFF_CONTRACT.md](SALES_HANDOFF_CONTRACT.md) for the contract and its
invariants.

## Ownership Boundary

| Concern | Owner | Source of truth |
|---|---|---|
| Deal intake, validation, quarantine | `gtm-ops-router` | `deals`, `events` |
| Enrichment observations and projected facts | `gtm-ops-router` | `provider_observations`, `enriched_subject_facts` |
| Score, route, owner, finance/legal flags | `gtm-ops-router` | routed deal projection |
| HubSpot/Slack receipts and retry history | `gtm-ops-router` | `external_event_keys`, `external_event_observations` |
| Commercial lifecycle and deployment readiness | `gtm-ops-router` | `commercial_states`, `deployment_*`, `outcome_*` |
| Role queues, work items, agent suggestions | `gtm-ops-router` | `work_items`, `work_item_events`, `agent_suggestions` |
| Cross-repo seed payload | `gtm-ops-router` | `gtm-ops-router.sales-handoff.v1` export |
| Imported GTM context on an account | `gorajing/sales` | `gtm_handoff_imports` |
| Public evidence capture and audit | `gorajing/sales` | `evidence`, `extraction_audits` |
| Drafts, cited claims, critics, revisions | `gorajing/sales` | sequences, touches, revisions, critiques |

## Boundary Rules

1. Router context is operational context, not verified evidence.
2. Sales may use router context to decide what to research next.
3. Sales must not cite router context in outreach unless a public source is
   captured as an evidence row and passes audit.
4. `routerDealId` is the durable cross-repo trace key.
5. `trace.evidenceBoundary` records that the seed is not verified evidence;
   optional `operatorLinks` are local navigation affordances only.
6. Handoff imports are idempotent: replay updates the same imported seed instead
   of creating duplicate accounts, contacts, or evidence.

## Demo Path

The fastest proof path is:

```bash
cd /path/to/gtm-ops-router
npm run demo:cross-repo
```

That command proves the full local seam:

- Router produces a persistent operating ledger with dry-run HubSpot/Slack
  receipts and demo lifecycle outcomes in an isolated ignored SQLite file.
- Router exports `data/sales-handoff.cross-repo-demo.json` with local operator
  links back to the matching router deal.
- Sales runs committed migrations against an isolated ignored SQLite file and
  imports that handoff idempotently.
- The script prints Sales account URLs with account name and router deal id.

Set `SALES_REPO=/absolute/path/to/Sales` if the Sales repo is not a sibling of
this repo.

## Why Two Repos

Keeping the systems separate preserves a clean operating model:

- Router can evolve toward CRM, Slack, lifecycle, and deployment orchestration
  without becoming an outreach writer.
- Sales can enforce evidence quality without trusting operational metadata as a
  factual source.
- The handoff contract is small enough to test from both sides.

This is the main product claim: action can be automated, but claims still need
evidence.
