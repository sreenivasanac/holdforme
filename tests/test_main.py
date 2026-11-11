"""The HTTP app end to end in-process: auth, console API, MCP, Twilio webhooks, audio socket, web export."""

import json
import xml.dom.minidom

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from callenvoy import calls, config, demo_line, guard, main, mcp_server, owner, store

from .conftest import CALL, KEY, run

AUTH = {"Authorization": f"Bearer {KEY}"}
BASE = "http://localhost:3020"


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    web = tmp_path_factory.mktemp("dist")
    (web / "index.html").write_text("<html>console</html>")
    (web / "sw.js").write_text("// sw")
    (web / "_expo").mkdir()
    (web / "_expo" / "app-1a2b.js").write_text("//")
    config.DB_PATH = tmp_path_factory.mktemp("db") / "callenvoy.db"
    config.WEB_DIR = web
    with TestClient(main.app, base_url=BASE) as c:  # the MCP session manager can run once per process
        yield c


def signed(client, path, form):
    sig = guard.twilio_signature(config.public_base_url() + path, form, "test-token")
    return client.post("/callenvoy" + path, data=form, headers={"X-Twilio-Signature": sig})


def test_web_export_routes(client):
    r = client.get("/callenvoy/calls/c_123")
    assert r.status_code == 200 and "console" in r.text and r.headers["cache-control"] == "no-cache"
    assert client.get("/callenvoy/sw.js").headers["cache-control"] == "no-cache"
    assert "immutable" in client.get("/callenvoy/_expo/app-1a2b.js").headers["cache-control"]
    assert client.get("/callenvoy/../pyproject.toml").text != open("pyproject.toml").read()
    assert client.get("/callenvoy/healthz").json() == {"ok": True}


def test_api_auth_and_unknown(client):
    assert client.get("/callenvoy/api/profile").status_code == 401
    assert client.get("/callenvoy/api/profile", headers={"Authorization": "Bearer wrong"}).json() == {"detail": "unauthorized"}
    r = client.get("/callenvoy/api/nothing", headers=AUTH)
    assert r.status_code == 404 and r.json() == {"detail": "not found"}
    cfg = client.get("/callenvoy/api/config", headers=AUTH).json()
    assert len(cfg["voices"]) == 10 and cfg["defaults"]["leave_voicemail"] is True
    assert cfg["choices"]["caller_id"] == ["callenvoy", "own"] and cfg["vapid_public_key"] is None


def test_console_call_flow_and_errors(client):
    r = client.post("/callenvoy/api/calls", json={**CALL, "to": "+19005550123"}, headers=AUTH)
    assert r.status_code == 400 and r.json()["field"] == "to"
    r = client.post("/callenvoy/api/calls", json={**CALL, "goal": "x"}, headers=AUTH)
    assert r.status_code == 400 and r.json()["field"] == "goal"
    cid = client.post("/callenvoy/api/calls", json={**CALL, "from": "callenvoy"}, headers=AUTH).json()["id"]
    v = client.get(f"/callenvoy/api/calls/{cid}", headers=AUTH).json()
    assert v["status"] == "dialing" and v["direction"] == "outbound" and v["calling_number"] == "+19186021019"
    assert v["leave_voicemail"] is True and v["recordings"] == [] and v["owner"]["state"] == "none"
    assert client.get("/callenvoy/api/calls", headers=AUTH).json()[0]["id"] == cid
    assert client.post(f"/callenvoy/api/calls/{cid}/audio-ticket", headers=AUTH).status_code == 409
    assert client.put("/callenvoy/api/profile", json={"mode": "x"}, headers=AUTH).json()["field"] == "mode"
    assert client.put("/callenvoy/api/profile", json={"name": "Alex"}, headers=AUTH).json()["name"] == "Alex"
    assert client.get("/callenvoy/api/caller-id", headers=AUTH).json() == {"number": None, "verified": False}
    assert client.post("/callenvoy/api/caller-id/verify", headers=AUTH).json()["field"] == "callback_number"
    client.put("/callenvoy/api/profile", json={"callback_number": "4155550199"}, headers=AUTH)
    assert client.post("/callenvoy/api/caller-id/verify", headers=AUTH).json() == {"validation_code": "123456"}


