import { describe, it, expect } from "vitest";
import { evidenceCeiling, resolveEnrichment, type Coverage, type LlmFirmographics } from "../src/enrich/confidence.js";

const full: LlmFirmographics = {
  employees: { value: 400, basis: "evidence" }, industry: { value: "freight", basis: "evidence" },
  regulated: { value: true, basis: "inference" }, techSignals: ["twilio"], selfConfidence: 0.99,
};
const cov = (over: Partial<Coverage> = {}): Coverage => ({ homepage: true, dns: true, tech: true, ...over });

describe("evidenceCeiling", () => {
  it("is 0.15 (strictly < 0.2, forces quarantine) with no homepage and no dns", () => {
    expect(evidenceCeiling(cov({ homepage: false, dns: false, tech: false }))).toBeLessThan(0.2);
    expect(evidenceCeiling(cov({ homepage: false, dns: false, tech: false }))).toBe(0.15);
  });
  it("is high (~0.85) with homepage + dns + tech", () => {
    expect(evidenceCeiling(cov())).toBeGreaterThanOrEqual(0.85);
  });
  it("is monotonic: more coverage never lowers the ceiling", () => {
    expect(evidenceCeiling(cov({ tech: false }))).toBeLessThanOrEqual(evidenceCeiling(cov()));
    expect(evidenceCeiling(cov({ dns: false, tech: false }))).toBeLessThanOrEqual(evidenceCeiling(cov({ tech: false })));
  });
});

describe("resolveEnrichment", () => {
  it("clamps an overconfident model to the code ceiling (injection defense)", () => {
    const e = resolveEnrichment(full, cov({ homepage: false, dns: false, tech: false }));
    expect(e).not.toBeNull();
    expect(e!.confidence).toBe(0.15); // min(0.99, 0.15)
  });
  it("uses the model selfConfidence when below the ceiling", () => {
    const e = resolveEnrichment({ ...full, selfConfidence: 0.5 }, cov());
    expect(e!.confidence).toBe(0.5);
  });
  it("returns null when a routing-critical field is unknown (no placeholder routes)", () => {
    expect(resolveEnrichment({ ...full, employees: { value: null, basis: "unknown" } }, cov())).toBeNull();
    expect(resolveEnrichment({ ...full, industry: { value: null, basis: "unknown" } }, cov())).toBeNull();
    expect(resolveEnrichment({ ...full, regulated: { value: null, basis: "unknown" } }, cov())).toBeNull();
  });
  it("allows empty techSignals (not routing-critical)", () => {
    expect(resolveEnrichment({ ...full, techSignals: [] }, cov())).not.toBeNull();
  });
  it("returns null on an implausible employee count (0 / negative / non-finite / fractional)", () => {
    for (const value of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 12.5]) {
      expect(resolveEnrichment({ ...full, employees: { value, basis: "evidence" } }, cov())).toBeNull();
    }
  });
});
