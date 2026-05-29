# GTM Loop Measurement — Slice 1 Design Spec

**Status:** Design locked — ready for implementation planning
**Date:** 2026-05-29
**Scope:** Cross-repo. Owned by `gtm-ops-router` (the measurement plane); requires additive changes in the companion `sales` repo.
**Author:** Jin Choi (with Claude)

---

## 1. Why this slice exists

The two repos already prove a lot: the router can route, sync, audit; Sales can research, draft, validate, and export. The chain is ~80% real. The two faked/missing ends are exactly what a Series A/B **GTM-engineer** role screens for hardest:

- **Front (faked):** enrichment is `FixtureEnricher` (`src/enrich.ts`). — *deferred to Slice 2.*
- **Back (missing):** outreach engagement tracking + business-outcome attribution. Neither repo has it; Sales `touches.status='sent'/sentAt` are vestigial. — **this slice.**

The portfolio claim we are making increasingly true: **`signal → route → evidence-grounded outreach → human review → CRM/Slack → measured outcome`.** Today that arrow stops at "outreach." This slice closes it: the router becomes the single **full-funnel measurement plane**, attributing engagement and revenue back to routing decisions.

**Non-goal restated:** this is *not* enterprise infrastructure (multi-tenancy, auth, scale). It is enterprise *workflow fluency* + a measurement spine. No infra drift.

---

## 2. Decision log (locked, with rationale)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Reverse versioned contract** `sales.engagement-feedback.v1`, file-based JSON, keyed by `routerDealId`. | Mirrors the forward `gtm-ops-router.sales-handoff.v1` exactly. Symmetry (two narrow contracts, opposite directions) is itself the portfolio asset. Rejected: direct dual-SQLite read (couples repos); live HTTP push (breaks the deliberate "narrow contract, not hidden live sync" posture, reintroduces secrets). |
| D2 | **Append-only engagement events**, not snapshots. | Mirrors the router's existing event-sourced `outcome_events`/`events`. Gives provenance and explainable attribution. |
| D3 | **Three epistemic categories are three different things** in the schema: observed engagement, derived verdicts, commercial signals. | Make the boundary a *type*, not a convention. A reviewer sees the distinction with zero prose. |
| D4 | **`no_response` is derived, never observed**, and superseded at projection time (never deleted). | Absence is not an observation. A late reply wins at read time; history is immutable. |
| D5 | **`commercialSignals` (e.g. `opportunity_created`) are non-authoritative observations**; the importer reconciles, it does **not** write `commercial_states`. | The router already owns commercial truth (`commercial_states`, sources `local`/`hubspot`). Letting Sales auto-write it would make Sales a silent revenue source-of-truth — the exact blur to avoid. |
| D6 | **Coverage flag from day one** (`coverage.complete`, `scanned`, `emitted`). | The forward contract's envelope has no truncation signal (audit finding). Silent undercounting would poison the measurement story. Missing engagement = *unknown*, never *negative*. |
| D7 | **Attribution metrics are tiered by source authority**, presented as an authority ladder (not a numeric `≥` cascade). | The three tiers are overlapping sets; the *set differences* are the diagnostic. |
| D8 | **Deal-grain attribution**, not weighted multi-touch. | Multi-touch would look sophisticated and be fake precision without real per-touch cost data. Disclosed as a deliberate choice. |
| D9 | **Hours-saved is a labeled model**, not a measurement. `ASSUMED_TRIAGE_MIN = 8`, `ASSUMED_DRAFT_MIN = 20`. | Conservative (real times usually higher) → under-claim a modeled number. Surfaced as "modeled estimate, assumptions shown." |
| D10 | **One canonical demo fixture, two render paths, identical `demo-engagement:` source IDs.** | Router-only and cross-repo demos share fixture semantics, so any combination of demo paths is a *replay* (idempotent), not additive. Prevents metric double-counting structurally. |
| D11 | **Simulator writes through the real importer**, not a store shortcut. | The demo *is* the acceptance test of the contract + importer (parse → validate → idempotency → boundary rejection). |
| D12 | **One dedicated "Full-funnel" panel** inside the existing dashboard; no new page. | Finishes the loop without a new product surface — the same control plane gets smarter. |
| D13 | **`ops_audit.py` gates ledger *integrity*, not GTM *performance*.** | The audit answers "is the measurement ledger trustworthy?" — never "is the reply rate good?" |

---

## 3. Architecture (Section 1)

