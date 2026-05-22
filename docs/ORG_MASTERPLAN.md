# Org Master Plan: GTM-to-Deployment Control Plane

This plan evolves `gtm-ops-router` from a deal-routing proof into a small,
closed-loop operating spine for a fast-scaling AI company.

The primary audience for the next slice is still a reviewer/operator evaluating
the repo as a portfolio artifact. Phase 1 should be production-shaped, but it
is not a production rollout plan.

The goal is not to replace HubSpot, Slack, finance tooling, legal tooling, or
deployment project management. The goal is to make the handoffs between them
auditable, timely, and improvable.

## Product thesis

The current system proves the first handoff:

```text
inbound deal -> enrich -> score -> route -> HubSpot/Slack/store -> audit
```

The next useful system proves one more handoff:

```text
routed deal -> commercial state -> deployment readiness -> Slack handoff -> audit
```

Only after that slice works should the tool ingest post-sale outcomes and tune
policy from reality. The sequence matters: outcome intelligence without a
reliable handoff record is just another dashboard with soft numbers.

## Who this serves

| Cluster | Their operating question | Tool responsibility |
|---|---|---|
| AEs / GTM Lead / Market Launcher | Which accounts need human attention now, and why? | Keep routing, owner, SLA, and commercial state traceable. |
| Growth / Field Marketing / PMM | Which sources and messages produce real customers? | Preserve source/channel context through commercial and deployment outcomes. |
| Finance / Accounting | Which deals need approval or clean order-to-cash handoff? | Preserve stable ids, ARR, approval flags, and audit history. |
| Legal | Which deals need commercial/privacy/DPA attention? | Preserve legal flags and review context without pretending the router makes legal decisions. |
| Deployment Strategists / FDEs / Deployment Ops | Which closed-won customers are ready to staff, and what will make them hard? | Produce a structured deployment readiness record and Slack handoff. |
| Leadership | Is the operating system improving or creating hidden work? | Report conversion, blocked handoffs, readiness gaps, and later outcome quality from one ledger. |

## Design principles

1. **One operating record, many systems.** HubSpot remains the CRM and Slack
   remains the alerting surface. The router owns cross-system identity, events,
   and handoff invariants.
2. **Phase 1 is the implementation contract.** Later phases are directional and
   must get their own specs before code. Do not leak Phase 3 or Phase 5 fields
   into Phase 1 just because they might be useful later.
3. **Ledger before learning.** No self-tuning policy or AI worker until the
   system has a reliable, audited record of handoffs and post-sale outcomes.
4. **Human judgment stays explicit.** Finance approval, legal review,
   negotiation, and staffing are surfaced as work; they are not automated away.
5. **Every phase has an audit acceptance test.** If the audit cannot prove the
   handoff, the phase is not done.
6. **Public artifact stays focused.** Demonstrate judgment and extensibility,
   not a fake enterprise suite.

## Phase 0: Narrative and guardrails

**Goal:** Make the org-level direction discoverable without bloating the README.

**Implementation**

- Add this master plan.
- Link it from the README under "What I'd build next".
- Keep private hiring research out of the repo.

**Acceptance checks**

```bash
rg -n "^## Phase 1: Deployment readiness handoff$" docs/ORG_MASTERPLAN.md
rg -F "(docs/ORG_MASTERPLAN.md)" README.md
! rg "Employment[[:space:]]Type|Compensat[i]on|Apply[[:space:]]for[[:space:]]this[[:space:]]Job" docs README.md
! git ls-files | rg '(^|/)\.env$'
```

## Phase 1: Deployment readiness handoff

**Goal:** When a deal reaches `closed_won`, produce a deployment handoff that a
Deployment Strategist, FDE, or Deployment Ops owner could actually use.

This is the next code slice. It is deliberately narrower than the full master
plan.

### Phase 1 domain

Add only these concepts:

```text
CommercialState = open | proposal_sent | negotiating | closed_won | closed_lost

DeploymentReadiness =
  not_required
  pending
  ready
  blocked

DeploymentBlocker =
  deployment_use_case_unclear
  deployment_integration_unknown
  deployment_data_unavailable
```

Phase 1 does **not** add multi-owner blockers, agent suggestions, post-sale
outcomes, reactivation, CLM workflows, or a full external-reference history
model. Those are later specs.

### Commercial-state inputs

Use the existing HubSpot stage webhook as the CRM input. Add a semantic mapping
config, for example:

```text
HUBSPOT_STAGE_MAP_JSON='{"stage_open_id":"open","stage_proposal_id":"proposal_sent","stage_negotiating_id":"negotiating","stage_closed_won_id":"closed_won","stage_closed_lost_id":"closed_lost","stage_notify_only_id":"ignore"}'
```

The exact HubSpot stage ids are portal-specific. The mapping value type is
`CommercialState | "ignore"`; `ignore` is a sentinel, not a commercial state.
It is allowed for Slack-notify-only stages that should not project commercial
state. Inline JSON must be one line because the local `.env` loader is
intentionally one `KEY=value` per line. Invalid JSON must fail boot instead of
falling back to an empty map. For larger portals, support
`HUBSPOT_STAGE_MAP_PATH=config/hubspot-stage-map.json` as the preferred
code-reviewable form. The path variant has the same strictness as inline JSON:
boot fails if the file is unreadable, invalid JSON, or maps to values outside
`CommercialState | "ignore"`. Boot should fail if both `HUBSPOT_STAGE_MAP_JSON`
and `HUBSPOT_STAGE_MAP_PATH` are set. When HubSpot webhooks or live integrations
are enabled, boot must also fail if neither stage-map source is set. Pure local
dry-runs that do not register HubSpot webhook handling may omit the stage map.

The map does not replace `HUBSPOT_NOTIFY_STAGE_IDS`, which remains the Slack
notification allowlist.
Live mode must also fail boot if HubSpot webhooks are enabled and
no stage map is provided. In live mode, every stage id in
`HUBSPOT_NOTIFY_STAGE_IDS` must also appear in the resolved stage map with a
commercial state or `ignore`; an interesting unmapped stage is a boot error, not
a quiet audit counter.

For deterministic local demos, add a local-only endpoint:

```text
POST /commercial-state
{
  "dealId": "router deal id",
  "commercialState": "closed_won",
  "sourceEventId": "UUIDv4 idempotency key",
  "reason": "optional operator note for local/admin corrections",
  "expectedRedPath": false,
  "occurredAt": "ISO timestamp"
}
```

This endpoint must stay localhost/internal-only unless authentication is added.
It exists to drive the demo without requiring the user to drag a HubSpot card.
Phase 1 should register it only when `ALLOW_LOCAL_WRITE_ENDPOINTS=1`. If live
integrations are enabled at the same time, fail at startup as specified below;
do not fall back to registering the routes in dry-run mode or silently omitting
them. Public/live environments should rely on the signed HubSpot webhook or add
a real auth token before exposing this route.
Local `/commercial-state` requests must require UUIDv4 `sourceEventId`, matching
`/deployment-facts`. `reason` is optional but should be stored in event meta when
present, especially for local/admin correction events.
Use `JSON.stringify(["commercial_state", "local", sourceEventId])` as the
authoritative source-event claim key in `external_event_keys.key`.
`expectedRedPath` is optional and exists only for local demo fixtures that
intentionally exercise terminal drift. Accept it only when
`ALLOW_EXPECTED_RED_PATHS=1`; live HubSpot events and normal local corrections
must not be able to mark their own drift as expected. When accepted, carry it
into the resulting `commercial_terminal_drift` event meta so
`ops_audit.py --allow-expected-red-paths` has a concrete source for the waiver.
`commercial_terminal_drift` is the per-deal timeline event type for terminal
drift alerts; add it to the typed event union/checks when terminal-drift support
is implemented.
HubSpot webhook processing must never copy an `expectedRedPath` field from the
raw external payload into router event meta, even in local unsigned-webhook
demos. The only source of that audit waiver is the gated local
`/commercial-state` field above.
The handler should also enforce loopback requests at the application layer, not
only by relying on the server bind address. Use `req.socket.remoteAddress` and
ignore forwarded headers for this check. Accept `127.0.0.1`, `::1`, and
IPv4-mapped loopback addresses such as `::ffff:127.0.0.1`. When local
endpoints are registered, boot should also require the server bind address to
be loopback and reject `Host` headers outside `localhost`, `127.0.0.1`, and
`[::1]`. A `Host` header may include no port or the configured port; if a port
is present and differs from the configured server port, reject it.

For Phase 1, "live mode" means `--live-integrations` or any runtime where
HubSpot/Slack writes are configured as live rather than dry-run. Treat the
presence of any of these env vars as live-integration intent for boot-guard
purposes: `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_WEBHOOK_SECRET`,
`HUBSPOT_PORTAL_ID`, `PUBLIC_BASE_URL`, `SLACK_BOT_TOKEN`,
`SLACK_CHANNEL_ID`, or `SLACK_DEPLOYMENT_CHANNEL_ID`.
`ALLOW_LOCAL_WRITE_ENDPOINTS` covers all local-only write/retry endpoints in
Phase 1: `/commercial-state`, `/deployment-facts`, and
`/notification-retry`. If
`ALLOW_LOCAL_WRITE_ENDPOINTS=1` is set in live mode, boot should fail; do not
silently skip route registration. Local endpoints require
`LOCAL_ENDPOINT_SECRET` even in local/demo mode. When local endpoints are
enabled, boot should reject missing secrets or secrets shorter than 32
characters. If local endpoints are disabled, ignore `LOCAL_ENDPOINT_SECRET` for
boot-failure purposes. Use a constant-time header comparison so another process
on the same host cannot mutate state by accident.
`/notification-retry` is specified later in the Notifications and UI section;
it is listed here only to declare that the same exposure, secret, loopback, and
live-mode refusal rules apply.
If `ALLOW_LOCAL_WRITE_ENDPOINTS=1` and `TRUST_PROXY=1` are both set, boot should
fail. Phase 1's loopback guarantee intentionally ignores forwarded headers, so a
proxied local-write setup needs real authentication before it can be supported.
If `ALLOW_EXPECTED_RED_PATHS=1` is set in live mode, boot should also fail. The
flag is only for local demo fixtures and should never be available in a process
that can observe or write real HubSpot/Slack state.

### Deployment readiness facts

Phase 1 needs one deployment-side input so the handoff is not purely inferred
from sales data. Add a local/internal endpoint:

```text
POST /deployment-facts
{
  "dealId": "router deal id",
  "sourceEventId": "UUIDv4 idempotency key; do not use content hash",
  "useCaseClear": true,
  "integrationsKnown": true,
  "dataReady": true,
  "operator": "local operator name or initials",
  "occurredAt": "ISO timestamp"
}
```

This endpoint has the same exposure rule as `/commercial-state`: local/internal
only until authentication exists. In dry-run demos, this is the Deployment
Strategist/FDE input that flips a blocked handoff to ready.

All three booleans and a non-empty `operator` string are required in Phase 1.
Partial fact updates are deferred until there is a real production intake
surface such as an internal form, Slack command, or HubSpot property mirror.
After secret, shape, and UUID validation, `/deployment-facts` must verify that
`dealId` exists in `deals`. Unknown deal ids return 404 and write no
`deployment_facts`, readiness row, event, or source-event claim; this avoids
orphan facts while still allowing an operator to retry after the router deal
exists with the same `sourceEventId`. This deal-existence check happens before
the source-event key claim. The caller must provide a fresh
`sourceEventId` for each semantic change; a content hash is not valid because
`true -> false -> true` corrections must not dedupe against the first event.
Require UUIDv4 format. If a duplicate UUID arrives with a different payload
hash, reject it as an idempotency violation. Record the caller-supplied
`operator`, server-assigned `operatorSource=self_reported`, and loopback source
in event meta. This is not authentication, but it keeps the demo audit trail
honest.
Use `JSON.stringify(["deployment_facts", "local", sourceEventId])` as the
authoritative source-event claim key in `external_event_keys.key`.
`deployment_facts.source` and `deployment_facts_rejections.source` store the
human-readable source (`local`) and `source_event_id` stores the raw UUID; those
tables are not the idempotency fence.

### Readiness derivation

Run readiness derivation inside a single SQLite transaction per deal:

```text
read current deal + commercial state
dedupe `(source, sourceEventId)`
append event
derive readiness
upsert readiness row
commit
```

Rules:

- Commercial projection is monotonic for Phase 1:
  `open -> proposal_sent -> negotiating -> terminal`.
  `closed_won` and `closed_lost` are terminal siblings, not ordered values.
  `negotiating -> closed_won` and `negotiating -> closed_lost` are valid
  forward transitions. For strictly newer events
  (`incoming.occurredAt > current.occurredAt`), any terminal-to-terminal
  cross-state move or terminal-to-nonterminal move is unsupported in Phase 1.
  Strictly newer same-state repeats, including `closed_won -> closed_won`, use
  the `same_state_newer` observation rule below. Equal-timestamp terminal sibling
  conflicts use the tie rules below before regression handling.
- The ordering is ordinal, not adjacency-required. Any forward advance is valid,
  including skipped states such as `open -> closed_won` or
  `proposal_sent -> closed_lost`.
- Monotonicity is checked against the source event `occurredAt` timestamp, not
  server receive time.
- If `occurredAt` is older than the projected row, append a
  `commercial_stage_observation` event, insert
  `external_event_observations.observation_code=stale_stage_observation`, and
  keep the projection unchanged, even if the stale event has a higher semantic
  state.
- If `occurredAt` is equal to the projected row but maps to a different state,
  first check whether the tie is between `closed_won` and `closed_lost`. If so,
  treat that as the only terminal sibling pair Phase 1 supports; duplicate
  same-state terminal deliveries are same-state ties, not additional terminal
  siblings.
  For multi-event webhook batches, group same-deal/same-`occurredAt` mapped
  states before projection; if both terminal siblings are present, apply this
  terminal-sibling path directly before the generic ranked-tie path and emit
  `tieArrivalMode=batch`.
  apply terminal-tie resolution only inside
  `TERMINAL_TIE_WINDOW_MS = 300000` from the current projection's
  `terminal_projected_at` server timestamp. Inside that short receipt window, do
  not use delivery order; resolve to `closed_lost` as the conservative deterministic
  projection, mark `terminalTieConflict=true` in event meta, and surface
  `commercialTerminalTieConflicts` in audit output. If the current projection is
  `closed_won` and the incoming state is `closed_lost`, update projection and
  readiness to `closed_lost`/`not_required` in the same transaction, set
  `commercial_states.projected_via_terminal_tie=1`,
  `terminal_tie_occurred_at=occurredAt`, `terminal_tie_resolved_at=now`, and
  preserve the original `terminal_projected_at`; also insert a
  `terminal_tie_conflict` observation with `projected=1`. If the current projection is
  already `closed_lost`, keep the state and readiness unchanged but set
  `commercial_states.projected_via_terminal_tie=1` and terminal-tie provenance
  if it is not already set; preserve the original `terminal_projected_at` and
  record `terminal_tie_conflict` with `projected=0` because the stored state did
  not change. This keeps the resolved tie represented consistently regardless of
  delivery order. `terminal_projected_at` is the
  server-time anchor for terminal-tie eligibility. Direct, unambiguous terminal
  projections set `terminal_projected_at=now`,
  `projected_via_terminal_tie=0`, and clear the terminal-tie timestamps. Outside
  that receipt window, keep the
  current projection and treat the event as terminal drift requiring manual
  escalation, not as a silent downgrade. Equal-timestamp
  terminal sibling conflicts are operator-visible conflicts, but Phase 1 must
  not staff an ambiguous deal by accident. This is a one-way door in Phase 1:
  after an in-window terminal tie resolves to `closed_lost`, the deal remains
  `not_required`, and any later `closed_won` event is terminal drift that
  requires manual escalation or Phase 2+ correction semantics.
  Additional same-timestamp terminal sibling challengers that arrive while the
  original `terminal_projected_at` receipt window is still open also keep
  `closed_lost`, record another `terminal_tie_conflict` observation with
  `projected=0`, and do not mutate `commercial_states` beyond already-recorded
  tie provenance.
  `TERMINAL_TIE_WINDOW_MS` and `MAX_FUTURE_SKEW_MS` both default to `300000` ms
  in Phase 1, but they are separate named constants with different meanings and
  must not share a single implementation variable.
  `projected_via_terminal_tie` describes how the current terminal projection was
  produced; it is not the complete audit source for terminal tie conflicts.
  `terminal_tie_resolved_at` is set only when the second sibling of an
  equal-timestamp `closed_won`/`closed_lost` pair is processed inside the receipt
  window and the canonical terminal-sibling precedence resolves the pair,
  regardless of whether the stored state value changes on that second delivery.
  Audit must count `commercialTerminalTieConflicts` from
  `external_event_observations.observation_code='terminal_tie_conflict'`, which
  captures both delivery orderings.
  For all other equal-timestamp different-state ties, resolve by deterministic
  rank rather than delivery order:
  `open < proposal_sent < negotiating < terminal`. If the incoming state has
  higher rank, update projection and readiness in the same transaction and append
  `commercial_stage_tie_resolved` plus
  `external_event_observations.observation_code=commercial_stage_tie_resolved`
  with `projected=1`; otherwise append `commercial_stage_tie_ignored`, insert
  `external_event_observations.observation_code=commercial_stage_tie_ignored`
  with `projected=0`, and keep projection unchanged.
  This rank applies only to equal-timestamp tie resolution after terminal sibling
  ties have been excluded. For different `occurredAt` values, terminal-to-terminal
  movement is unsupported in both directions regardless of rank.
  If ranked tie resolution projects a terminal state such as `closed_won` or
  `closed_lost`, apply the same terminal-column rules as a direct terminal
  projection: set `terminal_projected_at=now`,
  `projected_via_terminal_tie=0`, and clear terminal-tie timestamps.
