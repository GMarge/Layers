"""SQLite storage for Layers. Everything seeded here is fictional demo data."""

import json
import sqlite3
import threading
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "layers.db"

# The server acts for one signed-in employee. Identity is fixed here, on the server,
# and is never taken from the browser or from the model.
EMPLOYEE = {"name": "Jordan Lee", "team": "Strategy", "role": "Intern"}
MANAGER = "Priya Nair"
PROJECT = {"name": "Project X", "title": "Competitor analysis", "due": "Fri, Nov 20"}

COMPETITORS = ["Stocksmith", "Pantryline", "Crateworks", "Tallyhouse", "Larder & Co"]

_lock = threading.Lock()
_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row

SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, name TEXT, text TEXT, owner TEXT, scope TEXT);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY, name TEXT, kind TEXT, summary TEXT, author TEXT, team TEXT,
  reviewed_on TEXT, approved_by TEXT, access TEXT, columns TEXT, inputs TEXT, shared_with TEXT
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, title TEXT, source TEXT, author TEXT, columns TEXT, rows TEXT, created_at REAL
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT, note TEXT, status TEXT, approver TEXT, created_at REAL
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT, verdict TEXT, allowed INTEGER, reason TEXT,
  decided_by TEXT, created_at REAL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, prompt TEXT, created_at REAL
);
CREATE TABLE IF NOT EXISTS learned_terms (term TEXT PRIMARY KEY, learned_from TEXT, created_at REAL);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, actor TEXT, action TEXT, detail TEXT
);
"""

TABLES = ["settings", "tasks", "rules", "workflows", "artifacts", "approvals", "decisions",
          "feedback", "learned_terms", "audit"]


def execute(sql: str, params: tuple = ()) -> sqlite3.Cursor:
    with _lock:
        cur = _conn.execute(sql, params)
        _conn.commit()
        return cur


def query(sql: str, params: tuple = ()) -> list[dict]:
    with _lock:
        return [dict(r) for r in _conn.execute(sql, params).fetchall()]


def audit(actor: str, action: str, detail: object = "") -> None:
    """Append-only record of everything Layers did and why."""
    text = detail if isinstance(detail, str) else json.dumps(detail)
    execute("INSERT INTO audit (ts, actor, action, detail) VALUES (?, ?, ?, ?)",
            (time.time(), actor, action, text[:2000]))


def setting(key: str) -> str:
    rows = query("SELECT value FROM settings WHERE key = ?", (key,))
    return rows[0]["value"] if rows else ""


def reset() -> None:
    """Wipe and reseed, so every demo starts from the same place."""
    with _lock:
        for table in TABLES:
            _conn.execute(f"DROP TABLE IF EXISTS {table}")
        _conn.executescript(SCHEMA)
        _conn.executemany("INSERT INTO settings VALUES (?, ?)",
                          [("policy_mode", "approval"), ("unsure_mode", "ask")])
        _conn.executemany("INSERT INTO tasks VALUES (?, ?, ?)", [
            ("t1", "Research five competitors", "done"),
            ("t2", "Analyze findings", "doing"),
            ("t3", "Build comparison spreadsheet", "todo"),
            ("t4", "Draft presentation", "todo"),
        ])
        _conn.executemany("INSERT INTO rules VALUES (?, ?, ?, ?, ?)", [
            ("AI-01", "Assigned work only", "Use Fernhill AI for work on your assigned projects.",
             MANAGER, "Applies to this workspace only"),
            ("AI-02", "Reuse before rebuild",
             "Check for an approved team workflow before generating a new one.",
             MANAGER, "Applies to this workspace only"),
        ])
        _conn.executemany("INSERT INTO workflows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
            ("wf-competitor-matrix-v2", "CompetitorMatrix_v2", "Approved workflow",
             "Comparison sheet with scoring columns for up to ten competitors.",
             "Marcus Bell", "Strategy", "Oct 28, 2026", MANAGER,
             "Shared with Strategy, interns included",
             json.dumps(["Company", "Segment", "Pricing model", "Standout feature", "Gap we can use"]),
             "A list of competitor names", json.dumps(["Strategy"])),
            ("wf-board-deck-q3", "BoardDeck_Q3", "Approved workflow",
             "Quarterly board deck outline with finance tables.",
             "Dana Ortiz", "Finance", "Sep 12, 2026", "Dana Ortiz",
             "Finance only", json.dumps(["Section", "Owner", "Status"]),
             "Quarterly figures", json.dumps(["Finance"])),
            ("wf-interview-synth", "InterviewSynthesis_v1", "Approved workflow",
             "Template for turning customer interview notes into themes.",
             "Marcus Bell", "Strategy", "Aug 30, 2026", MANAGER,
             "Shared with Strategy, interns included",
             json.dumps(["Theme", "Quote", "Customer", "Strength"]),
             "Interview notes", json.dumps(["Strategy"])),
        ])
        _conn.commit()


with _lock:
    _conn.executescript(SCHEMA)
if not query("SELECT 1 FROM tasks LIMIT 1"):
    reset()
