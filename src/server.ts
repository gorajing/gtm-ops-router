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
  DeploymentReadinessState,
  CommercialTerminalDriftAlertClaim,
  CommercialTerminalDriftAlertRetryCandidate,
  Metrics,
  Quarantine,
  ReadinessFallbackNotificationClaim,
  ReadinessNotificationClaim,
  RoutedDeal,
} from "./types.js";
import { CommercialState, OutcomeReasonCategory, OutcomeState } from "./types.js";

const MAX_BODY_BYTES = 1_000_000;
const STATE_DEAL_LIMIT = 200;
const STATE_EXCEPTION_LIMIT = 100;
const STATE_EVENTS_PER_DEAL = 50;
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
}

type PreviewResult =
  | { ok: true; deal: RoutedDeal }
  | { ok: false; stage: "intake" | "enriched"; reason: string };

const LocalCommercialStateBody = z.object({
  dealId: z.string().min(1),
  commercialState: CommercialState,
  sourceEventId: z.string().regex(UUID_V4, "sourceEventId must be UUIDv4"),
  reason: z.string().min(1).max(500).optional(),
  expectedRedPath: z.boolean().optional(),
  occurredAt: z.string().min(1),
});

const LocalDeploymentFactsBody = z.object({
  dealId: z.string().min(1),
  sourceEventId: z.string().regex(UUID_V4, "sourceEventId must be UUIDv4"),
  useCaseClear: z.boolean(),
  integrationsKnown: z.boolean(),
  dataReady: z.boolean(),
  operator: z.string().trim().min(1).max(120),
  occurredAt: z.string().min(1),
});

const LocalOutcomeBody = z.object({
  dealId: z.string().min(1),
  sourceEventId: z.string().regex(UUID_V4, "sourceEventId must be UUIDv4"),
  outcome: OutcomeState,
  occurredAt: z.string().min(1),
  operator: z.string().trim().min(1).max(120),
  arrDeltaUsd: z.number().int("arrDeltaUsd must be an integer").optional(),
  reasonCategory: OutcomeReasonCategory.optional(),
});

const NotificationRetryBody = z.object({
  dealId: z.string().min(1).optional(),
  fingerprint: z.string().min(1).optional(),
  alertKey: z.string().min(1).optional(),
  limit: z.number().int().optional(),
});

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

  return {
    metrics,
    sinkLabel,
    integrity,
    queue,
    exceptions: quarantined.map((record) => record.quarantine),
    deploymentReadiness: store.deploymentReadinessRecords(),
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
</div>
<script>
const fmtMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
let state = null;
let selectedId = null;
let stateRequestSeq = 0;
let healthRequestSeq = 0;
let detailRequestSeq = 0;

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
function payloadFromForm(){
  const fd = new FormData(qs("#deal-form"));
  const optionalString = (name) => {
    const value = String(fd.get(name) || "").trim();
    return value.length ? value : undefined;
  };
  return {
    company: String(fd.get("company") || ""),
    domain: optionalString("domain"),
    contactName: String(fd.get("contactName") || ""),
    contactEmail: String(fd.get("contactEmail") || ""),
    dealUSD: Number(fd.get("dealUSD") || 0),
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
    throw new Error("HTTP " + res.status + ": " + detail);
  }
  return body;
}
function renderKpis(){
  const m = state.metrics;
  const readiness = m.deploymentReadiness || {not_required:0,pending:0,ready:0,blocked:0};
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
    ["Deploy Ready", readiness.ready, readiness.blocked + " blocked"],
    ["Deploy Pending", readiness.pending, m.readinessPendingOverSla + " over SLA"],
    ["Fact Risk", m.readinessFactsStaleProjected, m.readinessFactsStaleIgnored + " stale ignored"],
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
qs("#preview-btn").addEventListener("click", preview);
qs("#refresh-btn").addEventListener("click", () => { loadState(); loadHealth(); });
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
  const html = consoleHtml(sinkLabel);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(
      req,
      res,
      store,
      enricher,
      loadHealth,
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

  const occurredAt = new Date(body.data.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    json(res, 400, { error: "occurredAt must be a valid ISO timestamp" });
    return;
  }
  if (occurredAt.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
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
    occurredAt: occurredAt.toISOString(),
    reason: body.data.reason ?? null,
    expectedRedPath,
  });
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

async function handleLocalDeploymentFacts(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
  readinessNotifications: ReadinessNotificationHandler,
  fallbackNotifications: FallbackNotificationHandler,
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

  const occurredAt = new Date(body.data.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    json(res, 400, { error: "occurredAt must be a valid ISO timestamp" });
    return;
  }
  if (occurredAt.getTime() - Date.now() > MAX_FUTURE_SKEW_MS) {
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
    occurredAt: occurredAt.toISOString(),
  });
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
  if (parsed && typeof parsed === "object" && !("dealId" in parsed)) {
    const record = parsed as Record<string, unknown>;
    if ("hubspotDealId" in record || "externalDealId" in record) {
      return "router dealId required";
    }
  }
  return "invalid outcome request";
}

async function handleLocalOutcome(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  localWrites: LocalWriteEndpointOptions,
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

  const occurredAt = new Date(body.data.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) {
    json(res, 400, { error: "occurredAt must be a valid ISO timestamp" });
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
    occurredAt: occurredAt.toISOString(),
    operator: body.data.operator,
    arrDeltaUsd: body.data.arrDeltaUsd ?? null,
    reasonCategory: body.data.reasonCategory ?? null,
  });
  json(res, localOutcomeStatusCode(result.status), result);
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
    json(res, 200, buildState(store, options.sinkLabel ?? "logging"), head);
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
    );
    return;
  }
  if (method === "POST" && url === "/outcomes") {
    await handleLocalOutcome(req, res, store, localWrites);
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
