# Runbook (first 30 days / on-call)

What an owner needs to operate this, not just read it.

## Operate it

```bash
npm run run -- data/inbound.seed.jsonl   # process a batch -> data/router.db
python3 ops_audit.py --db data/router.db # SLO gate; exit 1 if breached
npm run serve                            # live dashboard :8787
```

Nightly cron / CI: `npm run run -- <today.jsonl> && python3 ops_audit.py`.
The audit exits non-zero on an SLO breach, so it fails the pipeline loudly
instead of letting a regression ride along silently.

## Read the metrics

- **conversion %** — routed / intake. A sudden drop = upstream lead-quality
  or an enrichment outage (check `enrichment_unresolved`).
- **quarantine rate** — SLO default 35%. Above it, the audit fails. The
  `quarantineByCode` breakdown tells you *which* boundary broke.
- **routed ARR / human-routed ARR** — revenue moving through, and how much
  needs a person. Use it to size rep capacity, not just count leads.
- **auto-handled** — deals routed with zero rep touch. This is the leverage
  number; it is the thing this system exists to grow.

## Quarantine codes → response

| Code | Meaning | First action |
|---|---|---|
| `schema_invalid` | bad intake record | fix the upstream form/webhook; replay |
| `enrichment_unresolved` | provider miss/timeout/unknown co. | check provider health; backfill then replay |
| `insufficient_data` | enrichment confidence too low | lower-confidence source; do not "fix" by guessing |
| `store_error` | internal persistence failed | page: disk/db; this should never be normal |
| `sink_terminal` | downstream rejected (4xx/auth) | bad mapping or creds; fix config, replay |
| `sink_exhausted` | downstream retried to budget | dependency degraded; check its status, replay |

Nothing is dropped — every failure is a row in `deals` with
`stage='quarantined'`. Replay = re-ingest; idempotent on deal id, so replay is
always safe.

## Change it safely

- New enrichment/CRM provider: implement the `Enricher` / `OpportunitySink`
  interface. The pipeline does not change.
- Always test a real sink with **dry-run first** (`LoggingSink`) — it logs
  intended writes and mutates nothing. Promote to live only after the log
  looks right.
- Tune thresholds in `src/types.ts` (`HUMAN_GATE_USD`, `ICP_THRESHOLD`) and
  `src/route.ts` (`FINANCE_APPROVAL_USD`). They are named constants on purpose.

## Rollback

The sink runs *before* routed-state is persisted, so a bad downstream never
half-commits. To roll back a config change: revert the constant, re-run the
batch (idempotent), re-run the audit. No data migration.
