/**
 * Orchestration. Every stage is wrapped: the only two ways out of this
 * function are a routed deal or a typed Quarantine. Nothing is ever silently
 * dropped, and an unexpected throw is surfaced (pipeline_error), not swallowed.
 *
 * Stage order matters: the downstream write (sink) is attempted BEFORE the
 * internal routed-state is persisted, so a deal is never both "routed
 * internally" and "failed to sync" — it is exactly one terminal state, and
 * routed + quarantined == intake always holds.
 */

import { createHash } from "node:crypto";
import { ENRICHMENT_FACT_MIN_CONFIDENCE } from "./constants.js";
import { normalize } from "./intake.js";
import { score } from "./score.js";
import { route } from "./route.js";
import {
  DEFAULT_RETRY,
  LoggingSink,
  SinkExhaustedError,
  TerminalSinkError,
  withRetry,
  type OpportunitySink,
  type RetryOptions,
  type SinkReceipt,
} from "./sink.js";
import type { Enricher } from "./enrich.js";
import type { Store } from "./store.js";
import type {
  Deal,
  Enrichment,
  PipelineOutcome,
  Quarantine,
  QuarantineCode,
  RoutedDeal,
  Stage,
} from "./types.js";

// Below this enrichment confidence we refuse to score — acting on data we
// don't believe is how silent corruption enters an ops system.
export const LOW_CONFIDENCE = ENRICHMENT_FACT_MIN_CONFIDENCE;

export interface PipelineOptions {
  /** Default true: do not attempt the external write, just record intent. */
  dryRun: boolean;
  sink: OpportunitySink;
  retry: RetryOptions;
}

function defaults(): PipelineOptions {
  return { dryRun: true, sink: new LoggingSink(), retry: DEFAULT_RETRY };
}

function renderReceipts(receipts: SinkReceipt[]): string {
  if (receipts.length === 0) return "sink: no downstream receipt";
  return receipts
    .map((r) => {
      const url = r.url ? ` (${r.url})` : "";
      return `${r.system}:${r.externalId} ${r.detail}${url}`;
    })
    .join(" | ");
}

function syntheticId(raw: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(raw);
  } catch {
    s = String(raw);
  }
  return "D-bad-" + createHash("sha1").update(s).digest("hex").slice(0, 8);
}

function bestEffortDealId(raw: unknown): string {
  const intake = normalize(raw);
  return intake.ok ? intake.deal.id : syntheticId(raw);
}

export type EnrichmentGateResult =
  | { ok: true; enrichment: Enrichment }
  | {
      ok: false;
      code: "enrichment_unresolved" | "insufficient_data";
      reason: string;
      enrichment?: Enrichment;
    };

export async function enrichWithGate(
  deal: Deal,
  enricher: Enricher,
): Promise<EnrichmentGateResult> {
  let enrichment;
  try {
    enrichment = await enricher.enrich(deal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "enrichment_unresolved",
      reason: `provider error: ${msg}`,
    };
  }
  if (enrichment === null) {
    return {
      ok: false,
      code: "enrichment_unresolved",
      reason: `no record for ${deal.domain ?? deal.company} — not guessing`,
    };
  }
  if (enrichment.confidence < LOW_CONFIDENCE) {
    return {
      ok: false,
      code: "insufficient_data",
      reason: `enrichment confidence ${enrichment.confidence.toFixed(2)} < ${LOW_CONFIDENCE}`,
      enrichment,
    };
  }
  return { ok: true, enrichment };
}

export function scoreAndRoute(
  deal: Deal,
  enrichment: Enrichment,
): RoutedDeal {
  const enriched = { ...deal, enrichment };
  const scored = { ...enriched, score: score(enriched) };
  return { ...scored, route: route(scored) };
}

function quarantine(
  store: Store,
  dealId: string,
  from: Stage | "-",
  stage: Stage,
  code: QuarantineCode,
  reason: string,
  t0: number,
  deal?: Deal,
  routedDeal?: RoutedDeal,
): PipelineOutcome {
  const q: Quarantine = {
    dealId,
    stage,
    code,
    reason,
    at: new Date().toISOString(),
  };
  try {
    store.recordQuarantine(
      q,
      Math.round(performance.now() - t0),
      from,
      `${code}: ${reason}`,
      deal,
      routedDeal,
    );
    return { ok: false, quarantine: q };
  } catch (err) {
    const persistReason = err instanceof Error ? err.message : String(err);
    const fallback: Quarantine = {
      ...q,
      reason: `${reason} (quarantine persistence failed: ${persistReason})`,
    };
    console.error(
      JSON.stringify({
        level: "error",
        event: "quarantine_persist_failed",
        dealId,
        code,
        reason: fallback.reason,
      }),
    );
    try {
      store.appendEvent(
        dealId,
        from,
        "quarantined",
        `quarantine_persist_failed: ${fallback.reason}`,
      );
    } catch {
      // If even the fallback breadcrumb cannot be written, the returned
      // quarantine and stderr line are the last available loud surfaces.
    }
    return { ok: false, quarantine: fallback };
  }
}

