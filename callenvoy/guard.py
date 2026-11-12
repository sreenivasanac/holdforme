"""Phone number rules, Twilio signature check and one-use tickets. Keys and sessions: auth.py."""

import base64
import hashlib
import hmac
import re
import secrets
import time

from . import config

_NANP = re.compile(r"^\+1([2-9]\d{2})[2-9]\d{6}$")


def to_e164(raw: str) -> str:
    """Normalise "(415) 555-0123", "4155550123", "+1 415 555 0123" to E.164; "" when not a NANP number.
    Ported from the old lib/guard.ts."""
    d = re.sub(r"\D", "", raw or "")
    if len(d) == 10:
        return "+1" + d
    if len(d) == 11 and d.startswith("1"):
        return "+" + d
    return ""


def check_number(raw: str) -> str:
    """Returns the E.164 number or raises ValueError with a plain reason.
    The NANP shape already rules out 911 and other short codes."""
    n = to_e164(raw)
    m = _NANP.match(n)
    if not m:
        raise ValueError("only US and Canada numbers like +14155550123 can be called")
    if m.group(1) in config.BLOCKED_AREA_CODES:
        raise ValueError(f"area code {m.group(1)} is blocked (premium rate or outside the US and Canada)")
    return n


def twilio_signature(url: str, params: dict, token: str) -> str:
    data = url + "".join(k + params[k] for k in sorted(params))
    return base64.b64encode(hmac.new(token.encode(), data.encode(), hashlib.sha1).digest()).decode()


def twilio_ok(url: str, params: dict, signature: str | None, token: str | None = None) -> bool:
    token = token or config.env("TWILIO_AUTH_TOKEN")
    if not signature or not token:
        return False
    return hmac.compare_digest(twilio_signature(url, params, token), signature)


# --- one-use tickets (audio socket, demo stream): random, short-lived, bound to one subject, in memory ---

_tickets: dict[str, tuple[str, float]] = {}
clock = time.monotonic


def issue_ticket(subject: str, seconds: int = config.AUDIO_TICKET_SECONDS) -> str:
    now = clock()
    for t, (_, exp) in list(_tickets.items()):  # drop expired ones
        if exp < now:
            del _tickets[t]
    ticket = secrets.token_urlsafe(32)
    _tickets[ticket] = (subject, now + seconds)
    return ticket


def take_ticket(ticket: str, subject: str) -> bool:
    """True once for a valid, unexpired ticket of this subject. Any attempt uses the ticket up."""
    entry = _tickets.pop(ticket, None) if isinstance(ticket, str) else None
    return bool(entry) and hmac.compare_digest(entry[0], subject) and entry[1] >= clock()
