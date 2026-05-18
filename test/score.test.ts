import { describe, expect, it } from "vitest";
import { score } from "../src/score.js";
import type { EnrichedDeal } from "../src/types.js";

function deal(over: Partial<EnrichedDeal> = {}): EnrichedDeal {
  return {
    id: "D-test",
    company: "Test Co",
    domain: "test.co",
    contactName: "T",
    contactEmail: "t@test.co",
    dealUSD: 20000,
    region: "NA",
    sourceChannel: "inbound_form",
    statedNeed: "manual work",
    enrichment: {
      employees: 200,
      industry: "logistics",
      techSignals: ["twilio"],
      regulated: false,
      confidence: 0.9,
    },
    ...over,
  };
}

describe("score — deterministic and recomputable", () => {
  it("core industry scores icpFit 1.0", () => {
    expect(score(deal()).icpFit).toBe(1);
  });

  it("adjacent industry scores icpFit 0.5, off-ICP 0.2", () => {
    expect(
      score(deal({ enrichment: { ...deal().enrichment, industry: "retail" } }))
        .icpFit,
    ).toBe(0.5);
    expect(
      score(deal({ enrichment: { ...deal().enrichment, industry: "media" } }))
        .icpFit,
    ).toBe(0.2);
  });

  it("counts pain keywords and tech-signal boost", () => {
    const s = score(
      deal({ statedNeed: "manual spreadsheet work, errors and backlog" }),
    );
    // manual + spreadsheet + error + errors + backlog = 5 hits -> capped 1.0
    expect(s.painSignal).toBe(1);
  });

  it("no pain keywords and no tech signals -> painSignal 0", () => {
    const s = score(
      deal({
        statedNeed: "we want a dashboard",
        enrichment: { ...deal().enrichment, techSignals: [] },
      }),
    );
    expect(s.painSignal).toBe(0);
  });

  it("size band: <50 -> 0.4, 50..5000 -> 1, >5000 -> 0.7", () => {
    expect(
      score(deal({ enrichment: { ...deal().enrichment, employees: 12 } }))
        .sizeFit,
    ).toBe(0.4);
    expect(score(deal()).sizeFit).toBe(1);
    expect(
      score(deal({ enrichment: { ...deal().enrichment, employees: 9000 } }))
        .sizeFit,
    ).toBe(0.7);
  });

  it("total equals the documented weighted sum", () => {
    const s = score(deal()); // icp1 pain(.25+.2=.45) size1 region1
    const expected =
      0.35 * s.icpFit +
      0.3 * s.painSignal +
      0.2 * s.sizeFit +
      0.15 * s.regionFit;
    expect(s.total).toBeCloseTo(Math.round(expected * 100) / 100, 5);
  });

  it("emits one audit note per dimension", () => {
    const notes = score(deal()).notes.join("\n");
    expect(notes).toContain("icpFit=");
    expect(notes).toContain("painSignal=");
    expect(notes).toContain("sizeFit=");
    expect(notes).toContain("regionFit=");
  });
});
