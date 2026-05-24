/**
 * Domain model for the GTM ops router.
 *
 * Design rule: make invalid states unrepresentable. A deal cannot be "routed" without a score; a route is a
 * discriminated union so you cannot construct a `human_assisted` route with no
 * owner; every failure is a typed `Quarantine`, never a dropped record.
 */

import { z } from "zod";

// ── Policy constants (every business threshold is named, not magic) ──────────
// $10K is the human-trust gate: above it, buyers will not self-serve — they
// need a person. We automate the *routing and prep*, never the close.
// (GTM mastery curriculum L7 / INS-260327-5DD2.)
export const HUMAN_GATE_USD = 10_000;
// Below this ICP fit we do not spend human time — nurture instead.
// (Funnel math: outreach is volume; protect rep hours. INS-260327-4E28.)
export const ICP_THRESHOLD = 0.55;

export const REGIONS = ["NA", "EU", "UK", "APAC", "LATAM"] as const;
export type Region = (typeof REGIONS)[number];

export const SOURCE_CHANNELS = [
  "inbound_form",
  "website_chat",
  "referral",
  "event",
  "cold_reply",
] as const;
export type SourceChannel = (typeof SOURCE_CHANNELS)[number];

// ── Phase 1 commercial/deployment lifecycle vocabulary ─────────────────────
export const COMMERCIAL_STATES = [
  "open",
  "proposal_sent",
  "negotiating",
  "closed_won",
  "closed_lost",
] as const;
export const CommercialState = z.enum(COMMERCIAL_STATES);
export type CommercialState = z.infer<typeof CommercialState>;

export const TERMINAL_COMMERCIAL_STATES = ["closed_won", "closed_lost"] as const;
export type TerminalCommercialState = (typeof TERMINAL_COMMERCIAL_STATES)[number];

export function isTerminalCommercialState(
  state: CommercialState,
): state is TerminalCommercialState {
  return (TERMINAL_COMMERCIAL_STATES as readonly CommercialState[]).includes(state);
}

export const DEPLOYMENT_READINESS = [
  "not_required",
  "pending",
  "ready",
  "blocked",
] as const;
export const DeploymentReadiness = z.enum(DEPLOYMENT_READINESS);
export type DeploymentReadiness = z.infer<typeof DeploymentReadiness>;

export const DEPLOYMENT_FACT_STATUSES = [
  "not_applicable",
  "missing",
  "fresh",
  "stale",
] as const;
export type DeploymentFactStatus = (typeof DEPLOYMENT_FACT_STATUSES)[number];

export const DEPLOYMENT_BLOCKERS = [
  "deployment_use_case_unclear",
  "deployment_integration_unknown",
  "deployment_data_unavailable",
] as const;
export const DeploymentBlocker = z.enum(DEPLOYMENT_BLOCKERS);
export type DeploymentBlocker = z.infer<typeof DeploymentBlocker>;

type NonBlockedDeploymentReadiness = Exclude<DeploymentReadiness, "blocked">;

export type DeploymentReadinessRecord =
  | {
      readiness: NonBlockedDeploymentReadiness;
      blockerCode: null;
      secondaryBlockerCodes: null;
      blockerEnteredAt: null;
      reason: string | null;
    }
  | {
      readiness: "blocked";
      blockerCode: DeploymentBlocker;
      secondaryBlockerCodes: DeploymentBlocker[] | null;
      blockerEnteredAt: string;
      reason: string | null;
    };

export interface LocalCommercialStateInput {
  dealId: string;
  commercialState: CommercialState;
  sourceEventId: string;
  occurredAt: string;
  reason: string | null;
  expectedRedPath: boolean;
}

export interface CommercialStateRecord {
  dealId: string;
  commercialState: CommercialState;
  source: "local" | "hubspot";
  sourceEventId: string;
  occurredAt: string;
  stateEnteredAt: string;
  updatedAt: string;
  terminalProjectedAt: string | null;
  projectedViaTerminalTie: boolean;
  terminalTieOccurredAt: string | null;
  terminalTieResolvedAt: string | null;
  terminalTieWinnerState: TerminalCommercialState | null;
  terminalTieLoserState: TerminalCommercialState | null;
}

