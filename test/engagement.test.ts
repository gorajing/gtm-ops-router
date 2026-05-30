import { describe, expect, it } from "vitest";
import {
  ENGAGEMENT_FEEDBACK_SCHEMA_VERSION,
  parseEngagementFeedback,
} from "../src/engagement.js";

// Minimal valid payload used across multiple tests.
const VALID_SENT_EVENT = {
  kind: "sent",
  eventId: "11111111-1111-4111-8111-111111111111",
  occurredAt: "2026-05-01T09:00:00.000Z",
  touchId: "T-001",
  channel: "email",
};

const VALID_REPLIED_EVENT = {
  kind: "replied",
  eventId: "22222222-2222-4222-8222-222222222222",
  occurredAt: "2026-05-02T10:00:00.000Z",
  touchId: "T-001",
  replyIntent: "positive",
};

const VALID_MEETING_EVENT = {
  kind: "meeting_booked",
  eventId: "33333333-3333-4333-8333-333333333333",
  occurredAt: "2026-05-03T11:00:00.000Z",
  touchId: "T-001",
  meetingAt: "2026-05-10T14:00:00.000Z",
};

const VALID_BOUNCED_EVENT = {
  kind: "bounced",
  eventId: "44444444-4444-4444-8444-444444444444",
  occurredAt: "2026-05-01T09:05:00.000Z",
  touchId: "T-002",
  reason: "hard bounce",
};

const VALID_NO_RESPONSE_EVENT = {
  kind: "no_response",
  eventId: "55555555-5555-4555-8555-555555555555",
  occurredAt: "2026-05-08T00:00:00.000Z",
  asOf: "2026-05-08T00:00:00.000Z",
  windowDays: 7,
  lastTouchId: "T-001",
  derived: true as const,
};

const VALID_COMMERCIAL_SIGNAL = {
  kind: "opportunity_created",
  eventId: "66666666-6666-4666-8666-666666666666",
  occurredAt: "2026-05-05T15:30:00.000Z",
  amountUsd: 95000,
  crmRef: "CRM-0042",
};

function validPayload(): unknown {
  return {
    schemaVersion: "sales.engagement-feedback.v1",
    generatedAt: "2026-05-29T00:00:00.000Z",
    source: {
      system: "sales",
      purpose: "Report observed front-funnel engagement for router measurement.",
    },
    coverage: {
      complete: true,
      scanned: 3,
      emitted: 3,
      since: "2026-05-01T00:00:00.000Z",
    },
    deals: [
      {
        routerDealId: "D-fb65c15017ef",
        trace: {
          sourceSystem: "sales",
          boundary: "observed_engagement_not_router_truth",
        },
        events: [VALID_SENT_EVENT, VALID_REPLIED_EVENT, VALID_MEETING_EVENT],
        commercialSignals: [VALID_COMMERCIAL_SIGNAL],
      },
      {
        routerDealId: "D-cdea8ac45022",
        trace: {
          sourceSystem: "sales",
          boundary: "observed_engagement_not_router_truth",
        },
        events: [VALID_BOUNCED_EVENT],
      },
    ],
  };
}

