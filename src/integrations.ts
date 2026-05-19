/**
 * HubSpot + Slack integration sink.
 *
 * The default demo stays clone-and-run. Passing --integrations uses this same
 * sink in dry-run mode so reviewers can see the exact cross-system handoff
 * without credentials. Passing --live-integrations requires env vars and uses
 * real HTTP writes.
 */

import {
  RetryableSinkError,
  TerminalSinkError,
  type OpportunitySink,
  type SinkReceipt,
} from "./sink.js";
import type { RoutedDeal } from "./types.js";

type FetchLike = typeof fetch;

export interface IntegrationSinkConfig {
  mode: "dry-run" | "live";
  hubspotAccessToken: string | undefined;
  hubspotExternalIdProperty: string;
  hubspotApiBase: string;
  hubspotApiVersion: string;
  hubspotPipeline: string;
  hubspotDealstage: string;
  hubspotPortalId: string | undefined;
  slackBotToken: string | undefined;
  slackChannelId: string;
  slackApiBase: string;
  fetchImpl: FetchLike;
}

export interface IntegrationBuild {
  dryRun: boolean;
  sink: OpportunitySink;
  label: string;
}

interface HubSpotUpsertResponse {
  results?: Array<{
    id?: unknown;
    new?: unknown;
    url?: unknown;
  }>;
}

interface SlackPostResponse {
  ok?: unknown;
  error?: unknown;
  ts?: unknown;
  channel?: unknown;
}

interface HubSpotBatchUpsertPayload {
  inputs: Array<{
    id: string;
    idProperty: string;
    objectWriteTraceId: string;
    properties: Record<string, string>;
  }>;
}

function routeSummary(deal: RoutedDeal): string {
  if (deal.route.kind !== "human_assisted") return deal.route.kind;
  const flags = [
    deal.route.financeFlag ?? "",
    deal.route.legalFlag ?? "",
  ].filter(Boolean);
  return [
    `human -> ${deal.route.salesOwner}`,
    flags.length ? `flags: ${flags.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

export function hubSpotDealPayload(
  deal: RoutedDeal,
  cfg: Pick<
    IntegrationSinkConfig,
    | "hubspotExternalIdProperty"
    | "hubspotPipeline"
    | "hubspotDealstage"
  >,
): HubSpotBatchUpsertPayload {
  return {
    inputs: [
      {
        id: deal.id,
        idProperty: cfg.hubspotExternalIdProperty,
        objectWriteTraceId: deal.id,
        properties: {
          [cfg.hubspotExternalIdProperty]: deal.id,
          dealname: `${deal.company} - ${routeSummary(deal)}`,
          amount: String(Math.round(deal.dealUSD)),
          pipeline: cfg.hubspotPipeline,
          dealstage: cfg.hubspotDealstage,
        },
      },
    ],
  };
}

export function slackHandoffPayload(
  deal: RoutedDeal,
  channel: string,
  hubspot: SinkReceipt,
): { channel: string; text: string } {
  const lines = [
    `GTM routed deal: ${deal.company}`,
    `ARR: ${money(deal.dealUSD)} | score: ${deal.score.total.toFixed(2)} | route: ${routeSummary(deal)}`,
    `HubSpot: ${hubspot.externalId}${hubspot.url ? ` (${hubspot.url})` : ""}`,
    `Router id: ${deal.id}`,
  ];
  return { channel, text: lines.join("\n") };
}

function bodyMessage(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 500);
  try {
    return JSON.stringify(body).slice(0, 500);
  } catch {
    return String(body);
  }
}

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.trim().length === 0) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function httpFailure(system: string, res: Response, body: unknown): Error {
  const msg = `${system} HTTP ${res.status}: ${bodyMessage(body)}`;
  if (res.status === 408 || res.status === 429 || res.status >= 500) {
    return new RetryableSinkError(msg);
  }
  return new TerminalSinkError(msg);
}

function isRetryableSlackError(code: string): boolean {
  return [
    "ratelimited",
    "request_timeout",
    "service_unavailable",
    "fatal_error",
    "internal_error",
  ].includes(code);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function resultId(v: unknown, fallback: string): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function hubSpotUrl(
  cfg: IntegrationSinkConfig,
  id: string,
  rawUrl: unknown,
): string | undefined {
  if (typeof rawUrl === "string" && rawUrl.length > 0) return rawUrl;
  if (cfg.hubspotPortalId) {
    return `https://app.hubspot.com/contacts/${cfg.hubspotPortalId}/deal/${id}`;
  }
  return undefined;
}

export class HubSpotSlackSink implements OpportunitySink {
  readonly name: string;

  constructor(private readonly cfg: IntegrationSinkConfig) {
    this.name =
      cfg.mode === "live" ? "hubspot+slack" : "hubspot+slack:dry-run";
  }

  async upsert(deal: RoutedDeal): Promise<SinkReceipt[]> {
    const hubspot = await this.upsertHubSpot(deal);
    const slack = await this.postSlack(deal, hubspot);
    return [hubspot, slack];
  }