```
inbound → route → [gtm-ops-router.sales-handoff.v1] → Sales: research → outreach
                                                              │
                          measured here ◄───────────────────┘
router imports [sales.engagement-feedback.v1]  →  attribution by routerDealId:
   signal → routing decision → outreach touch → engagement → commercial state → post-sale outcome
```

The router already owns the *back* funnel (`commercial_states`: open · proposal_sent · negotiating · closed_won · closed_lost; `outcome_events`: deployment_started · deployed · landed · expanded · churned). This slice adds the *front* funnel the router is currently blind to (sent → reply → meeting), joined on `routerDealId`. The join path already exists: Sales `touches → sequences → accounts`, and `gtm_handoff_imports.router_deal_id` (its PK) maps account → routerDealId.

---

## 4. Data model + `sales.engagement-feedback.v1` (Section 2)

### 4.1 The contract envelope (mirrors forward + coverage)

```jsonc
{
  "schemaVersion": "sales.engagement-feedback.v1",
  "generatedAt": "<canonical UTC>",
  "source": { "system": "sales", "purpose": "Report observed front-funnel engagement for router measurement." },
  "coverage": { "complete": true, "scanned": 0, "emitted": 0, "since": "<canonical UTC|null>" },
  "deals": [
    {
      "routerDealId": "D-...",
      "trace": { "sourceSystem": "sales", "boundary": "observed_engagement_not_router_truth" },
      "events": [ /* EngagementEvent[] */ ],
      "commercialSignals": [ /* optional, non-authoritative */ ]
    }
  ]
}
```

### 4.2 Event taxonomy (discriminated union — each kind carries only its valid payload)

```ts
type EngagementEvent =
  | { kind: "sent";           occurredAt: string; touchId: string; channel: "email" | "linkedin" }
  | { kind: "replied";        occurredAt: string; touchId: string; replyIntent: "positive" | "neutral" | "negative" }
  | { kind: "meeting_booked"; occurredAt: string; touchId: string; meetingAt: string }
  | { kind: "bounced";        occurredAt: string; touchId: string; reason: string }
  | { kind: "no_response";    occurredAt: string; asOf: string; windowDays: number; lastTouchId: string; derived: true };

// Separate seam — NEVER an engagement event, NEVER auto-writes commercial_states:
type CommercialSignal =
  | { kind: "opportunity_created"; occurredAt: string; amountUsd: number | null; crmRef: string | null };
```

- `replyIntent` (not `direction`): what the reply means for the deal.
- `delivered` deliberately **dropped** — no real provider receipt = fake precision.
- `no_response.derived: true` is a type-level honesty marker; only `no_response` can be derived.

### 4.3 `no_response` supersession (D4)

`no_response` is emitted by a window evaluator (`source: "sales_window_evaluator"`), keyed by `(lastTouchId, windowDays)` — re-emitting the same window is an idempotent duplicate. It is the **floor** in the router's funnel-state projection: any later observed event with greater `occurredAt` (a `replied`, `meeting_booked`) supersedes it **at read time**. History is never mutated; the projection picks max-progress.

### 4.4 Router-side storage

