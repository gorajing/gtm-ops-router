import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FUTURE_SKEW_MS } from "../src/constants.js";
import type { Enricher } from "../src/enrich.js";
import {
  hubSpotV3Signature,
  integrationOptionsFromEnv,
} from "../src/integrations.js";
import { startServer } from "../src/server.js";
import type { OpportunitySink } from "../src/sink.js";
import { Store } from "../src/store.js";
import type { Deal, Enrichment, RoutedDeal } from "../src/types.js";

const LOCAL_ENDPOINT_SECRET = "0123456789abcdef0123456789abcdef";
const LOCAL_ENDPOINT_SECRET_HEADER = "x-local-endpoint-secret";
const ISOLATED_ENV_KEYS = [
  "ALLOW_EXPECTED_RED_PATHS",
  "ALLOW_LOCAL_WRITE_ENDPOINTS",
  "HUBSPOT_ACCESS_TOKEN",
  "HUBSPOT_PORTAL_ID",
  "HUBSPOT_WEBHOOK_SECRET",
  "LOCAL_ENDPOINT_SECRET",
  "PUBLIC_BASE_URL",
  "SLACK_BOT_TOKEN",
  "SLACK_CHANNEL_ID",
  "SLACK_DEPLOYMENT_CHANNEL_ID",
  "TRUST_PROXY",
] as const;

const enricher: Enricher = {
  name: "test",
  async enrich(_deal: Deal): Promise<Enrichment> {
    return {
      employees: 1200,
      industry: "logistics",
      techSignals: ["manual_ops", "enterprise"],
      regulated: true,
      confidence: 0.95,
    };
  },
};

const open: Array<{ close(): Promise<void>; store: Store }> = [];

async function withEnv<T>(
  env: Partial<Record<(typeof ISOLATED_ENV_KEYS)[number], string>>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const key of ISOLATED_ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of ISOLATED_ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function routedRecord(id: string): RoutedDeal {
  return {
    id,
    company: "Partial Resolve Co",
    domain: "example.com",
    contactName: "Rae Ops",
    contactEmail: "rae@example.com",
    dealUSD: 60000,
    region: "NA",
    sourceChannel: "inbound_form",
    statedNeed: "one webhook event should not block the rest",
    enrichment: {
      employees: 1200,
      industry: "logistics",
      techSignals: ["manual_ops", "enterprise"],
      regulated: true,
      confidence: 0.95,
    },
    score: {
      icpFit: 1,
      painSignal: 1,
      sizeFit: 1,
      regionFit: 1,
      total: 1,
      notes: [],
    },
    route: {
      kind: "human_assisted",
      salesOwner: "ae.morgan",
      financeFlag: "pricing_approval",
      legalFlag: "regulated_review",
      slaHours: 4,
    },
  };
}

async function app(
  options?: Parameters<typeof startServer>[3],
): Promise<{ baseUrl: string; close(): Promise<void>; store: Store }> {
  const store = new Store(":memory:");
  const server = startServer(store, enricher, 0, options);
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    store.close();
  };
  const running = { baseUrl, close, store };
  open.push(running);
  return running;
}

async function postRoutedDeal(baseUrl: string): Promise<string> {
  const post = await fetch(`${baseUrl}/deals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      company: "Local State Co",
      domain: "example.com",
      contactName: "Lena Ops",
      contactEmail: "lena@example.com",
      dealUSD: 90000,
      region: "NA",
      sourceChannel: "website_chat",
      statedNeed: "local commercial state endpoint needs a real routed deal",
    }),
  });
  const body = (await post.json()) as {
    outcomes: Array<{ ok: true; deal: { id: string } }>;
  };
  const dealId = body.outcomes[0]?.deal.id;
  if (!dealId) throw new Error("expected routed deal id");
  return dealId;
}

async function postClosedWon(
  baseUrl: string,
  dealId: string,
  sourceEventId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
): Promise<void> {
  const close = await fetch(`${baseUrl}/commercial-state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
    },
    body: JSON.stringify({
      dealId,
      commercialState: "closed_won",
      sourceEventId,
      occurredAt: "2026-05-21T12:00:00.000Z",
    }),
  });
  if (!close.ok) {
    throw new Error(`failed to close test deal: ${close.status}`);
  }
}

afterEach(async () => {
  while (open.length > 0) {
    const running = open.pop();
    if (running) await running.close();
  }
});

