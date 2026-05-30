import { describe, expect, it } from "vitest";
import { ASSUMED_TRIAGE_MIN, ASSUMED_DRAFT_MIN } from "../src/constants.js";
import {
  computeEngagementAttribution,
  type AttributionStore,
  type EngagementEventRecord,
  type CommercialSignalRecord,
} from "../src/attribution.js";
import { Store } from "../src/store.js";
import type { CommercialStateRecord, RoutedDeal } from "../src/types.js";

// ── helpers ────────────────────────────────────────────────────────────────

function baseRoutedDeal(
  id: string,
  overrides: Partial<RoutedDeal> = {},
): RoutedDeal {
  return {
    id,
    company: `Company-${id}`,
    domain: null,
    contactName: "Test User",
    contactEmail: "test@example.invalid",
    dealUSD: 10_000,
    region: "NA",
    sourceChannel: "inbound_form",
    statedNeed: "test",
    enrichment: {
      employees: 100,
      industry: "tech",
      techSignals: [],
      regulated: false,
      confidence: 0.9,
    },
    score: {
      icpFit: 0.8,
      painSignal: 0.8,
      sizeFit: 0.8,
      regionFit: 0.8,
      total: 0.8,
      notes: [],
    },
    route: {
      kind: "human_assisted",
      salesOwner: "ae.test",
      financeFlag: null,
      legalFlag: null,
      slaHours: 4,
    },
    ...overrides,
  };
}

/**
 * In-memory stub satisfying AttributionStore.
 * Lets Task 4 tests run without Tasks 2 & 3 being implemented on Store.
 * Uses the real Store for routed()/commercialState(); stubs the engagement
 * tables that don't exist yet.
 */
class StubAttributionStore implements AttributionStore {
  private inner: Store;
  private _events: EngagementEventRecord[];
  private _signals: CommercialSignalRecord[];
  private _coverageComplete: boolean;

  constructor(
    inner: Store,
    events: EngagementEventRecord[] = [],
    signals: CommercialSignalRecord[] = [],
    coverageComplete = false,
  ) {
    this.inner = inner;
    this._events = events;
    this._signals = signals;
    this._coverageComplete = coverageComplete;
  }

  routed(limit?: number): RoutedDeal[] {
    return this.inner.routed(limit);
  }

  commercialState(dealId: string): CommercialStateRecord | null {
    return this.inner.commercialState(dealId);
  }

  engagementEvents(dealId?: string): EngagementEventRecord[] {
    if (dealId === undefined) return this._events;
    return this._events.filter((e) => e.dealId === dealId);
  }

  commercialSignals(dealId?: string): CommercialSignalRecord[] {
    if (dealId === undefined) return this._signals;
    return this._signals.filter((s) => s.dealId === dealId);
  }

  lastEngagementFeedbackCoverageComplete(): boolean {
    return this._coverageComplete;
  }
}

function engEvent(
  dealId: string,
  kind: EngagementEventRecord["kind"],
  seq: number,
): EngagementEventRecord {
  return {
    id: `ev-${dealId}-${kind}-${seq}`,
    dealId,
    source: "sales_observed",
    sourceEventId: `src-${dealId}-${kind}-${seq}`,
    sourcePayloadHash: "abc123",
    kind,
    occurredAt: `2026-05-${String(10 + seq).padStart(2, "0")}T12:00:00.000Z`,
    payloadJson: "{}",
    createdAt: "2026-05-29T00:00:00.000Z",
  };
}

function sigEvent(dealId: string, seq: number): CommercialSignalRecord {
  return {
    id: `sig-${dealId}-${seq}`,
    dealId,
    source: "sales_reported",
    sourceEventId: `sigsrc-${dealId}-${seq}`,
    sourcePayloadHash: "def456",
    kind: "opportunity_created",
    occurredAt: `2026-05-${String(10 + seq).padStart(2, "0")}T12:00:00.000Z`,
    amountUsd: null,
    crmRef: null,
    createdAt: "2026-05-29T00:00:00.000Z",
  };
}

function makeInnerStore(...deals: RoutedDeal[]): Store {
  const store = new Store(":memory:");
  for (const deal of deals) {
    store.recordRouted(deal, 0, { mode: "dry_run", status: "dry_run" });
  }
  return store;
}

// ── constants ──────────────────────────────────────────────────────────────

describe("constants", () => {
  it("ASSUMED_TRIAGE_MIN equals 8", () => {
    expect(ASSUMED_TRIAGE_MIN).toBe(8);
  });

  it("ASSUMED_DRAFT_MIN equals 20", () => {
    expect(ASSUMED_DRAFT_MIN).toBe(20);
  });
});

