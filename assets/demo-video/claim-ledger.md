# gtm-ops-router demo video claim ledger

Generated for the operator-session README demo on 2026-06-10 local time.

## Core claims

| On-screen claim | Exact meaning | Evidence checked | Observed value | Safe caption |
|---|---|---|---|---|
| `Start in the live operator console.` | The video records the project dashboard served from the demo DB, not recreated static cards. | `GTM_ROUTER_DB_PATH=data/router.video-demo.db npm run serve -- 8790 --integrations`; Playwright recording of `/?demo=operator&deal=D-fb65c15017ef` | Local dashboard loaded from `/state` and selected the Ryder deal. | live operator console |
| `local SQLite sample run` | The demo uses committed sample/fixture data, not live customer data. | `GTM_ROUTER_DB_PATH=data/router.video-demo.db npm run run -- data/inbound.seed.jsonl --integrations --demo-outcomes --demo-engagement` | Isolated demo DB generated from committed fixtures. | local SQLite sample run |
| `$508,000`, `13`, `9`, `4`, `PASS` | Top dashboard KPI values from the fresh run. | `curl -s http://localhost:8790/state`; `curl -s http://localhost:8790/metrics` | routed ARR `$508,000`, intake `13`, routed `9`, quarantined `4`, settlement `PASS`. | operating state |
| `The same deal stays selected.` | The video follows Ryder Digital through workflow, detail, receipt, attribution, and audit beats. | `/?demo=operator&deal=D-fb65c15017ef`; `/state.queue` | Ryder remains selected in the operator workflow and detail panel. | same deal selected |
| `Ryder Digital`, `D-fb65c15017ef`, `$120K`, `human_assisted` | Ryder is the protagonist deal and was routed to a human-assisted workflow. | `/state.queue` Ryder row | `amount: 120000`, `route: human_assisted`, `id: D-fb65c15017ef`. | route receipt |
| `owner ae.morgan`, `pricing_approval`, `regulated_review`, `score 1.00` | Ryder carries owner, finance/legal flags, and score in the live state. | `/state.queue` Ryder row; `src/route.ts` | `owner ae.morgan | pricing_approval | regulated_review`; `scoreTotal: 1`. | owner / flags / score |
| `The handoff leaves receipts.` | Ryder has an event trail including intake, enrichment, score, dry-run HubSpot/Slack receipt, and route. | `curl -s http://localhost:8790/deals/D-fb65c15017ef/events` | Event stream includes intake, enriched, score, dry-run sink receipts, and `route human_assisted`. | event stream |
| `dry-run HubSpot + Slack receipts` | The display summarizes a real sink event instead of showing the full long receipt text. | `/deals/D-fb65c15017ef/events` event `id: 4` | Event detail contains dry-run HubSpot and Slack receipts for Ryder. | dry-run HubSpot + Slack receipts |
| `A signal is not truth.` | Sales-reported engagement and commercial signals are shown separately from router-owned pipeline influence. | `/state.engagementAttribution.tiers`; `src/attribution.ts`; `src/engagement.ts` | meetings influenced `$120,000`, commercial signals `$120,000`, authoritative pipeline influenced `$0`. | source authority |
| `coverage 4 / 9` | Engagement attribution coverage is partial and missing data is unknown, not negative. | `/state.engagementAttribution.coverage` | `routedDealsWithEngagement: 4`, `routedDealsTotal: 9`, `complete: false`. | coverage 4 / 9 |
| `Then the audit gets the last word.` | Independent Python audit passes against the isolated demo DB. | `python3 ops_audit.py --db data/router.video-demo.db`; JSON audit output | `RESULT: PASS`, engagement orphans `0`, projection conflicts `0`, stuck rows `0`. | audit proof |
| `typecheck passed`, `361 passed`, `28 passed` | Local checks passed during the video update. | `npm run typecheck`; `npm test`; `python3 -m unittest test_ops_audit` | TypeScript passed; Vitest 19 files / 361 tests; Python unittest 28 tests. | verified |

## Current proof numbers

- Node: `v25.2.1`
- TypeScript: `tsc --noEmit` passed
- Vitest: `19` files, `361` tests passed
- Python audit unit tests: `28` tests passed
- Isolated demo run:
  - intake `13`
  - routed `9`
  - quarantined `4`
  - route mix: nurture `1`, self_serve `2`, human_assisted `6`
  - routed ARR `$508,000`
  - auto-handled `3`
  - engagement import: `8` events, `1` commercial signal, `0` unknown deal rejections
- Ryder sample deal:
  - id `D-fb65c15017ef`
  - amount `$120,000`
  - route `human_assisted`
  - owner `ae.morgan`
  - flags `pricing_approval`, `regulated_review`
  - score `1.00`
- Independent DB audit:
  - result `PASS`
  - engagement orphans `0`
  - projection conflicts `0`
  - stuck rows `0`
  - breaches `[]`
- Live `/state.engagementAttribution`:
  - coverage `4 of 9` routed deals
  - meetings influenced `$120,000`
  - commercial signals `$120,000`
  - authoritative pipeline influenced `$0`

## Deliberate wording boundaries

- The video says `sample run` / `local SQLite sample run`; it does not claim live customer data.
- The reverse Sales leg is proven as a committed sample contract consumed by the router, not as a live external CRM sync.
- Commercial signals are not revenue truth. They are Sales-reported observations requiring confirmation into router-owned commercial state.
- Engagement coverage is partial by design. Missing engagement means unknown, not negative.
- The README visible artifact remains `assets/demo.gif`; the MP4 is retained as source/proof material.
