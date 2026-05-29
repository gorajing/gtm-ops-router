"""
Tests for ops_audit.py — stdlib unittest only (no pytest dependency), mirrors
the TypeScript suite's discipline: the happy path AND the failure paths.

Run:  python3 -m unittest test_ops_audit
"""

import contextlib
import io
import json
import os
import sqlite3
import tempfile
import unittest

import ops_audit


def run_main(argv):
    """Call ops_audit.main with stdout/stderr captured (quiet test suite)."""
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
        io.StringIO()
    ):
        return ops_audit.main(argv)

DEALS_DDL = """
CREATE TABLE deals (
  id TEXT PRIMARY KEY, stage TEXT NOT NULL, payload TEXT, quarantine TEXT,
  latency_ms INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)
"""

COMMERCIAL_STATES_DDL = """
CREATE TABLE commercial_states (
  deal_id TEXT PRIMARY KEY,
  commercial_state TEXT NOT NULL,
  state_entered_at TEXT NOT NULL
)
"""

OUTCOME_EVENTS_DDL = """
CREATE TABLE outcome_events (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  arr_delta_usd INTEGER
)
"""

EVENTS_DDL = """
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  from_st TEXT NOT NULL,
  to_st TEXT NOT NULL,
  detail TEXT NOT NULL,
  meta TEXT
)
"""


def _routed(id_, kind, usd, latency):
    payload = json.dumps({"id": id_, "dealUSD": usd, "route": {"kind": kind}})
    return (id_, "routed", payload, None, latency, "t", "t")


def _quar(id_, code, latency):
    q = json.dumps({"dealId": id_, "code": code})
    return (id_, "quarantined", None, q, latency, "t", "t")


def _commercial(deal_id, state, state_entered_at):
    return (deal_id, state, state_entered_at)


def _outcome(id_, deal_id, outcome, occurred_at, arr_delta_usd=None):
    return (id_, deal_id, outcome, occurred_at, occurred_at, arr_delta_usd)


def _commercial_event(deal_id, occurred_at, projected=True):
    meta = json.dumps(
        {
            "kind": "commercial_state",
            "source": "local",
            "eventKey": "event-key",
            "sourceEventId": "source-event",
            "commercialState": "closed_won",
            "occurredAt": occurred_at,
            "projected": projected,
        }
    )
    return (deal_id, occurred_at, "routed", "routed", "commercial state changed", meta)


def make_db(rows, outcome_rows=None, commercial_rows=None, event_rows=None):
    conn = sqlite3.connect(":memory:")
    conn.execute(DEALS_DDL)
    conn.executemany(
        "INSERT INTO deals VALUES (?,?,?,?,?,?,?)", rows
    )
    if event_rows is not None:
        conn.execute(EVENTS_DDL)
        conn.executemany(
            """INSERT INTO events (
                 deal_id, ts, from_st, to_st, detail, meta
               )
               VALUES (?,?,?,?,?,?)""",
            event_rows,
        )
    if commercial_rows is not None:
        conn.execute(COMMERCIAL_STATES_DDL)
        conn.executemany(
            "INSERT INTO commercial_states VALUES (?,?,?)", commercial_rows
        )
    if outcome_rows is not None:
        conn.execute(OUTCOME_EVENTS_DDL)
        conn.executemany(
            "INSERT INTO outcome_events VALUES (?,?,?,?,?,?)", outcome_rows
        )
    conn.commit()
    return conn


class PercentileTest(unittest.TestCase):
    def test_empty_is_zero(self):
        self.assertEqual(ops_audit.percentile([], 95), 0)

    def test_p95_matches_ts_definition(self):
        self.assertEqual(ops_audit.percentile(list(range(1, 11)), 95), 10)
        self.assertEqual(ops_audit.percentile([5], 50), 5)


