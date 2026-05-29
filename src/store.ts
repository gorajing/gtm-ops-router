/**
 * Persistence + observability store.
 *
 * Uses Node's BUILT-IN SQLite (`node:sqlite`) on purpose: real SQL, zero native
 * build step, so `git clone && npm i && npm run demo` works on any machine
 * running Node >= 22.5. Trading a battle-tested native dep for clone-and-run
 * reliability is a deliberate tradeoff: real SQL with no native build step.
 *
 * DDL and pragmas are issued one statement per prepared call (no
 * multi-statement string execution) — explicit, lint-clean, and easy to audit.
 */

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import {
  DEPLOYMENT_FACT_MAX_AGE_DAYS,
  ENRICHMENT_FACT_MAX_AGE_DAYS,
  ENRICHMENT_FACT_MIN_CONFIDENCE,
  FALLBACK_NOTIFICATION_MAX_ATTEMPTS,
  FALLBACK_NOTIFICATION_LEASE_MS,
  READINESS_NOTIFICATION_MAX_ATTEMPTS,
  READINESS_NOTIFICATION_LEASE_MS,
  READINESS_PENDING_SLA_HOURS,
  STAGE_NOTIFICATION_LEASE_MS,
  TERMINAL_DRIFT_NOTIFICATION_LEASE_MS,
  TERMINAL_DRIFT_NOTIFICATION_MAX_ATTEMPTS,
  TERMINAL_TIE_WINDOW_MS,
} from "./constants.js";
import { enrichmentSubjectKey } from "./enrich.js";
import type { IntegrationConfigBundle } from "./integrations.js";
import {
  AGENT_SUGGESTION_KINDS,
  AGENT_SUGGESTION_STATUSES,
  LOCAL_AGENT_SUGGESTION_WRITE_STATUSES,
  AgentSuggestionKind,
  AgentSuggestionStatus,
  DEPLOYMENT_BLOCKERS,
  ROLE_QUEUE_KINDS,
  WorkItemStatus,
  PROVIDER_OBSERVATION_PROVIDERS,
  PROVIDER_OBSERVATION_SUBJECT_TYPES,
  ProviderObservationProvider,
  ProviderObservationSubjectType,
  SOURCE_CHANNELS,
  type Deal,
  type Enrichment,
  type EnrichedSubjectFacts,
  type AgentSuggestionDecision,
  type AgentSuggestionRecord,
  type AgentSuggestionRunStatus,
  AgentSuggestionWriteStatusCounts,
  type CommercialTerminalDriftAlertClaim,
  type CommercialTerminalDriftAlertDeliveryResult,
  type CommercialTerminalDriftAlertRetryCandidate,
  isTerminalCommercialState,
  type CommercialState,
  type CommercialStateRecord,
  type DeploymentBlocker,
  type DeploymentFactsRecord,
  type DeploymentReadiness,
  type DeploymentReadinessNotifyStatus,
  type DeploymentReadinessState,
  type ExternalStageState,
  type LocalCommercialStateInput,
  type LocalCommercialStateWriteResult,
  type LocalDeploymentFactsInput,
  type LocalDeploymentFactsWriteResult,
  type LocalAgentSuggestionDecisionInput,
  type LocalAgentSuggestionDecisionResult,
  type LocalAgentSuggestionInput,
  type LocalAgentSuggestionWriteResult,
  type LocalOutcomeInput,
  type LocalOutcomeWriteResult,
  type Metrics,
  type OutcomeEventRecord,
  type OutcomeRejectionKind,
  type OutcomeRejectionRecord,
  type OutcomeState,
  type PipelineEvent,
  type PipelineEventMeta,
  type PolicyEvaluationDeal,
  type PolicyEvaluationReports,
  type PolicyFlag,
  PolicyRecommendationDraftResult as PolicyRecommendationDraftResultSchema,
  type PolicyRecommendationRunRecord,
  type PolicyRecommendationRunInput,
  type PolicyRecommendationRunResult,
  AgentSuggestionRunStatus as AgentSuggestionRunStatusSchema,
  type ProviderObservationInput,
  type ProviderObservationRecord,
  type ProviderObservationWriteResult,
  type SourceChannelPolicySummary,
  type FlagPolicySummary,
  type PreviousDeploymentReadiness,
  type Quarantine,
  type QuarantineCode,
  type ReadinessFallbackNotificationClaim,
  type ReadinessFallbackNotificationClaimMissStatus,
  type ReadinessFallbackNotificationDeliveryResult,
  type ReadinessNotificationClaim,
  type ReadinessNotificationDeliveryResult,
  type ReadinessNotificationRecordStatus,
  type LocalWorkItemActionInput,
  type LocalWorkItemActionResult,
  type LocalWorkItemInput,
  type LocalWorkItemWriteResult,
  type RoleQueueItem,
  type RoleQueueKind,
  type RoleQueuePriority,
  type RoleQueues,
  type RoleQueueStatus,
  type RoutedDeal,
  type Stage,
  type WorkItemRecord,
  type WorkItemSuggestionRunInput,
  type WorkItemSuggestionRunResult,
  type WorkItemStatus as WorkItemStatusType,
} from "./types.js";

// Load the experimental built-in SQLite via createRequire. `node:sqlite`
// isn't in `builtinModules` yet, so static analyzers/bundlers (Vite, Vitest,
// esbuild) try to pre-resolve it and fail. The real Node require resolves it
// fine at runtime — this keeps the artifact runnable under any toolchain.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof DatabaseSyncT;
};

const QUARANTINE_CODES: QuarantineCode[] = [
  "schema_invalid",
  "enrichment_unresolved",
  "insufficient_data",
  "store_error",
  "pipeline_error",
  "sink_terminal",
  "sink_exhausted",
];
const PIPELINE_STAGES = [
  "intake",
  "enriched",
  "scored",
  "routed",
  "quarantined",
] as const satisfies readonly Stage[];

// Stage-change Slack posts are single-attempt and bounded by the shared webhook
// fetch cap in constants.ts. notify_leases counts lease acquisitions, not only
// completed Slack posts.
const NOTIFY_PENDING_LEASE_MS = STAGE_NOTIFICATION_LEASE_MS;
const NOTIFICATION_LEASE_CHANGED = "notification lease changed before mark";
const MAX_EVENT_TAIL = 1000;
const LOCAL_COMMERCIAL_SOURCE = "local";
const LOCAL_DEPLOYMENT_FACTS_SOURCE = "local";
const LOCAL_OUTCOME_SOURCE = "local";
const LOCAL_AGENT_SUGGESTION_SOURCE = "local_agent";
const SELF_REPORTED_OPERATOR_SOURCE = "self_reported";
const PROVIDER_OBSERVATION_ID_PREFIX = "PO";
const DAY_MS = 86_400_000;
const CANONICAL_ISO_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Stay below SQLite builds with the older 999-parameter ceiling.
const SQL_PARAMETER_BUDGET = 900;
// Dashboard/read-model backfills use the same conservative window so each
// follow-up IN query remains within the SQL parameter budget.
const ROLE_QUEUE_MAX_SCAN = SQL_PARAMETER_BUDGET;
const ROLE_QUEUE_HIGH_PRIORITY_USD = 50_000;
const POLICY_CLOSED_WON_STALLED_SLA_HOURS = READINESS_PENDING_SLA_HOURS;
const POLICY_RECOMMENDATION_VERSION = 1;
const DEFAULT_POLICY_RECOMMENDATION_LIMIT = 10;
const MAX_POLICY_RECOMMENDATION_LIMIT = 25;
const DEFAULT_WORK_ITEM_SUGGESTION_LIMIT = 10;
const MAX_WORK_ITEM_SUGGESTION_LIMIT = 25;
const DEFAULT_POLICY_RECOMMENDATION_RUN_PAGE_LIMIT = 25;
const MAX_POLICY_RECOMMENDATION_RUN_PAGE_LIMIT = 100;
const POLICY_RECOMMENDATION_PREFETCH_MULTIPLIER = 4;
function sqlStringList(values: readonly string[]): string {
  return values
    .map((value) => `'${value.replaceAll("'", "''")}'`)
    .join(", ");
}
const PROVIDER_OBSERVATION_SUBJECT_TYPE_SQL = sqlStringList(
  PROVIDER_OBSERVATION_SUBJECT_TYPES,
);
const PROVIDER_OBSERVATION_PROVIDER_SQL = sqlStringList(
  PROVIDER_OBSERVATION_PROVIDERS,
);
const ROLE_QUEUE_KIND_SQL = sqlStringList(ROLE_QUEUE_KINDS);
type NotifiableReadiness = Exclude<DeploymentReadiness, "not_required">;
type OutcomeMetricRow = {
  id: string;
  dealId: string;
  outcome: OutcomeState;
  occurredAt: string;
  createdAt: string;
  arrDeltaUsd: number | null;
};
type RoutedRecord = {
  deal: RoutedDeal;
  updatedAt: string;
  sinkStatus: "synced" | "partial" | "dry_run" | "needs_review";
  externalStage: ExternalStageState | null;
};
type QuarantinedRecord = {
  quarantine: Quarantine;
  deal: Deal | null;
  routedDeal: RoutedDeal | null;
  updatedAt: string;
  externalStage: ExternalStageState | null;
};
type RoutedRecordRow = {
  payload: string;
  updated_at: string;
  sink_status: string | null;
  external_system: string | null;
  external_id: string | null;
  external_stage_id: string | null;
  external_stage_label: string | null;
  external_stage_updated_at: string | null;
};

type QuarantineReplayPayload = Omit<Deal, "contactName" | "contactEmail"> & {
  payloadKind?: "deal" | "routed_deal";
};
type QuarantineRoutedReplayPayload = Omit<
  RoutedDeal,
  "contactName" | "contactEmail"
> & {
  payloadKind?: "routed_deal";
};

function quarantineReplayPayload(
  deal: Deal | RoutedDeal,
): QuarantineReplayPayload | QuarantineRoutedReplayPayload {
  const base = {
    id: deal.id,
    company: deal.company,
    domain: deal.domain,
    dealUSD: deal.dealUSD,
    region: deal.region,
    sourceChannel: deal.sourceChannel,
    statedNeed: deal.statedNeed,
  };
  return "enrichment" in deal
    ? {
        ...base,
        payloadKind: "routed_deal",
        enrichment: deal.enrichment,
        score: deal.score,
        route: deal.route,
      }
    : { ...base, payloadKind: "deal" };
}

function dealFromPayload(payload: string | null): Deal | null {
  if (!payload) return null;
  const parsed = JSON.parse(payload) as QuarantineReplayPayload;
  return {
    id: parsed.id,
    company: parsed.company,
    domain: parsed.domain,
    dealUSD: parsed.dealUSD,
    region: parsed.region,
    sourceChannel: parsed.sourceChannel,
    statedNeed: parsed.statedNeed,
    contactName: "Redacted Contact",
    contactEmail: "redacted@example.invalid",
  };
}

function routedDealFromPayload(payload: string | null): RoutedDeal | null {
  if (!payload) return null;
  const parsed = JSON.parse(payload) as Partial<
    Omit<RoutedDeal, "contactName" | "contactEmail">
  > & { payloadKind?: "deal" | "routed_deal" };
  if (parsed.payloadKind === "deal") return null;
  if (
    parsed.payloadKind !== undefined &&
    parsed.payloadKind !== "routed_deal"
  ) {
    return null;
  }
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.company !== "string" ||
    typeof parsed.domain !== "string" ||
    typeof parsed.dealUSD !== "number" ||
    typeof parsed.region !== "string" ||
    typeof parsed.sourceChannel !== "string" ||
    typeof parsed.statedNeed !== "string" ||
    !parsed.enrichment ||
    !parsed.score ||
    !parsed.route
  ) {
    return null;
  }
  const routedPayload = parsed as QuarantineRoutedReplayPayload;
  return {
    id: routedPayload.id,
    company: routedPayload.company,
    domain: routedPayload.domain,
    dealUSD: routedPayload.dealUSD,
    region: routedPayload.region,
    sourceChannel: routedPayload.sourceChannel,
    statedNeed: routedPayload.statedNeed,
    enrichment: routedPayload.enrichment,
    score: routedPayload.score,
    route: routedPayload.route,
    contactName: "Redacted Contact",
    contactEmail: "redacted@example.invalid",
  };
}

const COMMERCIAL_STATE_RANK: Record<CommercialState, number> = {
  open: 0,
  proposal_sent: 1,
  negotiating: 2,
  closed_won: 3,
  closed_lost: 4,
};

const ROLE_QUEUE_PRIORITY_RANK: Record<RoleQueuePriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function emptyRoleQueues(): RoleQueues {
  return {
    ae_attention: [],
    finance_review: [],
    legal_review: [],
    deployment_readiness: [],
    growth_attribution: [],
  };
}

function newestTimestamp(
  requiredTimestamp: string,
  values: Array<string | null | undefined>,
): string {
  if (requiredTimestamp.length === 0) {
    throw new Error("newestTimestamp requires a non-empty base timestamp");
  }
  return [requiredTimestamp, ...values]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .sort()
    .at(-1)!;
}

function humanOwner(deal: RoutedDeal): string | null {
  return deal.route.kind === "human_assisted" ? deal.route.salesOwner : null;
}

function enrichmentObservationSourceEventId(
  provider: ProviderObservationProvider,
  subjectKey: string,
  enrichment: Enrichment,
): string {
  return stableUuidV4(
    canonicalJson({
      kind: "provider_observation",
      provider,
      subjectKey,
      enrichment,
    }),
  );
}

function enrichmentFactExpiresAt(observedAt: string): string {
  return new Date(
    Date.parse(observedAt) + ENRICHMENT_FACT_MAX_AGE_DAYS * DAY_MS,
  ).toISOString();
}

function actionRolePriority(deal: RoutedDeal): RoleQueuePriority {
  if (
    deal.dealUSD >= ROLE_QUEUE_HIGH_PRIORITY_USD ||
    (deal.route.kind === "human_assisted" &&
      (deal.route.financeFlag !== null || deal.route.legalFlag !== null))
  ) {
    return "high";
  }
  return "medium";
}

function assertSqlParameterBudget(count: number, context: string): void {
  if (count > SQL_PARAMETER_BUDGET) {
    throw new Error(
      `${context} needs ${count} SQL parameters; max supported budget is ${SQL_PARAMETER_BUDGET}`,
    );
  }
}

function sortRoleQueue(items: RoleQueueItem[]): RoleQueueItem[] {
  return [...items].sort((a, b) => {
    const priority =
      ROLE_QUEUE_PRIORITY_RANK[a.priority] - ROLE_QUEUE_PRIORITY_RANK[b.priority];
    if (priority !== 0) return priority;
    const amount = b.amount - a.amount;
    if (amount !== 0) return amount;
    const updatedAt = b.updatedAt.localeCompare(a.updatedAt);
    if (updatedAt !== 0) return updatedAt;
    return a.dealId.localeCompare(b.dealId);
  });
}

function sortPolicyDeals(items: PolicyEvaluationDeal[]): PolicyEvaluationDeal[] {
  return [...items].sort((a, b) => {
    const amount = b.amount - a.amount;
    if (amount !== 0) return amount;
    const observed = b.signalObservedAt.localeCompare(a.signalObservedAt);
    if (observed !== 0) return observed;
    return a.dealId.localeCompare(b.dealId);
  });
}

function policyRecommendationPriority(signal: PolicyEvaluationDeal["signal"]): number {
  switch (signal) {
    case "human_assisted_churned":
      return 0;
    case "human_assisted_stalled":
    case "human_assisted_ready_not_started":
      return 1;
    case "self_serve_expanded":
      return 2;
  }
  const exhaustive: never = signal;
  return exhaustive;
}

function sortPolicyRecommendationCandidates(
  items: PolicyEvaluationDeal[],
): PolicyEvaluationDeal[] {
  return [...items].sort((a, b) => {
    const priority = policyRecommendationPriority(a.signal) - policyRecommendationPriority(b.signal);
    if (priority !== 0) return priority;
    const amount = b.amount - a.amount;
    if (amount !== 0) return amount;
    const observed = b.signalObservedAt.localeCompare(a.signalObservedAt);
    if (observed !== 0) return observed;
    return a.dealId.localeCompare(b.dealId);
  });
}

function policyRecommendationSourceEventId(item: PolicyEvaluationDeal): string {
  return stableUuidV4(
    canonicalJson({
      kind: "policy_recommendation",
      version: POLICY_RECOMMENDATION_VERSION,
      dealId: item.dealId,
      signal: item.signal,
      signalObservedAt: item.signalObservedAt,
    }),
  );
}

function policyRecommendationTitle(item: PolicyEvaluationDeal): string {
  switch (item.signal) {
    case "self_serve_expanded":
      return truncateField(`Review self-serve expansion: ${item.company}`, 160);
    case "human_assisted_churned":
      return truncateField(`Review human-assisted churn: ${item.company}`, 160);
    case "human_assisted_stalled":
      return truncateField(`Unblock stalled deployment: ${item.company}`, 160);
    case "human_assisted_ready_not_started":
      return truncateField(`Close deployment-start gap: ${item.company}`, 160);
  }
  const exhaustive: never = item.signal;
  return exhaustive;
}

function policyRecommendationBody(item: PolicyEvaluationDeal): string {
  const amount = formatUsd(item.amount);
  switch (item.signal) {
    case "self_serve_expanded":
      return [
        `${item.company} routed self-serve at ${amount} and later expanded by ${formatUsd(item.arrDeltaUsd ?? 0)}.`,
        "Review whether similar source-channel and ARR patterns should remain self-serve, get earlier expansion enablement, or move to human-assisted review.",
      ].join(" ");
    case "human_assisted_churned":
      return [
        `${item.company} was human-assisted at ${amount} and later recorded churn.`,
        "Review whether the routing score, qualification notes, deployment readiness, or handoff expectations missed an early risk signal.",
      ].join(" ");
    case "human_assisted_ready_not_started":
      return [
        `${item.company} is marked deployment-ready at ${amount}, but no deployment_start outcome has been recorded.`,
        "Review whether the deployment-start handoff needs a clearer owner, SLA, or automatic follow-up.",
      ].join(" ");
    case "human_assisted_stalled":
      return [
        `${item.company} closed won at ${amount}, but deployment has not started after the readiness SLA.`,
        "Review whether the human-assisted route needs stronger pre-close readiness requirements or a deployment blocker escalation.",
      ].join(" ");
  }
  const exhaustive: never = item.signal;
  return exhaustive;
}

function policyRecommendationRationale(item: PolicyEvaluationDeal): string {
  return truncateField(
    `Policy signal ${item.signal} observed at ${item.signalObservedAt}: ${item.reason}`,
    1000,
  );
}

// One assigned work item gets one draft suggestion. Assignment churn should not
// fork agent work. Reopening a closed role-queue item creates a fresh work item
// row, so reopened work receives a fresh draft through the new id. The derived
// id is stored on the row at creation/backfill time so future formula changes
// do not rewrite existing open work.
function workItemSuggestionSourceEventId(
  item: Pick<WorkItemRecord, "id">,
): string {
  return stableUuidV4(
    canonicalJson({
      kind: "work_item_suggestion",
      workItemId: item.id,
    }),
  );
}

function workItemSuggestionKind(item: WorkItemRecord): AgentSuggestionKind {
  switch (item.queue) {
    case "ae_attention":
    case "deployment_readiness":
      return "handoff_summary";
    case "finance_review":
    case "legal_review":
    case "growth_attribution":
      return "missing_field_question";
  }
  const exhaustive: never = item.queue;
  throw new Error(`unhandled work item queue: ${String(exhaustive)}`);
}

function workItemSuggestionTitle(item: WorkItemRecord): string {
  switch (item.queue) {
    case "ae_attention":
      return truncateField(`Draft AE next step: ${item.title}`, 160);
    case "finance_review":
      return truncateField(`Draft finance review request: ${item.title}`, 160);
    case "legal_review":
      return truncateField(`Draft legal review request: ${item.title}`, 160);
    case "deployment_readiness":
      return truncateField(`Draft deployment handoff: ${item.title}`, 160);
    case "growth_attribution":
      return truncateField(`Draft growth follow-up: ${item.title}`, 160);
  }
  const exhaustive: never = item.queue;
  throw new Error(`unhandled work item queue: ${String(exhaustive)}`);
}

function formatWorkItemDueAt(dueAt: string): string | null {
  const date = new Date(dueAt);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== dueAt) {
    return null;
  }
  const iso = date.toISOString();
  // Display-only copy rounded to minutes for operators; the canonical dueAt
  // remains on the work item.
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function workItemSuggestionBody(item: WorkItemRecord): string {
  const formattedDue = item.dueAt ? formatWorkItemDueAt(item.dueAt) : null;
  const due = formattedDue ? ` Due ${formattedDue}.` : "";
  switch (item.queue) {
    case "ae_attention":
      return truncateField(
        `Prepare a concise owner follow-up. Context: ${item.description}.${due}`,
        4000,
      );
    case "finance_review":
      return truncateField(
        `Ask finance to review pricing approval before close. Context: ${item.description}.${due}`,
        4000,
      );
    case "legal_review":
      return truncateField(
        `Ask legal to review regulated-deal risk and required contract/privacy steps. Context: ${item.description}.${due}`,
        4000,
      );
    case "deployment_readiness":
      return truncateField(
        `Summarize the deployment readiness gap and the next deployment-ops action. Context: ${item.description}.${due}`,
        4000,
      );
    case "growth_attribution":
      return truncateField(
        `Summarize the growth attribution follow-up for this routed deal. Context: ${item.description}.${due}`,
        4000,
      );
  }
  const exhaustive: never = item.queue;
  throw new Error(`unhandled work item queue: ${String(exhaustive)}`);
}

function workItemSuggestionRationale(item: WorkItemRecord): string {
  return truncateField(
    `Assigned work item ${item.id} (${item.queue}) is still open; draft evidence uses the work-item opening snapshot and no workflow action is executed automatically.`,
    1000,
  );
}

function parseAgentSuggestionSource(value: unknown): "local_agent" {
  if (value !== LOCAL_AGENT_SUGGESTION_SOURCE) {
    throw new Error(`stored agent suggestion has invalid source: ${String(value)}`);
  }
  return value;
}

function expandedArrDelta(outcomes: OutcomeEventRecord[]): number {
  return outcomes.reduce(
    (sum, outcome) =>
      outcome.outcome === "expanded" ? sum + outcome.arrDeltaUsd : sum,
    0,
  );
}

function lastOutcomeAt(outcomes: OutcomeEventRecord[]): string | null {
  return outcomes.reduce<string | null>(
    (latest, outcome) =>
      latest === null || outcome.occurredAt > latest ? outcome.occurredAt : latest,
    null,
  );
}

function roleQueueItem(
  deal: RoutedDeal,
  queue: RoleQueueItem["queue"],
  priority: RoleQueuePriority,
  reason: string,
  status: RoleQueueStatus,
  updatedAt: string,
): RoleQueueItem {
  return {
    queue,
    dealId: deal.id,
    company: deal.company,
    amount: deal.dealUSD,
    routeKind: deal.route.kind,
    sourceChannel: deal.sourceChannel,
    salesOwner: humanOwner(deal),
    priority,
    reason,
    status,
    updatedAt,
  };
}

function isNotifiableReadiness(
  readiness: DeploymentReadiness,
): readiness is NotifiableReadiness {
  return readiness === "pending" || readiness === "ready" || readiness === "blocked";
}

function readinessFromFingerprint(
  dealId: string,
  fingerprint: string,
): {
  previousReadiness: PreviousDeploymentReadiness;
  readiness: NotifiableReadiness;
} | null {
  const prefix = `readiness:${dealId}:`;
  if (!fingerprint.startsWith(prefix)) return null;
  const [previous, next, extra] = fingerprint.slice(prefix.length).split(":");
  if (extra !== undefined) return null;
  const previousReadiness =
    previous === "none" ||
    previous === "not_required" ||
    previous === "pending" ||
    previous === "ready" ||
    previous === "blocked"
      ? previous
      : null;
  const readiness =
    next === "pending" || next === "ready" || next === "blocked" ? next : null;
  if (!previousReadiness || !readiness) return null;
  return { previousReadiness, readiness };
}

function notificationErrorClass(error: string | null): string {
  if (!error) return "slack_delivery_failed";
  const lower = error.toLowerCase();
  if (lower.includes("rate") || lower.includes("429")) return "slack_rate_limited";
  if (lower.includes("channel")) return "slack_channel_error";
  if (lower.includes("auth") || lower.includes("token")) return "slack_auth_error";
  return "slack_delivery_failed";
}

function expectedRedPathFromMeta(metaJson: string | null): boolean {
  if (!metaJson) return false;
  try {
    const meta = JSON.parse(metaJson) as { expectedRedPath?: unknown };
    return meta.expectedRedPath === true;
  } catch {
    return false;
  }
}

function tieResolutionDriftFromMeta(metaJson: string | null): boolean | null {
  if (!metaJson) return null;
  try {
    const meta = JSON.parse(metaJson) as { tieResolutionDrift?: unknown };
    return typeof meta.tieResolutionDrift === "boolean"
      ? meta.tieResolutionDrift
      : null;
  } catch {
    return null;
  }
}

function recentTerminalTieResolution(
  projectedViaTerminalTie: boolean,
  terminalTieResolvedAt: string | null,
  referenceAt: string,
): boolean {
  if (!projectedViaTerminalTie || terminalTieResolvedAt === null) return false;
  const deltaMs = Date.parse(referenceAt) - Date.parse(terminalTieResolvedAt);
  return (
    Number.isFinite(deltaMs) &&
    deltaMs >= 0 &&
    deltaMs <= TERMINAL_TIE_WINDOW_MS
  );
}

