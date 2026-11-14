"""Round 3: users, data separation (REST and MCP), admin, sign-up rules and limits, callback routing, migration."""

import asyncio
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from callenvoy import auth, calls, config, main, owner, push, store

from .conftest import CALL, KEY, owner_cookie, place, run, uid

ORIGIN = {"Origin": config.PUBLIC_ORIGIN}
API = "/callenvoy/api"


@pytest.fixture
def client():
    return TestClient(main.app, base_url="http://localhost:3020")  # no lifespan: the MCP manager runs once per process


def new_user(email="bo@example.com", name="Bo") -> str:
    u = store.add_user(email)["id"]
    if name:
        store.save_profile(u, {"name": name})
    return u


def bearer(key):
    return {"Authorization": f"Bearer {key}"}


def live(cid):
    store.update_call(cid, status="in_progress")
    calls.LIVE.setdefault(cid, calls.Live())


# --- migration ---

ROUND2 = """
CREATE TABLE calls (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, answered_at TEXT, ended_at TEXT, status TEXT NOT NULL,
  phase TEXT, to_number TEXT NOT NULL, business TEXT NOT NULL, goal TEXT NOT NULL, facts TEXT, menu_tips TEXT,
  flexibility TEXT, on_behalf_of TEXT, mode TEXT NOT NULL, connect_when TEXT, reach TEXT NOT NULL,
  alert_on_human INTEGER NOT NULL, listen_in INTEGER NOT NULL, alert_wait_seconds INTEGER NOT NULL,
  no_answer TEXT NOT NULL, max_minutes INTEGER NOT NULL, voice TEXT NOT NULL, record INTEGER NOT NULL,
  twilio_sid TEXT, ws_token TEXT, owner_twilio_sid TEXT, human_at TEXT, owner_seconds INTEGER, outcome_result TEXT,
  outcome_summary TEXT, outcome_details TEXT, talk_seconds INTEGER, error TEXT, recording_sid TEXT,
  recording_seconds INTEGER, recording_token TEXT, direction TEXT NOT NULL DEFAULT 'outbound', from_number TEXT,
  leave_voicemail INTEGER NOT NULL DEFAULT 1);
CREATE TABLE lines (call_id TEXT NOT NULL, n INTEGER NOT NULL, t TEXT NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL,
  at REAL, PRIMARY KEY (call_id, n));
CREATE TABLE questions (id TEXT PRIMARY KEY, call_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT,
  asked_at TEXT NOT NULL, answered_at TEXT);
CREATE TABLE profile (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, label TEXT,
  created_at TEXT NOT NULL, last_ok_at TEXT);
CREATE TABLE api_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, disabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, email TEXT, expires_at TEXT NOT NULL);
CREATE TABLE signin_tokens (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
INSERT INTO calls (id, created_at, status, to_number, business, goal, mode, reach, alert_on_human, listen_in,
  alert_wait_seconds, no_answer, max_minutes, voice, record, talk_seconds)
  VALUES ('c_old', '2026-11-12T10:00:00Z', 'completed', '+14155550123', 'Northstar', 'fix the bill', 'handle',
  'app', 1, 0, 20, 'ai_handles', 30, 'Hannah', 1, 125);
INSERT INTO lines VALUES ('c_old', 0, '2026-11-12T10:00:07Z', 'them', 'hello', 1.5);
INSERT INTO questions VALUES ('q_old', 'c_old', 'which bill?', 'October', '2026-11-12T10:00:09Z', NULL);
INSERT INTO profile VALUES ('name', '"Alex"'), ('callback_number', '"+14155550199"'), ('voice', '"Rohan"');
INSERT INTO push_subscriptions VALUES ('https://fcm.googleapis.com/x', 'p', 'a', 'phone', '2026-11-12T10:00:00Z', NULL);
INSERT INTO api_keys VALUES ('k_old', 'Claude Code', 'HASH', 'ce_live_abcd', '2026-11-12T10:00:00Z', NULL, 0);
INSERT INTO sessions VALUES ('S', 'me@example.com', '2099-01-01T00:00:00Z');
INSERT INTO signin_tokens VALUES ('T', '2099-01-01T00:00:00Z');
"""


def round2_db(path):
    db = sqlite3.connect(path)
    db.executescript(ROUND2)
    db.execute("PRAGMA user_version = 1")
    db.commit()
    db.close()