export type LocalCommercialStateWriteStatus =
  | "recorded"
  | "duplicate"
  | "idempotency_conflict"
  | "not_routed"
  | "stale"
  | "same_state_tie"
  | "same_state_newer"
  | "tie_ignored"
  | "regression"
  | "terminal_drift";

export interface LocalCommercialStateWriteResult {
  status: LocalCommercialStateWriteStatus;
  eventKey: string;
  dealId: string;
  commercialState: CommercialState;
  projected: boolean;
  current: CommercialStateRecord | null;
  readinessNotification: ReadinessNotificationClaim | null;
  terminalDriftAlert: CommercialTerminalDriftAlertClaim | null;
}

export interface LocalDeploymentFactsInput {
  dealId: string;
  sourceEventId: string;
  useCaseClear: boolean;
  integrationsKnown: boolean;
  dataReady: boolean;
  operator: string;
  occurredAt: string;
}

export interface DeploymentFactsRecord {
  dealId: string;
  useCaseClear: boolean;
  integrationsKnown: boolean;
  dataReady: boolean;
  source: "local";
  sourceEventId: string;
  operator: string;
  operatorSource: "self_reported";
  occurredAt: string;
  updatedAt: string;
}

export type DeploymentReadinessNotifyStatus =
  | "pending"
  | "ok"
  | "failed"
  | "max_attempts_exceeded";

export type PreviousDeploymentReadiness = DeploymentReadiness | "none";

export interface ReadinessNotificationClaim {
  dealId: string;
  fingerprint: string;
  previousReadiness: PreviousDeploymentReadiness;
  readiness: Exclude<DeploymentReadiness, "not_required">;
  blockerCode: DeploymentBlocker | null;
  reason: string | null;
  leaseAcquiredAt: string;
  attempt: number;
}

export interface ReadinessFallbackNotificationClaim {
  dealId: string;
  fingerprint: string;
  fallbackKey: string;
  readiness: Exclude<DeploymentReadiness, "not_required">;
  errorClass: string;
  leaseAcquiredAt: string;
  leaseGeneration: number;
}

export type ReadinessNotificationRecordStatus =
  | "ok"
  | "failed"
  | "max_attempts_exceeded"
  | "lost_race";

export type ReadinessFallbackNotificationRecordStatus =
  | "ok"
  | "failed"
  | "fallback_max_attempts_exceeded"
  | "lost_race";

export type ReadinessFallbackNotificationClaimMissStatus =
  | "already_delivered"
  | "lease_held"
  | "fallback_max_attempts_exceeded"
  | "superseded_by_new_readiness"
  | "missing"
  | "lost_race";

export interface ReadinessNotificationDeliveryResult {
  status: ReadinessNotificationRecordStatus;
  fallbackClaim: ReadinessFallbackNotificationClaim | null;
}

export interface ReadinessFallbackNotificationDeliveryResult {
  status: ReadinessFallbackNotificationRecordStatus;
}

export interface CommercialTerminalDriftAlertClaim {
  dealId: string;
  alertKey: string;
  source: "local" | "hubspot";
  sourceEventId: string;
  incomingCommercialState: CommercialState;
  currentCommercialState: CommercialState;
  incomingOccurredAt: string;
  currentOccurredAt: string;
  driftKind: "terminal_regression";
  tieResolutionDrift: boolean;
  expectedRedPath: boolean;
  leaseAcquiredAt: string;
  leaseGeneration: number;
}

export type CommercialTerminalDriftAlertRecordStatus =
  | "ok"
  | "failed"
  | "max_attempts_exceeded"
  | "lost_race";

export interface CommercialTerminalDriftAlertDeliveryResult {
  status: CommercialTerminalDriftAlertRecordStatus;
}

