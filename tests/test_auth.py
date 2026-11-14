"""Round 2: agent keys, the owner's email sign-in and session, recording Range requests, transcript `at`."""

import asyncio
import os
import sqlite3
import stat

import pytest
from fastapi.testclient import TestClient

from callenvoy import auth, calls, config, main, store, twilio_api

from .conftest import CALL, KEY, owner_cookie, run, uid

ORIGIN = {"Origin": config.PUBLIC_ORIGIN}


@pytest.fixture
def client():
    return TestClient(main.app, base_url="http://localhost:3020")  # no lifespan: the MCP manager runs once per process


def bearer(key):
    return {"Authorization": f"Bearer {key}"}


def test_keys_lifecycle(client):
    owner = {**owner_cookie(), **ORIGIN}
    keys = client.get("/callenvoy/api/keys", headers=owner).json()["keys"]
    assert [k["name"] for k in keys] == [config.IMPORTED_KEY_NAME] and keys[0]["prefix"] == KEY[:12]
    assert client.post("/callenvoy/api/keys", json={"name": "  "}, headers=owner).json()["field"] == "name"
    assert client.post("/callenvoy/api/keys", json={"name": "x" * 41}, headers=owner).status_code == 400
    r = client.post("/callenvoy/api/keys", json={"name": " Claude Code "}, headers=owner)
    new = r.json()
    assert r.status_code == 201 and new["name"] == "Claude Code" and set(new) == {"id", "name", "prefix", "created_at", "key"}
    key = new["key"]
    assert key.startswith("ce_live_") and len(key) == 40 and new["prefix"] == key[:12]
    assert not set(key[8:]) - set(config.KEY_ALPHABET)
    assert key not in str(store.keys(uid()))  # only the hash is stored
    listed = client.get("/callenvoy/api/keys", headers=owner).json()["keys"][1]
    assert listed["last_used_at"] is None and listed["disabled"] is False and "key" not in listed
    assert client.get("/callenvoy/api/profile", headers=bearer(key)).status_code == 200
    assert store.get_key(uid(), new["id"])["last_used_at"] is not None
    r = client.patch(f"/callenvoy/api/keys/{new['id']}", json={"disabled": True}, headers=owner)
    assert r.json()["disabled"] is True and r.json()["name"] == "Claude Code"
    r = client.get("/callenvoy/api/profile", headers=bearer(key))
    assert r.status_code == 401 and r.json()["code"] == "key_disabled"
    r = client.patch(f"/callenvoy/api/keys/{new['id']}", json={"disabled": False, "name": "Codex"}, headers=owner)
    assert r.json()["name"] == "Codex" and client.get("/callenvoy/api/profile", headers=bearer(key)).status_code == 200
    assert client.delete(f"/callenvoy/api/keys/{new['id']}", headers=owner).status_code == 204
    assert client.get("/callenvoy/api/profile", headers=bearer(key)).json()["code"] == "bad_key"
    assert client.delete(f"/callenvoy/api/keys/{new['id']}", headers=owner).status_code == 404
    assert client.patch("/callenvoy/api/keys/k_nope", json={}, headers=owner).status_code == 404


def test_key_limit(client):
    owner = {**owner_cookie(), **ORIGIN}
    for i in range(config.MAX_KEYS - 1):
        auth.create_key(uid(), f"k{i}")
    assert client.post("/callenvoy/api/keys", json={"name": "one more"}, headers=owner).status_code == 409


def test_agent_key_refused_on_owner_routes(client):
    for method, path in (("GET", "/api/keys"), ("POST", "/api/keys"), ("PATCH", "/api/keys/x"),
                         ("DELETE", "/api/keys/x"), ("POST", "/api/push/test"), ("POST", "/api/push/subscriptions")):
        r = client.request(method, "/callenvoy" + path, headers=bearer(KEY), json={})
        assert r.status_code == 403 and r.json()["code"] == "owner_only", path
    # the agent routes still work with the key, and the owner session opens them too
    assert client.get("/callenvoy/api/calls", headers=bearer(KEY)).status_code == 200
    assert client.get("/callenvoy/api/calls", headers=owner_cookie()).status_code == 200


