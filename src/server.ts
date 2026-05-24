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
 *   POST /agent-suggestions   local-only agent draft ledger
 *   POST /agent-suggestions/:id/decision
 *   POST /agent-suggestion-runs/policy-evaluation
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
import { z } from "zod";
import { MAX_FUTURE_SKEW_MS } from "./constants.js";
import type { Enricher } from "./enrich.js";
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
import type { Store } from "./store.js";
import type {
  AgentSuggestionRecord,
  DeploymentReadinessState,
  CommercialTerminalDriftAlertClaim,
  CommercialTerminalDriftAlertRetryCandidate,
  Metrics,
  PolicyEvaluationReports,
  PolicyRecommendationRunRecord,
  Quarantine,
  ReadinessFallbackNotificationClaim,
  ReadinessNotificationClaim,
  RoleQueues,
  RoutedDeal,
} from "./types.js";
import {
  AgentSuggestionKind,
  AgentSuggestionDecision,
  CommercialState,
  OutcomeReasonCategory,
  OutcomeState,
} from "./types.js";

const MAX_BODY_BYTES = 1_000_000;
const STATE_DEAL_LIMIT = 200;
const STATE_EXCEPTION_LIMIT = 100;
const STATE_EVENTS_PER_DEAL = 50;
const STATE_ROLE_QUEUE_LIMIT = 50;
const STATE_AGENT_SUGGESTION_LIMIT = 50;
const STATE_POLICY_RECOMMENDATION_RUN_LIMIT = 25;
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
  quarantine?: Quarantine;
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
  roleQueues: RoleQueues;
  roleQueueLimit: number;
  policyEvaluation: PolicyEvaluationReports;
  policyRecommendationRuns: PolicyRecommendationRunRecord[];
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