export interface CommercialTerminalDriftAlertRetryCandidate {
  type: "terminal_drift";
  dealId: string;
  alertKey: string;
}

export interface DeploymentReadinessState {
  dealId: string;
  readiness: DeploymentReadiness;
  blockerCode: DeploymentBlocker | null;
  secondaryBlockerCodes: DeploymentBlocker[] | null;
  reason: string | null;
  stateEnteredAt: string;
  blockerEnteredAt: string | null;
  updatedAt: string;
  notifyStatus: DeploymentReadinessNotifyStatus | null;
  factsStatus: DeploymentFactStatus;
  factsFresh: boolean | null;
  factsStaleAt: string | null;
}

export type LocalDeploymentFactsWriteStatus =
  | "recorded"
  | "duplicate"
  | "idempotency_conflict"
  | "not_found"
  | "stale_age"
  | "stale_ordering"
  | "same_values_tie"
  | "tie_conflict";

export interface LocalDeploymentFactsWriteResult {
  status: LocalDeploymentFactsWriteStatus;
  eventKey: string;
  dealId: string;
  sourceEventId: string;
  accepted: boolean;
  current: DeploymentFactsRecord | null;
  readinessNotification: ReadinessNotificationClaim | null;
}

// -- Phase 2 outcome loop vocabulary ---------------------------------------
export const OUTCOME_STATES = [
  "deployment_started",
  "deployed",
  "landed",
  "expanded",
  "churned",
] as const;
export const OutcomeState = z.enum(OUTCOME_STATES);
export type OutcomeState = z.infer<typeof OutcomeState>;

export const OUTCOME_REASON_CATEGORIES = [
  "customer_ready",
  "technical_blocker_resolved",
  "scope_expanded",
  "budget_lost",
  "no_show",
  "other",
] as const;
export const OutcomeReasonCategory = z.enum(OUTCOME_REASON_CATEGORIES);
export type OutcomeReasonCategory = z.infer<typeof OutcomeReasonCategory>;

export const OUTCOME_REJECTION_KINDS = [
  "duplicate_semantic_outcome",
  "missing_prior_outcome",
  "post_churn_outcome",
  "invalid_arr_delta",
] as const;
export const OutcomeRejectionKind = z.enum(OUTCOME_REJECTION_KINDS);
export type OutcomeRejectionKind = z.infer<typeof OutcomeRejectionKind>;

export type OutcomeSource = "local";
export type OutcomeOperatorSource = "self_reported";
type NonExpandedOutcomeState = Exclude<OutcomeState, "expanded">;

export interface LocalOutcomeInput {
  dealId: string;
  sourceEventId: string;
  outcome: OutcomeState;
  occurredAt: string;
  operator: string;
  arrDeltaUsd: number | null;
  reasonCategory: OutcomeReasonCategory | null;
}

interface OutcomeEventRecordBase {
  id: string;
  dealId: string;
  source: OutcomeSource;
  sourceEventId: string;
  sourcePayloadHash: string;
  occurredAt: string;
  operator: string;
  operatorSource: OutcomeOperatorSource;
  reasonCategory: OutcomeReasonCategory | null;
  createdAt: string;
}

export type OutcomeEventRecord =
  | (OutcomeEventRecordBase & {
      outcome: "expanded";
      arrDeltaUsd: number;
    })
  | (OutcomeEventRecordBase & {
      outcome: NonExpandedOutcomeState;
      arrDeltaUsd: null;
    });

export interface OutcomeRejectionRecord {
  id: string;
  dealId: string;
  source: OutcomeSource;
  sourceEventId: string;
  sourcePayloadHash: string;
  rejectionKind: OutcomeRejectionKind;
  outcome: OutcomeState;
  occurredAt: string;
  createdAt: string;
}

export type LocalOutcomeWriteStatus =
  | "recorded"
  | "duplicate"
  | "idempotency_conflict"
  | "not_found"
  | "not_closed_won"
  | OutcomeRejectionKind;