- If `occurredAt` is equal to the projected row and maps to the same state,
  append `commercial_stage_tie_ignored` with `tieKind=same_state` and keep the
  projection unchanged. The cross-deal `external_event_observations` row uses
  `observation_code=same_state_tie`; lower-rank different-state ties use
  `commercial_stage_tie_ignored`. Different source events with the same
  timestamp should be observable, but they should not reset projection age.
  The shared timeline event type is intentional: timeline consumers must use
  `tieKind` (`same_state` vs `lower_rank`) to distinguish duplicate-like
  same-state ties from rank-suppressed challengers.
- If `occurredAt` is newer and maps to the same current commercial state, append
  `commercial_stage_observation` with `observation_code=same_state_newer` and keep
  the commercial projection unchanged; also insert
  `external_event_observations.observation_code=same_state_newer` with
  `projected=0`. Do not advance the projected
  `occurred_at`, and do not reset readiness or projection age. For terminal
  same-state repeats, do not reset `terminal_projected_at`; the terminal-tie
  eligibility window remains anchored to the first accepted terminal projection.
- If `occurredAt` is newer and moves forward in the state chain, project it.
- `ignore`-mapped stages never trigger commercial regression handling; they are
  observe-only. Record them in `external_event_observations` with
  `observation_code=ignored_stage` so audit can distinguish deliberately ignored
  stages from missing deliveries. Evaluate `ignore` before all monotonicity,
  regression, tie, and terminal-drift checks; `ignored_stage` is the only
  observation written for an ignored stage regardless of current projection.
  If an `ignore`-mapped stage is also in `HUBSPOT_NOTIFY_STAGE_IDS`, the generic
  stage-change Slack notification is still allowed; `ignore` suppresses
  commercial projection only, not the notify allowlist.
- For any newer movement where the current projection is already terminal and
  the incoming mapped state differs, or any out-of-window same-timestamp
  terminal sibling challenger, keep projection unchanged and treat it as
  terminal drift. This applies whether the incoming state is another terminal
  state or a non-terminal stage such as `negotiating`. Append the
  `commercial_terminal_drift` timeline event, insert
  `external_event_observations.observation_code=terminal_drift_unsupported`,
  increment `commercialTerminalDriftAlerts`, and claim one redacted Slack alert
  lease with key `commercial_terminal_drift:<source>:<sourceEventId>`. This key
  is per incoming drift event, not per deal; sequential post-terminal events may
  each alert once.
  Include `driftKind=late_delivery_tie` for out-of-window same-timestamp terminal
  sibling challengers and `driftKind=terminal_regression` for strictly newer
  movement away from a terminal projection. Delivery more than five minutes late
  is operator-reviewed because Phase 1 cannot distinguish webhook delay from a
  real post-terminal correction without a human owner. The Slack payload is
  redacted and contains only router id, incoming state, current projection,
  event timestamp, and `driftKind`.
  `commercial_terminal_drift` timeline meta must include `source`,
  `sourceEventId`, `stageId`, `stageLabel`, `incomingCommercialState`,
  `currentCommercialState`, `incomingOccurredAt`, `currentOccurredAt`,
  `driftKind`, `tieResolutionDrift`, and `expectedRedPath`.
  `tieResolutionDrift` is a boolean: true only when the current terminal
  projection was produced by an in-window terminal-tie resolution and this drift
  event is processed within `TERMINAL_TIE_WINDOW_MS` of
  `commercial_states.terminal_tie_resolved_at`; otherwise false.
- For newer backward movement where the current projection is not terminal,
  append `commercial_regression_unsupported`, insert
  `external_event_observations.observation_code=commercial_regression_unsupported`,
  and keep projection unchanged.
  Production-grade regression, re-sign, and retraction workflows belong to
  Phase 2+.
`commercial_stage_observation` timeline meta must include `source`,
`sourceEventId`, `stageId`, `stageLabel`, `incomingCommercialState`,
`currentCommercialState`, `incomingOccurredAt`, `currentOccurredAt`, and
`observationCode`. The shared event type covers both stale-stage and
same-state-newer observations; both also write `external_event_observations`.
- Missing, invalid, or more-than-5-minutes future-skewed `occurredAt` values
  fail local endpoint requests before source-event claim, so an operator can
  retry the same `sourceEventId` with a corrected timestamp. HubSpot
  future-skew is also rejected before source-event claim so natural webhook retry
  can succeed once the timestamp is within the allowed window; do not insert an
  `external_event_keys` claim or `external_event_observations` row for
  future-skew-only HubSpot deliveries. Invalid HubSpot timestamps are not
  naturally repairable, so those deliveries do claim/dedupe the event key and use
  `external_event_observations.observation_code=invalid_timestamp`.
- Any currently accepted non-`closed_won` deal has
  `deploymentReadiness=not_required`.
- If a `closed_won` deal is not on the `human_assisted` route, set
  `deploymentReadiness=not_required` and stop; Phase 1 does not staff
  `self_serve` or `nurture` wins.
- A `closed_won` deal on `human_assisted` requires readiness review.
- The readiness row materializes in the same transaction that accepts the
  `closed_won` projection; there is no async grace period for row creation.
Commercial-state processing runs readiness derivation only when the stored
commercial projection changes. Observation-only paths such as ignored stages,
stale stages, same-state-newer events, unsupported regressions, and terminal
drift do not re-derive readiness. Successful `/deployment-facts` writes always
run readiness derivation for the same deal.
- If required deployment facts have not been submitted yet, set `pending` with
  no blocker code. `pending` means "needs assessment," not "assessed and
  blocked."
- If required readiness facts are present (`useCaseClear`,
  `integrationsKnown`, and `dataReady`), set `deploymentReadiness=ready`.
Whenever derivation sets `not_required`, `pending`, or `ready`, clear
`blocker_code`, `blocker_entered_at`, and `secondary_blocker_codes` in the same
upsert. Only the `blocked` state may retain blocker fields.
When derivation sets `blocked`, set `blocker_entered_at=now` if the previous
readiness was not `blocked` or if the primary `blocker_code` changed; otherwise
preserve the existing `blocker_entered_at` so age reflects the current primary
blocker, not every derivation run.
- Check `DEPLOYMENT_FACT_MAX_AGE_DAYS = 30` in two places. At write time,
  back-dated incoming facts older than the limit are claimed, appended as a
  `deployment_facts_stale_ignored` event, and inserted into
  `deployment_facts_rejections`, but they must not overwrite current facts or
  make a deal `ready`. At derivation/audit time, previously accepted facts older
  than the limit are stale and behave like missing facts.
  If a first-ever facts submission is stale at write time, the deal remains
  `pending` and no `deployment_facts` row is written, but the rejection must be
  inserted into `deployment_facts_rejections` and reported under
  `readinessFactsStaleIgnored` rather than making it look like no one ever
  submitted facts.
- Phase 1 does not emit `deployment_facts_expired` timeline events. Fact
  freshness is authoritative only from `deployment_facts.occurred_at` plus
  `DEPLOYMENT_FACT_MAX_AGE_DAYS`, as recomputed by `/state` and `ops_audit.py`.
  A later scheduler-backed production slice can add explicit expiration events.
- Phase 1 does not add a background scheduler. `ops_audit.py` is the backstop:
  it must recompute fact age independently and fail/report any persisted `ready`
  or `blocked` row whose latest deployment facts are older than
  `DEPLOYMENT_FACT_MAX_AGE_DAYS`, even if no new event has triggered
  re-derivation yet. At derivation time, stale accepted facts behave like
  missing facts, so a closed-won human-assisted deal with only stale facts becomes
  `pending`, not `ready` or `blocked`.
  The Phase 1 operator repair path is to resubmit the readiness facts with a
  fresh `occurredAt` and a new `sourceEventId`, even when the boolean values are
  unchanged. There is no separate "force rederive" admin endpoint in Phase 1.
For blocked derivation, evaluate all three blocker conditions independently
before selecting the primary blocker. Do not implement these next three bullets
as an early-return chain; lower-priority matches feed `secondary_blocker_codes`.
- If the use case is unclear, set `blocked` with
  `deployment_use_case_unclear`.
- If integrations are unknown, set `blocked` with
  `deployment_integration_unknown`.
- If deployment facts say data is not ready, set `blocked` with
  `deployment_data_unavailable`.
- For Phase 1, `self_serve` and `nurture` routes are `not_required` even if
  they later become interesting in a real production workflow.

Deployment fact updates are also monotonic by `occurredAt`. First reject
`occurredAt` values more than `MAX_FUTURE_SKEW_MS = 300000` ahead of server now
before writing or claiming the event key; future facts would otherwise block
legitimate later updates and must remain operator-correctable with the same
`sourceEventId`. After that future-skew gate and the deal-existence check
described above, compute the payload hash and check/claim the
`/deployment-facts` event key before comparing against current fact timestamps.
If the key already exists with the same payload hash, return the prior duplicate
result without reprocessing. If it exists with a different payload hash, record
an `idempotency_violations` row with `scope='deployment_facts'` and return
before stale-age or ordering checks. Do not also insert a
`deployment_facts_rejections` row for this branch; the structured
`idempotency_violations` row is the audit-visible record. Only a newly claimed
key reaches the stale checks, so replaying the same stale fact event is a
duplicate no-op. Run stale checks in this order:

1. If incoming `occurredAt` is older than `DEPLOYMENT_FACT_MAX_AGE_DAYS` from
   server now, append `deployment_facts_stale_ignored` with `staleKind=age` and
   insert a `deployment_facts_rejections` row; do not write a
   `deployment_facts` row.
2. Otherwise, if a current `deployment_facts` row exists and incoming
   `occurredAt` is older than the current row, append
   `deployment_facts_stale_ignored` with `staleKind=ordering`, insert a
   `deployment_facts_rejections` row, and do not overwrite newer facts.
3. Otherwise, if a current `deployment_facts` row exists and incoming
   `occurredAt` equals the current row, keep the current row and append
   `deployment_facts_tie_ignored`; include `tieKind=same_values` when all
   booleans match and `tieKind=different_values` when any boolean differs. A
   `same_values` tie is a duplicate-like no-op. A `different_values` tie is a
   409-style operator-visible conflict: the event key is claimed, the ignored
   event is recorded, a `deployment_facts_rejections` row with
   `rejection_kind='tie_conflict'` is inserted, and the handler must tell the
   operator to resubmit the correction with a strictly newer `occurredAt`.

A successful `/deployment-facts` write must trigger readiness derivation for the
same deal in the same transaction shape as a commercial-state change. This is
what flips a closed-won `pending` handoff to `ready` or `blocked`; do not wait
for another commercial event.
Rejected deployment-facts inserts should use `INSERT OR IGNORE` (or an
equivalent existence check) after the source-event claim and payload-hash check.
Replaying the same rejected source event returns the prior rejection result as a
duplicate no-op rather than surfacing a `UNIQUE (source, source_event_id)`
constraint error.

Normalize every stored timestamp to ISO-with-milliseconds-Z before comparing or
persisting. Do not compare raw timestamp strings from external systems.

When multiple readiness blockers apply, evaluate all three blocker conditions
independently first, then use this precedence for the single Phase 1 primary
`blocker_code`: unclear use case, unknown integrations, deployment data not
ready. Store lower-priority matched blocker codes as a JSON array in
`secondary_blocker_codes` so the later multi-blocker migration is
non-destructive. Store `secondary_blocker_codes=NULL`, not `[]`, when no
secondary blockers apply; `NULL` means "no secondary blockers." Keep `reason`
for sanitized, human-readable explanatory text only. `reason` is optional:
`blocked` rows may use it for a generated blocker summary, `pending` rows may
use it for "awaiting deployment facts," and `ready`/`not_required` rows should
normally clear it. Never store raw notes, customer text, or contract details in
`reason`.
Phase 1 does not store per-secondary blocker timestamps. If a secondary blocker
is promoted to primary after a higher-priority blocker is resolved,
`blocker_entered_at` resets to the promotion time. Audit should describe blocked
age as "current primary blocker age," not "first known age for every blocker."
A later production slice can add `secondary_blocker_entered_at` or a blocker
history table if secondary duration becomes operationally important.

Phase 1 blocker ownership is simple: every `DeploymentBlocker` is owned by the
deployment cluster. Waivers, multi-owner blockers, and authority checks are not
part of Phase 1; if a blocker is wrong, resolve it by updating the underlying
readiness facts and re-deriving.

### Storage

Add narrow tables keyed by router deal id, plus small config/observation tables
for audit-visible external behavior:

Phase 1 continues to use the existing per-deal timeline table:

```text
events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  from_st TEXT NOT NULL,
  to_st TEXT NOT NULL,
  detail TEXT NOT NULL,
  meta TEXT
)
```

New Phase 1 event types are stored in `detail`, with structured JSON in `meta`.
The existing `from_st`/`to_st` columns should preserve the router stage context;
commercial/readiness-specific state goes in typed `meta`.

```text
commercial_states (
  deal_id TEXT PRIMARY KEY,
  commercial_state TEXT NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_payload_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  state_entered_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_projected_at TEXT,
  projected_via_terminal_tie INTEGER NOT NULL DEFAULT 0,
  terminal_tie_occurred_at TEXT,
  terminal_tie_resolved_at TEXT,
  CHECK (
    commercial_state IN (
      'open',
      'proposal_sent',
      'negotiating',
      'closed_won',
      'closed_lost'
    )
  ),
  CHECK (projected_via_terminal_tie IN (0, 1)),
  CHECK (
    commercial_state IN ('closed_won', 'closed_lost') OR
    terminal_projected_at IS NULL
  ),
  CHECK (
    commercial_state NOT IN ('closed_won', 'closed_lost') OR
    terminal_projected_at IS NOT NULL
  ),
  CHECK (
    projected_via_terminal_tie = 0 OR
    commercial_state IN ('closed_won', 'closed_lost')
  ),
  CHECK (
    projected_via_terminal_tie = 0 OR
    (terminal_tie_occurred_at IS NOT NULL AND terminal_tie_resolved_at IS NOT NULL)
  ),
  CHECK (
    projected_via_terminal_tie = 1 OR
    (terminal_tie_occurred_at IS NULL AND terminal_tie_resolved_at IS NULL)
  )
)
```

