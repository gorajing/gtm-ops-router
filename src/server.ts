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
import { z } from "zod";
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
 .toolbar{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
 .segmented{display:flex;gap:4px;flex-wrap:wrap}
 .segmented button{padding:5px 8px;font-size:12px}
 .segmented button.active{background:var(--ink);color:#fff;border-color:var(--ink)}
 .action-status{font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);min-height:18px}
 .suggestion-title{font-weight:700;color:var(--ink);margin-bottom:5px;overflow-wrap:anywhere}
 .suggestion-body{border:1px solid var(--line);background:var(--soft);border-radius:5px;padding:7px 8px;margin:5px 0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);max-height:120px;overflow:auto;user-select:text}
 .suggestion-meta{color:var(--muted);font-size:11px;overflow-wrap:anywhere;margin-top:4px}
 .workflow-panel{margin-bottom:12px}
 .workflow-head{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
 .workflow-grid{display:grid;grid-template-columns:1.2fr .8fr;gap:12px;align-items:start}
 .workflow-steps{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:7px}
 .workflow-step{border:1px solid var(--line);border-radius:6px;background:#fff;padding:9px;min-height:112px}
 .workflow-step.active{border-color:var(--blue);box-shadow:inset 0 0 0 1px rgba(36,94,219,.2)}
 .workflow-step.complete{border-color:rgba(8,122,85,.48);background:#f3fbf7}
 .workflow-step.waiting{background:var(--soft)}
 .workflow-step-label{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
 .workflow-step-title{font-weight:700;margin-top:5px;overflow-wrap:anywhere}
 .workflow-step-detail{font-size:12px;color:var(--muted);margin-top:5px;overflow-wrap:anywhere}
 .workflow-lineage{display:grid;gap:6px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
 .workflow-next{display:grid;gap:8px;border:1px solid var(--line);background:var(--soft);border-radius:6px;padding:10px}
 dialog{border:1px solid var(--line);border-radius:8px;padding:0;max-width:460px;width:calc(100% - 32px);color:var(--ink);box-shadow:0 14px 44px rgba(20,24,32,.24)}
 dialog::backdrop{background:rgba(20,24,32,.42)}
 .dialog-body{display:grid;gap:10px;padding:16px}
 .dialog-body h3{margin:0;font-size:15px}
 .dialog-detail{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);overflow-wrap:anywhere}
 .dialog-caption{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
 .dialog-draft{border:1px solid var(--line);background:var(--soft);border-radius:5px;padding:9px 10px;max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
 .queue-wrap{max-height:560px;overflow:auto}.exceptions,.handoff-wrap{max-height:260px;overflow:auto}
 .footer{color:var(--muted);font-size:12px;margin-top:12px}
 @media(max-width:1180px){.layout,.top,.workflow-grid{grid-template-columns:1fr}.workflow-steps{grid-template-columns:1fr 1fr}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
 @media(max-width:640px){.shell{padding:14px}.two,.kpis,.workflow-steps{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column}.stamp{white-space:normal}.layout{grid-template-columns:1fr}.queue-wrap{max-height:none}}
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
<script>
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
const MANUAL_ENRICHMENT_MAX_EMPLOYEES = ${MAX_MANUAL_ENRICHMENT_EMPLOYEES};
const MANUAL_ENRICHMENT_RETRY_WINDOW_MS = 5 * 60 * 1000;
const OPERATOR_DEMO_MODE = new URLSearchParams(window.location.search).get("demo") === "operator";
let state = null;
let selectedId = null;
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
const roleQueueOrder = ${JSON.stringify(ROLE_QUEUE_KINDS)};
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
  selectedId = dealId;
  pauseDemoAutoPilot();
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
    list.append(el("div", "event", event.from + " -> " + event.to + " | " + event.detail + "\\n" + event.ts));
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
    const demoCanRetarget =
      OPERATOR_DEMO_MODE &&
      !demoAutoPilotPaused &&
      pendingSuggestionDecisions.size === 0 &&
      pendingWorkItemActions.size === 0;
    if (demoCanRetarget) {
      if (selectedId && !workflowDealIds().has(selectedId)) selectedId = null;
      selectedId = preferredWorkflowDealId() || selectedId;
    }
    if (!selectedId && (state.queue || [])[0]) selectedId = (state.queue || [])[0].id;
    if (!selectedId && (state.deploymentReadiness || [])[0]) selectedId = state.deploymentReadiness[0].dealId;
    qs("#last-refresh").textContent = new Date().toLocaleTimeString();
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
