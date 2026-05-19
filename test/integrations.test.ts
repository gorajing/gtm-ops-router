import { describe, expect, it, vi } from "vitest";
import {
  HubSpotSlackSink,
  hubSpotDealPayload,
  integrationOptionsFromEnv,
  runIntegrationDoctor,
  slackHandoffPayload,
} from "../src/integrations.js";
import { RetryableSinkError } from "../src/sink.js";
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
    expect(payload.inputs[0]?.properties.dealname).toContain("ae.morgan");
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

  it("dry-run mode emits HubSpot and Slack receipts without network", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const built = integrationOptionsFromEnv("dry-run", {}, fetchImpl);

    const receipts = await built.sink.upsert(routed());

    expect(receipts.map((r) => r.system)).toEqual(["hubspot", "slack"]);
    expect(receipts[0]?.detail).toContain("would upsert deal");
    expect(receipts[1]?.detail).toContain("would post handoff");
    expect(fetchImpl).not.toHaveBeenCalled();
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
      hubspotApiVersion: "2026-03",
      hubspotPipeline: "default",
      hubspotDealstage: "appointmentscheduled",
      hubspotPortalId: undefined,
      slackBotToken: "xoxb-token",
      slackChannelId: "C123",
      slackApiBase: "https://slack.com",
      fetchImpl,
    });

    const receipts = await sink.upsert(routed());
    const hubspotBody = JSON.parse(String(calls[0]?.init.body));
    const slackBody = JSON.parse(String(calls[1]?.init.body));

    expect(calls[0]?.url).toContain("/crm/objects/2026-03/deals/batch/upsert");
    expect(hubspotBody.inputs[0].id).toBe("D-1");
    expect(calls[1]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(slackBody.text).toContain("HubSpot: 12345");
    expect(receipts.map((r) => r.externalId)).toEqual(["12345", "171.0001"]);
  });

  it("live mode refuses missing env instead of creating duplicate-prone writes", () => {
    expect(() => integrationOptionsFromEnv("live", {})).toThrow(
      "missing live integration env",
    );
  });

  it("Slack rate limits stay retryable", async () => {
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
      hubspotApiVersion: "2026-03",
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

  it("doctor reports missing live env without network", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const checks = await runIntegrationDoctor({ env: {}, fetchImpl });

    expect(checks.map((check) => check.name)).toEqual([
      "HUBSPOT_ACCESS_TOKEN",
      "HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY",
      "SLACK_BOT_TOKEN",
      "SLACK_CHANNEL_ID",
    ]);
    expect(checks.every((check) => check.status === "fail")).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("doctor catches non-unique HubSpot upsert properties", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/crm/properties/2026-03/deals/")) {
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
      return new Response(JSON.stringify({ ok: true, team: "Memric", user: "bot" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const checks = await runIntegrationDoctor({
      env: {
        HUBSPOT_ACCESS_TOKEN: "hs-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
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
      if (String(url).includes("/crm/properties/2026-03/deals/")) {
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