export interface LocalOutcomeWriteResult {
  status: LocalOutcomeWriteStatus;
  eventKey: string;
  dealId: string;
  sourceEventId: string;
  accepted: boolean;
  event: OutcomeEventRecord | null;
  rejection: OutcomeRejectionRecord | null;
}

export const AGENT_SUGGESTION_KINDS = [
  "handoff_summary",
  "missing_field_question",
  "stale_deal_nudge",
  "policy_change_recommendation",
] as const;
export const AgentSuggestionKind = z.enum(AGENT_SUGGESTION_KINDS);
export type AgentSuggestionKind = z.infer<typeof AgentSuggestionKind>;

export const AGENT_SUGGESTION_STATUSES = [
  "proposed",
  "accepted",
  "rejected",
] as const;
export const AgentSuggestionStatus = z.enum(AGENT_SUGGESTION_STATUSES);
export type AgentSuggestionStatus = z.infer<typeof AgentSuggestionStatus>;

export const AGENT_SUGGESTION_DECISIONS = [
  "accepted",
  "rejected",
] as const satisfies readonly Exclude<AgentSuggestionStatus, "proposed">[];
export const AgentSuggestionDecision = z.enum(AGENT_SUGGESTION_DECISIONS);
export type AgentSuggestionDecision = z.infer<typeof AgentSuggestionDecision>;

export type AgentSuggestionSource = "local_agent";

export interface LocalAgentSuggestionInput {
  dealId: string;
  sourceEventId: string;
  kind: AgentSuggestionKind;
  title: string;
  body: string;
  rationale: string;
  createdBy: string;
  occurredAt: string;
}

export interface LocalAgentSuggestionDecisionInput {
  suggestionId: string;
  sourceEventId: string;
  decision: AgentSuggestionDecision;
  humanPrincipal: string;
  reason: string;
  occurredAt: string;
}

export interface AgentSuggestionRecord {
  id: string;
  dealId: string;
  kind: AgentSuggestionKind;
  status: AgentSuggestionStatus;
  title: string;
  body: string;
  rationale: string;
  source: AgentSuggestionSource;
  sourceEventId: string;
  sourcePayloadHash: string;
  createdBy: string;
  occurredAt: string;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionSourceEventId: string | null;
  decisionPayloadHash: string | null;
  decisionReason: string | null;
}

export const LOCAL_AGENT_SUGGESTION_WRITE_STATUSES = [
  "recorded",
  "duplicate",
  "idempotency_conflict",
  "not_found",
  "not_routed",
] as const;
export const LocalAgentSuggestionWriteStatus = z.enum(
  LOCAL_AGENT_SUGGESTION_WRITE_STATUSES,
);
export type LocalAgentSuggestionWriteStatus = z.infer<
  typeof LocalAgentSuggestionWriteStatus
>;

export interface LocalAgentSuggestionWriteResult {
  status: LocalAgentSuggestionWriteStatus;
  eventKey: string;
  suggestion: AgentSuggestionRecord | null;
}

export type LocalAgentSuggestionDecisionStatus =
  | "recorded"
  | "duplicate"
  | "idempotency_conflict"
  | "not_found"
  | "already_decided"
  | "decision_before_proposal";

export interface LocalAgentSuggestionDecisionResult {
  status: LocalAgentSuggestionDecisionStatus;
  eventKey: string;
  suggestion: AgentSuggestionRecord | null;
}

export interface PolicyRecommendationRunInput {
  createdBy: string;
  evaluatedAt: string;
  limit?: number;
}

export const POLICY_RECOMMENDATION_RUN_STATUSES = [
  "recorded",
  "duplicate",
  "idempotency_conflict",
  "all_skipped",
  "no_signals",
] as const;
export const PolicyRecommendationRunStatus = z.enum(
  POLICY_RECOMMENDATION_RUN_STATUSES,
);
export type PolicyRecommendationRunStatus = z.infer<
  typeof PolicyRecommendationRunStatus
