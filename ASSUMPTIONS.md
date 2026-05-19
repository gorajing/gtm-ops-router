# Assumptions & honest scope

What is real in this prototype, what is stubbed, and what a production
deployment would change. Stated up front so a reviewer doesn't have to
reverse-engineer the boundary.

## Real

- The pipeline, typed domain model, failure taxonomy, idempotency, retry/
  backoff classification, persistence, metrics, audit, and tests are real and
  run. The numbers in the README are asserted in the test suite.
- SQLite persistence is real SQL via Node's built-in `node:sqlite`.
- The Python audit (`ops_audit.py`) reads the same database and is a genuine
  SLO gate (non-zero exit on breach) — wire it to cron/CI as-is.

## Stubbed (deliberately, and visibly)

- **Enrichment** is a deterministic fixture (`data/enrichment.fixture.json`),
  not a live provider. The `Enricher` interface is the seam; an Apollo/
  warehouse adapter drops in without touching the pipeline. Unknown company →
  quarantined, never guessed — that behavior is real, the data source is not.
- **The downstream write (sink)** defaults to `LoggingSink` and dry-run: it
  logs the intended CRM upsert and writes nothing external. `--integrations`
  swaps in the HubSpot + Slack sink in dry-run mode, so the cross-system
  handoff is visible without secrets. `--live-integrations` makes real HTTP
  calls when the env vars in `.env.example` are present. `FlakySink`
  (`--flaky`) injects deterministic retryable/terminal faults so the failure
  handling is demonstrable without a real CRM.
- **Seed corpus** is 14 hand-built records chosen to exercise every route and
  every quarantine code. It is illustrative, not sampled from real traffic.
- **Scoring weights and the $10K / $50K gates** are reasoned policy defaults,
  not fitted to data. In production they would be calibrated against
  closed-won outcomes (see "what I'd build next" in the README).

## Not built (out of scope on purpose)

No auth, no second workflow, no multi-store. HubSpot and Slack adapters exist,
but a production deployment would still add secret management, structured log
shipping, alerting, and a dead-letter replay queue around them. That surface is
not pretended to be complete.

## Runtime floor

Needs Node ≥ 22.5 (built-in SQLite). Authored/tested on Node 25.2.1; the
failure branch on older Node degrades to a one-line preflight message, but
was not exercised on an actual LTS install. Python side: stdlib only, 3.8+.