// ── empty store ────────────────────────────────────────────────────────────

describe("computeEngagementAttribution — empty store", () => {
  it("returns zero routed deals and null rates when no deals exist", () => {
    const store = new StubAttributionStore(new Store(":memory:"));
    const attr = computeEngagementAttribution(store);

    expect(attr.coverage.routedDealsTotal).toBe(0);
    expect(attr.coverage.routedDealsWithEngagement).toBe(0);
    expect(attr.rates.replyRate).toBeNull();
    expect(attr.rates.meetingRate).toBeNull();
    expect(attr.rates.replyToMeetingRate).toBeNull();
  });

  it("all three tier USD values are 0 when no data", () => {
    const store = new StubAttributionStore(new Store(":memory:"));
    const attr = computeEngagementAttribution(store);

    expect(attr.tiers.meetingsInfluencedUsd).toBe(0);
    expect(attr.tiers.commercialSignalsUsd).toBe(0);
    expect(attr.tiers.pipelineInfluencedUsd).toBe(0);
  });

  it("winRateByEngagementPath has all three paths with null winRate", () => {
    const store = new StubAttributionStore(new Store(":memory:"));
    const attr = computeEngagementAttribution(store);

    const paths = attr.winRateByEngagementPath.map((r) => r.path);
    expect(paths).toContain("replied");
    expect(paths).toContain("met");
    expect(paths).toContain("no_engagement");

    for (const row of attr.winRateByEngagementPath) {
      expect(row.winRate).toBeNull();
      expect(row.routed).toBe(0);
      expect(row.closedWon).toBe(0);
    }
  });

  it("hoursSaved: modeled is true, agentDraftedTouchesSent is 0, estimatedHours is 0", () => {
    const store = new StubAttributionStore(new Store(":memory:"));
    const attr = computeEngagementAttribution(store);

    expect(attr.hoursSaved.modeled).toBe(true);
    expect(attr.hoursSaved.agentDraftedTouchesSent).toBe(0);
    expect(attr.hoursSaved.assumedTriageMin).toBe(ASSUMED_TRIAGE_MIN);
    expect(attr.hoursSaved.assumedDraftMin).toBe(ASSUMED_DRAFT_MIN);
    expect(attr.hoursSaved.estimatedHours).toBe(0);
  });

  it("coverage.complete is true when no routed deals exist", () => {
    const store = new StubAttributionStore(new Store(":memory:"));
    const attr = computeEngagementAttribution(store);
    expect(attr.coverage.complete).toBe(true);
  });
});

// ── nullable-rate edge cases ───────────────────────────────────────────────

