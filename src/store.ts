/**
 * Persistence + observability store.
 *
 * Uses Node's BUILT-IN SQLite (`node:sqlite`) on purpose: real SQL (the JD
 * asks for SQL), zero native build step, so `git clone && npm i && npm run
 * demo` works on any machine running Node >= 22.5. Trading a battle-tested
 * native dep for clone-and-run reliability is a deliberate tradeoff: real
 * SQL with no native build step.
 *
 * DDL and pragmas are issued one statement per prepared call (no
 * multi-statement string execution) — explicit, lint-clean, and easy to audit.
 */

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import {
  DEPLOYMENT_FACT_MAX_AGE_DAYS,
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
import type { IntegrationConfigBundle } from "./integrations.js";
import {
  DEPLOYMENT_BLOCKERS,
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
  type LocalOutcomeInput,
  type LocalOutcomeWriteResult,
  type Metrics,
  type OutcomeEventRecord,
  type OutcomeRejectionKind,
  type OutcomeRejectionRecord,
  type OutcomeState,
  type PipelineEvent,
  type PipelineEventMeta,
  type PreviousDeploymentReadiness,
  type Quarantine,
  type QuarantineCode,
  type ReadinessFallbackNotificationClaim,
  type ReadinessFallbackNotificationClaimMissStatus,
  type ReadinessFallbackNotificationDeliveryResult,
  type ReadinessNotificationClaim,
  type ReadinessNotificationDeliveryResult,
  type ReadinessNotificationRecordStatus,
  type RoutedDeal,
  type Stage,
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

// Stage-change Slack posts are single-attempt and bounded by the shared webhook
// fetch cap in constants.ts. notify_leases counts lease acquisitions, not only
// completed Slack posts.
const NOTIFY_PENDING_LEASE_MS = STAGE_NOTIFICATION_LEASE_MS;
const NOTIFICATION_LEASE_CHANGED = "notification lease changed before mark";
const MAX_EVENT_TAIL = 1000;
const LOCAL_COMMERCIAL_SOURCE = "local";
const LOCAL_DEPLOYMENT_FACTS_SOURCE = "local";
const LOCAL_OUTCOME_SOURCE = "local";
const SELF_REPORTED_OPERATOR_SOURCE = "self_reported";
const DAY_MS = 86_400_000;
type NotifiableReadiness = Exclude<DeploymentReadiness, "not_required">;
type OutcomeMetricRow = {
  id: string;
  dealId: string;
  outcome: OutcomeState;
  occurredAt: string;
  createdAt: string;
  arrDeltaUsd: number | null;
};

const COMMERCIAL_STATE_RANK: Record<CommercialState, number> = {
  open: 0,
  proposal_sent: 1,
  negotiating: 2,
  closed_won: 3,
  closed_lost: 4,
};

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
       scope IN ('commercial_state', 'deployment_facts', 'outcome') OR
       scope LIKE 'external_event_observation:%'
     )
   )`,
  "CREATE INDEX IF NOT EXISTS idx_events_deal ON events(deal_id)",
  "CREATE INDEX IF NOT EXISTS idx_events_deal_id ON events(deal_id, id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage)",
  "CREATE INDEX IF NOT EXISTS idx_commercial_states_state ON commercial_states(commercial_state)",
  "CREATE INDEX IF NOT EXISTS idx_deployment_readiness_status ON deployment_readiness(readiness)",
  "CREATE INDEX IF NOT EXISTS idx_external_event_observations_code ON external_event_observations(observation_code)",
  "CREATE INDEX IF NOT EXISTS idx_outcome_events_deal ON outcome_events(deal_id, occurred_at)",
  "CREATE INDEX IF NOT EXISTS idx_outcome_events_deal_outcome ON outcome_events(deal_id, outcome, occurred_at)",
  "CREATE INDEX IF NOT EXISTS idx_outcome_events_outcome ON outcome_events(outcome, occurred_at)",
  "CREATE INDEX IF NOT EXISTS idx_outcome_rejections_kind ON outcome_rejections(rejection_kind, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_outcome_rejections_deal ON outcome_rejections(deal_id, created_at)",
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)] ?? 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function hoursBetween(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return null;
  }
  return Math.round(((end - start) / 3_600_000) * 100) / 100;
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

export class Store {
  private db: DatabaseSyncT;

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
    this.ensureIdempotencyViolationOutcomeScope();
    this.backfillExternalNotificationLeases();
    this.backfillDerivedColumns();
    this.backfillSinkColumns();
  }

  private ensureColumn(
    table: "deals" | "events" | "external_event_keys",
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

  private ensureIdempotencyViolationOutcomeScope(): void {
    const row = this.db
      .prepare(
        `SELECT sql
         FROM sqlite_master
         WHERE type = 'table'
           AND name = 'idempotency_violations'`,
      )
      .get() as { sql: string | null } | undefined;
    if (!row?.sql || row.sql.includes("'outcome'")) return;

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
               scope IN ('commercial_state', 'deployment_facts', 'outcome') OR
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

  private transaction<T>(fn: () => T): T {
    this.db.prepare("BEGIN").run();
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

  upsertQuarantine(q: Quarantine, latencyMs: number): void {
    const now = new Date().toISOString();
    const sink = this.sinkStateFromEvents(q.dealId);
    this.db
      .prepare(
        `INSERT INTO deals (
           id, stage, payload, quarantine, route_kind, finance_flag, legal_flag,
           deal_usd, quarantine_code, sink_mode, sink_status, latency_ms, created_at, updated_at
         )
         VALUES (?, 'quarantined', NULL, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           stage='quarantined', payload=NULL, quarantine=excluded.quarantine,
           route_kind=NULL, finance_flag=NULL, legal_flag=NULL, deal_usd=NULL,
           quarantine_code=excluded.quarantine_code,
           sink_mode=excluded.sink_mode, sink_status=excluded.sink_status,
           latency_ms=excluded.latency_ms, updated_at=excluded.updated_at`,
      )
      .run(
        q.dealId,
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

  recordQuarantine(
    q: Quarantine,
    latencyMs: number,
    from: Stage | "-",
    detail: string,
  ): void {
    this.transaction(() => {
      this.appendEvent(q.dealId, from, "quarantined", detail);
      this.upsertQuarantine(q, latencyMs);
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
        LOCAL_COMMERCIAL_SOURCE,
        sourceEventId,
        scope,
        existingPayloadHash,
        incomingPayloadHash,
        reason,
        new Date().toISOString(),
      );
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

  recordLocalOutcome(input: LocalOutcomeInput): LocalOutcomeWriteResult {
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
    return {
      status,
      eventKey,
      dealId: input.dealId,
      sourceEventId: input.sourceEventId,
      accepted,
      event: this.outcomeEventBySourceEvent(input.sourceEventId),
      rejection: this.outcomeRejectionBySourceEvent(input.sourceEventId),
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

  routedRecords(
    limit?: number,
  ): Array<{
    deal: RoutedDeal;
    updatedAt: string;
    sinkStatus: "synced" | "partial" | "dry_run" | "needs_review";
    externalStage: ExternalStageState | null;
  }> {
    const cappedLimit =
      limit === undefined ? undefined : Math.max(1, Math.min(1000, limit));
    const rows =
      cappedLimit === undefined
        ? (this.db
            .prepare(
              `SELECT payload, updated_at, sink_status, external_system,
                      external_id, external_stage_id, external_stage_label,
                      external_stage_updated_at
               FROM deals
               WHERE stage='routed'
               ORDER BY updated_at DESC`,
            )
            .all() as Array<{
            payload: string;
            updated_at: string;
            sink_status: string | null;
            external_system: string | null;
            external_id: string | null;
            external_stage_id: string | null;
            external_stage_label: string | null;
            external_stage_updated_at: string | null;
          }>)
        : (this.db
            .prepare(
              `SELECT payload, updated_at, sink_status, external_system,
                      external_id, external_stage_id, external_stage_label,
                      external_stage_updated_at
               FROM deals
               WHERE stage='routed'
               ORDER BY updated_at DESC
               LIMIT ?`,
            )
            .all(cappedLimit) as Array<{
            payload: string;
            updated_at: string;
            sink_status: string | null;
            external_system: string | null;
            external_id: string | null;
            external_stage_id: string | null;
            external_stage_label: string | null;
            external_stage_updated_at: string | null;
          }>);
    return rows.map((r) => ({
      deal: JSON.parse(r.payload) as RoutedDeal,
      updatedAt: r.updated_at,
      sinkStatus:
        r.sink_status === "synced" ||
        r.sink_status === "partial" ||
        r.sink_status === "dry_run"
          ? r.sink_status
          : "needs_review",
      externalStage: this.externalStageFromRow(r),
    }));
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
  ): Array<{
    quarantine: Quarantine;
    updatedAt: string;
    externalStage: ExternalStageState | null;
  }> {
    const cappedLimit =
      limit === undefined ? undefined : Math.max(1, Math.min(1000, limit));
    const rows =
      cappedLimit === undefined
        ? (this.db
            .prepare(
              `SELECT quarantine, updated_at, external_system, external_id,
                      external_stage_id, external_stage_label,
                      external_stage_updated_at
               FROM deals WHERE stage='quarantined' ORDER BY updated_at DESC`,
            )
            .all() as Array<{
            quarantine: string;
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
                      external_stage_updated_at
               FROM deals WHERE stage='quarantined' ORDER BY updated_at DESC LIMIT ?`,
            )
            .all(cappedLimit) as Array<{
            quarantine: string;
            updated_at: string;
            external_system: string | null;
            external_id: string | null;
            external_stage_id: string | null;
            external_stage_label: string | null;
            external_stage_updated_at: string | null;
          }>);
    return rows.map((r) => ({
      quarantine: JSON.parse(r.quarantine) as Quarantine,
      updatedAt: r.updated_at,
      externalStage: this.externalStageFromRow(r),
    }));
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

    const firstProjectedClosedWonAtByDeal = new Map<string, string>();
    const commercialEventRows = this.db
      .prepare(
        `SELECT deal_id, meta
         FROM events
         WHERE meta IS NOT NULL
         ORDER BY ts, id`,
      )
      .all() as Array<{ deal_id: string; meta: string }>;
    for (const row of commercialEventRows) {
      let meta: PipelineEventMeta;
      try {
        meta = JSON.parse(row.meta) as PipelineEventMeta;
      } catch {
        continue;
      }
      if (
        meta.kind !== "commercial_state" ||
        meta.commercialState !== "closed_won" ||
        meta.projected !== true
      ) {
        continue;
      }
      const previous = firstProjectedClosedWonAtByDeal.get(row.deal_id);
      if (previous === undefined || meta.occurredAt < previous) {
        firstProjectedClosedWonAtByDeal.set(row.deal_id, meta.occurredAt);
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
        const closedWonAt = firstProjectedClosedWonAtByDeal.get(dealId);
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
