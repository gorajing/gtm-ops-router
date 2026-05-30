import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_FACT_MAX_AGE_DAYS,
  READINESS_PENDING_SLA_HOURS,
} from "../src/constants.js";
import { integrationConfigBundleFromEnv } from "../src/integrations.js";
import { Store } from "../src/store.js";
import type {
  AgentSuggestionKind,
  ExternalStageState,
  LocalAgentSuggestionDecisionInput,
  LocalAgentSuggestionInput,
  LocalOutcomeInput,
  PipelineEventMeta,
  RoleQueueItem,
  RoleQueueKind,
  ProviderObservationInput,
  RoutedDeal,
  EngagementEventRecord,
  CommercialSignalRecord,
  EngagementImportResult,
} from "../src/types.js";
import type { EngagementFeedback, EngagementEvent, CommercialSignal } from "../src/engagement.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  StatementSync: unknown;
  DatabaseSync: new (path: string) => {
    prepare(sql: string): {
      run(...args: unknown[]): unknown;
      get(...args: unknown[]): unknown;
      all(...args: unknown[]): unknown[];
    };
    close(): void;
  };
};

function routed(): RoutedDeal {
  return {
    id: "D-lease",
    company: "Lease Freight",
    domain: "lease.example",
    contactName: "Lena Ops",
    contactEmail: "lena@example.com",
    dealUSD: 120000,
    region: "NA",
    sourceChannel: "inbound_form",
    statedNeed: "stage retry lease",
    enrichment: {
      employees: 1000,
      industry: "logistics",
      techSignals: ["manual_ops"],
      regulated: true,
      confidence: 0.9,
    },
    score: {
      icpFit: 1,
      painSignal: 1,
      sizeFit: 1,
      regionFit: 1,
      total: 1,
      notes: [],
    },
    route: {
      kind: "human_assisted",
      salesOwner: "ae.morgan",
      financeFlag: "pricing_approval",
      legalFlag: "regulated_review",
      slaHours: 4,
    },
  };
}

function externalStage(): ExternalStageState {
  return {
    system: "hubspot",
    externalId: "991",
    stageId: "contact_made",
    stageLabel: "Contact Made",
    updatedAt: "2026-05-19T17:00:00.000Z",
  };
}

function externalMeta(eventKey = "lease-key"): PipelineEventMeta {
  return {
    kind: "hubspot_stage_claim",
    mode: "dry_run",
    hubspotDealId: "991",
    eventKey,
    toStageId: "contact_made",
    toStageLabel: "Contact Made",
  };
}

function closedWonRoutedDeal(store: Store, deal: RoutedDeal = routed()): void {
  store.recordRouted(deal, 0, { mode: "dry_run", status: "dry_run" });
  store.recordLocalCommercialState({
    dealId: deal.id,
    commercialState: "closed_won",
    sourceEventId: "11111111-1111-4111-8111-111111111111",
    occurredAt: "2026-05-21T12:00:00.000Z",
    reason: null,
    expectedRedPath: false,
  });
}

function outcomeInput(
  overrides: Partial<LocalOutcomeInput> = {},
): LocalOutcomeInput {
  return {
    dealId: "D-lease",
    sourceEventId: "22222222-2222-4222-8222-222222222222",
    outcome: "deployment_started",
    occurredAt: "2026-05-22T12:00:00.000Z",
    operator: "DS",
    arrDeltaUsd: null,
    reasonCategory: null,
    ...overrides,
  };
}

function outcomeEventKey(sourceEventId: string): string {
  return JSON.stringify(["outcome", "local", sourceEventId]);
}

function agentSuggestionInput(
  overrides: Partial<LocalAgentSuggestionInput> = {},
): LocalAgentSuggestionInput {
  return {
    dealId: "D-lease",
    sourceEventId: "33333333-3333-4333-8333-333333333333",
    kind: "handoff_summary",
    title: "Draft AE handoff",
    body: "Summarize the freight scheduling pain, stakeholders, and next step.",
    rationale: "High-ARR human-assisted deal needs a concise handoff.",
    createdBy: "local-agent",
    occurredAt: "2026-05-22T13:00:00.000Z",
    ...overrides,
  };
}

function agentSuggestionDecisionInput(
  suggestionId: string,
  overrides: Partial<LocalAgentSuggestionDecisionInput> = {},
): LocalAgentSuggestionDecisionInput {
  return {
    suggestionId,
    sourceEventId: "44444444-4444-4444-8444-444444444444",
    decision: "accepted",
    humanPrincipal: "ops@example.com",
    reason: "Handoff is accurate and ready for the AE.",
    occurredAt: "2026-05-22T13:05:00.000Z",
    ...overrides,
  };
}

function agentSuggestionEventKey(sourceEventId: string): string {
  return JSON.stringify(["agent_suggestion", "local_agent", sourceEventId]);
}

function agentSuggestionDecisionEventKey(sourceEventId: string): string {
  return JSON.stringify([
    "agent_suggestion_decision",
    "local_agent",
    sourceEventId,
  ]);
}

function providerObservationInput(
  overrides: Partial<ProviderObservationInput> = {},
): ProviderObservationInput {
  return {
    subjectType: "company",
    subjectKey: "acme.example",
    provider: "fixture",
    sourceEventId: "55555555-5555-4555-8555-555555555555",
    observedAt: "2026-05-21T12:00:00.000Z",
    expiresAt: "2026-06-20T12:00:00.000Z",
    confidence: 0.9,
    rawPayload: { source: "fixture" },
    normalizedPayload: {
      employees: 500,
      industry: "logistics",
      techSignals: ["manual_ops"],
      regulated: true,
      confidence: 0.9,
    },
    ...overrides,
  };
}

function withTempStoreDb(test: (db: InstanceType<typeof DatabaseSync>) => void): void {
  const dir = join(tmpdir(), `gtm-router-schema-${process.pid}-${Date.now()}`);
  mkdirSync(dir);
  const dbPath = join(dir, "router.db");
  try {
    new Store(dbPath).close();
    const db = new DatabaseSync(dbPath);
    try {
      test(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withTempStore(
  test: (store: Store, dbPath: string) => void,
): void {
  const dir = join(tmpdir(), `gtm-router-store-${process.pid}-${Date.now()}`);
  mkdirSync(dir);
  const dbPath = join(dir, "router.db");
  try {
    const store = new Store(dbPath);
    try {
      test(store, dbPath);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface ReadinessRow {
  readiness: string;
  blocker_code: string | null;
  secondary_blocker_codes: string | null;
  blocker_entered_at: string | null;
  reason: string | null;
  state_entered_at: string;
}

interface ReadinessNotificationRow {
  last_notified_fingerprint: string | null;
  notify_status: string | null;
  notify_pending_at: string | null;
  notify_attempts: number;
  notify_error: string | null;
}

interface ExternalEventKeyRow {
  key: string;
  notify_status: string;
  notify_leases: number;
  notify_pending_at: string | null;
  scope: string;
  notify_error: string | null;
}

interface IdempotencyViolationRow {
  source: string;
  source_event_id: string;
  scope: string;
  existing_payload_hash: string;
  incoming_payload_hash: string;
  reason: string;
}

function readReadiness(
  dbPath: string,
  dealId: string,
): ReadinessRow | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        `SELECT readiness, blocker_code, secondary_blocker_codes,
                blocker_entered_at, reason, state_entered_at
         FROM deployment_readiness
         WHERE deal_id = ?`,
      )
      .get(dealId) as ReadinessRow | undefined;
  } finally {
    db.close();
  }
}

function readReadinessNotification(
  dbPath: string,
  dealId: string,
): ReadinessNotificationRow | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        `SELECT last_notified_fingerprint, notify_status, notify_pending_at,
                notify_attempts, notify_error
         FROM deployment_readiness
         WHERE deal_id = ?`,
      )
      .get(dealId) as ReadinessNotificationRow | undefined;
  } finally {
    db.close();
  }
}

function readExternalEventKey(
  dbPath: string,
  key: string,
): ExternalEventKeyRow | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        `SELECT key, notify_status, notify_leases, notify_pending_at, scope,
                notify_error
         FROM external_event_keys
         WHERE key = ?`,
      )
      .get(key) as ExternalEventKeyRow | undefined;
  } finally {
    db.close();
  }
}

function readIdempotencyViolation(
  dbPath: string,
  scope: string,
  sourceEventId: string,
): IdempotencyViolationRow | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare(
        `SELECT source, source_event_id, scope, existing_payload_hash,
                incoming_payload_hash, reason
         FROM idempotency_violations
         WHERE scope = ?
           AND source_event_id = ?`,
      )
      .get(scope, sourceEventId) as IdempotencyViolationRow | undefined;
  } finally {
    db.close();
  }
}

function readObservationConfigHash(
  dbPath: string,
  sourceEventId: string,
): string | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db
      .prepare(
        `SELECT config_hash
         FROM external_event_observations
         WHERE source = 'local'
           AND source_event_id = ?`,
      )
      .get(sourceEventId) as { config_hash: string } | undefined;
    return row?.config_hash;
  } finally {
    db.close();
  }
}

function setExternalEventLease(
  dbPath: string,
  key: string,
  leaseAcquiredAt: string,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db
      .prepare(
        `UPDATE external_event_keys
         SET notify_pending_at = ?
         WHERE key = ?`,
      )
      .run(leaseAcquiredAt, key);
  } finally {
    db.close();
  }
}

function setCommercialTerminalTieResolvedAt(
  dbPath: string,
  dealId: string,
  resolvedAt: string,
): void {
  const db = new DatabaseSync(dbPath);
  try {
    db
      .prepare(
        `UPDATE commercial_states
         SET terminal_tie_resolved_at = ?
         WHERE deal_id = ?`,
      )
      .run(resolvedAt, dealId);
  } finally {
    db.close();
  }
}

class AuditAppendFailureStore extends Store {
  failNotificationAppend = false;

  override appendEvent(...args: Parameters<Store["appendEvent"]>): void {
    if (this.failNotificationAppend && args[3] === "hubspot stage notification") {
      throw new Error("event append failed");
    }
    super.appendEvent(...args);
  }
}

