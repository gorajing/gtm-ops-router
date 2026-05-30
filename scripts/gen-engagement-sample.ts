import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyDemoEngagementFixtures } from "../src/demo-engagement-fixtures.js";
import { FixtureEnricher, type FixtureEntry } from "../src/enrich.js";
import { processBatch } from "../src/pipeline.js";
import { Store } from "../src/store.js";

const DATA = fileURLToPath(new URL("../data/", import.meta.url));

const fixture = JSON.parse(
  readFileSync(`${DATA}enrichment.fixture.json`, "utf8"),
) as Record<string, FixtureEntry>;

const seedLines = readFileSync(`${DATA}inbound.seed.jsonl`, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l) as unknown);

const store = new Store(":memory:");
await processBatch(seedLines, store, new FixtureEnricher(fixture));
const result = applyDemoEngagementFixtures(store, store.routed());
store.close();

writeFileSync(
  `${DATA}engagement-feedback.sample.json`,
  JSON.stringify(result.payload, null, 2) + "\n",
);
console.log("wrote data/engagement-feedback.sample.json");
