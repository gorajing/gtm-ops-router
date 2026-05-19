import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Enricher } from "../src/enrich.js";
import { startServer } from "../src/server.js";
import type { OpportunitySink } from "../src/sink.js";
import { Store } from "../src/store.js";
import type { Deal, Enrichment } from "../src/types.js";

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

afterEach(async () => {
  while (open.length > 0) {
    const running = open.pop();
    if (running) await running.close();
  }
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
