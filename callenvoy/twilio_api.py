"""The three Twilio REST calls CallEnvoy needs, with httpx and basic auth (no Twilio SDK)."""

from collections.abc import AsyncIterator

import httpx

from . import config

API = "https://api.twilio.com/2010-04-01"


class TwilioError(Exception):
    pass


def _auth() -> tuple[str, str]:
    return config.env("TWILIO_ACCOUNT_SID"), config.env("TWILIO_AUTH_TOKEN")


def _url(path: str) -> str:
    return f"{API}/Accounts/{config.env('TWILIO_ACCOUNT_SID')}/{path}"


async def _post(path: str, data: list[tuple[str, str]]) -> dict:
    async with httpx.AsyncClient(auth=_auth(), timeout=15) as c:
        r = await c.post(_url(path), data=data)
    if r.status_code >= 400:
        try:
            msg = r.json().get("message", "")
        except ValueError:
            msg = ""
        raise TwilioError(f"Twilio {r.status_code}: {msg[:200]}")
    return r.json()


async def create_call(*, to: str, url: str, status_callback: str, record: bool = False,
                      time_limit: int | None = None, ring_seconds: int | None = None, from_number: str | None = None) -> str:
    """Dials `to` from `from_number` (default TWILIO_FROM_NUMBER). Returns the call SID. Also used for the owner's leg."""
    data = [("To", to), ("From", from_number or config.env("TWILIO_FROM_NUMBER")), ("Url", url), ("Method", "POST"),
            ("StatusCallback", status_callback), ("StatusCallbackMethod", "POST")]
    data += [("StatusCallbackEvent", e) for e in ("initiated", "ringing", "answered", "completed")]
    if record:
        data += [("Record", "true"), ("RecordingChannels", "dual"),
                 ("RecordingStatusCallback", status_callback), ("RecordingStatusCallbackEvent", "completed")]
    if time_limit:
        data.append(("TimeLimit", str(time_limit)))
    if ring_seconds:
        data.append(("Timeout", str(ring_seconds)))
    return (await _post("Calls.json", data))["sid"]


async def update_call(sid: str, *, hang_up: bool = True) -> None:
    """Hangs up a live call. TODO: Twilio <Play digits> fallback (redirect with Twiml) if in-band tones fail."""
    await _post(f"Calls/{sid}.json", [("Status", "completed")])


def twiml(body: str) -> str:
    """A TwiML document; `body` must already be XML-escaped."""
    return f'<?xml version="1.0" encoding="UTF-8"?><Response>{body}</Response>'


async def _get(path: str, params: dict) -> dict:
    async with httpx.AsyncClient(auth=_auth(), timeout=15) as c:
        r = await c.get(_url(path), params=params)
    if r.status_code >= 400:
        raise TwilioError(f"Twilio {r.status_code}")
    return r.json()


# Verified caller IDs (checked 2026-11-10 against twilio.com/docs/voice/api/outgoing-caller-ids):
# POST OutgoingCallerIds.json {PhoneNumber, FriendlyName} -> {validation_code, call_sid, ...}; Twilio then
# calls the number and the person types the code. GET OutgoingCallerIds.json?PhoneNumber= lists verified ones.

async def caller_id_verified(number: str) -> bool:
    return any(c.get("phone_number") == number for c in
               (await _get("OutgoingCallerIds.json", {"PhoneNumber": number})).get("outgoing_caller_ids", []))


async def start_caller_id_validation(number: str) -> str:
    """Starts Twilio's validation call to `number`. Returns the 6-digit code the owner types on the keypad."""
    return (await _post("OutgoingCallerIds.json", [("PhoneNumber", number), ("FriendlyName", config.APP_NAME)]))["validation_code"]


async def fetch_recording(recording_sid: str) -> AsyncIterator[bytes]:
    """Streams the recording mp3 from Twilio."""
    async with httpx.AsyncClient(auth=_auth(), timeout=30) as c:
        async with c.stream("GET", _url(f"Recordings/{recording_sid}.mp3")) as r:
            if r.status_code >= 400:
                raise TwilioError(f"Twilio {r.status_code}")
            async for chunk in r.aiter_bytes():
                yield chunk
