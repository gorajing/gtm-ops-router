#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCENE_DIR = resolve(ROOT, "scenes");

const scenes = [
  { id: "01-open", duration: 4.5, title: "opening" },
  { id: "02-leak", duration: 4.6, title: "handoff leak" },
  { id: "03-policy", duration: 4.8, title: "routing policy" },
  { id: "04-run", duration: 5.2, title: "run proof" },
  { id: "05-loop", duration: 5.0, title: "closed loop" },
  { id: "06-product", duration: 5.4, title: "live product" },
  { id: "07-audit", duration: 4.8, title: "audit" },
  { id: "08-close", duration: 4.4, title: "close" },
];

function baseCss() {
  return `
    :root {
      --paper: #f7f3ea;
      --paper-2: #eceff1;
      --ink: #151719;
      --muted: #59636f;
      --hair: #ced4da;
      --teal: #0b7773;
      --blue: #315aa8;
      --amber: #b86d16;
      --red: #a9363f;
      --green: #347c52;
      --violet: #6852a3;
      --white: #ffffff;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; }
    body {
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--paper);
      color: var(--ink);
      letter-spacing: 0;
    }
    .stage {
      position: relative;
      width: 1280px;
      height: 720px;
      padding: 46px 56px;
      overflow: hidden;
      background:
        linear-gradient(90deg, rgba(21,23,25,0.045) 1px, transparent 1px),
        linear-gradient(0deg, rgba(21,23,25,0.04) 1px, transparent 1px),
        var(--paper);
      background-size: 64px 64px;
    }
    .stage::after {
      content: "";
      position: absolute;
      inset: 18px;
      border: 1px solid rgba(21,23,25,0.18);
      pointer-events: none;
    }
    h1, h2, p { margin: 0; }
    h1 {
      max-width: 760px;
      font-size: 70px;
      line-height: 0.94;
      font-weight: 850;
    }
    h2 {
      max-width: 760px;
      font-size: 48px;
      line-height: 1;
      font-weight: 820;
    }
    .sub {
      max-width: 650px;
      margin-top: 18px;
      color: var(--muted);
      font-size: 21px;
      line-height: 1.36;
      font-weight: 520;
    }
    .topline {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 28px;
      font-size: 13px;
      font-weight: 760;
      text-transform: uppercase;
      color: var(--muted);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 5px 9px;
      border: 1px solid var(--ink);
      border-radius: 6px;
      background: var(--white);
      color: var(--ink);
      font-size: 13px;
      font-weight: 780;
      white-space: nowrap;
    }
    .pill.teal { border-color: var(--teal); color: var(--teal); }
    .pill.blue { border-color: var(--blue); color: var(--blue); }
    .pill.amber { border-color: var(--amber); color: var(--amber); }
    .pill.red { border-color: var(--red); color: var(--red); }
    .pill.green { border-color: var(--green); color: var(--green); }
    .card {
      border: 1px solid var(--hair);
      border-radius: 8px;
      background: rgba(255,255,255,0.86);
      box-shadow: 0 16px 30px rgba(21,23,25,0.08);
    }
    .mono {
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      letter-spacing: 0;
    }
    .caption {
      color: var(--muted);
      font-size: 14px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .fade-up { opacity: 0; transform: translateY(18px); animation: fadeUp 680ms ease forwards; }
    .fade-left { opacity: 0; transform: translateX(24px); animation: fadeLeft 720ms ease forwards; }
    .scale-in { opacity: 0; transform: scale(0.96); animation: scaleIn 660ms ease forwards; }
    .d1 { animation-delay: 160ms; }
    .d2 { animation-delay: 360ms; }
    .d3 { animation-delay: 620ms; }
    .d4 { animation-delay: 860ms; }
    .d5 { animation-delay: 1120ms; }
    .d6 { animation-delay: 1380ms; }
    @keyframes fadeUp { to { opacity: 1; transform: translateY(0); } }
    @keyframes fadeLeft { to { opacity: 1; transform: translateX(0); } }
    @keyframes scaleIn { to { opacity: 1; transform: scale(1); } }
    @keyframes drawLine { from { transform: scaleX(0); } to { transform: scaleX(1); } }
    @keyframes pulse { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
    @keyframes driftPacket {
      0% { offset-distance: 0%; opacity: 0; }
      8% { opacity: 1; }
      86% { opacity: 1; }
      100% { offset-distance: 100%; opacity: 0; }
    }
    @keyframes scanDown {
      0% { transform: translateY(-20px); opacity: 0; }
      20%, 70% { opacity: 1; }
      100% { transform: translateY(330px); opacity: 0; }
    }
    @keyframes dashboardPan {
      0%, 18% { transform: translateY(0); }
      70%, 100% { transform: translateY(-1120px); }
    }
    @keyframes blink { 0%, 48% { opacity: 1; } 49%, 100% { opacity: 0.15; } }
  `;
}

