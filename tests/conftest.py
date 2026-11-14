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
    "OWNER_EMAIL": "Me@Example.com",  # the admin; its user is made by open_db and owns the env key
})
for name in ("VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "OPENAI_API_KEY", "FISH_API_KEY", "DEEPGRAM_API_KEY",
             "SMTP_HOST", "MAIL_FROM"):
    os.environ.pop(name, None)

from callenvoy import auth, calls, config, owner, store, twilio_api  # noqa: E402

KEY = "k" * 40
ADMIN_EMAIL = "me@example.com"


def uid() -> str:
    """The admin's user id (the default user of the tests; it holds the env key "k" * 40)."""
    return store.user_by_email(ADMIN_EMAIL)["id"]


def owner_cookie(user_id: str | None = None) -> dict:
    """Headers of a signed-in console (the cookie is Secure, so the test client would not send it over http)."""
    return {"Cookie": f"{config.SESSION_COOKIE}={auth.new_session(user_id or uid())}"}


def place(user_id: str | None = None, **kw) -> dict:
    return run(calls.place_call(user_id or uid(), calls.PlaceCallInput(**{**CALL, **kw})))


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
    store.save_profile(uid(), {"name": "Alex"})  # a call needs the profile name
    auth._requests.clear()
    calls.LIVE.clear()
    owner.OWNERS.clear()
    calls._caller_id_cache.clear()
    fake = FakeTwilio()
    for name in ("create_call", "update_call", "caller_id_verified", "start_caller_id_validation"):
        monkeypatch.setattr(twilio_api, name, getattr(fake, name))
    yield fake


def run(coro):
    return asyncio.run(coro)


CALL = {"to": "(415) 555-0123", "business": "Northstar Internet", "goal": "Fix a double charge on the bill"}
