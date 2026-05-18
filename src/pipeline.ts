/**
 * Orchestration. Every stage is wrapped: the only two ways out of this
 * function are a routed deal or a typed Quarantine. Nothing is ever silently
 * dropped, and an unexpected throw is surfaced (store_error), not swallowed.
 */

import { createHash } from "node:crypto";
import { normalize } from "./intake.js";
import { score } from "./score.js";
import { route } from "./route.js";
import type { Enricher } from "./enrich.js";
import type { Store } from "./store.js";
import type {
  PipelineOutcome,
  Quarantine,
  QuarantineCode,
  Stage,
} from "./types.js";

// Below this enrichment confidence we refuse to score — acting on data we
// don't believe is how silent corruption enters an ops system.
const LOW_CONFIDENCE = 0.2;

function syntheticId(raw: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(raw);
  } catch {
    s = String(raw);
  }
  return "D-bad-" + createHash("sha1").update(s).digest("hex").slice(0, 8);
}

function quarantine(
  store: Store,
  dealId: string,
  from: Stage | "-",
  stage: Stage,
  code: QuarantineCode,
  reason: string,
  t0: number,
): PipelineOutcome {
  const q: Quarantine = {
    dealId,
    stage,
    code,
    reason,
    at: new Date().toISOString(),
  };
  store.appendEvent(dealId, from, "quarantined", `${code}: ${reason}`);
  store.upsertQuarantine(q, Math.round(performance.now() - t0));
  return { ok: false, quarantine: q };
}

export async function processOne(
  raw: unknown,
  store: Store,
  enricher: Enricher,
): Promise<PipelineOutcome> {
  const t0 = performance.now();

  // ── Stage 1: intake ──────────────────────────────────────────────────────
  const intake = normalize(raw);
  if (!intake.ok) {
    return quarantine(
      store,
      syntheticId(raw),
      "-",
      "intake",
      "schema_invalid",
      intake.reason,
      t0,
    );
  }
  const deal = intake.deal;
  store.appendEvent(deal.id, "-", "intake", `intake: ${deal.company}`);

  // ── Stage 2: enrich (the riskiest external boundary) ─────────────────────
  let enrichment;
  try {
    enrichment = await enricher.enrich(deal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return quarantine(
      store,
      deal.id,
      "intake",
      "enriched",
      "enrichment_unresolved",
      `provider error: ${msg}`,
      t0,
    );
  }
  if (enrichment === null) {
    return quarantine(
      store,
      deal.id,
      "intake",
      "enriched",
      "enrichment_unresolved",
      `no record for ${deal.domain ?? deal.company} — not guessing`,
      t0,
    );
  }
  if (enrichment.confidence < LOW_CONFIDENCE) {
    return quarantine(
      store,
      deal.id,
      "intake",
      "enriched",
      "insufficient_data",
      `enrichment confidence ${enrichment.confidence.toFixed(2)} < ${LOW_CONFIDENCE}`,
      t0,
    );
  }
  const enriched = { ...deal, enrichment };
  store.appendEvent(
    deal.id,
    "intake",
    "enriched",
    `enriched via ${enricher.name} (conf ${enrichment.confidence.toFixed(2)})`,
  );

  // ── Stage 3: score ───────────────────────────────────────────────────────
  const scored = { ...enriched, score: score(enriched) };
  store.appendEvent(
    deal.id,
    "enriched",
    "scored",
    `score ${scored.score.total.toFixed(2)}`,
  );

  // ── Stage 4: route ───────────────────────────────────────────────────────
  const routed = { ...scored, route: route(scored) };
  store.appendEvent(
    deal.id,
    "scored",
    "routed",
    `route ${routed.route.kind}`,
  );

  // ── Persist (loud on failure) ────────────────────────────────────────────
  const latency = Math.round(performance.now() - t0);
  try {
    store.upsertRouted(routed, latency);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Surfaced, not swallowed. If even quarantining fails, it rethrows.
    return quarantine(
      store,
      deal.id,
      "scored",
      "routed",
      "store_error",
      `persist failed: ${msg}`,
      t0,
    );
  }

  return { ok: true, deal: routed };
}

export async function processBatch(
  rawList: unknown[],
  store: Store,
  enricher: Enricher,
): Promise<PipelineOutcome[]> {
  const out: PipelineOutcome[] = [];
  for (const raw of rawList) {
    out.push(await processOne(raw, store, enricher));
  }
  return out;
}
