import { describe, expect, it, vi } from "vitest";
import {
  FlakySink,
  LoggingSink,
  RetryableSinkError,
  SinkExhaustedError,
  TerminalSinkError,
  withRetry,
  type RetryOptions,
} from "../src/sink.js";
import type { RoutedDeal } from "../src/types.js";

const noSleep: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 0,
  sleep: async () => {},
};

function routed(id = "D-1", company = "Test Co"): RoutedDeal {
  return {
    id,
    company,
    domain: "t.co",
    contactName: "T",
    contactEmail: "t@t.co",
    dealUSD: 20000,
    region: "NA",
    sourceChannel: "inbound_form",
    statedNeed: "manual",
    enrichment: {
      employees: 100,
      industry: "logistics",
      techSignals: [],
      regulated: false,
      confidence: 0.9,
    },
    score: { icpFit: 1, painSignal: 1, sizeFit: 1, regionFit: 1, total: 1, notes: [] },
    route: { kind: "self_serve", queue: "sales_self_serve", slaHours: 24 },
  };
}

describe("withRetry — retryable vs terminal is the whole point", () => {
  it("terminal error is rethrown immediately, never retried", async () => {
    const fn = vi.fn(async () => {
      throw new TerminalSinkError("400 invalid");
    });
    await expect(withRetry(fn, noSleep)).rejects.toBeInstanceOf(
      TerminalSinkError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retryable error recovers within budget", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n < 3) throw new RetryableSinkError(`429 #${n}`);
    });
    await expect(withRetry(fn, noSleep)).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retryable past budget becomes SinkExhaustedError", async () => {
    const fn = vi.fn(async () => {
      throw new RetryableSinkError("429 always");
    });
    await expect(withRetry(fn, noSleep)).rejects.toBeInstanceOf(
      SinkExhaustedError,
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("sinks", () => {
  it("LoggingSink resolves and logs intent (dry-run default)", async () => {
    const lines: string[] = [];
    await new LoggingSink((l) => lines.push(l)).upsert(routed());
    expect(lines[0]).toContain("would upsert CRM opportunity D-1");
  });

  it("FlakySink: retryableTimes then success", async () => {
    const s = new FlakySink({ retryableTimes: 2 });
    await expect(withRetry(() => s.upsert(routed("D-2")), noSleep)).resolves
      .toBeUndefined();
  });

  it("FlakySink: terminalCompanies throws terminal (no retry)", async () => {
    const s = new FlakySink({
      retryableTimes: 0,
      terminalCompanies: new Set(["EuroDist"]),
    });
    await expect(s.upsert(routed("D-3", "EuroDist"))).rejects.toBeInstanceOf(
      TerminalSinkError,
    );
  });
});
