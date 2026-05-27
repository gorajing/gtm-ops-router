import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  applyDemoOutcomeFixtures,
  demoCommercialStateSourceEventIds,
  demoOutcomeFixtureDealIds,
  demoOutcomeSourceEventIds,
} from "../src/demo-fixtures.js";
import { FixtureEnricher, type FixtureEntry } from "../src/enrich.js";
import { normalize } from "../src/intake.js";
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

  it("records enrichment evidence without changing route behavior", async () => {
    const store = new Store(":memory:");
    const out = await processOne(validDeal, store, new FixtureEnricher(fixture()));
    expect(out.ok).toBe(true);

    const facts = store.enrichedSubjectFacts("company", "ryder-digital.com");
    expect(facts).toEqual(
      expect.objectContaining({
        sourceProvider: "fixture",
        subjectKey: "ryder-digital.com",
        industry: "logistics",
        employees: 1200,
        techSignals: ["salesforce", "twilio"],
        confidence: 0.95,
        freshnessStatus: "fresh",
      }),
    );
    expect(store.providerObservations("company", "ryder-digital.com")).toHaveLength(
      1,
    );
    expect(store.routed()[0]?.route.kind).toBe("human_assisted");
    store.close();
  });

  it("deduplicates identical provider evidence across deals for the same subject", async () => {
    const store = new Store(":memory:");
    const e = new FixtureEnricher(fixture());
    await processOne(validDeal, store, e);
    await processOne(
      {
        ...validDeal,
        contactName: "Riley Ops",
        contactEmail: "riley@ryder-digital.com",
        dealUSD: 130000,
      },
      store,
      e,
    );

    expect(store.routed()).toHaveLength(2);
    expect(store.providerObservations("company", "ryder-digital.com")).toHaveLength(
      1,
    );
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

    const events = store.events(out.deal.id);
    expect(events).toHaveLength(1000);
    expect(events.some((event) => event.detail === "intake: Ryder Digital")).toBe(
      false,
    );
    expect(events.at(-1)?.detail).toBe("operator note 1000");
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
    expect(store.providerObservations("company", "foggyfreight.com")).toHaveLength(
      1,
    );
    expect(store.enrichedSubjectFacts("company", "foggyfreight.com")).toBeNull();
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

  it("enrichment evidence failures do not become a new routing gate", async () => {
    class ExplodingEvidenceStore extends Store {
      override recordEnrichmentObservation(): never {
        throw new Error("evidence table locked");
      }
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new ExplodingEvidenceStore(":memory:");
    const out = await processOne(validDeal, store, new FixtureEnricher(fixture()));

    expect(out.ok).toBe(true);
    if (out.ok) expect(out.deal.route.kind).toBe("human_assisted");
    expect(store.events(store.routed()[0]?.id).map((event) => event.detail)).toContain(
      "enrichment_evidence_persist_failed: evidence table locked",
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("enrichment_evidence_persist_failed"),
    );
    errorSpy.mockRestore();
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
    expect(store.providerObservations("company", "ryder-digital.com")).toHaveLength(
      1,
    );
    store.close();
  });
});

describe("pipeline — deterministic corpus metrics (the demo, asserted)", () => {
  it("keeps demo outcome fixture ids aligned to the seed records", () => {
    const idsByCompany = new Map<string, string>();
    for (const raw of seed()) {
      const normalized = normalize(raw);
      if (normalized.ok) {
        idsByCompany.set(normalized.deal.company, normalized.deal.id);
      }
    }

    expect(idsByCompany.get("Ryder Digital")).toBe("D-fb65c15017ef");
    expect(idsByCompany.get("Cargo Loop")).toBe("D-cdea8ac45022");
  });

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

  it("can layer deterministic post-sale outcome fixtures onto the demo corpus", async () => {
    const store = new Store(":memory:");
    await processBatch(seed(), store, new FixtureEnricher(fixture()));

    const first = applyDemoOutcomeFixtures(store, store.routed());
    const second = applyDemoOutcomeFixtures(store, store.routed());
    const m = store.metrics();

    expect(first).toEqual(expect.objectContaining({
      fixturesResolved: 2,
      commercialRecorded: 2,
      commercialDuplicate: 0,
      commercialClosedWonNoop: 0,
      acceptedOutcomes: 6,
      duplicateOutcomes: 0,
      resolvedCompanies: ["Ryder Digital", "Cargo Loop"],
      appliedCompanies: ["Ryder Digital", "Cargo Loop"],
      missingCompanies: [],
      errors: [],
    }));
    expect(second).toEqual(expect.objectContaining({
      fixturesResolved: 2,
      commercialRecorded: 0,
      commercialDuplicate: 2,
      commercialClosedWonNoop: 0,
      acceptedOutcomes: 0,
      duplicateOutcomes: 6,
      resolvedCompanies: ["Ryder Digital", "Cargo Loop"],
      appliedCompanies: ["Ryder Digital", "Cargo Loop"],
      missingCompanies: [],
      errors: [],
    }));
    expect(m.deploymentStartedDeals).toBe(2);
    expect(m.deployedDeals).toBe(1);
    expect(m.landedDeals).toBe(1);
    expect(m.expandedDeals).toBe(1);
    expect(m.expandedArrDeltaUsd).toBe(35_000);
    expect(m.churnedDeals).toBe(1);
    expect(m.outcomeChurnBeforeDeploy).toBe(1);
    expect(m.outcomeCommercialStateConflicts).toBe(0);
    expect(m.outcomeInvalidHistories).toBe(0);
    expect(m.medianTimeClosedWonToDeployedHours).toBe(48);
    expect(m.medianTimeDeployedToLandedHours).toBe(30);
    expect(
      store.nonDemoOutcomeEventCount(
        demoOutcomeFixtureDealIds(),
        demoOutcomeSourceEventIds(),
      ),
    ).toBe(0);
    expect(
      store.nonDemoProjectedCommercialStateEventCount(
        demoOutcomeFixtureDealIds(),
        demoCommercialStateSourceEventIds(),
      ),
    ).toBe(0);
    expect(store.integrity().ok).toBe(true);

    store.close();
  });

  it("treats demo commercial source-id conflicts as fixture errors", async () => {
    const store = new Store(":memory:");
    await processBatch(seed(), store, new FixtureEnricher(fixture()));
    const ryder = store.routed().find((deal) => deal.company === "Ryder Digital");
    const [ryderDemoCommercialSourceEventId] = demoCommercialStateSourceEventIds();
    if (!ryder || !ryderDemoCommercialSourceEventId) {
      throw new Error("expected Ryder Digital seed deal and fixture source id");
    }

    expect(
      store.recordLocalCommercialState({
        dealId: ryder.id,
        commercialState: "closed_won",
        sourceEventId: ryderDemoCommercialSourceEventId,
        occurredAt: "2026-05-20T12:00:00.000Z",
        reason: "conflicting replay payload",
        expectedRedPath: false,
      }).status,
    ).toBe("recorded");

    const result = applyDemoOutcomeFixtures(store, store.routed());

    expect(result).toEqual(expect.objectContaining({
      fixturesResolved: 2,
      commercialRecorded: 1,
      commercialDuplicate: 0,
      commercialClosedWonNoop: 0,
      acceptedOutcomes: 2,
      appliedCompanies: ["Cargo Loop"],
      errors: [
        {
          company: "Ryder Digital",
          step: "commercial_state",
          status: "idempotency_conflict",
          sourceEventKey: "closed_won",
          currentCommercialState: "closed_won",
        },
      ],
    }));
    expect(store.metrics().deploymentStartedDeals).toBe(1);

    store.close();
  });

  it("scopes the non-demo outcome guard to fixture deals", async () => {
    const store = new Store(":memory:");
    await processBatch(seed(), store, new FixtureEnricher(fixture()));
    const midwest = store.routed().find((deal) => deal.company === "Midwest 3PL");
    if (!midwest) throw new Error("expected Midwest 3PL seed deal");

    expect(
      store.recordLocalCommercialState({
        dealId: midwest.id,
        commercialState: "closed_won",
        sourceEventId: "66666666-6666-4666-8666-666666666666",
        occurredAt: "2026-05-20T12:00:00.000Z",
        reason: "real non-fixture closed_won",
        expectedRedPath: false,
      }).status,
    ).toBe("recorded");
    expect(
      store.recordLocalOutcome({
        dealId: midwest.id,
        sourceEventId: "77777777-7777-4777-8777-777777777777",
        outcome: "deployment_started",
        occurredAt: "2026-05-21T12:00:00.000Z",
        operator: "ops:user",
        arrDeltaUsd: null,
        reasonCategory: "customer_ready",
      }).status,
    ).toBe("recorded");

    expect(store.outcomeEventCount()).toBe(1);
    expect(
      store.nonDemoOutcomeEventCount(
        demoOutcomeFixtureDealIds(),
        demoOutcomeSourceEventIds(),
      ),
    ).toBe(0);
    expect(
      store.nonDemoOutcomeEventCount([midwest.id], demoOutcomeSourceEventIds()),
    ).toBe(1);

    store.close();
  });

  it("keys demo outcome fixtures by router deal id, not company text", async () => {
    const store = new Store(":memory:");
    await processBatch(
      [
        validDeal,
        {
          ...validDeal,
          contactEmail: "second@ryder-digital.com",
          dealUSD: 121_000,
          statedNeed: "second team needs autonomous after-hours dispatch calls",
        },
      ],
      store,
      new FixtureEnricher(fixture()),
    );

    const result = applyDemoOutcomeFixtures(store, store.routed());

    expect(result).toEqual(expect.objectContaining({
      fixturesResolved: 1,
      commercialClosedWonNoop: 0,
      acceptedOutcomes: 4,
      resolvedCompanies: ["Ryder Digital"],
      appliedCompanies: ["Ryder Digital"],
      missingCompanies: ["Cargo Loop"],
      errors: [],
    }));
    expect(store.metrics().deploymentStartedDeals).toBe(1);

    store.close();
  });

  it("layers demo outcomes when a fixture deal is already closed_won", async () => {
    const store = new Store(":memory:");
    await processBatch(seed(), store, new FixtureEnricher(fixture()));
    const ryder = store.routed().find((deal) => deal.company === "Ryder Digital");
    if (!ryder) throw new Error("expected Ryder Digital seed deal");

    expect(
      store.recordLocalCommercialState({
        dealId: ryder.id,
        commercialState: "closed_won",
        sourceEventId: "55555555-5555-4555-8555-555555555555",
        occurredAt: "2026-05-20T12:00:00.000Z",
        reason: "external closed_won already present",
        expectedRedPath: false,
      }).status,
    ).toBe("recorded");
    expect(
      store.nonDemoProjectedCommercialStateEventCount(
        demoOutcomeFixtureDealIds(),
        demoCommercialStateSourceEventIds(),
      ),
    ).toBe(1);

    const result = applyDemoOutcomeFixtures(store, store.routed());

    expect(result).toEqual(expect.objectContaining({
      fixturesResolved: 2,
      commercialRecorded: 1,
      commercialClosedWonNoop: 1,
      acceptedOutcomes: 6,
      appliedCompanies: ["Ryder Digital", "Cargo Loop"],
      errors: [],
    }));
    expect(store.metrics().deploymentStartedDeals).toBe(2);
    expect(store.metrics().medianTimeClosedWonToDeployedHours).toBeNull();

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