describe("Store Phase 1 storage schema", () => {
  it("creates the lifecycle tables", () => {
    withTempStoreDb((db) => {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;

      expect(tables.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          "commercial_states",
          "deployment_facts",
          "deployment_facts_rejections",
          "deployment_readiness",
          "integration_config",
          "external_event_observations",
          "idempotency_violations",
          "outcome_events",
          "outcome_rejections",
          "provider_observations",
          "enriched_subject_facts",
        ]),
      );
    });
  });

  it("enforces commercial-state terminal tie invariants", () => {
    withTempStoreDb((db) => {
      const insert = db.prepare(
        `INSERT INTO commercial_states (
           deal_id, commercial_state, source, source_event_id,
           source_payload_hash, occurred_at, state_entered_at, updated_at,
           terminal_projected_at, projected_via_terminal_tie,
           terminal_tie_occurred_at, terminal_tie_resolved_at,
           terminal_tie_winner_state, terminal_tie_loser_state
         )
         VALUES (?, ?, 'local', ?, 'hash', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const at = "2026-05-21T00:00:00.000Z";

      expect(() =>
        insert.run(
          "deal-open-terminal-at",
          "open",
          "evt-open-terminal-at",
          at,
          at,
          at,
          at,
          0,
          null,
          null,
          null,
          null,
        ),
      ).toThrow();

      expect(() =>
        insert.run(
          "deal-won-missing-terminal-at",
          "closed_won",
          "evt-won-missing-terminal-at",
          at,
          at,
          at,
          null,
          0,
          null,
          null,
          null,
          null,
        ),
      ).toThrow();

      expect(() =>
        insert.run(
          "deal-direct-with-tie-fields",
          "closed_won",
          "evt-direct-with-tie-fields",
          at,
          at,
          at,
          at,
          0,
          at,
          at,
          "closed_lost",
          "closed_won",
        ),
      ).toThrow();

      expect(() =>
        insert.run(
          "deal-mismatched-tie-winner",
          "closed_lost",
          "evt-mismatched-tie-winner",
          at,
          at,
          at,
          at,
          1,
          at,
          at,
          "closed_won",
          "closed_lost",
        ),
      ).toThrow();

      insert.run(
        "deal-tie",
        "closed_lost",
        "evt-tie",
        at,
        at,
        at,
        at,
        1,
        at,
        at,
        "closed_lost",
        "closed_won",
      );

      const row = db
        .prepare("SELECT projected_via_terminal_tie FROM commercial_states WHERE deal_id='deal-tie'")
        .get() as { projected_via_terminal_tie: number };
      expect(row.projected_via_terminal_tie).toBe(1);
    });
  });

  it("enforces deployment-readiness blocker and notification invariants", () => {
    withTempStoreDb((db) => {
      const insert = db.prepare(
        `INSERT INTO deployment_readiness (
           deal_id, readiness, blocker_code, secondary_blocker_codes,
           blocker_entered_at, reason, state_entered_at,
           last_notified_fingerprint, notify_status, notify_pending_at,
           notify_attempts, notify_error, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      );
      const at = "2026-05-21T00:00:00.000Z";

      insert.run(
        "deal-pending",
        "pending",
        null,
        null,
        null,
        "awaiting deployment facts",
        at,
        null,
        null,
        null,
        null,
        at,
      );

      expect(() =>
        insert.run(
          "deal-blocked-no-code",
          "blocked",
          null,
          null,
          at,
          null,
          at,
          null,
          null,
          null,
          null,
          at,
        ),
      ).toThrow();

      expect(() =>
        insert.run(
          "deal-ready-with-code",
          "ready",
          "deployment_data_unavailable",
          null,
          null,
          null,
          at,
          null,
          null,
          null,
          null,
          at,
        ),
      ).toThrow();

      expect(() =>
        insert.run(
          "deal-pending-notify-without-lease",
          "pending",
          null,
          null,
          null,
          null,
          at,
          "fingerprint",
          "pending",
          null,
          null,
          at,
        ),
      ).toThrow();

      expect(() =>
        insert.run(
          "deal-max-without-fingerprint",
          "pending",
          null,
          null,
          null,
          null,
          at,
          null,
          "max_attempts_exceeded",
          null,
          null,
          at,
        ),
      ).toThrow();
    });
  });

  it("enforces observation and idempotency guardrail constraints", () => {
    withTempStoreDb((db) => {
      const at = "2026-05-21T00:00:00.000Z";
      db.prepare(
        `INSERT INTO external_event_observations (
           source, source_event_id, observation_code, projected, payload_hash,
           config_hash, mapped_commercial_state, router_deal_id, external_deal_id,
           stage_id, occurred_at, reason, meta_json, created_at
         )
         VALUES (
           'local', 'obs-1', 'terminal_tie_conflict', 1, 'payload',
           'config', 'closed_lost', 'deal-1', 'external-1',
           'closedlost', ?, 'terminal tie', ?, ?
         )`,
      ).run(
        at,
        JSON.stringify({
          tieArrivalMode: "batch",
          tieWinnerChangedProjection: true,
          logicalTieKey: "deal-1:2026-05-21T00:00:00.000Z:closed_lost:closed_won",
        }),
        at,
      );

      expect(() =>
        db
          .prepare(
            `INSERT INTO external_event_observations (
               source, source_event_id, observation_code, projected,
               payload_hash, config_hash, created_at
             )
             VALUES ('local', 'obs-2', 'same_state_tie', 1, 'payload', 'config', ?)`,
          )
          .run(at),
      ).toThrow();

      db
        .prepare(
          `INSERT INTO idempotency_violations (
             id, source, source_event_id, scope, existing_payload_hash,
             incoming_payload_hash, reason, created_at
           )
           VALUES ('idem-outcome', 'local', 'evt-outcome', 'outcome', 'a', 'b', 'replay', ?)`,
        )
        .run(at);

      expect(() =>
        db
          .prepare(
            `INSERT INTO idempotency_violations (
               id, source, source_event_id, scope, existing_payload_hash,
               incoming_payload_hash, reason, created_at
             )
             VALUES ('idem-1', 'local', 'evt-1', 'slack', 'a', 'b', 'bad scope', ?)`,
          )
          .run(at),
      ).toThrow();
    });
  });

  it("enforces outcome event and rejection constraints", () => {
    withTempStoreDb((db) => {
      const at = "2026-05-21T00:00:00.000Z";
      const insertEvent = db.prepare(
        `INSERT INTO outcome_events (
           id, deal_id, source, source_event_id, source_payload_hash,
           outcome, occurred_at, operator, operator_source, arr_delta_usd,
           reason_category, created_at
         )
         VALUES (?, 'deal-1', ?, ?, 'hash', ?, ?, 'DS', ?, ?, ?, ?)`,
      );

      insertEvent.run(
        "outcome-deployed",
        "local",
        "evt-deployed",
        "deployed",
        at,
        "self_reported",
        null,
        "technical_blocker_resolved",
        at,
      );
      insertEvent.run(
        "outcome-expanded",
        "local",
        "evt-expanded",
        "expanded",
        at,
        "self_reported",
        25_000,
        "scope_expanded",
        at,
      );

      expect(() =>
        insertEvent.run(
          "outcome-deployed-arr",
          "local",
          "evt-deployed-arr",
          "deployed",
          at,
          "self_reported",
          1_000,
          null,
          at,
        ),
      ).toThrow();
      expect(() =>
        insertEvent.run(
          "outcome-expanded-missing-arr",
          "local",
          "evt-expanded-missing-arr",
          "expanded",
          at,
          "self_reported",
          null,
          "scope_expanded",
          at,
        ),
      ).toThrow();
      expect(() =>
        insertEvent.run(
          "outcome-expanded-zero-arr",
          "local",
          "evt-expanded-zero-arr",
          "expanded",
          at,
          "self_reported",
          0,
          "scope_expanded",
          at,
        ),
      ).toThrow();
      expect(() =>
        insertEvent.run(
          "outcome-bad-source",
          "hubspot",
          "evt-bad-source",
          "deployed",
          at,
          "self_reported",
          null,
          null,
          at,
        ),
      ).toThrow();
      expect(() =>
        insertEvent.run(
          "outcome-bad-outcome",
          "local",
          "evt-bad-outcome",
          "go_live",
          at,
          "self_reported",
          null,
          null,
          at,
        ),
      ).toThrow();
      expect(() =>
        insertEvent.run(
          "outcome-bad-operator-source",
          "local",
          "evt-bad-operator-source",
          "deployed",
          at,
          "system",
          null,
          null,
          at,
        ),
      ).toThrow();
      expect(() =>
        insertEvent.run(
          "outcome-bad-reason",
          "local",
          "evt-bad-reason",
          "deployed",
          at,
          "self_reported",
          null,
          "customer_note",
          at,
        ),
      ).toThrow();

      const insertRejection = db.prepare(
        `INSERT INTO outcome_rejections (
           id, deal_id, source, source_event_id, source_payload_hash,
           rejection_kind, outcome, occurred_at, created_at
         )
         VALUES (?, 'deal-1', ?, ?, 'hash', ?, ?, ?, ?)`,
      );
      insertRejection.run(
        "outcome-rejection",
        "local",
        "evt-rejected",
        "missing_prior_outcome",
        "deployed",
        at,
        at,
      );

      expect(() =>
        insertRejection.run(
          "outcome-rejection-bad-kind",
          "local",
          "evt-rejected-bad-kind",
          "not_closed_won",
          "deployed",
          at,
          at,
        ),
      ).toThrow();
      expect(() =>
        insertRejection.run(
          "outcome-rejection-bad-source",
          "hubspot",
          "evt-rejected-bad-source",
          "missing_prior_outcome",
          "deployed",
          at,
          at,
        ),
      ).toThrow();
      expect(() =>
        insertRejection.run(
          "outcome-rejection-bad-outcome",
          "local",
          "evt-rejected-bad-outcome",
          "missing_prior_outcome",
          "go_live",
          at,
          at,
        ),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO outcome_rejections (
               id, deal_id, source, source_event_id, source_payload_hash,
               rejection_kind, outcome, occurred_at, created_at
             )
             VALUES (
               'outcome-rejection-null-source-event', 'deal-1', 'local',
               NULL, 'hash', 'missing_prior_outcome', 'deployed', ?, ?
             )`,
          )
          .run(at, at),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO outcome_rejections (
               id, deal_id, source, source_event_id, source_payload_hash,
               rejection_kind, outcome, occurred_at, created_at
             )
             VALUES (
               'outcome-rejection-null-payload-hash', 'deal-1', 'local',
               'evt-rejected-null-payload-hash', NULL, 'missing_prior_outcome',
               'deployed', ?, ?
             )`,
          )
          .run(at, at),
      ).toThrow();
    });
  });

  it("deduplicates unchanged integration config activations", () => {
    const dir = join(tmpdir(), `gtm-router-config-${process.pid}-${Date.now()}`);
    mkdirSync(dir);
    const dbPath = join(dir, "router.db");
    try {
      const store = new Store(dbPath);
      const bundle = integrationConfigBundleFromEnv("dry-run", {
        HUBSPOT_NOTIFY_STAGE_IDS: "contact_made",
        HUBSPOT_STAGE_MAP_JSON: JSON.stringify({ contact_made: "open" }),
      });
      const first = store.recordIntegrationConfigBundle(bundle);
      const second = store.recordIntegrationConfigBundle(bundle);
      const changed = store.recordIntegrationConfigBundle({
        ...bundle,
        allowLocalWriteEndpoints: true,
      });
      expect(first.activationId).toBe(second.activationId);
      expect(changed.activationId).not.toBe(first.activationId);
      expect(first.bundleHash).toBe(second.bundleHash);
      expect(changed.bundleHash).not.toBe(first.bundleHash);
      expect(first.rows).toBe(11);
      expect(second.rows).toBe(0);
      expect(changed.rows).toBe(11);
      store.close();

      const db = new DatabaseSync(dbPath);
      try {
        const activations = db
          .prepare(
            "SELECT activation_id, value_hash FROM integration_config WHERE key='effective_bundle' ORDER BY id",
          )
          .all() as Array<{ activation_id: string; value_hash: string }>;
        expect(activations).toHaveLength(2);
        expect(activations[0]?.activation_id).toBe(first.activationId);
        expect(activations[1]?.activation_id).toBe(changed.activationId);
        expect(activations[0]?.value_hash).toBe(first.bundleHash);
        expect(activations[1]?.value_hash).toBe(changed.bundleHash);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records provider observations and projects highest-confidence enrichment facts", () => {
    withTempStore((store, dbPath) => {
      const first = store.recordProviderObservation(providerObservationInput());
      expect(first.status).toBe("recorded");
      expect(first.observation?.id).toMatch(/^PO-[0-9a-f]{32}$/);
      expect(first.facts).toEqual(
        expect.objectContaining({
          subjectType: "company",
          subjectKey: "acme.example",
          employees: 500,
          industry: "logistics",
          techSignals: ["manual_ops"],
          regulated: true,
          confidence: 0.9,
          sourceProvider: "fixture",
          freshnessStatus: "fresh",
        }),
      );

      const duplicate = store.recordProviderObservation(providerObservationInput());
      expect(duplicate.status).toBe("duplicate");
      expect(duplicate.observation?.id).toBe(first.observation?.id);
      expect(duplicate.observation?.observedAt).toBe(first.observation?.observedAt);

      const refreshedDuplicate = store.recordProviderObservation(
        providerObservationInput({
          observedAt: "2026-05-22T12:00:00.000Z",
          expiresAt: "2026-06-21T12:00:00.000Z",
          refreshOnDuplicate: true,
        }),
      );
      expect(refreshedDuplicate.status).toBe("refreshed");
      expect(refreshedDuplicate.observation?.id).toBe(first.observation?.id);
      expect(refreshedDuplicate.observation?.observedAt).toBe(
        "2026-05-22T12:00:00.000Z",
      );
      expect(refreshedDuplicate.facts).toEqual(
        expect.objectContaining({
          observedAt: "2026-05-22T12:00:00.000Z",
          expiresAt: "2026-06-21T12:00:00.000Z",
        }),
      );

      const expiryOnlyRefresh = store.recordProviderObservation(
        providerObservationInput({
          observedAt: "2026-05-22T12:00:00.000Z",
          expiresAt: "2026-06-22T12:00:00.000Z",
          refreshOnDuplicate: true,
        }),
      );
      expect(expiryOnlyRefresh.status).toBe("refreshed");
      expect(expiryOnlyRefresh.observation?.expiresAt).toBe(
        "2026-06-22T12:00:00.000Z",
      );
      expect(expiryOnlyRefresh.facts?.expiresAt).toBe(
        "2026-06-22T12:00:00.000Z",
      );

      const conflict = store.recordProviderObservation(
        providerObservationInput({
          normalizedPayload: {
            employees: 501,
            industry: "logistics",
            techSignals: ["manual_ops"],
            regulated: true,
            confidence: 0.9,
          },
        }),
      );
      expect(conflict.status).toBe("idempotency_conflict");
      expect(conflict.observation).toBeNull();
      expect(
        readIdempotencyViolation(
          dbPath,
          "provider_observation",
          "55555555-5555-4555-8555-555555555555",
        ),
      ).toEqual(
        expect.objectContaining({
          source: "fixture",
          scope: "provider_observation",
          reason:
            "provider observation source event id replayed with a different payload",
        }),
      );

      const lowerConfidence = store.recordProviderObservation(
        providerObservationInput({
          sourceEventId: "66666666-6666-4666-8666-666666666666",
          observedAt: "2026-05-22T12:00:00.000Z",
          expiresAt: "2026-06-21T12:00:00.000Z",
          confidence: 0.2,
          normalizedPayload: {
            employees: 50,
            industry: "freight",
            techSignals: ["legacy-tms"],
            regulated: false,
            confidence: 0.2,
          },
        }),
      );
      expect(lowerConfidence.status).toBe("recorded");
      expect(lowerConfidence.facts?.employees).toBe(500);

      const higherConfidence = store.recordProviderObservation(
        providerObservationInput({
          sourceEventId: "77777777-7777-4777-8777-777777777777",
          observedAt: "2026-05-23T12:00:00.000Z",
          expiresAt: "2026-06-22T12:00:00.000Z",
          confidence: 0.95,
          normalizedPayload: {
            employees: 650,
            industry: "3pl",
            techSignals: ["manual_ops", "voice_ai_eval"],
            regulated: false,
            confidence: 0.95,
          },
        }),
      );
      expect(higherConfidence.status).toBe("recorded");
      expect(higherConfidence.facts).toEqual(
        expect.objectContaining({
          employees: 650,
          industry: "3pl",
          techSignals: ["manual_ops", "voice_ai_eval"],
          sourceObservationId: higherConfidence.observation?.id,
        }),
      );

      const refreshedLowerConfidenceSource = store.recordProviderObservation(
        providerObservationInput({
          observedAt: "2026-05-24T12:00:00.000Z",
          expiresAt: "2026-06-24T12:00:00.000Z",
          refreshOnDuplicate: true,
        }),
      );
      expect(refreshedLowerConfidenceSource.status).toBe("refreshed");
      expect(refreshedLowerConfidenceSource.observation?.observedAt).toBe(
        "2026-05-24T12:00:00.000Z",
      );
      expect(refreshedLowerConfidenceSource.facts).toEqual(
        expect.objectContaining({
          employees: 650,
          sourceObservationId: higherConfidence.observation?.id,
        }),
      );

      const expiryShorteningReplay = store.recordProviderObservation(
        providerObservationInput({
          observedAt: "2026-05-24T12:00:00.000Z",
          expiresAt: "2026-06-01T12:00:00.000Z",
          refreshOnDuplicate: true,
        }),
      );
      expect(expiryShorteningReplay.status).toBe("duplicate");
      expect(expiryShorteningReplay.observation?.expiresAt).toBe(
        "2026-06-24T12:00:00.000Z",
      );

      const laterExpiryShorteningReplay = store.recordProviderObservation(
        providerObservationInput({
          observedAt: "2026-05-25T12:00:00.000Z",
          expiresAt: "2026-06-01T12:00:00.000Z",
          refreshOnDuplicate: true,
        }),
      );
      expect(laterExpiryShorteningReplay.status).toBe("duplicate");
      expect(laterExpiryShorteningReplay.observation?.observedAt).toBe(
        "2026-05-24T12:00:00.000Z",
      );
      expect(laterExpiryShorteningReplay.observation?.expiresAt).toBe(
        "2026-06-24T12:00:00.000Z",
      );

      expect(
        store.enrichedSubjectFacts(
          "company",
          "acme.example",
          "2026-06-23T12:00:00.000Z",
        )?.freshnessStatus,
      ).toBe("stale");
      expect(store.providerObservations("company", "acme.example")).toHaveLength(3);
    });
  });

  it("lets fresh usable facts replace stale higher-confidence facts", () => {
    withTempStore((store) => {
      const staleHighConfidence = store.recordProviderObservation(
        providerObservationInput({
          subjectKey: "stale.example",
          sourceEventId: "88888888-8888-4888-8888-888888888888",
          observedAt: "2026-04-20T12:00:00.000Z",
          expiresAt: "2026-05-20T12:00:00.000Z",
          confidence: 0.95,
          normalizedPayload: {
            employees: 900,
            industry: "logistics",
            techSignals: ["legacy-tms"],
            regulated: true,
            confidence: 0.95,
          },
        }),
      );
      expect(staleHighConfidence.status).toBe("recorded");
      expect(
        store.enrichedSubjectFacts(
          "company",
          "stale.example",
          "2026-05-25T12:00:00.000Z",
        ),
      ).toEqual(
        expect.objectContaining({
          employees: 900,
          confidence: 0.95,
          freshnessStatus: "stale",
        }),
      );

      const freshLowerConfidence = store.recordProviderObservation(
        providerObservationInput({
          subjectKey: "stale.example",
          sourceEventId: "99999999-9999-4999-8999-999999999999",
          observedAt: "2026-05-25T12:00:00.000Z",
          expiresAt: "2026-06-24T12:00:00.000Z",
          confidence: 0.7,
          normalizedPayload: {
            employees: 725,
            industry: "3pl",
            techSignals: ["voice_ai_eval"],
            regulated: false,
            confidence: 0.7,
          },
        }),
      );
      expect(freshLowerConfidence.status).toBe("recorded");
      expect(
        store.enrichedSubjectFacts(
          "company",
          "stale.example",
          "2026-05-25T12:00:00.000Z",
        ),
      ).toEqual(
        expect.objectContaining({
          employees: 725,
          industry: "3pl",
          confidence: 0.7,
          freshnessStatus: "fresh",
          sourceObservationId: freshLowerConfidence.observation?.id,
        }),
      );
    });
  });

  it("allows duplicate refresh to extend bounded facts to unbounded expiry", () => {
    withTempStore((store) => {
      const first = store.recordProviderObservation(
        providerObservationInput({
          subjectKey: "unbounded.example",
          sourceEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          observedAt: "2026-05-21T12:00:00.000Z",
          expiresAt: "2026-06-20T12:00:00.000Z",
        }),
      );
      expect(first.status).toBe("recorded");

      const unbounded = store.recordProviderObservation(
        providerObservationInput({
          subjectKey: "unbounded.example",
          sourceEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          observedAt: "2026-05-21T12:00:00.000Z",
          expiresAt: null,
          refreshOnDuplicate: true,
        }),
      );
      expect(unbounded.status).toBe("refreshed");
      expect(unbounded.observation?.expiresAt).toBeNull();
      expect(unbounded.facts).toEqual(
        expect.objectContaining({
          expiresAt: null,
          freshnessStatus: "fresh",
          sourceObservationId: first.observation?.id,
        }),
      );
    });
  });

  it("stores raw local commercial UUIDs in projections and observations", () => {
    const dir = join(tmpdir(), `gtm-router-commercial-${process.pid}-${Date.now()}`);
    mkdirSync(dir);
    const dbPath = join(dir, "router.db");
    try {
      const store = new Store(dbPath);
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "open",
        sourceEventId: "77777777-7777-4777-8777-777777777777",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "proposal_sent",
        sourceEventId: "88888888-8888-4888-8888-888888888888",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      const conflict = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "open",
        sourceEventId: "77777777-7777-4777-8777-777777777777",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: "changed replay",
        expectedRedPath: false,
      });

      expect(conflict.status).toBe("idempotency_conflict");
      expect(store.commercialState("D-lease")?.sourceEventId).toBe(
        "88888888-8888-4888-8888-888888888888",
      );
      store.close();

      const db = new DatabaseSync(dbPath);
      try {
        const observation = db
          .prepare(
            `SELECT source_event_id
             FROM external_event_observations
             WHERE observation_code='commercial_stage_tie_resolved'`,
          )
          .get() as { source_event_id: string } | undefined;
        const claim = db
          .prepare(
            `SELECT key
             FROM external_event_keys
             WHERE key = ?`,
          )
          .get(
            JSON.stringify([
              "commercial_state",
              "local",
              "88888888-8888-4888-8888-888888888888",
            ]),
          ) as { key: string } | undefined;
        const violation = db
          .prepare(
            `SELECT source_event_id
             FROM idempotency_violations
             WHERE scope='commercial_state'`,
          )
          .get() as { source_event_id: string } | undefined;

        expect(observation?.source_event_id).toBe(
          "88888888-8888-4888-8888-888888888888",
        );
        expect(claim?.key).toBe(
          JSON.stringify([
            "commercial_state",
            "local",
            "88888888-8888-4888-8888-888888888888",
          ]),
        );
        expect(violation?.source_event_id).toBe(
          "77777777-7777-4777-8777-777777777777",
        );
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves the existing winner event id when a terminal tie arrives late", () => {
    const store = new Store(":memory:");
    try {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_lost",
        sourceEventId: "99999999-9999-4999-8999-999999999999",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      const tie = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      const current = store.commercialState("D-lease");

      expect(tie.status).toBe("recorded");
      expect(tie.projected).toBe(false);
      expect(current?.commercialState).toBe("closed_lost");
      expect(current?.sourceEventId).toBe(
        "99999999-9999-4999-8999-999999999999",
      );
      expect(current?.projectedViaTerminalTie).toBe(true);
      expect(current?.terminalTieWinnerState).toBe("closed_lost");
      expect(current?.terminalTieLoserState).toBe("closed_won");
    } finally {
      store.close();
    }
  });

  it("claims deployment facts before stale and tie handling while preserving current facts", () => {
    const dir = join(tmpdir(), `gtm-router-facts-${process.pid}-${Date.now()}`);
    mkdirSync(dir);
    const dbPath = join(dir, "router.db");
    try {
      const store = new Store(dbPath);
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const oldAt = new Date(
        Date.now() - (DEPLOYMENT_FACT_MAX_AGE_DAYS + 1) * 86_400_000,
      ).toISOString();
      const freshAt = new Date(Date.now() - 60_000).toISOString();
      const olderThanFreshAt = new Date(Date.parse(freshAt) - 60_000).toISOString();

      const staleAge = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: oldAt,
      });
      const recorded = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: freshAt,
      });
      const staleOrdering = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        useCaseClear: false,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: olderThanFreshAt,
      });
      const sameValuesTie = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: freshAt,
      });
      const differentValuesTie = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "abababab-abab-4bab-8bab-abababababab",
        useCaseClear: true,
        integrationsKnown: false,
        dataReady: true,
        operator: "DS",
        occurredAt: freshAt,
      });
      const differentOperatorTie = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "acacacac-acac-4cac-8cac-acacacacacac",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "FDE",
        occurredAt: freshAt,
      });

      expect(staleAge).toEqual(
        expect.objectContaining({ status: "stale_age", accepted: false }),
      );
      expect(recorded).toEqual(
        expect.objectContaining({ status: "recorded", accepted: true }),
      );
      expect(staleOrdering).toEqual(
        expect.objectContaining({ status: "stale_ordering", accepted: false }),
      );
      expect(sameValuesTie).toEqual(
        expect.objectContaining({ status: "same_values_tie", accepted: false }),
      );
      expect(differentValuesTie).toEqual(
        expect.objectContaining({ status: "tie_conflict", accepted: false }),
      );
      expect(differentOperatorTie).toEqual(
        expect.objectContaining({ status: "tie_conflict", accepted: false }),
      );
      expect(store.deploymentFacts("D-lease")).toEqual(
        expect.objectContaining({
          sourceEventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          useCaseClear: true,
          integrationsKnown: true,
          dataReady: true,
        }),
      );
      store.close();

      const db = new DatabaseSync(dbPath);
      try {
        const rejections = db
          .prepare(
            `SELECT source_event_id, rejection_kind, current_occurred_at
             FROM deployment_facts_rejections
             ORDER BY created_at, source_event_id`,
          )
          .all() as Array<{
          source_event_id: string;
          rejection_kind: string;
          current_occurred_at: string | null;
        }>;
        const claims = db
          .prepare(
            "SELECT key FROM external_event_keys WHERE key LIKE '[\"deployment_facts\"%' ORDER BY key",
          )
          .all() as Array<{ key: string }>;

        expect(rejections).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              source_event_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              rejection_kind: "age",
              current_occurred_at: null,
            }),
            expect.objectContaining({
              source_event_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              rejection_kind: "ordering",
              current_occurred_at: freshAt,
            }),
            expect.objectContaining({
              source_event_id: "abababab-abab-4bab-8bab-abababababab",
              rejection_kind: "tie_conflict",
              current_occurred_at: freshAt,
            }),
            expect.objectContaining({
              source_event_id: "acacacac-acac-4cac-8cac-acacacacacac",
              rejection_kind: "tie_conflict",
              current_occurred_at: freshAt,
            }),
          ]),
        );
        expect(claims).toHaveLength(6);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a hash-shaped config sentinel before integrations are recorded", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "17171717-1717-4717-8717-171717171717",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "18181818-1818-4818-8818-181818181818",
        occurredAt: "2026-05-21T12:01:00.000Z",
        reason: "newer duplicate state",
        expectedRedPath: false,
      });

      const configHash = readObservationConfigHash(
        dbPath,
        "18181818-1818-4818-8818-181818181818",
      );

      expect(configHash).toMatch(/^[a-f0-9]{64}$/);
      expect(configHash).not.toBe("local");
    });
  });
});

