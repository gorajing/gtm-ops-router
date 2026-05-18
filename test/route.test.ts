import { describe, expect, it } from "vitest";
import { route } from "../src/route.js";
import type { Region, ScoredDeal } from "../src/types.js";

function scored(over: {
  total?: number;
  dealUSD?: number;
  region?: Region;
  regulated?: boolean;
}): ScoredDeal {
  const total = over.total ?? 0.8;
  return {
    id: "D-test",
    company: "Test Co",
    domain: "test.co",
    contactName: "T",
    contactEmail: "t@test.co",
    dealUSD: over.dealUSD ?? 20000,
    region: over.region ?? "NA",
    sourceChannel: "inbound_form",
    statedNeed: "manual work",
    enrichment: {
      employees: 200,
      industry: "logistics",
      techSignals: [],
      regulated: over.regulated ?? false,
      confidence: 0.9,
    },
    score: {
      icpFit: 1,
      painSignal: 1,
      sizeFit: 1,
      regionFit: 1,
      total,
      notes: [],
    },
  };
}

describe("route — the L7 judgment, encoded", () => {
  it("below ICP threshold -> nurture (no rep time)", () => {
    expect(route(scored({ total: 0.4 })).kind).toBe("nurture");
  });

  it("qualified and < $10K -> self_serve", () => {
    const r = route(scored({ total: 0.8, dealUSD: 8000 }));
    expect(r.kind).toBe("self_serve");
  });

  it(">= $10K -> human_assisted with an owner", () => {
    const r = route(scored({ total: 0.8, dealUSD: 15000, region: "NA" }));
    expect(r.kind).toBe("human_assisted");
    if (r.kind === "human_assisted") {
      expect(r.salesOwner).toBe("ae.morgan");
      expect(r.financeFlag).toBeNull();
      expect(r.legalFlag).toBeNull();
    }
  });

  it(">= $50K sets the finance pricing_approval flag", () => {
    const r = route(scored({ dealUSD: 60000 }));
    if (r.kind === "human_assisted") {
      expect(r.financeFlag).toBe("pricing_approval");
    } else {
      throw new Error("expected human_assisted");
    }
  });

  it("regulated buyer OR EU/UK region sets legal flag", () => {
    const reg = route(scored({ dealUSD: 20000, regulated: true }));
    const eu = route(scored({ dealUSD: 20000, region: "EU" }));
    if (reg.kind === "human_assisted") {
      expect(reg.legalFlag).toBe("regulated_review");
    }
    if (eu.kind === "human_assisted") {
      expect(eu.legalFlag).toBe("regulated_review");
    }
  });

  it("non-regulated NA mid-deal triggers neither flag", () => {
    const r = route(scored({ dealUSD: 20000, region: "NA" }));
    if (r.kind === "human_assisted") {
      expect(r.financeFlag).toBeNull();
      expect(r.legalFlag).toBeNull();
    }
  });
});