```text
deployment_facts (
  deal_id TEXT PRIMARY KEY,
  use_case_clear INTEGER NOT NULL,
  integrations_known INTEGER NOT NULL,
  data_ready INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_payload_hash TEXT NOT NULL,
  operator TEXT NOT NULL,
  operator_source TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (use_case_clear IN (0, 1)),
  CHECK (integrations_known IN (0, 1)),
  CHECK (data_ready IN (0, 1))
)
```

```text
deployment_facts_rejections (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_payload_hash TEXT NOT NULL,
  rejection_kind TEXT NOT NULL CHECK (rejection_kind IN ('age', 'ordering', 'tie_conflict')),
  incoming_occurred_at TEXT NOT NULL,
  current_occurred_at TEXT,
  operator TEXT NOT NULL,
  operator_source TEXT NOT NULL,
  use_case_clear INTEGER NOT NULL,
  integrations_known INTEGER NOT NULL,
  data_ready INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source, source_event_id),
  CHECK (use_case_clear IN (0, 1)),
  CHECK (integrations_known IN (0, 1)),
  CHECK (data_ready IN (0, 1)),
  CHECK (rejection_kind = 'age' OR current_occurred_at IS NOT NULL)
)
```

`deployment_facts_rejections.current_occurred_at` is required for
`ordering` and `tie_conflict` because both compare against an existing facts row.
It may be `NULL` for a first-ever `age` rejection where no current facts row
exists.

```text
deployment_readiness (
  deal_id TEXT PRIMARY KEY,
  readiness TEXT NOT NULL,
  blocker_code TEXT,
  secondary_blocker_codes TEXT,
  blocker_entered_at TEXT,
  reason TEXT,
  state_entered_at TEXT NOT NULL,
  last_notified_fingerprint TEXT,
  notify_status TEXT,
  notify_pending_at TEXT,
  notify_attempts INTEGER NOT NULL DEFAULT 0,
  notify_error TEXT,
  updated_at TEXT NOT NULL,
  CHECK (readiness IN ('not_required', 'pending', 'ready', 'blocked')),
  CHECK (readiness != 'blocked' OR blocker_code IS NOT NULL),
  CHECK (readiness = 'blocked' OR blocker_code IS NULL),
  CHECK (readiness != 'blocked' OR blocker_entered_at IS NOT NULL),
  CHECK (readiness = 'blocked' OR blocker_entered_at IS NULL),
  CHECK (readiness = 'blocked' OR secondary_blocker_codes IS NULL),
  CHECK (secondary_blocker_codes IS NULL OR secondary_blocker_codes != '[]'),
  CHECK (
    notify_status IS NULL OR
    notify_status IN ('pending', 'ok', 'failed', 'max_attempts_exceeded')
  ),
  CHECK (
    notify_status IS NULL OR
    notify_status != 'pending' OR
    notify_pending_at IS NOT NULL
  ),
  CHECK (
    notify_status IS NULL OR
    notify_status != 'max_attempts_exceeded' OR
    last_notified_fingerprint IS NOT NULL
  )
)
```

```text
integration_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  value_hash TEXT NOT NULL,
  loaded_at TEXT NOT NULL,
  UNIQUE (key, activation_id)
)
```

`integration_config.activation_id` is a UUIDv4 generated once per boot/config
load activation and shared by every config row inserted during that activation,
including `effective_bundle`. It is not a hash and not a secret; it groups the
individual config rows that were active together.
`key='effective_bundle'` is inserted once per activation. Its `value_json` is a
canonical JSON object containing every non-secret config input that can affect
Phase 1 projection, observation, or notification behavior: resolved HubSpot
stage map, `HUBSPOT_NOTIFY_STAGE_IDS`, unsigned-webhook mode, local-write mode,
and deployment-handoff channel mode. `value_hash` is the lowercase hex SHA-256
of that exact canonical JSON string. Individual config rows also store a
SHA-256 `value_hash` of their own canonical `value_json`, but
`external_event_observations.config_hash` always stores the
`effective_bundle.value_hash`.
Out-of-process audit recovers the current config by selecting the newest
`effective_bundle` row with `ORDER BY loaded_at DESC, id DESC`, then loading
non-`effective_bundle` rows with that activation id. Observation rows still keep
their original `config_hash`, so historical audit is not rewritten by later
boots.

```text
external_event_observations (
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  observation_code TEXT NOT NULL,
  projected INTEGER NOT NULL DEFAULT 0,
  payload_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  mapped_commercial_state TEXT,
  router_deal_id TEXT,
  external_deal_id TEXT,
  stage_id TEXT,
  occurred_at TEXT,
  reason TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source, source_event_id),
  CHECK (
    observation_code IN (
      'invalid_timestamp',
      'not_routed',
      'unmapped_stage',
      'ignored_stage',
      'stale_stage_observation',
      'same_state_newer',
      'same_state_tie',
      'terminal_tie_conflict',
      'commercial_stage_tie_resolved',
      'commercial_stage_tie_ignored',
      'commercial_regression_unsupported',
      'terminal_drift_unsupported'
    )
  ),
  CHECK (projected IN (0, 1)),
  CHECK (
    projected = 0 OR
    observation_code IN ('terminal_tie_conflict', 'commercial_stage_tie_resolved')
  )
)
```

`external_event_observations` is an audit/index table, not the authoritative
source-event claim table. Normal successful forward projections can skip this
table; their replay fence is the matching `external_event_keys.key` claim. Rows
are inserted here only for the non-standard projection and observation paths
listed in the CHECK constraint. All HubSpot/local source-event paths, including
non-standard observation paths, still claim `external_event_keys` first; an
`external_event_observations` primary-key conflict is never the replay fence.
For `external_event_observations` and `idempotency_violations`,
`source_event_id` stores the full authoritative claim-key string from
`external_event_keys.key`, not a shortened provider event id. For HubSpot rows,
that means the full JSON key containing portal id, event id, deal id, property
name, stage id, and occurredAt. `source` remains a human-readable system label
such as `hubspot` or `local`.
`meta_json` is nullable canonical JSON for non-standard observation metadata.
For `terminal_tie_conflict`, it includes `tieArrivalMode`,
`tieWinnerChangedProjection`, and a stable logical tie key derived from
router deal id, `occurredAt`, and the two terminal states.

```text
idempotency_violations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  existing_payload_hash TEXT NOT NULL,
  incoming_payload_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (source, source_event_id, scope),
  CHECK (
    scope IN ('commercial_state', 'deployment_facts') OR
    scope LIKE 'external_event_observation:%'
  )
)
```

```text
external_event_keys (
  key TEXT PRIMARY KEY,
  system TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  notify_status TEXT NOT NULL DEFAULT 'pending',
  notify_leases INTEGER NOT NULL DEFAULT 0,
  notify_pending_at TEXT,
  notified_at TEXT,
  notify_error TEXT,
  scope TEXT NOT NULL DEFAULT 'source_event',
  payload_hash TEXT,
  CHECK (
    notify_status IN (
      'pending',
      'ok',
      'failed',
      'superseded_by_readiness',
      'superseded_by_terminal_drift',
      'superseded_by_new_readiness',
      'max_attempts_exceeded',
      'fallback_max_attempts_exceeded'
    )
  ),
  CHECK (
    scope IN (
      'source_event',
      'stage_notification',
      'readiness_fallback',
      'commercial_terminal_drift'
    )
  )
)
```

`external_event_keys.key` is the authoritative idempotency and notification
lease key for every Phase 1 source-event path. HubSpot stage events use the
existing stable JSON key
`["hubspot", portalIdOrUnknown, eventId, hubspotDealId, propertyName, toStageId, occurredAt]`.
Local commercial-state events use
`["commercial_state", "local", sourceEventId]`, and deployment facts use
`["deployment_facts", "local", sourceEventId]`. Notification leases use the
namespaced string keys documented later, such as
`readiness_fallback:<fingerprint>`.

Readiness is total for every deal whose commercial state has been projected.
Whenever a commercial-state event is accepted, upsert exactly one readiness row:
`not_required` for non-`closed_won`, `pending`, `ready`, or `blocked` for
`closed_won`.
`commercial_states.state_entered_at` is the server timestamp when the current
`commercial_state` value was first entered. Update it only when
`commercial_state` changes; preserve it for same-state observations and
tie-provenance updates.
Audit should check row presence for every deal with a projected commercial
state, not only for deals that look interesting.
When auditing `closed_won` human-assisted rows, join
`deployment_readiness.deal_id` and `commercial_states.deal_id` back to `deals.id`
to read the stored route; `deployment_readiness` does not duplicate route type.
Only update `state_entered_at` when the readiness value changes; repeated
derivations in the same state must not reset age-based audit checks.
`secondary_blocker_codes` uses `NULL` for "no secondary blockers." Do not store
an empty JSON array; the schema should reject `'[]'` so SQL audits can safely
use `IS NULL` for the no-secondary case. When secondary blockers exist, store a
canonical non-empty JSON array.
`deployment_readiness.reason` is optional sanitized display text only. Use it
for generated blocker summaries or "awaiting deployment facts"; clear it for
`ready` and `not_required`. Do not store raw customer notes, emails, contract
text, or other free-form external content in this column.
When readiness is `blocked`, update `blocker_entered_at` whenever the primary
`blocker_code` changes, including the initial transition from `NULL` to a
blocker code; otherwise preserve it so audits can age the active blocker
separately from the overall blocked state. When readiness exits `blocked`, set
`blocker_code=NULL`, `blocker_entered_at=NULL`, and
`secondary_blocker_codes=NULL`.
When the primary `blocker_code` changes while readiness remains `blocked`, the
notification fingerprint changes; mark any pending or failed
`readiness_fallback:<previousFingerprint>` lease `superseded_by_readiness` in
the same transaction before activating the new fingerprint.

`integration_config` stores append-only effective parsed stage map and
notification allowlist hashes used at boot. It is not a secrets table. Its
purpose is to make audit output able to say which config version produced a
projection or observation even after later config changes.
On every boot, insert one row per config key with a shared UUIDv4
`activation_id`, the parsed JSON, its `value_hash`, and `loaded_at`. Do not
update older rows, even when the same hash is loaded again. Determine the current
config by selecting the newest `effective_bundle` row using
`ORDER BY loaded_at DESC, id DESC`, then read all config rows with that same
`activation_id` and `key != 'effective_bundle'`; do not choose newest rows per
key independently, and do not feed the aggregate bundle row back into the
individual config map. The autoincrement `id` tiebreaker gives deterministic
current-config selection when two boots share the same millisecond `loaded_at`;
it is not business meaning. This preserves rollback history without ambiguous
recency, activation mixing, or mutable `is_current` state.
Also insert a row with `key='effective_bundle'` whose `value_json` is the
canonical JSON bundle of all config values that can affect projection,
observation, or notification behavior in Phase 1: resolved stage map,
`HUBSPOT_NOTIFY_STAGE_IDS`, unsigned-webhook mode, local-write mode, and
deployment-handoff channel mode.
`external_event_observations.config_hash` must store this effective-bundle
`value_hash`, not an individual stage-map hash and not `activation_id`.
`external_event_observations` captures HubSpot delivery audit rows for
non-standard projection paths: `not_routed`, ignored stages, unmapped stage ids,
invalid timestamps, ties, and unsupported regressions.
Most rows do not alter commercial projection, but some tie rows do.
`projected=1` means the stored `commercial_states.commercial_state` value
changed in the same transaction as this observation. It does not mean "entered a
projection code path" and it does not count updates to tie-provenance columns
alone. For example, an in-window terminal sibling conflict that changes
`closed_won -> closed_lost` has `projected=1`; the symmetric event that arrives
when the current projection is already `closed_lost` has `projected=0`, even
though it records `terminal_tie_conflict` in the event/observation ledger. Ranked
`commercial_stage_tie_resolved` rows use `projected=1` only when the incoming
state wins and changes the stored commercial state.
Generate at most one `observation_code` per `(source, source_event_id)`.
If multiple conditions apply, use this precedence: invalid timestamp,
not routed, unmapped stage, ignored stage,
stale-stage observation, same-state-newer observation, terminal-tie conflict,
ranked equal-timestamp tie, equal-timestamp same-state tie, terminal-drift unsupported
movement, unsupported regression.
Terminal-tie conflict takes precedence over same-state tie only when the event is
part of an observed cross-terminal sibling pair or existing terminal-tie
provenance; an isolated equal-timestamp same-state event still uses
`same_state_tie`.
Use `observation_code=stale_stage_observation` for mapped, router-owned HubSpot
events that are stale against either the latest external stage timestamp or the
stored commercial projection timestamp, regardless of whether the stale event
maps to the same or a different commercial state. Phase 1 stale handling is
checked independently of the pre-existing HubSpot branch result because
external-stage staleness and commercial-projection staleness can diverge.
Use `observation_code=same_state_tie` for equal-timestamp same-state events.
Operational reports that count same-state repeats must combine
`external_event_observations.observation_code IN ('same_state_newer',
'same_state_tie')`; Phase 1 does not treat either as an audit failure.
`same_state_newer` never updates `commercial_states.occurred_at`,
`source_event_id`, `source_payload_hash`, `state_entered_at`, or `updated_at`;
it is an observation-only row. The stored commercial projection timestamp stays
anchored to the first accepted projection into that state.
Use `observation_code=terminal_tie_conflict` for
`closed_won`/`closed_lost` same-timestamp conflicts only while they are inside
the receipt window. Out-of-window same-timestamp terminal sibling challengers
use `observation_code=terminal_drift_unsupported` with
`driftKind=late_delivery_tie`.
Only the selected code is inserted into `external_event_observations`; richer
details can still live in the per-deal `events` meta when a router deal exists.
Audit queries that mean "did not alter projection" must filter
`projected=0`, not infer from table membership.
Insert observations in the same transaction as the event-key claim. That
transaction must use `BEGIN IMMEDIATE` (or the store's existing equivalent write
lock) before inspecting or inserting observation keys. Attempt the observation
insert, and on primary-key conflict explicitly read the existing row's
`payload_hash` and `observation_code`: if both match the incoming values, treat
it as a duplicate; if either differs, insert an `idempotency_violations` row,
commit the event-key claim plus violation durably, and return a terminal
409-style handler result rather than silently overwriting history or throwing
before commit. Do not use silent `INSERT OR IGNORE` for
`external_event_observations`, because that would hide payload or branch
mismatches.
Generate `idempotency_violations.id` as a UUIDv4 and use `scope` values such as
`commercial_state`, `deployment_facts`, or
`external_event_observation:<observation_code>`; the unique constraint keeps
replayed violations from creating unbounded rows. Use `INSERT OR IGNORE` (or
equivalent `ON CONFLICT DO NOTHING`) only for replayed violation rows with the
same `(source, source_event_id, scope)`. Phase 1 intentionally stores at most
one violation row per source event per scope; if the same source event is later
replayed with a third payload hash, return the existing violation rather than
appending another row. A mismatched replay is considered claimed and terminal
after the violation is committed; retries should observe the existing violation
instead of re-entering the main processing path.
Observation rows must store the
effective `config_hash` and `mapped_commercial_state` so audit metrics such as
`notRoutedClosedWonStageEvents` do not change meaning when the stage map changes
on a later boot. `mapped_commercial_state` means "the state the incoming stage
id mapped to under this config," not the router deal's current projection.