const SCHEMA: string[] = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA foreign_keys = ON",
  "PRAGMA busy_timeout = 5000",
  `CREATE TABLE IF NOT EXISTS deals (
     id          TEXT PRIMARY KEY,
     stage       TEXT NOT NULL,
     payload     TEXT,
     quarantine  TEXT,
     route_kind  TEXT,
     finance_flag TEXT,
     legal_flag TEXT,
     deal_usd    REAL,
     quarantine_code TEXT,
     sink_mode   TEXT,
     sink_status TEXT,
     latency_ms  INTEGER,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS events (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     deal_id   TEXT NOT NULL,
     ts        TEXT NOT NULL,
     from_st   TEXT NOT NULL,
     to_st     TEXT NOT NULL,
     detail    TEXT NOT NULL,
     meta      TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS external_event_keys (
     key         TEXT PRIMARY KEY,
     system      TEXT NOT NULL,
     recorded_at TEXT NOT NULL,
     notify_status TEXT NOT NULL DEFAULT 'pending',
     notify_leases INTEGER NOT NULL DEFAULT 0,
     notify_pending_at TEXT,
     notified_at TEXT,
     notify_error TEXT,
     scope TEXT NOT NULL DEFAULT 'source_event',
     payload_hash TEXT,
     CHECK (
       notify_status IN (
         'pending',
         'ok',
         'failed',
         'suppressed',
         'superseded_by_new_readiness',
         'max_attempts_exceeded',
         'fallback_max_attempts_exceeded'
       )
     ),
     CHECK (
       scope IN (
         'source_event',
         'stage_notification',
         'readiness_fallback',
         'commercial_terminal_drift'
       )
     )
   )`,
  `CREATE TABLE IF NOT EXISTS commercial_states (
     deal_id TEXT PRIMARY KEY,
     commercial_state TEXT NOT NULL,
     source TEXT NOT NULL,
     source_event_id TEXT NOT NULL,
     source_payload_hash TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     state_entered_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     terminal_projected_at TEXT,
     projected_via_terminal_tie INTEGER NOT NULL DEFAULT 0,
     terminal_tie_occurred_at TEXT,
     terminal_tie_resolved_at TEXT,
     terminal_tie_winner_state TEXT,
     terminal_tie_loser_state TEXT,
     CHECK (
       commercial_state IN (
         'open',
         'proposal_sent',
         'negotiating',
         'closed_won',
         'closed_lost'
       )
     ),
     CHECK (projected_via_terminal_tie IN (0, 1)),
     CHECK (
       commercial_state IN ('closed_won', 'closed_lost') OR
       terminal_projected_at IS NULL
     ),
     CHECK (
       commercial_state NOT IN ('closed_won', 'closed_lost') OR
       terminal_projected_at IS NOT NULL
     ),
     CHECK (
       projected_via_terminal_tie = 0 OR
       commercial_state IN ('closed_won', 'closed_lost')
     ),
     CHECK (
       projected_via_terminal_tie = 0 OR
       (
         terminal_tie_occurred_at IS NOT NULL AND
         terminal_tie_resolved_at IS NOT NULL AND
         terminal_tie_winner_state IN ('closed_won', 'closed_lost') AND
         terminal_tie_loser_state IN ('closed_won', 'closed_lost') AND
         terminal_tie_winner_state != terminal_tie_loser_state
       )
     ),
     CHECK (
       projected_via_terminal_tie = 0 OR
       commercial_state = terminal_tie_winner_state
     ),
     CHECK (
       projected_via_terminal_tie = 1 OR
       (
         terminal_tie_occurred_at IS NULL AND
         terminal_tie_resolved_at IS NULL AND
         terminal_tie_winner_state IS NULL AND
         terminal_tie_loser_state IS NULL
       )
     )
   )`,
  `CREATE TABLE IF NOT EXISTS deployment_facts (
     deal_id TEXT PRIMARY KEY,
     use_case_clear INTEGER NOT NULL,
     integrations_known INTEGER NOT NULL,
     data_ready INTEGER NOT NULL,
     source TEXT NOT NULL,
     source_event_id TEXT NOT NULL,
     source_payload_hash TEXT NOT NULL,
     operator TEXT NOT NULL,
     operator_source TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     CHECK (use_case_clear IN (0, 1)),
     CHECK (integrations_known IN (0, 1)),
     CHECK (data_ready IN (0, 1))
   )`,
  `CREATE TABLE IF NOT EXISTS deployment_facts_rejections (
     id TEXT PRIMARY KEY,
     deal_id TEXT NOT NULL,
     source TEXT NOT NULL,
     source_event_id TEXT NOT NULL,
     source_payload_hash TEXT NOT NULL,
     rejection_kind TEXT NOT NULL CHECK (
       rejection_kind IN ('age', 'ordering', 'tie_conflict')
     ),
     incoming_occurred_at TEXT NOT NULL,
     current_occurred_at TEXT,
     operator TEXT NOT NULL,
     operator_source TEXT NOT NULL,
     use_case_clear INTEGER NOT NULL,
     integrations_known INTEGER NOT NULL,
     data_ready INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (source, source_event_id),
     CHECK (use_case_clear IN (0, 1)),
     CHECK (integrations_known IN (0, 1)),
     CHECK (data_ready IN (0, 1)),
     CHECK (rejection_kind = 'age' OR current_occurred_at IS NOT NULL)
   )`,
  `CREATE TABLE IF NOT EXISTS outcome_events (
     id TEXT PRIMARY KEY,
     deal_id TEXT NOT NULL,
     source TEXT NOT NULL,
     source_event_id TEXT NOT NULL,
     source_payload_hash TEXT NOT NULL,
     outcome TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     operator TEXT NOT NULL,
     operator_source TEXT NOT NULL,
     arr_delta_usd INTEGER,
     reason_category TEXT,
     created_at TEXT NOT NULL,
     UNIQUE (source, source_event_id),
     CHECK (
       outcome IN (
         'deployment_started',
         'deployed',
         'landed',
         'expanded',
         'churned'
       )
     ),
     CHECK (source IN ('local')),
     CHECK (operator_source IN ('self_reported')),
     CHECK (
       (outcome = 'expanded' AND arr_delta_usd IS NOT NULL AND arr_delta_usd > 0) OR
       (outcome != 'expanded' AND arr_delta_usd IS NULL)
     ),
     CHECK (
       reason_category IS NULL OR
       reason_category IN (
         'customer_ready',
         'technical_blocker_resolved',
         'scope_expanded',
         'budget_lost',
         'no_show',
         'other'
       )
     )
   )`,
  `CREATE TABLE IF NOT EXISTS outcome_rejections (
     id TEXT PRIMARY KEY,
     deal_id TEXT NOT NULL,
     source TEXT NOT NULL,
     source_event_id TEXT NOT NULL,
     source_payload_hash TEXT NOT NULL,
     rejection_kind TEXT NOT NULL,
     outcome TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (source, source_event_id),
     CHECK (
       rejection_kind IN (
         'duplicate_semantic_outcome',
         'missing_prior_outcome',
         'post_churn_outcome',
         'invalid_arr_delta'
       )
     ),
     CHECK (source IN ('local')),
     CHECK (
       outcome IN (
         'deployment_started',
         'deployed',
         'landed',
         'expanded',
         'churned'
       )
     )
   )`,
  `CREATE TABLE IF NOT EXISTS provider_observations (
     id TEXT PRIMARY KEY,
     subject_type TEXT NOT NULL,
     subject_key TEXT NOT NULL,
     provider TEXT NOT NULL,
     source_event_id TEXT NOT NULL,
     source_payload_hash TEXT NOT NULL,
     observed_at TEXT NOT NULL,
     expires_at TEXT,
     confidence REAL NOT NULL,
     raw_payload_json TEXT NOT NULL,
     normalized_payload_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (provider, source_event_id),
     CHECK (subject_type IN (${PROVIDER_OBSERVATION_SUBJECT_TYPE_SQL})),
     CHECK (provider IN (${PROVIDER_OBSERVATION_PROVIDER_SQL})),
     CHECK (confidence >= 0 AND confidence <= 1)
   )`,
  // Projection is company-only for now. Contact/deal observations remain in
  // provider_observations until their fact schemas are explicit.
  `CREATE TABLE IF NOT EXISTS enriched_subject_facts (
     subject_type TEXT NOT NULL,
     subject_key TEXT NOT NULL,
     employees INTEGER NOT NULL,
     industry TEXT NOT NULL,
     tech_signals_json TEXT NOT NULL,
     regulated INTEGER NOT NULL,
     confidence REAL NOT NULL,
     source_provider TEXT NOT NULL,
     source_observation_id TEXT NOT NULL,
     observed_at TEXT NOT NULL,
     expires_at TEXT,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (subject_type, subject_key),
     CHECK (subject_type IN ('company')),
     CHECK (source_provider IN (${PROVIDER_OBSERVATION_PROVIDER_SQL})),
     CHECK (employees >= 0),
     CHECK (regulated IN (0, 1)),
     CHECK (confidence >= 0 AND confidence <= 1),
     CHECK (json_valid(tech_signals_json))
   )`,
  `CREATE TABLE IF NOT EXISTS agent_suggestions (
     id TEXT PRIMARY KEY,
     deal_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'proposed',
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     rationale TEXT NOT NULL,
     source TEXT NOT NULL,
     source_event_id TEXT NOT NULL,
     source_payload_hash TEXT NOT NULL,
     created_by TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     created_at TEXT NOT NULL,
     decided_at TEXT,
     decided_by TEXT,
     decision_source_event_id TEXT,
     decision_payload_hash TEXT,
     decision_reason TEXT,
     UNIQUE (source, source_event_id),
     UNIQUE (source, decision_source_event_id),
     CHECK (
       kind IN (
         'handoff_summary',
         'missing_field_question',
         'stale_deal_nudge',
         'policy_change_recommendation'
       )
     ),
     CHECK (status IN ('proposed', 'accepted', 'rejected')),
     CHECK (source IN ('local_agent')),
     CHECK (
       status = 'proposed' OR
       (
         decided_at IS NOT NULL AND
         decided_by IS NOT NULL AND
         decision_source_event_id IS NOT NULL AND
         decision_payload_hash IS NOT NULL AND
         decision_reason IS NOT NULL
       )
     ),
     CHECK (
       status != 'proposed' OR
       (
         decided_at IS NULL AND
         decided_by IS NULL AND
         decision_source_event_id IS NULL AND
         decision_payload_hash IS NULL AND
         decision_reason IS NULL
       )
     ),
     CHECK (decided_at IS NULL OR decided_at >= occurred_at)
   )`,
  `CREATE TABLE IF NOT EXISTS work_items (
     id TEXT PRIMARY KEY,
     source_kind TEXT NOT NULL,
     source_key TEXT NOT NULL,
     deal_id TEXT NOT NULL,
     queue TEXT NOT NULL,
     status TEXT NOT NULL,
     priority TEXT NOT NULL,
     owner TEXT NOT NULL,
     title TEXT NOT NULL,
     description TEXT NOT NULL,
     due_at TEXT,
     agent_suggestion_source_event_id TEXT,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     resolved_at TEXT,
     resolved_by TEXT,
     resolution_reason TEXT,
     CHECK (source_kind IN ('role_queue')),
     CHECK (queue IN (${ROLE_QUEUE_KIND_SQL})),
     CHECK (status IN ('assigned', 'resolved', 'waived')),
     CHECK (priority IN ('high', 'medium', 'low')),
     CHECK (
       status = 'assigned' OR
       (
         resolved_at IS NOT NULL AND
         resolved_by IS NOT NULL AND
         resolution_reason IS NOT NULL
       )
     ),
     CHECK (
       status != 'assigned' OR
       (
         resolved_at IS NULL AND
         resolved_by IS NULL AND
         resolution_reason IS NULL
       )
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_assigned_source
     ON work_items(source_key)
     WHERE status = 'assigned'`,
  `CREATE TABLE IF NOT EXISTS work_item_events (
     id TEXT PRIMARY KEY,
     work_item_id TEXT NOT NULL,
     action TEXT NOT NULL,
     source_event_id TEXT NOT NULL,
     event_key TEXT NOT NULL UNIQUE,
     source_payload_hash TEXT NOT NULL,
     actor TEXT NOT NULL,
     owner TEXT,
     reason TEXT NOT NULL,
     occurred_at TEXT NOT NULL,
     created_at TEXT NOT NULL,
     CHECK (action IN ('opened', 'open_attempted', 'assign', 'resolve', 'waive', 'already_closed', 'superseded', 'invalid_action'))
   )`,
  `CREATE TABLE IF NOT EXISTS policy_recommendation_runs (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL,
     created_by TEXT NOT NULL,
     evaluated_at TEXT NOT NULL,
     limit_count INTEGER NOT NULL,
     attempted INTEGER NOT NULL,
     recorded INTEGER NOT NULL,
     duplicate INTEGER NOT NULL,
     idempotency_conflict INTEGER NOT NULL,
     skipped INTEGER NOT NULL,
     status_counts_json TEXT NOT NULL,
     results_json TEXT NOT NULL,
     created_at TEXT NOT NULL,
     CHECK (status IN (
       'recorded',
       'duplicate',
       'idempotency_conflict',
       'all_skipped',
       'no_signals'
     )),
     CHECK (limit_count >= 1),
     CHECK (attempted >= 0),
     CHECK (recorded >= 0),
     CHECK (duplicate >= 0),
     CHECK (idempotency_conflict >= 0),
     CHECK (skipped >= 0)
   )`,
  `CREATE TABLE IF NOT EXISTS deployment_readiness (
     deal_id TEXT PRIMARY KEY,
     readiness TEXT NOT NULL,
     blocker_code TEXT,
     secondary_blocker_codes TEXT,
     blocker_entered_at TEXT,
     reason TEXT,
     state_entered_at TEXT NOT NULL,
     last_notified_fingerprint TEXT,
     notify_status TEXT,
     notify_pending_at TEXT,
     notify_attempts INTEGER NOT NULL DEFAULT 0,
     notify_error TEXT,
     updated_at TEXT NOT NULL,
     CHECK (readiness IN ('not_required', 'pending', 'ready', 'blocked')),
     CHECK (
       blocker_code IS NULL OR
       blocker_code IN (
         'deployment_use_case_unclear',
         'deployment_integration_unknown',
         'deployment_data_unavailable'
       )
     ),
     CHECK (readiness != 'blocked' OR blocker_code IS NOT NULL),
     CHECK (readiness = 'blocked' OR blocker_code IS NULL),
     CHECK (readiness != 'blocked' OR blocker_entered_at IS NOT NULL),
     CHECK (readiness = 'blocked' OR blocker_entered_at IS NULL),
     CHECK (readiness = 'blocked' OR secondary_blocker_codes IS NULL),
     CHECK (secondary_blocker_codes IS NULL OR secondary_blocker_codes != '[]'),
     CHECK (
       notify_status IS NULL OR
       notify_status IN ('pending', 'ok', 'failed', 'max_attempts_exceeded')
     ),
     CHECK (
       notify_status IS NULL OR
       notify_status != 'pending' OR
       notify_pending_at IS NOT NULL
     ),
     CHECK (
       notify_status IS NULL OR
       notify_status != 'max_attempts_exceeded' OR
       last_notified_fingerprint IS NOT NULL
     )
   )`,
  `CREATE TABLE IF NOT EXISTS integration_config (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     key TEXT NOT NULL,
     activation_id TEXT NOT NULL,
     value_json TEXT NOT NULL,
     value_hash TEXT NOT NULL,
     loaded_at TEXT NOT NULL,
     UNIQUE (key, activation_id)
   )`,
  `CREATE TABLE IF NOT EXISTS external_event_observations (
     source TEXT NOT NULL,
     source_event_id TEXT NOT NULL,
     observation_code TEXT NOT NULL,
     projected INTEGER NOT NULL DEFAULT 0,
     payload_hash TEXT NOT NULL,
     config_hash TEXT NOT NULL,
     mapped_commercial_state TEXT,
     router_deal_id TEXT,
     external_deal_id TEXT,
     stage_id TEXT,
     occurred_at TEXT,
     reason TEXT,
     meta_json TEXT,
     created_at TEXT NOT NULL,
     PRIMARY KEY (source, source_event_id),
     CHECK (
       observation_code IN (
         'invalid_timestamp',
         'not_routed',
         'unmapped_stage',
         'ignored_stage',
         'stale_stage_observation',
         'same_state_newer',
         'same_state_tie',
         'terminal_tie_conflict',
         'commercial_stage_tie_resolved',
         'commercial_stage_tie_ignored',
         'commercial_regression_unsupported',
         'terminal_drift_unsupported'
       )
     ),
     CHECK (projected IN (0, 1)),
     CHECK (
       projected = 0 OR
       observation_code IN (
         'terminal_tie_conflict',
         'commercial_stage_tie_resolved'
       )
     )
   )`,
  `CREATE TABLE IF NOT EXISTS idempotency_violations (
     id TEXT PRIMARY KEY,
     source TEXT NOT NULL,
     source_event_id TEXT NOT NULL,
     scope TEXT NOT NULL,
     existing_payload_hash TEXT NOT NULL,
     incoming_payload_hash TEXT NOT NULL,
     reason TEXT NOT NULL,
     created_at TEXT NOT NULL,
     UNIQUE (source, source_event_id, scope),
     CHECK (
       scope IN (
         'commercial_state',
         'deployment_facts',
         'outcome',
         'provider_observation',
         'agent_suggestion',
         'agent_suggestion_decision'
       ) OR
       scope LIKE 'external_event_observation:%'
     )
   )`,
  "CREATE INDEX IF NOT EXISTS idx_events_deal ON events(deal_id)",
  "CREATE INDEX IF NOT EXISTS idx_events_deal_id ON events(deal_id, id DESC)",
  `CREATE INDEX IF NOT EXISTS idx_events_commercial_state_projection
   ON events (
     json_extract(meta, '$.kind'),
     json_extract(meta, '$.commercialState'),
     json_extract(meta, '$.projected'),
     ts,
     id
   )
   WHERE meta IS NOT NULL AND json_valid(meta)`,
  `CREATE INDEX IF NOT EXISTS idx_events_commercial_state_guard
   ON events (
     deal_id,
     json_extract(meta, '$.kind'),
     json_extract(meta, '$.source'),
     json_extract(meta, '$.projected')
   )
   WHERE meta IS NOT NULL AND json_valid(meta)`,
  "CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage)",
  "CREATE INDEX IF NOT EXISTS idx_commercial_states_state ON commercial_states(commercial_state)",
  "CREATE INDEX IF NOT EXISTS idx_deployment_readiness_status ON deployment_readiness(readiness)",
  "CREATE INDEX IF NOT EXISTS idx_external_event_observations_code ON external_event_observations(observation_code)",
  "CREATE INDEX IF NOT EXISTS idx_outcome_events_deal ON outcome_events(deal_id, occurred_at)",
  "CREATE INDEX IF NOT EXISTS idx_outcome_events_deal_outcome ON outcome_events(deal_id, outcome, occurred_at)",
  "CREATE INDEX IF NOT EXISTS idx_outcome_events_outcome ON outcome_events(outcome, occurred_at)",
  "CREATE INDEX IF NOT EXISTS idx_outcome_rejections_kind ON outcome_rejections(rejection_kind, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_outcome_rejections_deal ON outcome_rejections(deal_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_provider_observations_subject ON provider_observations(subject_type, subject_key, observed_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_provider_observations_provider ON provider_observations(provider, observed_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_agent_suggestions_status ON agent_suggestions(status, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_agent_suggestions_deal ON agent_suggestions(deal_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_policy_recommendation_runs_created ON policy_recommendation_runs(created_at DESC)",
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)] ?? 0;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function hoursBetween(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return Math.round(((end - start) / 3_600_000) * 100) / 100;
}

function assertCanonicalIsoUtc(value: string, field: string): void {
  if (!CANONICAL_ISO_UTC.test(value)) {
    throw new Error(`${field} must be canonical UTC ISO timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${field} must be canonical UTC ISO timestamp`);
  }
}

function nonEmptyLabel(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  if (trimmed !== value) {
    throw new Error(`${field} must not have surrounding whitespace`);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableUuidV4(seed: string): string {
  const chars = sha256Hex(seed).slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = ((Number.parseInt(chars[16] ?? "0", 16) & 0x3) | 0x8).toString(
    16,
  );
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pipelineStage(value: string): Stage | null {
  return (PIPELINE_STAGES as readonly string[]).includes(value)
    ? (value as Stage)
    : null;
}

function agentSuggestionRunStatus(counts: {
  recorded: number;
  duplicate: number;
  idempotencyConflict: number;
  skipped: number;
}): AgentSuggestionRunStatus {
  // Idempotency conflicts are correctness incidents, so they dominate even
  // when the same run also recorded useful suggestions; callers still receive
  // the full count breakdown for operator triage.
  if (counts.idempotencyConflict > 0) return "idempotency_conflict";
  if (counts.recorded > 0) return "recorded";
  if (counts.duplicate > 0) return "duplicate";
  if (counts.skipped > 0) return "all_skipped";
  return "no_signals";
}

function emptyAgentSuggestionWriteStatusCounts(): AgentSuggestionWriteStatusCounts {
  return Object.fromEntries(
    LOCAL_AGENT_SUGGESTION_WRITE_STATUSES.map((status) => [status, 0]),
  ) as AgentSuggestionWriteStatusCounts;
}

function policyRecommendationLimit(value: number | undefined): number {
  const raw = value ?? DEFAULT_POLICY_RECOMMENDATION_LIMIT;
  if (!Number.isFinite(raw)) {
    throw new Error("policy recommendation limit must be finite");
  }
  return Math.max(
    1,
    Math.min(Math.trunc(raw), MAX_POLICY_RECOMMENDATION_LIMIT),
  );
}

function workItemSuggestionLimit(value: number | undefined): number {
  const raw = value ?? DEFAULT_WORK_ITEM_SUGGESTION_LIMIT;
  if (!Number.isFinite(raw)) {
    throw new Error("work item suggestion limit must be finite");
  }
  return Math.max(
    1,
    Math.min(Math.trunc(raw), MAX_WORK_ITEM_SUGGESTION_LIMIT),
  );
}

function policyRecommendationRunPageLimit(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("policy recommendation run page limit must be finite");
  }
  return Math.max(
    0,
    Math.min(Math.trunc(value), MAX_POLICY_RECOMMENDATION_RUN_PAGE_LIMIT),
  );
}

function truncateField(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
}

function formatUsd(value: number): string {
  return "$" + Math.round(value).toLocaleString("en-US");
}

const DEFAULT_INTEGRATION_CONFIG_HASH = sha256Hex("integration_config:unrecorded");

function deploymentBlockerFromValue(value: unknown): DeploymentBlocker {
  if (
    typeof value === "string" &&
    (DEPLOYMENT_BLOCKERS as readonly string[]).includes(value)
  ) {
    return value as DeploymentBlocker;
  }
  throw new Error(`invalid deployment blocker in stored readiness row: ${value}`);
}

function parseSecondaryBlockerCodes(
  value: string | null,
): DeploymentBlocker[] | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("stored secondary blocker codes must be a non-empty array");
  }
  return parsed.map(deploymentBlockerFromValue);
}

function parseEnrichmentPayload(value: unknown): Enrichment {
  if (!value || typeof value !== "object") {
    throw new Error("enrichment payload must be an object");
  }
  const record = value as Record<string, unknown>;
  const employees = record.employees;
  const industry = record.industry;
  const techSignals = record.techSignals;
  const regulated = record.regulated;
  const confidence = record.confidence;
  if (
    typeof employees !== "number" ||
    !Number.isInteger(employees) ||
    employees < 0
  ) {
    throw new Error("enrichment employees must be a non-negative integer");
  }
  if (typeof industry !== "string" || industry.trim().length === 0) {
    throw new Error("enrichment industry must be non-empty");
  }
  if (
    !Array.isArray(techSignals) ||
    !techSignals.every(
      (signal) => typeof signal === "string" && signal.trim().length > 0,
    )
  ) {
    throw new Error("enrichment techSignals must be non-empty strings");
  }
  if (typeof regulated !== "boolean") {
    throw new Error("enrichment regulated must be boolean");
  }
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new Error("enrichment confidence must be between 0 and 1");
  }
  return {
    employees,
    industry,
    techSignals: [...techSignals].sort(),
    regulated,
    confidence,
  };
}

function providerObservationId(
  provider: ProviderObservationProvider,
  sourceEventId: string,
): string {
  return `${PROVIDER_OBSERVATION_ID_PREFIX}-${sha256Hex(
    canonicalJson(["provider_observation", provider, sourceEventId]),
  ).slice(0, 32)}`;
}

function assertJsonPayload(value: unknown, field: string): string {
  const json = canonicalJson(value);
  if (json === undefined) {
    throw new Error(`${field} must be JSON-serializable`);
  }
  return json;
}

function providerObservationPayloadHash(input: ProviderObservationInput): string {
  return sha256Hex(
    canonicalJson({
      subjectType: input.subjectType,
      subjectKey: input.subjectKey,
      provider: input.provider,
      sourceEventId: input.sourceEventId,
      confidence: input.confidence,
      rawPayload: input.rawPayload,
      normalizedPayload: input.normalizedPayload,
    }),
  );
}

function companyProviderObservationInput(
  input: ProviderObservationInput,
): ProviderObservationInput & { subjectType: "company" } {
  if (input.subjectType !== "company") {
    throw new Error("only company provider observations can project enrichment facts");
  }
  return {
    ...input,
    subjectType: input.subjectType,
  };
}

function enrichmentFactFreshnessStatus(
  expiresAt: string | null,
  now: string,
): "fresh" | "stale" {
  if (expiresAt === null) return "fresh";
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) {
    throw new Error("enrichment fact freshness timestamps must be valid dates");
  }
  // Expiration is a closed boundary: at the exact expiry instant, callers should
  // stop trusting the fact without a fresh observation.
  return expiresAtMs <= nowMs ? "stale" : "fresh";
}

function expiryExtends(
  incoming: string | null,
  existing: string | null,
): boolean {
  if (incoming === existing) return false;
  if (incoming === null) return true;
  if (existing === null) return false;
  return incoming > existing;
}

function factFreshness(
  readiness: DeploymentReadiness,
  factsOccurredAt: string | null,
  nowMs: number,
): Pick<
  DeploymentReadinessState,
  "factsStatus" | "factsFresh" | "factsStaleAt"
> {
  if (readiness === "not_required") {
    return {
      factsStatus: "not_applicable",
      factsFresh: null,
      factsStaleAt: null,
    };
  }
  if (factsOccurredAt === null) {
    return { factsStatus: "missing", factsFresh: false, factsStaleAt: null };
  }

  const occurredAtMs = Date.parse(factsOccurredAt);
  if (Number.isNaN(occurredAtMs)) {
    return { factsStatus: "stale", factsFresh: false, factsStaleAt: null };
  }
  const staleAtMs = occurredAtMs + DEPLOYMENT_FACT_MAX_AGE_DAYS * DAY_MS;
  const factsFresh = nowMs < staleAtMs;
  return {
    factsStatus: factsFresh ? "fresh" : "stale",
    factsFresh,
    factsStaleAt: new Date(staleAtMs).toISOString(),
  };
}

/**
 * The single SQLite data-access layer for the router.
 *
 * This is one large, cohesive class on purpose. Every domain below shares one
 * connection and one `transactionDepth` scope, so a write that spans (say)
 * commercial state and a deployment-readiness re-derivation commits or rolls
 * back atomically. Splitting the class into per-domain modules would trade an
 * unfamiliarly large file for cross-module transaction coupling that is harder
 * to reason about, not easier — the cohesion is the point. The class is
 * organized by domain in source order. Each `// ─── … ───` banner below heads
 * one group; search for the representative method to jump in:
 *
 *   schema, migrations, private helpers ......... constructor
 *   write path — routed/quarantine + event log .. upsertRouted
 *   HubSpot stage-change webhooks ............... recordExternalStageChange
 *   commercial lifecycle state .................. commercialState
 *   enrichment observations + projected facts ... recordEnrichmentObservation
 *   deployment facts + readiness inputs ......... deploymentFacts
 *   post-sale outcomes, agent + policy-run reads  outcomeEvents
 *   operator work-item queue .................... workItems
 *   readiness derivation + notification retries . deriveDeploymentReadiness
 *   read & projection surface ................... events
 *   policy evaluation + recommendation writes ... policyEvaluation
 *   deployment readiness projection ............. deploymentReadinessRecords
 *   aggregate metrics ........................... metrics
 *   integrity self-check + lifecycle ............ integrity
 */
