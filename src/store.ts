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
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
import type {
  ExternalStageState,
  Metrics,
  PipelineEvent,
  PipelineEventMeta,
  Quarantine,
  QuarantineCode,
  RoutedDeal,
  Stage,
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
     notify_attempts INTEGER NOT NULL DEFAULT 0,
     notified_at TEXT,
     notify_error TEXT
   )`,
  "CREATE INDEX IF NOT EXISTS idx_events_deal ON events(deal_id)",
  "CREATE INDEX IF NOT EXISTS idx_events_deal_id ON events(deal_id, id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals(stage)",
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)] ?? 0;
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
      "TEXT NOT NULL DEFAULT 'ok'",
    );
    this.ensureColumn(
      "external_event_keys",
      "notify_attempts",
      "INTEGER NOT NULL DEFAULT 0",
    );
    this.ensureColumn("external_event_keys", "notified_at", "TEXT");
    this.ensureColumn("external_event_keys", "notify_error", "TEXT");
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
        .prepare("SELECT key, notify_status FROM external_event_keys WHERE key = ?")
        .get(eventKey) as { key: string; notify_status: string | null } | undefined;
      if (existingEvent) {
        if (existingEvent.notify_status === "failed") {
          if (stale) return "stale";
          const now = new Date().toISOString();
          this.db
            .prepare(
              "UPDATE external_event_keys SET notify_status='pending' WHERE key = ?",
            )
            .run(eventKey);
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
        return "duplicate";
      }

      if (stale) return "stale";

      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO external_event_keys (key, system, recorded_at, notify_status, notify_attempts) VALUES (?, ?, ?, 'pending', 0)",
        )
        .run(eventKey, stage.system, now);
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
  ): void {
    const failed = receipts.some((receipt) => receipt.status === "warning");
    const status = receipts.length === 0 ? "suppressed" : failed ? "failed" : "ok";
    const error = failed
      ? receipts
          .filter((receipt) => receipt.status === "warning")
          .map((receipt) => receipt.detail)
          .join("; ")
          .slice(0, 500)
      : null;
    this.db
      .prepare(
        `UPDATE external_event_keys
         SET notify_status = ?,
             notify_attempts = notify_attempts + 1,
             notified_at = ?,
             notify_error = ?
         WHERE key = ?`,
      )
      .run(status, new Date().toISOString(), error, eventKey);
  }

  recordExternalNotificationEvent(
    dealId: string,
    detail: string,
    meta: PipelineEventMeta,
    eventKey: string,
    receipts: Array<{ detail: string; status?: "ok" | "warning" }>,
  ): void {
    this.transaction(() => {
      this.markExternalNotification(eventKey, receipts);
      this.appendEvent(dealId, "routed", "routed", detail, meta);
    });
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
      limit === undefined ? undefined : Math.max(1, Math.min(1000, limit));
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
          "SELECT id, deal_id, ts, from_st, to_st, detail, meta FROM events WHERE deal_id = ? ORDER BY id",
        )
        .all(dealId);
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

  metrics(): Metrics {
    const count = (sql: string): number =>
      Number((this.db.prepare(sql).get() as { n: number }).n);

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