For HubSpot webhook events, resolve the stage id through the semantic stage map
before router-deal lookup branches that can produce `not_routed`, so even
unowned HubSpot deliveries store `mapped_commercial_state` under the config that
observed them. Then extend the existing `recordExternalStageChange`
transaction and existing HubSpot event key to also update `commercial_states`
and `deployment_readiness`. Do not claim a second commercial-state key for the
same HubSpot delivery. This source-event claim is required for every HubSpot
delivery branch, including `not_routed`, before writing any
`external_event_observations` row. For the local-only `/commercial-state`
endpoint, use the existing event-key claim pattern with a structured key such as
`JSON.stringify(["commercial_state", "local", sourceEventId])`.
Reuse the existing `external_event_keys` table as the source-event claim table
for HubSpot, `/commercial-state`, and `/deployment-facts`. The current table
already has notification lease columns (`notify_status`, `notify_leases`,
`notify_pending_at`, `notified_at`, and `notify_error`); Phase 1 should reuse
those for fallback and terminal-drift alert leases. Add only
`scope TEXT NOT NULL DEFAULT 'source_event'` and `payload_hash TEXT`.
The migration must either use that default or recreate/backfill the table so
existing rows get `scope='source_event'`; adding `scope TEXT NOT NULL` without a
default is invalid SQLite migration behavior. Keep the existing
`external_event_keys.key` primary key; `scope` is metadata, not part of a
composite key. When the same source event needs both an idempotency claim and a
notification lease, insert separate rows with different namespaced `key` values
and different scopes. Claim the source-event key before validation branches that
append observations, including stale deployment facts, so same-payload replays
remain no-ops across process restarts.
Valid `external_event_keys.notify_status` values after Phase 1 are: `pending`,
`ok`, `failed`, `superseded_by_readiness`,
`superseded_by_terminal_drift`, `superseded_by_new_readiness`,
`max_attempts_exceeded`, and `fallback_max_attempts_exceeded`. Stage-change
notifications, readiness fallback alerts, terminal-drift alerts, and suppression
must use only those values.
Because SQLite cannot add a CHECK constraint to an existing table in place, the
migration must recreate/backfill `external_event_keys` or otherwise install an
equivalent schema-level CHECK enforcing that status set.
That rebuild must preserve every existing row and notification-lease column,
including `pending`, `failed`, `notify_leases`, `notify_pending_at`,
`notified_at`, and `notify_error`; the migration must not drop in-flight stage
notification leases.
Use these `external_event_keys.scope` values:
`source_event` for source-event idempotency claim keys,
`stage_notification` for `stage_notification:<source>:<sourceEventId>` keys,
`readiness_fallback` for `readiness_fallback:<fingerprint>` keys, and
`commercial_terminal_drift` for
`commercial_terminal_drift:<source>:<sourceEventId>` keys. The namespaced prefix
remains part of `external_event_keys.key`; `scope` is audit/query metadata, not a
replacement for the key namespace. Suppressed stage
notifications use the stage-notification row and set
`notify_status=superseded_by_readiness`.
Store a deterministic payload hash for both HubSpot and local commercial-state
events. Replaying the same source event id with a different payload hash is an
idempotency violation, matching `/deployment-facts` behavior.
Existing pre-migration `external_event_keys` rows with `payload_hash=NULL` are
legacy claims. If replayed after migration, treat them as duplicate no-ops,
do not reprocess the event, do not backfill a guessed hash, and do not raise an
idempotency violation. Audit should report their count as
`legacyUnhashedEventKeys` warning-only. All new Phase 1 claims must store a
non-null `payload_hash`.

The commercial-state write and readiness upsert must happen in the same
synchronous SQLite transaction as the event-key claim that authorized the state
change. If the process cannot update both projections, it should update neither
and let replay retry the same event key. The store return shape must distinguish
external-stage status (`recorded`, `duplicate`, `not_routed`, `stale`,
`notify_retry`) from readiness-notification work (`none`, `claim`, `retry`), so
the server never guesses whether a Slack handoff is owed.

Extend the existing HubSpot branch behavior explicitly:

| Existing result | Phase 1 commercial/readiness behavior |
|---|---|
| `recorded` | update external stage, then run Phase 1 mapping, staleness, monotonicity, tie, and regression checks before any commercial projection; project and derive readiness only for accepted projection-changing events |
| `duplicate` | do not re-project or re-notify |
| `not_routed` | claim/dedupe HubSpot event key, insert observation with `projected=0`, increment not-routed counter |
| `stale` | claim/dedupe the event key before appending any stale observation; do not re-project |
| `notify_retry` | do not re-project commercial state and do not re-derive readiness; treat existing `commercial_states` and `deployment_readiness` rows as authoritative and run only readiness notification retry checks |

Re-entry semantics:

- Readiness is re-derived on every accepted commercial-state event and every
  accepted deployment-facts event.
- The HubSpot webhook dedupe key is the existing HubSpot delivery/event key
  already used by `recordExternalStageChange`; Phase 1 must not invent a second
  key for the same delivery.
- A newly accepted `closed_won` projection creates a readiness row immediately.
- A newly accepted `closed_lost` projection sets readiness to `not_required`;
  Phase 1 captures `closed_lost` to avoid stale handoff work and to preserve
  event history for later outcome analysis. When readiness becomes
  `not_required`, clear `reason` and notification fields on
  `deployment_readiness`, and mark any pending or failed
  `readiness_fallback:<previousFingerprint>` lease `superseded_by_readiness` in
  the same transaction, so stale fallback alerts do not fire after the handoff
  is no longer required.
- Unsupported regressions or terminal cross-state movement leave
  `commercial_states` and `deployment_readiness` unchanged, while recording the
  rejected observation for audit. For terminal cross-state movement, this
  rejected observation is cumulative with the redacted `commercial_terminal_drift`
  alert lease; append the selected timeline event
  (`commercial_regression_unsupported` for ordinary regressions or
  `commercial_terminal_drift` for terminal drift) to the per-deal `events`
  timeline and record the selected `external_event_observations` row
  (`commercial_regression_unsupported` or `terminal_drift_unsupported`) before
  claiming/sending the Slack alert.

The existing `deals.external_stage_*` columns should continue to mirror the
latest HubSpot stage observation, even when commercial projection rejects a
regression. The dashboard should treat external stage as CRM truth and
`commercial_states` as router projection; drift is intentional and should be
visible. The audit should fail for a router-owned deal when the latest mapped
external stage differs from the router projection, regardless of notification
status. Phase 1 can detect the drift even though it does not repair it.

Resolve `HUBSPOT_STAGE_MAP_JSON` or `HUBSPOT_STAGE_MAP_PATH` in the
server/integration layer and pass the mapped `CommercialState | null` into the
store method. Keep the store config-free; it should not parse portal-specific
env vars.

Phase 1 should write two records for every resolved router-owned observation or
tie:

- `events`: the per-router-deal timeline used by `/state`, demos, and local
  debugging. Store rich typed meta here.
- `external_event_observations`: the cross-deal audit/index row keyed by
  external source event, observation code, payload hash, config hash, mapped
  commercial state, and external/router ids.

This dual write is required for router-owned `ignored_stage`,
`stale_stage_observation`, `same_state_newer`, `same_state_tie`,
`terminal_tie_conflict`,
`commercial_stage_tie_ignored`, `commercial_stage_tie_resolved`, and
`commercial_regression_unsupported`/`terminal_drift_unsupported`. A `not_routed` event with no router deal id
writes only `external_event_observations`, because there is no per-deal timeline
to attach to. Both writes happen in the same transaction as the source event-key
claim. If typed event meta is extended, add the union members in `types.ts` with
tests.

Minimum event meta fields:

```text
commercial-stage observation/regression:
  hubspotDealId, stageId, stageLabel, occurredAt, currentCommercialState,
  incomingCommercialState, tieRank, tieWinner, timelineObservationCode

tieRank:
  null except for ranked equal-timestamp different-state ties. When present, a
  JSON object `{ "current": number, "incoming": number }` using
  `open=0, proposal_sent=1, negotiating=2, terminal=3`. `tieRank` is explicitly
  null for terminal sibling conflicts because those use the conservative
  `closed_lost` rule instead of ranked resolution.

tieWinner:
  `"current"`, `"incoming"`, or `"none"`. Use `"none"` for `same_state` ties.
  The field describes which side's commercial state becomes or remains the
  projection. In terminal sibling conflicts, the winning side is always the side
  carrying `closed_lost`: `"current"` if the current projection is `closed_lost`,
  `"incoming"` if the incoming event is `closed_lost`.

timelineObservationCode:
  null for projected commercial-state events; otherwise one of the explicit
  observation codes such as `ignored_stage`, `same_state_newer`,
  `same_state_tie`, `terminal_tie_conflict`, `not_routed`, or
  `commercial_regression_unsupported`. This is timeline event meta only;
  `external_event_observations.observation_code` is always non-null for rows
  written to the cross-deal audit/index table.

deployment facts:
  operator, sourceEventId, occurredAt, useCaseClear, integrationsKnown, dataReady

deployment_facts_stale_ignored:
  dealId, sourceEventId, staleKind, incomingOccurredAt, currentOccurredAt,
  operator, useCaseClear, integrationsKnown, dataReady

staleKind:
  `"ordering"` when incoming facts are older than the current facts row;
  `"age"` when incoming facts exceed `DEPLOYMENT_FACT_MAX_AGE_DAYS` from server
  now

deployment_facts_tie_ignored:
  dealId, sourceEventId, occurredAt, tieKind, operator,
  useCaseClear, integrationsKnown, dataReady, currentUseCaseClear,
  currentIntegrationsKnown, currentDataReady

readiness notification:
  fingerprint, readiness, blockerCode, notifyStatus
```

Keep the existing inline HubSpot external id columns for Phase 1. A full
active/historical external-reference table belongs to Phase 2+ hardening,
because it changes identity flow across the app.

### Notifications and UI

- Add a "Deployment Handoff" section to the existing HTML dashboard.
- Place it below the routed/quarantine tables as a compact table with columns:
  router id, readiness, blocker label, reason, and last updated.
  `blocker label` is a fixed display mapping from the Phase 1 blocker codes,
  not a second stored value.
- Add readiness counters to `/metrics` and per-deal readiness rows to `/state`.
  `/metrics` should add
  `deploymentReadiness: {not_required, pending, ready, blocked}`,
  `readinessNotificationGaps`, `readinessPendingOverSla`,
  `readinessFactsStaleProjected`, `readinessFactsStaleIgnored`,
  `commercialProjectionDrift`, `commercialTerminalDriftAlerts`,
  `commercialTerminalTieConflicts`, and `notRoutedClosedWonStageEvents`.
  `/state` should add a
  `deploymentReadiness` array with `{dealId, readiness, blockerCode,
  secondaryBlockerCodes, reason, stateEnteredAt, blockerEnteredAt, updatedAt,
  notifyStatus, factsStatus, factsFresh, factsStaleAt}` rows.
  `/state` returns the persisted projection, not an inline recomputation; a
  persisted `ready` or `blocked` row with stale facts remains in its persisted
  readiness state in `/state` while
  `factsFresh=false`, `factsStaleAt`, `readinessFactsStaleProjected`, and audit
  expose the lag. This keeps the dashboard honest about projection state instead
  of hiding the missing scheduler in a read query. The dashboard must render a
  stale persisted `ready` or `blocked` row as an at-risk state, for example
  `Ready (stale facts)` or `Blocked (stale facts)`, so deployment users do not
  rely on audit alone for staffing decisions.
  `factsStatus` is the primary UI/API field and is one of
  `not_applicable`, `missing`, `fresh`, or `stale`. Keep `factsFresh` and
  `factsStaleAt` as compatibility/detail fields: `factsFresh=null` and
  `factsStaleAt=null` only when readiness does not depend on deployment facts
  (`factsStatus=not_applicable`); when readiness requires facts but none have
  been accepted yet, use `factsStatus=missing`, `factsFresh=false`, and
  `factsStaleAt=null`.
  When accepted facts exist, compute
  `factsStaleAt = latest deployment_facts.occurred_at + DEPLOYMENT_FACT_MAX_AGE_DAYS`
  using the same normalized millisecond-Z timestamp rules as storage and audit;
  `factsFresh` is `true` only when server `now < factsStaleAt`.
  The dashboard renders `factsStatus=missing` as awaiting facts, `stale` as
  stale/at-risk, `fresh` as normal, and `not_applicable` without a facts badge.
  This relies on a load-bearing invariant: the write-time age gate rejects any
  accepted facts whose `occurredAt < now - DEPLOYMENT_FACT_MAX_AGE_DAYS`, so
  `factsStaleAt` is never already expired at acceptance time. Add an assertion
  or acceptance test for that invariant if the age gate is touched.
- Add a Slack dry-run/live handoff only for `pending`, `ready`, and `blocked`
  closed-won deals.
- Notify on readiness transitions, not every derivation run. Any transition
  into `pending`, `ready`, or `blocked` for a `closed_won` deal sends one
  redacted handoff; this includes `not_required -> pending`,
  `not_required -> ready`, `not_required -> blocked`, `pending -> ready`,
  `pending -> blocked`, and `blocked -> ready`. These `not_required` examples
  apply to literal prior rows as well as to `none` treated as `not_required`.
  Treat `none` as equivalent to `not_required` for notification purposes when no
  readiness row existed before the transaction, so direct first projection to
  `closed_won` still sends `none -> pending`, `none -> ready`, or
  `none -> blocked` handoffs.
  Replaying the same transition should dedupe. Use the existing lease/release
  notification pattern rather than trying to post Slack inside the SQLite
  transaction.
- Dedupe Slack by readiness fingerprint, not inbound event key:
  `readiness:<dealId>:<previous_readiness>:<new_readiness>`.
  Use `none` as `previous_readiness` when no readiness row existed before the
  transaction, for example `readiness:<dealId>:none:pending`.
  Store the last notified fingerprint on `deployment_readiness` so a local
  event and a HubSpot event that derive the same transition do not post twice,
  while `ready -> blocked -> ready` still produces the second ready handoff.
  The Phase 1 notification fingerprint includes previous readiness and new
  readiness only; it intentionally excludes `blocker_code`. Blocker changes
  while readiness remains `blocked` should update dashboard state, not send
  another Slack handoff in Phase 1. Do not compute or claim a notification
  fingerprint when `previous_readiness == new_readiness`. Because blocker changes
  do not create a new fingerprint, they also do not supersede fallback leases;
  fallback alerts must not include blocker labels, and the dashboard is the
  source of truth for the current blocker. A primary blocked handoff already in
  flight may mention the prior blocker; treat that as bounded in-flight staleness
  until a later notification-correction spec exists.
  A newly inserted `deployment_readiness` row starts with
  `last_notified_fingerprint=NULL`, `notify_status=NULL`,
  `notify_pending_at=NULL`, and `notify_attempts=0`. `notify_status=NULL` means
  "unnotified"; it is distinct from `pending`, which means a worker has claimed
  a notification lease and must have a non-null `notify_pending_at`.
