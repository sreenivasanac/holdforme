"""SQLite access (stdlib sqlite3, WAL). Writes are short and run inline on the event loop.

Users own their data: every function that reads or writes a user's data takes the user id. Functions without
one (get_call, find_call, live_calls, ...) are for system paths keyed by a secret or a Twilio webhook, never for a
route that a user reaches with an id they typed.
"""

import json
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from . import config

USERS_TABLE = """CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT,
  disabled INTEGER NOT NULL DEFAULT 0
)"""
PROFILE_TABLE = """CREATE TABLE IF NOT EXISTS profile (
  user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key)
)"""
SCHEMA = f"""
{USERS_TABLE};
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
  direction TEXT NOT NULL DEFAULT 'outbound', from_number TEXT, leave_voicemail INTEGER NOT NULL DEFAULT 1,
  user_id TEXT
);
CREATE INDEX IF NOT EXISTS calls_user ON calls (user_id, created_at);
CREATE TABLE IF NOT EXISTS lines (
  call_id TEXT NOT NULL, n INTEGER NOT NULL, t TEXT NOT NULL,
  who TEXT NOT NULL, text TEXT NOT NULL, at REAL, PRIMARY KEY (call_id, n)
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, call_id TEXT NOT NULL, question TEXT NOT NULL,
  answer TEXT, asked_at TEXT NOT NULL, answered_at TEXT
);
{PROFILE_TABLE};
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  label TEXT, created_at TEXT NOT NULL, last_ok_at TEXT, user_id TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, disabled INTEGER NOT NULL DEFAULT 0, user_id TEXT
);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS signin_tokens (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS service (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""
# Columns added after the first release: (table, column, type). open_db adds them to an existing database.
MIGRATIONS = [("lines", "at", "REAL")]

db: sqlite3.Connection | None = None
# Set by calls.py: called with the call id after every write that changes a call (long-poll wake-up).
on_change: Callable[[str], None] = lambda call_id: None


def open_db(path: Path | str | None = None) -> None:
    global db
    path = path or config.DB_PATH
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).parent.chmod(0o700)  # personal data at rest (section 22.4)
    db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    if _columns("calls") and "user_id" not in _columns("calls"):
        _migrate_to_users()
    db.executescript(SCHEMA)
    for table, column, kind in MIGRATIONS:
        if column not in _columns(table):
            db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {kind}")
    if admin_email() and not user_by_email(admin_email()):
        add_user(admin_email())
    if str(path) != ":memory:":
        Path(path).chmod(0o600)  # personal data at rest (section 22.4)


def _columns(table: str) -> set[str]:
    return {r[1] for r in _q(f"PRAGMA table_info({table})")}  # table names are code constants


def admin_email() -> str:
    """The admin is the user with this address (OWNER_EMAIL, lower-case). There is no admin flag."""
    return config.env("OWNER_EMAIL").strip().lower()


def _migrate_to_users() -> None:
    """Round 2 (one owner) -> round 3 (users), in place, once, in one transaction. Every call, key, profile value
    and push device goes to the admin (OWNER_EMAIL); sessions and sign-in tokens are dropped (sign in again).
    SQLite cannot change a primary key, so `profile` is copied into a new table keyed by (user_id, key)."""
    admin = admin_email()
    owned = [t for t in ("calls", "api_keys", "profile", "push_subscriptions") if _columns(t)]
    if not admin and any(_q(f"SELECT 1 FROM {t} LIMIT 1").fetchone() for t in owned):
        raise SystemExit("the database holds data from before user accounts: set OWNER_EMAIL to the admin's "
                         "address, so that this data can be given to the admin")
    _q("BEGIN IMMEDIATE")
    try:
        _q(USERS_TABLE)
        uid = None
        if admin:
            uid = new_id("u_")
            _q("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", (uid, admin, now()))
        for t in owned:
            if t != "profile":
                _q(f"ALTER TABLE {t} ADD COLUMN user_id TEXT")
                _q(f"UPDATE {t} SET user_id = ?", (uid,))
        if "profile" in owned:
            _q("ALTER TABLE profile RENAME TO profile_round2")
            _q(PROFILE_TABLE)
            _q("INSERT INTO profile (user_id, key, value) SELECT ?, key, value FROM profile_round2", (uid,))
            # The admin verified this number before verification was per user: it stays theirs.
            _q("INSERT INTO profile (user_id, key, value) SELECT ?, ?, value FROM profile_round2 "
               "WHERE key = 'callback_number'", (uid, config.CALLER_ID_CLAIM))
            _q("DROP TABLE profile_round2")
        _q("DROP TABLE IF EXISTS sessions")
        _q("DROP TABLE IF EXISTS signin_tokens")
        _q("COMMIT")
    except BaseException:
        _q("ROLLBACK")
        raise


def env_key_imported(mark: bool = False) -> bool:
    """SQLite's user_version is 1 after the one-time import of the .env key (auth.import_env_key)."""
    if mark:
        _q("PRAGMA user_version = 1")
    return _q("PRAGMA user_version").fetchone()[0] == 1