function shellRows(rows) {
  return rows
    .map((row, index) => `<div class="shell-row" style="animation-delay:${260 + index * 150}ms">${row}</div>`)
    .join("");
}

function metric(label, value, tone = "") {
  return `<div class="metric ${tone}"><strong>${value}</strong><span>${label}</span></div>`;
}

function sceneOpen() {
  return `
    <section class="stage scene-open">
      <div class="topline fade-up">
        <span class="pill teal">gorajing/gtm-ops-router</span>
        <span>control plane for AI-native revenue teams</span>
      </div>
      <h1 class="fade-up d1">Inbound demand, routed with receipts.</h1>
      <p class="sub fade-up d2">Every deal becomes accountable work or a visible exception. No guessed enrichment. No silent drops.</p>

      <div class="router-map scale-in d3">
        <div class="lane-label inbound-label">inbound</div>
        <div class="lane-label router-label">router ledger</div>
        <div class="lane-label queue-label">work queues</div>
        <div class="inbound-stack">
          <div class="deal-card">Ryder Digital <b>$120K</b></div>
          <div class="deal-card">Cargo Loop <b>$60K</b></div>
          <div class="deal-card muted-card">Mystery Logistics <b>?</b></div>
        </div>
        <div class="router-core">
          <div class="core-ring"></div>
          <div class="core-title">route()</div>
          <div class="core-sub">score + policy + receipts</div>
        </div>
        <div class="queue-stack">
          <div class="queue-card sales">Sales owner</div>
          <div class="queue-card finance">Finance flag</div>
          <div class="queue-card legal">Legal review</div>
          <div class="queue-card audit">Audit trail</div>
        </div>
        <div class="path path-a"></div>
        <div class="path path-b"></div>
        <div class="packet packet-a"></div>
        <div class="packet packet-b"></div>
      </div>

      <style>
        .scene-open h1 { width: 720px; }
        .router-map {
          position: absolute;
          right: 56px;
          bottom: 50px;
          width: 575px;
          height: 420px;
        }
        .lane-label {
          position: absolute;
          top: 0;
          font-size: 13px;
          font-weight: 850;
          text-transform: uppercase;
          color: var(--muted);
        }
        .inbound-label { left: 18px; }
        .router-label { left: 226px; }
        .queue-label { right: 72px; }
        .inbound-stack { position: absolute; left: 0; top: 48px; display: grid; gap: 12px; width: 175px; }
        .deal-card {
          min-height: 78px;
          padding: 16px;
          border: 1px solid var(--hair);
          border-left: 5px solid var(--blue);
          border-radius: 8px;
          background: var(--white);
          font-size: 18px;
          font-weight: 800;
          box-shadow: 0 14px 26px rgba(21,23,25,0.08);
        }
        .deal-card b { display: block; margin-top: 8px; font-size: 15px; color: var(--muted); }
        .muted-card { border-left-color: var(--red); color: var(--muted); }
        .router-core {
          position: absolute;
          left: 225px;
          top: 108px;
          width: 150px;
          height: 150px;
          display: grid;
          place-items: center;
          text-align: center;
          border: 2px solid var(--ink);
          border-radius: 8px;
          background: #fff8e8;
          z-index: 2;
        }
        .core-ring {
          position: absolute;
          inset: 14px;
          border: 2px dashed var(--teal);
          border-radius: 8px;
          animation: pulse 1800ms ease infinite;
        }
        .core-title { font-size: 26px; font-weight: 900; }
        .core-sub { margin-top: 40px; position: absolute; font-size: 12px; color: var(--muted); font-weight: 760; }
        .queue-stack { position: absolute; right: 0; top: 44px; display: grid; gap: 11px; width: 170px; }
        .queue-card {
          padding: 14px 15px;
          min-height: 54px;
          border: 1px solid var(--hair);
          border-radius: 8px;
          background: var(--white);
          font-size: 16px;
          font-weight: 850;
        }
        .sales { border-left: 5px solid var(--green); }
        .finance { border-left: 5px solid var(--amber); }
        .legal { border-left: 5px solid var(--violet); }
        .audit { border-left: 5px solid var(--red); }
        .path {
          position: absolute;
          height: 3px;
          background: var(--ink);
          transform-origin: left center;
          animation: drawLine 920ms ease forwards;
          opacity: 0.8;
        }
        .path-a { left: 176px; top: 180px; width: 49px; animation-delay: 880ms; }
        .path-b { left: 376px; top: 180px; width: 29px; animation-delay: 1180ms; }
        .packet {
          position: absolute;
          width: 16px;
          height: 16px;
          border-radius: 4px;
          background: var(--teal);
          offset-rotate: 0deg;
          animation: driftPacket 2700ms ease-in-out infinite;
        }
        .packet-a { offset-path: path("M 84 84 L 292 180 L 486 80"); animation-delay: 1400ms; }
        .packet-b { offset-path: path("M 82 178 L 292 180 L 486 194"); animation-delay: 1820ms; background: var(--amber); }
      </style>
    </section>
  `;
}