describe("Store readiness derivation", () => {
  it("claims one readiness notification per readiness transition", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const pending = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "d0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });

      expect(pending.readinessNotification).toEqual(
        expect.objectContaining({
          dealId: "D-lease",
          fingerprint: "readiness:D-lease:none:pending",
          previousReadiness: "none",
          readiness: "pending",
          blockerCode: null,
          attempt: 1,
        }),
      );
      expect(readReadinessNotification(dbPath, "D-lease")).toEqual(
        expect.objectContaining({
          last_notified_fingerprint: "readiness:D-lease:none:pending",
          notify_status: "pending",
          notify_pending_at: expect.any(String),
          notify_attempts: 0,
          notify_error: null,
        }),
      );

      const duplicate = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "d0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      expect(duplicate.status).toBe("duplicate");
      expect(duplicate.readinessNotification).toBeNull();

      const ready = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: new Date().toISOString(),
      });

      expect(ready.readinessNotification).toEqual(
        expect.objectContaining({
          dealId: "D-lease",
          fingerprint: "readiness:D-lease:pending:ready",
          previousReadiness: "pending",
          readiness: "ready",
          blockerCode: null,
          attempt: 1,
        }),
      );
      expect(readReadinessNotification(dbPath, "D-lease")).toEqual(
        expect.objectContaining({
          last_notified_fingerprint: "readiness:D-lease:pending:ready",
          notify_status: "pending",
          notify_attempts: 0,
        }),
      );
    });
  });

  it("does not claim a new notification for blocker-only blocked updates", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "d2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      const blocked = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "d3d3d3d3-d3d3-43d3-83d3-d3d3d3d3d3d3",
        useCaseClear: false,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-21T12:01:00.000Z",
      });
      expect(blocked.readinessNotification?.fingerprint).toBe(
        "readiness:D-lease:pending:blocked",
      );

      const changedBlocker = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4",
        useCaseClear: true,
        integrationsKnown: false,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-21T12:02:00.000Z",
      });

      expect(changedBlocker.status).toBe("recorded");
      expect(changedBlocker.readinessNotification).toBeNull();
      expect(readReadiness(dbPath, "D-lease")).toEqual(
        expect.objectContaining({
          readiness: "blocked",
          blocker_code: "deployment_integration_unknown",
        }),
      );
      expect(readReadinessNotification(dbPath, "D-lease")).toEqual(
        expect.objectContaining({
          last_notified_fingerprint: "readiness:D-lease:pending:blocked",
          notify_status: "pending",
        }),
      );
    });
  });

  it("records readiness notification results against the claimed fingerprint", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const pending = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "d5d5d5d5-d5d5-45d5-85d5-d5d5d5d5d5d5",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });

      const claim = pending.readinessNotification;
      if (!claim) throw new Error("expected readiness notification claim");
      const delivery = store.recordReadinessNotificationEvent(claim, "dry_run", [
        {
          system: "slack",
          externalId: "CDEPLOY",
          detail: "posted redacted deployment handoff",
        },
      ]);

      expect(delivery).toEqual({ status: "ok", fallbackClaim: null });
      expect(readReadinessNotification(dbPath, "D-lease")).toEqual(
        expect.objectContaining({
          last_notified_fingerprint: "readiness:D-lease:none:pending",
          notify_status: "ok",
          notify_pending_at: null,
          notify_attempts: 0,
          notify_error: null,
        }),
      );
      expect(store.events("D-lease").at(-1)).toEqual(
        expect.objectContaining({
          detail: "deployment readiness notification",
          meta: expect.objectContaining({
            kind: "deployment_readiness_notification",
            mode: "dry_run",
            fingerprint: "readiness:D-lease:none:pending",
            readiness: "pending",
          }),
        }),
      );
    });
  });

  it("audits readiness notifications that lose the lease to a newer state", () => {
    withTempStore((store) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const pending = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "e1e1e1e1-e1e1-41e1-81e1-e1e1e1e1e1e1",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      const supersededClaim = pending.readinessNotification;
      if (!supersededClaim) throw new Error("expected readiness notification claim");

      const ready = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "e2e2e2e2-e2e2-42e2-82e2-e2e2e2e2e2e2",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-21T12:01:00.000Z",
      });
      expect(ready.readinessNotification?.fingerprint).toBe(
        "readiness:D-lease:pending:ready",
      );

      const delivery = store.recordReadinessNotificationEvent(
        supersededClaim,
        "dry_run",
        [
          {
            system: "slack",
            externalId: "CDEPLOY",
            detail: "posted redacted deployment handoff",
          },
        ],
      );

      expect(delivery).toEqual({ status: "lost_race", fallbackClaim: null });
      expect(store.events("D-lease").at(-1)).toEqual(
        expect.objectContaining({
          detail: "deployment readiness notification superseded",
          meta: expect.objectContaining({
            kind: "deployment_readiness_notification_superseded",
            mode: "dry_run",
            fingerprint: "readiness:D-lease:none:pending",
            readiness: "pending",
          }),
        }),
      );
    });
  });

  it("records warning readiness notification receipts as retryable failures", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const pending = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "d6d6d6d6-d6d6-46d6-86d6-d6d6d6d6d6d6",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });

      const claim = pending.readinessNotification;
      if (!claim) throw new Error("expected readiness notification claim");
      const delivery = store.recordReadinessNotificationEvent(claim, "dry_run", [
        {
          system: "slack",
          externalId: "CDEPLOY",
          detail: "deployment readiness notification failed: channel_not_found",
          status: "warning",
        },
      ]);

      expect(delivery).toEqual({ status: "failed", fallbackClaim: null });
      expect(readReadinessNotification(dbPath, "D-lease")).toEqual(
        expect.objectContaining({
          last_notified_fingerprint: "readiness:D-lease:none:pending",
          notify_status: "failed",
          notify_pending_at: null,
          notify_attempts: 1,
          notify_error:
            "deployment readiness notification failed: channel_not_found",
        }),
      );
      expect(store.events("D-lease").at(-1)).toEqual(
        expect.objectContaining({
          detail: "deployment readiness notification failed",
          meta: expect.objectContaining({
            kind: "deployment_readiness_notification",
            receipts: [
              expect.objectContaining({
                status: "warning",
                detail:
                  "deployment readiness notification failed: channel_not_found",
              }),
            ],
          }),
        }),
      );
    });
  });

  it("claims primary readiness notification retries with CAS predicates", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const pending = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "d7d7d7d7-d7d7-47d7-87d7-d7d7d7d7d7d7",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      const initialClaim = pending.readinessNotification;
      if (!initialClaim) throw new Error("expected readiness notification claim");
      store.recordReadinessNotificationEvent(initialClaim, "dry_run", [
        {
          system: "slack",
          externalId: "CDEPLOY",
          detail: "deployment readiness notification failed: rate_limited",
          status: "warning",
        },
      ]);

      const retryClaim = store.claimReadinessNotificationRetry(
        "D-lease",
        "readiness:D-lease:none:pending",
      );
      expect(retryClaim).toEqual(
        expect.objectContaining({
          dealId: "D-lease",
          fingerprint: "readiness:D-lease:none:pending",
          previousReadiness: "none",
          readiness: "pending",
          attempt: 2,
        }),
      );
      expect(store.claimReadinessNotificationRetry(
        "D-lease",
        "readiness:D-lease:none:pending",
      )).toBeNull();
      expect(readReadinessNotification(dbPath, "D-lease")).toEqual(
        expect.objectContaining({
          notify_status: "pending",
          notify_pending_at: retryClaim?.leaseAcquiredAt,
          notify_attempts: 1,
        }),
      );
    });
  });

  it("claims a fallback lease when primary readiness attempts are exhausted", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const pending = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "d8d8d8d8-d8d8-48d8-88d8-d8d8d8d8d8d8",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      let claim = pending.readinessNotification;
      if (!claim) throw new Error("expected readiness notification claim");
      let delivery = store.recordReadinessNotificationEvent(claim, "dry_run", [
        {
          system: "slack",
          externalId: "CDEPLOY",
          detail: "deployment readiness notification failed: outage",
          status: "warning",
        },
      ]);
      expect(delivery.status).toBe("failed");
      claim = store.claimReadinessNotificationRetry(
        "D-lease",
        "readiness:D-lease:none:pending",
      );
      if (!claim) throw new Error("expected first retry claim");
      delivery = store.recordReadinessNotificationEvent(claim, "dry_run", [
        {
          system: "slack",
          externalId: "CDEPLOY",
          detail: "deployment readiness notification failed: outage",
          status: "warning",
        },
      ]);
      expect(delivery.status).toBe("failed");
      claim = store.claimReadinessNotificationRetry(
        "D-lease",
        "readiness:D-lease:none:pending",
      );
      if (!claim) throw new Error("expected second retry claim");
      delivery = store.recordReadinessNotificationEvent(claim, "dry_run", [
        {
          system: "slack",
          externalId: "CDEPLOY",
          detail: "deployment readiness notification failed: outage",
          status: "warning",
        },
      ]);

      expect(delivery).toEqual({
        status: "max_attempts_exceeded",
        fallbackClaim: expect.objectContaining({
          dealId: "D-lease",
          fingerprint: "readiness:D-lease:none:pending",
          fallbackKey: "readiness_fallback:readiness:D-lease:none:pending",
          readiness: "pending",
          errorClass: "slack_delivery_failed",
          leaseGeneration: 1,
        }),
      });
      expect(readReadinessNotification(dbPath, "D-lease")).toEqual(
        expect.objectContaining({
          notify_status: "max_attempts_exceeded",
          notify_attempts: 3,
        }),
      );
      expect(
        readExternalEventKey(
          dbPath,
          "readiness_fallback:readiness:D-lease:none:pending",
        ),
      ).toEqual(
        expect.objectContaining({
          notify_status: "pending",
          notify_leases: 1,
          notify_pending_at: delivery.fallbackClaim?.leaseAcquiredAt,
          scope: "readiness_fallback",
        }),
      );
    });
  });

  it("preserves delivered fallback outcomes across recurring readiness transitions", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const pending = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "ebebebeb-ebeb-4beb-8beb-ebebebebebeb",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      if (!pending.readinessNotification) {
        throw new Error("expected pending notification");
      }
      store.recordReadinessNotificationEvent(
        pending.readinessNotification,
        "dry_run",
        [
          {
            system: "slack",
            externalId: "CDEPLOY",
            detail: "posted pending deployment handoff",
          },
        ],
      );

      const readyOne = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "ecececec-ecec-4cec-8cec-ecececececec",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-21T12:01:00.000Z",
      });
      if (!readyOne.readinessNotification) {
        throw new Error("expected first ready notification");
      }
      store.recordReadinessNotificationEvent(
        readyOne.readinessNotification,
        "dry_run",
        [
          {
            system: "slack",
            externalId: "CDEPLOY",
            detail: "posted ready deployment handoff",
          },
        ],
      );

      const blockOne = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "edededed-eded-4ded-8ded-edededededed",
        useCaseClear: true,
        integrationsKnown: false,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-21T12:02:00.000Z",
      });
      let claim = blockOne.readinessNotification;
      if (!claim) throw new Error("expected first blocked notification");
      let fallbackClaim = null;
      for (let i = 0; i < 3; i += 1) {
        const delivery = store.recordReadinessNotificationEvent(claim, "dry_run", [
          {
            system: "slack",
            externalId: "CDEPLOY",
            detail: "deployment readiness notification failed: outage",
            status: "warning",
          },
        ]);
        fallbackClaim = delivery.fallbackClaim;
        if (fallbackClaim) break;
        claim = store.claimReadinessNotificationRetry(
          "D-lease",
          "readiness:D-lease:ready:blocked",
        );
        if (!claim) throw new Error("expected retry before first fallback");
      }
      if (!fallbackClaim) throw new Error("expected first fallback claim");
      store.recordReadinessFallbackNotificationEvent(
        fallbackClaim,
        "dry_run",
        [
          {
            system: "slack",
            externalId: "CGENERIC",
            detail: "posted deployment_handoff_failed alert",
          },
        ],
      );
      expect(
        readExternalEventKey(
          dbPath,
          "readiness_fallback:readiness:D-lease:ready:blocked",
        ),
      ).toEqual(expect.objectContaining({ notify_status: "ok" }));

      const readyTwo = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-21T12:03:00.000Z",
      });
      if (!readyTwo.readinessNotification) {
        throw new Error("expected second ready notification");
      }
      store.recordReadinessNotificationEvent(
        readyTwo.readinessNotification,
        "dry_run",
        [
          {
            system: "slack",
            externalId: "CDEPLOY",
            detail: "posted ready deployment handoff again",
          },
        ],
      );
      expect(
        readExternalEventKey(
          dbPath,
          "readiness_fallback:readiness:D-lease:ready:blocked",
        ),
      ).toEqual(expect.objectContaining({ notify_status: "ok" }));

      const blockTwo = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "efefefef-efef-4fef-8fef-efefefefefef",
        useCaseClear: true,
        integrationsKnown: false,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-21T12:04:00.000Z",
      });
      claim = blockTwo.readinessNotification;
      expect(claim?.fingerprint).toBe("readiness:D-lease:ready:blocked");
      if (!claim) throw new Error("expected second blocked notification");

      let secondFallbackClaim = null;
      for (let i = 0; i < 3; i += 1) {
        const delivery = store.recordReadinessNotificationEvent(claim, "dry_run", [
          {
            system: "slack",
            externalId: "CDEPLOY",
            detail: "deployment readiness notification failed: outage",
            status: "warning",
          },
        ]);
        secondFallbackClaim = delivery.fallbackClaim;
        if (secondFallbackClaim) break;
        if (delivery.status === "max_attempts_exceeded") break;
        claim = store.claimReadinessNotificationRetry(
          "D-lease",
          "readiness:D-lease:ready:blocked",
        );
        if (!claim) throw new Error("expected retry before second fallback");
      }

      expect(secondFallbackClaim).toBeNull();
      expect(
        readExternalEventKey(
          dbPath,
          "readiness_fallback:readiness:D-lease:ready:blocked",
        ),
      ).toEqual(
        expect.objectContaining({
          notify_status: "ok",
          notify_leases: 1,
          notify_pending_at: null,
        }),
      );
      expect(
        store.readinessFallbackClaimMissStatus(
          "readiness:D-lease:ready:blocked",
        ),
      ).toBe("already_delivered");
    });
  });

  it("reclaims superseded fallback rows when a recurring transition reuses a fingerprint", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const pending = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "abababab-abab-4bab-8bab-abababababab",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      if (!pending.readinessNotification) {
        throw new Error("expected pending notification");
      }
      store.recordReadinessNotificationEvent(
        pending.readinessNotification,
        "dry_run",
        [
          {
            system: "slack",
            externalId: "CDEPLOY",
            detail: "posted pending deployment handoff",
          },
        ],
      );

      const readyOne = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "acacacac-acac-4cac-8cac-acacacacacac",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-21T12:01:00.000Z",
      });
      if (!readyOne.readinessNotification) {
        throw new Error("expected first ready notification");
      }
      store.recordReadinessNotificationEvent(
        readyOne.readinessNotification,
        "dry_run",
        [
          {
            system: "slack",
            externalId: "CDEPLOY",
            detail: "posted ready deployment handoff",
          },
        ],
      );

      const blockOne = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "adadadad-adad-4dad-8dad-adadadadadad",
        useCaseClear: true,
        integrationsKnown: false,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-21T12:02:00.000Z",
      });
      let claim = blockOne.readinessNotification;
      if (!claim) throw new Error("expected first blocked notification");
      let fallbackClaim = null;
      for (let i = 0; i < 3; i += 1) {
        const delivery = store.recordReadinessNotificationEvent(claim, "dry_run", [
          {
            system: "slack",
            externalId: "CDEPLOY",
            detail: "deployment readiness notification failed: outage",
            status: "warning",
          },
        ]);
        fallbackClaim = delivery.fallbackClaim;
        if (fallbackClaim) break;
        claim = store.claimReadinessNotificationRetry(
          "D-lease",
          "readiness:D-lease:ready:blocked",
        );
        if (!claim) throw new Error("expected retry before first fallback");
      }
      if (!fallbackClaim) throw new Error("expected first fallback claim");

      const readyTwo = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-21T12:03:00.000Z",
      });
      if (!readyTwo.readinessNotification) {
        throw new Error("expected second ready notification");
      }
      expect(
        readExternalEventKey(
          dbPath,
          "readiness_fallback:readiness:D-lease:ready:blocked",
        ),
      ).toEqual(
        expect.objectContaining({
          notify_status: "superseded_by_new_readiness",
          notify_pending_at: null,
        }),
      );

      const blockTwo = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "afafafaf-afaf-4faf-8faf-afafafafafaf",
        useCaseClear: true,
        integrationsKnown: false,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-21T12:04:00.000Z",
      });
      claim = blockTwo.readinessNotification;
      if (!claim) throw new Error("expected second blocked notification");
      let secondFallbackClaim = null;
      for (let i = 0; i < 3; i += 1) {
        const delivery = store.recordReadinessNotificationEvent(claim, "dry_run", [
          {
            system: "slack",
            externalId: "CDEPLOY",
            detail: "deployment readiness notification failed: outage",
            status: "warning",
          },
        ]);
        secondFallbackClaim = delivery.fallbackClaim;
        if (secondFallbackClaim) break;
        claim = store.claimReadinessNotificationRetry(
          "D-lease",
          "readiness:D-lease:ready:blocked",
        );
        if (!claim) throw new Error("expected retry before second fallback");
      }

      expect(secondFallbackClaim).toEqual(
        expect.objectContaining({
          dealId: "D-lease",
          fingerprint: "readiness:D-lease:ready:blocked",
          fallbackKey: "readiness_fallback:readiness:D-lease:ready:blocked",
          readiness: "blocked",
          leaseGeneration: 1,
        }),
      );
    });
  });

  it("records fallback notification success against the claimed lease generation", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const pending = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "d9d9d9d9-d9d9-49d9-89d9-d9d9d9d9d9d9",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      let claim = pending.readinessNotification;
      if (!claim) throw new Error("expected readiness notification claim");
      for (let i = 0; i < 3; i += 1) {
        const delivery = store.recordReadinessNotificationEvent(claim, "dry_run", [
          {
            system: "slack",
            externalId: "CDEPLOY",
            detail: "deployment readiness notification failed: outage",
            status: "warning",
          },
        ]);
        if (delivery.fallbackClaim) {
          const fallback = store.recordReadinessFallbackNotificationEvent(
            delivery.fallbackClaim,
            "dry_run",
            [
              {
                system: "slack",
                externalId: "CGENERIC",
                detail: "posted deployment_handoff_failed alert",
              },
            ],
          );
          expect(fallback).toEqual({ status: "ok" });
          break;
        }
        claim = store.claimReadinessNotificationRetry(
          "D-lease",
          "readiness:D-lease:none:pending",
        );
        if (!claim) throw new Error("expected retry claim before fallback");
      }

      expect(
        readExternalEventKey(
          dbPath,
          "readiness_fallback:readiness:D-lease:none:pending",
        ),
      ).toEqual(
        expect.objectContaining({
          notify_status: "ok",
          notify_pending_at: null,
          notify_leases: 1,
        }),
      );
      expect(
        store.readinessNotificationRetryCandidates({
          dealId: "D-lease",
          limit: 10,
        }),
      ).toEqual([]);
      expect(
        store.readinessFallbackClaimMissStatus(
          "readiness:D-lease:none:pending",
        ),
      ).toBe("already_delivered");
      expect(store.events("D-lease").at(-1)).toEqual(
        expect.objectContaining({
          detail: "deployment handoff fallback notification",
          meta: expect.objectContaining({
            kind: "deployment_handoff_failed",
            fingerprint: "readiness:D-lease:none:pending",
            fallbackKey: "readiness_fallback:readiness:D-lease:none:pending",
            readiness: "pending",
          }),
        }),
      );
    });
  });

  it("removes terminal fallback failures from retry candidates", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const pending = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "dadadada-dada-4ada-8ada-dadadadadada",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      let claim = pending.readinessNotification;
      if (!claim) throw new Error("expected readiness notification claim");
      let fallbackClaim = null;
      for (let i = 0; i < 3; i += 1) {
        const delivery = store.recordReadinessNotificationEvent(claim, "dry_run", [
          {
            system: "slack",
            externalId: "CDEPLOY",
            detail: "deployment readiness notification failed: outage",
            status: "warning",
          },
        ]);
        if (delivery.fallbackClaim) {
          fallbackClaim = delivery.fallbackClaim;
          break;
        }
        claim = store.claimReadinessNotificationRetry(
          "D-lease",
          "readiness:D-lease:none:pending",
        );
        if (!claim) throw new Error("expected retry claim before fallback");
      }
      if (!fallbackClaim) throw new Error("expected fallback claim");

      for (let i = 0; i < 3; i += 1) {
        const fallback = store.recordReadinessFallbackNotificationEvent(
          fallbackClaim,
          "dry_run",
          [
            {
              system: "slack",
              externalId: "CGENERIC",
              detail: "deployment handoff fallback notification failed: outage",
              status: "warning",
            },
          ],
        );
        if (fallback.status === "fallback_max_attempts_exceeded") break;
        fallbackClaim = store.claimReadinessFallback(
          "D-lease",
          "readiness:D-lease:none:pending",
        );
        if (!fallbackClaim) throw new Error("expected fallback retry claim");
      }

      expect(
        readExternalEventKey(
          dbPath,
          "readiness_fallback:readiness:D-lease:none:pending",
        ),
      ).toEqual(
        expect.objectContaining({
          notify_status: "fallback_max_attempts_exceeded",
          notify_leases: 3,
        }),
      );
      expect(
        store.readinessNotificationRetryCandidates({
          dealId: "D-lease",
          limit: 10,
        }),
      ).toEqual([]);
      expect(
        store.readinessFallbackClaimMissStatus(
          "readiness:D-lease:none:pending",
        ),
      ).toBe("fallback_max_attempts_exceeded");
    });
  });

  it("orders readiness retry candidates by oldest pending lease", () => {
    withTempStore((store, dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const insert = db.prepare(
          `INSERT INTO deployment_readiness (
             deal_id, readiness, blocker_code, secondary_blocker_codes,
             blocker_entered_at, reason, state_entered_at,
             last_notified_fingerprint, notify_status, notify_pending_at,
             notify_attempts, notify_error, updated_at
           )
           VALUES (?, 'pending', NULL, NULL, NULL, NULL, ?, ?, 'pending', ?, 0, NULL, ?)`,
        );
        insert.run(
          "D-a",
          "2026-05-21T12:00:00.000Z",
          "readiness:D-a:none:pending",
          "2001-01-01T00:00:00.000Z",
          "2001-01-01T00:00:00.000Z",
        );
        insert.run(
          "D-z",
          "2026-05-21T12:00:00.000Z",
          "readiness:D-z:none:pending",
          "2000-01-01T00:00:00.000Z",
          "2000-01-01T00:00:00.000Z",
        );
      } finally {
        db.close();
      }

      expect(
        store
          .readinessNotificationRetryCandidates({ limit: 2 })
          .map((candidate) => candidate.dealId),
      ).toEqual(["D-z", "D-a"]);
    });
  });

  it("orders terminal drift retry candidates by oldest pending lease", () => {
    withTempStore((store, dbPath) => {
      const db = new DatabaseSync(dbPath);
      try {
        const insertObservation = db.prepare(
          `INSERT INTO external_event_observations (
             source, source_event_id, observation_code, projected,
             payload_hash, config_hash, router_deal_id, created_at
           )
           VALUES ('local', ?, 'terminal_drift_unsupported', 0, ?, ?, ?, ?)`,
        );
        const insertKey = db.prepare(
          `INSERT INTO external_event_keys (
             key, system, recorded_at, notify_status, notify_leases,
             notify_pending_at, scope
           )
           VALUES (?, 'slack', ?, 'pending', 1, ?, 'commercial_terminal_drift')`,
        );
        insertObservation.run(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "payload-a",
          "config-a",
          "D-a",
          "2001-01-01T00:00:00.000Z",
        );
        insertKey.run(
          "commercial_terminal_drift:local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "2001-01-01T00:00:00.000Z",
          "2001-01-01T00:00:00.000Z",
        );
        insertObservation.run(
          "zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz",
          "payload-z",
          "config-z",
          "D-z",
          "2000-01-01T00:00:00.000Z",
        );
        insertKey.run(
          "commercial_terminal_drift:local:zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz",
          "2000-01-01T00:00:00.000Z",
          "2000-01-01T00:00:00.000Z",
        );
      } finally {
        db.close();
      }

      expect(
        store
          .commercialTerminalDriftAlertRetryCandidates({ limit: 2 })
          .map((candidate) => candidate.dealId),
      ).toEqual(["D-z", "D-a"]);
    });
  });

  it("audits fallback notifications that lose the lease to a newer readiness", () => {
    withTempStore((store) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const pending = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "53535353-5353-4353-8353-535353535353",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      let claim = pending.readinessNotification;
      if (!claim) throw new Error("expected readiness notification claim");
      let fallbackClaim = null;
      for (let i = 0; i < 3; i += 1) {
        const delivery = store.recordReadinessNotificationEvent(claim, "dry_run", [
          {
            system: "slack",
            externalId: "CDEPLOY",
            detail: "deployment readiness notification failed: outage",
            status: "warning",
          },
        ]);
        fallbackClaim = delivery.fallbackClaim;
        if (fallbackClaim) break;
        claim = store.claimReadinessNotificationRetry(
          "D-lease",
          "readiness:D-lease:none:pending",
        );
        if (!claim) throw new Error("expected retry claim before fallback");
      }
      if (!fallbackClaim) throw new Error("expected fallback claim");

      const ready = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "54545454-5454-4454-8454-545454545454",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-21T12:01:00.000Z",
      });
      expect(ready.readinessNotification?.fingerprint).toBe(
        "readiness:D-lease:pending:ready",
      );

      const delivery = store.recordReadinessFallbackNotificationEvent(
        fallbackClaim,
        "dry_run",
        [
          {
            system: "slack",
            externalId: "CGENERIC",
            detail: "posted deployment_handoff_failed alert",
          },
        ],
      );

      expect(delivery).toEqual({ status: "lost_race" });
      expect(store.events("D-lease").at(-1)).toEqual(
        expect.objectContaining({
          detail: "deployment handoff fallback notification superseded",
          meta: expect.objectContaining({
            kind: "deployment_handoff_failed_superseded",
            mode: "dry_run",
            fingerprint: "readiness:D-lease:none:pending",
            fallbackKey: "readiness_fallback:readiness:D-lease:none:pending",
            readiness: "pending",
          }),
        }),
      );
    });
  });

  it("reclaims failed terminal drift alert leases for retry", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "51515151-5151-4151-8151-515151515151",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      const drift = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_lost",
        sourceEventId: "52525252-5252-4252-8252-525252525252",
        occurredAt: "2026-05-21T12:01:00.000Z",
        reason: null,
        expectedRedPath: true,
      });
      if (!drift.terminalDriftAlert) {
        throw new Error("expected terminal drift alert claim");
      }
      const alertKey =
        "commercial_terminal_drift:local:52525252-5252-4252-8252-525252525252";
      const failed = store.recordCommercialTerminalDriftAlertEvent(
        drift.terminalDriftAlert,
        "dry_run",
        [
          {
            system: "slack",
            externalId: "CGENERIC",
            detail: "commercial terminal drift alert failed: rate_limited",
            status: "warning",
          },
        ],
      );

      expect(failed).toEqual({ status: "failed" });
      expect(
        store.commercialTerminalDriftAlertRetryCandidates({
          dealId: "D-lease",
          limit: 10,
        }),
      ).toEqual([
        {
          type: "terminal_drift",
          dealId: "D-lease",
          alertKey,
        },
      ]);
      const retryClaim = store.claimCommercialTerminalDriftAlertRetry(alertKey);
      expect(retryClaim).toEqual(
        expect.objectContaining({
          dealId: "D-lease",
          alertKey,
          sourceEventId: "52525252-5252-4252-8252-525252525252",
          incomingCommercialState: "closed_lost",
          currentCommercialState: "closed_won",
          driftKind: "terminal_regression",
          expectedRedPath: true,
          leaseGeneration: 2,
        }),
      );
      expect(readExternalEventKey(dbPath, alertKey)).toEqual(
        expect.objectContaining({
          notify_status: "pending",
          notify_leases: 2,
          notify_pending_at: retryClaim?.leaseAcquiredAt,
        }),
      );
      if (!retryClaim) throw new Error("expected terminal drift retry claim");
      expect(
        store.recordCommercialTerminalDriftAlertEvent(retryClaim, "dry_run", [
          {
            system: "slack",
            externalId: "CGENERIC",
            detail: "posted commercial_terminal_drift alert",
          },
        ]),
      ).toEqual({ status: "ok" });
      expect(
        store.commercialTerminalDriftAlertRetryCandidates({
          dealId: "D-lease",
          limit: 10,
        }),
      ).toEqual([]);
    });
  });

  it("audits terminal drift alerts that lose the lease", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "55555555-5555-4555-8555-555555555555",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      const drift = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_lost",
        sourceEventId: "56565656-5656-4656-8656-565656565656",
        occurredAt: "2026-05-21T12:01:00.000Z",
        reason: null,
        expectedRedPath: true,
      });
      if (!drift.terminalDriftAlert) {
        throw new Error("expected terminal drift alert claim");
      }
      const alertKey =
        "commercial_terminal_drift:local:56565656-5656-4656-8656-565656565656";
      setExternalEventLease(dbPath, alertKey, "2026-05-21T12:02:00.000Z");

      const delivery = store.recordCommercialTerminalDriftAlertEvent(
        drift.terminalDriftAlert,
        "dry_run",
        [
          {
            system: "slack",
            externalId: "CGENERIC",
            detail: "posted commercial_terminal_drift alert",
          },
        ],
      );

      expect(delivery).toEqual({ status: "lost_race" });
      expect(store.events("D-lease").at(-1)).toEqual(
        expect.objectContaining({
          detail: "commercial terminal drift alert superseded",
          meta: expect.objectContaining({
            kind: "commercial_terminal_drift_superseded",
            mode: "dry_run",
            alertKey,
            sourceEventId: "56565656-5656-4656-8656-565656565656",
            incomingCommercialState: "closed_lost",
            currentCommercialState: "closed_won",
          }),
        }),
      );
    });
  });

  it("keeps terminal drift tie classification stable across retries", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const tieAt = "2026-05-21T12:00:00.000Z";
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "57575757-5757-4757-8757-575757575757",
        occurredAt: tieAt,
        reason: null,
        expectedRedPath: false,
      });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_lost",
        sourceEventId: "58585858-5858-4858-8858-585858585858",
        occurredAt: tieAt,
        reason: null,
        expectedRedPath: false,
      });
      expect(store.commercialState("D-lease")).toEqual(
        expect.objectContaining({
          commercialState: "closed_lost",
          projectedViaTerminalTie: true,
        }),
      );

      const drift = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "59595959-5959-4959-8959-595959595959",
        occurredAt: "2026-05-21T12:01:00.000Z",
        reason: null,
        expectedRedPath: true,
      });
      if (!drift.terminalDriftAlert) {
        throw new Error("expected terminal drift alert claim");
      }
      expect(drift.terminalDriftAlert.tieResolutionDrift).toBe(true);
      store.recordCommercialTerminalDriftAlertEvent(
        drift.terminalDriftAlert,
        "dry_run",
        [
          {
            system: "slack",
            externalId: "CGENERIC",
            detail: "commercial terminal drift alert failed: rate_limited",
            status: "warning",
          },
        ],
      );

      const alertKey =
        "commercial_terminal_drift:local:59595959-5959-4959-8959-595959595959";
      setCommercialTerminalTieResolvedAt(
        dbPath,
        "D-lease",
        "2026-05-21T00:00:00.000Z",
      );
      const retryClaim = store.claimCommercialTerminalDriftAlertRetry(alertKey);

      expect(retryClaim).toEqual(
        expect.objectContaining({
          alertKey,
          tieResolutionDrift: true,
        }),
      );
    });
  });

  it("derives pending immediately for closed-won human-assisted deals without facts", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const result = store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "adadadad-adad-4dad-8dad-adadadadadad",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });

      expect(result.status).toBe("recorded");
      expect(readReadiness(dbPath, "D-lease")).toEqual(
        expect.objectContaining({
          readiness: "pending",
          blocker_code: null,
          secondary_blocker_codes: null,
          blocker_entered_at: null,
          reason: "awaiting deployment facts",
        }),
      );
    });
  });

  it("flips closed-won human-assisted readiness to ready when complete facts arrive", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      const result = store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "afafafaf-afaf-4faf-8faf-afafafafafaf",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: new Date().toISOString(),
      });

      expect(result.status).toBe("recorded");
      expect(readReadiness(dbPath, "D-lease")).toEqual(
        expect.objectContaining({
          readiness: "ready",
          blocker_code: null,
          secondary_blocker_codes: null,
          blocker_entered_at: null,
          reason: null,
        }),
      );
    });
  });

  it("derives blocked readiness with primary and secondary blockers", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1",
        useCaseClear: false,
        integrationsKnown: false,
        dataReady: false,
        operator: "DS",
        occurredAt: new Date().toISOString(),
      });

      const readiness = readReadiness(dbPath, "D-lease");
      expect(readiness).toEqual(
        expect.objectContaining({
          readiness: "blocked",
          blocker_code: "deployment_use_case_unclear",
          secondary_blocker_codes: JSON.stringify([
            "deployment_integration_unknown",
            "deployment_data_unavailable",
          ]),
          reason: "blocked: deployment_use_case_unclear",
        }),
      );
      expect(readiness?.blocker_entered_at).toEqual(expect.any(String));
    });
  });

  it("stores null secondary blockers for a single blocker", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "b3b3b3b3-b3b3-43b3-83b3-b3b3b3b3b3b3",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: false,
        operator: "DS",
        occurredAt: new Date().toISOString(),
      });

      expect(readReadiness(dbPath, "D-lease")).toEqual(
        expect.objectContaining({
          readiness: "blocked",
          blocker_code: "deployment_data_unavailable",
          secondary_blocker_codes: null,
        }),
      );
    });
  });

  it("preserves blocker_entered_at when the primary blocker is unchanged", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "b6b6b6b6-b6b6-46b6-86b6-b6b6b6b6b6b6",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "b7b7b7b7-b7b7-47b7-87b7-b7b7b7b7b7b7",
        useCaseClear: false,
        integrationsKnown: false,
        dataReady: false,
        operator: "DS",
        occurredAt: "2026-05-21T12:01:00.000Z",
      });

      const sentinel = "2026-05-21T00:00:00.000Z";
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(
          "UPDATE deployment_readiness SET blocker_entered_at=? WHERE deal_id=?",
        ).run(sentinel, "D-lease");
      } finally {
        db.close();
      }

      store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "b8b8b8b8-b8b8-48b8-88b8-b8b8b8b8b8b8",
        useCaseClear: false,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-21T12:02:00.000Z",
      });

      expect(readReadiness(dbPath, "D-lease")).toEqual(
        expect.objectContaining({
          readiness: "blocked",
          blocker_code: "deployment_use_case_unclear",
          secondary_blocker_codes: null,
          blocker_entered_at: sentinel,
        }),
      );
    });
  });

  it("treats corrupt stored deployment fact timestamps as missing facts", () => {
    const dir = join(tmpdir(), `gtm-router-corrupt-facts-${process.pid}-${Date.now()}`);
    mkdirSync(dir);
    const dbPath = join(dir, "router.db");
    try {
      const store = new Store(dbPath);
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.close();

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(
          `INSERT INTO deployment_facts (
             deal_id, use_case_clear, integrations_known, data_ready,
             source, source_event_id, source_payload_hash, operator,
             operator_source, occurred_at, updated_at
           )
           VALUES (
             'D-lease', 1, 1, 1, 'local',
             'b9b9b9b9-b9b9-49b9-89b9-b9b9b9b9b9b9',
             'payload', 'DS', 'self_reported', 'not-a-date',
             '2026-05-21T12:00:00.000Z'
           )`,
        ).run();
      } finally {
        db.close();
      }

      const reopened = new Store(dbPath);
      try {
        reopened.recordLocalCommercialState({
          dealId: "D-lease",
          commercialState: "closed_won",
          sourceEventId: "bababaab-baba-4aba-8aba-babababababa",
          occurredAt: "2026-05-21T12:00:00.000Z",
          reason: null,
          expectedRedPath: false,
        });
      } finally {
        reopened.close();
      }

      expect(readReadiness(dbPath, "D-lease")).toEqual(
        expect.objectContaining({
          readiness: "pending",
          blocker_code: null,
          reason: "awaiting deployment facts",
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives not_required for non-closed-won and non-human-assisted deals", () => {
    withTempStore((store, dbPath) => {
      const openDeal = routed();
      openDeal.id = "D-open";
      store.recordRouted(openDeal, 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-open",
        commercialState: "negotiating",
        sourceEventId: "b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });

      const selfServeDeal = routed();
      selfServeDeal.id = "D-self";
      selfServeDeal.route = {
        kind: "self_serve",
        queue: "sales_self_serve",
        slaHours: 24,
      };
      store.recordRouted(selfServeDeal, 0, {
        mode: "dry_run",
        status: "dry_run",
      });
      store.recordLocalCommercialState({
        dealId: "D-self",
        commercialState: "closed_won",
        sourceEventId: "b5b5b5b5-b5b5-45b5-85b5-b5b5b5b5b5b5",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });

      expect(readReadiness(dbPath, "D-open")).toEqual(
        expect.objectContaining({ readiness: "not_required", reason: null }),
      );
      expect(readReadiness(dbPath, "D-self")).toEqual(
        expect.objectContaining({ readiness: "not_required", reason: null }),
      );
    });
  });

  it("derives role-specific queues from routed, commercial, and readiness state", () => {
    withTempStore((store) => {
      const openDeal = routed();
      openDeal.id = "D-open";
      openDeal.company = "Open Freight";
      openDeal.dealUSD = 75000;
      store.recordRouted(openDeal, 0, { mode: "dry_run", status: "dry_run" });

      const closedDeal = routed();
      closedDeal.id = "D-closed";
      closedDeal.company = "Closed Logistics";
      closedDeal.dealUSD = 120000;
      store.recordRouted(closedDeal, 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-closed",
        commercialState: "closed_won",
        sourceEventId: "b6b6b6b6-b6b6-46b6-86b6-b6b6b6b6b6b6",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });

      const readyDeal = routed();
      readyDeal.id = "D-ready";
      readyDeal.company = "Ready Distribution";
      store.recordRouted(readyDeal, 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-ready",
        commercialState: "closed_won",
        sourceEventId: "b7b7b7b7-b7b7-47b7-87b7-b7b7b7b7b7b7",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      store.recordLocalDeploymentFacts({
        dealId: "D-ready",
        sourceEventId: "b8b8b8b8-b8b8-48b8-88b8-b8b8b8b8b8b8",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-22T12:00:00.000Z",
      });

      const selfServeDeal = routed();
      selfServeDeal.id = "D-self";
      selfServeDeal.company = "Self Serve Ops";
      selfServeDeal.dealUSD = 12000;
      selfServeDeal.sourceChannel = "event";
      selfServeDeal.route = {
        kind: "self_serve",
        queue: "sales_self_serve",
        slaHours: 24,
      };
      store.recordRouted(selfServeDeal, 0, {
        mode: "dry_run",
        status: "dry_run",
      });

      const queues = store.roleQueues();

      expect(queues.ae_attention).toEqual([
        expect.objectContaining({
          queue: "ae_attention",
          dealId: "D-open",
          company: "Open Freight",
          salesOwner: "ae.morgan",
          priority: "high",
          status: "no_commercial_state",
          reason: "human-assisted deal needs owner touch",
        }),
      ]);
      expect(queues.finance_review.map((item) => item.dealId)).toEqual([
        "D-open",
      ]);
      expect(queues.legal_review.map((item) => item.dealId)).toEqual([
        "D-open",
      ]);
      expect(queues.deployment_readiness).toEqual([
        expect.objectContaining({
          queue: "deployment_readiness",
          dealId: "D-closed",
          priority: "medium",
          status: "pending",
          reason: "awaiting deployment facts",
        }),
      ]);
      expect(queues.growth_attribution).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            dealId: "D-open",
            routeKind: "human_assisted",
            sourceChannel: "inbound_form",
            status: "no_commercial_state",
          }),
          expect.objectContaining({
            dealId: "D-closed",
            routeKind: "human_assisted",
            status: "closed_won",
          }),
          expect.objectContaining({
            dealId: "D-self",
            routeKind: "self_serve",
            sourceChannel: "event",
            priority: "low",
          }),
        ]),
      );
    });
  });

  it("keeps older pending readiness rows in role queues outside the recent scan", () => {
    withTempStore((store) => {
      const olderDeal = routed();
      olderDeal.id = "D-older";
      olderDeal.company = "Older Pending Handoff";
      store.recordRouted(olderDeal, 0, {
        mode: "dry_run",
        status: "dry_run",
      });
      store.recordLocalCommercialState({
        dealId: "D-older",
        commercialState: "closed_won",
        sourceEventId: "b9b9b9b9-b9b9-49b9-89b9-b9b9b9b9b9b9",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });

      for (let i = 0; i < 101; i += 1) {
        const filler = routed();
        filler.id = `D-fill-${String(i).padStart(3, "0")}`;
        filler.company = `Filler ${i}`;
        store.recordRouted(filler, 0, {
          mode: "dry_run",
          status: "dry_run",
        });
      }

      expect(store.roleQueues(1).deployment_readiness).toEqual([
        expect.objectContaining({
          dealId: "D-older",
          status: "pending",
        }),
      ]);
    });
  });

  it("keeps older open human-assisted work in role queues outside the recent scan", () => {
    withTempStore((store) => {
      const olderDeal = routed();
      olderDeal.id = "D-older-open";
      olderDeal.company = "Older Strategic Freight";
      olderDeal.dealUSD = 999999;
      store.recordRouted(olderDeal, 0, {
        mode: "dry_run",
        status: "dry_run",
      });

      for (let i = 0; i < 101; i += 1) {
        const filler = routed();
        filler.id = `D-open-fill-${String(i).padStart(3, "0")}`;
        filler.company = `Open Filler ${i}`;
        store.recordRouted(filler, 0, {
          mode: "dry_run",
          status: "dry_run",
        });
      }

      expect(store.roleQueues(1).ae_attention).toEqual([
        expect.objectContaining({
          dealId: "D-older-open",
          priority: "high",
        }),
      ]);
      expect(store.roleQueues(1).finance_review).toEqual([
        expect.objectContaining({
          dealId: "D-older-open",
        }),
      ]);
    });
  });

  it("opens and closes role-queue work items with idempotent local commands", () => {
    withTempStore((store) => {
      const deal = routed();
      deal.id = "D-work-item";
      deal.company = "Work Item Freight";
      store.recordRouted(deal, 0, { mode: "dry_run", status: "dry_run" });

      const signal = store.roleQueues().ae_attention[0];
      if (!signal) throw new Error("expected AE attention signal");

      const opened = store.recordLocalWorkItem(
        {
          dealId: deal.id,
          queue: "ae_attention",
          sourceEventId: "51515151-5151-4151-9151-515151515151",
          owner: "ae.morgan",
          createdBy: "operator-console",
          occurredAt: "2026-05-24T15:00:00.000Z",
          reason: "Open from queue.",
        },
        signal,
      );
      expect(opened.status).toBe("recorded");
      expect(opened.workItem).toBeDefined();
      const workItemId = opened.workItem!.id;
      expect(opened.workItem).toEqual(
        expect.objectContaining({
          dealId: deal.id,
          queue: "ae_attention",
          status: "assigned",
          owner: "ae.morgan",
          sourceKey: "role_queue:ae_attention:D-work-item",
        }),
      );

      const duplicate = store.recordLocalWorkItem(
        {
          dealId: deal.id,
          queue: "ae_attention",
          sourceEventId: "51515151-5151-4151-9151-515151515151",
          owner: "ae.morgan",
          createdBy: "operator-console",
          occurredAt: "2026-05-24T15:00:00.000Z",
          reason: "Open from queue.",
        },
        signal,
      );
      expect(duplicate.status).toBe("duplicate");

      const alreadyExists = store.recordLocalWorkItem(
        {
          dealId: deal.id,
          queue: "ae_attention",
          sourceEventId: "52525252-5252-4252-9252-525252525252",
          owner: "ae.morgan",
          createdBy: "operator-console",
          occurredAt: "2026-05-24T15:05:00.000Z",
          reason: "Second operator click.",
        },
        signal,
      );
      expect(alreadyExists.status).toBe("already_exists");

      const reassigned = store.recordLocalWorkItemAction({
        workItemId,
        sourceEventId: "56565656-5656-4656-9656-565656565656",
        action: "assign",
        humanPrincipal: "operator-console",
        occurredAt: "2026-05-24T15:08:00.000Z",
        owner: "ae.taylor",
        reason: "Taylor owns this lane.",
      });
      expect(reassigned.status).toBe("recorded");
      expect(reassigned.workItem?.owner).toBe("ae.taylor");

      const staleAssign = store.recordLocalWorkItemAction({
        workItemId,
        sourceEventId: "57575757-5757-4757-9757-575757575757",
        action: "assign",
        humanPrincipal: "operator-console",
        occurredAt: "2026-05-24T15:06:00.000Z",
        owner: "ae.older",
        reason: "Older owner update arrived late.",
      });
      expect(staleAssign.status).toBe("superseded");
      expect(staleAssign.workItem?.owner).toBe("ae.taylor");

      const staleWaive = store.recordLocalWorkItemAction({
        workItemId,
        sourceEventId: "58585858-5858-4858-9858-585858585858",
        action: "waive",
        humanPrincipal: "operator-console",
        occurredAt: "2026-05-24T15:06:30.000Z",
        reason: "Older terminal update arrived late.",
      });
      expect(staleWaive.status).toBe("superseded");
      expect(staleWaive.workItem?.status).toBe("assigned");

      const resolved = store.recordLocalWorkItemAction({
        workItemId,
        sourceEventId: "53535353-5353-4353-9353-535353535353",
        action: "resolve",
        humanPrincipal: "operator-console",
        occurredAt: "2026-05-24T15:10:00.000Z",
        reason: "AE followed up.",
      });
      expect(resolved.status).toBe("recorded");
      expect(resolved.workItem).toEqual(
        expect.objectContaining({
          status: "resolved",
          resolvedBy: "operator-console",
          resolutionReason: "AE followed up.",
        }),
      );

      const afterClose = store.recordLocalWorkItemAction({
        workItemId,
        sourceEventId: "54545454-5454-4454-9454-545454545454",
        action: "waive",
        humanPrincipal: "operator-console",
        occurredAt: "2026-05-24T15:15:00.000Z",
        reason: "No longer needed.",
      });
      expect(afterClose.status).toBe("already_closed");

      const assignAfterClose = store.recordLocalWorkItemAction({
        workItemId,
        sourceEventId: "59595959-5959-4959-9959-595959595959",
        action: "assign",
        humanPrincipal: "operator-console",
        occurredAt: "2026-05-24T15:16:00.000Z",
        owner: "ae.closed",
        reason: "Closed items should not be reassigned.",
      });
      expect(assignAfterClose.status).toBe("already_closed");

      const reopened = store.recordLocalWorkItem(
        {
          dealId: deal.id,
          queue: "ae_attention",
          sourceEventId: "55555555-5555-4555-9555-555555555555",
          owner: "ae.morgan",
          createdBy: "operator-console",
          occurredAt: "2026-05-24T15:20:00.000Z",
          reason: "Deal returned to the queue.",
        },
        signal,
      );
      expect(reopened.status).toBe("recorded");
      expect(reopened.workItem).toEqual(
        expect.objectContaining({
          sourceKey: "role_queue:ae_attention:D-work-item",
          status: "assigned",
          resolvedAt: null,
          resolvedBy: null,
          resolutionReason: null,
        }),
      );
      expect(reopened.workItem?.id).not.toBe(workItemId);
      // The operator queue renders currently assigned work before closed history.
      expect(store.workItems()).toEqual([
        expect.objectContaining({
          id: reopened.workItem?.id,
          status: "assigned",
        }),
        expect.objectContaining({
          id: workItemId,
          status: "resolved",
        }),
      ]);
    });
  });

  it("waives assigned role-queue work items", () => {
    withTempStore((store) => {
      const deal = routed();
      deal.id = "D-waive-work-item";
      deal.company = "Waive Work Freight";
      store.recordRouted(deal, 0, { mode: "dry_run", status: "dry_run" });

      const signal = store.roleQueues().ae_attention[0];
      if (!signal) throw new Error("expected AE attention signal");
      const opened = store.recordLocalWorkItem(
        {
          dealId: deal.id,
          queue: "ae_attention",
          sourceEventId: "61616161-6161-4161-9161-616161616161",
          owner: "ae.morgan",
          createdBy: "operator-console",
          occurredAt: "2026-05-24T16:00:00.000Z",
        },
        signal,
      );
      expect(opened.workItem).toBeDefined();
      const workItemId = opened.workItem!.id;
      const waived = store.recordLocalWorkItemAction({
        workItemId,
        sourceEventId: "62626262-6262-4262-9262-626262626262",
        action: "waive",
        humanPrincipal: "operator-console",
        occurredAt: "2026-05-24T16:05:00.000Z",
        reason: "Queue signal reviewed and waived.",
      });

      expect(waived.status).toBe("recorded");
      expect(waived.workItem).toEqual(
        expect.objectContaining({
          status: "waived",
          resolvedBy: "operator-console",
          resolutionReason: "Queue signal reviewed and waived.",
        }),
      );
    });
  });

  it("drafts agent suggestions from assigned work items", () => {
    withTempStore((store) => {
      const deal = routed();
      deal.id = "D-work-item-suggestion";
      deal.company = "Suggestion Work Freight";
      store.recordRouted(deal, 0, { mode: "dry_run", status: "dry_run" });

      const signal = store.roleQueues().ae_attention[0];
      if (!signal) throw new Error("expected AE attention signal");
      const opened = store.recordLocalWorkItem(
        {
          dealId: deal.id,
          queue: "ae_attention",
          sourceEventId: "63636363-6363-4363-9363-636363636363",
          owner: "ae.morgan",
          createdBy: "operator-console",
          occurredAt: "2026-05-24T17:00:00.000Z",
          reason: "Open from queue.",
        },
        signal,
      );
      expect(opened.workItem).toBeDefined();

      const first = store.recordWorkItemSuggestions({
        createdBy: "work-item-agent",
        evaluatedAt: "2026-05-24T17:05:00.000Z",
        limit: 5,
      });
      const reassigned = store.recordLocalWorkItemAction({
        workItemId: opened.workItem!.id,
        sourceEventId: "65656565-6565-4565-9565-656565656565",
        action: "assign",
        humanPrincipal: "operator-console",
        occurredAt: "2026-05-24T17:07:00.000Z",
        owner: "ae.taylor",
        reason: "Taylor owns follow-up.",
      });
      const replay = store.recordWorkItemSuggestions({
        createdBy: "work-item-agent",
        evaluatedAt: "2026-05-24T17:10:00.000Z",
        limit: 5,
      });
      const resolved = store.recordLocalWorkItemAction({
        workItemId: opened.workItem!.id,
        sourceEventId: "64646464-6464-4464-9464-646464646464",
        action: "resolve",
        humanPrincipal: "operator-console",
        occurredAt: "2026-05-24T17:15:00.000Z",
        reason: "Suggestion reviewed.",
      });
      const afterResolve = store.recordWorkItemSuggestions({
        createdBy: "work-item-agent",
        evaluatedAt: "2026-05-24T17:20:00.000Z",
        limit: 5,
      });
      const reopened = store.recordLocalWorkItem(
        {
          dealId: deal.id,
          queue: "ae_attention",
          sourceEventId: "66666666-6666-4666-9666-666666666666",
          owner: "ae.morgan",
          createdBy: "operator-console",
          occurredAt: "2026-05-24T17:25:00.000Z",
          reason: "Deal returned to the queue.",
        },
        signal,
      );
      const afterReopen = store.recordWorkItemSuggestions({
        createdBy: "work-item-agent",
        evaluatedAt: "2026-05-24T17:30:00.000Z",
        limit: 5,
      });

      expect(first).toEqual(
        expect.objectContaining({
          status: "recorded",
          attempted: 1,
          recorded: 1,
          duplicate: 0,
          skipped: 0,
          results: [
            expect.objectContaining({
              workItemId: opened.workItem!.id,
              dealId: deal.id,
              queue: "ae_attention",
              status: "recorded",
              title: expect.stringContaining("Draft AE next step"),
            }),
          ],
        }),
      );
      expect(first.results[0]?.sourceEventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(reassigned.status).toBe("recorded");
      expect(replay).toEqual(
        expect.objectContaining({
          status: "no_signals",
          attempted: 0,
          recorded: 0,
          duplicate: 0,
        }),
      );
      expect(resolved.status).toBe("recorded");
      expect(afterResolve).toEqual(
        expect.objectContaining({
          status: "no_signals",
          attempted: 0,
          recorded: 0,
          duplicate: 0,
        }),
      );
      expect(reopened.status).toBe("recorded");
      expect(reopened.workItem?.id).not.toBe(opened.workItem!.id);
      expect(afterReopen).toEqual(
        expect.objectContaining({
          status: "recorded",
          attempted: 1,
          recorded: 1,
          duplicate: 0,
          results: [
            expect.objectContaining({
              workItemId: reopened.workItem!.id,
              status: "recorded",
            }),
          ],
        }),
      );
      expect(store.agentSuggestions()).toEqual([
        expect.objectContaining({
          dealId: deal.id,
          kind: "handoff_summary",
          status: "proposed",
          title: expect.stringContaining("Draft AE next step"),
        }),
        expect.objectContaining({
          dealId: deal.id,
          kind: "handoff_summary",
          status: "proposed",
          title: expect.stringContaining("Draft AE next step"),
        }),
      ]);
    });
  });

  it("rejects non-canonical work item due dates before drafting", () => {
    withTempStore((store) => {
      const deal = routed();
      deal.id = "D-work-item-bad-due";
      deal.company = "Bad Due Freight";
      store.recordRouted(deal, 0, { mode: "dry_run", status: "dry_run" });

      const signal = store.roleQueues().ae_attention[0];
      if (!signal) throw new Error("expected AE attention signal");

      expect(() =>
        store.recordLocalWorkItem(
          {
            dealId: deal.id,
            queue: "ae_attention",
            sourceEventId: "68686868-6868-4868-9868-686868686868",
            owner: "ae.morgan",
            createdBy: "operator-console",
            occurredAt: "2026-05-24T17:35:00.000Z",
            dueAt: "2026-05-24T17:40:00Z",
            reason: "Open from queue.",
          },
          signal,
        ),
      ).toThrow(/work item dueAt must be canonical UTC ISO timestamp/);

      const opened = store.recordLocalWorkItem(
        {
          dealId: deal.id,
          queue: "ae_attention",
          sourceEventId: "69696969-6969-4969-9969-696969696969",
          owner: "ae.morgan",
          createdBy: "operator-console",
          occurredAt: "2026-05-24T17:36:00.000Z",
          dueAt: "2026-05-24T17:40:00.000Z",
          reason: "Open from queue.",
        },
        signal,
      );
      const db = (store as unknown as {
        db: InstanceType<typeof DatabaseSync>;
      }).db;
      db.prepare("UPDATE work_items SET due_at = ? WHERE id = ?").run(
        "2026-05-24T17:40:00Z",
        opened.workItem!.id,
      );

      const run = store.recordWorkItemSuggestions({
        createdBy: "work-item-agent",
        evaluatedAt: "2026-05-24T17:45:00.000Z",
        limit: 5,
      });

      expect(run.status).toBe("recorded");
      expect(store.agentSuggestions()[0]?.body).not.toContain("Due ");
    });
  });

  it("uses the stored work-item suggestion source id instead of recomputing it", () => {
    withTempStore((store) => {
      const deal = routed();
      deal.id = "D-work-item-stored-source";
      deal.company = "Stored Source Freight";
      store.recordRouted(deal, 0, { mode: "dry_run", status: "dry_run" });

      const signal = store.roleQueues().ae_attention[0];
      if (!signal) throw new Error("expected AE attention signal");
      const opened = store.recordLocalWorkItem(
        {
          dealId: deal.id,
          queue: "ae_attention",
          sourceEventId: "67676767-6767-4767-9767-676767676767",
          owner: "ae.morgan",
          createdBy: "operator-console",
          occurredAt: "2026-05-24T17:40:00.000Z",
          reason: "Open from queue.",
        },
        signal,
      );
      const legacyStoredSourceId = "77777777-7777-4777-9777-777777777777";
      const db = (store as unknown as {
        db: InstanceType<typeof DatabaseSync>;
      }).db;
      db.prepare(
        `UPDATE work_items
         SET agent_suggestion_source_event_id = ?
         WHERE id = ?`,
      ).run(legacyStoredSourceId, opened.workItem!.id);

      const run = store.recordWorkItemSuggestions({
        createdBy: "work-item-agent",
        evaluatedAt: "2026-05-24T17:45:00.000Z",
        limit: 5,
      });
      const replay = store.recordWorkItemSuggestions({
        createdBy: "work-item-agent",
        evaluatedAt: "2026-05-24T17:50:00.000Z",
        limit: 5,
      });

      expect(run.results[0]).toEqual(
        expect.objectContaining({
          sourceEventId: legacyStoredSourceId,
          status: "recorded",
        }),
      );
      expect(store.agentSuggestions()[0]?.sourceEventId).toBe(
        legacyStoredSourceId,
      );
      expect(replay).toEqual(
        expect.objectContaining({
          status: "no_signals",
          attempted: 0,
          recorded: 0,
        }),
      );
    });
  });

  it("drafts queue-specific suggestion kinds from assigned work items", () => {
    withTempStore((store) => {
      const cases: Array<{
        queue: RoleQueueKind;
        expectedKind: AgentSuggestionKind;
        expectedTitle: string;
      }> = [
        {
          queue: "ae_attention",
          expectedKind: "handoff_summary",
          expectedTitle: "Draft AE next step",
        },
        {
          queue: "finance_review",
          expectedKind: "missing_field_question",
          expectedTitle: "Draft finance review request",
        },
        {
          queue: "legal_review",
          expectedKind: "missing_field_question",
          expectedTitle: "Draft legal review request",
        },
        {
          queue: "deployment_readiness",
          expectedKind: "handoff_summary",
          expectedTitle: "Draft deployment handoff",
        },
        {
          queue: "growth_attribution",
          expectedKind: "missing_field_question",
          expectedTitle: "Draft growth follow-up",
        },
      ];

      for (const [index, testCase] of cases.entries()) {
        const deal = routed();
        deal.id = `D-work-item-kind-${index}`;
        deal.company = `Queue Kind ${index}`;
        store.recordRouted(deal, 0, { mode: "dry_run", status: "dry_run" });

        const signal: RoleQueueItem = {
          queue: testCase.queue,
          dealId: deal.id,
          company: deal.company,
          amount: deal.dealUSD,
          routeKind: deal.route.kind,
          sourceChannel: deal.sourceChannel,
          salesOwner: "ae.morgan",
          priority: index === cases.length - 1 ? "low" : "medium",
          reason: `${testCase.queue} needs operator follow-up.`,
          status: "closed_won",
          updatedAt: `2026-05-24T18:0${index}:00.000Z`,
        };
        const opened = store.recordLocalWorkItem(
          {
            dealId: deal.id,
            queue: testCase.queue,
            sourceEventId: `90000000-0000-4000-8000-00000000000${index}`,
            owner: "ops.owner",
            createdBy: "operator-console",
            occurredAt: signal.updatedAt,
            reason: "Open from queue.",
          },
          signal,
        );
        expect(opened.status).toBe("recorded");
      }

      const run = store.recordWorkItemSuggestions({
        createdBy: "work-item-agent",
        evaluatedAt: "2026-05-24T18:10:00.000Z",
        limit: 5,
      });
      const suggestionsById = new Map(
        store.agentSuggestions().map((suggestion) => [suggestion.id, suggestion]),
      );

      expect(run).toEqual(
        expect.objectContaining({
          status: "recorded",
          attempted: 5,
          recorded: 5,
          duplicate: 0,
        }),
      );
      for (const testCase of cases) {
        const result = run.results.find(
          (candidate) => candidate.queue === testCase.queue,
        );
        expect(result).toEqual(
          expect.objectContaining({
            queue: testCase.queue,
            status: "recorded",
            title: expect.stringContaining(testCase.expectedTitle),
          }),
        );
        expect(suggestionsById.get(result!.suggestionId!)?.kind).toBe(
          testCase.expectedKind,
        );
      }
    });
  });

  it("drafts by assignment age and skips previously drafted work items", () => {
    withTempStore((store) => {
      const openedIds: string[] = [];
      for (const [index, company] of ["Oldest Freight", "Newest Freight"].entries()) {
        const deal = routed();
        deal.id = `D-work-item-age-${index}`;
        deal.company = company;
        store.recordRouted(deal, 0, { mode: "dry_run", status: "dry_run" });

        const signal: RoleQueueItem = {
          queue: "ae_attention",
          dealId: deal.id,
          company: deal.company,
          amount: deal.dealUSD,
          routeKind: deal.route.kind,
          sourceChannel: deal.sourceChannel,
          salesOwner: "ae.morgan",
          priority: "medium",
          reason: "AE follow-up needed.",
          status: "closed_won",
          updatedAt: `2026-05-24T19:${index}0:00.000Z`,
        };
        const opened = store.recordLocalWorkItem(
          {
            dealId: deal.id,
            queue: "ae_attention",
            sourceEventId: `91000000-0000-4000-8000-00000000000${index}`,
            owner: "ae.morgan",
            createdBy: "operator-console",
            occurredAt: signal.updatedAt,
            reason: "Open from queue.",
          },
          signal,
        );
        expect(opened.workItem).toBeDefined();
        openedIds.push(opened.workItem!.id);
      }
      const churnedOwner = store.recordLocalWorkItemAction({
        workItemId: openedIds[0]!,
        sourceEventId: "92000000-0000-4000-8000-000000000000",
        action: "assign",
        humanPrincipal: "operator-console",
        occurredAt: "2026-05-24T19:25:00.000Z",
        owner: "ae.taylor",
        reason: "Oldest item changed owner but should keep FIFO draft order.",
      });
      expect(churnedOwner.status).toBe("recorded");

      const run = store.recordWorkItemSuggestions({
        createdBy: "work-item-agent",
        evaluatedAt: "2026-05-24T19:30:00.000Z",
        limit: 1,
      });

      expect(run).toEqual(
        expect.objectContaining({
          attempted: 1,
          recorded: 1,
        }),
      );
      expect(run.results[0]?.workItemId).toBe(openedIds[0]);

      const nextRun = store.recordWorkItemSuggestions({
        createdBy: "work-item-agent",
        evaluatedAt: "2026-05-24T19:35:00.000Z",
        limit: 1,
      });

      expect(nextRun).toEqual(
        expect.objectContaining({
          attempted: 1,
          duplicate: 0,
          recorded: 1,
        }),
      );
      expect(nextRun.results[0]?.workItemId).toBe(openedIds[1]);
      expect(nextRun.results[0]?.status).toBe("recorded");
    });
  });

  it("does not let unrouted work items consume draft-run slots", () => {
    withTempStore((store) => {
      const openedIds: string[] = [];
      for (const [index, company] of ["Stale Freight", "Fresh Freight"].entries()) {
        const deal = routed();
        deal.id = `D-work-item-routed-filter-${index}`;
        deal.company = company;
        store.recordRouted(deal, 0, { mode: "dry_run", status: "dry_run" });

        const signal: RoleQueueItem = {
          queue: "ae_attention",
          dealId: deal.id,
          company: deal.company,
          amount: deal.dealUSD,
          routeKind: deal.route.kind,
          sourceChannel: deal.sourceChannel,
          salesOwner: "ae.morgan",
          priority: "medium",
          reason: "AE follow-up needed.",
          status: "closed_won",
          updatedAt: `2026-05-24T20:${index}0:00.000Z`,
        };
        const opened = store.recordLocalWorkItem(
          {
            dealId: deal.id,
            queue: "ae_attention",
            sourceEventId: `93000000-0000-4000-8000-00000000000${index}`,
            owner: "ae.morgan",
            createdBy: "operator-console",
            occurredAt: signal.updatedAt,
            reason: "Open from queue.",
          },
          signal,
        );
        expect(opened.workItem).toBeDefined();
        openedIds.push(opened.workItem!.id);
      }

      const db = (store as unknown as {
        db: InstanceType<typeof DatabaseSync>;
      }).db;
      db.prepare("UPDATE deals SET stage = 'quarantined' WHERE id = ?").run(
        "D-work-item-routed-filter-0",
      );

      const run = store.recordWorkItemSuggestions({
        createdBy: "work-item-agent",
        evaluatedAt: "2026-05-24T20:30:00.000Z",
        limit: 1,
      });

      expect(run).toEqual(
        expect.objectContaining({
          status: "recorded",
          attempted: 1,
          recorded: 1,
          skipped: 0,
        }),
      );
      expect(run.results[0]?.workItemId).toBe(openedIds[1]);
    });
  });

	  it("evaluates routing policy against post-sale outcomes without changing policy", () => {
	    withTempStore((store) => {
      const closeDeal = (
        deal: RoutedDeal,
        sourceEventId: string,
      ): void => {
        store.recordRouted(deal, 0, { mode: "dry_run", status: "dry_run" });
        store.recordLocalCommercialState({
          dealId: deal.id,
          commercialState: "closed_won",
          sourceEventId,
          occurredAt: "2026-05-21T12:00:00.000Z",
          reason: null,
          expectedRedPath: false,
        });
      };
      const writeOutcome = (
        dealId: string,
        sourceEventId: string,
        outcome: LocalOutcomeInput["outcome"],
        occurredAt: string,
        arrDeltaUsd: number | null = null,
      ): void => {
        expect(
          store.recordLocalOutcome(
            outcomeInput({
              dealId,
              sourceEventId,
              outcome,
              occurredAt,
              arrDeltaUsd,
              reasonCategory: outcome === "expanded" ? "scope_expanded" : null,
            }),
          ).status,
        ).toBe("recorded");
      };

      const selfServe = routed();
      selfServe.id = "D-self-expanded";
      selfServe.company = "Self Serve Expansion";
      selfServe.dealUSD = 18_000;
      selfServe.sourceChannel = "event";
      selfServe.route = {
        kind: "self_serve",
        queue: "sales_self_serve",
        slaHours: 24,
      };
      closeDeal(selfServe, "33333333-3333-4333-8333-333333333331");
      writeOutcome(
        selfServe.id,
        "44444444-4444-4444-8444-444444444401",
        "deployment_started",
        "2026-05-22T10:00:00.000Z",
      );
      writeOutcome(
        selfServe.id,
        "44444444-4444-4444-8444-444444444402",
        "deployed",
        "2026-05-22T11:00:00.000Z",
      );
      writeOutcome(
        selfServe.id,
        "44444444-4444-4444-8444-444444444403",
        "landed",
        "2026-05-22T12:00:00.000Z",
      );
      writeOutcome(
        selfServe.id,
        "44444444-4444-4444-8444-444444444404",
        "expanded",
        "2026-05-22T13:00:00.000Z",
        25_000,
      );

      const churned = routed();
      churned.id = "D-human-churned";
      churned.company = "Churned Human Deal";
      churned.dealUSD = 90_000;
      churned.sourceChannel = "event";
      closeDeal(churned, "33333333-3333-4333-8333-333333333332");
      writeOutcome(
        churned.id,
        "44444444-4444-4444-8444-444444444405",
        "deployment_started",
        "2026-05-22T10:00:00.000Z",
      );
      writeOutcome(
        churned.id,
        "44444444-4444-4444-8444-444444444406",
        "churned",
        "2026-05-22T14:00:00.000Z",
      );

      const stalled = routed();
      stalled.id = "D-human-stalled";
      stalled.company = "Stalled Human Deal";
      stalled.dealUSD = 70_000;
      stalled.sourceChannel = "inbound_form";
      closeDeal(stalled, "33333333-3333-4333-8333-333333333333");

      const readyNotStarted = routed();
      readyNotStarted.id = "D-human-ready-not-started";
      readyNotStarted.company = "Ready But Not Started";
      readyNotStarted.dealUSD = 80_000;
      readyNotStarted.sourceChannel = "cold_reply";
      closeDeal(readyNotStarted, "33333333-3333-4333-8333-333333333334");
      store.recordLocalDeploymentFacts({
        dealId: readyNotStarted.id,
        sourceEventId: "55555555-5555-4555-8555-555555555501",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: "2026-05-22T12:00:00.000Z",
      });

      const report = store.policyEvaluation(
        50,
        undefined,
        "2026-05-23T12:00:00.000Z",
      );

      expect(report.candidateRouted).toBe(4);
      expect(report.candidateLimit).toBe(500);
      expect(report.selfServeExpanded).toEqual([
        expect.objectContaining({
          dealId: selfServe.id,
          signal: "self_serve_expanded",
          sourceChannel: "event",
          salesOwner: null,
          lastOutcomeAt: "2026-05-22T13:00:00.000Z",
          arrDeltaUsd: 25_000,
        }),
      ]);
      expect(report.humanAssistedRisk).toEqual([
        expect.objectContaining({
          dealId: churned.id,
          signal: "human_assisted_churned",
          salesOwner: "ae.morgan",
          lastOutcomeAt: "2026-05-22T14:00:00.000Z",
        }),
        expect.objectContaining({
          dealId: readyNotStarted.id,
          signal: "human_assisted_ready_not_started",
          reason: "deployment ready but no deployment start recorded",
          lastOutcomeAt: null,
        }),
        expect.objectContaining({
          dealId: stalled.id,
          signal: "human_assisted_stalled",
          reason: "awaiting deployment facts",
          lastOutcomeAt: null,
        }),
      ]);

      const eventSummary = report.sourceChannels.find(
        (summary) => summary.sourceChannel === "event",
      );
      expect(eventSummary).toEqual(
        expect.objectContaining({
          routed: 2,
          closedWon: 2,
          deploymentStarted: 2,
          landed: 1,
          expanded: 1,
          churned: 1,
          expandedArrDeltaUsd: 25_000,
        }),
      );
      const inboundSummary = report.sourceChannels.find(
        (summary) => summary.sourceChannel === "inbound_form",
      );
      expect(inboundSummary).toEqual(
        expect.objectContaining({
          routed: 1,
          closedWon: 1,
          deploymentStarted: 0,
        }),
      );
      expect(report.flags).toEqual([
        expect.objectContaining({
          flag: "pricing_approval",
          routed: 3,
          closedWon: 3,
          deploymentStarted: 1,
          churned: 1,
        }),
        expect.objectContaining({
          flag: "regulated_review",
          routed: 3,
          closedWon: 3,
          deploymentStarted: 1,
          churned: 1,
        }),
      ]);
    });
  });

  it("drafts policy evaluation recommendations into the agent suggestion ledger", () => {
    withTempStore((store) => {
      const closeDeal = (deal: RoutedDeal, sourceEventId: string): void => {
        store.recordRouted(deal, 0, { mode: "dry_run", status: "dry_run" });
        store.recordLocalCommercialState({
          dealId: deal.id,
          commercialState: "closed_won",
          sourceEventId,
          occurredAt: "2026-05-21T12:00:00.000Z",
          reason: null,
          expectedRedPath: false,
        });
      };
      const writeOutcome = (
        dealId: string,
        sourceEventId: string,
        outcome: LocalOutcomeInput["outcome"],
        occurredAt: string,
        arrDeltaUsd: number | null = null,
      ): void => {
        expect(
          store.recordLocalOutcome(
            outcomeInput({
              dealId,
              sourceEventId,
              outcome,
              occurredAt,
              arrDeltaUsd,
              reasonCategory: outcome === "expanded" ? "scope_expanded" : null,
            }),
          ).status,
        ).toBe("recorded");
      };

      const selfServe = routed();
      selfServe.id = "D-policy-rec-self-serve";
      selfServe.company = "Policy Rec Self Serve";
      selfServe.dealUSD = 18_000;
      selfServe.route = {
        kind: "self_serve",
        queue: "sales_self_serve",
        slaHours: 24,
      };
      closeDeal(selfServe, "33333333-3333-4333-8333-333333333351");
      writeOutcome(
        selfServe.id,
        "44444444-4444-4444-8444-444444444451",
        "deployment_started",
        "2026-05-22T10:00:00.000Z",
      );
      writeOutcome(
        selfServe.id,
        "44444444-4444-4444-8444-444444444452",
        "deployed",
        "2026-05-22T11:00:00.000Z",
      );
      writeOutcome(
        selfServe.id,
        "44444444-4444-4444-8444-444444444453",
        "landed",
        "2026-05-22T12:00:00.000Z",
      );
      writeOutcome(
        selfServe.id,
        "44444444-4444-4444-8444-444444444454",
        "expanded",
        "2026-05-22T13:00:00.000Z",
        25_000,
      );

      const stalled = routed();
      stalled.id = "D-policy-rec-stalled";
      stalled.company = "Policy Rec Stalled";
      stalled.dealUSD = 90_000;
      closeDeal(stalled, "33333333-3333-4333-8333-333333333352");

      const result = store.recordPolicyEvaluationRecommendations({
        createdBy: "policy-agent",
        evaluatedAt: "2026-05-23T13:00:00.000Z",
        limit: 5,
      });

      expect(result).toEqual(
        expect.objectContaining({
          evaluatedAt: "2026-05-23T13:00:00.000Z",
          attempted: 2,
          recorded: 2,
          duplicate: 0,
          idempotencyConflict: 0,
          skipped: 0,
          statusCounts: expect.objectContaining({
            recorded: 2,
            duplicate: 0,
            idempotency_conflict: 0,
            not_found: 0,
            not_routed: 0,
          }),
        }),
      );
      expect(result.results.map((item) => item.signal)).toEqual([
        "human_assisted_stalled",
        "self_serve_expanded",
      ]);
      expect(result.results[0]?.sourceEventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      const suggestions = store.agentSuggestions(10);
      expect(suggestions).toHaveLength(2);
      expect(suggestions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            dealId: stalled.id,
            kind: "policy_change_recommendation",
            status: "proposed",
            createdBy: "policy-agent",
            occurredAt: "2026-05-22T12:00:00.000Z",
          }),
          expect.objectContaining({
            dealId: selfServe.id,
            kind: "policy_change_recommendation",
            status: "proposed",
            createdBy: "policy-agent",
            occurredAt: "2026-05-22T13:00:00.000Z",
          }),
        ]),
      );

      const replay = store.recordPolicyEvaluationRecommendations({
        createdBy: "policy-agent",
        evaluatedAt: "2026-05-23T13:00:00.000Z",
        limit: 5,
      });
      expect(replay).toEqual(
        expect.objectContaining({
          attempted: 2,
          recorded: 0,
          duplicate: 2,
          idempotencyConflict: 0,
          skipped: 0,
          statusCounts: expect.objectContaining({
            recorded: 0,
            duplicate: 2,
          }),
        }),
      );
      const policyRuns = store.policyRecommendationRuns(10);
      expect(policyRuns.map((run) => run.status)).toEqual([
        "duplicate",
        "recorded",
      ]);
      expect(policyRuns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: expect.stringMatching(/^PRR-/),
            status: "recorded",
            createdBy: "policy-agent",
            evaluatedAt: "2026-05-23T13:00:00.000Z",
            limit: 5,
            attempted: 2,
            recorded: 2,
            duplicate: 0,
            results: expect.arrayContaining([
              expect.objectContaining({
                signal: "human_assisted_stalled",
                status: "recorded",
              }),
            ]),
          }),
          expect.objectContaining({
            id: expect.stringMatching(/^PRR-/),
            status: "duplicate",
            attempted: 2,
            recorded: 0,
            duplicate: 2,
          }),
        ]),
      );
    });
  });

  it("records no-signal policy recommendation runs for auditability", () => {
    withTempStore((store) => {
      const result = store.recordPolicyEvaluationRecommendations({
        createdBy: "policy-agent",
        evaluatedAt: "2026-05-23T13:00:00.000Z",
      });

      expect(result).toEqual(
        expect.objectContaining({
          status: "no_signals",
          limit: 10,
          attempted: 0,
          recorded: 0,
          duplicate: 0,
          skipped: 0,
        }),
      );
      expect(store.policyRecommendationRuns()).toEqual([
        expect.objectContaining({
          id: result.id,
          status: "no_signals",
          createdBy: "policy-agent",
          evaluatedAt: "2026-05-23T13:00:00.000Z",
          limit: 10,
          attempted: 0,
          results: [],
        }),
      ]);
    });
  });

  it("marks policy recommendation runs all_skipped when candidates are not writable", () => {
    withTempStore((store) => {
      const originalPolicyEvaluation = store.policyEvaluation.bind(store);
      store.policyEvaluation = (() => ({
        candidateRouted: 1,
        candidateLimit: 1,
        signalBackfillRouted: 0,
        signalBackfillLimitPerSignal: 0,
        selfServeExpanded: [
          {
            dealId: "D-missing-policy-candidate",
            company: "Missing Policy Candidate",
            amount: 42_000,
            routeKind: "self_serve",
            sourceChannel: "inbound_form",
            salesOwner: null,
            signal: "self_serve_expanded",
            signalObservedAt: "2026-05-23T12:00:00.000Z",
            reason: "synthetic stale candidate",
            lastOutcomeAt: null,
            arrDeltaUsd: 5_000,
          },
        ],
        humanAssistedRisk: [],
        sourceChannels: [],
        flags: [],
      })) as Store["policyEvaluation"];
      try {
        const result = store.recordPolicyEvaluationRecommendations({
          createdBy: "policy-agent",
          evaluatedAt: "2026-05-23T13:00:00.000Z",
          limit: 1,
        });

        expect(result).toEqual(
          expect.objectContaining({
            status: "all_skipped",
            attempted: 1,
            recorded: 0,
            skipped: 1,
            statusCounts: expect.objectContaining({
              not_found: 1,
              not_routed: 0,
            }),
          }),
        );
        expect(store.policyRecommendationRuns()).toEqual([
          expect.objectContaining({
            status: "all_skipped",
            skipped: 1,
          }),
        ]);
      } finally {
        store.policyEvaluation =
          originalPolicyEvaluation as Store["policyEvaluation"];
      }
    });
  });

  it("prefetches policy signals before applying recommendation priority", () => {
    withTempStore((store) => {
      const closeDeal = (deal: RoutedDeal, sourceEventId: string): void => {
        store.recordRouted(deal, 0, { mode: "dry_run", status: "dry_run" });
        store.recordLocalCommercialState({
          dealId: deal.id,
          commercialState: "closed_won",
          sourceEventId,
          occurredAt: "2026-05-21T12:00:00.000Z",
          reason: null,
          expectedRedPath: false,
        });
      };

      const stalled = routed();
      stalled.id = "D-policy-prefetch-stalled";
      stalled.company = "Large Stalled";
      stalled.dealUSD = 250_000;
      closeDeal(stalled, "33333333-3333-4333-8333-333333333353");

      const churned = routed();
      churned.id = "D-policy-prefetch-churned";
      churned.company = "Smaller Churned";
      churned.dealUSD = 25_000;
      closeDeal(churned, "33333333-3333-4333-8333-333333333354");
      expect(
        store.recordLocalOutcome(
          outcomeInput({
            dealId: churned.id,
            sourceEventId: "44444444-4444-4444-8444-444444444455",
            outcome: "deployment_started",
            occurredAt: "2026-05-22T10:00:00.000Z",
          }),
        ).status,
      ).toBe("recorded");
      expect(
        store.recordLocalOutcome(
          outcomeInput({
            dealId: churned.id,
            sourceEventId: "44444444-4444-4444-8444-444444444456",
            outcome: "churned",
            occurredAt: "2026-05-22T14:00:00.000Z",
          }),
        ).status,
      ).toBe("recorded");

      const result = store.recordPolicyEvaluationRecommendations({
        createdBy: "policy-agent",
        evaluatedAt: "2026-05-23T13:00:00.000Z",
        limit: 1,
      });

      expect(result.results).toEqual([
        expect.objectContaining({
          dealId: churned.id,
          signal: "human_assisted_churned",
          status: "recorded",
        }),
      ]);
    });
  });

  it("does not flag fresh closed-won deals as stalled before the policy SLA", () => {
    withTempStore((store) => {
      const fresh = routed();
      fresh.id = "D-fresh-closed-won";
      fresh.company = "Fresh Closed Won";
      store.recordRouted(fresh, 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: fresh.id,
        commercialState: "closed_won",
        sourceEventId: "33333333-3333-4333-8333-333333333340",
        occurredAt: "2026-05-23T11:30:00.000Z",
        reason: null,
        expectedRedPath: false,
      });

      expect(
        store.policyEvaluation(50, undefined, "2026-05-23T12:00:00.000Z")
          .humanAssistedRisk,
      ).toEqual([]);
    });
  });

  it("backfills older policy signals outside the recent routed candidate set", () => {
    withTempStore((store, dbPath) => {
      const oldSignal = routed();
      oldSignal.id = "D-old-policy-signal";
      oldSignal.company = "Old Self Serve Expansion";
      oldSignal.route = {
        kind: "self_serve",
        queue: "sales_self_serve",
        slaHours: 24,
      };
      store.recordRouted(oldSignal, 0, {
        mode: "dry_run",
        status: "dry_run",
      });
      store.recordLocalCommercialState({
        dealId: oldSignal.id,
        commercialState: "closed_won",
        sourceEventId: "33333333-3333-4333-8333-333333333341",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      for (const input of [
        outcomeInput({
          dealId: oldSignal.id,
          sourceEventId: "44444444-4444-4444-8444-444444444411",
          occurredAt: "2026-05-22T10:00:00.000Z",
        }),
        outcomeInput({
          dealId: oldSignal.id,
          sourceEventId: "44444444-4444-4444-8444-444444444412",
          outcome: "deployed",
          occurredAt: "2026-05-22T11:00:00.000Z",
        }),
        outcomeInput({
          dealId: oldSignal.id,
          sourceEventId: "44444444-4444-4444-8444-444444444413",
          outcome: "landed",
          occurredAt: "2026-05-22T12:00:00.000Z",
        }),
        outcomeInput({
          dealId: oldSignal.id,
          sourceEventId: "44444444-4444-4444-8444-444444444414",
          outcome: "expanded",
          occurredAt: "2026-05-22T13:00:00.000Z",
          arrDeltaUsd: 30_000,
          reasonCategory: "scope_expanded",
        }),
      ]) {
        expect(store.recordLocalOutcome(input).status).toBe("recorded");
      }
      const db = new DatabaseSync(dbPath);
      try {
        db
          .prepare("UPDATE deals SET updated_at = ? WHERE id = ?")
          .run("2026-05-20T00:00:00.000Z", oldSignal.id);
      } finally {
        db.close();
      }

      for (let i = 0; i < 101; i += 1) {
        const filler = routed();
        filler.id = `D-policy-fill-${String(i).padStart(3, "0")}`;
        filler.company = `Policy Filler ${i}`;
        store.recordRouted(filler, 0, {
          mode: "dry_run",
          status: "dry_run",
        });
      }

      const report = store.policyEvaluation(
        1,
        undefined,
        "2026-05-23T12:00:00.000Z",
      );

      expect(report.signalBackfillRouted).toBeGreaterThanOrEqual(1);
      expect(report.selfServeExpanded).toEqual([
        expect.objectContaining({
          dealId: oldSignal.id,
          arrDeltaUsd: 30_000,
        }),
      ]);
    });
  });

  it("exposes persisted readiness state with fact freshness for the dashboard", () => {
    withTempStore((store, dbPath) => {
      const acceptedAt = new Date().toISOString();
      const staleAcceptedAt = new Date(
        Date.now() - (DEPLOYMENT_FACT_MAX_AGE_DAYS + 1) * 86_400_000,
      ).toISOString();
      const expectedStaleAt = new Date(
        Date.parse(staleAcceptedAt) +
          DEPLOYMENT_FACT_MAX_AGE_DAYS * 86_400_000,
      ).toISOString();

      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: acceptedAt,
      });

      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(
          "UPDATE deployment_facts SET occurred_at=? WHERE deal_id=?",
        ).run(staleAcceptedAt, "D-lease");
      } finally {
        db.close();
      }

      expect(store.deploymentReadinessRecords()).toEqual([
        expect.objectContaining({
          dealId: "D-lease",
          readiness: "ready",
          blockerCode: null,
          secondaryBlockerCodes: null,
          factsStatus: "stale",
          factsFresh: false,
          factsStaleAt: expectedStaleAt,
        }),
      ]);
      expect(store.metrics()).toEqual(
        expect.objectContaining({
          deploymentReadiness: {
            not_required: 0,
            pending: 0,
            ready: 1,
            blocked: 0,
          },
          readinessFactsStaleProjected: 1,
        }),
      );
    });
  });

  it("counts pending readiness over SLA and stale ignored deployment facts", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: "D-lease",
        commercialState: "closed_won",
        sourceEventId: "bdbdbdbd-bdbd-4dbd-8dbd-bdbdbdbdbdbd",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      store.recordLocalDeploymentFacts({
        dealId: "D-lease",
        sourceEventId: "bebebebe-bebe-4ebe-8ebe-bebebebebebe",
        useCaseClear: true,
        integrationsKnown: true,
        dataReady: true,
        operator: "DS",
        occurredAt: new Date(
          Date.now() - (DEPLOYMENT_FACT_MAX_AGE_DAYS + 1) * 86_400_000,
        ).toISOString(),
      });

      const oldPendingAt = new Date(
        Date.now() - (READINESS_PENDING_SLA_HOURS + 1) * 3_600_000,
      ).toISOString();
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(
          "UPDATE deployment_readiness SET state_entered_at=? WHERE deal_id=?",
        ).run(oldPendingAt, "D-lease");
      } finally {
        db.close();
      }

      expect(store.metrics()).toEqual(
        expect.objectContaining({
          deploymentReadiness: {
            not_required: 0,
            pending: 1,
            ready: 0,
            blocked: 0,
          },
          readinessPendingOverSla: 1,
          readinessFactsStaleIgnored: 1,
        }),
      );
    });
  });
});

