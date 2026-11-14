"""Web push: send alerts to saved devices, drop dead subscriptions.

Make VAPID keys once with: uv run python -m callenvoy.push --make-keys
"""

import asyncio
import json
import logging
import sys
from urllib.parse import urlparse

from . import config, store

log = logging.getLogger("callenvoy.push")


def _webpush(*args, **kwargs):  # indirection so tests can fake pywebpush
    from pywebpush import webpush

    return webpush(*args, **kwargs)


def enabled() -> bool:
    return bool(config.env("VAPID_PUBLIC_KEY") and config.env("VAPID_PRIVATE_KEY") and config.env("VAPID_SUBJECT"))


def endpoint_ok(endpoint: str) -> bool:
    """Only https endpoints on the known push services: the server later sends requests to them."""
    u = urlparse(endpoint or "")
    host = (u.hostname or "").lower()
    return u.scheme == "https" and any(host == h.lstrip(".") or (h.startswith(".") and host.endswith(h)) for h in config.PUSH_HOSTS)


def payload(row: dict, kind: str, shows_business: bool) -> dict:
    biz = row["business"] if shows_business else None
    if kind == "dropped":
        title, body = "You dropped off the call", "The AI carried on. Rejoin?"
    elif kind == "listen_in":
        title, body = "Call answered", (f"{biz} answered. Tap to listen." if biz else "The call was answered. Tap to listen.")
    elif kind == "test":
        title, body = "CallEnvoy alerts work", "This device will get call alerts."
    else:
        title, body = "A person is on the line", (f"A person answered at {biz}. Tap to join." if biz else "A person is on the line. Tap to join.")
    cid = row.get("id")
    url = f"{config.BASE_PATH}/calls/{cid}" if cid else f"{config.BASE_PATH}/"
    return {"title": title, "body": body, "url": url, "call_id": cid, "kind": kind}


async def send(user_id: str, data: dict) -> int:
    """Sends one push to every saved device of the user. Returns how many were accepted. 404/410 deletes the device."""
    if not enabled():
        return 0
    sent = 0
    for d in store.push_devices(user_id):
        try:
            await asyncio.to_thread(
                _webpush, {"endpoint": d["endpoint"], "keys": {"p256dh": d["p256dh"], "auth": d["auth"]}},
                data=json.dumps(data), vapid_private_key=config.env("VAPID_PRIVATE_KEY"),
                vapid_claims={"sub": config.env("VAPID_SUBJECT")}, ttl=config.PUSH_TTL_SECONDS,
                headers={"Urgency": "high"}, timeout=10)
            store.push_ok(d["endpoint"])
            sent += 1
        except Exception as e:  # noqa: BLE001 - one bad device must not stop the others
            status = getattr(e, "status_code", None) or getattr(getattr(e, "response", None), "status_code", None)
            if status in (404, 410):
                store.delete_push_device(user_id, d["endpoint"])
            else:
                log.warning("push failed (status %s)", status)  # never log the endpoint
    return sent


async def send_alert(row: dict, kind: str) -> int:
    """An alert about a call goes only to the devices of the call's user, with that user's settings."""
    from . import calls

    profile = calls.get_profile(row["user_id"])
    if not profile["alert_push"]:
        return 0
    try:
        return await send(row["user_id"], payload(row, kind, profile["push_shows_business"]))
    except Exception:  # noqa: BLE001
        log.exception("push alert failed")
        return 0


def make_keys() -> tuple[str, str]:
    """Returns (public, private) VAPID keys, base64url, for the env file."""
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid
    from py_vapid.utils import b64urlencode

    v = Vapid()
    v.generate_keys()
    raw_pub = v.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    raw_priv = v.private_key.private_numbers().private_value.to_bytes(32, "big")
    return b64urlencode(raw_pub), b64urlencode(raw_priv)


if __name__ == "__main__":
    if "--make-keys" in sys.argv:
        pub, priv = make_keys()
        print(f"VAPID_PUBLIC_KEY={pub}\nVAPID_PRIVATE_KEY={priv}\nVAPID_SUBJECT=mailto:you@example.com")
    else:
        print("usage: uv run python -m callenvoy.push --make-keys")