function sceneLeak() {
  return `
    <section class="stage scene-leak">
      <div class="topline fade-up">
        <span class="pill red">the expensive failure</span>
        <span>handoff ambiguity becomes invisible revenue drag</span>
      </div>
      <h2 class="fade-up d1">Bad GTM ops rarely explodes. It leaks.</h2>
      <p class="sub fade-up d2">A qualified account waits, a regulated deal reaches an AE without context, and an unknown company gets guessed into the funnel.</p>

      <div class="leak-grid">
        <div class="leak-card card fade-up d3">
          <span class="leak-tag">hidden</span>
          <strong>$150K regulated deal</strong>
          <p>AE receives the handoff before finance and legal are flagged.</p>
        </div>
        <div class="leak-card card fade-up d4">
          <span class="leak-tag">hidden</span>
          <strong>unknown company</strong>
          <p>Enrichment uncertainty gets treated like data instead of an exception.</p>
        </div>
        <div class="leak-card card fade-up d5">
          <span class="leak-tag">hidden</span>
          <strong>quarter-close surprise</strong>
          <p>Engagement exists in Sales, but routing cannot measure it.</p>
        </div>
      </div>

      <div class="boundary card scale-in d4">
        <div class="caption">router boundary</div>
        <div class="boundary-row"><span>quarantine</span><b>visible</b></div>
        <div class="boundary-row"><span>owner / flags</span><b>typed</b></div>
        <div class="boundary-row"><span>engagement</span><b>measured</b></div>
        <div class="boundary-row"><span>commercial truth</span><b>not auto-written</b></div>
      </div>
      <div class="scan-line"></div>

      <style>
        .scene-leak h2 { width: 690px; }
        .leak-grid {
          position: absolute;
          left: 56px;
          bottom: 58px;
          width: 650px;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 14px;
        }
        .leak-card { padding: 18px; min-height: 178px; }
        .leak-card strong { display: block; margin-top: 18px; font-size: 23px; line-height: 1.05; }
        .leak-card p { margin-top: 13px; color: var(--muted); font-size: 15px; line-height: 1.34; }
        .leak-tag {
          display: inline-block;
          padding: 4px 7px;
          border: 1px solid var(--red);
          border-radius: 6px;
          color: var(--red);
          font-size: 12px;
          font-weight: 850;
          text-transform: uppercase;
        }
        .boundary {
          position: absolute;
          right: 74px;
          top: 130px;
          width: 386px;
          padding: 22px;
          background: #fffaf2;
        }
        .boundary-row {
          display: flex;
          justify-content: space-between;
          gap: 20px;
          padding: 18px 0;
          border-bottom: 1px solid var(--hair);
          font-size: 19px;
          font-weight: 760;
        }
        .boundary-row:last-child { border-bottom: 0; }
        .boundary-row span { color: var(--muted); }
        .boundary-row b { color: var(--teal); text-align: right; }
        .scan-line {
          position: absolute;
          right: 83px;
          top: 134px;
          width: 368px;
          height: 3px;
          background: var(--teal);
          animation: scanDown 3800ms ease-in-out infinite;
          opacity: 0.8;
        }
      </style>
    </section>
  `;
}

