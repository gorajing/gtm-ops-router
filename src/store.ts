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
  Metrics,
  PipelineEvent,
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
];

const SCHEMA: string[] = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA foreign_keys = ON",
  `CREATE TABLE IF NOT EXISTS deals (
     id          TEXT PRIMARY KEY,
     stage       TEXT NOT NULL,
     payload     TEXT,
     quarantine  TEXT,
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
     detail    TEXT NOT NULL
   )`,
  "CREATE INDEX IF NOT EXISTS idx_events_deal ON events(deal_id)",
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
  }

  /** Idempotent on deal id — re-ingesting the same id updates, never dupes. */
  upsertRouted(deal: RoutedDeal, latencyMs: number): "inserted" | "updated" {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare("SELECT id FROM deals WHERE id = ?")
      .get(deal.id) as { id: string } | undefined;
    this.db
      .prepare(
        `INSERT INTO deals (id, stage, payload, quarantine, latency_ms, created_at, updated_at)
         VALUES (?, 'routed', ?, NULL, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           stage='routed', payload=excluded.payload, quarantine=NULL,
           latency_ms=excluded.latency_ms, updated_at=excluded.updated_at`,
      )
      .run(deal.id, JSON.stringify(deal), latencyMs, now, now);
    return existing ? "updated" : "inserted";
  }

  upsertQuarantine(q: Quarantine, latencyMs: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO deals (id, stage, payload, quarantine, latency_ms, created_at, updated_at)
         VALUES (?, 'quarantined', NULL, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           stage='quarantined', payload=NULL, quarantine=excluded.quarantine,
           latency_ms=excluded.latency_ms, updated_at=excluded.updated_at`,
      )
      .run(q.dealId, JSON.stringify(q), latencyMs, now, now);
  }

  appendEvent(
    dealId: string,
    from: Stage | "-",
    to: Stage,
    detail: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO events (deal_id, ts, from_st, to_st, detail) VALUES (?, ?, ?, ?, ?)",
      )
      .run(dealId, new Date().toISOString(), from, to, detail);
  }

  events(dealId?: string): PipelineEvent[] {
    const rows = dealId
      ? this.db
          .prepare(
            "SELECT id, deal_id, ts, from_st, to_st, detail FROM events WHERE deal_id = ? ORDER BY id",
          )
          .all(dealId)
      : this.db
          .prepare(
            "SELECT id, deal_id, ts, from_st, to_st, detail FROM events ORDER BY id",
          )
          .all();
    return (rows as Record<string, unknown>[]).map((r) => ({
      id: Number(r.id),
      dealId: String(r.deal_id),
      ts: String(r.ts),
      from: r.from_st as Stage | "-",
      to: r.to_st as Stage,
      detail: String(r.detail),
    }));
  }

  routed(): RoutedDeal[] {
    const rows = this.db
      .prepare(
        "SELECT payload FROM deals WHERE stage='routed' ORDER BY updated_at",
      )
      .all() as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as RoutedDeal);
  }

  quarantined(): Quarantine[] {
    const rows = this.db
      .prepare(
        "SELECT quarantine FROM deals WHERE stage='quarantined' ORDER BY updated_at",
      )
      .all() as { quarantine: string }[];
    return rows.map((r) => JSON.parse(r.quarantine) as Quarantine);
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
    const flags = { pricing_approval: 0, regulated_review: 0 };
    for (const d of this.routed()) {
      routeMix[d.route.kind] += 1;
      if (d.route.kind === "human_assisted") {
        if (d.route.financeFlag) flags.pricing_approval += 1;
        if (d.route.legalFlag) flags.regulated_review += 1;
      }
    }

    const quarantineByCode = Object.fromEntries(
      QUARANTINE_CODES.map((c) => [c, 0]),
    ) as Record<QuarantineCode, number>;
    for (const q of this.quarantined()) quarantineByCode[q.code] += 1;

    const lat = (
      this.db
        .prepare(
          "SELECT latency_ms m FROM deals WHERE latency_ms IS NOT NULL ORDER BY latency_ms",
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
    };
  }

  close(): void {
    this.db.close();
  }
}
