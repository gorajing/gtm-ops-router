/**
 * Deterministic demo engagement fixtures for the GTM loop measurement plane.
 *
 * Design rules (mirrors src/demo-fixtures.ts):
 *   - Seed namespace "demo-engagement:{routerDealId}:{key}" is isolated from
 *     "demo-outcome:{...}" to prevent guard-classification blur.
 *   - All timestamps are frozen canonical-UTC literals (no clock dependency).
 *   - applyDemoEngagementFixtures calls the real importEngagementFeedback; it
 *     NEVER writes directly to store internals (D11).
 */

import { createHash } from "node:crypto";
import type { EngagementFeedback } from "./engagement.js";
import type { EngagementImportResult } from "./types.js";
import type { Store } from "./store.js";
import type { RoutedDeal } from "./types.js";

// ── Deterministic id helper (own namespace) ────────────────────────────────

function uuidV4FromSeed(seed: string): string {
  // Deterministic by design: the fixture layer must be replayable and
  // idempotent. Do NOT reuse this helper with the demo-outcome: prefix —
  // namespace isolation is the classification invariant.
  const chars = createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "4";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function demoEngagementEventId(dealId: string, key: string): string {
  // Namespace: "demo-engagement:{dealId}:{key}"
  // Never use the demo-outcome: prefix here.
  return uuidV4FromSeed(`demo-engagement:${dealId}:${key}`);
}

// ── Canonical fixture deals ────────────────────────────────────────────────

type DemoEngagementDealSpec = {
  company: string;
  /** Stable id guarded by pipeline.test.ts seed-id fixture test. */
  dealId: string;
  events: Array<
    | {
        key: string;
        kind: "sent";
        occurredAt: string;
        touchId: string;
        channel: "email" | "linkedin";
      }
    | {
        key: string;
        kind: "replied";
        occurredAt: string;
        touchId: string;
        replyIntent: "positive" | "neutral" | "negative";
      }
    | {
        key: string;
        kind: "meeting_booked";
        occurredAt: string;
        touchId: string;
        meetingAt: string;
      }
    | {
        key: string;
        kind: "bounced";
        occurredAt: string;
        touchId: string;
        reason: string;
      }
    | {
        key: string;
        kind: "no_response";
        occurredAt: string;
        asOf: string;
        windowDays: number;
        lastTouchId: string;
      }
  >;
  commercialSignals?: Array<{
    key: string;
    kind: "opportunity_created";
    occurredAt: string;
    amountUsd: number | null;
    crmRef: string | null;
  }>;
};

const DEMO_ENGAGEMENT_DEAL_SPECS: DemoEngagementDealSpec[] = [
  {
    // Case 1a: full positive funnel (sent → replied(positive) → meeting_booked)
    company: "Ryder Digital",
    dealId: "D-fb65c15017ef",
    events: [
      {
        key: "sent-1",
        kind: "sent",
        occurredAt: "2026-05-01T09:00:00.000Z",
        touchId: "ryder-touch-1",
        channel: "email",
      },
      {
        key: "replied-1",
        kind: "replied",
        occurredAt: "2026-05-02T14:30:00.000Z",
        touchId: "ryder-touch-1",
        replyIntent: "positive",
      },
      {
        key: "meeting_booked-1",
        kind: "meeting_booked",
        occurredAt: "2026-05-03T10:00:00.000Z",
        touchId: "ryder-touch-1",
        meetingAt: "2026-05-06T15:00:00.000Z",
      },
    ],
    commercialSignals: [
      {
        key: "opp-created-1",
        kind: "opportunity_created",
        occurredAt: "2026-05-06T16:00:00.000Z",
        amountUsd: 120000,
        crmRef: "HUB-RYDER-001",
      },
    ],
  },
  {
    // Case 1b: bounced outreach
    company: "Cargo Loop",
    dealId: "D-cdea8ac45022",
    events: [
      {
        key: "sent-1",
        kind: "sent",
        occurredAt: "2026-05-01T09:15:00.000Z",
        touchId: "cargo-touch-1",
        channel: "linkedin",
      },
      {
        key: "bounced-1",
        kind: "bounced",
        occurredAt: "2026-05-01T09:16:00.000Z",
        touchId: "cargo-touch-1",
        reason: "mailbox_full",
      },
    ],
  },
  {
    // Case 2 + partial coverage: no_response only (window evaluator verdict)
    company: "Acme Retail",
    dealId: "D-8eb789ad84fc",
    events: [
      {
        key: "no_response-1",
        kind: "no_response",
        occurredAt: "2026-05-08T00:00:00.000Z",
        asOf: "2026-05-08T00:00:00.000Z",
        windowDays: 7,
        lastTouchId: "acme-touch-1",
      },
    ],
  },
  {
    // Case 5 (⭐ acceptance): LATE-REPLY — no_response(T1) then replied(T2>T1)
    company: "Globex Foods",
    dealId: "D-a2ff6592e43f",
    events: [
      {
        key: "no_response-1",
        kind: "no_response",
        occurredAt: "2026-05-05T00:00:00.000Z",
        asOf: "2026-05-05T00:00:00.000Z",
        windowDays: 7,
        lastTouchId: "mystery-touch-1",
      },
      {
        key: "replied-late",
        kind: "replied",
        occurredAt: "2026-05-14T11:00:00.000Z", // T2 > T1 (2026-05-05)
        touchId: "mystery-touch-1",
        replyIntent: "neutral",
      },
    ],
  },
];

// ── Public fixture payload ─────────────────────────────────────────────────

// coverage.complete = false: Acme and Globex have no_response verdicts only
// (sales scanned more deals than it emitted full-funnel data for).
export const DEMO_ENGAGEMENT_FIXTURES: {
  schemaVersion: "sales.engagement-feedback.v1";
  generatedAt: string;
  source: { system: "sales"; purpose: string };
  coverage: { complete: boolean; scanned: number; emitted: number; since: string | null };
  deals: EngagementFeedback["deals"];
} = buildDemoEngagementFixtures();

function buildDemoEngagementFixtures(): typeof DEMO_ENGAGEMENT_FIXTURES {
  const deals: EngagementFeedback["deals"] = DEMO_ENGAGEMENT_DEAL_SPECS.map(
    (spec) => {
      const routerDealId = spec.dealId;

      const events: EngagementFeedback["deals"][number]["events"] = spec.events.map(
        (ev) => {
          const eventId = demoEngagementEventId(routerDealId, ev.key);
          if (ev.kind === "sent") {
            return {
              kind: "sent" as const,
              eventId,
              occurredAt: ev.occurredAt,
              touchId: ev.touchId,
              channel: ev.channel,
            };
          }
          if (ev.kind === "replied") {
            return {
              kind: "replied" as const,
              eventId,
              occurredAt: ev.occurredAt,
              touchId: ev.touchId,
              replyIntent: ev.replyIntent,
            };
          }
          if (ev.kind === "meeting_booked") {
            return {
              kind: "meeting_booked" as const,
              eventId,
              occurredAt: ev.occurredAt,
              touchId: ev.touchId,
              meetingAt: ev.meetingAt,
            };
          }
          if (ev.kind === "bounced") {
            return {
              kind: "bounced" as const,
              eventId,
              occurredAt: ev.occurredAt,
              touchId: ev.touchId,
              reason: ev.reason,
            };
          }
          if (ev.kind === "no_response") {
            return {
              kind: "no_response" as const,
              eventId,
              occurredAt: ev.occurredAt,
              asOf: ev.asOf,
              windowDays: ev.windowDays,
              lastTouchId: ev.lastTouchId,
              derived: true as const,
            };
          }
          const exhaustive: never = ev;
          throw new Error(
            `unhandled demo engagement event kind: ${String(exhaustive)}`,
          );
        },
      );

      const commercialSignals: EngagementFeedback["deals"][number]["commercialSignals"] =
        spec.commercialSignals?.map((sig) => ({
          kind: "opportunity_created" as const,
          eventId: demoEngagementEventId(routerDealId, sig.key),
          occurredAt: sig.occurredAt,
          amountUsd: sig.amountUsd,
          crmRef: sig.crmRef,
        }));

      return {
        routerDealId,
        trace: {
          sourceSystem: "sales" as const,
          boundary: "observed_engagement_not_router_truth" as const,
        },
        events,
        ...(commercialSignals !== undefined ? { commercialSignals } : {}),
      };
    },
  );

  return {
    schemaVersion: "sales.engagement-feedback.v1",
    generatedAt: "2026-05-29T07:00:00.000Z",
    source: {
      system: "sales",
      purpose:
        "Demo engagement overlay: observed front-funnel engagement for router measurement.",
    },
    coverage: {
      complete: false,
      scanned: 9, // full seed corpus of routed deals
      emitted: DEMO_ENGAGEMENT_DEAL_SPECS.length, // deals with engagement data in the demo
      since: null,
    },
    deals,
  };
}

// ── Result type ────────────────────────────────────────────────────────────

export interface DemoEngagementResult extends EngagementImportResult {
  /** The final EngagementFeedback payload that was built and imported. */
  payload: EngagementFeedback;
  /** Fixture deal ids not present in the live routed set (skipped). */
  skippedDealIds: string[];
}

// ── Apply function ─────────────────────────────────────────────────────────

export function applyDemoEngagementFixtures(
  store: Store,
  routedDeals: readonly RoutedDeal[],
): DemoEngagementResult {
  // Fixture deal ids are concrete real routed ids; import only the specs
  // whose id is actually routed in the live DB (works with any seed subset).
  const routedIds = new Set(routedDeals.map((d) => d.id));

  const skippedDealIds: string[] = [];
  const resolvedDeals: EngagementFeedback["deals"] = [];

  for (const deal of DEMO_ENGAGEMENT_FIXTURES.deals) {
    if (!routedIds.has(deal.routerDealId)) {
      skippedDealIds.push(deal.routerDealId);
      continue;
    }
    resolvedDeals.push(deal);
  }

  // Emit deals in the real producer's deterministic order (ascending by
  // routerDealId), matching the sales repo's buildEngagementFeedback. This is
  // what lets the live sales producer reproduce this sample byte-for-byte —
  // the demo overlay must look exactly like real engagement feedback.
  resolvedDeals.sort((a, b) =>
    a.routerDealId < b.routerDealId ? -1 : a.routerDealId > b.routerDealId ? 1 : 0,
  );

  const payload: EngagementFeedback = {
    schemaVersion: DEMO_ENGAGEMENT_FIXTURES.schemaVersion,
    generatedAt: DEMO_ENGAGEMENT_FIXTURES.generatedAt,
    source: DEMO_ENGAGEMENT_FIXTURES.source,
    coverage: DEMO_ENGAGEMENT_FIXTURES.coverage,
    deals: resolvedDeals,
  };

  const importResult = store.importEngagementFeedback(payload);

  return {
    ...importResult,
    payload,
    skippedDealIds,
  };
}

// ── Guard helpers ──────────────────────────────────────────────────────────

export function demoEngagementFixtureDealIds(): string[] {
  // Every routed deal the demo engagement fixture covers — mirrors
  // demoOutcomeFixtureDealIds(); Task 7's --demo-engagement guard uses it.
  return DEMO_ENGAGEMENT_DEAL_SPECS.map((spec) => spec.dealId);
}

export function demoEngagementSourceEventIds(): string[] {
  // Every deterministic event/signal id the demo fixture produces. All deal
  // ids are concrete real routed ids, so the guard (Task 7's
  // nonDemoEngagementEventCount) enumerates across ALL fixture deals.
  return DEMO_ENGAGEMENT_DEAL_SPECS.flatMap((spec) => {
    const eventIds = spec.events.map((ev) =>
      demoEngagementEventId(spec.dealId, ev.key),
    );
    const signalIds = (spec.commercialSignals ?? []).map((sig) =>
      demoEngagementEventId(spec.dealId, sig.key),
    );
    return [...eventIds, ...signalIds];
  });
}
