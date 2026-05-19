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
import type { Metrics, PipelineEvent, Quarantine, RoutedDeal } from "./types.js";

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

function pctWidth(n: number): string {
  return Math.max(0, Math.min(100, n)).toFixed(1) + "%";
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function routeLabel(d: RoutedDeal): string {
  if (d.route.kind !== "human_assisted") return d.route.kind;
  return (
    `human -> ${d.route.salesOwner}` +
    (d.route.financeFlag ? " +finance" : "") +
    (d.route.legalFlag ? " +legal" : "")
  );
}

function dashboard(
  m: Metrics,
  routed: RoutedDeal[],
  quarantined: Quarantine[],
  events: PipelineEvent[],
): string {
  const card = (label: string, value: string | number, detail = "") =>
    `<div class="card"><div class="v">${value}</div><div class="l">${label}</div>${detail ? `<div class="d">${detail}</div>` : ""}</div>`;
  const maxRoute = Math.max(...Object.values(m.routeMix), 1);
  const maxQuarantine = Math.max(...Object.values(m.quarantineByCode), 1);
  const firstEvents = events.slice(0, 8);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<title>GTM Ops Router</title>
<style>
 :root{--bg:#f6f7fb;--ink:#15171c;--muted:#596376;--line:#d9dee8;--panel:#fff;--panel2:#edf1f6;--green:#087a55;--amber:#a45d13;--red:#b42318;--blue:#2563eb}
 *{box-sizing:border-box}
 body{font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink);margin:0}
 .shell{max-width:1280px;margin:0 auto;padding:28px}
 header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;border-bottom:2px solid var(--ink);padding-bottom:18px;margin-bottom:20px}
 h1{font-size:30px;line-height:1;margin:0;letter-spacing:0;font-weight:700}.sub{color:var(--muted);margin-top:8px}
 .stamp{font:12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;border:1px solid var(--ink);padding:8px 10px;background:#fff}
 .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:16px}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:14px 16px;min-height:98px}
 .v{font-size:30px;font-weight:700;line-height:1.05}.l{color:var(--muted);font-size:12px;margin-top:8px;text-transform:uppercase;letter-spacing:.04em}.d{color:var(--muted);font-size:12px;margin-top:6px}
 .band{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:16px 0}
 section{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:16px}
 h2{font-size:15px;margin:0 0 12px;text-transform:uppercase;letter-spacing:.05em}
 table{border-collapse:collapse;width:100%;font:13px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace}
 td,th{border-top:1px solid var(--line);padding:8px 8px;text-align:left;vertical-align:top}
 th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
 .bar{height:9px;background:var(--panel2);border-radius:999px;overflow:hidden;margin-top:4px}.fill{height:100%;background:var(--blue)}
 .risk{color:var(--red)}.ok{color:var(--green)}.warn{color:var(--amber)}.muted{color:var(--muted)}.tag{font-weight:700;color:var(--green)}
 .pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 7px;background:#fff}
 .empty{color:var(--muted);padding:18px;border:1px dashed var(--line);border-radius:6px;background:#fff}
 .events{display:grid;gap:7px}.event{font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;background:#fff;border:1px solid var(--line);border-radius:5px;padding:8px}
 .wide{overflow-x:auto}.wide table{min-width:720px}
 .ledger table{table-layout:fixed;font-size:12px}.ledger td{overflow-wrap:anywhere}
 .ledger th:nth-child(1),.ledger td:nth-child(1){width:24%}.ledger th:nth-child(2),.ledger td:nth-child(2){width:13%}.ledger th:nth-child(3),.ledger td:nth-child(3){width:31%}.ledger th:nth-child(4),.ledger td:nth-child(4){width:32%}
 @media(max-width:900px){.grid,.band{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column}.shell{padding:18px}table{font-size:12px}}
 @media(max-width:600px){.ledger table,.ledger tbody,.ledger tr,.ledger td{display:block;width:100%}.ledger tr:first-child{display:none}.ledger tr{border-top:1px solid var(--line);padding:10px 0}.ledger td{border-top:0;overflow-wrap:break-word;padding:3px 0}.ledger th:nth-child(1),.ledger td:nth-child(1),.ledger th:nth-child(2),.ledger td:nth-child(2),.ledger th:nth-child(3),.ledger td:nth-child(3),.ledger th:nth-child(4),.ledger td:nth-child(4){width:100%}.ledger td::before{color:var(--muted);display:block;font:10px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px}.ledger td:nth-child(1)::before{content:"record"}.ledger td:nth-child(2)::before{content:"stage"}.ledger td:nth-child(3)::before{content:"code"}.ledger td:nth-child(4)::before{content:"reason"}}
</style></head><body>
<div class="shell">
<header>
 <div>
  <h1>GTM Ops Router</h1>
  <div class="sub">Inbound deals routed across sales, finance, and legal with quarantine instead of silent drops.</div>
 </div>
 <div class="stamp">LIVE SQLITE VIEW<br>auto-refresh 5s</div>
</header>
<div class="grid">
 ${card("routed ARR", money(m.routedArrUsd), `${money(m.humanRoutedArrUsd)} needs human ownership`)}
 ${card("auto-handled", m.autoHandled, "nurture + self-serve, no rep touch")}
 ${card("routed", m.routed, `${m.conversionPct}% conversion from intake`)}
 ${card("quarantined", m.quarantined, `${m.quarantineRatePct}% loud failure rate`)}
 ${card("intake", m.intake)}
 ${card("finance flags", m.flags.pricing_approval)}
 ${card("legal flags", m.flags.regulated_review)}
 ${card("p95 latency", m.latencyMsP95 + "ms")}
</div>
<div class="band">
 <section>
  <h2>Route Mix</h2>
  <table>
   ${Object.entries(m.routeMix)
     .map(
       ([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td><td><div class="bar"><div class="fill" style="width:${pctWidth((v / maxRoute) * 100)}"></div></div></td></tr>`,
     )
     .join("")}
  </table>
 </section>
 <section>
  <h2>Quarantine Codes</h2>
  <table>
   ${Object.entries(m.quarantineByCode)
     .map(
       ([k, v]) => `<tr><td class="${v ? "risk" : "ok"}">${escapeHtml(k)}</td><td>${v}</td><td><div class="bar"><div class="fill" style="width:${pctWidth((v / maxQuarantine) * 100)}"></div></div></td></tr>`,
     )
     .join("")}
  </table>
 </section>
</div>
<section class="wide">
 <h2>Routed Deals</h2>
 ${
   routed.length === 0
     ? `<div class="empty">No routed deals in this database yet.</div>`
     : `<table><tr><th>Deal</th><th>Company</th><th>ARR</th><th>Score</th><th>Route</th></tr>${routed
         .map(
           (d) => `<tr><td>${escapeHtml(d.id)}</td><td>${escapeHtml(d.company)}</td><td>${money(d.dealUSD)}</td><td>${d.score.total.toFixed(2)}</td><td><span class="pill">${escapeHtml(routeLabel(d))}</span></td></tr>`,
         )
         .join("")}</table>`
 }
</section>
<div class="band">
 <section class="ledger">
  <h2>Quarantine Ledger</h2>
  ${
    quarantined.length === 0
      ? `<div class="empty">No quarantined records.</div>`
      : `<table><tr><th>Record</th><th>Stage</th><th>Code</th><th>Reason</th></tr>${quarantined
          .map(
            (q) => `<tr><td>${escapeHtml(q.dealId)}</td><td>${escapeHtml(q.stage)}</td><td class="risk">${escapeHtml(q.code)}</td><td>${escapeHtml(q.reason)}</td></tr>`,
          )
          .join("")}</table>`
  }
 </section>
 <section>
  <h2>Event Trail</h2>
  ${
    firstEvents.length === 0
      ? `<div class="empty">No events recorded.</div>`
      : `<div class="events">${firstEvents
          .map(
            (e) => `<div class="event"><span class="warn">${escapeHtml(e.from)} -> ${escapeHtml(e.to)}</span> ${escapeHtml(e.detail)}<br><span class="muted">${escapeHtml(e.ts)}</span></div>`,
          )
          .join("")}</div>`
  }
 </section>
</div>
</div>
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
      if (req.method === "GET" && url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && url === "/metrics") {
        json(res, 200, store.metrics());
        return;
      }
      if (req.method === "GET" && url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        const firstRouted = store.routed()[0];
        res.end(
          dashboard(
            store.metrics(),
            store.routed(),
            store.quarantined(),
            firstRouted ? store.events(firstRouted.id) : store.events(),
          ),
        );
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
