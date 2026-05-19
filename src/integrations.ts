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

export type IntegrationCheckStatus = "pass" | "warn" | "fail";

export interface IntegrationCheck {
  system: "env" | "hubspot" | "slack";
  name: string;
  status: IntegrationCheckStatus;
  detail: string;
  hint?: string;
}

export interface IntegrationDoctorOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  sendSlackTest?: boolean;
  now?: () => Date;
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

interface HubSpotPropertyResponse {
  name?: unknown;
  label?: unknown;
  type?: unknown;
  fieldType?: unknown;
  hasUniqueValue?: unknown;
}

interface SlackAuthResponse {
  ok?: unknown;
  error?: unknown;
  team?: unknown;
  user?: unknown;
  team_id?: unknown;
  user_id?: unknown;
  bot_id?: unknown;
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

function resultText(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
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

function integrationConfigFromEnv(
  mode: "dry-run" | "live",
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
): IntegrationSinkConfig {
  return {
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
}

function missingLiveEnv(
  cfg: IntegrationSinkConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  return [
    cfg.hubspotAccessToken ? "" : "HUBSPOT_ACCESS_TOKEN",
    env.HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY
      ? ""
      : "HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY",
    cfg.slackBotToken ? "" : "SLACK_BOT_TOKEN",
    env.SLACK_CHANNEL_ID ? "" : "SLACK_CHANNEL_ID",
  ].filter(Boolean);
}

function authHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

function slackApiErrorHint(code: string): string | undefined {
  if (code === "not_in_channel" || code === "no_permission") {
    return "Invite the Slack app/bot to the target channel, then rerun with --send-test.";
  }
  if (code === "channel_not_found") {
    return "Use the channel ID (starts C/G/D), not the workspace URL or channel name.";
  }
  if (code === "missing_scope") {
    return "Add the bot token scope chat:write, reinstall the app, then update SLACK_BOT_TOKEN if Slack rotated it.";
  }
  if (code === "invalid_auth" || code === "not_authed") {
    return "Use the bot token that starts xoxb- from the installed Slack app.";
  }
  return undefined;
}

function checkLine(
  system: IntegrationCheck["system"],
  name: string,
  status: IntegrationCheckStatus,
  detail: string,
  hint?: string,
): IntegrationCheck {
  return { system, name, status, detail, ...(hint ? { hint } : {}) };
}

async function checkHubSpotProperty(
  cfg: IntegrationSinkConfig,
): Promise<IntegrationCheck> {
  const token = cfg.hubspotAccessToken;
  if (!token) {
    return checkLine(
      "hubspot",
      "unique deal property",
      "fail",
      "HUBSPOT_ACCESS_TOKEN is missing",
    );
  }
  const property = encodeURIComponent(cfg.hubspotExternalIdProperty);
  const url =
    `${cfg.hubspotApiBase}/crm/properties/${cfg.hubspotApiVersion}` +
    `/deals/${property}`;
  let res: Response;
  try {
    res = await cfg.fetchImpl(url, {
      method: "GET",
      headers: authHeaders(token),
    });
  } catch (err) {
    return checkLine(
      "hubspot",
      "unique deal property",
      "fail",
      `network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const body = await parseBody(res);
  if (!res.ok) {
    const hint =
      res.status === 404
        ? "Create a custom deal property with hasUniqueValue=true, then set HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY to its internal name."
        : undefined;
    return checkLine(
      "hubspot",
      "unique deal property",
      "fail",
      `HTTP ${res.status}: ${bodyMessage(body)}`,
      hint,
    );
  }
  if (!isRecord(body)) {
    return checkLine(
      "hubspot",
      "unique deal property",
      "fail",
      "property response was not an object",
    );
  }
  const parsed = body as HubSpotPropertyResponse;
  if (parsed.hasUniqueValue === true) {
    const label = resultText(parsed.label) ?? cfg.hubspotExternalIdProperty;
    return checkLine(
      "hubspot",
      "unique deal property",
      "pass",
      `${label} (${cfg.hubspotExternalIdProperty}) is unique`,
    );
  }
  return checkLine(
    "hubspot",
    "unique deal property",
    "fail",
    `${cfg.hubspotExternalIdProperty} exists but is not unique`,
    "HubSpot cannot batch upsert by a non-unique property. Create a new unique text property and set HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY to that internal name.",
  );
}

async function checkSlackAuth(
  cfg: IntegrationSinkConfig,
): Promise<IntegrationCheck> {
  const token = cfg.slackBotToken;
  if (!token) {
    return checkLine("slack", "bot auth", "fail", "SLACK_BOT_TOKEN is missing");
  }
  let res: Response;
  try {
    res = await cfg.fetchImpl(`${cfg.slackApiBase}/api/auth.test`, {
      method: "POST",
      headers: authHeaders(token),
    });
  } catch (err) {
    return checkLine(
      "slack",
      "bot auth",
      "fail",
      `network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const body = await parseBody(res);
  if (!res.ok) {
    return checkLine(
      "slack",
      "bot auth",
      "fail",
      `HTTP ${res.status}: ${bodyMessage(body)}`,
    );
  }
  if (!isRecord(body)) {
    return checkLine(
      "slack",
      "bot auth",
      "fail",
      "auth response was not an object",
    );
  }
  const parsed = body as SlackAuthResponse;
  if (parsed.ok !== true) {
    const code = resultId(parsed.error, "unknown_error");
    return checkLine(
      "slack",
      "bot auth",
      "fail",
      `Slack rejected auth: ${code}`,
      slackApiErrorHint(code),
    );
  }
  const team =
    resultText(parsed.team) ?? resultText(parsed.team_id) ?? "workspace";
  const user = resultText(parsed.user) ?? resultText(parsed.bot_id) ?? "bot";
  return checkLine("slack", "bot auth", "pass", `${user} on ${team}`);
}

function checkSlackChannelId(channel: string): IntegrationCheck {
  if (/^[CGD][A-Z0-9]{8,}$/.test(channel)) {
    return checkLine("slack", "channel id", "pass", channel);
  }
  return checkLine(
    "slack",
    "channel id",
    "warn",
    `${channel} does not look like a Slack channel ID`,
    "Use the channel ID from Slack's channel details panel. Public channels start with C.",
  );
}

async function checkSlackPost(
  cfg: IntegrationSinkConfig,
  now: () => Date,
): Promise<IntegrationCheck> {
  const token = cfg.slackBotToken;
  if (!token) {
    return checkLine("slack", "test post", "fail", "SLACK_BOT_TOKEN is missing");
  }
  let res: Response;
  try {
    res = await cfg.fetchImpl(`${cfg.slackApiBase}/api/chat.postMessage`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({
        channel: cfg.slackChannelId,
        text:
          "gtm-ops-router integration check " +
          now().toISOString().replace(/\.\d{3}Z$/, "Z"),
      }),
    });
  } catch (err) {
    return checkLine(
      "slack",
      "test post",
      "fail",
      `network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const body = await parseBody(res);
  if (!res.ok) {
    return checkLine(
      "slack",
      "test post",
      "fail",
      `HTTP ${res.status}: ${bodyMessage(body)}`,
    );
  }
  if (!isRecord(body)) {
    return checkLine(
      "slack",
      "test post",
      "fail",
      "post response was not an object",
    );
  }
  const parsed = body as SlackPostResponse;
  if (parsed.ok !== true) {
    const code = resultId(parsed.error, "unknown_error");
    return checkLine(
      "slack",
      "test post",
      "fail",
      `Slack rejected post: ${code}`,
      slackApiErrorHint(code),
    );
  }
  return checkLine(
    "slack",
    "test post",
    "pass",
    `posted to ${resultId(parsed.channel, cfg.slackChannelId)}`,
  );
}

export async function runIntegrationDoctor(
  opts: IntegrationDoctorOptions = {},
): Promise<IntegrationCheck[]> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cfg = integrationConfigFromEnv("live", env, fetchImpl);
  const checks: IntegrationCheck[] = [];

  const missing = missingLiveEnv(cfg, env);
  if (missing.length > 0) {
    for (const name of missing) {
      checks.push(
        checkLine(
          "env",
          name,
          "fail",
          "missing",
          "Set it in .env or export it before running live integrations.",
        ),
      );
    }
    return checks;
  }
  checks.push(checkLine("env", "required variables", "pass", "all present"));

  checks.push(await checkHubSpotProperty(cfg));
  checks.push(await checkSlackAuth(cfg));
  checks.push(checkSlackChannelId(cfg.slackChannelId));
  if (opts.sendSlackTest === true) {
    checks.push(await checkSlackPost(cfg, opts.now ?? (() => new Date())));
  } else {
    checks.push(
      checkLine(
        "slack",
        "test post",
        "warn",
        "skipped",
        "Run npm run doctor -- --send-test to prove channel membership before a live demo.",
      ),
    );
  }
  return checks;
}

export function renderIntegrationChecks(checks: IntegrationCheck[]): string {
  return checks
    .map((check) => {
      const line =
        `[${check.status.toUpperCase()}] ${check.system} / ${check.name}: ` +
        check.detail;
      return check.hint ? `${line}\n        hint: ${check.hint}` : line;
    })
    .join("\n");
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
  const cfg = integrationConfigFromEnv(mode, env, fetchImpl);

  if (mode === "live") {
    const missing = missingLiveEnv(cfg, env);
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