def test_error_codes_and_key_cleaning(client):
    def code(headers, path="/callenvoy/api/profile"):
        r = client.get(path, headers=headers)
        assert r.status_code == 401 and set(r.json()) == {"error", "code"}
        return r.json()["code"]

    assert code({}) == "no_credential"
    assert code(bearer("")) == "no_credential"
    assert code(bearer("ce_live_" + "a" * 31)) == "malformed_key"
    assert code(bearer("ce_live_" + "0" * 32)) == "malformed_key"  # look-alike characters never occur
    assert code(bearer("ce_live_" + "a" * 32)) == "bad_key"
    assert code(bearer("sk-" + "a" * 40)) == "malformed_key"
    assert code({"Cookie": f"{config.SESSION_COOKIE}=gone"}) == "session_expired"
    r = client.get("/callenvoy/api/profile", headers=bearer("ce_live_" + "a" * 31))
    assert "ce_live_aaaa" not in r.json()["error"] and "31" in r.json()["error"]
    _, key = auth.create_key(uid(), "Cursor")
    for messy in (f"Bearer {key}", f'"{key}"', f"  {key}\n", key.replace("_", "%5F")):
        assert client.get("/callenvoy/api/profile", headers=bearer(messy)).status_code == 200, messy
    assert auth.clean_key(f"Bearer 'Bearer {key}' ") == key and auth.clean_key("Bearer") == ""


def test_last_used_written_at_most_once_a_minute():
    row, key = auth.create_key(uid(), "Codex")
    auth.check_key(key)
    first = store.get_key(uid(), row["id"])["last_used_at"]
    store.update_key(uid(), row["id"], last_used_at="2000-01-01T00:00:00Z")
    auth.check_key(key)
    assert store.get_key(uid(), row["id"])["last_used_at"] == first  # older than a minute: rewritten
    store.update_key(uid(), row["id"], last_used_at=store.now(-30))
    auth.check_key(key)
    assert store.get_key(uid(), row["id"])["last_used_at"] == store.now(-30)  # 30 s ago: left alone


def test_env_key_import(monkeypatch):
    assert len(store.keys(uid())) == 1  # conftest imported "k" * 40
    auth.import_env_key()
    assert len(store.keys(uid())) == 1  # not again once the table has keys
    store.delete_key(uid(), store.keys(uid())[0]["id"])
    auth.import_env_key()
    assert store.keys(uid()) == []  # a deleted key does not come back at the next start
    store.open_db(":memory:")
    monkeypatch.delenv("CALLENVOY_API_KEY")
    auth.import_env_key()
    assert store.keys(uid()) == []
    main.startup_checks()  # dev mode, no env key: starts (keys come from the console)


def test_signin_token_one_use_and_expiry(client):
    token = auth.signin_link("me@example.com").split("token=")[1]
    assert client.get(f"/callenvoy/signin?token={token}").status_code in (200, 404)  # the page does not use it
    r = client.post("/callenvoy/api/auth/verify", json={"token": token}, headers=ORIGIN)
    assert r.status_code == 200 and r.json() == {"ok": True, "email": "me@example.com"}
    cookie = r.headers["set-cookie"]
    for part in ("ce_session=", "HttpOnly", "Secure", "SameSite=strict", "Path=/callenvoy", "Max-Age=2592000"):
        assert part in cookie
    session = r.cookies[config.SESSION_COOKIE]
    me = client.get("/callenvoy/api/auth/me", headers={"Cookie": f"ce_session={session}"}).json()
    assert me == {"signed_in": True, "email": "me@example.com", "mail_ready": False, "is_admin": True,
                  "signups_open": True, "first_run": False}
    r = client.post("/callenvoy/api/auth/verify", json={"token": token}, headers=ORIGIN)
    assert r.status_code == 400 and r.json()["code"] == "bad_link"  # used
    store.add_signin_token(auth.digest("old"), "me@example.com", "2000-01-01T00:00:00Z")
    assert client.post("/callenvoy/api/auth/verify", json={"token": "old"}).json()["code"] == "bad_link"  # expired
    assert client.post("/callenvoy/api/auth/verify", json={"token": "nope"}).json()["code"] == "bad_link"
    r = client.post("/callenvoy/api/auth/sign-out", headers={"Cookie": f"ce_session={session}", **ORIGIN})
    assert r.json() == {"ok": True} and 'ce_session=""' in r.headers["set-cookie"]
    assert client.get("/callenvoy/api/keys", headers={"Cookie": f"ce_session={session}"}).json()["code"] == "session_expired"