def test_round2_database_is_migrated_once_to_the_admin(tmp_path):
    path = tmp_path / "callenvoy.db"
    round2_db(path)
    store.open_db(path)
    admin = store.user_by_email("me@example.com")
    assert [u["email"] for u in store.users()] == ["me@example.com"]
    a = admin["id"]
    assert store.user_call(a, "c_old")["business"] == "Northstar" and store.lines("c_old")[0]["at"] == 1.5
    assert store.questions("c_old")[0]["answer"] == "October"
    assert calls.get_profile(a)["voice"] == "Rohan" and calls.get_profile(a)["name"] == "Alex"
    assert store.get_profile(a)[config.CALLER_ID_CLAIM] == "+14155550199"  # the admin's verified number stays usable
    assert [k["id"] for k in store.keys(a)] == ["k_old"] and store.key_by_hash("HASH")["user_id"] == a
    assert [d["label"] for d in store.push_devices(a)] == ["phone"]
    assert store.db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 0  # sign in again
    assert store.db.execute("SELECT COUNT(*) FROM signin_tokens").fetchone()[0] == 0
    assert store.env_key_imported()  # the round 2 marker is kept
    # the new tables work: a second user and a call of theirs
    b = new_user()
    assert store.list_calls(b, 10) == [] and calls.get_profile(b)["voice"] == config.DEFAULT_VOICE
    store.open_db(path)  # again: nothing changes, no second admin
    assert len(store.users()) == 2 and store.user_call(a, "c_old")


def test_migration_refuses_without_owner_email_and_leaves_the_database(tmp_path, monkeypatch):
    path = tmp_path / "callenvoy.db"
    round2_db(path)
    monkeypatch.delenv("OWNER_EMAIL")
    with pytest.raises(SystemExit, match="OWNER_EMAIL"):
        store.open_db(path)
    old = sqlite3.connect(path)
    assert "user_id" not in {r[1] for r in old.execute("PRAGMA table_info(calls)")}
    assert old.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 1
    old.close()


def test_migration_rolls_back_on_error(tmp_path, monkeypatch):
    path = tmp_path / "callenvoy.db"
    round2_db(path)
    monkeypatch.setattr(store, "PROFILE_TABLE", "CREATE TABLE broken (")  # fails halfway through
    with pytest.raises(sqlite3.OperationalError):
        store.open_db(path)
    old = sqlite3.connect(path)
    assert "user_id" not in {r[1] for r in old.execute("PRAGMA table_info(api_keys)")}
    assert old.execute("SELECT value FROM profile WHERE key = 'name'").fetchone()[0] == '"Alex"'
    assert not old.execute("SELECT 1 FROM sqlite_master WHERE name IN ('users', 'profile_round2')").fetchall()
    old.close()


# --- data separation: REST ---

def test_two_users_cannot_see_or_change_each_others_data(client, fresh):
    a, b = uid(), new_user()
    ca, cb = owner_cookie(a), {**owner_cookie(b), **ORIGIN}
    cid = place()["id"]
    live(cid)
    qid = store.add_question(cid, "Which bill?")
    store.save_profile(a, {"callback_number": "+14155550199", "details": "secret"})
    a_key = store.keys(a)[0]["id"]
    sub = {"endpoint": "https://fcm.googleapis.com/fcm/send/a", "keys": {"p256dh": "p", "auth": "a"}}
    assert client.post(f"{API}/push/subscriptions", json=sub, headers=ca).json() == {"ok": True}

    # every call route answers 404 for A's call, like an unknown id
    for method, path, body in (
            ("GET", f"/calls/{cid}", None), ("GET", f"/calls/{cid}?wait_seconds=1", None),
            ("POST", f"/calls/{cid}/hang-up", None), ("POST", f"/calls/{cid}/hand-back", None),
            ("POST", f"/calls/{cid}/answer", {"question_id": qid, "answer": "x"}),
            ("POST", f"/calls/{cid}/connect", {"reach": "phone"}), ("POST", f"/calls/{cid}/audio-ticket", None)):
        r = client.request(method, API + path, json=body, headers=cb)
        unknown = client.request(method, API + path.replace(cid, "c_nope"), json=body, headers=cb)
        assert r.status_code == 404 and r.json() == {**unknown.json(), "detail": f"no call with id {cid}"}, path
    assert client.get(f"{API}/calls", headers=cb).json() == []
    assert fresh.updated == [] and fresh.created[1:] == []  # nothing was hung up or rung
    assert store.questions(cid)[0]["answer"] is None

    # profile, caller ID, keys and push devices are B's own
    assert client.get(f"{API}/profile", headers=cb).json()["details"] is None
    assert client.put(f"{API}/profile", json={"details": "mine"}, headers=cb).json()["details"] == "mine"
    assert calls.get_profile(a)["details"] == "secret"
    assert client.get(f"{API}/caller-id", headers=cb).json() == {"number": None, "verified": False}
    assert client.get(f"{API}/keys", headers=cb).json() == {"keys": []}
    assert client.patch(f"{API}/keys/{a_key}", json={"disabled": True}, headers=cb).status_code == 404
    assert client.delete(f"{API}/keys/{a_key}", headers=cb).status_code == 404
    assert store.get_key(a, a_key)["disabled"] == 0
    client.request("DELETE", f"{API}/push/subscriptions", json={"endpoint": sub["endpoint"]}, headers=cb)
    assert len(store.push_devices(a)) == 1 and store.push_devices(b) == []

    # A still sees everything of their own
    assert client.get(f"{API}/calls/{cid}", headers=ca).json()["open_questions"][0]["id"] == qid
    assert client.post(f"{API}/calls/{cid}/audio-ticket", headers=ca).status_code == 200


