const fmtMoney = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
// Local-only convenience: sessionStorage avoids persisting the write secret
// across browser restarts, but this console still must stay localhost-only.
const LOCAL_SECRET_STORAGE_KEY = "gtm_ops_router_local_secret";
const LOCAL_ACTION_EVENTS_STORAGE_KEY = "gtm_ops_router_pending_local_actions_v3";
const LOCAL_ACTION_EVENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const AGENT_SUGGESTION_DRAFT_LIMIT = 10;
const DEAL_DETAIL_SUGGESTION_LIMIT = 5;
const AGENT_SUGGESTION_RUNNER = "console-policy-agent";
const WORK_ITEM_SUGGESTION_RUNNER = "console-work-item-agent";
const OPERATOR_PRINCIPAL = "operator-console";
const MANUAL_ENRICHMENT_MAX_EMPLOYEES = window.__DASH__.maxManualEnrichmentEmployees;
const MANUAL_ENRICHMENT_RETRY_WINDOW_MS = 5 * 60 * 1000;
const OPERATOR_URL_PARAMS = new URLSearchParams(window.location.search);
const OPERATOR_DEMO_MODE = OPERATOR_URL_PARAMS.get("demo") === "operator";
const URL_PINNED_DEAL_ID = OPERATOR_URL_PARAMS.get("deal");
let state = null;
let selectedId = URL_PINNED_DEAL_ID && URL_PINNED_DEAL_ID.length > 0 ? URL_PINNED_DEAL_ID : null;
let urlPinnedDealId = selectedId;
let missingUrlPinnedDealId = null;
let demoAutoPilotPaused = false;
let agentSuggestionFilter = "open";
const warnedAgentSuggestionStatuses = new Set();
let stateRequestSeq = 0;
let healthRequestSeq = 0;
let detailRequestSeq = 0;
const pendingSuggestionDecisions = new Set();
const pendingWorkItemActions = new Set();
const pendingLocalActionEvents = new Map();
let workItemDraftRunPending = false;

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
function displayValue(value){
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}
function displayNumber(value, digits){
  if (value === null || value === undefined || value === "") return "-";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : "-";
}
function displayInteger(value){
  if (value === null || value === undefined || value === "") return "-";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed).toLocaleString("en-US") : "-";
}
function displayBoolean(value){
  if (value === true) return "yes";
  if (value === false) return "no";
  return "-";
}
function compareCodepoint(left, right){
  return left < right ? -1 : left > right ? 1 : 0;
}
function labeledInput(labelText, input){
  const label = document.createElement("label");
  label.append(labelText, input);
  return label;
}
function manualEnrichmentForm(deal, facts){
  const subjectKey = String(deal?.enrichmentSubjectKey || facts?.subjectKey || "").trim().toLowerCase();
  const wrap = document.createElement("form");
  wrap.className = "mini-form";
  wrap.append(el("div", "muted", "Manual company evidence"));
  if (!subjectKey) {
    wrap.append(el("div", "empty", "No company subject key available for this deal."));
    return wrap;
  }
  const employees = document.createElement("input");
  employees.id = "manual-enrichment-employees";
  employees.type = "number";
  employees.min = "1";
  employees.max = String(MANUAL_ENRICHMENT_MAX_EMPLOYEES);
  employees.step = "1";
  employees.required = true;
  employees.value = facts?.employees ?? "";

  const industry = document.createElement("input");
  industry.id = "manual-enrichment-industry";
  industry.required = true;
  industry.maxLength = 120;
  industry.value = facts?.industry || "";

  const techSignals = document.createElement("input");
  techSignals.id = "manual-enrichment-tech";
  techSignals.placeholder = "manual_ops, voice_ai_eval";
  techSignals.maxLength = 1800;
  techSignals.value = Array.isArray(facts?.techSignals) ? facts.techSignals.join(", ") : "";

  const regulated = document.createElement("select");
  regulated.id = "manual-enrichment-regulated";
  regulated.required = true;
  const unknownRegulated = document.createElement("option");
  unknownRegulated.value = "";
  unknownRegulated.textContent = "Select...";
  unknownRegulated.disabled = true;
  unknownRegulated.hidden = true;
  regulated.append(unknownRegulated);
  for (const [value, label] of [["false", "No"], ["true", "Yes"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    regulated.append(option);
  }
  regulated.value = facts?.regulated === true ? "true" : facts?.regulated === false ? "false" : "";

  const confidence = document.createElement("input");
  confidence.id = "manual-enrichment-confidence";
  confidence.type = "number";
  confidence.min = "0";
  confidence.max = "1";
  confidence.step = "0.01";
  confidence.required = true;
  confidence.value = facts?.confidence ?? "0.85";

  const note = document.createElement("textarea");
  note.id = "manual-enrichment-note";
  note.rows = 2;
  note.maxLength = 500;
  note.placeholder = "What changed or where did this come from?";

  const operator = document.createElement("input");
  operator.id = "manual-enrichment-operator";
  operator.required = true;
  operator.maxLength = 120;
  operator.value = OPERATOR_PRINCIPAL;

  const status = el("div", "action-status");
  status.id = "enrichment-action-status";
  const button = el("button", "secondary", "Record Manual Evidence");
  button.type = "submit";
  let pendingSubmission = null;
  wrap.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    if (typeof wrap.reportValidity === "function" && !wrap.reportValidity()) return;
    const parsedEmployees = Number(employees.value);
    const parsedConfidence = Number(confidence.value);
    const normalizedIndustry = industry.value.trim();
    const normalizedOperator = operator.value.trim();
    const normalizedNote = note.value.trim();
    const signals = [
      ...new Set(
        techSignals.value
          .split(",")
          .map((signal) => signal.trim())
          .filter((signal) => signal.length > 0),
      ),
    ].sort(compareCodepoint);
    if (
      !employees.value.trim() ||
      !Number.isInteger(parsedEmployees) ||
      parsedEmployees < 1 ||
      parsedEmployees > MANUAL_ENRICHMENT_MAX_EMPLOYEES
    ) {
      status.className = "action-status fail";
      status.textContent = "Employees must be a positive integer up to " + MANUAL_ENRICHMENT_MAX_EMPLOYEES.toLocaleString("en-US") + ".";
      return;
    }
    if (!Number.isFinite(parsedConfidence) || parsedConfidence < 0 || parsedConfidence > 1) {
      status.className = "action-status fail";
      status.textContent = "Confidence must be between 0 and 1.";
      return;
    }
    if (!normalizedIndustry) {
      status.className = "action-status fail";
      status.textContent = "Industry is required.";
      return;
    }
    if (!normalizedOperator) {
      status.className = "action-status fail";
      status.textContent = "Operator is required.";
      return;
    }
    if (signals.length > 20 || signals.some((signal) => signal.length > 80)) {
      status.className = "action-status fail";
      status.textContent = "Use at most 20 tech signals, 80 characters each.";
      return;
    }
    if (regulated.value !== "true" && regulated.value !== "false") {
      status.className = "action-status fail";
      status.textContent = "Regulated must be selected.";
      return;
    }
    const submissionKey = JSON.stringify({
      subjectKey,
      employees: parsedEmployees,
      industry: normalizedIndustry,
      techSignals: signals,
      regulated: regulated.value === "true",
      confidence: parsedConfidence,
      operator: normalizedOperator,
      note: normalizedNote || null
    });
    const nowMs = Date.now();
    const shouldReusePendingSubmission =
      pendingSubmission?.key === submissionKey &&
      nowMs - pendingSubmission.createdAtMs <= MANUAL_ENRICHMENT_RETRY_WINDOW_MS;
    if (!shouldReusePendingSubmission) {
      const observedAt = new Date().toISOString();
      pendingSubmission = {
        key: submissionKey,
        observedAt,
        createdAtMs: nowMs,
        sourceEventId: deterministicUuidV4("manual-enrichment:" + observedAt + ":" + submissionKey)
      };
    }
    const payload = {
      subjectKey,
      sourceEventId: pendingSubmission.sourceEventId,
      observedAt: pendingSubmission.observedAt,
      employees: parsedEmployees,
      industry: normalizedIndustry,
      techSignals: signals,
      regulated: regulated.value === "true",
      confidence: parsedConfidence,
      operator: normalizedOperator,
      note: normalizedNote || undefined
    };
    button.disabled = true;
    status.className = "action-status";
    status.textContent = "Recording manual evidence...";
    try {
      const result = await fetchJson("/enrichment-observations", {
        method: "POST",
        headers: localWriteHeaders(),
        body: JSON.stringify(payload)
      });
      status.className = "action-status pass";
      status.textContent = "Evidence " + result.status + ". Refreshing state...";
      pendingSubmission = null;
      await loadState();
    } catch (err) {
      status.className = "action-status fail";
      status.textContent = String(err);
    } finally {
      button.disabled = false;
    }
  });

  const firstRow = el("div", "two");
  firstRow.append(
    labeledInput("Employees", employees),
    labeledInput("Industry", industry)
  );
  const secondRow = el("div", "two");
  secondRow.append(
    labeledInput("Regulated", regulated),
    labeledInput("Confidence", confidence)
  );
  wrap.append(
    el("div", "muted", "Subject " + subjectKey),
    firstRow,
    secondRow,
    labeledInput("Operator", operator),
    labeledInput("Tech Signals", techSignals),
    labeledInput("Evidence Note", note),
    button,
    status
  );
  return wrap;
}
function quarantineReplayForm(deal){
  if (!deal?.quarantine) return null;
  const wrap = document.createElement("form");
  wrap.className = "mini-form";
  wrap.append(el("div", "muted", "Quarantine repair"));
  const code = deal.quarantine.code;
  const isEnrichmentReplay = code === "enrichment_unresolved" || code === "insufficient_data";
  const isSinkReplay = code === "sink_terminal" || code === "sink_exhausted";
  if (!isEnrichmentReplay && !isSinkReplay) {
    wrap.append(el("div", "empty", "Replay is not available for this quarantine code."));
    return wrap;
  }
  if (isEnrichmentReplay && !deal.enrichmentSubjectKey) {
    wrap.append(el("div", "empty", "No normalized deal payload is available for replay."));
    return wrap;
  }
  if (isEnrichmentReplay && (!deal.enrichmentFacts || deal.enrichmentFacts.freshnessStatus !== "fresh")) {
    wrap.append(el("div", "empty", "Fresh, high-confidence enrichment evidence is required before replay."));
    return wrap;
  }
  const contactName = document.createElement("input");
  contactName.required = true;
  contactName.autocomplete = "name";
  contactName.placeholder = "Current contact";
  const contactEmail = document.createElement("input");
  contactEmail.type = "email";
  contactEmail.required = true;
  contactEmail.autocomplete = "email";
  contactEmail.placeholder = "contact@company.com";
  const status = el("div", "action-status");
  const button = el("button", "secondary", "Replay Quarantine");
  button.type = "submit";
  wrap.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    status.className = "action-status";
    status.textContent = "Replaying quarantine...";
    try {
      const result = await fetchJson("/quarantine-replay", {
        method: "POST",
        headers: localWriteHeaders(),
        body: JSON.stringify({
          dealId: deal.id,
          contactName: contactName.value.trim(),
          contactEmail: contactEmail.value.trim(),
          operator: OPERATOR_PRINCIPAL,
          reason: isSinkReplay ? "downstream sink repaired" : "fresh enrichment evidence available"
        })
      });
      status.className = "action-status pass";
      status.textContent = "Replay " + result.status + ". Refreshing state...";
      await loadState();
    } catch (err) {
      status.className = "action-status fail";
      status.textContent = String(err);
    } finally {
      button.disabled = false;
    }
  });
  let replayNote;
  if (isSinkReplay && deal.sinkReplayMode === "stored_route") {
    replayNote = "Retry downstream sync with the original stored route after fixing the integration or configuration.";
  } else if (isSinkReplay && deal.enrichmentFacts?.freshnessStatus === "fresh") {
    replayNote = "Retry downstream sync after rechecking routing from fresh " + deal.enrichmentFacts.sourceProvider + " evidence.";
  } else if (isSinkReplay) {
    replayNote = "Retry downstream sync after rechecking enrichment with the live provider and routing.";
  } else {
    replayNote = "Using " + deal.enrichmentFacts.sourceProvider + " evidence for " + deal.enrichmentSubjectKey;
  }
  wrap.append(
    el("div", "muted", replayNote),
    labeledInput("Contact", contactName),
    labeledInput("Email", contactEmail),
    button,
    status
  );
  return wrap;
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
    const error = new Error("HTTP " + res.status + ": " + (detailText || res.statusText));
    error.status = res.status;
    error.body = body;
    throw error;
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
function compareCanonicalStrings(a, b){
  return a < b ? -1 : a > b ? 1 : 0;
}
function canonicalLocalActionValue(value, seen){
  if (value === null) return ["null"];
  if (value === undefined) return ["undefined"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    if (Number.isNaN(value)) return ["number", "NaN"];
    if (value === Infinity) return ["number", "Infinity"];
    if (value === -Infinity) return ["number", "-Infinity"];
    if (Object.is(value, -0)) return ["number", "-0"];
    return ["number", value];
  }
  if (typeof value === "bigint") return ["bigint", value.toString()];
  if (typeof value === "function" || typeof value === "symbol") {
    throw new Error("local action keys must be JSON-like values");
  }
  if (seen.has(value)) throw new Error("local action keys cannot contain cycles");
  seen.add(value);
  try {
    if (Array.isArray(value)) return ["array", value.map((item) => canonicalLocalActionValue(item, seen))];
    if (value instanceof Date) {
      return ["date", Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString()];
    }
    if (value instanceof Map) {
      return ["map", [...value.entries()]
        .map(([key, entryValue]) => [canonicalLocalActionValue(key, seen), canonicalLocalActionValue(entryValue, seen)])
        .sort((a, b) => compareCanonicalStrings(JSON.stringify(a), JSON.stringify(b)))];
    }
    if (value instanceof Set) {
      return ["set", [...value.values()]
        .map((item) => canonicalLocalActionValue(item, seen))
        .sort((a, b) => compareCanonicalStrings(JSON.stringify(a), JSON.stringify(b)))];
    }
    if (value && typeof value === "object") {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error("local action keys must be plain objects");
      }
      return ["object", Object.keys(value).sort().map((key) => [key, canonicalLocalActionValue(value[key], seen)])];
    }
    throw new Error("unsupported local action key value");
  } finally {
    seen.delete(value);
  }
}
function canonicalLocalActionJson(value){
  return JSON.stringify(canonicalLocalActionValue(value, new WeakSet()));
}
function localActionStableKey(prefix, scopeKey){
  return prefix + ":" + canonicalLocalActionJson(scopeKey);
}
function validStoredLocalActionEvent(event){
  return event &&
    typeof event === "object" &&
    typeof event.occurredAt === "string" &&
    typeof event.sourceEventId === "string" &&
    typeof event.createdAtMs === "number" &&
    typeof event.payloadSignature === "string";
}
function persistPendingLocalActionEvents(){
  try {
    sessionStorage.setItem(
      LOCAL_ACTION_EVENTS_STORAGE_KEY,
      JSON.stringify([...pendingLocalActionEvents])
    );
    return true;
  } catch (err) {
    console.warn("failed to persist pending local action events", err);
    return false;
  }
}
function sweepPendingLocalActionEvents(nowMs){
  let changed = false;
  for (const [key, event] of pendingLocalActionEvents) {
    if (nowMs - event.createdAtMs > LOCAL_ACTION_EVENT_MAX_AGE_MS) {
      pendingLocalActionEvents.delete(key);
      changed = true;
    }
  }
  if (changed) persistPendingLocalActionEvents();
}
function hydratePendingLocalActionEvents(){
  try {
    const raw = sessionStorage.getItem(LOCAL_ACTION_EVENTS_STORAGE_KEY);
    if (!raw) return;
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return;
    const nowMs = Date.now();
    pendingLocalActionEvents.clear();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 2) continue;
      const [key, event] = row;
      if (typeof key !== "string" || !validStoredLocalActionEvent(event)) continue;
      if (nowMs - event.createdAtMs > LOCAL_ACTION_EVENT_MAX_AGE_MS) continue;
      pendingLocalActionEvents.set(key, event);
    }
    persistPendingLocalActionEvents();
  } catch (err) {
    console.warn("failed to hydrate pending local action events", err);
  }
}
function localActionEvent(prefix, scopeKey, payloadKey){
  let stableKey;
  let payloadSignature;
  try {
    stableKey = localActionStableKey(prefix, scopeKey);
    payloadSignature = canonicalLocalActionJson(payloadKey);
  } catch (err) {
    return { status: "invalid_payload", detail: String(err) };
  }
  const nowMs = Date.now();
  const existing = pendingLocalActionEvents.get(stableKey);
  if (existing) {
    if (nowMs - existing.createdAtMs > LOCAL_ACTION_EVENT_MAX_AGE_MS) {
      pendingLocalActionEvents.delete(stableKey);
      if (!persistPendingLocalActionEvents()) return { status: "persist_failed" };
    } else {
      if (existing.payloadSignature !== payloadSignature) {
        return {
          status: "payload_conflict",
          pendingSourceEventId: existing.sourceEventId,
          pendingOccurredAt: existing.occurredAt
        };
      }
      return { status: "ok", event: existing };
    }
  }
  sweepPendingLocalActionEvents(nowMs);
  const occurredAt = new Date(nowMs).toISOString();
  const next = {
    occurredAt,
    sourceEventId: deterministicUuidV4(stableKey + ":" + occurredAt + ":" + payloadSignature),
    createdAtMs: nowMs,
    payloadSignature
  };
  pendingLocalActionEvents.set(stableKey, next);
  if (!persistPendingLocalActionEvents()) {
    pendingLocalActionEvents.delete(stableKey);
    return { status: "persist_failed" };
  }
  return { status: "ok", event: next };
}
function clearLocalActionEvent(prefix, scopeKey){
  pendingLocalActionEvents.delete(localActionStableKey(prefix, scopeKey));
  if (!persistPendingLocalActionEvents()) {
    throw new Error("pending local action clear could not be persisted");
  }
}
function randomUuidV4(fallbackKey){
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return deterministicUuidV4(fallbackKey + ":" + Date.now() + ":" + Math.random());
}
function statusFromError(err){
  if (!err || typeof err !== "object") return null;
  const body = err.body;
  if (!body || typeof body !== "object") return null;
  return body.status || body.error || null;
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
function setWorkItemActionStatus(message, className){
  const root = qs("#work-item-action-status");
  if (!root) return;
  root.className = "action-status" + (className ? " " + className : "");
  root.textContent = message;
}
function renderUrlPinStatus(){
  const root = qs("#url-pin-status");
  if (!root) return;
  if (!missingUrlPinnedDealId) {
    root.className = "action-status";
    root.textContent = "";
    return;
  }
  root.className = "action-status fail";
  root.textContent = "Router trace link target " + missingUrlPinnedDealId + " is not in the current workflow state; showing the next available deal instead.";
}
function clearUrlDealParam(){
  if (!window || !window.history || typeof window.history.replaceState !== "function") return;
  const params = new URLSearchParams(window.location.search || "");
  if (!params.has("deal")) return;
  params.delete("deal");
  const query = params.toString();
  const path = window.location.pathname || "/";
  const hash = window.location.hash || "";
  window.history.replaceState(null, "", path + (query ? "?" + query : "") + hash);
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
        if (receipt.url && /^https:\/\//.test(receipt.url)) {
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
const roleQueueOrder = window.__DASH__.roleQueueKinds;
const roleQueueLabels = {
  ae_attention: "AE",
  finance_review: "Finance",
  legal_review: "Legal",
  deployment_readiness: "Deployment",
  growth_attribution: "Growth"
};
// Action queues are every ROLE_QUEUE_KIND except growth_attribution, which is attribution-only.
const actionWorkQueueKeys = roleQueueOrder.filter((queue) => queue !== "growth_attribution");
const suggestionKindLabels = {
  handoff_summary: "Handoff",
  missing_field_question: "Missing field",
  stale_deal_nudge: "Stale deal",
  policy_change_recommendation: "Policy"
};
function rolePriorityClass(priority){
  if (priority === "high") return "fail";
  if (priority === "medium") return "warn";
  return "muted";
}
function workItemSourceKey(item){
  return "role_queue:" + item.queue + ":" + item.dealId;
}
function workItemStatusClass(status){
  if (status === "resolved") return "pass";
  if (status === "waived") return "muted";
  return "warn";
}
function workItemDefaultOwner(item){
  if (item.queue === "ae_attention") return item.salesOwner || "ae.unassigned";
  if (item.queue === "finance_review") return "finance.ops";
  if (item.queue === "legal_review") return "legal.counsel";
  if (item.queue === "deployment_readiness") return "deployment.ops";
  return "growth.ops";
}
function workItemForSignal(item){
  const sourceKey = workItemSourceKey(item);
  return (state.workItems || []).find((workItem) => workItem.sourceKey === sourceKey) || null;
}
function roleQueueOpenEventId(item){
  return randomUuidV4(["work-item-open", item.queue, item.dealId].join(":"));
}
function pauseDemoAutoPilot(){
  if (OPERATOR_DEMO_MODE) demoAutoPilotPaused = true;
}
async function openWorkItemFromSignal(item){
  pauseDemoAutoPilot();
  const existing = workItemForSignal(item);
  if (existing) {
    setWorkItemActionStatus("Work item already exists: " + existing.id, "warn");
    return;
  }
  const actionKey = workItemSourceKey(item);
  if (pendingWorkItemActions.has(actionKey)) return;
  pendingWorkItemActions.add(actionKey);
  renderRoleQueues();
  renderWorkItems();
  renderWorkflowGuide();
  try {
    setWorkItemActionStatus("Opening work item for " + item.company + "...", "");
    const result = await fetchJson("/work-items", {
      method: "POST",
      headers: localWriteHeaders(),
      body: JSON.stringify({
        dealId: item.dealId,
        queue: item.queue,
        sourceEventId: roleQueueOpenEventId(item),
        owner: workItemDefaultOwner(item),
        createdBy: OPERATOR_PRINCIPAL,
        reason: "Opened from " + (roleQueueLabels[item.queue] || item.queue) + " queue."
      })
    });
    if (result.status === "recorded" || result.status === "duplicate" || result.status === "already_exists") {
      setWorkItemActionStatus("Work item " + result.status + ": " + (result.workItem?.id || "-"), result.status === "recorded" ? "pass" : "warn");
      await loadState();
      return;
    }
    setWorkItemActionStatus("Work item open returned " + result.status, "fail");
  } catch (err) {
    const status = statusFromError(err);
    setWorkItemActionStatus(
      status
        ? "Work item open returned " + status
        : "Work item open failed: " + String(err),
      status === "already_exists" ? "warn" : "fail"
    );
  } finally {
    pendingWorkItemActions.delete(actionKey);
    renderRoleQueues();
    renderWorkItems();
    renderWorkflowGuide();
  }
}
function roleQueueActionCell(item){
  const actionCell = document.createElement("td");
  const existing = workItemForSignal(item);
  const actionKey = workItemSourceKey(item);
  if (pendingWorkItemActions.has(actionKey)) {
    actionCell.textContent = "Opening...";
  } else if (existing) {
    actionCell.append(el("span", workItemStatusClass(existing.status), existing.status));
  } else {
    const button = el("button", "secondary", "Open");
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void openWorkItemFromSignal(item);
    });
    actionCell.append(button);
  }
  return actionCell;
}
function renderRoleQueues(){
  const root = qs("#role-queues");
  const queues = state.roleQueues || {};
  const actionRows = actionWorkQueueKeys.flatMap((queue) => queues[queue] || []);
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
      ["Queue", "Priority", "Company", "ARR", "Sales Owner", "Status", "Reason", "Work Item"],
      (item) => [
        cell(roleQueueLabels[item.queue] || item.queue),
        cell(item.priority, rolePriorityClass(item.priority)),
        cell(item.company),
        cell(fmtMoney.format(item.amount)),
        cell(item.salesOwner || "-"),
        cell(item.status),
        cell(item.reason),
        roleQueueActionCell(item)
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
function workItemActionEventId(item, action){
  return deterministicUuidV4(
    ["work-item-action", action, item.id, item.status, item.updatedAt].join(":")
  );
}
async function actOnWorkItem(item, action){
  pauseDemoAutoPilot();
  const actionKey = item.id + ":" + action;
  if (pendingWorkItemActions.has(actionKey)) return;
  pendingWorkItemActions.add(actionKey);
  renderWorkItems();
  renderRoleQueues();
  renderWorkflowGuide();
  try {
    const verb = action === "resolve" ? "Resolving" : "Waiving";
    setWorkItemActionStatus(verb + " " + item.id + "...", "");
    const result = await fetchJson("/work-items/" + encodeURIComponent(item.id) + "/action", {
      method: "POST",
      headers: localWriteHeaders(),
      body: JSON.stringify({
        action,
        sourceEventId: workItemActionEventId(item, action),
        humanPrincipal: OPERATOR_PRINCIPAL,
        reason: action === "resolve"
          ? "Resolved from operator console."
          : "Waived from operator console."
      })
    });
    if (result.status === "recorded" || result.status === "duplicate" || result.status === "superseded") {
      setWorkItemActionStatus(
        "Work item " + result.status + ": " + (result.workItem?.id || item.id),
        result.status === "superseded" ? "warn" : "pass"
      );
      await loadState();
      return;
    }
    setWorkItemActionStatus("Work item action returned " + result.status, result.status === "already_closed" ? "warn" : "fail");
  } catch (err) {
    const status = statusFromError(err);
    setWorkItemActionStatus(
      status
        ? "Work item action returned " + status
        : "Work item action failed: " + String(err),
      status === "already_closed" || status === "invalid_action" ? "warn" : "fail"
    );
  } finally {
    pendingWorkItemActions.delete(actionKey);
    renderWorkItems();
    renderRoleQueues();
    renderWorkflowGuide();
  }
}
function workItemActionCell(item){
  const actionCell = document.createElement("td");
  if (item.status !== "assigned") {
    actionCell.textContent = item.resolutionReason || "-";
    return actionCell;
  }
  if (
    pendingWorkItemActions.has(item.id + ":resolve") ||
    pendingWorkItemActions.has(item.id + ":waive")
  ) {
    actionCell.textContent = "Updating...";
    return actionCell;
  }
  const actions = el("div", "inline-actions");
  const resolve = el("button", "secondary", "Resolve");
  const waive = el("button", "secondary", "Waive");
  resolve.type = "button";
  waive.type = "button";
  resolve.addEventListener("click", (event) => {
    event.stopPropagation();
    void actOnWorkItem(item, "resolve");
  });
  waive.addEventListener("click", (event) => {
    event.stopPropagation();
    void actOnWorkItem(item, "waive");
  });
  actions.append(resolve, waive);
  actionCell.append(actions);
  return actionCell;
}
function roleQueueKeys(){
  return roleQueueOrder;
}
function rolePriorityRank(priority){
  if (priority === "high") return 0;
  if (priority === "medium") return 1;
  return 2;
}
function workflowRoleQueueRows(){
  const queues = state?.roleQueues || {};
  return roleQueueKeys()
    .flatMap((key) => queues[key] || [])
    .sort((a, b) => {
      const actionDelta = Number(isActionWorkQueue(b.queue)) - Number(isActionWorkQueue(a.queue));
      if (actionDelta !== 0) return actionDelta;
      const priorityDelta = rolePriorityRank(a.priority) - rolePriorityRank(b.priority);
      if (priorityDelta !== 0) return priorityDelta;
      return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
    });
}
function isActionWorkQueue(queue){
  return actionWorkQueueKeys.includes(queue);
}
function roleQueueSignalForDeal(dealId, workItem){
  const rows = workflowRoleQueueRows().filter((item) => item.dealId === dealId);
  if (workItem) {
    return rows.find((item) => item.queue === workItem.queue) || null;
  }
  return rows[0] || null;
}
function workItemsForDeal(dealId){
  return (state.workItems || [])
    .filter((item) => item.dealId === dealId)
    .sort((a, b) => {
      const statusRank = (item) => item.status === "assigned" ? 0 : (item.status === "resolved" ? 1 : 2);
      const rankDelta = statusRank(a) - statusRank(b);
      if (rankDelta !== 0) return rankDelta;
      const aUpdatedAt = String(a.updatedAt || "");
      const bUpdatedAt = String(b.updatedAt || "");
      if (aUpdatedAt !== bUpdatedAt) return bUpdatedAt.localeCompare(aUpdatedAt);
      return String(b.id || "").localeCompare(String(a.id || ""));
    });
}
function primaryWorkItemForDeal(dealId){
  return workItemsForDeal(dealId)[0] || null;
}
function suggestionsForDeal(dealId){
  return (state.agentSuggestions || [])
    .filter((suggestion) => suggestion.dealId === dealId)
    .sort((a, b) => {
      const statusRank = (suggestion) => suggestion.status === "proposed" ? 0 : (suggestion.status === "accepted" ? 1 : 2);
      const rankDelta = statusRank(a) - statusRank(b);
      if (rankDelta !== 0) return rankDelta;
      const aTime = String(a.status === "proposed" ? (a.createdAt || "") : (a.decidedAt || a.createdAt || ""));
      const bTime = String(b.status === "proposed" ? (b.createdAt || "") : (b.decidedAt || b.createdAt || ""));
      if (aTime !== bTime) return bTime.localeCompare(aTime);
      return String(b.id || "").localeCompare(String(a.id || ""));
    });
}
function primarySuggestionForDeal(dealId, workItem){
  const rows = suggestionsForDeal(dealId);
  if (workItem) {
    if (!workItem.agentSuggestionSourceEventId) return null;
    const direct = rows.find((suggestion) => suggestion.sourceEventId === workItem.agentSuggestionSourceEventId);
    if (direct) return direct;
    return null;
  }
  return rows.find((suggestion) => suggestion.status === "proposed") || null;
}
function workflowDealIds(){
  const ids = new Set();
  for (const deal of state.queue || []) ids.add(deal.id);
  for (const item of workflowRoleQueueRows()) ids.add(item.dealId);
  for (const item of state.workItems || []) ids.add(item.dealId);
  for (const suggestion of state.agentSuggestions || []) ids.add(suggestion.dealId);
  for (const readiness of state.deploymentReadiness || []) ids.add(readiness.dealId);
  return ids;
}
function preferredWorkflowDealId(){
  const assignedWorkItem = (state.workItems || [])
    .filter((item) => item.status === "assigned")
    .sort((a, b) => {
      const priorityDelta = rolePriorityRank(a.priority) - rolePriorityRank(b.priority);
      if (priorityDelta !== 0) return priorityDelta;
      const aUpdatedAt = String(a.updatedAt || "");
      const bUpdatedAt = String(b.updatedAt || "");
      if (aUpdatedAt !== bUpdatedAt) return bUpdatedAt.localeCompare(aUpdatedAt);
      return String(b.id || "").localeCompare(String(a.id || ""));
    })[0];
  if (assignedWorkItem) return assignedWorkItem.dealId;
  const openSuggestion = (state.agentSuggestions || [])
    .filter((suggestion) => suggestion.status === "proposed")
    .sort((a, b) => {
      const aTime = String(a.createdAt || "");
      const bTime = String(b.createdAt || "");
      if (aTime !== bTime) return bTime.localeCompare(aTime);
      return String(b.id || "").localeCompare(String(a.id || ""));
    })[0];
  if (openSuggestion) return openSuggestion.dealId;
  const roleSignal = workflowRoleQueueRows()[0];
  if (roleSignal) return roleSignal.dealId;
  const queue = state.queue || [];
  if (queue[0]) return queue[0].id;
  const readiness = (state.deploymentReadiness || [])[0];
  return readiness ? readiness.dealId : null;
}
function workflowStep(label, className, title, detail){
  const node = el("div", "workflow-step " + (className || "waiting"));
  node.setAttribute("role", "listitem");
  if (className === "active") node.setAttribute("aria-current", "step");
  node.append(
    el("div", "workflow-step-label", label),
    el("div", "workflow-step-title", title),
    el("div", "workflow-step-detail", detail)
  );
  return node;
}
function workflowLine(label, value, className){
  const row = el("div", className || null);
  row.append(el("span", "muted", label + ": "), value === null || value === undefined || value === "" ? "-" : String(value));
  return row;
}
function workflowNextAction(dealId, deal, roleSignal, workItem, suggestion, hasUnpairedProposedDraft, linkedDraftMissing){
  const box = el("div", "workflow-next");
  const boxLabel = el("div", "workflow-step-label", "Next action");
  box.append(boxLabel);
  if (!deal && !workItem && !suggestion) {
    box.append(el("div", "workflow-step-title", dealId ? "No action signal" : "Select a routed deal"));
    box.append(el("div", "workflow-step-detail", dealId ? "This deal has no active queue signal, work item, or agent draft in the current state payload." : "The rail follows the selected deal, work item, and agent draft."));
    return box;
  }
  if (!workItem && roleSignal && isActionWorkQueue(roleSignal.queue)) {
    box.append(el("div", "workflow-step-title", "Open the work item"));
    box.append(el("div", "workflow-step-detail", "Creates owner-visible work from the " + (roleQueueLabels[roleSignal.queue] || roleSignal.queue) + " queue signal."));
    const actionKey = workItemSourceKey(roleSignal);
    if (pendingWorkItemActions.has(actionKey)) {
      box.append(el("div", "muted", "Opening..."));
    } else {
      const button = el("button", "secondary", "Open work item");
      button.type = "button";
      button.addEventListener("click", () => void openWorkItemFromSignal(roleSignal));
      box.append(button);
    }
    return box;
  }
  if (!workItem && roleSignal) {
    box.append(el("div", "workflow-step-title", "Growth signal captured"));
    box.append(el("div", "workflow-step-detail", "This queue is an attribution view; no owner work item is opened from the workflow rail."));
    return box;
  }
  if (workItem && workItem.status === "assigned" && linkedDraftMissing) {
    box.append(el("div", "workflow-step-title", "Find linked draft"));
    box.append(el("div", "workflow-step-detail", "This work item already points to a draft outside the current suggestion window; refresh or inspect Agent Suggestions before closing it."));
    const button = el("button", "secondary", "Refresh");
    button.type = "button";
    button.addEventListener("click", () => { void loadState(); });
    box.append(button);
    return box;
  }
  if (workItem && workItem.status === "assigned" && !suggestion) {
    boxLabel.textContent = "Available actions";
    box.append(el("div", "workflow-step-title", "Choose manual close or global draft"));
    box.append(el("div", "workflow-step-detail", "Use the global Draft Work Item Actions control when you want the agent to process pending work; use Resolve/Waive if this item is intentionally manual."));
    if (hasUnpairedProposedDraft) {
      box.append(el("div", "warn", "Unpaired proposed drafts exist for this deal; review them in Agent Suggestions before closing the work item."));
    }
    if (workItemDraftRunPending) box.append(el("div", "muted", "Global draft batch is running..."));
    if (
      !pendingWorkItemActions.has(workItem.id + ":resolve") &&
      !pendingWorkItemActions.has(workItem.id + ":waive")
    ) {
      const manualActions = el("div", "inline-actions");
      const resolve = el("button", "secondary", "Resolve item");
      const waive = el("button", "secondary", "Waive item");
      resolve.type = "button";
      waive.type = "button";
      resolve.addEventListener("click", () => void actOnWorkItem(workItem, "resolve"));
      waive.addEventListener("click", () => void actOnWorkItem(workItem, "waive"));
      manualActions.append(resolve, waive);
      box.append(manualActions);
    } else {
      box.append(el("div", "muted", "Updating..."));
    }
    return box;
  }
  if (suggestion && suggestion.status === "proposed") {
    box.append(el("div", "workflow-step-title", "Human decision needed"));
    box.append(el("div", "workflow-step-detail", "Accept or reject the draft before any operator marks the work item done."));
    renderSuggestionDecisionActions(box, suggestion);
    return box;
  }
  if (workItem && workItem.status === "assigned") {
    box.append(el("div", "workflow-step-title", "Resolve or waive"));
    box.append(el("div", "workflow-step-detail", "Close the work item once the accepted action is complete, or waive it with an audit reason."));
    if (
      pendingWorkItemActions.has(workItem.id + ":resolve") ||
      pendingWorkItemActions.has(workItem.id + ":waive")
    ) {
      box.append(el("div", "muted", "Updating..."));
    } else {
      const actions = el("div", "inline-actions");
      const resolve = el("button", "secondary", "Resolve item");
      const waive = el("button", "secondary", "Waive item");
      resolve.type = "button";
      waive.type = "button";
      resolve.addEventListener("click", () => void actOnWorkItem(workItem, "resolve"));
      waive.addEventListener("click", () => void actOnWorkItem(workItem, "waive"));
      actions.append(resolve, waive);
      box.append(actions);
    }
    return box;
  }
  if (!workItem) {
    box.append(
      el("div", "workflow-step-title", "No work to do"),
      el("div", "workflow-step-detail", "No action signal, work item, or agent draft is active for this deal.")
    );
    return box;
  }
  box.append(
    el("div", "workflow-step-title", "Loop closed"),
    el("div", "workflow-step-detail", workItem.status + " by " + (workItem.resolvedBy || "-"))
  );
  return box;
}
function renderSuggestionDecisionActions(box, suggestion){
  if (pendingSuggestionDecisions.has(suggestion.id)) {
    box.append(el("div", "muted", "Deciding..."));
    return;
  }
  const actions = el("div", "inline-actions");
  const accept = el("button", "secondary", "Accept draft");
  const reject = el("button", "secondary", "Reject draft");
  accept.type = "button";
  reject.type = "button";
  accept.addEventListener("click", () => void decideSuggestion(suggestion, "accepted"));
  reject.addEventListener("click", () => void decideSuggestion(suggestion, "rejected"));
  actions.append(accept, reject);
  box.append(actions);
}
function renderWorkflowMode(){
  const mode = qs("#workflow-mode");
  if (!mode) return;
  mode.textContent = OPERATOR_DEMO_MODE ? (demoAutoPilotPaused ? "Resume auto-follow" : "Pause auto-follow") : "Guided";
  mode.hidden = !OPERATOR_DEMO_MODE;
  mode.title = OPERATOR_DEMO_MODE
    ? (demoAutoPilotPaused ? "Resume following the highest-priority workflow" : "Auto-following the highest-priority workflow")
    : "Guided workflow rail";
}
function toggleDemoAutoPilot(){
  if (!OPERATOR_DEMO_MODE || !state) return;
  if (!demoAutoPilotPaused) {
    demoAutoPilotPaused = true;
    renderWorkflowGuide();
    return;
  }
  demoAutoPilotPaused = false;
  selectedId = preferredWorkflowDealId() || selectedId;
  renderWorkflowGuide();
  renderQueue();
  renderRoleQueues();
  renderWorkItems();
  renderPolicyEvaluation();
  renderPolicyRuns();
  renderAgentSuggestions();
  renderDeploymentHandoff();
  scheduleRenderDetail();
}
function renderWorkflowGuide(){
  const root = qs("#workflow-guide");
  if (!root || !state) return;
  renderWorkflowMode();
  const dealId = selectedId || preferredWorkflowDealId();
  if (!dealId) {
    root.replaceChildren(el("div", "empty", "No routed deals, role queues, work items, or agent suggestions yet."));
    return;
  }
  const queue = state.queue || [];
  const deal = queue.find((row) => row.id === dealId) || null;
  const workItem = primaryWorkItemForDeal(dealId);
  const roleSignal = roleQueueSignalForDeal(dealId, workItem);
  const suggestion = primarySuggestionForDeal(dealId, workItem);
  const hasUnpairedProposedDraft =
    Boolean(workItem) &&
    suggestionsForDeal(dealId).some((row) => row.status === "proposed" && (!suggestion || row.id !== suggestion.id));
  const linkedDraftMissing =
    Boolean(workItem?.agentSuggestionSourceEventId) && !suggestion;
  const routeTitle = deal ? (deal.company + " routed") : "Routed deal";
  const signalTitle = roleSignal
    ? ((roleQueueLabels[roleSignal.queue] || roleSignal.queue) + " signal")
    : (workItem ? "Opened from prior signal" : "Awaiting signal");
  const workTitle = workItem
    ? (workItem.status === "assigned" ? "Assigned to " + workItem.owner : workItem.status)
    : "No work item";
  const draftTitle = suggestion
    ? (suggestion.status === "proposed" ? "Draft proposed" : suggestion.status)
    : (linkedDraftMissing ? "Linked draft not found" : (hasUnpairedProposedDraft ? "Unpaired draft exists" : "No draft"));
  const decisionTitle = suggestion
    ? (suggestion.status === "proposed" ? "Awaiting human" : suggestion.status + " by " + (suggestion.decidedBy || "-"))
    : "No decision";
  const decisionDetail = suggestion
    ? (suggestion.status === "proposed"
      ? "Awaiting accept/reject."
      : (suggestion.decisionReason || "Decided without reason."))
    : (linkedDraftMissing ? "Linked draft is outside the current suggestion window." : "No draft decision yet.");
  const closeTitle = workItem
    ? (workItem.status === "assigned" ? "Still open" : workItem.status + " by " + (workItem.resolvedBy || "-"))
    : "Not opened";
  const otherWorkItemCount = workItemsForDeal(dealId).filter((item) => !workItem || item.id !== workItem.id).length;
  const steps = el("div", "workflow-steps");
  steps.setAttribute("role", "list");
  steps.append(
    workflowStep("1. Routed", deal ? "complete" : "waiting", routeTitle, deal ? (deal.route + " | " + (deal.externalStage?.stageLabel || deal.status)) : "Select or ingest a deal."),
    workflowStep("2. Signal", (roleSignal || workItem) ? "complete" : "waiting", signalTitle, roleSignal ? roleSignal.reason : (workItem ? "Opened from " + (roleQueueLabels[workItem.queue] || workItem.queue) + " queue." : "No queue signal selected.")),
    workflowStep("3. Work item", workItem ? "complete" : "waiting", workTitle, workItem ? workItem.title : (roleSignal && !isActionWorkQueue(roleSignal.queue) ? "Attribution-only signal." : "Open one from the role queue.")),
    workflowStep("4. Agent draft", suggestion ? "complete" : (workItem && workItem.status === "assigned" ? "active" : "waiting"), draftTitle, suggestion ? suggestion.title : (linkedDraftMissing ? "This work item links to a draft outside the current suggestion window." : (hasUnpairedProposedDraft ? "Other proposed drafts exist for this deal; this work item has no paired draft." : (workItem && workItem.status !== "assigned" ? "Closed without an agent draft." : "Use Draft Work Item Actions to generate a draft.")))),
    workflowStep("5. Decision", suggestion && suggestion.status !== "proposed" ? "complete" : (suggestion || linkedDraftMissing ? "active" : "waiting"), decisionTitle, decisionDetail),
    workflowStep("6. Close work", workItem && workItem.status !== "assigned" ? "complete" : (workItem && suggestion && suggestion.status !== "proposed" ? "active" : "waiting"), closeTitle, workItem ? (workItem.resolutionReason || "Resolve or waive after the human decision.") : "No work item to close yet.")
  );
  const lineage = el("div", "workflow-lineage");
  const hubSpotStage = deal?.externalStage
    ? ((deal.externalStage.stageLabel || deal.externalStage.stageId || "-") + " / " + (deal.externalStage.externalId || "-"))
    : "-";
  const roleSignalLine = roleSignal
    ? ((roleQueueLabels[roleSignal.queue] || roleSignal.queue || "-") + " / " + (roleSignal.priority || "-"))
    : "-";
  lineage.append(
    workflowLine("Deal", deal ? (deal.company + " / " + deal.id) : dealId),
    workflowLine("Route", deal ? deal.route : "-"),
    workflowLine("HubSpot", hubSpotStage),
    workflowLine("Role signal", roleSignalLine),
    workflowLine("Work item", workItem ? (workItem.id + " / " + workItem.status + " / " + workItem.owner) : "-"),
    workflowLine("Other work items", otherWorkItemCount ? String(otherWorkItemCount) : "-"),
    workflowLine("Suggestion", suggestion ? (suggestion.id + " / " + (suggestionKindLabels[suggestion.kind] || suggestion.kind) + " / " + suggestion.status) : "-"),
    workflowLine("Source event", workItem?.agentSuggestionSourceEventId || suggestion?.sourceEventId || "-")
  );
  const summary = el("div");
  summary.append(lineage, workflowNextAction(dealId, deal, roleSignal, workItem, suggestion, hasUnpairedProposedDraft, linkedDraftMissing));
  const grid = el("div", "workflow-grid");
  grid.append(steps, summary);
  root.replaceChildren(grid);
}
function renderWorkItems(){
  const root = qs("#work-items");
  if (!root) return;
  const rows = state.workItems || [];
  if (!rows.length) {
    root.replaceChildren(el("div", "empty", "No work items yet. Open one from a role queue."));
    return;
  }
  const table = el("table");
  const head = document.createElement("tr");
  ["Status", "Owner", "Queue", "Deal", "Priority", "Title", "Updated", "Action"].forEach((h) => head.append(el("th", null, h)));
  table.append(head);
  for (const item of rows) {
    const row = el("tr", "selectable" + (item.dealId === selectedId ? " selected" : ""));
    row.addEventListener("click", () => selectDeal(item.dealId));
    row.append(
      cell(item.status, workItemStatusClass(item.status)),
      cell(item.owner),
      cell(roleQueueLabels[item.queue] || item.queue),
      cell(item.dealId),
      cell(item.priority, rolePriorityClass(item.priority)),
      cell(item.title),
      cell(item.updatedAt),
      workItemActionCell(item)
    );
    table.append(row);
  }
  root.replaceChildren(
    table,
    el("div", "muted", "Showing latest " + rows.length + " role-queue work items.")
  );
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
function suggestionStatusClass(status){
  if (status === "accepted") return "pass";
  if (status === "rejected") return "muted";
  return "warn";
}
function suggestionStatusGroup(suggestion){
  if (suggestion.status === "proposed") return "open";
  if (suggestion.status === "accepted" || suggestion.status === "rejected") return "decided";
  return "other";
}
function suggestionAuditText(suggestion){
  return "By " + (suggestion.createdBy || "-") + " at " + (suggestion.createdAt || "-") + " | Source " + (suggestion.source || "-") + " / " + (suggestion.sourceEventId || "-");
}
function suggestionDecisionText(suggestion){
  if (suggestion.status === "proposed") return "awaiting human";
  if (!suggestion.decidedBy && !suggestion.decidedAt && !suggestion.decisionReason) return "-";
  return (suggestion.decidedBy || "-") + " at " + (suggestion.decidedAt || "-") + ": " + (suggestion.decisionReason || "-");
}
function suggestionDetailCell(suggestion){
  const detail = document.createElement("td");
  const body = el("div", "suggestion-body", suggestion.body || "(no draft body)");
  detail.append(
    el("div", "suggestion-title", suggestion.title || "(untitled suggestion)"),
    body,
    el("div", "suggestion-meta", "Rationale: " + (suggestion.rationale || "-")),
    el("div", "suggestion-meta", suggestionAuditText(suggestion))
  );
  return detail;
}
function suggestionActionCell(suggestion){
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
  return actionCell;
}
function agentSuggestionFilterName(filter){
  const labels = { open: "Open", decided: "Decided", other: "Other", all: "All" };
  return labels[filter] || filter;
}
function agentSuggestionFilterLabel(filter, count){
  return agentSuggestionFilterName(filter) + " " + count;
}
function agentSuggestionFilterEmptyText(){
  if (agentSuggestionFilter === "all") return "No agent suggestions in this view.";
  return "No " + agentSuggestionFilterName(agentSuggestionFilter).toLowerCase() + " agent suggestions in this view.";
}
function agentSuggestionFilterMatches(suggestion){
  if (agentSuggestionFilter === "all") return true;
  return suggestionStatusGroup(suggestion) === agentSuggestionFilter;
}
function countAgentSuggestions(rows){
  return rows.reduce((acc, suggestion) => {
    const group = suggestionStatusGroup(suggestion);
    if (group === "other" && !warnedAgentSuggestionStatuses.has(suggestion.status)) {
      warnedAgentSuggestionStatuses.add(suggestion.status);
      console.warn("unknown agent suggestion status", suggestion.status);
    }
    acc.all += 1;
    acc[group] += 1;
    return acc;
  }, { open: 0, decided: 0, other: 0, all: 0 });
}
function normalizeAgentSuggestionFilter(counts){
  if (agentSuggestionFilter === "other" && !counts.other) {
    agentSuggestionFilter = counts.open ? "open" : counts.decided ? "decided" : "all";
  }
}
function agentSuggestionQueueSummary(counts){
  const parts = [
    counts.open + " open proposal" + (counts.open === 1 ? "" : "s"),
    counts.decided + " decided suggestion" + (counts.decided === 1 ? "" : "s"),
  ];
  if (counts.other) {
    parts.push(counts.other + " unclassified status" + (counts.other === 1 ? "" : "es"));
  }
  return "Queue: " + parts.join(", ");
}
function renderAgentSuggestionFilters(counts){
  const toolbar = el("div", "toolbar");
  toolbar.append(el("div", counts.other ? "warn" : "muted", agentSuggestionQueueSummary(counts)));
  const segmented = el("div", "segmented");
  segmented.setAttribute("role", "group");
  segmented.setAttribute("aria-label", "Filter agent suggestions");
  const filters = counts.other
    ? ["open", "decided", "other", "all"]
    : ["open", "decided", "all"];
  for (const filter of filters) {
    const active = agentSuggestionFilter === filter;
    const label = agentSuggestionFilterLabel(filter, counts[filter]);
    const button = el(
      "button",
      "secondary" + (active ? " active" : ""),
      label
    );
    button.type = "button";
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("data-filter", filter);
    button.addEventListener("click", () => {
      agentSuggestionFilter = filter;
      renderAgentSuggestions();
    });
    segmented.append(button);
  }
  toolbar.append(segmented);
  return toolbar;
}
function renderAgentSuggestions(){
  const root = qs("#agent-suggestions");
  const rows = state.agentSuggestions || [];
  if (!rows.length) {
    root.replaceChildren(el("div", "empty", "No agent suggestions."));
    return;
  }
  const counts = countAgentSuggestions(rows);
  normalizeAgentSuggestionFilter(counts);
  const visibleRows = rows.filter(agentSuggestionFilterMatches);
  const table = el("table");
  const head = document.createElement("tr");
  ["Status", "Kind", "Deal", "Suggestion", "Decision", "Action"].forEach((h) => head.append(el("th", null, h)));
  table.append(head);
  for (const suggestion of visibleRows) {
    const row = el("tr", "selectable" + (selectedId && suggestion.dealId === selectedId ? " selected" : ""));
    row.addEventListener("click", () => selectDeal(suggestion.dealId));
    row.append(
      cell(suggestion.status, suggestionStatusClass(suggestion.status)),
      cell(suggestionKindLabels[suggestion.kind] || suggestion.kind),
      cell(suggestion.dealId),
      suggestionDetailCell(suggestion),
      cell(suggestionDecisionText(suggestion)),
      suggestionActionCell(suggestion)
    );
    table.append(row);
  }
  const filterEmpty = el("div", "empty", agentSuggestionFilterEmptyText());
  root.replaceChildren(
    renderAgentSuggestionFilters(counts),
    visibleRows.length ? table : filterEmpty
  );
}
function renderSelectedDealSuggestions(){
  const detail = qs("#detail");
  const section = detail?.querySelector("[data-deal-suggestion-section='true']");
  if (!state || selectedId == null || !section || section.dataset.dealId !== String(selectedId)) return;
  populateDealSuggestionSection(section, selectedId);
}
// Local fallback only patches the suggestion rows the operator just touched.
// Other dashboard sections stay on the last full /state payload until refresh.
function applySuggestionDecisionResult(result, expectedSuggestionId){
  if (!state || !result || !result.suggestion) return false;
  if (result.suggestion.id !== expectedSuggestionId) {
    console.warn("agent suggestion decision response id mismatch", result.suggestion.id, expectedSuggestionId);
    return false;
  }
  const rows = state.agentSuggestions || [];
  const index = rows.findIndex((row) => row.id === result.suggestion.id);
  if (index < 0) return false;
  state.agentSuggestions = [
    ...rows.slice(0, index),
    result.suggestion,
    ...rows.slice(index + 1),
  ];
  return true;
}
function renderSuggestionSurfaces(options){
  if (!state) return;
  renderAgentSuggestions();
  if (!options || options.detail !== false) renderSelectedDealSuggestions();
  renderWorkflowGuide();
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
async function draftWorkItemSuggestions(){
  const button = qs("#draft-work-item-btn");
  if (!button) {
    setAgentActionStatus("Work item draft button is not available.", "fail");
    return;
  }
  if (workItemDraftRunPending) return;
  pauseDemoAutoPilot();
  workItemDraftRunPending = true;
  button.disabled = true;
  renderWorkflowGuide();
  setAgentActionStatus("Drafting work item actions...", "muted");
  try {
    const result = await fetchJson("/agent-suggestion-runs/work-items", {
      method: "POST",
      headers: localWriteHeaders(),
      body: JSON.stringify({
        createdBy: WORK_ITEM_SUGGESTION_RUNNER,
        limit: AGENT_SUGGESTION_DRAFT_LIMIT
      })
    });
    setAgentActionStatus(
      "Work item run: " + result.recorded + " recorded, " + result.duplicate + " duplicate, " + result.skipped + " skipped.",
      result.recorded > 0 ? "pass" : "muted"
    );
    await loadState();
  } catch (err) {
    setAgentActionStatus(String(err), "fail");
  } finally {
    workItemDraftRunPending = false;
    button.disabled = false;
    renderWorkflowGuide();
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
  // The lock spans the dialog and decision POST. If the POST response can be
  // patched into local state, the patched render releases the lock before the
  // reload; otherwise the finally block releases and repaints.
  let lockReleased = false;
  let refreshStatus = null;
  pauseDemoAutoPilot();
  pendingSuggestionDecisions.add(suggestion.id);
  try {
    renderSuggestionSurfaces();
    const reason = await openDecisionDialog(suggestion, decision);
    if (reason === null) {
      setAgentActionStatus("Decision cancelled.", "muted");
      return; // operator cancelled; finally releases the lock
    }
    const activeSuggestion = (state.agentSuggestions || []).find((row) => row.id === suggestion.id);
    if (!activeSuggestion || activeSuggestion.status !== "proposed") {
      setAgentActionStatus("Suggestion changed while the dialog was open; refreshing before deciding.", "warn");
      refreshStatus = await loadState();
      return;
    }
    setAgentActionStatus(decision + " " + activeSuggestion.id + "...", "muted");
    const result = await fetchJson("/agent-suggestions/" + encodeURIComponent(activeSuggestion.id) + "/decision", {
      method: "POST",
      headers: localWriteHeaders(),
      body: JSON.stringify({
        sourceEventId: deterministicUuidV4("agent-suggestion-decision:" + activeSuggestion.id + ":" + decision),
        decision,
        humanPrincipal: OPERATOR_PRINCIPAL,
        reason
      })
    });
    setAgentActionStatus(
      "Suggestion " + result.status + ": " + activeSuggestion.title,
      result.status === "recorded" ? "pass" : "warn"
    );
    const patchedBeforeReload = applySuggestionDecisionResult(result, activeSuggestion.id);
    if (patchedBeforeReload) {
      pendingSuggestionDecisions.delete(suggestion.id);
      lockReleased = true;
      renderSuggestionSurfaces();
    }
    refreshStatus = await loadState();
    if (refreshStatus === "error") {
      const localState = patchedBeforeReload
        ? "local suggestion row was patched"
        : (state ? "local suggestion row was not found" : "local state is unavailable");
      setAgentActionStatus("Decision " + result.status + " for " + activeSuggestion.title + ". Refresh failed after the decision response; " + localState + ". Refresh to sync the rest of the dashboard.", "warn");
    }
  } catch (err) {
    setAgentActionStatus(String(err), "fail");
  } finally {
    const releasedHere = !lockReleased;
    if (releasedHere) pendingSuggestionDecisions.delete(suggestion.id);
    if (releasedHere || refreshStatus !== "ok") renderSuggestionSurfaces();
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
function notifyStatusLabel(status){
  if (!status) return "unnotified";
  return status;
}
function notifyStatusClass(status){
  if (status === "ok") return "pass";
  if (status === "failed" || status === "max_attempts_exceeded") return "fail";
  if (status === "pending") return "warn";
  return "muted";
}
function notificationRetryable(status){
  return status === "failed" || status === "pending" || status === "max_attempts_exceeded";
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
  ["Router ID", "Readiness", "Blocker", "Notify", "Reason", "Last Updated"].forEach((h) => head.append(el("th", null, h)));
  table.append(head);
  for (const rowState of rows) {
    const row = el("tr", "selectable" + (rowState.dealId === selectedId ? " selected" : ""));
    row.addEventListener("click", () => selectDeal(rowState.dealId));
    const reason = rowState.reason || (rowState.factsStatus === "missing" ? "awaiting deployment facts" : "-");
    row.append(
      cell(rowState.dealId),
      cell(readinessDisplay(rowState), readinessClass(rowState)),
      cell(blockerDisplay(rowState)),
      cell(notifyStatusLabel(rowState.notifyStatus), notifyStatusClass(rowState.notifyStatus)),
      cell(reason),
      cell(rowState.updatedAt)
    );
    table.append(row);
  }
  root.replaceChildren(table);
}
function option(value, label, selected){
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  if (selected) node.selected = true;
  return node;
}
function booleanSelect(defaultValue){
  const input = document.createElement("select");
  input.required = true;
  input.append(
    option("", "Select...", defaultValue === null || defaultValue === undefined),
    option("true", "Yes", defaultValue === true),
    option("false", "No", defaultValue === false)
  );
  input.value = defaultValue === true ? "true" : defaultValue === false ? "false" : "";
  return input;
}
function parseBooleanSelect(input){
  if (input.value === "true") return true;
  if (input.value === "false") return false;
  return null;
}
async function refreshAfterLocalWrite(status, successMessage, onRefreshOk){
  status.className = "action-status pass";
  status.textContent = successMessage + " Refreshing state...";
  const refreshStatus = await loadState();
  if (refreshStatus === "ok") {
    try {
      onRefreshOk();
      return true;
    } catch (err) {
      status.className = "action-status warn";
      status.textContent = successMessage + " Refresh succeeded, but local retry state could not be cleared: " + String(err);
      return false;
    }
  }
  status.className = "action-status warn";
  status.textContent = successMessage + " Refresh failed; the write may already be recorded. Retry after refreshing the dashboard.";
  return false;
}
function localWriteResultStatus(result){
  return result && typeof result.status === "string" && result.status.trim() ? result.status : "recorded";
}
function showPendingLocalActionConflict(status, prefix, scopeKey, label, conflict){
  status.className = "action-status warn";
  const clearButton = el("button", "secondary", "Clear Pending Write");
  clearButton.type = "button";
  clearButton.addEventListener("click", () => {
    try {
      clearLocalActionEvent(prefix, scopeKey);
      status.className = "action-status";
      status.textContent = "Pending " + label + " write cleared. Submit again only if this is a new operator action.";
    } catch (err) {
      status.className = "action-status fail";
      status.textContent = String(err);
    }
  });
  status.replaceChildren(
    "A " + label + " write for this deal is still unconfirmed. Use the same values, refresh the dashboard, or clear the pending write before changing fields. Pending event: " + conflict.pendingSourceEventId + " ",
    clearButton
  );
}
async function postCommercialStateControl(dealId, commercialState, reason, button, status){
  const normalizedReason = reason.value.trim();
  if (!commercialState.value) {
    status.className = "action-status fail";
    status.textContent = "Select a commercial state.";
    return;
  }
  const payloadKey = {
    dealId,
    commercialState: commercialState.value,
    reason: normalizedReason || null
  };
  const scopeKey = { dealId };
  const actionEventResult = localActionEvent("commercial-state", scopeKey, payloadKey);
  if (actionEventResult.status === "invalid_payload") {
    status.className = "action-status fail";
    status.textContent = "Commercial-state write is not retry-safe: " + actionEventResult.detail;
    return;
  }
  if (actionEventResult.status === "persist_failed") {
    status.className = "action-status fail";
    status.textContent = "Could not persist the local retry guard; not sending commercial-state write.";
    return;
  }
  if (actionEventResult.status !== "ok") {
    showPendingLocalActionConflict(
      status,
      "commercial-state",
      scopeKey,
      "commercial-state",
      actionEventResult
    );
    return;
  }
  const actionEvent = actionEventResult.event;
  button.disabled = true;
  status.className = "action-status";
  status.textContent = "Recording commercial state...";
  pauseDemoAutoPilot();
  try {
    const result = await fetchJson("/commercial-state", {
      method: "POST",
      headers: localWriteHeaders(),
      body: JSON.stringify({
        dealId,
        commercialState: commercialState.value,
        sourceEventId: actionEvent.sourceEventId,
        occurredAt: actionEvent.occurredAt,
        ...(normalizedReason ? { reason: normalizedReason } : {})
      })
    });
    await refreshAfterLocalWrite(
      status,
      "Commercial state " + localWriteResultStatus(result) + ".",
      () => clearLocalActionEvent("commercial-state", scopeKey)
    );
  } catch (err) {
    status.className = "action-status fail";
    status.textContent = String(err);
  } finally {
    button.disabled = false;
  }
}
async function postDeploymentFactsControl(dealId, useCaseClear, integrationsKnown, dataReady, operator, button, status){
  const parsedUseCaseClear = parseBooleanSelect(useCaseClear);
  const parsedIntegrationsKnown = parseBooleanSelect(integrationsKnown);
  const parsedDataReady = parseBooleanSelect(dataReady);
  const normalizedOperator = operator.value.trim();
  if (parsedUseCaseClear === null || parsedIntegrationsKnown === null || parsedDataReady === null) {
    status.className = "action-status fail";
    status.textContent = "Select all deployment fact fields.";
    return;
  }
  if (!normalizedOperator) {
    status.className = "action-status fail";
    status.textContent = "Operator is required.";
    return;
  }
  const payloadKey = {
    dealId,
    useCaseClear: parsedUseCaseClear,
    integrationsKnown: parsedIntegrationsKnown,
    dataReady: parsedDataReady,
    operator: normalizedOperator
  };
  const scopeKey = { dealId };
  const actionEventResult = localActionEvent("deployment-facts", scopeKey, payloadKey);
  if (actionEventResult.status === "invalid_payload") {
    status.className = "action-status fail";
    status.textContent = "Deployment-facts write is not retry-safe: " + actionEventResult.detail;
    return;
  }
  if (actionEventResult.status === "persist_failed") {
    status.className = "action-status fail";
    status.textContent = "Could not persist the local retry guard; not sending deployment-facts write.";
    return;
  }
  if (actionEventResult.status !== "ok") {
    showPendingLocalActionConflict(
      status,
      "deployment-facts",
      scopeKey,
      "deployment-facts",
      actionEventResult
    );
    return;
  }
  const actionEvent = actionEventResult.event;
  button.disabled = true;
  status.className = "action-status";
  status.textContent = "Recording deployment facts...";
  pauseDemoAutoPilot();
  try {
    const result = await fetchJson("/deployment-facts", {
      method: "POST",
      headers: localWriteHeaders(),
      body: JSON.stringify({
        dealId,
        sourceEventId: actionEvent.sourceEventId,
        occurredAt: actionEvent.occurredAt,
        useCaseClear: parsedUseCaseClear,
        integrationsKnown: parsedIntegrationsKnown,
        dataReady: parsedDataReady,
        operator: normalizedOperator
      })
    });
    await refreshAfterLocalWrite(
      status,
      "Deployment facts " + localWriteResultStatus(result) + ".",
      () => clearLocalActionEvent("deployment-facts", scopeKey)
    );
  } catch (err) {
    status.className = "action-status fail";
    status.textContent = String(err);
  } finally {
    button.disabled = false;
  }
}
async function retryDeploymentNotificationControl(dealId, button, status){
  button.disabled = true;
  status.className = "action-status";
  status.textContent = "Retrying handoff notification...";
  pauseDemoAutoPilot();
  try {
    const result = await fetchJson("/notification-retry", {
      method: "POST",
      headers: localWriteHeaders(),
      body: JSON.stringify({ dealId, limit: 1 })
    });
    const attempted = result && typeof result.attempted === "number" ? result.attempted : 0;
    const firstStatus = result?.results?.[0]?.status || "no_candidate";
    status.className = "action-status " + (firstStatus === "ok" ? "pass" : "warn");
    status.textContent = "Notification retry attempted " + attempted + " candidate(s): " + firstStatus + ". Refreshing state...";
    const refreshStatus = await loadState();
    if (refreshStatus !== "ok") {
      status.className = "action-status warn";
      status.textContent = "Notification retry attempted " + attempted + " candidate(s): " + firstStatus + ". Refresh failed; retry after refreshing the dashboard.";
    }
  } catch (err) {
    status.className = "action-status fail";
    status.textContent = String(err);
  } finally {
    button.disabled = false;
  }
}
function lifecycleControlsSection(dealId, deal, readiness){
  const section = el("div", "section");
  section.dataset.lifecycleControls = "true";
  section.append(el("h2", null, "Lifecycle Controls"));
  if (deal?.status === "quarantined") {
    section.append(el("div", "empty", "Lifecycle controls are available after a deal is routed."));
    return section;
  }

  const commercialWrap = el("div", "mini-form");
  commercialWrap.append(el("div", "muted", "Commercial state"));
  const commercialState = document.createElement("select");
  commercialState.required = true;
  commercialState.append(option("", "Select...", true));
  for (const [value, label] of [
    ["open", "Open"],
    ["proposal_sent", "Proposal Sent"],
    ["negotiating", "Negotiating"],
    ["closed_won", "Closed Won"],
    ["closed_lost", "Closed Lost"]
  ]) {
    commercialState.append(option(value, label, false));
  }
  commercialState.value = "";
  const commercialReason = document.createElement("textarea");
  commercialReason.rows = 2;
  commercialReason.maxLength = 500;
  commercialReason.placeholder = "Optional reason";
  const commercialButton = el("button", "secondary", "Record Commercial State");
  commercialButton.type = "button";
  const commercialStatus = el("div", "action-status");
  commercialButton.addEventListener("click", () => {
    void postCommercialStateControl(dealId, commercialState, commercialReason, commercialButton, commercialStatus);
  });
  const commercialRow = el("div", "two");
  commercialRow.append(
    labeledInput("State", commercialState),
    labeledInput("Reason", commercialReason)
  );
  commercialWrap.append(
    commercialRow,
    commercialButton,
    commercialStatus
  );

  const factsWrap = el("div", "mini-form");
  factsWrap.append(el("div", "muted", "Deployment facts"));
  const useCaseClear = booleanSelect(null);
  const integrationsKnown = booleanSelect(null);
  const dataReady = booleanSelect(null);
  const operator = document.createElement("input");
  operator.required = true;
  operator.maxLength = 120;
  operator.value = OPERATOR_PRINCIPAL;
  const factsButton = el("button", "secondary", "Record Deployment Facts");
  factsButton.type = "button";
  const factsStatus = el("div", "action-status");
  factsButton.addEventListener("click", () => {
    void postDeploymentFactsControl(dealId, useCaseClear, integrationsKnown, dataReady, operator, factsButton, factsStatus);
  });
  const factsRow = el("div", "two");
  factsRow.append(
    labeledInput("Use Case Clear", useCaseClear),
    labeledInput("Integrations Known", integrationsKnown)
  );
  factsWrap.append(
    factsRow,
    labeledInput("Data Ready", dataReady),
    labeledInput("Operator", operator),
    factsButton,
    factsStatus
  );

  section.append(commercialWrap, factsWrap);
  if (readiness) {
    const notifyWrap = el("div", "mini-form");
    notifyWrap.append(
      el("div", "muted", "Deployment handoff notification"),
      workflowLine("Notify status", notifyStatusLabel(readiness.notifyStatus), notifyStatusClass(readiness.notifyStatus))
    );
    if (notificationRetryable(readiness.notifyStatus)) {
      const retryButton = el("button", "secondary", "Retry Handoff Notification");
      retryButton.type = "button";
      const retryStatus = el("div", "action-status");
      retryButton.addEventListener("click", () => {
        void retryDeploymentNotificationControl(dealId, retryButton, retryStatus);
      });
      notifyWrap.append(retryButton, retryStatus);
    }
    section.append(notifyWrap);
  } else if (!deal) {
    section.append(el("div", "empty", "No routed deal or readiness row is available for this record."));
  }
  return section;
}
function populateDealSuggestionSection(section, dealId){
  section.replaceChildren(el("h2", null, "Agent Suggestions"));
  const rows = (state.agentSuggestions || [])
    .filter((suggestion) => suggestion.dealId === dealId)
    .sort((a, b) => {
      const aRank = a.status === "proposed" ? 0 : 1;
      const bRank = b.status === "proposed" ? 0 : 1;
      if (aRank !== bRank) return aRank - bRank;
      const aTime = a.status === "proposed" ? a.createdAt : (a.decidedAt || a.createdAt);
      const bTime = b.status === "proposed" ? b.createdAt : (b.decidedAt || b.createdAt);
      if (aTime !== bTime) return bTime.localeCompare(aTime);
      return b.id.localeCompare(a.id);
    });
  if (!rows.length) {
    section.append(el("div", "empty", "No recent agent suggestions for this deal."));
    return;
  }
  const visibleRows = rows.slice(0, DEAL_DETAIL_SUGGESTION_LIMIT);
  const table = el("table");
  const head = document.createElement("tr");
  ["Status", "Kind", "Suggestion", "Decision", "Action"].forEach((h) => head.append(el("th", null, h)));
  table.append(head);
  for (const suggestion of visibleRows) {
    const row = document.createElement("tr");
    row.append(
      cell(suggestion.status, suggestionStatusClass(suggestion.status)),
      cell(suggestionKindLabels[suggestion.kind] || suggestion.kind),
      suggestionDetailCell(suggestion),
      cell(suggestionDecisionText(suggestion)),
      suggestionActionCell(suggestion)
    );
    table.append(row);
  }
  section.append(table);
  if (rows.length > DEAL_DETAIL_SUGGESTION_LIMIT) {
    section.append(el("div", "muted", "Showing " + visibleRows.length + " of " + rows.length + " recent suggestions for this deal."));
  }
}
function dealSuggestionSection(dealId){
  const section = el("div", "section");
  section.dataset.dealSuggestionSection = "true";
  section.dataset.dealId = String(dealId);
  populateDealSuggestionSection(section, dealId);
  return section;
}
function selectDeal(dealId){
  urlPinnedDealId = null;
  missingUrlPinnedDealId = null;
  clearUrlDealParam();
  selectedId = dealId;
  pauseDemoAutoPilot();
  renderUrlPinStatus();
  renderWorkflowGuide();
  renderQueue();
  renderRoleQueues();
  renderWorkItems();
  renderPolicyEvaluation();
  renderPolicyRuns();
  renderAgentSuggestions();
  renderDeploymentHandoff();
  scheduleRenderDetail();
}
function scheduleRenderDetail(){
  const seq = ++detailRequestSeq;
  void renderDetail(seq).catch((err) => {
    if (seq !== detailRequestSeq) return;
    console.error(err);
    qs("#detail")?.replaceChildren(el("div", "empty", "Could not render deal detail: " + String(err)));
  });
}
async function renderDetail(seq){
  const root = qs("#detail");
  if (!root) return;
  if (!state) {
    root.replaceChildren(el("div", "empty", "State is not loaded."));
    return;
  }
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
  const lifecycle = lifecycleControlsSection(detailId, deal, detailReadiness);
  const scoreBox = el("div", "section");
  scoreBox.append(el("h2", null, "Score Explanation"));
  if (deal?.scoreNotes && deal.scoreNotes.length) {
    const notes = el("div", "journey");
    for (const note of deal.scoreNotes) notes.append(el("div", "event", note));
    scoreBox.append(notes);
  } else {
    scoreBox.append(el("div", "empty", "No score notes available."));
  }
  const enrichmentBox = el("div", "section");
  enrichmentBox.append(el("h2", null, "Enrichment Evidence"));
  const facts = deal?.enrichmentFacts || null;
  if (facts) {
    const factRows = el("div", "kv");
    const factFields = [
      ["Provider", displayValue(facts.sourceProvider)],
      ["Confidence", displayNumber(facts.confidence, 2)],
      ["Freshness", displayValue(facts.freshnessStatus)],
      ["Industry", displayValue(facts.industry)],
      ["Employees", displayInteger(facts.employees)],
      ["Regulated", displayBoolean(facts.regulated)],
      ["Tech Signals", Array.isArray(facts.techSignals) ? facts.techSignals.join(", ") || "-" : "-"],
      ["Observed", displayValue(facts.observedAt)],
      ["Expires", displayValue(facts.expiresAt)],
      ["Observation", displayValue(facts.sourceObservationId)]
    ];
    for (const [k, v] of factFields) factRows.append(el("div", null, k), el("div", null, v));
    enrichmentBox.append(factRows);
  } else {
    enrichmentBox.append(el("div", "empty", "No projected enrichment facts available."));
  }
  enrichmentBox.append(manualEnrichmentForm(deal, facts));
  const replayForm = quarantineReplayForm(deal);
  if (replayForm) enrichmentBox.append(replayForm);
  const suggestions = dealSuggestionSection(detailId);
  const journey = el("div", "section");
  journey.append(el("h2", null, "Deal Journey"));
  const list = el("div", "journey");
  if (eventBody.truncated) {
    list.append(el("div", "empty", "Showing intake plus latest " + (events.length - 1) + " of " + eventBody.total + " events."));
  }
  for (const event of events) {
    list.append(el("div", "event", event.from + " -> " + event.to + " | " + event.detail + "\n" + event.ts));
  }
  journey.append(list);
  root.replaceChildren(title, lifecycle, scoreBox, enrichmentBox, suggestions, journey);
}
async function loadState(){
  const seq = ++stateRequestSeq;
  try {
    const next = await fetchJson("/state");
    if (seq !== stateRequestSeq) return "stale";
    state = next;
    const workflowIds = workflowDealIds();
    if (urlPinnedDealId) {
      if (workflowIds.has(urlPinnedDealId)) {
        selectedId = urlPinnedDealId;
        missingUrlPinnedDealId = null;
      }
      else {
        missingUrlPinnedDealId = urlPinnedDealId;
        urlPinnedDealId = null;
        selectedId = null;
        clearUrlDealParam();
      }
    }
    const demoCanRetarget =
      OPERATOR_DEMO_MODE &&
      !urlPinnedDealId &&
      !demoAutoPilotPaused &&
      pendingSuggestionDecisions.size === 0 &&
      pendingWorkItemActions.size === 0;
    if (demoCanRetarget) {
      if (selectedId && !workflowIds.has(selectedId)) selectedId = null;
      selectedId = preferredWorkflowDealId() || selectedId;
    }
    if (!selectedId && (state.queue || [])[0]) selectedId = (state.queue || [])[0].id;
    if (!selectedId && (state.deploymentReadiness || [])[0]) selectedId = state.deploymentReadiness[0].dealId;
    qs("#last-refresh").textContent = new Date().toLocaleTimeString();
    renderUrlPinStatus();
    renderKpis();
    renderQueue();
    renderRoleQueues();
    renderWorkItems();
    renderPolicyEvaluation();
    renderPolicyRuns();
    renderSuggestionSurfaces({ detail: false });
    renderExceptions();
    renderDeploymentHandoff();
    scheduleRenderDetail();
    return "ok";
  } catch (err) {
    if (seq !== stateRequestSeq) return "stale";
    qs("#last-refresh").textContent = "state error " + new Date().toLocaleTimeString();
    if (!state) {
      const msg = "State load failed: " + String(err);
      qs("#kpis").replaceChildren(el("div", "empty", msg));
      qs("#queue").replaceChildren(el("div", "empty", msg));
      qs("#role-queues").replaceChildren(el("div", "empty", msg));
      qs("#work-items").replaceChildren(el("div", "empty", msg));
      qs("#policy-evaluation").replaceChildren(el("div", "empty", msg));
      qs("#policy-runs").replaceChildren(el("div", "empty", msg));
      qs("#workflow-guide").replaceChildren(el("div", "empty", msg));
      qs("#agent-suggestions").replaceChildren(el("div", "empty", msg));
      qs("#exceptions").replaceChildren(el("div", "empty", msg));
      qs("#deployment-handoff").replaceChildren(el("div", "empty", msg));
      qs("#detail").replaceChildren(el("div", "empty", msg));
    }
    return "error";
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
      root.textContent = "QUARANTINE\n" + body.stage + ": " + body.reason;
      return;
    }
    const d = body.deal;
    root.textContent = [
      "ROUTE " + (d.route.kind === "human_assisted" ? "human -> " + d.route.salesOwner : d.route.kind),
      "score " + d.score.total.toFixed(2) + " | " + fmtMoney.format(d.dealUSD),
      d.route.financeFlag ? "finance: " + d.route.financeFlag : "finance: none",
      d.route.legalFlag ? "legal: " + d.route.legalFlag : "legal: none",
      ...d.score.notes
    ].join("\n");
  } catch (err) {
    root.textContent = "ERROR\n" + String(err);
  }
}
hydratePendingLocalActionEvents();
const savedLocalSecret = sessionStorage.getItem(LOCAL_SECRET_STORAGE_KEY);
if (savedLocalSecret) qs("#local-secret").value = savedLocalSecret;
qs("#preview-btn").addEventListener("click", preview);
qs("#refresh-btn").addEventListener("click", () => { loadState(); loadHealth(); });
qs("#workflow-mode").addEventListener("click", () => { toggleDemoAutoPilot(); });
qs("#draft-policy-btn").addEventListener("click", () => { void draftPolicyRecommendations(); });
qs("#draft-work-item-btn").addEventListener("click", () => { void draftWorkItemSuggestions(); });
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
    root.textContent = "ERROR\n" + String(err);
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
