import { describe, expect, it, vi } from "vitest";
import {
  HubSpotSlackSink,
  hubSpotV3Signature,
  hubSpotDealPayload,
  integrationOptionsFromEnv,
  parseHubSpotStageEvents,
  parseHubSpotStageWebhookBatch,
  runIntegrationDoctor,
  slackHandoffPayload,
  slackStageChangePayload,
} from "../src/integrations.js";
import { FixtureEnricher } from "../src/enrich.js";
import { processOne } from "../src/pipeline.js";
import { RetryableSinkError, TerminalSinkError } from "../src/sink.js";
import { Store } from "../src/store.js";
import type { RoutedDeal } from "../src/types.js";

function routed(id = "D-1", company = "Ryder Digital"): RoutedDeal {
  return {
    id,
    company,
    domain: "ryder-digital.com",
    contactName: "Dana Pruitt",
    contactEmail: "dana@ryder-digital.com",
    dealUSD: 120000,
    region: "NA",
    sourceChannel: "inbound_form",
    statedNeed: "manual check calls",
    enrichment: {
      employees: 1200,
      industry: "logistics",
      techSignals: ["manual_ops", "enterprise"],
      regulated: true,
      confidence: 0.95,
    },
    score: {
      icpFit: 1,
      painSignal: 1,
      sizeFit: 1,
      regionFit: 1,
      total: 1,
      notes: [],
    },
    route: {
      kind: "human_assisted",
      salesOwner: "ae.morgan",
      financeFlag: "pricing_approval",
      legalFlag: "regulated_review",
      slaHours: 4,
    },
  };
}

