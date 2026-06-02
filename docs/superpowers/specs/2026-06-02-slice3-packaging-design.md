# Slice 3 — Packaging: make the now-true GTM-loop claim legible (design)

**Status:** design (brainstorming output) · **Date:** 2026-06-02

## Goal

Bring the public-facing narrative (`README.md`, `docs/DEMO_SCRIPT.md`,
`docs/SYSTEM_MAP.md`, `ASSUMPTIONS.md`) current with **Slice 2** (real, grounded
LLM enrichment) and **Plan B** (the closed engagement-feedback loop), and add a
tight **reviewer entry-point** — so a hiring reviewer (GTM / forward-deployed
engineer roles at Series A/B AI-native companies) grasps the now-true claim in
~60 seconds and can verify it. **Docs + stale doc-comments only — no code-logic
changes** (the one `.ts` touch is a doc-comment in `src/enrich/enricher.ts`).

## Decisions (locked during brainstorming)

1. **Scope:** update the existing docs to current + add a reviewer
   entry-point. NOT a from-scratch rewrite, NOT a new demo command, NOT a
   glossy showcase.
2. **Proof of "real":** code-trust + documented smoke. The docs show the
   enricher architecture + guardrails + the exact smoke command; **no committed
   live-output artifact** (nothing that can drift or look faked) and **no
   dependency on anyone running a key**.
3. **Reviewer entry-point lives as a new section IN the README** (discoverable
   for a GitHub skimmer), not a separate `FOR_REVIEWERS.md`.
4. **Small reciprocal pointer in the `sales` README** (one paragraph) so the
   closed loop is legible from both repos.

## Non-goals (YAGNI)

- No new demo command, no router CLI/API import for engagement feedback, and no
  wiring a new "full-loop" runner. Lean on existing runnable artifacts:
  `npm test`, the byte-for-byte sample regeneration (`gen-engagement-sample.ts`
  + `git diff --exit-code`), `npm run demo -- --demo-engagement` + `npm run
  serve` (dashboard attribution), and `npm run demo:cross-repo` (forward leg).
- No committed real-enrichment sample/transcript — the code + smoke command are
  the proof.
- No restructure of the existing README domain map, `RUNBOOK.md`, or
  `ASSUMPTIONS.md`.
- No marketing gloss. Every claim must be verifiable from the repo.

## What's stale (audit) → what changes

- **`README.md:5`** tagline `enrich` is generic → name it **real, grounded LLM
  enrichment, with a keyless deterministic fixture fallback**.
- **`README.md:24`** domain table points enrichment at **`enrich.ts`** → now the
  **`src/enrich/`** module (`collectors`, `confidence`, `claude-client`,
  `grounded-llm`, `safe-fetch`, `index`); note the LLM enricher.
- **`README.md:311`** lists a "Live `Enricher` adapter (Apollo/Clearbit/internal
  warehouse)" as **future work** → it's **built** (a grounded LLM enricher).
  Reframe future→done; note the seam still admits a vendor adapter as a drop-in.
- **`README.md` cross-repo story is forward-only** (handoff → sales) → add the
  **reverse leg** (sales produces `sales.engagement-feedback.v1` → router
  measurement) so the loop visibly closes.
- **`README.md` has no mention** of LLM / real enrichment / the closed loop →
  the reviewer entry-point + the fixes above introduce it.
- **`docs/DEMO_SCRIPT.md`** demos the forward handoff only → add the reverse leg
  (engagement feedback → measurement) showing the loop closing, + a real-
  enrichment smoke note.
- **`docs/SYSTEM_MAP.md`** predates the `src/enrich/` module + engagement-feedback
  tables → reflect them and the closed-loop ownership boundary.
- **`ASSUMPTIONS.md:22`** still states enrichment is a deterministic fixture (not
  a live provider) → update to "real grounded LLM enrichment (keyed) with a
  deterministic fixture fallback (keyless)."
- **`src/enrich/enricher.ts:4,56`** — the moved doc-comments still say the shipped
  implementation is "only a deterministic fixture" and the production seam is
  "not shipped." The reviewer entry-point sends people to `src/enrich/`, so this
  comment **actively contradicts the Slice-2 claim**. Update the comments to
  reflect that the real `GroundedLlmEnricher` (`src/enrich/grounded-llm.ts`) ships
  alongside the fixture. **Comment-only — no code logic changes.**
- **`README.md:14`** domain map says "8 domains" and has no engagement/measurement
  domain, though the store now owns `engagement_events`, `commercial_signals`,
  `engagement_feedback_meta`. Since the map is a source-of-truth table, add the
  measurement/engagement domain (and correct the count).

