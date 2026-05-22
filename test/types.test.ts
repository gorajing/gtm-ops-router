import { describe, expect, it } from "vitest";
import {
  CommercialState,
  DEPLOYMENT_BLOCKERS,
  DEPLOYMENT_READINESS,
  DeploymentBlocker,
  DeploymentReadiness,
  OutcomeReasonCategory,
  OutcomeRejectionKind,
  OutcomeState,
  type DeploymentReadinessRecord,
  type LocalOutcomeInput,
  type LocalOutcomeWriteStatus,
  type OutcomeEventRecord,
  type PipelineEventMeta,
  type ReadinessFallbackNotificationDeliveryResult,
  isTerminalCommercialState,
} from "../src/types.js";

describe("Phase 1 lifecycle vocabulary", () => {
  it("accepts only the planned commercial states", () => {
    expect(CommercialState.options).toEqual([
      "open",
      "proposal_sent",
      "negotiating",
      "closed_won",
      "closed_lost",
    ]);
    expect(CommercialState.safeParse("ignore").success).toBe(false);
  });

  it("identifies the two terminal commercial states", () => {
    expect(isTerminalCommercialState("closed_won")).toBe(true);
    expect(isTerminalCommercialState("closed_lost")).toBe(true);
    expect(isTerminalCommercialState("negotiating")).toBe(false);
  });

  it("keeps deployment readiness and blocker enums explicit", () => {
    expect(DeploymentReadiness.options).toEqual(DEPLOYMENT_READINESS);
    expect(DeploymentBlocker.options).toEqual(DEPLOYMENT_BLOCKERS);
    expect(DeploymentReadiness.safeParse("awaiting_ops").success).toBe(false);
    expect(DeploymentBlocker.safeParse("legal_review").success).toBe(false);
  });

  it("makes blocked readiness require a blocker", () => {
    const blocked: DeploymentReadinessRecord = {
      readiness: "blocked",
      blockerCode: "deployment_integration_unknown",
      secondaryBlockerCodes: ["deployment_data_unavailable"],
      blockerEnteredAt: "2026-05-21T00:00:00.000Z",
      reason: "integration owner not identified",
    };

    expect(blocked.blockerCode).toBe("deployment_integration_unknown");
  });
});

describe("Phase 2 outcome vocabulary", () => {
  it("accepts only the planned outcome states", () => {
    expect(OutcomeState.options).toEqual([
      "deployment_started",
      "deployed",
      "landed",
      "expanded",
      "churned",
    ]);
    expect(OutcomeState.safeParse("go_live").success).toBe(false);
  });

  it("keeps reason categories and rejection kinds explicit", () => {
    expect(OutcomeReasonCategory.options).toEqual([
      "customer_ready",
      "technical_blocker_resolved",
      "scope_expanded",
      "budget_lost",
      "no_show",
      "other",
    ]);
    expect(OutcomeRejectionKind.options).toEqual([
      "duplicate_semantic_outcome",
      "missing_prior_outcome",
      "post_churn_outcome",
      "invalid_arr_delta",
    ]);
    expect(OutcomeReasonCategory.safeParse("sales_request").success).toBe(false);
    expect(OutcomeRejectionKind.safeParse("not_closed_won").success).toBe(false);
  });

  it("models expanded outcomes as ARR-positive events", () => {
    const expanded: LocalOutcomeInput = {
      dealId: "deal_123",
      sourceEventId: "6dfedbec-8f1d-49d8-8572-7fcd96c2f94e",
      outcome: "expanded",
      occurredAt: "2026-05-21T00:00:00.000Z",
      operator: "deployments@happyrobot.ai",
      arrDeltaUsd: 25_000,
      reasonCategory: "scope_expanded",
    };

    expect(expanded.outcome).toBe("expanded");
    expect(expanded.arrDeltaUsd).toBe(25_000);
  });

  it("models non-expanded outcomes without ARR deltas", () => {
    const deployed: OutcomeEventRecord = {
      id: "outcome_123",
      dealId: "deal_123",
      source: "local",
      sourceEventId: "ea1a1f5f-84ac-4a75-a184-d583e0c5397d",
      sourcePayloadHash: "hash",
      outcome: "deployed",
      occurredAt: "2026-05-21T00:00:00.000Z",
      operator: "deployments@happyrobot.ai",
      operatorSource: "self_reported",
      arrDeltaUsd: null,
      reasonCategory: "technical_blocker_resolved",
      createdAt: "2026-05-21T00:00:00.000Z",
    };

    expect(deployed.outcome).toBe("deployed");
    expect(deployed.arrDeltaUsd).toBeNull();
  });
});

// @ts-expect-error blocked readiness requires a blocker code.
const invalidBlockedReadiness: DeploymentReadinessRecord = {
  readiness: "blocked",
  blockerCode: null,
  secondaryBlockerCodes: null,
  blockerEnteredAt: null,
  reason: null,
};
void invalidBlockedReadiness;

const invalidReadyReadiness: DeploymentReadinessRecord = {
  readiness: "ready",
  // @ts-expect-error non-blocked readiness cannot carry blocker state.
  blockerCode: "deployment_data_unavailable",
  secondaryBlockerCodes: null,
  blockerEnteredAt: null,
  reason: null,
};
void invalidReadyReadiness;

const invalidFallbackDeliveryStatus: ReadinessFallbackNotificationDeliveryResult = {
  // @ts-expect-error superseded rows are claim misses, not delivery results.
  status: "superseded_by_new_readiness",
};
void invalidFallbackDeliveryStatus;

// @ts-expect-error stored non-expanded outcome events cannot carry ARR deltas.
const invalidOutcomeEvent: OutcomeEventRecord = {
  id: "outcome_123",
  dealId: "deal_123",
  source: "local",
  sourceEventId: "ec80e65e-7b42-4b24-bc5e-24ad665a26cc",
  sourcePayloadHash: "hash",
  outcome: "landed",
  occurredAt: "2026-05-21T00:00:00.000Z",
  operator: "deployments@happyrobot.ai",
  operatorSource: "self_reported",
  arrDeltaUsd: 5_000,
  reasonCategory: "customer_ready",
  createdAt: "2026-05-21T00:00:00.000Z",
};
void invalidOutcomeEvent;

const invalidOutcomeEventMeta: PipelineEventMeta = {
  kind: "post_sale_outcome",
  source: "local",
  eventKey: "[\"outcome\",\"local\",\"ec80e65e-7b42-4b24-bc5e-24ad665a26cc\"]",
  sourceEventId: "ec80e65e-7b42-4b24-bc5e-24ad665a26cc",
  outcome: "landed",
  occurredAt: "2026-05-21T00:00:00.000Z",
  operator: "deployments@happyrobot.ai",
  operatorSource: "self_reported",
  // @ts-expect-error post-sale outcome timeline meta mirrors accepted event shape.
  arrDeltaUsd: 5_000,
  reasonCategory: "customer_ready",
};
void invalidOutcomeEventMeta;

// @ts-expect-error external reference gaps are request errors, not outcome write statuses.
const invalidOutcomeWriteStatus: LocalOutcomeWriteStatus = "external_reference_gap";
void invalidOutcomeWriteStatus;
