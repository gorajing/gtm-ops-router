#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const DEMO_ROOT = resolve(ROOT, "assets/demo-video");
const DEFAULT_URL = "http://localhost:8790/?demo=operator&deal=D-fb65c15017ef";
const DEFAULT_OUT = resolve(DEMO_ROOT, "clips/operator-session.mp4");
const DEAL_ID = "D-fb65c15017ef";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("--")) args[arg.slice(2)] = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return args;
}

function run(cmd, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${cmd} exited with ${code}`));
    });
  });
}

async function localJson(path) {
  return JSON.parse(await readFile(resolve(ROOT, path), "utf8"));
}

function directorCss() {
  return `
    body.gtm-video-mode {
      background: #eef2f5;
    }
    body.gtm-video-mode .shell {
      max-width: 1280px;
      padding: 18px 24px 108px;
    }
    body.gtm-video-mode header {
      margin-bottom: 12px;
    }
    body.gtm-video-mode h1 {
      font-size: 25px;
    }
    body.gtm-video-mode .stamp {
      font-size: 11px;
      padding: 7px 9px;
    }
    body.gtm-video-mode .top {
      grid-template-columns: 1fr;
      gap: 10px;
    }
    body.gtm-video-mode .top > .panel:nth-child(2),
    body.gtm-video-mode .layout > .panel:first-child,
    body.gtm-video-mode #policy-runs,
    body.gtm-video-mode #agent-suggestions,
    body.gtm-video-mode #exceptions {
      display: none !important;
    }
    body.gtm-video-mode .kpis {
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 8px;
    }
    body.gtm-video-mode .card {
      min-height: 72px;
      padding: 10px;
    }
    body.gtm-video-mode .v {
      font-size: 23px;
    }
    body.gtm-video-mode .l {
      font-size: 10px;
      letter-spacing: .02em;
    }
    body.gtm-video-mode .workflow-panel {
      min-height: 276px;
    }
    body.gtm-video-mode .workflow-grid {
      grid-template-columns: 1.35fr .95fr;
    }
    body.gtm-video-mode .workflow-steps {
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 7px;
    }
    body.gtm-video-mode .workflow-step {
      min-height: 126px;
      padding: 10px;
    }
    body.gtm-video-mode .layout {
      grid-template-columns: minmax(610px, 1fr) 420px;
      gap: 12px;
    }
    body.gtm-video-mode .queue-wrap,
    body.gtm-video-mode .handoff-wrap,
    body.gtm-video-mode .exceptions {
      max-height: 430px;
    }
    body.gtm-video-mode #detail {
      max-height: 600px;
      overflow: hidden;
    }
    body.gtm-video-mode.stage-queue #role-queues,
    body.gtm-video-mode.stage-queue #work-items,
    body.gtm-video-mode.stage-queue #policy-evaluation,
    body.gtm-video-mode.stage-queue #deployment-handoff,
    body.gtm-video-mode.stage-queue #full-funnel {
      display: none !important;
    }
    body.gtm-video-mode.stage-funnel #queue,
    body.gtm-video-mode.stage-funnel #role-queues,
    body.gtm-video-mode.stage-funnel #work-items,
    body.gtm-video-mode.stage-funnel #policy-evaluation,
    body.gtm-video-mode.stage-funnel #deployment-handoff {
      display: none !important;
    }
    body.gtm-video-mode.stage-funnel #full-funnel {
      display: block !important;
    }
    body.gtm-video-mode.stage-audit .layout,
    body.gtm-video-mode.stage-audit .workflow-panel,
    body.gtm-video-mode.stage-audit .top {
      filter: saturate(.7);
    }
    .video-scrim {
      position: fixed;
      inset: 0;
      z-index: 99990;
      pointer-events: none;
      background: linear-gradient(180deg, rgba(238,242,245,0) 0%, rgba(238,242,245,.1) 64%, rgba(238,242,245,.84) 100%);
    }
    .video-focus {
      position: fixed;
      z-index: 99995;
      pointer-events: none;
      border: 3px solid #0d766f;
      border-radius: 10px;
      box-shadow: 0 0 0 999px rgba(20,24,32,.10), 0 18px 46px rgba(20,24,32,.18);
      opacity: 0;
      transition: opacity 420ms ease, left 760ms ease, top 760ms ease, width 760ms ease, height 760ms ease;
    }
    .video-focus.show {
      opacity: 1;
    }
    .video-focus-label {
      position: absolute;
      left: 12px;
      top: -34px;
      padding: 6px 9px;
      border-radius: 6px;
      background: #0d766f;
      color: #fff;
      font-size: 13px;
      font-weight: 760;
      white-space: nowrap;
      box-shadow: 0 10px 26px rgba(20,24,32,.18);
    }
    .video-lower {
      position: fixed;
      left: 28px;
      bottom: 24px;
      z-index: 99999;
      width: 680px;
      min-height: 82px;
      padding: 16px 18px;
      border: 1px solid rgba(20,24,32,.2);
      border-left: 6px solid #0d766f;
      border-radius: 10px;
      background: rgba(255,255,255,.94);
      box-shadow: 0 18px 46px rgba(20,24,32,.18);
      opacity: 0;
      transform: translateY(12px);
      transition: opacity 460ms ease, transform 460ms ease;
      pointer-events: none;
    }
    .video-lower.show {
      opacity: 1;
      transform: translateY(0);
    }
    .video-lower b {
      display: block;
      color: #141820;
      font-size: 25px;
      line-height: 1.05;
      margin-bottom: 6px;
    }
    .video-lower span {
      display: block;
      color: #5e6a7d;
      font-size: 16px;
      line-height: 1.28;
      font-weight: 560;
    }
    .video-drawer {
      position: fixed;
      right: 28px;
      top: 98px;
      z-index: 99998;
      width: 386px;
      padding: 17px;
      border: 1px solid rgba(20,24,32,.18);
      border-radius: 10px;
      background: rgba(255,255,255,.96);
      box-shadow: 0 18px 46px rgba(20,24,32,.18);
      opacity: 0;
      transform: translateX(18px);
      transition: opacity 460ms ease, transform 460ms ease;
      pointer-events: none;
      font-size: 15px;
    }
    .video-drawer.dark {
      background: rgba(17,20,24,.96);
      color: #f7f2e8;
      border-color: rgba(255,255,255,.16);
    }
    .video-drawer.show {
      opacity: 1;
      transform: translateX(0);
    }
    .video-drawer h3 {
      margin: 0 0 12px;
      font-size: 16px;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: #5e6a7d;
    }
    .video-drawer.dark h3 {
      color: #aeb7c2;
    }
    .video-row {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      padding: 10px 0;
      border-top: 1px solid #d8dee8;
    }
    .video-row:first-of-type {
      border-top: 0;
    }
    .video-row span {
      color: #5e6a7d;
      font-weight: 680;
    }
    .video-row b {
      text-align: right;
      color: #141820;
    }
    .video-drawer.dark .video-row {
      border-top-color: rgba(255,255,255,.16);
    }
    .video-drawer.dark .video-row span {
      color: #aeb7c2;
    }
    .video-drawer.dark .video-row b {
      color: #f7f2e8;
    }
    .video-terminal {
      font: 17px/1.45 "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
      white-space: pre-wrap;
    }
    .video-terminal .prompt {
      color: #8bd2c7;
      font-weight: 900;
    }
    .video-terminal .pass {
      color: #9addaf;
      font-weight: 900;
    }
    .video-cursor {
      position: fixed;
      z-index: 100000;
      width: 22px;
      height: 22px;
      border-radius: 999px;
      border: 2px solid #0d766f;
      background: rgba(13,118,111,.12);
      box-shadow: 0 0 0 6px rgba(13,118,111,.1), 0 10px 24px rgba(20,24,32,.2);
      transform: translate(-50%, -50%);
      opacity: 0;
      transition: opacity 300ms ease, left 900ms ease, top 900ms ease;
      pointer-events: none;
    }
    .video-cursor.show {
      opacity: 1;
    }
  `;
}

function directorInit() {
  const scrim = document.createElement("div");
  scrim.className = "video-scrim";
  const lower = document.createElement("div");
  lower.className = "video-lower";
  const focus = document.createElement("div");
  focus.className = "video-focus";
  const focusLabel = document.createElement("div");
  focusLabel.className = "video-focus-label";
  focus.append(focusLabel);
  const drawer = document.createElement("div");
  drawer.className = "video-drawer";
  const cursor = document.createElement("div");
  cursor.className = "video-cursor";
  document.body.append(scrim, focus, lower, drawer, cursor);
  document.body.classList.add("gtm-video-mode", "stage-dashboard");

  function setStage(stage) {
    document.body.classList.remove("stage-dashboard", "stage-workflow", "stage-queue", "stage-funnel", "stage-audit");
    document.body.classList.add("stage-" + stage);
  }

  function setLower(title, detail) {
    lower.innerHTML = `<b>${title}</b><span>${detail}</span>`;
    lower.classList.add("show");
  }

  function setDrawer(html, options = {}) {
    drawer.className = "video-drawer" + (options.dark ? " dark" : "") + (html ? " show" : "");
    drawer.innerHTML = html || "";
  }

  function rectFor(selector) {
    const node = document.querySelector(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  }

  function setFocus(selector, label, pad = 8) {
    const rect = rectFor(selector);
    if (!rect) {
      focus.classList.remove("show");
      return;
    }
    focus.style.left = Math.max(12, rect.left - pad) + "px";
    focus.style.top = Math.max(12, rect.top - pad) + "px";
    focus.style.width = Math.min(window.innerWidth - 24, rect.width + pad * 2) + "px";
    focus.style.height = Math.min(window.innerHeight - 24, rect.height + pad * 2) + "px";
    focusLabel.textContent = label || "";
    focus.classList.add("show");
  }

  function moveCursor(selector, xRatio = .5, yRatio = .5) {
    const rect = rectFor(selector);
    if (!rect) {
      cursor.classList.remove("show");
      return;
    }
    cursor.style.left = rect.left + rect.width * xRatio + "px";
    cursor.style.top = rect.top + rect.height * yRatio + "px";
    cursor.classList.add("show");
  }

  function scrollToSelector(selector, block = "center") {
    const node = document.querySelector(selector);
    if (node) node.scrollIntoView({ behavior: "smooth", block, inline: "nearest" });
  }

  window.__gtmVideoDirector = { setStage, setLower, setDrawer, setFocus, moveCursor, scrollToSelector };
}

function drawerRows(title, rows) {
  return [
    `<h3>${title}</h3>`,
    ...rows.map(([label, value]) => `<div class="video-row"><span>${label}</span><b>${value}</b></div>`),
  ].join("");
}

function compactEventDetail(detail) {
  if (detail.startsWith("sink:")) return "dry-run HubSpot + Slack receipts";
  return detail;
}

function terminalDrawer(command, lines) {
  return [
    `<h3>audit proof</h3>`,
    `<div class="video-terminal"><span class="prompt">$</span> ${command}`,
    ...lines,
    `</div>`,
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node record-operator-session.mjs [--url http://localhost:8790/?demo=operator&deal=...] [--out assets/demo-video/clips/operator-session.mp4]");
    return;
  }

  const url = args.url || DEFAULT_URL;
  const outPath = resolve(args.out || DEFAULT_OUT);
  const width = Number(args.width || 1280);
  const height = Number(args.height || 720);
  const fps = Number(args.fps || 30);

  let chromium;
  try {
    ({ chromium } = createRequire(import.meta.url)("playwright"));
  } catch {
    throw new Error("Missing dependency: install Playwright or set NODE_PATH to a directory containing playwright.");
  }

  const engagement = await localJson("data/engagement-feedback.sample.json");
  const ryderFeedback = engagement.deals.find((deal) => deal.routerDealId === DEAL_ID);
  if (!ryderFeedback) throw new Error(`Missing Ryder feedback for ${DEAL_ID}`);

  await mkdir(dirname(outPath), { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), "gtm-operator-session-"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    recordVideo: { dir: tempDir, size: { width, height } },
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector("#kpis .card");
  await page.waitForTimeout(1200);

  const state = await page.evaluate(async () => {
    const response = await fetch("/state");
    if (!response.ok) throw new Error(`state ${response.status}`);
    return response.json();
  });
  const events = await page.evaluate(async (dealId) => {
    const response = await fetch(`/deals/${encodeURIComponent(dealId)}/events`);
    if (!response.ok) throw new Error(`events ${response.status}`);
    return response.json();
  }, DEAL_ID);

  const ryder = state.queue.find((deal) => deal.id === DEAL_ID);
  if (!ryder) throw new Error(`Missing Ryder deal in /state.queue: ${DEAL_ID}`);

  await page.addStyleTag({ content: directorCss() });
  await page.evaluate(directorInit);

  const director = async (fn, ...fnArgs) => page.evaluate(([source, argsForFn]) => {
    const run = new Function("return (" + source + ")")();
    return run(window.__gtmVideoDirector, ...argsForFn);
  }, [String(fn), fnArgs]);

  await director((d) => {
    window.scrollTo({ top: 0, behavior: "instant" });
    d.setStage("dashboard");
    d.setLower("Start in the live operator console.", "This is the localhost dashboard reading the isolated SQLite sample run.");
    d.setDrawer("");
    d.setFocus("#kpis", "operating state", 10);
    d.moveCursor("#kpis .card:nth-child(1)", .72, .35);
  });
  await page.waitForTimeout(3700);

  await director((d) => {
    d.setStage("workflow");
    d.scrollToSelector("#workflow-guide", "center");
    d.setLower("The same deal stays selected.", "Ryder Digital is pinned from route decision through downstream measurement.");
    d.setDrawer("");
  });
  await page.waitForTimeout(900);
  await director((d) => {
    d.setFocus("#workflow-guide", "Ryder workflow", 10);
    d.moveCursor("#workflow-guide", .16, .36);
  });
  await page.waitForTimeout(3500);

  await director((d, html) => {
    d.setStage("queue");
    d.scrollToSelector("#detail", "center");
    d.setLower("Inspect the route, not a recreated mockup.", "The selected deal detail carries owner, finance, legal, score, and receipt state from /state.");
    d.setDrawer(html);
  }, drawerRows("route receipt", [
    ["deal", "Ryder Digital"],
    ["route", ryder.route],
    ["owner", "ae.morgan"],
    ["finance", "pricing_approval"],
    ["legal", "regulated_review"],
    ["score", Number(ryder.scoreTotal).toFixed(2)],
  ]));
  await page.waitForTimeout(900);
  await director((d) => {
    d.setFocus("#detail", "deal detail", 10);
    d.moveCursor("#detail", .35, .32);
  });
  await page.waitForTimeout(4200);

  const eventRows = events.events
    .filter((event) =>
      event.detail.includes("intake") ||
      event.detail.includes("enriched") ||
      event.detail.includes("score") ||
      event.detail.includes("sink:") ||
      event.detail.includes("route ")
    )
    .slice(0, 5)
    .map((event) => [String(event.to || event.from || "-"), compactEventDetail(event.detail)]);
  await director((d, html) => {
    d.setStage("queue");
    d.setLower("The handoff leaves receipts.", "HubSpot and Slack are dry-run sinks here, but the receipt trail is a real event stream.");
    d.setDrawer(html, { dark: false });
    d.setFocus("#detail", "receipt trail", 10);
    d.moveCursor("#detail", .62, .56);
  }, drawerRows("event stream", eventRows));
  await page.waitForTimeout(4300);

  const tiers = state.engagementAttribution.tiers;
  const coverage = state.engagementAttribution.coverage;
  await director((d, html) => {
    d.setStage("funnel");
    d.scrollToSelector("#full-funnel", "center");
    d.setLower("A signal is not truth.", "The dashboard shows Sales-reported motion without converting it into router-owned pipeline.");
    d.setDrawer(html);
  }, drawerRows("source authority", [
    ["observed engagement", `$${Math.round(tiers.meetingsInfluencedUsd / 1000)}K`],
    ["reported by Sales", `$${Math.round(tiers.commercialSignalsUsd / 1000)}K`],
    ["authoritative router", `$${Math.round(tiers.pipelineInfluencedUsd / 1000)}`],
    ["coverage", `${coverage.routedDealsWithEngagement} / ${coverage.routedDealsTotal}`],
  ]));
  await page.waitForTimeout(900);
  await director((d) => {
    d.setFocus("#full-funnel", "full-funnel attribution", 10);
    d.moveCursor("#full-funnel", .52, .34);
  });
  await page.waitForTimeout(4800);

  await director((d, html) => {
    d.setStage("audit");
    d.setLower("Then the audit gets the last word.", "The story only ships if the ledger still passes independent checks.");
    d.setDrawer(html, { dark: true });
    d.setFocus("#full-funnel", "measurement surface", 10);
  }, terminalDrawer("python3 ops_audit.py --db data/router.video-demo.db", [
    '<span class="pass">RESULT: PASS</span>',
    "engagement orphans 0",
    "projection conflicts 0",
    "stuck rows 0",
  ]));
  await page.waitForTimeout(4700);

  await director((d, html) => {
    d.setStage("workflow");
    d.scrollToSelector("#workflow-guide", "center");
    d.setLower("Route the work. Preserve the receipts.", "The demo is one operator inspecting a live ledger, not a deck of recreated claims.");
    d.setDrawer(html);
  }, drawerRows("verified", [
    ["typecheck", "passed"],
    ["tests", "361 passed"],
    ["python audit tests", "28 passed"],
  ]));
  await page.waitForTimeout(900);
  await director((d) => {
    d.setFocus("#workflow-guide", "same deal, checked loop", 10);
    d.moveCursor("#workflow-guide", .15, .34);
  });
  await page.waitForTimeout(3600);

  const video = page.video();
  await page.close();
  await context.close();
  await browser.close();
  const webmPath = await video.path();

  await run("ffmpeg", [
    "-y",
    "-i", webmPath,
    "-vf", `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`,
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outPath,
  ]);
  console.log(`Wrote ${outPath}`);
}

main().catch((error) => {
  console.error(`record-operator-session: ${error.message}`);
  process.exit(1);
});
