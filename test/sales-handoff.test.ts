import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FixtureEnricher, type FixtureEntry } from "../src/enrich.js";
import { processOne } from "../src/pipeline.js";
import {
  SALES_HANDOFF_SCHEMA_VERSION,
  buildSalesHandoffExport,
} from "../src/sales-handoff.js";
import { Store } from "../src/store.js";

const DATA = fileURLToPath(new URL("../data/", import.meta.url));

function fixture(): Record<string, FixtureEntry> {
  return JSON.parse(
    readFileSync(`${DATA}enrichment.fixture.json`, "utf8"),
  ) as Record<string, FixtureEntry>;
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

describe("sales handoff export", () => {
  it("exports routed workflow context as a Sales research seed", async () => {
    const store = new Store(":memory:");
    const outcome = await processOne(
      validDeal,
      store,
      new FixtureEnricher(fixture()),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected routed deal");

    const signal = store.roleQueues().ae_attention[0];
    if (!signal) throw new Error("expected AE queue signal");
    const opened = store.recordLocalWorkItem(
      {
        dealId: outcome.deal.id,
        queue: "ae_attention",
        sourceEventId: "11111111-1111-4111-9111-111111111111",
        owner: "ae.morgan",
        createdBy: "operator-console",
        occurredAt: "2026-05-24T15:00:00.000Z",
        reason: "Open from queue.",
      },
      signal,
    );
    expect(opened.status).toBe("recorded");

    const draftRun = store.recordWorkItemSuggestions({
      createdBy: "work-item-agent",
      evaluatedAt: "2026-05-24T15:05:00.000Z",
      limit: 5,
    });
    expect(draftRun.recorded).toBe(1);

    const payload = buildSalesHandoffExport(store, {
      generatedAt: "2026-05-24T15:10:00.000Z",
      limit: 10,
    });

    expect(payload.schemaVersion).toBe(SALES_HANDOFF_SCHEMA_VERSION);
    expect(payload.accounts).toHaveLength(1);
    expect(payload.accounts[0]).toEqual(
      expect.objectContaining({
        routerDealId: outcome.deal.id,
        trace: {
          sourceSystem: "gtm-ops-router",
          evidenceBoundary: "research_seed_not_verified_evidence",
        },
        account: expect.objectContaining({
          name: "Ryder Digital",
          domain: "ryder-digital.com",
          sourceChannel: "inbound_form",
        }),
        opportunity: expect.objectContaining({
          amountUsd: 120000,
          route: expect.objectContaining({
            kind: "human_assisted",
            salesOwner: "ae.morgan",
            financeFlag: "pricing_approval",
            legalFlag: "regulated_review",
          }),
        }),
        enrichmentEvidence: expect.objectContaining({
          sourceProvider: "fixture",
          industry: "logistics",
          confidence: 0.95,
        }),
      }),
    );
    expect(payload.accounts[0]?.operatorLinks).toBeUndefined();
    const linkedPayload = buildSalesHandoffExport(store, {
      generatedAt: "2026-05-24T15:10:00.000Z",
      limit: 10,
      operatorBaseUrl: "http://localhost:8787",
    });
    expect(linkedPayload.accounts[0]?.operatorLinks).toEqual({
      consoleUrl: `http://localhost:8787/?deal=${encodeURIComponent(outcome.deal.id)}`,
      eventsUrl: `http://localhost:8787/deals/${encodeURIComponent(outcome.deal.id)}/events`,
    });
    const subpathPayload = buildSalesHandoffExport(store, {
      generatedAt: "2026-05-24T15:10:00.000Z",
      limit: 10,
      operatorBaseUrl: "https://demo.example.com/router",
    });
    expect(subpathPayload.accounts[0]?.operatorLinks).toEqual({
      consoleUrl: `https://demo.example.com/router/?deal=${encodeURIComponent(outcome.deal.id)}`,
      eventsUrl: `https://demo.example.com/router/deals/${encodeURIComponent(outcome.deal.id)}/events`,
    });
    expect(payload.accounts[0]?.workflow.workItems).toEqual([
      expect.objectContaining({
        queue: "ae_attention",
        status: "assigned",
        owner: "ae.morgan",
      }),
    ]);
    expect(payload.accounts[0]?.workflow.agentSuggestions).toEqual([
      expect.objectContaining({
        kind: "handoff_summary",
        status: "proposed",
      }),
    ]);
    expect(payload.accounts[0]?.salesToolInput.researchBrief).toContain(
      "Ryder Digital entered the GTM router",
    );
    expect(payload.accounts[0]?.salesToolInput.suggestedEvidenceQuestions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("pricing approval"),
        expect.stringContaining("regulatory"),
      ]),
    );
    store.close();
  });

  it("can export all routes when explicitly requested", async () => {
    const store = new Store(":memory:");
    await processOne(validDeal, store, new FixtureEnricher(fixture()));
    await processOne(
      {
        ...validDeal,
        company: "Tiny Trucking",
        domain: "tinytrucking.com",
        contactName: "Tia Driver",
        contactEmail: "tia@tinytrucking.com",
        dealUSD: 3000,
      },
      store,
      new FixtureEnricher(fixture()),
    );

    const humanOnly = buildSalesHandoffExport(store, {
      generatedAt: "2026-05-24T15:10:00.000Z",
    });
    const allRoutes = buildSalesHandoffExport(store, {
      generatedAt: "2026-05-24T15:10:00.000Z",
      includeAllRoutes: true,
    });

    expect(humanOnly.accounts.map((account) => account.account.name)).toEqual([
      "Ryder Digital",
    ]);
    expect(allRoutes.accounts.map((account) => account.account.name)).toEqual(
      expect.arrayContaining(["Tiny Trucking", "Ryder Digital"]),
    );
    store.close();
  });
});
