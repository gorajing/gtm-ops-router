import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { Enricher } from "../src/enrich.js";
import { startServer } from "../src/server.js";
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

async function app(): Promise<{ baseUrl: string; close(): Promise<void>; store: Store }> {
  const store = new Store(":memory:");
  const server = startServer(store, enricher, 0);
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

  it("escapes routed deal and event text before rendering HTML", async () => {
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
    expect(dashboard).not.toContain("<script>");
    expect(dashboard).toContain(
      "&lt;script&gt;alert(&quot;owned&quot;)&lt;/script&gt; &amp; Co",
    );
  });
});