def test_agent_key_acts_only_for_its_user(client):
    b = new_user()
    _, b_key = auth.create_key(b, "Codex")
    cid = place()["id"]  # the admin's call
    assert client.get(f"{API}/calls/{cid}", headers=bearer(b_key)).status_code == 404
    assert client.get(f"{API}/calls", headers=bearer(b_key)).json() == []
    assert client.get(f"{API}/profile", headers=bearer(b_key)).json()["name"] == "Bo"
    r = client.post(f"{API}/calls", json=CALL, headers=bearer(b_key))
    assert store.user_call(b, r.json()["id"]) and not store.user_call(uid(), r.json()["id"])
    assert [c["id"] for c in client.get(f"{API}/calls", headers=bearer(KEY)).json()] == [cid]


def test_caller_id_verified_by_another_user_is_not_usable(fresh):
    a, b = uid(), new_user()
    for u in (a, b):
        store.save_profile(u, {"callback_number": "+14155550199"})
    run(calls.verify_number(b))  # B starts it but cannot type the code (not B's phone)
    run(calls.verify_number(a))
    fresh.verified.add("+14155550199")
    assert run(calls.caller_id(a))["verified"] is True and run(calls.caller_id(b))["verified"] is False
    with pytest.raises(calls.CallError, match="cannot be verified") as e:
        run(calls.verify_number(b))
    assert e.value.status == 409 and fresh.validations == ["+14155550199"] * 2
    with pytest.raises(calls.CallError, match="verif"):
        place(b, **{"from": "own"})
    with pytest.raises(calls.CallError, match="unknown setting"):  # the claim is not a setting anyone can save
        calls.save_profile(b, {config.CALLER_ID_CLAIM: "+14155550199"})
    assert config.CALLER_ID_CLAIM not in calls.get_profile(a)


def test_alerts_and_prompt_use_the_calls_user(monkeypatch, fresh):
    monkeypatch.setenv("VAPID_PUBLIC_KEY", "x")
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "x")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:x@example.com")
    sent = []
    monkeypatch.setattr(push, "_webpush", lambda sub, **kw: sent.append(sub["endpoint"]))
    b = new_user()
    store.save_push_device(uid(), "https://fcm.googleapis.com/a", "p", "a", None)
    store.save_push_device(b, "https://fcm.googleapis.com/b", "p", "a", None)
    store.save_profile(b, {"callback_number": "+14155550177"})
    v = place(b, mode="transfer", reach="phone")
    assert run(push.send_alert(store.get_call(v["id"]), "handover")) == 1 and sent == ["https://fcm.googleapis.com/b"]
    live(v["id"])
    run(owner.connect(b, v["id"], "join", "phone"))
    assert fresh.created[-1]["to"] == "+14155550177"  # B's phone, not the admin's
    assert owner._name(store.get_call(v["id"])) == "Bo"


# --- data separation: MCP (in process; the HTTP path is in test_main) ---