function scenePolicy() {
  return `
    <section class="stage scene-policy">
      <div class="topline fade-up">
        <span class="pill blue">src/route.ts</span>
        <span>business judgment as typed policy</span>
      </div>
      <h2 class="fade-up d1">The close stays human. The prep gets automated.</h2>
      <p class="sub fade-up d2">The router assigns work, owners, and review flags without pretending to make finance or legal decisions.</p>

      <div class="policy-board">
        <div class="gate gate-human scale-in d3">
          <span>$10K</span>
          <b>human gate</b>
          <small>buyers need trust above this size</small>
        </div>
        <div class="gate gate-finance scale-in d4">
          <span>$50K</span>
          <b>finance flag</b>
          <small>pricing approval before close</small>
        </div>
        <div class="gate gate-legal scale-in d5">
          <span>EU / UK / regulated</span>
          <b>legal flag</b>
          <small>review surfaced early</small>
        </div>
      </div>

      <div class="code-panel card fade-left d3">
        <div class="caption">route outcome</div>
        <pre class="mono"><span class="kw">human_assisted</span> {
  salesOwner: "ae.morgan",
  financeFlag: "pricing_approval",
  legalFlag: "regulated_review",
  slaHours: 4
}</pre>
      </div>

      <div class="route-split fade-up d5">
        <div class="split-item nurture"><b>nurture</b><span>no rep time</span></div>
        <div class="split-item self"><b>self_serve</b><span>24h SLA</span></div>
        <div class="split-item human"><b>human_assisted</b><span>owner + flags</span></div>
      </div>

      <style>
        .scene-policy h2 { width: 760px; }
        .policy-board {
          position: absolute;
          left: 62px;
          bottom: 70px;
          width: 700px;
          height: 222px;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
        }
        .gate {
          position: relative;
          padding: 22px;
          border: 2px solid var(--ink);
          border-radius: 8px;
          background: var(--white);
          min-height: 210px;
        }
        .gate::before {
          content: "";
          position: absolute;
          left: 22px;
          right: 22px;
          bottom: 68px;
          height: 3px;
          background: currentColor;
          transform-origin: left center;
          animation: drawLine 900ms ease forwards;
          animation-delay: 1200ms;
        }
        .gate-human { color: var(--blue); }
        .gate-finance { color: var(--amber); }
        .gate-legal { color: var(--violet); }
        .gate span { display: block; font-size: 32px; font-weight: 900; color: currentColor; line-height: 1; }
        .gate b { display: block; margin-top: 22px; font-size: 22px; color: var(--ink); }
        .gate small { display: block; margin-top: 54px; color: var(--muted); font-size: 14px; line-height: 1.28; }
        .code-panel {
          position: absolute;
          right: 60px;
          top: 130px;
          width: 410px;
          padding: 20px;
          background: #161719;
          color: #f6f4ea;
          border-color: #222;
        }
        .code-panel pre { margin: 16px 0 0; font-size: 18px; line-height: 1.45; }
        .kw { color: #8bd2c7; }
        .route-split {
          position: absolute;
          right: 60px;
          bottom: 76px;
          width: 410px;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 10px;
        }
        .split-item {
          padding: 13px 11px;
          min-height: 92px;
          border: 1px solid var(--hair);
          border-radius: 8px;
          background: var(--white);
        }
        .split-item b { display: block; font-size: 15px; }
        .split-item span { display: block; margin-top: 11px; color: var(--muted); font-size: 12px; line-height: 1.2; }
        .nurture { border-top: 5px solid var(--red); }
        .self { border-top: 5px solid var(--green); }
        .human { border-top: 5px solid var(--blue); }
      </style>
    </section>
  `;
}

