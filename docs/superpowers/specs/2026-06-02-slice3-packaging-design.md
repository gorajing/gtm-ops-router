# Slice 3 — Packaging: make the now-true GTM-loop claim legible (design)

**Status:** design (brainstorming output) · **Date:** 2026-06-02

## Goal

Bring the public-facing narrative (`README.md`, `docs/DEMO_SCRIPT.md`,
`docs/SYSTEM_MAP.md`) current with **Slice 2** (real, grounded LLM enrichment)
and **Plan B** (the closed engagement-feedback loop), and add a tight
**reviewer entry-point** — so a hiring reviewer (GTM / forward-deployed
engineer roles at Series A/B AI-native companies) grasps the now-true claim in
~60 seconds and can verify it. **Docs only — no code changes.**

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

- No new demo command and no wiring a new "full-loop" runner. Lean on existing
  runnable artifacts: `npm test`, `npm run demo`, the byte-for-byte sample
  regeneration, `npm run demo:cross-repo`, and the dashboard (`npm run serve`).
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
3. **Verify it (the proof menu):**
   - **Keyless (no setup):** `npm test` (the real count), `npm run demo`
     (routing + engagement attribution = the measurement spine), the
     byte-for-byte sample (regenerate → identical to the committed file), the
     dashboard (`npm run serve`).
   - **Keyed (live LLM):** `ANTHROPIC_API_KEY=… npx tsx scripts/enrich-smoke.ts
     stripe.com somenonexistentco.invalid` → real grounded enrichment + honest
     quarantine.
   - **Read:** `src/pipeline.ts` (stage order + error boundaries), `src/enrich/`
     (the real enricher + guardrails).

## Accuracy guardrail (non-negotiable)

Every verify-command quoted in the docs MUST be executed during implementation
and confirmed (exact test count, demo output, sample-diff result). The live
path is framed as "API-ready — here's the code + the smoke command," never as
"run in CI / I observed it." Stale paths and counts are corrected to ground
truth, not guessed.

## Files

- **gtm-ops-router:** `README.md` (reviewer entry-point + stale fixes),
  `docs/DEMO_SCRIPT.md` (reverse leg + smoke note), `docs/SYSTEM_MAP.md`
  (`src/enrich/` module + engagement-feedback tables + closed loop).
- **sales:** `README.md` (one reciprocal paragraph — "produces the
  `sales.engagement-feedback.v1` the router consumes").

## Success criteria

- A reviewer reading the README top understands the closed loop + real
  enrichment in ~60 seconds, and **every claim is verifiable from the repo**.
- No stale references remain (the `enrich.ts` path, the "future" enricher
  bullet, the forward-only loop).
- All cited keyless verify-commands run green (confirmed during implementation);
  the smoke command's guards are verified.
- Docs-only: the full test suite and the byte-for-byte demo remain green (no
  code touched).