def now(offset_seconds: float = 0) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id(prefix: str) -> str:
    return prefix + secrets.token_urlsafe(9).replace("-", "a").replace("_", "b")


def _q(sql: str, args=()) -> sqlite3.Cursor:
    assert db is not None, "store.open_db() was not called"
    return db.execute(sql, args)


def _rows(sql: str, args=()) -> list[dict]:
    return [dict(r) for r in _q(sql, args)]


def _row(sql: str, args=()) -> dict | None:
    r = _q(sql, args).fetchone()
    return dict(r) if r else None


# --- users ---

def add_user(email: str) -> dict:
    uid = new_id("u_")
    _q("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)", (uid, email.strip().lower(), now()))
    return get_user(uid)


def get_user(user_id: str) -> dict | None:
    return _row("SELECT * FROM users WHERE id = ?", (user_id,))


def user_by_email(email: str) -> dict | None:
    return _row("SELECT * FROM users WHERE email = ?", (email.strip().lower(),))


def users() -> list[dict]:
    return _rows("SELECT * FROM users ORDER BY created_at, rowid")


def set_user_disabled(user_id: str, disabled: bool) -> bool:
    return _q("UPDATE users SET disabled = ? WHERE id = ?", (int(disabled), user_id)).rowcount > 0


def user_seen(user_id: str) -> None:
    """last_seen_at, written at most every USER_SEEN_WRITE_SECONDS (ISO strings sort by time)."""
    _q("UPDATE users SET last_seen_at = ? WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?)",
       (now(), user_id, now(-config.USER_SEEN_WRITE_SECONDS)))


def delete_user(user_id: str) -> list[str]:
    """Deletes the user and all their data in one transaction. Returns the recording sids (cached files)."""
    sids = [r[0] for r in _q("SELECT recording_sid FROM calls WHERE user_id = ? AND recording_sid IS NOT NULL",
                             (user_id,))]
    email = (get_user(user_id) or {}).get("email")
    _q("BEGIN IMMEDIATE")
    try:
        mine = "SELECT id FROM calls WHERE user_id = ?"
        _q(f"DELETE FROM lines WHERE call_id IN ({mine})", (user_id,))
        _q(f"DELETE FROM questions WHERE call_id IN ({mine})", (user_id,))
        for t in ("calls", "profile", "api_keys", "sessions", "push_subscriptions"):
            _q(f"DELETE FROM {t} WHERE user_id = ?", (user_id,))
        _q("DELETE FROM signin_tokens WHERE email = ?", (email,))
        _q("DELETE FROM users WHERE id = ?", (user_id,))
        _q("COMMIT")
    except BaseException:
        _q("ROLLBACK")
        raise
    return sids


