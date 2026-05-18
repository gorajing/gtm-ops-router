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


def _routed(id_, kind, usd, latency):
    payload = json.dumps({"id": id_, "dealUSD": usd, "route": {"kind": kind}})
    return (id_, "routed", payload, None, latency, "t", "t")


def _quar(id_, code, latency):
    q = json.dumps({"dealId": id_, "code": code})
    return (id_, "quarantined", None, q, latency, "t", "t")


def make_db(rows):
    conn = sqlite3.connect(":memory:")
    conn.execute(DEALS_DDL)
    conn.executemany(
        "INSERT INTO deals VALUES (?,?,?,?,?,?,?)", rows
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

    def test_latency_slo_breach_fails(self):
        conn = make_db([_routed("a", "self_serve", 1000, 9000)])
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=2000)
        self.assertFalse(r.ok)
        self.assertTrue(any("p95_latency" in b for b in r.breaches))


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