describe("computeEngagementAttribution — nullable rates", () => {
  it("replyRate is null when no sent events exist (deals present but no events)", () => {
    const deal = baseRoutedDeal("D-1");
    const inner = makeInnerStore(deal);
    const store = new StubAttributionStore(inner, [], [], false);
    const attr = computeEngagementAttribution(store);

    expect(attr.rates.replyRate).toBeNull();
    expect(attr.rates.meetingRate).toBeNull();
    expect(attr.rates.replyToMeetingRate).toBeNull();
  });

  it("replyToMeetingRate is null when deals replied but none met", () => {
    const deal = baseRoutedDeal("D-1");
    const inner = makeInnerStore(deal);
    const events = [
      engEvent("D-1", "sent", 1),
      // no meeting_booked
    ];
    const store = new StubAttributionStore(inner, events, [], false);
    const attr = computeEngagementAttribution(store);

    expect(attr.rates.replyRate).toBe(0);    // sent=1, replied=0 → 0/1
    expect(attr.rates.meetingRate).toBe(0);  // sent=1, meeting=0 → 0/1
    expect(attr.rates.replyToMeetingRate).toBeNull(); // no replied → null denom
  });

  it("replyToMeetingRate uses the replied∩met intersection — a meeting without a reply does not count", () => {
    const d1 = baseRoutedDeal("D-1");
    const d2 = baseRoutedDeal("D-2");
    const inner = makeInnerStore(d1, d2);
    const events = [
      engEvent("D-1", "sent", 1),
      engEvent("D-1", "replied", 2), // D-1 replied, did NOT meet
      engEvent("D-2", "sent", 1),
      engEvent("D-2", "meeting_booked", 3), // D-2 met WITHOUT replying
    ];
    const store = new StubAttributionStore(inner, events, [], false);
    const attr = computeEngagementAttribution(store);

    // Of the 1 deal that replied (D-1), 0 booked a meeting → 0, NOT 1.
    expect(attr.rates.replyToMeetingRate).toBe(0);
    expect(attr.rates.replyRate).toBe(0.5); // 1 replied of 2 sent
    expect(attr.rates.meetingRate).toBe(0.5); // 1 met of 2 sent
  });

  it("replyRate cannot exceed 1 even when a reply lands on a deal with no sent event", () => {
    const d1 = baseRoutedDeal("D-1");
    const d3 = baseRoutedDeal("D-3");
    const inner = makeInnerStore(d1, d3);
    const events = [
      engEvent("D-1", "sent", 1),
      engEvent("D-1", "replied", 2),
      engEvent("D-3", "replied", 2), // D-3 replied but was never "sent"
    ];
    const store = new StubAttributionStore(inner, events, [], false);
    const attr = computeEngagementAttribution(store);

    // sent = {D-1}; replied∩sent = {D-1} → 1/1 = 1, never 2/1.
    expect(attr.rates.replyRate).toBe(1);
  });

  it("replyToMeetingRate is non-null when there are replied deals", () => {
    const deal = baseRoutedDeal("D-1");
    const inner = makeInnerStore(deal);
    const events = [
      engEvent("D-1", "sent", 1),
      engEvent("D-1", "replied", 2),
      engEvent("D-1", "meeting_booked", 3),
    ];
    const store = new StubAttributionStore(inner, events, [], false);
    const attr = computeEngagementAttribution(store);

    expect(attr.rates.replyRate).toBe(1);          // 1/1
    expect(attr.rates.meetingRate).toBe(1);         // 1/1
    expect(attr.rates.replyToMeetingRate).toBe(1);  // 1/1
  });

  it("partial: 2 sent, 1 replied, 0 meeting", () => {
    const d1 = baseRoutedDeal("D-1");
    const d2 = baseRoutedDeal("D-2");
    const inner = makeInnerStore(d1, d2);
    const events = [
      engEvent("D-1", "sent", 1),
      engEvent("D-1", "replied", 2),
      engEvent("D-2", "sent", 1),
      // D-2 no reply, no meeting
    ];
    const store = new StubAttributionStore(inner, events, [], false);
    const attr = computeEngagementAttribution(store);

    expect(attr.rates.replyRate).toBe(0.5);         // 1 replied / 2 sent
    expect(attr.rates.meetingRate).toBe(0);         // 0 meetings / 2 sent
    expect(attr.rates.replyToMeetingRate).toBe(0);  // 0 meetings / 1 replied
  });
});

// ── coverage-incomplete ───────────────────────────────────────────────────

describe("computeEngagementAttribution — coverage incomplete", () => {
  it("coverage.complete mirrors lastEngagementFeedbackCoverageComplete() when deals exist", () => {
    const deal = baseRoutedDeal("D-1");
    const inner = makeInnerStore(deal);

    const storeIncomplete = new StubAttributionStore(inner, [], [], false);
    expect(computeEngagementAttribution(storeIncomplete).coverage.complete).toBe(false);

    const storeComplete = new StubAttributionStore(inner, [], [], true);
    expect(computeEngagementAttribution(storeComplete).coverage.complete).toBe(true);
  });
});

// ── no-engagement is not negative ────────────────────────────────────────

describe("computeEngagementAttribution — no-engagement is not negative", () => {
  it("a deal with no events is bucketed into no_engagement, not counted as a negative signal", () => {
    const d1 = baseRoutedDeal("D-1", { dealUSD: 50_000 });
    const d2 = baseRoutedDeal("D-2", { dealUSD: 30_000 });
    const inner = makeInnerStore(d1, d2);
    // D-1 has events, D-2 has none
    const events = [
      engEvent("D-1", "sent", 1),
      engEvent("D-1", "replied", 2),
    ];
    const store = new StubAttributionStore(inner, events, [], false);
    const attr = computeEngagementAttribution(store);

    const noEngRow = attr.winRateByEngagementPath.find((r) => r.path === "no_engagement");
    expect(noEngRow).toBeDefined();
    expect(noEngRow!.routed).toBe(1); // D-2 is bucketed here
    expect(noEngRow!.closedWon).toBe(0);
    expect(noEngRow!.winRate).toBe(0); // routed=1, closedWon=0 → 0/1=0, NOT null
  });

  it("no_engagement winRate is null only when no deal falls in that bucket", () => {
    const d1 = baseRoutedDeal("D-1");
    const inner = makeInnerStore(d1);
    const events = [
      engEvent("D-1", "sent", 1),
      engEvent("D-1", "replied", 2),
      engEvent("D-1", "meeting_booked", 3),
    ];
    const store = new StubAttributionStore(inner, events, [], false);
    const attr = computeEngagementAttribution(store);

    const noEngRow = attr.winRateByEngagementPath.find((r) => r.path === "no_engagement");
    expect(noEngRow!.routed).toBe(0);
    expect(noEngRow!.winRate).toBeNull(); // denominator 0 → null
  });
});