describe("Store idempotency migration", () => {
  it("migrates idempotency violations to admit newer scopes without losing rows", () => {
    const dir = join(tmpdir(), `gtm-router-outcome-migration-${process.pid}-${Date.now()}`);
    mkdirSync(dir);
    const dbPath = join(dir, "router.db");
    try {
      const db = new DatabaseSync(dbPath);
      try {
        db.prepare(
          `CREATE TABLE idempotency_violations (
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
               scope IN ('commercial_state', 'deployment_facts') OR
               scope LIKE 'external_event_observation:%'
             )
           )`,
        ).run();
        db.prepare(
          `INSERT INTO idempotency_violations (
             id, source, source_event_id, scope, existing_payload_hash,
             incoming_payload_hash, reason, created_at
           )
           VALUES (
             'phase1-violation', 'local', 'evt-phase1', 'commercial_state',
             'existing', 'incoming', 'phase 1 replay',
             '2026-05-21T00:00:00.000Z'
           )`,
        ).run();
      } finally {
        db.close();
      }

      new Store(dbPath).close();
      const sqlAfterFirstOpen = new DatabaseSync(dbPath);
      let migratedTableSql: string;
      try {
        const row = sqlAfterFirstOpen
          .prepare(
            `SELECT sql
             FROM sqlite_master
             WHERE type='table'
               AND name='idempotency_violations'`,
          )
          .get() as { sql: string } | undefined;
        migratedTableSql = row?.sql ?? "";
        expect(migratedTableSql).toContain("'outcome'");
        expect(migratedTableSql).toContain("'agent_suggestion'");
        expect(migratedTableSql).toContain("'agent_suggestion_decision'");
      } finally {
        sqlAfterFirstOpen.close();
      }

      new Store(dbPath).close();
      const sqlAfterSecondOpen = new DatabaseSync(dbPath);
      try {
        const row = sqlAfterSecondOpen
          .prepare(
            `SELECT sql
             FROM sqlite_master
             WHERE type='table'
               AND name='idempotency_violations'`,
          )
          .get() as { sql: string } | undefined;
        expect(row?.sql).toBe(migratedTableSql);
      } finally {
        sqlAfterSecondOpen.close();
      }

      const migrated = new DatabaseSync(dbPath);
      try {
        const preserved = migrated
          .prepare(
            `SELECT scope, existing_payload_hash, incoming_payload_hash
             FROM idempotency_violations
             WHERE id = 'phase1-violation'`,
          )
          .get() as
          | {
              scope: string;
              existing_payload_hash: string;
              incoming_payload_hash: string;
            }
          | undefined;
        expect(preserved).toEqual({
          scope: "commercial_state",
          existing_payload_hash: "existing",
          incoming_payload_hash: "incoming",
        });

        migrated
          .prepare(
            `INSERT INTO idempotency_violations (
               id, source, source_event_id, scope, existing_payload_hash,
               incoming_payload_hash, reason, created_at
             )
             VALUES ('outcome-violation', 'local', 'evt-outcome', 'outcome', 'a', 'b', 'outcome replay', ?)`,
          )
          .run("2026-05-21T00:00:00.000Z");
        migrated
          .prepare(
            `INSERT INTO idempotency_violations (
               id, source, source_event_id, scope, existing_payload_hash,
               incoming_payload_hash, reason, created_at
             )
             VALUES (
               'agent-violation', 'local_agent', 'evt-agent',
               'agent_suggestion', 'a', 'b', 'agent replay', ?
             )`,
          )
          .run("2026-05-21T00:00:00.000Z");
        migrated
          .prepare(
            `INSERT INTO idempotency_violations (
               id, source, source_event_id, scope, existing_payload_hash,
               incoming_payload_hash, reason, created_at
             )
             VALUES (
               'agent-decision-violation', 'local_agent', 'evt-agent-decision',
               'agent_suggestion_decision', 'a', 'b', 'agent decision replay', ?
             )`,
          )
          .run("2026-05-21T00:00:00.000Z");

        expect(() =>
          migrated
            .prepare(
              `INSERT INTO idempotency_violations (
                 id, source, source_event_id, scope, existing_payload_hash,
                 incoming_payload_hash, reason, created_at
               )
               VALUES ('bad-scope', 'local', 'evt-bad', 'slack', 'a', 'b', 'bad', ?)`,
            )
            .run("2026-05-21T00:00:00.000Z"),
        ).toThrow();
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Store Phase 2 outcome writes", () => {
  it("requires canonical UTC ISO timestamps at the store boundary", () => {
    withTempStore((store) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      expect(() =>
        store.recordLocalCommercialState({
          dealId: "D-lease",
          commercialState: "closed_won",
          sourceEventId: "22222222-2222-4222-8222-222222222221",
          occurredAt: "2026-05-21T12:00:00+02:00",
          reason: null,
          expectedRedPath: false,
        }),
      ).toThrow(/canonical UTC ISO/);
      expect(() =>
        store.recordLocalDeploymentFacts({
          dealId: "D-lease",
          sourceEventId: "22222222-2222-4222-8222-222222222222",
          useCaseClear: true,
          integrationsKnown: true,
          dataReady: true,
          operator: "DS",
          occurredAt: "2026-05-22T12:00:00+02:00",
        }),
      ).toThrow(/canonical UTC ISO/);
      expect(() =>
        store.recordLocalOutcome(
          outcomeInput({
            sourceEventId: "22222222-2222-4222-8222-222222222223",
            occurredAt: "2026-05-22T12:00:00+02:00",
          }),
        ),
      ).toThrow(/canonical UTC ISO/);
    });
  });

  it("rejects unknown or not-closed-won deals before claiming an outcome event", () => {
    withTempStore((store, dbPath) => {
      const missing = store.recordLocalOutcome(
        outcomeInput({
          dealId: "missing",
          sourceEventId: "22222222-2222-4222-8222-222222222223",
        }),
      );
      expect(missing).toEqual(
        expect.objectContaining({
          status: "not_found",
          accepted: false,
          event: null,
          rejection: null,
        }),
      );
      expect(
        readExternalEventKey(
          dbPath,
          outcomeEventKey("22222222-2222-4222-8222-222222222223"),
        ),
      ).toBeUndefined();

      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const notClosedWon = store.recordLocalOutcome(
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222224",
        }),
      );
      expect(notClosedWon).toEqual(
        expect.objectContaining({
          status: "not_closed_won",
          accepted: false,
          event: null,
          rejection: null,
        }),
      );
      expect(
        readExternalEventKey(
          dbPath,
          outcomeEventKey("22222222-2222-4222-8222-222222222224"),
        ),
      ).toBeUndefined();
    });
  });

  it("records accepted outcomes and appends a post-sale timeline event", () => {
    withTempStore((store, dbPath) => {
      closedWonRoutedDeal(store);
      const input = outcomeInput({
        sourceEventId: "22222222-2222-4222-8222-222222222225",
        reasonCategory: "customer_ready",
      });

      const result = store.recordLocalOutcome(input);

      expect(result).toEqual(
        expect.objectContaining({
          status: "recorded",
          accepted: true,
          eventKey: outcomeEventKey(input.sourceEventId),
          event: expect.objectContaining({
            dealId: "D-lease",
            sourceEventId: input.sourceEventId,
            outcome: "deployment_started",
            arrDeltaUsd: null,
            reasonCategory: "customer_ready",
          }),
          rejection: null,
        }),
      );
      expect(readExternalEventKey(dbPath, outcomeEventKey(input.sourceEventId))).toEqual(
        expect.objectContaining({
          notify_status: "ok",
          scope: "source_event",
        }),
      );
      expect(store.outcomeEvents("D-lease")).toHaveLength(1);
      expect(store.outcomeEventCount()).toBe(1);
      expect(store.events("D-lease").at(-1)).toEqual(
        expect.objectContaining({
          from: "routed",
          to: "routed",
          detail: "post_sale_outcome",
          meta: expect.objectContaining({
            kind: "post_sale_outcome",
            source: "local",
            sourceEventId: input.sourceEventId,
            outcome: "deployment_started",
            operatorSource: "self_reported",
            arrDeltaUsd: null,
            reasonCategory: "customer_ready",
          }),
        }),
      );
    });
  });

  it("dedupes identical outcome replays and records idempotency conflicts", () => {
    withTempStore((store, dbPath) => {
      closedWonRoutedDeal(store);
      const input = outcomeInput({
        sourceEventId: "22222222-2222-4222-8222-222222222226",
      });

      expect(store.recordLocalOutcome(input).status).toBe("recorded");
      const duplicate = store.recordLocalOutcome(input);
      expect(duplicate).toEqual(
        expect.objectContaining({
          status: "duplicate",
          accepted: false,
          event: expect.objectContaining({ sourceEventId: input.sourceEventId }),
          rejection: null,
        }),
      );
      expect(store.outcomeEvents("D-lease")).toHaveLength(1);

      const conflict = store.recordLocalOutcome({
        ...input,
        reasonCategory: "other",
      });
      expect(conflict).toEqual(
        expect.objectContaining({
          status: "idempotency_conflict",
          accepted: false,
          event: null,
          rejection: null,
        }),
      );

      const db = new DatabaseSync(dbPath);
      try {
        const violation = db
          .prepare(
            `SELECT scope, source_event_id
             FROM idempotency_violations
             WHERE scope = 'outcome'`,
          )
          .get() as { scope: string; source_event_id: string } | undefined;
        expect(violation).toEqual({
          scope: "outcome",
          source_event_id: input.sourceEventId,
        });
        const rejectionCount = db
          .prepare("SELECT COUNT(*) n FROM outcome_rejections")
          .get() as { n: number };
        expect(rejectionCount.n).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  it("surfaces the prior accepted outcome when replayed after commercial correction", () => {
    withTempStore((store, dbPath) => {
      closedWonRoutedDeal(store);
      const input = outcomeInput({
        sourceEventId: "22222222-2222-4222-8222-222222222233",
      });
      expect(store.recordLocalOutcome(input).status).toBe("recorded");

      const db = new DatabaseSync(dbPath);
      try {
        db
          .prepare(
            `UPDATE commercial_states
             SET commercial_state = 'closed_lost'
             WHERE deal_id = ?`,
          )
          .run(input.dealId);
      } finally {
        db.close();
      }

      const replay = store.recordLocalOutcome(input);
      expect(replay).toEqual(
        expect.objectContaining({
          status: "not_closed_won",
          accepted: false,
          event: expect.objectContaining({
            sourceEventId: input.sourceEventId,
            outcome: "deployment_started",
          }),
          rejection: null,
        }),
      );
    });
  });

  it("records semantic outcome rejections after claiming the source event", () => {
    withTempStore((store, dbPath) => {
      closedWonRoutedDeal(store);
      const missingPrior = store.recordLocalOutcome(
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222227",
          outcome: "deployed",
        }),
      );
      const duplicateMissingPrior = store.recordLocalOutcome(
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222227",
          outcome: "deployed",
        }),
      );
      const invalidArr = store.recordLocalOutcome(
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222228",
          outcome: "deployed",
          arrDeltaUsd: 10_000,
        }),
      );
      const started = store.recordLocalOutcome(
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222229",
        }),
      );
      const duplicateSemantic = store.recordLocalOutcome(
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222230",
        }),
      );
      const churned = store.recordLocalOutcome(
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222231",
          outcome: "churned",
          occurredAt: "2026-05-22T12:01:00.000Z",
        }),
      );
      const postChurn = store.recordLocalOutcome(
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222232",
          outcome: "landed",
          occurredAt: "2026-05-22T12:02:00.000Z",
        }),
      );

      expect(missingPrior.status).toBe("missing_prior_outcome");
      expect(duplicateMissingPrior).toEqual(
        expect.objectContaining({
          status: "duplicate",
          accepted: false,
          event: null,
          rejection: expect.objectContaining({
            sourceEventId: "22222222-2222-4222-8222-222222222227",
            rejectionKind: "missing_prior_outcome",
          }),
        }),
      );
      expect(invalidArr.status).toBe("invalid_arr_delta");
      expect(started.status).toBe("recorded");
      expect(duplicateSemantic.status).toBe("duplicate_semantic_outcome");
      expect(churned.status).toBe("recorded");
      expect(postChurn.status).toBe("post_churn_outcome");
      expect(store.outcomeEvents("D-lease").map((event) => event.outcome)).toEqual([
        "deployment_started",
        "churned",
      ]);
      expect(
        store
          .outcomeRejections("D-lease")
          .map((rejection) => rejection.rejectionKind),
      ).toEqual(
        expect.arrayContaining([
          "missing_prior_outcome",
          "invalid_arr_delta",
          "duplicate_semantic_outcome",
          "post_churn_outcome",
        ]),
      );
      expect(store.outcomeRejections("D-lease")).toHaveLength(4);
      expect(
        readExternalEventKey(
          dbPath,
          outcomeEventKey("22222222-2222-4222-8222-222222222227"),
        ),
      ).toEqual(expect.objectContaining({ notify_status: "ok" }));
    });
  });

  it("requires landed before expansion and allows multiple expansions", () => {
    withTempStore((store) => {
      closedWonRoutedDeal(store);
      expect(
        store.recordLocalOutcome(
          outcomeInput({
            sourceEventId: "22222222-2222-4222-8222-222222222233",
            outcome: "expanded",
            arrDeltaUsd: 25_000,
            reasonCategory: "scope_expanded",
          }),
        ).status,
      ).toBe("missing_prior_outcome");

      for (const input of [
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222234",
          occurredAt: "2026-05-22T12:00:00.000Z",
        }),
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222235",
          outcome: "deployed",
          occurredAt: "2026-05-22T12:01:00.000Z",
        }),
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222236",
          outcome: "landed",
          occurredAt: "2026-05-22T12:02:00.000Z",
        }),
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222237",
          outcome: "expanded",
          occurredAt: "2026-05-22T12:03:00.000Z",
          arrDeltaUsd: 25_000,
          reasonCategory: "scope_expanded",
        }),
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222238",
          outcome: "expanded",
          occurredAt: "2026-05-22T12:04:00.000Z",
          arrDeltaUsd: 15_000,
          reasonCategory: "scope_expanded",
        }),
      ]) {
        expect(store.recordLocalOutcome(input).status).toBe("recorded");
      }

      expect(store.outcomeEvents("D-lease").map((event) => event.outcome)).toEqual([
        "deployment_started",
        "deployed",
        "landed",
        "expanded",
        "expanded",
      ]);
      const expandedArr = store
        .outcomeEvents("D-lease")
        .filter((event) => event.outcome === "expanded")
        .reduce((sum, event) => sum + event.arrDeltaUsd, 0);
      expect(expandedArr).toBe(40_000);
    });
  });

  it("summarizes accepted outcome metrics and cycle times", () => {
    withTempStore((store, dbPath) => {
      closedWonRoutedDeal(store);
      const db = new DatabaseSync(dbPath);
      try {
        db
          .prepare(
            `UPDATE commercial_states
             SET state_entered_at = ?
             WHERE deal_id = ?`,
          )
          .run("2026-05-26T12:00:00.000Z", "D-lease");
        db
          .prepare(
            `INSERT INTO events (deal_id, ts, from_st, to_st, detail, meta)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "D-lease",
            "2026-05-20T12:00:00.000Z",
            "routed",
            "routed",
            "commercial state changed: closed_won",
            JSON.stringify({
              kind: "commercial_state",
              source: "local",
              eventKey: "manual-earlier-projected-close",
              sourceEventId: "22222222-2222-4222-8222-222222222299",
              commercialState: "closed_won",
              occurredAt: "2026-05-20T14:00:00+02:00",
              projected: true,
            }),
          );
      } finally {
        db.close();
      }
      for (const input of [
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222239",
          occurredAt: "2026-05-22T12:00:00.000Z",
        }),
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222240",
          outcome: "deployed",
          occurredAt: "2026-05-23T12:00:00.000Z",
        }),
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222241",
          outcome: "landed",
          occurredAt: "2026-05-24T00:00:00.000Z",
        }),
        outcomeInput({
          sourceEventId: "22222222-2222-4222-8222-222222222242",
          outcome: "expanded",
          occurredAt: "2026-05-25T00:00:00.000Z",
          arrDeltaUsd: 50_000,
          reasonCategory: "scope_expanded",
        }),
      ]) {
        expect(store.recordLocalOutcome(input).status).toBe("recorded");
      }

      expect(store.metrics()).toEqual(
        expect.objectContaining({
          deploymentStartedDeals: 1,
          deployedDeals: 1,
          landedDeals: 1,
          expandedDeals: 1,
          expandedArrDeltaUsd: 50_000,
          churnedDeals: 0,
          outcomeChurnBeforeDeploy: 0,
          outcomeCommercialStateConflicts: 0,
          outcomeInvalidHistories: 0,
          medianTimeClosedWonToDeployedHours: 72,
          medianTimeDeployedToLandedHours: 12,
        }),
      );
    });
  });

  it("flags impossible accepted outcome histories from persisted rows", () => {
    withTempStore((store, dbPath) => {
      const lease = routed();
      const churn = { ...routed(), id: "D-churn", company: "Churn Freight" };
      store.recordRouted(lease, 0, { mode: "dry_run", status: "dry_run" });
      store.recordRouted(churn, 0, { mode: "dry_run", status: "dry_run" });
      store.recordLocalCommercialState({
        dealId: lease.id,
        commercialState: "closed_won",
        sourceEventId: "33333333-3333-4333-8333-333333333331",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });
      store.recordLocalCommercialState({
        dealId: churn.id,
        commercialState: "closed_won",
        sourceEventId: "33333333-3333-4333-8333-333333333332",
        occurredAt: "2026-05-21T12:00:00.000Z",
        reason: null,
        expectedRedPath: false,
      });

      const db = new DatabaseSync(dbPath);
      try {
        const insertOutcome = db.prepare(
          `INSERT INTO outcome_events (
             id, deal_id, source, source_event_id, source_payload_hash,
             outcome, occurred_at, operator, operator_source, arr_delta_usd,
             reason_category, created_at
           )
           VALUES (?, ?, 'local', ?, 'hash', ?, ?, 'DS', 'self_reported', NULL, NULL, ?)`,
        );
        for (const row of [
          [
            "outcome-deployed-missing",
            lease.id,
            "evt-deployed-missing",
            "deployed",
            "2026-05-22T12:00:00.000Z",
          ],
          [
            "outcome-lease-churned",
            lease.id,
            "evt-lease-churned",
            "churned",
            "2026-05-23T12:00:00.000Z",
          ],
          [
            "outcome-landed-post-churn",
            lease.id,
            "evt-landed-post-churn",
            "landed",
            "2026-05-24T12:00:00.000Z",
          ],
          [
            "outcome-churn-started",
            churn.id,
            "evt-churn-started",
            "deployment_started",
            "2026-05-22T12:00:00.000Z",
          ],
          [
            "outcome-churn-before-deploy",
            churn.id,
            "evt-churn-before-deploy",
            "churned",
            "2026-05-23T12:00:00.000Z",
          ],
          [
            "outcome-deployed-after-churn",
            churn.id,
            "evt-deployed-after-churn",
            "deployed",
            "2026-05-24T12:00:00.000Z",
          ],
          [
            "outcome-orphan-started",
            "D-orphan",
            "evt-orphan-started",
            "deployment_started",
            "2026-05-22T12:00:00.000Z",
          ],
        ] as const) {
          insertOutcome.run(row[0], row[1], row[2], row[3], row[4], row[4]);
        }
      } finally {
        db.close();
      }

      expect(store.metrics()).toEqual(
        expect.objectContaining({
          deploymentStartedDeals: 2,
          deployedDeals: 2,
          landedDeals: 1,
          churnedDeals: 2,
          outcomeChurnBeforeDeploy: 1,
          outcomeCommercialStateConflicts: 1,
          outcomeInvalidHistories: 4,
          medianTimeClosedWonToDeployedHours: null,
          medianTimeDeployedToLandedHours: null,
        }),
      );
    });
  });
});

describe("Store Phase 5 agent suggestion ledger", () => {
  it("separates missing and non-routed deals before claiming suggestion source events", () => {
    withTempStore((store, dbPath) => {
      const missing = store.recordLocalAgentSuggestion(
        agentSuggestionInput({
          dealId: "missing",
          sourceEventId: "33333333-3333-4333-8333-333333333334",
        }),
      );
      store.recordQuarantine(
        {
          dealId: "D-quarantined",
          stage: "enriched",
          code: "insufficient_data",
          reason: "not enough data to route",
          at: "2026-05-22T12:00:00.000Z",
        },
        0,
        "enriched",
        "insufficient data",
      );
      const nonRouted = store.recordLocalAgentSuggestion(
        agentSuggestionInput({
          dealId: "D-quarantined",
          sourceEventId: "33333333-3333-4333-8333-333333333337",
        }),
      );

      expect(missing).toEqual(
        expect.objectContaining({
          status: "not_found",
          suggestion: null,
        }),
      );
      expect(nonRouted).toEqual(
        expect.objectContaining({
          status: "not_routed",
          suggestion: null,
        }),
      );
      expect(
        readExternalEventKey(
          dbPath,
          agentSuggestionEventKey("33333333-3333-4333-8333-333333333334"),
        ),
      ).toBeUndefined();
      expect(
        readExternalEventKey(
          dbPath,
          agentSuggestionEventKey("33333333-3333-4333-8333-333333333337"),
        ),
      ).toBeUndefined();
    });
  });

  it("records proposed suggestions, replays, conflicts, and human decisions", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const input = agentSuggestionInput({
        sourceEventId: "33333333-3333-4333-8333-333333333335",
      });

      const proposed = store.recordLocalAgentSuggestion(input);

      expect(proposed).toEqual(
        expect.objectContaining({
          status: "recorded",
          eventKey: agentSuggestionEventKey(input.sourceEventId),
          suggestion: expect.objectContaining({
            dealId: "D-lease",
            kind: "handoff_summary",
            status: "proposed",
            title: "Draft AE handoff",
            source: "local_agent",
            sourceEventId: input.sourceEventId,
            decidedAt: null,
            decidedBy: null,
          }),
        }),
      );
      const suggestionId = proposed.suggestion?.id ?? "";
      expect(suggestionId).not.toBe("");
      expect(readExternalEventKey(dbPath, agentSuggestionEventKey(input.sourceEventId))).toEqual(
        expect.objectContaining({
          notify_status: "ok",
          scope: "source_event",
        }),
      );
      expect(store.agentSuggestions()).toEqual([
        expect.objectContaining({
          id: suggestionId,
          status: "proposed",
        }),
      ]);
      expect(store.events("D-lease").at(-1)).toEqual(
        expect.objectContaining({
          detail: "agent_suggestion_proposed",
          meta: expect.objectContaining({
            kind: "agent_suggestion_proposed",
            source: "local_agent",
            suggestionId,
          }),
        }),
      );

      const duplicate = store.recordLocalAgentSuggestion(input);
      expect(duplicate).toEqual(
        expect.objectContaining({
          status: "duplicate",
          suggestion: expect.objectContaining({ id: suggestionId }),
        }),
      );
      store.recordQuarantine(
        {
          dealId: "D-lease",
          stage: "routed",
          code: "sink_terminal",
          reason: "simulate a later non-routed terminal state",
          at: "2026-05-22T13:01:00.000Z",
        },
        0,
        "routed",
        "simulate stage exit after suggestion",
      );
      const duplicateAfterStageChange = store.recordLocalAgentSuggestion(input);
      expect(duplicateAfterStageChange).toEqual(
        expect.objectContaining({
          status: "duplicate",
          suggestion: expect.objectContaining({ id: suggestionId }),
        }),
      );

      const conflict = store.recordLocalAgentSuggestion({
        ...input,
        title: "Different suggestion under same source event",
      });
      expect(conflict).toEqual(
        expect.objectContaining({
          status: "idempotency_conflict",
          suggestion: null,
        }),
      );

      const decisionInput = agentSuggestionDecisionInput(suggestionId, {
        sourceEventId: "44444444-4444-4444-8444-444444444445",
      });
      const accepted = store.recordLocalAgentSuggestionDecision(decisionInput);
      expect(accepted).toEqual(
        expect.objectContaining({
          status: "recorded",
          eventKey: agentSuggestionDecisionEventKey(decisionInput.sourceEventId),
          suggestion: expect.objectContaining({
            id: suggestionId,
            status: "accepted",
            decidedAt: "2026-05-22T13:05:00.000Z",
            decidedBy: "ops@example.com",
            decisionSourceEventId: decisionInput.sourceEventId,
            decisionReason: "Handoff is accurate and ready for the AE.",
          }),
        }),
      );
      expect(
        readExternalEventKey(
          dbPath,
          agentSuggestionDecisionEventKey(decisionInput.sourceEventId),
        ),
      ).toEqual(expect.objectContaining({ scope: "source_event" }));
      expect(store.events("D-lease").at(-1)).toEqual(
        expect.objectContaining({
          detail: "agent_suggestion_decided",
          meta: expect.objectContaining({
            kind: "agent_suggestion_decided",
            source: "local_agent",
            suggestionId,
            decision: "accepted",
            humanPrincipal: "ops@example.com",
          }),
        }),
      );

      const duplicateDecision =
        store.recordLocalAgentSuggestionDecision(decisionInput);
      expect(duplicateDecision).toEqual(
        expect.objectContaining({
          status: "duplicate",
          suggestion: expect.objectContaining({
            id: suggestionId,
            status: "accepted",
          }),
        }),
      );
      const laterDecision = store.recordLocalAgentSuggestionDecision(
        agentSuggestionDecisionInput(suggestionId, {
          sourceEventId: "44444444-4444-4444-8444-444444444446",
          decision: "rejected",
          reason: "Changed mind after acceptance.",
        }),
      );
      expect(laterDecision).toEqual(
        expect.objectContaining({
          status: "already_decided",
          suggestion: expect.objectContaining({
            id: suggestionId,
            status: "accepted",
          }),
        }),
      );
      expect(
        readExternalEventKey(
          dbPath,
          agentSuggestionDecisionEventKey(
            "44444444-4444-4444-8444-444444444446",
          ),
        ),
      ).toBeUndefined();
      const mutatedLaterDecision = store.recordLocalAgentSuggestionDecision(
        agentSuggestionDecisionInput(suggestionId, {
          sourceEventId: "44444444-4444-4444-8444-444444444446",
          decision: "rejected",
          reason: "Mutated replay after the suggestion was already decided.",
        }),
      );
      expect(mutatedLaterDecision).toEqual(
        expect.objectContaining({
          status: "already_decided",
          suggestion: expect.objectContaining({
            id: suggestionId,
            status: "accepted",
          }),
        }),
      );
      expect(
        readExternalEventKey(
          dbPath,
          agentSuggestionDecisionEventKey(
            "44444444-4444-4444-8444-444444444446",
          ),
        ),
      ).toBeUndefined();

      const db = new DatabaseSync(dbPath);
      try {
        const violations = db
          .prepare(
            `SELECT scope, source
             FROM idempotency_violations
             ORDER BY created_at`,
          )
          .all() as Array<{ scope: string; source: string }>;
        expect(violations).toEqual([
          { scope: "agent_suggestion", source: "local_agent" },
        ]);
      } finally {
        db.close();
      }
    });
  });

  it("rejects decisions for missing suggestions before claiming the source event", () => {
    withTempStore((store, dbPath) => {
      const sourceEventId = "44444444-4444-4444-8444-444444444448";

      const result = store.recordLocalAgentSuggestionDecision(
        agentSuggestionDecisionInput("S-missing", { sourceEventId }),
      );

      expect(result).toEqual(
        expect.objectContaining({
          status: "not_found",
          suggestion: null,
        }),
      );
      expect(
        readExternalEventKey(
          dbPath,
          agentSuggestionDecisionEventKey(sourceEventId),
        ),
      ).toBeUndefined();
    });
  });

  it("rejects decisions that predate proposals before claiming the source event", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const proposed = store.recordLocalAgentSuggestion(
        agentSuggestionInput({
          sourceEventId: "33333333-3333-4333-8333-333333333338",
          occurredAt: "2026-05-22T13:00:00.000Z",
        }),
      );
      const suggestionId = proposed.suggestion?.id ?? "";
      const sourceEventId = "44444444-4444-4444-8444-444444444449";

      const result = store.recordLocalAgentSuggestionDecision(
        agentSuggestionDecisionInput(suggestionId, {
          sourceEventId,
          occurredAt: "2026-05-22T12:59:59.000Z",
        }),
      );

      expect(result).toEqual(
        expect.objectContaining({
          status: "decision_before_proposal",
          suggestion: expect.objectContaining({
            id: suggestionId,
            status: "proposed",
            decidedAt: null,
          }),
        }),
      );
      expect(
        readExternalEventKey(
          dbPath,
          agentSuggestionDecisionEventKey(sourceEventId),
        ),
      ).toBeUndefined();
      expect(store.agentSuggestions()).toEqual([
        expect.objectContaining({
          id: suggestionId,
          status: "proposed",
          decidedAt: null,
        }),
      ]);
    });
  });

  it("keeps recently decided suggestions visible when proposals hit the cap", () => {
    withTempStore((store) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const accepted = store.recordLocalAgentSuggestion(
        agentSuggestionInput({
          sourceEventId: "33333333-3333-4333-8333-333333333339",
          title: "Accepted handoff",
        }),
      );
      const acceptedId = accepted.suggestion?.id ?? "";
      store.recordLocalAgentSuggestionDecision(
        agentSuggestionDecisionInput(acceptedId, {
          sourceEventId: "44444444-4444-4444-8444-444444444450",
        }),
      );

      for (const sourceEventId of [
        "33333333-3333-4333-8333-333333333340",
        "33333333-3333-4333-8333-333333333341",
        "33333333-3333-4333-8333-333333333342",
      ]) {
        store.recordLocalAgentSuggestion(
          agentSuggestionInput({
            sourceEventId,
            title: `Proposal ${sourceEventId.slice(-3)}`,
          }),
        );
      }

      const rows = store.agentSuggestions(2);

      expect(rows).toHaveLength(2);
      expect(
        rows.some((row) => row.id === acceptedId && row.status === "accepted"),
      ).toBe(true);
      expect(rows.some((row) => row.status === "proposed")).toBe(true);

      expect(store.agentSuggestions(4).map((row) => row.status)).toEqual([
        "proposed",
        "proposed",
        "proposed",
        "accepted",
      ]);
    });
  });

  it("dedupes and conflicts decision source event replays before lifecycle checks", () => {
    withTempStore((store, dbPath) => {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const proposed = store.recordLocalAgentSuggestion(
        agentSuggestionInput({
          sourceEventId: "33333333-3333-4333-8333-333333333336",
        }),
      );
      const suggestionId = proposed.suggestion?.id ?? "";
      const decisionInput = agentSuggestionDecisionInput(suggestionId, {
        sourceEventId: "44444444-4444-4444-8444-444444444447",
      });
      expect(store.recordLocalAgentSuggestionDecision(decisionInput).status).toBe(
        "recorded",
      );

      const conflict = store.recordLocalAgentSuggestionDecision({
        ...decisionInput,
        reason: "Different decision reason under the same source event.",
      });
      expect(conflict).toEqual(
        expect.objectContaining({
          status: "idempotency_conflict",
          suggestion: null,
        }),
      );

      const db = new DatabaseSync(dbPath);
      try {
        const violation = db
          .prepare(
            `SELECT scope, source_event_id
             FROM idempotency_violations
             WHERE scope = 'agent_suggestion_decision'`,
          )
          .get() as { scope: string; source_event_id: string } | undefined;
        expect(violation).toEqual({
          scope: "agent_suggestion_decision",
          source_event_id: decisionInput.sourceEventId,
        });
      } finally {
        db.close();
      }
    });
  });
});

describe("Store external webhook leases", () => {
  it("backfills pending lease timestamps on migration", () => {
    const dir = join(tmpdir(), `gtm-router-migration-${process.pid}-${Date.now()}`);
    mkdirSync(dir);
    const dbPath = join(dir, "router.db");
    try {
      const db = new DatabaseSync(dbPath);
      db.prepare(
        `CREATE TABLE deals (
           id TEXT PRIMARY KEY,
           stage TEXT NOT NULL,
           payload TEXT,
           quarantine TEXT,
           created_at TEXT NOT NULL,
           updated_at TEXT NOT NULL
         )`,
      ).run();
      db.prepare(
        `CREATE TABLE events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           deal_id TEXT NOT NULL,
           ts TEXT NOT NULL,
           from_st TEXT NOT NULL,
           to_st TEXT NOT NULL,
           detail TEXT NOT NULL,
           meta TEXT
         )`,
      ).run();
      db.prepare(
        `CREATE TABLE external_event_keys (
           key TEXT PRIMARY KEY,
           system TEXT NOT NULL,
           recorded_at TEXT NOT NULL,
           notify_status TEXT NOT NULL DEFAULT 'pending',
           notify_attempts INTEGER NOT NULL DEFAULT 0,
           notified_at TEXT,
           notify_error TEXT
         )`,
      ).run();
      db.prepare(
        "INSERT INTO deals (id, stage, payload, quarantine, created_at, updated_at) VALUES (?, 'routed', ?, NULL, ?, ?)",
      ).run(
        "D-lease",
        JSON.stringify(routed()),
        "2026-05-19T17:00:00.000Z",
        "2026-05-19T17:00:00.000Z",
      );
      db.prepare(
        "INSERT INTO external_event_keys (key, system, recorded_at, notify_status, notify_attempts) VALUES (?, 'hubspot', ?, 'pending', 0)",
      ).run("legacy-key", "2026-05-19T17:00:00.000Z");
      db.close();

      const store = new Store(dbPath);
      expect(
        store.recordExternalStageChange(
          "D-lease",
          externalStage(),
          "hubspot stage changed: Contact Made",
          externalMeta("legacy-key"),
          "legacy-key",
        ),
      ).toBe("duplicate");
      store.close();

      const migrated = new DatabaseSync(dbPath);
      try {
        const columns = migrated
          .prepare("PRAGMA table_info(external_event_keys)")
          .all() as Array<{ name: string }>;
        expect(columns.map((column) => column.name)).toEqual(
          expect.arrayContaining(["scope", "payload_hash"]),
        );
        expect(() =>
          migrated
            .prepare(
              `INSERT INTO external_event_keys (
                 key, system, recorded_at, notify_status, scope
               )
               VALUES ('bad-scope', 'hubspot', ?, 'pending', 'slack')`,
            )
            .run("2026-05-19T17:00:00.000Z"),
        ).toThrow();
        expect(() =>
          migrated
            .prepare(
              `INSERT INTO external_event_keys (
                 key, system, recorded_at, notify_status, scope
               )
               VALUES ('bad-status', 'hubspot', ?, 'mystery', 'source_event')`,
            )
            .run("2026-05-19T17:00:00.000Z"),
        ).toThrow();
        for (const status of [
          "superseded_by_readiness",
          "superseded_by_terminal_drift",
        ]) {
          expect(() =>
            migrated
              .prepare(
                `INSERT INTO external_event_keys (
                   key, system, recorded_at, notify_status, scope
                 )
                 VALUES (?, 'hubspot', ?, ?, 'source_event')`,
              )
              .run(
                `dead-status-${status}`,
                "2026-05-19T17:00:00.000Z",
                status,
              ),
          ).toThrow();
        }
      } finally {
        migrated.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dedupes fresh pending notifications and reclaims expired pending leases", () => {
    const dir = join(tmpdir(), `gtm-router-store-${process.pid}-${Date.now()}`);
    mkdirSync(dir);
    const dbPath = join(dir, "router.db");
    try {
      const store = new Store(dbPath);
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const stage = externalStage();
      const meta = externalMeta();

      expect(
        store.recordExternalStageChange(
          "D-lease",
          stage,
          "hubspot stage changed: Contact Made",
          meta,
          "lease-key",
        ),
      ).toBe("recorded");
      expect(
        store.recordExternalStageChange(
          "D-lease",
          stage,
          "hubspot stage changed: Contact Made",
          meta,
          "lease-key",
        ),
      ).toBe("duplicate");
      store.close();

      // Simulate lease expiry without sleeping through the 60s production TTL.
      const db = new DatabaseSync(dbPath);
      db.prepare(
        "UPDATE external_event_keys SET notify_pending_at='2000-01-01T00:00:00.000Z' WHERE key='lease-key'",
      ).run();
      db.close();

      const reopened = new Store(dbPath);
      expect(
        reopened.recordExternalStageChange(
          "D-lease",
          stage,
          "hubspot stage changed: Contact Made",
          meta,
          "lease-key",
        ),
      ).toBe("notify_retry");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not reacquire a notification lease after a successful post", () => {
    const store = new Store(":memory:");
    try {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const stage = externalStage();
      const meta = externalMeta("ok-key");
      expect(
        store.recordExternalStageChange(
          "D-lease",
          stage,
          "hubspot stage changed: Contact Made",
          meta,
          "ok-key",
        ),
      ).toBe("recorded");
      const leaseAt = store.externalNotificationLeaseAt("ok-key");

      store.recordExternalNotificationEvent(
        "D-lease",
        "hubspot stage notification",
        {
          kind: "hubspot_stage_change",
          mode: "dry_run",
          hubspotDealId: "991",
          eventKey: "ok-key",
          toStageId: "contact_made",
          toStageLabel: "Contact Made",
          receipts: [{ system: "slack", externalId: "C123", detail: "posted" }],
        },
        "ok-key",
        [{ detail: "posted" }],
        leaseAt ?? undefined,
      );

      expect(
        store.recordExternalStageChange(
          "D-lease",
          stage,
          "hubspot stage changed: Contact Made",
          meta,
          "ok-key",
        ),
      ).toBe("duplicate");
    } finally {
      store.close();
    }
  });

  it("does not reacquire a notification lease after a suppressed post", () => {
    const store = new Store(":memory:");
    try {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const stage = externalStage();
      const meta = externalMeta("suppressed-key");
      expect(
        store.recordExternalStageChange(
          "D-lease",
          stage,
          "hubspot stage changed: Contact Made",
          meta,
          "suppressed-key",
        ),
      ).toBe("recorded");
      const leaseAt = store.externalNotificationLeaseAt("suppressed-key");

      store.recordExternalNotificationEvent(
        "D-lease",
        "hubspot stage notification suppressed by HUBSPOT_NOTIFY_STAGE_IDS",
        {
          kind: "hubspot_stage_change",
          mode: "dry_run",
          hubspotDealId: "991",
          eventKey: "suppressed-key",
          toStageId: "contact_made",
          toStageLabel: "Contact Made",
          receipts: [],
        },
        "suppressed-key",
        [],
        leaseAt ?? undefined,
      );

      expect(
        store.recordExternalStageChange(
          "D-lease",
          stage,
          "hubspot stage changed: Contact Made",
          meta,
          "suppressed-key",
        ),
      ).toBe("duplicate");
    } finally {
      store.close();
    }
  });

  it("reacquires a notification lease after a failed post", () => {
    const store = new Store(":memory:");
    try {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const stage = externalStage();
      const meta = externalMeta("failed-key");
      expect(
        store.recordExternalStageChange(
          "D-lease",
          stage,
          "hubspot stage changed: Contact Made",
          meta,
          "failed-key",
        ),
      ).toBe("recorded");
      const leaseAt = store.externalNotificationLeaseAt("failed-key");

      store.recordExternalNotificationEvent(
        "D-lease",
        "hubspot stage notification",
        {
          kind: "hubspot_stage_change",
          mode: "dry_run",
          hubspotDealId: "991",
          eventKey: "failed-key",
          toStageId: "contact_made",
          toStageLabel: "Contact Made",
          receipts: [
            {
              system: "slack",
              externalId: "C123",
              detail: "stage-change notification failed: ratelimited",
              status: "warning",
            },
          ],
        },
        "failed-key",
        [
          {
            detail: "stage-change notification failed: ratelimited",
            status: "warning",
          },
        ],
        leaseAt ?? undefined,
      );

      expect(
        store.recordExternalStageChange(
          "D-lease",
          stage,
          "hubspot stage changed: Contact Made",
          meta,
          "failed-key",
        ),
      ).toBe("notify_retry");
    } finally {
      store.close();
    }
  });

  it("counts audit append failures even when Slack notification also failed", () => {
    const store = new AuditAppendFailureStore(":memory:");
    try {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const stage = externalStage();
      const meta = externalMeta("audit-failed-key");
      expect(
        store.recordExternalStageChange(
          "D-lease",
          stage,
          "hubspot stage changed: Contact Made",
          meta,
          "audit-failed-key",
        ),
      ).toBe("recorded");
      const leaseAt = store.externalNotificationLeaseAt("audit-failed-key");

      store.failNotificationAppend = true;
      expect(() =>
        store.recordExternalNotificationEvent(
          "D-lease",
          "hubspot stage notification",
          {
            kind: "hubspot_stage_change",
            mode: "dry_run",
            hubspotDealId: "991",
            eventKey: "audit-failed-key",
            toStageId: "contact_made",
            toStageLabel: "Contact Made",
            receipts: [
              {
                system: "slack",
                externalId: "C123",
                detail: "stage-change notification failed: ratelimited",
                status: "warning",
              },
            ],
          },
          "audit-failed-key",
          [
            {
              detail: "stage-change notification failed: ratelimited",
              status: "warning",
            },
          ],
          leaseAt ?? undefined,
        ),
      ).toThrow("event append failed");

      expect(store.metrics().stageNotificationAuditGaps).toBe(1);
      expect(
        store.recordExternalStageChange(
          "D-lease",
          stage,
          "hubspot stage changed: Contact Made",
          meta,
          "audit-failed-key",
        ),
      ).toBe("notify_retry");
      const retryLeaseAt = store.externalNotificationLeaseAt("audit-failed-key");
      store.failNotificationAppend = false;
      store.recordExternalNotificationEvent(
        "D-lease",
        "hubspot stage notification retry",
        {
          kind: "hubspot_stage_change",
          mode: "dry_run",
          hubspotDealId: "991",
          eventKey: "audit-failed-key",
          toStageId: "contact_made",
          toStageLabel: "Contact Made",
          receipts: [{ system: "slack", externalId: "C123", detail: "posted" }],
        },
        "audit-failed-key",
        [{ detail: "posted" }],
        retryLeaseAt ?? undefined,
      );
      expect(store.metrics().stageNotificationAuditGaps).toBe(0);
      expect(store.externalNotificationLeaseAt("audit-failed-key")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("does not release a notification lease when the lease token changed", () => {
    const store = new Store(":memory:");
    try {
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      const stage = externalStage();
      const meta = externalMeta("changed-lease-key");
      expect(
        store.recordExternalStageChange(
          "D-lease",
          stage,
          "hubspot stage changed: Contact Made",
          meta,
          "changed-lease-key",
        ),
      ).toBe("recorded");

      expect(() =>
        store.recordExternalNotificationEvent(
          "D-lease",
          "hubspot stage notification",
          {
            kind: "hubspot_stage_change",
            mode: "dry_run",
            hubspotDealId: "991",
            eventKey: "changed-lease-key",
            toStageId: "contact_made",
            toStageLabel: "Contact Made",
            receipts: [{ system: "slack", externalId: "C123", detail: "posted" }],
          },
          "changed-lease-key",
          [{ detail: "posted" }],
          "2000-01-01T00:00:00.000Z",
        ),
      ).toThrow("notification lease changed before mark");

      expect(
        store.recordExternalStageChange(
          "D-lease",
          stage,
          "hubspot stage changed: Contact Made",
          meta,
          "changed-lease-key",
        ),
      ).toBe("duplicate");
    } finally {
      store.close();
    }
  });
});

describe("Store.integrity() — reconciliation invariant fails loud", () => {
  it("flags a recognized intake with no routed/quarantined terminal as not ok", () => {
    const store = new Store(":memory:");
    try {
      // A recognized intake event with no settling terminal row: the invariant
      // (recognized intake === routed + valid quarantined) must NOT hold. This
      // guards against integrity() silently regressing to always-ok — every
      // other test only ever asserts integrity().ok === true.
      store.appendEvent("D-orphan", "-", "intake", "orphan intake, never settled");
      const result = store.integrity();
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("recognized intakes but");
    } finally {
      store.close();
    }
  });
});

// ─── Engagement helpers ────────────────────────────────────────────────────

function engagementFeedback(
  overrides: Partial<EngagementFeedback> = {},
): EngagementFeedback {
  return {
    schemaVersion: "sales.engagement-feedback.v1",
    generatedAt: "2026-05-29T10:00:00.000Z",
    source: { system: "sales", purpose: "test" },
    coverage: { complete: true, scanned: 1, emitted: 1, since: null },
    deals: [],
    ...overrides,
  };
}

function sentEvent(eventId: string, touchId = "touch-001"): EngagementEvent {
  return {
    kind: "sent",
    eventId,
    occurredAt: "2026-05-20T08:00:00.000Z",
    touchId,
    channel: "email",
  };
}

function repliedEvent(
  eventId: string,
  touchId = "touch-001",
): EngagementEvent {
  return {
    kind: "replied",
    eventId,
    occurredAt: "2026-05-21T09:00:00.000Z",
    touchId,
    replyIntent: "positive",
  };
}

function noResponseEvent(eventId: string): EngagementEvent {
  return {
    kind: "no_response",
    eventId,
    occurredAt: "2026-05-22T00:00:00.000Z",
    asOf: "2026-05-22T00:00:00.000Z",
    windowDays: 7,
    lastTouchId: "touch-001",
    derived: true,
  };
}

function opportunitySignal(eventId: string): CommercialSignal {
  return {
    kind: "opportunity_created",
    eventId,
    occurredAt: "2026-05-22T10:00:00.000Z",
    amountUsd: 80000,
    crmRef: "HS-001",
  };
}

// ─── engagement_events DDL + engagementEvents reader ──────────────────────

describe("store — engagement_events DDL", () => {
  it("creates engagement_events and commercial_signals tables on construction", () => {
    withTempStoreDb((db) => {
      const tables = (
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('engagement_events','commercial_signals') ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(tables).toEqual(["commercial_signals", "engagement_events"]);
    });
  });

  it("engagement_events UNIQUE(source, source_event_id) is enforced by SQLite schema", () => {
    withTempStoreDb((db) => {
      const row = db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='engagement_events'`,
        )
        .get() as { sql: string } | undefined;
      expect(row?.sql).toContain("UNIQUE");
      expect(row?.sql).toContain("source_event_id");
    });
  });

  it("commercial_signals UNIQUE(source, source_event_id) is enforced by SQLite schema", () => {
    withTempStoreDb((db) => {
      const row = db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='commercial_signals'`,
        )
        .get() as { sql: string } | undefined;
      expect(row?.sql).toContain("UNIQUE");
      expect(row?.sql).toContain("source_event_id");
    });
  });

  it("idempotency_violations accepts engagement_event and commercial_signal scopes", () => {
    withTempStoreDb((db) => {
      const row = db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE type='table' AND name='idempotency_violations'`,
        )
        .get() as { sql: string } | undefined;
      expect(row?.sql).toContain("'engagement_event'");
      expect(row?.sql).toContain("'commercial_signal'");
    });
  });
});

