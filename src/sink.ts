/**
 * Downstream write adapter (the "CRM upsert" side of an ops handoff).
 *
 * Two failure classes, because production failure handling is exactly this
 * distinction: a 429/5xx/timeout is *retryable* (back off and try again); a
 * 4xx/validation/auth error is *terminal* (retrying just wastes budget and
 * hammers the dependency). Conflating them is the most common ops-tool bug.
 *
 * The interface contract is idempotent on deal.id, so a retry that actually
 * succeeded-but-looked-failed does not create a duplicate opportunity.
 */

import type { RoutedDeal } from "./types.js";

export class RetryableSinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableSinkError";
  }
}

export class TerminalSinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalSinkError";
  }
}

export class SinkExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastReason: string,
  ) {
    super(`sink retries exhausted after ${attempts} attempts: ${lastReason}`);
    this.name = "SinkExhaustedError";
  }
}

export interface OpportunitySink {
  readonly name: string;
  /** Idempotent on deal.id. Throws Retryable/Terminal on failure. */
  upsert(deal: RoutedDeal): Promise<SinkReceipt[]>;
}

export interface SinkReceipt {
  system: string;
  externalId: string;
  detail: string;
  url?: string;
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export const DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 100,
  sleep: realSleep,
};

/**
 * Run `fn` with bounded exponential backoff.
 *  - TerminalSinkError  -> rethrown immediately (no retry).
 *  - RetryableSinkError -> retried up to maxAttempts, then SinkExhaustedError.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = DEFAULT_RETRY,
): Promise<T> {
  let lastReason = "";
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TerminalSinkError) throw err;
      if (err instanceof RetryableSinkError) {
        lastReason = err.message;
        if (attempt < opts.maxAttempts) {
          await opts.sleep(opts.baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw new SinkExhaustedError(opts.maxAttempts, lastReason);
      }
      throw err; // unknown error type — do not silently absorb
    }
  }
  throw new SinkExhaustedError(opts.maxAttempts, lastReason);
}

/**
 * Default sink: no external system. Logs the intended write and returns.
 * Used for dry-run and as the safe default — trivially idempotent.
 */
export class LoggingSink implements OpportunitySink {
  readonly name = "logging";
  constructor(private readonly log: (line: string) => void = () => {}) {}
  async upsert(deal: RoutedDeal): Promise<SinkReceipt[]> {
    const detail =
      `would upsert CRM opportunity ${deal.id} ` +
      `(${deal.company}, $${deal.dealUSD}, route=${deal.route.kind})`;
    this.log(`[dry-run] ${detail}`);
    return [{ system: "dry_run", externalId: deal.id, detail }];
  }
}

/**
 * Deterministic fault-injecting sink for tests and the --flaky demo.
 *  - ids in `terminalIds` throw TerminalSinkError (never retried)
 *  - other ids throw RetryableSinkError `retryableTimes` times, then succeed
 */
export class FlakySink implements OpportunitySink {
  readonly name = "flaky";
  private attempts = new Map<string, number>();
  constructor(
    private readonly opts: {
      retryableTimes: number;
      terminalIds?: ReadonlySet<string>;
      terminalCompanies?: ReadonlySet<string>;
    },
  ) {}
  async upsert(deal: RoutedDeal): Promise<SinkReceipt[]> {
    if (
      this.opts.terminalIds?.has(deal.id) ||
      this.opts.terminalCompanies?.has(deal.company)
    ) {
      throw new TerminalSinkError(`rejected ${deal.company}: invalid account`);
    }
    const n = (this.attempts.get(deal.id) ?? 0) + 1;
    this.attempts.set(deal.id, n);
    if (n <= this.opts.retryableTimes) {
      throw new RetryableSinkError(`429 rate limited (attempt ${n})`);
    }
    return [
      {
        system: "flaky",
        externalId: deal.id,
        detail: `accepted ${deal.company} after ${n} attempt(s)`,
      },
    ];
  }
}