// ── tier USD calculations ─────────────────────────────────────────────────

describe("computeEngagementAttribution — tier USD", () => {
  it("meetingsInfluencedUsd sums dealUSD for deals with meeting_booked events", () => {
    const d1 = baseRoutedDeal("D-1", { dealUSD: 20_000 });
    const d2 = baseRoutedDeal("D-2", { dealUSD: 15_000 });
    const d3 = baseRoutedDeal("D-3", { dealUSD: 5_000 });
    const inner = makeInnerStore(d1, d2, d3);
    const events = [
      engEvent("D-1", "sent", 1),
      engEvent("D-1", "meeting_booked", 2),
      engEvent("D-2", "sent", 1), // no meeting
      engEvent("D-3", "meeting_booked", 1),
    ];
    const store = new StubAttributionStore(inner, events, [], false);
    const attr = computeEngagementAttribution(store);

    expect(attr.tiers.meetingsInfluencedUsd).toBe(25_000); // D-1 + D-3
  });

  it("commercialSignalsUsd sums dealUSD for deals with opportunity_created signals", () => {
    const d1 = baseRoutedDeal("D-1", { dealUSD: 20_000 });
    const d2 = baseRoutedDeal("D-2", { dealUSD: 15_000 });
    const inner = makeInnerStore(d1, d2);
    const signals = [sigEvent("D-1", 1)];
    const store = new StubAttributionStore(inner, [], signals, false);
    const attr = computeEngagementAttribution(store);

    expect(attr.tiers.commercialSignalsUsd).toBe(20_000);
  });

  it("pipelineInfluencedUsd sums dealUSD for deals in active commercial_state", () => {
    const d1 = baseRoutedDeal("D-1", { dealUSD: 40_000 });
    const d2 = baseRoutedDeal("D-2", { dealUSD: 25_000 });
    const d3 = baseRoutedDeal("D-3", { dealUSD: 10_000 });
    const inner = makeInnerStore(d1, d2, d3);
    // D-1 → open (active), D-2 → closed_won (terminal), D-3 → no commercial state
    inner.recordLocalCommercialState({
      dealId: "D-1",
      commercialState: "open",
      sourceEventId: "00000000-0000-4000-8000-000000000001",
      occurredAt: "2026-05-20T10:00:00.000Z",
      reason: null,
      expectedRedPath: false,
    });
    inner.recordLocalCommercialState({
      dealId: "D-2",
      commercialState: "closed_won",
      sourceEventId: "00000000-0000-4000-8000-000000000002",
      occurredAt: "2026-05-20T10:00:00.000Z",
      reason: null,
      expectedRedPath: false,
    });
    const store = new StubAttributionStore(inner, [], [], false);
    const attr = computeEngagementAttribution(store);

    expect(attr.tiers.pipelineInfluencedUsd).toBe(40_000); // D-1 only
  });

  it("pipelineInfluencedUsd excludes closed_lost (terminal)", () => {
    const d1 = baseRoutedDeal("D-1", { dealUSD: 30_000 });
    const inner = makeInnerStore(d1);
    inner.recordLocalCommercialState({
      dealId: "D-1",
      commercialState: "closed_lost",
      sourceEventId: "00000000-0000-4000-8000-000000000003",
      occurredAt: "2026-05-20T10:00:00.000Z",
      reason: null,
      expectedRedPath: false,
    });
    const store = new StubAttributionStore(inner, [], [], false);
    const attr = computeEngagementAttribution(store);

    expect(attr.tiers.pipelineInfluencedUsd).toBe(0);
  });
});

// ── win-rate by engagement path ───────────────────────────────────────────

