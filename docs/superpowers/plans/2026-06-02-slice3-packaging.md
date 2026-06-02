# Slice 3 — Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development. Docs work — the controller authors prose against the live files. Steps use checkbox (`- [ ]`). **Run a Codex review on the executed diff after each task and fix real findings before the next.**

**Goal:** Bring the public-facing narrative current with Slice 2 (real grounded LLM enrichment) and Plan B (the closed engagement-feedback loop), and add a reviewer entry-point — every claim verifiable, no overclaim.

**Architecture:** Docs + one doc-comment, no code logic. Each task edits one file (or one cohesive section), then runs the exact verify-command it cites and confirms the claim against ground truth. Spec: `docs/superpowers/specs/2026-06-02-slice3-packaging-design.md`.

**Tech Stack:** Markdown; the cited verify-commands (`npm test`, `npx tsx scripts/gen-engagement-sample.ts`, `npm run run -- … --demo-engagement` + `npm run serve`, `scripts/enrich-smoke.ts`). Node ≥22.5.

**Accuracy guardrail (every task):** Every command quoted in a doc MUST be executed and confirmed (exact test count, sample-diff result, dashboard panel present). The live LLM path is framed "API-ready — here's the code + smoke," never "I ran it in CI." Counts/paths are corrected to ground truth, not guessed. Use the *current* suite count from `npm test` (was 361) wherever a count appears.

---

## File structure

- `README.md` — reviewer entry-point (new section) + stale fixes (tagline, domain map path/count + measurement domain, cross-repo reverse leg, "future enricher" bullet, dashboard-seed flag, architecture note).
- `ASSUMPTIONS.md` — enrichment moves from "Stubbed" to real (dual-mode).
- `src/enrich/enricher.ts` — **doc-comments only** (the "fixture-only / not shipped" comments).
- `docs/SYSTEM_MAP.md` — reverse leg in the diagram + engagement-feedback tables + sales-side producer.
- `docs/DEMO_SCRIPT.md` — reverse-leg section (honest) + real-enrichment smoke note.
- `sales/README.md` (other repo) — one reciprocal paragraph.

---

### Task 1: README — reviewer entry-point

**Files:** Modify `README.md` (insert a new section after line 9, the `---` under the tagline, before `## Read this first`).

- [ ] **Step 1: Insert the reviewer entry-point.** After the `---` on line 9, add:

```markdown
## The closed loop (and how to verify it in ~5 minutes)

A **closed** GTM loop that runs end to end — no mock-ups:

> inbound deal → **real, grounded LLM enrichment** → score → route (sales / finance / legal) → sales handoff → **sales engagement feedback → router measurement**

The router decides what revenue work should happen and records why; the companion
[`gorajing/sales`](https://github.com/gorajing/sales) repo turns the right accounts
into evidence-grounded outreach and feeds observed engagement back. **What the
router routes, it later measures** — the loop closes.

**What's hard here (the judgment, not just the code):**

- **Honest enrichment.** Firmographics are inferred by an LLM (Claude) grounded in
  collected public evidence (homepage + DNS + tech signals), with a **code-owned
  confidence ceiling the model cannot inflate**, SSRF-safe fetching,
  prompt-injection isolation, and **quarantine-on-uncertainty** — an unknown
  company is never guessed. Keyless, a deterministic fixture is the default.
- **Typed failure handling + per-deal idempotency**, end to end.
- **A byte-for-byte cross-repo contract** — `sales` emits exactly the
  engagement-feedback bytes the router consumes.
- **Measurement that gates trust** — attribution, coverage, honest (nullable) rates.

**Verify it (no setup, no key):**

- `npm test` — the full suite, every failure mode asserted.
- **Closed loop, byte-for-byte:**
  `npx tsx scripts/gen-engagement-sample.ts && git diff --exit-code data/engagement-feedback.sample.json`
  — the committed engagement sample regenerates identically (the `sales` repo's
  frozen `gen:engagement-sample` reproduces these same bytes).
- **Measurement dashboard:**
  `npm run run -- data/inbound.seed.jsonl --demo-engagement`, then `npm run serve`
  → the **Full-funnel panel** at `http://localhost:8787` shows engagement attribution.

**Verify the live enricher (your own API key):**

- `ANTHROPIC_API_KEY=… npx tsx scripts/enrich-smoke.ts stripe.com somenonexistentco.invalid`
  → real grounded firmographics + an honest quarantine for the unresolvable one.