def test_mcp_tools_are_scoped_to_the_user():
    from mcp import Client

    from callenvoy import mcp_server

    cid = place()["id"]
    qid = store.add_question(cid, "Which bill?")
    b = new_user()
    token = auth.CURRENT_USER.set(store.get_user(b))

    async def go():
        async with Client(mcp_server.server) as c:
            for name, args in (("get_call", {}), ("hang_up", {}), ("hand_back", {}), ("get_recordings", {}),
                               ("connect_me", {}), ("answer_question", {"question_id": qid, "answer": "x"})):
                r = await c.call_tool("callenvoy_" + name, {"call_id": cid, **args})
                assert r.is_error and r.content[0].text == f"no call with id {cid}", name
            r = await c.call_tool("callenvoy_list_calls", {})
            assert r.structured_content == {"calls": []}
            r = await c.call_tool("callenvoy_get_profile", {})
            assert r.structured_content["name"] == "Bo"
            await c.call_tool("callenvoy_save_profile", {"details": "bo only"})
            r = await c.call_tool("callenvoy_verify_number", {})
            assert r.is_error and "callback_number" in r.content[0].text

    try:
        run(go())
    finally:
        auth.CURRENT_USER.reset(token)
    assert calls.get_profile(b)["details"] == "bo only" and calls.get_profile(uid())["details"] is None
    assert store.get_call(cid)["status"] == "dialing"


def test_mcp_without_a_user_refuses():
    from mcp import Client

    from callenvoy import mcp_server

    async def go():
        async with Client(mcp_server.server) as c:
            r = await c.call_tool("callenvoy_list_calls", {})
            assert r.is_error
    run(go())


# --- admin ---

def test_admin_routes_are_404_for_everyone_else(client):
    b = new_user()
    _, b_key = auth.create_key(b, "x")
    for headers in ({**owner_cookie(b), **ORIGIN}, bearer(b_key), bearer(KEY)):
        for method, path in (("GET", "/admin/users"), ("PATCH", f"/admin/users/{uid()}"),
                             ("DELETE", f"/admin/users/{uid()}"), ("PUT", "/admin/settings")):
            r = client.request(method, API + path, json={"disabled": True, "signups_open": False}, headers=headers)
            assert r.status_code == 404 and r.json() == {"detail": "not found"}, (path, headers)
    r = client.put(f"{API}/admin/settings", json={"signups_open": "x"}, headers={**owner_cookie(b), **ORIGIN})
    assert r.status_code == 404  # not a validation error: the route does not show itself
    assert not store.get_user(uid())["disabled"] and auth.signups_open()


def test_admin_list_is_usage_only(client):
    b = new_user()
    v = place(b)
    store.update_call(v["id"], status="completed", talk_seconds=150)
    live(place(b)["id"])
    store.save_profile(b, {"details": "private", "callback_number": "+14155550177"})
    users = client.get(f"{API}/admin/users", headers=owner_cookie()).json()
    assert users["signups_open"] is True
    me, bo = users["users"]
    assert set(bo) == {"id", "email", "name", "created_at", "last_seen_at", "disabled", "is_admin", "calls",
                       "minutes", "minutes_today", "live_calls"}
    assert (bo["email"], bo["name"], bo["calls"], bo["minutes"], bo["minutes_today"], bo["live_calls"]) == \
        ("bo@example.com", "Bo", 2, 2, 2, 1)
    assert me["is_admin"] is True and bo["is_admin"] is False and me["calls"] == 0
    for secret in ("private", "+14155550177", "Northstar", CALL["goal"]):
        assert secret not in json.dumps(users)


