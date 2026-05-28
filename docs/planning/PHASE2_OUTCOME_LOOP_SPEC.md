# Phase 2 Spec: Outcome Loop

**Status:** Implemented (base outcome loop + deterministic demo fixtures)
**Date:** 2026-05-21
**Depends on:** Phase 1 deployment readiness handoff

Phase 2 records what happened after deployment so routing policy can be judged
against reality. It does not tune policy, replace HubSpot, or introduce an
agent. It adds the smallest durable outcome ledger that lets an operator ask:
"Which routed deals actually deployed, landed, expanded, or churned?"

## Scope

Phase 2 adds post-sale outcome events for router-owned deals:

```text
deployment_started
deployed
landed
expanded
churned
```

It does not add:

- automatic threshold changes.
- agent-authored recommendations.
- customer-facing write endpoints.
- HubSpot merge/split adoption.
- outcome correction UX beyond append-only rejection/audit records.
- reactivation after churn.

## Decision Summary

| Area | Decision |
|---|---|
| Write surface | Add local-only `POST /outcomes` using the same loopback, Host, and `LOCAL_ENDPOINT_SECRET` guard as Phase 1 local write endpoints. |
| Live auth | No live/public outcome endpoint in Phase 2. Live deployment-system ingestion needs a separate signed-source spec. |
| Identity | Require `dealId` as the router deal id. Reject HubSpot-only/external-only outcome writes with 400 before claiming an idempotency key. |
| Idempotency | Use `JSON.stringify(["outcome", "local", sourceEventId])` as the source-event claim key. Same payload replays are no-ops; different payload replays are idempotency violations. |
| Storage | Append-only `outcome_events` plus `outcome_rejections`; metrics query event history, not a mutable latest-state projection. |
| Retro ingestion | Do not set `closed_won` and outcome in one transaction in Phase 2. Caller must project commercial state first, then write outcome. |
| Corrections | Do not mutate old outcomes. Later valid events can supersede interpretation in analytics; invalid contradictions are rejected and audited. |
| External references | Defer active/historical external-reference adoption. Phase 2 may read existing inline HubSpot IDs, but outcome writes are keyed only by router deal id. |
| Churn/reactivation | `churned` is terminal for Phase 2 outcome flow. Events after churn are rejected until a reactivation spec exists. |

## Authorized Callers And Auth

Phase 2 reuses the Phase 1 local-write security posture:

- `/outcomes` is registered only when `ALLOW_LOCAL_WRITE_ENDPOINTS=1`.
- Boot fails if local write endpoints are enabled with live integration intent.
- Requests require loopback remote address, local Host header, and
  `x-local-endpoint-secret`.
- `LOCAL_ENDPOINT_SECRET` must be at least 32 characters.
- `ALLOW_LOCAL_WRITE_ENDPOINTS=1` with `TRUST_PROXY=1` remains invalid.

This keeps the portfolio demo runnable without claiming production auth. A real
deployment-system caller needs a later signed-source design with caller identity,
replay bounds, secret rotation, and audit ownership.

## Request Schema

```json
{
  "dealId": "router deal id",
  "sourceEventId": "UUIDv4 idempotency key",
  "outcome": "deployment_started | deployed | landed | expanded | churned",
  "occurredAt": "ISO timestamp",
  "operator": "local operator name or initials",
  "arrDeltaUsd": 25000,
  "reasonCategory": "optional enum"
}
```

Required for all outcomes:

- `dealId`
- `sourceEventId`
- `outcome`
- `occurredAt`
- `operator`

Field rules:

- `sourceEventId` must be UUIDv4. Content hashes are not valid because a deal
  can legitimately move through the same outcome more than once only after a
  future reactivation spec.
- `operator` is self-reported display context, not authentication.
- `occurredAt` must be canonical UTC ISO with milliseconds
  (`YYYY-MM-DDTHH:mm:ss.sssZ`) and cannot be more than
  `MAX_FUTURE_SKEW_MS` ahead of server time. The store enforces the canonical
  form for commercial-state, deployment-fact, and outcome writes because cycle
  metrics compare event timestamps lexicographically in SQLite. Databases
  written by versions before this invariant should be refreshed or audited
  before relying on cycle-time medians.
