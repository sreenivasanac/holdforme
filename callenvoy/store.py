"""SQLite access (stdlib sqlite3, WAL). Writes are short and run inline on the event loop."""

import json
import secrets
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL, answered_at TEXT, ended_at TEXT,
  status TEXT NOT NULL, phase TEXT,
  to_number TEXT NOT NULL, business TEXT NOT NULL, goal TEXT NOT NULL,
  facts TEXT, menu_tips TEXT, flexibility TEXT, on_behalf_of TEXT,
  mode TEXT NOT NULL, connect_when TEXT, reach TEXT NOT NULL,
  alert_on_human INTEGER NOT NULL, listen_in INTEGER NOT NULL,
  alert_wait_seconds INTEGER NOT NULL, no_answer TEXT NOT NULL,
  max_minutes INTEGER NOT NULL, voice TEXT NOT NULL, record INTEGER NOT NULL,
  twilio_sid TEXT, ws_token TEXT, owner_twilio_sid TEXT,
  human_at TEXT, owner_seconds INTEGER,
  outcome_result TEXT, outcome_summary TEXT, outcome_details TEXT,
  talk_seconds INTEGER, error TEXT,
  recording_sid TEXT, recording_seconds INTEGER, recording_token TEXT,
  direction TEXT NOT NULL DEFAULT 'outbound', from_number TEXT, leave_voicemail INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS lines (
  call_id TEXT NOT NULL, n INTEGER NOT NULL, t TEXT NOT NULL,
  who TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (call_id, n)
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, call_id TEXT NOT NULL, question TEXT NOT NULL,
  answer TEXT, asked_at TEXT NOT NULL, answered_at TEXT
);
CREATE TABLE IF NOT EXISTS profile (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  label TEXT, created_at TEXT NOT NULL, last_ok_at TEXT
);
"""

db: sqlite3.Connection | None = None
# Set by calls.py: called with the call id after every write that changes a call (long-poll wake-up).
on_change: Callable[[str], None] = lambda call_id: None


def open_db(path: Path | str | None = None) -> None:
    global db
    path = path or config.DB_PATH
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(SCHEMA)
    if str(path) != ":memory:":
        Path(path).chmod(0o600)  # personal data at rest (section 22.4)


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id(prefix: str) -> str:
    return prefix + secrets.token_urlsafe(9).replace("-", "a").replace("_", "b")


def _q(sql: str, args=()) -> sqlite3.Cursor:
    assert db is not None, "store.open_db() was not called"
    return db.execute(sql, args)


# --- calls ---

def insert_call(row: dict) -> None:
    cols = ", ".join(row)
    _q(f"INSERT INTO calls ({cols}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))
    on_change(row["id"])


def update_call(call_id: str, **fields) -> None:
    if not fields:
        return
    sets = ", ".join(f"{k} = ?" for k in fields)  # keys are code constants, never user input
    _q(f"UPDATE calls SET {sets} WHERE id = ?", (*fields.values(), call_id))
    on_change(call_id)


def get_call(call_id: str) -> dict | None:
    r = _q("SELECT * FROM calls WHERE id = ?", (call_id,)).fetchone()
    return dict(r) if r else None


def find_call(column: str, value: str) -> dict | None:
    assert column in ("ws_token", "recording_token", "twilio_sid")
    r = _q(f"SELECT * FROM calls WHERE {column} = ?", (value,)).fetchone()
    return dict(r) if r else None


def list_calls(limit: int) -> list[dict]:
    return [dict(r) for r in _q("SELECT * FROM calls ORDER BY created_at DESC, rowid DESC LIMIT ?", (limit,))]


def live_calls() -> list[dict]:
    """Live outbound calls (inbound forwards are not ours to limit or hang up)."""
    marks = ", ".join("?" * len(config.LIVE_STATUSES))
    sql = f"SELECT * FROM calls WHERE status IN ({marks}) AND direction = 'outbound'"
    return [dict(r) for r in _q(sql, config.LIVE_STATUSES)]


def business_for_number(number: str, since: str) -> str | None:
    r = _q("SELECT business FROM calls WHERE direction = 'outbound' AND to_number = ? AND created_at >= ? "
           "ORDER BY created_at DESC LIMIT 1", (number, since)).fetchone()
    return r[0] if r else None


def talk_seconds_today() -> int:
    day = now()[:10]
    return _q("SELECT COALESCE(SUM(talk_seconds), 0) FROM calls WHERE created_at >= ? AND direction = 'outbound'", (day,)).fetchone()[0]


# --- transcript lines ---

def add_line(call_id: str, who: str, text: str) -> int:
    n = _q("SELECT COALESCE(MAX(n), -1) + 1 FROM lines WHERE call_id = ?", (call_id,)).fetchone()[0]
    _q("INSERT INTO lines (call_id, n, t, who, text) VALUES (?, ?, ?, ?, ?)", (call_id, n, now(), who, text))
    on_change(call_id)
    return n


def lines(call_id: str, since: int = 0) -> list[dict]:
    return [dict(r) for r in _q("SELECT n, t, who, text FROM lines WHERE call_id = ? AND n >= ? ORDER BY n", (call_id, since))]


def next_line(call_id: str) -> int:
    return _q("SELECT COALESCE(MAX(n), -1) + 1 FROM lines WHERE call_id = ?", (call_id,)).fetchone()[0]


# --- questions ---

def add_question(call_id: str, question: str) -> str:
    qid = new_id("q_")
    _q("INSERT INTO questions (id, call_id, question, asked_at) VALUES (?, ?, ?, ?)", (qid, call_id, question, now()))
    on_change(call_id)
    return qid


def get_question(qid: str) -> dict | None:
    r = _q("SELECT * FROM questions WHERE id = ?", (qid,)).fetchone()
    return dict(r) if r else None


def answer_question(qid: str, answer: str) -> None:
    q = get_question(qid)
    _q("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?", (answer, now(), qid))
    if q:
        on_change(q["call_id"])


def questions(call_id: str) -> list[dict]:
    return [dict(r) for r in _q("SELECT * FROM questions WHERE call_id = ? ORDER BY asked_at, rowid", (call_id,))]


# --- profile (one row per setting, JSON values) ---

def get_profile() -> dict:
    return {r["key"]: json.loads(r["value"]) for r in _q("SELECT key, value FROM profile")}


def save_profile(changes: dict) -> None:
    """Merge: a value of None removes the key (back to the default)."""
    for k, v in changes.items():
        if v is None:
            _q("DELETE FROM profile WHERE key = ?", (k,))
        else:
            _q("INSERT INTO profile (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, json.dumps(v)))


# --- push subscriptions ---

def push_devices() -> list[dict]:
    return [dict(r) for r in _q("SELECT * FROM push_subscriptions ORDER BY created_at")]


def save_push_device(endpoint: str, p256dh: str, auth: str, label: str | None) -> None:
    _q(
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label",
        (endpoint, p256dh, auth, label, now()),
    )


def delete_push_device(endpoint: str) -> None:
    _q("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))


def push_ok(endpoint: str) -> None:
    _q("UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?", (now(), endpoint))


# --- restart ---

def restart_cleanup() -> list[dict]:
    """Mark every unfinished call failed. Returns those rows so their Twilio legs can be hung up."""
    marks = ", ".join("?" * len(config.LIVE_STATUSES))
    rows = [dict(r) for r in _q(f"SELECT * FROM calls WHERE status IN ({marks})", config.LIVE_STATUSES)]
    for r in rows:
        update_call(r["id"], status="failed", error="server restarted", ended_at=now(), phase=None)
    return rows
