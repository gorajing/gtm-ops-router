import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import type {
  LocalCommercialStateWriteResult,
  LocalOutcomeInput,
  LocalOutcomeWriteResult,
  RoutedDeal,
} from "./types.js";

type DemoStore = Pick<Store, "recordLocalCommercialState" | "recordLocalOutcome">;

export const DEMO_OUTCOME_COMMERCIAL_REASON_PREFIX = "demo outcome loop:";

type DemoOutcomeFixture = {
  company: string;
  dealId: string;
  description: string;
  closedWon: {
    sourceEventKey: string;
    occurredAt: string;
    reason: string;
  };
  outcomes: Array<Omit<LocalOutcomeInput, "dealId" | "sourceEventId"> & {
    sourceEventKey: string;
  }>;
};

export interface DemoOutcomeFixtureResult {
  fixturesResolved: number;
  commercialRecorded: number;
  commercialDuplicate: number;
  commercialClosedWonNoop: number;
  acceptedOutcomes: number;
  duplicateOutcomes: number;
  resolvedCompanies: string[];
  appliedCompanies: string[];
  appliedDescriptions: string[];
  missingCompanies: string[];
  errors: DemoOutcomeFixtureError[];
}

type DemoOutcomeFixtureErrorStatus =
  | LocalCommercialStateWriteResult["status"]
  | LocalOutcomeWriteResult["status"];

export interface DemoOutcomeFixtureError {
  company: string;
  step: "commercial_state" | "outcome";
  status: DemoOutcomeFixtureErrorStatus;
  sourceEventKey: string;
  currentCommercialState?: string | null;
  outcome?: LocalOutcomeInput["outcome"];
}

const DEMO_OUTCOME_FIXTURES: DemoOutcomeFixture[] = [
  {
    company: "Ryder Digital",
    // Stable id from the Ryder Digital row in data/inbound.seed.jsonl.
    // Guarded by the seed-id fixture test in test/pipeline.test.ts.
    dealId: "D-fb65c15017ef",
    description: "Ryder deploys, lands, expands by $35k",
    closedWon: {
      sourceEventKey: "closed_won",
      occurredAt: "2026-05-15T12:00:00.000Z",
      reason: `${DEMO_OUTCOME_COMMERCIAL_REASON_PREFIX} enterprise account closed won`,
    },
    outcomes: [
      {
        sourceEventKey: "deployment_started",
        outcome: "deployment_started",
        occurredAt: "2026-05-16T09:00:00.000Z",
        operator: "demo:DS",
        arrDeltaUsd: null,
        reasonCategory: "customer_ready",
      },
      {
        sourceEventKey: "deployed",
        outcome: "deployed",
        occurredAt: "2026-05-17T12:00:00.000Z",
        operator: "demo:FDE",
        arrDeltaUsd: null,
        reasonCategory: "technical_blocker_resolved",
      },
      {
        sourceEventKey: "landed",
        outcome: "landed",
        occurredAt: "2026-05-18T18:00:00.000Z",
        operator: "demo:DS",
        arrDeltaUsd: null,
        reasonCategory: "customer_ready",
      },
      {
        sourceEventKey: "expanded",
        outcome: "expanded",
        occurredAt: "2026-05-19T10:00:00.000Z",
        operator: "demo:AE",
        arrDeltaUsd: 35_000,
        reasonCategory: "scope_expanded",
      },
    ],
  },
  {
    company: "Cargo Loop",
    // Stable id from the Cargo Loop row in data/inbound.seed.jsonl.
    // Guarded by the seed-id fixture test in test/pipeline.test.ts.
    dealId: "D-cdea8ac45022",
    description: "Cargo churns before deploy as a warning fact",
    closedWon: {
      sourceEventKey: "closed_won",
      occurredAt: "2026-05-15T12:00:00.000Z",
      reason: `${DEMO_OUTCOME_COMMERCIAL_REASON_PREFIX} churn-risk account closed won`,
    },
    outcomes: [
      {
        sourceEventKey: "deployment_started",
        outcome: "deployment_started",
        occurredAt: "2026-05-16T08:00:00.000Z",
        operator: "demo:DS",
        arrDeltaUsd: null,
        reasonCategory: "customer_ready",
      },
      {
        sourceEventKey: "churned",
        outcome: "churned",
        occurredAt: "2026-05-16T20:00:00.000Z",
        operator: "demo:AE",
        arrDeltaUsd: null,
        reasonCategory: "budget_lost",
      },
    ],
  },
];

