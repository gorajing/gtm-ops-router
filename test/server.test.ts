import type { AddressInfo } from "node:net";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FUTURE_SKEW_MS } from "../src/constants.js";
import type { Enricher } from "../src/enrich.js";
import {
  hubSpotV3Signature,
  integrationOptionsFromEnv,
} from "../src/integrations.js";
import { startServer } from "../src/server.js";
import { TerminalSinkError, type OpportunitySink } from "../src/sink.js";
import { Store } from "../src/store.js";
import type { Deal, Enrichment, Quarantine, RoutedDeal } from "../src/types.js";

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
  name: "fixture",
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

type FakeConsoleChild = FakeConsoleElement | string;
type FakeConsoleEvent = {
  type: string;
  target: FakeConsoleElement;
  preventDefault(): void;
  stopPropagation(): void;
};
type FakeConsoleEventHandler = (event: FakeConsoleEvent) => void;

class FakeConsoleElement {
  id = "";
  className = "";
  value = "";
  disabled = false;
  type = "";
  href = "";
  target = "";
  rel = "";
  returnValue = "";
  open = false;
  focused = false;
  selected = false;
  readonly attributes = new Map<string, string>();
  dataset: Record<string, string> = new Proxy<Record<string, string>>(
    {},
    {
      set(target, property, value) {
        if (typeof property !== "string") return true;
        target[property] = String(value);
        return true;
      },
    },
  );
  readonly tagName: string;
  readonly children: FakeConsoleChild[] = [];
  private readonly listeners = new Map<string, Set<FakeConsoleEventHandler>>();
  private ownText = "";

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get textContent(): string {
    return [
      this.ownText,
      ...this.children.map((child) =>
        typeof child === "string" ? child : child.textContent,
      ),
    ].join("");
  }

  set textContent(value: string) {
    this.children.splice(0, this.children.length);
    this.ownText = value;
  }

