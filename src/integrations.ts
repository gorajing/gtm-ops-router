/**
 * HubSpot + Slack integration sink.
 *
 * The default demo stays clone-and-run. Passing --integrations uses this same
 * sink in dry-run mode so reviewers can see the exact cross-system handoff
 * without credentials. Passing --live-integrations requires env vars and uses
 * real HTTP writes.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { HUBSPOT_WEBHOOK_FETCH_TIMEOUT_CAP_MS } from "./constants.js";
import {
  DEFAULT_RETRY,
  RetryableSinkError,
  SinkExhaustedError,
  TerminalSinkError,
  type OpportunitySink,
  type RetryOptions,
  type SinkReceipt,
  withRetry,
} from "./sink.js";
import type { RoutedDeal } from "./types.js";

type FetchLike = typeof fetch;
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;

export class WebhookPayloadError extends Error {}
class HubSpotDealUnmappedError extends Error {}

export interface IntegrationSinkConfig {
  mode: "dry-run" | "live";
  hubspotAccessToken: string | undefined;
  hubspotExternalIdProperty: string;
  hubspotApiBase: string;
  hubspotPipeline: string;
  hubspotDealstage: string;
  hubspotPortalId: string | undefined;
  slackBotToken: string | undefined;
  slackChannelId: string;
  slackApiBase: string;
  fetchImpl: FetchLike;
  slackRetry?: RetryOptions;
}

export interface IntegrationBuild {
  dryRun: boolean;
  sink: OpportunitySink;
  label: string;
  stageChanges: HubSpotStageChangeHandler;
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
  errors?: unknown[];
}

interface SlackPostResponse {
  ok?: unknown;
  error?: unknown;
  ts?: unknown;
  channel?: unknown;
}

interface HubSpotDealResponse {
  id?: unknown;
  properties?: Record<string, unknown>;
}

export interface HubSpotStageWebhookEvent {
  eventKey: string;
  hubspotDealId: string;
  portalId: string | null;
  eventId: string;
  propertyName: string;
  toStageId: string;
  toStageLabel: string | null;
  routerDealId: string | null;
  dealName: string | null;
  occurredAt: string;
  source: string | null;
}

interface HubSpotStageParseResult {
  events: HubSpotStageWebhookEvent[];
  dropped: number;
}

export interface ResolvedHubSpotStageChange {
  eventKey: string;
  routerDealId: string;
  hubspotDealId: string;
  portalId: string | null;
  eventId: string;
  toStageId: string;
  toStageLabel: string | null;
  dealName: string | null;
  occurredAt: string;
  source: string | null;
}

export interface HubSpotStageResolveResult {
  changes: ResolvedHubSpotStageChange[];
  droppedMalformed: number;
  droppedNoRouterId: number;
  resolveErrors: number;
}

export interface HubSpotWebhookRequest {
  method: string;
  absoluteUrl: string;
  rawBody: string;
  headers: NodeJS.Dict<string | string[] | undefined>;
  now?: () => Date;
}

interface HubSpotStageChangeConfig {
  mode: "dry-run" | "live";
  hubspotAccessToken: string | undefined;
  hubspotExternalIdProperty: string;
  hubspotApiBase: string;
  hubspotPortalId: string | undefined;
  hubspotWebhookSecret: string | undefined;
  hubspotNotifyStageIds: string[];
  slackBotToken: string | undefined;
  slackChannelId: string;
  slackApiBase: string;
  fetchImpl: FetchLike;
  allowUnsignedWebhooks: boolean;
}

interface HubSpotPropertyResponse {
  name?: unknown;
  label?: unknown;
  type?: unknown;
  fieldType?: unknown;
  hasUniqueValue?: unknown;
}

interface HubSpotPipelineResponse {
  results?: Array<{
    id?: unknown;
    label?: unknown;
    stages?: Array<{
      id?: unknown;
      label?: unknown;
      archived?: unknown;
    }>;
  }>;
}

function fetchTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.INTEGRATION_FETCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_FETCH_TIMEOUT_MS;
}

function webhookFetchTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.HUBSPOT_WEBHOOK_FETCH_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.round(raw), HUBSPOT_WEBHOOK_FETCH_TIMEOUT_CAP_MS);
  }
  return 3_000;
}

function withFetchTimeout(fetchImpl: FetchLike, timeoutMs: number): FetchLike {
  return (async (
    input: Parameters<FetchLike>[0],
    init?: Parameters<FetchLike>[1],
  ) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`fetch timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const signals = [controller.signal];
    if (init?.signal) signals.push(init.signal);
    const signal =
      signals.length === 1 ? controller.signal : AbortSignal.any(signals);
    try {
      return await fetchImpl(input, { ...init, signal });
    } finally {
      clearTimeout(timer);
    }
  }) as FetchLike;
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
    `GTM routed deal: ${escapeSlackLinkChars(deal.company)}`,
    `ARR: ${money(deal.dealUSD)} | score: ${deal.score.total.toFixed(2)} | route: ${escapeSlackLinkChars(routeSummary(deal))}`,
    `HubSpot: ${escapeSlackLinkChars(hubspot.externalId)}${
      hubspot.url ? ` (${escapeSlackLinkChars(hubspot.url)})` : ""
    }`,
    `Router id: ${escapeSlackLinkChars(deal.id)}`,
  ];
  return { channel, text: lines.join("\n") };
}

// Escape Slack's link/control delimiters. This intentionally leaves styling
// markers readable for trusted operator-controlled deal text; exposing /deals
// publicly would need auth or stricter mrkdwn escaping. Escaping <, >, and &
// blocks Slack mentions/links, while escaping backticks prevents code spans
// from bleeding across the rest of a line.
// If intake becomes public-facing, escape *_~ here too.
function escapeSlackLinkChars(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "\\`");
}

function headerValue(
  headers: NodeJS.Dict<string | string[] | undefined>,
  name: string,
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const HUBSPOT_V3_URI_DECODES: Array<[RegExp, string]> = [
  [/%3A/gi, ":"],
  [/%2F/gi, "/"],
  [/%3F/gi, "?"],
  [/%40/gi, "@"],
  [/%23/gi, "#"],
  [/%26/gi, "&"],
  [/%3D/gi, "="],
  [/%20/gi, " "],
  [/%21/gi, "!"],
  [/%24/gi, "$"],
  [/%27/gi, "'"],
  [/%28/gi, "("],
  [/%29/gi, ")"],
  [/%2A/gi, "*"],
  [/%2C/gi, ","],
  [/%3B/gi, ";"],
  [/%2D/gi, "-"],
  [/%5F/gi, "_"],
  [/%7E/gi, "~"],
];

function normalizeHubSpotV3Uri(uri: string): string {
  let normalized = uri;
  for (const [pattern, value] of HUBSPOT_V3_URI_DECODES) {
    normalized = normalized.replace(pattern, value);
  }
  return normalized;
}

export function hubSpotV3Signature(
  secret: string,
  method: string,
  absoluteUrl: string,
  rawBody: string,
  timestamp: string,
): string {
  return createHmac("sha256", secret)
    .update(
      method.toUpperCase() +
        normalizeHubSpotV3Uri(absoluteUrl) +
        rawBody +
        timestamp,
    )
    .digest("base64");
}

export function verifyHubSpotV3Signature(
  secret: string,
  request: HubSpotWebhookRequest,
): boolean {
  const signature = headerValue(request.headers, "x-hubspot-signature-v3");
  const timestamp = headerValue(request.headers, "x-hubspot-request-timestamp");
  if (!signature || !timestamp) return false;
  const timestampMs = Number(timestamp);
  if (!Number.isInteger(timestampMs)) return false;
  const now = request.now?.() ?? new Date();
  const skewMs = timestampMs - now.getTime();
  if (Math.abs(skewMs) > 300_000) return false;

  const expected = hubSpotV3Signature(
    secret,
    request.method,
    request.absoluteUrl,
    request.rawBody,
    timestamp,
  );
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(signature, "utf8");
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function bodyMessage(body: unknown): string {
  const scrub = (s: string): string =>
    s
      .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted-slack-token]")
      .replace(/\bpat-[A-Za-z0-9_-]{20,}\b/g, "[redacted-hubspot-token]")
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
  if (typeof body === "string") return scrub(body).slice(0, 500);
  try {
    return scrub(JSON.stringify(body)).slice(0, 500);
  } catch {
    return scrub(String(body));
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
  // Slack can use fatal_error for server-side failures, so retry it before
  // preserving the HubSpot write as a warning receipt.
  return [
    "ratelimited",
    "request_timeout",
    "service_unavailable",
    "internal_error",
    "fatal_error",
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
    hubspotPipeline: env.HUBSPOT_PIPELINE ?? "default",
    hubspotDealstage: env.HUBSPOT_DEALSTAGE ?? "appointmentscheduled",
    hubspotPortalId: env.HUBSPOT_PORTAL_ID,
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackChannelId: env.SLACK_CHANNEL_ID ?? "#gtm-ops-router-demo",
    slackApiBase: env.SLACK_API_BASE ?? "https://slack.com",
    fetchImpl: withFetchTimeout(fetchImpl, fetchTimeoutMs(env)),
  };
}

function csvEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function stageChangeConfigFromEnv(
  mode: "dry-run" | "live",
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike,
): HubSpotStageChangeConfig {
  const sink = integrationConfigFromEnv(mode, env, fetchImpl);
  return {
    mode,
    hubspotAccessToken: sink.hubspotAccessToken,
    hubspotExternalIdProperty: sink.hubspotExternalIdProperty,
    hubspotApiBase: sink.hubspotApiBase,
    hubspotPortalId: sink.hubspotPortalId,
    hubspotWebhookSecret: env.HUBSPOT_WEBHOOK_SECRET,
    hubspotNotifyStageIds: csvEnv(env.HUBSPOT_NOTIFY_STAGE_IDS),
    slackBotToken: sink.slackBotToken,
    slackChannelId: sink.slackChannelId,
    slackApiBase: sink.slackApiBase,
    fetchImpl: withFetchTimeout(fetchImpl, webhookFetchTimeoutMs(env)),
    allowUnsignedWebhooks: env.ALLOW_UNSIGNED_WEBHOOKS === "1",
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
    env.HUBSPOT_WEBHOOK_SECRET ? "" : "HUBSPOT_WEBHOOK_SECRET",
    env.PUBLIC_BASE_URL ? "" : "PUBLIC_BASE_URL",
    env.HUBSPOT_NOTIFY_STAGE_IDS === undefined
      ? "HUBSPOT_NOTIFY_STAGE_IDS"
      : "",
    cfg.slackBotToken ? "" : "SLACK_BOT_TOKEN",
    env.SLACK_CHANNEL_ID ? "" : "SLACK_CHANNEL_ID",
  ].filter(Boolean);
}

function invalidPublicBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol !== "https:" ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0
    );
  } catch {
    return true;
  }
}

function invalidLiveEnv(
  cfg: IntegrationSinkConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  const invalid: string[] = [];
  if (!/^[a-z][a-z0-9_]*$/i.test(cfg.hubspotExternalIdProperty)) {
    invalid.push("HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY");
  }
  if (invalidPublicBaseUrl(env.PUBLIC_BASE_URL)) {
    invalid.push("PUBLIC_BASE_URL");
  }
  if (
    csvEnv(env.HUBSPOT_NOTIFY_STAGE_IDS).length === 0
  ) {
    invalid.push("HUBSPOT_NOTIFY_STAGE_IDS (must list at least one stage id)");
  }
  if (!/^[CGD][A-Z0-9]{8,}$/.test(cfg.slackChannelId)) {
    invalid.push("SLACK_CHANNEL_ID");
  }
  return invalid;
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
  const url = `${cfg.hubspotApiBase}/crm/v3/properties/deals/${property}`;
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

async function checkHubSpotPipelineStage(
  cfg: IntegrationSinkConfig,
): Promise<IntegrationCheck> {
  const token = cfg.hubspotAccessToken;
  if (!token) {
    return checkLine(
      "hubspot",
      "pipeline stage",
      "fail",
      "HUBSPOT_ACCESS_TOKEN is missing",
    );
  }
  const url = `${cfg.hubspotApiBase}/crm/v3/pipelines/deals`;
  let res: Response;
  try {
    res = await cfg.fetchImpl(url, {
      method: "GET",
      headers: authHeaders(token),
    });
  } catch (err) {
    return checkLine(
      "hubspot",
      "pipeline stage",
      "fail",
      `network error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const body = await parseBody(res);
  if (!res.ok) {
    return checkLine(
      "hubspot",
      "pipeline stage",
      "fail",
      `HTTP ${res.status}: ${bodyMessage(body)}`,
    );
  }
  if (!isRecord(body)) {
    return checkLine(
      "hubspot",
      "pipeline stage",
      "fail",
      "pipeline response was not an object",
    );
  }

  const parsed = body as HubSpotPipelineResponse;
  const pipeline = parsed.results?.find((p) => p.id === cfg.hubspotPipeline);
  if (!pipeline) {
    return checkLine(
      "hubspot",
      "pipeline stage",
      "fail",
      `pipeline ${cfg.hubspotPipeline} was not found`,
      "Set HUBSPOT_PIPELINE to one of the pipeline IDs returned by HubSpot.",
    );
  }
  const stage = pipeline.stages?.find(
    (s) => s.id === cfg.hubspotDealstage && s.archived !== true,
  );
  if (!stage) {
    const valid = (pipeline.stages ?? [])
      .filter((s) => s.archived !== true)
      .map((s) => `${resultText(s.label) ?? "stage"}=${resultText(s.id) ?? "?"}`)
      .join(", ");
    return checkLine(
      "hubspot",
      "pipeline stage",
      "fail",
      `${cfg.hubspotDealstage} is not a valid stage in ${cfg.hubspotPipeline}`,
      valid ? `Valid stages: ${valid}` : "Check the Deals pipeline stage IDs in HubSpot.",
    );
  }
  return checkLine(
    "hubspot",
    "pipeline stage",
    "pass",
    `${resultText(pipeline.label) ?? cfg.hubspotPipeline} / ${resultText(stage.label) ?? cfg.hubspotDealstage}`,
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

  const [propertyCheck, pipelineCheck, slackAuthCheck] = await Promise.all([
    checkHubSpotProperty(cfg),
    checkHubSpotPipelineStage(cfg),
    checkSlackAuth(cfg),
  ]);
  checks.push(propertyCheck, pipelineCheck, slackAuthCheck);
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

function optionalText(v: unknown): string | null {
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function requiredText(v: unknown, name: string): string {
  const text = optionalText(v);
  if (text) return text;
  throw new TerminalSinkError(`HubSpot webhook event missing ${name}`);
}

function isoFromHubSpotMillis(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  throw new TerminalSinkError("HubSpot webhook event missing valid occurredAt");
}

function hubSpotStageEventKey(
  event: Pick<
    HubSpotStageWebhookEvent,
    | "portalId"
    | "eventId"
    | "hubspotDealId"
    | "propertyName"
    | "toStageId"
    | "occurredAt"
  >,
): string {
  return JSON.stringify([
    "hubspot",
    event.portalId ?? "unknown_portal",
    event.eventId,
    event.hubspotDealId,
    event.propertyName,
    event.toStageId,
    event.occurredAt,
  ]);
}

function parseHubSpotStageEventBatch(body: unknown): HubSpotStageParseResult {
  if (!Array.isArray(body)) {
    throw new WebhookPayloadError("HubSpot webhook body must be an array");
  }
  const events: HubSpotStageWebhookEvent[] = [];
  let dropped = 0;
  for (const item of body) {
    if (!isRecord(item)) continue;
    const propertyName = optionalText(item.propertyName);
    const subscriptionType =
      optionalText(item.subscriptionType) ?? optionalText(item.eventType);
    const objectTypeId = optionalText(item.objectTypeId);
    const isDealStage =
      propertyName === "dealstage" &&
      (subscriptionType === "deal.propertyChange" ||
        (subscriptionType === "object.propertyChange" && objectTypeId === "0-3"));
    if (!isDealStage) continue;
    try {
      const hubspotDealId = requiredText(item.objectId, "objectId");
      const portalId = optionalText(item.portalId);
      const eventId = requiredText(item.eventId, "eventId");
      const toStageId = requiredText(item.propertyValue, "propertyValue");
      const occurredAt = isoFromHubSpotMillis(item.occurredAt);
      const event: HubSpotStageWebhookEvent = {
        eventKey: hubSpotStageEventKey({
          portalId,
          eventId,
          hubspotDealId,
          propertyName,
          toStageId,
          occurredAt,
        }),
        hubspotDealId,
        portalId,
        eventId,
        propertyName,
        toStageId,
        toStageLabel:
          optionalText(item.toStageLabel) ??
          optionalText(item.stageLabel),
        routerDealId:
          optionalText(item.routerDealId) ??
          optionalText(item.gtmRouterDealId) ??
          optionalText(item.gtm_router_deal_id),
        dealName: optionalText(item.dealName) ?? optionalText(item.dealname),
        occurredAt,
        source: optionalText(item.changeSource) ?? optionalText(item.sourceId),
      };
      events.push(event);
    } catch {
      // HubSpot retries non-2xx webhook responses. A malformed item should not
      // poison the whole batch and create a retry storm for the valid items.
      dropped += 1;
      continue;
    }
  }
  return { events, dropped };
}

async function mapWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<U>(items.length);
  let next = 0;
  let aborted = false;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        if (aborted) return;
        const index = next;
        next += 1;
        if (index >= items.length) return;
        try {
          results[index] = await fn(items[index] as T);
        } catch (err) {
          aborted = true;
          throw err;
        }
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export function parseHubSpotStageEvents(body: unknown): HubSpotStageWebhookEvent[] {
  return parseHubSpotStageEventBatch(body).events;
}

export function parseHubSpotStageWebhookBatch(
  body: unknown,
): HubSpotStageParseResult {
  return parseHubSpotStageEventBatch(body);
}

export function slackStageChangePayload(
  change: ResolvedHubSpotStageChange,
  channel: string,
  hubspotPortalId: string | undefined,
): { channel: string; text: string } {
  const stage = change.toStageLabel
    ? `${change.toStageLabel} (${change.toStageId})`
    : change.toStageId;
  const hubspotUrl = hubspotPortalId
    ? `https://app.hubspot.com/contacts/${hubspotPortalId}/deal/${change.hubspotDealId}`
    : undefined;
  const lines = [
    `HubSpot deal stage changed: ${escapeSlackLinkChars(change.dealName ?? change.routerDealId)}`,
    `Stage: ${escapeSlackLinkChars(stage)}`,
    `HubSpot deal: ${escapeSlackLinkChars(change.hubspotDealId)}${
      hubspotUrl ? ` (${escapeSlackLinkChars(hubspotUrl)})` : ""
    }`,
    `Router id: ${escapeSlackLinkChars(change.routerDealId)}`,
    `When: ${escapeSlackLinkChars(change.occurredAt)}`,
  ];
  return { channel, text: lines.join("\n") };
}

export class HubSpotStageChangeHandler {
  constructor(private readonly cfg: HubSpotStageChangeConfig) {}

  get eventMode(): "dry_run" | "live" {
    return this.cfg.mode === "dry-run" ? "dry_run" : "live";
  }

  verify(request: HubSpotWebhookRequest): boolean {
    if (!this.cfg.hubspotWebhookSecret) return this.cfg.allowUnsignedWebhooks;
    return verifyHubSpotV3Signature(this.cfg.hubspotWebhookSecret, request);
  }

  async resolve(body: unknown): Promise<HubSpotStageResolveResult> {
    const parsed = parseHubSpotStageEventBatch(body);
    let droppedNoRouterId = 0;
    const stageEvents = await mapWithConcurrency(
      parsed.events,
      5,
      async (event) => {
        try {
          return event.routerDealId ? event : await this.fetchHubSpotDeal(event);
        } catch (err) {
          if (err instanceof HubSpotDealUnmappedError) return null;
          return err instanceof Error ? err : new Error(String(err));
        }
      },
    );
    const resolved: ResolvedHubSpotStageChange[] = [];
    let resolveErrors = 0;
    for (const event of stageEvents) {
      if (event instanceof Error) {
        resolveErrors += 1;
        continue;
      }
      if (!event) {
        droppedNoRouterId += 1;
        continue;
      }
      const hydrated = event;
      if (!hydrated.routerDealId) {
        droppedNoRouterId += 1;
        continue;
      }
      resolved.push({
        eventKey: hydrated.eventKey,
        routerDealId: hydrated.routerDealId,
        hubspotDealId: hydrated.hubspotDealId,
        portalId: hydrated.portalId,
        eventId: hydrated.eventId,
        toStageId: hydrated.toStageId,
        toStageLabel: hydrated.toStageLabel,
        dealName: hydrated.dealName,
        occurredAt: hydrated.occurredAt,
        source: hydrated.source,
      });
    }
    return {
      changes: resolved,
      droppedMalformed: parsed.dropped,
      droppedNoRouterId,
      resolveErrors,
    };
  }

  shouldNotify(change: ResolvedHubSpotStageChange): boolean {
    return (
      (this.cfg.mode === "dry-run" && this.cfg.hubspotNotifyStageIds.length === 0) ||
      this.cfg.hubspotNotifyStageIds.includes(change.toStageId)
    );
  }

  async notify(change: ResolvedHubSpotStageChange): Promise<SinkReceipt[]> {
    if (!this.shouldNotify(change)) return [];
    const payload = slackStageChangePayload(
      change,
      this.cfg.slackChannelId,
      this.cfg.hubspotPortalId ?? change.portalId ?? undefined,
    );
    try {
      const receipt = await this.postSlack(payload, change);
      return [receipt];
    } catch (err) {
      return [
        {
          system: "slack",
          externalId: this.cfg.slackChannelId,
          detail: `stage-change notification failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          status: "warning",
        },
      ];
    }
  }

  private async fetchHubSpotDeal(
    event: HubSpotStageWebhookEvent,
  ): Promise<HubSpotStageWebhookEvent> {
    if (this.cfg.mode === "dry-run") return event;
    const token = this.cfg.hubspotAccessToken;
    if (!token) throw new TerminalSinkError("HUBSPOT_ACCESS_TOKEN is missing");
    const url = new URL(
      `${this.cfg.hubspotApiBase}/crm/v3/objects/deals/${encodeURIComponent(
        event.hubspotDealId,
      )}`,
    );
    url.searchParams.set(
      "properties",
      [
        this.cfg.hubspotExternalIdProperty,
        "dealstage",
        "dealname",
        "amount",
      ].join(","),
    );
    let res: Response;
    try {
      res = await this.cfg.fetchImpl(url, {
        method: "GET",
        headers: authHeaders(token),
      });
    } catch (err) {
      throw new RetryableSinkError(
        `hubspot deal fetch network error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const body = await parseBody(res);
    if (res.status === 404) throw new HubSpotDealUnmappedError("hubspot deal not found");
    if (!res.ok) throw httpFailure("hubspot", res, body);
    if (!isRecord(body)) {
      throw new TerminalSinkError("hubspot deal response was not an object");
    }
    const parsed = body as HubSpotDealResponse;
    const properties = isRecord(parsed.properties) ? parsed.properties : {};
    return {
      ...event,
      routerDealId: optionalText(properties[this.cfg.hubspotExternalIdProperty]),
      dealName: event.dealName ?? optionalText(properties.dealname),
    };
  }

  private async postSlack(
    payload: { channel: string; text: string },
    change: ResolvedHubSpotStageChange,
  ): Promise<SinkReceipt> {
    if (this.cfg.mode === "dry-run") {
      return {
        system: "slack",
        externalId: this.cfg.slackChannelId,
        detail: `would post HubSpot stage change for ${change.routerDealId}`,
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
      detail: `posted stage change to ${resultId(parsed.channel, this.cfg.slackChannelId)}`,
    };
  }
}

export class HubSpotSlackSink implements OpportunitySink {
  readonly name: string;

  constructor(private readonly cfg: IntegrationSinkConfig) {
    this.name =
      cfg.mode === "live" ? "hubspot+slack" : "hubspot+slack:dry-run";
  }

  async upsert(deal: RoutedDeal): Promise<SinkReceipt[]> {
    const hubspot = await this.upsertHubSpot(deal);
    try {
      // Slack chat.postMessage has no request-level idempotency key. If Slack
      // accepts the post but the response is lost, retrying can duplicate a
      // notification. We keep retries because a missed handoff is worse for
      // this ops channel; webhook stage changes claim the event before Slack.
      const slack = await withRetry(
        () => this.postSlack(deal, hubspot),
        this.cfg.slackRetry ?? DEFAULT_RETRY,
      );
      return [hubspot, slack];
    } catch (err) {
      if (
        err instanceof SinkExhaustedError ||
        err instanceof TerminalSinkError
      ) {
        return [
          hubspot,
          {
            system: "slack",
            externalId: this.cfg.slackChannelId,
            detail: `notification failed: ${err.message}`,
            status: "warning",
          },
        ];
      }
      throw err;
    }
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
      `${this.cfg.hubspotApiBase}/crm/v3/objects/0-3/batch/upsert` +
      `?idProperty=${idProperty}`;
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
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      throw new TerminalSinkError(
        `hubspot upsert errors: ${bodyMessage(parsed.errors)}`,
      );
    }
    const first = parsed.results?.[0] ?? {};
    if (typeof first.id !== "string" || first.id.length === 0) {
      throw new TerminalSinkError("hubspot upsert response had no result");
    }
    const id = first.id;
    const urlFromBody = hubSpotUrl(this.cfg, id, first.url);
    return {
      system: "hubspot",
      externalId: id,
      // HubSpot batch upsert returns boolean { new: true } for newly created
      // records. Keep this strict so string/number-shaped API drift does not
      // invent "created" semantics.
      detail: first.new === true ? "created deal" : "upserted deal",
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
  const stageCfg = stageChangeConfigFromEnv(mode, env, fetchImpl);

  if (mode === "live") {
    const missing = missingLiveEnv(cfg, env);
    if (missing.length > 0) {
      throw new Error(`missing live integration env: ${missing.join(", ")}`);
    }
    const invalid = invalidLiveEnv(cfg, env);
    if (invalid.length > 0) {
      throw new Error(`invalid live integration env: ${invalid.join(", ")}`);
    }
  }

  const sink = new HubSpotSlackSink(cfg);
  return {
    dryRun: mode === "dry-run",
    sink,
    label: sink.name,
    stageChanges: new HubSpotStageChangeHandler(stageCfg),
  };
}
