# gtm-ops-router demo video claim ledger

Generated for the README replacement video on 2026-06-10.

## Core claims

| Claim in video | Evidence checked | Status |
|---|---|---|
| Inbound deals become routed work or visible exceptions. | `src/pipeline.ts`, `src/route.ts`, `npm run run -- data/inbound.seed.jsonl --integrations --demo-outcomes --demo-engagement` | Verified |
| Routing policy separates nurture, self-serve, and human-assisted work. | `src/route.ts`; run metrics route mix `nurture 1`, `self_serve 2`, `human_assisted 6` | Verified |
| Above-policy deals receive owner, finance, and legal prep flags rather than automated close decisions. | `src/route.ts`; README "What I deliberately did NOT automate"; run metrics `pricing_approval 4`, `regulated_review 4` | Verified |
| Demo run uses a real SQLite-backed ledger, not a mock dashboard. | `GTM_ROUTER_DB_PATH=data/router.video-demo.db npm run run -- ...`; live dashboard served from that DB on `localhost:8790` | Verified |
| Engagement feedback is imported as a reverse contract and does not become router commercial truth. | `src/engagement.ts`, `src/store.ts` tests, `/state.engagementAttribution`, `docs/SYSTEM_MAP.md` | Verified |
| Partial coverage is disclosed; missing engagement is unknown, not negative. | Live `/state` response and `public/dashboard.js` Full-funnel panel copy | Verified |
| Independent audit passes with zero engagement orphans and zero projection conflicts. | `python3 ops_audit.py --db data/router.video-demo.db` | Verified |
| Current automated checks pass. | `npm run typecheck`, `npm test`, `python3 -m unittest test_ops_audit` | Verified |
| Reverse sample has no drift. | `npx tsx scripts/gen-engagement-sample.ts`; `git diff --exit-code data/engagement-feedback.sample.json` | Verified |

## Current proof numbers

- Node: `v25.2.1`
- TypeScript: `tsc --noEmit` passed
- Vitest: `19` files, `361` tests passed
- Python audit unit tests: `28` tests passed
- Isolated demo run:
  - intake `13`
  - routed `9`
  - quarantined `4`
  - routed ARR `$508,000`
  - auto-handled `3`
  - engagement import: `8` events, `1` commercial signal, `0` unknown deal rejections
- Independent DB audit:
  - result `PASS`
  - engagement orphans `0`
  - projection conflicts `0`
  - breaches `[]`
- Live `/state.engagementAttribution`:
  - coverage `4 of 9` routed deals
  - reply rate `50.0%`
  - meeting rate `50.0%`
  - meetings influenced `$120,000`
  - commercial signals `$120,000`
  - authoritative pipeline influenced `$0`

## Deliberate wording boundaries

- Do not claim the reverse leg is one end-to-end live runner. The repo proves it as a byte-for-byte contract and consumes the sample for measurement.
- Do not claim commercial signals are revenue truth. They are Sales-reported observations requiring confirmation into router-owned `commercial_states`.
- Do not imply engagement coverage is complete. The demo intentionally renders partial coverage.
- Do not claim measured time savings. The dashboard labels hours saved as modeled.