// ─── importEngagementFeedback — happy path ─────────────────────────────────

describe("store — importEngagementFeedback happy path", () => {
  it("records a sent+replied deal and returns correct counts", () => {
    const store = new Store(":memory:");
    store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });

    const result = store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-lease",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [sentEvent("evt-sent-1"), repliedEvent("evt-replied-1")],
          },
        ],
      }),
    );

    expect(result.eventsRecorded).toBe(2);
    expect(result.eventsDuplicate).toBe(0);
    expect(result.processedDeals).toBe(1);
    expect(result.unknownDealRejections).toHaveLength(0);
    expect(result.commercialSignalsRecorded).toBe(0);

    const events = store.engagementEvents("D-lease");
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("sent");
    expect(events[0]?.source).toBe("sales_observed");
    expect(events[1]?.kind).toBe("replied");

    store.close();
  });

  it("records a commercial signal and returns correct counts", () => {
    const store = new Store(":memory:");
    store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });

    const result = store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-lease",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [],
            commercialSignals: [opportunitySignal("sig-opp-1")],
          },
        ],
      }),
    );

    expect(result.commercialSignalsRecorded).toBe(1);
    expect(result.commercialSignalsDuplicate).toBe(0);

    const signals = store.commercialSignals("D-lease");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe("opportunity_created");
    expect(signals[0]?.amountUsd).toBe(80000);
    expect(signals[0]?.crmRef).toBe("HS-001");
    expect(signals[0]?.source).toBe("sales_reported");

    store.close();
  });

  it("engagementEvents() with no dealId returns all rows across all deals", () => {
    const store = new Store(":memory:");
    store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
    store.recordRouted(
      {
        ...routed(),
        id: "D-other",
        company: "Other Co",
        domain: "other.example",
      },
      0,
      { mode: "dry_run", status: "dry_run" },
    );

    store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-lease",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [sentEvent("evt-s1")],
          },
          {
            routerDealId: "D-other",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [sentEvent("evt-s2", "touch-002")],
          },
        ],
      }),
    );

    expect(store.engagementEvents()).toHaveLength(2);
    expect(store.engagementEvents("D-lease")).toHaveLength(1);
    expect(store.engagementEvents("D-other")).toHaveLength(1);

    store.close();
  });

  it("no_response event gets source='sales_window_evaluator'", () => {
    const store = new Store(":memory:");
    store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });

    store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-lease",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [noResponseEvent("evt-nr-1")],
          },
        ],
      }),
    );

    const events = store.engagementEvents("D-lease");
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe("sales_window_evaluator");
    expect(events[0]?.kind).toBe("no_response");

    store.close();
  });

  it("lastEngagementFeedbackCoverageComplete returns false before any import (no feedback = not complete)", () => {
    const store = new Store(":memory:");
    expect(store.lastEngagementFeedbackCoverageComplete()).toBe(false);
    store.close();
  });

  it("lastEngagementFeedbackCoverageComplete reflects coverage.complete from last import", () => {
    const store = new Store(":memory:");
    store.importEngagementFeedback(
      engagementFeedback({
        coverage: { complete: false, scanned: 5, emitted: 2, since: null },
        deals: [],
      }),
    );
    expect(store.lastEngagementFeedbackCoverageComplete()).toBe(false);

    store.importEngagementFeedback(
      engagementFeedback({
        coverage: { complete: true, scanned: 5, emitted: 5, since: null },
        deals: [],
      }),
    );
    expect(store.lastEngagementFeedbackCoverageComplete()).toBe(true);
    store.close();
  });
});

