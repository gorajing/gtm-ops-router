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
 *
 * This is a local/operator-console surface. Put auth in front of it before
 * exposing it beyond localhost or a trusted internal network.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Enricher } from "./enrich.js";
import {
  type IntegrationCheck,
  runIntegrationDoctor,
} from "./integrations.js";
import { normalize } from "./intake.js";
import { enrichWithGate, processBatch, scoreAndRoute } from "./pipeline.js";
import type { PipelineOptions } from "./pipeline.js";
import type { Store } from "./store.js";
import type {
  Metrics,
  Quarantine,
  RoutedDeal,
} from "./types.js";

const MAX_BODY_BYTES = 1_000_000;
const STATE_DEAL_LIMIT = 200;
const STATE_EXCEPTION_LIMIT = 100;
const STATE_EVENTS_PER_DEAL = 50;
const HEALTH_TTL_MS = 35_000;
const MAX_BATCH_DEALS = 250;
const MAX_LIVE_BATCH_DEALS = 5;
const HEALTH_FAILURE_TTL_MS = 5_000;

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
  updatedAt: string | null;
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
}

type PreviewResult =
  | { ok: true; deal: RoutedDeal }
  | { ok: false; stage: "intake" | "enriched"; reason: string };

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

  const routedQueue: ConsoleDeal[] = routed.map(({ deal, updatedAt, sinkStatus }) => {
    return {
      id: deal.id,
      company: deal.company,
      stage: "routed",
      amount: deal.dealUSD,
      route: routeKindLabel(deal),
      reason: routeReason(deal),
      status: sinkStatus,
      updatedAt,
      scoreTotal: deal.score.total,
      scoreNotes: deal.score.notes,
      sourceChannel: deal.sourceChannel,
      statedNeed: deal.statedNeed,
    };
  });
  const quarantinedQueue: ConsoleDeal[] = quarantined.map(({ quarantine, updatedAt }) => {
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
    };
  });
  const queue = [...routedQueue, ...quarantinedQueue].sort((a, b) =>
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
  const integrity = store.integrity();

  return {
    metrics,
    sinkLabel,
    integrity,
    queue,
    exceptions: quarantined.map((record) => record.quarantine),
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
 .journey{display:grid;gap:8px}.event{border:1px solid var(--line);background:#fff;border-radius:5px;padding:8px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
 .receipts{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.receipt{border:1px solid var(--line);border-radius:999px;padding:2px 7px;background:#fff;font-size:11px}
 .empty{border:1px dashed var(--line);border-radius:5px;padding:14px;color:var(--muted);background:#fff}
 .queue-wrap{max-height:560px;overflow:auto}.exceptions{max-height:260px;overflow:auto}
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
const eventCache = new Map();
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
  ["Status", "Company", "ARR", "Route", "Reason"].forEach((h) => head.append(el("th", null, h)));
  table.append(head);
  for (const deal of state.queue) {
    const row = el("tr", "selectable" + (deal.id === selectedId ? " selected" : ""));
    row.addEventListener("click", () => { selectedId = deal.id; renderQueue(); renderDetail(); });
    row.append(
      cell(deal.status, statusClass(deal.status)),
      cell(deal.company),
      cell(deal.amount ? fmtMoney.format(deal.amount) : "-"),
      cell(routeText(deal)),
      cell(deal.reason || "-")
    );
    table.append(row);
  }
  root.replaceChildren(table);
}
async function dealEvents(dealId){
  if (eventCache.has(dealId)) return eventCache.get(dealId);
  const loaded = await fetchJson("/deals/" + encodeURIComponent(dealId) + "/events");
  eventCache.set(dealId, loaded);
  return loaded;
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
    // Legacy rows written before structured sink metadata carried receipt data
    // only in the event detail string.
    const hub = event.detail.match(/hubspot:([^ ]+) ([^|]+)/);
    const slack = event.detail.match(/slack:([^ ]+) ([^|]+)/);
    const url = event.detail.match(/https:\\/\\/[^ )]+/);
    if (hub) {
      const badge = el("span", "receipt pass", "HubSpot " + hub[1]);
      if (url) {
        const link = el("a", "receipt pass", "Open HubSpot");
        link.href = url[0];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        wrap.append(badge);
        wrap.append(link);
      } else {
        wrap.append(badge);
      }
    }
    if (slack) wrap.append(el("span", "receipt violet", "Slack " + slack[1]));
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
async function renderDetail(){
  const seq = ++detailRequestSeq;
  const root = qs("#detail");
  const selected = selectedId ? state.queue.find((d) => d.id === selectedId) : null;
  if (selectedId && !selected) {
    root.replaceChildren(el("div", "empty", "Selected deal " + selectedId + " is outside the visible queue. Refresh or submit a new deal to select another record."));
    return;
  }
  const deal = selected || state.queue[0];
  if (!deal) {
    root.replaceChildren(el("div", "empty", "Select a deal."));
    return;
  }
  selectedId = deal.id;
  root.replaceChildren(el("div", "empty", "Loading deal journey..."));
  let eventBody;
  try {
    eventBody = await dealEvents(deal.id);
  } catch (err) {
    if (seq !== detailRequestSeq) return;
    root.replaceChildren(el("div", "empty", "Could not load deal events: " + String(err)));
    return;
  }
  if (seq !== detailRequestSeq || selectedId !== deal.id) return;
  const events = eventBody.events || [];
  const title = el("div", "section");
  title.append(el("h2", null, deal.company));
  const kv = el("div", "kv");
  const fields = [
    ["ID", deal.id],
    ["Status", deal.status],
    ["Route", routeText(deal)],
    ["Reason", deal.reason || "-"],
    ["ARR", deal.amount ? fmtMoney.format(deal.amount) : "-"]
  ];
  if (deal.scoreTotal !== undefined) {
    fields.push(["Score", deal.scoreTotal.toFixed(2)]);
    fields.push(["Source", deal.sourceChannel || "-"]);
    fields.push(["Need", deal.statedNeed || "-"]);
  }
  if (deal.quarantine) {
    fields.push(["Stage", deal.quarantine.stage]);
    fields.push(["Reason", deal.quarantine.reason]);
  }
  for (const [k, v] of fields) kv.append(el("div", null, k), el("div", null, v));
  title.append(kv, receiptBadges(events));
  const scoreBox = el("div", "section");
  scoreBox.append(el("h2", null, "Score Explanation"));
  if (deal.scoreNotes) {
    const notes = el("div", "journey");
    for (const note of deal.scoreNotes) notes.append(el("div", "event", note));
    scoreBox.append(notes);
  } else {
    scoreBox.append(el("div", "empty", "No score for quarantined records."));
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
    eventCache.clear();
    if (!selectedId && state.queue[0]) selectedId = state.queue[0].id;
    qs("#last-refresh").textContent = new Date().toLocaleTimeString();
    renderKpis();
    renderQueue();
    renderExceptions();
  void renderDetail();
  } catch (err) {
    if (seq !== stateRequestSeq) return;
    qs("#last-refresh").textContent = "state error " + new Date().toLocaleTimeString();
    if (!state) {
      const msg = "State load failed: " + String(err);
      qs("#kpis").replaceChildren(el("div", "empty", msg));
      qs("#queue").replaceChildren(el("div", "empty", msg));
      qs("#exceptions").replaceChildren(el("div", "empty", msg));
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
      eventCache.delete(first.deal.id);
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

function bodyErrorStatus(err: unknown): 400 | 413 {
  return err instanceof Error && err.message === "request body too large"
    ? 413
    : 400;
}

function bodyErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "body is not valid JSON";
}

function sendBodyError(res: ServerResponse, err: unknown): void {
  const msg = bodyErrorMessage(err);
  json(res, bodyErrorStatus(err), {
    error: msg === "request body too large" ? msg : "body is not valid JSON",
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

export function startServer(
  store: Store,
  enricher: Enricher,
  port: number,
  options: {
    pipelineOptions?: Partial<PipelineOptions>;
    sinkLabel?: string;
    liveIntegrations?: boolean;
  } = {},
): ReturnType<typeof createServer> {
  const sinkLabel = options.sinkLabel ?? "logging";
  const integrationHealthEnabled = options.liveIntegrations === true;
  let healthCache:
    | { at: number; ttlMs: number; checks: IntegrationCheck[] }
    | undefined;
  let healthInFlight: Promise<IntegrationCheck[]> | undefined;
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
    void handleRequest(req, res, store, enricher, loadHealth, html, options).catch(
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
  server.listen(port, "127.0.0.1");
  return server;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  enricher: Enricher,
  loadHealth: HealthLoader,
  html: string,
  options: {
    pipelineOptions?: Partial<PipelineOptions>;
    sinkLabel?: string;
    liveIntegrations?: boolean;
  },
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