export class Store {
  // ─── Schema, migrations & private setup ───────────────────────────────────
  private db: DatabaseSyncT;
  private transactionDepth = 0;

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    for (const stmt of SCHEMA) this.db.prepare(stmt).run();
    this.ensureColumn("events", "meta", "TEXT");
    this.ensureColumn("deals", "route_kind", "TEXT");
    this.ensureColumn("deals", "finance_flag", "TEXT");
    this.ensureColumn("deals", "legal_flag", "TEXT");
    this.ensureColumn("deals", "deal_usd", "REAL");
    this.ensureColumn("deals", "quarantine_code", "TEXT");
    this.ensureColumn("deals", "sink_mode", "TEXT");
    this.ensureColumn("deals", "sink_status", "TEXT");
    this.ensureColumn("deals", "external_system", "TEXT");
    this.ensureColumn("deals", "external_id", "TEXT");
    this.ensureColumn("deals", "external_stage_id", "TEXT");
    this.ensureColumn("deals", "external_stage_label", "TEXT");
    this.ensureColumn("deals", "external_stage_updated_at", "TEXT");
    this.ensureColumn(
      "external_event_keys",
      "notify_status",
      // Existing event-key rows predate stage notifications, so the ALTER path
      // defaults them to terminal-ok. Fresh stage rows still start pending in
      // SCHEMA and are explicitly leased before Slack is posted.
      "TEXT NOT NULL DEFAULT 'ok'",
    );
    this.ensureColumn(
      "external_event_keys",
      "notify_leases",
      "INTEGER NOT NULL DEFAULT 0",
    );
    this.ensureColumn("external_event_keys", "notify_pending_at", "TEXT");
    this.ensureColumn("external_event_keys", "notified_at", "TEXT");
    this.ensureColumn("external_event_keys", "notify_error", "TEXT");
    this.ensureColumn(
      "external_event_keys",
      "scope",
      "TEXT NOT NULL DEFAULT 'source_event'",
    );
    this.ensureColumn("external_event_keys", "payload_hash", "TEXT");
    this.ensureExternalEventKeyGuards();
    this.ensureColumn("work_items", "agent_suggestion_source_event_id", "TEXT");
    this.backfillWorkItemSuggestionSourceEventIds();
    this.ensureWorkItemSuggestionSourceIndex();
    this.ensureIdempotencyViolationScopes();
    this.ensurePolicyRecommendationRunStatuses();
    this.backfillExternalNotificationLeases();
    this.backfillDerivedColumns();
    this.backfillSinkColumns();
  }

  private ensureColumn(
    table: "deals" | "events" | "external_event_keys" | "work_items",
    name: string,
    type: string,
  ): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((col) => col.name === name)) {
      try {
        this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`).run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("duplicate column name")) throw err;
      }
    }
  }

  private backfillWorkItemSuggestionSourceEventIds(): void {
    this.transactionImmediate(() => {
      const rows = this.db
        .prepare(
          `SELECT id
           FROM work_items
           WHERE agent_suggestion_source_event_id IS NULL`,
        )
        .all() as Array<{ id: string }>;
      if (rows.length === 0) return;

      const update = this.db.prepare(
        `UPDATE work_items
         SET agent_suggestion_source_event_id = ?
         WHERE id = ?`,
      );
      for (const row of rows) {
        update.run(
          workItemSuggestionSourceEventId({ id: String(row.id) }),
          row.id,
        );
      }
    });
  }

  private ensureWorkItemSuggestionSourceIndex(): void {
    // Clean up pre-release index names/shapes from earlier local builds; after
    // the first open these drops are no-ops.
    this.db.prepare("DROP INDEX IF EXISTS idx_work_items_suggestion_source").run();
    this.db
      .prepare("DROP INDEX IF EXISTS idx_work_items_assigned_suggestion_source")
      .run();
    this.db
      .prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_agent_suggestion_source_unique
         ON work_items(agent_suggestion_source_event_id)
         WHERE agent_suggestion_source_event_id IS NOT NULL`,
      )
      .run();
    this.db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_work_items_assigned_suggestion_fifo
         ON work_items(
           CASE priority
             WHEN 'high' THEN 0
             WHEN 'medium' THEN 1
             WHEN 'low' THEN 2
             ELSE 3
           END,
           created_at,
           id
         )
         WHERE status = 'assigned'`,
      )
      .run();
  }

  private ensureExternalEventKeyGuards(): void {
    const validStatus =
      "'pending','ok','failed','suppressed','superseded_by_new_readiness'," +
      "'max_attempts_exceeded','fallback_max_attempts_exceeded'";
    const validScope =
      "'source_event','stage_notification','readiness_fallback'," +
      "'commercial_terminal_drift'";
    const invalid = this.db
      .prepare(
        `SELECT key, notify_status, scope
         FROM external_event_keys
         WHERE notify_status NOT IN (${validStatus})
            OR scope NOT IN (${validScope})
         LIMIT 1`,
      )
      .get() as
      | { key: string; notify_status: string; scope: string }
      | undefined;
    if (invalid) {
      throw new Error(
        `external_event_keys contains invalid status/scope for ${invalid.key}: ` +
          `${invalid.notify_status}/${invalid.scope}`,
      );
    }
    this.db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS trg_external_event_keys_notify_status_insert
         BEFORE INSERT ON external_event_keys
         WHEN NEW.notify_status NOT IN (${validStatus})
         BEGIN
           SELECT RAISE(ABORT, 'invalid external_event_keys.notify_status');
         END`,
      )
      .run();
    this.db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS trg_external_event_keys_notify_status_update
         BEFORE UPDATE OF notify_status ON external_event_keys
         WHEN NEW.notify_status NOT IN (${validStatus})
         BEGIN
           SELECT RAISE(ABORT, 'invalid external_event_keys.notify_status');
         END`,
      )
      .run();
    this.db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS trg_external_event_keys_scope_insert
         BEFORE INSERT ON external_event_keys
         WHEN NEW.scope NOT IN (${validScope})
         BEGIN
           SELECT RAISE(ABORT, 'invalid external_event_keys.scope');
         END`,
      )
      .run();
    this.db
      .prepare(
        `CREATE TRIGGER IF NOT EXISTS trg_external_event_keys_scope_update
         BEFORE UPDATE OF scope ON external_event_keys
         WHEN NEW.scope NOT IN (${validScope})
         BEGIN
           SELECT RAISE(ABORT, 'invalid external_event_keys.scope');
         END`,
      )
      .run();
  }

  private ensureIdempotencyViolationScopes(): void {
    const row = this.db
      .prepare(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'idempotency_violations'`,
      )
      .get() as { sql: string | null } | undefined;
    if (
      !row?.sql ||
      this.idempotencyViolationsAllowScopes(row.sql, [
        "outcome",
        "provider_observation",
        "agent_suggestion",
        "agent_suggestion_decision",
      ])
    ) {
      return;
    }

    this.transaction(() => {
      this.db
        .prepare(
          `CREATE TABLE idempotency_violations_next (
             id TEXT PRIMARY KEY,
             source TEXT NOT NULL,
             source_event_id TEXT NOT NULL,
             scope TEXT NOT NULL,
             existing_payload_hash TEXT NOT NULL,
             incoming_payload_hash TEXT NOT NULL,
             reason TEXT NOT NULL,
             created_at TEXT NOT NULL,
             UNIQUE (source, source_event_id, scope),
             CHECK (
               scope IN (
                 'commercial_state',
                 'deployment_facts',
                 'outcome',
                 'provider_observation',
                 'agent_suggestion',
                 'agent_suggestion_decision'
               ) OR
               scope LIKE 'external_event_observation:%'
             )
           )`,
        )
        .run();
      this.db
        .prepare(
          `INSERT INTO idempotency_violations_next (
             id, source, source_event_id, scope, existing_payload_hash,
             incoming_payload_hash, reason, created_at
           )
           SELECT
             id, source, source_event_id, scope, existing_payload_hash,
             incoming_payload_hash, reason, created_at
           FROM idempotency_violations`,
        )
        .run();
      this.db.prepare("DROP TABLE idempotency_violations").run();
      this.db
        .prepare(
          "ALTER TABLE idempotency_violations_next RENAME TO idempotency_violations",
        )
        .run();
    });
  }

  private idempotencyViolationsAllowScopes(
    tableSql: string,
    scopes: readonly string[],
  ): boolean {
    return scopes.every((scope) => {
      const escaped = scope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`scope\\s+IN\\s*\\([^)]*'${escaped}'[^)]*\\)`, "i").test(
        tableSql,
      );
    });
  }

  private ensurePolicyRecommendationRunStatuses(): void {
    const row = this.db
      .prepare(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'policy_recommendation_runs'`,
      )
      .get() as { sql: string | null } | undefined;
    const expectedStatuses = [
      "'recorded'",
      "'duplicate'",
      "'idempotency_conflict'",
      "'all_skipped'",
      "'no_signals'",
    ];
    const tableSql = row?.sql;
    if (
      !tableSql ||
      expectedStatuses.every((status) => tableSql.includes(status))
    ) {
      return;
    }

    // Recreate if an earlier local branch created the CHECK before the final
    // run-status vocabulary was settled.
    this.transactionImmediate(() => {
      this.db
        .prepare(
          `CREATE TABLE policy_recommendation_runs_next (
             id TEXT PRIMARY KEY,
             status TEXT NOT NULL,
             created_by TEXT NOT NULL,
             evaluated_at TEXT NOT NULL,
             limit_count INTEGER NOT NULL,
             attempted INTEGER NOT NULL,
             recorded INTEGER NOT NULL,
             duplicate INTEGER NOT NULL,
             idempotency_conflict INTEGER NOT NULL,
             skipped INTEGER NOT NULL,
             status_counts_json TEXT NOT NULL,
             results_json TEXT NOT NULL,
             created_at TEXT NOT NULL,
             CHECK (status IN (
               'recorded',
               'duplicate',
               'idempotency_conflict',
               'all_skipped',
               'no_signals'
             )),
             CHECK (limit_count >= 1),
             CHECK (attempted >= 0),
             CHECK (recorded >= 0),
             CHECK (duplicate >= 0),
             CHECK (idempotency_conflict >= 0),
             CHECK (skipped >= 0)
           )`,
        )
        .run();
      this.db
        .prepare(
          `INSERT INTO policy_recommendation_runs_next (
             id, status, created_by, evaluated_at, limit_count, attempted,
             recorded, duplicate, idempotency_conflict, skipped,
             status_counts_json, results_json, created_at
           )
           SELECT
             id, status, created_by, evaluated_at, limit_count, attempted,
             recorded, duplicate, idempotency_conflict, skipped,
             status_counts_json, results_json, created_at
           FROM policy_recommendation_runs`,
        )
        .run();
      this.db.prepare("DROP TABLE policy_recommendation_runs").run();
      this.db
        .prepare(
          "ALTER TABLE policy_recommendation_runs_next RENAME TO policy_recommendation_runs",
        )
        .run();
      this.db
        .prepare(
          "CREATE INDEX IF NOT EXISTS idx_policy_recommendation_runs_created ON policy_recommendation_runs(created_at DESC)",
        )
        .run();
    });
  }

  private transaction<T>(fn: () => T): T {
    this.db.prepare("BEGIN").run();
    this.transactionDepth += 1;
    try {
      const result = fn();
      if (result instanceof Promise) {
        throw new Error("Store.transaction callback must be synchronous");
      }
      this.db.prepare("COMMIT").run();
      return result;
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private backfillDerivedColumns(): void {
    const rows = this.db
      .prepare(
        `SELECT id, stage, payload, quarantine
         FROM deals
         WHERE (stage='routed' AND route_kind IS NULL)
            OR (stage='quarantined' AND quarantine_code IS NULL)`,
      )
      .all() as Array<{
      id: string;
      stage: string;
      payload: string | null;
      quarantine: string | null;
    }>;
    if (rows.length === 0) return;
    this.transaction(() => {
      for (const row of rows) {
        try {
          this.backfillDerivedRow(row);
        } catch (err) {
          throw new Error(
            `derived-column backfill failed for ${row.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    });
  }

  private backfillDerivedRow(row: {
    id: string;
    stage: string;
    payload: string | null;
    quarantine: string | null;
  }): void {
    if (row.stage === "routed" && row.payload) {
      const deal = JSON.parse(row.payload) as RoutedDeal;
      this.db
        .prepare(
          `UPDATE deals
           SET route_kind=?, finance_flag=?, legal_flag=?, deal_usd=?, quarantine_code=NULL
           WHERE id=?`,
        )
        .run(
          deal.route.kind,
          deal.route.kind === "human_assisted" ? deal.route.financeFlag : null,
          deal.route.kind === "human_assisted" ? deal.route.legalFlag : null,
          deal.dealUSD,
          row.id,
        );
    }
    if (row.stage === "quarantined" && row.quarantine) {
      const quarantine = JSON.parse(row.quarantine) as Quarantine;
      this.db
        .prepare(
          `UPDATE deals
           SET route_kind=NULL, finance_flag=NULL, legal_flag=NULL, deal_usd=NULL, quarantine_code=?
           WHERE id=?`,
        )
        .run(quarantine.code, row.id);
    }
  }

  private sinkStateFromEvents(
    dealId: string,
  ): {
    mode: "dry_run" | "live" | null;
    status: "synced" | "partial" | "dry_run" | "unknown";
  } {
    const row = this.db
      .prepare(
        `SELECT detail, meta
         FROM events
         WHERE deal_id = ? AND (meta IS NOT NULL OR detail LIKE 'sink:%')
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(dealId) as { detail: string; meta: string | null } | undefined;
    if (!row) return { mode: null, status: "unknown" };
    if (row.meta) {
      const meta = JSON.parse(row.meta) as PipelineEventMeta;
      if (meta.kind === "sink") {
        if (meta.mode === "dry_run") return { mode: "dry_run", status: "dry_run" };
        return {
          mode: "live",
          status: meta.receipts.some((receipt) => receipt.status === "warning")
            ? "partial"
            : "synced",
        };
      }
    }
    if (row.detail.includes("notification failed")) {
      return { mode: "live", status: "partial" };
    }
    if (row.detail.includes("dry-run")) {
      return { mode: "dry_run", status: "dry_run" };
    }
    return { mode: null, status: "unknown" };
  }

  private backfillSinkColumns(): void {
    const rows = this.db
      .prepare(
        "SELECT id FROM deals WHERE stage='routed' AND sink_status IS NULL",
      )
      .all() as Array<{ id: string }>;
    if (rows.length === 0) return;
    this.transaction(() => {
      for (const row of rows) {
        const sink = this.sinkStateFromEvents(row.id);
        this.db
          .prepare("UPDATE deals SET sink_mode=?, sink_status=? WHERE id=?")
          .run(sink.mode, sink.status, row.id);
      }
    });
  }

  private backfillExternalNotificationLeases(): void {
    this.db
      .prepare(
        `UPDATE external_event_keys
         SET notify_pending_at = ?
         WHERE notify_status='pending'
           AND notify_pending_at IS NULL`,
      )
      .run(new Date().toISOString());
  }

  /** Idempotent on deal id — re-ingesting the same id updates, never dupes. */
  // ─── Write path — routed & quarantine persistence + event log ───────────
  upsertRouted(
    deal: RoutedDeal,
    latencyMs: number,
    sink?: { mode: "dry_run" | "live"; status: "synced" | "partial" | "dry_run" },
  ): "inserted" | "updated" {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT id FROM deals WHERE id = ?")
      .get(deal.id) as { id: string } | undefined;
    this.db
      .prepare(
        `INSERT INTO deals (
           id, stage, payload, quarantine, route_kind, finance_flag, legal_flag,
           deal_usd, quarantine_code, sink_mode, sink_status, latency_ms, created_at, updated_at
         )
         VALUES (?, 'routed', ?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           stage='routed', payload=excluded.payload, quarantine=NULL,
           route_kind=excluded.route_kind, finance_flag=excluded.finance_flag,
           legal_flag=excluded.legal_flag, deal_usd=excluded.deal_usd,
           quarantine_code=NULL, sink_mode=excluded.sink_mode,
           sink_status=excluded.sink_status,
           latency_ms=excluded.latency_ms, updated_at=excluded.updated_at`,
      )
      .run(
        deal.id,
        JSON.stringify(deal),
        deal.route.kind,
        deal.route.kind === "human_assisted" ? deal.route.financeFlag : null,
        deal.route.kind === "human_assisted" ? deal.route.legalFlag : null,
        deal.dealUSD,
        sink?.mode ?? null,
        sink?.status ?? null,
        latencyMs,
        now,
        now,
      );
    return existing ? "updated" : "inserted";
  }

  upsertQuarantine(
    q: Quarantine,
    latencyMs: number,
    deal?: Deal,
    routedDeal?: RoutedDeal,
  ): void {
    const now = new Date().toISOString();
    const sink = this.sinkStateFromEvents(q.dealId);
    this.db
      .prepare(
         `INSERT INTO deals (
           id, stage, payload, quarantine, route_kind, finance_flag, legal_flag,
           deal_usd, quarantine_code, sink_mode, sink_status, latency_ms, created_at, updated_at
         )
         VALUES (?, 'quarantined', ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           stage='quarantined',
           payload=CASE
             WHEN excluded.payload IS NOT NULL THEN excluded.payload
             WHEN deals.stage = 'quarantined' THEN deals.payload
             ELSE NULL
           END,
           quarantine=excluded.quarantine,
           route_kind=NULL, finance_flag=NULL, legal_flag=NULL,
           deal_usd=NULL,
           quarantine_code=excluded.quarantine_code,
           sink_mode=excluded.sink_mode, sink_status=excluded.sink_status,
           latency_ms=excluded.latency_ms, updated_at=excluded.updated_at`,
      )
      .run(
        q.dealId,
        routedDeal
          ? JSON.stringify(quarantineReplayPayload(routedDeal))
          : deal
            ? JSON.stringify(quarantineReplayPayload(deal))
            : null,
        JSON.stringify(q),
        q.code,
        sink.mode,
        sink.status,
        latencyMs,
        now,
        now,
      );
  }

  recordRouted(
    deal: RoutedDeal,
    latencyMs: number,
    sink: { mode: "dry_run" | "live"; status: "synced" | "partial" | "dry_run" },
  ): "inserted" | "updated" {
    return this.transaction(() => {
      const result = this.upsertRouted(deal, latencyMs, sink);
      this.appendEvent(deal.id, "scored", "routed", `route ${deal.route.kind}`);
      return result;
    });
  }

  recordQuarantineReplay(
    deal: RoutedDeal,
    latencyMs: number,
    sink: { mode: "dry_run" | "live"; status: "synced" | "partial" | "dry_run" },
    replayDetail: string,
    scoreDetail: string,
    sinkDetail: string,
    sinkMeta: PipelineEventMeta,
    noteDetail?: string,
  ): "inserted" | "updated" {
    return this.transaction(() => {
      const current = this.db
        .prepare("SELECT stage FROM deals WHERE id = ?")
        .get(deal.id) as { stage: string } | undefined;
      if (current?.stage !== "quarantined") {
        throw new Error("quarantine replay requires a currently quarantined deal");
      }
      this.appendEvent(deal.id, "quarantined", "enriched", replayDetail);
      if (noteDetail) {
        this.appendEvent(deal.id, "enriched", "enriched", noteDetail);
      }
      this.appendEvent(deal.id, "enriched", "scored", scoreDetail);
      this.appendEvent(deal.id, "scored", "scored", sinkDetail, sinkMeta);
      // upsertRouted only mutates the deals row; recordRouted is the normal
      // ingestion helper that appends its own routed event. Replay owns the
      // virtual quarantine -> enriched -> scored -> routed audit chain here.
      const result = this.upsertRouted(deal, latencyMs, sink);
      this.appendEvent(deal.id, "scored", "routed", `route ${deal.route.kind}`);
      return result;
    });
  }

  recordQuarantineReplayFailureOrStateRace(
    dealId: string,
    quarantineDetail: string,
    stateRaceDetail: string,
  ): { auditRecorded: boolean; stateChanged: boolean; auditUnavailable: boolean } {
    const now = new Date().toISOString();
    return this.transaction(() => {
      const current = this.db
        .prepare("SELECT stage FROM deals WHERE id = ?")
        .get(dealId) as { stage: string } | undefined;
      if (!current) {
        return {
          auditRecorded: false,
          stateChanged: false,
          auditUnavailable: true,
        };
      }
      const stage = pipelineStage(current.stage);
      if (!stage) {
        return {
          auditRecorded: false,
          stateChanged: false,
          auditUnavailable: true,
        };
      }
      if (stage === "quarantined") {
        this.appendEvent(dealId, "quarantined", "quarantined", quarantineDetail);
        this.db
          .prepare(
            `UPDATE deals
             SET updated_at = ?
             WHERE id = ?
               AND stage = 'quarantined'`,
          )
          .run(now, dealId);
        return {
          auditRecorded: true,
          stateChanged: false,
          auditUnavailable: false,
        };
      }
      this.appendEvent(dealId, stage, stage, stateRaceDetail);
      this.db
        .prepare("UPDATE deals SET updated_at = ? WHERE id = ?")
        .run(now, dealId);
      return {
        auditRecorded: true,
        stateChanged: true,
        auditUnavailable: false,
      };
    });
  }

  recordQuarantineReplayStateRace(
    dealId: string,
    detail: string,
    meta?: PipelineEventMeta,
  ): boolean {
    const now = new Date().toISOString();
    return this.transaction(() => {
      const current = this.db
        .prepare("SELECT stage FROM deals WHERE id = ?")
        .get(dealId) as { stage: string } | undefined;
      if (!current) return false;
      const stage = pipelineStage(current.stage);
      if (!stage) return false;
      this.appendEvent(dealId, stage, stage, detail, meta);
      this.db
        .prepare("UPDATE deals SET updated_at = ? WHERE id = ?")
        .run(now, dealId);
      return true;
    });
  }

  recordQuarantine(
    q: Quarantine,
    latencyMs: number,
    from: Stage | "-",
    detail: string,
    deal?: Deal,
    routedDeal?: RoutedDeal,
  ): void {
    this.transaction(() => {
      this.appendEvent(q.dealId, from, "quarantined", detail);
      this.upsertQuarantine(q, latencyMs, deal, routedDeal);
    });
  }

  appendEvent(
    dealId: string,
    from: Stage | "-",
    to: Stage,
    detail: string,
    meta?: PipelineEventMeta,
  ): void {
    this.db
      .prepare(
        "INSERT INTO events (deal_id, ts, from_st, to_st, detail, meta) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        dealId,
        new Date().toISOString(),
        from,
        to,
        detail,
        meta ? JSON.stringify(meta) : null,
      );
  }

  // ─── HubSpot stage-change webhooks + integration config ──────────────────
  recordExternalStageChange(
    dealId: string,
    stage: ExternalStageState,
    detail: string,
    meta: PipelineEventMeta,
    eventKey: string,
  ): "recorded" | "duplicate" | "not_routed" | "stale" | "notify_retry" {
    return this.transaction(() => {
      const existingDeal = this.db
        .prepare(
          `SELECT id, external_stage_updated_at
           FROM deals
           WHERE id = ?
             AND (stage='routed' OR sink_mode IS NOT NULL)`,
        )
        .get(dealId) as
        | { id: string; external_stage_updated_at: string | null }
        | undefined;
      if (!existingDeal) return "not_routed";

      const stale =
        existingDeal.external_stage_updated_at !== null &&
        existingDeal.external_stage_updated_at > stage.updatedAt;
      const existingEvent = this.db
        .prepare(
          "SELECT key FROM external_event_keys WHERE key = ?",
        )
        .get(eventKey) as { key: string } | undefined;
      if (existingEvent) {
        if (stale) return "stale";
        const now = new Date().toISOString();
        const cutoff = new Date(Date.now() - NOTIFY_PENDING_LEASE_MS).toISOString();
        const lease = this.db
          .prepare(
            `UPDATE external_event_keys
             SET notify_status='pending',
                 notify_pending_at=?,
                 notify_leases=notify_leases + 1
             WHERE key=?
               AND (
                 notify_status='failed'
                 OR (
                   notify_status='pending'
                   AND (
                     notify_pending_at IS NULL
                     OR notify_pending_at <= ?
                     OR notify_pending_at NOT GLOB '????-??-??T??:??:??*'
                   )
                 )
               )`,
          )
          .run(now, eventKey, cutoff) as { changes?: number };
        if ((lease.changes ?? 0) === 0) return "duplicate";
        this.db
          .prepare(
            `UPDATE deals
             SET external_system=?,
                 external_id=?,
                 external_stage_id=?,
                 external_stage_label=?,
                 external_stage_updated_at=?,
                 updated_at=?
             WHERE id=?`,
          )
          .run(
            stage.system,
            stage.externalId,
            stage.stageId,
            stage.stageLabel,
            stage.updatedAt,
            now,
            dealId,
          );
        return "notify_retry";
      }

      if (stale) return "stale";

      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO external_event_keys (key, system, recorded_at, notify_status, notify_leases, notify_pending_at) VALUES (?, ?, ?, 'pending', 1, ?)",
        )
        .run(eventKey, stage.system, now, now);
      this.db
        .prepare(
          `UPDATE deals
           SET external_system=?,
               external_id=?,
               external_stage_id=?,
               external_stage_label=?,
               external_stage_updated_at=?,
               updated_at=?
           WHERE id=?`,
        )
        .run(
          stage.system,
          stage.externalId,
          stage.stageId,
          stage.stageLabel,
          stage.updatedAt,
          now,
          dealId,
        );
      this.appendEvent(dealId, "routed", "routed", detail, meta);
      return "recorded";
    });
  }

  private markExternalNotification(
    eventKey: string,
    receipts: Array<{ detail: string; status?: "ok" | "warning" }>,
    auditFailure?: unknown,
    expectedLeaseAt?: string,
    options: {
      failedStatus?: "failed" | "max_attempts_exceeded";
      emptyReceiptsStatus?: "suppressed" | "failed" | "max_attempts_exceeded";
      notificationErrorFallback?: string;
    } = {},
  ): void {
    const failed = receipts.some((receipt) => receipt.status === "warning");
    const status =
      receipts.length === 0
        ? (options.emptyReceiptsStatus ?? "suppressed")
        : failed
          ? (options.failedStatus ?? "failed")
          : "ok";
    const notificationFailed =
      status === "failed" || status === "max_attempts_exceeded";
    const notificationError = notificationFailed
      ? receipts
          .filter((receipt) => receipt.status === "warning")
          .map((receipt) => receipt.detail)
          .join("; ") ||
        options.notificationErrorFallback ||
        "stage notification failed"
      : null;
    const auditError =
      auditFailure === undefined
        ? null
        : `audit_append_failed: ${
            auditFailure instanceof Error ? auditFailure.message : String(auditFailure)
          }`;
    const error = [auditError, notificationError]
      .filter((part): part is string => Boolean(part))
      .join("; ")
      .slice(0, 500) || null;
    const sql =
      expectedLeaseAt === undefined
        ? `UPDATE external_event_keys
           SET notify_status = ?,
               notify_pending_at = NULL,
               notified_at = ?,
               notify_error = ?
           WHERE key = ?`
        : `UPDATE external_event_keys
           SET notify_status = ?,
               notify_pending_at = NULL,
               notified_at = ?,
               notify_error = ?
           WHERE key = ?
             AND notify_pending_at = ?`;
    const result = this.db
      .prepare(sql)
      .run(
        status,
        new Date().toISOString(),
        error,
        eventKey,
        ...(expectedLeaseAt === undefined ? [] : [expectedLeaseAt]),
      ) as { changes?: number };
    if (expectedLeaseAt !== undefined && (result.changes ?? 0) === 0) {
      throw new Error(NOTIFICATION_LEASE_CHANGED);
    }
  }

  externalNotificationLeaseAt(eventKey: string): string | null {
    const row = this.db
      .prepare("SELECT notify_pending_at FROM external_event_keys WHERE key = ?")
      .get(eventKey) as { notify_pending_at: string | null } | undefined;
    return row?.notify_pending_at ?? null;
  }

  recordIntegrationConfigBundle(
    values: IntegrationConfigBundle,
  ): { activationId: string; bundleHash: string; rows: number } {
    const record = { ...values } satisfies Record<
      keyof IntegrationConfigBundle,
      unknown
    >;
    const bundleJson = canonicalJson(record);
    const bundleHash = sha256Hex(bundleJson);
    return this.transaction(() => {
      const latest = this.db
        .prepare(
          `SELECT activation_id, value_hash
           FROM integration_config
           WHERE key = 'effective_bundle'
           ORDER BY loaded_at DESC, id DESC
           LIMIT 1`,
        )
        .get() as
        | {
            activation_id: string;
            value_hash: string;
          }
        | undefined;
      if (latest?.value_hash === bundleHash) {
        return { activationId: latest.activation_id, bundleHash, rows: 0 };
      }
      const activationId = randomUUID();
      const loadedAt = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO integration_config (
             key, activation_id, value_json, value_hash, loaded_at
           )
           VALUES ('effective_bundle', ?, ?, ?, ?)`,
        )
        .run(activationId, bundleJson, bundleHash, loadedAt);
      let rows = 1;
      const keys = Object.keys(record).sort() as Array<keyof typeof record>;
      for (const key of keys) {
        const valueJson = canonicalJson(record[key]);
        this.db
          .prepare(
            `INSERT INTO integration_config (
               key, activation_id, value_json, value_hash, loaded_at
             )
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(String(key), activationId, valueJson, sha256Hex(valueJson), loadedAt);
        rows += 1;
      }
      return { activationId, bundleHash, rows };
    });
  }

  // ─── Commercial lifecycle state ───────────────────────────────────────────
  private commercialStateFromRow(
    row: Record<string, unknown>,
  ): CommercialStateRecord {
    return {
      dealId: String(row.deal_id),
      commercialState: row.commercial_state as CommercialState,
      source: row.source as "local" | "hubspot",
      sourceEventId: String(row.source_event_id),
      occurredAt: String(row.occurred_at),
      stateEnteredAt: String(row.state_entered_at),
      updatedAt: String(row.updated_at),
      terminalProjectedAt:
        typeof row.terminal_projected_at === "string"
          ? row.terminal_projected_at
          : null,
      projectedViaTerminalTie: Number(row.projected_via_terminal_tie) === 1,
      terminalTieOccurredAt:
        typeof row.terminal_tie_occurred_at === "string"
          ? row.terminal_tie_occurred_at
          : null,
      terminalTieResolvedAt:
        typeof row.terminal_tie_resolved_at === "string"
          ? row.terminal_tie_resolved_at
          : null,
      terminalTieWinnerState:
        row.terminal_tie_winner_state === "closed_won" ||
        row.terminal_tie_winner_state === "closed_lost"
          ? row.terminal_tie_winner_state
          : null,
      terminalTieLoserState:
        row.terminal_tie_loser_state === "closed_won" ||
        row.terminal_tie_loser_state === "closed_lost"
          ? row.terminal_tie_loser_state
          : null,
    };
  }

  commercialState(dealId: string): CommercialStateRecord | null {
    const row = this.db
      .prepare("SELECT * FROM commercial_states WHERE deal_id = ?")
      .get(dealId) as Record<string, unknown> | undefined;
    return row ? this.commercialStateFromRow(row) : null;
  }

  recordLocalCommercialState(
    input: LocalCommercialStateInput,
  ): LocalCommercialStateWriteResult {
    assertCanonicalIsoUtc(input.occurredAt, "commercial occurredAt");
    const eventKey = JSON.stringify([
      "commercial_state",
      LOCAL_COMMERCIAL_SOURCE,
      input.sourceEventId,
    ]);
    const payloadHash = sha256Hex(canonicalJson(input));
    return this.transactionImmediate(() => {
      const existingKey = this.db
        .prepare(
          "SELECT payload_hash FROM external_event_keys WHERE key = ?",
        )
        .get(eventKey) as { payload_hash: string | null } | undefined;
      if (existingKey) {
        if (existingKey.payload_hash === payloadHash) {
          return this.commercialStateResult(
            "duplicate",
            eventKey,
            input,
            false,
          );
        }
        this.recordIdempotencyViolation(
          input.sourceEventId,
          "commercial_state",
          existingKey.payload_hash ?? "[legacy-null]",
          payloadHash,
          "source event id replayed with a different payload",
        );
        return this.commercialStateResult(
          "idempotency_conflict",
          eventKey,
          input,
          false,
        );
      }

      const routed = this.db
        .prepare("SELECT id FROM deals WHERE id = ? AND stage = 'routed'")
        .get(input.dealId) as { id: string } | undefined;
      if (!routed) {
        return this.commercialStateResult("not_routed", eventKey, input, false);
      }

      this.claimLocalCommercialStateEvent(eventKey, payloadHash);
      const current = this.commercialState(input.dealId);
      const now = new Date().toISOString();

      if (!current) {
        this.upsertCommercialProjection(input, eventKey, payloadHash, now, {
          stateEnteredAt: now,
        });
        const readinessNotification = this.deriveDeploymentReadiness(
          input.dealId,
          now,
        );
        this.appendCommercialStateEvent(
          input,
          eventKey,
          true,
          `commercial state changed: ${input.commercialState}`,
        );
        return this.commercialStateResult(
          "recorded",
          eventKey,
          input,
          true,
          readinessNotification,
        );
      }

      if (input.occurredAt < current.occurredAt) {
        this.recordCommercialObservation(
          input,
          eventKey,
          payloadHash,
          "stale_stage_observation",
          false,
          `stale commercial state ignored: ${input.commercialState}`,
        );
        return this.commercialStateResult("stale", eventKey, input, false);
      }

      if (input.occurredAt === current.occurredAt) {
        return this.recordEqualTimestampCommercialState(
          input,
          eventKey,
          payloadHash,
          current,
          now,
        );
      }

      if (
        isTerminalCommercialState(current.commercialState) &&
        input.commercialState !== current.commercialState
      ) {
        const terminalDriftAlert = this.claimCommercialTerminalDriftAlert(
          input,
          payloadHash,
          current,
          now,
          "terminal_regression",
        );
        this.recordCommercialObservation(
          input,
          eventKey,
          payloadHash,
          "terminal_drift_unsupported",
          false,
          `terminal drift ignored: ${current.commercialState} -> ${input.commercialState}`,
          terminalDriftAlert
            ? {
                ...(input.expectedRedPath ? { expectedRedPath: true } : {}),
                tieResolutionDrift: terminalDriftAlert.tieResolutionDrift,
              }
            : input.expectedRedPath
              ? { expectedRedPath: true }
              : undefined,
        );
        this.appendCommercialStateEvent(
          input,
          eventKey,
          false,
          "commercial_terminal_drift",
          "terminal_drift_unsupported",
        );
        return this.commercialStateResult(
          "terminal_drift",
          eventKey,
          input,
          false,
          null,
          terminalDriftAlert,
        );
      }

      if (input.commercialState === current.commercialState) {
        this.recordCommercialObservation(
          input,
          eventKey,
          payloadHash,
          "same_state_newer",
          false,
          `same commercial state ignored: ${input.commercialState}`,
        );
        return this.commercialStateResult(
          "same_state_newer",
          eventKey,
          input,
          false,
        );
      }

      if (
        COMMERCIAL_STATE_RANK[input.commercialState] <
        COMMERCIAL_STATE_RANK[current.commercialState]
      ) {
        this.recordCommercialObservation(
          input,
          eventKey,
          payloadHash,
          "commercial_regression_unsupported",
          false,
          `commercial regression ignored: ${current.commercialState} -> ${input.commercialState}`,
        );
        return this.commercialStateResult("regression", eventKey, input, false);
      }

      this.upsertCommercialProjection(input, eventKey, payloadHash, now, {
        stateEnteredAt: now,
      });
      const readinessNotification = this.deriveDeploymentReadiness(
        input.dealId,
        now,
      );
      this.appendCommercialStateEvent(
        input,
        eventKey,
        true,
        `commercial state changed: ${input.commercialState}`,
      );
      return this.commercialStateResult(
        "recorded",
        eventKey,
        input,
        true,
        readinessNotification,
      );
    });
  }

  private transactionImmediate<T>(fn: () => T): T {
    this.db.prepare("BEGIN IMMEDIATE").run();
    this.transactionDepth += 1;
    try {
      const result = fn();
      if (result instanceof Promise) {
        throw new Error("Store.transactionImmediate callback must be synchronous");
      }
      this.db.prepare("COMMIT").run();
      return result;
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private commercialStateResult(
    status: LocalCommercialStateWriteResult["status"],
    eventKey: string,
    input: LocalCommercialStateInput,
    projected: boolean,
    readinessNotification: ReadinessNotificationClaim | null = null,
    terminalDriftAlert: CommercialTerminalDriftAlertClaim | null = null,
  ): LocalCommercialStateWriteResult {
    return {
      status,
      eventKey,
      dealId: input.dealId,
      commercialState: input.commercialState,
      projected,
      current: this.commercialState(input.dealId),
      readinessNotification,
      terminalDriftAlert,
    };
  }

  private claimLocalCommercialStateEvent(
    eventKey: string,
    payloadHash: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO external_event_keys (
           key, system, recorded_at, notify_status, scope, payload_hash
         )
         VALUES (?, ?, ?, 'ok', 'source_event', ?)`,
      )
      .run(eventKey, LOCAL_COMMERCIAL_SOURCE, new Date().toISOString(), payloadHash);
  }

  private claimCommercialTerminalDriftAlert(
    input: LocalCommercialStateInput,
    payloadHash: string,
    current: CommercialStateRecord,
    now: string,
    driftKind: CommercialTerminalDriftAlertClaim["driftKind"],
  ): CommercialTerminalDriftAlertClaim | null {
    const alertKey = `commercial_terminal_drift:${LOCAL_COMMERCIAL_SOURCE}:${input.sourceEventId}`;
    const tieResolutionDrift = recentTerminalTieResolution(
      current.projectedViaTerminalTie,
      current.terminalTieResolvedAt,
      now,
    );
    const inserted = this.db
      .prepare(
        `INSERT OR IGNORE INTO external_event_keys (
           key, system, recorded_at, notify_status, notify_leases,
           notify_pending_at, scope, payload_hash
         )
         VALUES (?, 'slack', ?, 'pending', 1, ?, 'commercial_terminal_drift', ?)`,
      )
      .run(alertKey, now, now, payloadHash) as { changes?: number };
    if ((inserted.changes ?? 0) !== 1) return null;
    return {
      dealId: input.dealId,
      alertKey,
      source: LOCAL_COMMERCIAL_SOURCE,
      sourceEventId: input.sourceEventId,
      incomingCommercialState: input.commercialState,
      currentCommercialState: current.commercialState,
      incomingOccurredAt: input.occurredAt,
      currentOccurredAt: current.occurredAt,
      driftKind,
      tieResolutionDrift,
      expectedRedPath: input.expectedRedPath,
      leaseAcquiredAt: now,
      leaseGeneration: 1,
    };
  }

  private currentIntegrationConfigHash(): string {
    const row = this.db
      .prepare(
        `SELECT value_hash
         FROM integration_config
         WHERE key = 'effective_bundle'
         ORDER BY loaded_at DESC, id DESC
         LIMIT 1`,
      )
      .get() as { value_hash: string } | undefined;
    return row?.value_hash ?? DEFAULT_INTEGRATION_CONFIG_HASH;
  }

  private recordIdempotencyViolation(
    sourceEventId: string,
    scope: string,
    existingPayloadHash: string,
    incomingPayloadHash: string,
    reason: string,
    source = LOCAL_COMMERCIAL_SOURCE,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO idempotency_violations (
           id, source, source_event_id, scope, existing_payload_hash,
           incoming_payload_hash, reason, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        source,
        sourceEventId,
        scope,
        existingPayloadHash,
        incomingPayloadHash,
        reason,
        new Date().toISOString(),
      );
  }

  // ─── Enrichment — provider observations & projected subject facts ─────────
  recordEnrichmentObservation(
    deal: Deal,
    provider: ProviderObservationProvider,
    enrichment: Enrichment,
  ): ProviderObservationWriteResult {
    const observedAt = new Date().toISOString();
    const normalizedPayload = parseEnrichmentPayload(enrichment);
    const subjectKey = enrichmentSubjectKey(deal);
    return this.recordProviderObservation({
      subjectType: "company",
      subjectKey,
      provider,
      sourceEventId: enrichmentObservationSourceEventId(
        provider,
        subjectKey,
        normalizedPayload,
      ),
      observedAt,
      expiresAt: enrichmentFactExpiresAt(observedAt),
      confidence: normalizedPayload.confidence,
      rawPayload: {
        provider,
        subjectKey,
        enrichment: normalizedPayload,
      },
      normalizedPayload,
      refreshOnDuplicate: true,
    });
  }

  recordProviderObservation(
    input: ProviderObservationInput,
  ): ProviderObservationWriteResult {
    ProviderObservationSubjectType.parse(input.subjectType);
    ProviderObservationProvider.parse(input.provider);
    if (input.subjectKey.trim().length === 0) {
      throw new Error("provider observation subjectKey must be non-empty");
    }
    if (input.sourceEventId.trim().length === 0) {
      throw new Error("provider observation sourceEventId must be non-empty");
    }
    assertCanonicalIsoUtc(input.observedAt, "provider observation observedAt");
    if (input.expiresAt !== null) {
      assertCanonicalIsoUtc(input.expiresAt, "provider observation expiresAt");
    }
    if (
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 1
    ) {
      throw new Error("provider observation confidence must be between 0 and 1");
    }
    const normalizedPayload = parseEnrichmentPayload(input.normalizedPayload);
    if (input.confidence !== normalizedPayload.confidence) {
      throw new Error(
        "provider observation confidence must match normalizedPayload.confidence",
      );
    }
    const normalizedInput = { ...input, normalizedPayload };
    const rawPayloadJson = assertJsonPayload(
      input.rawPayload,
      "provider observation rawPayload",
    );
    const normalizedPayloadJson = assertJsonPayload(
      normalizedPayload,
      "provider observation normalizedPayload",
    );
    const payloadHash = providerObservationPayloadHash(normalizedInput);

    return this.transactionImmediate(() => {
      const now = new Date().toISOString();
      const existing = this.providerObservationBySourceEvent(
        input.provider,
        input.sourceEventId,
      );
      if (existing) {
        if (existing.sourcePayloadHash === payloadHash) {
          // Duplicate refreshes are liveness extensions, not TTL corrections:
          // shorter-lived upstream corrections should arrive as new observations.
          const refreshExtendsExpiry = expiryExtends(
            input.expiresAt,
            existing.expiresAt,
          );
          const expiryNotShrunk =
            input.expiresAt === existing.expiresAt || refreshExtendsExpiry;
          const duplicateAdvanced =
            input.observedAt > existing.observedAt || refreshExtendsExpiry;
          const shouldRefreshDuplicate =
            input.refreshOnDuplicate === true &&
            input.observedAt >= existing.observedAt &&
            expiryNotShrunk &&
            duplicateAdvanced;
          if (shouldRefreshDuplicate) {
            this.db
              .prepare(
                `UPDATE provider_observations
                 SET observed_at = ?,
                     expires_at = ?
                 WHERE id = ?`,
              )
              .run(input.observedAt, input.expiresAt, existing.id);
            const refreshed = this.providerObservationById(existing.id);
            if (!refreshed) {
              throw new Error("provider observation refresh did not return a stored row");
            }
            const currentFacts = this.enrichedFactsForObservationSubject(
              input.subjectType,
              input.subjectKey,
            );
            const companyInput = companyProviderObservationInput(normalizedInput);
            const facts =
              currentFacts === null || currentFacts.sourceObservationId === refreshed.id
                ? this.projectEnrichedSubjectFacts(
                    companyInput,
                    refreshed,
                    now,
                    normalizedPayload,
                  )
                : currentFacts;
            return {
              status: "refreshed",
              observation: refreshed,
              facts,
            };
          }
          return {
            status: "duplicate",
            observation: existing,
            facts: this.enrichedFactsForObservationSubject(
              input.subjectType,
              input.subjectKey,
            ),
          };
        }
        this.recordIdempotencyViolation(
          input.sourceEventId,
          "provider_observation",
          existing.sourcePayloadHash,
          payloadHash,
          "provider observation source event id replayed with a different payload",
          input.provider,
        );
        return {
          status: "idempotency_conflict",
          observation: null,
          facts: this.enrichedFactsForObservationSubject(
            input.subjectType,
            input.subjectKey,
          ),
        };
      }

      const id = providerObservationId(input.provider, input.sourceEventId);
      this.db
        .prepare(
          `INSERT INTO provider_observations (
             id, subject_type, subject_key, provider, source_event_id,
             source_payload_hash, observed_at, expires_at, confidence,
             raw_payload_json, normalized_payload_json, created_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.subjectType,
          input.subjectKey,
          input.provider,
          input.sourceEventId,
          payloadHash,
          input.observedAt,
          input.expiresAt,
          input.confidence,
          rawPayloadJson,
          normalizedPayloadJson,
          now,
        );

      const observation = this.providerObservationById(id);
      if (!observation) {
        throw new Error("provider observation insert did not return a stored row");
      }
      const companyInput = companyProviderObservationInput(input);
      const facts =
        input.subjectType === "company"
          ? this.projectEnrichedSubjectFacts(
              companyInput,
              observation,
              now,
              normalizedPayload,
            )
          : null;
      return { status: "recorded", observation, facts };
    });
  }

  providerObservations(
    subjectType?: ProviderObservationSubjectType,
    subjectKey?: string,
    limit = 50,
  ): ProviderObservationRecord[] {
    const cappedLimit = Math.max(1, Math.min(Math.trunc(limit), 250));
    if (subjectType !== undefined) ProviderObservationSubjectType.parse(subjectType);
    if (subjectKey !== undefined && subjectKey.trim().length === 0) {
      throw new Error("provider observation subjectKey must be non-empty");
    }

    const where: string[] = [];
    const params: string[] = [];
    if (subjectType !== undefined) {
      where.push("subject_type = ?");
      params.push(subjectType);
    }
    if (subjectKey !== undefined) {
      where.push("subject_key = ?");
      params.push(subjectKey);
    }
    const sql = [
      "SELECT * FROM provider_observations",
      where.length ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY observed_at DESC, id DESC",
      "LIMIT ?",
    ]
      .filter(Boolean)
      .join(" ");
    const rows = this.db
      .prepare(sql)
      .all(...params, cappedLimit) as Record<string, unknown>[];
    return rows.map((row) => this.providerObservationFromRow(row));
  }

  enrichedSubjectFacts(
    subjectType: "company",
    subjectKey: string,
    now = new Date().toISOString(),
  ): EnrichedSubjectFacts | null {
    if (subjectType !== "company") {
      throw new Error("only company enrichment facts are supported");
    }
    if (subjectKey.trim().length === 0) {
      throw new Error("enrichment facts subjectKey must be non-empty");
    }
    assertCanonicalIsoUtc(now, "enrichment facts reference time");
    const row = this.db
      .prepare(
        `SELECT *
         FROM enriched_subject_facts
         WHERE subject_type = ?
           AND subject_key = ?`,
      )
      .get(subjectType, subjectKey) as Record<string, unknown> | undefined;
    return row ? this.enrichedSubjectFactsFromRow(row, now) : null;
  }

  /**
   * Returns only currently projected company facts. Missing keys may mean no
   * observation ever existed, or that observations exist only below the
   * projection confidence threshold; callers that need that distinction should
   * read providerObservations().
   */
  enrichedSubjectFactsForKeys(
    subjectType: "company",
    subjectKeys: readonly string[],
    now = new Date().toISOString(),
  ): Map<string, EnrichedSubjectFacts> {
    if (subjectType !== "company") {
      throw new Error("only company enrichment facts are supported");
    }
    assertCanonicalIsoUtc(now, "enrichment facts reference time");
    const uniqueKeys = [...new Set(subjectKeys.filter((key) => key.trim().length > 0))];
    const facts = new Map<string, EnrichedSubjectFacts>();
    for (let i = 0; i < uniqueKeys.length; i += SQL_PARAMETER_BUDGET - 1) {
      const chunk = uniqueKeys.slice(i, i + SQL_PARAMETER_BUDGET - 1);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT *
           FROM enriched_subject_facts
           WHERE subject_type = ?
             AND subject_key IN (${placeholders})`,
        )
        .all(subjectType, ...chunk) as Record<string, unknown>[];
      for (const row of rows) {
        const parsed = this.enrichedSubjectFactsFromRow(row, now);
        facts.set(parsed.subjectKey, parsed);
      }
    }
    return facts;
  }

  private providerObservationById(id: string): ProviderObservationRecord | null {
    const row = this.db
      .prepare("SELECT * FROM provider_observations WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.providerObservationFromRow(row) : null;
  }

  private providerObservationBySourceEvent(
    provider: ProviderObservationProvider,
    sourceEventId: string,
  ): ProviderObservationRecord | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM provider_observations
         WHERE provider = ?
           AND source_event_id = ?`,
      )
      .get(provider, sourceEventId) as Record<string, unknown> | undefined;
    return row ? this.providerObservationFromRow(row) : null;
  }

  private providerObservationFromRow(
    row: Record<string, unknown>,
  ): ProviderObservationRecord {
    const normalizedPayload = parseEnrichmentPayload(
      JSON.parse(String(row.normalized_payload_json)),
    );
    return {
      id: String(row.id),
      subjectType: ProviderObservationSubjectType.parse(row.subject_type),
      subjectKey: String(row.subject_key),
      provider: ProviderObservationProvider.parse(row.provider),
      sourceEventId: String(row.source_event_id),
      sourcePayloadHash: String(row.source_payload_hash),
      observedAt: String(row.observed_at),
      expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
      confidence: Number(row.confidence),
      rawPayload: JSON.parse(String(row.raw_payload_json)) as unknown,
      normalizedPayload,
      createdAt: String(row.created_at),
    };
  }

  private projectEnrichedSubjectFacts(
    input: ProviderObservationInput & { subjectType: "company" },
    observation: ProviderObservationRecord,
    now: string,
    enrichment: Enrichment,
  ): EnrichedSubjectFacts | null {
    if (enrichment.confidence < ENRICHMENT_FACT_MIN_CONFIDENCE) {
      return this.enrichedSubjectFacts(input.subjectType, input.subjectKey, now);
    }
    this.db
      .prepare(
        `INSERT INTO enriched_subject_facts (
           subject_type, subject_key, employees, industry, tech_signals_json,
           regulated, confidence, source_provider, source_observation_id,
           observed_at, expires_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subject_type, subject_key) DO UPDATE SET
           employees=excluded.employees,
           industry=excluded.industry,
           tech_signals_json=excluded.tech_signals_json,
           regulated=excluded.regulated,
           confidence=excluded.confidence,
           source_provider=excluded.source_provider,
           source_observation_id=excluded.source_observation_id,
           observed_at=excluded.observed_at,
           expires_at=excluded.expires_at,
           updated_at=excluded.updated_at
         WHERE
           excluded.confidence > enriched_subject_facts.confidence OR
           (
             enriched_subject_facts.expires_at IS NOT NULL AND
             enriched_subject_facts.expires_at <= ? AND
             (
               excluded.expires_at IS NULL OR
               excluded.expires_at > ?
             )
           ) OR
           (
             excluded.source_observation_id =
               enriched_subject_facts.source_observation_id AND
             excluded.observed_at >= enriched_subject_facts.observed_at AND
             (
               excluded.expires_at IS enriched_subject_facts.expires_at OR
               excluded.expires_at IS NULL OR
               (
                 enriched_subject_facts.expires_at IS NOT NULL AND
                 excluded.expires_at > enriched_subject_facts.expires_at
               )
             )
           ) OR
           (
             excluded.confidence = enriched_subject_facts.confidence AND
             excluded.observed_at > enriched_subject_facts.observed_at
           )`,
      )
      .run(
        input.subjectType,
        input.subjectKey,
        enrichment.employees,
        enrichment.industry,
        canonicalJson(enrichment.techSignals),
        enrichment.regulated ? 1 : 0,
        enrichment.confidence,
        observation.provider,
        observation.id,
        observation.observedAt,
        observation.expiresAt,
        now,
        now,
        now,
      );
    return this.enrichedSubjectFacts(input.subjectType, input.subjectKey, now);
  }

  private enrichedFactsForObservationSubject(
    subjectType: ProviderObservationSubjectType,
    subjectKey: string,
  ): EnrichedSubjectFacts | null {
    return subjectType === "company"
      ? this.enrichedSubjectFacts("company", subjectKey)
      : null;
  }

  private enrichedSubjectFactsFromRow(
    row: Record<string, unknown>,
    now: string,
  ): EnrichedSubjectFacts {
    const techSignals = JSON.parse(String(row.tech_signals_json)) as unknown;
    if (
      !Array.isArray(techSignals) ||
      !techSignals.every((signal) => typeof signal === "string")
    ) {
      throw new Error("stored enrichment techSignals must be a string array");
    }
    return {
      subjectType: "company",
      subjectKey: String(row.subject_key),
      employees: Number(row.employees),
      industry: String(row.industry),
      techSignals,
      regulated: Number(row.regulated) === 1,
      confidence: Number(row.confidence),
      sourceProvider: ProviderObservationProvider.parse(row.source_provider),
      sourceObservationId: String(row.source_observation_id),
      observedAt: String(row.observed_at),
      expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
      freshnessStatus: enrichmentFactFreshnessStatus(
        typeof row.expires_at === "string" ? row.expires_at : null,
        now,
      ),
      updatedAt: String(row.updated_at),
    };
  }

  private recordEqualTimestampCommercialState(
    input: LocalCommercialStateInput,
    eventKey: string,
    payloadHash: string,
    current: CommercialStateRecord,
    now: string,
  ): LocalCommercialStateWriteResult {
    if (input.commercialState === current.commercialState) {
      this.recordCommercialObservation(
        input,
        eventKey,
        payloadHash,
        "same_state_tie",
        false,
        `same timestamp/state ignored: ${input.commercialState}`,
      );
      return this.commercialStateResult("same_state_tie", eventKey, input, false);
    }

    const terminalSiblingTie =
      isTerminalCommercialState(input.commercialState) &&
      isTerminalCommercialState(current.commercialState);
    if (terminalSiblingTie) {
      const winner: CommercialState = "closed_lost";
      const loser: CommercialState = "closed_won";
      const projected = current.commercialState !== winner;
      if (projected) {
        this.upsertCommercialProjection(input, eventKey, payloadHash, now, {
          commercialState: winner,
          stateEnteredAt: now,
          terminalProjectedAt: current.terminalProjectedAt ?? now,
          projectedViaTerminalTie: true,
          terminalTieOccurredAt: input.occurredAt,
          terminalTieResolvedAt: now,
          terminalTieWinnerState: winner,
          terminalTieLoserState: loser,
        });
        const readinessNotification = this.deriveDeploymentReadiness(
          input.dealId,
          now,
        );
        this.recordCommercialObservation(
          input,
          eventKey,
          payloadHash,
          "terminal_tie_conflict",
          projected,
          "terminal sibling tie resolved",
          {
            tieArrivalMode: "sequential_state_changed",
            tieWinnerChangedProjection: projected,
            logicalTieKey: `${input.dealId}:${input.occurredAt}:closed_lost:closed_won`,
          },
        );
        this.appendCommercialStateEvent(
          input,
          eventKey,
          projected,
          "terminal_tie_conflict",
          "terminal_tie_conflict",
        );
        return this.commercialStateResult(
          "recorded",
          eventKey,
          input,
          projected,
          readinessNotification,
        );
      } else {
        this.markTerminalTieOnExistingWinner(input, now, winner, loser);
      }
      this.recordCommercialObservation(
        input,
        eventKey,
        payloadHash,
        "terminal_tie_conflict",
        projected,
        "terminal sibling tie resolved",
        {
          tieArrivalMode: projected
            ? "sequential_state_changed"
            : "sequential_winner_already_projected",
          tieWinnerChangedProjection: projected,
          logicalTieKey: `${input.dealId}:${input.occurredAt}:closed_lost:closed_won`,
        },
      );
      this.appendCommercialStateEvent(
        input,
        eventKey,
        projected,
        "terminal_tie_conflict",
        "terminal_tie_conflict",
      );
      return this.commercialStateResult("recorded", eventKey, input, projected);
    }

    const incomingWins =
      COMMERCIAL_STATE_RANK[input.commercialState] >
      COMMERCIAL_STATE_RANK[current.commercialState];
    if (!incomingWins) {
      this.recordCommercialObservation(
        input,
        eventKey,
        payloadHash,
        "commercial_stage_tie_ignored",
        false,
        `same timestamp lower-ranked state ignored: ${input.commercialState}`,
      );
      return this.commercialStateResult("tie_ignored", eventKey, input, false);
    }

    this.upsertCommercialProjection(input, eventKey, payloadHash, now, {
      stateEnteredAt: now,
    });
    const readinessNotification = this.deriveDeploymentReadiness(
      input.dealId,
      now,
    );
    this.recordCommercialObservation(
      input,
      eventKey,
      payloadHash,
      "commercial_stage_tie_resolved",
      true,
      `same timestamp higher-ranked state projected: ${input.commercialState}`,
    );
    this.appendCommercialStateEvent(
      input,
      eventKey,
      true,
      "commercial_stage_tie_resolved",
      "commercial_stage_tie_resolved",
    );
    return this.commercialStateResult(
      "recorded",
      eventKey,
      input,
      true,
      readinessNotification,
    );
  }

  private upsertCommercialProjection(
    input: LocalCommercialStateInput,
    eventKey: string,
    payloadHash: string,
    now: string,
    override: {
      commercialState?: CommercialState;
      stateEnteredAt: string;
      terminalProjectedAt?: string | null;
      projectedViaTerminalTie?: boolean;
      terminalTieOccurredAt?: string | null;
      terminalTieResolvedAt?: string | null;
      terminalTieWinnerState?: CommercialState | null;
      terminalTieLoserState?: CommercialState | null;
    },
  ): void {
    const commercialState = override.commercialState ?? input.commercialState;
    const terminalProjectedAt =
      override.terminalProjectedAt ??
      (isTerminalCommercialState(commercialState) ? now : null);
    const projectedViaTerminalTie = override.projectedViaTerminalTie === true;
    this.db
      .prepare(
        `INSERT INTO commercial_states (
           deal_id, commercial_state, source, source_event_id,
           source_payload_hash, occurred_at, state_entered_at, updated_at,
           terminal_projected_at, projected_via_terminal_tie,
           terminal_tie_occurred_at, terminal_tie_resolved_at,
           terminal_tie_winner_state, terminal_tie_loser_state
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(deal_id) DO UPDATE SET
           commercial_state=excluded.commercial_state,
           source=excluded.source,
           source_event_id=excluded.source_event_id,
           source_payload_hash=excluded.source_payload_hash,
           occurred_at=excluded.occurred_at,
           state_entered_at=excluded.state_entered_at,
           updated_at=excluded.updated_at,
           terminal_projected_at=excluded.terminal_projected_at,
           projected_via_terminal_tie=excluded.projected_via_terminal_tie,
           terminal_tie_occurred_at=excluded.terminal_tie_occurred_at,
           terminal_tie_resolved_at=excluded.terminal_tie_resolved_at,
           terminal_tie_winner_state=excluded.terminal_tie_winner_state,
           terminal_tie_loser_state=excluded.terminal_tie_loser_state`,
      )
      .run(
        input.dealId,
        commercialState,
        LOCAL_COMMERCIAL_SOURCE,
        input.sourceEventId,
        payloadHash,
        input.occurredAt,
        override.stateEnteredAt,
        now,
        terminalProjectedAt,
        projectedViaTerminalTie ? 1 : 0,
        override.terminalTieOccurredAt ?? null,
        override.terminalTieResolvedAt ?? null,
        override.terminalTieWinnerState ?? null,
        override.terminalTieLoserState ?? null,
      );
  }

  private markTerminalTieOnExistingWinner(
    input: LocalCommercialStateInput,
    now: string,
    winner: CommercialState,
    loser: CommercialState,
  ): void {
    this.db
      .prepare(
        `UPDATE commercial_states
         SET updated_at=?,
             projected_via_terminal_tie=1,
             terminal_tie_occurred_at=?,
             terminal_tie_resolved_at=?,
             terminal_tie_winner_state=?,
             terminal_tie_loser_state=?
         WHERE deal_id=?
           AND commercial_state=?`,
      )
      .run(
        now,
        input.occurredAt,
        now,
        winner,
        loser,
        input.dealId,
        winner,
      );
  }

  private recordCommercialObservation(
    input: LocalCommercialStateInput,
    eventKey: string,
    payloadHash: string,
    observationCode: string,
    projected: boolean,
    reason: string,
    meta?: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO external_event_observations (
           source, source_event_id, observation_code, projected, payload_hash,
           config_hash, mapped_commercial_state, router_deal_id,
           occurred_at, reason, meta_json, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        LOCAL_COMMERCIAL_SOURCE,
        input.sourceEventId,
        observationCode,
        projected ? 1 : 0,
        payloadHash,
        this.currentIntegrationConfigHash(),
        input.commercialState,
        input.dealId,
        input.occurredAt,
        reason,
        meta ? canonicalJson(meta) : null,
        new Date().toISOString(),
      );
  }

  private appendCommercialStateEvent(
    input: LocalCommercialStateInput,
    eventKey: string,
    projected: boolean,
    detail: string,
    observationCode?: string,
  ): void {
    this.appendEvent(input.dealId, "routed", "routed", detail, {
      kind: "commercial_state",
      source: LOCAL_COMMERCIAL_SOURCE,
      eventKey,
      sourceEventId: input.sourceEventId,
      commercialState: input.commercialState,
      occurredAt: input.occurredAt,
      projected,
      ...(observationCode ? { observationCode } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.expectedRedPath ? { expectedRedPath: true } : {}),
    });
  }

  // ─── Deployment facts & readiness inputs ──────────────────────────────────
  private deploymentFactsFromRow(
    row: Record<string, unknown>,
  ): DeploymentFactsRecord {
    return {
      dealId: String(row.deal_id),
      useCaseClear: Number(row.use_case_clear) === 1,
      integrationsKnown: Number(row.integrations_known) === 1,
      dataReady: Number(row.data_ready) === 1,
      source: "local",
      sourceEventId: String(row.source_event_id),
      operator: String(row.operator),
      operatorSource: "self_reported",
      occurredAt: String(row.occurred_at),
      updatedAt: String(row.updated_at),
    };
  }

  deploymentFacts(dealId: string): DeploymentFactsRecord | null {
    const row = this.db
      .prepare("SELECT * FROM deployment_facts WHERE deal_id = ?")
      .get(dealId) as Record<string, unknown> | undefined;
    return row ? this.deploymentFactsFromRow(row) : null;
  }

  recordLocalDeploymentFacts(
    input: LocalDeploymentFactsInput,
  ): LocalDeploymentFactsWriteResult {
    assertCanonicalIsoUtc(input.occurredAt, "deployment facts occurredAt");
    const eventKey = JSON.stringify([
      "deployment_facts",
      LOCAL_DEPLOYMENT_FACTS_SOURCE,
      input.sourceEventId,
    ]);
    const payloadHash = sha256Hex(canonicalJson(input));
    return this.transactionImmediate(() => {
      const deal = this.db
        .prepare("SELECT id, stage FROM deals WHERE id = ?")
        .get(input.dealId) as { id: string; stage: string } | undefined;
      if (!deal) {
        return this.deploymentFactsResult("not_found", eventKey, input, false);
      }
      const routerStage = deal.stage as Stage;

      const existingKey = this.db
        .prepare("SELECT payload_hash FROM external_event_keys WHERE key = ?")
        .get(eventKey) as { payload_hash: string | null } | undefined;
      if (existingKey) {
        if (existingKey.payload_hash === payloadHash) {
          return this.deploymentFactsResult(
            "duplicate",
            eventKey,
            input,
            false,
          );
        }
        this.recordIdempotencyViolation(
          input.sourceEventId,
          "deployment_facts",
          existingKey.payload_hash ?? "[legacy-null]",
          payloadHash,
          "source event id replayed with different deployment facts",
        );
        return this.deploymentFactsResult(
          "idempotency_conflict",
          eventKey,
          input,
          false,
        );
      }

      const now = new Date().toISOString();
      this.claimLocalDeploymentFactsEvent(eventKey, payloadHash, now);
      const current = this.deploymentFacts(input.dealId);
      const staleAtMs =
        Date.parse(now) - DEPLOYMENT_FACT_MAX_AGE_DAYS * DAY_MS;

      if (Date.parse(input.occurredAt) < staleAtMs) {
        this.recordDeploymentFactsRejection(
          input,
          payloadHash,
          "age",
          null,
          now,
        );
        this.appendDeploymentFactsEvent(
          input,
          eventKey,
          routerStage,
          false,
          "deployment_facts_stale_ignored",
          { staleKind: "age" },
        );
        return this.deploymentFactsResult("stale_age", eventKey, input, false);
      }

      if (current && input.occurredAt < current.occurredAt) {
        this.recordDeploymentFactsRejection(
          input,
          payloadHash,
          "ordering",
          current.occurredAt,
          now,
        );
        this.appendDeploymentFactsEvent(
          input,
          eventKey,
          routerStage,
          false,
          "deployment_facts_stale_ignored",
          { staleKind: "ordering" },
        );
        return this.deploymentFactsResult(
          "stale_ordering",
          eventKey,
          input,
          false,
        );
      }

      if (current && input.occurredAt === current.occurredAt) {
        const sameBooleans =
          input.useCaseClear === current.useCaseClear &&
          input.integrationsKnown === current.integrationsKnown &&
          input.dataReady === current.dataReady;
        const sameOperator = input.operator === current.operator;
        const sameValues = sameBooleans && sameOperator;
        if (!sameValues) {
          this.recordDeploymentFactsRejection(
            input,
            payloadHash,
            "tie_conflict",
            current.occurredAt,
            now,
          );
        }
        this.appendDeploymentFactsEvent(
          input,
          eventKey,
          routerStage,
          false,
          "deployment_facts_tie_ignored",
          {
            tieKind: sameValues
              ? "same_values"
              : sameBooleans
                ? "different_operator"
                : "different_values",
          },
        );
        return this.deploymentFactsResult(
          sameValues ? "same_values_tie" : "tie_conflict",
          eventKey,
          input,
          false,
        );
      }

      this.upsertDeploymentFacts(input, payloadHash, now);
      const readinessNotification = this.deriveDeploymentReadiness(
        input.dealId,
        now,
      );
      this.appendDeploymentFactsEvent(
        input,
        eventKey,
        routerStage,
        true,
        "deployment facts recorded",
      );
      return this.deploymentFactsResult(
        "recorded",
        eventKey,
        input,
        true,
        readinessNotification,
      );
    });
  }

  private deploymentFactsResult(
    status: LocalDeploymentFactsWriteResult["status"],
    eventKey: string,
    input: LocalDeploymentFactsInput,
    accepted: boolean,
    readinessNotification: ReadinessNotificationClaim | null = null,
  ): LocalDeploymentFactsWriteResult {
    return {
      status,
      eventKey,
      dealId: input.dealId,
      sourceEventId: input.sourceEventId,
      accepted,
      current: this.deploymentFacts(input.dealId),
      readinessNotification,
    };
  }

  private claimLocalDeploymentFactsEvent(
    eventKey: string,
    payloadHash: string,
    recordedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO external_event_keys (
           key, system, recorded_at, notify_status, scope, payload_hash
         )
         VALUES (?, ?, ?, 'ok', 'source_event', ?)`,
      )
      .run(eventKey, LOCAL_DEPLOYMENT_FACTS_SOURCE, recordedAt, payloadHash);
  }

  private upsertDeploymentFacts(
    input: LocalDeploymentFactsInput,
    payloadHash: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO deployment_facts (
           deal_id, use_case_clear, integrations_known, data_ready,
           source, source_event_id, source_payload_hash, operator,
           operator_source, occurred_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(deal_id) DO UPDATE SET
           use_case_clear=excluded.use_case_clear,
           integrations_known=excluded.integrations_known,
           data_ready=excluded.data_ready,
           source=excluded.source,
           source_event_id=excluded.source_event_id,
           source_payload_hash=excluded.source_payload_hash,
           operator=excluded.operator,
           operator_source=excluded.operator_source,
           occurred_at=excluded.occurred_at,
           updated_at=excluded.updated_at`,
      )
      .run(
        input.dealId,
        input.useCaseClear ? 1 : 0,
        input.integrationsKnown ? 1 : 0,
        input.dataReady ? 1 : 0,
        LOCAL_DEPLOYMENT_FACTS_SOURCE,
        input.sourceEventId,
        payloadHash,
        input.operator,
        SELF_REPORTED_OPERATOR_SOURCE,
        input.occurredAt,
        now,
      );
  }

  private recordDeploymentFactsRejection(
    input: LocalDeploymentFactsInput,
    payloadHash: string,
    rejectionKind: "age" | "ordering" | "tie_conflict",
    currentOccurredAt: string | null,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO deployment_facts_rejections (
           id, deal_id, source, source_event_id, source_payload_hash,
           rejection_kind, incoming_occurred_at, current_occurred_at,
           operator, operator_source, use_case_clear, integrations_known,
           data_ready, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.dealId,
        LOCAL_DEPLOYMENT_FACTS_SOURCE,
        input.sourceEventId,
        payloadHash,
        rejectionKind,
        input.occurredAt,
        currentOccurredAt,
        input.operator,
        SELF_REPORTED_OPERATOR_SOURCE,
        input.useCaseClear ? 1 : 0,
        input.integrationsKnown ? 1 : 0,
        input.dataReady ? 1 : 0,
        now,
      );
  }

  private appendDeploymentFactsEvent(
    input: LocalDeploymentFactsInput,
    eventKey: string,
    routerStage: Stage,
    accepted: boolean,
    detail: string,
    extra?: {
      staleKind?: "age" | "ordering";
      tieKind?: "same_values" | "different_values" | "different_operator";
    },
  ): void {
    this.appendEvent(input.dealId, routerStage, routerStage, detail, {
      kind: "deployment_facts",
      source: LOCAL_DEPLOYMENT_FACTS_SOURCE,
      eventKey,
      sourceEventId: input.sourceEventId,
      useCaseClear: input.useCaseClear,
      integrationsKnown: input.integrationsKnown,
      dataReady: input.dataReady,
      operator: input.operator,
      operatorSource: SELF_REPORTED_OPERATOR_SOURCE,
      occurredAt: input.occurredAt,
      accepted,
      ...(extra?.staleKind ? { staleKind: extra.staleKind } : {}),
      ...(extra?.tieKind ? { tieKind: extra.tieKind } : {}),
    });
  }

  // ─── Post-sale outcomes, agent suggestions & policy recommendations ───────
  private outcomeEventFromRow(row: Record<string, unknown>): OutcomeEventRecord {
    const base = {
      id: String(row.id),
      dealId: String(row.deal_id),
      source: LOCAL_OUTCOME_SOURCE as "local",
      sourceEventId: String(row.source_event_id),
      sourcePayloadHash: String(row.source_payload_hash),
      occurredAt: String(row.occurred_at),
      operator: String(row.operator),
      operatorSource: SELF_REPORTED_OPERATOR_SOURCE as "self_reported",
      reasonCategory:
        typeof row.reason_category === "string"
          ? (row.reason_category as OutcomeEventRecord["reasonCategory"])
          : null,
      createdAt: String(row.created_at),
    };
    const outcome = row.outcome as OutcomeState;
    if (outcome === "expanded") {
      const arrDeltaUsd = Number(row.arr_delta_usd);
      if (!Number.isFinite(arrDeltaUsd)) {
        throw new Error("stored expanded outcome is missing arr_delta_usd");
      }
      return { ...base, outcome, arrDeltaUsd };
    }
    return { ...base, outcome: outcome as Exclude<OutcomeState, "expanded">, arrDeltaUsd: null };
  }

  private outcomeRejectionFromRow(
    row: Record<string, unknown>,
  ): OutcomeRejectionRecord {
    return {
      id: String(row.id),
      dealId: String(row.deal_id),
      source: LOCAL_OUTCOME_SOURCE,
      sourceEventId: String(row.source_event_id),
      sourcePayloadHash: String(row.source_payload_hash),
      rejectionKind: row.rejection_kind as OutcomeRejectionKind,
      outcome: row.outcome as OutcomeState,
      occurredAt: String(row.occurred_at),
      createdAt: String(row.created_at),
    };
  }

  outcomeEvents(dealId: string): OutcomeEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM outcome_events
         WHERE deal_id = ?
         ORDER BY occurred_at, created_at, id`,
      )
      .all(dealId) as Record<string, unknown>[];
    return rows.map((row) => this.outcomeEventFromRow(row));
  }

  outcomeRejections(dealId: string): OutcomeRejectionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM outcome_rejections
         WHERE deal_id = ?
         ORDER BY created_at, id`,
      )
      .all(dealId) as Record<string, unknown>[];
    return rows.map((row) => this.outcomeRejectionFromRow(row));
  }

  outcomeEventCount(): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM outcome_events").get() as {
      n: number;
    }).n;
  }

  agentSuggestions(limit = 50): AgentSuggestionRecord[] {
    const boundedLimit = Math.max(0, Math.min(Math.trunc(limit), 250));
    if (boundedLimit === 0) return [];

    const proposedTarget = Math.ceil(boundedLimit / 2);
    const decidedTarget = boundedLimit - proposedTarget;
    const proposedRows = this.db
      .prepare(
        `SELECT *
         FROM agent_suggestions
         WHERE status = 'proposed'
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(proposedTarget) as Record<string, unknown>[];
    const decidedRows =
      decidedTarget > 0
        ? (this.db
            .prepare(
              `SELECT *
               FROM agent_suggestions
               WHERE status != 'proposed'
               ORDER BY decided_at DESC, id DESC
               LIMIT ?`,
            )
            .all(decidedTarget) as Record<string, unknown>[])
        : [];
    const rows = [...proposedRows, ...decidedRows];

    if (rows.length < boundedLimit) {
      const ids = rows.map((row) => String(row.id));
      const excluded = ids.length
        ? `WHERE id NOT IN (${ids.map(() => "?").join(", ")})`
        : "";
      const backfill = this.db
        .prepare(
          `SELECT *
           FROM agent_suggestions
           ${excluded}
           ORDER BY
             CASE status
               WHEN 'proposed' THEN 0
               ELSE 1
             END,
             COALESCE(decided_at, created_at) DESC,
             id DESC
           LIMIT ?`,
        )
        .all(...ids, boundedLimit - rows.length) as Record<string, unknown>[];
      rows.push(...backfill);
    }

    rows.sort((a, b) => {
      const aStatus = String(a.status);
      const bStatus = String(b.status);
      const aRank = aStatus === "proposed" ? 0 : 1;
      const bRank = bStatus === "proposed" ? 0 : 1;
      if (aRank !== bRank) return aRank - bRank;
      const aTime = String(
        aStatus === "proposed"
          ? a.created_at
          : (a.decided_at ?? a.created_at),
      );
      const bTime = String(
        bStatus === "proposed"
          ? b.created_at
          : (b.decided_at ?? b.created_at),
      );
      if (aTime !== bTime) return bTime.localeCompare(aTime);
      return String(b.id).localeCompare(String(a.id));
    });

    return rows.map((row) => this.agentSuggestionFromRow(row));
  }

  policyRecommendationRuns(
    limit = DEFAULT_POLICY_RECOMMENDATION_RUN_PAGE_LIMIT,
  ): PolicyRecommendationRunRecord[] {
    const boundedLimit = policyRecommendationRunPageLimit(limit);
    if (boundedLimit === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT *
         FROM policy_recommendation_runs
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
      )
      .all(boundedLimit) as Record<string, unknown>[];
    return rows.map((row) => this.policyRecommendationRunFromRow(row));
  }

  nonDemoOutcomeEventCount(
    dealIds: readonly string[],
    demoSourceEventIds: readonly string[],
  ): number {
    if (dealIds.length === 0) return 0;
    assertSqlParameterBudget(
      dealIds.length + demoSourceEventIds.length,
      "non-demo outcome fixture guard",
    );
    const dealPlaceholders = dealIds.map(() => "?").join(", ");
    if (demoSourceEventIds.length === 0) {
      return (
        this.db
          .prepare(
            `SELECT COUNT(*) n
             FROM outcome_events
             WHERE deal_id IN (${dealPlaceholders})`,
          )
          .get(...dealIds) as { n: number }
      ).n;
    }
    const placeholders = demoSourceEventIds.map(() => "?").join(", ");
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) n
           FROM outcome_events
           WHERE deal_id IN (${dealPlaceholders})
             AND source_event_id NOT IN (${placeholders})`,
        )
        .get(...dealIds, ...demoSourceEventIds) as { n: number }
    ).n;
  }

  // Counts projected local commercial-state timeline events on demo fixture
  // deals. Observe-only stale/same-state rows live in
  // external_event_observations and do not block deterministic fixture replay.
  nonDemoProjectedCommercialStateEventCount(
    dealIds: readonly string[],
    demoSourceEventIds: readonly string[],
  ): number {
    if (dealIds.length === 0) return 0;
    assertSqlParameterBudget(
      dealIds.length + demoSourceEventIds.length,
      "non-demo projected commercial-state fixture guard",
    );
    const dealPlaceholders = dealIds.map(() => "?").join(", ");
    if (demoSourceEventIds.length === 0) {
      return (
        this.db
          .prepare(
            `SELECT COUNT(*) n
             FROM events
             WHERE deal_id IN (${dealPlaceholders})
               AND meta IS NOT NULL
               AND json_valid(meta)
               AND json_extract(meta, '$.kind') = 'commercial_state'
               AND json_extract(meta, '$.source') = 'local'
               AND json_extract(meta, '$.projected') = 1
               AND json_extract(meta, '$.sourceEventId') IS NOT NULL`,
          )
          .get(...dealIds) as { n: number }
      ).n;
    }
    const sourcePlaceholders = demoSourceEventIds.map(() => "?").join(", ");
    // Demo classification requires both the deterministic source id and the
    // demo reason prefix. A real local correction that somehow collides on the
    // source UUID still blocks persistent fixture overlay.
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) n
           FROM events
           WHERE deal_id IN (${dealPlaceholders})
             AND meta IS NOT NULL
             AND json_valid(meta)
             AND json_extract(meta, '$.kind') = 'commercial_state'
             AND json_extract(meta, '$.source') = 'local'
             AND json_extract(meta, '$.projected') = 1
             AND json_extract(meta, '$.sourceEventId') IS NOT NULL
             AND NOT (
               json_extract(meta, '$.sourceEventId') IN (${sourcePlaceholders})
               AND COALESCE(
                 json_extract(meta, '$.reason') LIKE 'demo outcome loop:%',
                 0
               )
             )`,
        )
        .get(...dealIds, ...demoSourceEventIds) as { n: number }
    ).n;
  }

  recordLocalOutcome(input: LocalOutcomeInput): LocalOutcomeWriteResult {
    assertCanonicalIsoUtc(input.occurredAt, "outcome occurredAt");
    const eventKey = JSON.stringify([
      "outcome",
      LOCAL_OUTCOME_SOURCE,
      input.sourceEventId,
    ]);
    const payloadHash = sha256Hex(canonicalJson(input));
    return this.transactionImmediate(() => {
      const deal = this.db
        .prepare("SELECT id FROM deals WHERE id = ?")
        .get(input.dealId) as { id: string } | undefined;
      if (!deal) {
        return this.outcomeResult("not_found", eventKey, input, false);
      }

      const commercial = this.commercialState(input.dealId);
      if (commercial?.commercialState !== "closed_won") {
        return this.outcomeResult("not_closed_won", eventKey, input, false);
      }

      const existingKey = this.db
        .prepare("SELECT payload_hash FROM external_event_keys WHERE key = ?")
        .get(eventKey) as { payload_hash: string | null } | undefined;
      if (existingKey) {
        if (existingKey.payload_hash === payloadHash) {
          return this.outcomeResult("duplicate", eventKey, input, false);
        }
        this.recordIdempotencyViolation(
          input.sourceEventId,
          "outcome",
          existingKey.payload_hash ?? "[legacy-null]",
          payloadHash,
          "source event id replayed with a different outcome payload",
        );
        return this.outcomeResult(
          "idempotency_conflict",
          eventKey,
          input,
          false,
        );
      }

      const now = new Date().toISOString();
      this.claimLocalOutcomeEvent(eventKey, payloadHash, now);
      const rejectionKind = this.localOutcomeRejectionKind(input);
      if (rejectionKind) {
        this.recordOutcomeRejection(input, payloadHash, rejectionKind, now);
        return this.outcomeResult(rejectionKind, eventKey, input, false);
      }

      this.insertOutcomeEvent(input, payloadHash, now);
      this.appendOutcomeEvent(input, eventKey);
      return this.outcomeResult("recorded", eventKey, input, true);
    });
  }

  private outcomeResult(
    status: LocalOutcomeWriteResult["status"],
    eventKey: string,
    input: LocalOutcomeInput,
    accepted: boolean,
  ): LocalOutcomeWriteResult {
    // Conflict rows belong to the first payload under the idempotency key; the
    // violation table is the diagnostic source for the mismatched replay.
    const loadPriorOutcome = status !== "idempotency_conflict";
    return {
      status,
      eventKey,
      dealId: input.dealId,
      sourceEventId: input.sourceEventId,
      accepted,
      event: loadPriorOutcome
        ? this.outcomeEventBySourceEvent(input.sourceEventId)
        : null,
      rejection: loadPriorOutcome
        ? this.outcomeRejectionBySourceEvent(input.sourceEventId)
        : null,
    };
  }

  private claimLocalOutcomeEvent(
    eventKey: string,
    payloadHash: string,
    recordedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO external_event_keys (
           key, system, recorded_at, notify_status, scope, payload_hash
         )
         VALUES (?, ?, ?, 'ok', 'source_event', ?)`,
      )
      .run(eventKey, LOCAL_OUTCOME_SOURCE, recordedAt, payloadHash);
  }

  private outcomeEventBySourceEvent(
    sourceEventId: string,
  ): OutcomeEventRecord | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM outcome_events
         WHERE source = ?
           AND source_event_id = ?`,
      )
      .get(LOCAL_OUTCOME_SOURCE, sourceEventId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.outcomeEventFromRow(row) : null;
  }

  private outcomeRejectionBySourceEvent(
    sourceEventId: string,
  ): OutcomeRejectionRecord | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM outcome_rejections
         WHERE source = ?
           AND source_event_id = ?`,
      )
      .get(LOCAL_OUTCOME_SOURCE, sourceEventId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.outcomeRejectionFromRow(row) : null;
  }

  private localOutcomeRejectionKind(
    input: LocalOutcomeInput,
  ): OutcomeRejectionKind | null {
    if (
      (input.outcome === "expanded" &&
        (typeof input.arrDeltaUsd !== "number" ||
          !Number.isInteger(input.arrDeltaUsd) ||
          input.arrDeltaUsd <= 0)) ||
      (input.outcome !== "expanded" && input.arrDeltaUsd !== null)
    ) {
      return "invalid_arr_delta";
    }

    if (
      this.hasPriorOutcome(input.dealId, "churned", input.occurredAt)
    ) {
      return "post_churn_outcome";
    }

    if (
      input.outcome !== "expanded" &&
      this.hasAnyOutcome(input.dealId, input.outcome)
    ) {
      return "duplicate_semantic_outcome";
    }

    if (
      (input.outcome === "deployed" &&
        !this.hasPriorOutcome(input.dealId, "deployment_started", input.occurredAt)) ||
      (input.outcome === "landed" &&
        !this.hasPriorOutcome(input.dealId, "deployed", input.occurredAt)) ||
      (input.outcome === "expanded" &&
        !this.hasPriorOutcome(input.dealId, "landed", input.occurredAt)) ||
      (input.outcome === "churned" &&
        !this.hasPriorOutcome(input.dealId, "deployment_started", input.occurredAt))
    ) {
      return "missing_prior_outcome";
    }

    return null;
  }

  private hasPriorOutcome(
    dealId: string,
    outcome: OutcomeState,
    occurredAt: string,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM outcome_events
         WHERE deal_id = ?
           AND outcome = ?
           AND occurred_at <= ?
         LIMIT 1`,
      )
      .get(dealId, outcome, occurredAt) as { "1": number } | undefined;
    return Boolean(row);
  }

  private hasAnyOutcome(dealId: string, outcome: OutcomeState): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM outcome_events
         WHERE deal_id = ?
           AND outcome = ?
         LIMIT 1`,
      )
      .get(dealId, outcome) as { "1": number } | undefined;
    return Boolean(row);
  }

  private insertOutcomeEvent(
    input: LocalOutcomeInput,
    payloadHash: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO outcome_events (
           id, deal_id, source, source_event_id, source_payload_hash,
           outcome, occurred_at, operator, operator_source, arr_delta_usd,
           reason_category, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.dealId,
        LOCAL_OUTCOME_SOURCE,
        input.sourceEventId,
        payloadHash,
        input.outcome,
        input.occurredAt,
        input.operator,
        SELF_REPORTED_OPERATOR_SOURCE,
        input.arrDeltaUsd,
        input.reasonCategory,
        now,
      );
  }

  private recordOutcomeRejection(
    input: LocalOutcomeInput,
    payloadHash: string,
    rejectionKind: OutcomeRejectionKind,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO outcome_rejections (
           id, deal_id, source, source_event_id, source_payload_hash,
           rejection_kind, outcome, occurred_at, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.dealId,
        LOCAL_OUTCOME_SOURCE,
        input.sourceEventId,
        payloadHash,
        rejectionKind,
        input.outcome,
        input.occurredAt,
        now,
      );
  }

  private appendOutcomeEvent(input: LocalOutcomeInput, eventKey: string): void {
    if (input.outcome === "expanded") {
      const arrDeltaUsd = input.arrDeltaUsd;
      if (
        typeof arrDeltaUsd !== "number" ||
        !Number.isInteger(arrDeltaUsd) ||
        arrDeltaUsd <= 0
      ) {
        throw new Error("accepted expanded outcome requires positive arrDeltaUsd");
      }
      this.appendEvent(input.dealId, "routed", "routed", "post_sale_outcome", {
        kind: "post_sale_outcome",
        source: LOCAL_OUTCOME_SOURCE,
        eventKey,
        sourceEventId: input.sourceEventId,
        outcome: input.outcome,
        occurredAt: input.occurredAt,
        operator: input.operator,
        operatorSource: SELF_REPORTED_OPERATOR_SOURCE,
        arrDeltaUsd,
        reasonCategory: input.reasonCategory,
      });
      return;
    }

    this.appendEvent(input.dealId, "routed", "routed", "post_sale_outcome", {
      kind: "post_sale_outcome",
      source: LOCAL_OUTCOME_SOURCE,
      eventKey,
      sourceEventId: input.sourceEventId,
      outcome: input.outcome,
      occurredAt: input.occurredAt,
      operator: input.operator,
      operatorSource: SELF_REPORTED_OPERATOR_SOURCE,
      arrDeltaUsd: null,
      reasonCategory: input.reasonCategory,
    });
  }

  recordLocalAgentSuggestion(
    input: LocalAgentSuggestionInput,
  ): LocalAgentSuggestionWriteResult {
    return this.transactionImmediate(() =>
      this.recordLocalAgentSuggestionInTransaction(input),
    );
  }

  private recordLocalAgentSuggestionInTransaction(
    input: LocalAgentSuggestionInput,
  ): LocalAgentSuggestionWriteResult {
    // Precondition: caller owns the transaction. This lets batch operations
    // atomically record suggestions and their parent audit row.
    if (this.transactionDepth === 0) {
      throw new Error(
        "recordLocalAgentSuggestionInTransaction requires an active transaction",
      );
    }
    assertCanonicalIsoUtc(input.occurredAt, "agent suggestion occurredAt");
    const eventKey = JSON.stringify([
      "agent_suggestion",
      LOCAL_AGENT_SUGGESTION_SOURCE,
      input.sourceEventId,
    ]);
    const payloadHash = sha256Hex(canonicalJson(input));
    const existingKey = this.db
      .prepare("SELECT payload_hash FROM external_event_keys WHERE key = ?")
      .get(eventKey) as { payload_hash: string | null } | undefined;
    if (existingKey) {
      if (existingKey.payload_hash === payloadHash) {
        const suggestion = this.agentSuggestionBySourceEvent(input.sourceEventId);
        if (!suggestion) {
          throw new Error(
            "agent suggestion source event was claimed without a suggestion row",
          );
        }
        return this.localAgentSuggestionResult(
          "duplicate",
          eventKey,
          suggestion,
        );
      }
      this.recordIdempotencyViolation(
        input.sourceEventId,
        "agent_suggestion",
        existingKey.payload_hash ?? "[legacy-null]",
        payloadHash,
        "source event id replayed with a different agent suggestion payload",
        LOCAL_AGENT_SUGGESTION_SOURCE,
      );
      return this.localAgentSuggestionResult(
        "idempotency_conflict",
        eventKey,
        null,
      );
    }

    const deal = this.db
      .prepare("SELECT id, stage FROM deals WHERE id = ?")
      .get(input.dealId) as { id: string; stage: Stage } | undefined;
    if (!deal) {
      return this.localAgentSuggestionResult("not_found", eventKey, null);
    }
    if (deal.stage !== "routed") {
      return this.localAgentSuggestionResult("not_routed", eventKey, null);
    }

    const now = new Date().toISOString();
    const suggestionId = `S-${sha256Hex(eventKey).slice(0, 20)}`;
    this.claimLocalAgentSuggestionEvent(eventKey, payloadHash, now);
    this.db
      .prepare(
        `INSERT INTO agent_suggestions (
           id, deal_id, kind, status, title, body, rationale, source,
           source_event_id, source_payload_hash, created_by, occurred_at,
           created_at
         )
         VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        suggestionId,
        input.dealId,
        input.kind,
        input.title,
        input.body,
        input.rationale,
        LOCAL_AGENT_SUGGESTION_SOURCE,
        input.sourceEventId,
        payloadHash,
        input.createdBy,
        input.occurredAt,
        now,
      );
    this.appendEvent(
      input.dealId,
      "routed",
      "routed",
      "agent_suggestion_proposed",
      {
        kind: "agent_suggestion_proposed",
        source: LOCAL_AGENT_SUGGESTION_SOURCE,
        eventKey,
        sourceEventId: input.sourceEventId,
        suggestionId,
        suggestionKind: input.kind,
        createdBy: input.createdBy,
        occurredAt: input.occurredAt,
      },
    );
    return this.localAgentSuggestionResult(
      "recorded",
      eventKey,
      this.agentSuggestionById(suggestionId),
    );
  }

  recordLocalAgentSuggestionDecision(
    input: LocalAgentSuggestionDecisionInput,
  ): LocalAgentSuggestionDecisionResult {
    assertCanonicalIsoUtc(
      input.occurredAt,
      "agent suggestion decision occurredAt",
    );
    const eventKey = JSON.stringify([
      "agent_suggestion_decision",
      LOCAL_AGENT_SUGGESTION_SOURCE,
      input.sourceEventId,
    ]);
    const payloadHash = sha256Hex(canonicalJson(input));
    return this.transactionImmediate(() => {
      const existingKey = this.db
        .prepare("SELECT payload_hash FROM external_event_keys WHERE key = ?")
        .get(eventKey) as { payload_hash: string | null } | undefined;
      if (existingKey) {
        if (existingKey.payload_hash === payloadHash) {
          const suggestion = this.agentSuggestionByDecisionSourceEvent(
            input.sourceEventId,
          );
          if (!suggestion) {
            throw new Error(
              "agent suggestion decision event was claimed without a decided suggestion row",
            );
          }
          return this.localAgentSuggestionDecisionResult(
            "duplicate",
            eventKey,
            suggestion,
          );
        }
        this.recordIdempotencyViolation(
          input.sourceEventId,
          "agent_suggestion_decision",
          existingKey.payload_hash ?? "[legacy-null]",
          payloadHash,
          "source event id replayed with a different agent suggestion decision payload",
          LOCAL_AGENT_SUGGESTION_SOURCE,
        );
        return this.localAgentSuggestionDecisionResult(
          "idempotency_conflict",
          eventKey,
          null,
        );
      }

      const suggestion = this.agentSuggestionById(input.suggestionId);
      if (!suggestion) {
        return this.localAgentSuggestionDecisionResult("not_found", eventKey, null);
      }
      if (suggestion.status !== "proposed") {
        return this.localAgentSuggestionDecisionResult(
          "already_decided",
          eventKey,
          suggestion,
        );
      }
      if (input.occurredAt < suggestion.occurredAt) {
        return this.localAgentSuggestionDecisionResult(
          "decision_before_proposal",
          eventKey,
          suggestion,
        );
      }

      const now = new Date().toISOString();
      this.claimLocalAgentSuggestionEvent(eventKey, payloadHash, now);
      this.db
        .prepare(
          `UPDATE agent_suggestions
           SET status = ?,
               decided_at = ?,
               decided_by = ?,
               decision_source_event_id = ?,
               decision_payload_hash = ?,
               decision_reason = ?
           WHERE id = ?
             AND status = 'proposed'`,
        )
        .run(
          input.decision,
          input.occurredAt,
          input.humanPrincipal,
          input.sourceEventId,
          payloadHash,
          input.reason,
          input.suggestionId,
        );
      const decided = this.agentSuggestionById(input.suggestionId);
      this.appendEvent(
        suggestion.dealId,
        "routed",
        "routed",
        "agent_suggestion_decided",
        {
          kind: "agent_suggestion_decided",
          source: LOCAL_AGENT_SUGGESTION_SOURCE,
          eventKey,
          sourceEventId: input.sourceEventId,
          suggestionId: input.suggestionId,
          decision: input.decision,
          humanPrincipal: input.humanPrincipal,
          occurredAt: input.occurredAt,
          reason: input.reason,
        },
      );
      return this.localAgentSuggestionDecisionResult(
        "recorded",
        eventKey,
        decided,
      );
    });
  }

  private localAgentSuggestionResult(
    status: LocalAgentSuggestionWriteResult["status"],
    eventKey: string,
    suggestion: AgentSuggestionRecord | null,
  ): LocalAgentSuggestionWriteResult {
    return { status, eventKey, suggestion };
  }

  private localAgentSuggestionDecisionResult(
    status: LocalAgentSuggestionDecisionResult["status"],
    eventKey: string,
    suggestion: AgentSuggestionRecord | null,
  ): LocalAgentSuggestionDecisionResult {
    return { status, eventKey, suggestion };
  }

  private claimLocalAgentSuggestionEvent(
    eventKey: string,
    payloadHash: string,
    recordedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO external_event_keys (
           key, system, recorded_at, notify_status, scope, payload_hash
         )
         VALUES (?, ?, ?, 'ok', 'source_event', ?)`,
      )
      .run(eventKey, LOCAL_AGENT_SUGGESTION_SOURCE, recordedAt, payloadHash);
  }

  private agentSuggestionById(id: string): AgentSuggestionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM agent_suggestions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.agentSuggestionFromRow(row) : null;
  }

  private agentSuggestionBySourceEvent(
    sourceEventId: string,
  ): AgentSuggestionRecord | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM agent_suggestions
         WHERE source = ?
           AND source_event_id = ?`,
      )
      .get(LOCAL_AGENT_SUGGESTION_SOURCE, sourceEventId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.agentSuggestionFromRow(row) : null;
  }

  private agentSuggestionByDecisionSourceEvent(
    sourceEventId: string,
  ): AgentSuggestionRecord | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM agent_suggestions
         WHERE source = ?
           AND decision_source_event_id = ?`,
      )
      .get(LOCAL_AGENT_SUGGESTION_SOURCE, sourceEventId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.agentSuggestionFromRow(row) : null;
  }

  private agentSuggestionFromRow(row: Record<string, unknown>): AgentSuggestionRecord {
    return {
      id: String(row.id),
      dealId: String(row.deal_id),
      kind: AgentSuggestionKind.parse(row.kind),
      status: AgentSuggestionStatus.parse(row.status),
      title: String(row.title),
      body: String(row.body),
      rationale: String(row.rationale),
      source: parseAgentSuggestionSource(row.source),
      sourceEventId: String(row.source_event_id),
      sourcePayloadHash: String(row.source_payload_hash),
      createdBy: String(row.created_by),
      occurredAt: String(row.occurred_at),
      createdAt: String(row.created_at),
      decidedAt:
        typeof row.decided_at === "string" ? String(row.decided_at) : null,
      decidedBy:
        typeof row.decided_by === "string" ? String(row.decided_by) : null,
      decisionSourceEventId:
        typeof row.decision_source_event_id === "string"
          ? String(row.decision_source_event_id)
          : null,
      decisionPayloadHash:
        typeof row.decision_payload_hash === "string"
          ? String(row.decision_payload_hash)
          : null,
      decisionReason:
        typeof row.decision_reason === "string"
          ? String(row.decision_reason)
          : null,
    };
  }

  // ─── Operator work-item queue ─────────────────────────────────────────────
  workItems(limit = 50): WorkItemRecord[] {
    const normalizedLimit = Number.isFinite(limit) ? limit : 50;
    const cappedLimit = Math.max(1, Math.min(250, normalizedLimit));
    const rows = this.db
      .prepare(
        `SELECT *
         FROM work_items
         ORDER BY
           CASE status
             WHEN 'assigned' THEN 0
             WHEN 'resolved' THEN 1
             WHEN 'waived' THEN 2
             ELSE 3
           END,
           CASE priority
             WHEN 'high' THEN 0
             WHEN 'medium' THEN 1
             WHEN 'low' THEN 2
             ELSE 3
           END,
           updated_at DESC,
           id
         LIMIT ?`,
      )
      .all(cappedLimit) as Record<string, unknown>[];
    return rows.map((row) => this.workItemFromRow(row));
  }

  recordWorkItemSuggestions(
    input: WorkItemSuggestionRunInput,
  ): WorkItemSuggestionRunResult {
    assertCanonicalIsoUtc(input.evaluatedAt, "work item suggestion evaluatedAt");
    const createdBy = nonEmptyLabel(
      input.createdBy,
      "work item suggestion createdBy",
    );
    const limit = workItemSuggestionLimit(input.limit);

    return this.transactionImmediate(() => {
      const candidates = this.assignedWorkItemsForSuggestions(limit);
      const results: WorkItemSuggestionRunResult["results"] = candidates.map(
        (candidate) => {
          const suggestionInput: LocalAgentSuggestionInput = {
            dealId: candidate.dealId,
            sourceEventId: candidate.agentSuggestionSourceEventId,
            kind: workItemSuggestionKind(candidate),
            title: workItemSuggestionTitle(candidate),
            body: workItemSuggestionBody(candidate),
            rationale: workItemSuggestionRationale(candidate),
            createdBy,
            // occurredAt is the source work-item signal time, not the run time.
            // Keeping it stable prevents replayed runs from turning the same
            // source event into an idempotency conflict.
            occurredAt: candidate.createdAt,
          };
          const result =
            this.recordLocalAgentSuggestionInTransaction(suggestionInput);
          return {
            workItemId: candidate.id,
            dealId: candidate.dealId,
            queue: candidate.queue,
            sourceEventId: suggestionInput.sourceEventId,
            status: result.status,
            suggestionId: result.suggestion?.id ?? null,
            title: suggestionInput.title,
          };
        },
      );

      const statusCounts = emptyAgentSuggestionWriteStatusCounts();
      for (const result of results) {
        statusCounts[result.status] += 1;
      }
      const recorded = statusCounts.recorded;
      const duplicate = statusCounts.duplicate;
      const idempotencyConflict = statusCounts.idempotency_conflict;
      const skipped = statusCounts.not_found + statusCounts.not_routed;
      if (skipped > 0) {
        throw new Error(
          "work item suggestion candidates must reference routed deals",
        );
      }

      return {
        status: agentSuggestionRunStatus({
          recorded,
          duplicate,
          idempotencyConflict,
          skipped,
        }),
        createdBy,
        limit,
        evaluatedAt: input.evaluatedAt,
        attempted: results.length,
        recorded,
        duplicate,
        idempotencyConflict,
        skipped,
        statusCounts,
        results,
      };
    });
  }

  recordLocalWorkItem(
    input: LocalWorkItemInput,
    signal: RoleQueueItem,
  ): LocalWorkItemWriteResult {
    // Caller must resolve this from roleQueues immediately before writing; the
    // store checks identity but does not re-run the full queue projection.
    assertCanonicalIsoUtc(input.occurredAt, "work item occurredAt");
    if (input.dueAt) assertCanonicalIsoUtc(input.dueAt, "work item dueAt");
    if (input.dealId !== signal.dealId || input.queue !== signal.queue) {
      throw new Error("work item input does not match role queue signal");
    }
    const sourceKey = this.workItemSourceKey(input.queue, input.dealId);
    const eventKey = JSON.stringify([
      "work_item",
      "role_queue",
      sourceKey,
      input.sourceEventId,
    ]);
    const { occurredAt: _occurredAt, reason: _reason, ...stableInput } = input;
    // Open notes are operator context, not the identity of the open command.
    // Signal detail is likewise a point-in-time snapshot used to describe the
    // work item, so retries do not fail when queue priority/reason text evolves.
    const payloadHash = sha256Hex(
      canonicalJson({
        input: stableInput,
        sourceKey,
      }),
    );

    return this.transactionImmediate(() => {
      const replay = this.workItemReplayResult(
        eventKey,
        payloadHash,
      );
      if (replay) return replay;

      const existing = this.assignedWorkItemBySourceKey(sourceKey);
      if (existing) {
        this.insertWorkItemEvent({
          workItemId: existing.id,
          action: "open_attempted",
          sourceEventId: input.sourceEventId,
          eventKey,
          payloadHash,
          actor: input.createdBy,
          owner: input.owner,
          reason:
            input.reason ??
            "Open requested while an assigned work item already existed.",
          occurredAt: input.occurredAt,
          createdAt: new Date().toISOString(),
        });
        return this.localWorkItemResult("already_exists", eventKey, existing);
      }

      const now = new Date().toISOString();
      const workItemId = `WI-${sha256Hex(`${sourceKey}:${input.sourceEventId}`).slice(0, 20)}`;
      const agentSuggestionSourceEventId = workItemSuggestionSourceEventId({
        id: workItemId,
      });
      const arrDescription = Number.isFinite(signal.amount)
        ? `$${Math.round(signal.amount).toLocaleString("en-US")}`
        : "unknown";
      const title = `${this.roleQueueLabel(signal.queue)}: ${signal.company}`;
      const description = [
        signal.reason,
        `Status: ${signal.status}`,
        `ARR: ${arrDescription}`,
        input.reason ? `Operator note: ${input.reason}` : "",
      ]
        .filter(Boolean)
        .join(" | ");
      this.db
        .prepare(
          `INSERT INTO work_items (
             id, source_kind, source_key, deal_id, queue, status, priority,
             owner, title, description, due_at, agent_suggestion_source_event_id,
             created_by, created_at, updated_at
           )
           VALUES (?, 'role_queue', ?, ?, ?, 'assigned', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workItemId,
          sourceKey,
          input.dealId,
          input.queue,
          signal.priority,
          input.owner,
          title,
          description,
          input.dueAt ?? null,
          agentSuggestionSourceEventId,
          input.createdBy,
          input.occurredAt,
          input.occurredAt,
        );
      this.insertWorkItemEvent({
        workItemId,
        action: "opened",
        sourceEventId: input.sourceEventId,
        eventKey,
        payloadHash,
        actor: input.createdBy,
        owner: input.owner,
        reason: input.reason ?? "Opened from role queue.",
        occurredAt: input.occurredAt,
        createdAt: now,
      });
      this.appendEvent(
        input.dealId,
        "routed",
        "routed",
        `work_item_opened: ${workItemId} ${input.queue} owner ${input.owner}`,
      );
      return this.localWorkItemResult(
        "recorded",
        eventKey,
        this.workItemById(workItemId),
      );
    });
  }

  recordLocalWorkItemAction(
    input: LocalWorkItemActionInput,
  ): LocalWorkItemActionResult {
    assertCanonicalIsoUtc(input.occurredAt, "work item action occurredAt");
    const eventKey = JSON.stringify([
      "work_item_action",
      input.workItemId,
      input.action,
      input.sourceEventId,
    ]);
    const { occurredAt: _occurredAt, ...stableInput } = input;
    // Action reasons are persisted as resolution evidence, so changing them
    // under the same event key is an idempotency conflict rather than a retry.
    const payloadHash = sha256Hex(canonicalJson(stableInput));

    return this.transactionImmediate(() => {
      const replay = this.workItemActionReplayResult(
        eventKey,
        payloadHash,
      );
      if (replay) return replay;

      const current = this.workItemById(input.workItemId);
      if (!current) {
        return this.localWorkItemActionResult("not_found", eventKey, null);
      }
      if (current.status !== "assigned") {
        this.insertWorkItemEvent({
          workItemId: input.workItemId,
          action: "already_closed",
          sourceEventId: input.sourceEventId,
          eventKey,
          payloadHash,
          actor: input.humanPrincipal,
          owner: input.owner ?? null,
          reason: input.reason,
          occurredAt: input.occurredAt,
          createdAt: new Date().toISOString(),
        });
        this.appendEvent(
          current.dealId,
          "routed",
          "routed",
          `work_item_${input.action}_already_closed_noop: ${input.workItemId} by ${input.humanPrincipal}`,
        );
        return this.localWorkItemActionResult("already_closed", eventKey, current);
      }
      const now = new Date().toISOString();
      // Recency is a projection rule, not an audit rule: older actions,
      // including terminal attempts, are logged as superseded no-ops so an old
      // backfill cannot close or reassign newer operator work. If these local
      // commands ever become distributed writes, replace client occurredAt as
      // the ordering key with a server-assigned monotonic sequence.
      const actionStatus: LocalWorkItemActionResult["status"] =
        input.occurredAt < current.updatedAt ? "superseded" : "recorded";
      const nextUpdatedAt =
        input.occurredAt > current.updatedAt ? input.occurredAt : current.updatedAt;
      if (input.action === "assign") {
        const nextOwner = input.owner;
        if (!nextOwner) {
          this.insertWorkItemEvent({
            workItemId: input.workItemId,
            action: "invalid_action",
            sourceEventId: input.sourceEventId,
            eventKey,
            payloadHash,
            actor: input.humanPrincipal,
            owner: null,
            reason: input.reason,
            occurredAt: input.occurredAt,
            createdAt: new Date().toISOString(),
          });
          this.appendEvent(
            current.dealId,
            "routed",
            "routed",
            `work_item_assign_invalid_action_noop: ${input.workItemId} by ${input.humanPrincipal} missing owner`,
          );
          return this.localWorkItemActionResult("invalid_action", eventKey, current);
        }
        if (actionStatus === "recorded") {
          this.db
            .prepare(
              `UPDATE work_items
               SET owner = ?, updated_at = ?
               WHERE id = ?
                 AND status = 'assigned'`,
            )
            .run(nextOwner, nextUpdatedAt, input.workItemId);
        }
      } else {
        const nextStatus: Exclude<WorkItemStatusType, "assigned"> =
          input.action === "resolve" ? "resolved" : "waived";
        if (actionStatus === "recorded") {
          this.db
            .prepare(
              `UPDATE work_items
               SET status = ?,
                   updated_at = ?,
                   resolved_at = ?,
                   resolved_by = ?,
                   resolution_reason = ?
               WHERE id = ?
                 AND status = 'assigned'`,
            )
            .run(
              nextStatus,
              nextUpdatedAt,
              input.occurredAt,
              input.humanPrincipal,
              input.reason,
              input.workItemId,
            );
        }
      }
      this.insertWorkItemEvent({
        workItemId: input.workItemId,
        action: actionStatus === "superseded" ? "superseded" : input.action,
        sourceEventId: input.sourceEventId,
        eventKey,
        payloadHash,
        actor: input.humanPrincipal,
        owner: input.owner ?? null,
        reason: input.reason,
        occurredAt: input.occurredAt,
        createdAt: now,
      });
      const updated = this.workItemById(input.workItemId);
      if (!updated) {
        throw new Error("work item disappeared during action write");
      }
      this.appendEvent(
        updated.dealId,
        "routed",
        "routed",
        actionStatus === "superseded"
          ? `work_item_${input.action}_superseded_noop: ${input.workItemId} by ${input.humanPrincipal} older than current projection`
          : `work_item_${input.action}: ${input.workItemId} by ${input.humanPrincipal}`,
      );
      return this.localWorkItemActionResult(actionStatus, eventKey, updated);
    });
  }

  private workItemReplayResult(
    eventKey: string,
    payloadHash: string,
  ): LocalWorkItemWriteResult | null {
    const event = this.workItemEventByEventKey(eventKey);
    if (!event) return null;
    const item = this.workItemById(event.workItemId);
    if (!item) {
      throw new Error("work item event was claimed without a work item row");
    }
    if (event.sourcePayloadHash !== payloadHash) {
      return this.localWorkItemResult("idempotency_conflict", eventKey, item);
    }
    if (event.action === "open_attempted") {
      // "Already exists" should describe the current active blocker, not a
      // historical blocker that may have closed since the no-op was logged.
      const activeItem =
        item.status === "assigned"
          ? item
          : this.assignedWorkItemBySourceKey(item.sourceKey);
      return this.localWorkItemResult(
        activeItem ? "already_exists" : "duplicate",
        eventKey,
        activeItem ?? item,
      );
    }
    return this.localWorkItemResult(
      "duplicate",
      eventKey,
      item,
    );
  }

  private workItemActionReplayResult(
    eventKey: string,
    payloadHash: string,
  ): LocalWorkItemActionResult | null {
    const event = this.workItemEventByEventKey(eventKey);
    if (!event) return null;
    const item = this.workItemById(event.workItemId);
    if (!item) {
      throw new Error("work item event was claimed without a work item row");
    }
    if (event.sourcePayloadHash !== payloadHash) {
      return this.localWorkItemActionResult(
        "idempotency_conflict",
        eventKey,
        item,
      );
    }
    return this.localWorkItemActionResult(
      event.action === "already_closed"
        ? "already_closed"
        : event.action === "superseded"
          ? "superseded"
          : event.action === "invalid_action"
            ? "invalid_action"
            : "duplicate",
      eventKey,
      item,
    );
  }

  private insertWorkItemEvent(event: {
    workItemId: string;
    action:
      | "opened"
      | "open_attempted"
      | "already_closed"
      | "superseded"
      | "invalid_action"
      | LocalWorkItemActionInput["action"];
    sourceEventId: string;
    eventKey: string;
    payloadHash: string;
    actor: string;
    owner: string | null;
    reason: string;
    occurredAt: string;
    createdAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO work_item_events (
           id, work_item_id, action, source_event_id, event_key, source_payload_hash,
           actor, owner, reason, occurred_at, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `WIE-${sha256Hex(`${event.eventKey}:${event.payloadHash}`).slice(0, 20)}`,
        event.workItemId,
        event.action,
        event.sourceEventId,
        event.eventKey,
        event.payloadHash,
        event.actor,
        event.owner,
        event.reason,
        event.occurredAt,
        event.createdAt,
      );
  }

  private workItemEventByEventKey(
    eventKey: string,
  ): {
    workItemId: string;
    action: string;
    sourcePayloadHash: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT work_item_id, action, source_payload_hash
         FROM work_item_events
         WHERE event_key = ?`,
      )
      .get(eventKey) as
      | { work_item_id: string; action: string; source_payload_hash: string }
      | undefined;
    return row
      ? {
          workItemId: row.work_item_id,
          action: row.action,
          sourcePayloadHash: row.source_payload_hash,
        }
      : null;
  }

  private workItemById(id: string): WorkItemRecord | null {
    const row = this.db
      .prepare("SELECT * FROM work_items WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.workItemFromRow(row) : null;
  }

  private assignedWorkItemBySourceKey(sourceKey: string): WorkItemRecord | null {
    const row = this.db
      .prepare(
        `SELECT *
         FROM work_items
         WHERE source_key = ?
           AND status = 'assigned'
         LIMIT 1`,
      )
      .get(sourceKey) as Record<string, unknown> | undefined;
    return row ? this.workItemFromRow(row) : null;
  }

  private assignedWorkItemsForSuggestions(limit: number): WorkItemRecord[] {
    const rows = this.db
      .prepare(
        `SELECT work_items.*
         FROM work_items
         JOIN deals
           ON deals.id = work_items.deal_id
          -- deals.stage is the pipeline storage state. Commercial closed-won
          -- and post-sale outcomes live in their own tables, so those items
          -- remain draftable while the routed deal row stays in this stage.
          AND deals.stage = 'routed'
         WHERE work_items.status = 'assigned'
           AND NOT EXISTS (
             SELECT 1
             FROM agent_suggestions
             WHERE agent_suggestions.source = ?
               AND agent_suggestions.source_event_id =
                 work_items.agent_suggestion_source_event_id
           )
         ORDER BY
           CASE work_items.priority
             WHEN 'high' THEN 0
             WHEN 'medium' THEN 1
             WHEN 'low' THEN 2
             ELSE 3
           END,
           work_items.created_at ASC,
           work_items.id
         LIMIT ?`,
      )
      .all(LOCAL_AGENT_SUGGESTION_SOURCE, limit) as Record<string, unknown>[];
    return rows.map((row) => this.workItemFromRow(row));
  }

  private workItemFromRow(row: Record<string, unknown>): WorkItemRecord {
    const id = String(row.id);
    const queue = this.parseRoleQueueKind(row.queue);
    if (typeof row.agent_suggestion_source_event_id !== "string") {
      throw new Error(`work item ${id} is missing agent suggestion source id`);
    }
    return {
      id,
      sourceKind: "role_queue",
      sourceKey: String(row.source_key),
      dealId: String(row.deal_id),
      queue,
      status: WorkItemStatus.parse(row.status),
      priority: this.parseRoleQueuePriority(row.priority),
      owner: String(row.owner),
      title: String(row.title),
      description: String(row.description),
      dueAt: typeof row.due_at === "string" ? String(row.due_at) : null,
      agentSuggestionSourceEventId: String(row.agent_suggestion_source_event_id),
      createdBy: String(row.created_by),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      resolvedAt:
        typeof row.resolved_at === "string" ? String(row.resolved_at) : null,
      resolvedBy:
        typeof row.resolved_by === "string" ? String(row.resolved_by) : null,
      resolutionReason:
        typeof row.resolution_reason === "string"
          ? String(row.resolution_reason)
          : null,
    };
  }

  private localWorkItemResult(
    status: LocalWorkItemWriteResult["status"],
    eventKey: string,
    workItem: WorkItemRecord | null,
  ): LocalWorkItemWriteResult {
    return { status, eventKey, workItem };
  }

  private localWorkItemActionResult(
    status: LocalWorkItemActionResult["status"],
    eventKey: string,
    workItem: WorkItemRecord | null,
  ): LocalWorkItemActionResult {
    return { status, eventKey, workItem };
  }

  private workItemSourceKey(queue: RoleQueueKind, dealId: string): string {
    return `role_queue:${queue}:${dealId}`;
  }

  private roleQueueLabel(queue: RoleQueueKind): string {
    const labels: Record<RoleQueueKind, string> = {
      ae_attention: "AE attention",
      finance_review: "Finance review",
      legal_review: "Legal review",
      deployment_readiness: "Deployment readiness",
      growth_attribution: "Growth attribution",
    };
    return labels[queue];
  }

  private parseRoleQueueKind(value: unknown): RoleQueueKind {
    if (
      typeof value === "string" &&
      ROLE_QUEUE_KINDS.includes(value as RoleQueueKind)
    ) {
      return value as RoleQueueKind;
    }
    throw new Error(`invalid role queue kind: ${String(value)}`);
  }

  private parseRoleQueuePriority(value: unknown): RoleQueuePriority {
    if (value === "high" || value === "medium" || value === "low") {
      return value;
    }
    throw new Error(`invalid role queue priority: ${String(value)}`);
  }

  // ─── Deployment readiness derivation + notification retries ───────────────
  private deriveDeploymentReadiness(
    dealId: string,
    now: string,
  ): ReadinessNotificationClaim | null {
    const commercial = this.commercialState(dealId);
    if (!commercial) return null;
    const deal = this.db
      .prepare("SELECT route_kind FROM deals WHERE id = ?")
      .get(dealId) as { route_kind: string | null } | undefined;
    if (!deal) return null;

    if (
      commercial.commercialState !== "closed_won" ||
      deal.route_kind !== "human_assisted"
    ) {
      return this.upsertDeploymentReadiness(
        dealId,
        {
          readiness: "not_required",
          blockerCode: null,
          secondaryBlockerCodes: null,
          reason: null,
        },
        now,
      );
    }

    const facts = this.deploymentFacts(dealId);
    const freshCutoffMs =
      Date.parse(now) - DEPLOYMENT_FACT_MAX_AGE_DAYS * DAY_MS;
    const factsOccurredAtMs = facts ? Date.parse(facts.occurredAt) : Number.NaN;
    if (
      !facts ||
      Number.isNaN(factsOccurredAtMs) ||
      factsOccurredAtMs < freshCutoffMs
    ) {
      return this.upsertDeploymentReadiness(
        dealId,
        {
          readiness: "pending",
          blockerCode: null,
          secondaryBlockerCodes: null,
          reason: "awaiting deployment facts",
        },
        now,
      );
    }

    const blockers: DeploymentBlocker[] = [];
    if (!facts.useCaseClear) blockers.push("deployment_use_case_unclear");
    if (!facts.integrationsKnown) blockers.push("deployment_integration_unknown");
    if (!facts.dataReady) blockers.push("deployment_data_unavailable");

    if (blockers.length === 0) {
      return this.upsertDeploymentReadiness(
        dealId,
        {
          readiness: "ready",
          blockerCode: null,
          secondaryBlockerCodes: null,
          reason: null,
        },
        now,
      );
    }

    const [primary, ...secondary] = blockers;
    return this.upsertDeploymentReadiness(
      dealId,
      {
        readiness: "blocked",
        blockerCode: primary ?? "deployment_data_unavailable",
        secondaryBlockerCodes: secondary.length > 0 ? secondary : null,
        reason: `blocked: ${primary ?? "deployment_data_unavailable"}`,
      },
      now,
    );
  }

  private upsertDeploymentReadiness(
    dealId: string,
    next:
      | {
          readiness: Exclude<DeploymentReadiness, "blocked">;
          blockerCode: null;
          secondaryBlockerCodes: null;
          reason: string | null;
        }
      | {
          readiness: "blocked";
          blockerCode: DeploymentBlocker;
          secondaryBlockerCodes: DeploymentBlocker[] | null;
          reason: string;
        },
    now: string,
  ): ReadinessNotificationClaim | null {
    const current = this.db
      .prepare(
        `SELECT readiness, blocker_code, blocker_entered_at, state_entered_at,
                last_notified_fingerprint
         FROM deployment_readiness
         WHERE deal_id = ?`,
      )
      .get(dealId) as
      | {
          readiness: DeploymentReadiness;
          blocker_code: DeploymentBlocker | null;
          blocker_entered_at: string | null;
          state_entered_at: string;
          last_notified_fingerprint: string | null;
        }
      | undefined;

    const previousReadiness = current?.readiness ?? "none";
    const previousFingerprint = current?.last_notified_fingerprint ?? null;
    const stateEnteredAt =
      current?.readiness === next.readiness ? current.state_entered_at : now;
    const blockerEnteredAt =
      next.readiness === "blocked"
        ? current?.readiness === "blocked" &&
          current.blocker_code === next.blockerCode &&
          current.blocker_entered_at
          ? current.blocker_entered_at
          : now
        : null;
    const secondaryBlockerCodes =
      next.readiness === "blocked" && next.secondaryBlockerCodes
        ? JSON.stringify(next.secondaryBlockerCodes)
        : null;

    this.db
      .prepare(
        `INSERT INTO deployment_readiness (
           deal_id, readiness, blocker_code, secondary_blocker_codes,
           blocker_entered_at, reason, state_entered_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(deal_id) DO UPDATE SET
           readiness=excluded.readiness,
           blocker_code=excluded.blocker_code,
           secondary_blocker_codes=excluded.secondary_blocker_codes,
           blocker_entered_at=excluded.blocker_entered_at,
           reason=excluded.reason,
           state_entered_at=excluded.state_entered_at,
           updated_at=excluded.updated_at`,
      )
      .run(
        dealId,
        next.readiness,
        next.readiness === "blocked" ? next.blockerCode : null,
        secondaryBlockerCodes,
        blockerEnteredAt,
        next.reason,
        stateEnteredAt,
        now,
      );
    if (
      current?.readiness === next.readiness ||
      !isNotifiableReadiness(next.readiness)
    ) {
      return null;
    }
    return this.claimReadinessNotification(
      dealId,
      previousReadiness,
      next.readiness,
      next.readiness === "blocked" ? next.blockerCode : null,
      next.reason,
      previousFingerprint,
      now,
    );
  }

  private claimReadinessNotification(
    dealId: string,
    previousReadiness: PreviousDeploymentReadiness,
    readiness: NotifiableReadiness,
    blockerCode: DeploymentBlocker | null,
    reason: string | null,
    previousFingerprint: string | null,
    now: string,
  ): ReadinessNotificationClaim | null {
    const fingerprint = `readiness:${dealId}:${previousReadiness}:${readiness}`;
    const claimed = this.db
      .prepare(
        `UPDATE deployment_readiness
         SET last_notified_fingerprint=?,
             notify_status='pending',
             notify_pending_at=?,
             notify_attempts=0,
             notify_error=NULL,
             updated_at=?
         WHERE deal_id=?
           AND last_notified_fingerprint IS ?`,
      )
      .run(fingerprint, now, now, dealId, previousFingerprint) as {
      changes?: number;
    };
    if ((claimed.changes ?? 0) === 0) return null;
    if (previousFingerprint) {
      this.supersedeReadinessFallback(previousFingerprint, now);
    }
    this.supersedeReadinessFallback(fingerprint, now);
    return {
      dealId,
      fingerprint,
      previousReadiness,
      readiness,
      blockerCode,
      reason,
      leaseAcquiredAt: now,
      attempt: 1,
    };
  }

  private supersedeReadinessFallback(fingerprint: string, now: string): void {
    this.db
      .prepare(
        `UPDATE external_event_keys
         SET notify_status='superseded_by_new_readiness',
             notify_pending_at=NULL,
             notified_at=?,
             notify_error=NULL
         WHERE key=?
           AND scope='readiness_fallback'
           AND notify_status IN (
             'pending',
             'failed'
           )`,
      )
      .run(now, `readiness_fallback:${fingerprint}`);
  }

  claimReadinessNotificationRetry(
    dealId: string,
    fingerprint: string,
  ): ReadinessNotificationClaim | null {
    return this.transactionImmediate(() => {
      const row = this.db
        .prepare(
          `SELECT readiness, blocker_code, reason, notify_status,
                  notify_pending_at, notify_attempts
           FROM deployment_readiness
           WHERE deal_id = ?
             AND last_notified_fingerprint = ?`,
        )
        .get(dealId, fingerprint) as
        | {
            readiness: DeploymentReadiness;
            blocker_code: DeploymentBlocker | null;
            reason: string | null;
            notify_status: DeploymentReadinessNotifyStatus | null;
            notify_pending_at: string | null;
            notify_attempts: number;
          }
        | undefined;
      if (!row || !isNotifiableReadiness(row.readiness)) return null;
      if (row.notify_attempts >= READINESS_NOTIFICATION_MAX_ATTEMPTS) {
        return null;
      }

      const parsed = readinessFromFingerprint(dealId, fingerprint);
      if (!parsed || parsed.readiness !== row.readiness) return null;
      const now = new Date().toISOString();
      const cutoff = new Date(
        Date.now() - READINESS_NOTIFICATION_LEASE_MS,
      ).toISOString();
      let update: { changes?: number };
      if (row.notify_status === "failed") {
        update = this.db
          .prepare(
            `UPDATE deployment_readiness
             SET notify_status='pending',
                 notify_pending_at=?,
                 updated_at=?
             WHERE deal_id=?
               AND last_notified_fingerprint=?
               AND notify_status='failed'
               AND notify_attempts=?`,
          )
          .run(now, now, dealId, fingerprint, row.notify_attempts) as {
          changes?: number;
        };
      } else if (
        row.notify_status === "pending" &&
        row.notify_pending_at !== null &&
        row.notify_pending_at <= cutoff
      ) {
        update = this.db
          .prepare(
            `UPDATE deployment_readiness
             SET notify_pending_at=?,
                 updated_at=?
             WHERE deal_id=?
               AND last_notified_fingerprint=?
               AND notify_status='pending'
               AND notify_pending_at=?
               AND notify_attempts=?`,
          )
          .run(
            now,
            now,
            dealId,
            fingerprint,
            row.notify_pending_at,
            row.notify_attempts,
          ) as { changes?: number };
      } else {
        return null;
      }
      if ((update.changes ?? 0) === 0) return null;
      return {
        dealId,
        fingerprint,
        previousReadiness: parsed.previousReadiness,
        readiness: parsed.readiness,
        blockerCode: parsed.readiness === "blocked" ? row.blocker_code : null,
        reason: row.reason,
        leaseAcquiredAt: now,
        attempt: row.notify_attempts + 1,
      };
    });
  }

  readinessNotificationRetryCandidates(
    filter: { dealId?: string; fingerprint?: string; limit: number },
  ): Array<{ type: "primary" | "fallback"; dealId: string; fingerprint: string }> {
    const cutoff = new Date(
      Date.now() - READINESS_NOTIFICATION_LEASE_MS,
    ).toISOString();
    const clauses = [
      "dr.readiness IN ('pending', 'ready', 'blocked')",
      "dr.last_notified_fingerprint IS NOT NULL",
      `(
        dr.notify_status='failed'
        OR dr.notify_status='max_attempts_exceeded'
        OR (
          dr.notify_status='pending'
          AND dr.notify_pending_at IS NOT NULL
          AND dr.notify_pending_at <= ?
        )
      )`,
      `NOT (
        dr.notify_status='max_attempts_exceeded'
        AND EXISTS (
          SELECT 1
          FROM external_event_keys AS fallback
          WHERE fallback.key='readiness_fallback:' || dr.last_notified_fingerprint
            AND fallback.scope='readiness_fallback'
            AND (
              fallback.notify_status IN ('ok', 'fallback_max_attempts_exceeded')
              OR (
                fallback.notify_status='failed'
                AND fallback.notify_leases >= ?
              )
            )
        )
      )`,
    ];
    const args: Array<string | number> = [
      cutoff,
      FALLBACK_NOTIFICATION_MAX_ATTEMPTS,
    ];
    if (filter.dealId) {
      clauses.push("dr.deal_id=?");
      args.push(filter.dealId);
    }
    if (filter.fingerprint) {
      clauses.push("dr.last_notified_fingerprint=?");
      args.push(filter.fingerprint);
    }
    args.push(filter.limit);
    const rows = this.db
      .prepare(
        `SELECT dr.deal_id, dr.last_notified_fingerprint, dr.notify_status,
                dr.notify_attempts,
                COALESCE(dr.notify_pending_at, dr.updated_at) AS retry_available_at
         FROM deployment_readiness AS dr
         WHERE ${clauses.join(" AND ")}
         ORDER BY retry_available_at, dr.last_notified_fingerprint, dr.deal_id
         LIMIT ?`,
      )
      .all(...args) as Array<{
      deal_id: string;
      last_notified_fingerprint: string;
      notify_status: DeploymentReadinessNotifyStatus;
      notify_attempts: number;
    }>;
    return rows.map((row) => ({
      type:
        row.notify_status === "max_attempts_exceeded" ||
        row.notify_attempts >= READINESS_NOTIFICATION_MAX_ATTEMPTS
          ? "fallback"
          : "primary",
      dealId: row.deal_id,
      fingerprint: row.last_notified_fingerprint,
    }));
  }

  claimReadinessFallback(
    dealId: string,
    fingerprint: string,
  ): ReadinessFallbackNotificationClaim | null {
    return this.transactionImmediate(() =>
      this.claimReadinessFallbackTx(dealId, fingerprint, new Date().toISOString()),
    );
  }

  readinessFallbackClaimMissStatus(
    fingerprint: string,
  ): ReadinessFallbackNotificationClaimMissStatus {
    const row = this.db
      .prepare(
        `SELECT notify_status, notify_leases
         FROM external_event_keys
         WHERE key=?
           AND scope='readiness_fallback'`,
      )
      .get(`readiness_fallback:${fingerprint}`) as
      | {
          notify_status: string;
          notify_leases: number;
        }
      | undefined;
    if (!row) return "missing";
    if (row.notify_status === "ok") return "already_delivered";
    if (row.notify_status === "pending") return "lease_held";
    if (
      row.notify_status === "fallback_max_attempts_exceeded" ||
      row.notify_leases >= FALLBACK_NOTIFICATION_MAX_ATTEMPTS
    ) {
      return "fallback_max_attempts_exceeded";
    }
    if (row.notify_status === "superseded_by_new_readiness") {
      return "superseded_by_new_readiness";
    }
    return "lost_race";
  }

  commercialTerminalDriftAlertRetryCandidates(
    filter: { dealId?: string; alertKey?: string; limit: number },
  ): CommercialTerminalDriftAlertRetryCandidate[] {
    const cutoff = new Date(
      Date.now() - TERMINAL_DRIFT_NOTIFICATION_LEASE_MS,
    ).toISOString();
    const clauses = [
      "e.scope='commercial_terminal_drift'",
      "o.source=?",
      "o.observation_code='terminal_drift_unsupported'",
      "e.notify_leases < ?",
      `(
        e.notify_status='failed'
        OR (
          e.notify_status='pending'
          AND e.notify_pending_at IS NOT NULL
          AND e.notify_pending_at <= ?
        )
      )`,
    ];
    const args: Array<string | number> = [
      `commercial_terminal_drift:${LOCAL_COMMERCIAL_SOURCE}:`,
      LOCAL_COMMERCIAL_SOURCE,
      TERMINAL_DRIFT_NOTIFICATION_MAX_ATTEMPTS,
      cutoff,
    ];
    if (filter.dealId) {
      clauses.push("o.router_deal_id=?");
      args.push(filter.dealId);
    }
    if (filter.alertKey) {
      clauses.push("e.key=?");
      args.push(filter.alertKey);
    }
    args.push(filter.limit);
    const rows = this.db
      .prepare(
        `SELECT o.router_deal_id AS deal_id, e.key AS alert_key,
                COALESCE(e.notify_pending_at, e.notified_at, e.recorded_at) AS retry_available_at
         FROM external_event_keys AS e
         JOIN external_event_observations AS o
           ON e.key=? || o.source_event_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY retry_available_at, e.key
         LIMIT ?`,
      )
      .all(...args) as Array<{ deal_id: string; alert_key: string }>;
    return rows.map((row) => ({
      type: "terminal_drift",
      dealId: row.deal_id,
      alertKey: row.alert_key,
    }));
  }

  claimCommercialTerminalDriftAlertRetry(
    alertKey: string,
  ): CommercialTerminalDriftAlertClaim | null {
    return this.transactionImmediate(() => {
      const now = new Date().toISOString();
      const cutoff = new Date(
        Date.now() - TERMINAL_DRIFT_NOTIFICATION_LEASE_MS,
      ).toISOString();
      const row = this.commercialTerminalDriftAlertRow(alertKey);
      if (!row) return null;
      if (row.notify_leases >= TERMINAL_DRIFT_NOTIFICATION_MAX_ATTEMPTS) {
        return null;
      }
      const eligible =
        row.notify_status === "failed" ||
        (row.notify_status === "pending" &&
          row.notify_pending_at !== null &&
          row.notify_pending_at <= cutoff);
      if (!eligible) return null;
      const updated = this.db
        .prepare(
          `UPDATE external_event_keys
           SET notify_status='pending',
               notify_leases=notify_leases + 1,
               notify_pending_at=?,
               notify_error=NULL
           WHERE key=?
             AND scope='commercial_terminal_drift'
             AND notify_leases=?
             AND (
               notify_status='failed'
               OR (
                 notify_status='pending'
                 AND notify_pending_at IS NOT NULL
                 AND notify_pending_at <= ?
               )
             )`,
        )
        .run(now, alertKey, row.notify_leases, cutoff) as { changes?: number };
      if ((updated.changes ?? 0) !== 1) return null;
      return this.commercialTerminalDriftAlertClaimFromRow(
        row,
        now,
        row.notify_leases + 1,
      );
    });
  }

  private commercialTerminalDriftAlertRow(alertKey: string):
    | {
        alert_key: string;
        notify_status: string;
        notify_leases: number;
        notify_pending_at: string | null;
        deal_id: string;
        source_event_id: string;
        incoming_commercial_state: string;
        incoming_occurred_at: string;
        meta_json: string | null;
        current_commercial_state: string;
        current_occurred_at: string;
        projected_via_terminal_tie: number;
        terminal_tie_resolved_at: string | null;
      }
    | undefined {
    return this.db
      .prepare(
        `SELECT e.key AS alert_key,
                e.notify_status,
                e.notify_leases,
                e.notify_pending_at,
                o.router_deal_id AS deal_id,
                o.source_event_id,
                o.mapped_commercial_state AS incoming_commercial_state,
                o.occurred_at AS incoming_occurred_at,
                o.meta_json,
                c.commercial_state AS current_commercial_state,
                c.occurred_at AS current_occurred_at,
                c.projected_via_terminal_tie,
                c.terminal_tie_resolved_at
         FROM external_event_keys AS e
         JOIN external_event_observations AS o
           ON e.key=? || o.source_event_id
          AND o.source=?
          AND o.observation_code='terminal_drift_unsupported'
         JOIN commercial_states AS c
           ON c.deal_id=o.router_deal_id
         WHERE e.key=?
           AND e.scope='commercial_terminal_drift'`,
      )
      .get(
        `commercial_terminal_drift:${LOCAL_COMMERCIAL_SOURCE}:`,
        LOCAL_COMMERCIAL_SOURCE,
        alertKey,
      ) as
      | {
          alert_key: string;
          notify_status: string;
          notify_leases: number;
          notify_pending_at: string | null;
          deal_id: string;
          source_event_id: string;
          incoming_commercial_state: string;
          incoming_occurred_at: string;
          meta_json: string | null;
          current_commercial_state: string;
          current_occurred_at: string;
          projected_via_terminal_tie: number;
          terminal_tie_resolved_at: string | null;
        }
      | undefined;
  }

  private commercialTerminalDriftAlertClaimFromRow(
    row: NonNullable<ReturnType<Store["commercialTerminalDriftAlertRow"]>>,
    leaseAcquiredAt: string,
    leaseGeneration: number,
  ): CommercialTerminalDriftAlertClaim {
    const tieResolutionDrift =
      tieResolutionDriftFromMeta(row.meta_json) ??
      recentTerminalTieResolution(
        row.projected_via_terminal_tie === 1,
        row.terminal_tie_resolved_at,
        leaseAcquiredAt,
      );
    return {
      dealId: row.deal_id,
      alertKey: row.alert_key,
      source: LOCAL_COMMERCIAL_SOURCE,
      sourceEventId: row.source_event_id,
      incomingCommercialState: row.incoming_commercial_state as CommercialState,
      currentCommercialState: row.current_commercial_state as CommercialState,
      incomingOccurredAt: row.incoming_occurred_at,
      currentOccurredAt: row.current_occurred_at,
      driftKind: "terminal_regression",
      tieResolutionDrift,
      expectedRedPath: expectedRedPathFromMeta(row.meta_json),
      leaseAcquiredAt,
      leaseGeneration,
    };
  }

  private claimReadinessFallbackTx(
    dealId: string,
    fingerprint: string,
    now: string,
  ): ReadinessFallbackNotificationClaim | null {
    const row = this.db
      .prepare(
        `SELECT readiness, notify_status, notify_attempts, notify_error
         FROM deployment_readiness
         WHERE deal_id=?
           AND last_notified_fingerprint=?`,
      )
      .get(dealId, fingerprint) as
      | {
          readiness: DeploymentReadiness;
          notify_status: DeploymentReadinessNotifyStatus | null;
          notify_attempts: number;
          notify_error: string | null;
        }
      | undefined;
    if (!row || !isNotifiableReadiness(row.readiness)) return null;
    const readiness = row.readiness;
    if (
      row.notify_status !== "max_attempts_exceeded" &&
      row.notify_attempts < READINESS_NOTIFICATION_MAX_ATTEMPTS
    ) {
      return null;
    }
    if (row.notify_status !== "max_attempts_exceeded") {
      const normalized = this.db
        .prepare(
          `UPDATE deployment_readiness
           SET notify_status='max_attempts_exceeded',
               notify_pending_at=NULL,
               updated_at=?
           WHERE deal_id=?
             AND last_notified_fingerprint=?
             AND notify_status IN ('failed', 'pending')
             AND notify_attempts >= ?`,
        )
        .run(now, dealId, fingerprint, READINESS_NOTIFICATION_MAX_ATTEMPTS) as {
        changes?: number;
      };
      if ((normalized.changes ?? 0) === 0) return null;
    }

    const fallbackKey = `readiness_fallback:${fingerprint}`;
    const existing = this.db
      .prepare(
        `SELECT notify_status, notify_leases, notify_pending_at
         FROM external_event_keys
         WHERE key=?`,
      )
      .get(fallbackKey) as
      | {
          notify_status: string;
          notify_leases: number;
          notify_pending_at: string | null;
        }
      | undefined;
    const claim = (
      leaseGeneration: number,
      leaseAcquiredAt: string,
    ): ReadinessFallbackNotificationClaim => ({
      dealId,
      fingerprint,
      fallbackKey,
      readiness,
      errorClass: notificationErrorClass(row.notify_error),
      leaseAcquiredAt,
      leaseGeneration,
    });

    if (!existing) {
      const inserted = this.db
        .prepare(
          `INSERT INTO external_event_keys (
             key, system, recorded_at, notify_status, notify_leases,
             notify_pending_at, scope
           )
           VALUES (?, 'slack', ?, 'pending', 1, ?, 'readiness_fallback')`,
        )
        .run(fallbackKey, now, now) as { changes?: number };
      return (inserted.changes ?? 0) === 1 ? claim(1, now) : null;
    }

    if (existing.notify_status === "superseded_by_new_readiness") {
      const updated = this.db
        .prepare(
          `UPDATE external_event_keys
           SET recorded_at=?,
               notify_status='pending',
               notify_leases=1,
               notify_pending_at=?,
               notified_at=NULL,
               notify_error=NULL
           WHERE key=?
             AND scope='readiness_fallback'
             AND notify_status='superseded_by_new_readiness'`,
        )
        .run(now, now, fallbackKey) as { changes?: number };
      return (updated.changes ?? 0) === 1 ? claim(1, now) : null;
    }

    if (existing.notify_leases >= FALLBACK_NOTIFICATION_MAX_ATTEMPTS) {
      return null;
    }
    const cutoff = new Date(
      Date.now() - FALLBACK_NOTIFICATION_LEASE_MS,
    ).toISOString();
    if (existing.notify_status === "failed") {
      const updated = this.db
        .prepare(
          `UPDATE external_event_keys
           SET notify_status='pending',
               notify_leases=notify_leases + 1,
               notify_pending_at=?,
               notify_error=NULL
           WHERE key=?
             AND scope='readiness_fallback'
             AND notify_status='failed'
             AND notify_leases=?`,
        )
        .run(now, fallbackKey, existing.notify_leases) as { changes?: number };
      return (updated.changes ?? 0) === 1
        ? claim(existing.notify_leases + 1, now)
        : null;
    }
    if (
      existing.notify_status === "pending" &&
      existing.notify_pending_at !== null &&
      existing.notify_pending_at <= cutoff
    ) {
      const updated = this.db
        .prepare(
          `UPDATE external_event_keys
           SET notify_leases=notify_leases + 1,
               notify_pending_at=?,
               notify_error=NULL
           WHERE key=?
             AND scope='readiness_fallback'
             AND notify_status='pending'
             AND notify_leases=?
             AND notify_pending_at=?`,
        )
        .run(
          now,
          fallbackKey,
          existing.notify_leases,
          existing.notify_pending_at,
        ) as { changes?: number };
      return (updated.changes ?? 0) === 1
        ? claim(existing.notify_leases + 1, now)
        : null;
    }
    return null;
  }

  recordExternalNotificationEvent(
    dealId: string,
    detail: string,
    meta: PipelineEventMeta,
    eventKey: string,
    receipts: Array<{ detail: string; status?: "ok" | "warning" }>,
    expectedLeaseAt?: string,
    markOptions?: Parameters<Store["markExternalNotification"]>[4],
  ): void {
    try {
      this.transaction(() => {
        this.markExternalNotification(
          eventKey,
          receipts,
          undefined,
          expectedLeaseAt,
          markOptions,
        );
        this.appendEvent(dealId, "routed", "routed", detail, meta);
      });
    } catch (err) {
      if (err instanceof Error && err.message === NOTIFICATION_LEASE_CHANGED) {
        throw err;
      }
      // Slack may already have accepted the post. If the audit append failed,
      // make a best-effort lease release so a later HubSpot retry does not
      // duplicate the user-visible notification. The rollback restored the
      // pre-transaction notify_pending_at, so expectedLeaseAt still identifies
      // this caller's claim.
      try {
        this.markExternalNotification(
          eventKey,
          receipts,
          err,
          expectedLeaseAt,
          markOptions,
        );
      } catch (releaseErr) {
        throw new Error(
          `notification audit append failed and lease release also failed: ${
            releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
          }; original failure: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      throw err;
    }
  }

  recordReadinessNotificationEvent(
    claim: ReadinessNotificationClaim,
    mode: "dry_run" | "live",
    receipts: Array<{
      system: string;
      externalId: string;
      detail: string;
      status?: "ok" | "warning";
      url?: string;
    }>,
  ): ReadinessNotificationDeliveryResult {
    const failed =
      receipts.length === 0 || receipts.some((receipt) => receipt.status === "warning");
    const warningDetail = failed
      ? receipts
          .filter((receipt) => receipt.status === "warning")
          .map((receipt) => receipt.detail)
          .join("; ") || "readiness notification returned no receipts"
      : null;

    return this.transactionImmediate(() => {
      const now = new Date().toISOString();
      let update: { changes?: number };
      if (failed) {
        update = this.db
          .prepare(
            `UPDATE deployment_readiness
             SET notify_status = CASE
                   WHEN notify_attempts + 1 >= ? THEN 'max_attempts_exceeded'
                   ELSE 'failed'
                 END,
                 notify_pending_at = NULL,
                 notify_attempts = notify_attempts + 1,
                 notify_error = ?,
                 updated_at = ?
             WHERE deal_id = ?
               AND last_notified_fingerprint = ?
               AND notify_status = 'pending'
               AND notify_pending_at = ?`,
          )
          .run(
            READINESS_NOTIFICATION_MAX_ATTEMPTS,
            warningDetail,
            now,
            claim.dealId,
            claim.fingerprint,
            claim.leaseAcquiredAt,
          ) as { changes?: number };
      } else {
        update = this.db
          .prepare(
            `UPDATE deployment_readiness
             SET notify_status = 'ok',
                 notify_pending_at = NULL,
                 notify_error = NULL,
                 updated_at = ?
             WHERE deal_id = ?
               AND last_notified_fingerprint = ?
               AND notify_status = 'pending'
               AND notify_pending_at = ?`,
          )
          .run(
            now,
            claim.dealId,
            claim.fingerprint,
            claim.leaseAcquiredAt,
          ) as { changes?: number };
      }
      if ((update.changes ?? 0) === 0) {
        this.appendEvent(
          claim.dealId,
          "routed",
          "routed",
          "deployment readiness notification superseded",
          {
            kind: "deployment_readiness_notification_superseded",
            mode,
            fingerprint: claim.fingerprint,
            previousReadiness: claim.previousReadiness,
            readiness: claim.readiness,
            blockerCode: claim.blockerCode,
            receipts,
          },
        );
        return { status: "lost_race", fallbackClaim: null };
      }

      const row = this.db
        .prepare(
          `SELECT notify_status
           FROM deployment_readiness
           WHERE deal_id = ?
             AND last_notified_fingerprint = ?`,
        )
        .get(claim.dealId, claim.fingerprint) as
        | { notify_status: ReadinessNotificationRecordStatus }
        | undefined;
      const status =
        row?.notify_status === "max_attempts_exceeded"
          ? "max_attempts_exceeded"
          : failed
            ? "failed"
            : "ok";
      const fallbackClaim =
        status === "max_attempts_exceeded"
          ? this.claimReadinessFallbackTx(
              claim.dealId,
              claim.fingerprint,
              new Date().toISOString(),
            )
          : null;
      this.appendEvent(
        claim.dealId,
        "routed",
        "routed",
        failed
          ? "deployment readiness notification failed"
          : "deployment readiness notification",
        {
          kind: "deployment_readiness_notification",
          mode,
          fingerprint: claim.fingerprint,
          previousReadiness: claim.previousReadiness,
          readiness: claim.readiness,
          blockerCode: claim.blockerCode,
          receipts,
        },
      );
      return { status, fallbackClaim };
    });
  }

  recordReadinessFallbackNotificationEvent(
    claim: ReadinessFallbackNotificationClaim,
    mode: "dry_run" | "live",
    receipts: Array<{
      system: string;
      externalId: string;
      detail: string;
      status?: "ok" | "warning";
      url?: string;
    }>,
  ): ReadinessFallbackNotificationDeliveryResult {
    const failed =
      receipts.length === 0 || receipts.some((receipt) => receipt.status === "warning");
    const warningDetail = failed
      ? receipts
          .filter((receipt) => receipt.status === "warning")
          .map((receipt) => receipt.detail)
          .join("; ") || "readiness fallback notification returned no receipts"
      : null;

    return this.transactionImmediate(() => {
      const now = new Date().toISOString();
      let update: { changes?: number };
      if (failed) {
        const status =
          claim.leaseGeneration >= FALLBACK_NOTIFICATION_MAX_ATTEMPTS
            ? "fallback_max_attempts_exceeded"
            : "failed";
        update = this.db
          .prepare(
            `UPDATE external_event_keys
             SET notify_status=?,
                 notify_pending_at=NULL,
                 notified_at=?,
                 notify_error=?
             WHERE key=?
               AND scope='readiness_fallback'
               AND notify_status='pending'
               AND notify_leases=?
               AND notify_pending_at=?`,
          )
          .run(
            status,
            now,
            warningDetail,
            claim.fallbackKey,
            claim.leaseGeneration,
            claim.leaseAcquiredAt,
          ) as { changes?: number };
      } else {
        update = this.db
          .prepare(
            `UPDATE external_event_keys
             SET notify_status='ok',
                 notify_pending_at=NULL,
                 notified_at=?,
                 notify_error=NULL
             WHERE key=?
               AND scope='readiness_fallback'
               AND notify_status='pending'
               AND notify_leases=?
               AND notify_pending_at=?`,
          )
          .run(
            now,
            claim.fallbackKey,
            claim.leaseGeneration,
            claim.leaseAcquiredAt,
          ) as { changes?: number };
      }
      if ((update.changes ?? 0) === 0) {
        this.appendEvent(
          claim.dealId,
          "routed",
          "routed",
          "deployment handoff fallback notification superseded",
          {
            kind: "deployment_handoff_failed_superseded",
            mode,
            fingerprint: claim.fingerprint,
            fallbackKey: claim.fallbackKey,
            readiness: claim.readiness,
            errorClass: claim.errorClass,
            receipts,
          },
        );
        return { status: "lost_race" };
      }
      const row = this.db
        .prepare(
          `SELECT notify_status
           FROM external_event_keys
           WHERE key=?`,
        )
        .get(claim.fallbackKey) as
        | { notify_status: ReadinessFallbackNotificationDeliveryResult["status"] }
        | undefined;
      const status = row?.notify_status ?? (failed ? "failed" : "ok");
      this.appendEvent(
        claim.dealId,
        "routed",
        "routed",
        failed
          ? "deployment handoff fallback notification failed"
          : "deployment handoff fallback notification",
        {
          kind: "deployment_handoff_failed",
          mode,
          fingerprint: claim.fingerprint,
          fallbackKey: claim.fallbackKey,
          readiness: claim.readiness,
          errorClass: claim.errorClass,
          receipts,
        },
      );
      return { status };
    });
  }

  recordCommercialTerminalDriftAlertEvent(
    claim: CommercialTerminalDriftAlertClaim,
    mode: "dry_run" | "live",
    receipts: Array<{
      system: string;
      externalId: string;
      detail: string;
      status?: "ok" | "warning";
      url?: string;
    }>,
  ): CommercialTerminalDriftAlertDeliveryResult {
    const failed =
      receipts.length === 0 || receipts.some((receipt) => receipt.status === "warning");
    const failedStatus =
      claim.leaseGeneration >= TERMINAL_DRIFT_NOTIFICATION_MAX_ATTEMPTS
        ? "max_attempts_exceeded"
        : "failed";
    const status = failed ? failedStatus : "ok";
    try {
      this.recordExternalNotificationEvent(
        claim.dealId,
        failed
          ? "commercial terminal drift alert failed"
          : "commercial terminal drift alert",
        {
          kind: "commercial_terminal_drift",
          mode,
          alertKey: claim.alertKey,
          source: claim.source,
          sourceEventId: claim.sourceEventId,
          incomingCommercialState: claim.incomingCommercialState,
          currentCommercialState: claim.currentCommercialState,
          incomingOccurredAt: claim.incomingOccurredAt,
          currentOccurredAt: claim.currentOccurredAt,
          driftKind: claim.driftKind,
          tieResolutionDrift: claim.tieResolutionDrift,
          expectedRedPath: claim.expectedRedPath,
          receipts,
        },
        claim.alertKey,
        receipts,
        claim.leaseAcquiredAt,
        {
          emptyReceiptsStatus: failedStatus,
          failedStatus,
          notificationErrorFallback: "commercial terminal drift alert failed",
        },
      );
    } catch (err) {
      if (err instanceof Error && err.message === NOTIFICATION_LEASE_CHANGED) {
        this.appendEvent(
          claim.dealId,
          "routed",
          "routed",
          "commercial terminal drift alert superseded",
          {
            kind: "commercial_terminal_drift_superseded",
            mode,
            alertKey: claim.alertKey,
            source: claim.source,
            sourceEventId: claim.sourceEventId,
            incomingCommercialState: claim.incomingCommercialState,
            currentCommercialState: claim.currentCommercialState,
            incomingOccurredAt: claim.incomingOccurredAt,
            currentOccurredAt: claim.currentOccurredAt,
            driftKind: claim.driftKind,
            tieResolutionDrift: claim.tieResolutionDrift,
            expectedRedPath: claim.expectedRedPath,
            receipts,
          },
        );
        return { status: "lost_race" };
      }
      throw err;
    }
    return { status };
  }

  // ─── Read & projection surface ────────────────────────────────────────────
  private eventFromRow(r: Record<string, unknown>): PipelineEvent {
    let meta: PipelineEventMeta | undefined;
    if (typeof r.meta === "string" && r.meta.length > 0) {
      try {
        meta = JSON.parse(r.meta) as PipelineEventMeta;
      } catch {
        meta = undefined;
      }
    }
    return {
      id: Number(r.id),
      dealId: String(r.deal_id),
      ts: String(r.ts),
      from: r.from_st as Stage | "-",
      to: r.to_st as Stage,
      detail: String(r.detail),
      ...(meta ? { meta } : {}),
    };
  }

  events(dealId?: string, limit?: number): PipelineEvent[] {
    const cappedLimit =
      limit === undefined ? undefined : Math.max(1, Math.min(MAX_EVENT_TAIL, limit));
    let rows: unknown[];
    if (dealId && cappedLimit !== undefined) {
      rows = this.db
        .prepare(
          "SELECT id, deal_id, ts, from_st, to_st, detail, meta FROM events WHERE deal_id = ? ORDER BY id DESC LIMIT ?",
        )
        .all(dealId, cappedLimit)
        .reverse();
    } else if (dealId) {
      rows = this.db
        .prepare(
          "SELECT id, deal_id, ts, from_st, to_st, detail, meta FROM events WHERE deal_id = ? ORDER BY id DESC LIMIT ?",
        )
        .all(dealId, MAX_EVENT_TAIL)
        .reverse();
    } else if (cappedLimit !== undefined) {
      rows = this.db
        .prepare(
          "SELECT id, deal_id, ts, from_st, to_st, detail, meta FROM events ORDER BY id DESC LIMIT ?",
        )
        .all(cappedLimit)
        .reverse();
    } else {
      rows = this.db
        .prepare(
          "SELECT id, deal_id, ts, from_st, to_st, detail, meta FROM events ORDER BY id",
        )
        .all();
    }
    return (rows as Record<string, unknown>[]).map((r) => this.eventFromRow(r));
  }

  eventsBookended(
    dealId: string,
    limit: number,
  ): { events: PipelineEvent[]; total: number; truncated: boolean } {
    const cappedLimit = Math.max(2, Math.min(1000, limit));
    const total = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) n FROM events WHERE deal_id = ?")
          .get(dealId) as { n: number }
      ).n,
    );
    if (total <= cappedLimit) {
      return { events: this.events(dealId), total, truncated: false };
    }
    const first = this.db
      .prepare(
        "SELECT id, deal_id, ts, from_st, to_st, detail, meta FROM events WHERE deal_id = ? ORDER BY id LIMIT 1",
      )
      .get(dealId) as Record<string, unknown> | undefined;
    const recent = this.db
      .prepare(
        "SELECT id, deal_id, ts, from_st, to_st, detail, meta FROM events WHERE deal_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(dealId, cappedLimit - 1)
      .reverse() as Record<string, unknown>[];
    const rows = first ? [first, ...recent] : recent;
    return {
      events: rows.map((row) => this.eventFromRow(row)),
      total,
      truncated: true,
    };
  }

  routed(limit?: number): RoutedDeal[] {
    return this.routedRecords(limit).map((record) => record.deal);
  }

  routedByIds(dealIds: readonly string[]): RoutedDeal[] {
    return this.routedRecordsByIds(dealIds).map((record) => record.deal);
  }

  routedRecords(
    limit?: number,
  ): RoutedRecord[] {
    const cappedLimit =
      limit === undefined ? undefined : Math.max(1, Math.min(1000, limit));
    // id is only a deterministic tie-breaker for equal-millisecond updates.
    const rows =
      cappedLimit === undefined
        ? (this.db
            .prepare(
              `SELECT payload, updated_at, sink_status, external_system,
                      external_id, external_stage_id, external_stage_label,
                      external_stage_updated_at
               FROM deals
               WHERE stage='routed'
               ORDER BY updated_at DESC, id DESC`,
            )
            .all() as RoutedRecordRow[])
        : (this.db
            .prepare(
              `SELECT payload, updated_at, sink_status, external_system,
                      external_id, external_stage_id, external_stage_label,
                      external_stage_updated_at
               FROM deals
               WHERE stage='routed'
               ORDER BY updated_at DESC, id DESC
               LIMIT ?`,
            )
            .all(cappedLimit) as RoutedRecordRow[]);
    return rows.map((r) => this.routedRecordFromRow(r));
  }

  private routedRecordFromRow(r: RoutedRecordRow): RoutedRecord {
    return {
      deal: JSON.parse(r.payload) as RoutedDeal,
      updatedAt: r.updated_at,
      sinkStatus:
        r.sink_status === "synced" ||
        r.sink_status === "partial" ||
        r.sink_status === "dry_run"
          ? r.sink_status
          : "needs_review",
      externalStage: this.externalStageFromRow(r),
    };
  }

  private routedRecordsByIds(dealIds: readonly string[]): RoutedRecord[] {
    if (dealIds.length === 0) return [];
    const records: RoutedRecord[] = [];
    for (let i = 0; i < dealIds.length; i += ROLE_QUEUE_MAX_SCAN) {
      const chunk = dealIds.slice(i, i + ROLE_QUEUE_MAX_SCAN);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT payload, updated_at, sink_status, external_system,
                  external_id, external_stage_id, external_stage_label,
                  external_stage_updated_at
           FROM deals
           WHERE stage='routed'
             AND id IN (${placeholders})`,
        )
        .all(...chunk) as RoutedRecordRow[];
      records.push(...rows.map((row) => this.routedRecordFromRow(row)));
    }
    return records;
  }

  private externalStageFromRow(r: {
    external_system: string | null;
    external_id: string | null;
    external_stage_id: string | null;
    external_stage_label: string | null;
    external_stage_updated_at: string | null;
  }): ExternalStageState | null {
    return r.external_system === "hubspot" &&
      r.external_id &&
      r.external_stage_id &&
      r.external_stage_updated_at
      ? {
          system: "hubspot",
          externalId: r.external_id,
          stageId: r.external_stage_id,
          stageLabel: r.external_stage_label,
          updatedAt: r.external_stage_updated_at,
        }
      : null;
  }

  quarantined(limit?: number): Quarantine[] {
    return this.quarantinedRecords(limit).map((record) => record.quarantine);
  }

  quarantinedRecords(
    limit?: number,
  ): QuarantinedRecord[] {
    const cappedLimit =
      limit === undefined ? undefined : Math.max(1, Math.min(1000, limit));
    const rows =
      cappedLimit === undefined
        ? (this.db
            .prepare(
              `SELECT quarantine, updated_at, external_system, external_id,
                      external_stage_id, external_stage_label,
                      external_stage_updated_at, payload
               FROM deals WHERE stage='quarantined' ORDER BY updated_at DESC`,
            )
            .all() as Array<{
            quarantine: string;
            payload: string | null;
            updated_at: string;
            external_system: string | null;
            external_id: string | null;
            external_stage_id: string | null;
            external_stage_label: string | null;
            external_stage_updated_at: string | null;
          }>)
        : (this.db
            .prepare(
              `SELECT quarantine, updated_at, external_system, external_id,
                      external_stage_id, external_stage_label,
                      external_stage_updated_at, payload
               FROM deals WHERE stage='quarantined' ORDER BY updated_at DESC LIMIT ?`,
            )
            .all(cappedLimit) as Array<{
            quarantine: string;
            payload: string | null;
            updated_at: string;
            external_system: string | null;
            external_id: string | null;
            external_stage_id: string | null;
            external_stage_label: string | null;
            external_stage_updated_at: string | null;
          }>);
    return rows.map((r) => ({
      quarantine: JSON.parse(r.quarantine) as Quarantine,
      deal: dealFromPayload(r.payload),
      routedDeal: routedDealFromPayload(r.payload),
      updatedAt: r.updated_at,
      externalStage: this.externalStageFromRow(r),
    }));
  }

  quarantinedDeal(dealId: string): {
    quarantine: Quarantine;
    deal: Deal | null;
    routedDeal: RoutedDeal | null;
    updatedAt: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT quarantine, payload, updated_at
         FROM deals
         WHERE id = ?
           AND stage = 'quarantined'`,
      )
      .get(dealId) as
      | { quarantine: string; payload: string | null; updated_at: string }
      | undefined;
    return row
      ? {
          quarantine: JSON.parse(row.quarantine) as Quarantine,
          deal: dealFromPayload(row.payload),
          routedDeal: routedDealFromPayload(row.payload),
          updatedAt: row.updated_at,
        }
      : null;
  }

  intakeLabels(dealIds: string[]): Map<string, string> {
    if (dealIds.length === 0) return new Map();
    const labels = new Map<string, string>();
    const placeholders = dealIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT e.deal_id, e.detail
         FROM events e
         JOIN (
           SELECT deal_id, MIN(id) id
           FROM events
           WHERE deal_id IN (${placeholders})
             AND to_st='intake'
             AND detail LIKE 'intake: %'
           GROUP BY deal_id
         ) first ON first.id = e.id`,
      )
      .all(...dealIds) as Array<{ deal_id: string; detail: string }>;
    for (const row of rows) {
      labels.set(row.deal_id, row.detail.slice("intake: ".length));
    }
    return labels;
  }

  roleQueues(
    limit = 50,
    readinessRecords?: DeploymentReadinessState[],
  ): RoleQueues {
    const perQueueLimit = Math.max(1, Math.min(250, limit));
    const scanLimit = Math.min(
      ROLE_QUEUE_MAX_SCAN,
      Math.max(100, perQueueLimit * 6),
    );
    const queues = emptyRoleQueues();
    const readinessRows = readinessRecords ?? this.deploymentReadinessRecords();
    const recentRoutedRecords = this.routedRecords(scanLimit);
    const recentRoutedDealIds = new Set(
      recentRoutedRecords.map((record) => record.deal.id),
    );
    const missingReadinessDealIds = readinessRows
      .filter(
        (record) =>
          (record.readiness === "pending" || record.readiness === "blocked") &&
          !recentRoutedDealIds.has(record.dealId),
      )
      .slice(0, ROLE_QUEUE_MAX_SCAN)
      .map((record) => record.dealId);
    const openActionDealIds = (
      this.db
        .prepare(
          `SELECT d.id
           FROM deals d
           LEFT JOIN commercial_states cs ON cs.deal_id = d.id
           WHERE d.stage = 'routed'
             AND d.route_kind = 'human_assisted'
             AND (
               cs.commercial_state IS NULL OR
               cs.commercial_state NOT IN ('closed_won', 'closed_lost')
             )
           ORDER BY
             CASE
               WHEN d.deal_usd >= ?
                 OR d.finance_flag IS NOT NULL
                 OR d.legal_flag IS NOT NULL
               THEN 0 ELSE 1
             END,
             d.deal_usd DESC,
             d.updated_at DESC,
             d.id
           LIMIT ?`,
        )
        .all(ROLE_QUEUE_HIGH_PRIORITY_USD, ROLE_QUEUE_MAX_SCAN) as Array<{
        id: string;
      }>
    )
      .map((row) => row.id)
      .filter((dealId) => !recentRoutedDealIds.has(dealId));
    const backfillDealIds = Array.from(
      new Set([...missingReadinessDealIds, ...openActionDealIds]),
    );
    const routedRecords = [
      ...recentRoutedRecords,
      ...this.routedRecordsByIds(backfillDealIds),
    ];
    const dealIds = routedRecords.map((record) => record.deal.id);
    const routedById = new Map(
      routedRecords.map((record) => [record.deal.id, record] as const),
    );
    const commercialRows: Record<string, unknown>[] = [];
    for (let i = 0; i < dealIds.length; i += ROLE_QUEUE_MAX_SCAN) {
      const chunk = dealIds.slice(i, i + ROLE_QUEUE_MAX_SCAN);
      if (chunk.length === 0) continue;
      commercialRows.push(
        ...(this.db
          .prepare(
            `SELECT *
             FROM commercial_states
             WHERE deal_id IN (${chunk.map(() => "?").join(", ")})`,
          )
          .all(...chunk) as Record<string, unknown>[]),
      );
    }
    const commercialByDeal = new Map(
      commercialRows.map((row) => [
        String(row.deal_id),
        this.commercialStateFromRow(row),
      ] as const),
    );
    const readinessByDeal = new Map(
      readinessRows.map((record) => [record.dealId, record] as const),
    );

    for (const record of routedRecords) {
      const deal = record.deal;
      const commercial = commercialByDeal.get(deal.id) ?? null;
      const commercialStatus = commercial?.commercialState ?? "no_commercial_state";
      const readiness = readinessByDeal.get(deal.id);
      const updatedAt = newestTimestamp(record.updatedAt, [
        commercial?.updatedAt,
        readiness?.updatedAt,
      ]);

      const terminal =
        commercial !== null && isTerminalCommercialState(commercial.commercialState);
      if (deal.route.kind === "human_assisted" && !terminal) {
        const priority = actionRolePriority(deal);
        queues.ae_attention.push(
          roleQueueItem(
            deal,
            "ae_attention",
            priority,
            "human-assisted deal needs owner touch",
            commercialStatus,
            updatedAt,
          ),
        );

        if (deal.route.financeFlag === "pricing_approval") {
          queues.finance_review.push(
            roleQueueItem(
              deal,
              "finance_review",
              priority,
              "pricing approval required before close",
              commercialStatus,
              updatedAt,
            ),
          );
        }
        if (deal.route.legalFlag === "regulated_review") {
          queues.legal_review.push(
            roleQueueItem(
              deal,
              "legal_review",
              priority,
              "regulated review required before close",
              commercialStatus,
              updatedAt,
            ),
          );
        }
      }

      queues.growth_attribution.push(
        roleQueueItem(
          deal,
          "growth_attribution",
          "low",
          `source ${deal.sourceChannel}; route ${deal.route.kind}`,
          commercialStatus,
          updatedAt,
        ),
      );
    }

    for (const readiness of readinessRows) {
      if (
        readiness.readiness === "not_required" ||
        readiness.readiness === "ready"
      ) {
        continue;
      }
      const record = routedById.get(readiness.dealId);
      if (!record) continue;
      const priority =
        readiness.readiness === "blocked" ? "high" : "medium";
      queues.deployment_readiness.push(
        roleQueueItem(
          record.deal,
          "deployment_readiness",
          priority,
          readiness.reason ?? readiness.blockerCode ?? readiness.readiness,
          readiness.readiness,
          newestTimestamp(record.updatedAt, [readiness.updatedAt]),
        ),
      );
    }

    return {
      ae_attention: sortRoleQueue(queues.ae_attention).slice(0, perQueueLimit),
      finance_review: sortRoleQueue(queues.finance_review).slice(0, perQueueLimit),
      legal_review: sortRoleQueue(queues.legal_review).slice(0, perQueueLimit),
      deployment_readiness: sortRoleQueue(queues.deployment_readiness).slice(
        0,
        perQueueLimit,
      ),
      growth_attribution: sortRoleQueue(queues.growth_attribution).slice(
        0,
        perQueueLimit,
      ),
    };
  }

  // ─── Policy evaluation — reports + recommendation-run writes ──────────────
  private policySignalBackfillDealIds(limit: number, now: string): string[] {
    const cappedLimit = Math.max(1, Math.min(ROLE_QUEUE_MAX_SCAN, limit));
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) {
      throw new Error(`invalid policy evaluation timestamp: ${now}`);
    }
    const stalledCutoff = new Date(
      nowMs - POLICY_CLOSED_WON_STALLED_SLA_HOURS * 3_600_000,
    ).toISOString();
    const ids: string[] = [];
    const collect = (rows: Array<{ id: string }>): void => {
      for (const row of rows) ids.push(row.id);
    };

    // Each signal type gets its own budget so expansion-heavy data cannot
    // crowd out churn or stalled-deployment signals.
    collect(
      this.db
        .prepare(
          `SELECT d.id
           FROM deals d
           WHERE d.stage='routed'
             AND d.route_kind='self_serve'
             AND EXISTS (
               SELECT 1
               FROM outcome_events oe
               WHERE oe.deal_id = d.id
                 AND oe.outcome = 'expanded'
                 AND COALESCE(oe.arr_delta_usd, 0) > 0
             )
           ORDER BY d.deal_usd DESC, d.updated_at DESC, d.id
           LIMIT ?`,
        )
        .all(cappedLimit) as Array<{ id: string }>,
    );
    collect(
      this.db
        .prepare(
          `SELECT d.id
           FROM deals d
           WHERE d.stage='routed'
             AND d.route_kind='human_assisted'
             AND EXISTS (
               SELECT 1
               FROM outcome_events oe
               WHERE oe.deal_id = d.id
                 AND oe.outcome = 'churned'
             )
           ORDER BY d.deal_usd DESC, d.updated_at DESC, d.id
           LIMIT ?`,
        )
        .all(cappedLimit) as Array<{ id: string }>,
    );
    collect(
      this.db
        .prepare(
          `SELECT d.id
           FROM deals d
           JOIN commercial_states cs ON cs.deal_id = d.id
           LEFT JOIN deployment_readiness dr ON dr.deal_id = d.id
           WHERE d.stage='routed'
             AND d.route_kind='human_assisted'
             AND cs.commercial_state = 'closed_won'
             AND cs.occurred_at <= ?
             AND NOT EXISTS (
               SELECT 1
               FROM outcome_events oe
               WHERE oe.deal_id = d.id
                 AND oe.outcome = 'deployment_started'
             )
             AND (
               dr.readiness IS NULL OR
               dr.readiness IN ('pending', 'blocked', 'ready')
             )
           ORDER BY d.deal_usd DESC, d.updated_at DESC, d.id
           LIMIT ?`,
        )
        .all(stalledCutoff, cappedLimit) as Array<{ id: string }>,
    );

    return Array.from(new Set(ids));
  }

  policyEvaluation(
    limit = 50,
    readinessRecords?: DeploymentReadinessState[],
    now = new Date().toISOString(),
  ): PolicyEvaluationReports {
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) {
      throw new Error(`invalid policy evaluation timestamp: ${now}`);
    }
    const reportLimit = Math.max(1, Math.min(250, limit));
    const candidateLimit = Math.min(
      ROLE_QUEUE_MAX_SCAN,
      Math.max(100, reportLimit * 10),
    );
    const recentRoutedRecords = this.routedRecords(candidateLimit);
    const readinessRows = readinessRecords ?? this.deploymentReadinessRecords();
    const recentRoutedDealIds = new Set(
      recentRoutedRecords.map((record) => record.deal.id),
    );
    const signalBackfillDealIds = this.policySignalBackfillDealIds(
      ROLE_QUEUE_MAX_SCAN,
      now,
    ).filter((dealId) => !recentRoutedDealIds.has(dealId));
    const routedRecords = [
      ...recentRoutedRecords,
      ...this.routedRecordsByIds(signalBackfillDealIds),
    ];
    const dealIds = routedRecords.map((record) => record.deal.id);
    const commercialRows: Record<string, unknown>[] = [];
    const outcomeRows: Record<string, unknown>[] = [];
    for (let i = 0; i < dealIds.length; i += ROLE_QUEUE_MAX_SCAN) {
      const chunk = dealIds.slice(i, i + ROLE_QUEUE_MAX_SCAN);
      if (chunk.length === 0) continue;
      const placeholders = chunk.map(() => "?").join(", ");
      commercialRows.push(
        ...(this.db
          .prepare(
            `SELECT *
             FROM commercial_states
             WHERE deal_id IN (${placeholders})`,
          )
          .all(...chunk) as Record<string, unknown>[]),
      );
      outcomeRows.push(
        ...(this.db
          .prepare(
            `SELECT *
             FROM outcome_events
             WHERE deal_id IN (${placeholders})
             ORDER BY deal_id, occurred_at, created_at, id`,
          )
          .all(...chunk) as Record<string, unknown>[]),
      );
    }
    const commercialByDeal = new Map(
      commercialRows.map((row) => [
        String(row.deal_id),
        this.commercialStateFromRow(row),
      ] as const),
    );
    const readinessByDeal = new Map(
      readinessRows.map((record) => [
        record.dealId,
        record,
      ] as const),
    );
    const outcomesByDeal = new Map<string, OutcomeEventRecord[]>();
    for (const row of outcomeRows) {
      const outcome = this.outcomeEventFromRow(row);
      const existing = outcomesByDeal.get(outcome.dealId) ?? [];
      existing.push(outcome);
      outcomesByDeal.set(outcome.dealId, existing);
    }

    const sourceSummaries = new Map(
      SOURCE_CHANNELS.map((sourceChannel) => [
        sourceChannel,
        {
          sourceChannel,
          routed: 0,
          closedWon: 0,
          deploymentStarted: 0,
          deployed: 0,
          landed: 0,
          expanded: 0,
          churned: 0,
          expandedArrDeltaUsd: 0,
        } satisfies SourceChannelPolicySummary,
      ] as const),
    );
    const getSourceSummary = (
      sourceChannel: SourceChannelPolicySummary["sourceChannel"],
    ): SourceChannelPolicySummary => {
      const summary = sourceSummaries.get(sourceChannel);
      if (!summary) {
        throw new Error(`missing policy source summary for ${sourceChannel}`);
      }
      return summary;
    };
    const flagSummaries = new Map<PolicyFlag, FlagPolicySummary>(
      (["pricing_approval", "regulated_review"] as const).map((flag) => [
        flag,
        {
          flag,
          routed: 0,
          closedWon: 0,
          deploymentStarted: 0,
          deployed: 0,
          landed: 0,
          expanded: 0,
          churned: 0,
          expandedArrDeltaUsd: 0,
        },
      ]),
    );
    const getFlagSummary = (flag: PolicyFlag): FlagPolicySummary => {
      const summary = flagSummaries.get(flag);
      if (!summary) {
        throw new Error(`missing policy flag summary for ${flag}`);
      }
      return summary;
    };
    const selfServeExpanded: PolicyEvaluationDeal[] = [];
    const humanAssistedRisk: PolicyEvaluationDeal[] = [];
    const policyStalledCutoffMs =
      nowMs - POLICY_CLOSED_WON_STALLED_SLA_HOURS * 3_600_000;

    const applyLifecycle = (
      summary: SourceChannelPolicySummary | FlagPolicySummary,
      commercial: CommercialStateRecord | null,
      outcomes: OutcomeEventRecord[],
    ): void => {
      summary.routed += 1;
      if (commercial?.commercialState === "closed_won") summary.closedWon += 1;
      const outcomeKinds = new Set(outcomes.map((outcome) => outcome.outcome));
      if (outcomeKinds.has("deployment_started")) summary.deploymentStarted += 1;
      if (outcomeKinds.has("deployed")) summary.deployed += 1;
      if (outcomeKinds.has("landed")) summary.landed += 1;
      if (outcomeKinds.has("expanded")) summary.expanded += 1;
      if (outcomeKinds.has("churned")) summary.churned += 1;
      summary.expandedArrDeltaUsd += expandedArrDelta(outcomes);
    };

    for (const record of routedRecords) {
      const deal = record.deal;
      const commercial = commercialByDeal.get(deal.id) ?? null;
      const readiness = readinessByDeal.get(deal.id) ?? null;
      const outcomes = outcomesByDeal.get(deal.id) ?? [];
      const expandedArrDeltaUsd = expandedArrDelta(outcomes);
      const latestOutcomeAt = lastOutcomeAt(outcomes);
      const latestExpandedAt = lastOutcomeAt(
        outcomes.filter((outcome) => outcome.outcome === "expanded"),
      );
      const latestChurnedAt = lastOutcomeAt(
        outcomes.filter((outcome) => outcome.outcome === "churned"),
      );
      const closedWonRiskObservedAt =
        commercial?.commercialState === "closed_won"
          ? new Date(
              Date.parse(commercial.occurredAt) +
                POLICY_CLOSED_WON_STALLED_SLA_HOURS * 3_600_000,
            ).toISOString()
          : null;
      const sourceSummary = sourceSummaries.get(deal.sourceChannel);
      if (sourceSummary) applyLifecycle(sourceSummary, commercial, outcomes);

      if (deal.route.kind === "human_assisted") {
        if (deal.route.financeFlag === "pricing_approval") {
          applyLifecycle(
            getFlagSummary("pricing_approval"),
            commercial,
            outcomes,
          );
        }
        if (deal.route.legalFlag === "regulated_review") {
          applyLifecycle(
            getFlagSummary("regulated_review"),
            commercial,
            outcomes,
          );
        }
      }

      if (deal.route.kind === "self_serve" && expandedArrDeltaUsd > 0) {
        selfServeExpanded.push({
          dealId: deal.id,
          company: deal.company,
          amount: deal.dealUSD,
          routeKind: deal.route.kind,
          sourceChannel: deal.sourceChannel,
          salesOwner: null,
          signal: "self_serve_expanded",
          signalObservedAt: latestExpandedAt ?? latestOutcomeAt ?? now,
          reason: `self-serve deal later expanded by $${expandedArrDeltaUsd.toLocaleString("en-US")}`,
          lastOutcomeAt: latestOutcomeAt,
          arrDeltaUsd: expandedArrDeltaUsd,
        });
      }

      if (deal.route.kind !== "human_assisted") continue;
      const churned = outcomes.some((outcome) => outcome.outcome === "churned");
      if (churned) {
        humanAssistedRisk.push({
          dealId: deal.id,
          company: deal.company,
          amount: deal.dealUSD,
          routeKind: deal.route.kind,
          sourceChannel: deal.sourceChannel,
          salesOwner: deal.route.salesOwner,
          signal: "human_assisted_churned",
          signalObservedAt: latestChurnedAt ?? latestOutcomeAt ?? now,
          reason: "human-assisted deal recorded churn",
          lastOutcomeAt: latestOutcomeAt,
          arrDeltaUsd: null,
        });
        // Churn is the terminal signal for this read-only risk list; do not
        // also emit a stalled row for the same deal.
        continue;
      }

      const deployedStarted = outcomes.some(
        (outcome) => outcome.outcome === "deployment_started",
      );
      const closedWonOldEnoughForRisk =
        commercial?.commercialState === "closed_won" &&
        Date.parse(commercial.occurredAt) <= policyStalledCutoffMs;
      if (
        closedWonOldEnoughForRisk &&
        !deployedStarted &&
        (readiness === null || readiness.readiness !== "not_required")
      ) {
        const signal =
          readiness?.readiness === "ready"
            ? "human_assisted_ready_not_started"
            : "human_assisted_stalled";
        const readinessReason =
          readiness?.reason ??
          readiness?.blockerCode ??
          (readiness?.readiness === "ready"
            ? "deployment ready but no deployment start recorded"
            : "closed won but deployment has not started");
        humanAssistedRisk.push({
          dealId: deal.id,
          company: deal.company,
          amount: deal.dealUSD,
          routeKind: deal.route.kind,
          sourceChannel: deal.sourceChannel,
          salesOwner: deal.route.salesOwner,
          signal,
          signalObservedAt: closedWonRiskObservedAt ?? now,
          reason: readinessReason,
          lastOutcomeAt: latestOutcomeAt,
          arrDeltaUsd: null,
        });
      }
    }

    return {
      candidateRouted: routedRecords.length,
      candidateLimit,
      signalBackfillRouted: signalBackfillDealIds.length,
      signalBackfillLimitPerSignal: ROLE_QUEUE_MAX_SCAN,
      selfServeExpanded: sortPolicyDeals(selfServeExpanded).slice(
        0,
        reportLimit,
      ),
      humanAssistedRisk: sortPolicyDeals(humanAssistedRisk).slice(
        0,
        reportLimit,
      ),
      sourceChannels: SOURCE_CHANNELS.map((channel) =>
        getSourceSummary(channel),
      ),
      flags: (["pricing_approval", "regulated_review"] as const).map(
        (flag) => getFlagSummary(flag),
      ),
    };
  }

  recordPolicyEvaluationRecommendations(
    input: PolicyRecommendationRunInput,
  ): PolicyRecommendationRunResult {
    assertCanonicalIsoUtc(input.evaluatedAt, "policy recommendation evaluatedAt");
    const createdBy = nonEmptyLabel(
      input.createdBy,
      "policy recommendation createdBy",
    );
    const limit = policyRecommendationLimit(input.limit);
    const prefetchLimit = Math.min(
      250,
      Math.max(limit * POLICY_RECOMMENDATION_PREFETCH_MULTIPLIER, limit),
    );
    const report = this.policyEvaluation(prefetchLimit, undefined, input.evaluatedAt);
    const candidates = sortPolicyRecommendationCandidates([
      ...report.humanAssistedRisk,
      ...report.selfServeExpanded,
    ]).slice(0, limit);

    // Audit rows are useful only if they describe exactly the suggestions that
    // committed, so a hard write error aborts the whole run instead of keeping
    // partial suggestions with no trustworthy parent record.
    return this.transactionImmediate(() => {
      const results = candidates.map((candidate) => {
        const suggestionInput: LocalAgentSuggestionInput = {
          dealId: candidate.dealId,
          sourceEventId: policyRecommendationSourceEventId(candidate),
          kind: "policy_change_recommendation",
          title: policyRecommendationTitle(candidate),
          body: policyRecommendationBody(candidate),
          rationale: policyRecommendationRationale(candidate),
          createdBy,
          occurredAt: candidate.signalObservedAt,
        };
        const result =
          this.recordLocalAgentSuggestionInTransaction(suggestionInput);
        return {
          dealId: candidate.dealId,
          signal: candidate.signal,
          sourceEventId: suggestionInput.sourceEventId,
          status: result.status,
          suggestionId: result.suggestion?.id ?? null,
          title: suggestionInput.title,
        };
      });

      const statusCounts = emptyAgentSuggestionWriteStatusCounts();
      for (const result of results) {
        statusCounts[result.status] += 1;
      }
      const recorded = statusCounts.recorded;
      const duplicate = statusCounts.duplicate;
      const idempotencyConflict = statusCounts.idempotency_conflict;
      const skipped = statusCounts.not_found + statusCounts.not_routed;
      const status = agentSuggestionRunStatus({
        recorded,
        duplicate,
        idempotencyConflict,
        skipped,
      });
      const createdAt = new Date().toISOString();
      const runId = `PRR-${randomUUID()}`;
      const run: PolicyRecommendationRunResult = {
        id: runId,
        status,
        createdBy,
        limit,
        evaluatedAt: input.evaluatedAt,
        createdAt,
        attempted: results.length,
        recorded,
        duplicate,
        idempotencyConflict,
        skipped,
        statusCounts,
        results,
      };
      this.insertPolicyRecommendationRun(run);
      return run;
    });
  }

  private insertPolicyRecommendationRun(run: PolicyRecommendationRunResult): void {
    this.db
      .prepare(
        `INSERT INTO policy_recommendation_runs (
           id, status, created_by, evaluated_at, limit_count, attempted,
           recorded, duplicate, idempotency_conflict, skipped,
           status_counts_json, results_json, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.status,
        run.createdBy,
        run.evaluatedAt,
        run.limit,
        run.attempted,
        run.recorded,
        run.duplicate,
        run.idempotencyConflict,
        run.skipped,
        JSON.stringify(run.statusCounts),
        JSON.stringify(run.results),
        run.createdAt,
      );
  }

  private policyRecommendationRunFromRow(
    row: Record<string, unknown>,
  ): PolicyRecommendationRunRecord {
    return {
      id: String(row.id),
      status: AgentSuggestionRunStatusSchema.parse(row.status),
      createdBy: String(row.created_by),
      evaluatedAt: String(row.evaluated_at),
      limit: Number(row.limit_count),
      createdAt: String(row.created_at),
      attempted: Number(row.attempted),
      recorded: Number(row.recorded),
      duplicate: Number(row.duplicate),
      idempotencyConflict: Number(row.idempotency_conflict),
      skipped: Number(row.skipped),
      statusCounts: AgentSuggestionWriteStatusCounts.parse(
        JSON.parse(String(row.status_counts_json)),
      ),
      results: PolicyRecommendationDraftResultSchema.array().parse(
        JSON.parse(String(row.results_json)),
      ),
    };
  }

  // ─── Deployment readiness projection ──────────────────────────────────────
  deploymentReadinessRecords(
    now = new Date().toISOString(),
  ): DeploymentReadinessState[] {
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) {
      throw new Error(`invalid readiness state timestamp: ${now}`);
    }
    const rows = this.db
      .prepare(
        `SELECT
           dr.deal_id, dr.readiness, dr.blocker_code,
           dr.secondary_blocker_codes, dr.reason, dr.state_entered_at,
           dr.blocker_entered_at, dr.updated_at, dr.notify_status,
           df.occurred_at facts_occurred_at
         FROM deployment_readiness dr
         LEFT JOIN deployment_facts df ON df.deal_id = dr.deal_id
         ORDER BY dr.updated_at DESC, dr.deal_id`,
      )
      .all() as Array<{
      deal_id: string;
      readiness: DeploymentReadiness;
      blocker_code: DeploymentBlocker | null;
      secondary_blocker_codes: string | null;
      reason: string | null;
      state_entered_at: string;
      blocker_entered_at: string | null;
      updated_at: string;
      notify_status: DeploymentReadinessNotifyStatus | null;
      facts_occurred_at: string | null;
    }>;

    return rows.map((row) => ({
      dealId: row.deal_id,
      readiness: row.readiness,
      blockerCode: row.blocker_code,
      secondaryBlockerCodes: parseSecondaryBlockerCodes(
        row.secondary_blocker_codes,
      ),
      reason: row.reason,
      stateEnteredAt: row.state_entered_at,
      blockerEnteredAt: row.blocker_entered_at,
      updatedAt: row.updated_at,
      notifyStatus: row.notify_status,
      ...factFreshness(row.readiness, row.facts_occurred_at, nowMs),
    }));
  }

  // ─── Aggregate metrics ────────────────────────────────────────────────────
  metrics(): Metrics {
    const count = (
      sql: string,
      ...args: Array<string | number | bigint | null>
    ): number =>
      Number((this.db.prepare(sql).get(...args) as { n: number }).n);

    const intake = count("SELECT COUNT(*) n FROM deals");
    const routed = count("SELECT COUNT(*) n FROM deals WHERE stage='routed'");
    const quarantined = count(
      "SELECT COUNT(*) n FROM deals WHERE stage='quarantined'",
    );

    const routeMix = { nurture: 0, self_serve: 0, human_assisted: 0 };
    const arrByRoute = { nurture: 0, self_serve: 0, human_assisted: 0 };
    const routeRows = this.db
      .prepare(
        `SELECT route_kind kind, COUNT(*) n, COALESCE(SUM(deal_usd), 0) arr
         FROM deals
         WHERE stage='routed'
         GROUP BY route_kind`,
      )
      .all() as Array<{ kind: keyof Metrics["routeMix"]; n: number; arr: number }>;
    for (const row of routeRows) {
      if (row.kind in routeMix) {
        routeMix[row.kind] = Number(row.n);
        arrByRoute[row.kind] = Number(row.arr);
      }
    }
    const flags = {
      pricing_approval: count(
        "SELECT COUNT(*) n FROM deals WHERE stage='routed' AND finance_flag='pricing_approval'",
      ),
      regulated_review: count(
        "SELECT COUNT(*) n FROM deals WHERE stage='routed' AND legal_flag='regulated_review'",
      ),
    };
    const routedArrUsd =
      arrByRoute.nurture + arrByRoute.self_serve + arrByRoute.human_assisted;
    const externallySyncedStoreErrors = count(
      `SELECT COUNT(*) n
       FROM deals
       WHERE stage='quarantined'
         AND quarantine_code='store_error'
         AND sink_mode='live'`,
    );
    const partialSyncs = count(
      "SELECT COUNT(*) n FROM deals WHERE stage='routed' AND sink_status='partial'",
    );
    const stageNotificationAuditGaps = count(
      "SELECT COUNT(*) n FROM external_event_keys WHERE notify_error LIKE '%audit_append_failed:%'",
    );
    const deploymentReadiness: Record<DeploymentReadiness, number> = {
      not_required: 0,
      pending: 0,
      ready: 0,
      blocked: 0,
    };
    const readinessRows = this.db
      .prepare(
        `SELECT readiness, COUNT(*) n
         FROM deployment_readiness
         GROUP BY readiness`,
      )
      .all() as Array<{ readiness: DeploymentReadiness; n: number }>;
    for (const row of readinessRows) {
      if (row.readiness in deploymentReadiness) {
        deploymentReadiness[row.readiness] = Number(row.n);
      }
    }

    const nowMs = Date.now();
    const staleProjectedRows = this.db
      .prepare(
        `SELECT df.occurred_at
         FROM deployment_readiness dr
         LEFT JOIN deployment_facts df ON df.deal_id = dr.deal_id
         WHERE dr.readiness IN ('ready', 'blocked')`,
      )
      .all() as Array<{ occurred_at: string | null }>;
    const readinessFactsStaleProjected = staleProjectedRows.filter((row) => {
      const occurredAtMs = row.occurred_at ? Date.parse(row.occurred_at) : NaN;
      return (
        Number.isNaN(occurredAtMs) ||
        nowMs >= occurredAtMs + DEPLOYMENT_FACT_MAX_AGE_DAYS * DAY_MS
      );
    }).length;
    const pendingSlaCutoff = new Date(
      nowMs - READINESS_PENDING_SLA_HOURS * 3_600_000,
    ).toISOString();
    const readinessNotificationGaps = count(
      `SELECT COUNT(*) n
       FROM deployment_readiness dr
       WHERE dr.readiness IN ('pending', 'ready', 'blocked')
         AND dr.notify_status IS NOT NULL
         AND dr.notify_status != 'ok'
         AND (
           dr.notify_status != 'pending' OR
           dr.notify_pending_at <= ?
         )
         AND (
           dr.notify_status != 'max_attempts_exceeded' OR
           NOT EXISTS (
             SELECT 1
             FROM external_event_keys f
             WHERE f.key = 'readiness_fallback:' || dr.last_notified_fingerprint
               AND f.scope = 'readiness_fallback'
               AND f.notify_status = 'ok'
           )
         )`,
      new Date(nowMs - NOTIFY_PENDING_LEASE_MS).toISOString(),
    );
    const readinessPendingOverSla = count(
      `SELECT COUNT(*) n
       FROM deployment_readiness
       WHERE readiness='pending' AND state_entered_at <= ?`,
      pendingSlaCutoff,
    );
    const readinessFactsStaleIgnored = count(
      `SELECT COUNT(*) n
       FROM deployment_facts_rejections
       WHERE rejection_kind='age'`,
    );
    const commercialProjectionDrift = count(
      `SELECT COUNT(*) n
       FROM external_event_observations
       WHERE observation_code='commercial_regression_unsupported'`,
    );
    const commercialTerminalDriftAlerts = count(
      `SELECT COUNT(*) n
       FROM external_event_observations
       WHERE observation_code='terminal_drift_unsupported'`,
    );
    const commercialTerminalDriftNotificationGaps = count(
      `SELECT COUNT(*) n
       FROM external_event_keys
       WHERE scope='commercial_terminal_drift'
         AND notify_status != 'ok'
         AND (
           notify_status != 'pending' OR
           notify_pending_at <= ?
         )`,
      new Date(nowMs - TERMINAL_DRIFT_NOTIFICATION_LEASE_MS).toISOString(),
    );
    const commercialTerminalTieConflicts = count(
      `SELECT COUNT(*) n
       FROM external_event_observations
       WHERE observation_code='terminal_tie_conflict'`,
    );
    const notRoutedClosedWonStageEvents = count(
      `SELECT COUNT(*) n
       FROM external_event_observations
       WHERE observation_code='not_routed'
         AND mapped_commercial_state='closed_won'`,
    );

    const outcomeDealSets: Record<OutcomeState, Set<string>> = {
      deployment_started: new Set(),
      deployed: new Set(),
      landed: new Set(),
      expanded: new Set(),
      churned: new Set(),
    };
    let expandedArrDeltaUsd = 0;
    const outcomesByDeal = new Map<string, OutcomeMetricRow[]>();
    const outcomeRows = this.db
      .prepare(
        `SELECT id, deal_id, outcome, occurred_at, created_at, arr_delta_usd
         FROM outcome_events
         ORDER BY deal_id, occurred_at, created_at, id`,
      )
      .all() as Array<{
      id: string;
      deal_id: string;
      outcome: OutcomeState;
      occurred_at: string;
      created_at: string;
      arr_delta_usd: number | null;
    }>;
    for (const row of outcomeRows) {
      outcomeDealSets[row.outcome].add(row.deal_id);
      if (row.outcome === "expanded" && row.arr_delta_usd !== null) {
        expandedArrDeltaUsd += Number(row.arr_delta_usd);
      }
      const metricRow: OutcomeMetricRow = {
        id: row.id,
        dealId: row.deal_id,
        outcome: row.outcome,
        occurredAt: row.occurred_at,
        createdAt: row.created_at,
        arrDeltaUsd:
          row.arr_delta_usd === null ? null : Number(row.arr_delta_usd),
      };
      const existing = outcomesByDeal.get(metricRow.dealId) ?? [];
      existing.push(metricRow);
      outcomesByDeal.set(metricRow.dealId, existing);
    }

    const firstProjectedClosedWonAtByDeal = new Map<
      string,
      { occurredAt: string; occurredAtMs: number }
    >();
    // Use the customer-reported occurredAt from the append-only commercial-state
    // event, not the mutable commercial_states projection timestamp, so
    // cycle-time metrics survive projection refreshes and replays. Parse in JS
    // rather than using SQL text MIN so legacy non-canonical ISO rows still sort
    // chronologically; new writes are canonical at the store boundary.
    const commercialEventRows = this.db
      .prepare(
        `SELECT deal_id,
                CAST(json_extract(meta, '$.occurredAt') AS TEXT) occurred_at
         FROM events
         WHERE meta IS NOT NULL
           AND json_valid(meta)
           AND json_extract(meta, '$.kind') = 'commercial_state'
           AND json_extract(meta, '$.commercialState') = 'closed_won'
           AND json_extract(meta, '$.projected') = 1
           AND json_extract(meta, '$.occurredAt') IS NOT NULL
         ORDER BY deal_id, ts, id`,
      )
      .all() as Array<{ deal_id: string; occurred_at: string }>;
    for (const row of commercialEventRows) {
      const occurredAtMs = Date.parse(row.occurred_at);
      if (Number.isNaN(occurredAtMs)) continue;
      const existing = firstProjectedClosedWonAtByDeal.get(row.deal_id);
      if (!existing || occurredAtMs < existing.occurredAtMs) {
        firstProjectedClosedWonAtByDeal.set(row.deal_id, {
          occurredAt: row.occurred_at,
          occurredAtMs,
        });
      }
    }

    const commercialRows = this.db
      .prepare(
        `SELECT deal_id, commercial_state
         FROM commercial_states`,
      )
      .all() as Array<{
      deal_id: string;
      commercial_state: CommercialState;
    }>;
    const commercialByDeal = new Map<string, CommercialState>();
    for (const row of commercialRows) {
      commercialByDeal.set(row.deal_id, row.commercial_state);
    }
    const outcomeCommercialStateConflicts = [...outcomesByDeal.keys()].filter(
      (dealId) => commercialByDeal.get(dealId) !== "closed_won",
    ).length;
    const compareOutcomeRows = (
      a: OutcomeMetricRow,
      b: OutcomeMetricRow,
    ): number =>
      a.occurredAt.localeCompare(b.occurredAt) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id);
    const invalidOutcomeRowIds = new Set<string>();
    const closedWonToDeployedHours: number[] = [];
    const deployedToLandedHours: number[] = [];
    let outcomeChurnBeforeDeploy = 0;
    for (const [dealId, history] of outcomesByDeal) {
      history.sort(compareOutcomeRows);
      const seenNonExpandedOutcomes = new Set<Exclude<OutcomeState, "expanded">>();
      let sawChurn = false;
      let firstDeployed: OutcomeMetricRow | null = null;
      let firstLandedAfterDeployed: OutcomeMetricRow | null = null;
      let firstChurned: OutcomeMetricRow | null = null;

      for (const event of history) {
        if (sawChurn) {
          invalidOutcomeRowIds.add(event.id);
        }
        if (event.outcome !== "expanded") {
          if (seenNonExpandedOutcomes.has(event.outcome)) {
            invalidOutcomeRowIds.add(event.id);
          }
        }
        if (
          event.outcome === "deployed" &&
          !seenNonExpandedOutcomes.has("deployment_started")
        ) {
          invalidOutcomeRowIds.add(event.id);
        }
        if (
          event.outcome === "landed" &&
          !seenNonExpandedOutcomes.has("deployed")
        ) {
          invalidOutcomeRowIds.add(event.id);
        }
        if (
          event.outcome === "expanded" &&
          !seenNonExpandedOutcomes.has("landed")
        ) {
          invalidOutcomeRowIds.add(event.id);
        }
        if (
          event.outcome === "churned" &&
          !seenNonExpandedOutcomes.has("deployment_started")
        ) {
          invalidOutcomeRowIds.add(event.id);
        }

        if (event.outcome === "deployed" && firstDeployed === null) {
          firstDeployed = event;
        }
        if (
          event.outcome === "landed" &&
          firstDeployed !== null &&
          firstLandedAfterDeployed === null
        ) {
          firstLandedAfterDeployed = event;
        }
        if (event.outcome === "churned" && firstChurned === null) {
          firstChurned = event;
        }
        if (event.outcome !== "expanded") {
          seenNonExpandedOutcomes.add(event.outcome);
        }
        if (event.outcome === "churned") {
          sawChurn = true;
        }
      }

      if (
        firstChurned !== null &&
        (firstDeployed === null ||
          compareOutcomeRows(firstChurned, firstDeployed) < 0)
      ) {
        outcomeChurnBeforeDeploy += 1;
      }
      const hasInvalidHistory = history.some((event) =>
        invalidOutcomeRowIds.has(event.id),
      );
      const commercialState = commercialByDeal.get(dealId);
      if (
        !hasInvalidHistory &&
        firstDeployed !== null &&
        commercialState === "closed_won"
      ) {
        const closedWonAt =
          firstProjectedClosedWonAtByDeal.get(dealId)?.occurredAt;
        if (closedWonAt !== undefined) {
          const hours = hoursBetween(closedWonAt, firstDeployed.occurredAt);
          if (hours !== null) closedWonToDeployedHours.push(hours);
        }
      }
      if (
        !hasInvalidHistory &&
        firstDeployed !== null &&
        firstLandedAfterDeployed !== null
      ) {
        const hours = hoursBetween(
          firstDeployed.occurredAt,
          firstLandedAfterDeployed.occurredAt,
        );
        if (hours !== null) deployedToLandedHours.push(hours);
      }
    }

    const quarantineByCode = Object.fromEntries(
      QUARANTINE_CODES.map((c) => [c, 0]),
    ) as Record<QuarantineCode, number>;
    const quarantineRows = this.db
      .prepare(
        `SELECT quarantine_code code, COUNT(*) n
         FROM deals
         WHERE stage='quarantined'
         GROUP BY quarantine_code`,
      )
      .all() as Array<{ code: QuarantineCode | null; n: number }>;
    for (const row of quarantineRows) {
      if (row.code && row.code in quarantineByCode) {
        quarantineByCode[row.code] = Number(row.n);
      }
    }

    const lat = (
      this.db
        .prepare(
          "SELECT latency_ms m FROM deals WHERE stage='routed' AND latency_ms IS NOT NULL ORDER BY latency_ms",
        )
        .all() as { m: number }[]
    ).map((r) => Number(r.m));

    const pct = (a: number, b: number): number =>
      b === 0 ? 0 : Math.round((a / b) * 1000) / 10;

    return {
      intake,
      routed,
      quarantined,
      conversionPct: pct(routed, intake),
      quarantineRatePct: pct(quarantined, intake),
      routeMix,
      flags,
      quarantineByCode,
      latencyMsP50: percentile(lat, 50),
      latencyMsP95: percentile(lat, 95),
      routedArrUsd,
      humanRoutedArrUsd: arrByRoute.human_assisted,
      arrByRoute,
      autoHandled: routeMix.nurture + routeMix.self_serve,
      partialSyncs,
      externallySyncedStoreErrors,
      stageNotificationAuditGaps,
      deploymentReadiness,
      readinessNotificationGaps,
      readinessPendingOverSla,
      readinessFactsStaleProjected,
      readinessFactsStaleIgnored,
      commercialProjectionDrift,
      commercialTerminalDriftAlerts,
      commercialTerminalDriftNotificationGaps,
      commercialTerminalTieConflicts,
      notRoutedClosedWonStageEvents,
      deploymentStartedDeals: outcomeDealSets.deployment_started.size,
      deployedDeals: outcomeDealSets.deployed.size,
      landedDeals: outcomeDealSets.landed.size,
      expandedDeals: outcomeDealSets.expanded.size,
      expandedArrDeltaUsd,
      churnedDeals: outcomeDealSets.churned.size,
      outcomeChurnBeforeDeploy,
      outcomeCommercialStateConflicts,
      outcomeInvalidHistories: invalidOutcomeRowIds.size,
      medianTimeClosedWonToDeployedHours: median(closedWonToDeployedHours),
      medianTimeDeployedToLandedHours: median(deployedToLandedHours),
    };
  }

  // ─── Integrity self-check & lifecycle ─────────────────────────────────────
  integrity(): { ok: boolean; detail: string } {
    const recognizedIntake = Number(
      (
        this.db
          .prepare(
            "SELECT COUNT(DISTINCT deal_id) n FROM events WHERE to_st='intake'",
          )
          .get() as { n: number }
      ).n,
    );
    const routed = Number(
      (
        this.db
          .prepare("SELECT COUNT(*) n FROM deals WHERE stage='routed'")
          .get() as { n: number }
      ).n,
    );
    const validQuarantined = Number(
      (
        this.db
          .prepare(
            `SELECT COUNT(*) n
             FROM deals
             WHERE stage='quarantined'
               AND quarantine_code <> 'schema_invalid'`,
          )
          .get() as { n: number }
      ).n,
    );
    const terminalValid = routed + validQuarantined;
    const ok = recognizedIntake === terminalValid;
    return {
      ok,
      detail: ok
        ? `${recognizedIntake} recognized intakes settled`
        : `${recognizedIntake} recognized intakes but ${terminalValid} routed/quarantined valid terminals`,
    };
  }

  close(): void {
    this.db.close();
  }
}