  append(...nodes: FakeConsoleChild[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeConsoleChild[]): void {
    this.children.splice(0, this.children.length, ...nodes);
    this.ownText = "";
  }

  addEventListener(event: string, handler: FakeConsoleEventHandler): void {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
  }

  removeEventListener(event: string, handler: FakeConsoleEventHandler): void {
    this.listeners.get(event)?.delete(handler);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  querySelector(selector: string): FakeConsoleElement | null {
    if (selector === "[data-deal-suggestion-section='true']") {
      return findConsoleElement(
        this,
        (node) => node.dataset.dealSuggestionSection === "true",
      );
    }
    if (selector.startsWith("#")) {
      const id = selector.slice(1);
      return findConsoleElement(this, (node) => node.id === id);
    }
    throw new Error(`FakeConsoleElement unsupported selector: ${selector}`);
  }

  dispatch(event: string): void {
    const payload: FakeConsoleEvent = {
      type: event,
      target: this,
      preventDefault: () => {},
      stopPropagation: () => {},
    };
    for (const handler of [...(this.listeners.get(event) ?? [])]) handler(payload);
  }

  focus(): void {
    this.focused = true;
  }

  select(): void {
    this.selected = true;
  }

  showModal(): void {
    if (this.open) throw new Error("InvalidStateError: dialog is already open");
    this.open = true;
  }

  close(returnValue = ""): void {
    if (!this.open) return;
    this.returnValue = returnValue;
    this.open = false;
    this.dispatch("close");
  }

  get innerText(): string {
    return [
      this.ownText,
      ...this.children.map((child) =>
        typeof child === "string" ? child : child.innerText,
      ),
    ]
      .filter((text) => text.length > 0)
      .join("\n");
  }
}

class FakeConsoleDocument {
  private readonly elements = new Map<string, FakeConsoleElement>();

  constructor(elements: Record<string, string>) {
    for (const [id, tagName] of Object.entries(elements)) {
      const element = new FakeConsoleElement(tagName);
      element.id = id;
      this.elements.set(id, element);
    }
  }

  querySelector(selector: string): FakeConsoleElement | null {
    if (!selector.startsWith("#")) {
      throw new Error(`FakeConsoleDocument only supports id selectors: ${selector}`);
    }
    const id = selector.slice(1);
    return this.elements.get(id) ?? null;
  }

  createElement(tagName: string): FakeConsoleElement {
    return new FakeConsoleElement(tagName);
  }

  text(id: string): string {
    return this.elements.get(id)?.innerText ?? "";
  }
}

function findConsoleElement(
  root: FakeConsoleElement,
  predicate: (node: FakeConsoleElement) => boolean,
): FakeConsoleElement | null {
  if (predicate(root)) return root;
  for (const child of root.children) {
    if (typeof child === "string") continue;
    const match = findConsoleElement(child, predicate);
    if (match) return match;
  }
  return null;
}

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
  testEnricher: Enricher = enricher,
): Promise<{ baseUrl: string; close(): Promise<void>; store: Store }> {
  const store = new Store(":memory:");
  const server = startServer(store, testEnricher, 0, options);
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
      const enrichment = await fetch(`${baseUrl}/enrichment-observations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const replay = await fetch(`${baseUrl}/quarantine-replay`, {
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
      const workItemSuggestionRun = await fetch(
        `${baseUrl}/agent-suggestion-runs/work-items`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      const workItem = await fetch(`${baseUrl}/work-items`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const workItemAction = await fetch(`${baseUrl}/work-items/WI-1/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const commercialBody = (await commercial.json()) as { error: string };
      const deploymentBody = (await deployment.json()) as { error: string };
      const outcomeBody = (await outcome.json()) as { error: string };
      const enrichmentBody = (await enrichment.json()) as { error: string };
      const replayBody = (await replay.json()) as { error: string };
      const suggestionBody = (await suggestion.json()) as { error: string };
      const suggestionDecisionBody = (await suggestionDecision.json()) as {
        error: string;
      };
      const workItemSuggestionRunBody = (await workItemSuggestionRun.json()) as {
        error: string;
      };
      const workItemBody = (await workItem.json()) as { error: string };
      const workItemActionBody = (await workItemAction.json()) as { error: string };

      expect(commercial.status).toBe(404);
      expect(deployment.status).toBe(404);
      expect(outcome.status).toBe(404);
      expect(enrichment.status).toBe(404);
      expect(replay.status).toBe(404);
      expect(suggestion.status).toBe(404);
      expect(suggestionDecision.status).toBe(404);
      expect(workItemSuggestionRun.status).toBe(404);
      expect(workItem.status).toBe(404);
      expect(workItemAction.status).toBe(404);
      expect(commercialBody.error).toBe("not found");
      expect(deploymentBody.error).toBe("not found");
      expect(outcomeBody.error).toBe("not found");
      expect(enrichmentBody.error).toBe("not found");
      expect(replayBody.error).toBe("not found");
      expect(suggestionBody.error).toBe("not found");
      expect(suggestionDecisionBody.error).toBe("not found");
      expect(workItemSuggestionRunBody.error).toBe("not found");
      expect(workItemBody.error).toBe("not found");
      expect(workItemActionBody.error).toBe("not found");
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
        const enrichment = await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const replay = await fetch(`${baseUrl}/quarantine-replay`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const suggestion = await fetch(`${baseUrl}/agent-suggestions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const workItemSuggestionRun = await fetch(
          `${baseUrl}/agent-suggestion-runs/work-items`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
          },
        );
        const workItem = await fetch(`${baseUrl}/work-items`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        const workItemAction = await fetch(`${baseUrl}/work-items/WI-1/action`, {
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
        expect(enrichment.status).toBe(401);
        expect(replay.status).toBe(401);
        expect(suggestion.status).toBe(401);
        expect(workItemSuggestionRun.status).toBe(401);
        expect(workItem.status).toBe(401);
        expect(workItemAction.status).toBe(401);
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
        const workItem = await fetch(`${baseUrl}/work-items`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            queue: "ae_attention",
            sourceEventId: "51515151-5151-4151-9151-515151515159",
            owner: "ae.morgan",
            createdBy: "operator-console",
            occurredAt: "2026-05-21T12:00:00",
          }),
        });
        const workItemAction = await fetch(`${baseUrl}/work-items/WI-test/action`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            sourceEventId: "52525252-5252-4252-9252-525252525259",
            action: "resolve",
            humanPrincipal: "operator-console",
            occurredAt: "2026-05-21T12:00:00",
            reason: "bad timestamp",
          }),
        });
        const workItemSuggestionRun = await fetch(
          `${baseUrl}/agent-suggestion-runs/work-items`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              createdBy: "work-item-agent",
              evaluatedAt: "2026-05-21T12:00:00",
            }),
          },
        );

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
        const enrichment = await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            subjectKey: "local-state.example",
            sourceEventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            observedAt: "2026-05-21T12:00:00Z",
            employees: 1200,
            industry: "logistics",
            techSignals: ["manual_ops"],
            regulated: true,
            confidence: 0.9,
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
        expect(enrichment.status).toBe(400);
        expect(suggestion.status).toBe(400);
        expect(workItem.status).toBe(400);
        expect(workItemAction.status).toBe(400);
        expect(workItemSuggestionRun.status).toBe(400);
        expect(recommendationRun.status).toBe(400);
        expect(store.deploymentFacts(dealId)).toBeNull();
        expect(store.outcomeEvents(dealId)).toHaveLength(0);
        expect(store.providerObservations("company", "local-state.example")).toHaveLength(0);
        expect(store.agentSuggestions()).toHaveLength(0);
        expect(store.workItems()).toHaveLength(0);
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

  it("opens and resolves work items from current role-queue signals", async () => {
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

        const notInQueue = await fetch(`${baseUrl}/work-items`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            queue: "deployment_readiness",
            sourceEventId: "56565656-5656-4656-9656-565656565656",
            owner: "deployment.ops",
            createdBy: "operator-console",
            occurredAt: "2026-05-24T15:00:00.000Z",
          }),
        });
        const notInQueueBody = (await notInQueue.json()) as { status: string };
        expect(notInQueue.status).toBe(409);
        expect(notInQueueBody.status).toBe("not_in_queue");

        const open = await fetch(`${baseUrl}/work-items`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            queue: "ae_attention",
            sourceEventId: "57575757-5757-4757-9757-575757575757",
            owner: "ae.morgan",
            createdBy: "operator-console",
            occurredAt: "2026-05-24T15:05:00.000Z",
            dueAt: "2026-05-25T15:05:00.000Z",
            reason: "AE should follow up.",
          }),
        });
        const openBody = (await open.json()) as {
          status: string;
          workItem: {
            id: string;
            status: string;
            owner: string;
            dueAt: string | null;
          } | null;
        };
        expect(open.status).toBe(200);
        expect(openBody.workItem?.id).toBeTruthy();
        const workItemId = openBody.workItem!.id;
        expect(openBody).toEqual(
          expect.objectContaining({
            status: "recorded",
            workItem: expect.objectContaining({
              status: "assigned",
              owner: "ae.morgan",
              dueAt: "2026-05-25T15:05:00.000Z",
            }),
          }),
        );

        const duplicate = await fetch(`${baseUrl}/work-items`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            queue: "ae_attention",
            sourceEventId: "57575757-5757-4757-9757-575757575757",
            owner: "ae.morgan",
            createdBy: "operator-console",
            occurredAt: "2026-05-24T15:05:00.000Z",
            dueAt: "2026-05-25T15:05:00.000Z",
            reason: "AE should follow up.",
          }),
        });
        const duplicateBody = (await duplicate.json()) as { status: string };
        expect(duplicate.status).toBe(200);
        expect(duplicateBody.status).toBe("duplicate");
        expect(duplicateBody).toEqual(
          expect.objectContaining({
            workItem: openBody.workItem,
          }),
        );

        const draft = await fetch(
          `${baseUrl}/agent-suggestion-runs/work-items`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              createdBy: "work-item-agent",
              evaluatedAt: "2026-05-24T15:06:00.000Z",
              limit: 5,
            }),
          },
        );
        const draftBody = (await draft.json()) as {
          status: string;
          attempted: number;
          recorded: number;
          duplicate: number;
          results: Array<{
            workItemId: string;
            dealId: string;
            queue: string;
            status: string;
            sourceEventId: string;
            suggestionId: string | null;
            title: string;
          }>;
        };
        const draftReplay = await fetch(
          `${baseUrl}/agent-suggestion-runs/work-items`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              createdBy: "work-item-agent",
              evaluatedAt: "2026-05-24T15:07:00.000Z",
              limit: 5,
            }),
          },
        );
        const draftReplayBody = (await draftReplay.json()) as {
          status: string;
          attempted: number;
          recorded: number;
          duplicate: number;
        };
        expect(draft.status).toBe(200);
        expect(draftBody).toEqual(
          expect.objectContaining({
            status: "recorded",
            attempted: 1,
            recorded: 1,
            duplicate: 0,
          }),
        );
        expect(draftBody.results[0]).toEqual(
          expect.objectContaining({
            workItemId,
            dealId,
            queue: "ae_attention",
            status: "recorded",
            title: expect.stringContaining("Draft AE next step"),
            sourceEventId: expect.stringMatching(
              /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
            ),
          }),
        );
        expect(draftReplay.status).toBe(200);
        expect(draftReplayBody).toEqual(
          expect.objectContaining({
            status: "no_signals",
            attempted: 0,
            recorded: 0,
            duplicate: 0,
          }),
        );

        const missingAction = await fetch(
          `${baseUrl}/work-items/WI-missing/action`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              sourceEventId: "59595959-5959-4959-9959-595959595959",
              action: "resolve",
              humanPrincipal: "operator-console",
              occurredAt: "2026-05-24T15:09:00.000Z",
              reason: "Missing item should stay visible.",
            }),
          },
        );
        const missingActionBody = (await missingAction.json()) as { status: string };
        expect(missingAction.status).toBe(404);
        expect(missingActionBody.status).toBe("not_found");

        const resolve = await fetch(
          `${baseUrl}/work-items/${encodeURIComponent(
            workItemId,
          )}/action`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              sourceEventId: "58585858-5858-4858-9858-585858585858",
              action: "resolve",
              humanPrincipal: "operator-console",
              occurredAt: "2026-05-24T15:10:00.000Z",
              reason: "AE confirmed first touch.",
            }),
          },
        );
        const resolveBody = (await resolve.json()) as {
          status: string;
          workItem: { status: string; resolutionReason: string } | null;
        };
        expect(resolve.status).toBe(200);
        expect(resolveBody).toEqual(
          expect.objectContaining({
            status: "recorded",
            workItem: expect.objectContaining({
              status: "resolved",
              resolutionReason: "AE confirmed first touch.",
            }),
          }),
        );

        const state = (await fetch(`${baseUrl}/state`).then((r) =>
          r.json(),
        )) as {
          workItems: Array<{ dealId: string; status: string }>;
          agentSuggestions: Array<{
            dealId: string;
            status: string;
            kind: string;
            title: string;
          }>;
        };
        expect(state.workItems).toEqual([
          expect.objectContaining({
            dealId,
            status: "resolved",
          }),
        ]);
        expect(state.agentSuggestions).toEqual([
          expect.objectContaining({
            dealId,
            status: "proposed",
            kind: "handoff_summary",
            title: expect.stringContaining("Draft AE next step"),
          }),
        ]);
        expect(store.workItems()[0]?.status).toBe("resolved");
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

  it("records manual enrichment evidence and refreshes the console projection", async () => {
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
        const body = {
          subjectKey: "Example.COM",
          sourceEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          observedAt: "2026-05-21T12:00:00.000Z",
          employees: 1500,
          industry: "freight brokerage",
          techSignals: ["voice_ai_eval", "manual_ops"],
          regulated: false,
          confidence: 0.99,
          operator: "operator-console",
          note: "Confirmed from account research.",
        };

        const first = await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const firstBody = (await first.json()) as {
          status: string;
          facts: {
            employees: number;
            sourceProvider: string;
            techSignals: string[];
          };
        };
        const second = await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const secondBody = (await second.json()) as { status: string };
        const conflict = await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...body, employees: 1501 }),
        });
        const conflictBody = (await conflict.json()) as { status: string };

        expect(first.status).toBe(201);
        expect(firstBody.status).toBe("recorded");
        expect(firstBody.facts).toEqual(
          expect.objectContaining({
            subjectKey: "example.com",
            employees: 1500,
            techSignals: ["manual_ops", "voice_ai_eval"],
            sourceProvider: "manual",
          }),
        );
        expect(second.status).toBe(200);
        expect(secondBody.status).toBe("duplicate");
        expect(conflict.status).toBe(409);
        expect(conflictBody.status).toBe("idempotency_conflict");
        expect(store.enrichedSubjectFacts("company", "example.com")).toEqual(
          expect.objectContaining({
            employees: 1500,
            sourceProvider: "manual",
          }),
        );

        const state = (await fetch(`${baseUrl}/state`).then((res) =>
          res.json(),
        )) as {
          queue: Array<{
            id: string;
            enrichmentSubjectKey?: string;
            enrichmentFacts?: { employees: number; sourceProvider: string };
          }>;
        };
        const row = state.queue.find((item) => item.id === dealId);
        expect(row?.enrichmentSubjectKey).toBe("example.com");
        expect(row?.enrichmentFacts).toEqual(
          expect.objectContaining({
            employees: 1500,
            sourceProvider: "manual",
          }),
        );
      },
    );
  });

  it("replays an enrichment quarantine after manual evidence is recorded", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const unresolvedEnricher: Enricher = {
          name: "fixture",
          async enrich(): Promise<Enrichment | null> {
            return null;
          },
        };
        const { baseUrl, store } = await app(undefined, unresolvedEnricher);
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };
        const post = await fetch(`${baseUrl}/deals`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            company: "Repair Logistics",
            domain: "repairlogistics.com",
            contactName: "Rina Ops",
            contactEmail: "rina@repairlogistics.com",
            dealUSD: 55000,
            region: "NA",
            sourceChannel: "cold_reply",
            statedNeed: "manual appointment scheduling creates missed pickups",
          }),
        });
        const postBody = (await post.json()) as {
          quarantined: number;
          outcomes: Array<{
            ok: false;
            quarantine: { dealId: string; code: string };
          }>;
        };
        const dealId = postBody.outcomes[0]?.quarantine.dealId;
        if (!dealId) throw new Error("expected quarantined deal id");

        const blocked = await fetch(`${baseUrl}/quarantine-replay`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            contactName: "Rina Ops",
            contactEmail: "rina@repairlogistics.com",
            operator: "operator-console",
          }),
        });
        const blockedBody = (await blocked.json()) as { status: string };

        expect(postBody.quarantined).toBe(1);
        expect(postBody.outcomes[0]?.quarantine.code).toBe(
          "enrichment_unresolved",
        );
        expect(store.quarantinedDeal(dealId)?.deal).toEqual(
          expect.objectContaining({
            company: "Repair Logistics",
            domain: "repairlogistics.com",
            contactName: "Redacted Contact",
            contactEmail: "redacted@example.invalid",
            dealUSD: 55000,
          }),
        );
        expect(blocked.status).toBe(409);
        expect(blockedBody.status).toBe("no_fresh_facts");

        await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            subjectKey: "RepairLogistics.COM",
            sourceEventId: "90909090-9090-4090-8090-909090909090",
            employees: 750,
            industry: "freight brokerage",
            techSignals: ["voice_ai_eval", "manual_ops"],
            regulated: false,
            confidence: 0.19,
            operator: "operator-console",
            note: "Low-confidence manual note should still hit the gate.",
          }),
        });
        const lowConfidenceReplay = await fetch(`${baseUrl}/quarantine-replay`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            contactName: "Rina Ops",
            contactEmail: "rina@repairlogistics.com",
            operator: "operator-console",
          }),
        });
        const lowConfidenceReplayBody = (await lowConfidenceReplay.json()) as {
          status: string;
        };
        expect(lowConfidenceReplay.status).toBe(409);
        expect(lowConfidenceReplayBody.status).toBe("low_confidence");

        const evidence = await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            subjectKey: "RepairLogistics.COM",
            sourceEventId: "90909090-9090-4090-9090-909090909090",
            employees: 750,
            industry: "freight brokerage",
            techSignals: ["voice_ai_eval", "manual_ops"],
            regulated: false,
            confidence: 0.96,
            operator: "operator-console",
            note: "Backfilled from manual account research.",
          }),
        });
        const replay = await fetch(`${baseUrl}/quarantine-replay`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            contactName: "Rina Ops",
            contactEmail: "rina@repairlogistics.com",
            operator: "operator-console",
            reason: "manual enrichment evidence is now fresh",
          }),
        });
        const replayBody = (await replay.json()) as {
          status: string;
          deal: {
            contactName: string;
            contactEmail: string;
            route: { kind: string; financeFlag: string | null };
          };
          facts: { subjectKey: string; sourceProvider: string };
        };
        const state = (await fetch(`${baseUrl}/state`).then((res) =>
          res.json(),
        )) as {
          queue: Array<{
            id: string;
            stage: string;
            amount: number;
            status: string;
            enrichmentSubjectKey?: string;
            enrichmentFacts?: { sourceProvider: string };
          }>;
          exceptions: Array<{ dealId: string }>;
        };
        const row = state.queue.find((item) => item.id === dealId);
        const events = (await fetch(
          `${baseUrl}/deals/${encodeURIComponent(dealId)}/events`,
        ).then((res) => res.json())) as {
          events: Array<{ detail: string; from: string; to: string }>;
        };

        expect(evidence.status).toBe(201);
        expect(replay.status).toBe(200);
        expect(replayBody.status).toBe("routed");
        expect(replayBody.deal.contactName).toBe("Rina Ops");
        expect(replayBody.deal.contactEmail).toBe("rina@repairlogistics.com");
        expect(replayBody.deal.route.kind).toBe("human_assisted");
        expect(replayBody.deal.route.financeFlag).toBe("pricing_approval");
        expect(replayBody.facts).toEqual(
          expect.objectContaining({
            subjectKey: "repairlogistics.com",
            sourceProvider: "manual",
          }),
        );
        expect(store.quarantinedDeal(dealId)).toBeNull();
        expect(row).toEqual(
          expect.objectContaining({
            id: dealId,
            stage: "routed",
            amount: 55000,
            status: "dry_run",
            enrichmentSubjectKey: "repairlogistics.com",
            enrichmentFacts: expect.objectContaining({
              sourceProvider: "manual",
            }),
          }),
        );
        expect(state.exceptions.some((item) => item.dealId === dealId)).toBe(
          false,
        );
        expect(events.events).toContainEqual(
          expect.objectContaining({
            from: "quarantined",
            to: "enriched",
            detail: expect.stringContaining("quarantine replay by operator-console"),
          }),
        );
      },
    );
  });

  it("replays a sink quarantine after the downstream issue is fixed", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        let failSink = true;
        const repairingSink: OpportunitySink = {
          name: "repairing-sink",
          async upsert(deal: RoutedDeal) {
            if (failSink) {
              throw new TerminalSinkError("HubSpot mapping is invalid");
            }
            return [
              {
                system: "hubspot",
                externalId: deal.id,
                detail: "upserted after repair",
              },
              {
                system: "slack",
                externalId: "C123",
                detail: "posted after repair",
              },
            ];
          },
        };
        const { baseUrl, store } = await app({
          pipelineOptions: {
            dryRun: false,
            sink: repairingSink,
            retry: { maxAttempts: 1, baseDelayMs: 0, sleep: async () => {} },
          },
        });
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };

        const post = await fetch(`${baseUrl}/deals`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            company: "Sink Repair Logistics",
            domain: "sinkrepair.example",
            contactName: "Sia Ops",
            contactEmail: "sia@sinkrepair.example",
            dealUSD: 88000,
            region: "NA",
            sourceChannel: "referral",
            statedNeed: "manual carrier calls are delaying exceptions",
          }),
        });
        const postBody = (await post.json()) as {
          quarantined: number;
          outcomes: Array<{
            ok: false;
            quarantine: { dealId: string; code: string };
          }>;
        };
        const dealId = postBody.outcomes[0]?.quarantine.dealId;
        if (!dealId) throw new Error("expected quarantined deal id");

        expect(postBody.quarantined).toBe(1);
        expect(postBody.outcomes[0]?.quarantine.code).toBe("sink_terminal");
        expect(store.quarantinedDeal(dealId)?.deal).toEqual(
          expect.objectContaining({
            company: "Sink Repair Logistics",
            contactName: "Redacted Contact",
            contactEmail: "redacted@example.invalid",
            dealUSD: 88000,
          }),
        );

        failSink = false;
        const replay = await fetch(`${baseUrl}/quarantine-replay`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            contactName: "Sia Ops",
            contactEmail: "sia@sinkrepair.example",
            operator: "operator-console",
            reason: "HubSpot mapping fixed",
          }),
        });
        const replayBody = (await replay.json()) as {
          status: string;
          replaySource: string;
          routeDerivation: string;
          deal: {
            contactEmail: string;
            route: { kind: string; financeFlag: string | null };
          };
          sink: { mode: string; status: string; receipts: Array<{ system: string }> };
        };
        const state = (await fetch(`${baseUrl}/state`).then((res) =>
          res.json(),
        )) as {
          queue: Array<{ id: string; stage: string; status: string }>;
          exceptions: Array<{ dealId: string }>;
        };
        const row = state.queue.find((item) => item.id === dealId);
        const events = (await fetch(
          `${baseUrl}/deals/${encodeURIComponent(dealId)}/events`,
        ).then((res) => res.json())) as {
          events: Array<{ detail: string; from: string; to: string }>;
        };

        expect(replay.status).toBe(200);
        expect(replayBody.status).toBe("routed");
        expect(replayBody.replaySource).toBe("stored_route:sink_terminal");
        expect(replayBody.routeDerivation).toBe("stored_route");
        expect(replayBody.deal.contactEmail).toBe("sia@sinkrepair.example");
        expect(replayBody.deal.route.kind).toBe("human_assisted");
        expect(replayBody.deal.route.financeFlag).toBe("pricing_approval");
        expect(replayBody.sink).toEqual(
          expect.objectContaining({
            mode: "live",
            status: "synced",
            receipts: expect.arrayContaining([
              expect.objectContaining({ system: "hubspot" }),
              expect.objectContaining({ system: "slack" }),
            ]),
          }),
        );
        expect(store.quarantinedDeal(dealId)).toBeNull();
        expect(row).toEqual(
          expect.objectContaining({
            id: dealId,
            stage: "routed",
            status: "synced",
          }),
        );
        expect(state.exceptions.some((item) => item.dealId === dealId)).toBe(
          false,
        );
        expect(events.events).toContainEqual(
          expect.objectContaining({
            from: "quarantined",
            to: "enriched",
            detail: expect.stringContaining(
              "quarantine replay by operator-console via stored_route:sink_terminal",
            ),
          }),
        );
      },
    );
  });

  it("replays a legacy sink quarantine from fresh evidence before falling back to the live enricher", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        let enricherCalls = 0;
        const replayAwareEnricher: Enricher = {
          name: "fixture",
          async enrich(): Promise<Enrichment> {
            enricherCalls += 1;
            return {
              employees: 1200,
              industry: "logistics",
              techSignals: ["manual_ops", "enterprise"],
              regulated: false,
              confidence: 0.95,
            };
          },
        };
        const repairingSink: OpportunitySink = {
          name: "repairing-sink",
          async upsert(deal: RoutedDeal) {
            return [
              {
                system: "hubspot",
                externalId: deal.id,
                detail: "upserted after repair",
              },
            ];
          },
        };
        const { baseUrl, store } = await app(
          {
            pipelineOptions: {
              dryRun: false,
              sink: repairingSink,
              retry: { maxAttempts: 1, baseDelayMs: 0, sleep: async () => {} },
            },
          },
          replayAwareEnricher,
        );
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };

        const legacyDeal: Deal = {
          id: "D-legacy-sink-evidence",
          company: "Evidence Sink Logistics",
          domain: "evidencesink.example",
          contactName: "Eli Ops",
          contactEmail: "eli@evidencesink.example",
          dealUSD: 66000,
          region: "NA",
          sourceChannel: "event",
          statedNeed: "manual tender follow-up is missing pickups",
        };
        const legacyQuarantine: Quarantine = {
          dealId: legacyDeal.id,
          stage: "routed",
          code: "sink_terminal",
          reason: "Slack channel is invalid",
          at: new Date().toISOString(),
        };
        store.recordQuarantine(
          legacyQuarantine,
          0,
          "scored",
          "sink_terminal: Slack channel is invalid",
          legacyDeal,
        );

        await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            subjectKey: "evidencesink.example",
            sourceEventId: "93939393-9393-4393-9393-939393939393",
            employees: 780,
            industry: "freight brokerage",
            techSignals: ["voice_ai_eval", "manual_ops"],
            regulated: false,
            confidence: 0.97,
            operator: "operator-console",
          }),
        });

        const replay = await fetch(`${baseUrl}/quarantine-replay`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId: legacyDeal.id,
            contactName: "Eli Ops",
            contactEmail: "eli@evidencesink.example",
            operator: "operator-console",
            reason: "Slack channel fixed",
          }),
        });
        const replayBody = (await replay.json()) as {
          status: string;
          replaySource: string;
          routeDerivation: string;
          facts?: { sourceProvider: string; subjectKey: string };
        };

        expect(replay.status).toBe(200);
        expect(replayBody.status).toBe("routed");
        expect(replayBody.replaySource).toMatch(/^evidence:manual:/);
        expect(replayBody.routeDerivation).toBe("rederived_from_evidence");
        expect(replayBody.facts).toEqual(
          expect.objectContaining({
            sourceProvider: "manual",
            subjectKey: "evidencesink.example",
          }),
        );
        expect(enricherCalls).toBe(0);
      },
    );
  });

  it("replays a legacy sink quarantine through the live enricher when no fresh evidence exists", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        let enricherCalls = 0;
        const replayAwareEnricher: Enricher = {
          name: "fixture",
          async enrich(deal: Deal): Promise<Enrichment> {
            enricherCalls += 1;
            expect(deal.id).toBe("D-legacy-sink-live");
            return {
              employees: 1400,
              industry: "logistics",
              techSignals: ["manual_ops", "enterprise"],
              regulated: false,
              confidence: 0.96,
            };
          },
        };
        const repairingSink: OpportunitySink = {
          name: "repairing-sink",
          async upsert(deal: RoutedDeal) {
            return [
              {
                system: "hubspot",
                externalId: deal.id,
                detail: "upserted after live enrichment",
              },
            ];
          },
        };
        const { baseUrl, store } = await app(
          {
            pipelineOptions: {
              dryRun: false,
              sink: repairingSink,
              retry: { maxAttempts: 1, baseDelayMs: 0, sleep: async () => {} },
            },
          },
          replayAwareEnricher,
        );
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };
        const legacyDeal: Deal = {
          id: "D-legacy-sink-live",
          company: "Live Sink Logistics",
          domain: "livesink.example",
          contactName: "Liv Ops",
          contactEmail: "liv@livesink.example",
          dealUSD: 72000,
          region: "NA",
          sourceChannel: "website_chat",
          statedNeed: "dispatch team needs fewer manual check calls",
        };
        const legacyQuarantine: Quarantine = {
          dealId: legacyDeal.id,
          stage: "routed",
          code: "sink_exhausted",
          reason: "CRM timed out",
          at: new Date().toISOString(),
        };
        store.recordQuarantine(
          legacyQuarantine,
          0,
          "scored",
          "sink_exhausted: CRM timed out",
          legacyDeal,
        );

        const replay = await fetch(`${baseUrl}/quarantine-replay`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId: legacyDeal.id,
            contactName: "Liv Ops",
            contactEmail: "liv@livesink.example",
            operator: "operator-console",
            reason: "CRM timeout cleared",
          }),
        });
        const replayBody = (await replay.json()) as {
          status: string;
          replaySource: string;
          routeDerivation: string;
          facts?: unknown;
          deal: { route: { kind: string } };
        };

        expect(replay.status).toBe(200);
        expect(replayBody.status).toBe("routed");
        expect(replayBody.replaySource).toBe("enricher:fixture");
        expect(replayBody.routeDerivation).toBe("rederived_from_enricher");
        expect(replayBody.facts).toBeUndefined();
        expect(replayBody.deal.route.kind).toBe("human_assisted");
        expect(enricherCalls).toBe(1);
      },
    );
  });

  it("records an audit event when replay sink failure races with state movement", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const unresolvedEnricher: Enricher = {
          name: "fixture",
          async enrich(): Promise<Enrichment | null> {
            return null;
          },
        };
        let raceStore: Store | undefined;
        const racingSink: OpportunitySink = {
          name: "racing-sink",
          async upsert(deal: RoutedDeal) {
            raceStore?.recordRouted(deal, 0, {
              mode: "dry_run",
              status: "dry_run",
            });
            throw new Error("crm unavailable after state moved");
          },
        };
        const { baseUrl, store } = await app(
          { pipelineOptions: { sink: racingSink } },
          unresolvedEnricher,
        );
        raceStore = store;
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };

        const post = await fetch(`${baseUrl}/deals`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            company: "Race Failure Logistics",
            domain: "racefailure.com",
            contactName: "Rafi Ops",
            contactEmail: "rafi@racefailure.com",
            dealUSD: 62000,
            region: "NA",
            sourceChannel: "inbound_form",
            statedNeed: "manual dispatch follow-up is missing booked loads",
          }),
        });
        const postBody = (await post.json()) as {
          outcomes: Array<{
            ok: false;
            quarantine: { dealId: string };
          }>;
        };
        const dealId = postBody.outcomes[0]?.quarantine.dealId;
        if (!dealId) throw new Error("expected quarantined deal id");

        await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            subjectKey: "racefailure.com",
            sourceEventId: "91919191-9191-4191-9191-919191919191",
            employees: 820,
            industry: "freight brokerage",
            techSignals: ["voice_ai_eval", "manual_ops"],
            regulated: false,
            confidence: 0.97,
            operator: "operator-console",
          }),
        });
        const replay = await fetch(`${baseUrl}/quarantine-replay`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            contactName: "Rafi Ops",
            contactEmail: "rafi@racefailure.com",
            operator: "operator-console",
          }),
        });
        const replayBody = (await replay.json()) as {
          status: string;
          auditRecorded: boolean;
          stateChanged: boolean;
        };
        const events = (await fetch(
          `${baseUrl}/deals/${encodeURIComponent(dealId)}/events`,
        ).then((res) => res.json())) as {
          events: Array<{ detail: string; from: string; to: string }>;
        };

        expect(replay.status).toBe(502);
        expect(replayBody).toEqual(
          expect.objectContaining({
            status: "sink_error",
            auditRecorded: true,
            stateChanged: true,
          }),
        );
        expect(events.events).toContainEqual(
          expect.objectContaining({
            from: "routed",
            to: "routed",
            detail: expect.stringContaining(
              "quarantine replay sink_error after state moved",
            ),
          }),
        );
      },
    );
  });

  it("records an audit event when replay loses the quarantine race after sink success", async () => {
    await withEnv(
      {
        ALLOW_LOCAL_WRITE_ENDPOINTS: "1",
        LOCAL_ENDPOINT_SECRET: LOCAL_ENDPOINT_SECRET,
      },
      async () => {
        const unresolvedEnricher: Enricher = {
          name: "fixture",
          async enrich(): Promise<Enrichment | null> {
            return null;
          },
        };
        let raceStore: Store | undefined;
        const racingSink: OpportunitySink = {
          name: "racing-sink",
          async upsert(deal: RoutedDeal) {
            raceStore?.recordRouted(deal, 0, {
              mode: "dry_run",
              status: "dry_run",
            });
            return [
              {
                system: "dry_run",
                externalId: deal.id,
                detail: "race sink accepted replay",
              },
            ];
          },
        };
        const { baseUrl, store } = await app(
          { pipelineOptions: { sink: racingSink } },
          unresolvedEnricher,
        );
        raceStore = store;
        const headers = {
          "content-type": "application/json",
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        };

        const post = await fetch(`${baseUrl}/deals`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            company: "Race Success Logistics",
            domain: "racesuccess.com",
            contactName: "Sana Ops",
            contactEmail: "sana@racesuccess.com",
            dealUSD: 71000,
            region: "NA",
            sourceChannel: "event",
            statedNeed: "manual appointment work creates detention risk",
          }),
        });
        const postBody = (await post.json()) as {
          outcomes: Array<{
            ok: false;
            quarantine: { dealId: string };
          }>;
        };
        const dealId = postBody.outcomes[0]?.quarantine.dealId;
        if (!dealId) throw new Error("expected quarantined deal id");

        await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            subjectKey: "racesuccess.com",
            sourceEventId: "92929292-9292-4292-9292-929292929292",
            employees: 930,
            industry: "freight brokerage",
            techSignals: ["voice_ai_eval", "manual_ops"],
            regulated: false,
            confidence: 0.98,
            operator: "operator-console",
          }),
        });
        const replay = await fetch(`${baseUrl}/quarantine-replay`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            dealId,
            contactName: "Sana Ops",
            contactEmail: "sana@racesuccess.com",
            operator: "operator-console",
          }),
        });
        const replayBody = (await replay.json()) as {
          status: string;
          auditRecorded: boolean;
          sink: { receipts: Array<{ detail: string }> };
        };
        const events = (await fetch(
          `${baseUrl}/deals/${encodeURIComponent(dealId)}/events`,
        ).then((res) => res.json())) as {
          events: Array<{ detail: string; from: string; to: string }>;
        };

        expect(replay.status).toBe(409);
        expect(replayBody.status).toBe("not_quarantined");
        expect(replayBody.auditRecorded).toBe(true);
        expect(replayBody.sink.receipts[0]?.detail).toBe(
          "race sink accepted replay",
        );
        expect(events.events).toContainEqual(
          expect.objectContaining({
            from: "routed",
            to: "routed",
            detail: expect.stringContaining(
              "quarantine replay dropped after sink success because state moved",
            ),
          }),
        );
      },
    );
  });

  it("rejects unsafe manual enrichment evidence before writing", async () => {
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
        const baseBody = {
          subjectKey: "unsafe.example",
          sourceEventId: "12121212-1212-4212-8212-121212121212",
          observedAt: "2026-05-21T12:00:00.000Z",
          employees: 1,
          industry: "logistics",
          techSignals: ["manual_ops"],
          regulated: true,
          confidence: 0.9,
          operator: "operator-console",
        };

        const zeroEmployees = await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...baseBody, employees: 0 }),
        });
        const impossibleEmployees = await fetch(
          `${baseUrl}/enrichment-observations`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...baseBody,
              sourceEventId: "23232323-2323-4232-8232-232323232323",
              employees: 10_000_001,
            }),
          },
        );
        const unboundedExpiry = await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...baseBody,
            sourceEventId: "34343434-3434-4434-8434-343434343434",
            expiresAt: null,
          }),
        });
        const expiredFact = await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...baseBody,
            sourceEventId: "56565656-5656-4656-8656-565656565656",
            expiresAt: "2026-05-21T11:59:59.999Z",
          }),
        });
        const bornExpiredFact = await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...baseBody,
            sourceEventId: "67676767-6767-4767-8767-676767676767",
            observedAt: "2020-05-21T12:00:00.000Z",
          }),
        });
        const tooLongExpiry = await fetch(`${baseUrl}/enrichment-observations`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...baseBody,
            sourceEventId: "78787878-7878-4878-8878-787878787878",
            expiresAt: "2026-07-01T12:00:00.000Z",
          }),
        });

        expect(zeroEmployees.status).toBe(400);
        expect(impossibleEmployees.status).toBe(400);
        expect(unboundedExpiry.status).toBe(400);
        expect(expiredFact.status).toBe(422);
        expect(bornExpiredFact.status).toBe(422);
        expect(tooLongExpiry.status).toBe(422);
        expect(store.providerObservations("company", "unsafe.example")).toHaveLength(0);
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
    )) as {
      queue: Array<{ status: string }>;
      exceptions: unknown[];
      metrics: { partialSyncs: number };
    };
    expect(state.queue[0]?.status).toBe("partial");
    expect(state.exceptions).toEqual([]);
    expect(state.metrics.partialSyncs).toBe(1);
  });

  it("renders the embedded dashboard script against a representative state payload", async () => {
    const { baseUrl } = await app();
    const dashboard = await fetch(`${baseUrl}/`).then((r) => r.text());
    // The dashboard client JS is now served as a static asset, not inlined.
    expect(dashboard).toContain('<script src="/dashboard.js">');
    const script = await fetch(`${baseUrl}/dashboard.js`).then((r) => r.text());
    if (!script.trim()) throw new Error("dashboard.js is missing");
    if (
      !script.includes("void pollState();") ||
      !script.includes("void pollHealth();")
    ) {
      throw new Error("dashboard.js does not look like the dashboard client");
    }
    // Use the REAL bootstrap config the shell emits (not a hardcoded copy) so a
    // drift between the emitted window.__DASH__ and the client's reads fails here.
    const dashMatch = dashboard.match(/window\.__DASH__\s*=\s*(\{.*?\});<\/script>/);
    if (!dashMatch?.[1]) {
      throw new Error("dashboard bootstrap (window.__DASH__) not found in shell");
    }
    const dashConfig = runInNewContext(`(${dashMatch[1]})`, {});

    const dashboardElementTags = {
      "agent-action-status": "div",
      "agent-suggestions": "div",
      "deal-form": "form",
      "decision-dialog": "dialog",
      "decision-dialog-body": "div",
      "decision-dialog-confirm": "button",
      "decision-dialog-detail": "div",
      "decision-dialog-meta": "div",
      "decision-dialog-rationale": "div",
      "decision-dialog-reason": "textarea",
      "decision-dialog-title": "h2",
      "deployment-handoff": "div",
      detail: "div",
      "draft-policy-btn": "button",
      "draft-work-item-btn": "button",
      exceptions: "div",
      health: "div",
      kpis: "div",
      "last-refresh": "span",
      "local-secret": "input",
      "policy-evaluation": "div",
      "policy-runs": "div",
      preview: "pre",
      "preview-btn": "button",
      queue: "div",
      "refresh-btn": "button",
      "role-queues": "div",
      "submit-btn": "button",
      "work-item-action-status": "div",
      "work-items": "div",
      "workflow-guide": "div",
      "workflow-mode": "button",
    };
    const document = new FakeConsoleDocument(dashboardElementTags);
    type DashboardStateBase = {
      metrics: Record<string, unknown>;
      roleQueues: Record<string, unknown>;
      policyEvaluation: Record<string, unknown>;
      [key: string]: unknown;
    };
    const baseState = (await fetch(`${baseUrl}/state`).then((r) =>
      r.json(),
    )) as DashboardStateBase;
    const representativeState = {
      ...baseState,
      sinkLabel: "test",
      integrity: { ok: true, detail: "ok" },
      metrics: {
        ...baseState.metrics,
        routedArrUsd: 60000,
        humanRoutedArrUsd: 60000,
        routed: 1,
        conversionPct: 100,
        quarantined: 1,
        quarantineRatePct: 50,
        flags: { pricing_approval: 1, regulated_review: 1 },
        autoHandled: 0,
        partialSyncs: 0,
        externallySyncedStoreErrors: 0,
        stageNotificationAuditGaps: 0,
        deploymentReadiness: {
          not_required: 0,
          pending: 1,
          ready: 0,
          blocked: 0,
        },
        readinessPendingOverSla: 0,
        readinessFactsStaleProjected: 0,
        readinessFactsStaleIgnored: 0,
        deployedDeals: 0,
        landedDeals: 0,
        expandedArrDeltaUsd: 0,
        expandedDeals: 0,
        medianTimeClosedWonToDeployedHours: null,
        medianTimeDeployedToLandedHours: null,
        outcomeInvalidHistories: 0,
        outcomeCommercialStateConflicts: 0,
        outcomeChurnBeforeDeploy: 0,
        latencyMsP95: 12,
      },
      queue: [
        {
          id: "D-console",
          status: "dry_run",
          company: "Console Co",
          amount: 60000,
          route: "human_assisted",
          reason: "owner ae.morgan",
          externalStage: {
            externalId: "777",
            stageId: "contact_made",
            stageLabel: "Contact Made",
            updatedAt: "2026-05-24T15:00:00.000Z",
          },
          scoreTotal: 0.9,
          sourceChannel: "inbound_form",
          statedNeed: "manual exception follow-up",
          scoreNotes: ["ICP fit +1"],
          enrichmentFacts: {
            subjectType: "company",
            subjectKey: "console.example",
            employees: 1200,
            industry: "logistics",
            techSignals: ["manual_ops", "voice_ai_eval"],
            regulated: true,
            confidence: 0.95,
            sourceProvider: "fixture",
            sourceObservationId: "PO-console",
            observedAt: "2026-05-24T15:00:00.000Z",
            expiresAt: "2026-06-23T15:00:00.000Z",
            freshnessStatus: "fresh",
            updatedAt: "2026-05-24T15:00:00.000Z",
          },
        },
      ],
      roleQueues: {
        ...baseState.roleQueues,
        ae_attention: [
          {
            queue: "ae_attention",
            priority: "high",
            dealId: "D-console",
            company: "Console Co",
            amount: 60000,
            salesOwner: "ae.morgan",
            status: "open",
            reason: "needs follow-up",
          },
        ],
        finance_review: [],
        legal_review: [],
        deployment_readiness: [],
        growth_attribution: [],
      },
      roleQueueLimit: 50,
      workItems: [
        {
          id: "WI-console",
          sourceKind: "role_queue",
          sourceKey: "role_queue:ae_attention:D-console",
          dealId: "D-console",
          queue: "ae_attention",
          status: "assigned",
          priority: "high",
          owner: "ae.morgan",
          title: "AE attention: Console Co",
          description: "needs follow-up",
          dueAt: null,
          agentSuggestionSourceEventId: "11111111-1111-4111-8111-111111111111",
          createdBy: "operator-console",
          createdAt: "2026-05-24T15:00:00.000Z",
          updatedAt: "2026-05-24T15:00:00.000Z",
          resolvedAt: null,
          resolvedBy: null,
          resolutionReason: null,
        },
      ],
      policyEvaluation: {
        ...baseState.policyEvaluation,
        candidateRouted: 1,
        candidateLimit: 1,
        signalBackfillRouted: 0,
        signalBackfillLimitPerSignal: 0,
        selfServeExpanded: [],
        humanAssistedRisk: [
          {
            dealId: "D-console",
            company: "Console Co",
            amount: 60000,
            routeKind: "human_assisted",
            sourceChannel: "inbound_form",
            salesOwner: "ae.morgan",
            signal: "human_assisted_stalled",
            signalObservedAt: "2026-05-24T15:00:00.000Z",
            reason: "closed won but deployment has not started",
            lastOutcomeAt: null,
            arrDeltaUsd: null,
          },
        ],
        sourceChannels: [
          {
            sourceChannel: "inbound_form",
            routed: 1,
            closedWon: 1,
            deploymentStarted: 0,
            deployed: 0,
            landed: 0,
            expanded: 0,
            churned: 0,
            expandedArrDeltaUsd: 0,
          },
        ],
        flags: [
          {
            flag: "pricing_approval",
            routed: 1,
            closedWon: 1,
            deploymentStarted: 0,
            deployed: 0,
            landed: 0,
            expanded: 0,
            churned: 0,
            expandedArrDeltaUsd: 0,
          },
        ],
      },
      policyRecommendationRuns: [
        {
          id: "PRR-console",
          status: "recorded",
          createdBy: "policy-agent",
          evaluatedAt: "2026-05-24T15:00:00.000Z",
          limit: 5,
          createdAt: "2026-05-24T15:01:00.000Z",
          attempted: 1,
          recorded: 1,
          duplicate: 0,
          idempotencyConflict: 0,
          skipped: 0,
          statusCounts: {
            recorded: 1,
            duplicate: 0,
            idempotency_conflict: 0,
            not_found: 0,
            not_routed: 0,
          },
          results: [
            {
              dealId: "D-console",
              signal: "human_assisted_stalled",
              sourceEventId: "11111111-1111-4111-8111-111111111111",
              status: "recorded",
              suggestionId: "S-console",
              title: "Unblock stalled deployment: Console Co",
            },
          ],
        },
      ],
      agentSuggestions: [
        {
          id: "S-console",
          dealId: "D-console",
          kind: "policy_change_recommendation",
          status: "proposed",
          title: "Unblock stalled deployment: Console Co",
          body: "Ask deployment to confirm owner and next milestone.",
          rationale: "Closed won without deployment start.",
          source: "local_agent",
          sourceEventId: "11111111-1111-4111-8111-111111111111",
          sourcePayloadHash: "hash",
          createdBy: "policy-agent",
          occurredAt: "2026-05-24T15:00:00.000Z",
          createdAt: "2026-05-24T15:01:00.000Z",
          decidedAt: null,
          decidedBy: null,
          decisionSourceEventId: null,
          decisionPayloadHash: null,
          decisionReason: null,
        },
        {
          id: "S-console-decided",
          dealId: "D-console",
          kind: "handoff_summary",
          status: "accepted",
          title: "Accepted reference handoff",
          body: "Already accepted operator note.",
          rationale: "Accepted row should stay out of the default open queue.",
          source: "local_agent",
          sourceEventId: "22222222-2222-4222-8222-222222222222",
          sourcePayloadHash: "hash2",
          createdBy: "policy-agent",
          occurredAt: "2026-05-24T15:00:00.000Z",
          createdAt: "2026-05-24T15:01:00.000Z",
          decidedAt: "2026-05-24T15:03:00.000Z",
          decidedBy: "operator-console",
          decisionSourceEventId: "33333333-3333-4333-8333-333333333333",
          decisionPayloadHash: "decision-hash",
          decisionReason: "Accepted from operator console.",
        },
        {
          id: "S-console-other",
          dealId: "D-console",
          kind: "policy_change_recommendation",
          status: "deferred",
          title: "Deferred policy check",
          body: "Unknown statuses should be visible only from Other or All.",
          rationale: "The console should surface unclassified statuses loudly.",
          source: "local_agent",
          sourceEventId: "44444444-4444-4444-8444-444444444444",
          sourcePayloadHash: "hash3",
          createdBy: "policy-agent",
          occurredAt: "2026-05-24T15:04:00.000Z",
          createdAt: "2026-05-24T15:05:00.000Z",
          decidedAt: null,
          decidedBy: null,
          decisionSourceEventId: null,
          decisionPayloadHash: null,
          decisionReason: null,
        },
      ],
      exceptions: [
        {
          code: "schema_invalid",
          dealId: "D-bad",
          reason: "bad email",
        },
      ],
      deploymentReadiness: [
        {
          dealId: "D-console",
          readiness: "pending",
          blockerCode: "deployment_use_case_unclear",
          secondaryBlockerCodes: [],
          factsStatus: "missing",
          notifyStatus: "failed",
          reason: "awaiting deployment facts",
          updatedAt: "2026-05-24T15:02:00.000Z",
        },
      ],
    };
    const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
      new Response(JSON.stringify(body), {
        ...init,
        headers: { "content-type": "application/json" },
      });
    const pendingFetches = new Set<Promise<unknown>>();
    const dashboardPosts: Array<{
      url: string;
      headers: Record<string, string>;
      body: Record<string, unknown>;
    }> = [];
    let failNextCommercialStateRefresh = true;
    let stateFetchFailuresRemaining = 0;
    const expectedFetchUrls = new Set([
      "/state",
      "/integration-health",
      "/deals/D-console/events",
    ]);
    let activeFetches = 0;
    const fetchImpl = async (
      input: unknown,
      init?: unknown,
    ): Promise<Response> => {
      const fetchPromise = Promise.resolve().then(() => {
        const method =
          init && typeof init === "object" && "method" in init
            ? String((init as { method?: unknown }).method ?? "GET")
            : "GET";
        if (method.toUpperCase() !== "GET") {
          const initRecord = init as {
            headers?: Record<string, string>;
            body?: string;
          };
          const url = String(input);
          const body = JSON.parse(String(initRecord.body || "{}")) as Record<
            string,
            unknown
          >;
          dashboardPosts.push({
            url,
            headers: initRecord.headers ?? {},
            body,
          });
          if (url === "/commercial-state") {
            if (
              failNextCommercialStateRefresh &&
              body.commercialState === "proposal_sent"
            ) {
              stateFetchFailuresRemaining += 1;
              failNextCommercialStateRefresh = false;
            }
            return jsonResponse({ status: "recorded" });
          }
          if (url === "/deployment-facts") {
            return jsonResponse({ status: "recorded" });
          }
          if (url === "/notification-retry") {
            return jsonResponse({
              attempted: 1,
              results: [{ type: "primary", status: "ok", receipts: 1 }],
            });
          }
          throw new Error(`unexpected dashboard POST url: ${url}`);
        }
        const url = String(input);
        expectedFetchUrls.delete(url);
        if (url === "/state") {
          if (stateFetchFailuresRemaining > 0) {
            stateFetchFailuresRemaining -= 1;
            return jsonResponse(
              { error: "synthetic state refresh failure" },
              { status: 503 },
            );
          }
          return jsonResponse(representativeState);
        }
        if (url === "/integration-health") {
          return jsonResponse([
            {
              system: "env",
              name: "integration mode",
              status: "warn",
              detail: "test sink",
            },
          ]);
        }
        if (url === "/deals/D-console/events") {
          return jsonResponse({
            total: 1,
            truncated: false,
            events: [
              {
                from: "intake",
                to: "routed",
                detail: "agent_suggestion_proposed",
                ts: "2026-05-24T15:01:00.000Z",
                meta: { kind: "agent_suggestion_proposed" },
              },
            ],
          });
        }
        throw new Error(`unexpected dashboard fetch url: ${url}`);
      });
      activeFetches += 1;
      pendingFetches.add(fetchPromise);
      void fetchPromise.finally(() => {
        activeFetches -= 1;
        pendingFetches.delete(fetchPromise);
      });
      return fetchPromise;
    };
    const waitForExpectedDashboardFetches = async (): Promise<void> => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await Promise.allSettled([...pendingFetches]);
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!expectedFetchUrls.size && !activeFetches && !pendingFetches.size) return;
      }
      throw new Error(
        `dashboard fetches did not settle: expected=${[
          ...expectedFetchUrls,
        ].join(",")} active=${activeFetches} pending=${pendingFetches.size}`,
      );
    };
    const waitForDashboardDocumentText = async (
      targetDocument: FakeConsoleDocument,
      id: string,
      text: string,
    ): Promise<void> => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (targetDocument.text(id).includes(text)) return;
        await Promise.allSettled([...pendingFetches]);
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      throw new Error(`dashboard text ${id} did not include ${text}`);
    };
    const waitForDashboardText = async (
      id: string,
      text: string,
    ): Promise<void> => waitForDashboardDocumentText(document, id, text);
    const expectDashboardPostsToStay = async (
      expectedLength: number,
    ): Promise<void> => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await Promise.allSettled([...pendingFetches]);
        await Promise.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(dashboardPosts).toHaveLength(expectedLength);
      }
    };
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    const scheduledTimeoutDelays: Array<number | undefined> = [];
    const sessionStorageValues = new Map<string, string>();
    const pendingLocalActionsStorageKey =
      "gtm_ops_router_pending_local_actions_v3";
    const storage = {
      getItem: (key: string) => sessionStorageValues.get(key) ?? null,
      setItem: (key: string, value: string) => {
        sessionStorageValues.set(key, String(value));
      },
    };
    let formDataConstructed = 0;
    let promptCalls = 0;
    const dashboardWarnings: unknown[][] = [];
    const dashboardConsole = Object.create(console) as Console;
    dashboardConsole.warn = (...args: unknown[]): void => {
      dashboardWarnings.push(args);
    };

    process.on("unhandledRejection", onUnhandledRejection);
    try {
      runInNewContext(script, {
        console: dashboardConsole,
        document,
        encodeURIComponent,
        fetch: fetchImpl,
        FormData: class FormData {
          constructor() {
            formDataConstructed += 1;
          }

          get(): never {
            throw new Error("dashboard submit path is not covered by this smoke test");
          }
        },
        Intl,
        localStorage: storage,
        sessionStorage: storage,
        URLSearchParams,
        setTimeout: (_handler: unknown, delay?: number) => {
          scheduledTimeoutDelays.push(delay);
          return scheduledTimeoutDelays.length;
        },
        clearTimeout: () => {},
        window: {
          __DASH__: dashConfig,
          prompt: () => {
            promptCalls += 1;
            return null;
          },
          location: {
            search: "?demo=operator",
          },
        },
      });
      await waitForExpectedDashboardFetches();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }

    expect(unhandledRejections).toEqual([]);
    expect(scheduledTimeoutDelays.length).toBeGreaterThanOrEqual(2);
    expect(
      scheduledTimeoutDelays.every(
        (delay) => typeof delay === "number" && delay > 0,
      ),
    ).toBe(true);
    expect(formDataConstructed).toBe(0);
    expect(promptCalls).toBe(0);
    expect(document.text("queue")).toContain("Console Co");
    expect(document.text("kpis")).toContain("$60,000");
    expect(document.text("kpis")).toContain("50% loud failure");
    expect(document.text("exceptions")).toContain("schema_invalid");
    expect(document.text("policy-runs")).toContain("PRR-console");
    expect(document.text("policy-runs")).toContain(
      "Showing latest 1 policy runs.",
    );
    expect(document.text("work-items")).toContain("AE attention: Console Co");
    expect(document.text("work-items")).toContain("Resolve");
    expect(document.text("work-items")).toContain("assigned");
    expect(document.text("workflow-mode")).toContain("Pause auto-follow");
    expect(document.text("workflow-guide")).toContain("Console Co routed");
    expect(document.text("workflow-guide")).toContain("AE signal");
    expect(document.text("workflow-guide")).toContain("Assigned to ae.morgan");
    expect(document.text("workflow-guide")).toContain("Draft proposed");
    expect(document.text("workflow-guide")).toContain("Human decision needed");
    expect(document.text("workflow-guide")).toContain("Accept draft");
    expect(document.text("workflow-guide")).toContain("Reject draft");
    expect(document.text("agent-suggestions")).toContain(
      "Unblock stalled deployment",
    );
    expect(document.text("agent-suggestions")).toContain(
      "Ask deployment to confirm owner and next milestone.",
    );
    expect(document.text("agent-suggestions")).not.toContain(
      "Accepted reference handoff",
    );
    expect(document.text("agent-suggestions")).not.toContain(
      "Deferred policy check",
    );
    expect(document.text("agent-suggestions")).toContain(
      "Queue: 1 open proposal, 1 decided suggestion, 1 unclassified status",
    );
    expect(document.text("agent-suggestions")).toMatch(
      /Source local_agent \/ [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/,
    );
    expect(dashboardWarnings).toEqual([
      ["unknown agent suggestion status", "deferred"],
    ]);
    const suggestionRoot = document.querySelector("#agent-suggestions");
    if (!suggestionRoot) throw new Error("agent suggestions root missing");
    for (const [filter, label] of [
      ["open", "Open 1"],
      ["decided", "Decided 1"],
      ["other", "Other 1"],
      ["all", "All 3"],
    ]) {
      const filterButton = findConsoleElement(
        suggestionRoot,
        (node) =>
          node.tagName === "BUTTON" &&
          node.attributes.get("data-filter") === filter &&
          node.textContent === label,
      );
      if (!filterButton) throw new Error(`${label} filter button missing`);
      expect(filterButton.attributes.get("aria-pressed")).toBe(
        label === "Open 1" ? "true" : "false",
      );
    }
    const decidedFilter = findConsoleElement(
      suggestionRoot,
      (node) =>
        node.tagName === "BUTTON" &&
        node.attributes.get("data-filter") === "decided",
    );
    if (!decidedFilter) throw new Error("decided filter button missing");
    decidedFilter.dispatch("click");
    expect(document.text("agent-suggestions")).toContain(
      "Accepted reference handoff",
    );
    expect(document.text("agent-suggestions")).not.toContain(
      "Unblock stalled deployment",
    );
    const activeDecidedFilter = findConsoleElement(
      suggestionRoot,
      (node) =>
        node.tagName === "BUTTON" &&
        node.attributes.get("data-filter") === "decided",
    );
    expect(activeDecidedFilter?.attributes.get("aria-pressed")).toBe("true");
    const otherFilter = findConsoleElement(
      suggestionRoot,
      (node) =>
        node.tagName === "BUTTON" &&
        node.attributes.get("data-filter") === "other",
    );
    if (!otherFilter) throw new Error("other filter button missing");
    otherFilter.dispatch("click");
    expect(document.text("agent-suggestions")).toContain(
      "Deferred policy check",
    );
    expect(document.text("agent-suggestions")).not.toContain(
      "Accepted reference handoff",
    );
    expect(document.text("agent-suggestions")).not.toContain(
      "Unblock stalled deployment",
    );
    const allFilter = findConsoleElement(
      suggestionRoot,
      (node) =>
        node.tagName === "BUTTON" &&
        node.attributes.get("data-filter") === "all",
    );
    if (!allFilter) throw new Error("all filter button missing");
    allFilter.dispatch("click");
    expect(document.text("agent-suggestions")).toContain(
      "Accepted reference handoff",
    );
    expect(document.text("agent-suggestions")).toContain(
      "Unblock stalled deployment",
    );
    expect(document.text("agent-suggestions")).toContain(
      "Deferred policy check",
    );
    expect(document.text("deployment-handoff")).toContain("Use case unclear");
    expect(document.text("detail")).toContain("Deal Journey");
    expect(document.text("detail")).toContain("agent_suggestion_proposed");
    expect(document.text("detail")).toContain("Enrichment Evidence");
    expect(document.text("detail")).toContain("fixture");
    expect(document.text("detail")).toContain("manual_ops, voice_ai_eval");
    expect(document.text("detail")).toContain("Lifecycle Controls");
    expect(document.text("detail")).toContain("Commercial state");
    expect(document.text("detail")).toContain("Deployment facts");
    expect(document.text("detail")).toContain("Retry Handoff Notification");
    expect(document.text("detail")).toContain("Agent Suggestions");
    expect(document.text("detail")).toContain(
      "Ask deployment to confirm owner and next milestone.",
    );
    expect(document.text("health")).toContain("integration mode: test sink");

    const detail = document.querySelector("#detail");
    if (!detail) throw new Error("detail root missing from fake DOM");
    const localSecretInput = document.querySelector("#local-secret");
    if (!localSecretInput) throw new Error("local secret input missing");
    localSecretInput.value = LOCAL_ENDPOINT_SECRET;
    let lifecycle = findConsoleElement(
      detail,
      (node) => node.dataset.lifecycleControls === "true",
    );
    if (!lifecycle) throw new Error("lifecycle controls section missing");
    const currentLifecycle = (): FakeConsoleElement => {
      if (!lifecycle) throw new Error("lifecycle controls section missing");
      return lifecycle;
    };
    const lifecycleButton = (text: string): FakeConsoleElement => {
      const button = findConsoleElement(
        currentLifecycle(),
        (node) => node.tagName === "BUTTON" && node.textContent === text,
      );
      if (!button) throw new Error(`${text} button missing`);
      return button;
    };
    const controlInLabel = (
      labelText: string,
      tagName: string,
    ): FakeConsoleElement => {
      const label = findConsoleElement(
        currentLifecycle(),
        (node) => node.tagName === "LABEL" && node.textContent.includes(labelText),
      );
      if (!label) throw new Error(`${labelText} label missing`);
      const input = findConsoleElement(label, (node) => node.tagName === tagName);
      if (!input) throw new Error(`${labelText} control missing`);
      return input;
    };
    lifecycleButton("Record Commercial State").dispatch("click");
    await expectDashboardPostsToStay(0);
    expect(document.text("detail")).toContain("Select a commercial state.");
    const commercialStateControl = controlInLabel("State", "SELECT");
    commercialStateControl.value = "proposal_sent";
    lifecycleButton("Record Commercial State").dispatch("click");
    await waitForExpectedDashboardFetches();
    expect(dashboardPosts[0]?.url).toBe("/commercial-state");
    expect(dashboardPosts[0]?.headers).toEqual(
      expect.objectContaining({
        [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
      }),
    );
    expect(dashboardPosts[0]?.body).toEqual({
      dealId: "D-console",
      commercialState: "proposal_sent",
      sourceEventId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      occurredAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
    });
    expect(document.text("detail")).toContain(
      "Refresh failed; the write may already be recorded.",
    );
    const originalCommercialEvent = dashboardPosts[0]?.body;
    const pendingRaw = sessionStorageValues.get(pendingLocalActionsStorageKey);
    if (!pendingRaw) throw new Error("pending local action storage missing");
    const pendingRows = JSON.parse(pendingRaw) as Array<
      [string, Record<string, unknown>]
    >;
    expect(pendingRows).toHaveLength(1);
    const pendingEvent = pendingRows[0]?.[1];
    const expectedCommercialPayloadSignature = JSON.stringify([
      "object",
      [
        ["commercialState", ["string", "proposal_sent"]],
        ["dealId", ["string", "D-console"]],
        ["reason", ["null"]],
      ],
    ]);
    expect(pendingEvent).toEqual(
      expect.objectContaining({
        sourceEventId: originalCommercialEvent?.sourceEventId,
        occurredAt: originalCommercialEvent?.occurredAt,
        payloadSignature: expectedCommercialPayloadSignature,
      }),
    );
    commercialStateControl.value = "closed_won";
    lifecycleButton("Record Commercial State").dispatch("click");
    await expectDashboardPostsToStay(1);
    expect(document.text("detail")).toContain(
      "A commercial-state write for this deal is still unconfirmed.",
    );
    const pendingAfterBlockedRaw = sessionStorageValues.get(
      pendingLocalActionsStorageKey,
    );
    if (!pendingAfterBlockedRaw) {
      throw new Error("pending local action storage missing after blocked write");
    }
    expect(JSON.parse(pendingAfterBlockedRaw)).toEqual(pendingRows);
    const reloadDocument = new FakeConsoleDocument(dashboardElementTags);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      runInNewContext(script, {
        console: dashboardConsole,
        document: reloadDocument,
        encodeURIComponent,
        fetch: fetchImpl,
        FormData: class FormData {
          constructor() {
            formDataConstructed += 1;
          }

          get(): never {
            throw new Error("dashboard submit path is not covered by this smoke test");
          }
        },
        Intl,
        localStorage: storage,
        sessionStorage: storage,
        URLSearchParams,
        setTimeout: (_handler: unknown, delay?: number) => {
          scheduledTimeoutDelays.push(delay);
          return scheduledTimeoutDelays.length;
        },
        clearTimeout: () => {},
        window: {
          __DASH__: dashConfig,
          prompt: () => {
            promptCalls += 1;
            return null;
          },
          location: {
            search: "?demo=operator",
          },
        },
      });
      await waitForExpectedDashboardFetches();
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
    const reloadDetail = reloadDocument.querySelector("#detail");
    if (!reloadDetail) throw new Error("reload detail root missing");
    lifecycle = findConsoleElement(
      reloadDetail,
      (node) => node.dataset.lifecycleControls === "true",
    );
    if (!lifecycle) throw new Error("reload lifecycle controls section missing");
    controlInLabel("State", "SELECT").value = "closed_won";
    lifecycleButton("Record Commercial State").dispatch("click");
    await expectDashboardPostsToStay(1);
    expect(reloadDocument.text("detail")).toContain(
      "A commercial-state write for this deal is still unconfirmed.",
    );
    expect(JSON.parse(sessionStorageValues.get(pendingLocalActionsStorageKey) ?? "[]")).toEqual(
      pendingRows,
    );
    controlInLabel("State", "SELECT").value = "proposal_sent";
    lifecycleButton("Record Commercial State").dispatch("click");
    await waitForExpectedDashboardFetches();
    expect(dashboardPosts[1]?.url).toBe("/commercial-state");
    expect(dashboardPosts[1]?.headers).toEqual(
      expect.objectContaining({
        [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
      }),
    );
    expect(dashboardPosts[1]?.body).toEqual(originalCommercialEvent);
    expect(dashboardPosts[1]?.body).toEqual(
      expect.objectContaining({
        sourceEventId: pendingEvent?.sourceEventId,
        occurredAt: pendingEvent?.occurredAt,
      }),
    );
    expect(sessionStorageValues.get(pendingLocalActionsStorageKey)).toBe(
      "[]",
    );
    await waitForDashboardDocumentText(
      reloadDocument,
      "detail",
      "Retry Handoff Notification",
    );
    lifecycle = findConsoleElement(
      reloadDetail,
      (node) => node.dataset.lifecycleControls === "true",
    );
    if (!lifecycle) throw new Error("refreshed lifecycle controls section missing");
    lifecycleButton("Record Deployment Facts").dispatch("click");
    await expectDashboardPostsToStay(2);
    expect(sessionStorageValues.get(pendingLocalActionsStorageKey)).toBe("[]");
    expect(reloadDocument.text("detail")).toContain(
      "Select all deployment fact fields.",
    );
    controlInLabel("Use Case Clear", "SELECT").value = "true";
    controlInLabel("Integrations Known", "SELECT").value = "false";
    lifecycleButton("Record Deployment Facts").dispatch("click");
    await expectDashboardPostsToStay(2);
    expect(sessionStorageValues.get(pendingLocalActionsStorageKey)).toBe("[]");
    expect(reloadDocument.text("detail")).toContain(
      "Select all deployment fact fields.",
    );
    controlInLabel("Integrations Known", "SELECT").value = "";
    controlInLabel("Data Ready", "SELECT").value = "true";
    lifecycleButton("Record Deployment Facts").dispatch("click");
    await expectDashboardPostsToStay(2);
    expect(sessionStorageValues.get(pendingLocalActionsStorageKey)).toBe("[]");
    expect(reloadDocument.text("detail")).toContain(
      "Select all deployment fact fields.",
    );
    controlInLabel("Use Case Clear", "SELECT").value = "";
    controlInLabel("Integrations Known", "SELECT").value = "false";
    controlInLabel("Data Ready", "SELECT").value = "true";
    lifecycleButton("Record Deployment Facts").dispatch("click");
    await expectDashboardPostsToStay(2);
    expect(sessionStorageValues.get(pendingLocalActionsStorageKey)).toBe("[]");
    expect(reloadDocument.text("detail")).toContain(
      "Select all deployment fact fields.",
    );
    controlInLabel("Use Case Clear", "SELECT").value = "true";
    controlInLabel("Integrations Known", "SELECT").value = "";
    controlInLabel("Data Ready", "SELECT").value = "true";
    lifecycleButton("Record Deployment Facts").dispatch("click");
    await expectDashboardPostsToStay(2);
    expect(reloadDocument.text("detail")).toContain(
      "Select all deployment fact fields.",
    );
    controlInLabel("Integrations Known", "SELECT").value = "false";
    lifecycleButton("Record Deployment Facts").dispatch("click");
    await waitForExpectedDashboardFetches();
    expect(dashboardPosts[2]?.url).toBe("/deployment-facts");
    expect(dashboardPosts[2]?.headers).toEqual(
      expect.objectContaining({
        [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
      }),
    );
    expect(dashboardPosts[2]?.body).toEqual({
      dealId: "D-console",
      useCaseClear: true,
      integrationsKnown: false,
      dataReady: true,
      operator: "operator-console",
      sourceEventId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      occurredAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
    });
    lifecycleButton("Retry Handoff Notification").dispatch("click");
    await waitForExpectedDashboardFetches();
    expect(dashboardPosts[3]).toEqual(
      expect.objectContaining({
        url: "/notification-retry",
        headers: expect.objectContaining({
          [LOCAL_ENDPOINT_SECRET_HEADER]: LOCAL_ENDPOINT_SECRET,
        }),
        body: { dealId: "D-console", limit: 1 },
      }),
    );
    const detailSuggestions = detail.querySelector(
      "[data-deal-suggestion-section='true']",
    );
    if (!detailSuggestions) throw new Error("detail suggestions section missing");
    const detailAccept = findConsoleElement(
      detailSuggestions,
      (node) => node.tagName === "BUTTON" && node.textContent === "Accept",
    );
    if (!detailAccept) throw new Error("detail accept button missing");
    detailAccept.dispatch("click");
    await waitForDashboardText("detail", "Deciding...");
    const dialog = document.querySelector("#decision-dialog");
    if (!dialog) throw new Error("decision dialog missing from fake DOM");
    expect(dialog.open).toBe(true);
    dialog.close("cancel");
    await waitForExpectedDashboardFetches();
    await waitForDashboardText("detail", "Accept");
    expect(document.text("detail")).not.toContain("Deciding...");
    expect(unhandledRejections).toEqual([]);
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
    const dashboardJs = await fetch(`${baseUrl}/dashboard.js`).then((r) => r.text());
    // Static structure lives in the server-rendered shell.
    expect(dashboard).toContain("Deployment Handoff");
    expect(dashboard).toContain("Recent Policy Runs");
    expect(dashboard).toContain("policy-runs");
    expect(dashboard).toContain("Draft Policy Recommendations");
    expect(dashboard).toContain("Draft Work Item Actions");
    // Client behavior (labels + endpoint URLs) lives in the external dashboard.js.
    expect(dashboardJs).toContain("Manual company evidence");
    expect(dashboardJs).toContain("/enrichment-observations");
    expect(dashboardJs).toContain("Replay Quarantine");
    expect(dashboardJs).toContain("Retry downstream sync");
    expect(dashboardJs).toContain("/quarantine-replay");
    expect(dashboardJs).toContain("agent-suggestion-runs/policy-evaluation");
    expect(dashboardJs).toContain("agent-suggestion-runs/work-items");
    expect(dashboardJs).toContain('encodeURIComponent(activeSuggestion.id) + "/decision"');
    expect(dashboardJs).toContain("LOCAL_ENDPOINT_SECRET");
    expect(dashboardJs).toContain("sessionStorage");
    // Core safety: routed deal text is never baked into the served shell, and
    // the client renders without innerHTML.
    expect(dashboard).not.toContain(payload.company);
    expect(dashboard).not.toContain(`alert("owned")`);
    expect(dashboardJs).not.toContain("innerHTML");

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

describe("GET /state engagementAttribution", () => {
  it("includes engagementAttribution with correct shape on a fresh store", async () => {
    const { baseUrl } = await app();
    const res = await fetch(`${baseUrl}/state`);
    const body = (await res.json()) as {
      engagementAttribution: {
        coverage: { complete: boolean; routedDealsTotal: number; routedDealsWithEngagement: number };
        tiers: { meetingsInfluencedUsd: number; commercialSignalsUsd: number; pipelineInfluencedUsd: number };
        rates: { replyRate: number | null; meetingRate: number | null; replyToMeetingRate: number | null };
        winRateByEngagementPath: Array<{ path: string; routed: number; closedWon: number; winRate: number | null }>;
        hoursSaved: { autoHandledDeals: number; agentDraftedTouchesSent: number; assumedTriageMin: number; assumedDraftMin: number; estimatedHours: number; modeled: true };
      };
    };

    expect(res.status).toBe(200);
    expect(body.engagementAttribution).toBeDefined();
    // shape checks
    const ea = body.engagementAttribution;
    // Empty store: 0 routed deals → coverage vacuously complete (Task 4 design).
    expect(ea.coverage).toEqual({ complete: true, routedDealsTotal: 0, routedDealsWithEngagement: 0 });
    expect(ea.tiers).toEqual({ meetingsInfluencedUsd: 0, commercialSignalsUsd: 0, pipelineInfluencedUsd: 0 });
    expect(ea.rates.replyRate).toBeNull();
    expect(ea.rates.meetingRate).toBeNull();
    expect(ea.rates.replyToMeetingRate).toBeNull();
    expect(Array.isArray(ea.winRateByEngagementPath)).toBe(true);
    expect(ea.hoursSaved.modeled).toBe(true);
    expect(ea.hoursSaved.estimatedHours).toBe(0);
  });

  it("includes engagementAttribution with routed deals after intake", async () => {
    const { baseUrl } = await app();
    await fetch(`${baseUrl}/deals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        company: "Engagement Test Co",
        domain: "engtest.example",
        contactName: "Era Ops",
        contactEmail: "era@engtest.example",
        dealUSD: 75000,
        region: "NA",
        sourceChannel: "inbound_form",
        statedNeed: "automate scheduling across finance and sales handoffs",
      }),
    });
    const res = await fetch(`${baseUrl}/state`);
    const body = (await res.json()) as {
      engagementAttribution: {
        coverage: { complete: boolean; routedDealsTotal: number; routedDealsWithEngagement: number };
        tiers: { meetingsInfluencedUsd: number; commercialSignalsUsd: number; pipelineInfluencedUsd: number };
        rates: { replyRate: number | null; meetingRate: number | null; replyToMeetingRate: number | null };
      };
    };