const LocalPolicyRecommendationRunBody = z.object({
  createdBy: z.string().trim().min(1).max(120),
  evaluatedAt: CanonicalUtcIsoString.optional(),
  limit: z.number().int().min(1).max(25).optional(),
});

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
  const quarantineLabels = store.intakeLabels(
    quarantined.map((record) => record.quarantine.dealId),
  );

  const routedQueue: ConsoleDeal[] = routed.map(({ deal, updatedAt, sinkStatus, externalStage }) => {
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
    };
  });
  const quarantinedQueue: ConsoleDeal[] = quarantined.map(
    ({ quarantine, updatedAt, externalStage }) => {
      return {
        id: quarantine.dealId,
        company: quarantineCompany(quarantine, quarantineLabels),
        stage: "quarantined",
        amount: 0,
        route: "-",
        reason: quarantine.code,
        status: "quarantined",
        updatedAt,
        quarantine,
        externalStage,
      };
    },
  );
  const queue = [...routedQueue, ...quarantinedQueue].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const integrity = store.integrity();
  const now = new Date().toISOString();
  const deploymentReadiness = store.deploymentReadinessRecords(now);

  return {
    metrics,
    sinkLabel,
    integrity,
    queue,
    exceptions: quarantined.map((record) => record.quarantine),
    deploymentReadiness,
    agentSuggestions: store.agentSuggestions(STATE_AGENT_SUGGESTION_LIMIT),
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
<style>
 :root{--bg:#f5f7fa;--ink:#141820;--muted:#5e6a7d;--line:#d8dee8;--panel:#fff;--soft:#edf1f6;--green:#087a55;--amber:#9f5c12;--red:#b42318;--blue:#245edb;--violet:#6941c6}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
 button,input,select,textarea{font:inherit}
 button{border:1px solid var(--ink);background:var(--ink);color:#fff;border-radius:5px;padding:8px 11px;cursor:pointer}
 button.secondary{background:#fff;color:var(--ink);border-color:var(--line)}
 button:disabled{opacity:.55;cursor:not-allowed}
 input,select,textarea{width:100%;border:1px solid var(--line);border-radius:5px;background:#fff;color:var(--ink);padding:8px 9px}
 textarea{min-height:76px;resize:vertical}
 label{display:grid;gap:5px;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
 .shell{max-width:1440px;margin:0 auto;padding:22px}
 header{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;border-bottom:2px solid var(--ink);padding-bottom:14px;margin-bottom:14px}
 h1{font-size:28px;line-height:1;margin:0;font-weight:750;letter-spacing:0}
 h2{font-size:13px;margin:0 0 10px;text-transform:uppercase;letter-spacing:.06em}
 .sub{color:var(--muted);margin-top:7px}.stamp{font:12px/1.25 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--ink);padding:8px 10px;background:#fff;white-space:nowrap}
 .top{display:grid;grid-template-columns:1.1fr 1fr;gap:12px;margin-bottom:12px}
 .kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
 .card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:6px}
 .card{padding:12px;min-height:86px}.v{font-size:26px;font-weight:750;line-height:1}.l{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-top:7px}.d{color:var(--muted);font-size:12px;margin-top:4px}
 .panel{padding:14px}.health{display:grid;gap:7px}.health-row{display:grid;grid-template-columns:58px 1fr;gap:8px;border-top:1px solid var(--line);padding-top:7px;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace}
 .layout{display:grid;grid-template-columns:360px minmax(420px,1fr) 410px;gap:12px;align-items:start}
 .form{display:grid;gap:10px}.two{display:grid;grid-template-columns:1fr 1fr;gap:9px}.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
 .preview{border:1px solid var(--line);background:var(--soft);border-radius:5px;padding:10px;min-height:80px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
 table{border-collapse:collapse;width:100%;font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace}
 td,th{border-top:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}th{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em}
 tr.selectable{cursor:pointer}tr.selectable:hover{background:#f8fafc}tr.selected{background:#edf4ff}
 .pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 7px;background:#fff;white-space:nowrap}
 .pass{color:var(--green)}.warn{color:var(--amber)}.fail,.risk{color:var(--red)}.muted{color:var(--muted)}.blue{color:var(--blue)}.violet{color:var(--violet)}
 .detail{display:grid;gap:12px}.section{border-top:1px solid var(--line);padding-top:10px}.kv{display:grid;grid-template-columns:128px 1fr;gap:7px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.kv div:nth-child(odd){color:var(--muted)}
 .journey{display:grid;gap:8px}.event{border:1px solid var(--line);background:#fff;border-radius:5px;padding:8px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;white-space:pre-wrap}
 .receipts{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.receipt{border:1px solid var(--line);border-radius:999px;padding:2px 7px;background:#fff;font-size:11px}
 .empty{border:1px dashed var(--line);border-radius:5px;padding:14px;color:var(--muted);background:#fff}
 .mini-form{display:grid;gap:8px;margin-bottom:10px}.inline-actions{display:flex;gap:6px;flex-wrap:wrap}.inline-actions button{padding:5px 8px;font-size:12px}
 .action-status{font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);min-height:18px}
 dialog{border:1px solid var(--line);border-radius:8px;padding:0;max-width:460px;width:calc(100% - 32px);color:var(--ink);box-shadow:0 14px 44px rgba(20,24,32,.24)}
 dialog::backdrop{background:rgba(20,24,32,.42)}
 .dialog-body{display:grid;gap:10px;padding:16px}
 .dialog-body h3{margin:0;font-size:15px}
 .dialog-detail{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);overflow-wrap:anywhere}
 .dialog-caption{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
 .dialog-draft{border:1px solid var(--line);background:var(--soft);border-radius:5px;padding:9px 10px;max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
 .queue-wrap{max-height:560px;overflow:auto}.exceptions,.handoff-wrap{max-height:260px;overflow:auto}
 .footer{color:var(--muted);font-size:12px;margin-top:12px}
 @media(max-width:1180px){.layout,.top{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
 @media(max-width:640px){.shell{padding:14px}.two,.kpis{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column}.stamp{white-space:normal}.layout{grid-template-columns:1fr}.queue-wrap{max-height:none}}
</style></head><body>
<div class="shell">
<header>
 <div>
  <h1>GTM Ops Router</h1>
  <div class="sub">Inbound deal operations across sales, finance, legal, HubSpot, and Slack.</div>
 </div>
 <div class="stamp">SINK ${escapeHtml(sinkLabel)}<br><span id="last-refresh">loading</span></div>
</header>
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
<script>
const fmtMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const LOCAL_SECRET_STORAGE_KEY = "gtm_ops_router_local_secret";
const AGENT_SUGGESTION_DRAFT_LIMIT = 10;
const AGENT_SUGGESTION_RUNNER = "console-policy-agent";
const OPERATOR_PRINCIPAL = "operator-console";
let state = null;
let selectedId = null;
let stateRequestSeq = 0;
let healthRequestSeq = 0;
let detailRequestSeq = 0;
const pendingSuggestionDecisions = new Set();

function qs(sel){ return document.querySelector(sel); }
function el(tag, className, text){
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function statusClass(status){
  if (status === "pass" || status === "synced") return "pass";
  if (status === "warn" || status === "partial" || status === "dry_run" || status === "needs_review") return "warn";
  return "fail";
}
function routeText(deal){
  return deal.route;
}
function fmtHours(value){
  if (value == null) return "n/a";
  if (value > 0 && value < 0.01) return "<0.01h";
  return Number(Number(value).toFixed(2)).toString() + "h";
}
function payloadFromForm(){
  const fd = new FormData(qs("#deal-form"));
  const optionalString = (name) => {
    const value = String(fd.get(name) || "").trim();
    return value.length ? value : undefined;
  };
  const dealUSD = Number(fd.get("dealUSD") || 0);
  if (!Number.isFinite(dealUSD)) throw new Error("Deal USD must be a finite number.");
  return {
    company: String(fd.get("company") || ""),
    domain: optionalString("domain"),
    contactName: String(fd.get("contactName") || ""),
    contactEmail: String(fd.get("contactEmail") || ""),
    dealUSD,
    region: String(fd.get("region") || "NA"),
    sourceChannel: String(fd.get("sourceChannel") || "website_chat"),
    statedNeed: String(fd.get("statedNeed") || "")
  };
}
async function fetchJson(url, init){
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = body && typeof body === "object" && body.error ? body.error : body || res.statusText;
    const detailText = typeof detail === "string" ? detail : JSON.stringify(detail);
    throw new Error("HTTP " + res.status + ": " + (detailText || res.statusText));
  }
  return body;
}
function hash32(input, seed){
  // FNV-1a-style deterministic browser key material; the server still treats
  // the formatted value only as an idempotency key, never as randomness.
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function deterministicUuidV4(input){
  const hex =
    hash32(input, 0x811c9dc5) +
    hash32(input, 0x9e3779b9) +
    hash32(input, 0x85ebca6b) +
    hash32(input, 0xc2b2ae35);
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const normalized = hex.slice(0, 12) + "4" + hex.slice(13, 16) + variant + hex.slice(17);
  return normalized.slice(0, 8) + "-" + normalized.slice(8, 12) + "-" + normalized.slice(12, 16) + "-" + normalized.slice(16, 20) + "-" + normalized.slice(20);
}
function localWriteHeaders(){
  const input = qs("#local-secret");
  const secret = input ? String(input.value || "").trim() : "";
  if (!secret) throw new Error("LOCAL_ENDPOINT_SECRET required");
  sessionStorage.setItem(LOCAL_SECRET_STORAGE_KEY, secret);
  return {"content-type":"application/json","x-local-endpoint-secret":secret};
}
function setAgentActionStatus(message, className){
  const root = qs("#agent-action-status");
  root.className = "action-status" + (className ? " " + className : "");
  root.textContent = message;
}
function renderKpis(){
  const m = state.metrics;
  const readiness = m.deploymentReadiness || {not_required:0,pending:0,ready:0,blocked:0};
  const roleQueues = state.roleQueues || {};
  const policyEvaluation = state.policyEvaluation || {candidateRouted:0,candidateLimit:0,signalBackfillRouted:0,signalBackfillLimitPerSignal:0,selfServeExpanded:[],humanAssistedRisk:[],sourceChannels:[],flags:[]};
  const actionRoleDealCount = new Set(
    [
      ...(roleQueues.ae_attention || []),
      ...(roleQueues.finance_review || []),
      ...(roleQueues.legal_review || []),
      ...(roleQueues.deployment_readiness || [])
    ].map((row) => row.dealId)
  ).size;
  const policySignalCount =
    (policyEvaluation.selfServeExpanded || []).length +
    (policyEvaluation.humanAssistedRisk || []).length;
  const churnRiskDetail =
    m.outcomeChurnBeforeDeploy === 1
      ? "churn-before-deploy warning"
      : "churn-before-deploy warnings";
  const cards = [
    ["Routed ARR", fmtMoney.format(m.routedArrUsd), fmtMoney.format(m.humanRoutedArrUsd) + " human-owned"],
    ["Open Queue", state.queue.length, "visible work items"],
    ["Settlement", state.integrity.ok ? "PASS" : "FAIL", state.integrity.detail],
    ["Routed", m.routed, m.conversionPct + "% conversion"],
    ["Quarantined", m.quarantined, m.quarantineRatePct + "% loud failure"],
    ["Finance Flags", m.flags.pricing_approval, "pricing approval"],
    ["Legal Flags", m.flags.regulated_review, "regulated review"],
    ["Auto-handled", m.autoHandled, "nurture + self-serve"],
    ["Partial Syncs", m.partialSyncs, "routed with downstream warning"],
    ["Sync Gaps", m.externallySyncedStoreErrors, "external sync succeeded, local store failed"],
    ["Audit Gaps", m.stageNotificationAuditGaps, "stage notification audit rows needing attention"],
    ["Visible Role Work", actionRoleDealCount, "unique shown deals needing attention"],
    ["Policy Signals", policySignalCount, "routing-outcome patterns"],
    ["Deploy Ready", readiness.ready, readiness.blocked + " blocked"],
    ["Deploy Pending", readiness.pending, m.readinessPendingOverSla + " over SLA"],
    ["Fact Risk", m.readinessFactsStaleProjected, m.readinessFactsStaleIgnored + " stale ignored"],
    ["Deployed", m.deployedDeals, m.landedDeals + " landed"],
    ["Expansion ARR", fmtMoney.format(m.expandedArrDeltaUsd), m.expandedDeals + " expanded"],
    ["Won → Deployed", fmtHours(m.medianTimeClosedWonToDeployedHours), "median cycle time"],
    ["Deployed → Landed", fmtHours(m.medianTimeDeployedToLandedHours), "median cycle time"],
    ["Invalid Events", m.outcomeInvalidHistories, m.outcomeCommercialStateConflicts + " state conflicts"],
    ["Churned Early", m.outcomeChurnBeforeDeploy, churnRiskDetail],
    ["p95 Latency", m.latencyMsP95 + "ms", state.sinkLabel]
  ];
  const root = qs("#kpis");
  root.replaceChildren(...cards.map(([label, value, detail]) => {
    const card = el("div", "card");
    card.append(el("div", "v", value), el("div", "l", label), el("div", "d", detail));
    return card;
  }));
}
function renderHealth(checks){
  const root = qs("#health");
  if (!checks.length) {
    root.replaceChildren(el("div", "empty", "No health checks returned."));
    return;
  }
  root.replaceChildren(...checks.map((check) => {
    const row = el("div", "health-row");
    row.append(el("div", statusClass(check.status), check.status.toUpperCase()));
    const detail = el("div");
    detail.append(el("div", null, check.system + " / " + check.name + ": " + check.detail));
    if (check.hint) detail.append(el("div", "muted", check.hint));
    row.append(detail);
    return row;
  }));
}
function renderQueue(){
  const root = qs("#queue");
  if (!state.queue.length) {
    root.replaceChildren(el("div", "empty", "No deals yet."));
    return;
  }
  const table = el("table");
  const head = document.createElement("tr");
  ["Status", "Company", "ARR", "Route", "HubSpot Stage", "Reason"].forEach((h) => head.append(el("th", null, h)));
  table.append(head);
  for (const deal of state.queue) {
    const row = el("tr", "selectable" + (deal.id === selectedId ? " selected" : ""));
    row.addEventListener("click", () => selectDeal(deal.id));
    const hubspotStage = deal.externalStage
      ? (deal.externalStage.stageLabel || deal.externalStage.stageId)
      : "-";
    row.append(
      cell(deal.status, statusClass(deal.status)),
      cell(deal.company),
      cell(deal.amount ? fmtMoney.format(deal.amount) : "-"),
      cell(routeText(deal)),
      cell(hubspotStage),
      cell(deal.reason || "-")
    );
    table.append(row);
  }
  root.replaceChildren(table);
}
async function dealEvents(dealId){
  return fetchJson("/deals/" + encodeURIComponent(dealId) + "/events");
}
function cell(text, className){
  const td = el("td", className, text);
  return td;
}
function receiptBadges(events){
  const wrap = el("div", "receipts");
  for (const event of events) {
    if (event.meta && event.meta.kind === "sink") {
      for (const receipt of event.meta.receipts) {
        const badge = el("span", receipt.system === "hubspot" ? "receipt pass" : "receipt violet", receipt.system + " " + receipt.externalId);
        wrap.append(badge);
        if (receipt.url && /^https:\\/\\//.test(receipt.url)) {
          const link = el("a", "receipt pass", "Open " + receipt.system);
          link.href = receipt.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          wrap.append(link);
        }
      }
      continue;
    }
    if (event.meta && event.meta.kind === "hubspot_stage_change") {
      if (!event.meta.receipts.length) continue;
      wrap.append(el("span", "receipt pass", "HubSpot stage " + (event.meta.toStageLabel || event.meta.toStageId)));
      for (const receipt of event.meta.receipts) {
        wrap.append(el("span", receipt.status === "warning" ? "receipt warn" : "receipt violet", receipt.system + " " + receipt.externalId));
      }
      continue;
    }
  }
  return wrap;
}
function renderExceptions(){
  const root = qs("#exceptions");
  if (!state.exceptions.length) {
    root.replaceChildren(el("div", "empty", "No exceptions."));
    return;
  }
  const table = el("table");
  const head = document.createElement("tr");
  ["Code", "Record", "Reason"].forEach((h) => head.append(el("th", null, h)));
  table.append(head);
  for (const q of state.exceptions) {
    const row = document.createElement("tr");
    row.append(cell(q.code, "risk"), cell(q.dealId), cell(q.reason));
    table.append(row);
  }
  root.replaceChildren(table);
}
const roleQueueLabels = {
  ae_attention: "AE",
  finance_review: "Finance",
  legal_review: "Legal",
  deployment_readiness: "Deployment",
  growth_attribution: "Growth"
};
function rolePriorityClass(priority){
  if (priority === "high") return "fail";
  if (priority === "medium") return "warn";
  return "muted";
}
function renderRoleQueues(){
  const root = qs("#role-queues");
  const queues = state.roleQueues || {};
  const actionQueueKeys = ["ae_attention", "finance_review", "legal_review", "deployment_readiness"];
  const actionRows = actionQueueKeys.flatMap((queue) => queues[queue] || []);
  const growthRows = queues.growth_attribution || [];
  if (!actionRows.length && !growthRows.length) {
    root.replaceChildren(el("div", "empty", "No role-specific queue items."));
    return;
  }
  const renderTable = (rows, headers, buildCells) => {
    const table = el("table");
    const head = document.createElement("tr");
    headers.forEach((h) => head.append(el("th", null, h)));
    table.append(head);
    for (const item of rows) {
      const row = el("tr", "selectable" + (item.dealId === selectedId ? " selected" : ""));
      row.addEventListener("click", () => selectDeal(item.dealId));
      row.append(...buildCells(item));
      table.append(row);
    }
    return table;
  };
  const nodes = [];
  if (actionRows.length) {
    nodes.push(renderTable(
      actionRows,
      ["Queue", "Priority", "Company", "ARR", "Sales Owner", "Status", "Reason"],
      (item) => [
        cell(roleQueueLabels[item.queue] || item.queue),
        cell(item.priority, rolePriorityClass(item.priority)),
        cell(item.company),
        cell(fmtMoney.format(item.amount)),
        cell(item.salesOwner || "-"),
        cell(item.status),
        cell(item.reason)
      ]
    ));
  }
  if (growthRows.length) {
    nodes.push(el("div", "muted", "Growth attribution view"));
    nodes.push(renderTable(
      growthRows,
      ["Company", "ARR", "Source", "Route", "Status"],
      (item) => [
        cell(item.company),
        cell(fmtMoney.format(item.amount)),
        cell(item.sourceChannel),
        cell(item.routeKind),
        cell(item.status)
      ]
    ));
  }
  nodes.push(el("div", "muted", "Showing up to " + (state.roleQueueLimit || 50) + " rows per role from a bounded dashboard candidate set."));
  root.replaceChildren(...nodes);
}
const policySignalLabels = {
  self_serve_expanded: "Self-serve expanded",
  human_assisted_churned: "Human-assisted churned",
  human_assisted_stalled: "Human-assisted stalled",
  human_assisted_ready_not_started: "Ready, not started"
};
function renderPolicyEvaluation(){
  const root = qs("#policy-evaluation");
  const report = state.policyEvaluation || {};
  const selfServeRows = report.selfServeExpanded || [];
  const riskRows = report.humanAssistedRisk || [];
  const sourceRows = (report.sourceChannels || []).filter((row) => row.routed > 0);
  const flagRows = (report.flags || []).filter((row) => row.routed > 0);
  const nodes = [];
  if (!selfServeRows.length && !riskRows.length && !sourceRows.length && !flagRows.length) {
    nodes.push(el("div", "empty", "No policy evaluation signals yet."));
  }
  const renderDealSignals = (title, rows) => {
    nodes.push(el("div", "muted", title));
    const table = el("table");
    const head = document.createElement("tr");
    ["Signal", "Company", "ARR", "Source", "Owner", "Reason"].forEach((h) => head.append(el("th", null, h)));
    table.append(head);
    for (const item of rows) {
      const row = el("tr", "selectable" + (item.dealId === selectedId ? " selected" : ""));
      row.addEventListener("click", () => selectDeal(item.dealId));
      row.append(
        cell(policySignalLabels[item.signal] || item.signal),
        cell(item.company),
        cell(fmtMoney.format(item.amount)),
        cell(item.sourceChannel),
        cell(item.salesOwner || "-"),
        cell(item.reason)
      );
      table.append(row);
    }
    nodes.push(table);
  };
  const renderSummary = (title, rows, labelKey) => {
    nodes.push(el("div", "muted", title));
    const table = el("table");
    const head = document.createElement("tr");
    ["Segment", "Routed", "Won", "Started", "Deployed", "Landed", "Expanded Deals", "Churned", "Total Expansion ARR"].forEach((h) => head.append(el("th", null, h)));
    table.append(head);
    for (const item of rows) {
      const row = document.createElement("tr");
      row.append(
        cell(item[labelKey]),
        cell(item.routed),
        cell(item.closedWon),
        cell(item.deploymentStarted),
        cell(item.deployed),
        cell(item.landed),
        cell(item.expanded),
        cell(item.churned),
        cell(fmtMoney.format(item.expandedArrDeltaUsd))
      );
      table.append(row);
    }
    nodes.push(table);
  };
  if (selfServeRows.length) renderDealSignals("Self-serve expansion signals", selfServeRows);
  if (riskRows.length) renderDealSignals("Human-assisted risk signals", riskRows);
  if (sourceRows.length) renderSummary("Candidate-set source-channel outcomes", sourceRows, "sourceChannel");
  if (flagRows.length) renderSummary("Candidate-set flag outcomes", flagRows, "flag");
  nodes.push(el("div", "muted", "Read-only evaluation over " + (report.candidateRouted || 0) + " routed candidates: recent cap " + (report.candidateLimit || 0) + " plus " + (report.signalBackfillRouted || 0) + " signal backfills, capped at " + (report.signalBackfillLimitPerSignal || 0) + " per signal type. Routing thresholds are not changed automatically."));
  root.replaceChildren(...nodes);
}
function policyRunStatusClass(status){
  const classes = {
    recorded: "pass",
    idempotency_conflict: "fail",
    all_skipped: "warn",
    duplicate: "muted",
    no_signals: "muted"
  };
  return classes[status] || "muted";
}
function renderPolicyRuns(){
  const root = qs("#policy-runs");
  const runs = state.policyRecommendationRuns || [];
  if (!runs.length) {
    root.replaceChildren(el("div", "empty", "No policy recommendation runs yet."));
    return;
  }
  const table = el("table");
  const head = document.createElement("tr");
  ["Status", "Run", "Recorded At", "Evaluated At", "By", "Limit", "Attempted", "Recorded", "Duplicate", "Conflicts", "Skipped", "Signals"].forEach((h) => head.append(el("th", null, h)));
  table.append(head);
  for (const run of runs) {
    const row = document.createElement("tr");
    const signals = run.results.map((result) => {
      const label = policySignalLabels[result.signal] || result.signal;
      return label + " -> " + (result.suggestionId || result.status);
    });
    row.append(
      cell(run.status, policyRunStatusClass(run.status)),
      cell(run.id),
      cell(run.createdAt),
      cell(run.evaluatedAt),
      cell(run.createdBy),
      cell(run.limit),
      cell(run.attempted),
      cell(run.recorded),
      cell(run.duplicate),
      cell(run.idempotencyConflict),
      cell(run.skipped),
      cell(signals.length ? signals.join(", ") : "-")
    );
    table.append(row);
  }
  root.replaceChildren(
    table,
    el("div", "muted", "Showing latest " + runs.length + " policy runs.")
  );
}
const suggestionKindLabels = {
  handoff_summary: "Handoff",
  missing_field_question: "Missing field",
  stale_deal_nudge: "Stale deal",
  policy_change_recommendation: "Policy"
};
function suggestionStatusClass(status){
  if (status === "accepted") return "pass";
  if (status === "rejected") return "muted";
  return "warn";
}
function renderAgentSuggestions(){
  const root = qs("#agent-suggestions");
  const rows = state.agentSuggestions || [];
  if (!rows.length) {
    root.replaceChildren(el("div", "empty", "No agent suggestions."));
    return;
  }
  const table = el("table");
  const head = document.createElement("tr");
  ["Status", "Kind", "Deal", "Title", "Rationale", "Decision", "Action"].forEach((h) => head.append(el("th", null, h)));
  table.append(head);
  for (const suggestion of rows) {
    const row = el("tr", "selectable" + (selectedId && suggestion.dealId === selectedId ? " selected" : ""));
    row.addEventListener("click", () => selectDeal(suggestion.dealId));
    const decision = suggestion.status === "proposed"
      ? "awaiting human"
      : (suggestion.decidedBy || "-") + ": " + (suggestion.decisionReason || "-");
    const actionCell = document.createElement("td");
    const pendingDecision = pendingSuggestionDecisions.has(suggestion.id);
    if (suggestion.status === "proposed" && pendingDecision) {
      actionCell.textContent = "Deciding...";
    } else if (suggestion.status === "proposed") {
      const actions = el("div", "inline-actions");
      const accept = el("button", "secondary", "Accept");
      const reject = el("button", "secondary", "Reject");
      accept.type = "button";
      reject.type = "button";
      accept.addEventListener("click", (event) => {
        event.stopPropagation();
        void decideSuggestion(suggestion, "accepted");
      });
      reject.addEventListener("click", (event) => {
        event.stopPropagation();
        void decideSuggestion(suggestion, "rejected");
      });
      actions.append(accept, reject);
      actionCell.append(actions);
    } else {
      actionCell.textContent = "-";
    }
    row.append(
      cell(suggestion.status, suggestionStatusClass(suggestion.status)),
      cell(suggestionKindLabels[suggestion.kind] || suggestion.kind),
      cell(suggestion.dealId),
      cell(suggestion.title),
      cell(suggestion.rationale),
      cell(decision),
      actionCell
    );
    table.append(row);
  }
  root.replaceChildren(table);
}
async function draftPolicyRecommendations(){
  const button = qs("#draft-policy-btn");
  if (!button) {
    setAgentActionStatus("Draft button is not available.", "fail");
    return;
  }
  button.disabled = true;
  setAgentActionStatus("Drafting policy recommendations...", "muted");
  try {
    const result = await fetchJson("/agent-suggestion-runs/policy-evaluation", {
      method: "POST",
      headers: localWriteHeaders(),
      body: JSON.stringify({
        createdBy: AGENT_SUGGESTION_RUNNER,
        limit: AGENT_SUGGESTION_DRAFT_LIMIT
      })
    });
    setAgentActionStatus(
      "Policy run: " + result.recorded + " recorded, " + result.duplicate + " duplicate, " + result.skipped + " skipped.",
      result.recorded > 0 ? "pass" : "muted"
    );
    await loadState();
  } catch (err) {
    setAgentActionStatus(String(err), "fail");
  } finally {
    button.disabled = false;
  }
}
function defaultDecisionReason(decision){
  return decision === "accepted"
    ? "Accepted from operator console."
    : "Rejected from operator console.";
}
function openDecisionDialog(suggestion, decision){
  // Resolves with the reason string on confirm, or null if the operator
  // cancels (Cancel button, ESC, or backdrop). Replaces a blocking
  // window.prompt with an in-page modal; the decision contract is unchanged.
  return new Promise((resolve) => {
    const defaultReason = defaultDecisionReason(decision);
    const dialog = qs("#decision-dialog");
    if (!dialog || typeof dialog.showModal !== "function") {
      // Defensive fallback for environments without <dialog> support so a
      // decision is never silently dropped.
      const fallback = window.prompt("Decision reason", defaultReason);
      resolve(fallback === null ? null : (fallback.trim() || defaultReason));
      return;
    }
    if (dialog.open) {
      // A decision modal is already open: never stack showModal() (it throws
      // InvalidStateError) or attach a second close listener.
      resolve(null);
      return;
    }
    const verb = decision === "accepted" ? "Accept" : "Reject";
    qs("#decision-dialog-title").textContent = verb + " suggestion";
    qs("#decision-dialog-detail").textContent = suggestion.title || "(untitled suggestion)";
    qs("#decision-dialog-meta").textContent =
      (suggestionKindLabels[suggestion.kind] || suggestion.kind) + " | Deal " + suggestion.dealId;
    qs("#decision-dialog-body").textContent = suggestion.body || "(no draft body)";
    qs("#decision-dialog-rationale").textContent = suggestion.rationale || "(no rationale provided)";
    const reasonField = qs("#decision-dialog-reason");
    reasonField.value = defaultReason;
    qs("#decision-dialog-confirm").textContent = verb;
    function onClose(){
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue === "confirm" ? (reasonField.value.trim() || defaultReason) : null);
    }
    dialog.addEventListener("close", onClose);
    dialog.returnValue = "";
    dialog.showModal();
    reasonField.focus();
    reasonField.select();
  });
}
async function decideSuggestion(suggestion, decision){
  if (pendingSuggestionDecisions.has(suggestion.id)) return;
  // Lock BEFORE opening the async dialog. The old window.prompt was blocking,
  // so it could not be re-entered; <dialog> is async, so without an early lock
  // a rapid second click would re-open the modal and leak a close listener.
  // The lock is released in finally on cancel, success, or any error.
  pendingSuggestionDecisions.add(suggestion.id);
  try {
    renderAgentSuggestions();
    const reason = await openDecisionDialog(suggestion, decision);
    if (reason === null) return; // operator cancelled; finally releases the lock
    setAgentActionStatus(decision + " " + suggestion.id + "...", "muted");
    const result = await fetchJson("/agent-suggestions/" + encodeURIComponent(suggestion.id) + "/decision", {
      method: "POST",
      headers: localWriteHeaders(),
      body: JSON.stringify({
        sourceEventId: deterministicUuidV4("agent-suggestion-decision:" + suggestion.id + ":" + decision),
        decision,
        humanPrincipal: OPERATOR_PRINCIPAL,
        reason
      })
    });
    setAgentActionStatus(
      "Suggestion " + result.status + ": " + suggestion.title,
      result.status === "recorded" ? "pass" : "warn"
    );
    await loadState();
  } catch (err) {
    setAgentActionStatus(String(err), "fail");
  } finally {
    pendingSuggestionDecisions.delete(suggestion.id);
    if (state) renderAgentSuggestions();
  }
}
const blockerLabels = {
  deployment_use_case_unclear: "Use case unclear",
  deployment_integration_unknown: "Integration unknown",
  deployment_data_unavailable: "Data unavailable"
};
function readinessTitle(readiness){
  if (readiness === "not_required") return "Not required";
  if (readiness === "pending") return "Pending";
  if (readiness === "ready") return "Ready";
  return "Blocked";
}
function readinessDisplay(row){
  const staleProjection = row.factsStatus === "stale" && (row.readiness === "ready" || row.readiness === "blocked");
  return readinessTitle(row.readiness) + (staleProjection ? " (stale facts)" : "");
}
function readinessClass(row){
  if (row.factsStatus === "stale" && (row.readiness === "ready" || row.readiness === "blocked")) return "risk";
  if (row.readiness === "ready") return "pass";
  if (row.readiness === "pending") return "warn";
  if (row.readiness === "blocked") return "fail";
  return "muted";
}
function blockerDisplay(row){
  if (row.blockerCode) {
    const primary = blockerLabels[row.blockerCode] || row.blockerCode;
    const secondary = row.secondaryBlockerCodes && row.secondaryBlockerCodes.length
      ? " +" + row.secondaryBlockerCodes.length
      : "";
    return primary + secondary;
  }
  if (row.factsStatus === "missing") return "Awaiting facts";
  if (row.factsStatus === "stale") return "Facts stale";
  return "-";
}
function renderDeploymentHandoff(){
  const root = qs("#deployment-handoff");
  const rows = state.deploymentReadiness || [];
  if (!rows.length) {
    root.replaceChildren(el("div", "empty", "No deployment handoffs yet."));
    return;
  }
  const table = el("table");
  const head = document.createElement("tr");
  ["Router ID", "Readiness", "Blocker", "Reason", "Last Updated"].forEach((h) => head.append(el("th", null, h)));
  table.append(head);
  for (const rowState of rows) {
    const row = el("tr", "selectable" + (rowState.dealId === selectedId ? " selected" : ""));
    row.addEventListener("click", () => selectDeal(rowState.dealId));
    const reason = rowState.reason || (rowState.factsStatus === "missing" ? "awaiting deployment facts" : "-");
    row.append(
      cell(rowState.dealId),
      cell(readinessDisplay(rowState), readinessClass(rowState)),
      cell(blockerDisplay(rowState)),
      cell(reason),
      cell(rowState.updatedAt)
    );
    table.append(row);
  }
  root.replaceChildren(table);
}
function selectDeal(dealId){
  selectedId = dealId;
  renderQueue();
  renderRoleQueues();
  renderPolicyEvaluation();
  renderPolicyRuns();
  renderAgentSuggestions();
  renderDeploymentHandoff();
  void renderDetail();
}
async function renderDetail(){
  const seq = ++detailRequestSeq;
  const root = qs("#detail");
  const selected = selectedId ? state.queue.find((d) => d.id === selectedId) : null;
  const readiness = selectedId
    ? (state.deploymentReadiness || []).find((row) => row.dealId === selectedId)
    : null;
  if (selectedId && !selected && !readiness) {
    root.replaceChildren(el("div", "empty", "Selected deal " + selectedId + " is no longer in the current state payload. Refresh or select another record."));
    return;
  }
  const deal = selected || null;
  const detailId = selected?.id || readiness?.dealId || null;
  if (!detailId) {
    root.replaceChildren(el("div", "empty", "Select a deal."));
    return;
  }
  const detailReadiness = readiness || (state.deploymentReadiness || []).find((row) => row.dealId === detailId) || null;
  root.replaceChildren(el("div", "empty", "Loading deal journey..."));
  let eventBody;
  try {
    eventBody = await dealEvents(detailId);
  } catch (err) {
    if (seq !== detailRequestSeq) return;
    root.replaceChildren(el("div", "empty", "Could not load deal events: " + String(err)));
    return;
  }
  if (seq !== detailRequestSeq || selectedId !== detailId) return;
  const events = eventBody.events || [];
  const title = el("div", "section");
  title.append(el("h2", null, deal?.company || "Deployment handoff"));
  const kv = el("div", "kv");
  const fields = [["ID", detailId]];
  if (deal) {
    fields.push(
      ["Status", deal.status],
      ["Route", routeText(deal)],
      ["Reason", deal.reason || "-"],
      ["ARR", deal.amount ? fmtMoney.format(deal.amount) : "-"]
    );
  }
  if (detailReadiness) {
    fields.push(
      ["Readiness", readinessDisplay(detailReadiness)],
      ["Blocker", blockerDisplay(detailReadiness)],
      ["Facts", detailReadiness.factsStatus],
      ["Readiness Updated", detailReadiness.updatedAt]
    );
  }
  if (deal?.externalStage) {
    fields.push(["HubSpot ID", deal.externalStage.externalId]);
    fields.push(["HubSpot Stage", deal.externalStage.stageLabel || deal.externalStage.stageId]);
    fields.push(["Stage Updated", deal.externalStage.updatedAt]);
  }
  if (deal?.scoreTotal !== undefined) {
    fields.push(["Score", deal.scoreTotal.toFixed(2)]);
    fields.push(["Source", deal.sourceChannel || "-"]);
    fields.push(["Need", deal.statedNeed || "-"]);
  }
  if (deal?.quarantine) {
    fields.push(["Stage", deal.quarantine.stage]);
    fields.push(["Reason", deal.quarantine.reason]);
  }
  for (const [k, v] of fields) kv.append(el("div", null, k), el("div", null, v));
  title.append(kv, receiptBadges(events));
  const scoreBox = el("div", "section");
  scoreBox.append(el("h2", null, "Score Explanation"));
  if (deal?.scoreNotes && deal.scoreNotes.length) {
    const notes = el("div", "journey");
    for (const note of deal.scoreNotes) notes.append(el("div", "event", note));
    scoreBox.append(notes);
  } else {
    scoreBox.append(el("div", "empty", "No score notes available."));
  }
  const journey = el("div", "section");
  journey.append(el("h2", null, "Deal Journey"));
  const list = el("div", "journey");
  if (eventBody.truncated) {
    list.append(el("div", "empty", "Showing intake plus latest " + (events.length - 1) + " of " + eventBody.total + " events."));
  }
  for (const event of events) {
    list.append(el("div", "event", event.from + " -> " + event.to + " | " + event.detail + "\\n" + event.ts));
  }
  journey.append(list);
  root.replaceChildren(title, scoreBox, journey);
}
async function loadState(){
  const seq = ++stateRequestSeq;
  try {
    const next = await fetchJson("/state");
    if (seq !== stateRequestSeq) return;
    state = next;
    if (!selectedId && state.queue[0]) selectedId = state.queue[0].id;
    if (!selectedId && (state.deploymentReadiness || [])[0]) selectedId = state.deploymentReadiness[0].dealId;
    qs("#last-refresh").textContent = new Date().toLocaleTimeString();
    renderKpis();
    renderQueue();
    renderRoleQueues();
    renderPolicyEvaluation();
    renderPolicyRuns();
    renderAgentSuggestions();
    renderExceptions();
    renderDeploymentHandoff();
    void renderDetail();
  } catch (err) {
    if (seq !== stateRequestSeq) return;
    qs("#last-refresh").textContent = "state error " + new Date().toLocaleTimeString();
    if (!state) {
      const msg = "State load failed: " + String(err);
      qs("#kpis").replaceChildren(el("div", "empty", msg));
      qs("#queue").replaceChildren(el("div", "empty", msg));
      qs("#role-queues").replaceChildren(el("div", "empty", msg));
      qs("#policy-evaluation").replaceChildren(el("div", "empty", msg));
      qs("#policy-runs").replaceChildren(el("div", "empty", msg));
      qs("#agent-suggestions").replaceChildren(el("div", "empty", msg));
      qs("#exceptions").replaceChildren(el("div", "empty", msg));
      qs("#deployment-handoff").replaceChildren(el("div", "empty", msg));
      qs("#detail").replaceChildren(el("div", "empty", msg));
    }
  }
}
async function loadHealth(){
  const seq = ++healthRequestSeq;
  try {
    const checks = await fetchJson("/integration-health");
    if (seq !== healthRequestSeq) return;
    renderHealth(checks);
  } catch (err) {
    if (seq !== healthRequestSeq) return;
    renderHealth([{system:"integration",name:"health",status:"fail",detail:String(err)}]);
  }
}
async function preview(){
  const root = qs("#preview");
  root.textContent = "Previewing...";
  try {
    const body = await fetchJson("/preview", {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify(payloadFromForm())
    });
    if (!body.ok) {
      root.textContent = "QUARANTINE\\n" + body.stage + ": " + body.reason;
      return;
    }
    const d = body.deal;
    root.textContent = [
      "ROUTE " + (d.route.kind === "human_assisted" ? "human -> " + d.route.salesOwner : d.route.kind),
      "score " + d.score.total.toFixed(2) + " | " + fmtMoney.format(d.dealUSD),
      d.route.financeFlag ? "finance: " + d.route.financeFlag : "finance: none",
      d.route.legalFlag ? "legal: " + d.route.legalFlag : "legal: none",
      ...d.score.notes
    ].join("\\n");
  } catch (err) {
    root.textContent = "ERROR\\n" + String(err);
  }
}
const savedLocalSecret = sessionStorage.getItem(LOCAL_SECRET_STORAGE_KEY);
if (savedLocalSecret) qs("#local-secret").value = savedLocalSecret;
qs("#preview-btn").addEventListener("click", preview);
qs("#refresh-btn").addEventListener("click", () => { loadState(); loadHealth(); });
qs("#draft-policy-btn").addEventListener("click", () => { void draftPolicyRecommendations(); });
qs("#deal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const root = qs("#preview");
  const submit = qs("#submit-btn");
  root.textContent = "Submitting...";
  submit.disabled = true;
  try {
    const body = await fetchJson("/deals", {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify(payloadFromForm())
    });
    const first = body.outcomes && body.outcomes[0];
    if (first && first.ok) {
      selectedId = first.deal.id;
    }
    root.textContent = "Processed " + body.processed + " | routed " + body.routed + " | quarantined " + body.quarantined;
    await loadState();
  } catch (err) {
    root.textContent = "ERROR\\n" + String(err);
  } finally {
    submit.disabled = false;
  }
});
async function pollState(){
  await loadState();
  setTimeout(pollState, 5000);
}
async function pollHealth(){
  await loadHealth();
  setTimeout(pollHealth, 30000);
}
void pollState();
void pollHealth();
</script>
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