**Read:** [`src/pipeline.ts`](src/pipeline.ts) (stage order + error boundaries) and
[`src/enrich/`](src/enrich/) (the grounded enricher + its guardrails).
```

- [ ] **Step 2: Verify every cited command.**
  - `npm test` → record the exact `Tests N passed` count; ensure the prose doesn't hardcode a wrong number (it cites "the full suite", no number — good).
  - `npx tsx scripts/gen-engagement-sample.ts && git diff --exit-code data/engagement-feedback.sample.json` → must exit 0 (prints nothing / "byte-identical").
  - `npm run run -- data/inbound.seed.jsonl --demo-engagement` then `npm run serve` → confirm the dashboard serves and the Full-funnel panel renders engagement rows (curl `http://localhost:8787/state` and grep for `engagementAttribution`); then stop serve.
  - `npx tsx scripts/enrich-smoke.ts` with NO key → exits 2 (guard). (Do NOT run the keyed path — no key; the doc only documents it.)
  Expected: all commands behave as the prose claims. If any differs, fix the prose to match ground truth.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): add closed-loop reviewer entry-point

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: README — stale fixes (tagline, domain map, cross-repo, future bullet, architecture, dashboard flag)

**Files:** Modify `README.md` (lines ~5, 14, 24, 29-32, 47-75, 98, 311-314, 341-352).

- [ ] **Step 1: Tagline (line 5).** Replace:

```
Inbound deal → enrich → score → route across **sales / finance / legal**, with
typed failure handling, idempotent persistence, and live observability. No
mock-ups. It runs.
```

with:

```
Inbound deal → **real grounded LLM enrichment** (keyless fixture fallback) → score
→ route across **sales / finance / legal** → sales handoff → **engagement feedback
→ measurement**. Typed failure handling, idempotent persistence, a byte-for-byte
cross-repo contract, and live observability. No mock-ups. It runs, and the loop closes.
```

- [ ] **Step 2: Domain map count + enrichment path + new measurement domain (lines 14, 24).**
  - Line 14: change "one of 8 domains" → "one of 9 domains".
  - Line 24 (domain 6): change `enrich.ts` → `src/enrich/` and name the LLM enricher:
    ```
    | 6 | Enrichment (real, grounded LLM; fixture fallback) | `src/enrich/` · `store.ts` | `provider_observations`, `enriched_subject_facts` |
    ```
  - Add a new row after domain 8 (before the `—` integrity row), as domain 9:
    ```
    | 9 | Engagement feedback + measurement (closed loop) | `engagement.ts` · `store.ts` · `attribution.ts` | `engagement_events`, `commercial_signals`, `engagement_feedback_meta` |
    ```

- [ ] **Step 3: 60-second-map cross-repo line (lines 29-32).** Replace:

```
The cross-repo handoff (`src/sales-handoff.ts` → JSON) feeds the companion
Sales repo. See **[docs/SYSTEM_MAP.md](docs/SYSTEM_MAP.md)** for the ownership
boundary and **[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)** for the end-to-end
demo.
```

with:

```
The cross-repo handoff (`src/sales-handoff.ts` → JSON) feeds the companion Sales
repo; the Sales repo feeds **engagement** back as `sales.engagement-feedback.v1`,
which the router imports for measurement — so the loop closes. See
**[docs/SYSTEM_MAP.md](docs/SYSTEM_MAP.md)** for the ownership boundary and
**[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)** for the end-to-end demo.
```

- [ ] **Step 4: "Companion Sales tool" reverse leg (after line 75).** After the paragraph ending `…demoed without setting up the router first.`, add:

```markdown
The loop is bidirectional. The Sales repo also **produces** observed engagement as
a versioned `sales.engagement-feedback.v1` payload that the router imports
(`Store.importEngagementFeedback`) to compute attribution and coverage. The reverse
contract is proven **byte-for-byte**: the Sales repo's frozen `gen:engagement-sample`
reproduces the router's committed `data/engagement-feedback.sample.json` exactly.
(This is a forward + reverse *contract*, not a single end-to-end runner — see
[docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).)
```

- [ ] **Step 5: Dashboard-seed flag (line 98).** The engagement/attribution panel needs `--demo-engagement`. Change line 98 from:

```
npm run run -- data/inbound.seed.jsonl --integrations --demo-outcomes  # seed SQLite with receipts + post-sale outcomes
```

to:

```
npm run run -- data/inbound.seed.jsonl --integrations --demo-outcomes --demo-engagement  # seed receipts + post-sale outcomes + engagement (Full-funnel panel)
```

- [ ] **Step 6: "What I'd build next" — the enricher bullet is now DONE (lines 311-314).** Replace:

```
- Live `Enricher` adapter (Apollo/Clearbit/internal warehouse) behind the
  existing seam + a circuit breaker; dead-letter requeue after upstream
  recovery. (Retry/backoff, terminal-vs-retryable, dry-run, and the SLO gate
  are already built — see `sink.ts`, `integrations.ts`, and `ops_audit.py`.)
```

with:

```
- A vendor `Enricher` adapter (Apollo/Clearbit/internal warehouse) behind the
  existing seam — a drop-in next to the **already-shipped grounded LLM enricher**
  (`src/enrich/`), plus a circuit breaker and dead-letter requeue after upstream
  recovery. (Retry/backoff, terminal-vs-retryable, dry-run, and the SLO gate are
  already built — see `sink.ts`, `integrations.ts`, and `ops_audit.py`.)
```

- [ ] **Step 7: Architecture prose (lines 350-352).** The diagram's `enrich (seam, no guess)` is still accurate (the seam is the point); update the following prose sentence to name the real enricher. Change:

```
Each stage is single-purpose and swappable; the pipeline doesn't change when
an enricher or sink does. Read `pipeline.ts` first (~430 lines) — the stage
order and error boundaries are the interesting part.
```

to:

```
Each stage is single-purpose and swappable; the pipeline doesn't change when an
enricher or sink does — the enrichment seam now ships a **real grounded LLM
enricher** (`src/enrich/`, keyless fixture fallback) behind the same interface.
Read `pipeline.ts` first (~430 lines) — the stage order and error boundaries are
the interesting part.
```