function sceneRun() {
  return `
    <section class="stage scene-run">
      <div class="topline fade-up">
        <span class="pill green">real run</span>
        <span>isolated db: data/router.video-demo.db</span>
      </div>
      <h2 class="fade-up d1">The demo is a ledger run, not a mockup.</h2>
      <p class="sub fade-up d2">The same command writes routes, demo outcomes, engagement events, and dry-run HubSpot / Slack receipts.</p>

      <div class="metrics-grid scale-in d3">
        ${metric("intake", "13")}
        ${metric("routed", "9")}
        ${metric("quarantined", "4", "red")}
        ${metric("routed ARR", "$508K", "blue")}
        ${metric("auto-handled", "3", "green")}
        ${metric("engagement events", "8", "teal")}
      </div>

      <div class="receipt card fade-left d4">
        <div class="caption">command receipt</div>
        <div class="shell mono">
          ${shellRows([
            '<span class="prompt">$</span> npm run run -- data/inbound.seed.jsonl',
            '&nbsp;&nbsp;--integrations --demo-outcomes --demo-engagement',
            '[demo outcomes] Ryder deploys, lands, expands by $35k',
            '[demo engagement] imported: 8 events recorded, 1 commercial signal',
            'route mix: nurture 1 | self_serve 2 | human_assisted 6',
            'quarantine: schema_invalid 1 | unresolved 2 | insufficient_data 1',
            'latency: p50 1ms | p95 9ms'
          ])}
        </div>
      </div>

      <style>
        .scene-run h2 { width: 720px; }
        .metrics-grid {
          position: absolute;
          left: 56px;
          bottom: 74px;
          width: 560px;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
        }
        .metric {
          min-height: 116px;
          padding: 18px;
          border: 1px solid var(--hair);
          border-radius: 8px;
          background: var(--white);
          border-top: 5px solid var(--ink);
        }
        .metric strong { display: block; font-size: 42px; line-height: 1; }
        .metric span { display: block; margin-top: 15px; color: var(--muted); font-size: 14px; font-weight: 800; text-transform: uppercase; }
        .metric.red { border-top-color: var(--red); }
        .metric.blue { border-top-color: var(--blue); }
        .metric.green { border-top-color: var(--green); }
        .metric.teal { border-top-color: var(--teal); }
        .receipt {
          position: absolute;
          right: 58px;
          bottom: 74px;
          width: 560px;
          padding: 22px;
          background: #171819;
          border-color: #23262a;
          color: #f7f3ea;
        }
        .receipt .caption { color: #a7b0bb; }
        .shell { margin-top: 16px; font-size: 16px; line-height: 1.42; }
        .shell-row { opacity: 0; transform: translateY(10px); animation: fadeUp 500ms ease forwards; }
        .prompt { color: #8bd2c7; font-weight: 900; }
      </style>
    </section>
  `;
}