def usage() -> dict[str, dict]:
    """Per user: outbound call count, talk seconds in total and today. Usage numbers only, no call content."""
    day = now()[:10]
    rows = _q("SELECT user_id, COUNT(*), COALESCE(SUM(talk_seconds), 0), "
              "COALESCE(SUM(CASE WHEN created_at >= ? THEN talk_seconds END), 0) "
              "FROM calls WHERE direction = 'outbound' GROUP BY user_id", (day,))
    return {r[0]: {"calls": r[1], "seconds": r[2], "seconds_today": r[3]} for r in rows}


# --- service settings (the admin's switches; JSON values) ---

def service_setting(key: str, default):
    r = _q("SELECT value FROM service WHERE key = ?", (key,)).fetchone()
    return json.loads(r[0]) if r else default


def set_service_setting(key: str, value) -> None:
    _q("INSERT INTO service (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
       (key, json.dumps(value)))


# --- calls ---

def insert_call(row: dict) -> None:
    assert row.get("user_id"), "every call belongs to a user"
    cols = ", ".join(row)
    _q(f"INSERT INTO calls ({cols}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))
    on_change(row["id"])


def update_call(call_id: str, if_status: str | None = None, **fields) -> bool:
    """Updates a call row; with if_status only while the row still has that status. True when a row changed."""
    if not fields:
        return False
    sets = ", ".join(f"{k} = ?" for k in fields)  # keys are code constants, never user input
    sql, args = f"UPDATE calls SET {sets} WHERE id = ?", (*fields.values(), call_id)
    if if_status:
        sql, args = sql + " AND status = ?", (*args, if_status)
    changed = _q(sql, args).rowcount > 0
    if changed:
        on_change(call_id)
    return changed


def get_call(call_id: str) -> dict | None:
    """System paths only (webhooks, the bot, timers). A user's request goes through user_call."""
    return _row("SELECT * FROM calls WHERE id = ?", (call_id,))


def user_call(user_id: str, call_id: str) -> dict | None:
    return _row("SELECT * FROM calls WHERE id = ? AND user_id = ?", (call_id, user_id))


def find_call(column: str, value: str) -> dict | None:
    assert column in ("ws_token", "recording_token", "twilio_sid")
    return _row(f"SELECT * FROM calls WHERE {column} = ?", (value,))


def list_calls(user_id: str, limit: int) -> list[dict]:
    return _rows("SELECT * FROM calls WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?", (user_id, limit))


def live_calls() -> list[dict]:
    """Live outbound calls of all users (the shared limits; inbound forwards are not ours to limit)."""
    marks = ", ".join("?" * len(config.LIVE_STATUSES))
    return _rows(f"SELECT * FROM calls WHERE status IN ({marks}) AND direction = 'outbound'", config.LIVE_STATUSES)


def user_live_calls(user_id: str) -> list[dict]:
    """A user's unfinished calls in both directions (hung up when the admin disables or removes the user)."""
    marks = ", ".join("?" * len(config.LIVE_STATUSES))
    return _rows(f"SELECT * FROM calls WHERE user_id = ? AND status IN ({marks})", (user_id, *config.LIVE_STATUSES))


def last_call_to(number: str, since: str, user_id: str | None = None) -> dict | None:
    """The newest outbound call to `number` since `since` (of one user, or of anyone for callback routing)."""
    # Routing counts only calls that were answered: a call that never connected must not capture callbacks.
    mine = " AND user_id = ?" if user_id else " AND answered_at IS NOT NULL"
    return _row("SELECT user_id, business FROM calls WHERE direction = 'outbound' AND to_number = ? AND created_at >= ?"
                f"{mine} ORDER BY created_at DESC, rowid DESC LIMIT 1", (number, since, *([user_id] if user_id else [])))


def talk_seconds_today(user_id: str | None = None) -> int:
    """All users (the service's daily cap), or one user."""
    mine = " AND user_id = ?" if user_id else ""
    return _q(f"SELECT COALESCE(SUM(talk_seconds), 0) FROM calls WHERE created_at >= ? AND direction = 'outbound'{mine}",
              (now()[:10], *([user_id] if user_id else []))).fetchone()[0]


# --- transcript lines ---

def add_line(call_id: str, who: str, text: str, at: float | None = None) -> int:
    """`at`: seconds from the start of the recording to the start of the utterance, when known.
    Nothing is stored for a call that no longer exists (its user was removed while the bot still spoke)."""
    n = _q("SELECT COALESCE(MAX(n), -1) + 1 FROM lines WHERE call_id = ?", (call_id,)).fetchone()[0]
    _q("INSERT INTO lines (call_id, n, t, who, text, at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS "
       "(SELECT 1 FROM calls WHERE id = ?)", (call_id, n, now(), who, text, at, call_id))
    on_change(call_id)
    return n


def lines(call_id: str, since: int = 0) -> list[dict]:
    return _rows("SELECT n, t, who, text, at FROM lines WHERE call_id = ? AND n >= ? ORDER BY n", (call_id, since))


def next_line(call_id: str) -> int:
    return _q("SELECT COALESCE(MAX(n), -1) + 1 FROM lines WHERE call_id = ?", (call_id,)).fetchone()[0]


# --- questions ---

def add_question(call_id: str, question: str) -> str:
    qid = new_id("q_")
    _q("INSERT INTO questions (id, call_id, question, asked_at) VALUES (?, ?, ?, ?)", (qid, call_id, question, now()))
    on_change(call_id)
    return qid


def get_question(qid: str) -> dict | None:
    """Callers check that the question's call_id is the (user-checked) call."""
    return _row("SELECT * FROM questions WHERE id = ?", (qid,))


def answer_question(qid: str, answer: str) -> None:
    q = get_question(qid)
    _q("UPDATE questions SET answer = ?, answered_at = ? WHERE id = ?", (answer, now(), qid))
    if q:
        on_change(q["call_id"])


def questions(call_id: str) -> list[dict]:
    return _rows("SELECT * FROM questions WHERE call_id = ? ORDER BY asked_at, rowid", (call_id,))


# --- profile (one row per user and setting, JSON values) ---

def get_profile(user_id: str) -> dict:
    return {r["key"]: json.loads(r["value"]) for r in _q("SELECT key, value FROM profile WHERE user_id = ?", (user_id,))}


def save_profile(user_id: str, changes: dict) -> None:
    """Merge: a value of None removes the key (back to the default)."""
    for k, v in changes.items():
        if v is None:
            _q("DELETE FROM profile WHERE user_id = ? AND key = ?", (user_id, k))
        else:
            _q("INSERT INTO profile (user_id, key, value) VALUES (?, ?, ?) "
               "ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value", (user_id, k, json.dumps(v)))


def profile_names() -> dict[str, str]:
    """user id -> profile name, for the admin's usage list."""
    return {r[0]: json.loads(r[1]) for r in _q("SELECT user_id, value FROM profile WHERE key = 'name'")}


def caller_id_claim_busy(user_id: str, number: str) -> bool:
    """True while another user's verification of this number may still be going on. Without this, user B could
    take the claim during user A's verification call, and A's code entry would then verify the number for B."""
    since = json.dumps(now(-config.CALLER_ID_CLAIM_SECONDS))
    return _q("SELECT 1 FROM profile c JOIN profile t ON t.user_id = c.user_id AND t.key = ? "
              "WHERE c.key = ? AND c.value = ? AND c.user_id != ? AND t.value > ?",
              (config.CALLER_ID_CLAIM_AT, config.CALLER_ID_CLAIM, json.dumps(number), user_id, since)).fetchone() is not None


def claim_caller_id(user_id: str, number: str) -> None:
    """The user who starts a verification of a number holds it alone: an old unfinished claim of another user
    ends, so that it cannot become valid when the number's real owner verifies it later."""
    _q("DELETE FROM profile WHERE key = ? AND value = ?", (config.CALLER_ID_CLAIM, json.dumps(number)))
    save_profile(user_id, {config.CALLER_ID_CLAIM: number, config.CALLER_ID_CLAIM_AT: now()})


# --- push subscriptions ---

def push_devices(user_id: str) -> list[dict]:
    return _rows("SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at", (user_id,))


def save_push_device(user_id: str, endpoint: str, p256dh: str, auth: str, label: str | None) -> None:
    """A device belongs to the user who subscribed it last (one browser, another account signed in)."""
    _q(
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth, label, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, "
        "user_id = excluded.user_id",
        (endpoint, p256dh, auth, label, now(), user_id),
    )


def delete_push_device(user_id: str, endpoint: str) -> None:
    _q("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?", (endpoint, user_id))


def push_ok(endpoint: str) -> None:
    _q("UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?", (now(), endpoint))


# --- agent keys (SHA-256 hashes only) ---

def keys(user_id: str) -> list[dict]:
    return _rows("SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at, rowid", (user_id,))


def key_by_hash(key_hash: str) -> dict | None:
    """The auth lookup: the key itself is the credential that names its user."""
    return _row("SELECT * FROM api_keys WHERE key_hash = ?", (key_hash,))


def get_key(user_id: str, key_id: str) -> dict | None:
    return _row("SELECT * FROM api_keys WHERE id = ? AND user_id = ?", (key_id, user_id))


def insert_key(row: dict) -> None:
    assert row.get("user_id"), "every key belongs to a user"
    _q(f"INSERT INTO api_keys ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))


def update_key(user_id: str, key_id: str, **fields) -> bool:
    sets = ", ".join(f"{k} = ?" for k in fields)  # keys are code constants, never user input
    return _q(f"UPDATE api_keys SET {sets} WHERE id = ? AND user_id = ?", (*fields.values(), key_id, user_id)).rowcount > 0


def delete_key(user_id: str, key_id: str) -> bool:
    return _q("DELETE FROM api_keys WHERE id = ? AND user_id = ?", (key_id, user_id)).rowcount > 0


def key_used(key_id: str) -> None:
    """Sets last_used_at unless it was written less than KEY_USE_WRITE_SECONDS ago (ISO strings sort by time)."""
    _q("UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)",
       (now(), key_id, now(-config.KEY_USE_WRITE_SECONDS)))


# --- console sessions and one-time sign-in tokens (hashes only) ---

def add_session(token_hash: str, user_id: str, expires_at: str) -> None:
    _q("DELETE FROM sessions WHERE expires_at <= ?", (now(),))
    _q("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", (token_hash, user_id, expires_at))


def session_user(token_hash: str) -> dict | None:
    """The user of an unexpired session."""
    return _row("SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id "
                "WHERE token_hash = ? AND expires_at > ?", (token_hash, now()))


def delete_session(token_hash: str) -> None:
    _q("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))


def add_signin_token(token_hash: str, email: str, expires_at: str) -> None:
    _q("DELETE FROM signin_tokens WHERE expires_at <= ?", (now(),))
    _q("INSERT INTO signin_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)",
       (token_hash, email.strip().lower(), expires_at))


def take_signin_token(token_hash: str) -> str | None:
    """The address the token was made for, once, while unexpired; any attempt uses it up."""
    rows = _q("DELETE FROM signin_tokens WHERE token_hash = ? RETURNING email, expires_at", (token_hash,)).fetchall()
    return rows[0][0] if rows and rows[0][1] > now() else None


# --- restart ---

def restart_cleanup() -> list[dict]:
    """Mark every unfinished call failed. Returns those rows so their Twilio legs can be hung up."""
    marks = ", ".join("?" * len(config.LIVE_STATUSES))
    rows = _rows(f"SELECT * FROM calls WHERE status IN ({marks})", config.LIVE_STATUSES)
    for r in rows:
        update_call(r["id"], status="failed", error="server restarted", ended_at=now(), phase=None)
    return rows
