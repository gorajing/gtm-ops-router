import { describe, it, expect } from "vitest";
import { makeEnricher } from "../src/enrich/index.js";
import { FixtureEnricher } from "../src/enrich.js";
import { GroundedLlmEnricher } from "../src/enrich/grounded-llm.js";

describe("makeEnricher", () => {
  it("returns the fixture enricher when no ANTHROPIC_API_KEY", () => {
    expect(makeEnricher({})).toBeInstanceOf(FixtureEnricher);
  });
  it("returns the grounded LLM enricher when ANTHROPIC_API_KEY is set", () => {
    expect(makeEnricher({ ANTHROPIC_API_KEY: "sk-test" })).toBeInstanceOf(GroundedLlmEnricher);
  });
});
