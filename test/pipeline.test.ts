import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { FixtureEnricher, type FixtureEntry } from "../src/enrich.js";
import { processBatch, processOne } from "../src/pipeline.js";
import { FlakySink, type OpportunitySink } from "../src/sink.js";
import { Store } from "../src/store.js";

const DATA = fileURLToPath(new URL("../data/", import.meta.url));

function fixture(): Record<string, FixtureEntry> {
  return JSON.parse(
    readFileSync(`${DATA}enrichment.fixture.json`, "utf8"),
  ) as Record<string, FixtureEntry>;
}
function seed(): unknown[] {
  return readFileSync(`${DATA}inbound.seed.jsonl`, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const validDeal = {
  company: "Ryder Digital",
  domain: "ryder-digital.com",
  contactName: "Dana Pruitt",
  contactEmail: "dana@ryder-digital.com",
  dealUSD: 120000,
  region: "NA",
  sourceChannel: "inbound_form",
  statedNeed: "30 reps stuck on manual check calls after hours, we can't scale",
};

describe("pipeline — happy path", () => {
  it("routes a valid core deal and records an event trail", async () => {
    const store = new Store(":memory:");
    const out = await processOne(validDeal, store, new FixtureEnricher(fixture()));
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.deal.route.kind).toBe("human_assisted");
      if (out.deal.route.kind === "human_assisted") {
        expect(out.deal.route.financeFlag).toBe("pricing_approval");
        expect(out.deal.route.legalFlag).toBe("regulated_review");
      }
    }
    // intake -> enriched -> scored -> sink(dry-run) -> routed = 5 events
    expect(store.events(store.routed()[0]?.id).length).toBe(5);
    store.close();
  });

  it("keeps limited deal journeys bounded while preserving the intake event", async () => {
    const store = new Store(":memory:");
    const out = await processOne(validDeal, store, new FixtureEnricher(fixture()));
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected routed deal");
    for (let i = 0; i < 60; i += 1) {
      store.appendEvent(out.deal.id, "scored", "scored", `operator note ${i}`);
    }

    const { events, total, truncated } = store.eventsBookended(out.deal.id, 50);
    expect(events).toHaveLength(50);
    expect(total).toBe(65);
    expect(truncated).toBe(true);
    expect(events[0]?.detail).toBe("intake: Ryder Digital");
    expect(events.at(-1)?.detail).toBe("operator note 59");
    store.close();
  });

  it("plain deal event reads are capped", async () => {
    const store = new Store(":memory:");
    const out = await processOne(validDeal, store, new FixtureEnricher(fixture()));
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected routed deal");
    for (let i = 0; i < 1001; i += 1) {
      store.appendEvent(out.deal.id, "scored", "scored", `operator note ${i}`);
    }

    expect(store.events(out.deal.id)).toHaveLength(1000);
    store.close();
  });
});

