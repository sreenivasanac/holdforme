from callenvoy import push, store

from .conftest import run


def test_payload_respects_push_shows_business():
    row = {"id": "c_1", "business": "Northstar Internet"}
    assert push.payload(row, "handover", True)["body"] == "A person answered at Northstar Internet. Tap to join."
    p = push.payload(row, "handover", False)
    assert p["body"] == "A person is on the line. Tap to join." and "Northstar" not in str(p)
    assert p["url"] == "/callenvoy/calls/c_1" and p["call_id"] == "c_1"


def test_known_push_hosts_only():
    assert push.endpoint_ok("https://fcm.googleapis.com/fcm/send/abc")
    assert push.endpoint_ok("https://web.push.apple.com/QAbc")
    assert push.endpoint_ok("https://updates.push.services.mozilla.com/wpush/v2/x")
    assert push.endpoint_ok("https://wns2-par02p.notify.windows.com/w/?token=x")
    assert not push.endpoint_ok("http://fcm.googleapis.com/x")
    assert not push.endpoint_ok("https://evil.example.com/push.apple.com")
    assert not push.endpoint_ok("https://fcm.googleapis.com.evil.com/x")
    assert not push.endpoint_ok("https://notpush.apple.comx/")


def test_410_deletes_device_and_others_still_sent(monkeypatch):
    monkeypatch.setenv("VAPID_PUBLIC_KEY", "pub")
    monkeypatch.setenv("VAPID_PRIVATE_KEY", "priv")
    monkeypatch.setenv("VAPID_SUBJECT", "mailto:a@b.c")
    store.save_push_device("https://fcm.googleapis.com/dead", "p", "a", None)
    store.save_push_device("https://fcm.googleapis.com/ok", "p", "a", None)
    calls = []

    class Gone(Exception):
        status_code = 410

    def fake(sub, **kw):
        calls.append((sub["endpoint"], kw["ttl"], kw["headers"]))
        if sub["endpoint"].endswith("dead"):
            raise Gone()

    monkeypatch.setattr(push, "_webpush", fake)
    assert run(push.send({"title": "t"})) == 1
    assert [d["endpoint"] for d in store.push_devices()] == ["https://fcm.googleapis.com/ok"]
    assert calls[0][1] == 60 and calls[0][2] == {"Urgency": "high"}


def test_make_keys():
    pub, priv = push.make_keys()
    assert len(pub) == 87 and len(priv) == 43  # 65 and 32 bytes, base64url without padding