// ─── importEngagementFeedback — routed-only boundary ───────────────────────

describe("store — importEngagementFeedback routed-only boundary", () => {
  it("rejects engagement for a QUARANTINED deal (has a deals row but is not routed)", () => {
    const store = new Store(":memory:");
    // A quarantined deal HAS a deals row (stage='quarantined') but is NOT routed.
    // The importer must reject it, not persist engagement for a non-routed deal.
    store.recordQuarantine(
      {
        dealId: "D-quar",
        stage: "enriched",
        code: "enrichment_unresolved",
        reason: "unknown company",
        at: "2026-05-01T00:00:00.000Z",
      },
      0,
      "enriched",
      "enrichment_unresolved: unknown company",
    );

    const result = store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-quar",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [sentEvent("evt-q-1")],
          },
        ],
      }),
    );

    expect(result.unknownDealRejections).toEqual([
      { routerDealId: "D-quar", eventCount: 1 },
    ]);
    expect(result.eventsRecorded).toBe(0);
    expect(store.engagementEvents("D-quar")).toHaveLength(0);
    store.close();
  });
});

// ─── importEngagementFeedback — idempotency ─────────────────────────────────

describe("store — importEngagementFeedback idempotency", () => {
  it("re-importing identical events is a duplicate no-op", () => {
    const store = new Store(":memory:");
    store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });

    const payload = engagementFeedback({
      deals: [
        {
          routerDealId: "D-lease",
          trace: {
            sourceSystem: "sales",
            boundary: "observed_engagement_not_router_truth",
          },
          events: [sentEvent("evt-sent-1")],
        },
      ],
    });

    const first = store.importEngagementFeedback(payload);
    const second = store.importEngagementFeedback(payload);

    expect(first.eventsRecorded).toBe(1);
    expect(first.eventsDuplicate).toBe(0);
    expect(second.eventsRecorded).toBe(0);
    expect(second.eventsDuplicate).toBe(1);

    expect(store.engagementEvents("D-lease")).toHaveLength(1);

    store.close();
  });

  it("the same eventId on two different routed deals records both (idempotency is per-deal)", () => {
    const store = new Store(":memory:");
    store.recordRouted({ ...routed(), id: "D-a" }, 0, {
      mode: "dry_run",
      status: "dry_run",
    });
    store.recordRouted({ ...routed(), id: "D-b" }, 0, {
      mode: "dry_run",
      status: "dry_run",
    });

    const shared = sentEvent("shared-evt-1"); // same eventId reused across deals
    const result = store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-a",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [shared],
          },
          {
            routerDealId: "D-b",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [shared],
          },
        ],
      }),
    );

    // Per-deal idempotency: D-b's event must NOT be dropped as a duplicate of D-a's.
    expect(result.eventsRecorded).toBe(2);
    expect(result.eventsDuplicate).toBe(0);
    expect(store.engagementEvents("D-a")).toHaveLength(1);
    expect(store.engagementEvents("D-b")).toHaveLength(1);
    store.close();
  });

  it("nonDemoEngagementEventCount also counts non-demo commercial_signals, not just engagement_events", () => {
    const store = new Store(":memory:");
    store.recordRouted({ ...routed(), id: "D-x" }, 0, {
      mode: "dry_run",
      status: "dry_run",
    });
    // A real (non-demo) commercial signal, with NO engagement events.
    store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-x",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [],
            commercialSignals: [opportunitySignal("real-sig-1")],
          },
        ],
      }),
    );
    // The guard must see the signal and block layering (>=1), not 0.
    expect(store.nonDemoEngagementEventCount(["D-x"], [])).toBeGreaterThanOrEqual(1);
    store.close();
  });

  it("same eventId + changed payload writes an idempotency_violation and skips", () => {
    const store = new Store(":memory:");
    store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });

    store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-lease",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [sentEvent("evt-sent-1")],
          },
        ],
      }),
    );

    const changedEvent: EngagementEvent = {
      kind: "sent",
      eventId: "evt-sent-1",
      occurredAt: "2026-05-20T08:00:00.000Z",
      touchId: "touch-001",
      channel: "linkedin", // changed
    };

    const result = store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-lease",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [changedEvent],
          },
        ],
      }),
    );

    expect(result.eventsRecorded).toBe(0);
    expect(store.engagementEvents("D-lease")).toHaveLength(1);
    expect(store.engagementEvents("D-lease")[0]?.payloadJson).toContain("email");

    store.close();
  });

  it("a duplicate eventId within a single payload is a safe replay, not a double-count", () => {
    // The demo-fixture strategy depends on shared deterministic ids being safe
    // replays: two events with the same eventId in one payload must collapse to
    // a single stored row, never double-count.
    const store = new Store(":memory:");
    store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });

    const dup = sentEvent("evt-dup-1");
    const result = store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-lease",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [dup, dup],
          },
        ],
      }),
    );

    expect(result.eventsRecorded).toBe(1);
    expect(result.eventsDuplicate).toBe(1);
    expect(store.engagementEvents("D-lease")).toHaveLength(1);

    store.close();
  });

  it("changed-payload conflicts persist idempotency_violations rows (not silently swallowed)", () => {
    const dir = join(
      tmpdir(),
      `gtm-router-engagement-idem-${process.pid}-${Date.now()}`,
    );
    mkdirSync(dir);
    const dbPath = join(dir, "router.db");
    try {
      const store = new Store(dbPath);
      store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });
      store.importEngagementFeedback(
        engagementFeedback({
          deals: [
            {
              routerDealId: "D-lease",
              trace: {
                sourceSystem: "sales",
                boundary: "observed_engagement_not_router_truth",
              },
              events: [sentEvent("evt-sent-1")],
              commercialSignals: [opportunitySignal("sig-1")],
            },
          ],
        }),
      );
      // Replay the SAME ids with changed payloads — both must be recorded as
      // violations, not silently dropped (eventsRecorded===0 alone can't tell).
      store.importEngagementFeedback(
        engagementFeedback({
          deals: [
            {
              routerDealId: "D-lease",
              trace: {
                sourceSystem: "sales",
                boundary: "observed_engagement_not_router_truth",
              },
              events: [
                {
                  kind: "sent",
                  eventId: "evt-sent-1",
                  occurredAt: "2026-05-20T08:00:00.000Z",
                  touchId: "touch-001",
                  channel: "linkedin",
                },
              ],
              commercialSignals: [
                {
                  kind: "opportunity_created",
                  eventId: "sig-1",
                  occurredAt: "2026-05-22T10:00:00.000Z",
                  amountUsd: 99999,
                  crmRef: "HS-001",
                },
              ],
            },
          ],
        }),
      );
      store.close();

      const db = new DatabaseSync(dbPath);
      try {
        const eng = db
          .prepare(
            `SELECT COUNT(*) n FROM idempotency_violations WHERE scope='engagement_event'`,
          )
          .get() as { n: number };
        const sig = db
          .prepare(
            `SELECT COUNT(*) n FROM idempotency_violations WHERE scope='commercial_signal'`,
          )
          .get() as { n: number };
        expect(eng.n).toBeGreaterThanOrEqual(1);
        expect(sig.n).toBeGreaterThanOrEqual(1);
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("same commercial signal eventId + changed payload writes an idempotency_violation and skips", () => {
    const store = new Store(":memory:");
    store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });

    store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-lease",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [],
            commercialSignals: [opportunitySignal("sig-1")],
          },
        ],
      }),
    );

    const result = store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-lease",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [],
            commercialSignals: [
              {
                kind: "opportunity_created",
                eventId: "sig-1",
                occurredAt: "2026-05-22T10:00:00.000Z",
                amountUsd: 99999, // changed
                crmRef: "HS-001",
              },
            ],
          },
        ],
      }),
    );

    expect(result.commercialSignalsRecorded).toBe(0);
    expect(store.commercialSignals("D-lease")).toHaveLength(1);
    expect(store.commercialSignals("D-lease")[0]?.amountUsd).toBe(80000);

    store.close();
  });
});

