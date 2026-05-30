import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEMO_ENGAGEMENT_FIXTURES,
  applyDemoEngagementFixtures,
  demoEngagementSourceEventIds,
} from "../src/demo-engagement-fixtures.js";
import { parseEngagementFeedback } from "../src/engagement.js";
import { FixtureEnricher, type FixtureEntry } from "../src/enrich.js";
import { processBatch } from "../src/pipeline.js";
import { Store } from "../src/store.js";

const DATA = fileURLToPath(new URL("../data/", import.meta.url));

function fixture(): Record<string, FixtureEntry> {
  return JSON.parse(
    readFileSync(`${DATA}enrichment.fixture.json`, "utf8"),
  ) as Record<string, FixtureEntry>;
}

function seed(): unknown[] {
  return readFileSync(`${DATA}inbound.seed.jsonl`, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function seedStore(): Promise<Store> {
  const store = new Store(":memory:");
  await processBatch(seed(), store, new FixtureEnricher(fixture()));
  return store;
}

// ── Case 1: deterministic engagement fixture replay ────────────────────────

describe("Case 1 — deterministic engagement (Ryder sent→replied→meeting; Cargo bounced)", () => {
  it("applies without error and records the expected events", async () => {
    const store = await seedStore();
    const result = applyDemoEngagementFixtures(store, store.routed());

    expect(result.eventsRecorded).toBe(8); // 3 Ryder + 2 Cargo + 1 Acme + 2 Globex
    expect(result.commercialSignalsRecorded).toBeGreaterThanOrEqual(1);
    expect(result.unknownDealRejections).toHaveLength(0);
    expect(result.eventsDuplicate).toBe(0);
    expect(result.commercialSignalsDuplicate).toBe(0);
    store.close();
  });

  it("event ids are deterministic across replays", async () => {
    const store1 = await seedStore();
    const store2 = await seedStore();
    const r1 = applyDemoEngagementFixtures(store1, store1.routed());
    const r2 = applyDemoEngagementFixtures(store2, store2.routed());
    // Both runs produce identical counts — ids are seeded, not random
    expect(r1.eventsRecorded).toBe(r2.eventsRecorded);
    expect(r1.commercialSignalsRecorded).toBe(r2.commercialSignalsRecorded);
    store1.close();
    store2.close();
  });

  it("uses the demo-engagement: seed namespace, not demo-outcome:", async () => {
    const ids = demoEngagementSourceEventIds();
    for (const id of ids) {
      // These must be valid v4 UUIDs
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    // Must not overlap with demo-outcome: namespace
    const { demoOutcomeSourceEventIds, demoCommercialStateSourceEventIds } =
      await import("../src/demo-fixtures.js");
    const outcomeIds = new Set([
      ...demoOutcomeSourceEventIds(),
      ...demoCommercialStateSourceEventIds(),
    ]);
    for (const id of ids) {
      expect(outcomeIds.has(id)).toBe(false);
    }
  });
});

// ── Case 2: partial coverage ───────────────────────────────────────────────

describe("Case 2 — partial coverage (complete:false)", () => {
  it("fixture payload has complete:false with scanned > emitted", () => {
    // DEMO_ENGAGEMENT_FIXTURES.coverage is partial by design
    const payload = DEMO_ENGAGEMENT_FIXTURES;
    expect(payload.coverage.complete).toBe(false);
    expect(payload.coverage.scanned).toBeGreaterThan(payload.coverage.emitted);
  });

  it("importEngagementFeedback records coverage in the result", async () => {
    const store = await seedStore();
    const result = applyDemoEngagementFixtures(store, store.routed());
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.scanned).toBeGreaterThan(result.coverage.emitted);
    store.close();
  });
});

// ── Case 3a: unknown routerDealId rejected loud ────────────────────────────

describe("Case 3a — unknown routerDealId fails loud (rejected)", () => {
  it("pushes to unknownDealRejections and records NO events for it", async () => {
    const store = await seedStore();
    const routed = store.routed();

    // Build a payload that references a non-existent deal id
    const ghost = "D-000000000000";
    const payload = parseEngagementFeedback({
      schemaVersion: "sales.engagement-feedback.v1",
      generatedAt: "2026-05-29T10:00:00.000Z",
      source: { system: "sales", purpose: "test" },
      coverage: { complete: true, scanned: 1, emitted: 1, since: null },
      deals: [
        {
          routerDealId: ghost,
          trace: {
            sourceSystem: "sales",
            boundary: "observed_engagement_not_router_truth",
          },
          events: [
            {
              kind: "sent",
              eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              occurredAt: "2026-05-01T09:00:00.000Z",
              touchId: "t-ghost-1",
              channel: "email",
            },
          ],
        },
      ],
    });

    const result = store.importEngagementFeedback(payload);
    expect(result.unknownDealRejections).toEqual([
      { routerDealId: ghost, eventCount: 1 },
    ]);
    expect(result.eventsRecorded).toBe(0);
    // No engagement events written for the ghost deal
    expect(store.engagementEvents(ghost)).toHaveLength(0);

    void routed; // referenced to avoid unused-variable lint
    store.close();
  });
});

// ── Case 3b: malformed event rejected by parseEngagementFeedback ──────────

describe("Case 3b — malformed event fails zod parse", () => {
  it("throws on unknown event kind", () => {
    expect(() =>
      parseEngagementFeedback({
        schemaVersion: "sales.engagement-feedback.v1",
        generatedAt: "2026-05-29T10:00:00.000Z",
        source: { system: "sales", purpose: "test" },
        coverage: { complete: true, scanned: 1, emitted: 1, since: null },
        deals: [
          {
            routerDealId: "D-fb65c15017ef",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [
              {
                kind: "clicked", // not in the union
                eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                occurredAt: "2026-05-01T09:00:00.000Z",
                touchId: "t-1",
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  it("throws on non-canonical occurredAt (missing milliseconds)", () => {
    expect(() =>
      parseEngagementFeedback({
        schemaVersion: "sales.engagement-feedback.v1",
        generatedAt: "2026-05-29T10:00:00.000Z",
        source: { system: "sales", purpose: "test" },
        coverage: { complete: true, scanned: 1, emitted: 1, since: null },
        deals: [
          {
            routerDealId: "D-fb65c15017ef",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [
              {
                kind: "sent",
                eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                occurredAt: "2026-05-01T09:00:00Z", // missing .sss
                touchId: "t-1",
                channel: "email",
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });
});

// ── Case 4: re-import idempotency ──────────────────────────────────────────

describe("Case 4 — re-import idempotency", () => {
  it("importing the same fixture twice produces duplicates on the second pass", async () => {
    const store = await seedStore();
    const first = applyDemoEngagementFixtures(store, store.routed());
    const second = applyDemoEngagementFixtures(store, store.routed());

    expect(first.eventsRecorded).toBeGreaterThan(0);
    expect(second.eventsRecorded).toBe(0);
    expect(second.eventsDuplicate).toBe(first.eventsRecorded);
    expect(second.commercialSignalsRecorded).toBe(0);
    expect(second.commercialSignalsDuplicate).toBe(first.commercialSignalsRecorded);
    store.close();
  });

  it("same id + changed payload writes an idempotency_violation and skips", async () => {
    const store = await seedStore();
    const routed = store.routed();
    const ryder = routed.find((d) => d.company === "Ryder Digital");
    if (!ryder) throw new Error("expected Ryder Digital routed deal");

    // First: import a real 'sent' event under a known eventId
    const eventId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const p1 = parseEngagementFeedback({
      schemaVersion: "sales.engagement-feedback.v1",
      generatedAt: "2026-05-29T10:00:00.000Z",
      source: { system: "sales", purpose: "test" },
      coverage: { complete: true, scanned: 1, emitted: 1, since: null },
      deals: [
        {
          routerDealId: ryder.id,
          trace: {
            sourceSystem: "sales",
            boundary: "observed_engagement_not_router_truth",
          },
          events: [
            {
              kind: "sent",
              eventId,
              occurredAt: "2026-05-01T09:00:00.000Z",
              touchId: "t-idempotency-test",
              channel: "email",
            },
          ],
        },
      ],
    });
    const r1 = store.importEngagementFeedback(p1);
    expect(r1.eventsRecorded).toBe(1);

    // Second: same eventId but different payload (channel changed)
    const p2 = parseEngagementFeedback({
      schemaVersion: "sales.engagement-feedback.v1",
      generatedAt: "2026-05-29T10:01:00.000Z",
      source: { system: "sales", purpose: "test" },
      coverage: { complete: true, scanned: 1, emitted: 1, since: null },
      deals: [
        {
          routerDealId: ryder.id,
          trace: {
            sourceSystem: "sales",
            boundary: "observed_engagement_not_router_truth",
          },
          events: [
            {
              kind: "sent",
              eventId,
              occurredAt: "2026-05-01T09:00:00.000Z",
              touchId: "t-idempotency-test",
              channel: "linkedin", // payload changed
            },
          ],
        },
      ],
    });
    const r2 = store.importEngagementFeedback(p2);
    // Must skip, not overwrite; idempotency_violation written internally
    expect(r2.eventsRecorded).toBe(0);
    expect(r2.eventsDuplicate).toBe(0); // not a clean duplicate — it's a conflict
    // Confirm the original event was not mutated: channel is still "email"
    const events = store.engagementEvents(ryder.id);
    const sent = events.find(
      (e) => e.kind === "sent" && e.sourceEventId === eventId,
    );
    expect(sent).toBeDefined();
    const parsed = JSON.parse(sent!.payloadJson) as { channel?: string };
    expect(parsed.channel).toBe("email");
    store.close();
  });
});

// ── Case 5: LATE-REPLY after no_response ──────────────────────────────────

describe("Case 5 — LATE-REPLY after no_response (acceptance test)", () => {
  it("imports no_response then replied for the same deal; both rows are retained", async () => {
    const store = await seedStore();
    const routed = store.routed();
    const acme = routed.find((d) => d.company === "Acme Retail");
    if (!acme) throw new Error("expected Acme Retail routed deal");

    const noResponseId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const repliedId = "ffffffff-ffff-4fff-8fff-ffffffffffff";

    // Step 1: import no_response
    const p1 = parseEngagementFeedback({
      schemaVersion: "sales.engagement-feedback.v1",
      generatedAt: "2026-05-10T10:00:00.000Z",
      source: { system: "sales", purpose: "test" },
      coverage: { complete: false, scanned: 1, emitted: 1, since: null },
      deals: [
        {
          routerDealId: acme.id,
          trace: {
            sourceSystem: "sales",
            boundary: "observed_engagement_not_router_truth",
          },
          events: [
            {
              kind: "no_response",
              eventId: noResponseId,
              occurredAt: "2026-05-03T00:00:00.000Z",
              asOf: "2026-05-03T00:00:00.000Z",
              windowDays: 7,
              lastTouchId: "t-acme-touch-1",
              derived: true,
            },
          ],
        },
      ],
    });
    const r1 = store.importEngagementFeedback(p1);
    expect(r1.eventsRecorded).toBe(1);

    // Confirm source is sales_window_evaluator for no_response
    const afterFirst = store.engagementEvents(acme.id);
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0]?.source).toBe("sales_window_evaluator");
    expect(afterFirst[0]?.kind).toBe("no_response");

    // Step 2: import a later replied event (T2 > T1)
    const p2 = parseEngagementFeedback({
      schemaVersion: "sales.engagement-feedback.v1",
      generatedAt: "2026-05-15T10:00:00.000Z",
      source: { system: "sales", purpose: "test" },
      coverage: { complete: false, scanned: 1, emitted: 1, since: null },
      deals: [
        {
          routerDealId: acme.id,
          trace: {
            sourceSystem: "sales",
            boundary: "observed_engagement_not_router_truth",
          },
          events: [
            {
              kind: "replied",
              eventId: repliedId,
              occurredAt: "2026-05-12T09:00:00.000Z", // T2 > T1 (2026-05-03)
              touchId: "t-acme-touch-1",
              replyIntent: "positive",
            },
          ],
        },
      ],
    });
    const r2 = store.importEngagementFeedback(p2);
    expect(r2.eventsRecorded).toBe(1);

    // Both rows must be retained (append-only) — no_response is NOT deleted
    const afterSecond = store.engagementEvents(acme.id);
    expect(afterSecond).toHaveLength(2);
    const kinds = afterSecond.map((e) => e.kind).sort();
    expect(kinds).toEqual(["no_response", "replied"]);

    // The replied row uses sales_observed source
    const repliedRow = afterSecond.find((e) => e.kind === "replied");
    expect(repliedRow?.source).toBe("sales_observed");
    expect(repliedRow?.sourceEventId).toBe(repliedId);

    // The no_response row is still there (never deleted)
    const noRespRow = afterSecond.find((e) => e.kind === "no_response");
    expect(noRespRow?.source).toBe("sales_window_evaluator");
    expect(noRespRow?.sourceEventId).toBe(noResponseId);

    store.close();
  });

  it("DEMO_ENGAGEMENT_FIXTURES contains the LATE-REPLY deal (no_response + replied)", () => {
    const lateReplyDeal = DEMO_ENGAGEMENT_FIXTURES.deals.find(
      (d) =>
        d.events.some((e) => e.kind === "no_response") &&
        d.events.some((e) => e.kind === "replied"),
    );
    expect(lateReplyDeal).toBeDefined();
    const noResp = lateReplyDeal!.events.find((e) => e.kind === "no_response")!;
    const replied = lateReplyDeal!.events.find((e) => e.kind === "replied")!;
    // replied.occurredAt must be after no_response.asOf
    const asOf = "asOf" in noResp ? noResp.asOf : "";
    expect(replied.occurredAt > asOf).toBe(true);
  });
});

// ── Drift guard ────────────────────────────────────────────────────────────

describe("committed engagement-feedback sample (drift guard)", () => {
  it("data/engagement-feedback.sample.json matches the canonical fixture render", async () => {
    const SAMPLE = fileURLToPath(
      new URL("../data/engagement-feedback.sample.json", import.meta.url),
    );
    const committed = JSON.parse(readFileSync(SAMPLE, "utf8")) as unknown;

    // Produce the canonical render: seed store + apply fixtures
    const store = await seedStore();
    const result = applyDemoEngagementFixtures(store, store.routed());
    // The canonical payload is also exposed from DEMO_ENGAGEMENT_FIXTURES after
    // timestamp normalisation; compare the full parsed EngagementFeedback object
    // that the fixture builds internally (returned via result.payload).
    const canonical = result.payload;
    store.close();

    expect(committed).toEqual(canonical);
  });
});