def test_push_subscription_rules(client):
    sub = {"endpoint": "https://evil.example.com/x", "keys": {"p256dh": "p", "auth": "a"}}
    assert client.post("/callenvoy/api/push/subscriptions", json=sub, headers=AUTH).json()["field"] == "endpoint"
    sub["endpoint"] = "https://fcm.googleapis.com/fcm/send/1"
    assert client.post("/callenvoy/api/push/subscriptions", json=sub, headers=AUTH).json() == {"ok": True}
    assert client.request("DELETE", "/callenvoy/api/push/subscriptions", json={"endpoint": sub["endpoint"]},
                          headers=AUTH).json() == {"ok": True}
    assert client.post("/callenvoy/api/push/test", headers=AUTH).status_code == 409  # no VAPID keys


MCP_HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}}}


def test_mcp_http_auth_and_key_in_path(client):
    assert client.post("/callenvoy/mcp", json=INIT, headers=MCP_HEADERS).status_code == 401
    r = client.post("/callenvoy/mcp", json=INIT, headers={**MCP_HEADERS, **AUTH})
    assert r.status_code == 200 and r.json()["result"]["serverInfo"]["name"] == "CallEnvoy"
    r = client.post(f"/callenvoy/mcp/{KEY}", json=INIT, headers=MCP_HEADERS)
    assert r.status_code == 200
    assert client.post("/callenvoy/mcp/wrongkey", json=INIT, headers=MCP_HEADERS).status_code == 401


def test_mcp_in_process_tools_and_profile_round_trip():
    from mcp import Client

    async def go():
        async with Client(mcp_server.server) as c:
            tools = (await c.list_tools()).tools
            assert len(tools) == 12 and all(t.name.startswith("callenvoy_") for t in tools)
            r = await c.call_tool("callenvoy_save_profile", {"name": "Alex", "leave_voicemail": False, "vin": "1HG"})
            assert not r.is_error and r.structured_content["leave_voicemail"] is False
            r = await c.call_tool("callenvoy_get_profile", {})
            assert r.structured_content["vin"] == "1HG" and r.structured_content["caller_id_verified"] is False
            r = await c.call_tool("callenvoy_save_profile", {"mode": "nope"})
            assert r.is_error and "'handle' or 'transfer'" in r.content[0].text
            r = await c.call_tool("callenvoy_place_call", {**CALL, "from": "own"})
            assert r.is_error and "verif" in r.content[0].text
            r = await c.call_tool("callenvoy_place_call", CALL)
            assert not r.is_error
            r = await c.call_tool("callenvoy_get_call", {"call_id": r.structured_content["id"]})
            assert "Northstar" in r.content[0].text
    run(go())


def test_inbound_twiml(client):
    r = signed(client, "/twilio/inbound", {"From": "+14155550123", "CallSid": "CA1"})
    assert "does not take calls" in r.text
    store.save_profile({"callback_number": "+14155550199"})
    r = signed(client, "/twilio/inbound", {"From": "+14155550123", "CallSid": "CA2"})
    doc = xml.dom.minidom.parseString(r.text)
    dial = doc.getElementsByTagName("Dial")[0]
    assert dial.getAttribute("callerId") == "+14155550123" and dial.getAttribute("timeout") == "25"
    assert doc.getElementsByTagName("Number")[0].firstChild.data == "+14155550199"
    assert client.post("/callenvoy/twilio/inbound", data={"From": "+1"}).status_code == 403  # unsigned
    cid = dial.getAttribute("action").rsplit("/", 1)[1]
    again = signed(client, f"/twilio/inbound-done/{cid}", {"DialCallStatus": "failed"})
    assert 'callerId="+19186021019"' in again.text and "retry=1" in again.text
    signed(client, f"/twilio/inbound-done/{cid}?retry=1", {"DialCallStatus": "completed", "DialCallDuration": "42"})
    assert store.get_call(cid)["status"] == "completed" and store.get_call(cid)["talk_seconds"] == 42


def test_inbound_escapes_odd_caller():
    xml.dom.minidom.parseString(main.inbound_twiml({"id": "c_1", "caller": 'x"<&>', "forward_to": "+14155550199"}))


def test_demo_line_twiml_well_formed():
    for step, retry in ((None, False), ("menu", True), ("hold", False)):
        doc = xml.dom.minidom.parseString(demo_line.twiml(step, retry))
        assert doc.documentElement.tagName == "Response"
    hold = demo_line.twiml("hold", False)
    assert "wss://pragnyalabs.com/callenvoy/twilio/media/" in hold


def test_demo_line_only_for_our_own_number(client):
    """Fix 2: any other caller is hung up before a paid bot starts."""
    assert signed(client, "/api/demo-line", {"From": "+14155550123"}).text.endswith("<Response><Hangup/></Response>")
    assert "<Gather" in signed(client, "/api/demo-line", {"From": "+19186021019"}).text
    assert "<Hangup/>" in signed(client, "/api/demo-line?step=hold", {"From": "+14155550123"}).text