>;

export const PolicyRecommendationRunStatusCounts = z.object(
  Object.fromEntries(
    LOCAL_AGENT_SUGGESTION_WRITE_STATUSES.map((status) => [
      status,
      z.number().int().nonnegative().optional().default(0),
    ]),
  ) as Record<
    LocalAgentSuggestionWriteStatus,
    z.ZodDefault<z.ZodOptional<z.ZodNumber>>
  >,
);
export type PolicyRecommendationRunStatusCounts = z.infer<
  typeof PolicyRecommendationRunStatusCounts
>;

export interface PolicyRecommendationRunResult {
  id: string;
  status: PolicyRecommendationRunStatus;
  createdBy: string;
  limit: number;
  evaluatedAt: string;
  createdAt: string;
  attempted: number;
  recorded: number;
  duplicate: number;
  idempotencyConflict: number;
  skipped: number;
  statusCounts: PolicyRecommendationRunStatusCounts;
  results: PolicyRecommendationDraftResult[];
}

export type PolicyRecommendationRunRecord = PolicyRecommendationRunResult;

export type Stage =
  | "intake"
  | "enriched"
  | "scored"
  | "routed"
  | "quarantined";

export interface ExternalStageState {
  system: "hubspot";
  externalId: string;
  stageId: string;
  stageLabel: string | null;
  updatedAt: string;
}

// ── Intake: validated at the boundary, never trusted raw ────────────────────
export const RawDealInput = z.object({
  id: z.string().min(1).optional(),
  company: z.string().min(1, "company is required"),
  domain: z.preprocess(
    (v) => (typeof v === "string" && v.trim().length === 0 ? undefined : v),
    z.string().min(3).optional(),
  ),
  contactName: z.string().min(1, "contactName is required"),
  contactEmail: z.string().email("contactEmail must be a valid email"),
  dealUSD: z.number().finite().nonnegative("dealUSD must be >= 0"),
  region: z.enum(REGIONS),
  sourceChannel: z.enum(SOURCE_CHANNELS),
  statedNeed: z.string().min(1, "statedNeed is required"),
});
export type RawDealInput = z.infer<typeof RawDealInput>;

/** Normalized deal: id always present, domain coerced to string | null. */
export interface Deal {
  id: string;
  company: string;
  domain: string | null;
  contactName: string;
  contactEmail: string;
  dealUSD: number;
  region: Region;
  sourceChannel: SourceChannel;
  statedNeed: string;
}

// ── Enrichment ──────────────────────────────────────────────────────────────
export interface Enrichment {
  employees: number;
  industry: string;
  techSignals: string[];
  /** Regulated buyer (e.g. freight brokerage, healthcare) -> legal review. */
  regulated: boolean;
  /** 0..1. Low confidence is a first-class signal, not a silent default. */
  confidence: number;
}
export type EnrichedDeal = Deal & { enrichment: Enrichment };

// ── Scoring: deterministic and auditable (a reviewer can recompute it) ───────
export interface ScoreBreakdown {
  icpFit: number; // 0..1
  painSignal: number; // 0..1
  sizeFit: number; // 0..1
  regionFit: number; // 0..1
  total: number; // 0..1 weighted
  notes: string[]; // one line per dimension — the audit trail
}
export type ScoredDeal = EnrichedDeal & { score: ScoreBreakdown };

// ── Routing: a discriminated union — illegal combinations cannot be built ────
export type Route =
  | { kind: "nurture"; reason: string }
  | { kind: "self_serve"; queue: "sales_self_serve"; slaHours: number }
  | {
      kind: "human_assisted";
      salesOwner: string;
      financeFlag: "pricing_approval" | null;
      legalFlag: "regulated_review" | null;
      slaHours: number;
    };

