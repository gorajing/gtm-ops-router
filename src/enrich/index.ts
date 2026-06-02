import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FixtureEnricher, type FixtureEntry, type Enricher } from "./enricher.js";
import { GroundedLlmEnricher } from "./grounded-llm.js";

const DATA = fileURLToPath(new URL("../../data/", import.meta.url));

/** Dual-mode: real grounded LLM enricher when keyed, deterministic fixture otherwise. */
export function makeEnricher(env: NodeJS.ProcessEnv): Enricher {
  const key = env.ANTHROPIC_API_KEY;
  if (key && key.trim() !== "") return GroundedLlmEnricher.fromEnv(key);
  const fixture = JSON.parse(readFileSync(`${DATA}enrichment.fixture.json`, "utf8")) as Record<string, FixtureEntry>;
  return new FixtureEnricher(fixture);
}

export { GroundedLlmEnricher } from "./grounded-llm.js";