function uuidV4FromSeed(seed: string): string {
  // Deterministic by design: the fixture layer must be replayable and idempotent.
  const chars = createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "4";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function demoSourceEventId(dealId: string, key: string): string {
  // These ids isolate the demo overlay. Do not reuse this seed namespace for
  // other synthetic fixtures, or persistent demo-guard classification will blur.
  return uuidV4FromSeed(`demo-outcome:${dealId}:${key}`);
}

export function demoCommercialStateSourceEventIds(): string[] {
  return DEMO_OUTCOME_FIXTURES.map((fixture) =>
    demoSourceEventId(
      fixture.dealId,
      `commercial:${fixture.closedWon.sourceEventKey}`,
    ),
  );
}

export function demoOutcomeSourceEventIds(): string[] {
  return DEMO_OUTCOME_FIXTURES.flatMap((fixture) =>
    fixture.outcomes.map((outcome) =>
      demoSourceEventId(fixture.dealId, `outcome:${outcome.sourceEventKey}`),
    ),
  );
}

export function demoOutcomeFixtureDealIds(): string[] {
  return DEMO_OUTCOME_FIXTURES.map((fixture) => fixture.dealId);
}

function isAcceptableWhenAlreadyClosedWon(
  status: LocalCommercialStateWriteResult["status"],
): boolean {
  // These mean the deal is already closed_won by another local event. They are
  // only safe after the caller checks the current projection is closed_won.
  // Existing close timestamps can still move demo cycle-time medians earlier or
  // to n/a, so persistent runs refuse non-demo fixture-deal history.
  return (
    status === "stale" ||
    status === "same_state_tie" ||
    status === "same_state_newer"
  );
}

export function applyDemoOutcomeFixtures(
  store: DemoStore,
  routedDeals: readonly RoutedDeal[],
): DemoOutcomeFixtureResult {
  const byDealId = new Map<string, RoutedDeal>();
  for (const deal of routedDeals) {
    byDealId.set(deal.id, deal);
  }
  const resolvedCompanies: string[] = [];
  const appliedCompanies: string[] = [];
  const appliedDescriptions: string[] = [];
  const missingCompanies: string[] = [];
  const errors: DemoOutcomeFixtureError[] = [];
  let fixturesResolved = 0;
  let commercialRecorded = 0;
  let commercialDuplicate = 0;
  let commercialClosedWonNoop = 0;
  let acceptedOutcomes = 0;
  let duplicateOutcomes = 0;

  for (const fixture of DEMO_OUTCOME_FIXTURES) {
    // Each write is individually idempotent in Store. We intentionally avoid a
    // cross-write transaction here so the demo layer exercises the same durable
    // event claims as operator-entered commercial/outcome updates. If a fixture
    // only partly applies, replay is safe but does not undo the partial history.
    const deal = byDealId.get(fixture.dealId);
    if (!deal) {
      missingCompanies.push(fixture.company);
      continue;
    }
    fixturesResolved += 1;
    resolvedCompanies.push(fixture.company);
    const commercialResult = store.recordLocalCommercialState({
      dealId: deal.id,
      commercialState: "closed_won",
      sourceEventId: demoSourceEventId(
        deal.id,
        `commercial:${fixture.closedWon.sourceEventKey}`,
      ),
      occurredAt: fixture.closedWon.occurredAt,
      reason: fixture.closedWon.reason,
      expectedRedPath: false,
    });
    const currentIsClosedWon =
      commercialResult.current?.commercialState === "closed_won";
    if (!currentIsClosedWon) {
      errors.push({
        company: fixture.company,
        step: "commercial_state",
        status: commercialResult.status,
        sourceEventKey: fixture.closedWon.sourceEventKey,
        currentCommercialState:
          commercialResult.current?.commercialState ?? null,
      });
      continue;
    }
    if (commercialResult.status === "recorded") {
      commercialRecorded += 1;
    } else if (commercialResult.status === "duplicate") {
      commercialDuplicate += 1;
    } else if (isAcceptableWhenAlreadyClosedWon(commercialResult.status)) {
      commercialClosedWonNoop += 1;
    } else {
      errors.push({
        company: fixture.company,
        step: "commercial_state",
        status: commercialResult.status,
        sourceEventKey: fixture.closedWon.sourceEventKey,
        currentCommercialState:
          commercialResult.current?.commercialState ?? null,
      });
      continue;
    }
    let successfulOutcomeWrites = 0;
    for (const outcome of fixture.outcomes) {
      const { sourceEventKey, ...outcomeInput } = outcome;
      const outcomeResult = store.recordLocalOutcome({
        dealId: deal.id,
        sourceEventId: demoSourceEventId(
          deal.id,
          `outcome:${sourceEventKey}`,
        ),
        ...outcomeInput,
      });
      if (outcomeResult.status === "recorded") {
        acceptedOutcomes += 1;
        successfulOutcomeWrites += 1;
      } else if (outcomeResult.status === "duplicate") {
        duplicateOutcomes += 1;
        successfulOutcomeWrites += 1;
      } else {
        errors.push({
          company: fixture.company,
          step: "outcome",
          status: outcomeResult.status,
          sourceEventKey,
          outcome: outcomeInput.outcome,
        });
      }
    }
    if (successfulOutcomeWrites === fixture.outcomes.length) {
      appliedCompanies.push(fixture.company);
      appliedDescriptions.push(fixture.description);
    }
  }

  return {
    fixturesResolved,
    commercialRecorded,
    commercialDuplicate,
    commercialClosedWonNoop,
    acceptedOutcomes,
    duplicateOutcomes,
    resolvedCompanies,
    appliedCompanies,
    appliedDescriptions,
    missingCompanies,
    errors,
  };
}