def test_disable_enable_and_remove(client, fresh, tmp_path, monkeypatch):
    admin = {**owner_cookie(), **ORIGIN}
    b = new_user()
    _, b_key = auth.create_key(b, "x")
    b_cookie = owner_cookie(b)
    cid = place(b)["id"]
    live(cid)
    assert client.patch(f"{API}/admin/users/{uid()}", json={"disabled": True}, headers=admin).status_code == 400
    assert client.delete(f"{API}/admin/users/{uid()}", headers=admin).status_code == 400
    assert client.patch(f"{API}/admin/users/u_nope", json={"disabled": True}, headers=admin).status_code == 404
    assert client.patch(f"{API}/admin/users/{b}", json={"disabled": "yes"}, headers=admin).status_code == 400

    r = client.patch(f"{API}/admin/users/{b}", json={"disabled": True}, headers=admin)
    assert r.status_code == 200 and r.json()["disabled"] is True
    assert (store.get_call(cid)["twilio_sid"], {"hang_up": True}) in fresh.updated  # live call hung up
    for headers in (bearer(b_key), b_cookie):
        r = client.get(f"{API}/calls", headers=headers)
        assert r.status_code == 401 and r.json()["code"] == "account_disabled"
    assert client.get(f"{API}/auth/me", headers=b_cookie).json()["signed_in"] is False
    r = client.post(f"{API}/auth/request", json={"email": "bo@example.com"})
    assert r.status_code == 403 and r.json()["code"] == "account_disabled"
    token = auth.signin_link("bo@example.com").split("token=")[1]
    r = client.post(f"{API}/auth/verify", json={"token": token})
    assert r.status_code == 403 and r.json()["code"] == "account_disabled"

    assert client.patch(f"{API}/admin/users/{b}", json={"disabled": False}, headers=admin).json()["disabled"] is False
    assert client.get(f"{API}/calls", headers=bearer(b_key)).status_code == 200

    monkeypatch.setattr(config, "RECORDINGS_DIR", tmp_path)
    store.update_call(cid, recording_sid="RE" + "c" * 32, recording_token="t" * 32)
    (tmp_path / f"RE{'c' * 32}.mp3").write_bytes(b"mp3")
    store.add_line(cid, "them", "hello")
    store.save_push_device(b, "https://fcm.googleapis.com/b", "p", "a", None)
    assert client.delete(f"{API}/admin/users/{b}", headers=admin).status_code == 204
    assert store.get_user(b) is None and store.get_call(cid) is None and cid not in calls.LIVE
    for table in ("lines", "questions", "profile", "api_keys", "sessions", "push_subscriptions"):
        col = "call_id" if table in ("lines", "questions") else "user_id"
        assert not store.db.execute(f"SELECT 1 FROM {table} WHERE {col} = ?", (cid if col == "call_id" else b,)).fetchall()
    assert not (tmp_path / f"RE{'c' * 32}.mp3").exists()
    assert client.get(f"{API}/calls", headers=bearer(b_key)).json()["code"] == "bad_key"
    assert client.get(f"{API}/calls", headers=b_cookie).json()["code"] == "session_expired"
    store.add_line(cid, "ai", "late line from a stopping bot")
    assert store.lines(cid) == []  # not stored for a removed call


# --- sign-in for anyone ---

def test_signup_creates_the_user_at_first_verify(client, monkeypatch):
    mailed = []
    monkeypatch.setattr(auth, "mail_signin_link", mailed.append)
    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("MAIL_FROM", "ce@example.com")
    assert client.post(f"{API}/auth/request", json={"email": "New@Example.com"}).json() == {"ok": True}
    assert mailed == ["new@example.com"] and store.user_by_email("new@example.com") is None
    token = auth.signin_link("new@example.com").split("token=")[1]
    r = client.post(f"{API}/auth/verify", json={"token": token})
    assert r.json() == {"ok": True, "email": "new@example.com"}
    user = store.user_by_email("new@example.com")
    assert user["last_seen_at"] is not None
    me = client.get(f"{API}/auth/me", headers={"Cookie": f"ce_session={r.cookies['ce_session']}"}).json()
    assert me == {"signed_in": True, "email": "new@example.com", "mail_ready": True, "is_admin": False,
                  "signups_open": True, "first_run": True}
    with pytest.raises(calls.CallError, match="set your name") as e:
        place(user["id"])
    assert e.value.field == "name"
    store.save_profile(user["id"], {"name": "Nia"})
    assert client.get(f"{API}/auth/me", headers={"Cookie": f"ce_session={r.cookies['ce_session']}"}).json()["first_run"] is False


def test_signups_off(client):
    assert client.put(f"{API}/admin/settings", json={"signups_open": False}, headers=owner_cookie()).json() == \
        {"signups_open": False}
    assert client.get(f"{API}/auth/me").json()["signups_open"] is False
    r = client.post(f"{API}/auth/request", json={"email": "stranger@example.com"})
    assert r.status_code == 403 and r.json()["code"] == "signups_closed"
    token = auth.signin_link("stranger@example.com").split("token=")[1]  # a link from before the switch
    assert client.post(f"{API}/auth/verify", json={"token": token}).json()["code"] == "signups_closed"
    assert store.user_by_email("stranger@example.com") is None
    new_user()
    assert client.post(f"{API}/auth/request", json={"email": "bo@example.com"}).status_code == 200
    assert client.post(f"{API}/auth/request", json={"email": "me@example.com"}).status_code == 200
    store.delete_user(uid())  # the admin can always come back, even as a new user
    token = auth.signin_link("me@example.com").split("token=")[1]
    assert client.post(f"{API}/auth/verify", json={"token": token}).status_code == 200


