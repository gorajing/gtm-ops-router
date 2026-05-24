# Phase 5 Spec: Agent Suggestions Inside Typed Rails

## Goal

Let an agent draft useful GTM operations work without giving it authority to
mutate HubSpot, Slack, routing policy, or downstream deployment state.

Phase 5 records suggestions as first-class ledger rows:

```text
proposed -> accepted | rejected
```

Every suggestion is tied to one routed deal, one source-event id, and one
durable payload hash. Every decision is tied to a separate source-event id and
a human principal. Accepted suggestions are still evidence, not execution.

## Suggestion kinds

The Phase 5 vocabulary is intentionally small:

- `handoff_summary`: a draft AE/deployment/finance/legal handoff.
- `missing_field_question`: a question the operator should answer before the
  next stage.
- `stale_deal_nudge`: a suggested follow-up when state has gone quiet.
- `policy_change_recommendation`: a draft policy adjustment based on Phase 4
  evaluation signals.

These are not free-form task types. A future agent can become more capable
inside this enum, but it cannot invent new operational authority by writing an
unknown kind.

## Storage contract

`agent_suggestions` stores:

- immutable proposal fields: `deal_id`, `kind`, `title`, `body`, `rationale`,
  `source`, `source_event_id`, `source_payload_hash`, `created_by`,
  `occurred_at`, `created_at`.
- decision fields: `status`, `decided_at`, `decided_by`,
  `decision_source_event_id`, `decision_payload_hash`, `decision_reason`.

`status='proposed'` requires all decision fields to be null.
`status IN ('accepted', 'rejected')` requires all decision fields to be set.

Replay behavior follows the rest of the router:

- Same proposal `sourceEventId` and same payload: duplicate no-op.
- Same proposal `sourceEventId` and different payload:
  `idempotency_violations.scope='agent_suggestion'`.
- Same decision `sourceEventId` and same payload: duplicate no-op.
- Same decision `sourceEventId` and different payload:
  `idempotency_violations.scope='agent_suggestion_decision'`.
- A second, distinct decision event for an already decided suggestion returns
  `already_decided` and does not claim the source-event id.

Payload identity is byte-for-byte semantic input identity after JSON parsing,
server-side trimming, and canonical key ordering. All accepted request fields
participate in the hash. Proposal identity includes `dealId`, `sourceEventId`,
`kind`, `title`, `body`, `rationale`, `createdBy`, and `occurredAt`. Decision
identity includes the path-bound `suggestionId` plus `sourceEventId`,
`decision`, `humanPrincipal`, `reason`, and `occurredAt`. Retrying clients must
persist and replay the same `sourceEventId` plus the same timestamp, principal,
body, and reason values; regenerating `occurredAt` on retry is treated as an
idempotency conflict, not a duplicate.

Precondition failures that do not mutate the ledger intentionally do not claim
their source-event ids. That includes `not_found`, `not_routed`,
`already_decided`, and `decision_before_proposal`. The trade-off is deliberate:
a bad early attempt does not burn a source event forever, but operators should
monitor 404/409/422 rates because those failed attempts are not preserved as
idempotency violations. In particular, after a suggestion has already been
decided, later attempts with a new source-event id are classified as
`already_decided`; because that id is not claimed, a mutated replay of the same
failed decision attempt is also `already_decided`, not `idempotency_conflict`.

## API contract

Phase 5 uses the existing local-only write guard:

- `ALLOW_LOCAL_WRITE_ENDPOINTS=1`
- `LOCAL_ENDPOINT_SECRET` with at least 32 characters
- loopback host only
- no trusted proxy
- no live HubSpot/Slack intent in the same process

### `POST /agent-suggestions`

```json
{
  "dealId": "D-...",
  "sourceEventId": "33333333-3333-4333-8333-333333333333",
  "kind": "handoff_summary",
  "title": "Draft AE handoff",
  "body": "Summarize the current operating context.",
  "rationale": "High-ARR routed deal needs a concise owner handoff.",
  "createdBy": "local-agent",
  "occurredAt": "2026-05-22T13:00:00.000Z"
}
```

Only `stage='routed'` deals can receive suggestions. Missing deals return
`not_found`, and deals that exist in any non-routed router stage return
`not_routed`, before source-event claim.

Decision writes are bookkeeping for an already-created suggestion. They do not
re-check the deal's current router stage because the operator may still need to
accept or reject an old draft to keep the suggestion ledger complete.

The HTTP layer returns `409` for state conflicts (`not_routed`,
`already_decided`, and idempotency conflicts), `404` for missing resources, and
`422` for invalid chronology (`decision_before_proposal`). Clients should read
the response body's `status` field; successful first writes and idempotent
duplicates both return HTTP 200.

### `POST /agent-suggestions/:suggestionId/decision`

```json
{
  "sourceEventId": "44444444-4444-4444-8444-444444444444",
  "decision": "accepted",
  "humanPrincipal": "ops@example.com",
  "reason": "Accurate enough for the account owner.",
  "occurredAt": "2026-05-22T13:05:00.000Z"
}
```

In the local console, `createdBy` and `humanPrincipal` are self-reported labels
from the holder of `LOCAL_ENDPOINT_SECRET`. That is acceptable only because the
route is loopback-only and not registered in live-integration mode. Before any
non-local deployment, both fields must be bound to authenticated identities and
not trusted from request JSON.

`decided_at` stores the operator-reported decision time (`occurredAt`). The
system write time remains available through the claimed source event's
`external_event_keys.recorded_at` row and the append-only timeline event `ts`.

### `POST /agent-suggestion-runs/policy-evaluation`

```json
{
  "createdBy": "policy-agent",
  "evaluatedAt": "2026-05-23T13:00:00.000Z",
  "limit": 10
}
```

This local-only run reads the Phase 4 policy-evaluation report and writes
`policy_change_recommendation` suggestions for the highest-priority current
signals. It is deterministic for a given signal: the generated `sourceEventId`
is derived from the signal type, deal id, observed timestamp, and
recommendation version. Mutable value snapshots such as reason text, ARR, or
expansion amount stay in the suggestion payload, not the source-event identity.
Replaying the same run produces duplicate no-ops.

The run does not accept recommendations, change routing thresholds, move
HubSpot stages, post to Slack, or assign work. It only drafts suggestions into
the same proposal ledger that humans must accept or reject.

## Dashboard contract

`GET /state` includes a bounded mix of `agentSuggestions` (50 by default).
Proposed suggestions and recently decided suggestions each receive part of the
cap so a noisy proposal backlog cannot hide recent human decisions. Within that
bounded set, proposed rows render before decided rows. The console shows a
global suggestions panel with status, kind, deal id, title, rationale, and
decision reason; selecting a deal highlights matching rows instead of filtering
the panel. The SQLite ledger remains the source of truth for older suggestions
outside the dashboard cap. Deal detail keeps the append-only timeline events:

- `agent_suggestion_proposed`
- `agent_suggestion_decided`

## Non-goals

- No autonomous HubSpot stage moves.
- No autonomous Slack posts.
- No automatic scoring-weight or threshold changes.
- No automatic task assignment.
- No production identity model.

Phase 5 is a consent and evidence layer. It proves the agent can draft inside
typed rails, humans can accept or reject the work, and rejected suggestions stay
visible enough to improve the system later.
