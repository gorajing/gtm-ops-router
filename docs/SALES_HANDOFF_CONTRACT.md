# Sales Handoff Contract

`gtm-ops-router` and [`gorajing/sales`](https://github.com/gorajing/sales)
stay separate on purpose:

```text
inbound deal -> route/work item -> sales handoff JSON -> evidence research -> drafted outreach -> critic review
        gtm-ops-router                         gorajing/sales
```

The router owns the operating state: route, owner, finance/legal flags,
commercial state, deployment readiness, work items, agent drafts, and audit
events. The Sales tool owns evidence-grounded research and outreach: verified
evidence rows, claim validation, critics, immutable revisions, and export for
manual send.

## CLI

Seed the router and export human-assisted opportunities as Sales research
inputs:

```bash
npm run run -- data/inbound.seed.jsonl --integrations --demo-outcomes
npm run export:sales -- --limit 10 --out data/sales-handoff.json
```

Use `--include-all-routes` when you want nurture and self-serve deals included
for analysis instead of only human-assisted opportunities. Add
`--operator-base-url http://localhost:8787` only when you want the exported
handoff to include local operator-console links; the default export avoids
persisting machine-specific URLs.

The companion Sales consumer command is pinned as part of this integration
contract:

```bash
pnpm import:gtm-handoff -- ../gtm-ops-router/data/sales-handoff.json
```

Changing that command in Sales should be paired with this contract doc and the
cross-repo demo script.

The cross-repo demo also relies on the Sales repo exposing:

- `pnpm db:migrate`, applied against the `SALES_DB_PATH` environment override;
- `pnpm import:gtm-handoff -- <handoff.json> --out <result.json>`;
- `SALES_DB_PATH=<demo.db> pnpm dev`, so the UI opens the same imported demo
  accounts;
- an import result with `databasePath`, `imported[].accountId`,
  `imported[].accountName`, and `imported[].routerDealId`.

Those are treated as the consumer-side seam, not incidental implementation
details.

## Schema

The export is a narrow file/stdout contract, not live CRM sync:

`trace` is required in the current v1 contract. Older v1 exports that predate
the trace field should be regenerated before importing into Sales.

```json
{
  "schemaVersion": "gtm-ops-router.sales-handoff.v1",
  "generatedAt": "2026-05-24T15:10:00.000Z",
  "source": {
    "system": "gtm-ops-router",
    "purpose": "Seed evidence-grounded sales research and outreach."
  },
  "filters": {
    "limit": 10,
    "includeAllRoutes": false
  },
  "accounts": [
    {
      "routerDealId": "D-fb65c15017ef",
      "trace": {
        "sourceSystem": "gtm-ops-router",
        "evidenceBoundary": "research_seed_not_verified_evidence"
      },
      "account": {
        "name": "Ryder Digital",
        "domain": "ryder-digital.com",
        "region": "NA",
        "sourceChannel": "inbound_form"
      },
      "contact": {
        "name": "Dana Pruitt",
        "email": "dana@ryder-digital.com"
      },
      "opportunity": {
        "amountUsd": 120000,
        "statedNeed": "30 reps stuck on manual check calls after hours, we can't scale",
        "route": {
          "kind": "human_assisted",
          "salesOwner": "ae.morgan",
          "financeFlag": "pricing_approval",
          "legalFlag": "regulated_review",
          "queue": null,
          "reason": null,
          "slaHours": 4
        },
        "score": {
          "total": 1,
          "notes": ["..."]
        }
      },
      "workflow": {
        "commercialState": "closed_won",
        "deploymentReadiness": {
          "readiness": "ready",
          "blockerCode": null,
          "reason": null,
          "updatedAt": "2026-05-24T15:00:00.000Z"
        },
        "workItems": [],
        "agentSuggestions": []
      },
      "enrichmentEvidence": {
        "sourceProvider": "fixture",
        "confidence": 0.95,
        "industry": "logistics",
        "employees": 1200,
        "techSignals": ["salesforce", "twilio"],
        "regulated": true,
        "freshnessStatus": "fresh",
        "observedAt": "2026-05-24T15:00:00.000Z",
        "sourceObservationId": "..."
      },
      "salesToolInput": {
        "accountName": "Ryder Digital",
        "accountDomain": "ryder-digital.com",
        "researchBrief": "Ryder Digital entered the GTM router...",
        "suggestedEvidenceQuestions": [
          "Find current public evidence that Ryder Digital has the operations pain described..."
        ]
      }
    }
  ]
}
```

## Invariants

- The router never writes directly into the Sales database.
- The Sales tool should treat `salesToolInput` as a research seed, not as
  verified evidence.
- `trace.evidenceBoundary` is intentionally literal:
  `research_seed_not_verified_evidence`.
- `operatorLinks` is optional and environment-specific; consumers should render
  only `http` or `https` links.
- Public facts still need to become Sales `evidence` rows and pass that repo's
  verification/critic workflow before appearing in outreach.
- `routerDealId` is the stable cross-repo trace key for future manual imports,
  audit notes, or screenshots.