describe("pipeline — every failure mode is typed, never dropped", () => {
  it("schema_invalid: bad email + negative dealUSD", async () => {
    const store = new Store(":memory:");
    const out = await processOne(
      { ...validDeal, contactEmail: "nope", dealUSD: -5 },
      store,
      new FixtureEnricher(fixture()),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.quarantine.code).toBe("schema_invalid");
    store.close();
  });

  it("enrichment_unresolved: unknown company is NOT guessed", async () => {
    const store = new Store(":memory:");
    const out = await processOne(
      { ...validDeal, company: "Mystery Co", domain: "unknown-co.com" },
      store,
      new FixtureEnricher(fixture()),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.quarantine.code).toBe("enrichment_unresolved");
    store.close();
  });

  it("enrichment_unresolved: provider timeout is caught loudly", async () => {
    const store = new Store(":memory:");
    const out = await processOne(
      { ...validDeal, company: "Laggy Lines", domain: "laggylines.com" },
      store,
      new FixtureEnricher(fixture()),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.quarantine.code).toBe("enrichment_unresolved");
      expect(out.quarantine.reason).toContain("timeout");
    }
    store.close();
  });

  it("insufficient_data: low enrichment confidence refuses to score", async () => {
    const store = new Store(":memory:");
    const out = await processOne(
      { ...validDeal, company: "Foggy Freight", domain: "foggyfreight.com" },
      store,
      new FixtureEnricher(fixture()),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.quarantine.code).toBe("insufficient_data");
    store.close();
  });

  it("store_error: a persistence failure is surfaced, not swallowed", async () => {
    class ExplodingStore extends Store {
      override upsertRouted(): "inserted" | "updated" {
        throw new Error("disk full");
      }
    }
    const store = new ExplodingStore(":memory:");
    const out = await processOne(validDeal, store, new FixtureEnricher(fixture()));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.quarantine.code).toBe("store_error");
      expect(out.quarantine.reason).toContain("disk full");
    }
    store.close();
  });

  it("returns a loud fallback when quarantine persistence itself fails", async () => {
    class ExplodingQuarantineStore extends Store {
      override recordQuarantine(): void {
        throw new Error("db locked");
      }
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new ExplodingQuarantineStore(":memory:");
    const out = await processOne(
      { ...validDeal, contactEmail: "nope" },
      store,
      new FixtureEnricher(fixture()),
    );

    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.quarantine.code).toBe("schema_invalid");
      expect(out.quarantine.reason).toContain("quarantine persistence failed");
    }
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("quarantine_persist_failed"),
    );
    errorSpy.mockRestore();
    store.close();
  });
});

describe("pipeline — idempotency (data accuracy by construction)", () => {
  it("re-ingesting the same logical deal does not duplicate", async () => {
    const store = new Store(":memory:");
    const e = new FixtureEnricher(fixture());
    await processOne(validDeal, store, e);
    await processOne(validDeal, store, e);
    expect(store.routed().length).toBe(1);
    store.close();
  });
});

describe("pipeline — deterministic corpus metrics (the demo, asserted)", () => {
  it("the seed corpus produces exactly the documented numbers", async () => {
    const store = new Store(":memory:");
    const outcomes = await processBatch(seed(), store, new FixtureEnricher(fixture()));
    const m = store.metrics();

    // 14 input lines: 10 route OK (incl. the Midwest duplicate), 4 quarantine
    expect(outcomes.filter((o) => o.ok).length).toBe(10);
    expect(outcomes.filter((o) => !o.ok).length).toBe(4);

    // ...but the duplicate is deduped at the store -> 9 distinct routed rows
    expect(store.routed().length).toBe(9);
    expect(m.intake).toBe(13);
    expect(m.routed).toBe(9);
    expect(m.quarantined).toBe(4);
    expect(store.integrity().ok).toBe(true);

    expect(m.routeMix).toEqual({
      nurture: 1,
      self_serve: 2,
      human_assisted: 6,
    });
    expect(m.flags).toEqual({ pricing_approval: 4, regulated_review: 4 });
    expect(m.quarantineByCode).toEqual({
      schema_invalid: 1,
      enrichment_unresolved: 2,
      insufficient_data: 1,
      store_error: 0,
      pipeline_error: 0,
      sink_terminal: 0,
      sink_exhausted: 0,
    });
    expect(m.conversionPct).toBe(69.2);
    expect(m.quarantineRatePct).toBe(30.8);

    // business intuition: money + human-touch saved (default run = dry-run)
    expect(m.routedArrUsd).toBe(508000);
    expect(m.humanRoutedArrUsd).toBe(457000);
    expect(m.autoHandled).toBe(3);
    expect(m.partialSyncs).toBe(0);
    expect(m.externallySyncedStoreErrors).toBe(0);
    expect(m.stageNotificationAuditGaps).toBe(0);
    expect(m.arrByRoute).toEqual({
      nurture: 40000,
      self_serve: 11000,
      human_assisted: 457000,
    });

    const ryder = outcomes.find(
      (o) => o.ok && o.deal.company === "Ryder Digital",
    );
    expect(ryder?.ok && ryder.deal.route.kind).toBe("human_assisted");
    const offTarget = outcomes.find(
      (o) => o.ok && o.deal.company === "Off Target Media",
    );
    expect(offTarget?.ok && offTarget.deal.route.kind).toBe("nurture");

    store.close();
  });
});