describe("HubSpot + Slack integration sink", () => {
  it("builds an idempotent HubSpot upsert payload keyed by router deal id", () => {
    const payload = hubSpotDealPayload(routed(), {
      hubspotExternalIdProperty: "gtm_router_deal_id",
      hubspotPipeline: "default",
      hubspotDealstage: "appointmentscheduled",
    });

    expect(payload.inputs[0]?.id).toBe("D-1");
    expect(payload.inputs[0]?.idProperty).toBe("gtm_router_deal_id");
    expect(payload.inputs[0]?.properties.gtm_router_deal_id).toBe("D-1");
    expect(payload.inputs[0]?.properties.amount).toBe("120000");
    expect(payload.inputs[0]?.properties.dealname).toBe(
      "Ryder Digital - human -> ae.morgan; flags: pricing_approval, regulated_review",
    );
  });

  it("builds a Slack handoff that carries the HubSpot receipt", () => {
    const payload = slackHandoffPayload(routed(), "C123", {
      system: "hubspot",
      externalId: "12345",
      detail: "created deal",
      url: "https://hubspot.test/deal/12345",
    });

    expect(payload.channel).toBe("C123");
    expect(payload.text).toContain("Ryder Digital");
    expect(payload.text).toContain("HubSpot: 12345");
    expect(payload.text).toContain("pricing_approval");
  });

  it("escapes Slack link-control chars while leaving readable identifiers intact", () => {
    const payload = slackHandoffPayload(
      routed("D-<danger>`", "ACME <@U123|ops> & *Co* `prod`"),
      "C123",
      {
        system: "hubspot",
        externalId: "123<bad>`",
        detail: "created deal",
        url: "https://hubspot.test/deal/123?x=<bad>&y=1&env=`prod`",
      },
    );

    expect(payload.text).toContain("ACME &lt;@U123|ops&gt; &amp; *Co* \\`prod\\`");
    expect(payload.text).toContain("123&lt;bad&gt;\\`");
    expect(payload.text).toContain("x=&lt;bad&gt;&amp;y=1&amp;env=\\`prod\\`");
    expect(payload.text).toContain("D-&lt;danger&gt;\\`");
  });

  it("dry-run mode emits HubSpot and Slack receipts without network", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const built = integrationOptionsFromEnv("dry-run", {}, fetchImpl);

    const receipts = await built.sink.upsert(routed());

    expect(built.dryRun).toBe(true);
    expect(receipts.map((r) => r.system)).toEqual(["hubspot", "slack"]);
    expect(receipts[0]?.detail).toContain("would upsert deal");
    expect(receipts[1]?.detail).toContain("would post handoff");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("parses only HubSpot dealstage webhook events", () => {
    const events = parseHubSpotStageEvents([
      {
        eventId: 1,
        portalId: 246238162,
        subscriptionType: "object.propertyChange",
        objectTypeId: "0-3",
        objectId: 777,
        propertyName: "dealstage",
        propertyValue: "contact_made",
        toStageLabel: "Contact Made",
        routerDealId: "D-1",
        occurredAt: 1779210000000,
        changeSource: "CRM_UI",
      },
      {
        eventId: 2,
        objectTypeId: "0-1",
        objectId: 888,
        propertyName: "firstname",
        propertyValue: "Dana",
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        hubspotDealId: "777",
        routerDealId: "D-1",
        toStageId: "contact_made",
        toStageLabel: "Contact Made",
      }),
    );
    expect(events[0]?.eventKey).toBe(
      JSON.stringify([
        "hubspot",
        "246238162",
        "1",
        "777",
        "dealstage",
        "contact_made",
        "2026-05-19T17:00:00.000Z",
      ]),
    );
  });

  it("drops malformed dealstage webhooks without an event id", () => {
    const parsed = parseHubSpotStageWebhookBatch([
      {
        portalId: 246238162,
        subscriptionType: "object.propertyChange",
        objectTypeId: "0-3",
        objectId: 777,
        propertyName: "dealstage",
        propertyValue: "contact_made",
        routerDealId: "D-1",
        occurredAt: 1779210000000,
      },
    ]);

    expect(parsed.events).toHaveLength(0);
    expect(parsed.dropped).toBe(1);
  });

  it("bounds HubSpot deal hydration concurrency for webhook batches", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Response(
        JSON.stringify({
          id: "hubspot-deal",
          properties: { gtm_router_deal_id: "D-hydrated" },
        }),
        { status: 200 },
      );
    });
    const built = integrationOptionsFromEnv(
      "live",
      {
        HUBSPOT_ACCESS_TOKEN: "pat-na2-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "secret",
        PUBLIC_BASE_URL: "https://example.com",
        HUBSPOT_NOTIFY_STAGE_IDS: "contact_made",
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "C12345678",
      },
      fetchImpl,
    );

    const resolved = await built.stageChanges.resolve(
      Array.from({ length: 12 }, (_, i) => ({
        eventId: i + 1,
        portalId: 246238162,
        subscriptionType: "object.propertyChange",
        objectTypeId: "0-3",
        objectId: 10_000 + i,
        propertyName: "dealstage",
        propertyValue: "contact_made",
        occurredAt: 1779210000000 + i,
      })),
    );

    expect(resolved.changes).toHaveLength(12);
    expect(maxActive).toBeLessThanOrEqual(5);
  });

  it("resolves healthy HubSpot stage events even when one deal fetch fails", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/crm/v3/objects/deals/777")) {
        return new Response(
          JSON.stringify({
            id: "777",
            properties: { gtm_router_deal_id: "D-healthy" },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: "unavailable" }), {
        status: 503,
      });
    }) as unknown as typeof fetch;
    const built = integrationOptionsFromEnv(
      "live",
      {
        HUBSPOT_ACCESS_TOKEN: "pat-na2-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "secret",
        PUBLIC_BASE_URL: "https://example.com",
        HUBSPOT_NOTIFY_STAGE_IDS: "contact_made",
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "C12345678",
      },
      fetchImpl,
    );

    const resolved = await built.stageChanges.resolve([
      {
        eventId: 1,
        portalId: 246238162,
        subscriptionType: "object.propertyChange",
        objectTypeId: "0-3",
        objectId: 777,
        propertyName: "dealstage",
        propertyValue: "contact_made",
        occurredAt: 1779210000000,
      },
      {
        eventId: 2,
        portalId: 246238162,
        subscriptionType: "object.propertyChange",
        objectTypeId: "0-3",
        objectId: 778,
        propertyName: "dealstage",
        propertyValue: "contact_made",
        occurredAt: 1779210000001,
      },
    ]);

    expect(resolved.changes).toHaveLength(1);
    expect(resolved.changes[0]?.routerDealId).toBe("D-healthy");
    expect(resolved.resolveErrors).toBe(1);
  });

  it("verifies HubSpot v3 webhook signatures against the raw body", () => {
    const rawBody = JSON.stringify([
      {
        objectId: 777,
        propertyName: "dealstage",
        propertyValue: "contact_made",
      },
    ]);
    const timestamp = String(new Date("2026-05-19T12:00:00Z").getTime());
    const signature = hubSpotV3Signature(
      "client-secret",
      "POST",
      "https://router.example.com/webhooks/hubspot",
      rawBody,
      timestamp,
    );
    const built = integrationOptionsFromEnv("dry-run", {
      HUBSPOT_WEBHOOK_SECRET: "client-secret",
    });

    expect(
      built.stageChanges.verify({
        method: "POST",
        absoluteUrl: "https://router.example.com/webhooks/hubspot",
        rawBody,
        headers: {
          "x-hubspot-signature-v3": signature,
          "x-hubspot-request-timestamp": timestamp,
        },
        now: () => new Date("2026-05-19T12:00:00Z"),
      }),
    ).toBe(true);
    expect(
      built.stageChanges.verify({
        method: "POST",
        absoluteUrl: "https://router.example.com/webhooks/hubspot",
        rawBody: rawBody + "\n",
        headers: {
          "x-hubspot-signature-v3": signature,
          "x-hubspot-request-timestamp": timestamp,
        },
        now: () => new Date("2026-05-19T12:00:00Z"),
      }),
    ).toBe(false);

    const futureTimestamp = String(
      new Date("2026-05-19T12:06:00Z").getTime(),
    );
    const futureSignature = hubSpotV3Signature(
      "client-secret",
      "POST",
      "https://router.example.com/webhooks/hubspot",
      rawBody,
      futureTimestamp,
    );
    expect(
      built.stageChanges.verify({
        method: "POST",
        absoluteUrl: "https://router.example.com/webhooks/hubspot",
        rawBody,
        headers: {
          "x-hubspot-signature-v3": futureSignature,
          "x-hubspot-request-timestamp": futureTimestamp,
        },
        now: () => new Date("2026-05-19T12:00:00Z"),
      }),
    ).toBe(false);
  });

  it("live stage-change handling fetches the router id before posting Slack", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url).includes("/crm/v3/objects/deals/777")) {
        return new Response(
          JSON.stringify({
            id: "777",
            properties: {
              gtm_router_deal_id: "D-1",
              dealname: "Ryder Digital",
              dealstage: "contact_made",
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, channel: "C123", ts: "177.0001" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const built = integrationOptionsFromEnv(
      "live",
      {
        HUBSPOT_ACCESS_TOKEN: "hs-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "client-secret",
        PUBLIC_BASE_URL: "https://router.example.com",
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "C12345678",
        HUBSPOT_NOTIFY_STAGE_IDS: "contact_made",
      },
      fetchImpl,
    );

    const resolved = await built.stageChanges.resolve([
      {
        eventId: 1,
        portalId: 246238162,
        subscriptionType: "deal.propertyChange",
        objectTypeId: "0-3",
        objectId: 777,
        propertyName: "dealstage",
        propertyValue: "contact_made",
        occurredAt: 1779210000000,
      },
    ]);
    const receipts = await built.stageChanges.notify(resolved.changes[0]!);
    const slackBody = JSON.parse(String(calls[1]?.init.body));

    expect(resolved.changes[0]?.routerDealId).toBe("D-1");
    expect(resolved.droppedNoRouterId).toBe(0);
    expect(calls[0]?.url).toContain(
      "properties=gtm_router_deal_id%2Cdealstage%2Cdealname%2Camount",
    );
    expect(slackBody.text).toContain("Ryder Digital");
    expect(slackBody.text).toContain("Stage: contact_made");
    expect(receipts[0]?.detail).toContain("posted stage change");
  });

  it("builds a Slack stage-change message with traceable ids", () => {
    const payload = slackStageChangePayload(
      {
        eventKey: "hubspot:1",
        routerDealId: "D-1",
        hubspotDealId: "777",
        portalId: "246238162",
        eventId: "1",
        toStageId: "contact_made",
        toStageLabel: "Contact Made",
        dealName: "Ryder Digital",
        occurredAt: "2026-05-19T12:00:00.000Z",
        source: "CRM_UI",
      },
      "C123",
      "246238162",
    );

    expect(payload.channel).toBe("C123");
    expect(payload.text).toContain("Contact Made (contact_made)");
    expect(payload.text).toContain("Router id: D-1");
    expect(payload.text).toContain(
      "https://app.hubspot.com/contacts/246238162/deal/777",
    );
  });

  it("does not retry stage-change Slack posts after the webhook event is claimed", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 200,
      });
    });
    const built = integrationOptionsFromEnv(
      "live",
      {
        HUBSPOT_ACCESS_TOKEN: "pat-na2-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "secret",
        PUBLIC_BASE_URL: "https://example.com",
        HUBSPOT_NOTIFY_STAGE_IDS: "contact_made",
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "C12345678",
      },
      fetchImpl,
    );

    const receipts = await built.stageChanges.notify({
      eventKey: "event-1",
      routerDealId: "D-1",
      hubspotDealId: "777",
      portalId: "246238162",
      eventId: "1",
      toStageId: "contact_made",
      toStageLabel: "Contact Made",
      dealName: "Ryder Digital",
      occurredAt: "2026-05-19T17:00:00.000Z",
      source: "CRM_UI",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(receipts[0]).toEqual(
      expect.objectContaining({
        system: "slack",
        status: "warning",
      }),
    );
  });

  it("dry-run mode stays network-silent through the full pipeline", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const built = integrationOptionsFromEnv("dry-run", {}, fetchImpl);
    const store = new Store(":memory:");
    const enricher = new FixtureEnricher({
      "ryder-digital.com": {
        employees: 1200,
        industry: "logistics",
        techSignals: ["twilio", "salesforce"],
        regulated: true,
        confidence: 0.95,
      },
    });

    const outcome = await processOne(
      {
        company: "Ryder Digital",
        domain: "ryder-digital.com",
        contactName: "Dana Pruitt",
        contactEmail: "dana@ryder-digital.com",
        dealUSD: 120000,
        region: "NA",
        sourceChannel: "inbound_form",
        statedNeed: "manual check calls",
      },
      store,
      enricher,
      built,
    );

    const sinkEvent = store
      .events()
      .find((event) => event.meta?.kind === "sink");
    expect(outcome.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sinkEvent?.meta).toEqual(
      expect.objectContaining({
        kind: "sink",
        mode: "dry_run",
        receipts: [
          expect.objectContaining({ system: "hubspot" }),
          expect.objectContaining({ system: "slack" }),
        ],
      }),
    );
    store.close();
  });

  it("live mode calls HubSpot first, then posts the Slack handoff", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (calls.length === 1) {
        return new Response(
          JSON.stringify({
            results: [{ id: "12345", new: true, url: "https://hubspot/deal/12345" }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, channel: "C123", ts: "171.0001" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const sink = new HubSpotSlackSink({
      mode: "live",
      hubspotAccessToken: "hs-token",
      hubspotExternalIdProperty: "gtm_router_deal_id",
      hubspotApiBase: "https://api.hubapi.com",
      hubspotPipeline: "default",
      hubspotDealstage: "appointmentscheduled",
      hubspotPortalId: undefined,
      slackBotToken: "xoxb-token",
      slackChannelId: "C123",
      slackApiBase: "https://slack.com",
      fetchImpl,
      slackRetry: { maxAttempts: 3, baseDelayMs: 0, sleep: async () => {} },
    });

    const receipts = await sink.upsert(routed());
    const hubspotBody = JSON.parse(String(calls[0]?.init.body));
    const slackBody = JSON.parse(String(calls[1]?.init.body));

    expect(calls[0]?.url).toContain("/crm/v3/objects/0-3/batch/upsert");
    expect(new URL(calls[0]?.url ?? "https://example.com").search).toBe(
      "?idProperty=gtm_router_deal_id",
    );
    expect(hubspotBody.inputs[0].id).toBe("D-1");
    expect(hubspotBody.inputs[0].idProperty).toBe("gtm_router_deal_id");
    expect(calls[1]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(slackBody.text).toContain("HubSpot: 12345");
    expect(receipts.map((r) => r.externalId)).toEqual(["12345", "171.0001"]);
    expect(receipts[0]?.detail).toBe("created deal");
  });

  it("labels existing HubSpot upserts when the response says new is false", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            results: [{ id: "12345", new: false }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, channel: "C123", ts: "171.0001" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const sink = new HubSpotSlackSink({
      mode: "live",
      hubspotAccessToken: "hs-token",
      hubspotExternalIdProperty: "gtm_router_deal_id",
      hubspotApiBase: "https://api.hubapi.com",
      hubspotPipeline: "default",
      hubspotDealstage: "appointmentscheduled",
      hubspotPortalId: undefined,
      slackBotToken: "xoxb-token",
      slackChannelId: "C123",
      slackApiBase: "https://slack.com",
      fetchImpl,
      slackRetry: { maxAttempts: 1, baseDelayMs: 0, sleep: async () => {} },
    });

    const receipts = await sink.upsert(routed());

    expect(receipts[0]?.detail).toBe("upserted deal");
  });

  it("does not treat string-shaped HubSpot new values as created deals", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            results: [{ id: "12345", new: "true" }],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ ok: true, channel: "C123", ts: "171.0001" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const sink = new HubSpotSlackSink({
      mode: "live",
      hubspotAccessToken: "hs-token",
      hubspotExternalIdProperty: "gtm_router_deal_id",
      hubspotApiBase: "https://api.hubapi.com",
      hubspotPipeline: "default",
      hubspotDealstage: "appointmentscheduled",
      hubspotPortalId: undefined,
      slackBotToken: "xoxb-token",
      slackChannelId: "C123",
      slackApiBase: "https://slack.com",
      fetchImpl,
      slackRetry: { maxAttempts: 1, baseDelayMs: 0, sleep: async () => {} },
    });

    const receipts = await sink.upsert(routed());

    expect(receipts[0]?.detail).toBe("upserted deal");
  });

  it("live mode refuses missing env instead of creating duplicate-prone writes", () => {
    expect(() => integrationOptionsFromEnv("live", {})).toThrow(
      "missing live integration env",
    );
  });

  it("live mode requires an explicit HubSpot stage notification allowlist", () => {
    expect(() =>
      integrationOptionsFromEnv("live", {
        HUBSPOT_ACCESS_TOKEN: "hs-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "client-secret",
        PUBLIC_BASE_URL: "https://router.example.com",
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "C0123456789",
      }),
    ).toThrow("missing live integration env: HUBSPOT_NOTIFY_STAGE_IDS");
  });

  it("live mode rejects an empty HubSpot stage notification allowlist", () => {
    expect(() =>
      integrationOptionsFromEnv("live", {
        HUBSPOT_ACCESS_TOKEN: "hs-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "client-secret",
        PUBLIC_BASE_URL: "https://router.example.com",
        HUBSPOT_NOTIFY_STAGE_IDS: " , ,, ",
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "C0123456789",
      }),
    ).toThrow("invalid live integration env: HUBSPOT_NOTIFY_STAGE_IDS");
  });

  it("live mode rejects an explicitly empty HubSpot stage notification allowlist", () => {
    expect(() =>
      integrationOptionsFromEnv("live", {
        HUBSPOT_ACCESS_TOKEN: "hs-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "client-secret",
        PUBLIC_BASE_URL: "https://router.example.com",
        HUBSPOT_NOTIFY_STAGE_IDS: "",
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "C0123456789",
      }),
    ).toThrow("invalid live integration env: HUBSPOT_NOTIFY_STAGE_IDS");
  });

  it("live mode accepts whitespace around concrete HubSpot stage ids", () => {
    expect(() =>
      integrationOptionsFromEnv("live", {
        HUBSPOT_ACCESS_TOKEN: "hs-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "client-secret",
        PUBLIC_BASE_URL: "https://router.example.com",
        HUBSPOT_NOTIFY_STAGE_IDS: " , contact_made , ",
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "C0123456789",
      }),
    ).not.toThrow();
  });

  it("live mode rejects Slack channel names before first send", () => {
    expect(() =>
      integrationOptionsFromEnv("live", {
        HUBSPOT_ACCESS_TOKEN: "hs-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "client-secret",
        PUBLIC_BASE_URL: "https://router.example.com",
        HUBSPOT_NOTIFY_STAGE_IDS: "contact_made",
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "#ops",
      }),
    ).toThrow("invalid live integration env: SLACK_CHANNEL_ID");
  });

  it("live mode requires PUBLIC_BASE_URL to be an HTTPS origin", () => {
    expect(() =>
      integrationOptionsFromEnv("live", {
        HUBSPOT_ACCESS_TOKEN: "hs-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "client-secret",
        PUBLIC_BASE_URL: "https://router.example.com/prefix",
        HUBSPOT_NOTIFY_STAGE_IDS: "contact_made",
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "C0123456789",
      }),
    ).toThrow("invalid live integration env: PUBLIC_BASE_URL");
  });

  it("Slack rate limits become loud warning receipts after HubSpot succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ results: [{ id: "12345" }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const sink = new HubSpotSlackSink({
      mode: "live",
      hubspotAccessToken: "hs-token",
      hubspotExternalIdProperty: "gtm_router_deal_id",
      hubspotApiBase: "https://api.hubapi.com",
      hubspotPipeline: "default",
      hubspotDealstage: "appointmentscheduled",
      hubspotPortalId: undefined,
      slackBotToken: "xoxb-token",
      slackChannelId: "C123",
      slackApiBase: "https://slack.com",
      fetchImpl,
      slackRetry: { maxAttempts: 3, baseDelayMs: 0, sleep: async () => {} },
    });

    const receipts = await sink.upsert(routed());
    expect(receipts[0]).toEqual(expect.objectContaining({ system: "hubspot" }));
    expect(receipts[1]).toEqual(
      expect.objectContaining({
        system: "slack",
        detail: expect.stringContaining("ratelimited"),
      }),
    );
  });

  it("Slack fatal_error is reported without quarantining the HubSpot write", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ results: [{ id: "12345" }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: false, error: "fatal_error" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const sink = new HubSpotSlackSink({
      mode: "live",
      hubspotAccessToken: "hs-token",
      hubspotExternalIdProperty: "gtm_router_deal_id",
      hubspotApiBase: "https://api.hubapi.com",
      hubspotPipeline: "default",
      hubspotDealstage: "appointmentscheduled",
      hubspotPortalId: undefined,
      slackBotToken: "xoxb-token",
      slackChannelId: "C123",
      slackApiBase: "https://slack.com",
      fetchImpl,
      slackRetry: { maxAttempts: 3, baseDelayMs: 0, sleep: async () => {} },
    });

    const receipts = await sink.upsert(routed());
    expect(calls).toBe(4);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ system: "hubspot" }),
        expect.objectContaining({
          system: "slack",
          detail: expect.stringContaining("fatal_error"),
        }),
      ]),
    );
  });

  it("rejects malformed HubSpot result ids instead of inventing success", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ id: 12345 }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;

    const sink = new HubSpotSlackSink({
      mode: "live",
      hubspotAccessToken: "hs-token",
      hubspotExternalIdProperty: "gtm_router_deal_id",
      hubspotApiBase: "https://api.hubapi.com",
      hubspotPipeline: "default",
      hubspotDealstage: "appointmentscheduled",
      hubspotPortalId: undefined,
      slackBotToken: "xoxb-token",
      slackChannelId: "C123",
      slackApiBase: "https://slack.com",
      fetchImpl,
    });

    await expect(sink.upsert(routed())).rejects.toBeInstanceOf(
      TerminalSinkError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("live integration fetches are bounded by timeout", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    ) as unknown as typeof fetch;

    const built = integrationOptionsFromEnv(
      "live",
      {
        HUBSPOT_ACCESS_TOKEN: "hs-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "client-secret",
        PUBLIC_BASE_URL: "https://router.example.com",
        HUBSPOT_NOTIFY_STAGE_IDS: "contact_made",
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "C0123456789",
        INTEGRATION_FETCH_TIMEOUT_MS: "1",
      },
      fetchImpl,
    );

    await expect(built.sink.upsert(routed())).rejects.toBeInstanceOf(
      RetryableSinkError,
    );
  });

  it("pipeline stays routed when Slack notification fails after HubSpot upsert", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ results: [{ id: "12345" }] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: false, error: "missing_scope" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const sink = new HubSpotSlackSink({
      mode: "live",
      hubspotAccessToken: "hs-token",
      hubspotExternalIdProperty: "gtm_router_deal_id",
      hubspotApiBase: "https://api.hubapi.com",
      hubspotPipeline: "default",
      hubspotDealstage: "appointmentscheduled",
      hubspotPortalId: undefined,
      slackBotToken: "xoxb-token",
      slackChannelId: "C123",
      slackApiBase: "https://slack.com",
      fetchImpl,
    });
    const store = new Store(":memory:");
    const enricher = new FixtureEnricher({
      "ryder-digital.com": {
        employees: 1200,
        industry: "logistics",
        techSignals: ["twilio", "salesforce"],
        regulated: true,
        confidence: 0.95,
      },
    });

    const outcome = await processOne(
      {
        company: "Ryder Digital",
        domain: "ryder-digital.com",
        contactName: "Dana Pruitt",
        contactEmail: "dana@ryder-digital.com",
        dealUSD: 120000,
        region: "NA",
        sourceChannel: "inbound_form",
        statedNeed: "manual check calls",
      },
      store,
      enricher,
      {
        dryRun: false,
        sink,
        retry: { maxAttempts: 3, baseDelayMs: 0, sleep: async () => {} },
      },
    );
    const sinkEvent = store
      .events()
      .find((event) => event.meta?.kind === "sink");

    expect(outcome.ok).toBe(true);
    expect(store.routed()).toHaveLength(1);
    expect(store.metrics().partialSyncs).toBe(1);
    expect(store.quarantined()).toHaveLength(0);
    expect(sinkEvent?.meta).toEqual(
      expect.objectContaining({
        receipts: expect.arrayContaining([
          expect.objectContaining({ system: "hubspot", externalId: "12345" }),
          expect.objectContaining({
            system: "slack",
            detail: expect.stringContaining("missing_scope"),
          }),
        ]),
      }),
    );

    let recoveredCalls = 0;
    const recoveredSink: typeof sink = new HubSpotSlackSink({
      mode: "live",
      hubspotAccessToken: "hs-token",
      hubspotExternalIdProperty: "gtm_router_deal_id",
      hubspotApiBase: "https://api.hubapi.com",
      hubspotPipeline: "default",
      hubspotDealstage: "appointmentscheduled",
      hubspotPortalId: undefined,
      slackBotToken: "xoxb-token",
      slackChannelId: "C123",
      slackApiBase: "https://slack.com",
      fetchImpl: vi.fn(async () => {
        recoveredCalls += 1;
        if (recoveredCalls === 1) {
          return new Response(JSON.stringify({ results: [{ id: "12345" }] }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ ok: true, channel: "C123", ts: "172.0001" }),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const replay = await processOne(
      {
        company: "Ryder Digital",
        domain: "ryder-digital.com",
        contactName: "Dana Pruitt",
        contactEmail: "dana@ryder-digital.com",
        dealUSD: 120000,
        region: "NA",
        sourceChannel: "inbound_form",
        statedNeed: "manual check calls",
      },
      store,
      enricher,
      {
        dryRun: false,
        sink: recoveredSink,
        retry: { maxAttempts: 3, baseDelayMs: 0, sleep: async () => {} },
      },
    );
    expect(replay.ok).toBe(true);
    expect(store.metrics().partialSyncs).toBe(0);
    store.close();
  });

  it("HubSpot batch errors stay terminal even when HTTP status is successful", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          status: "COMPLETE",
          results: [],
          errors: [
            {
              category: "VALIDATION_ERROR",
              message: "dealstage is not a valid pipeline stage ID",
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const sink = new HubSpotSlackSink({
      mode: "live",
      hubspotAccessToken: "hs-token",
      hubspotExternalIdProperty: "gtm_router_deal_id",
      hubspotApiBase: "https://api.hubapi.com",
      hubspotPipeline: "default",
      hubspotDealstage: "appointmentscheduled",
      hubspotPortalId: undefined,
      slackBotToken: "xoxb-token",
      slackChannelId: "C123",
      slackApiBase: "https://slack.com",
      fetchImpl,
    });

    await expect(sink.upsert(routed())).rejects.toBeInstanceOf(
      TerminalSinkError,
    );
  });

  it("HubSpot 503 is retryable", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ message: "unavailable" }), {
        status: 503,
      });
    }) as unknown as typeof fetch;
    const sink = new HubSpotSlackSink({
      mode: "live",
      hubspotAccessToken: "hs-token",
      hubspotExternalIdProperty: "gtm_router_deal_id",
      hubspotApiBase: "https://api.hubapi.com",
      hubspotPipeline: "default",
      hubspotDealstage: "appointmentscheduled",
      hubspotPortalId: undefined,
      slackBotToken: "xoxb-token",
      slackChannelId: "C123",
      slackApiBase: "https://slack.com",
      fetchImpl,
    });

    await expect(sink.upsert(routed())).rejects.toBeInstanceOf(
      RetryableSinkError,
    );
  });

  it("HubSpot 401 is terminal", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ message: "bad token" }), {
        status: 401,
      });
    }) as unknown as typeof fetch;
    const sink = new HubSpotSlackSink({
      mode: "live",
      hubspotAccessToken: "hs-token",
      hubspotExternalIdProperty: "gtm_router_deal_id",
      hubspotApiBase: "https://api.hubapi.com",
      hubspotPipeline: "default",
      hubspotDealstage: "appointmentscheduled",
      hubspotPortalId: undefined,
      slackBotToken: "xoxb-token",
      slackChannelId: "C123",
      slackApiBase: "https://slack.com",
      fetchImpl,
    });

    await expect(sink.upsert(routed())).rejects.toBeInstanceOf(
      TerminalSinkError,
    );
  });

  it("doctor reports missing live env without network", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const checks = await runIntegrationDoctor({ env: {}, fetchImpl });

    expect(checks.map((check) => check.name)).toEqual([
      "HUBSPOT_ACCESS_TOKEN",
      "HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY",
      "HUBSPOT_WEBHOOK_SECRET",
      "PUBLIC_BASE_URL",
      "HUBSPOT_NOTIFY_STAGE_IDS",
      "SLACK_BOT_TOKEN",
      "SLACK_CHANNEL_ID",
    ]);
    expect(checks.every((check) => check.status === "fail")).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("doctor catches non-unique HubSpot upsert properties", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/crm/v3/properties/deals/")) {
        return new Response(
          JSON.stringify({
            name: "gtm_router_deal_id",
            label: "GTM router deal id",
            type: "string",
            fieldType: "text",
            hasUniqueValue: false,
          }),
          { status: 200 },
        );
      }
      if (String(url).includes("/crm/v3/pipelines/deals")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "default",
                label: "Sales Pipeline",
                stages: [{ id: "3695885012", label: "Lead Identified" }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, team: "Memric", user: "bot" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const checks = await runIntegrationDoctor({
      env: {
        HUBSPOT_ACCESS_TOKEN: "hs-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "client-secret",
        PUBLIC_BASE_URL: "https://router.example.com",
        HUBSPOT_NOTIFY_STAGE_IDS: "contact_made",
        HUBSPOT_DEALSTAGE: "3695885012",
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "C0123456789",
      },
      fetchImpl,
    });

    expect(checks).toContainEqual(
      expect.objectContaining({
        system: "hubspot",
        name: "unique deal property",
        status: "fail",
      }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({
        system: "slack",
        name: "test post",
        status: "warn",
      }),
    );
  });

  it("doctor can prove Slack channel membership with one test post", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes("/crm/v3/properties/deals/")) {
        return new Response(
          JSON.stringify({
            name: "gtm_router_deal_id",
            label: "GTM router deal id",
            type: "string",
            fieldType: "text",
            hasUniqueValue: true,
          }),
          { status: 200 },
        );
      }
      if (String(url).includes("/crm/v3/pipelines/deals")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "default",
                label: "Sales Pipeline",
                stages: [{ id: "3695885012", label: "Lead Identified" }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (String(url).endsWith("/api/auth.test")) {
        return new Response(JSON.stringify({ ok: true, team: "Memric", user: "bot" }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const checks = await runIntegrationDoctor({
      env: {
        HUBSPOT_ACCESS_TOKEN: "hs-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "client-secret",
        PUBLIC_BASE_URL: "https://router.example.com",
        HUBSPOT_NOTIFY_STAGE_IDS: "contact_made",
        HUBSPOT_DEALSTAGE: "3695885012",
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "C0123456789",
      },
      fetchImpl,
      sendSlackTest: true,
      now: () => new Date("2026-05-19T12:00:00Z"),
    });

    expect(calls.some((url) => url.endsWith("/api/chat.postMessage"))).toBe(true);
    expect(checks).toContainEqual(
      expect.objectContaining({
        system: "slack",
        name: "test post",
        status: "fail",
        detail: "Slack rejected post: not_in_channel",
      }),
    );
  });
});