describe("computeEngagementAttribution — winRateByEngagementPath", () => {
  it("met path closedWon is counted when commercial_state=closed_won", () => {
    const d1 = baseRoutedDeal("D-1", { dealUSD: 10_000 });
    const inner = makeInnerStore(d1);
    inner.recordLocalCommercialState({
      dealId: "D-1",
      commercialState: "closed_won",
      sourceEventId: "00000000-0000-4000-8000-000000000004",
      occurredAt: "2026-05-20T10:00:00.000Z",
      reason: null,
      expectedRedPath: false,
    });
    const events = [
      engEvent("D-1", "sent", 1),
      engEvent("D-1", "meeting_booked", 2),
    ];
    const store = new StubAttributionStore(inner, events, [], false);
    const attr = computeEngagementAttribution(store);

    const metRow = attr.winRateByEngagementPath.find((r) => r.path === "met");
    expect(metRow!.routed).toBe(1);
    expect(metRow!.closedWon).toBe(1);
    expect(metRow!.winRate).toBe(1);
  });

  it("replied (no meeting) path is distinct from met", () => {
    const d1 = baseRoutedDeal("D-1", { dealUSD: 10_000 });
    const d2 = baseRoutedDeal("D-2", { dealUSD: 10_000 });
    const inner = makeInnerStore(d1, d2);
    inner.recordLocalCommercialState({
      dealId: "D-1",
      commercialState: "closed_won",
      sourceEventId: "00000000-0000-4000-8000-000000000005",
      occurredAt: "2026-05-20T10:00:00.000Z",
      reason: null,
      expectedRedPath: false,
    });
    inner.recordLocalCommercialState({
      dealId: "D-2",
      commercialState: "closed_won",
      sourceEventId: "00000000-0000-4000-8000-000000000006",
      occurredAt: "2026-05-20T10:00:00.000Z",
      reason: null,
      expectedRedPath: false,
    });
    const events = [
      // D-1: sent + replied (no meeting) → "replied" path
      engEvent("D-1", "sent", 1),
      engEvent("D-1", "replied", 2),
      // D-2: sent + replied + meeting → "met" path
      engEvent("D-2", "sent", 1),
      engEvent("D-2", "replied", 2),
      engEvent("D-2", "meeting_booked", 3),
    ];
    const store = new StubAttributionStore(inner, events, [], false);
    const attr = computeEngagementAttribution(store);

    const repliedRow = attr.winRateByEngagementPath.find((r) => r.path === "replied");
    const metRow = attr.winRateByEngagementPath.find((r) => r.path === "met");
    expect(repliedRow!.routed).toBe(1);
    expect(repliedRow!.closedWon).toBe(1);
    expect(metRow!.routed).toBe(1);
    expect(metRow!.closedWon).toBe(1);
  });
});

// ── hours saved ───────────────────────────────────────────────────────────

describe("computeEngagementAttribution — hoursSaved", () => {
  it("estimatedHours is computed from autoHandledDeals * ASSUMED_TRIAGE_MIN / 60", () => {
    // 3 nurture/self_serve deals → 3 * 8 / 60 = 0.4 hours
    const d1 = baseRoutedDeal("D-1", {
      route: { kind: "nurture", reason: "low score" },
    });
    const d2 = baseRoutedDeal("D-2", {
      route: { kind: "nurture", reason: "low score" },
    });
    const d3 = baseRoutedDeal("D-3", {
      route: { kind: "self_serve", queue: "sales_self_serve", slaHours: 2 },
    });
    const inner = makeInnerStore(d1, d2, d3);
    const store = new StubAttributionStore(inner, [], [], false);
    const attr = computeEngagementAttribution(store);

    expect(attr.hoursSaved.autoHandledDeals).toBe(3);
    expect(attr.hoursSaved.estimatedHours).toBe(
      Math.round((3 * ASSUMED_TRIAGE_MIN / 60) * 100) / 100,
    );
  });

  it("human_assisted deals do not count as auto-handled", () => {
    const d1 = baseRoutedDeal("D-1"); // human_assisted (default)
    const inner = makeInnerStore(d1);
    const store = new StubAttributionStore(inner, [], [], false);
    const attr = computeEngagementAttribution(store);

    expect(attr.hoursSaved.autoHandledDeals).toBe(0);
    expect(attr.hoursSaved.estimatedHours).toBe(0);
  });
});

// ── engagement events on unknown deals are silently ignored ───────────────

describe("computeEngagementAttribution — non-routed deal events are ignored", () => {
  it("engagement events for a deal not in routed() do not affect rates", () => {
    const d1 = baseRoutedDeal("D-1");
    const inner = makeInnerStore(d1);
    // D-UNKNOWN is not a routed deal
    const events = [
      engEvent("D-UNKNOWN", "sent", 1),
      engEvent("D-UNKNOWN", "replied", 2),
      engEvent("D-UNKNOWN", "meeting_booked", 3),
      engEvent("D-1", "sent", 1),
    ];
    const store = new StubAttributionStore(inner, events, [], false);
    const attr = computeEngagementAttribution(store);

    // Only D-1 counts; D-UNKNOWN is filtered
    expect(attr.rates.replyRate).toBe(0);    // 0 replied / 1 sent
    expect(attr.rates.meetingRate).toBe(0);  // 0 meetings / 1 sent
    expect(attr.tiers.meetingsInfluencedUsd).toBe(0);
  });
});
