# gtm-ops-router

**A working slice of the Strategy & Ops Engineer role, built for HappyRobot.**

Inbound deal → enrich → score → route across **sales / finance / legal**, with
typed failure handling, idempotent persistence, and live observability. No
mock-ups. It runs.

---

## Why this exists

HappyRobot sells the thesis that AI workforces make manual operations
obsolete. The internal-ops function should be the first proof of that thesis,
not the last. The JD names the target directly:

> *"Improve go-to-market operations by building better tooling between sales,
> finance, and legal."*

At S23 → $60M scale, the place leverage leaks is the **handoff**: an inbound
deal that should be auto-qualified instead waits on a human; a $150K regulated
deal reaches an AE with no finance or legal context; a malformed record gets
silently dropped and nobody knows until the quarter closes. This is a small,
real system that closes those leaks — and, more importantly, shows *how I
reason* about building durable internal leverage.

---

## Run it (about 60 seconds)

Prereq: **Node ≥ 22.5** — uses the built-in SQLite, so zero native deps by
choice. Authored and tested on Node 25.2.1. On older Node a preflight prints a
one-line fix and exits cleanly, instead of a stack trace. Not claiming
universal; claiming honest about its floor.

```bash
npm install
npm run demo      # deterministic batch over a seed corpus — no API keys, no ports
npm test          # 21 tests incl. every failure mode
npm run serve     # live dashboard at http://localhost:8787
```

`npm run demo` prints run metrics, the routed table, the quarantine table
(loud, never dropped), and a full event trail for one deal. Node prints one
`ExperimentalWarning: SQLite ...` line — that is expected and intentional (see
below), not a defect.

---

## What the demo proves (these numbers are asserted in the test suite)

```
intake 13 · routed 9 (conv 69.2%) · quarantined 4 (rate 30.8%)
route mix      nurture 1 · self_serve 2 · human_assisted 6
human-gate     pricing_approval 4 · regulated_review 4
quarantine     schema_invalid 1 · enrichment_unresolved 2 · insufficient_data 1
```

14 input lines, but only 9 distinct routed rows: one line is a duplicate of
another and is **deduped at the store** — re-ingesting the same logical deal
never double-counts. That number being 9 and not 10 is the point.

---

## Design decisions (the judgment, not just the code)

Built to a production bar.

- **Rapid vs. evergreen.** This is an evergreen system (it would run daily for
  years), so it is typed, modular, and tested — not a flat script. Knowing
  which of the two you're building is the whole skill; a one-off campaign
  would correctly get the opposite treatment.
- **Make invalid states unrepresentable.** `src/types.ts` — `Route` is a
  discriminated union, so a `human_assisted` route with no owner cannot be
  constructed. The compiler enforces the business rules.
- **Fail loud, never silent.** Every failure is a typed `Quarantine` with a
  code and a human-readable reason. An unknown company is *not guessed*. A
  persistence error is surfaced as `store_error`, not swallowed. Nothing is
  ever dropped — `quarantined + routed == intake`, always.
- **Observability is first-class.** Every stage transition is an event row;
  metrics (conversion, quarantine rate by code, route mix, p50/p95 latency)
  are queryable and rendered on a live dashboard and a JSON endpoint.
- **Idempotency by construction.** Deterministic deal IDs → re-ingest is a
  safe no-op. Data accuracy is a property of the design, not a cron that
  cleans up later.
- **Clone-and-run, within a stated floor.** Zero native build step, zero
  secrets, deterministic demo. `node:sqlite` is loaded via `createRequire` so
  no bundler trips on the experimental specifier, and a preflight degrades an
  old-Node failure to one actionable line. It is not universal: it needs Node
  ≥ 22.5 and was tested on 25.2.1. The tradeoff — no native deps vs. an
  experimental builtin — is deliberate and disclosed, not hidden.

## What I deliberately did NOT automate

Knowing where automation stops is part of the job.

- **The close above $10K stays human.** Buyers will not self-serve at that
  size — trust is the product. The system routes and *prepares* the human
  (owner assigned, finance/legal pre-flagged) so they walk in ready; it never
  tries to replace them.
- **Finance pricing approval and legal regulated-review are flags, not
  decisions.** The system surfaces that they're needed and to whom; a person
  still decides. Automating the *routing* of judgment is leverage; automating
  the *judgment* is how an ops system silently does damage.

That boundary is a deliberate design output, not a missing feature.

## JD requirement → where it's demonstrated

| Their "Must Have" | In this repo |
|---|---|
| Ship real systems, strong SWE fundamentals | runs end-to-end; `tsc` strict + `noUncheckedIndexedAccess`; 21 tests |
| Automations/tools w/ SQL, APIs, scripting | `node:sqlite` store; `node:http` API; CLI batch + cron-shaped `run` |
| Reason about edge cases, failure modes, maintainability | 5 typed quarantine paths, all tested incl. injected `store_error` |
| Business intuition (cost, speed, scale) | scoring weights fit-first; `$10K`/`$50K` gates are named policy |
| Extreme ownership, ambiguity | scoped, built, and verified from a one-line JD bullet |
| Clear communication | this README; one audit note per score dimension |

## What I'd build next (ownership beyond the demo)

- Real enricher adapter (Apollo/warehouse) behind the existing `Enricher`
  seam — with a timeout + retry budget and a circuit breaker.
- A quarantine-rate **SLO with alerting**, and a dead-letter requeue once a
  bad upstream is fixed.
- Auth on `POST /deals`; structured log shipping.
- **The self-improving loop:** score routing decisions against closed-won
  outcomes, surface the false-positive / missed-pattern quadrants, and tune
  the thresholds from data instead of by hand. (Same loop, pointed at ops.)

## Architecture

```
inbound ─► intake ─► enrich ─► score ─► route ─► store ─► dashboard /metrics
            (zod)     (seam,   (deterministic, (sales/    (sqlite,   (http)
                       no guess) auditable)    finance/   idempotent,
              │           │         │           legal)    events)
              └───────────┴─────────┴── any failure ─► typed Quarantine (loud)
```

Each stage is single-purpose and swappable; the pipeline doesn't change when
an enricher does. `src/` is ~10 small files; read `pipeline.ts` first — the
error boundaries are the interesting part.

## 90-second walkthrough (for the screen recording)

1. (0:00) "HappyRobot sells autonomous ops. This is a working slice of the
   sales/finance/legal tooling bullet from the JD — built, not mocked."
2. (0:10) `npm run demo` — point at the metrics: "13 in, 9 routed, 4
   quarantined. Conversion and quarantine-by-code are asserted in tests."
3. (0:30) Routed table: "Ryder, $120K, regulated → human + finance + legal,
   pre-flagged. Off-ICP → nurture, zero rep time. $8K → self-serve."
4. (0:45) Quarantine table: "Unknown company is *not guessed* — quarantined
   with a reason. Bad schema, low-confidence data, provider timeout: all
   typed, none dropped."
5. (1:05) `src/types.ts` + `pipeline.ts`: "Invalid states are
   unrepresentable; every failure path is typed and tested."
6. (1:20) "What I didn't automate: the close, and finance/legal judgment.
   That boundary is deliberate. Repo's yours to clone."

---

Built by Jin Choi as a concrete artifact for the HappyRobot Strategy & Ops
Engineer role. Clone it, run `npm run demo`, read `pipeline.ts`.
