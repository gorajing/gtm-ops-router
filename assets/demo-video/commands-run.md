# Commands run for the README demo video

All commands were run from `/Users/jinchoi/Code/gtm-ops-router` on 2026-06-10 local time.

## Repo proof

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
Ran 28 tests
OK
```

```text
rm -f data/router.video-demo.db data/router.video-demo.db-wal data/router.video-demo.db-shm data/router.video-demo.db-journal
GTM_ROUTER_DB_PATH=data/router.video-demo.db npm run run -- data/inbound.seed.jsonl --integrations --demo-outcomes --demo-engagement
[demo outcomes] reconciled: Ryder Digital, Cargo Loop
[demo engagement] imported: 8 events recorded, 0 duplicates, 1 commercial signals recorded, 0 unknown deal rejections
intake 13
routed 9
quarantined 4
routed ARR $508,000
auto-handled 3 deals
latency p50 1ms p95 10ms
```

```text
python3 ops_audit.py --db data/router.video-demo.db
RESULT: PASS
engagement orphans 0
projection conflicts 0
```

```text
python3 ops_audit.py --db data/router.video-demo.db --json
"engagement_orphans": 0
"engagement_projection_conflicts": 0
"stuck": 0
"breaches": []
"ok": true
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
"routeMix": { "nurture": 1, "self_serve": 2, "human_assisted": 6 }
"routedArrUsd": 508000
```

```text
curl -s http://localhost:8790/state
"coverage": { "complete": false, "routedDealsTotal": 9, "routedDealsWithEngagement": 4 }
"tiers": { "meetingsInfluencedUsd": 120000, "commercialSignalsUsd": 120000, "pipelineInfluencedUsd": 0 }
```

```text
curl -s http://localhost:8790/deals/D-fb65c15017ef/events
intake: Ryder Digital
enriched via fixture (conf 0.95)
score 1.00
sink: dry-run hubspot ... slack ...
route human_assisted
```

## Render commands

Playwright was installed outside the repo so package files were not changed:

```text
mkdir -p /tmp/cinematic-video-tools
npm --prefix /tmp/cinematic-video-tools install playwright
```

```text
NODE_PATH=/tmp/cinematic-video-tools/node_modules node assets/demo-video/record-operator-session.mjs
Wrote /Users/jinchoi/Code/gtm-ops-router/assets/demo-video/clips/operator-session.mp4
```

```text
node assets/demo-video/build-scenes.mjs
Wrote /Users/jinchoi/Code/gtm-ops-router/assets/demo-video/timeline.json
```

```text
node /Users/jinchoi/.codex/skills/cinematic-explainer-videos/scripts/assemble_timeline.mjs assets/demo-video/timeline.json
Wrote /Users/jinchoi/Code/gtm-ops-router/assets/demo.mp4
Estimated duration: 34.07s
```

```text
bash /Users/jinchoi/.codex/skills/cinematic-explainer-videos/scripts/extract_review_frames.sh assets/demo.mp4 assets/demo-video/review-frames \
  2.5:dashboard 7.4:workflow 12.3:route-detail 17.0:event-stream 22.5:authority-tiers 27.8:audit 32.0:close
```

```text
ffmpeg -y -i assets/demo.mp4 \
  -vf "fps=12,scale=900:-1:flags=lanczos,palettegen=stats_mode=diff" \
  /tmp/gtm-ops-router-demo-palette.png

ffmpeg -y -i assets/demo.mp4 -i /tmp/gtm-ops-router-demo-palette.png \
  -lavfi "fps=12,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle" \
  assets/demo.gif
```

```text
ffmpeg -y -ss 17.0 -i assets/demo.gif -frames:v 1 assets/demo-video/review-frames/gif-event-stream.png
ffmpeg -y -ss 27.8 -i assets/demo.gif -frames:v 1 assets/demo-video/review-frames/gif-audit.png
```

## Media metadata

```text
assets/demo.mp4
1280x720, 30fps, 34.066667s, 3,180,530 bytes
```

```text
assets/demo.gif
900x506, 12fps, 34.080000s, 18,456,865 bytes
```
