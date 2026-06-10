# Commands run for the README demo video

All commands were run from `/Users/jinchoi/Code/gtm-ops-router` on 2026-06-10.

```text
node --version
v25.2.1
```

```text
npm run typecheck
> gtm-ops-router@0.1.0 typecheck
> tsc --noEmit
```

```text
npm test
Test Files  19 passed (19)
Tests       361 passed (361)
```

```text
python3 -m unittest test_ops_audit
Ran 28 tests in 0.011s
OK
```

```text
GTM_ROUTER_DB_PATH=data/router.video-demo.db npm run run -- data/inbound.seed.jsonl --integrations --demo-outcomes --demo-engagement
[demo outcomes] reconciled: Ryder Digital, Cargo Loop
[demo engagement] imported: 8 events recorded, 0 duplicates, 1 commercial signals recorded, 0 unknown deal rejections
intake 13
routed 9
quarantined 4
routed ARR $508,000
auto-handled 3 deals
latency p50 1ms p95 9ms
```

```text
python3 ops_audit.py --db data/router.video-demo.db
RESULT: PASS
engagement orphans 0
projection conflicts 0
```

```text
python3 ops_audit.py --db data/router.video-demo.db --json
"breaches": []
"ok": true
```

```text
npx tsx scripts/gen-engagement-sample.ts
wrote data/engagement-feedback.sample.json
```

```text
git diff --exit-code data/engagement-feedback.sample.json
# no output; exit 0
```

```text
GTM_ROUTER_DB_PATH=data/router.video-demo.db npm run serve -- 8790 --integrations
gtm-ops-router listening on http://localhost:8790
sink              hubspot+slack:dry-run
```

```text
curl -s http://localhost:8790/metrics
"intake": 13
"routed": 9
"quarantined": 4
"routedArrUsd": 508000
```

```text
curl -s http://localhost:8790/state
"coverage": { "complete": false, "routedDealsTotal": 9, "routedDealsWithEngagement": 4 }
"tiers": { "meetingsInfluencedUsd": 120000, "commercialSignalsUsd": 120000, "pipelineInfluencedUsd": 0 }
```

```text
assets/demo.mp4
1280x720, 30fps, 35.766667s, 4,270,569 bytes
```

```text
assets/demo.gif
640x360, 8fps, 35.760000s, 8,981,216 bytes
```