function recordEnrichmentEvidence(
  store: Store,
  deal: Deal,
  enricher: Enricher,
  enrichment: Enrichment,
): void {
  try {
    const result = store.recordEnrichmentObservation(deal, enricher.name, enrichment);
    if (result.status !== "idempotency_conflict") return;
    // The current pipeline source id is content-addressed, so this branch should
    // only fire if that identity contract changes or the store detects
    // corruption. Keep it loud but advisory for future provider-backed enrichers.
    console.error(
      JSON.stringify({
        level: "error",
        event: "enrichment_evidence_idempotency_conflict",
        dealId: deal.id,
        provider: enricher.name,
      }),
    );
    try {
      // This may create an intake -> enriched breadcrumb immediately before the
      // normal success or quarantine intake -> enriched event. The duplicated
      // edge is intentional: one row is advisory-evidence failure, the next row
      // remains the actual pipeline outcome.
      store.appendEvent(
        deal.id,
        "intake",
        "enriched",
        "enrichment_evidence_idempotency_conflict",
      );
    } catch {
      // Evidence is advisory to routing. If even the audit breadcrumb fails,
      // stderr remains the loud surface and the original route/quarantine holds.
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        level: "error",
        event: "enrichment_evidence_persist_failed",
        dealId: deal.id,
        provider: enricher.name,
        reason: msg,
      }),
    );
    try {
      store.appendEvent(
        deal.id,
        "intake",
        "enriched",
        `enrichment_evidence_persist_failed: ${msg}`,
      );
    } catch {
      // Preserve the original route/quarantine outcome even if evidence logging
      // fails; the evidence surface must not become a new routing gate.
    }
  }
}

export async function processOne(
  raw: unknown,
  store: Store,
  enricher: Enricher,
  options: Partial<PipelineOptions> = {},
): Promise<PipelineOutcome> {
  const opts = { ...defaults(), ...options };
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
  const enrichmentResult = await enrichWithGate(deal, enricher);
  if (!enrichmentResult.ok) {
    if (enrichmentResult.enrichment) {
      recordEnrichmentEvidence(
        store,
        deal,
        enricher,
        enrichmentResult.enrichment,
      );
    }
    return quarantine(
      store,
      deal.id,
      "intake",
      "enriched",
      enrichmentResult.code,
      enrichmentResult.reason,
      t0,
      deal,
    );
  }
  const enrichment = enrichmentResult.enrichment;
  recordEnrichmentEvidence(
    store,
    deal,
    enricher,
    enrichment,
  );
  store.appendEvent(
    deal.id,
    "intake",
    "enriched",
    `enriched via ${enricher.name} (conf ${enrichment.confidence.toFixed(2)})`,
  );

  // ── Stage 3: score + route ────────────────────────────────────────────────
  const routed = scoreAndRoute(deal, enrichment);
  store.appendEvent(
    deal.id,
    "enriched",
    "scored",
    `score ${routed.score.total.toFixed(2)}`,
  );

  // ── Stage 4: downstream write (before persisting routed state) ───────────
  let sinkState: {
    mode: "dry_run" | "live";
    status: "synced" | "partial" | "dry_run";
  };
  if (opts.dryRun) {
    const receipts = await opts.sink.upsert(routed); // LoggingSink records intent.
    sinkState = {
      mode: "dry_run",
      status: "dry_run",
    };
    store.appendEvent(
      deal.id,
      "scored",
      "scored",
      `sink: dry-run ${renderReceipts(receipts)}`,
      { kind: "sink", mode: "dry_run", receipts },
    );
  } else {
    try {
      const receipts = await withRetry(
        () => opts.sink.upsert(routed),
        opts.retry,
      );
      sinkState = {
        mode: "live",
        status: receipts.some((receipt) => receipt.status === "warning")
          ? "partial"
          : "synced",
      };
      store.appendEvent(
        deal.id,
        "scored",
        "scored",
        `sink: upserted via ${opts.sink.name} ${renderReceipts(receipts)}`,
        { kind: "sink", mode: "live", receipts },
      );
    } catch (err) {
      if (err instanceof TerminalSinkError) {
        return quarantine(
          store,
          deal.id,
          "scored",
          "routed",
          "sink_terminal",
          err.message,
          t0,
          deal,
          routed,
        );
      }
      if (err instanceof SinkExhaustedError) {
        return quarantine(
          store,
          deal.id,
          "scored",
          "routed",
          "sink_exhausted",
          err.message,
          t0,
          deal,
          routed,
        );
      }
      throw err; // unknown — do not absorb
    }
  }

  // ── Persist routed state (loud on failure) ───────────────────────────────
  const latency = Math.round(performance.now() - t0);
  try {
    store.recordRouted(routed, latency, sinkState);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return quarantine(
      store,
      deal.id,
      "scored",
      "routed",
      "store_error",
      `persist failed: ${msg}`,
      t0,
      deal,
    );
  }
  return { ok: true, deal: routed };
}

export async function processBatch(
  rawList: unknown[],
  store: Store,
  enricher: Enricher,
  options: Partial<PipelineOptions> = {},
): Promise<PipelineOutcome[]> {
  const out: PipelineOutcome[] = [];
  for (const raw of rawList) {
    const t0 = performance.now();
    try {
      out.push(await processOne(raw, store, enricher, options));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      out.push(
        quarantine(
          store,
          bestEffortDealId(raw),
          "-",
          "intake",
          "pipeline_error",
          `unexpected pipeline error: ${reason}`,
          t0,
        ),
      );
    }
  }
  return out;
}
