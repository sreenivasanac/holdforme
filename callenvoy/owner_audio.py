"""The owner's audio links: the browser socket (section 10a) and the owner's phone stream (section 10).

Browser protocol on WSS /callenvoy/audio/<call_id>:
  client -> server, first (within 5 s): text {"ticket": "..."} from POST /api/calls/{id}/audio-ticket
  server -> client: text {"type":"state","owner":...,"phase":...} on every change
  server -> client: binary call audio, PCM 16-bit mono 8 kHz, 640 bytes (40 ms) per message
  client -> server: text {"type":"join"} / {"type":"hand_back"}
  client -> server: binary microphone, PCM 16-bit mono 16 kHz (used only while the owner has the call)
  server -> client: text {"type":"ended"} then close. Errors of join/hand_back: {"type":"error","message":...}
"""

import asyncio
import base64
import json
import logging
import secrets
import time

from fastapi import WebSocket, WebSocketDisconnect

from . import calls, config, guard, owner

log = logging.getLogger("callenvoy.owner_audio")
PHONE_TOKENS: dict[str, str] = {}  # one-use stream token -> call id, for the owner's phone leg


def origin_ok(origin: str | None) -> bool:
    """A missing Origin is allowed (native app, Twilio); the ticket is still required."""
    if not origin:
        return True
    return origin == config.PUBLIC_ORIGIN or (config.dev_mode() and origin == config.DEV_ORIGIN)


class RateGate:
    """Drops microphone audio that arrives faster than AUDIO_MAX_RATE times real time."""

    def __init__(self, bytes_per_second: int, clock=time.monotonic):
        self.bps = bytes_per_second * config.AUDIO_MAX_RATE
        self.clock = clock
        self.start = clock()
        self.used = 0

    def allow(self, n: int) -> bool:
        budget = (self.clock() - self.start) * self.bps + self.bps  # one second of burst
        if self.used + n > budget:
            return False
        self.used += n
        return True


class BrowserLink:
    kind = "app"
    rate = config.OWNER_AUDIO_UP_HZ

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.closed = False
        self._send = asyncio.Lock()

    async def _out(self, data: str | bytes) -> None:
        if self.closed:
            return
        try:
            async with self._send:
                await (self.ws.send_bytes(data) if isinstance(data, bytes) else self.ws.send_text(data))
        except Exception:  # noqa: BLE001 - a dead socket is handled by the receive loop
            self.closed = True

    async def send_audio(self, pcm8k: bytes) -> None:
        await self._out(pcm8k)

    async def send_state(self, owner_state: str, phase: str | None) -> None:
        await self._out(json.dumps({"type": "state", "owner": owner_state, "phase": phase}))

    async def close(self, ended: bool = False) -> None:
        if ended:
            await self._out(json.dumps({"type": "ended"}))
        if not self.closed:
            self.closed = True
            try:
                await self.ws.close()
            except Exception:  # noqa: BLE001
                pass


async def read_ticket(ws: WebSocket, call_id: str) -> bool:
    try:
        raw = await asyncio.wait_for(ws.receive_text(), config.AUDIO_FIRST_MESSAGE_SECONDS)
        ticket = json.loads(raw).get("ticket")
    except Exception:  # noqa: BLE001 - timeout, binary first message, bad JSON
        return False
    return isinstance(ticket, str) and guard.take_ticket(ticket, call_id)


async def browser_socket(ws: WebSocket, call_id: str) -> None:
    if not origin_ok(ws.headers.get("origin")):
        await ws.close(code=1008)
        return
    await ws.accept()
    if not await read_ticket(ws, call_id):
        await ws.close(code=4401)
        return
    row = calls.store.get_call(call_id)
    if not row or row["status"] != "in_progress" or call_id not in calls.LIVE:
        await ws.send_text(json.dumps({"type": "ended"}))
        await ws.close()
        return
    link = BrowserLink(ws)
    rate = RateGate(config.OWNER_AUDIO_UP_HZ * 2)
    await owner.attach(call_id, link)
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                data = msg["bytes"]
                if len(data) > config.AUDIO_MAX_MESSAGE_BYTES:
                    break
                if rate.allow(len(data)):
                    await owner.mic(call_id, link, data)
            elif msg.get("text") is not None:
                await _command(call_id, link, msg["text"])
    except WebSocketDisconnect:
        pass
    finally:
        link.closed = True
        await owner.detach(call_id, link)
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


async def _command(call_id: str, link: BrowserLink, text: str) -> None:
    try:
        kind = json.loads(text).get("type")
    except (ValueError, AttributeError):
        return
    try:
        if kind == "join":
            await owner.join(call_id)
        elif kind == "hand_back":
            await owner.hand_back(call_id)
    except calls.CallError as e:
        await link._out(json.dumps({"type": "error", "message": str(e)}))


# --- The owner's phone leg: Twilio Media Streams JSON with base64 mu-law, read without a Pipecat transport ---

def issue_phone_token(call_id: str) -> str:
    token = secrets.token_urlsafe(32)
    PHONE_TOKENS[token] = call_id
    return token


async def decode_media(payload_b64: str, resampler) -> bytes:
    from pipecat.audio.utils import ulaw_to_pcm

    return await ulaw_to_pcm(base64.b64decode(payload_b64), 8000, 8000, resampler)


async def encode_media(pcm8k: bytes, resampler) -> str:
    from pipecat.audio.utils import pcm_to_ulaw

    return base64.b64encode(await pcm_to_ulaw(pcm8k, 8000, 8000, resampler)).decode()


class PhoneLink:
    kind = "phone"
    rate = 8000

    def __init__(self, ws: WebSocket, stream_sid: str):
        from pipecat.audio.utils import create_stream_resampler

        self.ws = ws
        self.stream_sid = stream_sid
        self.closed = False
        self.out_resampler = create_stream_resampler()

    async def send_audio(self, pcm8k: bytes) -> None:
        if self.closed:
            return
        try:
            payload = await encode_media(pcm8k, self.out_resampler)
            await self.ws.send_text(json.dumps({"event": "media", "streamSid": self.stream_sid,
                                                "media": {"payload": payload}}))
        except Exception:  # noqa: BLE001
            self.closed = True

    async def send_state(self, owner_state: str, phase: str | None) -> None:
        pass  # the phone has no screen

    async def close(self, ended: bool = False) -> None:
        if not self.closed:
            self.closed = True
            try:
                await self.ws.close()
            except Exception:  # noqa: BLE001
                pass


async def phone_socket(ws: WebSocket, token: str) -> None:
    call_id = PHONE_TOKENS.pop(token, None)
    if not call_id or call_id not in calls.LIVE:
        await ws.close(code=1008)
        return
    await ws.accept()
    from pipecat.audio.utils import create_stream_resampler

    resampler = create_stream_resampler()
    link: PhoneLink | None = None
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            ev = msg.get("event")
            if ev == "start" and link is None:
                link = PhoneLink(ws, msg.get("start", {}).get("streamSid") or msg.get("streamSid", ""))
                await owner.attach(call_id, link)
            elif ev == "media" and link:
                await owner.mic(call_id, link, await decode_media(msg["media"]["payload"], resampler))
            elif ev == "dtmf" and link:
                await owner.phone_key(call_id, link, str(msg.get("dtmf", {}).get("digit", "")))
            elif ev == "stop":
                break
    except (WebSocketDisconnect, ValueError, KeyError):
        pass
    finally:
        if link:
            link.closed = True
            await owner.detach(call_id, link)