def test_session_expiry():
    token = auth.new_session(uid())
    store.db.execute("UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z'")
    assert auth.session(token) is None


def test_signin_request_mail_and_rate_limit(client, monkeypatch):
    mailed, sent = [], []
    monkeypatch.setattr(auth, "mail_signin_link", lambda email: mailed.append(email))
    for k, v in {"SMTP_HOST": "smtp.example.com", "MAIL_FROM": "ce@example.com"}.items():
        monkeypatch.setenv(k, v)
    assert client.get("/callenvoy/api/auth/me").json() == {"signed_in": False, "email": None, "mail_ready": True,
                                                           "is_admin": False, "signups_open": True, "first_run": False}
    assert client.post("/callenvoy/api/auth/request", json={"email": "other@example.com"}).json() == {"ok": True}
    assert client.post("/callenvoy/api/auth/request", json={"email": " me@example.COM "}).json() == {"ok": True}
    assert mailed == ["other@example.com", "me@example.com"]  # open sign-up: any valid address gets a link
    for bad in ("nope", "a@b", "a b@example.com", "x@" + "e" * 260 + ".com"):
        r = client.post("/callenvoy/api/auth/request", json={"email": bad})
        assert r.status_code == 400 and r.json()["code"] == "bad_email", bad
    monkeypatch.undo()
    monkeypatch.setattr(auth, "send_mail", lambda to, subject, text: sent.append((to, text)))

    async def mail():
        auth.mail_signin_link("new@example.com")
        await asyncio.gather(*auth._sending)
    run(mail())
    assert len(sent) == 1 and sent[0][0] == "new@example.com"
    assert "CallEnvoy" in sent[0][1] and "one time, for 15 minutes" in sent[0][1]
    token = sent[0][1].split("https://pragnyalabs.com/callenvoy/signin?token=")[1].split()[0]
    assert auth.take_signin_token(token) == "new@example.com"  # the link is bound to the address


def test_origin_check_on_cookie_writes(client):
    cookie = owner_cookie()
    evil = {"Origin": "https://evil.example.com"}
    r = client.post("/callenvoy/api/keys", json={"name": "x"}, headers={**cookie, **evil})
    assert r.status_code == 403 and r.json()["code"] == "bad_origin"
    assert client.post("/callenvoy/api/auth/verify", json={"token": "x"}, headers=evil).status_code == 403
    assert client.get("/callenvoy/api/keys", headers={**cookie, **evil}).status_code == 200  # reads are not checked
    assert client.post("/callenvoy/api/keys", json={"name": "x"}, headers=cookie).status_code == 201  # no Origin
    assert client.post("/callenvoy/api/keys", json={"name": "y"}, headers={**cookie, **ORIGIN}).status_code == 201


def test_old_database_is_migrated(tmp_path):
    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.execute("CREATE TABLE lines (call_id TEXT NOT NULL, n INTEGER NOT NULL, t TEXT NOT NULL, "
                "who TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (call_id, n))")
    old.execute("INSERT INTO lines VALUES ('c_1', 0, '2026-11-10T10:00:07Z', 'them', 'hello')")
    old.commit()
    old.close()
    store.open_db(path)
    assert store.lines("c_1") == [{"n": 0, "t": "2026-11-10T10:00:07Z", "who": "them", "text": "hello", "at": None}]
    assert store.keys(uid()) == []
    store.open_db(path)  # again: no error