- Claim notification with an atomic compare-and-swap update before posting
  Slack: when the fingerprint differs from `last_notified_fingerprint`, start a
  fresh notification cycle by setting `last_notified_fingerprint=fingerprint`,
  `notify_status=pending`, `notify_attempts=0`, `notify_error=NULL`, and
  `notify_pending_at=now`. In the same transaction, if the previous
  `last_notified_fingerprint` has a non-terminal fallback key
  `readiness_fallback:<previous_fingerprint>` in `external_event_keys`, mark that
  fallback key `superseded_by_new_readiness` before overwriting the pointer.
  This makes the loss of an obsolete fallback explicit instead of orphaning a
  retryable lease. Leave prior fallback keys with `notify_status=ok`,
  `fallback_max_attempts_exceeded`, or `superseded_by_new_readiness` unchanged,
  but supersede `failed` and `pending` fallback keys even when a pending lease
  is still inside its lease window. Fallback workers must re-read both the
  fallback key and the current
  `deployment_readiness.last_notified_fingerprint` immediately before posting
  Slack, and skip the post unless the key is still `pending` for their lease and
  the readiness row still points at the fallback fingerprint. If the post was
  already in flight before the supersession, the stale fallback alert is accepted
  as an in-flight delivery, but its post-result writeback may update only its own
  `external_event_keys.key = readiness_fallback:<previous_fingerprint>` row,
  gated by the fallback lease token/status. It must not update
  `deployment_readiness`; primary writeback safety for the deal remains the
  fingerprint-gated CAS on `deployment_readiness.last_notified_fingerprint`.
  The fresh-cycle CAS WHERE clause must be strict on the previous fingerprint
  observed by the worker, using null-safe equality for the first notification:
  claim only when `last_notified_fingerprint IS <previous_fingerprint>` (or both
  are null), never with a loose
  `last_notified_fingerprint != <new_fingerprint>` predicate. That strict form
  prevents two concurrent workers with different computed fingerprints from both
  claiming and posting.
  For the same fingerprint, set
  `notify_status=pending` and `notify_pending_at=now` only when the row is
  currently retry-eligible
  (`notify_status=failed` with attempts still below the primary cap,
  or `notify_status=pending` with an expired lease and attempts still below the
  primary cap). Check the affected row count; only the worker that updates one
  row may post Slack. Post-result writes are also fingerprint-gated CAS updates:
  success and failure updates must include
  `last_notified_fingerprint=<claimed fingerprint>` in the WHERE clause and
  check the affected row count. If a newer transition advanced the fingerprint
  while the worker was posting Slack, the stale worker discards its result and
  must not mark the newer cycle `ok` or increment its attempts. On success set
  `notify_status=ok`. On failure, increment `notify_attempts` and store
  `notify_error`; if the new attempt count is still below
  `READINESS_NOTIFICATION_MAX_ATTEMPTS`, set `notify_status=failed`. If the new
  attempt count reaches `READINESS_NOTIFICATION_MAX_ATTEMPTS`, set
  `notify_status=max_attempts_exceeded` and claim or reuse the fallback key in
  the same post-failure SQLite transaction before any fallback Slack post is
  attempted. Use
  `READINESS_NOTIFICATION_LEASE_MS = STAGE_NOTIFICATION_LEASE_MS` unless a
  measured reason appears to split them. Retry when `notify_status=failed` or
  when `notify_status=pending` and `notify_pending_at` is older than that lease
  window. A matching fingerprint with `notify_status=failed` or expired
  `pending` must retry; `notify_status=ok` and
  `notify_status=max_attempts_exceeded` dedupe.
  Notification attempt caps are per fingerprint, not per deal: a later
  `pending -> ready` transition starts a new fingerprint and gets a fresh
  primary attempt budget even if `none -> pending` exhausted its own budget.
  `notify_status=max_attempts_exceeded` is terminal for primary-channel retries
  in Phase 1. `/notification-retry` must not send another primary handoff for
  that row, but it must still probe and process the
  `readiness_fallback:<last_notified_fingerprint>` fallback channel. An
  operator-visible primary reset workflow belongs to production hardening, not
  this slice.
  `notify_pending_at` may be null for rows that have never claimed a
  notification, but `notify_status=pending` with null `notify_pending_at` is an
  audit failure. New writes must make this unreachable by construction: the
  `deployment_readiness` table has a CHECK constraint rejecting pending/null,
  and every CAS claim sets `notify_status=pending` and `notify_pending_at=now`
  in the same atomic update. If audit ever sees pending/null in a legacy or
  manually edited DB, it should fail loudly rather than guessing at retry
  eligibility.
  Same-fingerprint retry claims must also use concrete CAS predicates. For a
  failed retry, bind the observed `notify_status='failed'`,
  `notify_attempts=<observed_attempts>`, and
  `last_notified_fingerprint=<fingerprint>`. For an expired pending retry, bind
  the observed `notify_status='pending'`,
  `notify_pending_at=<observed_pending_at>`,
  `notify_attempts=<observed_attempts>`, and
  `last_notified_fingerprint=<fingerprint>`, plus the expiry predicate. The
  worker may post only when that conditional update affects one row.
  For a row already at `notify_status=max_attempts_exceeded`,
  `/notification-retry` does not transition the primary row out of that terminal
  state. The fallback lease claim must happen in one SQLite transaction that
  checks `deployment_readiness.notify_status='max_attempts_exceeded'` and
  `deployment_readiness.last_notified_fingerprint=<fingerprint>` and claims
  `external_event_keys.key = readiness_fallback:<fingerprint>` only if that
  readiness predicate still matches. In SQL, prefer an `UPDATE ... WHERE key=?
  AND EXISTS (SELECT 1 FROM deployment_readiness WHERE ...)` shape or equivalent
  transaction-local check plus write, not an application-layer pre-read followed
  by an unrelated lease update. After commit, the fallback worker re-checks the
  readiness pointer immediately before Slack post; if the pointer changed, mark
  the fallback key `superseded_by_new_readiness` and skip the post. If the
  pointer changes after that final re-check but before the HTTP request is
  already in flight, accept it as the same bounded in-flight stale-alert risk
  described above. The fallback key status moves through `pending`, `ok`,
  `failed`, or `fallback_max_attempts_exceeded`. The primary row remains
  `max_attempts_exceeded`; audit becomes clean only when the fallback key is
  `ok`. If the fallback key reaches `fallback_max_attempts_exceeded`, Phase 1
  intentionally remains audit-dirty and requires operator escalation or an
  out-of-band/manual reset after the Slack/config problem is fixed; a first-class
  reset endpoint belongs to production hardening.
  Fallback key claims and writebacks use their own CAS predicates. Treat
  `external_event_keys.notify_leases` as the fallback lease/attempt generation:
  claiming a missing, failed, or expired-pending fallback key inserts or updates
  it to `notify_status=pending`, increments `notify_leases`, sets
  `notify_pending_at=now`, and returns the observed lease generation. A fallback
  worker may post only for the generation it claimed.
  `FALLBACK_NOTIFICATION_LEASE_MS = READINESS_NOTIFICATION_LEASE_MS` unless a
  measured reason appears to split them; a pending fallback key is reusable only
  when `notify_pending_at < now - FALLBACK_NOTIFICATION_LEASE_MS`. Fallback success/failure
  writeback must bind `key=<fallback_key>`, `notify_status='pending'`,
  `notify_leases=<claimed_generation>`, and
  `notify_pending_at=<claimed_pending_at>`. On fallback failure, if the new
  lease count is below `FALLBACK_NOTIFICATION_MAX_ATTEMPTS`, set
  `notify_status=failed`; otherwise set
  `notify_status=fallback_max_attempts_exceeded`. Supersession has two writers,
  both with explicit predicates. The new-fingerprint pipeline writer may mark
  the previous fallback key `superseded_by_new_readiness` in the same
  transaction that advances `deployment_readiness.last_notified_fingerprint`,
  using `WHERE key=<previous_fallback_key> AND notify_status IN ('pending',
  'failed')`. A fallback worker that discovers the readiness pointer no longer
  matches immediately before posting may mark its own key superseded with
  `WHERE key=<fallback_key> AND notify_status='pending' AND
  notify_leases=<claimed_generation> AND
  notify_pending_at=<claimed_pending_at>`. In either path, a fallback worker
  whose post-result writeback affects zero rows must discard its result.
  Fallback claim predicates are also concrete. A missing fallback key is claimed
  with `INSERT ... ON CONFLICT DO NOTHING`; only the inserter may post. A failed
  fallback key is claimed with
  `WHERE key=<fallback_key> AND notify_status='failed' AND
  notify_leases=<observed_leases>`. An expired pending fallback key is claimed
  with `WHERE key=<fallback_key> AND notify_status='pending' AND
  notify_leases=<observed_leases> AND
  notify_pending_at=<observed_pending_at> AND notify_pending_at < <lease_cutoff>`.
  `ok`, `fallback_max_attempts_exceeded`, and `superseded_by_new_readiness`
  fallback keys are not claimable.
  Deal-level audit cleanliness is computed only from the current
  `deployment_readiness.last_notified_fingerprint`. Historical fallback keys
  marked `superseded_by_new_readiness` are excluded from
  `readinessNotificationGaps` when no readiness row currently points at that
  fingerprint, though audit may report their count separately for observability.
  Phase 1 intentionally does not create a separate supersession ledger for
  primary notification leases. If a newer fingerprint supersedes a primary
  worker while its Slack post is in flight, the stale worker's fingerprint-gated
  writeback no-ops and the new fingerprint immediately owns the current audit
  state. This is acceptable for primary handoffs because the current readiness
  transition gets a fresh notification cycle; fallback leases need explicit
  supersession because they live in `external_event_keys` and can otherwise
  remain retryable after the readiness pointer advances.
- Phase 1 must provide one manual retry surface, `POST /notification-retry`,
  gated by the same loopback and `LOCAL_ENDPOINT_SECRET` controls as local write
  endpoints. It processes readiness rows with `notify_status=failed`, expired
  `pending`, or `max_attempts_exceeded`. Rows that are `failed` or expired
  `pending` are primary-channel candidates only while attempts remain below the
  primary cap; `max_attempts_exceeded` rows skip primary retry and go straight to
  fallback handling. If a legacy or manually edited row has
  `notify_status=failed` or expired `pending` with
  `notify_attempts >= READINESS_NOTIFICATION_MAX_ATTEMPTS`, normalize it to
  `notify_status=max_attempts_exceeded` in the same transaction that claims or
  reuses the fallback key, then route it through fallback handling; report that
  normalization in the per-row result for audit visibility. The normalization
  UPDATE must bind the observed readiness status, attempt count, and fingerprint;
  if it affects zero rows, the worker lost the race and must roll back/return a
  lost-race result without attempting to claim the fallback key. If
  normalization succeeds but the fallback claim affects zero rows, commit the
  same transaction with the normalization update and the no-op fallback claim,
  then return a lost-race result for the fallback step only; do not post Slack
  without owning the fallback lease. No savepoint is required for the zero-row
  claim case because there is no fallback-claim write to roll back. In SQLite, use
  `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING` plus `changes()` or equivalent
  row-count inspection for the fallback claim; a zero-row claim is a normal lost
  race, not a transaction error. This gives audit gaps an operator-actionable
  repair path without waiting for a new commercial or deployment-facts event.
  Request body:
  `{ "dealId": optional, "fingerprint": optional, "limit": optional }`; default
  limit is 25, minimum accepted limit is 1, and maximum accepted limit is 100.
  Reject `limit < 1` or `limit > 100` with a 400 response rather than silently
  clamping. When both `dealId` and `fingerprint` are provided, treat them as an
  AND filter: first resolve the readiness row by bare fingerprint. If no
  readiness row has `last_notified_fingerprint = fingerprint`, first check
  whether
  `readiness_fallback:<fingerprint>` exists with
  `external_event_keys.notify_status=superseded_by_new_readiness`; if so, return
  an explicit superseded result. Otherwise return 404 `readiness_not_found` and
  do not retry a fallback key by fingerprint alone. This no-row superseded check
  applies whether or not `dealId` was also provided. If a readiness row is found,
  then require that row's `deal_id` to match the provided `dealId`. A mismatched
  deal/fingerprint pair is a 400 input error and must not operate on a fallback
  key by fingerprint alone. A fallback key without a matching
  `deployment_readiness` row is an orphaned lease and should be reported in the
  per-row result, not retried blindly. If the selected readiness row has
  `notify_status=max_attempts_exceeded`, whether selected by `dealId` only,
  `fingerprint` only, or the `dealId` + `fingerprint` AND filter, still probe
  `readiness_fallback:<last_notified_fingerprint>` for fallback retry
  eligibility. A `max_attempts_exceeded` row with
  `last_notified_fingerprint IS NULL` is an invariant violation; return an
  `invalid_terminal_notification_state` result and do not construct a fallback
  key. If the fallback key is missing and the fingerprint is present,
  create/claim it with the same missing-key `INSERT ... ON CONFLICT DO NOTHING`
  path and attempt fallback; a missing fallback key for a terminal primary is
  recoverable, not a hard error.
  Build retry candidates, not deal rows, from the persisted state
  at candidate-selection time. Candidate selection has three buckets:
  primary-channel candidates (`failed` or expired `pending` rows with attempts
  below the primary cap), normalization-to-fallback candidates (`failed` or
  expired `pending` rows with attempts at or above the primary cap), and
  fallback candidates (rows already at `notify_status=max_attempts_exceeded`).
  A primary `deployment_readiness` retry and a fallback `external_event_keys`
  retry are separate candidates, but never for the same fingerprint while the
  primary row is still below the primary-attempt cap. Include a fallback
  candidate only when the primary row is already
  `notify_status=max_attempts_exceeded` at selection time, or when a
  normalization-to-fallback candidate successfully normalizes the row during
  processing. If a primary
  candidate reaches the max-attempts cap during processing, fallback acquisition
  and any fallback Slack attempt are part of that primary candidate's result, not
  a second preselected candidate for the same fingerprint. `limit` counts
  attempted candidates, not all matching rows. Query `limit + 1` candidates in
  deterministic order; process the first `limit`, and if the extra probe row
  exists, return a synthetic `not_attempted_due_to_limit` summary with at least
  the next candidate fingerprint/type so the operator knows more work remains.
  Process candidates in deterministic order by fingerprint,
  then primary before fallback; when the primary is `max_attempts_exceeded`,
  process fallback only. A failed candidate for one fingerprint does not stop
  later attempted candidates within the limit. Lost-race outcomes consume a
  limit slot because the candidate was selected and attempted, even if no Slack
  post or state mutation resulted. Continue after per-candidate failures and
  return per-candidate results.
  A request `fingerprint` is the bare readiness fingerprint, not the prefixed
  fallback key. The endpoint must match both
  `deployment_readiness.last_notified_fingerprint = fingerprint` and fallback
  event keys whose key is `readiness_fallback:<fingerprint>`.
  Primary retry eligibility must always check both status and attempt count:
  rows with `notify_attempts >= READINESS_NOTIFICATION_MAX_ATTEMPTS` are not
  primary-channel candidates, even if `notify_status=failed` or expired
  `pending`; they route to fallback acquisition instead. This rule applies to
  `/notification-retry` as well as background recovery so the system never sends
  a fourth primary readiness notification.
  The fallback channel has its own cap,
  `FALLBACK_NOTIFICATION_MAX_ATTEMPTS = 3`, and its terminal status is
  `fallback_max_attempts_exceeded`; do not reuse the primary
  `max_attempts_exceeded` status for fallback exhaustion.
- The audit should flag `pending`, `ready`, or `blocked` closed-won rows whose
  primary notification state is neither `ok` nor a successfully delivered
  fallback after the lease window. To reconstruct fallback lifecycle, join
  `deployment_readiness.last_notified_fingerprint` to
  `external_event_keys.key = readiness_fallback:<fingerprint>`. A primary
  `notify_status=max_attempts_exceeded` is clean only when that fallback key
  exists with `notify_status=ok`; missing, failed, expired pending, or
  `fallback_max_attempts_exceeded` fallback keys remain
  `readinessNotificationGaps`. `superseded_by_new_readiness` is clean only for
  fallback keys that no longer match any row's current
  `last_notified_fingerprint`; it is not clean for the active fingerprint. The
  audit should also flag `pending` closed-won rows older than
  `READINESS_PENDING_SLA_HOURS = 24`.
- `/notification-retry` treats primary readiness retry eligibility and fallback
  retry eligibility separately. A primary row with
  `notify_status=max_attempts_exceeded` is skipped for primary-channel retry,
  but the endpoint must still inspect the matching
  `readiness_fallback:<fingerprint>` key and retry that fallback if it is
  `failed` or expired `pending`. Skipping `max_attempts_exceeded` never means
  "skip the fallback row."
- Suppress the generic stage-change Slack post when the same HubSpot delivery is
  superseded by a redacted router-owned alert. In Phase 1, that means either a
  deployment-readiness handoff for a `closed_won` `human_assisted` deal, or a
  rejected terminal cross-state event that will claim a redacted
  `commercial_terminal_drift` alert. Do not suppress generic stage notifications
  for mapped non-`closed_won` stages that derive `not_required`. Suppression must
  mark the `stage_notification:<source>:<sourceEventId>` lease row with terminal
  `notify_status=superseded_by_readiness` for readiness handoffs or
  `notify_status=superseded_by_terminal_drift` for terminal-drift alerts, so the
  old notification lease does not leak. This suppression write must be an upsert
  that creates the `stage_notification:<source>:<sourceEventId>` row with the
  terminal superseded status if it does not already exist; do not use a bare
  UPDATE whose zero affected rows can silently leak the generic notification.
  The conflict update must not overwrite an existing `notify_status=ok` row:
  use a predicate such as `WHERE notify_status != 'ok'`. If the existing stage
  notification is already `ok`, the unredacted post has won the race and cannot
  be retracted; leave it `ok`, emit/report a `suppression_lost_race` result for
  audit visibility, and still continue the redacted readiness or terminal-drift
  alert path. If the
  readiness handoff fails, rely on the readiness notification retry/audit path
  rather than falling back to an unredacted stage message.
  The suppression decision is made after readiness derivation, in the same
  source-event transaction, and only when that derivation creates a readiness
  notification fingerprint. This means a `closed_won` `human_assisted` deal that
  goes directly `not_required -> ready` suppresses the generic stage post, while
  a `self_serve` `closed_won` deal that remains `not_required` does not.
  Explicit Phase 1 gap: if the generic stage-change post is superseded and both
  the primary readiness handoff and fallback alert eventually exhaust their
  retry caps, no Slack message will have been delivered for that closed-won
  movement. Audit remains exit-blocking via `readinessNotificationGaps`, but
  Phase 1 does not provide an in-app reset that unsuppresses the original
  unredacted stage notification. Production hardening should add a deliberate
  operator reset/replay endpoint rather than silently reviving superseded
  messages.
