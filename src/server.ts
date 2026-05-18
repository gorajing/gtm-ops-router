/**
 * Minimal HTTP surface — zero web framework on purpose (fewer deps, nothing
 * to rot, first-principles). Three endpoints:
 *
 *   GET  /          live dashboard (self-contained HTML)
 *   GET  /metrics   metrics as JSON (machine-readable observability)
 *   GET  /healthz   liveness
 *   POST /deals     ingest one deal or an array — runs the pipeline
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { processBatch } from "./pipeline.js";
import type { Enricher } from "./enrich.js";
import type { Store } from "./store.js";
import type { Metrics } from "./types.js";

function dashboard(m: Metrics): string {
  const card = (label: string, value: string | number) =>
    `<div class="card"><div class="v">${value}</div><div class="l">${label}</div></div>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>GTM Ops Router</title>
<style>
 body{font:14px/1.5 ui-monospace,Menlo,monospace;background:#0b0d10;color:#e6e6e6;margin:0;padding:32px}
 h1{font-size:18px;letter-spacing:.5px}.sub{color:#8a93a2;margin-bottom:24px}
 .grid{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:24px}
 .card{background:#15191f;border:1px solid #232a33;border-radius:10px;padding:16px 20px;min-width:140px}
 .v{font-size:26px;font-weight:600}.l{color:#8a93a2;font-size:12px;margin-top:4px}
 table{border-collapse:collapse;width:100%;margin-top:8px}
 td,th{border:1px solid #232a33;padding:6px 10px;text-align:left}
 th{color:#8a93a2;font-weight:500}.tag{color:#7fd1b9}
</style></head><body>
<h1>GTM OPS ROUTER</h1>
<div class="sub">inbound → enrich → score → route · auto-refresh 5s</div>
<div class="grid">
 ${card("intake", m.intake)}
 ${card("routed", m.routed)}
 ${card("conversion", m.conversionPct + "%")}
 ${card("quarantined", m.quarantined)}
 ${card("quar. rate", m.quarantineRatePct + "%")}
 ${card("routed ARR", "$" + Math.round(m.routedArrUsd).toLocaleString("en-US"))}
 ${card("auto-handled", m.autoHandled)}
 ${card("p95 latency", m.latencyMsP95 + "ms")}
</div>
<table>
 <tr><th>route mix</th><th>n</th><th>human-gate flags</th><th>n</th></tr>
 <tr><td>nurture</td><td>${m.routeMix.nurture}</td><td>pricing_approval</td><td>${m.flags.pricing_approval}</td></tr>
 <tr><td>self_serve</td><td>${m.routeMix.self_serve}</td><td>regulated_review</td><td>${m.flags.regulated_review}</td></tr>
 <tr><td class="tag">human_assisted</td><td>${m.routeMix.human_assisted}</td><td></td><td></td></tr>
</table>
<table>
 <tr><th>quarantine code</th><th>count</th></tr>
 ${Object.entries(m.quarantineByCode)
   .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
   .join("")}
</table>
</body></html>`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(s);
}

export function startServer(
  store: Store,
  enricher: Enricher,
  port: number,
): ReturnType<typeof createServer> {
  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const url = req.url ?? "/";
      if (req.method === "GET" && url === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url === "/metrics") {
        json(res, 200, store.metrics());
        return;
      }
      if (req.method === "GET" && url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(dashboard(store.metrics()));
        return;
      }
      if (req.method === "POST" && url === "/deals") {
        void readBody(req)
          .then(async (raw) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              json(res, 400, { error: "body is not valid JSON" });
              return;
            }
            const list = Array.isArray(parsed) ? parsed : [parsed];
            const outcomes = await processBatch(list, store, enricher);
            json(res, 200, {
              processed: outcomes.length,
              routed: outcomes.filter((o) => o.ok).length,
              quarantined: outcomes.filter((o) => !o.ok).length,
              outcomes,
            });
          })
          .catch((err: unknown) => {
            json(res, 500, {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        return;
      }
      json(res, 404, { error: "not found", url });
    },
  );
  server.listen(port);
  return server;
}
