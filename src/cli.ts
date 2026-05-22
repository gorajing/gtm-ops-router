/**
 * CLI entrypoint.
 *
 *   npm run demo            deterministic in-memory replay of the seed corpus
 *   npm run run <file>      process a JSONL file into a persistent SQLite db
 *   npm run serve [port]    HTTP server + live dashboard (default :8787)
 *
 * `demo` binds no port and needs no API keys — clone, install, run, done.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FixtureEnricher, type FixtureEntry } from "./enrich.js";
import {
  type IntegrationBuild,
  type IntegrationConfigBundle,
  integrationConfigBundleFromEnv,
  integrationOptionsFromEnv,
  renderIntegrationChecks,
  runIntegrationDoctor,
} from "./integrations.js";
import { processBatch } from "./pipeline.js";
import type { PipelineOptions } from "./pipeline.js";
import {
  renderMetricsTable,
  renderQuarantineTable,
  renderRoutedTable,
} from "./observe.js";
import { startServer } from "./server.js";
import { FlakySink } from "./sink.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function loadDotEnv(): void {
  const path = `${ROOT}.env`;
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();
    const quoted = rawValue.match(/^(['"])(.*)\1$/);
    const value = quoted ? quoted[2] ?? "" : rawValue;
    if (!(key in process.env)) process.env[key] = value;
  }
}

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

async function loadStore(): Promise<typeof import("./store.js").Store> {
  await import("./preflight.js"); // must run before store touches node:sqlite
  return (await import("./store.js")).Store;
}

function integrationMode(args: string[]): "off" | "dry-run" | "live" {
  if (args.includes("--live-integrations")) return "live";
  if (args.includes("--integrations")) return "dry-run";
  return "off";
}

function pipelineOptions(
  args: string[],
): {
  label: string;
  opts: Partial<PipelineOptions>;
  configBundle: IntegrationConfigBundle;
  stageChanges?: IntegrationBuild["stageChanges"];
  readinessNotifications?: IntegrationBuild["readinessNotifications"];
  fallbackNotifications?: IntegrationBuild["fallbackNotifications"];
  terminalDriftNotifications?: IntegrationBuild["terminalDriftNotifications"];
} {
  const mode = integrationMode(args);
  if (mode !== "off") {
    const built = integrationOptionsFromEnv(mode);
    return {
      label: built.label,
      opts: built,
      configBundle: built.configBundle,
      stageChanges: built.stageChanges,
      readinessNotifications: built.readinessNotifications,
      fallbackNotifications: built.fallbackNotifications,
      terminalDriftNotifications: built.terminalDriftNotifications,
    };
  }
  const configBundle = integrationConfigBundleFromEnv(mode);
  if (args.includes("--flaky")) {
    return {
      label: "flaky",
      configBundle,
      opts: {
        dryRun: false,
        sink: new FlakySink({
          retryableTimes: 1,
          terminalCompanies: new Set(["EuroDist"]),
        }),
        retry: { maxAttempts: 3, baseDelayMs: 0, sleep: async () => {} },
      },
    };
  }
  return { label: "logging", opts: {}, configBundle };
}

async function cmdDemo(args: string[]): Promise<void> {
  const Store = await loadStore();
  const store = new Store(":memory:");
  const enricher = new FixtureEnricher(loadFixture());
  const seed = loadJsonl(`${ROOT}data/inbound.seed.jsonl`);
  const { label, opts, configBundle } = pipelineOptions(args);
  store.recordIntegrationConfigBundle(configBundle);
  if (label === "flaky") {
    console.log(
      "[--flaky] live sink: 1 retryable failure then success; " +
        "EuroDist → terminal (see QUARANTINED: sink_terminal)\n",
    );
  }
  if (label === "hubspot+slack:dry-run") {
    console.log(
      "[--integrations] dry-run HubSpot + Slack sink: no secrets, no network; " +
        "event trail shows the cross-system handoff\n",
    );
  }
  if (label === "hubspot+slack") {
    console.log("[--live-integrations] writing to HubSpot and Slack\n");
  }

  const outcomes = await processBatch(seed, store, enricher, opts);

  console.log(renderMetricsTable(store.metrics()));
  console.log("\nROUTED");
  console.log(renderRoutedTable(store.routed()));
  console.log("\nQUARANTINED (loud, never dropped)");
  console.log(renderQuarantineTable(store.quarantined()));

  const firstRouted = outcomes.find((o) => o.ok);
  if (firstRouted && firstRouted.ok) {
    console.log(`\nEVENT TRAIL — ${firstRouted.deal.id} (latest 1000 events)`);
    for (const e of store.events(firstRouted.deal.id)) {
      console.log(`  ${e.ts}  ${e.from} → ${e.to}  ${e.detail}`);
    }
  }
  store.close();
}

async function cmdRun(file: string | undefined, args: string[]): Promise<void> {
  if (!file) {
    console.error("usage: npm run run -- <path-to.jsonl>");
    process.exitCode = 2;
    return;
  }
  const Store = await loadStore();
  const store = new Store(`${ROOT}data/router.db`);
  const enricher = new FixtureEnricher(loadFixture());
  const { opts, configBundle } = pipelineOptions(args);
  store.recordIntegrationConfigBundle(configBundle);
  await processBatch(
    loadJsonl(file),
    store,
    enricher,
    opts,
  );
  console.log(renderMetricsTable(store.metrics()));
  store.close();
}

async function cmdServe(portArg: string | undefined, args: string[]): Promise<void> {
  const port = Number(portArg ?? 8787);
  if (!Number.isInteger(port) || port <= 0) {
    console.error(`invalid port: ${portArg}`);
    process.exitCode = 2;
    return;
  }
  const Store = await loadStore();
  const store = new Store(`${ROOT}data/router.db`);
  const enricher = new FixtureEnricher(loadFixture());
  const mode = integrationMode(args);
  const {
    label,
    opts,
    configBundle,
    stageChanges,
    readinessNotifications,
    fallbackNotifications,
    terminalDriftNotifications,
  } = pipelineOptions(args);
  store.recordIntegrationConfigBundle(configBundle);
  const server = startServer(store, enricher, port, {
    pipelineOptions: opts,
    sinkLabel: label,
    liveIntegrations: mode === "live",
    ...(stageChanges ? { stageChanges } : {}),
    ...(readinessNotifications ? { readinessNotifications } : {}),
    ...(fallbackNotifications ? { fallbackNotifications } : {}),
    ...(terminalDriftNotifications ? { terminalDriftNotifications } : {}),
  });
  let closed = false;
  const closeStore = (): void => {
    if (closed) return;
    closed = true;
    store.close();
  };
  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`\nreceived ${signal}; shutting down`);
    const timer = setTimeout(() => {
      closeStore();
      process.exit(0);
    }, 2_000);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      closeStore();
      process.exit(0);
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`gtm-ops-router listening on http://localhost:${port}`);
  console.log(`  GET  /            operator console`);
  console.log(`  GET  /state       operator state`);
  console.log(`  GET  /deals/:id/events`);
  console.log(`  GET  /integration-health`);
  console.log(`  GET  /metrics     JSON metrics`);
  console.log(`  POST /preview     dry-run route preview`);
  console.log(`  POST /deals       ingest (single object or array)`);
  console.log(`  POST /webhooks/hubspot  HubSpot dealstage webhook`);
  console.log(`  sink              ${label}`);
}

async function cmdDoctor(args: string[]): Promise<void> {
  const checks = await runIntegrationDoctor({
    sendSlackTest: args.includes("--send-test"),
  });
  console.log(renderIntegrationChecks(checks));
  if (checks.some((check) => check.status === "fail")) {
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const positionals = args.filter((a) => !a.startsWith("-"));
  const cmd = positionals[0];
  switch (cmd) {
    case "demo":
      await cmdDemo(args);
      return;
    case "run":
      await cmdRun(positionals[1], args);
      return;
    case "serve":
      await cmdServe(positionals[1], args);
      return;
    case "doctor":
      await cmdDoctor(args);
      return;
    default:
      console.error(
        `unknown command: ${cmd ?? "(none)"} — expected demo | run | serve | doctor` +
          ` (flags: --flaky | --integrations | --live-integrations | --send-test)`,
      );
      process.exitCode = 2;
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