class AuditTest(unittest.TestCase):
    def test_healthy_corpus_passes(self):
        conn = make_db([
            _routed("a", "human_assisted", 120000, 1),
            _routed("b", "self_serve", 8000, 1),
            _quar("c", "schema_invalid", 0),
        ])
        r = ops_audit.audit(conn, max_quarantine_rate=0.35, max_p95_ms=2000)
        self.assertTrue(r.invariant_ok)
        self.assertTrue(r.ok)
        self.assertEqual(r.intake, 3)
        self.assertEqual(r.routed, 2)
        self.assertEqual(r.routed_arr_usd, 128000)
        self.assertEqual(r.arr_by_route["human_assisted"], 120000)

    def test_quarantine_rate_slo_breach_fails(self):
        conn = make_db([
            _routed("a", "self_serve", 1000, 1),
            _quar("b", "enrichment_unresolved", 0),
            _quar("c", "enrichment_unresolved", 0),
        ])
        r = ops_audit.audit(conn, max_quarantine_rate=0.35, max_p95_ms=2000)
        self.assertFalse(r.ok)
        self.assertTrue(any("quarantine_rate" in b for b in r.breaches))

    def test_non_terminal_row_breaks_invariant(self):
        conn = make_db([
            _routed("a", "self_serve", 1000, 1),
            ("b", "scored", None, None, 1, "t", "t"),  # stuck
        ])
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertEqual(r.stuck, 1)
        self.assertFalse(r.invariant_ok)
        self.assertFalse(r.ok)

    def test_unknown_route_kind_breaks_invariant(self):
        conn = make_db([
            _routed("a", "unknown", 1000, 1),
        ])
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertEqual(r.stuck, 1)
        self.assertNotIn("unknown", r.arr_by_route)
        self.assertFalse(r.invariant_ok)
        self.assertTrue(any("unknown_route_kind" in b for b in r.breaches))

    def test_malformed_routed_payload_is_breach_not_crash(self):
        # A corrupt (unparseable) routed payload must be a loud breach (exit 1),
        # not a traceback — symmetric with the null-payload branch above it
        # (routed_missing_payload). The audit exists to catch this corruption.
        conn = make_db([("a", "routed", "{not valid json", None, 1, "t", "t")])
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertEqual(r.stuck, 1)
        self.assertFalse(r.invariant_ok)
        self.assertFalse(r.ok)
        self.assertTrue(any("routed_corrupt_payload" in b for b in r.breaches))

    def test_nonnumeric_deal_usd_is_breach_not_crash(self):
        # A routed payload whose dealUSD is not a number is corruption, not a
        # crash. float("not-a-number") would raise; it must become a breach.
        payload = json.dumps(
            {"id": "a", "dealUSD": "not-a-number", "route": {"kind": "self_serve"}}
        )
        conn = make_db([("a", "routed", payload, None, 1, "t", "t")])
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertEqual(r.stuck, 1)
        self.assertFalse(r.invariant_ok)
        self.assertTrue(any("routed_corrupt_payload" in b for b in r.breaches))

    def test_nonstring_route_kind_is_breach_not_crash(self):
        # A parseable payload whose route.kind is not a string (e.g. a list) is
        # corruption: `kind not in arr` would raise TypeError (unhashable) and
        # crash the audit. It must be a breach instead.
        payload = json.dumps({"id": "a", "dealUSD": 1, "route": {"kind": []}})
        conn = make_db([("a", "routed", payload, None, 1, "t", "t")])
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertEqual(r.stuck, 1)
        self.assertFalse(r.invariant_ok)
        self.assertTrue(any("routed_corrupt_payload" in b for b in r.breaches))

    def test_nonfinite_deal_usd_is_breach_not_silent_nan(self):
        # Python's json accepts NaN/Infinity and float(NaN) succeeds, so a
        # non-finite amount would silently produce routed_arr_usd=nan with ok.
        # Non-finite is corruption: it must breach and never leak into the ARR.
        payload = '{"id": "a", "dealUSD": NaN, "route": {"kind": "self_serve"}}'
        conn = make_db([("a", "routed", payload, None, 1, "t", "t")])
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertEqual(r.stuck, 1)
        self.assertFalse(r.invariant_ok)
        self.assertTrue(any("routed_corrupt_payload" in b for b in r.breaches))
        self.assertEqual(r.routed_arr_usd, 0)
        self.assertEqual(r.routed, 0)

    def test_corrupt_deal_usd_variants_are_breaches(self):
        # dealUSD must match the TS contract z.number().finite().nonnegative()
        # (src/types.ts). Missing, negative, boolean, and numeric-string values
        # are corruption — they must breach, never silently coerce into ARR.
        variants = {
            "missing": {"id": "a", "route": {"kind": "self_serve"}},
            "negative": {"id": "a", "dealUSD": -1, "route": {"kind": "self_serve"}},
            "boolean": {"id": "a", "dealUSD": True, "route": {"kind": "self_serve"}},
            "string": {"id": "a", "dealUSD": "100", "route": {"kind": "self_serve"}},
        }
        for name, obj in variants.items():
            with self.subTest(variant=name):
                conn = make_db([("a", "routed", json.dumps(obj), None, 1, "t", "t")])
                r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
                self.assertEqual(r.stuck, 1)
                self.assertFalse(r.invariant_ok)
                self.assertTrue(
                    any("routed_corrupt_payload" in b for b in r.breaches)
                )
                self.assertEqual(r.routed_arr_usd, 0)
                self.assertEqual(r.routed, 0)

    def test_overflowing_int_deal_usd_is_breach_not_crash(self):
        # An arbitrarily large JSON integer parses to a Python int whose
        # math.isfinite() conversion raises OverflowError. JS float64 would
        # treat it as non-finite and reject it; here it must breach, not crash.
        payload = (
            '{"id": "a", "dealUSD": ' + ("9" * 1000) + ', "route": {"kind": "self_serve"}}'
        )
        conn = make_db([("a", "routed", payload, None, 1, "t", "t")])
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertEqual(r.stuck, 1)
        self.assertFalse(r.invariant_ok)
        self.assertTrue(any("routed_corrupt_payload" in b for b in r.breaches))
        self.assertEqual(r.routed_arr_usd, 0)

    def test_latency_slo_breach_fails(self):
        conn = make_db([_routed("a", "self_serve", 1000, 9000)])
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=2000)
        self.assertFalse(r.ok)
        self.assertTrue(any("p95_latency" in b for b in r.breaches))

    def test_outcome_loop_metrics_pass_on_valid_history(self):
        conn = make_db(
            [_routed("a", "human_assisted", 120000, 1)],
            commercial_rows=[
                _commercial("a", "closed_won", "2026-05-26T12:00:00.000Z")
            ],
            event_rows=[
                _commercial_event("a", "2026-05-21T14:00:00+02:00")
            ],
            outcome_rows=[
                _outcome("o1", "a", "deployment_started", "2026-05-22T12:00:00.000Z"),
                _outcome("o2", "a", "deployed", "2026-05-23T12:00:00.000Z"),
                _outcome("o3", "a", "landed", "2026-05-24T00:00:00.000Z"),
                _outcome(
                    "o4",
                    "a",
                    "expanded",
                    "2026-05-25T00:00:00.000Z",
                    50000,
                ),
            ],
        )
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=2000)
        self.assertTrue(r.ok)
        self.assertEqual(r.deployment_started_deals, 1)
        self.assertEqual(r.deployed_deals, 1)
        self.assertEqual(r.landed_deals, 1)
        self.assertEqual(r.expanded_deals, 1)
        self.assertEqual(r.expanded_arr_delta_usd, 50000)
        self.assertEqual(r.median_time_closed_won_to_deployed_hours, 48)
        self.assertEqual(r.median_time_deployed_to_landed_hours, 12)

    def test_outcome_commercial_conflict_fails(self):
        conn = make_db(
            [_routed("a", "human_assisted", 120000, 1)],
            commercial_rows=[_commercial("a", "open", "2026-05-21T12:00:00.000Z")],
            outcome_rows=[
                _outcome("o1", "a", "deployment_started", "2026-05-22T12:00:00.000Z")
            ],
        )
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=2000)
        self.assertFalse(r.ok)
        self.assertEqual(r.outcome_commercial_state_conflicts, 1)
        self.assertTrue(
            any("outcomeCommercialStateConflicts" in b for b in r.breaches)
        )

    def test_invalid_outcome_history_fails(self):
        conn = make_db(
            [_routed("a", "human_assisted", 120000, 1)],
            commercial_rows=[
                _commercial("a", "closed_won", "2026-05-21T12:00:00.000Z")
            ],
            outcome_rows=[
                _outcome("o1", "a", "deployed", "2026-05-22T12:00:00.000Z"),
                _outcome("o2", "a", "churned", "2026-05-23T12:00:00.000Z"),
                _outcome("o3", "a", "landed", "2026-05-24T12:00:00.000Z"),
            ],
        )
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=2000)
        self.assertFalse(r.ok)
        self.assertEqual(r.outcome_invalid_histories, 3)
        self.assertIsNone(r.median_time_closed_won_to_deployed_hours)
        self.assertIsNone(r.median_time_deployed_to_landed_hours)
        self.assertTrue(any("outcomeInvalidHistories" in b for b in r.breaches))

    def test_churn_before_deploy_is_warning_not_failure(self):
        conn = make_db(
            [_routed("a", "human_assisted", 120000, 1)],
            commercial_rows=[
                _commercial("a", "closed_won", "2026-05-21T12:00:00.000Z")
            ],
            outcome_rows=[
                _outcome("o1", "a", "deployment_started", "2026-05-22T12:00:00.000Z"),
                _outcome("o2", "a", "churned", "2026-05-23T12:00:00.000Z"),
            ],
        )
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=2000)
        self.assertTrue(r.ok)
        self.assertEqual(r.outcome_churn_before_deploy, 1)