- After `READINESS_NOTIFICATION_MAX_ATTEMPTS = 3`, a still-failing readiness
  handoff should emit one redacted `deployment_handoff_failed` alert to the
  generic Slack channel if that channel is configured. The fallback may include
  only router id, readiness, and error class; it must not unsuppress the original
  unredacted stage-change payload. Claim a separate event key before sending,
  `readiness_fallback:<fingerprint>`, using `external_event_keys.notify_status`
  and the same lease table so concurrent retry workers cannot post duplicate
  fallback alerts. `POST /notification-retry` also processes failed or expired
  fallback keys, up to `FALLBACK_NOTIFICATION_MAX_ATTEMPTS = 3`; after that, mark
  the fallback key `fallback_max_attempts_exceeded`. The transition from primary
  retry to fallback must be atomic: in one SQLite transaction, detect
  `notify_attempts >= READINESS_NOTIFICATION_MAX_ATTEMPTS`, claim or reuse the
  `readiness_fallback:<fingerprint>` lease, and set the primary
  `deployment_readiness.notify_status=max_attempts_exceeded` before any fallback
  Slack post is attempted. Recovery code must use
  `notify_attempts >= READINESS_NOTIFICATION_MAX_ATTEMPTS`, not only
  `notify_status=max_attempts_exceeded`, to route an interrupted primary row to
  the fallback path without sending a fourth primary notification. Once the
  fallback is claimed, the primary must never retry on the primary channel.
  Fallback reuse rules are explicit. If the fallback key is missing, failed, or
  expired pending, the transaction sets the primary row to
  `max_attempts_exceeded` and the worker attempts the fallback after commit. If
  the fallback key already exists as non-expired `pending`, set the primary row
  to `max_attempts_exceeded` and do not post; another worker owns the lease. If
  the fallback key already exists as `ok`, set the primary row to
  `max_attempts_exceeded`, skip Slack, and treat audit as clean. If the fallback
  key already exists as `fallback_max_attempts_exceeded`, set the primary row to
  `max_attempts_exceeded`, skip Slack, and leave
  `readinessNotificationGaps` exit-blocking.
- If a rejected terminal-to-terminal movement arrives after either terminal
  state has been projected, or if any newer non-terminal mapped state arrives
  after a terminal projection, claim one redacted `commercial_terminal_drift`
  alert and fail audit, regardless of readiness notification status. Use
  `external_event_keys` for the alert lease with key
  `commercial_terminal_drift:<source>:<sourceEventId>` and the same
  `notify_status` / pending lease semantics as other Slack alerts, so concurrent
  workers cannot post duplicates. Claim that alert lease in the same SQLite
  transaction that records the terminal-drift event and
  `external_event_observations` row; send Slack only after the transaction
  commits. If the HubSpot stage id is also in
  `HUBSPOT_NOTIFY_STAGE_IDS`, the same source-event transaction must also mark
  the generic `stage_notification:<source>:<sourceEventId>` row as
  `superseded_by_terminal_drift` using the same upsert rule as readiness
  suppression; do not emit the unredacted generic stage-change
  post for a terminal-drift event. Add `tieResolutionDrift=true` to alert/event
  meta when `commercial_states.projected_via_terminal_tie=1` and the rejected
  event is processed within `TERMINAL_TIE_WINDOW_MS = 300000` of
  non-null `terminal_tie_resolved_at` server time. If
  `projected_via_terminal_tie=0` or `terminal_tie_resolved_at IS NULL`,
  `tieResolutionDrift=false`. Equal source timestamps are handled by the tie path,
  not terminal drift. This drift annotation intentionally uses a different
  server-time anchor than terminal-tie eligibility: tie eligibility is measured
  from the original `terminal_projected_at`, while `tieResolutionDrift` is
  measured from `terminal_tie_resolved_at` because it asks whether a later
  rejected event arrived soon after a tie resolution. They share
  `TERMINAL_TIE_WINDOW_MS`, but they do not describe the same interval.
  This distinguishes likely concurrent webhook retry noise from later
  post-commit terminal drift during manual escalation.
  This is Phase 1's operator escalation path for
  cases like HubSpot moving a staffed `closed_won` deal to `closed_lost` before
  a later correction/retraction spec exists, and for the symmetric
  `closed_lost -> closed_won` conflict. The Phase 1 alert is informational but
  urgent: it means "manual GTM owner escalation required," not "the router can
  repair this automatically." CI or demo audit failure on
  `commercialTerminalDriftAlerts` should be treated as an expected red-path
  signal when a fixture intentionally exercises terminal drift, and as a blocking
  data-quality issue in normal runs. `commercialTerminalTieConflicts` is a
  separate warning counter for same-timestamp ambiguity; it should be reported
  and reviewed, but it is not the terminal-drift alert counter.
- Slack content must be redacted: router id, readiness, blocker code, and
  last updated timestamp are allowed; HubSpot link, company name, contact email,
  raw notes, contracts, customer data, and long free-text fields are not. The
  dashboard can carry the HubSpot link for users who already have local access.
This redaction rule is for the new deployment-handoff notification. Refactoring
the existing routed-deal Slack payload is a separate hardening task.
That means Phase 1 intentionally has divergent Slack redaction: existing routed
and stage-change posts may still show company/deal names, while the new
deployment-readiness post does not.
Use a dedicated deployment-handoff channel for the new readiness messages when
running against a real Slack workspace; otherwise the existing unredacted posts
can trivially re-identify the redacted readiness message by timing.
In live mode, require `SLACK_DEPLOYMENT_CHANNEL_ID` for readiness handoffs and
fail boot if it equals the generic `SLACK_CHANNEL_ID`, unless an explicit
`SLACK_ALLOW_SHARED_DEPLOYMENT_CHANNEL=1` override documents that the workspace
accepts the correlation risk.
`npm run doctor -- --send-test` should verify both the deployment handoff channel
and the generic fallback channel when fallback alerts are configured.

Readiness Slack message schema:

```text
GTM deployment handoff
Router deal: <id>
Readiness: <pending|ready|blocked>
Blocker: <label or none>
Updated: <timestamp>
```

Blocker labels:

```text
deployment_use_case_unclear -> Use case unclear
deployment_integration_unknown -> Integrations unknown
deployment_data_unavailable -> Deployment data unavailable
```

Dashboard states:

- empty: "No deployment handoffs yet."
- loading: preserve existing page shell and show a compact loading row.
- error: show the metrics/state fetch error in the section without hiding the
  rest of the dashboard.
- responsive: reuse the existing scrollable table/wrapper pattern.

### Backfill

Backfill and HubSpot-native deal adoption are not part of the Phase 1 demo
slice. They belong to production rollout hardening because historical or
HubSpot-created deals may not have router deal ids. HubSpot stage webhooks that
cannot resolve to a router-owned deal should remain `not_routed`, increment a
visible counter, and never create deployment readiness rows silently. Phase 1
does not need to crawl HubSpot history or reserve a backfill event format.
Operators should expect Phase 1 to project only newly observed mapped
commercial-state events after the feature is enabled, plus explicit local demo
events. The Phase 1 audit/demo claim is scoped to router-owned deals; production
hardening should fail or alert on closed-won `not_routed` HubSpot events before
claiming org-wide coverage.

### Audit exit policy

`ops_audit.py` should print all counters, but only some counters should produce
a non-zero exit. It must accept `--audit-mode local|integration|live`; local is
for dry-run fixtures, while integration/live use production-style strictness.
The human-assisted checks join readiness/commercial projections back to
`deals.route_kind`, where `route_kind='human_assisted'` is the persisted source
of truth. In this router, `human_assisted` means an enterprise/sales-led deal
that needs deployment handoff after `closed_won`; `nurture` and `self_serve`
remain `not_required` even if their commercial state reaches `closed_won`.
Phase 1 materializes exactly one readiness row for every router-owned commercial
projection, including intermediate/non-terminal states; non-`closed_won`
projections derive `not_required`. `not_routed` observations are not
router-owned projected commercial states and are excluded from joins to
`deals.route_kind`.
For `closed_won` human-assisted deals, valid readiness values are `pending`,
`ready`, and `blocked`; `pending` is allowed until the SLA row below fires, and
`blocked` is valid when blocker fields pass schema/audit checks. `not_required`
is invalid for this route because it would skip deployment handoff.
Terminal-tie provenance is complete only when
`projected_via_terminal_tie=1` has non-null `terminal_tie_winner_state`,
`terminal_tie_loser_state`, `terminal_tie_resolved_at`, and
`terminal_projected_at`; direct terminal projections must have
`projected_via_terminal_tie=0` and null terminal-tie fields.
`commercialProjectionDrift` excludes terminal-drift events that emit a
`commercial_terminal_drift` alert; those increment
`commercialTerminalDriftAlerts` only, so expected-red-path terminal drift can be
waived without a second generic drift counter blocking the run.
`commercialTerminalTieUnresolved` fires only when an equal-timestamp terminal
cross-state tie is detected but the canonical precedence rule cannot choose a
winner, for example because an unexpected terminal state escaped enum
validation. Under the current `closed_lost` over `closed_won` rule it should be
zero; if it fires, preserve the prior valid `commercial_states` projection, do
not create or update deployment readiness from the unresolved event, and record
only the unresolved-tie observation/counter. If there is no prior valid
projection, leave the deal without a commercial projection rather than inserting
a sentinel state.
For terminal-tie timing, the first terminal event projects normally and sets
`terminal_projected_at`; the in-window check is evaluated when the sibling event
arrives, anchored to that current projection's `terminal_projected_at`.
Terminal drift applies only after a terminal projection already exists. A newer
terminal event that advances a non-terminal current projection is a normal
projection, not drift. Any strictly older mapped event behind the current
projection, whether terminal or non-terminal and whether same-state or
different-state, is a stale-stage observation and increments
`commercialStaleStageObservations`, not drift. Equal-timestamp same-state events
remain `commercialSameStateObservations`; equal-timestamp cross-terminal events
use the tie/drift rules above. Newer cross-state events after a terminal
projection, including newer non-terminal events after a terminal projection, are
terminal drift: preserve the terminal projection, emit the redacted terminal
drift alert, and increment `commercialTerminalDriftAlerts`. They are not stale.
`same_state_newer` and
`same_state_tie` observations are idempotency or ordering observations and never
increment `commercialProjectionDrift`.
`commercialProjectionDrift` is audit-only in Phase 1: it increments when
`ops_audit.py` deterministically recomputes the commercial projection from
accepted projected events and the persisted `commercial_states` row does not
match that recomputation after excluding stale, same-state, terminal-tie, and
terminal-drift observations. Events classified as
`commercialTerminalTieUnresolved` are also excluded; they already fail audit via
their own counter and must not cascade into generic projection drift. Normal
webhook classification paths should not
write this counter directly, and it has no fixture waiver. A no-prior
unresolved tie leaves the deal without a commercial
projection until the enum/config bug is fixed and an operator replays a corrected
event with a new source event id or explicit local correction; do not insert a
sentinel commercial state or compensating readiness row.
Phase 1 uses this policy:

| Counter or condition | Exit policy |
| --- | --- |
| Missing readiness row for a router-owned projected commercial state with non-null `route_kind`; exclude `not_routed` observations | exit-blocking |
| Any readiness row created from a `not_routed` observation | exit-blocking |
| Router-owned projected commercial state joined to `deals.route_kind IS NULL`; exclude `not_routed` observations | exit-blocking |
| `closed_won` row with `route_kind='human_assisted'` and `not_required` readiness | exit-blocking |
| `closed_won` row with non-null `route_kind!='human_assisted'` and readiness other than `not_required` | exit-blocking |
| Non-`closed_won` row with readiness other than `not_required` | exit-blocking |
| `readinessNotificationGaps` | exit-blocking |
| `readinessPendingOverSla` | exit-blocking; no waiver, fixtures must keep pending rows fresh unless intentionally testing audit failure |
| `readinessFactsStaleProjected` from a persisted `ready` or `blocked` row with expired accepted facts | exit-blocking |
| `readinessFactsStaleIgnored` from ignored stale submissions on a still-`pending` row | warning-only |
| `commercialProjectionDrift`, excluding stale-stage observations, same-state observations, terminal-drift alerts, terminal-tie observations, and `commercialTerminalTieUnresolved` events | exit-blocking; no expected-red-path waiver in Phase 1 fixtures |
| `commercialStaleStageObservations` | warning-only/report-only ordering signal |
| `commercialSameStateObservations` for `same_state_newer` or `same_state_tie` | report-only |
| `commercialTerminalDriftAlerts` | per-event exit-blocking; a contributing event is warning-only only when `--allow-expected-red-paths` is set and that event meta has `expectedRedPath=true` |
| `commercialTerminalTieConflicts` | warning-only for detected-and-resolved equal-timestamp ties |
| `commercialTerminalTieUnresolved` | exit-blocking |
| `commercialTerminalTieMissingFields` when `projected_via_terminal_tie=1` has any required tie field null | exit-blocking |
| `commercialTerminalTieFieldLeak` when `projected_via_terminal_tie=0` has any tie field non-null | exit-blocking |
| `notRoutedClosedWonStageEvents` | exit-blocking when `--audit-mode=integration` or `--audit-mode=live`; warning-only when `--audit-mode=local` |
| `legacyUnhashedEventKeys` | exit-blocking when `--audit-mode=integration` or `--audit-mode=live`; warning-only when `--audit-mode=local` |
| `deploymentReadiness` distribution counts | report-only |

Expected red-path fixtures must be explicit. `ops_audit.py` accepts
`--allow-expected-red-paths` for demo-only runs; when that flag is present, a
`commercial_terminal_drift` event with meta `expectedRedPath=true` counts as a
warning instead of an exit-blocking `commercialTerminalDriftAlerts` failure.
The waiver is read from the emitted `commercial_terminal_drift` event meta, not
from the raw external webhook payload. Local/demo fixtures may request that meta
when `ALLOW_EXPECTED_RED_PATHS=1`; live HubSpot events cannot self-mark expected
red paths.
Without the flag, or without that exact event meta, terminal drift remains
exit-blocking.

### Phase 1 acceptance tests

- A local commercial-state event can move a routed deal to `closed_won`.
- A local commercial-state request rejects a non-UUIDv4 `sourceEventId`.
- An equal-timestamp `closed_won`/`closed_lost` conflict resolves to
  `closed_lost`, appends `terminalTieConflict=true`, and increments
  `commercialTerminalTieConflicts`, regardless of delivery order, only within
  `TERMINAL_TIE_WINDOW_MS` of the current projection's `terminal_projected_at`.
- A terminal tie involving an unexpected terminal state increments
  `commercialTerminalTieUnresolved` and fails audit instead of guessing a winner.
- In-window terminal-tie resolution sets `projected_via_terminal_tie=1` and
  terminal-tie timestamps on `commercial_states`; direct terminal projections
  clear them.
- A late equal-timestamp terminal sibling event outside
  `TERMINAL_TIE_WINDOW_MS` keeps the current projection and records
  `commercialTerminalDriftAlerts` instead of silently downgrading a clean
  projection; it does not increment `commercialProjectionDrift`, and the
  expected-red-path waiver applies per event.
- A later `closed_won` event after a terminal tie resolved to `closed_lost`
  records terminal drift, preserves the current `closed_lost` projection and its
  derived readiness, and does not derive `closed_won` readiness in Phase 1.
- A newer HubSpot event that maps to the same current commercial state records
  `observation_code=same_state_newer` without advancing projection age or
  re-deriving readiness.