  private async upsertHubSpot(deal: RoutedDeal): Promise<SinkReceipt> {
    const payload = hubSpotDealPayload(deal, this.cfg);
    if (this.cfg.mode === "dry-run") {
      return {
        system: "hubspot",
        externalId: deal.id,
        detail:
          `would upsert deal by ${this.cfg.hubspotExternalIdProperty} ` +
          `(${deal.company}, ${money(deal.dealUSD)})`,
      };
    }

    const token = this.cfg.hubspotAccessToken;
    if (!token) throw new TerminalSinkError("HUBSPOT_ACCESS_TOKEN is missing");
    const idProperty = encodeURIComponent(this.cfg.hubspotExternalIdProperty);
    const url =
      `${this.cfg.hubspotApiBase}/crm/objects/${this.cfg.hubspotApiVersion}` +
      `/deals/batch/upsert?idProperty=${idProperty}`;
    let res: Response;
    try {
      res = await this.cfg.fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw new RetryableSinkError(
        `hubspot network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const body = await parseBody(res);
    if (!res.ok) throw httpFailure("hubspot", res, body);
    if (!isRecord(body)) {
      throw new TerminalSinkError("hubspot response was not an object");
    }
    const parsed = body as HubSpotUpsertResponse;
    const first = parsed.results?.[0] ?? {};
    const id = resultId(first.id, deal.id);
    const urlFromBody = hubSpotUrl(this.cfg, id, first.url);
    return {
      system: "hubspot",
      externalId: id,
      detail: `${first.new === true ? "created" : "upserted"} deal`,
      ...(urlFromBody ? { url: urlFromBody } : {}),
    };
  }

  private async postSlack(
    deal: RoutedDeal,
    hubspot: SinkReceipt,
  ): Promise<SinkReceipt> {
    const payload = slackHandoffPayload(deal, this.cfg.slackChannelId, hubspot);
    if (this.cfg.mode === "dry-run") {
      return {
        system: "slack",
        externalId: this.cfg.slackChannelId,
        detail: `would post handoff message for ${deal.company}`,
      };
    }

    const token = this.cfg.slackBotToken;
    if (!token) throw new TerminalSinkError("SLACK_BOT_TOKEN is missing");
    let res: Response;
    try {
      res = await this.cfg.fetchImpl(
        `${this.cfg.slackApiBase}/api/chat.postMessage`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(payload),
        },
      );
    } catch (err) {
      throw new RetryableSinkError(
        `slack network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const body = await parseBody(res);
    if (!res.ok) throw httpFailure("slack", res, body);
    if (!isRecord(body)) {
      throw new TerminalSinkError("slack response was not an object");
    }
    const parsed = body as SlackPostResponse;
    if (parsed.ok !== true) {
      const code = resultId(parsed.error, "unknown_error");
      const msg = `slack API error: ${code}`;
      if (isRetryableSlackError(code)) throw new RetryableSinkError(msg);
      throw new TerminalSinkError(msg);
    }
    return {
      system: "slack",
      externalId: resultId(parsed.ts, this.cfg.slackChannelId),
      detail: `posted handoff to ${resultId(parsed.channel, this.cfg.slackChannelId)}`,
    };
  }
}

export function integrationOptionsFromEnv(
  mode: "off" | "dry-run" | "live",
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): IntegrationBuild {
  if (mode === "off") {
    throw new Error("integrationOptionsFromEnv cannot build mode=off");
  }
  const cfg: IntegrationSinkConfig = {
    mode,
    hubspotAccessToken: env.HUBSPOT_ACCESS_TOKEN,
    hubspotExternalIdProperty:
      env.HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY ?? "gtm_router_deal_id",
    hubspotApiBase: env.HUBSPOT_API_BASE ?? "https://api.hubapi.com",
    hubspotApiVersion: env.HUBSPOT_API_VERSION ?? "2026-03",
    hubspotPipeline: env.HUBSPOT_PIPELINE ?? "default",
    hubspotDealstage: env.HUBSPOT_DEALSTAGE ?? "appointmentscheduled",
    hubspotPortalId: env.HUBSPOT_PORTAL_ID,
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackChannelId: env.SLACK_CHANNEL_ID ?? "#gtm-ops-router-demo",
    slackApiBase: env.SLACK_API_BASE ?? "https://slack.com",
    fetchImpl,
  };

  if (mode === "live") {
    const missing = [
      cfg.hubspotAccessToken ? "" : "HUBSPOT_ACCESS_TOKEN",
      env.HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY
        ? ""
        : "HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY",
      cfg.slackBotToken ? "" : "SLACK_BOT_TOKEN",
      env.SLACK_CHANNEL_ID ? "" : "SLACK_CHANNEL_ID",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`missing live integration env: ${missing.join(", ")}`);
    }
  }

  const sink = new HubSpotSlackSink(cfg);
  return {
    dryRun: false,
    sink,
    label: sink.name,
  };
}