describe("parseEngagementFeedback", () => {
  it("parses a valid payload and pins the schema version constant", () => {
    expect(ENGAGEMENT_FEEDBACK_SCHEMA_VERSION).toBe(
      "sales.engagement-feedback.v1",
    );
    const result = parseEngagementFeedback(validPayload());
    expect(result.schemaVersion).toBe("sales.engagement-feedback.v1");
    expect(result.generatedAt).toBe("2026-05-29T00:00:00.000Z");
    expect(result.source.system).toBe("sales");
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.scanned).toBe(3);
    expect(result.coverage.emitted).toBe(3);
    expect(result.coverage.since).toBe("2026-05-01T00:00:00.000Z");
    expect(result.deals).toHaveLength(2);
  });

  it("parses all five EngagementEvent kinds on a single deal", () => {
    const payload = {
      ...(validPayload() as Record<string, unknown>),
      deals: [
        {
          routerDealId: "D-fb65c15017ef",
          trace: {
            sourceSystem: "sales",
            boundary: "observed_engagement_not_router_truth",
          },
          events: [
            VALID_SENT_EVENT,
            VALID_REPLIED_EVENT,
            VALID_MEETING_EVENT,
            VALID_BOUNCED_EVENT,
            VALID_NO_RESPONSE_EVENT,
          ],
        },
      ],
    };
    const result = parseEngagementFeedback(payload);
    const kinds = result.deals[0]!.events.map((e) => e.kind);
    expect(kinds).toEqual([
      "sent",
      "replied",
      "meeting_booked",
      "bounced",
      "no_response",
    ]);
  });

  it("accepts coverage.since as null", () => {
    const payload = validPayload() as Record<string, unknown>;
    (payload["coverage"] as Record<string, unknown>)["since"] = null;
    const result = parseEngagementFeedback(payload);
    expect(result.coverage.since).toBeNull();
  });

  it("accepts a deal with no commercialSignals field", () => {
    const result = parseEngagementFeedback(validPayload());
    // second deal has no commercialSignals
    expect(result.deals[1]!.commercialSignals).toBeUndefined();
  });

  it("round-trips commercialSignals including null amountUsd and null crmRef", () => {
    const payload = {
      ...(validPayload() as Record<string, unknown>),
      deals: [
        {
          routerDealId: "D-fb65c15017ef",
          trace: {
            sourceSystem: "sales",
            boundary: "observed_engagement_not_router_truth",
          },
          events: [VALID_SENT_EVENT],
          commercialSignals: [
            {
              kind: "opportunity_created",
              eventId: "77777777-7777-4777-8777-777777777777",
              occurredAt: "2026-05-06T08:00:00.000Z",
              amountUsd: null,
              crmRef: null,
            },
          ],
        },
      ],
    };
    const result = parseEngagementFeedback(payload);
    const sig = result.deals[0]!.commercialSignals![0]!;
    expect(sig.kind).toBe("opportunity_created");
    expect(sig.amountUsd).toBeNull();
    expect(sig.crmRef).toBeNull();
    expect(sig.occurredAt).toBe("2026-05-06T08:00:00.000Z");
  });

  it("passes through unknown top-level fields (forward-compat .passthrough)", () => {
    const payload = {
      ...(validPayload() as Record<string, unknown>),
      futureField: "some-future-value",
    };
    const result = parseEngagementFeedback(payload) as Record<string, unknown>;
    expect(result["futureField"]).toBe("some-future-value");
  });

  it("rejects an unknown event kind", () => {
    const payload = validPayload() as Record<string, unknown>;
    (payload["deals"] as Array<Record<string, unknown>>)[0]!["events"] = [
      {
        kind: "delivered", // explicitly dropped per spec §4.2
        eventId: "88888888-8888-4888-8888-888888888888",
        occurredAt: "2026-05-01T09:00:00.000Z",
        touchId: "T-001",
      },
    ];
    expect(() => parseEngagementFeedback(payload)).toThrow();
  });

  it("rejects an unknown commercialSignal kind", () => {
    const payload = validPayload() as Record<string, unknown>;
    (payload["deals"] as Array<Record<string, unknown>>)[0]!["commercialSignals"] = [
      {
        kind: "contract_signed", // not in schema
        eventId: "99999999-9999-4999-8999-999999999999",
        occurredAt: "2026-05-01T09:00:00.000Z",
        amountUsd: 50000,
        crmRef: null,
      },
    ];
    expect(() => parseEngagementFeedback(payload)).toThrow();
  });

  it("rejects a non-canonical-UTC occurredAt (date-only string)", () => {
    const payload = validPayload() as Record<string, unknown>;
    const events = (payload["deals"] as Array<Record<string, unknown>>)[0]!["events"] as Array<Record<string, unknown>>;
    events[0]!["occurredAt"] = "2026-05-01"; // missing time + Z
    expect(() => parseEngagementFeedback(payload)).toThrow();
  });

  it("rejects a non-canonical-UTC occurredAt (missing milliseconds)", () => {
    const payload = validPayload() as Record<string, unknown>;
    const events = (payload["deals"] as Array<Record<string, unknown>>)[0]!["events"] as Array<Record<string, unknown>>;
    events[0]!["occurredAt"] = "2026-05-01T09:00:00Z"; // no .sss
    expect(() => parseEngagementFeedback(payload)).toThrow();
  });

  it("rejects an invalid second (ss=60) occurredAt — caught by the invalid-Date check", () => {
    const payload = validPayload() as Record<string, unknown>;
    const events = (payload["deals"] as Array<Record<string, unknown>>)[0]!["events"] as Array<Record<string, unknown>>;
    // ss=60 matches the regex, but new Date(...) is Invalid (NaN), so it is rejected.
    events[0]!["occurredAt"] = "2026-05-01T09:00:60.000Z";
    expect(() => parseEngagementFeedback(payload)).toThrow();
  });

  it("rejects a rolling-overflow date (Feb 29 in a non-leap year) — only the round-trip guard catches this", () => {
    const payload = validPayload() as Record<string, unknown>;
    const events = (payload["deals"] as Array<Record<string, unknown>>)[0]!["events"] as Array<Record<string, unknown>>;
    // 2026 is not a leap year: the regex matches and new Date() is valid (not NaN),
    // but JS silently rolls 2026-02-29 to 2026-03-01, so toISOString() !== value.
    // This is the exact bypass class the round-trip equality check exists for.
    events[0]!["occurredAt"] = "2026-02-29T00:00:00.000Z";
    expect(() => parseEngagementFeedback(payload)).toThrow();
  });

  it("rejects a non-canonical-UTC generatedAt", () => {
    const payload = validPayload() as Record<string, unknown>;
    payload["generatedAt"] = "2026-05-29"; // date-only
    expect(() => parseEngagementFeedback(payload)).toThrow();
  });

  it("rejects a non-canonical-UTC meetingAt on meeting_booked", () => {
    const payload = {
      ...(validPayload() as Record<string, unknown>),
      deals: [
        {
          routerDealId: "D-fb65c15017ef",
          trace: {
            sourceSystem: "sales",
            boundary: "observed_engagement_not_router_truth",
          },
          events: [
            {
              kind: "meeting_booked",
              eventId: "aa111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              occurredAt: "2026-05-03T11:00:00.000Z",
              touchId: "T-001",
              meetingAt: "2026-05-10", // date-only — invalid
            },
          ],
        },
      ],
    };
    expect(() => parseEngagementFeedback(payload)).toThrow();
  });

  it("rejects a non-canonical-UTC asOf on no_response", () => {
    const payload = {
      ...(validPayload() as Record<string, unknown>),
      deals: [
        {
          routerDealId: "D-fb65c15017ef",
          trace: {
            sourceSystem: "sales",
            boundary: "observed_engagement_not_router_truth",
          },
          events: [
            {
              kind: "no_response",
              eventId: "bb222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              occurredAt: "2026-05-08T00:00:00.000Z",
              asOf: "not-a-date", // invalid
              windowDays: 7,
              lastTouchId: "T-001",
              derived: true,
            },
          ],
        },
      ],
    };
    expect(() => parseEngagementFeedback(payload)).toThrow();
  });

  it("rejects no_response with derived: false (the literal-true anti-spoofing guard)", () => {
    const payload = {
      ...(validPayload() as Record<string, unknown>),
      deals: [
        {
          routerDealId: "D-fb65c15017ef",
          trace: { sourceSystem: "sales", boundary: "observed_engagement_not_router_truth" },
          events: [
            {
              kind: "no_response",
              eventId: "cc333333-cccc-4ccc-8ccc-cccccccccccc",
              occurredAt: "2026-05-08T00:00:00.000Z",
              asOf: "2026-05-08T00:00:00.000Z",
              windowDays: 7,
              lastTouchId: "T-001",
              derived: false, // only the literal `true` is valid
            },
          ],
        },
      ],
    };
    expect(() => parseEngagementFeedback(payload)).toThrow();
  });

  it("rejects no_response with derived omitted", () => {
    const payload = {
      ...(validPayload() as Record<string, unknown>),
      deals: [
        {
          routerDealId: "D-fb65c15017ef",
          trace: { sourceSystem: "sales", boundary: "observed_engagement_not_router_truth" },
          events: [
            {
              kind: "no_response",
              eventId: "dd444444-dddd-4ddd-8ddd-dddddddddddd",
              occurredAt: "2026-05-08T00:00:00.000Z",
              asOf: "2026-05-08T00:00:00.000Z",
              windowDays: 7,
              lastTouchId: "T-001",
              // derived omitted — it is a required literal `true`
            },
          ],
        },
      ],
    };
    expect(() => parseEngagementFeedback(payload)).toThrow();
  });

  it("rejects missing required field (eventId)", () => {
    const payload = validPayload() as Record<string, unknown>;
    const events = (payload["deals"] as Array<Record<string, unknown>>)[0]!["events"] as Array<Record<string, unknown>>;
    const { eventId: _dropped, ...withoutEventId } = events[0]! as { eventId: string } & Record<string, unknown>;
    events[0] = withoutEventId;
    expect(() => parseEngagementFeedback(payload)).toThrow();
  });

  it("rejects wrong schemaVersion", () => {
    const payload = validPayload() as Record<string, unknown>;
    payload["schemaVersion"] = "sales.engagement-feedback.v2";
    expect(() => parseEngagementFeedback(payload)).toThrow();
  });
});