- Same-state-newer and stale-stage observations use the source-neutral
  `commercial_stage_observation` event type, with the actual source captured in
  event meta.
- A strictly newer terminal same-state repeat, such as `closed_won -> closed_won`,
  records `same_state_newer` rather than terminal drift.
- A `commercial_stage_tie_ignored` event with `tieKind=same_state` records
  `tieWinner=none`.
- Equal-timestamp same-state events use `observation_code=same_state_tie`.
- Older mapped HubSpot events use `observation_code=stale_stage_observation`
  whether they map to the same state or a different state than the current
  projection.
- Router-owned observations and commercial-stage ties write both an `events`
  timeline record and an `external_event_observations` audit/index row.
- Projection-changing observations set `external_event_observations.projected=1`;
  non-projecting observations set `projected=0`.
- An in-window terminal tie that changes `closed_won -> closed_lost` records
  `projected=1`, while an in-window terminal tie that finds the projection
  already `closed_lost` records `observation_code=terminal_tie_conflict`,
  `projected=0`, and still sets `commercial_states` terminal-tie provenance so
  the resolved tie is represented consistently regardless of delivery order.
- A single external delivery produces at most one `external_event_observations`
  row according to the observation-code precedence documented in the
  `external_event_observations` section above.
- Terminal sibling ties use `observation_code=terminal_tie_conflict`.
- Router-owned ignored stages write both per-deal `events` timeline entries and
  `external_event_observations` rows.
- A `closed_won` human-assisted deal with complete readiness facts becomes
  `ready`.
- A `closed_won` deal with unknown integrations becomes `blocked` with
  `deployment_integration_unknown`.
- A deployment facts event can flip `blocked` to `ready` and produce one
  redacted Slack handoff.
- A deployment facts request missing any required boolean is rejected.
- A deployment facts request records `operator` in event meta.
- A deployment facts request missing `operator` is rejected.
- The `deployment_facts` table rejects null `operator` and null
  `operator_source`.
- The `deployment_facts` and `deployment_facts_rejections` tables reject boolean
  values outside `0` or `1`.
- A deployment facts request rejects a non-UUIDv4 `sourceEventId`.
- A deployment facts request with `occurredAt` more than
  `MAX_FUTURE_SKEW_MS` ahead of server now is rejected without claiming the event
  key.
- A deployment facts request for an unknown router `dealId` returns 404 and
  writes no facts, readiness row, event, or source-event claim.
- `/deployment-facts` claims
  `JSON.stringify(["deployment_facts", "local", sourceEventId])`.
- A stale deployment facts request still claims the source event key before
  appending `deployment_facts_stale_ignored`.
- `deployment_facts_stale_ignored` records `staleKind=ordering` for facts older
  than the current row and `staleKind=age` for facts older than
  `DEPLOYMENT_FACT_MAX_AGE_DAYS`.
- A first-ever stale deployment facts request writes no `deployment_facts` row,
  leaves the closed-won human-assisted deal `pending`, and is reported by audit
  under `readinessFactsStaleIgnored`.
- Stale deployment facts rejected for age or ordering insert
  `deployment_facts_rejections` rows so audit does not depend on parsing only
  event JSON.
- `deployment_facts_rejections` preserves `operator_source` alongside
  `operator`.
- A stale accepted `ready` or `blocked` row can be repaired in Phase 1 only by
  resubmitting readiness facts with a fresh `occurredAt` and new
  `sourceEventId`.
- Local-only endpoints reject missing or invalid `LOCAL_ENDPOINT_SECRET`.
- Boot fails when `ALLOW_LOCAL_WRITE_ENDPOINTS=1` and `LOCAL_ENDPOINT_SECRET`
  is missing.
- A `closed_won` human-assisted deal with no deployment facts immediately gets a
  `pending` readiness row and one redacted Slack handoff.
- Stale deployment facts do not overwrite newer deployment facts.
- Replaying the same stale deployment facts event does not append a second
  `deployment_facts_stale_ignored` event.
- Equal-timestamp deployment facts with matching boolean values append one
  `deployment_facts_tie_ignored` event and do not overwrite the current facts.
- Equal-timestamp deployment facts with different boolean values return a
  409-style conflict telling the operator to resubmit with a newer `occurredAt`.
- Equal-timestamp deployment facts with different boolean values also insert a
  `deployment_facts_rejections` row with `rejection_kind='tie_conflict'`.
- A deployment facts event with `dataReady=false` becomes `blocked` with
  `deployment_data_unavailable`.
- A single-blocker `blocked` row stores `secondary_blocker_codes=NULL`, not `[]`.
- The `deployment_readiness` table rejects `secondary_blocker_codes='[]'`; no
  secondary blockers must be stored as `NULL`.
- A `self_serve` or `nurture` route is `not_required` in Phase 1.
- A non-`closed_won` deal is always `not_required`.
- Replaying the same `(source, sourceEventId)` is idempotent.
- Reusing the same `(source, sourceEventId)` with a different payload hash fails.
- Reusing a `/commercial-state` `sourceEventId` with a different payload hash
  fails the same way `/deployment-facts` does.
- Reusing an external observation key with a different payload hash records an
  idempotency violation instead of overwriting the prior observation.
- Reusing an external observation key with a different payload hash durably
  commits the idempotency violation before returning a terminal handler error, so
  retrying the same bad delivery does not loop forever.
- Concurrent external observation inserts cannot hide a payload-hash mismatch;
  the losing writer reads the existing row and records a durable idempotency
  violation when hashes differ.
- `external_event_observations` stores `config_hash` and
  `mapped_commercial_state`, and `notRoutedClosedWonStageEvents` is computed
  from the stored mapped state, not the current stage map.
- A `not_routed` HubSpot delivery still resolves the stage map and stores
  `mapped_commercial_state` when the stage id maps to a commercial state.
- `external_event_observations.config_hash` is the `effective_bundle`
  `integration_config.value_hash`, not an individual config-key hash.
- Two different source events that derive the same readiness fingerprint post
  at most one Slack handoff.
- Direct first projection to closed-won sends a redacted handoff for
  `none -> pending`, `none -> ready`, or `none -> blocked`.
- Concurrent readiness notification claims use a conditional update and affected
  row count so only one worker posts Slack.
- Fresh notification claims use strict previous-fingerprint CAS, not a loose
  "not equal to new fingerprint" predicate.
- Same-fingerprint retry claims bind observed attempt and lease values in the
  CAS predicate, so two retry workers cannot both claim the same expired
  notification.
- Readiness notification success/failure writeback is conditioned on the
  claimed fingerprint, so a slow worker cannot mark a newer notification cycle
  `ok` or increment its attempts.
- A Slack post failure leaves `notify_status=failed` and retries without
  permanently suppressing the handoff.
- `POST /notification-retry` retries failed or expired-pending readiness
  notifications and fallback-eligible `max_attempts_exceeded` rows behind
  loopback and `LOCAL_ENDPOINT_SECRET`.
- `POST /notification-retry` enforces deal/fingerprint filters, rejects
  `limit < 1` or `limit > 100`, and returns per-row retry results.
- `POST /notification-retry` with both `dealId` and `fingerprint` treats them as
  an AND filter and rejects mismatched pairs without retrying the fallback key by
  fingerprint alone.
- `POST /notification-retry` with a bare readiness fingerprint matches both the
  primary readiness row and a failed `readiness_fallback:<fingerprint>` event key.
- `POST /notification-retry` skips primary retry for
  `notify_status=max_attempts_exceeded` but still retries a matching failed or
  expired `readiness_fallback:<fingerprint>` key.
- `POST /notification-retry` with only `dealId` reads
  `last_notified_fingerprint` from a `max_attempts_exceeded` primary row and
  still probes `readiness_fallback:<last_notified_fingerprint>`.
- After `READINESS_NOTIFICATION_MAX_ATTEMPTS`, a failed readiness handoff emits
  one redacted `deployment_handoff_failed` fallback alert without replaying the
  unredacted stage-change message.
- Concurrent fallback attempts claim `readiness_fallback:<fingerprint>` and post
  at most one fallback alert.
- Fallback success/failure writeback binds the claimed fallback lease generation,
  so two fallback workers cannot both complete the same fallback key.
- Fallback retries stop at `FALLBACK_NOTIFICATION_MAX_ATTEMPTS` with
  `fallback_max_attempts_exceeded`.
- After fallback is claimed, primary readiness notification status becomes
  `max_attempts_exceeded` and does not retry indefinitely.
- Reusing a fallback key with `notify_status=ok` marks the primary
  `max_attempts_exceeded` without sending Slack and audit treats the fallback as
  delivered.
- Reusing a fallback key with `notify_status=fallback_max_attempts_exceeded`
  marks the primary `max_attempts_exceeded` without sending Slack and audit
  keeps `readinessNotificationGaps` exit-blocking.
- Fallback lease claim and primary transition to `max_attempts_exceeded` happen
  atomically before any fallback Slack post is attempted.
- If a process observes `notify_attempts >= READINESS_NOTIFICATION_MAX_ATTEMPTS`
  while primary status is still `failed`, it routes to fallback instead of
  sending another primary handoff.
- `/notification-retry` also routes `notify_status=failed` rows with
  `notify_attempts >= READINESS_NOTIFICATION_MAX_ATTEMPTS` to fallback instead
  of sending a fourth primary handoff.
- A claimed pending notification older than the lease window is audit-visible.
- A claimed pending notification inside the lease window is not double-posted.
- `notify_status=pending` always has non-null `notify_pending_at`.
- A newly inserted readiness row with `notify_status=NULL` and
  `notify_pending_at=NULL` is valid and means unnotified, not pending.
- The `deployment_readiness` table rejects `notify_status=pending` with null
  `notify_pending_at`.
- The `deployment_readiness` table rejects
  `notify_status=max_attempts_exceeded` with null `last_notified_fingerprint`.
- The `deployment_readiness` table rejects unknown `notify_status` values.
- The `deployment_readiness` table rejects unknown `readiness` values.
- The `deployment_readiness` table rejects `readiness=blocked` without
  `blocker_code` or `blocker_entered_at`.
- The `commercial_states` table rejects non-terminal rows with terminal
  projection timestamps, terminal rows without `terminal_projected_at`, and
  terminal-tie rows with incomplete tie provenance.
- The `external_event_observations` table rejects `projected` values outside
  `0` or `1`.
- `/state` marks persisted `ready` or `blocked` rows with stale facts as
  `factsStatus=stale`, `factsFresh=false`,
  and computes `factsStaleAt` from the latest accepted deployment facts timestamp
  plus `DEPLOYMENT_FACT_MAX_AGE_DAYS`; the dashboard renders them as stale rather
  than plain ready.
- `/state` returns `factsFresh=null` and `factsStaleAt=null` when readiness does
  not depend on facts with `factsStatus=not_applicable`, but returns
  `factsStatus=missing`, `factsFresh=false`, and `factsStaleAt=null` when a
  closed-won human-assisted deal is pending because facts are missing.
- `ready -> blocked -> ready` produces two ready handoffs because the transition
  fingerprint includes previous readiness.
- `not_required -> blocked` produces a readiness handoff.
- `pending -> ready` produces a readiness handoff.
- A `blocked -> blocked` blocker-code change updates dashboard state without a
  second Slack handoff.
- Any new readiness notification fingerprint supersedes a non-terminal fallback
  lease for the previous fingerprint with
  `notify_status=superseded_by_new_readiness`.
- `/notification-retry` does not retry a fallback lease marked
  `superseded_by_new_readiness`; it reports the superseded result explicitly.
- A fallback worker re-reads the fallback key before Slack post and skips if a
  newer readiness transition has marked it `superseded_by_new_readiness` or if
  `deployment_readiness.last_notified_fingerprint` no longer points at that
  fallback fingerprint.
- Deal-level audit ignores `superseded_by_new_readiness` fallback keys that no
  current readiness row points at, while still reporting their count.
- A `blocked -> blocked` primary blocker-code change updates
  `blocker_entered_at` without resetting `state_entered_at`.
- Promoting a former secondary blocker to primary resets `blocker_entered_at` and
  audit labels that duration as current primary blocker age.
- Exiting `blocked` clears `blocker_code`, `blocker_entered_at`, and
  `secondary_blocker_codes`.
- A HubSpot delivery that will claim a readiness handoff for a `closed_won`
  `human_assisted` deal marks the generic stage-change notification
  `superseded_by_readiness`.
- Suppression upserts do not overwrite a stage notification lease that is already
  `ok`; they report `suppression_lost_race` instead.
- A notify-allowed HubSpot delivery rejected as terminal drift marks the generic
  stage-change notification `superseded_by_terminal_drift` and emits only the
  redacted terminal-drift alert.
- An `ignore`-mapped stage that is notify-allowed can still emit the generic
  stage-change Slack notification; it only skips commercial projection.
- A rejected terminal cross-state event after either terminal state has been
  projected emits a redacted `commercial_terminal_drift` alert and fails audit,
  even if readiness notification is still pending or failed.
- A newer non-terminal stage event after a terminal projection also emits the
  redacted `commercial_terminal_drift` alert and fails audit.
- The same rejected terminal cross-state event appends the
  `commercial_terminal_drift` timeline event and records exactly one
  `external_event_observations` row with
  `observation_code=terminal_drift_unsupported`, not a second regression row.
- Concurrent terminal-drift alert attempts claim
  `commercial_terminal_drift:<source>:<sourceEventId>` and post at most one
  Slack alert per incoming drift event.
- Terminal-drift alerts after a terminal-tie resolution include
  `tieResolutionDrift=true` only when processed within
  `TERMINAL_TIE_WINDOW_MS` of `terminal_tie_resolved_at` server time.
- Terminal-tie eligibility uses `terminal_projected_at` as its anchor, while
  `tieResolutionDrift` uses `terminal_tie_resolved_at`; tests cover that the two
  checks are intentionally different.
- HubSpot future-skew rejection does not claim the HubSpot event key, so a later
  replay can process the original event once it is within the skew window.
- `ops_audit.py` treats primary `max_attempts_exceeded` as clean only when the
  corresponding `readiness_fallback:<fingerprint>` key is `ok`; a missing
  fallback key remains a `readinessNotificationGaps` failure. The fingerprint is
  read from `deployment_readiness.last_notified_fingerprint` on that
  `max_attempts_exceeded` row, and the `deployment_readiness` schema includes
  both `notify_status` and `last_notified_fingerprint`.
- Slack handoff output excludes contact email and raw free text.
- Slack handoff output excludes company name.
- Slack handoff output excludes HubSpot link.
- Python audit fails if any projected commercial-state row lacks exactly one
  readiness row.
- Python audit fails if a `closed_won` human-assisted readiness row is
  `not_required`.
- Python audit joins readiness/commercial rows back to `deals` to distinguish
  `human_assisted` from `self_serve`/`nurture` routes.
- Python audit reports `pending` closed-won rows older than
  `READINESS_PENDING_SLA_HOURS`.
- Python audit fails/reports any persisted `ready` or `blocked` row whose latest
  deployment facts are older than `DEPLOYMENT_FACT_MAX_AGE_DAYS`.
- Python audit and `/state` compute fact freshness from `deployment_facts`
  timestamps, not from `deployment_facts_expired` timeline events.
- Python audit reports a `closed_won` `human_assisted` pending row with only
  stale fact submissions under `readinessFactsStaleIgnored` by querying
  `deployment_facts_rejections`, not by depending only on timeline JSON.
- Python audit fails if any non-`closed_won` deal has readiness other than
  `not_required`.
- Python audit reports `readinessNotificationGaps`,
  `readinessPendingOverSla`, `readinessFactsStaleProjected`,
  `readinessFactsStaleIgnored`,
  `commercialProjectionDrift`, `commercialTerminalDriftAlerts`,
  `commercialTerminalTieConflicts`, and `notRoutedClosedWonStageEvents` as
  separate counters without breaking existing summary fields.
- Python audit applies the explicit audit exit-policy table instead of inferring
  severity from counter names.
- Python audit treats `commercial_terminal_drift` as warning-only only when run
  with `--allow-expected-red-paths` and the event meta has
  `expectedRedPath=true`.
