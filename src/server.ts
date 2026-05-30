/**
 * Minimal HTTP surface, intentionally framework-free:
 *
 *   GET  /                    operator console
 *   GET  /state               current SQLite-backed operating state
 *   GET  /integration-health  HubSpot + Slack doctor checks
 *   GET  /metrics             metrics as JSON
 *   GET  /healthz             liveness
 *   POST /preview             validate/enrich/score/route without persistence
 *   POST /deals               ingest one deal or an array
 *   POST /webhooks/hubspot    receive HubSpot dealstage changes
 *   POST /enrichment-observations local-only manual company evidence
 *   POST /quarantine-replay   local-only replay after enrichment repair
 *   POST /agent-suggestions   local-only agent draft ledger
 *   POST /agent-suggestions/:id/decision
 *   POST /agent-suggestion-runs/policy-evaluation
 *   POST /agent-suggestion-runs/work-items
 *   POST /work-items          local-only role-queue work item ledger
 *   POST /work-items/:id/action
 *
 * This is a local/operator-console surface. Put auth in front of it before
 * exposing it beyond localhost or a trusted internal network.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  computeEngagementAttribution,
  type EngagementAttribution,
} from "./attribution.js";
import {
  ENRICHMENT_FACT_MAX_AGE_DAYS,
  ENRICHMENT_FACT_MIN_CONFIDENCE,
  MAX_FUTURE_SKEW_MS,
} from "./constants.js";
import { enrichmentSubjectKey, type Enricher } from "./enrich.js";
import {
  type FallbackNotificationHandler,
  type HubSpotStageChangeHandler,
  type IntegrationCheck,
  type ReadinessNotificationHandler,
  type ResolvedHubSpotStageChange,
  type TerminalDriftNotificationHandler,
  WebhookPayloadError,
  runIntegrationDoctor,
} from "./integrations.js";
import { normalize } from "./intake.js";
import { enrichWithGate, processBatch, scoreAndRoute } from "./pipeline.js";
import type { PipelineOptions } from "./pipeline.js";
import {
  DEFAULT_RETRY,
  LoggingSink,
  SinkExhaustedError,
  TerminalSinkError,
  withRetry,
  type SinkReceipt,
} from "./sink.js";
import type { Store } from "./store.js";
import type {
  AgentSuggestionRecord,
  Deal,
  DeploymentReadinessState,
  Enrichment,
  EnrichedSubjectFacts,
  CommercialTerminalDriftAlertClaim,
  CommercialTerminalDriftAlertRetryCandidate,
  Metrics,
  PolicyEvaluationReports,
  PolicyRecommendationRunRecord,
  Quarantine,
  ReadinessFallbackNotificationClaim,
  ReadinessNotificationClaim,
  RoleQueueItem,
  RoleQueues,
  RoleQueueKind,
  RoutedDeal,
  WorkItemRecord,
} from "./types.js";
import {
  AgentSuggestionKind,
  AgentSuggestionDecision,
  CommercialState,
  OutcomeReasonCategory,
  OutcomeState,
  ROLE_QUEUE_KINDS,
  WorkItemAction,
} from "./types.js";

const MAX_BODY_BYTES = 1_000_000;
const STATE_DEAL_LIMIT = 200;
const STATE_EXCEPTION_LIMIT = 100;
const STATE_EVENTS_PER_DEAL = 50;
const STATE_ROLE_QUEUE_LIMIT = 50;
const STATE_AGENT_SUGGESTION_LIMIT = 50;
const STATE_POLICY_RECOMMENDATION_RUN_LIMIT = 25;
const STATE_WORK_ITEM_LIMIT = 50;
const MAX_MANUAL_ENRICHMENT_EMPLOYEES = 10_000_000;
// Dashboard client assets, read lazily on first request (not at module load) so
// commands that don't serve the dashboard — demo, doctor, run — don't depend on
// these files merely by importing this module. Cached after first read.
let dashboardAssetCache: { js: string; css: string } | undefined;
function dashboardAssets(): { js: string; css: string } {
  if (!dashboardAssetCache) {
    const dir = fileURLToPath(new URL("../public/", import.meta.url));
    dashboardAssetCache = {
      js: readFileSync(`${dir}dashboard.js`, "utf8"),
      css: readFileSync(`${dir}dashboard.css`, "utf8"),
    };
  }
  return dashboardAssetCache;
}
// Local-console cache only. Mutating handlers invalidate after successful
// processing; failed writes do not thrash the dashboard read cache.
const STATE_CACHE_TTL_MS = 1_000;
const HEALTH_TTL_MS = 35_000;
const MAX_BATCH_DEALS = 250;
const MAX_LIVE_BATCH_DEALS = 5;
const LOCAL_ENDPOINT_SECRET_HEADER = "x-local-endpoint-secret";
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_SERVER_HOST = "127.0.0.1";
const MIN_LOCAL_ENDPOINT_SECRET_LENGTH = 32;
const LOCAL_ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const LIVE_INTENT_ENV = [
  "HUBSPOT_ACCESS_TOKEN",
  "HUBSPOT_WEBHOOK_SECRET",
  "HUBSPOT_PORTAL_ID",
  "PUBLIC_BASE_URL",
  "SLACK_BOT_TOKEN",
  "SLACK_CHANNEL_ID",
  "SLACK_DEPLOYMENT_CHANNEL_ID",
] as const;
// Failed checks back off longer to avoid hammering Slack/HubSpot during an outage.
const HEALTH_FAILURE_TTL_MS = 120_000;

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function routeKindLabel(d: RoutedDeal): string {
  return d.route.kind;
}

function routeReason(d: RoutedDeal): string {
  if (d.route.kind === "nurture") return d.route.reason;
  if (d.route.kind === "self_serve") {
    return `${d.route.queue}, ${d.route.slaHours}h SLA`;
  }
  return [
    `owner ${d.route.salesOwner}`,
    d.route.financeFlag ?? "",
    d.route.legalFlag ?? "",
  ]
    .filter(Boolean)
    .join(" | ");
}

interface ConsoleDeal {
  id: string;
  company: string;
  stage: "routed" | "quarantined";
  amount: number;
  route: string;
  reason: string;
  status: "synced" | "partial" | "dry_run" | "needs_review" | "quarantined";
  updatedAt: string;
  externalStage?: {
    system: "hubspot";
    externalId: string;
    stageId: string;
    stageLabel: string | null;
    updatedAt: string;
  } | null;
  scoreTotal?: number;
  scoreNotes?: string[];
  sourceChannel?: string;
  statedNeed?: string;
  enrichmentSubjectKey?: string;
  enrichmentFacts?: EnrichedSubjectFacts | null;
  quarantine?: Quarantine;
  sinkReplayMode?: "stored_route" | "rederive_route";
}

interface ConsoleState {
  metrics: Metrics;
  sinkLabel: string;
  integrity: {
    ok: boolean;
    detail: string;
  };
  queue: ConsoleDeal[];
  exceptions: Quarantine[];
  deploymentReadiness: DeploymentReadinessState[];
  agentSuggestions: AgentSuggestionRecord[];
  workItems: WorkItemRecord[];
  roleQueues: RoleQueues;
  roleQueueLimit: number;
  policyEvaluation: PolicyEvaluationReports;
  policyRecommendationRuns: PolicyRecommendationRunRecord[];
  engagementAttribution: EngagementAttribution;
}

type PreviewResult =
  | { ok: true; deal: RoutedDeal }
  | { ok: false; stage: "intake" | "enriched"; reason: string };

const CANONICAL_UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function parseCanonicalOccurredAt(value: string): Date | null {
  if (!CANONICAL_UTC_ISO.test(value)) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString() === value ? parsed : null;
}

function resolveCanonicalTimestamp(
  value: string | undefined,
): { value: string; date: Date } | null {
  const resolved = value ?? new Date().toISOString();
  const date = parseCanonicalOccurredAt(resolved);
  return date ? { value: resolved, date } : null;
}

function defaultEnrichmentExpiresAt(observedAt: string): string {
  return new Date(
    Date.parse(observedAt) + ENRICHMENT_FACT_MAX_AGE_DAYS * 86_400_000,
  ).toISOString();
}

const CanonicalUtcIsoString = z.string().refine(
  (value) => parseCanonicalOccurredAt(value) !== null,
  "must be a canonical UTC ISO timestamp",
);

const LocalCommercialStateBody = z.object({
  dealId: z.string().min(1),
  commercialState: CommercialState,
  sourceEventId: z.string().regex(UUID_V4, "sourceEventId must be UUIDv4"),
  reason: z.string().min(1).max(500).optional(),
  expectedRedPath: z.boolean().optional(),
  occurredAt: CanonicalUtcIsoString,
});

const LocalDeploymentFactsBody = z.object({
  dealId: z.string().min(1),
  sourceEventId: z.string().regex(UUID_V4, "sourceEventId must be UUIDv4"),
  useCaseClear: z.boolean(),
  integrationsKnown: z.boolean(),
  dataReady: z.boolean(),
  operator: z.string().trim().min(1).max(120),
  occurredAt: CanonicalUtcIsoString,
});

const LocalOutcomeBody = z.object({
  dealId: z.string().min(1),
  sourceEventId: z.string().regex(UUID_V4, "sourceEventId must be UUIDv4"),
  outcome: OutcomeState,
  occurredAt: CanonicalUtcIsoString,
  operator: z.string().trim().min(1).max(120),
  arrDeltaUsd: z.number().int("arrDeltaUsd must be an integer").optional(),
  reasonCategory: OutcomeReasonCategory.optional(),
});

const LocalEnrichmentObservationBody = z.object({
  subjectKey: z.string().trim().toLowerCase().min(1).max(253),
  sourceEventId: z.string().regex(UUID_V4, "sourceEventId must be UUIDv4"),
  observedAt: CanonicalUtcIsoString.optional(),
  expiresAt: CanonicalUtcIsoString.optional(),
  employees: z
    .number()
    .int("employees must be an integer")
    .min(1)
    .max(MAX_MANUAL_ENRICHMENT_EMPLOYEES),
  industry: z.string().trim().min(1).max(120),
  techSignals: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  regulated: z.boolean(),
  confidence: z.number().min(0).max(1),
  operator: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).optional(),
});

const LocalQuarantineReplayBody = z.object({
  dealId: z.string().trim().min(1),
  contactName: z.string().trim().min(1).max(120),
  contactEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email("contactEmail must be a valid email"),
  operator: z.string().trim().min(1).max(120),
  reason: z.string().trim().max(500).optional(),
});

const LocalAgentSuggestionBody = z.object({
  dealId: z.string().trim().min(1),
  sourceEventId: z.string().regex(UUID_V4, "sourceEventId must be UUIDv4"),
  kind: AgentSuggestionKind,
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(4000),
  rationale: z.string().trim().min(1).max(1000),
  createdBy: z.string().trim().min(1).max(120),
  occurredAt: CanonicalUtcIsoString,
});

const LocalAgentSuggestionDecisionBody = z.object({
  sourceEventId: z.string().regex(UUID_V4, "sourceEventId must be UUIDv4"),
  decision: AgentSuggestionDecision,
  humanPrincipal: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000),
  occurredAt: CanonicalUtcIsoString.optional(),
});

const LocalWorkItemBody = z.object({
  dealId: z.string().trim().min(1),
  queue: z.enum(ROLE_QUEUE_KINDS),
  sourceEventId: z.string().regex(UUID_V4, "sourceEventId must be UUIDv4"),
  owner: z.string().trim().min(1).max(120),
  createdBy: z.string().trim().min(1).max(120),
  occurredAt: CanonicalUtcIsoString.optional(),
  dueAt: CanonicalUtcIsoString.optional(),
  reason: z.string().trim().max(500).optional(),
});

const LocalWorkItemActionBody = z.object({
  sourceEventId: z.string().regex(UUID_V4, "sourceEventId must be UUIDv4"),
  action: WorkItemAction,
  humanPrincipal: z.string().trim().min(1).max(120),
  occurredAt: CanonicalUtcIsoString.optional(),
  owner: z.string().trim().min(1).max(120).optional(),
  reason: z.string().trim().min(1).max(500),
});

const LocalPolicyRecommendationRunBody = z.object({
  createdBy: z.string().trim().min(1).max(120),
  evaluatedAt: CanonicalUtcIsoString.optional(),
  limit: z.number().int().min(1).max(25).optional(),
});

const LocalWorkItemSuggestionRunBody = LocalPolicyRecommendationRunBody;

const NotificationRetryBody = z.object({
  dealId: z.string().min(1).optional(),
  fingerprint: z.string().min(1).optional(),
  alertKey: z.string().min(1).optional(),
  limit: z.number().int().optional(),
});

function unreachableStatus(status: never): never {
  throw new Error(`unhandled local endpoint status: ${String(status)}`);
}

function quarantineCompany(q: Quarantine, intakeLabels: Map<string, string>): string {
  const intake = intakeLabels.get(q.dealId);
  if (intake) return intake;
  if (q.code === "schema_invalid") return "(unrecognized record)";
  return q.dealId;
}

function buildState(store: Store, sinkLabel: string): ConsoleState {
  const metrics = store.metrics();
  const routed = store.routedRecords(STATE_DEAL_LIMIT);
  const quarantined = store.quarantinedRecords(STATE_EXCEPTION_LIMIT);
  const now = new Date().toISOString();
  const routedWithSubjectKeys = routed.map((record) => ({
    record,
    subjectKey: enrichmentSubjectKey(record.deal),
  }));
  const quarantinedWithSubjectKeys = quarantined.map((record) => ({
    record,
    subjectKey: record.deal ? enrichmentSubjectKey(record.deal) : null,
  }));
  // Enrichment projections are company-only in this slice. Quarantined records
  // with a normalized deal payload can now show repair evidence too.
  const enrichmentFacts = store.enrichedSubjectFactsForKeys(
    "company",
    [
      ...new Set([
        ...routedWithSubjectKeys.map(({ subjectKey }) => subjectKey),
        ...quarantinedWithSubjectKeys.flatMap(({ subjectKey }) =>
          subjectKey ? [subjectKey] : [],
        ),
      ]),
    ],
    now,
  );
  const quarantineLabels = store.intakeLabels(
    quarantined.map((record) => record.quarantine.dealId),
  );

  const routedQueue: ConsoleDeal[] = routedWithSubjectKeys.map(({ record, subjectKey }) => {
    const { deal, updatedAt, sinkStatus, externalStage } = record;
    return {
      id: deal.id,
      company: deal.company,
      stage: "routed",
      amount: deal.dealUSD,
      route: routeKindLabel(deal),
      reason: routeReason(deal),
      status: sinkStatus,
      updatedAt,
      externalStage,
      scoreTotal: deal.score.total,
      scoreNotes: deal.score.notes,
      sourceChannel: deal.sourceChannel,
      statedNeed: deal.statedNeed,
      enrichmentSubjectKey: subjectKey,
      enrichmentFacts: enrichmentFacts.get(subjectKey) ?? null,
    };
  });
  const quarantinedQueue: ConsoleDeal[] = quarantinedWithSubjectKeys.map(
    ({ record, subjectKey }) => {
      const { quarantine, deal, updatedAt, externalStage } = record;
      return {
        id: quarantine.dealId,
        company: deal?.company ?? quarantineCompany(quarantine, quarantineLabels),
        stage: "quarantined",
        amount: deal?.dealUSD ?? 0,
        route: "-",
        reason: quarantine.code,
        status: "quarantined",
        updatedAt,
        quarantine,
        externalStage,
        ...(quarantine.code === "sink_terminal" ||
        quarantine.code === "sink_exhausted"
          ? {
              sinkReplayMode:
                record.routedDeal !== null ? "stored_route" : "rederive_route",
            }
          : {}),
        enrichmentFacts: subjectKey ? enrichmentFacts.get(subjectKey) ?? null : null,
        ...(deal
          ? {
              sourceChannel: deal.sourceChannel,
            }
          : {}),
        ...(subjectKey ? { enrichmentSubjectKey: subjectKey } : {}),
      };
    },
  );
  const queue = [...routedQueue, ...quarantinedQueue].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const integrity = store.integrity();
  const deploymentReadiness = store.deploymentReadinessRecords(now);

  return {
    metrics,
    sinkLabel,
    integrity,
    queue,
    exceptions: quarantined.map((record) => record.quarantine),
    deploymentReadiness,
    agentSuggestions: store.agentSuggestions(STATE_AGENT_SUGGESTION_LIMIT),
    workItems: store.workItems(STATE_WORK_ITEM_LIMIT),
    roleQueues: store.roleQueues(STATE_ROLE_QUEUE_LIMIT, deploymentReadiness),
    roleQueueLimit: STATE_ROLE_QUEUE_LIMIT,
    policyEvaluation: store.policyEvaluation(
      STATE_ROLE_QUEUE_LIMIT,
      deploymentReadiness,
      now,
    ),
    policyRecommendationRuns: store.policyRecommendationRuns(
      STATE_POLICY_RECOMMENDATION_RUN_LIMIT,
    ),
    engagementAttribution: computeEngagementAttribution(store),
  };
}

async function previewDeal(
  raw: unknown,
  enricher: Enricher,
): Promise<PreviewResult> {
  const intake = normalize(raw);
  if (!intake.ok) {
    return { ok: false, stage: "intake", reason: intake.reason };
  }
  const enrichment = await enrichWithGate(intake.deal, enricher);
  if (!enrichment.ok) {
    return { ok: false, stage: "enriched", reason: enrichment.reason };
  }
  return { ok: true, deal: scoreAndRoute(intake.deal, enrichment.enrichment) };
}

function consoleHtml(sinkLabel: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GTM Ops Router</title>
<link rel="stylesheet" href="/dashboard.css"></head><body>
<div class="shell">
<header>
 <div>
  <h1>GTM Ops Router</h1>
  <div class="sub">Inbound deal operations across sales, finance, legal, HubSpot, and Slack.</div>
 </div>
 <div class="stamp">SINK ${escapeHtml(sinkLabel)}<br><span id="last-refresh">loading</span></div>
</header>
<div class="action-status" id="url-pin-status"></div>
<div class="top">
 <section class="panel">
  <h2>Operating State</h2>
  <div class="kpis" id="kpis"></div>
 </section>
 <section class="panel">
  <h2>Integration Health</h2>
  <div class="health" id="health"><div class="empty">Checking...</div></div>
 </section>
</div>
<section class="panel workflow-panel">
 <div class="workflow-head">
  <h2>Operator Workflow</h2>
  <button type="button" class="secondary" id="workflow-mode" hidden>Guided</button>
 </div>
 <div id="workflow-guide"><div class="empty">Loading workflow...</div></div>
</section>
<div class="layout">
 <section class="panel">
  <h2>New Deal Intake</h2>
  <form class="form" id="deal-form">
   <label>Company<input name="company" value="CargoLoop Operator Console"></label>
   <label>Domain<input name="domain" value="cargoloop.io"></label>
   <div class="two">
    <label>Contact<input name="contactName" value="Maya Chen"></label>
    <label>Email<input name="contactEmail" value="maya.chen@cargoloop.io"></label>
   </div>
   <div class="two">
    <label>Deal USD<input name="dealUSD" type="number" min="0" step="1000" value="185000"></label>
    <label>Region<select name="region"><option>NA</option><option>EU</option><option>UK</option><option>APAC</option><option>LATAM</option></select></label>
   </div>
   <label>Source<select name="sourceChannel"><option>website_chat</option><option>inbound_form</option><option>referral</option><option>event</option><option>cold_reply</option></select></label>
   <label>Stated Need<textarea name="statedNeed">AI voice workers to automate freight appointment scheduling and exception follow-up across sales, finance, and legal handoffs</textarea></label>
   <div class="actions">
    <button type="button" id="preview-btn">Preview Route</button>
    <button type="submit" id="submit-btn">Submit + Sync</button>
    <button type="button" class="secondary" id="refresh-btn">Refresh</button>
   </div>
   <div class="preview" id="preview">No preview yet.</div>
  </form>
 </section>
 <section class="panel">
  <h2>Active Deal Queue</h2>
  <div class="queue-wrap" id="queue"></div>
  <div class="section">
   <h2>Role Queues</h2>
   <div class="handoff-wrap" id="role-queues"></div>
  </div>
  <div class="section">
   <h2>Work Items</h2>
   <div class="action-status" id="work-item-action-status"></div>
   <div class="handoff-wrap" id="work-items"></div>
  </div>
  <div class="section">
   <h2>Policy Evaluation</h2>
   <div class="handoff-wrap" id="policy-evaluation"></div>
  </div>
  <div class="section">
   <h2>Recent Policy Runs</h2>
   <div class="handoff-wrap" id="policy-runs"></div>
  </div>
  <div class="section">
   <h2>Agent Suggestions</h2>
   <div class="mini-form">
    <label>Local Secret<input id="local-secret" type="password" autocomplete="off" placeholder="LOCAL_ENDPOINT_SECRET"></label>
    <div class="actions">
     <button type="button" class="secondary" id="draft-policy-btn">Draft Policy Recommendations</button>
     <button type="button" class="secondary" id="draft-work-item-btn">Draft Work Item Actions</button>
    </div>
    <div class="action-status" id="agent-action-status"></div>
   </div>
   <div class="handoff-wrap" id="agent-suggestions"></div>
  </div>
  <div class="section">
   <h2>Exceptions Inbox</h2>
   <div class="exceptions" id="exceptions"></div>
  </div>
  <div class="section">
   <h2>Deployment Handoff</h2>
   <div class="handoff-wrap" id="deployment-handoff"></div>
  </div>
 </section>
 <section class="panel">
  <h2>Deal Detail</h2>
  <div class="detail" id="detail"><div class="empty">Select a deal.</div></div>
 </section>
</div>
<div class="footer">State is loaded from SQLite. Integration health is loaded from the same doctor used by the CLI.</div>
<dialog id="decision-dialog">
 <form method="dialog" class="dialog-body">
  <h3 id="decision-dialog-title">Decide suggestion</h3>
  <div class="dialog-detail" id="decision-dialog-detail"></div>
  <div class="dialog-detail" id="decision-dialog-meta"></div>
  <div class="dialog-caption">Draft</div>
  <div class="dialog-draft" id="decision-dialog-body"></div>
  <div class="dialog-caption">Rationale</div>
  <div class="dialog-detail" id="decision-dialog-rationale"></div>
  <label>Decision reason<textarea id="decision-dialog-reason" rows="3"></textarea></label>
  <div class="inline-actions">
   <button type="submit" value="confirm" id="decision-dialog-confirm">Confirm</button>
   <button type="submit" value="cancel" class="secondary">Cancel</button>
  </div>
 </form>
</dialog>
</div>
<script>window.__DASH__={maxManualEnrichmentEmployees:${MAX_MANUAL_ENRICHMENT_EMPLOYEES},roleQueueKinds:${JSON.stringify(ROLE_QUEUE_KINDS)}};</script><script src="/dashboard.js"></script>
</body></html>`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(
  res: ServerResponse,
  code: number,
  body: unknown,
  head = false,
): void {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(s)),
  });
  res.end(head ? undefined : s);
}

function parseJsonBody(raw: string): unknown {
  return JSON.parse(raw);
}

function sendBodyError(res: ServerResponse, err: unknown): void {
  const tooLarge = err instanceof Error && err.message === "request body too large";
  json(res, tooLarge ? 413 : 400, {
    error: tooLarge ? "request body too large" : "body is not valid JSON",
  });
}

function acceptsJsonBody(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  return typeof contentType === "string"
    ? contentType.toLowerCase().split(";")[0]?.trim() === "application/json"
    : false;
}

function rejectNonJson(res: ServerResponse): void {
  json(res, 415, { error: "content-type must be application/json" });
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

type HealthLoader = () => Promise<IntegrationCheck[]>;

interface ServerOptions {
  pipelineOptions?: Partial<PipelineOptions>;
  sinkLabel?: string;
  liveIntegrations?: boolean;
  stageChanges?: HubSpotStageChangeHandler;
  readinessNotifications?: ReadinessNotificationHandler;
  fallbackNotifications?: FallbackNotificationHandler;
  terminalDriftNotifications?: TerminalDriftNotificationHandler;
}

interface RequestUrlOptions {
  publicBaseUrl: string | undefined;
  trustProxy: boolean;
}

interface LocalWriteEndpointOptions {
  enabled: boolean;
  secret: string | null;
  allowExpectedRedPaths: boolean;
  configuredPort: number;
}

function envFlag(name: string): boolean {
  return process.env[name] === "1";
}

function hasLiveIntegrationIntent(options: ServerOptions): boolean {
  return (
    options.liveIntegrations === true ||
    LIVE_INTENT_ENV.some((name) => {
      const value = process.env[name];
      return typeof value === "string" && value.length > 0;
    })
  );
}

function localWriteEndpointOptions(
  options: ServerOptions,
  configuredPort: number,
): LocalWriteEndpointOptions {
  const enabled = envFlag("ALLOW_LOCAL_WRITE_ENDPOINTS");
  const allowExpectedRedPaths = envFlag("ALLOW_EXPECTED_RED_PATHS");
  const liveIntent = hasLiveIntegrationIntent(options);

  if (allowExpectedRedPaths && liveIntent) {
    throw new Error(
      "ALLOW_EXPECTED_RED_PATHS is only allowed in local/demo mode",
    );
  }
  if (!enabled) {
    return {
      enabled: false,
      secret: null,
      allowExpectedRedPaths,
      configuredPort,
    };
  }
  if (liveIntent) {
    throw new Error(
      "ALLOW_LOCAL_WRITE_ENDPOINTS cannot be enabled with live HubSpot/Slack integration intent",
    );
  }
  if (envFlag("TRUST_PROXY")) {
    throw new Error("ALLOW_LOCAL_WRITE_ENDPOINTS cannot be used with TRUST_PROXY=1");
  }

  const secret = process.env.LOCAL_ENDPOINT_SECRET;
  if (!secret || secret.length < MIN_LOCAL_ENDPOINT_SECRET_LENGTH) {
    throw new Error(
      `LOCAL_ENDPOINT_SECRET must be at least ${MIN_LOCAL_ENDPOINT_SECRET_LENGTH} characters when local write endpoints are enabled`,
    );
  }

  return {
    enabled: true,
    secret,
    allowExpectedRedPaths,
    configuredPort,
  };
}

function defaultReadinessNotifications(): ReadinessNotificationHandler {
  return {
    eventMode: "dry_run",
    async notify(claim: ReadinessNotificationClaim) {
      return [
        {
          system: "slack",
          externalId: "readiness:dry-run",
          detail: `would post redacted deployment readiness handoff for ${claim.dealId}`,
        },
      ];
    },
  };
}

function defaultFallbackNotifications(): FallbackNotificationHandler {
  return {
    eventMode: "dry_run",
    async notify(claim: ReadinessFallbackNotificationClaim) {
      return [
        {
          system: "slack",
          externalId: "fallback:dry-run",
          detail: `would post deployment_handoff_failed alert for ${claim.dealId}`,
        },
      ];
    },
  };
}

function defaultTerminalDriftNotifications(): TerminalDriftNotificationHandler {
  return {
    eventMode: "dry_run",
    async notify(claim: CommercialTerminalDriftAlertClaim) {
      return [
        {
          system: "slack",
          externalId: "terminal-drift:dry-run",
          detail: `would post commercial_terminal_drift alert for ${claim.dealId}`,
        },
      ];
    },
  };
}

export function startServer(
  store: Store,
  enricher: Enricher,
  port: number,
  options: ServerOptions = {},
): ReturnType<typeof createServer> {
  const sinkLabel = options.sinkLabel ?? "logging";
  const integrationHealthEnabled = options.liveIntegrations === true;
  const localWrites = localWriteEndpointOptions(options, port);
  const readinessNotifications =
    options.readinessNotifications ?? defaultReadinessNotifications();
  const fallbackNotifications =
    options.fallbackNotifications ?? defaultFallbackNotifications();
  const terminalDriftNotifications =
    options.terminalDriftNotifications ?? defaultTerminalDriftNotifications();
  let healthCache:
    | { at: number; ttlMs: number; checks: IntegrationCheck[] }
    | undefined;
  let healthInFlight: Promise<IntegrationCheck[]> | undefined;
  let stateCache: { at: number; state: ConsoleState } | undefined;
  const requestUrlOptions: RequestUrlOptions = {
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    trustProxy: process.env.TRUST_PROXY === "1",
  };
  const loadHealth: HealthLoader = async () => {
    if (!integrationHealthEnabled) {
      return [
        {
          system: "env",
          name: "integration mode",
          status: "warn",
          detail: `HubSpot/Slack doctor skipped for ${sinkLabel} sink.`,
          hint: "Start with --live-integrations to enable live doctor checks.",
        },
      ];
    }
    const now = Date.now();
    if (healthCache && now - healthCache.at < healthCache.ttlMs) {
      return healthCache.checks;
    }
    healthInFlight ??= runIntegrationDoctor()
      .then((checks) => {
        const ttlMs = checks.some((check) => check.status === "fail")
          ? HEALTH_FAILURE_TTL_MS
          : HEALTH_TTL_MS;
        healthCache = { at: Date.now(), ttlMs, checks };
        return checks;
      })
      .finally(() => {
        healthInFlight = undefined;
      });
    return healthInFlight;
  };
  const loadState = (): ConsoleState => {
    const now = Date.now();
    if (stateCache && now - stateCache.at < STATE_CACHE_TTL_MS) {
      return stateCache.state;
    }
    const state = buildState(store, sinkLabel);
    stateCache = { at: now, state };
    return state;
  };
  const invalidateStateCache = (): void => {
    stateCache = undefined;
  };
  const html = consoleHtml(sinkLabel);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(
      req,
      res,
      store,
      enricher,
      loadHealth,
      loadState,
      invalidateStateCache,
      html,
      options,
      requestUrlOptions,
      localWrites,
      readinessNotifications,
      fallbackNotifications,
      terminalDriftNotifications,
    ).catch(
      (err: unknown) => {
        if (!res.headersSent) {
          json(res, 500, {
            error: err instanceof Error ? err.message : String(err),
          });
        } else {
          res.destroy(err instanceof Error ? err : undefined);
        }
      },
    );
  });
  server.listen(port, LOCAL_SERVER_HOST);
  return server;
}

function incomingHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (address === "127.0.0.1" || address === "::1") return true;
  if (!address?.startsWith("::ffff:")) return false;
  return address.slice("::ffff:".length) === "127.0.0.1";
}

function hostHeaderAllowed(host: string | undefined, configuredPort: number): boolean {
  if (!host) return false;
  const lower = host.toLowerCase();
  let name: string;
  let port: string | undefined;

  if (lower.startsWith("[")) {
    const close = lower.indexOf("]");
    if (close < 0) return false;
    name = lower.slice(0, close + 1);
    const rest = lower.slice(close + 1);
    if (rest.length > 0) {
      if (!rest.startsWith(":")) return false;
      port = rest.slice(1);
    }
  } else {
    const firstColon = lower.indexOf(":");
    const lastColon = lower.lastIndexOf(":");
    if (firstColon !== lastColon) return false;
    if (firstColon >= 0) {
      name = lower.slice(0, firstColon);
      port = lower.slice(firstColon + 1);
    } else {
      name = lower;
    }
  }

  if (!LOCAL_ALLOWED_HOSTS.has(name)) return false;
  if (port === undefined) return true;
  if (!/^\d+$/.test(port)) return false;
  return configuredPort === 0 || Number(port) === configuredPort;
}

function localSecretMatches(expected: string, received: string | undefined): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(received ?? "", "utf8");
  if (receivedBytes.length !== expectedBytes.length) {
    const padded = Buffer.alloc(expectedBytes.length);
    receivedBytes.copy(padded, 0, 0, Math.min(receivedBytes.length, padded.length));
    timingSafeEqual(expectedBytes, padded);
    return false;
  }
  return timingSafeEqual(expectedBytes, receivedBytes);
}

function requestAbsoluteUrl(
  req: IncomingMessage,
  options: RequestUrlOptions,
): string {
  if (options.publicBaseUrl) {
    const base = new URL(options.publicBaseUrl);
    base.pathname = "/";
    base.search = "";
    base.hash = "";
    return new URL(req.url ?? "/", base).toString();
  }
  const proto = options.trustProxy
    ? incomingHeader(req, "x-forwarded-proto") ?? "http"
    : "http";
  const host = options.trustProxy
    ? incomingHeader(req, "x-forwarded-host") ?? incomingHeader(req, "host") ?? "localhost"
    : incomingHeader(req, "host") ?? "localhost";
  return `${proto}://${host}${req.url ?? "/"}`;
}

function stageName(change: ResolvedHubSpotStageChange): string {
  return change.toStageLabel
    ? `${change.toStageLabel} (${change.toStageId})`
    : change.toStageId;
}

async function handleHubSpotWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  handler: HubSpotStageChangeHandler | undefined,
  urlOptions: RequestUrlOptions,
): Promise<void> {
  if (!handler) {
    json(res, 404, {
      error:
        "HubSpot webhooks are disabled; start the server with --integrations or --live-integrations",
    });
    return;
  }
  if (!acceptsJsonBody(req)) {
    rejectNonJson(res);
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  const request = {
    method: req.method ?? "POST",
    absoluteUrl: requestAbsoluteUrl(req, urlOptions),
    rawBody,
    headers: req.headers,
  };
  if (!handler.verify(request)) {
    json(res, 401, { error: "invalid HubSpot signature" });
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(rawBody);
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  let changes: ResolvedHubSpotStageChange[];
  let malformed = 0;
  let noRouterId = 0;
  let resolveErrors = 0;
  let terminalResolveErrors = 0;
  try {
    const resolved = await handler.resolve(parsed);
    changes = resolved.changes;
    malformed = resolved.droppedMalformed;
    noRouterId = resolved.droppedNoRouterId;
    resolveErrors = resolved.resolveErrors;
    terminalResolveErrors = resolved.terminalResolveErrors;
  } catch (err) {
    json(res, err instanceof WebhookPayloadError ? 400 : 502, {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (malformed > 0) {
    console.error(`hubspot webhook dropped ${malformed} malformed dealstage event(s)`);
  }

  const results: Array<{
    status: "recorded" | "duplicate" | "not_routed" | "stale" | "notify_retry";
    routerDealId: string;
    hubspotDealId: string;
    toStage: string;
    receipts: number;
  }> = [];

  for (const change of changes) {
    const recorded = store.recordExternalStageChange(
      change.routerDealId,
      {
        system: "hubspot",
        externalId: change.hubspotDealId,
        stageId: change.toStageId,
        stageLabel: change.toStageLabel,
        updatedAt: change.occurredAt,
      },
      `hubspot stage changed: ${stageName(change)}`,
      {
        kind: "hubspot_stage_claim",
        mode: handler.eventMode,
        hubspotDealId: change.hubspotDealId,
        eventKey: change.eventKey,
        toStageId: change.toStageId,
        toStageLabel: change.toStageLabel,
      },
      change.eventKey,
    );
    if (recorded !== "recorded" && recorded !== "notify_retry") {
      results.push({
        status: recorded,
        routerDealId: change.routerDealId,
        hubspotDealId: change.hubspotDealId,
        toStage: stageName(change),
        receipts: 0,
      });
      continue;
    }
    const notificationLeaseAt =
      store.externalNotificationLeaseAt(change.eventKey) ?? undefined;

    let receipts: Array<{
      system: string;
      externalId: string;
      detail: string;
      status?: "ok" | "warning";
      url?: string;
    }>;
    try {
      receipts = await handler.notify(change);
    } catch (err) {
      receipts = [
        {
          system: "slack",
          externalId: "stage-change",
          detail: `stage-change notification failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          status: "warning",
        },
      ];
    }
    const notificationDetail =
      recorded === "notify_retry"
        ? "hubspot stage notification retry"
        : receipts.length > 0
          ? "hubspot stage notification"
          : "hubspot stage notification suppressed by HUBSPOT_NOTIFY_STAGE_IDS";
    try {
      store.recordExternalNotificationEvent(
        change.routerDealId,
        notificationDetail,
        {
          kind: "hubspot_stage_change",
          mode: handler.eventMode,
          hubspotDealId: change.hubspotDealId,
          eventKey: change.eventKey,
          toStageId: change.toStageId,
          toStageLabel: change.toStageLabel,
          receipts,
        },
        change.eventKey,
        receipts,
        notificationLeaseAt,
      );
    } catch (err) {
      console.error(
        `hubspot webhook could not append notification event for eventKey=${change.eventKey} dealId=${change.routerDealId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    results.push({
      status: recorded,
      routerDealId: change.routerDealId,
      hubspotDealId: change.hubspotDealId,
      toStage: stageName(change),
      receipts: receipts.length,
    });
  }

  json(res, resolveErrors > 0 ? 502 : 200, {
    processed: results.filter((r) => r.status === "recorded").length,
    notificationRetries: results.filter((r) => r.status === "notify_retry").length,
    duplicates: results.filter((r) => r.status === "duplicate").length,
    notRouted: results.filter((r) => r.status === "not_routed").length,
    stale: results.filter((r) => r.status === "stale").length,
    malformed,
    noRouterId,
    resolveErrors,
    terminalResolveErrors,
    ignored: Math.max(
      0,
      (Array.isArray(parsed) ? parsed.length : 0) -
        changes.length -
        malformed -
        noRouterId -
        resolveErrors -
        terminalResolveErrors,
    ),
    ...(changes.length === 0 ? { ignoredReason: "no dealstage events in payload" } : {}),
    results,
  });
}

function localCommercialStateStatusCode(
  status: ReturnType<Store["recordLocalCommercialState"]>["status"],
  expectedRedPath: boolean,
): number {
  if (status === "not_routed") return 404;
  if (status === "idempotency_conflict" || status === "regression") return 409;
  if (status === "terminal_drift" && !expectedRedPath) return 409;
  return 200;
}

function guardLocalWriteRequest(
  req: IncomingMessage,
  res: ServerResponse,
  localWrites: LocalWriteEndpointOptions,
  url: string,
): boolean {
  if (!localWrites.enabled || !localWrites.secret) {
    json(res, 404, { error: "not found", url });
    return false;
  }
  if (!hostHeaderAllowed(incomingHeader(req, "host"), localWrites.configuredPort)) {
    json(res, 403, { error: "local endpoint host rejected" });
    return false;
  }
  if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
    json(res, 403, { error: "local endpoint requires loopback remote address" });
    return false;
  }
  if (
    !localSecretMatches(
      localWrites.secret,
      incomingHeader(req, LOCAL_ENDPOINT_SECRET_HEADER),
    )
  ) {
    json(res, 401, { error: "invalid local endpoint secret" });
    return false;
  }
  return true;
}

async function deliverReadinessNotification(
  store: Store,
  handler: ReadinessNotificationHandler,
  fallbackHandler: FallbackNotificationHandler,
  claim: ReadinessNotificationClaim | null,
): Promise<{
  status: string;
  receipts: number;
  fingerprint: string;
  fallbackStatus?: string;
  fallbackReceipts?: number;
} | null> {
  if (!claim) return null;
  let receipts: Array<{
    system: string;
    externalId: string;
    detail: string;
    status?: "ok" | "warning";
    url?: string;
  }>;
  try {
    receipts = await handler.notify(claim);
  } catch (err) {
    // The bundled Slack notifier returns warning receipts, but custom handlers
    // may throw; convert that into the same retryable writeback path.
    receipts = [
      {
        system: "slack",
        externalId: "readiness-notification",
        detail: `deployment readiness notification failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        status: "warning",
      },
    ];
  }
  const delivery = store.recordReadinessNotificationEvent(
    claim,
    handler.eventMode,
    receipts,
  );
  const result: {
    status: string;
    receipts: number;
    fingerprint: string;
    fallbackStatus?: string;
    fallbackReceipts?: number;
  } = {
    status: delivery.status,
    receipts: receipts.length,
    fingerprint: claim.fingerprint,
  };
  if (delivery.fallbackClaim) {
    const fallback = await deliverFallbackNotification(
      store,
      fallbackHandler,
      delivery.fallbackClaim,
    );
    if (fallback) {
      result.fallbackStatus = fallback.status;
      result.fallbackReceipts = fallback.receipts;
    }
  }
  return result;
}

async function deliverFallbackNotification(
  store: Store,
  handler: FallbackNotificationHandler,
  claim: ReadinessFallbackNotificationClaim | null,
): Promise<{ status: string; receipts: number; fallbackKey: string } | null> {
  if (!claim) return null;
  let receipts: Array<{
    system: string;
    externalId: string;
    detail: string;
    status?: "ok" | "warning";
    url?: string;
  }>;
  try {
    receipts = await handler.notify(claim);
  } catch (err) {
    receipts = [
      {
        system: "slack",
        externalId: "fallback-notification",
        detail: `deployment handoff fallback notification failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        status: "warning",
      },
    ];
  }
  const delivery = store.recordReadinessFallbackNotificationEvent(
    claim,
    handler.eventMode,
    receipts,
  );
  return {
    status: delivery.status,
    receipts: receipts.length,
    fallbackKey: claim.fallbackKey,
  };
}

async function deliverTerminalDriftNotification(
  store: Store,
  handler: TerminalDriftNotificationHandler,
  claim: CommercialTerminalDriftAlertClaim | null,
): Promise<{ status: string; receipts: number; alertKey: string } | null> {
  if (!claim) return null;
  let receipts: Array<{
    system: string;
    externalId: string;
    detail: string;
    status?: "ok" | "warning";
    url?: string;
  }>;
  try {
    receipts = await handler.notify(claim);
  } catch (err) {
    receipts = [
      {
        system: "slack",
        externalId: "terminal-drift-notification",
        detail: `commercial terminal drift alert failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        status: "warning",
      },
    ];
  }
  const delivery = store.recordCommercialTerminalDriftAlertEvent(
    claim,
    handler.eventMode,
    receipts,
  );
  return {
    status: delivery.status,
    receipts: receipts.length,
    alertKey: claim.alertKey,
  };
}

async function handleLocalCommercialState(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
  readinessNotifications: ReadinessNotificationHandler,
  fallbackNotifications: FallbackNotificationHandler,
  terminalDriftNotifications: TerminalDriftNotificationHandler,
  invalidateStateCache: () => void,
): Promise<void> {
  if (!guardLocalWriteRequest(req, res, localWrites, "/commercial-state")) return;
  if (!acceptsJsonBody(req)) {
    rejectNonJson(res);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  const body = LocalCommercialStateBody.safeParse(parsed);
  if (!body.success) {
    json(res, 400, {
      error: "invalid commercial-state request",
      issues: body.error.issues,
    });
    return;
  }

  const occurredAt = resolveCanonicalTimestamp(body.data.occurredAt);
  if (!occurredAt) {
    json(res, 400, {
      error: "occurredAt must be a canonical UTC ISO timestamp",
    });
    return;
  }
  if (occurredAt.date.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
    json(res, 422, {
      error: `occurredAt is more than ${MAX_FUTURE_SKEW_MS}ms in the future`,
    });
    return;
  }

  const expectedRedPath = body.data.expectedRedPath === true;
  if (expectedRedPath && !localWrites.allowExpectedRedPaths) {
    json(res, 403, {
      error: "expectedRedPath requires ALLOW_EXPECTED_RED_PATHS=1",
    });
    return;
  }

  const result = store.recordLocalCommercialState({
    dealId: body.data.dealId,
    commercialState: body.data.commercialState,
    sourceEventId: body.data.sourceEventId,
    occurredAt: body.data.occurredAt,
    reason: body.data.reason ?? null,
    expectedRedPath,
  });
  if (localCommercialStateMutated(result.status)) invalidateStateCache();
  const readinessNotificationResult = await deliverReadinessNotification(
    store,
    readinessNotifications,
    fallbackNotifications,
    result.readinessNotification,
  );
  const terminalDriftAlertResult = await deliverTerminalDriftNotification(
    store,
    terminalDriftNotifications,
    result.terminalDriftAlert,
  );
  json(res, localCommercialStateStatusCode(result.status, expectedRedPath), {
    ...result,
    ...(readinessNotificationResult ? { readinessNotificationResult } : {}),
    ...(terminalDriftAlertResult ? { terminalDriftAlertResult } : {}),
  });
}

function localDeploymentFactsStatusCode(
  status: ReturnType<Store["recordLocalDeploymentFacts"]>["status"],
): number {
  if (status === "not_found") return 404;
  if (status === "idempotency_conflict" || status === "tie_conflict") return 409;
  return 200;
}

function localCommercialStateMutated(
  status: ReturnType<Store["recordLocalCommercialState"]>["status"],
): boolean {
  return status !== "not_routed" && status !== "duplicate";
}

function localDeploymentFactsMutated(
  status: ReturnType<Store["recordLocalDeploymentFacts"]>["status"],
): boolean {
  return status !== "not_found" && status !== "duplicate";
}

function localOutcomeMutated(
  status: ReturnType<Store["recordLocalOutcome"]>["status"],
): boolean {
  return (
    status !== "not_found" &&
    status !== "not_closed_won" &&
    status !== "duplicate"
  );
}

function localOutcomeStatusCode(
  status: ReturnType<Store["recordLocalOutcome"]>["status"],
): number {
  if (status === "not_found") return 404;
  if (status === "invalid_arr_delta") return 422;
  if (
    status === "idempotency_conflict" ||
    status === "not_closed_won" ||
    status === "duplicate_semantic_outcome" ||
    status === "missing_prior_outcome" ||
    status === "post_churn_outcome"
  ) {
    return 409;
  }
  return 200;
}

function localEnrichmentObservationMutated(
  status: ReturnType<Store["recordProviderObservation"]>["status"],
): boolean {
  switch (status) {
    case "recorded":
    case "refreshed":
      return true;
    case "duplicate":
    case "idempotency_conflict":
      return false;
    default:
      return unreachableStatus(status);
  }
}

function localEnrichmentObservationStatusCode(
  status: ReturnType<Store["recordProviderObservation"]>["status"],
): number {
  switch (status) {
    case "recorded":
      return 201;
    case "idempotency_conflict":
      return 409;
    case "duplicate":
    case "refreshed":
      // Refreshed is a state-changing replay for store callers that opt into
      // refreshOnDuplicate; this local endpoint does not currently set it.
      return 200;
    default:
      return unreachableStatus(status);
  }
}

function enrichmentFromFacts(facts: EnrichedSubjectFacts): Enrichment {
  return {
    employees: facts.employees,
    industry: facts.industry,
    techSignals: facts.techSignals,
    regulated: facts.regulated,
    confidence: facts.confidence,
  };
}

function enricherFromFacts(facts: EnrichedSubjectFacts): Enricher {
  return {
    name: facts.sourceProvider,
    async enrich() {
      return enrichmentFromFacts(facts);
    },
  };
}

function renderSinkReceipts(receipts: SinkReceipt[]): string {
  if (receipts.length === 0) return "sink: no downstream receipt";
  return receipts
    .map((receipt) => {
      const url = receipt.url ? ` (${receipt.url})` : "";
      return `${receipt.system}:${receipt.externalId} ${receipt.detail}${url}`;
    })
    .join(" | ");
}

function localAgentSuggestionMutated(
  status: ReturnType<Store["recordLocalAgentSuggestion"]>["status"],
): boolean {
  switch (status) {
    case "recorded":
      return true;
    case "duplicate":
    case "idempotency_conflict":
    case "not_found":
    case "not_routed":
      return false;
    default:
      return unreachableStatus(status);
  }
}

function localAgentSuggestionStatusCode(
  status: ReturnType<Store["recordLocalAgentSuggestion"]>["status"],
): number {
  switch (status) {
    case "not_found":
      return 404;
    case "not_routed":
      return 409;
    case "idempotency_conflict":
      return 409;
    case "recorded":
    case "duplicate":
      return 200;
    default:
      return unreachableStatus(status);
  }
}

function localAgentSuggestionDecisionMutated(
  status: ReturnType<Store["recordLocalAgentSuggestionDecision"]>["status"],
): boolean {
  switch (status) {
    case "recorded":
      return true;
    case "duplicate":
    case "idempotency_conflict":
    case "not_found":
    case "already_decided":
    case "decision_before_proposal":
      return false;
    default:
      return unreachableStatus(status);
  }
}

function localAgentSuggestionDecisionStatusCode(
  status: ReturnType<Store["recordLocalAgentSuggestionDecision"]>["status"],
): number {
  switch (status) {
    case "not_found":
      return 404;
    case "idempotency_conflict":
    case "already_decided":
      return 409;
    case "decision_before_proposal":
      return 422;
    case "recorded":
    case "duplicate":
      return 200;
    default:
      return unreachableStatus(status);
  }
}

function localWorkItemMutated(
  status: ReturnType<Store["recordLocalWorkItem"]>["status"],
): boolean {
  switch (status) {
    case "recorded":
      return true;
    case "duplicate":
    case "idempotency_conflict":
    case "already_exists":
      return false;
    default:
      return unreachableStatus(status);
  }
}

function localWorkItemStatusCode(
  status: ReturnType<Store["recordLocalWorkItem"]>["status"],
): number {
  switch (status) {
    case "idempotency_conflict":
      return 409;
    case "recorded":
    case "duplicate":
    case "already_exists":
      return 200;
    default:
      return unreachableStatus(status);
  }
}

function localWorkItemActionMutated(
  status: ReturnType<Store["recordLocalWorkItemAction"]>["status"],
): boolean {
  switch (status) {
    case "recorded":
    case "superseded":
      return true;
    case "duplicate":
    case "idempotency_conflict":
    case "not_found":
    case "already_closed":
    case "invalid_action":
      return false;
    default:
      return unreachableStatus(status);
  }
}

function localWorkItemActionStatusCode(
  status: ReturnType<Store["recordLocalWorkItemAction"]>["status"],
): number {
  switch (status) {
    case "not_found":
      return 404;
    case "idempotency_conflict":
    case "already_closed":
      return 409;
    case "invalid_action":
      return 422;
    case "recorded":
    case "superseded":
    case "duplicate":
      return 200;
    default:
      return unreachableStatus(status);
  }
}

function findRoleQueueSignal(
  store: Store,
  queue: RoleQueueKind,
  dealId: string,
): RoleQueueItem | null {
  const readiness = store.deploymentReadinessRecords(new Date().toISOString());
  return (
    store
      .roleQueues(250, readiness)
      [queue].find((item) => item.dealId === dealId) ?? null
  );
}

async function handleLocalDeploymentFacts(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
  readinessNotifications: ReadinessNotificationHandler,
  fallbackNotifications: FallbackNotificationHandler,
  invalidateStateCache: () => void,
): Promise<void> {
  if (!guardLocalWriteRequest(req, res, localWrites, "/deployment-facts")) return;
  if (!acceptsJsonBody(req)) {
    rejectNonJson(res);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  const body = LocalDeploymentFactsBody.safeParse(parsed);
  if (!body.success) {
    json(res, 400, {
      error: "invalid deployment-facts request",
      issues: body.error.issues,
    });
    return;
  }

  const occurredAt = resolveCanonicalTimestamp(body.data.occurredAt);
  if (!occurredAt) {
    json(res, 400, {
      error: "occurredAt must be a canonical UTC ISO timestamp",
    });
    return;
  }
  if (occurredAt.date.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
    json(res, 422, {
      error: `occurredAt is more than ${MAX_FUTURE_SKEW_MS}ms in the future`,
    });
    return;
  }

  const result = store.recordLocalDeploymentFacts({
    dealId: body.data.dealId,
    sourceEventId: body.data.sourceEventId,
    useCaseClear: body.data.useCaseClear,
    integrationsKnown: body.data.integrationsKnown,
    dataReady: body.data.dataReady,
    operator: body.data.operator,
    occurredAt: body.data.occurredAt,
  });
  if (localDeploymentFactsMutated(result.status)) invalidateStateCache();
  const readinessNotificationResult = await deliverReadinessNotification(
    store,
    readinessNotifications,
    fallbackNotifications,
    result.readinessNotification,
  );
  json(res, localDeploymentFactsStatusCode(result.status), {
    ...result,
    ...(readinessNotificationResult ? { readinessNotificationResult } : {}),
  });
}

function outcomeBodyError(parsed: unknown): string {
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const hasMissingOrEmptyDealId =
      !("dealId" in record) ||
      (typeof record.dealId === "string" && record.dealId.trim() === "");
    if (
      hasMissingOrEmptyDealId &&
      ("hubspotDealId" in record || "externalDealId" in record)
    ) {
      return "router dealId required";
    }
    if (typeof record.dealId !== "string" || record.dealId.trim() === "") {
      return "dealId required";
    }
  }
  return "invalid outcome request";
}

async function handleLocalOutcome(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
  invalidateStateCache: () => void,
): Promise<void> {
  if (!guardLocalWriteRequest(req, res, localWrites, "/outcomes")) return;
  if (!acceptsJsonBody(req)) {
    rejectNonJson(res);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  const body = LocalOutcomeBody.safeParse(parsed);
  if (!body.success) {
    json(res, 400, {
      error: outcomeBodyError(parsed),
      issues: body.error.issues,
    });
    return;
  }

  const occurredAt = parseCanonicalOccurredAt(body.data.occurredAt);
  if (!occurredAt) {
    json(res, 400, {
      error: "occurredAt must be a canonical UTC ISO timestamp",
    });
    return;
  }
  if (occurredAt.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
    json(res, 422, {
      error: `occurredAt is more than ${MAX_FUTURE_SKEW_MS}ms in the future`,
    });
    return;
  }

  const result = store.recordLocalOutcome({
    dealId: body.data.dealId,
    sourceEventId: body.data.sourceEventId,
    outcome: body.data.outcome,
    occurredAt: body.data.occurredAt,
    operator: body.data.operator,
    arrDeltaUsd: body.data.arrDeltaUsd ?? null,
    reasonCategory: body.data.reasonCategory ?? null,
  });
  if (localOutcomeMutated(result.status)) invalidateStateCache();
  json(res, localOutcomeStatusCode(result.status), result);
}

async function handleLocalEnrichmentObservation(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
  invalidateStateCache: () => void,
): Promise<void> {
  if (!guardLocalWriteRequest(req, res, localWrites, "/enrichment-observations")) {
    return;
  }
  if (!acceptsJsonBody(req)) {
    rejectNonJson(res);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  const body = LocalEnrichmentObservationBody.safeParse(parsed);
  if (!body.success) {
    json(res, 400, {
      error: "invalid enrichment-observation request",
      issues: body.error.issues,
    });
    return;
  }

  const observedAt = resolveCanonicalTimestamp(body.data.observedAt);
  if (!observedAt) {
    json(res, 400, {
      error: "observedAt must be a canonical UTC ISO timestamp",
    });
    return;
  }
  if (observedAt.date.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
    json(res, 422, {
      error: `observedAt is more than ${MAX_FUTURE_SKEW_MS}ms in the future`,
    });
    return;
  }

  const expiresAt =
    body.data.expiresAt === undefined
      ? defaultEnrichmentExpiresAt(observedAt.value)
      : body.data.expiresAt;
  const expiresAtTimestamp = resolveCanonicalTimestamp(expiresAt);
  if (!expiresAtTimestamp) {
    json(res, 400, {
      error: "expiresAt must be a canonical UTC ISO timestamp",
    });
    return;
  }
  const expiryDeltaMs = expiresAtTimestamp.date.getTime() - observedAt.date.getTime();
  if (expiryDeltaMs <= 0) {
    json(res, 422, {
      error: "expiresAt must be after observedAt",
    });
    return;
  }
  if (expiresAtTimestamp.date.getTime() <= Date.now()) {
    json(res, 422, {
      error: "expiresAt must be in the future",
    });
    return;
  }
  if (expiryDeltaMs > ENRICHMENT_FACT_MAX_AGE_DAYS * 86_400_000) {
    json(res, 422, {
      error: `expiresAt cannot be more than ${ENRICHMENT_FACT_MAX_AGE_DAYS} days after observedAt`,
    });
    return;
  }
  const techSignals = [...new Set(body.data.techSignals ?? [])].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const normalizedPayload = {
    employees: body.data.employees,
    industry: body.data.industry,
    techSignals,
    regulated: body.data.regulated,
    confidence: body.data.confidence,
  };
  const result = store.recordProviderObservation({
    subjectType: "company",
    subjectKey: body.data.subjectKey,
    provider: "manual",
    sourceEventId: body.data.sourceEventId,
    observedAt: observedAt.value,
    expiresAt,
    confidence: body.data.confidence,
    rawPayload: {
      source: "operator_console",
      // Local-console attribution only; write authorization is the local
      // endpoint secret plus loopback guard, not this operator string.
      operator: body.data.operator,
      note: body.data.note ?? null,
      normalizedPayload,
    },
    normalizedPayload,
  });
  if (localEnrichmentObservationMutated(result.status)) invalidateStateCache();
  json(res, localEnrichmentObservationStatusCode(result.status), result);
}

async function handleQuarantineReplay(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
  enricher: Enricher,
  pipelineOptions: Partial<PipelineOptions>,
  invalidateStateCache: () => void,
): Promise<void> {
  if (!guardLocalWriteRequest(req, res, localWrites, "/quarantine-replay")) {
    return;
  }
  if (!acceptsJsonBody(req)) {
    rejectNonJson(res);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  const body = LocalQuarantineReplayBody.safeParse(parsed);
  if (!body.success) {
    json(res, 400, {
      error: "invalid quarantine-replay request",
      issues: body.error.issues,
    });
    return;
  }

  const record = store.quarantinedDeal(body.data.dealId);
  if (!record) {
    json(res, 404, { status: "not_found", error: "quarantined deal not found" });
    return;
  }
  if (!record.deal) {
    json(res, 409, {
      status: "no_replay_payload",
      error: "quarantine has no normalized deal payload to replay",
    });
    return;
  }
  const replayMode =
    record.quarantine.code === "enrichment_unresolved" ||
    record.quarantine.code === "insufficient_data"
      ? "enrichment_repair"
      : record.quarantine.code === "sink_terminal" ||
          record.quarantine.code === "sink_exhausted"
        ? "sink_retry"
        : null;
  if (replayMode === null) {
    json(res, 409, {
      status: "unsupported_quarantine",
      error: `quarantine code ${record.quarantine.code} cannot be replayed by the operator console`,
    });
    return;
  }

  const startedAt = performance.now();
  const replayDeal: Deal = {
    id: record.deal.id,
    company: record.deal.company,
    domain: record.deal.domain,
    dealUSD: record.deal.dealUSD,
    region: record.deal.region,
    sourceChannel: record.deal.sourceChannel,
    statedNeed: record.deal.statedNeed,
    contactName: body.data.contactName,
    contactEmail: body.data.contactEmail,
  };
  let routed: RoutedDeal | null = null;
  let replayFacts: EnrichedSubjectFacts | null = null;
  let replaySource = "";
  let routeDerivation:
    | "stored_route"
    | "rederived_from_evidence"
    | "rederived_from_enricher"
    | null = null;
  let replayEnricher: Enricher | null = null;
  if (replayMode === "sink_retry" && record.routedDeal) {
    routed = {
      ...record.routedDeal,
      contactName: body.data.contactName,
      contactEmail: body.data.contactEmail,
    };
    replaySource = `stored_route:${record.quarantine.code}`;
    routeDerivation = "stored_route";
  } else if (replayMode === "enrichment_repair") {
    const subjectKey = enrichmentSubjectKey(replayDeal);
    const facts = store.enrichedSubjectFacts("company", subjectKey);
    if (!facts || facts.freshnessStatus !== "fresh") {
      const latestObservation = store.providerObservations(
        "company",
        subjectKey,
        1,
      )[0];
      const lowConfidence =
        latestObservation !== undefined &&
        latestObservation.confidence < ENRICHMENT_FACT_MIN_CONFIDENCE;
      const status = lowConfidence ? "low_confidence" : "no_fresh_facts";
      const error = lowConfidence
        ? facts?.freshnessStatus === "stale"
          ? `projected enrichment facts are stale and latest enrichment confidence ${latestObservation.confidence.toFixed(2)} < ${ENRICHMENT_FACT_MIN_CONFIDENCE}`
          : `latest enrichment confidence ${latestObservation.confidence.toFixed(2)} < ${ENRICHMENT_FACT_MIN_CONFIDENCE}`
        : "fresh, high-confidence enrichment facts are required before replay";
      const audit = store.recordQuarantineReplayFailureOrStateRace(
        replayDeal.id,
        `quarantine replay ${status}: ${error}`,
        `quarantine replay ${status} after state moved: ${error}`,
      );
      if (audit.auditRecorded) invalidateStateCache();
      json(res, 409, {
        status,
        error,
        subjectKey,
        freshnessStatus: facts?.freshnessStatus ?? null,
        latestObservationConfidence: latestObservation?.confidence ?? null,
        minimumConfidence: ENRICHMENT_FACT_MIN_CONFIDENCE,
        auditRecorded: audit.auditRecorded,
        stateChanged: audit.stateChanged,
        auditUnavailable: audit.auditUnavailable,
      });
      return;
    }
    replayFacts = facts;
    replaySource = `evidence:${facts.sourceProvider}:${facts.sourceObservationId}`;
    routeDerivation = "rederived_from_evidence";
    replayEnricher = enricherFromFacts(facts);
  } else {
    const subjectKey = enrichmentSubjectKey(replayDeal);
    const facts = store.enrichedSubjectFacts("company", subjectKey);
    if (facts?.freshnessStatus === "fresh") {
      replayFacts = facts;
      replaySource = `evidence:${facts.sourceProvider}:${facts.sourceObservationId}`;
      routeDerivation = "rederived_from_evidence";
      replayEnricher = enricherFromFacts(facts);
    } else {
      replaySource = `enricher:${enricher.name}`;
      routeDerivation = "rederived_from_enricher";
      replayEnricher = enricher;
    }
  }
  if (!routed) {
    if (!replayEnricher) {
      json(res, 500, {
        status: "pipeline_error",
        error: "quarantine replay enricher was not selected",
      });
      return;
    }
    try {
      const gate = await enrichWithGate(replayDeal, replayEnricher);
      if (!gate.ok) {
        const subjectKey = enrichmentSubjectKey(replayDeal);
        const audit = store.recordQuarantineReplayFailureOrStateRace(
          replayDeal.id,
          `quarantine replay ${gate.code}: ${gate.reason}`,
          `quarantine replay ${gate.code} after state moved: ${gate.reason}`,
        );
        if (audit.auditRecorded) invalidateStateCache();
        json(res, 409, {
          status: gate.code,
          error: gate.reason,
          subjectKey,
          auditRecorded: audit.auditRecorded,
          stateChanged: audit.stateChanged,
          auditUnavailable: audit.auditUnavailable,
        });
        return;
      }
      routed = scoreAndRoute(replayDeal, gate.enrichment);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const audit = store.recordQuarantineReplayFailureOrStateRace(
        replayDeal.id,
        `quarantine replay score_error: ${message}`,
        `quarantine replay score_error after state moved: ${message}`,
      );
      if (audit.auditRecorded) invalidateStateCache();
      json(res, 422, {
        status: "score_error",
        error: message,
        auditRecorded: audit.auditRecorded,
        stateChanged: audit.stateChanged,
        auditUnavailable: audit.auditUnavailable,
      });
      return;
    }
  }
  if (routeDerivation === null) {
    json(res, 500, {
      status: "pipeline_error",
      error: "quarantine replay route derivation was not selected",
    });
    return;
  }
  const dryRun = pipelineOptions.dryRun ?? true;
  const sink = pipelineOptions.sink ?? new LoggingSink();
  const retry = pipelineOptions.retry ?? DEFAULT_RETRY;
  let receipts: SinkReceipt[];
  let sinkState: {
    mode: "dry_run" | "live";
    status: "synced" | "partial" | "dry_run";
  };
  try {
    // Keep the original pipeline ordering: downstream upsert first, local
    // routed state second. OpportunitySink implementations must be idempotent
    // on deal.id so a retry after an interrupted replay cannot duplicate CRM
    // opportunities; sink quarantine replay relies on that same contract because
    // an earlier failed attempt may already have written a partial receipt.
    if (dryRun) {
      receipts = await sink.upsert(routed);
      sinkState = { mode: "dry_run", status: "dry_run" };
    } else {
      receipts = await withRetry(() => sink.upsert(routed), retry);
      sinkState = {
        mode: "live",
        status: receipts.some((receipt) => receipt.status === "warning")
          ? "partial"
          : "synced",
      };
    }
  } catch (err) {
    const status =
      err instanceof TerminalSinkError
        ? "sink_terminal"
        : err instanceof SinkExhaustedError
          ? "sink_exhausted"
          : "sink_error";
    const message = err instanceof Error ? err.message : String(err);
    const audit = store.recordQuarantineReplayFailureOrStateRace(
      replayDeal.id,
      `quarantine replay ${status}: ${message}`,
      `quarantine replay ${status} after state moved: ${message}`,
    );
    if (audit.auditRecorded) invalidateStateCache();
    json(res, 502, {
      status,
      error: message,
      auditRecorded: audit.auditRecorded,
      stateChanged: audit.stateChanged,
      auditUnavailable: audit.auditUnavailable,
    });
    return;
  }

  const sinkDetail = dryRun
    ? `sink: dry-run replay ${renderSinkReceipts(receipts)}`
    : `sink: replay upserted via ${sink.name} ${renderSinkReceipts(receipts)}`;
  let writeStatus: "inserted" | "updated";
  try {
    writeStatus = store.recordQuarantineReplay(
      routed,
      Math.round(performance.now() - startedAt),
      sinkState,
      `quarantine replay by ${body.data.operator} via ${replaySource} (${routeDerivation})`,
      `score ${routed.score.total.toFixed(2)} after quarantine replay`,
      sinkDetail,
      { kind: "sink", mode: sinkState.mode, receipts },
      body.data.reason ? `quarantine replay note: ${body.data.reason}` : undefined,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const noLongerQuarantined = message.includes("currently quarantined");
    const auditRecorded = noLongerQuarantined
      ? store.recordQuarantineReplayStateRace(
          routed.id,
          `quarantine replay dropped after sink success because state moved: ${sinkDetail}`,
          { kind: "sink", mode: sinkState.mode, receipts },
        )
      : false;
    if (auditRecorded) invalidateStateCache();
    json(res, noLongerQuarantined ? 409 : 500, {
      status: noLongerQuarantined ? "not_quarantined" : "store_error",
      error: message,
      auditRecorded,
      sink: noLongerQuarantined
        ? { ...sinkState, receipts }
        : undefined,
    });
    return;
  }
  invalidateStateCache();
  json(res, 200, {
    status: "routed",
    writeStatus,
    deal: routed,
    ...(replayFacts ? { facts: replayFacts } : {}),
    replaySource,
    routeDerivation,
    sink: {
      ...sinkState,
      receipts,
    },
    previousQuarantine: record.quarantine,
  });
}

async function handleLocalAgentSuggestion(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
  invalidateStateCache: () => void,
): Promise<void> {
  if (!guardLocalWriteRequest(req, res, localWrites, "/agent-suggestions")) return;
  if (!acceptsJsonBody(req)) {
    rejectNonJson(res);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  const body = LocalAgentSuggestionBody.safeParse(parsed);
  if (!body.success) {
    json(res, 400, {
      error: "invalid agent-suggestion request",
      issues: body.error.issues,
    });
    return;
  }

  const occurredAt = parseCanonicalOccurredAt(body.data.occurredAt);
  if (!occurredAt) {
    json(res, 400, {
      error: "occurredAt must be a canonical UTC ISO timestamp",
    });
    return;
  }
  if (occurredAt.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
    json(res, 422, {
      error: `occurredAt is more than ${MAX_FUTURE_SKEW_MS}ms in the future`,
    });
    return;
  }

  // Phase 5 is local-only: createdBy is a self-reported operator/agent label
  // from the holder of LOCAL_ENDPOINT_SECRET, not an authenticated principal.
  // Do not reuse this field for non-local identity without an auth layer.
  const result = store.recordLocalAgentSuggestion({
    dealId: body.data.dealId,
    sourceEventId: body.data.sourceEventId,
    kind: body.data.kind,
    title: body.data.title,
    body: body.data.body,
    rationale: body.data.rationale,
    createdBy: body.data.createdBy,
    occurredAt: body.data.occurredAt,
  });
  if (localAgentSuggestionMutated(result.status)) invalidateStateCache();
  json(res, localAgentSuggestionStatusCode(result.status), result);
}

async function handleLocalAgentSuggestionDecision(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
  suggestionId: string,
  invalidateStateCache: () => void,
): Promise<void> {
  if (
    !guardLocalWriteRequest(
      req,
      res,
      localWrites,
      "/agent-suggestions/:id/decision",
    )
  ) {
    return;
  }
  if (!acceptsJsonBody(req)) {
    rejectNonJson(res);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  const body = LocalAgentSuggestionDecisionBody.safeParse(parsed);
  if (!body.success) {
    json(res, 400, {
      error: "invalid agent-suggestion decision request",
      issues: body.error.issues,
    });
    return;
  }

  const occurredAt = resolveCanonicalTimestamp(body.data.occurredAt);
  if (!occurredAt) {
    json(res, 400, {
      error: "occurredAt must be a canonical UTC ISO timestamp",
    });
    return;
  }
  if (occurredAt.date.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
    json(res, 422, {
      error: `occurredAt is more than ${MAX_FUTURE_SKEW_MS}ms in the future`,
    });
    return;
  }

  // Phase 5 is local-only: humanPrincipal is self-reported by the operator
  // holding LOCAL_ENDPOINT_SECRET. Production must bind it to authenticated
  // identity before exposing this route outside loopback.
  const result = await store.recordLocalAgentSuggestionDecision({
    suggestionId,
    sourceEventId: body.data.sourceEventId,
    decision: body.data.decision,
    humanPrincipal: body.data.humanPrincipal,
    reason: body.data.reason,
    occurredAt: occurredAt.value,
  });
  if (localAgentSuggestionDecisionMutated(result.status)) invalidateStateCache();
  json(res, localAgentSuggestionDecisionStatusCode(result.status), result);
}

async function handleLocalWorkItem(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
  invalidateStateCache: () => void,
): Promise<void> {
  if (!guardLocalWriteRequest(req, res, localWrites, "/work-items")) return;
  if (!acceptsJsonBody(req)) {
    rejectNonJson(res);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  const body = LocalWorkItemBody.safeParse(parsed);
  if (!body.success) {
    json(res, 400, {
      error: "invalid work-item request",
      issues: body.error.issues,
    });
    return;
  }

  const occurredAt = resolveCanonicalTimestamp(body.data.occurredAt);
  if (!occurredAt) {
    json(res, 400, {
      error: "occurredAt must be a canonical UTC ISO timestamp",
    });
    return;
  }
  if (occurredAt.date.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
    json(res, 422, {
      error: `occurredAt is more than ${MAX_FUTURE_SKEW_MS}ms in the future`,
    });
    return;
  }
  let dueAtValue: string | undefined;
  if (body.data.dueAt) {
    const dueAt = resolveCanonicalTimestamp(body.data.dueAt);
    if (!dueAt) {
      json(res, 400, {
        error: "dueAt must be a canonical UTC ISO timestamp",
      });
      return;
    }
    dueAtValue = dueAt.value;
  }

  const signal = findRoleQueueSignal(store, body.data.queue, body.data.dealId);
  if (!signal) {
    json(res, 409, {
      status: "not_in_queue",
      error: "deal is not currently in that role queue",
      dealId: body.data.dealId,
      queue: body.data.queue,
    });
    return;
  }

  // Local-only: createdBy is an operator label supplied with the loopback
  // secret. A production surface must bind this to authenticated identity.
  const result = store.recordLocalWorkItem(
    {
      dealId: body.data.dealId,
      queue: body.data.queue,
      sourceEventId: body.data.sourceEventId,
      owner: body.data.owner,
      createdBy: body.data.createdBy,
      occurredAt: occurredAt.value,
      ...(dueAtValue ? { dueAt: dueAtValue } : {}),
      ...(body.data.reason !== undefined ? { reason: body.data.reason } : {}),
    },
    signal,
  );
  if (localWorkItemMutated(result.status)) invalidateStateCache();
  json(res, localWorkItemStatusCode(result.status), result);
}

async function handleLocalWorkItemAction(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
  workItemId: string,
  invalidateStateCache: () => void,
): Promise<void> {
  if (!guardLocalWriteRequest(req, res, localWrites, "/work-items/:id/action")) {
    return;
  }
  if (!acceptsJsonBody(req)) {
    rejectNonJson(res);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  const body = LocalWorkItemActionBody.safeParse(parsed);
  if (!body.success) {
    json(res, 400, {
      error: "invalid work-item action request",
      issues: body.error.issues,
    });
    return;
  }

  const occurredAt = resolveCanonicalTimestamp(body.data.occurredAt);
  if (!occurredAt) {
    json(res, 400, {
      error: "occurredAt must be a canonical UTC ISO timestamp",
    });
    return;
  }
  if (occurredAt.date.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
    json(res, 422, {
      error: `occurredAt is more than ${MAX_FUTURE_SKEW_MS}ms in the future`,
    });
    return;
  }

  // Local-only: humanPrincipal is self-reported by the operator holding the
  // local secret, matching the rest of this console's command endpoints.
  const result = store.recordLocalWorkItemAction({
    workItemId,
    sourceEventId: body.data.sourceEventId,
    action: body.data.action,
    humanPrincipal: body.data.humanPrincipal,
    occurredAt: occurredAt.value,
    reason: body.data.reason,
    ...(body.data.owner ? { owner: body.data.owner } : {}),
  });
  if (localWorkItemActionMutated(result.status)) invalidateStateCache();
  json(res, localWorkItemActionStatusCode(result.status), result);
}

async function handleLocalPolicyRecommendationRun(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
  invalidateStateCache: () => void,
): Promise<void> {
  if (
    !guardLocalWriteRequest(
      req,
      res,
      localWrites,
      "/agent-suggestion-runs/policy-evaluation",
    )
  ) {
    return;
  }
  if (!acceptsJsonBody(req)) {
    rejectNonJson(res);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  const body = LocalPolicyRecommendationRunBody.safeParse(parsed);
  if (!body.success) {
    json(res, 400, {
      error: "invalid policy recommendation run request",
      issues: body.error.issues,
    });
    return;
  }

  const evaluatedAt = resolveCanonicalTimestamp(body.data.evaluatedAt);
  if (!evaluatedAt) {
    json(res, 400, {
      error: "evaluatedAt must be a canonical UTC ISO timestamp",
    });
    return;
  }
  if (evaluatedAt.date.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
    json(res, 422, {
      error: `evaluatedAt is more than ${MAX_FUTURE_SKEW_MS}ms in the future`,
    });
    return;
  }

  // Local-only generator: createdBy is a self-reported agent/operator label.
  // The generated suggestions still require human accept/reject decisions.
  const recommendationInput = {
    createdBy: body.data.createdBy,
    evaluatedAt: evaluatedAt.value,
    ...(body.data.limit === undefined ? {} : { limit: body.data.limit }),
  };
  const result = await store.recordPolicyEvaluationRecommendations(recommendationInput);
  // Even duplicate/no-signal runs append policy_recommendation_runs rows.
  invalidateStateCache();
  json(res, 200, result);
}

async function handleLocalWorkItemSuggestionRun(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
  invalidateStateCache: () => void,
): Promise<void> {
  if (
    !guardLocalWriteRequest(
      req,
      res,
      localWrites,
      "/agent-suggestion-runs/work-items",
    )
  ) {
    return;
  }
  if (!acceptsJsonBody(req)) {
    rejectNonJson(res);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  const body = LocalWorkItemSuggestionRunBody.safeParse(parsed);
  if (!body.success) {
    json(res, 400, {
      error: "invalid work item suggestion run request",
      issues: body.error.issues,
    });
    return;
  }

  const evaluatedAt = resolveCanonicalTimestamp(body.data.evaluatedAt);
  if (!evaluatedAt) {
    json(res, 400, {
      error: "evaluatedAt must be a canonical UTC ISO timestamp",
    });
    return;
  }
  if (evaluatedAt.date.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
    json(res, 422, {
      error: `evaluatedAt is more than ${MAX_FUTURE_SKEW_MS}ms in the future`,
    });
    return;
  }

  // Local-only generator: suggestions are drafts attached to current assigned
  // work items. Humans still accept/reject drafts and resolve/waive work items.
  const result = store.recordWorkItemSuggestions({
    createdBy: body.data.createdBy,
    evaluatedAt: evaluatedAt.value,
    ...(body.data.limit === undefined ? {} : { limit: body.data.limit }),
  });
  if (result.recorded > 0) invalidateStateCache();
  json(res, 200, result);
}

async function handleNotificationRetry(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
  readinessNotifications: ReadinessNotificationHandler,
  fallbackNotifications: FallbackNotificationHandler,
  terminalDriftNotifications: TerminalDriftNotificationHandler,
): Promise<void> {
  if (!guardLocalWriteRequest(req, res, localWrites, "/notification-retry")) return;
  if (!acceptsJsonBody(req)) {
    rejectNonJson(res);
    return;
  }

  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (err) {
    sendBodyError(res, err);
    return;
  }

  const body = NotificationRetryBody.safeParse(parsed);
  if (!body.success) {
    json(res, 400, {
      error: "invalid notification-retry request",
      issues: body.error.issues,
    });
    return;
  }
  if (body.data.fingerprint && body.data.alertKey) {
    json(res, 400, {
      error: "fingerprint and alertKey filters are mutually exclusive",
    });
    return;
  }
  const limit = body.data.limit ?? 25;
  if (limit < 1 || limit > 100) {
    json(res, 400, { error: "limit must be between 1 and 100" });
    return;
  }

  const readinessCandidates = body.data.alertKey
    ? []
    : store.readinessNotificationRetryCandidates({
        ...(body.data.dealId ? { dealId: body.data.dealId } : {}),
        ...(body.data.fingerprint ? { fingerprint: body.data.fingerprint } : {}),
        limit: limit + 1,
      });
  const terminalDriftCandidates = body.data.fingerprint
    ? []
    : store.commercialTerminalDriftAlertRetryCandidates({
        ...(body.data.dealId ? { dealId: body.data.dealId } : {}),
        ...(body.data.alertKey ? { alertKey: body.data.alertKey } : {}),
        limit: limit + 1,
      });
  type ReadinessRetryCandidate = (typeof readinessCandidates)[number];
  type RetryCandidate =
    | ReadinessRetryCandidate
    | CommercialTerminalDriftAlertRetryCandidate;
  const candidates: RetryCandidate[] = [];
  for (
    let i = 0;
    candidates.length < limit + 1 &&
    (i < readinessCandidates.length || i < terminalDriftCandidates.length);
    i += 1
  ) {
    const readiness = readinessCandidates[i];
    if (readiness) candidates.push(readiness);
    const terminalDrift = terminalDriftCandidates[i];
    if (terminalDrift && candidates.length < limit + 1) {
      candidates.push(terminalDrift);
    }
  }
  const attempted = candidates.slice(0, limit);
  const results: Array<Record<string, unknown>> = [];

  for (const candidate of attempted) {
    if (candidate.type === "terminal_drift") {
      const claim = store.claimCommercialTerminalDriftAlertRetry(
        candidate.alertKey,
      );
      if (!claim) {
        results.push({ ...candidate, status: "lost_race", receipts: 0 });
        continue;
      }
      const delivery = await deliverTerminalDriftNotification(
        store,
        terminalDriftNotifications,
        claim,
      );
      results.push({
        ...candidate,
        status: delivery?.status ?? "lost_race",
        receipts: delivery?.receipts ?? 0,
      });
      continue;
    }

    if (candidate.type === "primary") {
      const claim = store.claimReadinessNotificationRetry(
        candidate.dealId,
        candidate.fingerprint,
      );
      if (!claim) {
        results.push({ ...candidate, status: "lost_race", receipts: 0 });
        continue;
      }
      let receipts: Array<{
        system: string;
        externalId: string;
        detail: string;
        status?: "ok" | "warning";
        url?: string;
      }>;
      try {
        receipts = await readinessNotifications.notify(claim);
      } catch (err) {
        receipts = [
          {
            system: "slack",
            externalId: "readiness-notification",
            detail: `deployment readiness notification failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
            status: "warning",
          },
        ];
      }
      const delivery = store.recordReadinessNotificationEvent(
        claim,
        readinessNotifications.eventMode,
        receipts,
      );
      const result: Record<string, unknown> = {
        ...candidate,
        status: delivery.status,
        receipts: receipts.length,
      };
      if (delivery.fallbackClaim) {
        const fallback = await deliverFallbackNotification(
          store,
          fallbackNotifications,
          delivery.fallbackClaim,
        );
        if (fallback) {
          result.fallbackStatus = fallback.status;
          result.fallbackReceipts = fallback.receipts;
        }
      }
      results.push(result);
      continue;
    }

    const fallbackClaim = store.claimReadinessFallback(
      candidate.dealId,
      candidate.fingerprint,
    );
    if (!fallbackClaim) {
      results.push({
        ...candidate,
        status: store.readinessFallbackClaimMissStatus(candidate.fingerprint),
        receipts: 0,
      });
      continue;
    }
    const fallback = await deliverFallbackNotification(
      store,
      fallbackNotifications,
      fallbackClaim,
    );
    results.push({
      ...candidate,
      status: fallback?.status ?? "lost_race",
      receipts: fallback?.receipts ?? 0,
    });
  }

  json(res, 200, {
    attempted: attempted.length,
    results,
    ...(candidates.length > limit ? { moreAvailable: true } : {}),
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  enricher: Enricher,
  loadHealth: HealthLoader,
  loadState: () => ConsoleState,
  invalidateStateCache: () => void,
  html: string,
  options: ServerOptions,
  requestUrlOptions: RequestUrlOptions,
  localWrites: LocalWriteEndpointOptions,
  readinessNotifications: ReadinessNotificationHandler,
  fallbackNotifications: FallbackNotificationHandler,
  terminalDriftNotifications: TerminalDriftNotificationHandler,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = req.method === "HEAD" ? "GET" : req.method;
  const head = req.method === "HEAD";
  const invalidateIfSuccessful = (): void => {
    if (res.statusCode < 400) invalidateStateCache();
  };
  if (method === "GET" && url === "/healthz") {
    json(res, 200, { ok: true }, head);
    return;
  }
  if (method === "GET" && url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (method === "GET" && url === "/dashboard.js") {
    const js = dashboardAssets().js;
    res.writeHead(200, {
      "content-type": "text/javascript; charset=utf-8",
      "content-length": String(Buffer.byteLength(js)),
    });
    res.end(head ? undefined : js);
    return;
  }
  if (method === "GET" && url === "/dashboard.css") {
    const css = dashboardAssets().css;
    res.writeHead(200, {
      "content-type": "text/css; charset=utf-8",
      "content-length": String(Buffer.byteLength(css)),
    });
    res.end(head ? undefined : css);
    return;
  }
  if (method === "GET" && url === "/metrics") {
    json(res, 200, store.metrics(), head);
    return;
  }
  if (method === "GET" && url === "/state") {
    json(res, 200, loadState(), head);
    return;
  }
  const eventsMatch = url.match(/^\/deals\/([^/]+)\/events$/);
  if (method === "GET" && eventsMatch) {
    const dealId = safeDecodeURIComponent(eventsMatch[1] ?? "");
    if (dealId === null) {
      json(res, 400, { error: "deal id is not valid URL encoding" }, head);
      return;
    }
    json(res, 200, store.eventsBookended(dealId, STATE_EVENTS_PER_DEAL), head);
    return;
  }
  if (method === "GET" && url === "/integration-health") {
    if (head) {
      json(res, 200, [], true);
      return;
    }
    json(res, 200, await loadHealth(), head);
    return;
  }
  if (method === "GET" && url === "/") {
    res.writeHead(200, {
      "content-type": "text/html",
      "content-length": String(Buffer.byteLength(html)),
    });
    res.end(head ? undefined : html);
    return;
  }
  if (method === "POST" && url === "/preview") {
    if (!acceptsJsonBody(req)) {
      rejectNonJson(res);
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonBody(await readBody(req));
    } catch (err) {
      sendBodyError(res, err);
      return;
    }
    json(res, 200, await previewDeal(parsed, enricher));
    return;
  }
  if (method === "POST" && url === "/webhooks/hubspot") {
    await handleHubSpotWebhook(
      req,
      res,
      store,
      options.stageChanges,
      requestUrlOptions,
    );
    invalidateIfSuccessful();
    return;
  }
  if (method === "POST" && url === "/commercial-state") {
    await handleLocalCommercialState(
      req,
      res,
      store,
      localWrites,
      readinessNotifications,
      fallbackNotifications,
      terminalDriftNotifications,
      invalidateStateCache,
    );
    return;
  }
  if (method === "POST" && url === "/deployment-facts") {
    await handleLocalDeploymentFacts(
      req,
      res,
      store,
      localWrites,
      readinessNotifications,
      fallbackNotifications,
      invalidateStateCache,
    );
    return;
  }
  if (method === "POST" && url === "/outcomes") {
    await handleLocalOutcome(req, res, store, localWrites, invalidateStateCache);
    return;
  }
  if (method === "POST" && url === "/enrichment-observations") {
    await handleLocalEnrichmentObservation(
      req,
      res,
      store,
      localWrites,
      invalidateStateCache,
    );
    return;
  }
  if (method === "POST" && url === "/quarantine-replay") {
    await handleQuarantineReplay(
      req,
      res,
      store,
      localWrites,
      enricher,
      options.pipelineOptions ?? {},
      invalidateStateCache,
    );
    return;
  }
  if (method === "POST" && url === "/agent-suggestions") {
    await handleLocalAgentSuggestion(
      req,
      res,
      store,
      localWrites,
      invalidateStateCache,
    );
    return;
  }
  if (method === "POST" && url === "/agent-suggestion-runs/policy-evaluation") {
    await handleLocalPolicyRecommendationRun(
      req,
      res,
      store,
      localWrites,
      invalidateStateCache,
    );
    return;
  }
  if (method === "POST" && url === "/agent-suggestion-runs/work-items") {
    await handleLocalWorkItemSuggestionRun(
      req,
      res,
      store,
      localWrites,
      invalidateStateCache,
    );
    return;
  }
  if (method === "POST" && url === "/work-items") {
    await handleLocalWorkItem(
      req,
      res,
      store,
      localWrites,
      invalidateStateCache,
    );
    return;
  }
  const workItemActionMatch = url.match(/^\/work-items\/([^/]+)\/action$/);
  if (method === "POST" && workItemActionMatch) {
    const workItemId = safeDecodeURIComponent(workItemActionMatch[1] ?? "");
    if (workItemId === null) {
      json(res, 400, { error: "work item id is not valid URL encoding" });
      return;
    }
    await handleLocalWorkItemAction(
      req,
      res,
      store,
      localWrites,
      workItemId,
      invalidateStateCache,
    );
    return;
  }
  const agentSuggestionDecisionMatch = url.match(
    /^\/agent-suggestions\/([^/]+)\/decision$/,
  );
  if (method === "POST" && agentSuggestionDecisionMatch) {
    const suggestionId = safeDecodeURIComponent(
      agentSuggestionDecisionMatch[1] ?? "",
    );
    if (suggestionId === null) {
      json(res, 400, { error: "suggestion id is not valid URL encoding" });
      return;
    }
    await handleLocalAgentSuggestionDecision(
      req,
      res,
      store,
      localWrites,
      suggestionId,
      invalidateStateCache,
    );
    return;
  }
  if (method === "POST" && url === "/notification-retry") {
    await handleNotificationRetry(
      req,
      res,
      store,
      localWrites,
      readinessNotifications,
      fallbackNotifications,
      terminalDriftNotifications,
    );
    invalidateIfSuccessful();
    return;
  }
  if (method === "POST" && url === "/deals") {
    if (!acceptsJsonBody(req)) {
      rejectNonJson(res);
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonBody(await readBody(req));
    } catch (err) {
      sendBodyError(res, err);
      return;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const maxDeals =
      options.liveIntegrations === true ? MAX_LIVE_BATCH_DEALS : MAX_BATCH_DEALS;
    if (list.length > maxDeals) {
      json(res, 413, {
        error: `batch too large: ${list.length} deals exceeds ${maxDeals}`,
      });
      return;
    }
    const outcomes = await processBatch(
      list,
      store,
      enricher,
      options.pipelineOptions ?? {},
    );
    invalidateStateCache();
    json(res, 200, {
      processed: outcomes.length,
      routed: outcomes.filter((o) => o.ok).length,
      quarantined: outcomes.filter((o) => !o.ok).length,
      outcomes,
    });
    return;
  }
  json(res, 404, { error: "not found", url }, head);
}
