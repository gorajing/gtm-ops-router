import { describe, expect, it, vi } from "vitest";
import {
  HubSpotSlackSink,
  hubSpotDealPayload,
  integrationOptionsFromEnv,
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
});
