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
real system that closes those leaks.

---

## Run it (about 60 seconds)

Prereq: **Node ≥ 22.5** — uses the built-in SQLite, so zero native deps by
choice. Authored and tested on Node 25.2.1. On older Node a preflight prints a
one-line fix and exits cleanly, instead of a stack trace. Not claiming
universal; claiming honest about its floor.

```bash
npm install
npm run demo            # deterministic batch — no API keys, no ports (dry-run)
npm run demo -- --flaky # same data, live sink faults: retry-then-succeed + a terminal reject
npm test                # TypeScript suite, incl. every failure mode

# Dashboard proof surface:
npm run run -- data/inbound.seed.jsonl  # process seed data -> data/router.db
npm run serve                           # open http://localhost:8787

# Python side (stdlib only — the JD names Python explicitly):
python3 ops_audit.py --db data/router.db  # data-integrity + SLO gate; exit 1 on breach
python3 -m unittest test_ops_audit        # Python tests
```

`npm run demo` prints the same proof in the terminal. The dashboard renders it
as an operator view: KPIs, route mix, routed deals, quarantine ledger, and an
event trail, all backed by the same SQLite store. Node prints one
`ExperimentalWarning: SQLite ...` line — expected, the disclosed cost of zero
native deps, not a defect.

---

## Dashboard proof

![GTM Ops Router dashboard](docs/dashboard.png)

---

## What the demo proves (these numbers are asserted in the test suite)

```
intake 13 · routed 9 (conv 69.2%) · quarantined 4 (rate 30.8%)
route mix      nurture 1 · self_serve 2 · human_assisted 6
human-gate     pricing_approval 4 · regulated_review 4
quarantine     schema_invalid 1 · enrichment_unresolved 2 · insufficient_data 1
business       routed ARR $508,000 · auto-handled 3 (routed, no rep touch)
```

14 input lines, 9 distinct routed rows: one line duplicates another and is
**deduped at the store** — re-ingesting the same logical deal never
double-counts. 9, not 10, is the point. The default run is dry-run (no
external writes, zero `sink_*` quarantines); `--flaky` injects deterministic
retryable and terminal sink faults so the retry/terminal taxonomy is visible
in the quarantine table, not just asserted in tests.

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
| Ship real systems, strong SWE fundamentals | runs end-to-end; `tsc` strict + `noUncheckedIndexedAccess`; TS + Python suites |
| Automations/tools w/ **Python**, SQL, APIs, scripting | Python `ops_audit.py` (SLO gate, stdlib, tested); `node:sqlite` store; `node:http` API; cron-shaped `run` |
| Reason about edge cases, failure modes, maintainability | 6 typed quarantine codes incl. injected `store_error`; retryable-vs-terminal sink taxonomy w/ bounded backoff; dry-run |
| Business intuition (cost, speed, scale) | routed/human ARR + auto-handled metrics; `$10K`/`$50K` gates are named policy |
| Extreme ownership, ambiguity | scoped from a one-line JD bullet to a running system; `ASSUMPTIONS.md` + `RUNBOOK.md` |
| Clear communication | this README, runbook, assumptions; one audit note per score dimension |

## What I'd build next (ownership beyond the demo)

- Live `Enricher` / `OpportunitySink` adapters (Apollo, Salesforce) behind
  the existing seams + a circuit breaker; dead-letter requeue after upstream
  recovery. (Retry/backoff, terminal-vs-retryable, dry-run, and the SLO gate
  are already built — see `sink.ts` and `ops_audit.py`.)
- Auth on `POST /deals`; structured log shipping; alerting wired to the
  existing audit gate.
- **The self-improving loop:** score routing decisions against closed-won
  outcomes, surface the false-positive / missed-pattern quadrants, and tune
  the thresholds from data instead of by hand. (Same loop, pointed at ops.)

## Architecture

```
inbound ─► intake ─► enrich ─► score ─► route ─► sink ──► store ─► dashboard
            (zod)    (seam,   (determ., (sales/  (retry/  (sqlite, /metrics
                      no guess) audit)   fin/     terminal idempot. (http)
              │          │        │       legal)   dry-run)  events)
              └──────────┴────────┴───────┴── any failure ─► typed Quarantine (loud)

data/router.db ─► ops_audit.py   (Python: invariant + SLO gate, exit 1 on breach)
```

Each stage is single-purpose and swappable; the pipeline doesn't change when
an enricher or sink does. `src/` is ~11 small files; read `pipeline.ts` first
— the stage order and error boundaries are the interesting part.

## 90-second walkthrough (for the screen recording)

1. (0:00) "HappyRobot sells autonomous ops. This is a working slice of the
   sales/finance/legal tooling bullet from the JD — built, not mocked."
2. (0:10) `npm run run -- data/inbound.seed.jsonl && npm run serve`, then open
   `http://localhost:8787` — point at the dashboard metrics: "13 in, 9 routed,
   4 quarantined. Conversion and quarantine-by-code are asserted in tests."
3. (0:30) Routed deals: "Ryder, $120K, regulated → human + finance + legal,
   pre-flagged. Off-ICP → nurture, zero rep time. $8K → self-serve."
4. (0:45) Quarantine ledger: "Unknown company is *not guessed* — quarantined
   with a reason. Bad schema, low-confidence data, provider timeout: all
   typed, none dropped."
5. (1:05) `src/types.ts` + `pipeline.ts`: "Invalid states are
   unrepresentable; every failure path is typed and tested."
6. (1:20) "What I didn't automate: the close, and finance/legal judgment.
   That boundary is deliberate. Repo's yours to clone."

---

Built by Jin Choi as a concrete artifact for the HappyRobot Strategy & Ops
Engineer role. Clone it, run `npm run demo`, read `pipeline.ts`.