function sceneLoop() {
  return `
    <section class="stage scene-loop">
      <div class="topline fade-up">
        <span class="pill amber">closed loop</span>
        <span>sales engagement becomes router measurement</span>
      </div>
      <h2 class="fade-up d1">The seam is explicit, so the truth stays separated.</h2>
      <p class="sub fade-up d2">Sales can report engagement. It cannot silently become router commercial truth.</p>

      <div class="loop-map scale-in d3">
        <div class="system router">
          <b>gtm-ops-router</b>
          <span>route + ledger + measurement</span>
        </div>
        <div class="system sales">
          <b>gorajing/sales</b>
          <span>evidence-grounded outreach</span>
        </div>
        <div class="contract forward">sales-handoff.v1</div>
        <div class="contract reverse">sales.engagement-feedback.v1</div>
      </div>

      <div class="authority card fade-left d4">
        <div class="caption">source authority tiers</div>
        <div class="authority-row"><span>Observed by Sales</span><b>$120K meetings influenced</b></div>
        <div class="authority-row"><span>Reported by Sales</span><b>$120K commercial signals</b></div>
        <div class="authority-row"><span>Authoritative in Router</span><b>$0 pipeline influenced</b></div>
      </div>

      <div class="boundary-quote fade-up d5 mono">trace.boundary = "observed_engagement_not_router_truth"</div>

      <style>
        .scene-loop h2 { width: 760px; }
        .loop-map {
          position: absolute;
          left: 62px;
          bottom: 88px;
          width: 560px;
          height: 290px;
        }
        .system {
          position: absolute;
          width: 230px;
          min-height: 118px;
          padding: 22px;
          border: 2px solid var(--ink);
          border-radius: 8px;
          background: var(--white);
        }
        .system b { display: block; font-size: 24px; line-height: 1.05; }
        .system span { display: block; margin-top: 12px; color: var(--muted); font-size: 15px; line-height: 1.3; }
        .router { left: 0; top: 0; border-left: 7px solid var(--teal); }
        .sales { right: 0; bottom: 0; border-left: 7px solid var(--blue); }
        .contract {
          position: absolute;
          left: 215px;
          width: 205px;
          padding: 10px 12px;
          border: 1px solid var(--hair);
          border-radius: 8px;
          background: #fff8e8;
          font-size: 14px;
          font-weight: 850;
          text-align: center;
        }
        .forward { top: 44px; }
        .reverse { bottom: 44px; color: var(--teal); }
        .contract::before {
          content: "";
          position: absolute;
          top: 50%;
          left: -78px;
          width: 75px;
          height: 3px;
          background: var(--ink);
          transform-origin: left center;
          animation: drawLine 950ms ease forwards;
          animation-delay: 900ms;
        }
        .contract::after {
          content: "";
          position: absolute;
          top: 50%;
          right: -78px;
          width: 75px;
          height: 3px;
          background: var(--ink);
          transform-origin: left center;
          animation: drawLine 950ms ease forwards;
          animation-delay: 1200ms;
        }
        .authority {
          position: absolute;
          right: 62px;
          top: 154px;
          width: 470px;
          padding: 22px;
        }
        .authority-row {
          display: flex;
          justify-content: space-between;
          gap: 18px;
          padding: 18px 0;
          border-bottom: 1px solid var(--hair);
          font-size: 17px;
        }
        .authority-row:last-child { border-bottom: 0; }
        .authority-row span { color: var(--muted); font-weight: 760; }
        .authority-row b { text-align: right; font-size: 18px; }
        .boundary-quote {
          position: absolute;
          right: 62px;
          bottom: 86px;
          width: 470px;
          padding: 16px;
          border: 1px solid var(--teal);
          border-radius: 8px;
          background: #eef8f6;
          color: var(--teal);
          font-size: 17px;
          font-weight: 800;
        }
      </style>
    </section>
  `;
}

