import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Enricher } from "../src/enrich.js";
import {
  hubSpotV3Signature,
  integrationOptionsFromEnv,
} from "../src/integrations.js";
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
    const timestamp = String(new Date("2026-05-19T12:00:00Z").getTime());
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