- Local demo terminal-drift fixtures can populate `expectedRedPath=true` only
  when `ALLOW_EXPECTED_RED_PATHS=1`; live HubSpot events cannot self-waive audit
  severity.
- HubSpot webhook payloads containing `expectedRedPath=true` do not propagate
  that field into router event meta.
- Introduce a boot-time refusal: `ALLOW_UNSIGNED_WEBHOOKS=1` is allowed only for
  localhost dry-runs. Boot fails if it is combined with live mode as defined
  above.
- Boot fails if `HUBSPOT_STAGE_MAP_JSON` is invalid JSON or maps to values
  outside `CommercialState | "ignore"`.
- Boot fails if `HUBSPOT_STAGE_MAP_PATH` is unreadable, invalid JSON, or maps to
  values outside `CommercialState | "ignore"`.
- Boot fails if both `HUBSPOT_STAGE_MAP_JSON` and `HUBSPOT_STAGE_MAP_PATH` are
  set.
- A valid `HUBSPOT_STAGE_MAP_PATH` file is parsed and hashed into
  append-only `integration_config` activation rows.
- Re-loading a previous stage-map hash inserts a new `integration_config`
  activation row rather than mutating the older row.
- Current config reads use the newest `effective_bundle` activation id and then
  load all non-`effective_bundle` config rows for that same activation id, with
  the autoincrement `integration_config.id` as the deterministic tiebreaker for
  same-millisecond `loaded_at` values.
- `external_event_keys` adds `scope` and `payload_hash`, and reuses the existing
  notification lease columns for fallback/drift alert leases.
- `external_event_keys.key` remains the primary key; source-event claims and
  notification leases use separate namespaced key rows with documented scopes.
- The `external_event_keys.scope` migration is safe for existing rows through
  `DEFAULT 'source_event'` or an explicit table-rebuild backfill.
- `external_event_keys.notify_status` is restricted to the documented Phase 1
  status set.
- Notification lease rows in `external_event_keys` use documented scopes:
  `stage_notification`, `readiness_fallback`, or `commercial_terminal_drift`.
- Pre-migration `external_event_keys` rows with null `payload_hash` replay as
  duplicate no-ops and are reported as `legacyUnhashedEventKeys`.
- Live boot fails if `HUBSPOT_NOTIFY_STAGE_IDS` contains a stage id missing
  from the resolved stage map; `ignore` is allowed for notify-only stages.
- Ignored and unmapped HubSpot stage ids are stored in
  `external_event_observations`, counted, and surfaced in audit output.
- `not_routed` HubSpot deliveries claim/dedupe the HubSpot event key and write
  `external_event_observations` in the same SQLite transaction, so replay is
  idempotent without a claim-written/observation-missing crash gap.
- Without `ALLOW_LOCAL_WRITE_ENDPOINTS=1`, local-only endpoints are not
  registered. If `ALLOW_LOCAL_WRITE_ENDPOINTS=1` is set in live mode, boot
  fails because Phase 1 does not define live auth for these routes.
- Local-only endpoints reject non-loopback requests at the handler level.
- Boot fails when `ALLOW_LOCAL_WRITE_ENDPOINTS=1` and `TRUST_PROXY=1`; a proxied
  live-HubSpot demo cannot also use the local-only demo endpoints without adding
  real auth.
- Boot fails when `ALLOW_EXPECTED_RED_PATHS=1` is set in live mode.
- Local-only endpoint Host validation rejects non-localhost hosts.
- Live readiness handoffs require `SLACK_DEPLOYMENT_CHANNEL_ID` and fail boot
  if it matches the generic Slack channel without an explicit override.
- HubSpot webhook Host/forwarded-host validation must match `PUBLIC_BASE_URL`
  when `TRUST_PROXY=1`.
- `LOCAL_ENDPOINT_SECRET` shorter than 32 characters fails boot when
  `ALLOW_LOCAL_WRITE_ENDPOINTS=1`; it is ignored when local endpoints are
  disabled.
- Newer backward or terminal cross-state movement records
  `commercial_regression_unsupported` and does not silently alter readiness.
- Evaluate the already-terminal projection guard before the generic backward
  movement guard; terminal drift wins over regression for any post-terminal
  cross-state movement.
- Inside the already-terminal projection guard, check equal-timestamp
  `closed_won`/`closed_lost` sibling eligibility before ordinary terminal-drift
  handling; in-window terminal siblings emit `terminal_tie_conflict`, while
  out-of-window siblings emit `terminal_drift_unsupported`.
- Newer movement away from an already-terminal projection is treated as terminal
  drift whether the incoming mapped state is terminal or non-terminal and records
  `observation_code=terminal_drift_unsupported`.
- Terminal-drift handling records the timeline event,
  `external_event_observations` row, and
  `commercial_terminal_drift:<source>:<sourceEventId>` alert lease in one SQLite
  transaction before posting Slack.
- Replaying the same terminal-drift source event with the same payload is a
  duplicate no-op: the source-event claim and/or existing
  `commercial_terminal_drift:<source>:<sourceEventId>` lease must gate re-entry
  before reinserting the timeline or observation row.
- Skipped forward commercial-state movement, such as `open -> closed_won`, is
  accepted as an ordinal advance, not rejected for missing intermediate stages.
- Equal-timestamp different-state commercial events resolve by deterministic
  rank and emit `commercial_stage_tie_resolved` when the incoming event wins.
- A ranked equal-timestamp tie that projects a terminal state sets
  `terminal_projected_at`, clears `terminal_tie_occurred_at`,
  `terminal_tie_resolved_at`, `terminal_tie_winner_state`, and
  `terminal_tie_loser_state`, and records
  `commercial_states.projected_via_terminal_tie=0`; this is not
  terminal-sibling tie resolution, so later drift cannot set
  `tieResolutionDrift=true` from this path. It still emits
  the generic stage-tie event `commercial_stage_tie_resolved` and an
  `external_event_observations` row with
  `observation_code=commercial_stage_tie_resolved` and `projected=1`.
- That ranked-tie terminal projection rule applies only when the current row is
  not already `projected_via_terminal_tie=1`; generic ranked ties must not clear
  existing terminal-sibling resolution fields. Once terminal-sibling resolution
  exists, later same-`occurredAt` events follow the re-observation or
  same-state-tie paths, and later different-`occurredAt` cross-state movement
  follows terminal drift/regression rules.
- `terminal_projected_at` is the server receipt timestamp when a terminal
  projection first became current, not the source event's `occurredAt`. For
  batch mode, use the in-memory server timestamp assigned to the
  not-yet-committed terminal projection as the receipt-window anchor.
- If the ranked tie projected `closed_won` or `closed_lost` and the opposite
  terminal sibling later arrives with the same `occurredAt` inside
  `TERMINAL_TIE_WINDOW_MS` of that `terminal_projected_at`, convert the row to
  terminal-sibling resolution by setting `projected_via_terminal_tie=1` and
  terminal-tie provenance in the same transaction; preserve the original
  `terminal_projected_at` as the receipt-window anchor.
- If the opposite terminal sibling arrives after `TERMINAL_TIE_WINDOW_MS`, keep
  the current projection and treat the event as terminal drift with
  `observation_code=terminal_drift_unsupported`. This uses the normal terminal
  drift path: claim `commercial_terminal_drift:<source>:<sourceEventId>`, append
  the drift timeline/observation row, emit the redacted drift alert, and do not
  mutate projection, readiness, or generic stage-notification state.
- For same-transaction batch processing, check all remaining same-deal,
  same-`occurredAt` events against the just-computed, not-yet-committed
  projection before committing. The batch window check uses that in-memory
  `terminal_projected_at` value as its anchor. If the opposite terminal sibling
  is present, resolve with the same canonical terminal-sibling rank as the
  sequential path (`closed_lost` wins), commit only the terminal-sibling
  resolution, and do not first persist or notify the generic ranked-tie
  projection.
- Commercial-state projection transactions use `BEGIN IMMEDIATE` and re-read the
  current `commercial_states` row after acquiring the write lock, so concurrent
  separate deliveries of equal-timestamp terminal siblings serialize and the
  second writer sees the first writer's `terminal_projected_at`.
- Terminal-sibling tie detection and resolution are atomic in one transaction;
  on first resolution there is no persisted intermediate state with terminal-tie
  fields set but no resolved projection.
- The transaction that first observes the second sibling and therefore detects
  the terminal tie writes
  `commercial_states.projected_via_terminal_tie=1`,
  `terminal_tie_occurred_at`, `terminal_tie_resolved_at`,
  `terminal_tie_winner_state`, and `terminal_tie_loser_state`. If the canonical
  terminal-tie winner differs from the current projection, update projection and
  readiness in the same transaction.
  Re-observed sibling ties after a terminal-sibling resolution keep the projected
  state, preserve the original `terminal_tie_occurred_at` and
  `terminal_tie_resolved_at`, and preserve the already-resolved
  `terminal_tie_winner_state`/`terminal_tie_loser_state`.
- `commercialTerminalTieConflicts` counts
  `external_event_observations.observation_code='terminal_tie_conflict'`.
- Emit `terminal_tie_conflict` when equal-timestamp `closed_won` and
  `closed_lost` sibling events are observed inside `TERMINAL_TIE_WINDOW_MS` of
  the current terminal projection's `terminal_projected_at`, regardless of which
  sibling arrived first.
- When terminal-sibling resolution changes the persisted projection,
  `terminal_tie_conflict` with `tieWinnerChangedProjection=true` is the
  authoritative projection-change signal for readiness recomputation, dashboard
  refresh, and downstream consumers; do not emit a second generic
  `commercial_stage_tie_resolved` for the same change.
- If a sequential terminal-sibling resolution supersedes an earlier
  `commercial_stage_tie_resolved` observation, keep the earlier observation as
  append-only history. Consumers must read current projection from
  `commercial_states` and projection-change events, not by treating older
  observation rows as current-state truth.
- Sequential and batch terminal-sibling histories are intentionally asymmetric:
  sequential delivery preserves any committed intermediate
  `commercial_stage_tie_resolved` observation as history, while batch delivery
  commits only `terminal_tie_conflict` because no intermediate projection was
  ever persisted. Batch causality is still recoverable from
  `commercial_states.projected_via_terminal_tie=1` plus the
  `terminal_tie_conflict` event meta `tieArrivalMode=batch`.
- Terminal sibling ties are constrained to the two distinct terminal states
  `closed_won` and `closed_lost`; duplicate same-state terminal deliveries use
  the same-state tie path and do not expand `terminal_tie_loser_state`.
- The same-state tie path handles a distinct source event whose mapped state and
  `occurredAt` equal the current projection: claim the source event, append a
  `same_state_tie` observation with `projected=0`, and do not mutate
  `commercial_states`, readiness, or notification state. Same source-event
  replays remain duplicate no-ops.
- `terminal_tie_conflict` event and observation meta include
  `tieArrivalMode=batch|sequential_state_changed|sequential_winner_already_projected`
  and `tieWinnerChangedProjection=true|false`; `commercialTerminalTieConflicts`
  counts observed conflict rows, not unique logical tie keys. Same source-event
  replays are deduped by the source-event key; distinct same-tie observations
  are intentionally counted and audit output also reports the breakdown.
- In batch mode, claim both terminal source-event keys and insert one
  `terminal_tie_conflict` observation per terminal source event. The canonical
  winner row has `projected=1` and `tieWinnerChangedProjection=true`; the loser
  row has `projected=0` and `tieWinnerChangedProjection=false`.
- `tieWinnerChangedProjection=true` means terminal-sibling resolution wrote a
  new current projection or changed the prior current projection, including
  batch mode where no ranked-tie projection was committed first. It is `false`
  only when the persisted projection already equals the canonical terminal-tie
  winner.
- Projection drift is audit-visible regardless of whether a readiness handoff has
  been notified.
- The audit exit-policy table above is authoritative for every new counter;
  `ops_audit.py` must not infer severity from counter names.
- Missing, invalid, or future-skewed local `occurredAt` is rejected before
  projection and before source-event claim.
- Local-only endpoints are not registered when `ALLOW_LOCAL_WRITE_ENDPOINTS` is
  unset.

### Phase 1 implementation order

1. Add `CommercialState`, `DeploymentReadiness`, and `DeploymentBlocker` types.
2. Add `commercial_states`, `deployment_facts`,
   `deployment_facts_rejections`, `deployment_readiness`,
   `integration_config`, `external_event_observations`, and
   `idempotency_violations` storage.
3. Add commercial-state mapping config, boot-time config persistence, and
   live-mode boot guards for unsigned webhooks/local-only routes before any new
   endpoint is registered.
4. Add local-only `POST /commercial-state` with loopback, Host, and
   `LOCAL_ENDPOINT_SECRET` enforcement in the same change.
5. Add local-only `POST /deployment-facts` with the same local-only guard rails.
6. Add readiness derivation with tests first.
7. Add dashboard/JSON display.
8. Add redacted Slack handoff receipts using the existing lease pattern.
9. Extend `ops_audit.py` with readiness invariants.
10. Run the existing TypeScript, Python, and demo checks.

## Phase 2: Outcome loop

**Goal:** Record what happened after deployment so routing policy can be judged
against reality.

The proposed implementation contract is
[Phase 2 Spec: Outcome Loop](PHASE2_OUTCOME_LOOP_SPEC.md).

Before coding Phase 2, keep that spec as the implementation contract. It
answers the previously open design questions:

- `/outcomes` authentication and authorized callers: local-only in Phase 2,
  with live signed-source ingestion deferred.
- outcome event schema and idempotency keys: append-only events plus claimed
  source-event ids.
- manual retro ingestion: commercial state first, outcome second.
- external-reference active/historical model and HubSpot merge behavior:
  deferred rather than partially adopted.
- correction/cascade rules: append-only outcomes, SQL audit for conflicts, no
  automatic cascades.
- churn-before-deploy and reactivation handling: churn-before-deploy is a
  warning fact; reactivation is out of scope.
- projection rules versus event-history analytics: metrics query event history,
  not a mutable latest-state projection.

Only then add events such as:

```text
deployment_started
deployed
landed
expanded
churned
```

Phase 2 success metrics should query event history, not a single latest-state
projection.

## Phase 3: Role-specific queues

**Goal:** Turn the ledger into focused work queues without creating separate
apps.

Possible queues:

- AE attention queue.
- finance review queue.
- legal review queue.
- deployment readiness queue.
- growth/source attribution view.

Before coding Phase 3, specify multi-owner blocker semantics, queue membership
rules, and who can resolve or waive work.

## Phase 4: Policy evaluation

**Goal:** Make routing policy measurable before making it self-adjusting.

Possible reports:

- self-serve deals that later expanded.
- human-assisted deals that stalled or churned.
- source channels that produced successful deployments.
- finance/legal flags correlated with delay, waiver, or success.

No production thresholds should change automatically in this phase. Simulations
are read-only.

## Later: Agent inside typed rails

Only after outcomes and policy evaluation exist, an agent can draft handoff
summaries, missing-field questions, stale-deal nudges, and policy-change
recommendations. Before any code, specify human acceptance, rejected-suggestion
storage, and how accepted agent work is tied to an authenticated human
principal.

## Deferred specification checklist

These are explicitly **not** Phase 1 requirements. They must be resolved before
their phase ships:

- auth model for non-local write endpoints.
- active/historical external-reference table and merge/split behavior.
- out-of-order webhook handling beyond Phase 1's idempotent local event key.
- post-sale terminal-state correction and cascade semantics after outcomes
  exist.
- multi-owner blockers and waiver authority.
- manual retro ingestion authorization.
- reactivation after churn.
- redaction/retention rules for production data.

## Near-term artifact target

The next impressive version of this repo should demo:

```text
inbound lead
  -> routed human-assisted
  -> moved to closed_won by HubSpot webhook or local demo endpoint
  -> deployment readiness generated
  -> missing integration blocks staffing
  -> integration fact resolved
  -> readiness becomes ready
  -> redacted deployment handoff appears in Slack/dashboard
  -> audit proves no closed-won deal lacks readiness
```

That slice shows the whole operating philosophy without pretending to be a
full CRM, CLM, ERP, or deployment project system.