function sceneProduct() {
  return `
    <section class="stage scene-product">
      <div class="topline fade-up">
        <span class="pill blue">live dashboard</span>
        <span>/state JSON before browser polish</span>
      </div>
      <h2 class="fade-up d1">The UI is a readable surface on the same store.</h2>
      <p class="sub fade-up d2">The product shows routes, exceptions, lifecycle, and full-funnel attribution without hiding uncertainty.</p>

      <div class="browser-frame card scale-in d3">
        <div class="browser-top"><span></span><span></span><span></span><b>localhost:8790</b></div>
        <div class="screen"><img src="../proof/dashboard-live.png" alt="Live GTM Ops Router dashboard"></div>
      </div>

      <div class="funnel-frame card fade-left d4">
        <img src="../proof/full-funnel-panel.png" alt="Full-funnel Attribution panel">
      </div>

      <div class="callout one fade-up d4">4 of 9 deals have engagement data</div>
      <div class="callout two fade-up d5">missing = unknown, not negative</div>
      <div class="callout three fade-up d6">commercial signals need confirmation</div>

      <style>
        .scene-product h2 { width: 730px; }
        .browser-frame {
          position: absolute;
          left: 54px;
          bottom: 50px;
          width: 706px;
          height: 420px;
          overflow: hidden;
          background: var(--white);
        }
        .browser-top {
          height: 35px;
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 0 13px;
          border-bottom: 1px solid var(--hair);
          background: #f3f5f6;
        }
        .browser-top span {
          width: 10px;
          height: 10px;
          border-radius: 999px;
          background: var(--hair);
        }
        .browser-top b { margin-left: 12px; font-size: 12px; color: var(--muted); }
        .screen { height: 385px; overflow: hidden; }
        .screen img {
          width: 706px;
          height: auto;
          display: block;
          animation: dashboardPan 5200ms ease-in-out forwards;
        }
        .funnel-frame {
          position: absolute;
          right: 54px;
          bottom: 72px;
          width: 400px;
          height: 430px;
          overflow: hidden;
          background: var(--white);
        }
        .funnel-frame img {
          display: block;
          width: 400px;
          height: auto;
        }
        .callout {
          position: absolute;
          right: 470px;
          padding: 11px 13px;
          border: 1px solid var(--ink);
          border-radius: 8px;
          background: #fff8e8;
          font-size: 16px;
          font-weight: 850;
          box-shadow: 0 14px 26px rgba(21,23,25,0.08);
          max-width: 250px;
        }
        .one { bottom: 396px; color: var(--amber); }
        .two { bottom: 321px; color: var(--red); }
        .three { bottom: 244px; color: var(--teal); }
      </style>
    </section>
  `;
}

function sceneAudit() {
  return `
    <section class="stage scene-audit">
      <div class="topline fade-up">
        <span class="pill green">audit gates</span>
        <span>the proof is reproducible</span>
      </div>
      <h2 class="fade-up d1">Independent checks keep the story honest.</h2>
      <p class="sub fade-up d2">The repo verifies the TypeScript surface, Python audit invariants, and reverse-contract drift guard.</p>

      <div class="audit-card card scale-in d3">
        <div class="caption">python3 ops_audit.py --db data/router.video-demo.db</div>
        <div class="audit-result">RESULT: PASS</div>
        <div class="audit-grid">
          <div><span>orphans</span><b>0</b></div>
          <div><span>projection conflicts</span><b>0</b></div>
          <div><span>stuck rows</span><b>0</b></div>
          <div><span>breaches</span><b>0</b></div>
        </div>
      </div>

      <div class="checks fade-left d4">
        <div class="check-row"><b>npm test</b><span>19 files / 361 tests</span></div>
        <div class="check-row"><b>npm run typecheck</b><span>tsc --noEmit passed</span></div>
        <div class="check-row"><b>python unittest</b><span>28 tests passed</span></div>
        <div class="check-row"><b>sample drift guard</b><span>regenerated with no diff</span></div>
      </div>

      <div class="pulse-led"></div>

      <style>
        .scene-audit h2 { width: 720px; }
        .audit-card {
          position: absolute;
          left: 58px;
          bottom: 80px;
          width: 550px;
          padding: 24px;
          background: #101214;
          color: #f7f3ea;
          border-color: #202327;
        }
        .audit-card .caption { color: #aab2bd; }
        .audit-result {
          margin-top: 28px;
          font-size: 54px;
          font-weight: 900;
          color: #99d9ad;
        }
        .audit-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 10px;
          margin-top: 24px;
        }
        .audit-grid div {
          min-height: 78px;
          padding: 12px;
          border: 1px solid rgba(255,255,255,0.16);
          border-radius: 8px;
        }
        .audit-grid span { display: block; color: #aab2bd; font-size: 12px; font-weight: 760; text-transform: uppercase; }
        .audit-grid b { display: block; margin-top: 10px; font-size: 30px; }
        .checks {
          position: absolute;
          right: 70px;
          bottom: 82px;
          width: 460px;
          display: grid;
          gap: 12px;
        }
        .check-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 20px;
          min-height: 62px;
          padding: 14px 17px;
          border: 1px solid var(--hair);
          border-left: 6px solid var(--green);
          border-radius: 8px;
          background: var(--white);
          box-shadow: 0 12px 22px rgba(21,23,25,0.06);
        }
        .check-row b { font-size: 17px; }
        .check-row span { color: var(--muted); font-size: 15px; text-align: right; }
        .pulse-led {
          position: absolute;
          left: 82px;
          bottom: 336px;
          width: 18px;
          height: 18px;
          border-radius: 999px;
          background: var(--green);
          animation: pulse 950ms ease infinite;
        }
      </style>
    </section>
  `;
}