describe("local commercial-state endpoint", () => {
  it("is not registered unless local write endpoints are enabled", async () => {
    await withEnv({}, async () => {
      const { baseUrl } = await app();
      const commercial = await fetch(`${baseUrl}/commercial-state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const deployment = await fetch(`${baseUrl}/deployment-facts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const outcome = await fetch(`${baseUrl}/outcomes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const suggestion = await fetch(`${baseUrl}/agent-suggestions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const suggestionDecision = await fetch(
        `${baseUrl}/agent-suggestions/S-1/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const commercialBody = (await commercial.json()) as { error: string };
      const deploymentBody = (await deployment.json()) as { error: string };
      const outcomeBody = (await outcome.json()) as { error: string };
      const suggestionBody = (await suggestion.json()) as { error: string };
      const suggestionDecisionBody = (await suggestionDecision.json()) as {
        error: string;
      };

      expect(commercial.status).toBe(404);
      expect(deployment.status).toBe(404);
      expect(outcome.status).toBe(404);
      expect(suggestion.status).toBe(404);
      expect(suggestionDecision.status).toBe(404);
      expect(commercialBody.error).toBe("not found");
      expect(deploymentBody.error).toBe("not found");
      expect(outcomeBody.error).toBe("not found");
      expect(suggestionBody.error).toBe("not found");
      expect(suggestionDecisionBody.error).toBe("not found");
    });
  });

  it("fails boot when local write endpoints are missing a strong secret", async () => {
    await withEnv({ ALLOW_LOCAL_WRITE_ENDPOINTS: "1" }, () => {
      const store = new Store(":memory:");
      try {
        expect(() => startServer(store, enricher, 0)).toThrow(
          /LOCAL_ENDPOINT_SECRET/,
        );
      } finally {
        store.close();
      }
    });

    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: "too-short",
      },
      () => {
        const store = new Store(":memory:");
        try {
          expect(() => startServer(store, enricher, 0)).toThrow(
            /at least 32 characters/,
          );
        } finally {
          store.close();
        }
      },
    );
  });

  it("fails boot when local write endpoints are mixed with proxy or live intent", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
        TRUST_PROXY: "1",
      },
      () => {
        const store = new Store(":memory:");
        try {
          expect(() => startServer(store, enricher, 0)).toThrow(/TRUST_PROXY/);
        } finally {
          store.close();
        }
      },
    );

    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        HUBSPOT_ACCESS_TOKEN: "pat-live",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      () => {
        const store = new Store(":memory:");
        try {
          expect(() => startServer(store, enricher, 0)).toThrow(
            /live HubSpot\/Slack integration intent/,
          );
        } finally {
          store.close();
        }
      },
    );

    await withEnv(
      {
        ALLOW_EXPECTED_RED_PATHS: "1",
        HUBSPOT_ACCESS_TOKEN: "pat-live",
      },
      () => {
        const store = new Store(":memory:");
        try {
          expect(() => startServer(store, enricher, 0)).toThrow(
            /ALLOW_EXPECTED_RED_PATHS/,
          );
        } finally {
          store.close();
        }
      },
    );
  });

  it("requires the local endpoint secret before mutating state", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl } = await app();
        const res = await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const body = (await res.json()) as { error: string };

        expect(res.status).toBe(401);
        expect(body.error).toBe("invalid local endpoint secret");

        const deployment = await fetch(`${baseUrl}/deployment-facts`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const outcome = await fetch(`${baseUrl}/outcomes`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const suggestion = await fetch(`${baseUrl}/agent-suggestions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const recommendationRun = await fetch(
          `${baseUrl}/agent-suggestion-runs/policy-evaluation`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        expect(deployment.status).toBe(401);
        expect(outcome.status).toBe(401);
        expect(suggestion.status).toBe(401);
        expect(recommendationRun.status).toBe(401);
      },
    );
  });

  it("requires canonical UTC ISO timestamps on local write endpoints", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const dealId = await postRoutedDeal(baseUrl);
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };

        const commercial = await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            commercialState: "closed_won",
            sourceEventId: "11111111-1111-4111-8111-111111111119",
            occurredAt: "2026-05-21T12:00:00Z",
          }),
        });
        const deployment = await fetch(`${baseUrl}/deployment-facts`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            sourceEventId: "22222222-2222-4222-8222-222222222229",
            useCaseClear: true,
            integrationsKnown: true,
            dataReady: true,
            operator: "DS",
            occurredAt: "2026-05-21T14:00:00+02:00",
          }),
        });

        await postClosedWon(baseUrl, dealId);
        const outcome = await fetch(`${baseUrl}/outcomes`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            sourceEventId: "33333333-3333-4333-8333-333333333339",
            outcome: "deployment_started",
            occurredAt: "2026-05-21T12:00:00Z",
            operator: "DS",
          }),
        });
        const suggestion = await fetch(`${baseUrl}/agent-suggestions`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            sourceEventId: "44444444-4444-4444-8444-444444444449",
            kind: "handoff_summary",
            title: "Draft handoff",
            body: "Summarize the deal.",
            rationale: "AE needs context.",
            createdBy: "local-agent",
            occurredAt: "2026-05-21T12:00:00Z",
          }),
        });
        const recommendationRun = await fetch(
          `${baseUrl}/agent-suggestion-runs/policy-evaluation`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              createdBy: "policy-agent",
              evaluatedAt: "2026-05-21T12:00:00Z",
            }),
          },
        );

        expect(commercial.status).toBe(400);
        expect(deployment.status).toBe(400);
        expect(outcome.status).toBe(400);
        expect(suggestion.status).toBe(400);
        expect(recommendationRun.status).toBe(400);
        expect(store.deploymentFacts(dealId)).toBeNull();
        expect(store.outcomeEvents(dealId)).toHaveLength(0);
        expect(store.agentSuggestions()).toHaveLength(0);
      },
    );
  });

  it("rejects invalid policy recommendation run limits before writing", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const res = await fetch(
          `${baseUrl}/agent-suggestion-runs/policy-evaluation`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
            },
            body: JSON.stringify({
              createdBy: "policy-agent",
              evaluatedAt: "2026-05-23T13:00:00.000Z",
              limit: 0,
            }),
          },
        );
        const body = (await res.json()) as { error: string };

        expect(res.status).toBe(400);
        expect(body.error).toBe("invalid policy recommendation run request");
        expect(store.policyRecommendationRuns()).toHaveLength(0);
      },
    );
  });

  it("records a routed deal commercial state and makes replay idempotent", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const dealId = await postRoutedDeal(baseUrl);
        const body = {
          dealId,
          commercialState: "closed_won",
          sourceEventId: "11111111-1111-4111-8111-111111111111",
          reason: "operator closed the loop after HubSpot demo",
          occurredAt: "2026-05-21T12:00:00.000Z",
        };

        const first = await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify(body),
        });
        const firstBody = (await first.json()) as { status: string; projected: boolean };
        const second = await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify(body),
        });
        const secondBody = (await second.json()) as {
          status: string;
          projected: boolean;
        };
        const conflict = await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify({ ...body, reason: "mutated replay" }),
        });
        const conflictBody = (await conflict.json()) as { status: string };

        expect(first.status).toBe(200);
        expect(firstBody).toEqual(
          expect.objectContaining({ status: "recorded", projected: true }),
        );
        expect(second.status).toBe(200);
        expect(secondBody).toEqual(
          expect.objectContaining({ status: "duplicate", projected: false }),
        );
        expect(conflict.status).toBe(409);
        expect(conflictBody.status).toBe("idempotency_conflict");
        expect(store.commercialState(dealId)?.commercialState).toBe("closed_won");
        expect(store.commercialState(dealId)?.sourceEventId).toBe(
          body.sourceEventId,
        );
      },
    );
  });

  it("rejects invalid UUIDv4 source ids before claiming them", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const dealId = await postRoutedDeal(baseUrl);
        const bad = await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify({
            dealId,
            commercialState: "closed_won",
            sourceEventId: "not-a-v4-uuid",
            occurredAt: "2026-05-21T12:00:00.000Z",
          }),
        });

        expect(bad.status).toBe(400);
        expect(store.commercialState(dealId)).toBeNull();
      },
    );
  });

  it("rejects future-skewed local state without claiming the source event", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const dealId = await postRoutedDeal(baseUrl);
        const sourceEventId = "22222222-2222-4222-8222-222222222222";
        const postState = (occurredAt: string) =>
          fetch(`${baseUrl}/commercial-state`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
            },
            body: JSON.stringify({
              dealId,
              commercialState: "closed_won",
              sourceEventId,
              occurredAt,
            }),
          });

        const future = await postState(
          new Date(Date.now() + MAX_FUTURE_SKEW_MS + 60_000).toISOString(),
        );
        const retry = await postState(new Date().toISOString());
        const retryBody = (await retry.json()) as { status: string };

        expect(future.status).toBe(422);
        expect(retry.status).toBe(200);
        expect(retryBody.status).toBe("recorded");
        expect(store.commercialState(dealId)?.commercialState).toBe("closed_won");
      },
    );
  });

  it("does not claim source ids for unknown deals", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl } = await app();
        const sourceEventId = "33333333-3333-4333-8333-333333333333";
        const unknown = await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify({
            dealId: "D-missing",
            commercialState: "closed_won",
            sourceEventId,
            occurredAt: "2026-05-21T12:00:00.000Z",
          }),
        });
        const dealId = await postRoutedDeal(baseUrl);
        const retry = await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify({
            dealId,
            commercialState: "closed_won",
            sourceEventId,
            occurredAt: "2026-05-21T12:00:00.000Z",
          }),
        });
        const retryBody = (await retry.json()) as { status: string };

        expect(unknown.status).toBe(404);
        expect(retry.status).toBe(200);
        expect(retryBody.status).toBe("recorded");
      },
    );
  });

  it("gates expected red-path waivers to local demo mode", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl } = await app();
        const dealId = await postRoutedDeal(baseUrl);
        const denied = await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify({
            dealId,
            commercialState: "closed_won",
            sourceEventId: "44444444-4444-4444-8444-444444444444",
            expectedRedPath: true,
            occurredAt: "2026-05-21T12:00:00.000Z",
          }),
        });

        expect(denied.status).toBe(403);
      },
    );

    await withEnv(
      {
        ALLOW_EXPECTED_RED_PATHS: "1",
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const terminalDriftCalls: unknown[] = [];
        const { baseUrl } = await app({
          terminalDriftNotifications: {
            eventMode: "dry_run",
            async notify(claim: unknown) {
              terminalDriftCalls.push(claim);
              return [
                {
                  system: "slack",
                  externalId: "CGENERIC",
                  detail: "posted commercial_terminal_drift alert",
                },
              ];
            },
          },
        } as never);
        const dealId = await postRoutedDeal(baseUrl);
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };
        await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            commercialState: "closed_won",
            sourceEventId: "55555555-5555-4555-8555-555555555555",
            occurredAt: "2026-05-21T12:00:00.000Z",
          }),
        });
        const drift = await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            commercialState: "closed_lost",
            sourceEventId: "66666666-6666-4666-8666-666666666666",
            expectedRedPath: true,
            occurredAt: "2026-05-21T12:01:00.000Z",
          }),
        });
        const driftBody = (await drift.json()) as {
          status: string;
          terminalDriftAlertResult?: {
            status: string;
            receipts: number;
            alertKey: string;
          };
        };
        const events = (await fetch(
          `${baseUrl}/deals/${encodeURIComponent(dealId)}/events`,
        ).then((r) => r.json())) as {
          events: Array<{ detail: string; meta?: { expectedRedPath?: boolean } }>;
        };

        expect(drift.status).toBe(200);
        expect(driftBody.status).toBe("terminal_drift");
        expect(driftBody.terminalDriftAlertResult).toEqual(
          expect.objectContaining({
            status: "ok",
            receipts: 1,
            alertKey:
              "commercial_terminal_drift:local:66666666-6666-4666-8666-666666666666",
          }),
        );
        expect(terminalDriftCalls).toEqual([
          expect.objectContaining({
            dealId,
            alertKey:
              "commercial_terminal_drift:local:66666666-6666-4666-8666-666666666666",
            source: "local",
            sourceEventId: "66666666-6666-4666-8666-666666666666",
            incomingCommercialState: "closed_lost",
            currentCommercialState: "closed_won",
            driftKind: "terminal_regression",
            expectedRedPath: true,
          }),
        ]);
        expect(events.events).toContainEqual(
          expect.objectContaining({
            detail: "commercial_terminal_drift",
            meta: expect.objectContaining({ expectedRedPath: true }),
          }),
        );
        expect(events.events).toContainEqual(
          expect.objectContaining({
            detail: "commercial terminal drift alert",
            meta: expect.objectContaining({
              kind: "commercial_terminal_drift",
              alertKey:
                "commercial_terminal_drift:local:66666666-6666-4666-8666-666666666666",
            }),
          }),
        );
      },
    );
  });

  it("records deployment facts and makes replay idempotent", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const dealId = await postRoutedDeal(baseUrl);
        const body = {
          dealId,
          sourceEventId: "77777777-7777-4777-8777-777777777777",
          useCaseClear: true,
          integrationsKnown: true,
          dataReady: true,
          operator: "  DS  ",
          occurredAt: "2026-05-21T12:00:00.000Z",
        };

        const first = await fetch(`${baseUrl}/deployment-facts`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify(body),
        });
        const firstBody = (await first.json()) as {
          status: string;
          accepted: boolean;
        };
        const second = await fetch(`${baseUrl}/deployment-facts`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify(body),
        });
        const secondBody = (await second.json()) as { status: string };
        const conflict = await fetch(`${baseUrl}/deployment-facts`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify({ ...body, dataReady: false }),
        });
        const conflictBody = (await conflict.json()) as { status: string };
        const events = (await fetch(
          `${baseUrl}/deals/${encodeURIComponent(dealId)}/events`,
        ).then((r) => r.json())) as {
          events: Array<{
            detail: string;
            meta?: { kind?: string; operator?: string; operatorSource?: string };
          }>;
        };

        expect(first.status).toBe(200);
        expect(firstBody).toEqual(
          expect.objectContaining({ status: "recorded", accepted: true }),
        );
        expect(second.status).toBe(200);
        expect(secondBody.status).toBe("duplicate");
        expect(conflict.status).toBe(409);
        expect(conflictBody.status).toBe("idempotency_conflict");
        expect(store.deploymentFacts(dealId)).toEqual(
          expect.objectContaining({
            sourceEventId: body.sourceEventId,
            operator: "DS",
            operatorSource: "self_reported",
            useCaseClear: true,
            integrationsKnown: true,
            dataReady: true,
          }),
        );
        expect(events.events).toContainEqual(
          expect.objectContaining({
            detail: "deployment facts recorded",
            meta: expect.objectContaining({
              kind: "deployment_facts",
              operator: "DS",
              operatorSource: "self_reported",
            }),
          }),
        );
      },
    );
  });

  it("rejects incomplete deployment facts before writing", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const dealId = await postRoutedDeal(baseUrl);
        const missingBoolean = await fetch(`${baseUrl}/deployment-facts`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify({
            dealId,
            sourceEventId: "88888888-8888-4888-8888-888888888888",
            useCaseClear: true,
            integrationsKnown: true,
            operator: "DS",
            occurredAt: "2026-05-21T12:00:00.000Z",
          }),
        });
        const emptyOperator = await fetch(`${baseUrl}/deployment-facts`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify({
            dealId,
            sourceEventId: "99999999-9999-4999-8999-999999999999",
            useCaseClear: true,
            integrationsKnown: true,
            dataReady: true,
            operator: "   ",
            occurredAt: "2026-05-21T12:00:00.000Z",
          }),
        });

        expect(missingBoolean.status).toBe(400);
        expect(emptyOperator.status).toBe(400);
        expect(store.deploymentFacts(dealId)).toBeNull();
      },
    );
  });

  it("does not claim deployment fact source ids for unknown deals", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const sourceEventId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };
        const unknown = await fetch(`${baseUrl}/deployment-facts`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId: "D-missing",
            sourceEventId,
            useCaseClear: true,
            integrationsKnown: true,
            dataReady: true,
            operator: "DS",
            occurredAt: "2026-05-21T12:00:00.000Z",
          }),
        });
        const dealId = await postRoutedDeal(baseUrl);
        const retry = await fetch(`${baseUrl}/deployment-facts`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            sourceEventId,
            useCaseClear: true,
            integrationsKnown: true,
            dataReady: true,
            operator: "DS",
            occurredAt: "2026-05-21T12:00:00.000Z",
          }),
        });
        const retryBody = (await retry.json()) as { status: string };

        expect(unknown.status).toBe(404);
        expect(retry.status).toBe(200);
        expect(retryBody.status).toBe("recorded");
        expect(store.deploymentFacts(dealId)?.sourceEventId).toBe(sourceEventId);
      },
    );
  });

  it("rejects future-skewed deployment facts without claiming the source event", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const dealId = await postRoutedDeal(baseUrl);
        const sourceEventId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };
        const postFacts = (occurredAt: string) =>
          fetch(`${baseUrl}/deployment-facts`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              dealId,
              sourceEventId,
              useCaseClear: true,
              integrationsKnown: true,
              dataReady: true,
              operator: "DS",
              occurredAt,
            }),
          });

        const future = await postFacts(
          new Date(Date.now() + MAX_FUTURE_SKEW_MS + 60_000).toISOString(),
        );
        const retry = await postFacts(new Date().toISOString());
        const retryBody = (await retry.json()) as { status: string };

        expect(future.status).toBe(422);
        expect(retry.status).toBe(200);
        expect(retryBody.status).toBe("recorded");
        expect(store.deploymentFacts(dealId)?.sourceEventId).toBe(sourceEventId);
      },
    );
  });

  it("records post-sale outcomes and makes replays idempotent", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const dealId = await postRoutedDeal(baseUrl);
        await postClosedWon(baseUrl, dealId);
        const body = {
          dealId,
          sourceEventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          outcome: "deployment_started",
          occurredAt: new Date().toISOString(),
          operator: "  DS  ",
          reasonCategory: "customer_ready",
        };
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };

        const first = await fetch(`${baseUrl}/outcomes`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const firstBody = (await first.json()) as {
          status: string;
          accepted: boolean;
          event: { operator: string; outcome: string; reasonCategory: string };
        };
        const second = await fetch(`${baseUrl}/outcomes`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const secondBody = (await second.json()) as { status: string };
        const conflict = await fetch(`${baseUrl}/outcomes`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, reasonCategory: "other" }),
        });
        const conflictBody = (await conflict.json()) as { status: string };

        expect(first.status).toBe(200);
        expect(firstBody).toEqual(
          expect.objectContaining({
            status: "recorded",
            accepted: true,
            event: expect.objectContaining({
              operator: "DS",
              outcome: "deployment_started",
              reasonCategory: "customer_ready",
            }),
          }),
        );
        expect(second.status).toBe(200);
        expect(secondBody.status).toBe("duplicate");
        expect(conflict.status).toBe(409);
        expect(conflictBody.status).toBe("idempotency_conflict");
        expect(store.outcomeEvents(dealId)).toHaveLength(1);
        expect(store.events(dealId).at(-1)).toEqual(
          expect.objectContaining({
            detail: "post_sale_outcome",
            meta: expect.objectContaining({
              kind: "post_sale_outcome",
              sourceEventId: body.sourceEventId,
              operator: "DS",
              arrDeltaUsd: null,
            }),
          }),
        );
      },
    );
  });

  it("rejects invalid outcome requests before claiming source ids", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const dealId = await postRoutedDeal(baseUrl);
        await postClosedWon(baseUrl, dealId);
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };

        const externalOnly = await fetch(`${baseUrl}/outcomes`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId: "",
            hubspotDealId: "991",
            sourceEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            outcome: "deployment_started",
            occurredAt: "2026-05-21T12:00:00.000Z",
            operator: "DS",
          }),
        });
        const externalOnlyBody = (await externalOnly.json()) as { error: string };
        const badUuid = await fetch(`${baseUrl}/outcomes`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            sourceEventId: "not-a-v4-uuid",
            outcome: "deployment_started",
            occurredAt: "2026-05-21T12:00:00.000Z",
            operator: "DS",
          }),
        });
        const futureSourceEventId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeef";
        const future = await fetch(`${baseUrl}/outcomes`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            sourceEventId: futureSourceEventId,
            outcome: "deployment_started",
            occurredAt: new Date(
              Date.now() + MAX_FUTURE_SKEW_MS + 60_000,
            ).toISOString(),
            operator: "DS",
          }),
        });
        const retry = await fetch(`${baseUrl}/outcomes`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            sourceEventId: futureSourceEventId,
            outcome: "deployment_started",
            occurredAt: new Date().toISOString(),
            operator: "DS",
          }),
        });
        const retryBody = (await retry.json()) as { status: string };

        expect(externalOnly.status).toBe(400);
        expect(externalOnlyBody.error).toBe("router dealId required");
        expect(badUuid.status).toBe(400);
        expect(future.status).toBe(422);
        expect(retry.status).toBe(200);
        expect(retryBody.status).toBe("recorded");
        expect(store.outcomeEvents(dealId)).toHaveLength(1);
      },
    );
  });

  it("records agent suggestions and human decisions in state", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const dealId = await postRoutedDeal(baseUrl);
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };
        const proposalBody = {
          dealId,
          sourceEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1",
          kind: "handoff_summary",
          title: "  Draft AE handoff  ",
          body: "Highlight scheduling automation pain and legal review flag.",
          rationale: "High-value human-assisted deal needs a tight handoff.",
          createdBy: "local-agent",
          occurredAt: "2026-05-22T13:00:00.000Z",
        };

        const proposed = await fetch(`${baseUrl}/agent-suggestions`, {
          method: "POST",
          headers,
          body: JSON.stringify(proposalBody),
        });
        const proposedBody = (await proposed.json()) as {
          status: string;
          suggestion: { id: string; status: string; title: string };
        };
        const duplicate = await fetch(`${baseUrl}/agent-suggestions`, {
          method: "POST",
          headers,
          body: JSON.stringify(proposalBody),
        });
        const conflict = await fetch(`${baseUrl}/agent-suggestions`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...proposalBody, rationale: "mutated replay" }),
        });
        const missingDecision = await fetch(
          `${baseUrl}/agent-suggestions/S-missing/decision`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              sourceEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee0",
              decision: "accepted",
              humanPrincipal: "ops@example.com",
              reason: "No such suggestion.",
            }),
          },
        );
        const decision = await fetch(
          `${baseUrl}/agent-suggestions/${encodeURIComponent(
            proposedBody.suggestion.id,
          )}/decision`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              sourceEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2",
              decision: "accepted",
              humanPrincipal: "ops@example.com",
              reason: "Good enough for the account owner.",
            }),
          },
        );
        const decisionBody = (await decision.json()) as {
          status: string;
          suggestion: {
            status: string;
            decidedAt: string;
            decidedBy: string;
            decisionReason: string;
          };
        };
        const laterDecision = await fetch(
          `${baseUrl}/agent-suggestions/${encodeURIComponent(
            proposedBody.suggestion.id,
          )}/decision`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              sourceEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3",
              decision: "rejected",
              humanPrincipal: "ops@example.com",
              reason: "Second decision should not overwrite the first.",
            }),
          },
        );
        const state = (await fetch(`${baseUrl}/state`).then((r) =>
          r.json(),
        )) as {
          agentSuggestions: Array<{
            id: string;
            dealId: string;
            status: string;
            title: string;
            decidedBy: string | null;
          }>;
        };

        expect(proposed.status).toBe(200);
        expect(proposedBody).toEqual(
          expect.objectContaining({
            status: "recorded",
            suggestion: expect.objectContaining({
              status: "proposed",
              title: "Draft AE handoff",
            }),
          }),
        );
        expect(duplicate.status).toBe(200);
        expect(((await duplicate.json()) as { status: string }).status).toBe(
          "duplicate",
        );
        expect(conflict.status).toBe(409);
        expect(missingDecision.status).toBe(404);
        expect(
          ((await missingDecision.json()) as { status: string }).status,
        ).toBe("not_found");
        expect(decision.status).toBe(200);
        expect(decisionBody).toEqual(
          expect.objectContaining({
            status: "recorded",
            suggestion: expect.objectContaining({
              status: "accepted",
              decidedAt: expect.stringMatching(
                /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
              ),
              decidedBy: "ops@example.com",
              decisionReason: "Good enough for the account owner.",
            }),
          }),
        );
        expect(laterDecision.status).toBe(409);
        expect(((await laterDecision.json()) as { status: string }).status).toBe(
          "already_decided",
        );
        expect(state.agentSuggestions).toEqual([
          expect.objectContaining({
            id: proposedBody.suggestion.id,
            dealId,
            status: "accepted",
            title: "Draft AE handoff",
            decidedBy: "ops@example.com",
          }),
        ]);
        expect(store.agentSuggestions()).toHaveLength(1);
        expect(store.events(dealId).map((event) => event.detail)).toEqual(
          expect.arrayContaining([
            "agent_suggestion_proposed",
            "agent_suggestion_decided",
          ]),
        );
      },
    );
  });

  it("generates policy recommendation suggestions from evaluation signals", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };
        const noSignals = await fetch(
          `${baseUrl}/agent-suggestion-runs/policy-evaluation`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              createdBy: "policy-agent",
              limit: 5,
            }),
          },
        );
        const noSignalsBody = (await noSignals.json()) as {
          status: string;
          attempted: number;
        };
        const dealId = await postRoutedDeal(baseUrl);
        await postClosedWon(
          baseUrl,
          dealId,
          "cccccccc-cccc-4ccc-8ccc-ccccccccccd1",
        );

        const first = await fetch(
          `${baseUrl}/agent-suggestion-runs/policy-evaluation`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              createdBy: "policy-agent",
              evaluatedAt: "2026-05-23T13:00:00.000Z",
              limit: 5,
            }),
          },
        );
        const firstBody = (await first.json()) as {
          status: string;
          attempted: number;
          recorded: number;
          duplicate: number;
          results: Array<{ signal: string; sourceEventId: string }>;
        };
        const replay = await fetch(
          `${baseUrl}/agent-suggestion-runs/policy-evaluation`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              createdBy: "policy-agent",
              evaluatedAt: "2026-05-23T13:00:00.000Z",
              limit: 5,
            }),
          },
        );
        const replayBody = (await replay.json()) as {
          status: string;
          attempted: number;
          recorded: number;
          duplicate: number;
        };
        const state = (await fetch(`${baseUrl}/state`).then((r) =>
          r.json(),
        )) as {
          agentSuggestions: Array<{
            dealId: string;
            kind: string;
            status: string;
            title: string;
          }>;
          policyRecommendationRuns: Array<{
            status: string;
            attempted: number;
            recorded: number;
            duplicate: number;
            createdBy: string;
            limit: number;
            results: Array<{ signal: string; status: string }>;
          }>;
        };

        expect(noSignals.status).toBe(200);
        expect(noSignalsBody).toEqual(
          expect.objectContaining({
            status: "no_signals",
            attempted: 0,
          }),
        );
        expect(first.status).toBe(200);
        expect(firstBody).toEqual(
          expect.objectContaining({
            status: "recorded",
            attempted: 1,
            recorded: 1,
            duplicate: 0,
          }),
        );
        expect(firstBody.results[0]).toEqual(
          expect.objectContaining({
            signal: "human_assisted_stalled",
            sourceEventId: expect.stringMatching(
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            ),
          }),
        );
        expect(replay.status).toBe(200);
        expect(replayBody).toEqual(
          expect.objectContaining({
            status: "duplicate",
            attempted: 1,
            recorded: 0,
            duplicate: 1,
          }),
        );
        expect(state.agentSuggestions).toEqual([
          expect.objectContaining({
            dealId,
            kind: "policy_change_recommendation",
            status: "proposed",
            title: expect.stringContaining("Unblock stalled deployment"),
          }),
        ]);
        expect(state.policyRecommendationRuns).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: "no_signals",
              attempted: 0,
              recorded: 0,
              createdBy: "policy-agent",
              limit: 5,
              results: [],
            }),
            expect.objectContaining({
              status: "recorded",
              attempted: 1,
              recorded: 1,
              duplicate: 0,
              results: [
                expect.objectContaining({
                  signal: "human_assisted_stalled",
                  status: "recorded",
                }),
              ],
            }),
            expect.objectContaining({
              status: "duplicate",
              attempted: 1,
              recorded: 0,
              duplicate: 1,
            }),
          ]),
        );
        expect(store.agentSuggestions()).toHaveLength(1);
      },
    );
  });

  it("keeps outcome preconditions and semantic rejections distinct", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl, store } = await app();
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };
        const notClosedDealId = await postRoutedDeal(baseUrl);
        const sourceEventId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        const postOutcome = (dealId: string, extra: Record<string, unknown> = {}) =>
          fetch(`${baseUrl}/outcomes`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              dealId,
              sourceEventId,
              outcome: "deployment_started",
              occurredAt: new Date().toISOString(),
              operator: "DS",
              ...extra,
            }),
          });

        const notClosedWon = await postOutcome(notClosedDealId);
        await postClosedWon(baseUrl, notClosedDealId);
        const retry = await postOutcome(notClosedDealId);
        const retryBody = (await retry.json()) as { status: string };
        const unknown = await postOutcome("D-missing", {
          sourceEventId: "ffffffff-ffff-4fff-8fff-fffffffffff0",
        });
        const invalidArr = await postOutcome(notClosedDealId, {
          sourceEventId: "ffffffff-ffff-4fff-8fff-fffffffffff1",
          arrDeltaUsd: 10_000,
        });
        const invalidArrBody = (await invalidArr.json()) as { status: string };
        const missingPrior = await postOutcome(notClosedDealId, {
          sourceEventId: "ffffffff-ffff-4fff-8fff-fffffffffff2",
          outcome: "landed",
        });
        const missingPriorBody = (await missingPrior.json()) as { status: string };

        expect(notClosedWon.status).toBe(409);
        expect(retry.status).toBe(200);
        expect(retryBody.status).toBe("recorded");
        expect(unknown.status).toBe(404);
        expect(invalidArr.status).toBe(422);
        expect(invalidArrBody.status).toBe("invalid_arr_delta");
        expect(missingPrior.status).toBe(409);
        expect(missingPriorBody.status).toBe("missing_prior_outcome");
        expect(store.outcomeRejections(notClosedDealId)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ rejectionKind: "invalid_arr_delta" }),
            expect.objectContaining({ rejectionKind: "missing_prior_outcome" }),
          ]),
        );
      },
    );
  });
});