class RenderTest(unittest.TestCase):
    def test_hours_match_dashboard_precision(self):
        r = ops_audit.AuditReport()
        r.median_time_closed_won_to_deployed_hours = 1.235
        r.median_time_deployed_to_landed_hours = 0.005
        rendered = ops_audit.render(r)
        self.assertIn("won-to-deployed med 1.24h", rendered)
        self.assertIn("deployed-to-landed  <0.01h", rendered)


class MainExitCodeTest(unittest.TestCase):
    def _db_file(self, rows):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        os.remove(path)  # let sqlite create it fresh
        conn = sqlite3.connect(path)
        conn.execute(DEALS_DDL)
        conn.executemany("INSERT INTO deals VALUES (?,?,?,?,?,?,?)", rows)
        conn.commit()
        conn.close()
        return path

    def test_exit_0_on_pass(self):
        path = self._db_file([_routed("a", "self_serve", 1000, 1)])
        self.addCleanup(os.remove, path)
        self.assertEqual(run_main(["--db", path]), 0)

    def test_exit_1_on_breach(self):
        path = self._db_file([
            _quar("a", "x", 0), _quar("b", "x", 0), _routed("c", "n", 1, 1),
        ])
        self.addCleanup(os.remove, path)
        self.assertEqual(
            run_main(["--db", path, "--max-quarantine-rate", "0.1"]), 1
        )

    def test_exit_2_on_missing_db(self):
        self.assertEqual(run_main(["--db", "/nonexistent/nope.db"]), 2)


if __name__ == "__main__":
    unittest.main()