- `arrDeltaUsd` must be an integer if present. The semantic ARR rule is
  post-claim validation: it is required and positive for `expanded`, and must
  be absent for all other outcomes. Violations record `invalid_arr_delta`.
- `reasonCategory` is optional, enum-only, and must not store raw notes,
  customer text, contract terms, or support details.

Initial `reasonCategory` enum:

```text
customer_ready
technical_blocker_resolved
scope_expanded
budget_lost
no_show
other
```

## Preconditions

`POST /outcomes` validates in this order:

1. local endpoint guard.
2. JSON body and schema.
3. timestamp parse and future-skew check.
4. `dealId` exists in `deals`.
5. current commercial state exists and is `closed_won`.
6. source-event idempotency claim.
7. outcome lifecycle and ARR semantic validation.
8. append outcome event and timeline event in one SQLite transaction.

On `idempotency_conflict`, the response returns `event=null` and
`rejection=null` because the stored row belongs to the first payload, not the
conflicting input. The idempotency violation table is the diagnostic source for
the mismatch.

Preconditions intentionally run before idempotency replay checks. If a deal is
later corrected away from `closed_won`, replaying a previously accepted outcome
returns `not_closed_won`, not `duplicate`.

Semantic rejection precedence is deterministic:

```text
invalid_arr_delta
post_churn_outcome
duplicate_semantic_outcome
missing_prior_outcome
```

For example, a second `churned` after churn is classified as
`post_churn_outcome`, because post-churn invalidity wins over duplicate
classification.

Unknown deals return 404 and do not claim the source event key, mirroring
`/deployment-facts`.

Deals without accepted `closed_won` commercial state return 409 and do not claim
the source event key. The operator repair path is explicit: project commercial
state first through the existing Phase 1 path, then submit the outcome with the
same `sourceEventId`.

Pre-claim validation errors are not written to `outcome_rejections`. Lifecycle
and ARR semantic errors after the source-event claim are durable semantic
rejections. If the
operator later fixes the missing prerequisite, they must submit the repaired
outcome with a fresh `sourceEventId`; replaying the rejected source event remains
an idempotent no-op.

## Lifecycle Rules

Outcome lifecycle is ordered but not a single mutable projection:

```text
deployment_started -> deployed -> landed -> expanded*
deployment_started -> churned
deployed            -> churned
landed              -> churned
expanded            -> churned
```

Rules:

- `deployment_started` is valid once a router-owned deal is `closed_won`.
- `deployed` requires a prior `deployment_started`.
- `landed` requires a prior `deployed`.
- `expanded` requires a prior `landed` and positive `arrDeltaUsd`.
- `churned` requires at least `deployment_started`.
- `churned` before `deployed` is allowed and means churn-before-deploy.
- After `churned`, every later outcome is rejected until a reactivation spec
  exists.
- Repeating the same semantic outcome with a new source event is rejected in
  Phase 2 unless it is `expanded`; multiple expansions are allowed.
- A replay with the same source event and same payload is a duplicate no-op.
- "Prior" means an accepted same-deal event that already exists before the
  candidate transaction and whose `occurred_at` is less than or equal to the
  candidate `occurred_at`.

## Storage

Add `outcome_events`:

```text
id TEXT PRIMARY KEY
deal_id TEXT NOT NULL
source TEXT NOT NULL
source_event_id TEXT NOT NULL
source_payload_hash TEXT NOT NULL
outcome TEXT NOT NULL
occurred_at TEXT NOT NULL
operator TEXT NOT NULL
operator_source TEXT NOT NULL
arr_delta_usd INTEGER
reason_category TEXT
created_at TEXT NOT NULL
UNIQUE (source, source_event_id)
CHECK (outcome IN (
  'deployment_started',
  'deployed',
  'landed',
  'expanded',
  'churned'
))
CHECK (source IN ('local'))
CHECK (operator_source IN ('self_reported'))
CHECK (
  (outcome = 'expanded' AND arr_delta_usd IS NOT NULL AND arr_delta_usd > 0) OR
  (outcome != 'expanded' AND arr_delta_usd IS NULL)
)
CHECK (
  reason_category IS NULL OR
  reason_category IN (
    'customer_ready',
    'technical_blocker_resolved',
    'scope_expanded',
    'budget_lost',
    'no_show',
    'other'
  )
)
```

