"""Agent keys, the owner's session cookie, one-time sign-in links and the sign-in mail.

Agent key: `Authorization: Bearer <key>` or /mcp/<key>. Owner session: cookie ce_session. Only hashes are stored.
"""

import asyncio
import hashlib
import logging
import secrets
import smtplib
import ssl
import time
from email.message import EmailMessage
from urllib.parse import unquote

from . import config, store

log = logging.getLogger("callenvoy.auth")
clock = time.monotonic


class AuthError(Exception):
    def __init__(self, code: str, message: str, status: int = 401):
        super().__init__(message)
        self.code, self.status = code, status


def digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


# --- agent keys ---

def clean_key(raw: str | None) -> str:
    """Undoes common copy mistakes: URL-encoding, a doubled "Bearer " prefix, surrounding quotes, white space."""
    key = unquote(raw or "").strip().strip("\"'").strip()
    while key.lower() == "bearer" or key[:7].lower() == "bearer ":
        key = key[6:].strip().strip("\"'").strip()
    return key


def check_key(raw: str | None) -> dict:
    """The key row for a usable key, else AuthError. Never puts the key into a message."""
    key = clean_key(raw)
    if not key:
        raise AuthError("no_credential", "no key: send Authorization: Bearer <key>")
    row = store.key_by("key_hash", digest(key))
    if row is None:
        body = key[len(config.KEY_PREFIX):]
        if not key.startswith(config.KEY_PREFIX):
            raise AuthError("malformed_key", f"a key starts with {config.KEY_PREFIX}")
        if len(body) != config.KEY_BODY_LENGTH:
            raise AuthError("malformed_key", f"a key has {config.KEY_BODY_LENGTH} characters after {config.KEY_PREFIX}"
                                             f", this one has {len(body)}")
        if set(body) - set(config.KEY_ALPHABET):
            raise AuthError("malformed_key", "the key has characters a key never has; copy it again")
        raise AuthError("bad_key", "unknown key")
    if row["disabled"]:
        raise AuthError("key_disabled", "this key is disabled; enable it in the console")
    store.key_used(row["id"])
    return row


def key_view(row: dict) -> dict:
    return {"id": row["id"], "name": row["name"], "prefix": row["prefix"], "created_at": row["created_at"],
            "last_used_at": row["last_used_at"], "disabled": bool(row["disabled"])}


def create_key(name: str, key: str | None = None) -> tuple[dict, str]:
    """Stores a new key (or the given one, for the .env import). Returns the row and the full key."""
    key = key or config.KEY_PREFIX + "".join(secrets.choice(config.KEY_ALPHABET) for _ in range(config.KEY_BODY_LENGTH))
    row = {"id": store.new_id("k_"), "name": name, "key_hash": digest(key), "prefix": key[:config.KEY_DISPLAY_LENGTH],
           "created_at": store.now(), "last_used_at": None, "disabled": 0}
    store.insert_key(row)
    return row, key


def import_env_key() -> None:
    """First start after the move to several keys: the single CALLENVOY_API_KEY becomes the first stored key."""
    key = config.env("CALLENVOY_API_KEY").strip()
    # Only once per database (SQLite user_version marks it): a key that the owner deleted must not come back
    # at the next start while the variable is still in .env.
    if key and not store.keys() and not store.env_key_imported():
        create_key(config.IMPORTED_KEY_NAME, key)
        store.env_key_imported(mark=True)
        log.warning("imported CALLENVOY_API_KEY as \"%s\"; it can now be removed from .env", config.IMPORTED_KEY_NAME)


# --- owner sessions and sign-in links ---

def new_session(email: str | None) -> str:
    token = secrets.token_urlsafe(32)
    store.add_session(digest(token), email, store.now(config.SESSION_DAYS * 86400))
    return token


def session(cookie: str | None) -> dict | None:
    return store.get_session(digest(cookie)) if cookie else None


def end_session(cookie: str | None) -> None:
    if cookie:
        store.delete_session(digest(cookie))


def signin_link() -> str:
    """A one-use link, valid SIGNIN_TOKEN_MINUTES. The page's button POSTs the token (mail scanners only GET)."""
    token = secrets.token_urlsafe(32)
    store.add_signin_token(digest(token), store.now(config.SIGNIN_TOKEN_MINUTES * 60))
    return f"{config.public_base_url()}/signin?token={token}"


def take_signin_token(token: str) -> bool:
    return store.take_signin_token(digest(token))


_requests: list[float] = []


def allow_signin_request() -> bool:
    """SIGNIN_REQUESTS_PER_HOUR for all addresses together (in memory; one process)."""
    now = clock()
    _requests[:] = [t for t in _requests if t > now - 3600]
    if len(_requests) >= config.SIGNIN_REQUESTS_PER_HOUR:
        return False
    _requests.append(now)
    return True


def owner_email() -> str:
    return config.env("OWNER_EMAIL").strip()


def mail_ready() -> bool:
    return all((owner_email(), config.env("SMTP_HOST"), config.env("MAIL_FROM")))


def send_mail(to: str, subject: str, text: str) -> None:
    """Blocking (run it in a thread). STARTTLS on SMTP_PORT, login when SMTP_USER is set."""
    msg = EmailMessage()
    msg["From"], msg["To"], msg["Subject"] = config.env("MAIL_FROM"), to, subject
    msg.set_content(text)
    port = int(config.env("SMTP_PORT") or config.SMTP_PORT)
    with smtplib.SMTP(config.env("SMTP_HOST"), port, timeout=config.SMTP_TIMEOUT_SECONDS) as s:
        s.starttls(context=ssl.create_default_context())
        if config.env("SMTP_USER"):
            s.login(config.env("SMTP_USER"), config.env("SMTP_PASSWORD"))
        s.send_message(msg)


_sending: set[asyncio.Task] = set()


def mail_signin_link() -> None:
    """Sends the link in the background, so the reply time does not show whether the address was the owner's."""
    link = signin_link()
    text = (f"Sign in to {config.APP_NAME}:\n\n{link}\n\nThe link works once, for {config.SIGNIN_TOKEN_MINUTES} "
            "minutes. If you did not ask for it, ignore this mail.")

    async def go():
        try:
            await asyncio.to_thread(send_mail, owner_email(), f"Sign in to {config.APP_NAME}", text)
        except Exception as e:  # noqa: BLE001 - logged without the link
            log.warning("sign-in mail failed: %s", type(e).__name__)

    task = asyncio.create_task(go())
    _sending.add(task)
    task.add_done_callback(_sending.discard)
