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

ENGAGEMENT_EVENTS_DDL = """
CREATE TABLE engagement_events (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_payload_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source, source_event_id),
  CHECK(source IN ('sales_observed','sales_window_evaluator')),
  CHECK(kind IN ('sent','replied','meeting_booked','bounced','no_response'))
)
"""

COMMERCIAL_SIGNALS_DDL = """
CREATE TABLE commercial_signals (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_payload_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  amount_usd INTEGER,
  crm_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source, source_event_id),
  CHECK(source IN ('sales_reported')),
  CHECK(kind IN ('opportunity_created'))
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


def _engagement(
    id_,
    deal_id,
    kind,
    occurred_at,
    source="sales_observed",
    source_event_id=None,
):
    if source_event_id is None:
        source_event_id = id_
    return (
        id_,
        deal_id,
        source,
        source_event_id,
        "hash-" + id_,
        kind,
        occurred_at,
        "{}",
        occurred_at,
    )


def make_db(
    rows,
    outcome_rows=None,
    commercial_rows=None,
    event_rows=None,
    engagement_rows=None,
    commercial_signal_rows=None,
):
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
    if engagement_rows is not None:
        conn.execute(ENGAGEMENT_EVENTS_DDL)
        conn.executemany(
            "INSERT INTO engagement_events VALUES (?,?,?,?,?,?,?,?,?)",
            engagement_rows,
        )
    if commercial_signal_rows is not None:
        conn.execute(COMMERCIAL_SIGNALS_DDL)
        conn.executemany(
            "INSERT INTO commercial_signals VALUES (?,?,?,?,?,?,?,?,?,?)",
            commercial_signal_rows,
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

    def test_engagement_orphan_breach_fails(self):
        # An engagement_event whose deal_id is not a routed deal is an orphan.
        # Orphans must breach and cause exit 1 (INTEGRITY gate).
        conn = make_db(
            [_routed("deal-a", "human_assisted", 50000, 1)],
            engagement_rows=[
                # Valid: deal-a is a routed deal.
                _engagement("e1", "deal-a", "sent", "2026-05-20T10:00:00.000Z"),
                # Orphan: deal-x does not exist in deals at all.
                _engagement("e2", "deal-x", "sent", "2026-05-20T11:00:00.000Z"),
            ],
        )
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertFalse(r.ok)
        self.assertEqual(r.engagement_orphans, 1)
        self.assertEqual(r.engagement_projection_conflicts, 0)
        self.assertTrue(
            any("engagementOrphans" in b for b in r.breaches)
        )

    def test_engagement_projection_conflict_breach_fails(self):
        # A projection conflict: a no_response event exists for a deal, but
        # there is also an observed event (replied / meeting_booked) whose
        # occurred_at is strictly BEFORE the no_response's occurred_at.
        # That means the no_response window was emitted after a known reply —
        # an impossible ordering that indicates a corrupt import.
        conn = make_db(
            [_routed("deal-a", "human_assisted", 50000, 1)],
            engagement_rows=[
                # replied at T1
                _engagement(
                    "e1", "deal-a", "replied",
                    "2026-05-20T09:00:00.000Z",
                ),
                # no_response emitted with occurred_at AFTER the reply —
                # but because the reply predates the no_response's window,
                # this is a conflict: no_response should never have been
                # emitted if a reply was already observed.
                _engagement(
                    "e2", "deal-a", "no_response",
                    "2026-05-21T00:00:00.000Z",
                    source="sales_window_evaluator",
                ),
            ],
        )
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertFalse(r.ok)
        self.assertEqual(r.engagement_projection_conflicts, 1)
        self.assertEqual(r.engagement_orphans, 0)
        self.assertTrue(
            any("engagementProjectionConflicts" in b for b in r.breaches)
        )

    def test_engagement_healthy_passes(self):
        # Valid case A: sent + replied + meeting_booked for one routed deal —
        #   no orphans, no projection conflicts.
        # Valid case B: no_response that is correctly superseded at projection
        #   time by a LATER observed event (occurred_at T2 > no_response
        #   occurred_at T1) — the late-reply acceptance case from spec §6.1.
        #   Both rows are retained; this is NOT a conflict.
        conn = make_db(
            [
                _routed("deal-a", "human_assisted", 80000, 1),
                _routed("deal-b", "self_serve", 20000, 1),
            ],
            engagement_rows=[
                _engagement(
                    "e1", "deal-a", "sent",
                    "2026-05-18T08:00:00.000Z",
                ),
                _engagement(
                    "e2", "deal-a", "replied",
                    "2026-05-19T10:00:00.000Z",
                ),
                _engagement(
                    "e3", "deal-a", "meeting_booked",
                    "2026-05-20T14:00:00.000Z",
                ),
                # deal-b: no_response at T1, then late reply at T2 > T1.
                # T2 > T1 means the no_response was emitted before the reply
                # arrived — the valid supersession path (spec D4 + case 5).
                _engagement(
                    "e4", "deal-b", "no_response",
                    "2026-05-19T00:00:00.000Z",
                    source="sales_window_evaluator",
                ),
                _engagement(
                    "e5", "deal-b", "replied",
                    "2026-05-20T09:00:00.000Z",
                ),
            ],
        )
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertTrue(r.ok)
        self.assertEqual(r.engagement_orphans, 0)
        self.assertEqual(r.engagement_projection_conflicts, 0)

    def test_sent_before_no_response_is_healthy(self):
        # The NORMAL no-response flow: a touch is sent, then after a window with
        # no reply the evaluator emits a no_response (occurred_at AFTER the sent).
        # sent-before-no_response is expected and must NOT be a projection conflict.
        conn = make_db(
            [_routed("deal-a", "human_assisted", 50000, 1)],
            engagement_rows=[
                _engagement("e1", "deal-a", "sent", "2026-05-18T08:00:00.000Z"),
                _engagement(
                    "e2", "deal-a", "no_response", "2026-05-25T00:00:00.000Z",
                    source="sales_window_evaluator",
                ),
            ],
        )
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertTrue(r.ok)
        self.assertEqual(r.engagement_projection_conflicts, 0)

    def test_commercial_signal_orphan_breach_fails(self):
        # A commercial_signals row whose deal_id is not a routed deal is an
        # orphan too — the orphan check must scan commercial_signals, not only
        # engagement_events.
        conn = make_db(
            [_routed("deal-a", "human_assisted", 50000, 1)],
            commercial_signal_rows=[
                (
                    "s1", "deal-z", "sales_reported", "sig-1", "h",
                    "opportunity_created", "2026-05-20T10:00:00.000Z",
                    None, None, "2026-05-20T10:00:00.000Z",
                ),
            ],
        )
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertFalse(r.ok)
        self.assertEqual(r.engagement_orphans, 1)
        self.assertTrue(any("engagementOrphans" in b for b in r.breaches))

    def test_projection_conflict_on_later_no_response(self):
        # replied(T2) followed by a LATER no_response(T3 > T2) is a conflict:
        # the no_response ignores a known reply. A MIN-based check misses this
        # when an earlier no_response(T1 < T2) also exists.
        conn = make_db(
            [_routed("deal-a", "human_assisted", 50000, 1)],
            engagement_rows=[
                _engagement(
                    "e0", "deal-a", "no_response", "2026-05-18T00:00:00.000Z",
                    source="sales_window_evaluator",
                ),
                _engagement("e1", "deal-a", "replied", "2026-05-19T09:00:00.000Z"),
                _engagement(
                    "e2", "deal-a", "no_response", "2026-05-21T00:00:00.000Z",
                    source="sales_window_evaluator",
                ),
            ],
        )
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertFalse(r.ok)
        self.assertGreaterEqual(r.engagement_projection_conflicts, 1)

    def test_engagement_orphan_count_is_rows_not_distinct_deals(self):
        # engagement_orphans counts orphan ROWS, not distinct orphan deals:
        # two bad rows for the same non-routed deal are two violations.
        conn = make_db(
            [_routed("deal-a", "human_assisted", 50000, 1)],
            engagement_rows=[
                _engagement("e1", "deal-x", "sent", "2026-05-20T10:00:00.000Z"),
                _engagement("e2", "deal-x", "replied", "2026-05-20T11:00:00.000Z"),
            ],
        )
        r = ops_audit.audit(conn, max_quarantine_rate=1.0, max_p95_ms=9999)
        self.assertEqual(r.engagement_orphans, 2)


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
