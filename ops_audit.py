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
import sqlite3
import sys
from dataclasses import dataclass, field

TERMINAL_STAGES = ("routed", "quarantined")


def percentile(values: list[int], p: float) -> int:
    """Same definition as the TS side, so both languages agree on p95."""
    if not values:
        return 0
    s = sorted(values)
    idx = min(len(s) - 1, max(0, -(-int(p) * len(s) // 100) - 1))
    return s[idx]


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
    breaches: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.invariant_ok and not self.breaches


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
    arr: dict[str, float] = {"nurture": 0.0, "self_serve": 0.0, "human_assisted": 0.0}

    for stage, payload, _quarantine, latency_ms in rows:
        if stage == "routed":
            r.routed += 1
            if payload:
                deal = json.loads(payload)
                kind = deal.get("route", {}).get("kind", "unknown")
                usd = float(deal.get("dealUSD", 0))
                arr[kind] = arr.get(kind, 0.0) + usd
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
    return r


def render(r: AuditReport) -> str:
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
        "-" * 48,
        "  RESULT: " + ("PASS" if r.ok else "FAIL"),
        *[f"    - {b}" for b in r.breaches],
    ]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Router SQLite audit + SLO gate")
    ap.add_argument("--db", default="data/router.db")
    ap.add_argument("--max-quarantine-rate", type=float, default=0.35)
    ap.add_argument("--max-p95-ms", type=int, default=2000)
    ap.add_argument("--json", action="store_true", help="machine-readable out")
    args = ap.parse_args(argv)

    try:
        conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    except sqlite3.OperationalError as e:
        sys.stderr.write(
            f"cannot open db {args.db!r} ({e}). "
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
