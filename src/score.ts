/**
 * Stage 3 — Score. Deterministic and auditable on purpose.
 *
 * A reviewer must be able to recompute any score by hand from the notes.
 * No LLM, no opaque float — quality is decomposed into four named
 * dimensions with documented weights (the same philosophy as the
 * hackathon critic: judge-recomputable beats clever).
 *
 * Targeting > copy: the score is overwhelmingly about *fit*, because no
 * downstream routing can rescue a wrong-fit deal (GTM curriculum L1).
 */

import type { EnrichedDeal, ScoreBreakdown } from "./types.js";

// HappyRobot is logistics-origin AI infra — freight/3PL/supply-chain is core.
const TARGET_INDUSTRIES = new Set([
  "logistics",
  "freight",
  "freight-brokerage",
  "3pl",
  "supply-chain",
  "trucking",
  "warehousing",
]);
const ADJACENT_INDUSTRIES = new Set([
  "manufacturing",
  "distribution",
  "retail",
  "ecommerce",
  "fintech",
]);

const PAIN_KEYWORDS = [
  "manual",
  "spreadsheet",
  "hours",
  "headcount",
  "error",
  "errors",
  "bottleneck",
  "can't scale",
  "cannot scale",
  "backlog",
  "phone",
  "call volume",
  "after hours",
  "24/7",
];

// Weights sum to 1.0 so the column is recomputable. Fit dominates by design.
const W = { icpFit: 0.35, painSignal: 0.3, sizeFit: 0.2, regionFit: 0.15 };

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function score(deal: EnrichedDeal): ScoreBreakdown {
  const notes: string[] = [];

  const ind = deal.enrichment.industry.trim().toLowerCase();
  const icpFit = TARGET_INDUSTRIES.has(ind)
    ? 1
    : ADJACENT_INDUSTRIES.has(ind)
      ? 0.5
      : 0.2;
  notes.push(
    `icpFit=${icpFit.toFixed(2)}: industry "${ind}" is ${
      icpFit === 1 ? "core" : icpFit === 0.5 ? "adjacent" : "off-ICP"
    }`,
  );

  const need = deal.statedNeed.toLowerCase();
  const hits = PAIN_KEYWORDS.filter((k) => need.includes(k)).length;
  const techBoost = deal.enrichment.techSignals.length > 0 ? 0.2 : 0;
  const painSignal = clamp01(hits * 0.25 + techBoost);
  notes.push(
    `painSignal=${painSignal.toFixed(2)}: ${hits} pain keyword(s)` +
      (techBoost ? " + tech signals present" : ""),
  );

  const emp = deal.enrichment.employees;
  const sizeFit = emp >= 50 && emp <= 5000 ? 1 : emp < 50 ? 0.4 : 0.7;
  notes.push(
    `sizeFit=${sizeFit.toFixed(2)}: ${emp} employees (${
      sizeFit === 1 ? "mid-market sweet spot" : "outside core band"
    })`,
  );

  const regionFit =
    deal.region === "NA" || deal.region === "EU" || deal.region === "UK"
      ? 1
      : deal.region === "APAC"
        ? 0.7
        : 0.6;
  notes.push(`regionFit=${regionFit.toFixed(2)}: region ${deal.region}`);

  if (deal.enrichment.confidence < 0.4) {
    notes.push(
      `NOTE: low enrichment confidence (${deal.enrichment.confidence.toFixed(
        2,
      )}) — score is provisional`,
    );
  }

  const total = clamp01(
    W.icpFit * icpFit +
      W.painSignal * painSignal +
      W.sizeFit * sizeFit +
      W.regionFit * regionFit,
  );

  return {
    icpFit,
    painSignal,
    sizeFit,
    regionFit,
    total: Math.round(total * 100) / 100,
    notes,
  };
}