Add `outcome_rejections`:

```text
id TEXT PRIMARY KEY
deal_id TEXT NOT NULL
source TEXT NOT NULL
source_event_id TEXT NOT NULL
source_payload_hash TEXT NOT NULL
rejection_kind TEXT NOT NULL
outcome TEXT NOT NULL
occurred_at TEXT NOT NULL
created_at TEXT NOT NULL
UNIQUE (source, source_event_id)
CHECK (rejection_kind IN (
  'duplicate_semantic_outcome',
  'missing_prior_outcome',
  'post_churn_outcome',
  'invalid_arr_delta'
))
CHECK (source IN ('local'))
CHECK (outcome IN (
  'deployment_started',
  'deployed',
  'landed',
  'expanded',
  'churned'
))
```

Rejection kinds:

```text
duplicate_semantic_outcome
missing_prior_outcome
post_churn_outcome
invalid_arr_delta
```

Idempotency conflicts also write `idempotency_violations` with
`scope='outcome'`; they do not also insert `outcome_rejections`.

Outcome source-event claims are persisted in the shared `external_event_keys`
table before inserting either `outcome_events` or `outcome_rejections`, matching
the Phase 1 local commercial-state and deployment-facts pattern. Use:

- `key = JSON.stringify(["outcome", "local", sourceEventId])`
- `system = "local"`
- `scope = "source_event"`
- `notify_status = "ok"`
- `payload_hash = source_payload_hash`

The per-table `UNIQUE (source, source_event_id)` constraints are secondary
guards; replay detection must read `external_event_keys` first so accepted
events and durable semantic rejections share one claim namespace.

`outcome_rejections` is for claimed semantic rejections only. Request-shape,
unknown-deal, not-closed-won, and future-skew failures return errors before
claiming the event key and before inserting `outcome_rejections`.

Phase 2 must extend the existing `idempotency_violations.scope` CHECK constraint
to allow `outcome`. Because SQLite cannot add a CHECK constraint in place, this
requires an explicit table-swap migration: create a replacement table with the
expanded scope constraint, copy existing rows, drop the old table, and rename
the replacement in one migration. This repo does not currently have a
CREATE-copy-DROP-RENAME precedent, so the Phase 2 implementation must include
focused migration tests for existing Phase 1 rows and new `outcome` rows.
The migration must be idempotent: inspect `sqlite_master.sql` for the
`idempotency_violations` table and skip the swap when the persisted CHECK
already admits `'outcome'`.

Each accepted outcome appends the existing per-deal `events` timeline with
`from_st='routed'`, `to_st='routed'`, `detail='post_sale_outcome'`, and
structured meta. This mirrors existing out-of-band external-stage updates: the
router stage does not change, but the timeline still records the operational
fact.

```json
{
  "kind": "post_sale_outcome",
  "outcome": "deployed",
  "source": "local",
  "sourceEventId": "uuid",
  "operator": "DS",
  "operatorSource": "self_reported",
  "arrDeltaUsd": null,
  "reasonCategory": null
}
```

## External References And HubSpot Merge Behavior

Phase 2 does not introduce active/historical external-reference adoption.

Reasons:

- Phase 1 already has stable router deal ids and inline HubSpot receipt fields.
- Outcome ingestion is meant to judge router policy, not reconcile CRM merges.
- A partial external-reference model would be more dangerous than rejecting
  external-only writes.

Behavior:

- `/outcomes` requires router `dealId`.
- If a caller only has a HubSpot deal id, return 400 with an explicit
  `router dealId required` error.
- HubSpot merge/split behavior is deferred. If a merge makes the inline HubSpot
  id stale, Phase 2 does not try to detect or repair it because there is no
  active external-reference model or live merge lookup. That audit belongs to
  the later signed-source/external-reference spec.
