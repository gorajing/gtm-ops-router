/**
 * Observability rendering. Pure functions — the store owns the data, this
 * owns the human-readable surface (CLI tables). The HTTP dashboard reuses
 * the same Metrics shape.
 */

import type { Metrics, Quarantine, RoutedDeal } from "./types.js";

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function rule(width = 64): string {
  return "─".repeat(width);
}

function money(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

export function renderMetricsTable(m: Metrics): string {
  const lines = [
    rule(),
    "  GTM OPS ROUTER — RUN METRICS",
    rule(),
    `  intake .............. ${m.intake}`,
    `  routed .............. ${m.routed}   (conversion ${m.conversionPct}%)`,
    `  quarantined ......... ${m.quarantined}   (rate ${m.quarantineRatePct}%)`,
    "",
    "  route mix",
    `    nurture ........... ${m.routeMix.nurture}`,
    `    self_serve ........ ${m.routeMix.self_serve}`,
    `    human_assisted .... ${m.routeMix.human_assisted}`,
    "",
    "  human-gate flags",
    `    pricing_approval .. ${m.flags.pricing_approval}`,
    `    regulated_review .. ${m.flags.regulated_review}`,
    "",
    "  quarantine by code",
    ...Object.entries(m.quarantineByCode).map(
      ([k, v]) => `    ${pad(k, 24)} ${v}`,
    ),
    "",
    "  business",
    `    routed ARR ........ ${money(m.routedArrUsd)}`,
    `    human-routed ARR .. ${money(m.humanRoutedArrUsd)}`,
    `    auto-handled ...... ${m.autoHandled} deals (routed with no rep touch)`,
    `    partial syncs ..... ${m.partialSyncs}`,
    `    sync gaps ......... ${m.externallySyncedStoreErrors} external/local mismatches`,
    `    audit gaps ........ ${m.stageNotificationAuditGaps} stage-notify rows needing attention`,
    "",
    `  latency  p50 ${m.latencyMsP50}ms   p95 ${m.latencyMsP95}ms`,
    rule(),
  ];
  return lines.join("\n");
}

export function renderRoutedTable(deals: RoutedDeal[]): string {
  const head =
    "  " +
    pad("DEAL", 16) +
    pad("COMPANY", 22) +
    pad("USD", 9) +
    pad("SCORE", 7) +
    "ROUTE";
  const rows = deals.map((d) => {
    const r =
      d.route.kind === "human_assisted"
        ? `human → ${d.route.salesOwner}` +
          (d.route.financeFlag ? " +finance" : "") +
          (d.route.legalFlag ? " +legal" : "")
        : d.route.kind;
    return (
      "  " +
      pad(d.id, 16) +
      pad(d.company, 22) +
      pad(String(d.dealUSD), 9) +
      pad(d.score.total.toFixed(2), 7) +
      r
    );
  });
  return [rule(), head, rule(), ...rows, rule()].join("\n");
}

export function renderQuarantineTable(qs: Quarantine[]): string {
  if (qs.length === 0) return "  (no quarantined records)";
  const head = "  " + pad("DEAL", 16) + pad("STAGE", 12) + pad("CODE", 24) + "REASON";
  const rows = qs.map(
    (q) =>
      "  " +
      pad(q.dealId, 16) +
      pad(q.stage, 12) +
      pad(q.code, 24) +
      q.reason,
  );
  return [rule(), head, rule(), ...rows, rule()].join("\n");
}
