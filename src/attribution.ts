/**
 * Engagement attribution — composed into the existing policy-evaluation surface
 * as a read-time projection. Everything joins on routerDealId; no fuzzy matching.
 *
 * Three authority tiers are *sets*, not a numeric ordering (D7):
 *   - meetingsInfluencedUsd   → observed  (Sales engagement_events)
 *   - commercialSignalsUsd    → reported  (Sales commercial_signals, non-authoritative)
 *   - pipelineInfluencedUsd   → authoritative (router commercial_states)
 *
 * Set differences in both directions are the diagnostic, not a cascade.
 * A deal with no engagement data is "unknown", never negative (D6).
 */

import {
  ASSUMED_TRIAGE_MIN,
  ASSUMED_DRAFT_MIN,
} from "./constants.js";
import type {
  CommercialState,
  CommercialStateRecord,
  RoutedDeal,
  EngagementEventRecord,
  CommercialSignalRecord,
} from "./types.js";

// Re-export so test files can import these types from attribution.js without
// going through types.js directly.
export type { EngagementEventRecord, CommercialSignalRecord };

// ── Minimal store surface needed for attribution ──────────────────────────
// Structural interface: the real Store (Tasks 2 & 3) satisfies this.
export interface AttributionStore {
  routed(limit?: number): RoutedDeal[];
  commercialState(dealId: string): CommercialStateRecord | null;
  engagementEvents(dealId?: string): EngagementEventRecord[];
  commercialSignals(dealId?: string): CommercialSignalRecord[];
  lastEngagementFeedbackCoverageComplete(): boolean;
}

// ── Public types ──────────────────────────────────────────────────────────

export type EngagementPath = "replied" | "met" | "no_engagement";

export interface EngagementAttribution {
  coverage: {
    /** True only when the most-recent imported feedback declared complete=true. */
    complete: boolean;
    routedDealsTotal: number;
    routedDealsWithEngagement: number;
  };
  /**
   * Three authority tiers — overlapping sets, NOT a numeric ≥ ordering.
   * Observed | Reported | Authoritative.
   */
  tiers: {
    /** Sum dealUSD for routed deals with >=1 meeting_booked event. Observed (Sales). */
    meetingsInfluencedUsd: number;
    /** Sum dealUSD for routed deals with >=1 opportunity_created signal. Reported (Sales, non-authoritative). */
    commercialSignalsUsd: number;
    /** Sum dealUSD for routed deals in an active (non-terminal, non-won) commercial_state. Authoritative (router). */
    pipelineInfluencedUsd: number;
  };
  /**
   * Deal-grain rates. null when denominator is 0 — callers render "n/a", never 0.
   * Base is deals with >=1 sent event.
   */
  rates: {
    replyRate: number | null;
    meetingRate: number | null;
    replyToMeetingRate: number | null;
  };
  /**
   * Closed-won / routed, sliced by engagement path (deal-grain).
   * winRate is null when routed count is 0 for that path.
   */
  winRateByEngagementPath: Array<{
    path: EngagementPath;
    routed: number;
    closedWon: number;
    winRate: number | null;
  }>;
  /**
   * Hours-saved model (D9). modeled is always true — never a measured value.
   * agentDraftedTouchesSent is 0 for Plan A; source is out of scope until Plan B.
   */
  hoursSaved: {
    autoHandledDeals: number;
    /** TODO(Plan B): source from sales touch_revisions.createdBy='drafter' count. */
    agentDraftedTouchesSent: number;
    assumedTriageMin: number;
    assumedDraftMin: number;
    estimatedHours: number;
    modeled: true;
  };
}

// Non-terminal, non-won states that represent active pipeline.
const PIPELINE_ACTIVE_STATES: ReadonlySet<string> = new Set([
  "open",
  "proposal_sent",
  "negotiating",
]);

/**
 * Compute EngagementAttribution at read time.
 * Pure projection — mirrors metrics() in store.ts; never a persisted aggregate.
 */
