/**
 * Domain model for the GTM ops router.
 *
 * Design rule: make invalid states unrepresentable. A deal cannot be "routed" without a score; a route is a
 * discriminated union so you cannot construct a `human_assisted` route with no
 * owner; every failure is a typed `Quarantine`, never a dropped record.
 */

import { z } from "zod";

// ── Policy constants (every business threshold is named, not magic) ──────────
// $10K is the human-trust gate: above it, buyers will not self-serve — they
// need a person. We automate the *routing and prep*, never the close.
// (GTM mastery curriculum L7 / INS-260327-5DD2.)
export const HUMAN_GATE_USD = 10_000;
// Below this ICP fit we do not spend human time — nurture instead.
// (Funnel math: outreach is volume; protect rep hours. INS-260327-4E28.)
export const ICP_THRESHOLD = 0.55;

export const REGIONS = ["NA", "EU", "UK", "APAC", "LATAM"] as const;
export type Region = (typeof REGIONS)[number];

export const SOURCE_CHANNELS = [
  "inbound_form",
  "website_chat",
  "referral",
  "event",
  "cold_reply",
] as const;
export type SourceChannel = (typeof SOURCE_CHANNELS)[number];

export type Stage =
  | "intake"
  | "enriched"
  | "scored"
  | "routed"
  | "quarantined";

// ── Intake: validated at the boundary, never trusted raw ────────────────────
export const RawDealInput = z.object({
  id: z.string().min(1).optional(),
  company: z.string().min(1, "company is required"),
  domain: z.string().min(3).optional(),
  contactName: z.string().min(1, "contactName is required"),
  contactEmail: z.string().email("contactEmail must be a valid email"),
  dealUSD: z.number().finite().nonnegative("dealUSD must be >= 0"),
  region: z.enum(REGIONS),
  sourceChannel: z.enum(SOURCE_CHANNELS),
  statedNeed: z.string().min(1, "statedNeed is required"),
});
export type RawDealInput = z.infer<typeof RawDealInput>;

/** Normalized deal: id always present, domain coerced to string | null. */
export interface Deal {
  id: string;
  company: string;
  domain: string | null;
  contactName: string;
  contactEmail: string;
  dealUSD: number;
  region: Region;
  sourceChannel: SourceChannel;
  statedNeed: string;
}

// ── Enrichment ──────────────────────────────────────────────────────────────
export interface Enrichment {
  employees: number;
  industry: string;
  techSignals: string[];
  /** Regulated buyer (e.g. freight brokerage, healthcare) -> legal review. */
  regulated: boolean;
  /** 0..1. Low confidence is a first-class signal, not a silent default. */
  confidence: number;
}
export type EnrichedDeal = Deal & { enrichment: Enrichment };

// ── Scoring: deterministic and auditable (a reviewer can recompute it) ───────
export interface ScoreBreakdown {
  icpFit: number; // 0..1
  painSignal: number; // 0..1
  sizeFit: number; // 0..1
  regionFit: number; // 0..1
  total: number; // 0..1 weighted
  notes: string[]; // one line per dimension — the audit trail
}
export type ScoredDeal = EnrichedDeal & { score: ScoreBreakdown };

// ── Routing: a discriminated union — illegal combinations cannot be built ────
export type Route =
  | { kind: "nurture"; reason: string }
  | { kind: "self_serve"; queue: "sales_self_serve"; slaHours: number }
  | {
      kind: "human_assisted";
      salesOwner: string;
      financeFlag: "pricing_approval" | null;
      legalFlag: "regulated_review" | null;
      slaHours: number;
    };
export type RoutedDeal = ScoredDeal & { route: Route };

// ── Failure is typed, never silent ──────────────────────────────────────────
export type QuarantineCode =
  | "schema_invalid" // intake failed validation
  | "enrichment_unresolved" // could not resolve the company — we do NOT guess
  | "insufficient_data" // cannot score safely
  | "store_error"; // persistence failed — surfaced, not swallowed

export interface Quarantine {
  dealId: string;
  stage: Stage;
  code: QuarantineCode;
  reason: string;
  at: string; // ISO timestamp
}

/** The only two outcomes of the pipeline. Exhaustive by construction. */
export type PipelineOutcome =
  | { ok: true; deal: RoutedDeal }
  | { ok: false; quarantine: Quarantine };

// ── Observability ───────────────────────────────────────────────────────────
export interface PipelineEvent {
  id: number;
  dealId: string;
  ts: string;
  from: Stage | "-";
  to: Stage;
  detail: string;
}

export interface Metrics {
  intake: number;
  routed: number;
  quarantined: number;
  conversionPct: number; // routed / intake
  quarantineRatePct: number; // quarantined / intake
  routeMix: { nurture: number; self_serve: number; human_assisted: number };
  flags: { pricing_approval: number; regulated_review: number };
  quarantineByCode: Record<QuarantineCode, number>;
  latencyMsP50: number;
  latencyMsP95: number;
}