export const ROLE_QUEUE_KINDS = [
  "ae_attention",
  "finance_review",
  "legal_review",
  "deployment_readiness",
  "growth_attribution",
] as const;
export type RoleQueueKind = (typeof ROLE_QUEUE_KINDS)[number];
// Action queues currently use high/medium; low is reserved for passive
// attribution views such as growth_attribution.
export type RoleQueuePriority = "high" | "medium" | "low";
export type RoleQueueStatus =
  | CommercialState
  | DeploymentReadiness
  | "no_commercial_state";

export interface RoleQueueItem {
  queue: RoleQueueKind;
  dealId: string;
  company: string;
  amount: number;
  routeKind: Route["kind"];
  sourceChannel: SourceChannel;
  salesOwner: string | null;
  priority: RoleQueuePriority;
  reason: string;
  status: RoleQueueStatus;
  updatedAt: string;
}

export type RoleQueues = Record<RoleQueueKind, RoleQueueItem[]>;

export const POLICY_EVALUATION_SIGNALS = [
  "self_serve_expanded",
  "human_assisted_churned",
  "human_assisted_stalled",
  "human_assisted_ready_not_started",
] as const;
export const PolicyEvaluationSignal = z.enum(POLICY_EVALUATION_SIGNALS);
export type PolicyEvaluationSignal = z.infer<typeof PolicyEvaluationSignal>;

export const PolicyRecommendationDraftResult = z.object({
  dealId: z.string(),
  signal: PolicyEvaluationSignal,
  sourceEventId: z.string(),
  status: LocalAgentSuggestionWriteStatus,
  suggestionId: z.string().nullable(),
  title: z.string(),
});
export type PolicyRecommendationDraftResult = z.infer<
  typeof PolicyRecommendationDraftResult
>;

export interface PolicyEvaluationDeal {
  dealId: string;
  company: string;
  amount: number;
  routeKind: Route["kind"];
  sourceChannel: SourceChannel;
  salesOwner: string | null;
  signal: PolicyEvaluationSignal;
  signalObservedAt: string;
  reason: string;
  lastOutcomeAt: string | null;
  arrDeltaUsd: number | null;
}

export interface SourceChannelPolicySummary {
  sourceChannel: SourceChannel;
  routed: number;
  closedWon: number;
  deploymentStarted: number;
  deployed: number;
  landed: number;
  expanded: number;
  churned: number;
  expandedArrDeltaUsd: number;
}

export type PolicyFlag = "pricing_approval" | "regulated_review";

export interface FlagPolicySummary {
  flag: PolicyFlag;
  routed: number;
  closedWon: number;
  deploymentStarted: number;
  deployed: number;
  landed: number;
  expanded: number;
  churned: number;
  expandedArrDeltaUsd: number;
}

export interface PolicyEvaluationReports {
  candidateRouted: number;
  candidateLimit: number;
  signalBackfillRouted: number;
  signalBackfillLimitPerSignal: number;
  selfServeExpanded: PolicyEvaluationDeal[];
  humanAssistedRisk: PolicyEvaluationDeal[];
  sourceChannels: SourceChannelPolicySummary[];
  flags: FlagPolicySummary[];
}

export type RoutedDeal = ScoredDeal & { route: Route };

// ── Failure is typed, never silent ──────────────────────────────────────────
export type QuarantineCode =
  | "schema_invalid" // intake failed validation
  | "enrichment_unresolved" // could not resolve the company — we do NOT guess
  | "insufficient_data" // cannot score safely
  | "store_error" // internal persistence failed — surfaced, not swallowed
  | "pipeline_error" // unexpected per-record throw; batch keeps running
  | "sink_terminal" // downstream write rejected non-retryably (e.g. 4xx)
  | "sink_exhausted"; // downstream write retried to budget and still failed

export interface Quarantine {
  dealId: string;
  stage: Stage;
  code: QuarantineCode;
  reason: string;
  at: string; // ISO timestamp
}

/** The only two outcomes of the pipeline. Exhaustive by construction. */
export type PipelineOutcome =
  | { ok: true; deal: RoutedDeal }
  | { ok: false; quarantine: Quarantine };