- **New table `engagement_events`** — mirrors `outcome_events` shape: `id PK, deal_id, source, source_event_id, source_payload_hash, kind, occurred_at, payload_json, created_at, UNIQUE(source, source_event_id), CHECK(kind IN (...)), CHECK(source IN ('sales_observed','sales_window_evaluator'))`. Append-only, idempotent by `(source, source_event_id)`; changed payload on same id → `idempotency_violation`.
- **New table `commercial_signals`** — non-authoritative observations for the reconciliation queue: `id PK, deal_id, source, source_event_id, source_payload_hash, kind, occurred_at, amount_usd, crm_ref, created_at, UNIQUE(source, source_event_id), CHECK(source IN ('sales_reported'))`. **Never writes `commercial_states`.** Surfaced in the console reconciliation queue for an operator/HubSpot to confirm.
- **New `PipelineEventMeta` variant** `engagement_observed` so engagement appears in the unified event trail (mirrors `post_sale_outcome`).
- Import validates strict canonical-UTC `occurredAt` (`YYYY-MM-DDTHH:mm:ss.sssZ`) at the boundary, identical to the existing local-write rule.
- **Boundary (mirror forward's "evidence length 0"):** the importer records only what the file reported; it never fabricates engagement; an event whose `routerDealId` is not a routed deal **fails loud** (rejected). A test asserts an engagement import leaves `commercial_states` byte-for-byte unchanged.

### 4.5 Sales-side changes (companion repo)

- Make `touches.status='sent'/sentAt` real (write a `sent` event when a touch is sent).
- **New Drizzle table `engagement_events`**: `{ id, touchId?, accountId, routerDealId, kind, occurredAt, source, payloadJson, eventKey }`. `routerDealId` resolved at emit time via `gtm_handoff_imports`.
- New export producing `sales.engagement-feedback.v1` (mirrors `lib/gtm-handoff/import.ts` patterns: zod parse with `.passthrough()` forward-compat, deterministic, idempotent).

---

## 5. Attribution model (Section 3)

A single modular `EngagementAttribution` domain object, **composed into** the existing policy-evaluation view (not new fields on `SourceChannelPolicySummary`/`FlagPolicySummary`). Everything joins on `routerDealId` — no fuzzy matching. Computed at read time (like `metrics()`), not a persisted aggregate.

### 5.1 Authority-tiered pipeline (D7 — sets, not a numeric ladder)

| Metric | Reads from | Authority |
|---|---|---|
| `meetingsInfluencedUsd` | `engagement_events` (`meeting_booked`) | Observed (Sales) |
| `commercialSignalsUsd` | `commercial_signals` | Reported (Sales, non-authoritative) |
| `pipelineInfluencedUsd` | `commercial_states` | Authoritative (local/HubSpot) |

Diagnostic = set differences in both directions (meeting-but-no-pipeline = lag/reconciliation gap; pipeline-but-no-meeting = progressed outside the tracked path).

### 5.2 Rates (deal-grain, coverage-aware, nullable)

- **Reply rate** = deals with ≥1 `replied` ÷ deals with ≥1 `sent`.
- **Meeting rate** = `meeting_booked` deals ÷ `sent` deals; and ÷ `replied` deals (reply→meeting conversion).
- **Win-rate by engagement path** = `closed_won` ÷ routed, sliced by source channel / route / score band / owner **and** engagement path (replied? met?). Connects the front funnel to the existing outcome aggregations.
- All sliced by segment. Denominator 0 → `null` ("n/a", mirroring nullable medians). A deal with no engagement data is **unknown**, not negative; if `coverage.complete=false`, every rate states its base ("over N of M deals with engagement data").

### 5.3 Hours saved (D9 — labeled model)

```ts
const ASSUMED_TRIAGE_MIN = 8;  // minutes a human would spend triaging+routing one inbound
const ASSUMED_DRAFT_MIN  = 20; // minutes to research+draft one outreach touch by hand
// hoursSaved = (autoHandledDeals * ASSUMED_TRIAGE_MIN + agentDraftedTouchesSent * ASSUMED_DRAFT_MIN) / 60
// Surfaced as "≈ X hours saved (modeled estimate, assumptions shown)" — never as measured time.
```

---

## 6. Simulator (Section 4) — deterministic, replay-safe

Mirrors the existing `demo-fixtures.ts` / `--demo-outcomes` pattern: deterministic seeds, frozen canonical-UTC timestamp literals (no clock dependency), real write paths, replay safety, demo/real-row guards.

- **One canonical `DEMO_ENGAGEMENT_FIXTURES`** (router-owned), two render paths, **identical `demo-engagement:{routerDealId}:{key}` source IDs** (own seed namespace, per the `demo-fixtures.ts` warning):
  1. **Router-only** (`npm run demo`, no Sales repo): `applyDemoEngagementFixtures` builds an in-memory `sales.engagement-feedback.v1` payload and calls the **real `importEngagementFeedback`** (D11 — no store shortcut). Layered by default; `--no-demo-engagement` to skip. Guarded by a new `nonDemoEngagementEventCount` (refuses to layer onto non-demo engagement rows on fixture deals).
  2. **Cross-repo**: committed `data/engagement-feedback.sample.json` (the canonical render; `.gitignore` gets a `!data/engagement-feedback.sample.json` exception mirroring `sales-handoff.sample.json`); `scripts/demo-cross-repo.sh` gains the reverse leg (Sales emits → router imports).
- **Drift guard** test asserts the committed sample equals the canonical render (mirrors commit `9062bcc`).
- Because both paths share IDs, running both is a replay (idempotent), not additive (D10).

### 6.1 The six acceptance cases

| # | Case | Proves |
|---|------|--------|
| 1 | Deterministic engagement (Ryder `sent→replied(positive)→meeting_booked`; one `bounced`) | demo: namespaced ids; idempotent |
| 2 | Partial coverage (`complete:false`, scanned>emitted) | attribution states its base; missing = unknown |
| 3a | Unknown `routerDealId` | importer **fails loud** (reject) |
| 3b | Malformed event | fails zod parse |
| 4 | Re-import idempotency | same file twice = duplicate no-op; same id + changed payload = `idempotency_violation` |
| 5 ⭐ | **Late reply after `no_response`** (`no_response(asOf T1)` then `replied(occurredAt T2>T1)`) | append-only history + derived-verdict supersession + projection-time truth; `no_response` row **retained**. **The acceptance test for the whole design.** |

---

## 7. Surfacing + audit (Section 5)

- **One dedicated "Full-funnel" panel section** on the existing dashboard (`public/dashboard.js` additive; `server.ts` stays lean). Renders:
  - the three **authority tiers** (Observed → Reported → Authoritative) with set-difference diagnostics — **no `≥` implication**;
  - reply / meeting rates by segment; win-rate by engagement path;
  - hours saved (labeled modeled estimate);
  - a **reconciliation queue** (commercial signals awaiting authoritative confirmation — operator-visible, never auto-applied);
  - a **coverage banner** when `coverage.complete=false`;
  - engagement rows in the existing **event trail** (`engagement_observed`).
- Honesty rules carried over: nullable rates render **"n/a", not 0**; unknown ≠ negative.
- **JSON `/state`** extended with the `EngagementAttribution` object (queryable; consumable by the audit).
- **`ops_audit.py` engagement invariants (integrity only, D13):** every `engagement_event.routerDealId` resolves to a routed deal (no orphans); idempotency/duplicate consistency; malformed/unknown payload → breach; late-reply/no-response projection consistency. Defined consistently across TS and Python from the start (pre-empts the Py/TS invariant divergence the audit flagged). **Never** gates reply rate or pipeline value.

---

## 8. Consolidated test matrix

| Layer | Tests |
|---|---|
| Simulator | the 6 cases (§6.1); late-reply = acceptance test |
| Contract round-trip | export → import → attribution; schema version pinned; drift guard on committed sample |
| Boundary | importer records only reported engagement, never fabricates; engagement import leaves `commercial_states` unchanged (commercialSignals never auto-write) |
| Attribution compute | three tiers correct; deal-grain; nullable → n/a; coverage-aware base; hours-saved deterministic given fixtures+constants |
| Python audit | engagement orphan / projection-consistency; exit 1 on breach |

---

## 9. Sequencing

1. **Warm-up PR (lands first) — reviewer-hardening, ~1 hour, no behavior change beyond tests/docs:**
   - Fix the two vacuous route tests (`test/route.test.ts:69-86`) — add top-level `expect(kind)` / else-throw.
   - Add a **negative** `integrity()` test (force an imbalance, assert `ok===false`).
   - README precision: tighten "pipeline doesn't change when you swap enrichers" (enum coupling), "nothing is ever dropped" (persist-failure boundary), and note `integrity()` excludes `schema_invalid`.
   - `ops_audit.py`: wrap the routed-payload `json.loads`/`float` so a malformed payload is a **breach (exit 1)**, not a traceback.
2. **Slice 1 build** (this spec), in dependency order: contract types → router `engagement_events` + `commercial_signals` tables + importer → Sales-side capture + export → attribution object → simulator + fixtures → Full-funnel panel + JSON → `ops_audit` invariants. Each step: feature branch → Codex `read-only` review loop (expect ≥2 rounds) → PR → merge → `git checkout main && git pull --ff-only`.

---

## 10. Out of scope / non-goals

- Real enrichment / intent signals (Slice 2 — provider-neutral adapters, not Clay-specific).
- End-to-end measured demo + packaging / Decagon-FDE overlay (Slice 3).
- Live provider, live Sales dependency, or clock dependency in any test (deterministic local proof first).
- Weighted multi-touch attribution; auto-mutation of `commercial_states`; auth/multi-tenancy/scale (infra — explicitly ruled out).

---

## 11. Open questions (resolve in `writing-plans` or implementation)

- Exact `commercial_signals` reconciliation UX (surface-only vs. one-click "confirm into commercial_states" via the *existing* local-write path).
- Whether the Sales-side `engagement_events` write is event-driven (on send/reply hooks) or a batch reconciler for v1 (likely batch + window evaluator for `no_response`).
- `agentDraftedTouchesSent` source for hours-saved (Sales `touch_revisions.createdBy='drafter'` count vs. a dedicated counter).