describe("pipeline — downstream sink (live, not dry-run)", () => {
  const liveRetry = { maxAttempts: 3, baseDelayMs: 0, sleep: async () => {} };

  it("retryable sink failures recover, deal still routes", async () => {
    const store = new Store(":memory:");
    const out = await processOne(validDeal, store, new FixtureEnricher(fixture()), {
      dryRun: false,
      sink: new FlakySink({ retryableTimes: 2 }),
      retry: liveRetry,
    });
    expect(out.ok).toBe(true);
    expect(store.routed().length).toBe(1);
    store.close();
  });

  it("terminal sink rejection -> sink_terminal quarantine, not routed", async () => {
    const store = new Store(":memory:");
    const out = await processOne(validDeal, store, new FixtureEnricher(fixture()), {
      dryRun: false,
      sink: new FlakySink({
        retryableTimes: 0,
        terminalCompanies: new Set(["Ryder Digital"]),
      }),
      retry: liveRetry,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.quarantine.code).toBe("sink_terminal");
    expect(store.routed().length).toBe(0); // invariant: routed XOR quarantined
    store.close();
  });

  it("retries exhausted -> sink_exhausted quarantine", async () => {
    const store = new Store(":memory:");
    const out = await processOne(validDeal, store, new FixtureEnricher(fixture()), {
      dryRun: false,
      sink: new FlakySink({ retryableTimes: 99 }),
      retry: liveRetry,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.quarantine.code).toBe("sink_exhausted");
    store.close();
  });

  it("counts live sync gaps when external write succeeds but local persistence fails", async () => {
    class ExplodingStore extends Store {
      override upsertRouted(): "inserted" | "updated" {
        throw new Error("disk full");
      }
    }
    const sink: OpportunitySink = {
      name: "crm",
      async upsert(deal) {
        return [{ system: "hubspot", externalId: deal.id, detail: "upserted" }];
      },
    };
    const store = new ExplodingStore(":memory:");
    const out = await processOne(validDeal, store, new FixtureEnricher(fixture()), {
      dryRun: false,
      sink,
      retry: liveRetry,
    });

    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.quarantine.code).toBe("store_error");
    expect(store.metrics().externallySyncedStoreErrors).toBe(1);
    store.close();
  });

  it("keeps processing a batch after an unexpected per-deal throw", async () => {
    let calls = 0;
    const sink: OpportunitySink = {
      name: "buggy-sink",
      async upsert(deal) {
        calls += 1;
        if (calls === 1) throw new TypeError("undefined is not a function");
        return [{ system: "hubspot", externalId: deal.id, detail: "upserted" }];
      },
    };
    const store = new Store(":memory:");
    const outcomes = await processBatch(
      [
        validDeal,
        {
          ...validDeal,
          company: "Ryder Digital Expansion",
          contactEmail: "expansion@ryder-digital.com",
        },
      ],
      store,
      new FixtureEnricher(fixture()),
      { dryRun: false, sink, retry: liveRetry },
    );

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.ok).toBe(false);
    if (outcomes[0] && !outcomes[0].ok) {
      expect(outcomes[0].quarantine.code).toBe("pipeline_error");
      expect(outcomes[0].quarantine.reason).toContain(
        "unexpected pipeline error",
      );
    }
    expect(outcomes[1]?.ok).toBe(true);
    expect(store.metrics().routed).toBe(1);
    expect(store.metrics().quarantineByCode.pipeline_error).toBe(1);
    store.close();
  });
});
