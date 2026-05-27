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
for analysis instead of only human-assisted opportunities.

## Schema

The export is a narrow file/stdout contract, not live CRM sync:

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
- Public facts still need to become Sales `evidence` rows and pass that repo's
  verification/critic workflow before appearing in outreach.
- `routerDealId` is the stable cross-repo trace key for future manual imports,
  audit notes, or screenshots.
