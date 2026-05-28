# Planning & specification trail

These are the design documents behind `gtm-ops-router` — the org-level roadmap
and the per-phase implementation specs. They are kept for provenance: they show
how the system was scoped and sequenced, not what it currently does.

**For current-state docs, do not start here.** The canonical reading path is:

1. [`../../README.md`](../../README.md) — what it is, why it exists, how to run it.
2. [`../SYSTEM_MAP.md`](../SYSTEM_MAP.md) — the two-repo ownership boundary.
3. [`../SALES_HANDOFF_CONTRACT.md`](../SALES_HANDOFF_CONTRACT.md) — the cross-repo JSON contract and its invariants.

## What's in here

| Doc | Scope |
|---|---|
| [`ORG_MASTERPLAN.md`](ORG_MASTERPLAN.md) | The org-level roadmap: product thesis, who it serves, design principles, and the phased build sequence (Phases 0–5) plus a deferred-specification checklist. |
| [`PHASE2_OUTCOME_LOOP_SPEC.md`](PHASE2_OUTCOME_LOOP_SPEC.md) | Detailed spec for the post-sale outcome loop (outcome events, commercial-state projection, audit gate). |
| [`PHASE5_AGENT_RAILS_SPEC.md`](PHASE5_AGENT_RAILS_SPEC.md) | Detailed spec for the local-only agent suggestion ledger (draft / human-decides). |

## Status

Phases 0–5 of the master plan have **landed** in the codebase — deployment
readiness, the outcome loop, role-specific queues, policy evaluation, and the
agent suggestion ledger are all built and tested. What remains genuinely
forward-looking is the **deferred-specification checklist** at the end of
`ORG_MASTERPLAN.md` (auth for non-local writes, external-reference merge/split,
out-of-order webhook handling, post-sale terminal-state correction, redaction
and retention rules, and similar). Those must each get their own spec before
they ship.
