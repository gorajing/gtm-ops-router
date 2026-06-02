/**
 * CLI entrypoint.
 *
 *   npm run demo            deterministic in-memory replay + post-sale outcomes
 *   npm run run <file>      process a JSONL file into a persistent SQLite db
 *     --demo-outcomes       bare flag: layer deterministic post-sale demo outcomes
 *   npm run serve [port]    HTTP server + live dashboard (default :8787)
 *
 * `demo` binds no port and needs no API keys — clone, install, run, done.
 * It layers the in-memory outcome fixtures by default; integration flags still
 * affect only intake→route sink receipts, not post-sale outcome writes.
 * Pass --no-demo-outcomes to show only the intake→route surface.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDemoOutcomeFixtures,
  demoCommercialStateSourceEventIds,
  demoOutcomeFixtureDealIds,
  demoOutcomeSourceEventIds,
  type DemoOutcomeFixtureResult,
} from "./demo-fixtures.js";
import {
  applyDemoEngagementFixtures,
  demoEngagementFixtureDealIds,
  demoEngagementSourceEventIds,
  type DemoEngagementResult,
} from "./demo-engagement-fixtures.js";
import { FixtureEnricher, makeEnricher, type FixtureEntry } from "./enrich.js";
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
import {
  buildSalesHandoffExport,
  type SalesHandoffExportOptions,
} from "./sales-handoff.js";
import { FlakySink } from "./sink.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function routerDbPath(): string {
  const override = process.env.GTM_ROUTER_DB_PATH;
  return override ? resolve(ROOT, override) : resolve(ROOT, "data/router.db");
}

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

function flagValue(args: string[], name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

function intFlag(args: string[], name: string, fallback: number): number {
  const raw = flagValue(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
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

function logDemoOutcomeFixtureResult(
  result: DemoOutcomeFixtureResult,
): void {
  if (result.appliedCompanies.length > 0) {
    console.log(
      `[demo outcomes] reconciled: ${result.appliedCompanies.join(", ")} ` +
        `(${result.commercialRecorded} commercial writes, ` +
        `${result.commercialDuplicate} commercial duplicates, ` +
        `${result.commercialClosedWonNoop} closed_won no-ops, ` +
        `${result.acceptedOutcomes} outcome writes, ` +
        `${result.duplicateOutcomes} outcome duplicates)`,
    );
    console.log(
      `[demo outcomes] journey: ${result.appliedDescriptions.join("; ")}`,
    );
  }
  if (result.commercialClosedWonNoop > 0) {
    console.warn(
      "[demo outcomes] layered onto existing closed_won state; cycle-time medians use the earliest projected close event and may render n/a if that close occurred after deployment",
    );
  }
  const skippedResolved = result.resolvedCompanies.filter(
    (company) => !result.appliedCompanies.includes(company),
  );
  if (skippedResolved.length > 0) {
    console.warn(
      `[demo outcomes] resolved but not fully applied; commercial close may remain: ${skippedResolved.join(", ")}`,
    );
  }
  if (result.missingCompanies.length > 0) {
    console.warn(
      `[demo outcomes] skipped missing routed companies: ${result.missingCompanies.join(", ")}`,
    );
  }
  if (result.errors.length > 0) {
    const details = result.errors
      .map((e) => {
        const event = e.outcome ? `/${e.outcome}` : "";
        const current =
          e.currentCommercialState === undefined
            ? ""
            : ` current=${e.currentCommercialState ?? "none"}`;
        return `${e.company} ${e.step}:${e.sourceEventKey}${event}=${e.status}${current}`;
      })
      .join("; ");
    console.warn(`[demo outcomes] skipped failed fixture writes: ${details}`);
  }
}

type DemoLayerEligibility =
  | { ok: true }
  | {
      ok: false;
      nonDemoOutcomes: number;
      nonDemoCommercialStates: number;
    };

function checkPersistentDemoOutcomeEligibility(store: {
  nonDemoOutcomeEventCount(
    dealIds: readonly string[],
    demoSourceEventIds: readonly string[],
  ): number;
  nonDemoProjectedCommercialStateEventCount(
    dealIds: readonly string[],
    demoSourceEventIds: readonly string[],
  ): number;
}): DemoLayerEligibility {
  const fixtureDealIds = demoOutcomeFixtureDealIds();
  const nonDemoOutcomes = store.nonDemoOutcomeEventCount(
    fixtureDealIds,
    demoOutcomeSourceEventIds(),
  );
  const nonDemoCommercialStates = store.nonDemoProjectedCommercialStateEventCount(
    fixtureDealIds,
    demoCommercialStateSourceEventIds(),
  );
  if (nonDemoOutcomes === 0 && nonDemoCommercialStates === 0) {
    return { ok: true };
  }
  return { ok: false, nonDemoOutcomes, nonDemoCommercialStates };
}

function rejectPersistentDemoOutcomeLayering(
  check: Exclude<DemoLayerEligibility, { ok: true }>,
  store: { close(): void },
  committedRoutedThisRun?: number,
): void {
  const committedDetail =
    committedRoutedThisRun === undefined
      ? ""
      : ` ${committedRoutedThisRun} routed deal(s) from this run were already committed before the overlay was refused.`;
  console.error(
    `[demo outcomes] refusing to layer fixtures into ${routerDbPath()} with ` +
      `${check.nonDemoOutcomes} non-demo outcome rows on fixture deals and ` +
      `${check.nonDemoCommercialStates} non-demo commercial-state events on fixture deals; ` +
      "use a fresh router DB or rerun without --demo-outcomes." +
      committedDetail,
  );
  store.close();
  process.exitCode = 2;
}

type DemoEngagementLayerEligibility =
  | { ok: true }
  | { ok: false; nonDemoEngagementEvents: number };

function checkPersistentDemoEngagementEligibility(store: {
  nonDemoEngagementEventCount(
    dealIds: readonly string[],
    demoSourceEventIds: readonly string[],
  ): number;
}): DemoEngagementLayerEligibility {
  const fixtureDealIds = demoEngagementFixtureDealIds();
  const nonDemoEngagementEvents = store.nonDemoEngagementEventCount(
    fixtureDealIds,
    demoEngagementSourceEventIds(),
  );
  if (nonDemoEngagementEvents === 0) return { ok: true };
  return { ok: false, nonDemoEngagementEvents };
}

function rejectPersistentDemoEngagementLayering(
  check: Exclude<DemoEngagementLayerEligibility, { ok: true }>,
  store: { close(): void },
): void {
  console.error(
    `[demo engagement] refusing to layer fixtures into ${routerDbPath()} with ` +
      `${check.nonDemoEngagementEvents} non-demo engagement rows on fixture deals; ` +
      "use a fresh router DB or rerun without --demo-engagement.",
  );
  store.close();
  process.exitCode = 2;
}

function logDemoEngagementResult(result: DemoEngagementResult): void {
  if (result.eventsRecorded > 0 || result.eventsDuplicate > 0) {
    console.log(
      `[demo engagement] imported: ${result.eventsRecorded} events recorded, ` +
        `${result.eventsDuplicate} duplicates, ` +
        `${result.commercialSignalsRecorded} commercial signals recorded, ` +
        `${result.unknownDealRejections.length} unknown deal rejections`,
    );
  }
  if (result.unknownDealRejections.length > 0) {
    const detail = result.unknownDealRejections
      .map((r) => `${r.routerDealId}(${r.eventCount})`)
      .join(", ");
    console.warn(`[demo engagement] unknown deal rejections: ${detail}`);
  }
}

async function cmdDemo(args: string[]): Promise<void> {
  const wantsDemoOutcomes = args.includes("--demo-outcomes");
  const skipsDemoOutcomes = args.includes("--no-demo-outcomes");
  const skipsDemoEngagement = args.includes("--no-demo-engagement");
  const wantsDemoEngagementExplicit = args.includes("--demo-engagement");
  if (wantsDemoOutcomes && skipsDemoOutcomes) {
    console.warn(
      "[demo outcomes] both demo outcome flags passed; --no-demo-outcomes wins",
    );
  } else if (wantsDemoOutcomes) {
    console.warn(
      "[demo outcomes] demo layers outcomes by default; --demo-outcomes is a no-op here",
    );
  }
  if (wantsDemoEngagementExplicit && skipsDemoEngagement) {
    console.warn(
      "[demo engagement] both engagement flags passed; --no-demo-engagement wins",
    );
  } else if (wantsDemoEngagementExplicit) {
    console.warn(
      "[demo engagement] demo layers engagement by default; --demo-engagement is a no-op here",
    );
  }
  const Store = await loadStore();
  const store = new Store(":memory:");
  const enricher = new FixtureEnricher(loadFixture());
  const seed = loadJsonl(`${ROOT}data/inbound.seed.jsonl`);
  const { label, opts, configBundle } = pipelineOptions(args);
  store.recordIntegrationConfigBundle(configBundle);
  if (label === "flaky") {
    console.log(
      "[--flaky] live sink: 1 retryable failure then success; " +
        "EuroDist → terminal (see QUARANTINED: sink_terminal)",
    );
  }
  if (label === "hubspot+slack:dry-run") {
    console.log(
      "[--integrations] dry-run HubSpot + Slack sink: no secrets, no network; " +
        "event trail shows the cross-system handoff",
    );
  }
  if (label === "hubspot+slack") {
    console.log("[--live-integrations] writing to HubSpot and Slack");
  }

  const outcomes = await processBatch(seed, store, enricher, opts);
  if (!skipsDemoOutcomes) {
    const demoOutcomes = applyDemoOutcomeFixtures(
      store,
      store.routedByIds(demoOutcomeFixtureDealIds()),
    );
    logDemoOutcomeFixtureResult(demoOutcomes);
  }
  if (!skipsDemoEngagement) {
    // :memory: store has no prior state; guard is always ok but kept for
    // symmetry with cmdRun so the code paths match.
    const demoEngagement = applyDemoEngagementFixtures(
      store,
      store.routedByIds(demoEngagementFixtureDealIds()),
    );
    logDemoEngagementResult(demoEngagement);
  }

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
  const store = new Store(routerDbPath());
  const enricher = makeEnricher(process.env);
  const { opts, configBundle } = pipelineOptions(args);
  const skipsDemoOutcomes = args.includes("--no-demo-outcomes");
  const wantsDemoOutcomes =
    args.includes("--demo-outcomes") && !skipsDemoOutcomes;
  if (args.includes("--demo-outcomes") && skipsDemoOutcomes) {
    console.warn(
      "[demo outcomes] both demo outcome flags passed; --no-demo-outcomes wins",
    );
  }
  const skipsDemoEngagement = args.includes("--no-demo-engagement");
  const wantsDemoEngagement =
    args.includes("--demo-engagement") && !skipsDemoEngagement;
  if (args.includes("--demo-engagement") && skipsDemoEngagement) {
    console.warn(
      "[demo engagement] both engagement flags passed; --no-demo-engagement wins",
    );
  }
  if (wantsDemoOutcomes) {
    const check = checkPersistentDemoOutcomeEligibility(store);
    if (!check.ok) {
      rejectPersistentDemoOutcomeLayering(check, store);
      return;
    }
  }
  if (wantsDemoEngagement) {
    const check = checkPersistentDemoEngagementEligibility(store);
    if (!check.ok) {
      rejectPersistentDemoEngagementLayering(check, store);
      return;
    }
  }
  store.recordIntegrationConfigBundle(configBundle);
  const outcomes = await processBatch(
    loadJsonl(file),
    store,
    enricher,
    opts,
  );
  if (wantsDemoOutcomes) {
    // Fast-fail above catches pre-existing DB history; this second check keeps
    // fixture layering safe if a future intake path records post-sale state.
    // Revisit when processBatch can emit commercial-state or outcome rows.
    const check = checkPersistentDemoOutcomeEligibility(store);
    if (!check.ok) {
      rejectPersistentDemoOutcomeLayering(
        check,
        store,
        outcomes.filter((outcome) => outcome.ok).length,
      );
      return;
    }
    const demoOutcomes = applyDemoOutcomeFixtures(
      store,
      store.routedByIds(demoOutcomeFixtureDealIds()),
    );
    logDemoOutcomeFixtureResult(demoOutcomes);
  }
  if (wantsDemoEngagement) {
    // Second guard: keeps layering safe if a future intake path records
    // engagement rows. Revisit when processBatch can emit engagement events.
    const check = checkPersistentDemoEngagementEligibility(store);
    if (!check.ok) {
      rejectPersistentDemoEngagementLayering(check, store);
      return;
    }
    const demoEngagement = applyDemoEngagementFixtures(
      store,
      store.routedByIds(demoEngagementFixtureDealIds()),
    );
    logDemoEngagementResult(demoEngagement);
  }
  console.log(renderMetricsTable(store.metrics()));
  store.close();
}

async function cmdServe(portArg: string | undefined, args: string[]): Promise<void> {
  if (args.includes("--demo-outcomes") || args.includes("--no-demo-outcomes")) {
    console.warn(
      "[demo outcomes] serve reads the existing SQLite state; ignoring demo outcome flags",
    );
  }
  if (args.includes("--demo-engagement") || args.includes("--no-demo-engagement")) {
    console.warn(
      "[demo engagement] serve reads the existing SQLite state; ignoring demo engagement flags",
    );
  }
  const port = Number(portArg ?? 8787);
  if (!Number.isInteger(port) || port <= 0) {
    console.error(`invalid port: ${portArg}`);
    process.exitCode = 2;
    return;
  }
  const Store = await loadStore();
  const store = new Store(routerDbPath());
  const enricher = makeEnricher(process.env);
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

async function cmdExportSales(args: string[]): Promise<void> {
  const Store = await loadStore();
  const store = new Store(routerDbPath());
  try {
    const exportOptions: SalesHandoffExportOptions = {
      limit: intFlag(args, "--limit", 25),
      includeAllRoutes: args.includes("--include-all-routes"),
    };
    const operatorBaseUrl = flagValue(args, "--operator-base-url");
    if (operatorBaseUrl !== undefined) exportOptions.operatorBaseUrl = operatorBaseUrl;
    const payload = buildSalesHandoffExport(store, exportOptions);
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    const outPath = flagValue(args, "--out");
    if (outPath) {
      const absolutePath = resolve(process.cwd(), outPath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, json);
      console.log(
        `wrote ${payload.accounts.length} sales handoff account(s) to ${absolutePath}`,
      );
    } else {
      process.stdout.write(json);
    }
  } finally {
    store.close();
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
    case "export-sales":
      await cmdExportSales(args);
      return;
    default:
      console.error(
        `unknown command: ${cmd ?? "(none)"} — expected demo | run | serve | doctor | export-sales` +
          ` (flags: --flaky | --integrations | --live-integrations | --demo-outcomes | --no-demo-outcomes | --demo-engagement | --no-demo-engagement | --send-test | --limit | --out | --include-all-routes)`,
      );
      process.exitCode = 2;
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