def test_signin_rate_limits(client, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(auth, "clock", lambda: now[0])

    def ask(email, ip="198.51.100.1"):
        return client.post(f"{API}/auth/request", json={"email": email},
                           headers={"X-Forwarded-For": f"203.0.113.9, {ip}"}).status_code

    assert [ask("a@example.com") for _ in range(4)] == [200, 200, 200, 429]  # per address
    assert [ask(f"u{i}@example.com") for i in range(8)] == [200] * 7 + [429]  # per IP (the last hop only): 10
    now[0] += 3601
    assert ask("a@example.com") == 200
    for i in range(60 - 11):  # global, over a day, from many addresses and IPs (11 so far)
        assert ask(f"g{i}@example.com", ip=f"10.0.{i}.1") == 200
    assert ask("z@example.com", ip="10.9.9.9") == 429
    now[0] += 86400
    assert ask("z@example.com", ip="10.9.9.9") == 200


# --- shared limits, config, demo line ---

def test_limits_are_shared_and_config_shows_own_minutes(client):
    b = new_user()
    v = place()
    store.update_call(v["id"], status="completed", talk_seconds=600)
    place()
    place()
    with pytest.raises(calls.CallError, match="service is busy") as e:
        place(b)
    assert e.value.status == 429
    cfg = client.get(f"{API}/config", headers=owner_cookie(b)).json()
    assert cfg["limits"]["minutes_used_today"] == 10 and cfg["limits"]["my_minutes_today"] == 0
    assert cfg["demo"] == config.DEMO_CALL and cfg["demo"]["number"] == "+16562405137"


def test_demo_line_always_uses_the_callenvoy_number(fresh):
    store.save_profile(uid(), {"callback_number": "+14155550199", "caller_id": "own"})
    v = place(to=config.DEMO_LINE_NUMBER)
    assert v["calling_number"] == "+19186021019" and fresh.created[-1]["from_number"] is None


# --- inbound callback routing ---

def test_inbound_goes_to_the_last_caller_else_the_admin():
    a, b = uid(), new_user()
    store.save_profile(a, {"callback_number": "+14155550199"})
    store.save_profile(b, {"callback_number": "+14155550177"})
    place(business="Admin's dentist")
    place(b, business="Bo's bank")
    for r in store.live_calls():
        store.update_call(r["id"], status="completed")

    fwd = calls.inbound({"From": "+14155550123", "CallSid": "CA1"})
    row = store.get_call(fwd["id"])
    assert fwd["forward_to"] == "+14155550177" and row["user_id"] == b and row["business"] == "Bo's bank"

    store.set_user_disabled(b, True)  # disabled: the admin gets it, named after the admin's own call
    fwd = calls.inbound({"From": "+14155550123", "CallSid": "CA2"})
    row = store.get_call(fwd["id"])
    assert fwd["forward_to"] == "+14155550199" and row["user_id"] == a and row["business"] == "Admin's dentist"

    fwd = calls.inbound({"From": "+14155550100", "CallSid": "CA3"})  # nobody called it: the admin
    assert fwd["forward_to"] == "+14155550199" and store.get_call(fwd["id"])["business"] == "Incoming call"

    store.set_user_disabled(b, False)
    store.save_profile(b, {"callback_number": None})  # B has no callback number: the admin, without B's name
    fwd = calls.inbound({"From": "+14155550123", "CallSid": "CA4"})
    assert fwd["forward_to"] == "+14155550199" and store.get_call(fwd["id"])["business"] == "Admin's dentist"

    store.save_profile(a, {"callback_number": None})
    assert calls.inbound({"From": "+14155550100", "CallSid": "CA5"}) is None  # nobody to forward to


def test_inbound_long_poll_is_scoped():
    b = new_user()
    store.save_profile(b, {"callback_number": "+14155550177"})
    place(b)
    fwd = calls.inbound({"From": CALL["to"], "CallSid": "CA1"})

    async def go():
        with pytest.raises(calls.CallError):
            await calls.get_call(uid(), fwd["id"], wait_seconds=5)
        assert (await asyncio.wait_for(calls.get_call(b, fwd["id"]), 1))["direction"] == "inbound"
    run(go())