export function computeEngagementAttribution(
  store: AttributionStore,
): EngagementAttribution {
  // ── Routed deals ──────────────────────────────────────────────────────────
  const routedDeals = store.routed();
  const routedDealsTotal = routedDeals.length;

  const dealUsdById = new Map<string, number>(
    routedDeals.map((d) => [d.id, d.dealUSD]),
  );

  // auto-handled = nurture + self_serve (mirrors metrics().autoHandled)
  const autoHandledDeals = routedDeals.filter(
    (d) => d.route.kind === "nurture" || d.route.kind === "self_serve",
  ).length;

  // ── Engagement events ────────────────────────────────────────────────────
  const allEngagementEvents = store.engagementEvents();

  const sentDeals = new Set<string>();
  const repliedDeals = new Set<string>();
  const meetingDeals = new Set<string>();
  const dealsWithAnyEvent = new Set<string>();

  for (const ev of allEngagementEvents) {
    if (!dealUsdById.has(ev.dealId)) continue; // skip events for non-routed deals
    dealsWithAnyEvent.add(ev.dealId);
    if (ev.kind === "sent") sentDeals.add(ev.dealId);
    if (ev.kind === "replied") repliedDeals.add(ev.dealId);
    if (ev.kind === "meeting_booked") meetingDeals.add(ev.dealId);
  }

  const routedDealsWithEngagement = dealsWithAnyEvent.size;

  // ── Commercial signals ───────────────────────────────────────────────────
  const allSignals = store.commercialSignals();
  const oppCreatedDeals = new Set<string>();
  for (const sig of allSignals) {
    // kind is typed "opportunity_created" today; guard future-proofs against a new variant.
    if (sig.kind !== "opportunity_created") continue;
    if (!dealUsdById.has(sig.dealId)) continue;
    oppCreatedDeals.add(sig.dealId);
  }

  // ── Commercial states (authoritative) ────────────────────────────────────
  const commercialStateByDeal = new Map<string, CommercialState>();
  for (const deal of routedDeals) {
    const cs = store.commercialState(deal.id);
    if (cs !== null) {
      commercialStateByDeal.set(deal.id, cs.commercialState);
    }
  }

  // ── Tier USD sums ─────────────────────────────────────────────────────────
  let meetingsInfluencedUsd = 0;
  let commercialSignalsUsd = 0;
  let pipelineInfluencedUsd = 0;
  for (const dealId of meetingDeals) {
    meetingsInfluencedUsd += dealUsdById.get(dealId) ?? 0;
  }
  for (const dealId of oppCreatedDeals) {
    commercialSignalsUsd += dealUsdById.get(dealId) ?? 0;
  }
  for (const [dealId, state] of commercialStateByDeal) {
    if (PIPELINE_ACTIVE_STATES.has(state)) {
      pipelineInfluencedUsd += dealUsdById.get(dealId) ?? 0;
    }
  }

  // ── Rates (deal-grain, denominator 0 → null) ─────────────────────────────
  const sentCount = sentDeals.size;
  const repliedCount = repliedDeals.size;

  // Rates are intersections with the correct base, so they can never exceed 1,
  // and a meeting on a deal that never replied (or a reply with no recorded
  // send) does not distort the conversion. Denominator 0 → null.
  const intersectionSize = (a: Set<string>, b: Set<string>): number => {
    let n = 0;
    for (const id of a) if (b.has(id)) n += 1;
    return n;
  };
  const replyRate: number | null =
    sentCount === 0 ? null : intersectionSize(repliedDeals, sentDeals) / sentCount;
  const meetingRate: number | null =
    sentCount === 0 ? null : intersectionSize(meetingDeals, sentDeals) / sentCount;
  const replyToMeetingRate: number | null =
    repliedCount === 0
      ? null
      : intersectionSize(meetingDeals, repliedDeals) / repliedCount;

  // ── Win-rate by engagement path ───────────────────────────────────────────
  // Path precedence (deal-grain, single path per deal):
  //   met          → >=1 meeting_booked
  //   replied      → >=1 replied AND no meeting_booked
  //   no_engagement → no engagement events at all for this deal
  const pathCounters: Record<EngagementPath, { routed: number; closedWon: number }> = {
    met: { routed: 0, closedWon: 0 },
    replied: { routed: 0, closedWon: 0 },
    no_engagement: { routed: 0, closedWon: 0 },
  };

  for (const deal of routedDeals) {
    const path: EngagementPath = meetingDeals.has(deal.id)
      ? "met"
      : repliedDeals.has(deal.id)
        ? "replied"
        : "no_engagement";
    pathCounters[path].routed += 1;
    if (commercialStateByDeal.get(deal.id) === "closed_won") {
      pathCounters[path].closedWon += 1;
    }
  }

  const winRateByEngagementPath = (
    ["replied", "met", "no_engagement"] as const
  ).map((path) => {
    const { routed, closedWon } = pathCounters[path];
    return {
      path,
      routed,
      closedWon,
      winRate: routed === 0 ? null : closedWon / routed,
    };
  });

  // ── Hours saved (D9 — always modeled) ─────────────────────────────────────
  const agentDraftedTouchesSent = 0; // TODO(Plan B): sales touch_revisions.createdBy='drafter'
  const estimatedHours =
    Math.round(
      ((autoHandledDeals * ASSUMED_TRIAGE_MIN +
        agentDraftedTouchesSent * ASSUMED_DRAFT_MIN) /
        60) *
        100,
    ) / 100;

  // ── Coverage ──────────────────────────────────────────────────────────────
  const coverageComplete =
    routedDealsTotal === 0 ? true : store.lastEngagementFeedbackCoverageComplete();

  return {
    coverage: {
      complete: coverageComplete,
      routedDealsTotal,
      routedDealsWithEngagement,
    },
    tiers: {
      meetingsInfluencedUsd,
      commercialSignalsUsd,
      pipelineInfluencedUsd,
    },
    rates: {
      replyRate,
      meetingRate,
      replyToMeetingRate,
    },
    winRateByEngagementPath,
    hoursSaved: {
      autoHandledDeals,
      agentDraftedTouchesSent,
      assumedTriageMin: ASSUMED_TRIAGE_MIN,
      assumedDraftMin: ASSUMED_DRAFT_MIN,
      estimatedHours,
      modeled: true,
    },
  };
}
