/**
 * CLI entrypoint.
 *
 *   npm run demo            deterministic in-memory replay of the seed corpus
 *   npm run run <file>      process a JSONL file into a persistent SQLite db
 *   npm run serve [port]    HTTP server + live dashboard (default :8787)
 *
 * `demo` binds no port and needs no API keys — clone, install, run, done.
 */

import "./preflight.js"; // must run before any module that touches node:sqlite
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FixtureEnricher, type FixtureEntry } from "./enrich.js";
import { processBatch } from "./pipeline.js";
import {
  renderMetricsTable,
  renderQuarantineTable,
  renderRoutedTable,
} from "./observe.js";
import { startServer } from "./server.js";
import { Store } from "./store.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function loadFixture(): Record<string, FixtureEntry> {
  return JSON.parse(
    readFileSync(`${ROOT}data/enrichment.fixture.json`, "utf8"),
  ) as Record<string, FixtureEntry>;
}

function loadJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        // Malformed JSON is itself a record the pipeline must quarantine,
        // so pass the raw string through rather than crashing the loader.
        return { __rawLine: l, __lineNo: i + 1 };
      }
    });
}

async function cmdDemo(): Promise<void> {
  const store = new Store(":memory:");
  const enricher = new FixtureEnricher(loadFixture());
  const seed = loadJsonl(`${ROOT}data/inbound.seed.jsonl`);

  const outcomes = await processBatch(seed, store, enricher);

  console.log(renderMetricsTable(store.metrics()));
  console.log("\nROUTED");
  console.log(renderRoutedTable(store.routed()));
  console.log("\nQUARANTINED (loud, never dropped)");
  console.log(renderQuarantineTable(store.quarantined()));

  const firstRouted = outcomes.find((o) => o.ok);
  if (firstRouted && firstRouted.ok) {
    console.log(`\nEVENT TRAIL — ${firstRouted.deal.id} (full observability)`);
    for (const e of store.events(firstRouted.deal.id)) {
      console.log(`  ${e.ts}  ${e.from} → ${e.to}  ${e.detail}`);
    }
  }
  store.close();
}

async function cmdRun(file: string | undefined): Promise<void> {
  if (!file) {
    console.error("usage: npm run run -- <path-to.jsonl>");
    process.exitCode = 2;
    return;
  }
  const store = new Store(`${ROOT}data/router.db`);
  const enricher = new FixtureEnricher(loadFixture());
  await processBatch(loadJsonl(file), store, enricher);
  console.log(renderMetricsTable(store.metrics()));
  store.close();
}

function cmdServe(portArg: string | undefined): void {
  const port = Number(portArg ?? 8787);
  if (!Number.isInteger(port) || port <= 0) {
    console.error(`invalid port: ${portArg}`);
    process.exitCode = 2;
    return;
  }
  const store = new Store(`${ROOT}data/router.db`);
  const enricher = new FixtureEnricher(loadFixture());
  startServer(store, enricher, port);
  console.log(`gtm-ops-router listening on http://localhost:${port}`);
  console.log(`  GET  /            dashboard`);
  console.log(`  GET  /metrics     JSON metrics`);
  console.log(`  POST /deals       ingest (single object or array)`);
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "demo":
      await cmdDemo();
      return;
    case "run":
      await cmdRun(arg);
      return;
    case "serve":
      cmdServe(arg);
      return;
    default:
      console.error(
        `unknown command: ${cmd ?? "(none)"} — expected demo | run | serve`,
      );
      process.exitCode = 2;
  }
}

void main();