describe("server dashboard", () => {
  it("serves favicon without console-noise 404s", async () => {
    const { baseUrl } = await app();
    const res = await fetch(`${baseUrl}/favicon.ico`);
    expect(res.status).toBe(204);
  });

  it("does not run HubSpot or Slack doctor checks for the default logging sink", async () => {
    const { baseUrl } = await app();
    const checks = (await fetch(`${baseUrl}/integration-health`).then((r) =>
      r.json(),
    )) as Array<{ system: string; status: string; detail: string }>;
    expect(checks).toEqual([
      expect.objectContaining({
        system: "env",
        status: "warn",
        detail: expect.stringContaining("logging sink"),
      }),
    ]);
  });

  it("does not run live doctor checks for dry-run integrations", async () => {
    const { baseUrl } = await app({ sinkLabel: "hubspot+slack:dry-run" });
    const checks = (await fetch(`${baseUrl}/integration-health`).then((r) =>
      r.json(),
    )) as Array<{ system: string; status: string; detail: string }>;
    expect(checks).toEqual([
      expect.objectContaining({
        system: "env",
        status: "warn",
        detail: expect.stringContaining("hubspot+slack:dry-run sink"),
      }),
    ]);
  });

  it("returns 400 for malformed event deal ids", async () => {
    const { baseUrl } = await app();
    const res = await fetch(`${baseUrl}/deals/%ZZ/events`);
    expect(res.status).toBe(400);
  });

  it("rejects simple non-JSON POSTs before parsing the body", async () => {
    const { baseUrl } = await app();
    const res = await fetch(`${baseUrl}/deals`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "company=csrf",
    });
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(415);
    expect(body.error).toBe("content-type must be application/json");
  });

  it("surfaces partial sync when a downstream notification receipt warns", async () => {
    const sink: OpportunitySink = {
      name: "partial-test",
      async upsert(deal) {
        return [
          { system: "hubspot", externalId: deal.id, detail: "upserted deal" },
          {
            system: "slack",
            externalId: "C123",
            detail: "notification failed: missing_scope",
            status: "warning",
          },
        ];
      },
    };
    const { baseUrl } = await app({
      pipelineOptions: {
        dryRun: false,
        sink,
        retry: { maxAttempts: 1, baseDelayMs: 0, sleep: async () => {} },
      },
      sinkLabel: "partial-test",
    });
    const post = await fetch(`${baseUrl}/deals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company: "Partial Sync Co",
        domain: "example.com",
        contactName: "Pat Ops",
        contactEmail: "pat@example.com",
        dealUSD: 90000,
        region: "NA",
        sourceChannel: "inbound_form",
        statedNeed: "manual finance handoff is slow",
      }),
    });
    expect(post.status).toBe(200);

    const state = (await fetch(`${baseUrl}/state`).then((r) =>
      r.json(),
    )) as { queue: Array<{ status: string }> };
    expect(state.queue[0]?.status).toBe("partial");
  });

  it("exposes deployment readiness rows and counters in state and metrics", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl } = await app();
        const dealId = await postRoutedDeal(baseUrl);
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };
        await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            commercialState: "closed_won",
            sourceEventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            occurredAt: "2026-05-21T12:00:00.000Z",
          }),
        });

        const pendingState = (await fetch(`${baseUrl}/state`).then((r) =>
          r.json(),
        )) as {
          deploymentReadiness: Array<{
            dealId: string;
            readiness: string;
            factsStatus: string;
            factsFresh: boolean | null;
            factsStaleAt: string | null;
          }>;
          metrics: {
            deploymentReadiness: Record<string, number>;
          };
          roleQueues: {
            ae_attention: Array<{ dealId: string }>;
            deployment_readiness: Array<{
              dealId: string;
              status: string;
              reason: string;
            }>;
            growth_attribution: Array<{ dealId: string; sourceChannel: string }>;
          };
          policyEvaluation: {
            humanAssistedRisk: Array<{
              dealId: string;
              signal: string;
              reason: string;
            }>;
            sourceChannels: Array<{
              sourceChannel: string;
              routed: number;
              closedWon: number;
            }>;
          };
        };
        expect(pendingState.deploymentReadiness).toEqual([
          expect.objectContaining({
            dealId,
            readiness: "pending",
            factsStatus: "missing",
            factsFresh: false,
            factsStaleAt: null,
          }),
        ]);
        expect(pendingState.metrics.deploymentReadiness.pending).toBe(1);
        expect(pendingState.roleQueues.ae_attention).toEqual([]);
        expect(pendingState.roleQueues.deployment_readiness).toEqual([
          expect.objectContaining({
            dealId,
            status: "pending",
            reason: "awaiting deployment facts",
          }),
        ]);
        expect(pendingState.roleQueues.growth_attribution).toEqual([
          expect.objectContaining({
            dealId,
            sourceChannel: "website_chat",
          }),
        ]);
        expect(pendingState.policyEvaluation.humanAssistedRisk).toEqual([
          expect.objectContaining({
            dealId,
            signal: "human_assisted_stalled",
            reason: "awaiting deployment facts",
          }),
        ]);
        expect(
          pendingState.policyEvaluation.sourceChannels.find(
            (summary) => summary.sourceChannel === "website_chat",
          ),
        ).toEqual(
          expect.objectContaining({
            routed: 1,
            closedWon: 1,
          }),
        );

        await fetch(`${baseUrl}/deployment-facts`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            sourceEventId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
            useCaseClear: true,
            integrationsKnown: true,
            dataReady: false,
            operator: "DS",
            occurredAt: new Date().toISOString(),
          }),
        });
        const blockedState = (await fetch(`${baseUrl}/state`).then((r) =>
          r.json(),
        )) as {
          deploymentReadiness: Array<{
            dealId: string;
            readiness: string;
            blockerCode: string | null;
            secondaryBlockerCodes: string[] | null;
            factsStatus: string;
            factsFresh: boolean | null;
            factsStaleAt: string | null;
          }>;
          metrics: {
            deploymentReadiness: Record<string, number>;
            readinessFactsStaleProjected: number;
          };
        };
        const metrics = (await fetch(`${baseUrl}/metrics`).then((r) =>
          r.json(),
        )) as {
          deploymentReadiness: Record<string, number>;
          readinessFactsStaleProjected: number;
        };

        expect(blockedState.deploymentReadiness).toEqual([
          expect.objectContaining({
            dealId,
            readiness: "blocked",
            blockerCode: "deployment_data_unavailable",
            secondaryBlockerCodes: null,
            factsStatus: "fresh",
            factsFresh: true,
            factsStaleAt: expect.any(String),
          }),
        ]);
        expect(blockedState.metrics.deploymentReadiness.blocked).toBe(1);
        expect(blockedState.metrics.readinessFactsStaleProjected).toBe(0);
        expect(metrics.deploymentReadiness.blocked).toBe(1);
        expect(metrics.readinessFactsStaleProjected).toBe(0);
      },
    );
  });

  it("posts a redacted readiness notification when local lifecycle reaches deployment handoff", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const notifications: unknown[] = [];
        const { baseUrl } = await app({
          readinessNotifications: {
            eventMode: "dry_run",
            async notify(claim: unknown) {
              notifications.push(claim);
              return [
                {
                  system: "slack",
                  externalId: "CDEPLOY",
                  detail: "would post redacted deployment readiness handoff",
                },
              ];
            },
          },
        } as never);
        const dealId = await postRoutedDeal(baseUrl);
        const commercial = await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify({
            dealId,
            commercialState: "closed_won",
            sourceEventId: "cececece-cece-4ece-8ece-cececececece",
            occurredAt: new Date().toISOString(),
          }),
        });
        const commercialBody = (await commercial.json()) as {
          readinessNotificationResult?: { status: string; receipts: number };
        };

        expect(commercial.status).toBe(200);
        expect(commercialBody.readinessNotificationResult).toEqual(expect.objectContaining({
          status: "ok",
          receipts: 1,
        }));
        expect(notifications).toEqual([
          expect.objectContaining({
            dealId,
            fingerprint: `readiness:${dealId}:none:pending`,
            readiness: "pending",
          }),
        ]);

        const state = (await fetch(`${baseUrl}/state`).then((r) =>
          r.json(),
        )) as {
          deploymentReadiness: Array<{ notifyStatus: string | null }>;
        };
        expect(state.deploymentReadiness[0]?.notifyStatus).toBe("ok");

        const eventBody = (await fetch(
          `${baseUrl}/deals/${encodeURIComponent(dealId)}/events`,
        ).then((r) => r.json())) as {
          events: Array<{ detail: string; meta?: unknown }>;
        };
        const event = eventBody.events.find(
          (entry) => entry.detail === "deployment readiness notification",
        );
        expect(event?.meta).toEqual(
          expect.objectContaining({
            kind: "deployment_readiness_notification",
            fingerprint: `readiness:${dealId}:none:pending`,
          }),
        );
        const metaJson = JSON.stringify(event?.meta);
        expect(metaJson).not.toContain("Local State Co");
        expect(metaJson).not.toContain("lena@example.com");
        expect(metaJson).not.toContain("local commercial state endpoint");
      },
    );
  });

  it("retries failed readiness notifications through the local retry endpoint", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        let calls = 0;
        const { baseUrl } = await app({
          readinessNotifications: {
            eventMode: "dry_run",
            async notify() {
              calls += 1;
              return calls === 1
                ? [
                    {
                      system: "slack",
                      externalId: "CDEPLOY",
                      detail: "deployment readiness notification failed: rate_limited",
                      status: "warning",
                    },
                  ]
                : [
                    {
                      system: "slack",
                      externalId: "CDEPLOY",
                      detail: "posted redacted deployment readiness handoff",
                    },
                  ];
            },
          },
        } as never);
        const dealId = await postRoutedDeal(baseUrl);
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };
        await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            commercialState: "closed_won",
            sourceEventId: "cfcfcfcf-cfcf-4fcf-8fcf-cfcfcfcfcfcf",
            occurredAt: new Date().toISOString(),
          }),
        });

        const retry = await fetch(`${baseUrl}/notification-retry`, {
          method: "POST",
          headers,
          body: JSON.stringify({ dealId, limit: 1 }),
        });
        const retryBody = (await retry.json()) as {
          attempted: number;
          results: Array<{ type: string; status: string; receipts: number }>;
        };

        expect(retry.status).toBe(200);
        expect(retryBody).toEqual(
          expect.objectContaining({
            attempted: 1,
            results: [
              expect.objectContaining({
                type: "primary",
                status: "ok",
                receipts: 1,
              }),
            ],
          }),
        );
        const state = (await fetch(`${baseUrl}/state`).then((r) =>
          r.json(),
        )) as {
          deploymentReadiness: Array<{ notifyStatus: string | null }>;
        };
        expect(state.deploymentReadiness[0]?.notifyStatus).toBe("ok");
        expect(calls).toBe(2);
      },
    );
  });

  it("rejects mutually exclusive notification retry filters", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl } = await app();
        const retry = await fetch(`${baseUrl}/notification-retry`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify({
            fingerprint: "readiness:D-1:none:pending",
            alertKey: "commercial_terminal_drift:local:evt-1",
          }),
        });
        const body = (await retry.json()) as { error: string };

        expect(retry.status).toBe(400);
        expect(body.error).toContain("fingerprint and alertKey");
      },
    );
  });

  it("routes exhausted readiness notifications to one fallback alert", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const fallbackCalls: unknown[] = [];
        const { baseUrl } = await app({
          readinessNotifications: {
            eventMode: "dry_run",
            async notify() {
              return [
                {
                  system: "slack",
                  externalId: "CDEPLOY",
                  detail: "deployment readiness notification failed: channel_not_found",
                  status: "warning",
                },
              ];
            },
          },
          fallbackNotifications: {
            eventMode: "dry_run",
            async notify(claim: unknown) {
              fallbackCalls.push(claim);
              return [
                {
                  system: "slack",
                  externalId: "CGENERIC",
                  detail: "posted deployment_handoff_failed alert",
                },
              ];
            },
          },
        } as never);
        const dealId = await postRoutedDeal(baseUrl);
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };
        await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            commercialState: "closed_won",
            sourceEventId: "d0cfd0cf-d0cf-40cf-80cf-d0cfd0cfd0cf",
            occurredAt: new Date().toISOString(),
          }),
        });
        await fetch(`${baseUrl}/notification-retry`, {
          method: "POST",
          headers,
          body: JSON.stringify({ dealId, limit: 1 }),
        });
        const retry = await fetch(`${baseUrl}/notification-retry`, {
          method: "POST",
          headers,
          body: JSON.stringify({ dealId, limit: 1 }),
        });
        const retryBody = (await retry.json()) as {
          results: Array<{
            type: string;
            status: string;
            fallbackStatus?: string;
          }>;
        };

        expect(retry.status).toBe(200);
        expect(retryBody.results).toEqual([
          expect.objectContaining({
            type: "primary",
            status: "max_attempts_exceeded",
            fallbackStatus: "ok",
          }),
        ]);
        expect(fallbackCalls).toEqual([
          expect.objectContaining({
            dealId,
            fingerprint: `readiness:${dealId}:none:pending`,
            fallbackKey: `readiness_fallback:readiness:${dealId}:none:pending`,
            readiness: "pending",
            errorClass: "slack_channel_error",
          }),
        ]);
        const metrics = (await fetch(`${baseUrl}/metrics`).then((r) =>
          r.json(),
        )) as { readinessNotificationGaps: number };
        expect(metrics.readinessNotificationGaps).toBe(0);

        const duplicateFallbackRetry = await fetch(
          `${baseUrl}/notification-retry`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ dealId, limit: 1 }),
          },
        );
        const duplicateFallbackBody = (await duplicateFallbackRetry.json()) as {
          attempted: number;
          results: unknown[];
        };

        expect(duplicateFallbackRetry.status).toBe(200);
        expect(duplicateFallbackBody).toEqual(
          expect.objectContaining({
            attempted: 0,
            results: [],
          }),
        );
      },
    );
  });

  it("retries failed terminal drift alerts through notification retry", async () => {
    await withEnv(
      {
        ALLOW_EXPECTED_RED_PATHS: "1",
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        let calls = 0;
        const { baseUrl } = await app({
          terminalDriftNotifications: {
            eventMode: "dry_run",
            async notify() {
              calls += 1;
              return calls === 1
                ? [
                    {
                      system: "slack",
                      externalId: "CGENERIC",
                      detail: "commercial terminal drift alert failed: rate_limited",
                      status: "warning",
                    },
                  ]
                : [
                    {
                      system: "slack",
                      externalId: "CGENERIC",
                      detail: "posted commercial_terminal_drift alert",
                    },
                  ];
            },
          },
        } as never);
        const dealId = await postRoutedDeal(baseUrl);
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };

        await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            commercialState: "closed_won",
            sourceEventId: "51515151-5151-4151-8151-515151515151",
            occurredAt: "2026-05-21T12:00:00.000Z",
          }),
        });
        const drift = await fetch(`${baseUrl}/commercial-state`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            commercialState: "closed_lost",
            sourceEventId: "52525252-5252-4252-8252-525252525252",
            expectedRedPath: true,
            occurredAt: "2026-05-21T12:01:00.000Z",
          }),
        });
        const driftBody = (await drift.json()) as {
          terminalDriftAlertResult?: { status: string };
        };
        expect(driftBody.terminalDriftAlertResult?.status).toBe("failed");

        const failedMetrics = (await fetch(`${baseUrl}/metrics`).then((r) =>
          r.json(),
        )) as { commercialTerminalDriftNotificationGaps: number };
        expect(failedMetrics.commercialTerminalDriftNotificationGaps).toBe(1);

        const retry = await fetch(`${baseUrl}/notification-retry`, {
          method: "POST",
          headers,
          body: JSON.stringify({ dealId, limit: 1 }),
        });
        const retryBody = (await retry.json()) as {
          attempted: number;
          results: Array<{
            type: string;
            status: string;
            receipts: number;
            alertKey?: string;
          }>;
        };

        expect(retry.status).toBe(200);
        expect(retryBody).toEqual(
          expect.objectContaining({
            attempted: 1,
            results: [
              expect.objectContaining({
                type: "terminal_drift",
                status: "ok",
                receipts: 1,
                alertKey:
                  "commercial_terminal_drift:local:52525252-5252-4252-8252-525252525252",
              }),
            ],
          }),
        );
        expect(calls).toBe(2);

        const healedMetrics = (await fetch(`${baseUrl}/metrics`).then((r) =>
          r.json(),
        )) as { commercialTerminalDriftNotificationGaps: number };
        expect(healedMetrics.commercialTerminalDriftNotificationGaps).toBe(0);
      },
    );
  });

  it("rejects invalid notification retry limits", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const { baseUrl } = await app();
        const retry = await fetch(`${baseUrl}/notification-retry`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
          },
          body: JSON.stringify({ limit: 101 }),
        });
        const body = (await retry.json()) as { error: string };

        expect(retry.status).toBe(400);
        expect(body.error).toContain("limit");
      },
    );
  });

  it("treats an empty optional domain from the operator form as omitted", async () => {
    const { baseUrl } = await app();
    const post = await fetch(`${baseUrl}/deals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company: "Domain Optional Co",
        domain: "",
        contactName: "Drew Ops",
        contactEmail: "drew@example.com",
        dealUSD: 15000,
        region: "NA",
        sourceChannel: "website_chat",
        statedNeed: "manual ops routing",
      }),
    });

    const body = (await post.json()) as { routed: number; quarantined: number };
    expect(post.status).toBe(200);
    expect(body.routed).toBe(1);
    expect(body.quarantined).toBe(0);
  });

  it("caps live integration batches so one HTTP request cannot hang the operator", async () => {
    const { baseUrl } = await app({ liveIntegrations: true });
    const post = await fetch(`${baseUrl}/deals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Array.from({ length: 6 }, () => ({ company: "x" }))),
    });

    const body = (await post.json()) as { error: string };
    expect(post.status).toBe(413);
    expect(body.error).toContain("6 deals exceeds 5");
  });

  it("records HubSpot stage changes and exposes them in the dashboard state", async () => {
    const built = integrationOptionsFromEnv("dry-run", {
      ALLOW_UNSIGNED_WEBHOOKS: "1",
    });
    const { baseUrl } = await app({
      pipelineOptions: built,
      sinkLabel: built.label,
      stageChanges: built.stageChanges,
    });
    const post = await fetch(`${baseUrl}/deals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company: "Stage Move Co",
        domain: "example.com",
        contactName: "Mina Ops",
        contactEmail: "mina@example.com",
        dealUSD: 85000,
        region: "NA",
        sourceChannel: "website_chat",
        statedNeed: "manual pipeline updates are hard to see",
      }),
    });
    const routed = (await post.json()) as {
      outcomes: Array<{ ok: true; deal: { id: string } }>;
    };
    const dealId = routed.outcomes[0]?.deal.id ?? "";

    const hook = await fetch(`${baseUrl}/webhooks/hubspot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          eventId: 901,
          portalId: 246238162,
          subscriptionType: "object.propertyChange",
          objectTypeId: "0-3",
          objectId: 777,
          propertyName: "dealstage",
          propertyValue: "contact_made",
          toStageLabel: "Contact Made",
          routerDealId: dealId,
          dealName: "Stage Move Co",
          occurredAt: 1779210000000,
          changeSource: "CRM_UI",
        },
      ]),
    });
    const hookBody = (await hook.json()) as {
      processed: number;
      results: Array<{ receipts: number }>;
    };
    const state = (await fetch(`${baseUrl}/state`).then((r) => r.json())) as {
      queue: Array<{
        id: string;
        externalStage?: { stageId: string; stageLabel: string | null };
      }>;
    };
    const events = (await fetch(
      `${baseUrl}/deals/${encodeURIComponent(dealId)}/events`,
    ).then((r) => r.json())) as {
      events: Array<{ detail: string; meta?: { kind: string; receipts?: unknown[] } }>;
    };

    expect(hook.status).toBe(200);
    expect(hookBody.processed).toBe(1);
    expect(hookBody.results[0]?.receipts).toBe(1);
    expect(state.queue.find((deal) => deal.id === dealId)?.externalStage).toEqual(
      expect.objectContaining({
        stageId: "contact_made",
        stageLabel: "Contact Made",
      }),
    );
    expect(events.events).toContainEqual(
      expect.objectContaining({
        detail: "hubspot stage changed: Contact Made (contact_made)",
      }),
    );
    expect(events.events).toContainEqual(
      expect.objectContaining({
        detail: "hubspot stage notification",
        meta: expect.objectContaining({
          kind: "hubspot_stage_change",
          receipts: [expect.objectContaining({ system: "slack" })],
        }),
      }),
    );
  });

  it("does not repost Slack notifications for duplicate HubSpot webhook retries", async () => {
    const built = integrationOptionsFromEnv("dry-run", {
      ALLOW_UNSIGNED_WEBHOOKS: "1",
    });
    const { baseUrl } = await app({
      pipelineOptions: built,
      stageChanges: built.stageChanges,
    });
    const dealPost = await fetch(`${baseUrl}/deals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company: "Duplicate Webhook Co",
        domain: "example.com",
        contactName: "Dev Ops",
        contactEmail: "dev@example.com",
        dealUSD: 42000,
        region: "NA",
        sourceChannel: "inbound_form",
        statedNeed: "HubSpot retries should not spam Slack",
      }),
    });
    const routed = (await dealPost.json()) as {
      outcomes: Array<{ ok: true; deal: { id: string } }>;
    };
    const payload = [
      {
        eventId: 902,
        portalId: 246238162,
        subscriptionType: "object.propertyChange",
        objectTypeId: "0-3",
        objectId: 778,
        propertyName: "dealstage",
        propertyValue: "contact_made",
        routerDealId: routed.outcomes[0]?.deal.id,
        occurredAt: 1779210000000,
      },
    ];

    const first = await fetch(`${baseUrl}/webhooks/hubspot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => r.json() as Promise<{ processed: number; duplicates: number }>);
    const second = await fetch(`${baseUrl}/webhooks/hubspot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => r.json() as Promise<{ processed: number; duplicates: number }>);

    expect(first).toEqual(expect.objectContaining({ processed: 1, duplicates: 0 }));
    expect(second).toEqual(expect.objectContaining({ processed: 0, duplicates: 1 }));
  });

  it("claims duplicate HubSpot webhook retries before awaiting Slack", async () => {
    const built = integrationOptionsFromEnv("dry-run", {
      ALLOW_UNSIGNED_WEBHOOKS: "1",
    });
    const originalNotify = built.stageChanges.notify.bind(built.stageChanges);
    let notifyCalls = 0;
    let releaseNotify!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseNotify = resolve;
    });
    built.stageChanges.notify = async (change) => {
      notifyCalls += 1;
      await gate;
      return originalNotify(change);
    };
    const { baseUrl } = await app({
      pipelineOptions: built,
      stageChanges: built.stageChanges,
    });
    const dealPost = await fetch(`${baseUrl}/deals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company: "Concurrent Retry Co",
        domain: "example.com",
        contactName: "Riley Ops",
        contactEmail: "riley@example.com",
        dealUSD: 64000,
        region: "NA",
        sourceChannel: "inbound_form",
        statedNeed: "same webhook can arrive twice at once",
      }),
    });
    const routed = (await dealPost.json()) as {
      outcomes: Array<{ ok: true; deal: { id: string } }>;
    };
    const body = JSON.stringify([
      {
        eventId: 903,
        portalId: 246238162,
        subscriptionType: "object.propertyChange",
        objectTypeId: "0-3",
        objectId: 779,
        propertyName: "dealstage",
        propertyValue: "contact_made",
        routerDealId: routed.outcomes[0]?.deal.id,
        occurredAt: 1779210000000,
      },
    ]);
    const request = (): Promise<Response> =>
      fetch(`${baseUrl}/webhooks/hubspot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

    const first = request();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = request();
    const secondBody = (await Promise.race([
      second.then((res) => res.json()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("duplicate request waited on Slack")), 100),
      ),
    ])) as { processed: number; duplicates: number };
    releaseNotify();
    const firstBody = (await first.then((res) => res.json())) as {
      processed: number;
      duplicates: number;
    };

    expect(notifyCalls).toBe(1);
    expect(firstBody).toEqual(expect.objectContaining({ processed: 1, duplicates: 0 }));
    expect(secondBody).toEqual(expect.objectContaining({ processed: 0, duplicates: 1 }));
  });

  it("retries a failed stage notification on HubSpot webhook retry", async () => {
    const built = integrationOptionsFromEnv("dry-run", {
      ALLOW_UNSIGNED_WEBHOOKS: "1",
    });
    let notifyCalls = 0;
    built.stageChanges.notify = async () => {
      notifyCalls += 1;
      if (notifyCalls === 1) {
        throw new TypeError("unexpected slack adapter failure");
      }
      return [
        {
          system: "slack",
          externalId: "C123",
          detail: "posted stage change after retry",
        },
      ];
    };
    const { baseUrl } = await app({
      pipelineOptions: built,
      stageChanges: built.stageChanges,
    });
    const dealPost = await fetch(`${baseUrl}/deals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company: "Slack Throw Co",
        domain: "example.com",
        contactName: "Sam Ops",
        contactEmail: "sam@example.com",
        dealUSD: 55000,
        region: "NA",
        sourceChannel: "inbound_form",
        statedNeed: "notification adapter failures should be visible",
      }),
    });
    const routed = (await dealPost.json()) as {
      outcomes: Array<{ ok: true; deal: { id: string } }>;
    };
    const dealId = routed.outcomes[0]?.deal.id ?? "";
    const payload = JSON.stringify([
      {
        eventId: 904,
        portalId: 246238162,
        subscriptionType: "object.propertyChange",
        objectTypeId: "0-3",
        objectId: 780,
        propertyName: "dealstage",
        propertyValue: "contact_made",
        routerDealId: dealId,
        occurredAt: 1779210000000,
      },
    ]);
    const hook = await fetch(`${baseUrl}/webhooks/hubspot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const hookBody = (await hook.json()) as {
      processed: number;
      results: Array<{ receipts: number }>;
    };
    const retry = await fetch(`${baseUrl}/webhooks/hubspot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const retryBody = (await retry.json()) as {
      notificationRetries: number;
      duplicates: number;
      results: Array<{ status: string; receipts: number }>;
    };
    const events = (await fetch(
      `${baseUrl}/deals/${encodeURIComponent(dealId)}/events`,
    ).then((res) => res.json())) as {
      events: Array<{
        meta?: { kind: string; receipts?: Array<{ status?: string; detail: string }> };
      }>;
    };

    expect(hookBody).toEqual(
      expect.objectContaining({ processed: 1, results: [expect.objectContaining({ receipts: 1 })] }),
    );
    expect(retryBody).toEqual(
      expect.objectContaining({
        notificationRetries: 1,
        duplicates: 0,
        results: [expect.objectContaining({ status: "notify_retry", receipts: 1 })],
      }),
    );
    expect(notifyCalls).toBe(2);
    expect(events.events).toContainEqual(
      expect.objectContaining({
        meta: expect.objectContaining({
          kind: "hubspot_stage_change",
          receipts: [
            expect.objectContaining({
              status: "warning",
              detail: expect.stringContaining("unexpected slack adapter failure"),
            }),
          ],
        }),
      }),
    );
    expect(events.events).toContainEqual(
      expect.objectContaining({
        detail: "hubspot stage notification retry",
        meta: expect.objectContaining({
          kind: "hubspot_stage_change",
          receipts: [
            expect.objectContaining({
              detail: "posted stage change after retry",
            }),
          ],
        }),
      }),
    );
  });

  it("does not let older HubSpot stage events overwrite newer stage state", async () => {
    const built = integrationOptionsFromEnv("dry-run", {
      ALLOW_UNSIGNED_WEBHOOKS: "1",
    });
    const { baseUrl } = await app({
      pipelineOptions: built,
      stageChanges: built.stageChanges,
    });
    const dealPost = await fetch(`${baseUrl}/deals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company: "Out Of Order Co",
        domain: "example.com",
        contactName: "Ori Ops",
        contactEmail: "ori@example.com",
        dealUSD: 72000,
        region: "NA",
        sourceChannel: "inbound_form",
        statedNeed: "webhooks can arrive out of order",
      }),
    });
    const routed = (await dealPost.json()) as {
      outcomes: Array<{ ok: true; deal: { id: string } }>;
    };
    const dealId = routed.outcomes[0]?.deal.id ?? "";
    const postStage = (eventId: number, stage: string, occurredAt: number) =>
      fetch(`${baseUrl}/webhooks/hubspot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          {
            eventId,
            portalId: 246238162,
            subscriptionType: "object.propertyChange",
            objectTypeId: "0-3",
            objectId: 782,
            propertyName: "dealstage",
            propertyValue: stage,
            routerDealId: dealId,
            occurredAt,
          },
        ]),
      }).then((res) => res.json());

    await postStage(906, "negotiation", 1779210300000);
    const stale = (await postStage(907, "contact_made", 1779210000000)) as {
      duplicates: number;
      stale: number;
    };
    const staleAgain = (await postStage(907, "contact_made", 1779210000000)) as {
      duplicates: number;
      stale: number;
    };
    const state = (await fetch(`${baseUrl}/state`).then((res) =>
      res.json(),
    )) as {
      queue: Array<{ id: string; externalStage?: { stageId: string } }>;
    };

    expect(stale.stale).toBe(1);
    expect(stale.duplicates).toBe(0);
    expect(staleAgain.stale).toBe(1);
    expect(staleAgain.duplicates).toBe(0);
    expect(state.queue.find((deal) => deal.id === dealId)?.externalStage?.stageId).toBe(
      "negotiation",
    );
  });

  it("rejects bad HubSpot signatures before processing the webhook body", async () => {
    const built = integrationOptionsFromEnv("dry-run", {
      HUBSPOT_WEBHOOK_SECRET: "client-secret",
    });
    const { baseUrl } = await app({ stageChanges: built.stageChanges });
    const rawBody = JSON.stringify([
      {
        objectId: 777,
        propertyName: "dealstage",
        propertyValue: "contact_made",
        routerDealId: "D-1",
      },
    ]);
    const timestamp = String(Date.now());
    const signature = hubSpotV3Signature(
      "wrong-secret",
      "POST",
      `${baseUrl}/webhooks/hubspot`,
      rawBody,
      timestamp,
    );
    const res = await fetch(`${baseUrl}/webhooks/hubspot`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hubspot-signature-v3": signature,
        "x-hubspot-request-timestamp": timestamp,
      },
      body: rawBody,
    });

    expect(res.status).toBe(401);
  });

  it("returns 400 for malformed HubSpot webhook bodies so HubSpot will not retry", async () => {
    const built = integrationOptionsFromEnv("dry-run", {
      ALLOW_UNSIGNED_WEBHOOKS: "1",
    });
    const { baseUrl } = await app({ stageChanges: built.stageChanges });
    const res = await fetch(`${baseUrl}/webhooks/hubspot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ propertyName: "dealstage" }),
    });

    expect(res.status).toBe(400);
  });

  it("accounts for HubSpot stage events that cannot be mapped to router deals", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const built = integrationOptionsFromEnv("dry-run", {
      ALLOW_UNSIGNED_WEBHOOKS: "1",
    });
    const { baseUrl } = await app({ stageChanges: built.stageChanges });
    const res = await fetch(`${baseUrl}/webhooks/hubspot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          eventId: 905,
          portalId: 246238162,
          subscriptionType: "object.propertyChange",
          objectTypeId: "0-3",
          objectId: 781,
          propertyName: "dealstage",
          propertyValue: "contact_made",
          occurredAt: 1779210000000,
        },
      ]),
    });
    const body = (await res.json()) as {
      processed: number;
      noRouterId: number;
      ignored: number;
    };

    expect(body).toEqual(
      expect.objectContaining({ processed: 0, noRouterId: 1, ignored: 0 }),
    );
    stderr.mockRestore();
  });

  it("processes healthy webhook events but returns 502 when one HubSpot resolve is retryable", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    let routerDealId = "";
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.includes("/crm/v3/objects/deals/777")) {
        return new Response(
          JSON.stringify({
            id: "777",
            properties: { gtm_router_deal_id: routerDealId },
          }),
          { status: 200 },
        );
      }
      if (textUrl.includes("/api/chat.postMessage")) {
        return new Response(
          JSON.stringify({ ok: true, channel: "C123", ts: "177.1" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: "unavailable" }), {
        status: 503,
      });
    }) as unknown as typeof fetch;
    const built = integrationOptionsFromEnv(
      "live",
      {
        HUBSPOT_ACCESS_TOKEN: "pat-na2-token",
        HUBSPOT_DEAL_EXTERNAL_ID_PROPERTY: "gtm_router_deal_id",
        HUBSPOT_WEBHOOK_SECRET: "client-secret",
        PUBLIC_BASE_URL: "https://router.example.com",
        HUBSPOT_NOTIFY_STAGE_IDS: "contact_made",
        HUBSPOT_STAGE_MAP_JSON: JSON.stringify({ contact_made: "open" }),
        SLACK_BOT_TOKEN: "xoxb-token",
        SLACK_CHANNEL_ID: "C12345678",
      },
      fetchImpl,
    );
    const { baseUrl, store } = await app({
      pipelineOptions: { ...built, dryRun: true },
      stageChanges: built.stageChanges,
    });
    routerDealId = "D-partial-resolve";
    store.recordRouted(routedRecord(routerDealId), 0, {
      mode: "dry_run",
      status: "dry_run",
    });
    const rawBody = JSON.stringify([
      {
        eventId: 1001,
        portalId: 246238162,
        subscriptionType: "object.propertyChange",
        objectTypeId: "0-3",
        objectId: 777,
        propertyName: "dealstage",
        propertyValue: "contact_made",
        occurredAt: 1779210000000,
      },
      {
        eventId: 1002,
        portalId: 246238162,
        subscriptionType: "object.propertyChange",
        objectTypeId: "0-3",
        objectId: 778,
        propertyName: "dealstage",
        propertyValue: "contact_made",
        occurredAt: 1779210000001,
      },
    ]);
    const timestamp = String(Date.now());
    const signature = hubSpotV3Signature(
      "client-secret",
      "POST",
      `${baseUrl}/webhooks/hubspot`,
      rawBody,
      timestamp,
    );
    const res = await fetch(`${baseUrl}/webhooks/hubspot`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hubspot-signature-v3": signature,
        "x-hubspot-request-timestamp": timestamp,
      },
      body: rawBody,
    });
    const body = (await res.json()) as {
      processed: number;
      resolveErrors: number;
      terminalResolveErrors: number;
      ignored: number;
    };

    expect(res.status).toBe(502);
    expect(body).toEqual(
      expect.objectContaining({
        processed: 1,
        resolveErrors: 1,
        terminalResolveErrors: 0,
        ignored: 0,
      }),
    );
    stderr.mockRestore();
  });

  it("keeps routed deal text out of the server-rendered HTML shell", async () => {
    const { baseUrl } = await app();
    const payload = {
      company: `<script>alert("owned")</script> & Co`,
      domain: "example.com",
      contactName: "Ari Operator",
      contactEmail: "ari@example.com",
      dealUSD: 75000,
      region: "NA",
      sourceChannel: "inbound_form",
      statedNeed: "manual contract review is blocking sales velocity",
    };

    const post = await fetch(`${baseUrl}/deals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(post.status).toBe(200);

    const dashboard = await fetch(`${baseUrl}/`).then((r) => r.text());
    expect(dashboard).toContain("Deployment Handoff");
    expect(dashboard).toContain("Recent Policy Runs");
    expect(dashboard).toContain("policy-runs");
    expect(dashboard).toContain("Draft Policy Recommendations");
    expect(dashboard).toContain("agent-suggestion-runs/policy-evaluation");
    expect(dashboard).toContain('encodeURIComponent(suggestion.id) + "/decision"');
    expect(dashboard).toContain("LOCAL_ENDPOINT_SECRET");
    expect(dashboard).toContain("sessionStorage");
    expect(dashboard).not.toContain(payload.company);
    expect(dashboard).not.toContain(`alert("owned")`);
    expect(dashboard).not.toContain("innerHTML");

    const state = (await fetch(`${baseUrl}/state`).then((r) =>
      r.json(),
    )) as {
      queue: Array<{
        id: string;
        company: string;
        events?: unknown;
        routed?: unknown;
      }>;
    };
    expect(state.queue[0]?.company).toBe(payload.company);
    expect(state.queue[0]?.events).toBeUndefined();
    expect(state.queue[0]?.routed).toBeUndefined();

    const events = (await fetch(
      `${baseUrl}/deals/${encodeURIComponent(state.queue[0]?.id ?? "")}/events`,
    ).then((r) => r.json())) as {
      events: Array<{ detail: string }>;
      total: number;
      truncated: boolean;
    };
    expect(events.total).toBe(5);
    expect(events.truncated).toBe(false);
    expect(events.events[0]?.detail).toBe(`intake: ${payload.company}`);
  });
});
