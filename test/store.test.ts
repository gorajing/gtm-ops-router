import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.js";
import type {
  ExternalStageState,
  PipelineEventMeta,
  RoutedDeal,
} from "../src/types.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    prepare(sql: string): { run(...args: unknown[]): unknown };
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

class AuditAppendFailureStore extends Store {
  failNotificationAppend = false;

  override appendEvent(...args: Parameters<Store["appendEvent"]>): void {
    if (this.failNotificationAppend && args[3] === "hubspot stage notification") {
      throw new Error("event append failed");
    }
    super.appendEvent(...args);
  }
}

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
