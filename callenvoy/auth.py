"""Users, agent keys, console sessions, one-time sign-in links and the sign-in mail.

Agent key: `Authorization: Bearer <key>` or /mcp/<key>. Console session: cookie ce_session. Both name one user;
every request acts only on that user's data. Only hashes are stored.
"""

import asyncio
import contextvars
import hashlib
import logging
import re
import secrets
import smtplib
import ssl
import time
from email.message import EmailMessage
from urllib.parse import unquote

from . import config, store

log = logging.getLogger("callenvoy.auth")
clock = time.monotonic
# The user of the current MCP request (set by main.AuthMiddleware; the MCP SDK hides the HTTP request from tools).
CURRENT_USER: contextvars.ContextVar[dict | None] = contextvars.ContextVar("callenvoy_user", default=None)


class AuthError(Exception):
    def __init__(self, code: str, message: str, status: int = 401):
        super().__init__(message)
        self.code, self.status = code, status


def digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


# --- users ---

def is_admin(user: dict | None) -> bool:
    return bool(user and store.admin_email() and user["email"] == store.admin_email())


def active(user: dict | None) -> dict:
    """The user, or AuthError when the account is gone or disabled."""
    if not user:
        raise AuthError("bad_key", "unknown key")
    if user["disabled"]:
        raise AuthError("account_disabled", "this account is disabled")
    store.user_seen(user["id"])
    return user


def signups_open() -> bool:
    return bool(store.service_setting("signups_open", config.SIGNUPS_OPEN_DEFAULT))


_EMAIL = re.compile(r"[^@\s\"<>,;]+@[^@\s\"<>,;]+\.[^@\s\"<>,;.]{2,}")


def email_ok(email: str) -> bool:
    return len(email) <= config.EMAIL_MAX and bool(_EMAIL.fullmatch(email))


# --- agent keys ---

def clean_key(raw: str | None) -> str:
    """Undoes common copy mistakes: URL-encoding, a doubled "Bearer " prefix, surrounding quotes, white space."""
    key = unquote(raw or "").strip().strip("\"'").strip()
    while key.lower() == "bearer" or key[:7].lower() == "bearer ":
        key = key[6:].strip().strip("\"'").strip()
    return key


def check_key(raw: str | None) -> dict:
    """The user of a usable key, else AuthError. Never puts the key into a message."""
    key = clean_key(raw)
    if not key:
        raise AuthError("no_credential", "no key: send Authorization: Bearer <key>")
    row = store.key_by_hash(digest(key))
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
    user = active(store.get_user(row["user_id"]) if row["user_id"] else None)
    store.key_used(row["id"])
    return user


def key_view(row: dict) -> dict:
    return {"id": row["id"], "name": row["name"], "prefix": row["prefix"], "created_at": row["created_at"],
            "last_used_at": row["last_used_at"], "disabled": bool(row["disabled"])}


def create_key(user_id: str, name: str, key: str | None = None) -> tuple[dict, str]:
    """Stores a new key of the user (or the given one, for the .env import). Returns the row and the full key."""
    key = key or config.KEY_PREFIX + "".join(secrets.choice(config.KEY_ALPHABET) for _ in range(config.KEY_BODY_LENGTH))
    row = {"id": store.new_id("k_"), "name": name, "key_hash": digest(key), "prefix": key[:config.KEY_DISPLAY_LENGTH],
           "created_at": store.now(), "last_used_at": None, "disabled": 0, "user_id": user_id}
    store.insert_key(row)
    return row, key


def import_env_key() -> None:
    """First start after the move to several keys: the single CALLENVOY_API_KEY becomes the admin's first key."""
    key = config.env("CALLENVOY_API_KEY").strip()
    admin = store.user_by_email(store.admin_email()) if store.admin_email() else None
    # Only once per database (SQLite user_version marks it): a key that the owner deleted must not come back
    # at the next start while the variable is still in .env.
    if key and admin and not store.keys(admin["id"]) and not store.env_key_imported():
        create_key(admin["id"], config.IMPORTED_KEY_NAME, key)
        store.env_key_imported(mark=True)
        log.warning("imported CALLENVOY_API_KEY as \"%s\"; it can now be removed from .env", config.IMPORTED_KEY_NAME)


# --- console sessions and sign-in links ---

def new_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    store.add_session(digest(token), user_id, store.now(config.SESSION_DAYS * 86400))
    return token


def session(cookie: str | None) -> dict | None:
    """The user of the session (also a disabled one: the caller decides)."""
    return store.session_user(digest(cookie)) if cookie else None


def end_session(cookie: str | None) -> None:
    if cookie:
        store.delete_session(digest(cookie))


def signin_link(email: str) -> str:
    """A one-use link for this address, valid SIGNIN_TOKEN_MINUTES. The page's button POSTs the token (mail
    scanners only GET)."""
    token = secrets.token_urlsafe(32)
    store.add_signin_token(digest(token), email, store.now(config.SIGNIN_TOKEN_MINUTES * 60))
    return f"{config.public_base_url()}/signin?token={token}"


def take_signin_token(token: str) -> str | None:
    """The address the link was made for, once."""
    return store.take_signin_token(digest(token))


_requests: dict[str, list[float]] = {}  # bucket -> request times (in memory; one process)


def allow_signin_request(email: str, ip: str) -> bool:
    """Per address, per client IP and global limits (config.SIGNIN_LIMIT_*). A request counts in all three."""
    now = clock()
    buckets = {f"a:{email}": config.SIGNIN_LIMIT_PER_ADDRESS, f"i:{ip}": config.SIGNIN_LIMIT_PER_IP,
               "all": config.SIGNIN_LIMIT_GLOBAL}
    for name, (limit, window) in buckets.items():
        times = [t for t in _requests.get(name, []) if t > now - window]
        _requests[name] = times
        if len(times) >= limit:
            return False
    for name in buckets:
        _requests[name].append(now)
    return True


def mail_ready() -> bool:
    return all((config.env("SMTP_HOST"), config.env("MAIL_FROM")))


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


def mail_signin_link(email: str) -> None:
    """Sends the link in the background, so a slow mail server does not hold the reply."""
    link = signin_link(email)
    text = (f"Someone (we hope you) asked to sign in to {config.APP_NAME}, the service that makes phone calls for "
            f"you, with this address.\n\n{link}\n\nThe link works one time, for {config.SIGNIN_TOKEN_MINUTES} "
            "minutes. If you did not ask for it, ignore this mail: nothing happens without the link.")

    async def go():
        try:
            await asyncio.to_thread(send_mail, email, f"Sign in to {config.APP_NAME}", text)
        except Exception as e:  # noqa: BLE001 - logged without the link
            log.warning("sign-in mail failed: %s", type(e).__name__)

    task = asyncio.create_task(go())
    _sending.add(task)
    task.add_done_callback(_sending.discard)
