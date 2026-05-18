/**
 * Stage 4 — Route across sales / finance / legal.
 *
 * This is where the senior judgment lives (GTM curriculum L7): we automate
 * the *routing and prep*, never the close. Three outcomes:
 *
 *   - nurture        : below ICP threshold — do not spend a human's hour.
 *   - self_serve     : qualified and < $10K — buyers will self-serve here.
 *   - human_assisted : >= $10K — buyers will NOT self-serve at this size,
 *                       so a person owns it; finance/legal are pre-flagged
 *                       so the human walks in prepared, not blocked.
 *
 * The $10K gate is a named policy constant, not a magic number
 * (INS-260327-5DD2: above ~$10K, customers require human trust).
 */

import {
  HUMAN_GATE_USD,
  ICP_THRESHOLD,
  type Region,
  type Route,
  type ScoredDeal,
} from "./types.js";

// Pricing approval needed above this ACV (finance pre-flag).
const FINANCE_APPROVAL_USD = 50_000;

// Deterministic owner assignment by region (round-robin would be fine in
// production; a static map keeps the demo reproducible and auditable).
const OWNER_BY_REGION: Record<Region, string> = {
  NA: "ae.morgan",
  EU: "ae.lindqvist",
  UK: "ae.okafor",
  APAC: "ae.tan",
  LATAM: "ae.alvarez",
};

export function route(deal: ScoredDeal): Route {
  if (deal.score.total < ICP_THRESHOLD) {
    return {
      kind: "nurture",
      reason: `ICP fit ${deal.score.total.toFixed(2)} < threshold ${ICP_THRESHOLD} — nurture, no rep time`,
    };
  }

  if (deal.dealUSD < HUMAN_GATE_USD) {
    return { kind: "self_serve", queue: "sales_self_serve", slaHours: 24 };
  }

  const regulatedRegion = deal.region === "EU" || deal.region === "UK";
  return {
    kind: "human_assisted",
    salesOwner: OWNER_BY_REGION[deal.region],
    financeFlag: deal.dealUSD >= FINANCE_APPROVAL_USD ? "pricing_approval" : null,
    legalFlag:
      deal.enrichment.regulated || regulatedRegion ? "regulated_review" : null,
    slaHours: 4,
  };
}