## The reviewer entry-point (new README section near the top, ~15–20 lines)

Three parts:

1. **What this is (one breath):** the closed GTM loop — *inbound deal → real
   grounded LLM enrichment → score → route (sales / finance / legal) → sales
   handoff → sales engagement feedback → router measurement.* "It runs; the
   loop closes."
2. **What it demonstrates (GTM judgment + engineering rigor):** honest
   enrichment (no fabrication, code-owned confidence ceiling, SSRF +
   prompt-injection guardrails, quarantine-on-uncertainty); typed failure
   handling + per-deal idempotency; a byte-for-byte cross-repo contract;
   measurement that gates trust.
3. **Verify it (the proof menu — every command confirmed accurate, see guardrail):**
   - **Keyless (no setup):**
     - `npm test` — the real suite count (structural correctness).
     - **Closed-loop, byte-for-byte:** `npx tsx scripts/gen-engagement-sample.ts
       && git diff --exit-code data/engagement-feedback.sample.json` — the
       committed sample regenerates identically (the test asserts `toEqual`, so
       cite THIS command for true byte-for-byte). Cross-repo, the `sales` repo's
       **frozen** `gen:engagement-sample` produces these *same bytes* (its
       `export:engagement-feedback` CLI stamps a live `generatedAt`, so that's
       the live path, NOT the byte-identical one).
     - **Measurement / attribution (dashboard, not terminal):** populate the
       **persistent** DB then serve — `npm run run -- data/inbound.seed.jsonl
       --demo-engagement`, then `npm run serve` (same DB path; default
       `data/router.db`) → the **Full-funnel panel** shows attribution. (Use
       `run`, not `demo`: `demo` uses an in-memory store `serve` can't read.
       And `npm run demo`'s *terminal* output shows routing/quarantine/metrics,
       **not** attribution rates — attribution lives in `/state` + the dashboard.)
   - **Keyed (live LLM):** `ANTHROPIC_API_KEY=… npx tsx scripts/enrich-smoke.ts
     stripe.com somenonexistentco.invalid` → real grounded enrichment + honest
     quarantine.
   - **Read:** `src/pipeline.ts` (stage order + error boundaries), `src/enrich/`
     (the real grounded enricher + guardrails).

   **Loop-closure framing (honest):** the forward leg is runnable end-to-end
   (`npm run demo:cross-repo`: router → handoff → sales). The reverse leg is
   proven two ways: the **runtime contract** (sales' live
   `export:engagement-feedback` emits `sales.engagement-feedback.v1`, which the
   router consumes via `Store.importEngagementFeedback`) and the **byte-for-byte
   identity** (sales' frozen `gen:engagement-sample` reproduces the router's
   committed sample exactly) + the router's `--demo-engagement` attribution —
   NOT by a single end-to-end command. Do **not** imply `demo:cross-repo` closes
   the loop, and do not invent a full-loop runner.

## Accuracy guardrail (non-negotiable)

Every verify-command quoted in the docs MUST be executed during implementation
and confirmed (exact test count, demo output, sample-diff result). The live
path is framed as "API-ready — here's the code + the smoke command," never as
"run in CI / I observed it." Stale paths and counts are corrected to ground
truth, not guessed.

## Files

- **gtm-ops-router:** `README.md` (reviewer entry-point + stale fixes: tagline,
  domain-map path/count + engagement domain, the "future" enricher bullet, the
  reverse leg), `docs/DEMO_SCRIPT.md` (reverse leg + smoke note),
  `docs/SYSTEM_MAP.md` (`src/enrich/` module + engagement-feedback tables +
  closed loop), `ASSUMPTIONS.md` (enrichment now real + fallback),
  `src/enrich/enricher.ts` (**doc-comment only** — the "fixture-only / not
  shipped" comment that contradicts Slice 2).
- **sales:** `README.md` (one reciprocal paragraph — "produces the
  `sales.engagement-feedback.v1` the router consumes").

## Success criteria

- A reviewer reading the README top understands the closed loop + real
  enrichment in ~60 seconds, and **every claim is verifiable from the repo**.
- No stale references remain (the `enrich.ts` path, the "future" enricher
  bullet, the forward-only loop).
- All cited keyless verify-commands run green (confirmed during implementation);
  the smoke command's guards are verified.
- Docs + one doc-comment: the full test suite and the byte-for-byte demo remain
  green (no code-*logic* touched — the only `.ts` edit is the `enricher.ts`
  comment).