- Outcomes are accepted for any router-owned `closed_won` deal, including
  `self_serve` and `nurture` routes. Those cohorts keep
  `deploymentReadiness=not_required`; analytics must preserve route kind so a
  product-led outcome is not interpreted as a missing deployment handoff.

## Commercial Corrections And Cascades

Outcome events are append-only. Later commercial-state corrections do not delete
or rewrite outcomes.

Audit rules:

- If a deal has any accepted outcome but current commercial state is not
  `closed_won`, report `outcomeCommercialStateConflicts`.
- If a deal has `churned` before `deployed`, report
  `outcomeChurnBeforeDeploy`.
- `outcomeInvalidHistories` is the sum of accepted outcome-event rows matching any of these
  impossible histories:
  - `deployed` without a prior accepted `deployment_started`.
  - `landed` without a prior accepted `deployed`.
  - `expanded` without a prior accepted `landed`.
  - repeated accepted non-`expanded` outcomes for the same deal and outcome.
  - any accepted outcome after the first accepted `churned`, ordered by
    `occurred_at` then `created_at`.

These history checks are enforced by application code and re-derived from SQL by
audit. Row-local table CHECK constraints only enforce enum and ARR field shape;
they cannot prove lifecycle ordering.

No automatic cascade is allowed in Phase 2. Human operators must fix the source
commercial state or append a future correction event defined by a later spec.

## Audit Exit Policy

`ops_audit.py` must print every Phase 2 counter. Exit severity is explicit:

| Counter | Local | Integration | Live | Reason |
|---|---|---|---|---|
| `outcomeCommercialStateConflicts` | exit-blocking | exit-blocking | exit-blocking | Outcome history attached to a non-`closed_won` current state makes routing analytics untrustworthy. |
| `outcomeInvalidHistories` | exit-blocking | exit-blocking | exit-blocking | This should be impossible if write validation holds; SQL audit independently proves it. |
| `outcomeChurnBeforeDeploy` | warning | warning | warning | This is a bad business outcome but a valid fact, not a data-integrity failure. |

There is no Phase 2 `expectedRedPath` waiver. If a demo needs churn before
deploy, it should show as a warning counter rather than a waived failure.

## Metrics

Phase 2 metrics query `outcome_events` history:

- `deploymentStartedDeals`
- `deployedDeals`
- `landedDeals`
- `expandedDeals`
- `expandedArrDeltaUsd`
- `churnedDeals`
- `outcomeChurnBeforeDeploy`
- `outcomeCommercialStateConflicts`
- `outcomeInvalidHistories`
- `medianTimeClosedWonToDeployedHours`
- `medianTimeDeployedToLandedHours`

`medianTimeClosedWonToDeployedHours` uses the customer-reported `occurredAt`
from the first projected local `closed_won` commercial-state timeline event as
the start timestamp, while `commercial_states` remains the current-state
eligibility/conflict check. HubSpot stage-change receipts update external-stage
audit fields, not the local commercial-state projection, so they do not enter
this median until a local commercial-state write confirms the close. Deals
without current `closed_won` are excluded from the median and counted by
`outcomeCommercialStateConflicts` instead. Deals with invalid accepted outcome
histories are excluded from cycle-time medians so failing audit output does not
display misleading timing. `medianTimeDeployedToLandedHours` uses the first
accepted `deployed` and first later accepted `landed` outcome by `occurred_at`.
Both the TypeScript `/metrics` shape and `ops_audit.py --json` emit `null`, not
`0`, when a cycle-time median has no valid sample.
Compatibility note: this intentionally changes those JSON fields from
always-number to `number | null`; downstream readers should render `null` as
`n/a`, not coerce it to zero.

Deferred beyond the base Phase 2 slice: follow-up cohort breakdowns should join
back to existing route/source fields:

- route kind.
- sales owner.
- source channel.
- finance flag.
- legal flag.
- deployment readiness at first `deployment_started`.

Implemented indexes:

- `idx_outcome_events_deal` on `(deal_id, occurred_at)`.
- `idx_outcome_events_deal_outcome` on `(deal_id, outcome, occurred_at)`.
- `idx_outcome_events_outcome` on `(outcome, occurred_at)`.
- `idx_outcome_rejections_kind` on `(rejection_kind, created_at)`.
- `idx_outcome_rejections_deal` on `(deal_id, created_at)`.

## Acceptance Tests

- `/outcomes` is not registered unless `ALLOW_LOCAL_WRITE_ENDPOINTS=1`.
- `/outcomes` rejects missing or invalid `LOCAL_ENDPOINT_SECRET`.
- `/outcomes` rejects non-UUIDv4 `sourceEventId`.
- `/outcomes` rejects future-skewed `occurredAt` without claiming the source
  event key.
- Unknown `dealId` returns 404 and does not claim the source event key.
- A deal without accepted `closed_won` commercial state returns 409 and does not
  claim the source event key.
- Accepted `deployment_started` appends one `outcome_events` row and one
  timeline event.
- Same `(source, sourceEventId)` and same payload replays as duplicate no-op.
- Same `(source, sourceEventId)` with different payload records an
  idempotency violation and returns conflict.
- Outcome idempotency conflicts do not insert `outcome_rejections`.
- The `idempotency_violations.scope` migration accepts `outcome` while
  preserving existing Phase 1 scopes.
- `deployed` before `deployment_started` is rejected and recorded in
  `outcome_rejections`.
- `landed` before `deployed` is rejected and recorded in `outcome_rejections`.
- `expanded` before `landed` is rejected and recorded in `outcome_rejections`.
- Replaying a lifecycle-rejected source event is an idempotent no-op; the repair
  path uses a fresh `sourceEventId`.
- non-integer `arrDeltaUsd` fails schema validation before claiming the source
  event key.
- `expanded` requires positive `arrDeltaUsd`, records `invalid_arr_delta`, and
  claims the source event key when the field is absent, zero, or negative.
- non-`expanded` outcomes with `arrDeltaUsd` record `invalid_arr_delta` and
  claim the source event key.
- Multiple `expanded` events with distinct source ids are accepted and summed in
  metrics.
- `churned` after `deployment_started` but before `deployed` is accepted and
  counted as churn-before-deploy.
- Any outcome after `churned` is rejected until reactivation is specified.
- `outcome_events` CHECK constraints reject unknown outcome values and
  `arr_delta_usd` outside the `expanded` rule.
- `outcome_events` CHECK constraints reject non-`local` source values and
  non-`self_reported` operator sources.
- `outcome_rejections` requires non-null source-event and payload-hash fields.
- `ops_audit.py` reports outcome/commercial-state conflicts and invalid outcome
  histories from SQL, not by trusting TypeScript service responses.
- `ops_audit.py` treats churn-before-deploy as warning-only and
  outcome/commercial conflicts plus invalid histories as exit-blocking.
- `/state` exposes outcome counters without treating a single latest projection
  as the source of truth.
- Demo outcome fixtures match known seed deals by stable router deal id, not
  company text. Their commercial-state reasons include `demo outcome loop`, and
  their outcome operators are prefixed with `demo:` so persistent demo rows are
  distinguishable from real local writes.
- Persistent `--demo-outcomes` runs recognize demo outcome and projected
  commercial-state rows by their deterministic fixture source-event ids and
  refuse to layer fixture rows into a DB that already contains non-demo outcome
  rows or non-demo projected local commercial-state rows on the fixture deals.
  Observe-only local commercial-state observations such as stale/same-state
  rows or terminal-drift alerts remain visible in the ledger, but do not by
  themselves block deterministic fixture reconciliation.

## Implementation Order

1. Add Phase 2 outcome types and enum tests.
2. Add `outcome_events` and `outcome_rejections` schema with migration tests.
3. Rebuild `idempotency_violations` to admit `scope='outcome'`.
4. Add store-level `recordLocalOutcome` with idempotency and lifecycle tests.
5. Add local-only `POST /outcomes` behind the existing local write guard.
6. Add timeline events and `/state` metrics.
7. Extend `ops_audit.py` with outcome invariants and the explicit exit policy.
8. Add demo fixtures only after audit can prove the loop.
