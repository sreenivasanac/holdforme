"""Shared test setup: fake env, an in-memory database per test, fake Twilio. No network."""

import asyncio
import os

import pytest

os.environ.update({
    "CALLENVOY_API_KEY": "k" * 40,
    "CALLENVOY_DEV": "1",
    "TWILIO_ACCOUNT_SID": "ACtest",
    "TWILIO_AUTH_TOKEN": "test-token",
    "TWILIO_FROM_NUMBER": "+19186021019",
    "PUBLIC_BASE_URL": "https://pragnyalabs.com/callenvoy",
})
for name in ("VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "OPENAI_API_KEY", "FISH_API_KEY", "DEEPGRAM_API_KEY"):
    os.environ.pop(name, None)

from callenvoy import auth, calls, config, owner, store, twilio_api  # noqa: E402

KEY = "k" * 40


def owner_cookie() -> dict:
    """Headers of a signed-in console (the cookie is Secure, so the test client would not send it over http)."""
    return {"Cookie": f"{config.SESSION_COOKIE}={auth.new_session('me@example.com')}"}


class FakeTwilio:
    """Records every REST call; never touches the network."""

    def __init__(self):
        self.created: list[dict] = []
        self.updated: list[tuple] = []
        self.verified: set[str] = set()
        self.validations: list[str] = []

    async def create_call(self, **kw):
        self.created.append(kw)
        return f"CA{len(self.created):032d}"

    async def update_call(self, sid, **kw):
        self.updated.append((sid, kw))

    async def caller_id_verified(self, number):
        return number in self.verified

    async def start_caller_id_validation(self, number):
        self.validations.append(number)
        return "123456"


@pytest.fixture(autouse=True)
def fresh(monkeypatch, tmp_path):
    monkeypatch.setattr("callenvoy.config.DB_PATH", tmp_path / "test.db")
    store.open_db(":memory:")
    auth.import_env_key()  # as at start: the env key "k" * 40 (old format) is the first stored key
    auth._requests.clear()
    calls.LIVE.clear()
    owner.OWNERS.clear()
    fake = FakeTwilio()
    for name in ("create_call", "update_call", "caller_id_verified", "start_caller_id_validation"):
        monkeypatch.setattr(twilio_api, name, getattr(fake, name))
    yield fake


def run(coro):
    return asyncio.run(coro)


CALL = {"to": "(415) 555-0123", "business": "Northstar Internet", "goal": "Fix a double charge on the bill"}