    expect(res.status).toBe(200);
    // 1 routed deal, 0 with engagement data
    expect(body.engagementAttribution.coverage.routedDealsTotal).toBe(1);
    expect(body.engagementAttribution.coverage.routedDealsWithEngagement).toBe(0);
    // no engagement rows → rates are null (denominator 0)
    expect(body.engagementAttribution.rates.replyRate).toBeNull();
    expect(body.engagementAttribution.rates.meetingRate).toBeNull();
  });
});

describe("nonDemoEngagementEventCount guard shape (store contract)", () => {
  it("returns 0 for an empty store on the demo deal ids", () => {
    const store = new Store(":memory:");
    try {
      const count = store.nonDemoEngagementEventCount(
        ["D-fb65c15017ef", "D-cdea8ac45022"],
        [],
      );
      expect(typeof count).toBe("number");
      expect(count).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("demo engagement guard (nonDemoEngagementEventCount)", () => {
  it("reports 0 when the store has no engagement rows for the fixture deals", () => {
    const store = new Store(":memory:");
    try {
      const count = store.nonDemoEngagementEventCount(
        ["D-fb65c15017ef", "D-cdea8ac45022"],
        ["demo-engagement-id-1", "demo-engagement-id-2"],
      );
      expect(count).toBe(0);
    } finally {
      store.close();
    }
  });
});