// ── Observability ───────────────────────────────────────────────────────────
export interface PipelineEvent {
  id: number;
  dealId: string;
  ts: string;
  from: Stage | "-";
  to: Stage;
  detail: string;
  meta?: PipelineEventMeta;
}

export type PipelineEventMeta =
  | {
      kind: "sink";
      mode: "dry_run" | "live";
      receipts: Array<{
        system: string;
        externalId: string;
        detail: string;
        status?: "ok" | "warning";
        url?: string;
      }>;
    }
  | {
      kind: "hubspot_stage_claim";
      mode: "dry_run" | "live";
      hubspotDealId: string;
      eventKey: string;
      toStageId: string;
      toStageLabel: string | null;
    }
  | {
      kind: "hubspot_stage_change";
      mode: "dry_run" | "live";
      hubspotDealId: string;
      eventKey: string;
      toStageId: string;
      toStageLabel: string | null;
      receipts: Array<{
        system: string;
        externalId: string;
        detail: string;
        status?: "ok" | "warning";
        url?: string;
      }>;
    }
  | {
      kind: "commercial_state";
      source: "local";
      eventKey: string;
      sourceEventId: string;
      commercialState: CommercialState;
      occurredAt: string;
      projected: boolean;
      observationCode?: string;
      reason?: string;
      expectedRedPath?: boolean;
    }
  | {
      kind: "deployment_facts";
      source: "local";
      eventKey: string;
      sourceEventId: string;
      useCaseClear: boolean;
      integrationsKnown: boolean;
      dataReady: boolean;
      operator: string;
      operatorSource: "self_reported";
      occurredAt: string;
      accepted: boolean;
      staleKind?: "age" | "ordering";
      tieKind?: "same_values" | "different_values" | "different_operator";
    }
  | {
      kind: "deployment_readiness_notification";
      mode: "dry_run" | "live";
      fingerprint: string;
      previousReadiness: PreviousDeploymentReadiness;
      readiness: Exclude<DeploymentReadiness, "not_required">;
      blockerCode: DeploymentBlocker | null;
      receipts: Array<{
        system: string;
        externalId: string;
        detail: string;
        status?: "ok" | "warning";
        url?: string;
      }>;
    }
  | {
      kind: "deployment_readiness_notification_superseded";
      mode: "dry_run" | "live";
      fingerprint: string;
      previousReadiness: PreviousDeploymentReadiness;
      readiness: Exclude<DeploymentReadiness, "not_required">;
      blockerCode: DeploymentBlocker | null;
      receipts: Array<{
        system: string;
        externalId: string;
        detail: string;
        status?: "ok" | "warning";
        url?: string;
      }>;
    }
  | {
      kind: "commercial_terminal_drift";
      mode: "dry_run" | "live";
      alertKey: string;
      source: "local" | "hubspot";
      sourceEventId: string;
      incomingCommercialState: CommercialState;
      currentCommercialState: CommercialState;
      incomingOccurredAt: string;
      currentOccurredAt: string;
      driftKind: "terminal_regression";
      tieResolutionDrift: boolean;
      expectedRedPath: boolean;
      receipts: Array<{
        system: string;
        externalId: string;
        detail: string;
        status?: "ok" | "warning";
        url?: string;
      }>;
    }
  | {
      kind: "commercial_terminal_drift_superseded";
      mode: "dry_run" | "live";
      alertKey: string;
      source: "local" | "hubspot";
      sourceEventId: string;
      incomingCommercialState: CommercialState;
      currentCommercialState: CommercialState;
      incomingOccurredAt: string;
      currentOccurredAt: string;
      driftKind: "terminal_regression";
      tieResolutionDrift: boolean;
      expectedRedPath: boolean;
      receipts: Array<{
        system: string;
        externalId: string;
        detail: string;
        status?: "ok" | "warning";
        url?: string;
      }>;
    }
  | ({
      kind: "post_sale_outcome";
      source: OutcomeSource;
      eventKey: string;
      sourceEventId: string;
      occurredAt: string;
      operator: string;
      operatorSource: OutcomeOperatorSource;
      reasonCategory: OutcomeReasonCategory | null;
    } & (
      | {
          outcome: "expanded";
          arrDeltaUsd: number;
        }
      | {
          outcome: NonExpandedOutcomeState;
          arrDeltaUsd: null;
        }
    ))
  | {
      kind: "agent_suggestion_proposed";
      source: AgentSuggestionSource;
      eventKey: string;
      sourceEventId: string;
      suggestionId: string;
      suggestionKind: AgentSuggestionKind;
      createdBy: string;
      occurredAt: string;
    }
  | {
      kind: "agent_suggestion_decided";
      source: AgentSuggestionSource;
      eventKey: string;
      sourceEventId: string;
      suggestionId: string;
      decision: AgentSuggestionDecision;
      humanPrincipal: string;
      occurredAt: string;
      reason: string;
    }
  | {
      kind: "deployment_handoff_failed";
      mode: "dry_run" | "live";
      fingerprint: string;
      fallbackKey: string;
      readiness: Exclude<DeploymentReadiness, "not_required">;
      errorClass: string;
      receipts: Array<{
        system: string;
        externalId: string;
        detail: string;
        status?: "ok" | "warning";
        url?: string;
      }>;
    }
  | {
      kind: "deployment_handoff_failed_superseded";
      mode: "dry_run" | "live";
      fingerprint: string;
      fallbackKey: string;
      readiness: Exclude<DeploymentReadiness, "not_required">;
      errorClass: string;
      receipts: Array<{
        system: string;
        externalId: string;
        detail: string;
        status?: "ok" | "warning";
        url?: string;
      }>;
    };

