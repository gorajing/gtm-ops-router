#!/usr/bin/env python3
"""
ops_audit.py — nightly data-integrity + SLO gate over the router's SQLite db.

This is the Python side of the system (the TS service writes the db; this
audits it). It is the kind of job you would put on a cron / in CI: it does not
trust the service to be correct, it re-derives the invariants from the data
and exits non-zero if an SLO is breached, so a regression pages someone
instead of silently riding along.

stdlib only (sqlite3, json, argparse, dataclasses). No pip install. Python 3.8+.

Usage:
    python3 ops_audit.py --db data/router.db
    python3 ops_audit.py --db data/router.db --max-quarantine-rate 0.35 --json

Exit codes:  0 = all SLOs pass   1 = SLO breached   2 = db missing/unreadable
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import sys
from dataclasses import dataclass, field
from datetime import datetime

TERMINAL_STAGES = ("routed", "quarantined")
ROUTE_KINDS = ("nurture", "self_serve", "human_assisted")
ROOT = os.path.dirname(os.path.abspath(__file__))


def router_db_path(raw: str) -> str:
    if os.path.isabs(raw):
        return raw
    return os.path.join(ROOT, raw)


def percentile(values: list[int], p: float) -> int:
    """Same definition as the TS side, so both languages agree on p95."""
    if not values:
        return 0
    s = sorted(values)
    idx = min(len(s) - 1, max(0, -(-int(p) * len(s) // 100) - 1))
    return s[idx]


def median(values: list[float]) -> float | None:
    if not values:
        return None
    s = sorted(values)
    mid = len(s) // 2
    if len(s) % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2


def hours_between(start_iso: str, end_iso: str) -> float | None:
    try:
        delta = parse_iso(end_iso) - parse_iso(start_iso)
    except ValueError:
        return None
    seconds = delta.total_seconds()
    if seconds < 0:
        return None
    hours = seconds / 3600
    # Half-up rounding matches TypeScript's Math.round for non-negative hours.
    return math.floor(hours * 100 + 0.5) / 100


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            (name,),
        ).fetchone()
        is not None
    )


def first_projected_closed_won_by_deal(
    conn: sqlite3.Connection,
) -> dict[str, str]:
    if not table_exists(conn, "events"):
        return {}
    closed_won_at: dict[str, tuple[str, float]] = {}
    for deal_id, meta_json in conn.execute(
        """
        SELECT deal_id, meta
        FROM events
        WHERE meta IS NOT NULL
          AND json_valid(meta)
          AND json_extract(meta, '$.kind') = 'commercial_state'
          AND json_extract(meta, '$.commercialState') = 'closed_won'
          AND json_extract(meta, '$.projected') = 1
        ORDER BY ts, id
        """
    ).fetchall():
        try:
            meta = json.loads(meta_json)
        except (TypeError, json.JSONDecodeError):
            continue
        if (
            not isinstance(meta, dict)
            or meta.get("kind") != "commercial_state"
            or meta.get("commercialState") != "closed_won"
            or meta.get("projected") is not True
        ):
            continue
        occurred_at = meta.get("occurredAt")
        if not isinstance(occurred_at, str):
            continue
        try:
            occurred_at_ts = parse_iso(occurred_at).timestamp()
        except ValueError:
            continue
        deal = str(deal_id)
        previous = closed_won_at.get(deal)
        if previous is None or occurred_at_ts < previous[1]:
            closed_won_at[deal] = (occurred_at, occurred_at_ts)
    return {
        deal_id: occurred_at
        for deal_id, (occurred_at, _) in closed_won_at.items()
    }


@dataclass
class AuditReport:
    intake: int = 0
    routed: int = 0
    quarantined: int = 0
    stuck: int = 0  # rows in a non-terminal stage (invariant violation)
    invariant_ok: bool = True  # routed + quarantined == intake, no stuck rows
    quarantine_rate: float = 0.0
    p95_latency_ms: int = 0
    routed_arr_usd: float = 0.0
    arr_by_route: dict[str, float] = field(default_factory=dict)
    deployment_started_deals: int = 0
    deployed_deals: int = 0
    landed_deals: int = 0
    expanded_deals: int = 0
    expanded_arr_delta_usd: float = 0.0
    churned_deals: int = 0
    outcome_churn_before_deploy: int = 0
    outcome_commercial_state_conflicts: int = 0
    outcome_invalid_histories: int = 0
    engagement_orphans: int = 0
    engagement_projection_conflicts: int = 0
    median_time_closed_won_to_deployed_hours: float | None = None
    median_time_deployed_to_landed_hours: float | None = None
    breaches: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.invariant_ok and not self.breaches


def audit_outcomes(conn: sqlite3.Connection, r: AuditReport) -> None:
    if not table_exists(conn, "outcome_events"):
        return

    rows = conn.execute(
        """SELECT id, deal_id, outcome, occurred_at, created_at, arr_delta_usd
           FROM outcome_events
           ORDER BY deal_id, occurred_at, created_at, id"""
    ).fetchall()
    if not rows:
        return

    commercial_by_deal: dict[str, str] = {}
    if table_exists(conn, "commercial_states"):
        for deal_id, commercial_state in conn.execute(
            "SELECT deal_id, commercial_state FROM commercial_states"
        ).fetchall():
            commercial_by_deal[str(deal_id)] = str(commercial_state)
    first_closed_won_at = first_projected_closed_won_by_deal(conn)

    deals_by_outcome: dict[str, set[str]] = {
        "deployment_started": set(),
        "deployed": set(),
        "landed": set(),
        "expanded": set(),
        "churned": set(),
    }
    histories: dict[str, list[dict[str, object]]] = {}
    for row_id, deal_id, outcome, occurred_at, created_at, arr_delta_usd in rows:
        deal = str(deal_id)
        outcome_name = str(outcome)
        if outcome_name in deals_by_outcome:
            deals_by_outcome[outcome_name].add(deal)
        if outcome_name == "expanded" and arr_delta_usd is not None:
            r.expanded_arr_delta_usd += float(arr_delta_usd)
        histories.setdefault(deal, []).append(
            {
                "id": str(row_id),
                "deal_id": deal,
                "outcome": outcome_name,
                "occurred_at": str(occurred_at),
                "created_at": str(created_at),
            }
        )

    r.deployment_started_deals = len(deals_by_outcome["deployment_started"])
    r.deployed_deals = len(deals_by_outcome["deployed"])
    r.landed_deals = len(deals_by_outcome["landed"])
    r.expanded_deals = len(deals_by_outcome["expanded"])
    r.churned_deals = len(deals_by_outcome["churned"])
    r.outcome_commercial_state_conflicts = sum(
        1
        for deal_id in histories
        if commercial_by_deal.get(deal_id) != "closed_won"
    )

    invalid_row_ids: set[str] = set()
    closed_won_to_deployed: list[float] = []
    deployed_to_landed: list[float] = []

    def event_key(event: dict[str, object]) -> tuple[str, str, str]:
        return (
            str(event["occurred_at"]),
            str(event["created_at"]),
            str(event["id"]),
        )

    for deal_id, history in histories.items():
        history.sort(key=event_key)
        seen_non_expanded: set[str] = set()
        saw_churn = False
        first_deployed: dict[str, object] | None = None
        first_landed_after_deployed: dict[str, object] | None = None
        first_churned: dict[str, object] | None = None

        for event in history:
            row_id = str(event["id"])
            outcome = str(event["outcome"])
            if saw_churn:
                invalid_row_ids.add(row_id)
            if outcome != "expanded" and outcome in seen_non_expanded:
                invalid_row_ids.add(row_id)
            if outcome == "deployed" and "deployment_started" not in seen_non_expanded:
                invalid_row_ids.add(row_id)
            if outcome == "landed" and "deployed" not in seen_non_expanded:
                invalid_row_ids.add(row_id)
            if outcome == "expanded" and "landed" not in seen_non_expanded:
                invalid_row_ids.add(row_id)
            if outcome == "churned" and "deployment_started" not in seen_non_expanded:
                invalid_row_ids.add(row_id)

            if outcome == "deployed" and first_deployed is None:
                first_deployed = event
            if (
                outcome == "landed"
                and first_deployed is not None
                and first_landed_after_deployed is None
            ):
                first_landed_after_deployed = event
            if outcome == "churned" and first_churned is None:
                first_churned = event
            if outcome != "expanded":
                seen_non_expanded.add(outcome)
            if outcome == "churned":
                saw_churn = True

        if first_churned is not None and (
            first_deployed is None or event_key(first_churned) < event_key(first_deployed)
        ):
            r.outcome_churn_before_deploy += 1
        has_invalid_history = any(str(event["id"]) in invalid_row_ids for event in history)
        commercial_state = commercial_by_deal.get(deal_id)
        if (
            not has_invalid_history
            and first_deployed is not None
            and commercial_state == "closed_won"
        ):
            closed_won_at = first_closed_won_at.get(deal_id)
            if closed_won_at is not None:
                hours = hours_between(closed_won_at, str(first_deployed["occurred_at"]))
                if hours is not None:
                    closed_won_to_deployed.append(hours)
        if (
            not has_invalid_history
            and first_deployed is not None
            and first_landed_after_deployed is not None
        ):
            hours = hours_between(
                str(first_deployed["occurred_at"]),
                str(first_landed_after_deployed["occurred_at"]),
            )
            if hours is not None:
                deployed_to_landed.append(hours)

    r.outcome_invalid_histories = len(invalid_row_ids)
    r.median_time_closed_won_to_deployed_hours = median(closed_won_to_deployed)
    r.median_time_deployed_to_landed_hours = median(deployed_to_landed)

    if r.outcome_commercial_state_conflicts:
        r.breaches.append(
            "OUTCOME outcomeCommercialStateConflicts "
            f"{r.outcome_commercial_state_conflicts} > 0"
        )
    if r.outcome_invalid_histories:
        r.breaches.append(
            f"OUTCOME outcomeInvalidHistories {r.outcome_invalid_histories} > 0"
        )


def audit_engagement(conn: sqlite3.Connection, r: AuditReport) -> None:
    """
    Integrity-only gate over the engagement ledger (spec D13).

    Checks:
      1. engagement_orphans — engagement_events OR commercial_signals rows
         whose deal_id is not the id of a routed deal (a row in `deals` with
         stage = 'routed'). An orphan means the import boundary was violated:
         the importer should have rejected the event/signal.
      2. engagement_projection_conflicts — a no_response for a deal that
         already has a POSITIVE response (replied or meeting_booked) with
         occurred_at strictly BEFORE the no_response. The deal had already
         responded, so the "no response" verdict is wrong. A `sent` (or
         `bounced`) before a no_response is the NORMAL flow and is NOT a
         conflict; a reply AFTER a no_response is the valid late-reply
         supersession. Each no_response row is checked, not just the earliest.

    Never checks reply rate, pipeline value, or any GTM performance metric.
    """
    has_events = table_exists(conn, "engagement_events")
    has_signals = table_exists(conn, "commercial_signals")
    if not has_events and not has_signals:
        return

    # Routed deal ids are the ground truth: only deals with stage='routed'
    # are valid anchors for engagement rows.
    routed_ids: set[str] = {
        str(deal_id)
        for (deal_id,) in conn.execute(
            "SELECT id FROM deals WHERE stage = 'routed'"
        ).fetchall()
    }

    # ── 1. Orphan check (engagement_events AND commercial_signals) ──────────
    orphan_count = 0
    if has_events:
        for (deal_id,) in conn.execute(
            "SELECT deal_id FROM engagement_events"
        ).fetchall():
            if str(deal_id) not in routed_ids:
                orphan_count += 1
    if has_signals:
        for (deal_id,) in conn.execute(
            "SELECT deal_id FROM commercial_signals"
        ).fetchall():
            if str(deal_id) not in routed_ids:
                orphan_count += 1
    r.engagement_orphans = orphan_count

    # ── 2. Projection-conflict check ───────────────────────────────────────
    # A no_response is inconsistent only when a POSITIVE response (replied or
    # meeting_booked) occurred strictly BEFORE it: the deal had already
    # responded, so the verdict is wrong. `sent`/`bounced` before a no_response
    # is the normal flow; a reply AFTER a no_response is the valid late-reply
    # supersession. Each no_response row is checked, not just the earliest.
    conflicts = 0
    if has_events:
        (conflicts,) = conn.execute(
            """SELECT COUNT(*)
               FROM engagement_events nr
               WHERE nr.kind = 'no_response'
                 AND EXISTS (
                   SELECT 1 FROM engagement_events pos
                   WHERE pos.deal_id = nr.deal_id
                     AND pos.kind IN ('replied', 'meeting_booked')
                     AND pos.occurred_at < nr.occurred_at
                 )"""
        ).fetchone()
    r.engagement_projection_conflicts = conflicts

    # ── Breaches ───────────────────────────────────────────────────────────
    if r.engagement_orphans > 0:
        r.breaches.append(
            f"ENGAGEMENT engagementOrphans {r.engagement_orphans} > 0"
        )
    if r.engagement_projection_conflicts > 0:
        r.breaches.append(
            f"ENGAGEMENT engagementProjectionConflicts"
            f" {r.engagement_projection_conflicts} > 0"
        )


def audit(
    conn: sqlite3.Connection,
    max_quarantine_rate: float,
    max_p95_ms: int,
) -> AuditReport:
    rows = conn.execute(
        "SELECT stage, payload, quarantine, latency_ms FROM deals"
    ).fetchall()

    r = AuditReport()
    r.intake = len(rows)
    latencies: list[int] = []
    arr: dict[str, float] = {kind: 0.0 for kind in ROUTE_KINDS}

    for stage, payload, _quarantine, latency_ms in rows:
        if stage == "routed":
            if not payload:
                r.breaches.append("INVARIANT routed_missing_payload")
                r.stuck += 1
            else:
                try:
                    deal = json.loads(payload)
                    kind = deal.get("route", {}).get("kind", "unknown")
                    raw_usd = deal.get("dealUSD")
                    # The routed payload must match the TS contract: route.kind a
                    # string (an unhashable kind would crash `kind not in arr`),
                    # and dealUSD a z.number().finite().nonnegative() (src/types.ts).
                    # bool is a subclass of int, so exclude it explicitly. Missing,
                    # negative, NaN/Infinity, boolean, and string dealUSD are all
                    # corruption — a breach, never silently coerced into ARR.
                    if (
                        not isinstance(kind, str)
                        or isinstance(raw_usd, bool)
                        or not isinstance(raw_usd, (int, float))
                        or not math.isfinite(raw_usd)
                        or raw_usd < 0
                    ):
                        raise ValueError("corrupt routed payload fields")
                    usd = float(raw_usd)
                except (
                    json.JSONDecodeError,
                    AttributeError,
                    TypeError,
                    ValueError,
                    OverflowError,
                ):
                    # A corrupt routed payload is a loud breach, not a traceback.
                    # Symmetric with the null-payload branch (routed_missing_payload):
                    # the audit re-derives invariants and must report corruption
                    # it cannot parse, never crash on it.
                    r.breaches.append("INVARIANT routed_corrupt_payload")
                    r.stuck += 1
                else:
                    if kind not in arr:
                        r.breaches.append(f"INVARIANT unknown_route_kind {kind}")
                        r.stuck += 1
                    else:
                        r.routed += 1
                        arr[kind] += usd
                        r.routed_arr_usd += usd
        elif stage == "quarantined":
            r.quarantined += 1
        else:
            r.stuck += 1  # should be impossible; the audit exists to catch it
        if latency_ms is not None:
            latencies.append(int(latency_ms))

    r.arr_by_route = arr
    r.p95_latency_ms = percentile(latencies, 95)
    r.quarantine_rate = (
        r.quarantined / r.intake if r.intake else 0.0
    )

    # Invariant: every row is terminal and the totals reconcile.
    r.invariant_ok = r.stuck == 0 and (r.routed + r.quarantined == r.intake)
    if not r.invariant_ok:
        r.breaches.append(
            f"INVARIANT: routed({r.routed})+quarantined({r.quarantined})"
            f" != intake({r.intake}) or stuck={r.stuck}"
        )

    # SLOs.
    if r.quarantine_rate > max_quarantine_rate:
        r.breaches.append(
            f"SLO quarantine_rate {r.quarantine_rate:.3f}"
            f" > {max_quarantine_rate:.3f}"
        )
    if r.p95_latency_ms > max_p95_ms:
        r.breaches.append(
            f"SLO p95_latency {r.p95_latency_ms}ms > {max_p95_ms}ms"
        )
    audit_outcomes(conn, r)
    audit_engagement(conn, r)
    return r


def render(r: AuditReport) -> str:
    def hours(value: float | None) -> str:
        if value is None:
            return "n/a"
        if 0 < value < 0.01:
            return "<0.01h"
        rounded = math.floor(value * 100 + 0.5) / 100
        return f"{rounded:.2f}".rstrip("0").rstrip(".") + "h"

    lines = [
        "OPS AUDIT",
        "-" * 48,
        f"  intake .............. {r.intake}",
        f"  routed .............. {r.routed}",
        f"  quarantined ......... {r.quarantined} "
        f"(rate {r.quarantine_rate:.1%})",
        f"  stuck (non-terminal)  {r.stuck}",
        f"  p95 latency ......... {r.p95_latency_ms}ms",
        f"  routed ARR .......... ${r.routed_arr_usd:,.0f}",
        "  ARR by route:",
        *[f"    {k:<16} ${v:,.0f}" for k, v in r.arr_by_route.items()],
        "  post-sale outcomes:",
        f"    deployment_started {r.deployment_started_deals}",
        f"    deployed .......... {r.deployed_deals}",
        f"    landed ............ {r.landed_deals}",
        f"    expanded .......... {r.expanded_deals} "
        f"(${r.expanded_arr_delta_usd:,.0f} ARR delta)",
        f"    churned ........... {r.churned_deals}",
        f"    churn before deploy {r.outcome_churn_before_deploy}",
        f"    commercial conflict {r.outcome_commercial_state_conflicts}",
        f"    invalid events .... {r.outcome_invalid_histories}",
        f"    won-to-deployed med "
        f"{hours(r.median_time_closed_won_to_deployed_hours)}",
        f"    deployed-to-landed  {hours(r.median_time_deployed_to_landed_hours)}",
        "  engagement integrity:",
        f"    orphans ........... {r.engagement_orphans}",
        f"    proj conflicts .... {r.engagement_projection_conflicts}",
        "-" * 48,
        "  RESULT: " + ("PASS" if r.ok else "FAIL"),
        *[f"    - {b}" for b in r.breaches],
    ]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    env_db = os.environ.get("GTM_ROUTER_DB_PATH")
    ap = argparse.ArgumentParser(description="Router SQLite audit + SLO gate")
    ap.add_argument("--db", default=None)
    ap.add_argument("--max-quarantine-rate", type=float, default=0.35)
    ap.add_argument("--max-p95-ms", type=int, default=2000)
    ap.add_argument("--json", action="store_true", help="machine-readable out")
    args = ap.parse_args(argv)
    db_path = args.db
    if db_path is None:
        db_path = env_db or "data/router.db"
    db_path = router_db_path(db_path)

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    except sqlite3.OperationalError as e:
        sys.stderr.write(
            f"cannot open db {db_path!r} ({e}). "
            f"Produce one first: `npm run run -- data/inbound.seed.jsonl`\n"
        )
        return 2

    try:
        r = audit(conn, args.max_quarantine_rate, args.max_p95_ms)
    finally:
        conn.close()

    if args.json:
        out = {k: v for k, v in r.__dict__.items()}
        out["ok"] = r.ok
        print(json.dumps(out, indent=2))
    else:
        print(render(r))
    return 0 if r.ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