// ─── importEngagementFeedback — boundary: unknown routerDealId ─────────────

describe("store — importEngagementFeedback boundary", () => {
  it("unknown routerDealId pushes to unknownDealRejections, writes no events", () => {
    const store = new Store(":memory:");
    const result = store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-unknown",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [sentEvent("evt-unknown-1")],
          },
        ],
      }),
    );

    expect(result.unknownDealRejections).toEqual([
      { routerDealId: "D-unknown", eventCount: 1 },
    ]);
    expect(result.eventsRecorded).toBe(0);
    expect(store.engagementEvents()).toHaveLength(0);
    store.close();
  });

  it("one bad deal in a batch does not abort recording the valid deal", () => {
    const store = new Store(":memory:");
    store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });

    const result = store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-unknown-only",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [sentEvent("evt-bad-1")],
          },
          {
            routerDealId: "D-lease",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [sentEvent("evt-good-1")],
          },
        ],
      }),
    );

    expect(result.unknownDealRejections).toHaveLength(1);
    expect(result.unknownDealRejections[0]?.routerDealId).toBe("D-unknown-only");
    expect(result.eventsRecorded).toBe(1);
    expect(store.engagementEvents("D-lease")).toHaveLength(1);
    store.close();
  });

  it("importing engagement feedback does NOT modify commercial_states", () => {
    const store = new Store(":memory:");
    store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });

    // Seed a real commercial_states row so the snapshot is non-empty.
    store.recordLocalCommercialState({
      dealId: "D-lease",
      commercialState: "open",
      sourceEventId: "cc000001-cc00-4c00-8c00-cc0000000001",
      occurredAt: "2026-05-29T08:00:00.000Z",
      reason: null,
      expectedRedPath: false,
    });

    const before = store.allCommercialStatesSnapshot();

    // Guard: the snapshot must be non-empty and contain the seeded deal,
    // so this test can never pass vacuously by comparing two empty strings.
    expect(before).toContain("D-lease");

    store.importEngagementFeedback(
      engagementFeedback({
        deals: [
          {
            routerDealId: "D-lease",
            trace: {
              sourceSystem: "sales",
              boundary: "observed_engagement_not_router_truth",
            },
            events: [sentEvent("evt-cs-1")],
            commercialSignals: [opportunitySignal("sig-cs-1")],
          },
        ],
      }),
    );

    const after = store.allCommercialStatesSnapshot();
    // Byte-for-byte unchanged: the importer must never touch commercial_states.
    expect(after).toBe(before);
    store.close();
  });

  it("strict UTC boundary: non-canonical timestamp throws at import, not silently accepted", () => {
    const store = new Store(":memory:");
    store.recordRouted(routed(), 0, { mode: "dry_run", status: "dry_run" });

    const badTimestamp = "2026-05-20T08:00:00Z"; // missing .sss milliseconds
    expect(() =>
      store.importEngagementFeedback(
        engagementFeedback({
          deals: [
            {
              routerDealId: "D-lease",
              trace: {
                sourceSystem: "sales",
                boundary: "observed_engagement_not_router_truth",
              },
              events: [
                {
                  kind: "sent",
                  eventId: "evt-bad-ts",
                  occurredAt: badTimestamp,
                  touchId: "touch-001",
                  channel: "email",
                } as EngagementEvent,
              ],
            },
          ],
        }),
      ),
    ).toThrow(/canonical UTC/);
    expect(store.engagementEvents("D-lease")).toHaveLength(0);
    store.close();
  });
});
