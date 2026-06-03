# Assumptions & honest scope

What is real in this prototype, what is stubbed, and what a production
deployment would change. Stated up front so a reviewer doesn't have to
reverse-engineer the boundary.

## Real

- The pipeline, typed domain model, failure taxonomy, idempotency, retry/
  backoff classification, persistence, metrics, audit, and tests are real and
  run. The numbers in the README are asserted in the test suite.
- **Enrichment is real**: a grounded LLM enricher (Claude) infers firmographics
  from collected public evidence (homepage + DNS + tech signals), with a
  code-owned confidence ceiling, SSRF-safe fetching, prompt-injection isolation,
  and quarantine-on-uncertainty. It runs when `ANTHROPIC_API_KEY` is set;
  `src/enrich/` + `scripts/enrich-smoke.ts`.
- SQLite persistence is real SQL via Node's built-in `node:sqlite`.
- The Python audit (`ops_audit.py`) reads the same database and is a genuine
  SLO gate (non-zero exit on breach) — wire it to cron/CI as-is.
- HubSpot deal-stage webhook ingestion is real: it validates the optional v3
  signature, maps HubSpot deal IDs back through the router's unique deal
  property, dedupes webhook retries, records external stage state, and posts
  Slack updates for configured stages.

## Stubbed (deliberately, and visibly)

- **The keyless enrichment default is a deterministic fixture**
  (`data/enrichment.fixture.json`) — so the demo is reproducible with no API key.
  With `ANTHROPIC_API_KEY` set, the real grounded LLM enricher (above) runs
  instead, behind the same `Enricher` seam; a vendor adapter (Apollo/warehouse)
  is a further drop-in. Unknown company → quarantined, never guessed — that
  behavior is real in both modes.
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
shipping, alerting, public HTTPS hosting in front of the webhook endpoint, and a
dead-letter replay queue around them. That surface is not pretended to be
complete.

## Runtime floor

Needs Node ≥ 22.5 (built-in SQLite). Authored/tested on Node 25.2.1; the
failure branch on older Node degrades to a one-line preflight message, but
was not exercised on an actual LTS install. Python side: stdlib only, 3.8+.
