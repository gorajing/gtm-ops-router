# Runbook (first 30 days / on-call)

What an owner needs to operate this, not just read it.

## Operate it

```bash
npm run run -- data/inbound.seed.jsonl   # process a batch -> data/router.db
npm run run -- data/inbound.seed.jsonl --integrations # HubSpot+Slack dry-run receipts
python3 ops_audit.py --db data/router.db # SLO gate; exit 1 if breached
npm run serve                            # live dashboard :8787
```

Nightly cron / CI: `npm run run -- <today.jsonl> && python3 ops_audit.py`.
The audit exits non-zero on an SLO breach, so it fails the pipeline loudly
instead of letting a regression ride along silently.

Live integrations: copy `.env.example` to `.env`, fill HubSpot and Slack
secrets, then run with `--live-integrations`. HubSpot requires a unique deal
property named by `HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY`; without that, live mode
refuses to run because retrying create-only writes would duplicate deals.
The local `.env` loader is intentionally simple: one `KEY=value` per line,
optional quotes, no multiline values or inline comments.

HubSpot reverse-sync: expose the server through a secure public URL for the
demo/deployment, subscribe HubSpot to the deal `dealstage` property change
event, and point it at `/webhooks/hubspot`. Set `HUBSPOT_WEBHOOK_SECRET` and
`PUBLIC_BASE_URL` before using a public endpoint. If a reverse proxy must supply
the public origin, set `TRUST_PROXY=1` only when it controls `X-Forwarded-*`
headers. Set `HUBSPOT_NOTIFY_STAGE_IDS` to the internal HubSpot stage IDs that
should alert Slack, for example only the ID for "Contact Made"; live mode
refuses to run without this allowlist so a first setup cannot create a Slack
firehose. HubSpot may retry webhook deliveries, so the router stores a
composite event key and skips duplicate successful Slack posts.
For local curl-only testing of the dry-run webhook, set
`ALLOW_UNSIGNED_WEBHOOKS=1`; do not use that on a public URL.
Webhook idempotency claims the HubSpot event in SQLite before posting Slack.
That prevents duplicate Slack messages on HubSpot retries. If Slack fails, the
event key is marked failed; HubSpot's next retry re-attempts only the Slack
notification without reapplying the stage movement.

## Read the metrics

- **conversion %** — routed / intake. A sudden drop = upstream lead-quality
  or an enrichment outage (check `enrichment_unresolved`).
- **quarantine rate** — SLO default 35%. Above it, the audit fails. The
  `quarantineByCode` breakdown tells you *which* boundary broke.
- **routed ARR / human-routed ARR** — revenue moving through, and how much
  landed on the `human_assisted` route. Use it to size rep capacity, not just
  count leads.
- **auto-handled** — deals routed with zero rep touch. This is the leverage
  number; it is the thing this system exists to grow.

## Quarantine codes → response

| Code | Meaning | First action |
|---|---|---|
| `schema_invalid` | bad intake record | fix the upstream form/webhook; replay |
| `enrichment_unresolved` | provider miss/timeout/unknown co. | check provider health; backfill then replay |
| `insufficient_data` | enrichment confidence too low | lower-confidence source; do not "fix" by guessing |
| `store_error` | internal persistence failed | page: disk/db; this should never be normal |
| `pipeline_error` | unexpected per-record throw; batch continued | inspect stderr/test the failing adapter; replay |
| `sink_terminal` | downstream rejected (4xx/auth) | bad mapping or creds; fix config, replay |
| `sink_exhausted` | downstream retried to budget | dependency degraded; check its status, replay |

Nothing is dropped — every failure is a row in `deals` with
`stage='quarantined'`. Replay = re-ingest; idempotent on deal id, so replay is
always safe.

## Change it safely

- New enrichment/CRM/notification provider: implement the `Enricher` /
  `OpportunitySink` interface. The pipeline does not change.
- Always test a real sink with **dry-run first** (`--integrations`) — it logs
  HubSpot and Slack receipts and mutates nothing. Promote to live only after
  the event trail looks right.
- Test HubSpot stage-change webhooks with a known router-owned deal before a
  live walkthrough. The expected result is: dashboard HubSpot stage updates,
  deal event trail gains `hubspot stage changed`, Slack receives one message.
- Tune thresholds in `src/types.ts` (`HUMAN_GATE_USD`, `ICP_THRESHOLD`) and
  `src/route.ts` (`FINANCE_APPROVAL_USD`). They are named constants on purpose.

## Rollback

The sink runs *before* routed-state is persisted, so a bad downstream never
half-commits. To roll back a config change: revert the constant, re-run the
batch (idempotent), re-run the audit. No data migration.