function sceneClose() {
  return `
    <section class="stage scene-close">
      <div class="topline fade-up">
        <span class="pill teal">gtm-ops-router</span>
        <span>replace ambiguity with an operating ledger</span>
      </div>
      <h1 class="fade-up d1">Action can be automated. Claims still need evidence.</h1>
      <p class="sub fade-up d2">That is the product boundary: route the work, preserve the receipts, and let the audit say whether the loop is healthy.</p>

      <div class="final-commands card fade-up d3 mono">
        <div><span>$</span> npm test</div>
        <div><span>$</span> npm run run -- data/inbound.seed.jsonl --demo-engagement</div>
        <div><span>$</span> python3 ops_audit.py --db data/router.db</div>
        <i></i>
      </div>

      <div class="final-tags fade-up d4">
        <span class="pill red">no silent drops</span>
        <span class="pill amber">no guessed enrichment</span>
        <span class="pill blue">no hidden sync</span>
        <span class="pill green">audit-first</span>
      </div>

      <style>
        .scene-close h1 { max-width: 880px; font-size: 66px; }
        .final-commands {
          position: absolute;
          left: 58px;
          bottom: 112px;
          width: 760px;
          padding: 20px 22px;
          background: #171819;
          border-color: #222;
          color: #f7f3ea;
          font-size: 18px;
          line-height: 1.72;
        }
        .final-commands span { color: #8bd2c7; font-weight: 900; }
        .final-commands i {
          display: inline-block;
          width: 10px;
          height: 22px;
          margin-left: 4px;
          vertical-align: -4px;
          background: #8bd2c7;
          animation: blink 750ms linear infinite;
        }
        .final-tags {
          position: absolute;
          right: 64px;
          bottom: 114px;
          width: 292px;
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          justify-content: flex-end;
        }
      </style>
    </section>
  `;
}

const sceneHtml = {
  "01-open": sceneOpen,
  "02-leak": sceneLeak,
  "03-policy": scenePolicy,
  "04-run": sceneRun,
  "05-loop": sceneLoop,
  "06-product": sceneProduct,
  "07-audit": sceneAudit,
  "08-close": sceneClose,
};

function wrap(id, body) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${id}</title>
    <style>${baseCss()}</style>
  </head>
  <body>${body}</body>
</html>
`;
}

async function main() {
  await mkdir(SCENE_DIR, { recursive: true });
  for (const scene of scenes) {
    const render = sceneHtml[scene.id];
    if (!render) throw new Error(`Missing scene renderer for ${scene.id}`);
    await writeFile(resolve(SCENE_DIR, `${scene.id}.html`), wrap(scene.id, render()), "utf8");
  }
  const timeline = {
    output: "../demo.mp4",
    width: 1280,
    height: 720,
    fps: 30,
    transition: 0.42,
    fade_in: 0.18,
    fade_out: 0.45,
    clips: scenes.map((scene) => ({
      id: scene.id,
      file: `clips/${scene.id}.mp4`,
      duration: scene.duration,
    })),
  };
  await writeFile(resolve(ROOT, "timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`, "utf8");
  console.log(`Wrote ${scenes.length} scenes and timeline.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