- [ ] **Step 8: Verify.** `npm run run -- data/inbound.seed.jsonl --integrations --demo-outcomes --demo-engagement` must succeed and seed engagement (confirm via `/state` `engagementAttribution` as in Task 1). Confirm no other line now contradicts the changes (grep `enrich.ts`, "8 domains"). `npm test` + `npx tsc --noEmit` still green (README change can't break them, but the run-command must work).

- [ ] **Step 9: Commit**

```bash
git add README.md
git commit -m "docs(readme): current with Slice 2 (real enrichment) + Plan B (closed loop)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: ASSUMPTIONS.md — enrichment is now real (dual-mode)

**Files:** Modify `ASSUMPTIONS.md` (the "Real" section ~line 9, and the "Stubbed" enrichment bullet lines 22-25).

- [ ] **Step 1: Add to the "Real" list** (after the first bullet, ~line 11):

```
- **Enrichment is real**: a grounded LLM enricher (Claude) infers firmographics
  from collected public evidence (homepage + DNS + tech signals), with a
  code-owned confidence ceiling, SSRF-safe fetching, prompt-injection isolation,
  and quarantine-on-uncertainty. It runs when `ANTHROPIC_API_KEY` is set;
  `src/enrich/` + `scripts/enrich-smoke.ts`.
```

- [ ] **Step 2: Reframe the "Stubbed" enrichment bullet (lines 22-25)** from "Enrichment is a deterministic fixture, not a live provider" to the keyless-default framing:

```
- **The keyless enrichment default is a deterministic fixture**
  (`data/enrichment.fixture.json`) — so the demo is reproducible with no API key.
  With `ANTHROPIC_API_KEY` set, the real grounded LLM enricher (above) runs
  instead, behind the same `Enricher` seam; a vendor adapter (Apollo/warehouse)
  is a further drop-in. Unknown company → quarantined, never guessed — that
  behavior is real in both modes.
```

- [ ] **Step 3: Verify** — no remaining claim that enrichment is *only* a fixture: `grep -niE "enrichment is a deterministic fixture|not a live provider" ASSUMPTIONS.md` returns nothing.

- [ ] **Step 4: Commit**

```bash
git add ASSUMPTIONS.md
git commit -m "docs(assumptions): enrichment is now real (grounded LLM), fixture is the keyless default

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: src/enrich/enricher.ts — doc-comments only

**Files:** Modify `src/enrich/enricher.ts` (the header comment lines 1-12 and the trailing "Production seam (not shipped…)" comment lines 56-73). **No code logic.**

- [ ] **Step 1: Header comment (lines 1-12).** Replace lines 4-7 ("The `Enricher` interface is the seam … not a toy.") so it stops implying fixture-only:

```
 * The `Enricher` interface is the seam. This file holds the interface and the
 * keyless `FixtureEnricher` (deterministic, no API keys). The real, grounded LLM
 * enricher ships in `grounded-llm.ts` and is selected by `makeEnricher()` when
 * `ANTHROPIC_API_KEY` is set — the seam is live, not aspirational.
```

- [ ] **Step 2: Trailing comment (lines 56-73).** Replace the "Production seam (not shipped …) ApolloEnricher" block opener so it no longer says the production seam is unshipped:

```
/*
 * The production seam is SHIPPED: `GroundedLlmEnricher` (`grounded-llm.ts`) is a
 * real provider over the Anthropic API, keyed via ANTHROPIC_API_KEY. A vendor
 * adapter remains a drop-in behind the same interface — e.g.:
```

(Keep the `ApolloEnricher` sketch that follows as the vendor-adapter example, and keep the closing paragraph about `Enricher.name` / the provider enum.)

- [ ] **Step 3: Verify no logic changed** — `npx tsc --noEmit` exit 0 and `npm test` still green (comment-only edit). `git diff src/enrich/enricher.ts` shows only comment lines changed.

- [ ] **Step 4: Commit**

```bash
git add src/enrich/enricher.ts
git commit -m "docs(enrich): correct enricher.ts comments — the real grounded LLM enricher is shipped

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: docs/SYSTEM_MAP.md — reverse leg + engagement tables

**Files:** Modify `docs/SYSTEM_MAP.md` (diagram lines 5-8; ownership table lines 23-34).

- [ ] **Step 1: Diagram (lines 5-8).** Replace the forward-only seam diagram with one that shows the reverse leg:

```text
inbound deal -> route/work item -> sales handoff JSON ─────► evidence research -> drafted outreach -> critic review
        gtm-ops-router                                              gorajing/sales
       measurement  ◄──────────────  sales.engagement-feedback.v1  ◄──────────  observed engagement
```

- [ ] **Step 2: Ownership table — add the closed-loop rows (after line 31, the "Cross-repo seed payload" row).**

```
| Engagement feedback + attribution (closed loop) | `gtm-ops-router` | `engagement_events`, `commercial_signals`, `engagement_feedback_meta` |
| Engagement-feedback producer | `gorajing/sales` | `sales.engagement-feedback.v1` export (frozen `gen:engagement-sample` = byte-for-byte) |
```

- [ ] **Step 3: Enrichment row (line 26)** — name the real provider:

```
| Enrichment observations and projected facts (real grounded LLM; fixture fallback) | `gtm-ops-router` | `provider_observations`, `enriched_subject_facts` |
```

- [ ] **Step 4: Verify** — internal consistency: the new rows reference real tables (`grep -n "engagement_events\|commercial_signals\|engagement_feedback_meta" src/store.ts` confirms they exist). No code run needed.

- [ ] **Step 5: Commit**

```bash
git add docs/SYSTEM_MAP.md
git commit -m "docs(system-map): reverse leg + engagement-feedback ownership (closed loop)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: docs/DEMO_SCRIPT.md — reverse leg + real-enrichment smoke (honest framing)

**Files:** Modify `docs/DEMO_SCRIPT.md` (add a section after section 4 / before "## The one sentence" at line 114).

- [ ] **Step 1: Add the reverse-leg + enrichment section.** Insert before `## The one sentence`:

```markdown
### 5. The loop closes (reverse leg) + real enrichment

The forward leg above is runnable end to end. The **reverse leg** — Sales's
observed engagement flowing back to router measurement — is proven by **contract**,
not a single command (the router consumes engagement feedback via
`Store.importEngagementFeedback`; there is no end-to-end CLI runner):

```bash
# Router: byte-for-byte reverse contract — regenerate the committed sample, expect no diff
npx tsx scripts/gen-engagement-sample.ts && git diff --exit-code data/engagement-feedback.sample.json

# Sales: the frozen producer reproduces those SAME bytes (live `export:engagement-feedback`
# stamps a real generatedAt, so it is the live path, not the byte-identical one)
cd ../Sales && pnpm gen:engagement-sample && git diff --exit-code data/engagement-feedback.sample.json

# Router: see the measurement consuming engagement — attribution in the dashboard
cd ../gtm-ops-router
npm run run -- data/inbound.seed.jsonl --demo-engagement   # persistent DB; `demo` is in-memory
npm run serve                                              # http://localhost:8787 → Full-funnel panel
```

**Real enrichment (your own key).** Keyless, enrichment is the deterministic
fixture (so this demo needs no setup). With a key, the real grounded LLM enricher
runs:

```bash
ANTHROPIC_API_KEY=… npx tsx scripts/enrich-smoke.ts stripe.com somenonexistentco.invalid
```
```

- [ ] **Step 2: Verify** the router-side commands run as written (the `gen-engagement-sample` + `git diff --exit-code` exits 0; the `run --demo-engagement` seeds engagement). The Sales-side `pnpm gen:engagement-sample` is documented for the reader (confirm the script exists: `grep -n gen:engagement-sample /Users/jinchoi/Code/sales/package.json`).

- [ ] **Step 3: Commit**

```bash
git add docs/DEMO_SCRIPT.md
git commit -m "docs(demo): add reverse leg (closed loop, honest framing) + real-enrichment smoke

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: sales/README.md — reciprocal reverse-leg pointer

**Files:** Modify `/Users/jinchoi/Code/sales/README.md` (in the "Companion GTM control plane" section, after the importer block ~line 32).

- [ ] **Step 1: Add the reciprocal paragraph** after the paragraph ending `…until you capture and audit public sources.`:

```markdown
The loop is bidirectional. Sales also **produces** observed engagement back to the
router as a versioned `sales.engagement-feedback.v1` payload (`export:engagement-feedback`),
which `gtm-ops-router` imports to compute attribution and coverage — closing the
GTM loop. The reverse contract is byte-for-byte: the frozen `gen:engagement-sample`
reproduces the router's committed engagement sample exactly.
```

- [ ] **Step 2: Verify** — `pnpm -C /Users/jinchoi/Code/sales typecheck` still exit 0 (docs-only; no code), and `grep -n "export:engagement-feedback\|gen:engagement-sample" /Users/jinchoi/Code/sales/package.json` confirms both scripts exist.

- [ ] **Step 3: Commit** (on a `sales` branch — never main directly)

```bash
cd /Users/jinchoi/Code/sales
git checkout -b docs-slice3-reciprocal main
git add README.md
git commit -m "docs(readme): note the reverse leg — Sales produces sales.engagement-feedback.v1

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Final accuracy + integrity pass

**Files:** none (verification only).

- [ ] **Step 1: Every cited keyless command runs green.**
  - `npm test` — record count; ensure no doc hardcodes a wrong number.
  - `npx tsx scripts/gen-engagement-sample.ts && git diff --exit-code data/engagement-feedback.sample.json` — exit 0.
  - `npm run run -- data/inbound.seed.jsonl --demo-engagement` then `curl -s localhost:8787/state | grep -o engagementAttribution` (start/stop serve) — present.
  - `npx tsx scripts/enrich-smoke.ts` (no key) — exit 2.
- [ ] **Step 2: No stale references remain** — `grep -rnE "enrich\.ts|8 domains|not shipped|deterministic fixture, not a live" README.md ASSUMPTIONS.md docs/*.md src/enrich/enricher.ts` returns nothing meaningful.
- [ ] **Step 3: Code untouched-in-logic** — `npm test` green + `npx tsc --noEmit` exit 0 + `git diff main...HEAD -- src/` shows ONLY `src/enrich/enricher.ts` comment lines.
- [ ] **Step 4: Final Codex review** over the whole branch diff (both repos); fix real findings.
- [ ] **Step 5: Open PRs** (gtm-ops-router branch `slice3-packaging`; sales branch `docs-slice3-reciprocal`), pre-merge audit, merge.

---

## Self-review (author)

- **Spec coverage:** reviewer entry-point (T1) ✓; README stale fixes — tagline/domain-map/path/count/measurement-domain/cross-repo/future-bullet/architecture/dashboard-flag (T2) ✓; ASSUMPTIONS (T3) ✓; enricher.ts comment (T4) ✓; SYSTEM_MAP reverse leg + engagement tables (T5) ✓; DEMO_SCRIPT reverse leg + smoke, honest framing (T6) ✓; sales reciprocal (T7) ✓; accuracy guardrail enforced every task + a final pass (T8) ✓.
- **Accuracy:** dashboard uses `run --demo-engagement` (persistent), not `demo` (in-memory); byte-for-byte cites `gen-engagement-sample` + `git diff --exit-code`, and notes `export:engagement-feedback` is the live (non-byte-identical) path; no claim that one command closes the loop; the live LLM path is never claimed as CI-verified. Counts pulled from `npm test` at execution, not hardcoded.
- **Placeholder scan:** none — every step has concrete text + an exact verify command.
- **Consistency:** "9 domains" (T2) matches the added measurement domain row; the reverse-leg framing is identical across README/SYSTEM_MAP/DEMO_SCRIPT/sales (forward+reverse contract, byte-for-byte via the frozen `gen`, no full-loop runner).