def test_startup_checks(monkeypatch):
    """Fix 11: outside dev mode, missing settings are named (never their values)."""
    monkeypatch.delenv("CALLENVOY_DEV")
    monkeypatch.setenv("PUBLIC_BASE_URL", "http://example.com/callenvoy")
    with pytest.raises(SystemExit, match="PUBLIC_BASE_URL"):
        main.startup_checks()
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://example.com/callenvoy")
    with pytest.raises(SystemExit, match="DEEPGRAM_API_KEY, OPENAI_API_KEY, FISH_API_KEY"):
        main.startup_checks()
    monkeypatch.setenv("CALLENVOY_API_KEY", "s3cr3tvalue")
    with pytest.raises(SystemExit, match="CALLENVOY_API_KEY") as e:
        main.startup_checks()
    assert "s3cr3tvalue" not in str(e.value)


def test_logs_are_quiet():
    """Fix 5: no Pipecat DEBUG lines (spoken sentences) and no httpx URLs (phone numbers)."""
    import logging

    from loguru import logger

    main.quiet_logs()
    assert logging.getLogger("httpx").getEffectiveLevel() == logging.WARNING
    assert logger._core.min_level >= 30  # loguru WARNING


def test_owner_phone_twiml(client):
    v = run(calls.place_call(calls.PlaceCallInput(**CALL)))
    store.update_call(v["id"], status="in_progress")
    owner.get(v["id"])
    doc = xml.dom.minidom.parseString(signed(client, f"/twilio/owner/{v['id']}", {"CallSid": "CA9"}).text)
    assert doc.getElementsByTagName("Gather") and "Press 1 to join" in doc.toxml()
    r = signed(client, f"/twilio/owner/{v['id']}", {"CallSid": "CA9", "Digits": "1"})
    assert "/twilio/owner-media/" in r.text


def _live_call():
    v = run(calls.place_call(calls.PlaceCallInput(**CALL)))
    store.update_call(v["id"], status="in_progress")
    return v["id"]


def test_audio_socket_tickets(client):
    cid = _live_call()
    with client.websocket_connect(f"/callenvoy/audio/{cid}") as ws:
        ws.send_text(json.dumps({"ticket": "wrong"}))
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_text()
        assert e.value.code == 4401
    ticket = client.post(f"/callenvoy/api/calls/{cid}/audio-ticket", headers=AUTH).json()["ticket"]
    with client.websocket_connect(f"/callenvoy/audio/{cid}") as ws:
        ws.send_text(json.dumps({"ticket": ticket}))
        assert json.loads(ws.receive_text()) == {"type": "state", "owner": "listening", "phase": None}
        ws.send_bytes(b"\0" * 5000)  # oversized: the server closes the socket
        with pytest.raises(WebSocketDisconnect):
            ws.receive_text()
    with client.websocket_connect(f"/callenvoy/audio/{cid}") as ws:  # used ticket
        ws.send_text(json.dumps({"ticket": ticket}))
        with pytest.raises(WebSocketDisconnect):
            ws.receive_text()
    # Contract 7: a second link replaces the first, which is told {"type": "replaced"} before it is closed
    t1 = client.post(f"/callenvoy/api/calls/{cid}/audio-ticket", headers=AUTH).json()["ticket"]
    t2 = client.post(f"/callenvoy/api/calls/{cid}/audio-ticket", headers=AUTH).json()["ticket"]
    with client.websocket_connect(f"/callenvoy/audio/{cid}") as first:
        first.send_text(json.dumps({"ticket": t1}))
        assert json.loads(first.receive_text())["type"] == "state"
        with client.websocket_connect(f"/callenvoy/audio/{cid}") as second:
            second.send_text(json.dumps({"ticket": t2}))
            assert json.loads(second.receive_text())["owner"] == "listening"
            assert json.loads(first.receive_text()) == {"type": "replaced"}
            with pytest.raises(WebSocketDisconnect):
                first.receive_text()
    with client.websocket_connect(f"/callenvoy/audio/{cid}") as ws:  # used ticket again
        ws.send_text(json.dumps({"ticket": ticket}))
        with pytest.raises(WebSocketDisconnect):
            ws.receive_text()
    with pytest.raises(WebSocketDisconnect):  # foreign origin
        with client.websocket_connect(f"/callenvoy/audio/{cid}", headers={"Origin": "https://evil.example.com"}) as ws:
            ws.receive_text()