def test_line_at_and_fallback(monkeypatch):
    v = run(calls.place_call(uid(), calls.PlaceCallInput(**CALL)))
    cid = v["id"]
    store.add_line(cid, "event", "before the answer", calls.line_at(cid))
    assert calls.line_at(cid) is None
    run(calls.on_status(cid, {"CallStatus": "in-progress"}))
    t0 = calls.LIVE[cid].answered
    assert calls.line_at(cid, t0 + 12.34) == 12.3 and calls.line_at(cid, t0 - 1) is None
    store.add_line(cid, "them", "hello", calls.line_at(cid, t0 + 3.06))
    store.add_line(cid, "ai", "old line")  # stored before `at` existed
    store.update_call(cid, answered_at="2026-11-10T10:00:00Z")
    store.db.execute("UPDATE lines SET t = '2026-11-10T10:00:09Z' WHERE n = 2")
    store.db.execute("UPDATE lines SET t = '2026-11-10T09:59:59Z' WHERE n = 0")
    view = run(calls.get_call(uid(), cid))["transcript"]
    assert [line["at"] for line in view] == [None, 3.1, 9.0]


def test_recording_range_and_cache(client, monkeypatch, tmp_path):
    monkeypatch.setattr(config, "RECORDINGS_DIR", tmp_path / "recordings")
    mp3 = bytes(range(256)) * 40
    fetched = []

    async def fake_fetch(sid):
        fetched.append(sid)
        for i in range(0, len(mp3), 1000):
            yield mp3[i:i + 1000]

    monkeypatch.setattr(twilio_api, "fetch_recording", fake_fetch)
    v = run(calls.place_call(uid(), calls.PlaceCallInput(**CALL)))
    store.update_call(v["id"], recording_sid="RE" + "a" * 32, recording_token="t" * 32, recording_seconds=9)
    url = "/callenvoy/r/" + "t" * 32
    r = client.get(url)
    assert r.status_code == 200 and r.content == mp3 and r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-length"] == str(len(mp3)) and r.headers["content-type"] == "audio/mpeg"
    r = client.get(url, headers={"Range": "bytes=100-199"})
    assert r.status_code == 206 and r.content == mp3[100:200]
    assert r.headers["content-range"] == f"bytes 100-199/{len(mp3)}" and r.headers["content-length"] == "100"
    r = client.get(url, headers={"Range": f"bytes={len(mp3)}-"})
    assert r.status_code == 416 and r.headers["content-range"] == f"bytes */{len(mp3)}"
    assert fetched == ["RE" + "a" * 32]  # fetched once, then served from disk
    assert stat.S_IMODE(os.stat(config.RECORDINGS_DIR).st_mode) == 0o700
    assert stat.S_IMODE(os.stat(config.RECORDINGS_DIR / f"RE{'a' * 32}.mp3").st_mode) == 0o600
    assert client.get("/callenvoy/r/" + "x" * 32).status_code == 404

    async def broken(sid):
        raise twilio_api.TwilioError("Twilio 404")
        yield b""

    monkeypatch.setattr(twilio_api, "fetch_recording", broken)
    store.update_call(v["id"], recording_sid="RE" + "b" * 32)
    assert client.get(url).status_code == 502
    assert list(config.RECORDINGS_DIR.iterdir()) == [config.RECORDINGS_DIR / f"RE{'a' * 32}.mp3"]  # no .part left


def test_agent_key_cannot_get_an_audio_ticket(client):
    """The ticket opens the owner's live audio: an agent key must not get one."""
    r = client.post("/callenvoy/api/calls/c_x/audio-ticket", headers={"Authorization": "Bearer " + "k" * 40})
    assert r.status_code == 403 and r.json()["code"] == "owner_only"