export interface Metrics {
  intake: number;
  routed: number;
  quarantined: number;
  conversionPct: number; // routed / intake
  quarantineRatePct: number; // quarantined / intake
  routeMix: { nurture: number; self_serve: number; human_assisted: number };
  flags: { pricing_approval: number; regulated_review: number };
  quarantineByCode: Record<QuarantineCode, number>;
  latencyMsP50: number;
  latencyMsP95: number;
  // Business intuition: tie routing to money and to human-touch saved.
  routedArrUsd: number; // sum dealUSD of all routed deals
  humanRoutedArrUsd: number; // sum dealUSD on the human_assisted route
  arrByRoute: { nurture: number; self_serve: number; human_assisted: number };
  autoHandled: number; // routed without consuming a rep touch (nurture+self_serve)
  partialSyncs: number; // routed rows where a secondary downstream handoff warned
  externallySyncedStoreErrors: number; // live sink succeeded, local persistence failed
  stageNotificationAuditGaps: number; // current rows where Slack lease released but audit append failed
  deploymentReadiness: Record<DeploymentReadiness, number>;
  readinessNotificationGaps: number;
  readinessPendingOverSla: number;
  readinessFactsStaleProjected: number;
  readinessFactsStaleIgnored: number;
  commercialProjectionDrift: number;
  commercialTerminalDriftAlerts: number;
  commercialTerminalDriftNotificationGaps: number;
  commercialTerminalTieConflicts: number;
  notRoutedClosedWonStageEvents: number;
  deploymentStartedDeals: number;
  deployedDeals: number;
  landedDeals: number;
  expandedDeals: number;
  expandedArrDeltaUsd: number;
  churnedDeals: number;
  outcomeChurnBeforeDeploy: number;
  outcomeCommercialStateConflicts: number;
  // Invalid accepted outcome rows; UI surfaces this as "Invalid Events".
  outcomeInvalidHistories: number;
  // Null means there is no valid sample yet; callers should render "n/a".
  medianTimeClosedWonToDeployedHours: number | null;
  medianTimeDeployedToLandedHours: number | null;
}
