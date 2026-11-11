"""The owner on a call: alert, ring, listen, join, hand back, drop handling. One state per call, in memory.

States: none -> alerting -> ringing -> listening -> on_call (steps skipped as needed). One owner link
(browser socket or phone stream) per call; a new link replaces the old one. Listen/join/hand-back
semantics follow Call4me src/server/voice/person.ts (MIT): an unanswered ring for a hand-over is settled
for the call, and the AI does not ring again on its own.
"""

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol

from . import calls, config, guard, prompt, push, store, twilio_api

log = logging.getLogger("callenvoy.owner")
_sleep = asyncio.sleep  # tests swap this for a fast clock


class Link(Protocol):
    kind: str  # "app" or "phone"
    rate: int  # sample rate of the owner's microphone audio

    async def send_audio(self, pcm8k: bytes) -> None: ...
    async def send_state(self, owner_state: str, phase: str | None) -> None: ...
    async def close(self, ended: bool = False) -> None: ...


@dataclass
class Owner:
    state: str = "none"
    via: str | None = None
    alert_until: str | None = None
    unreachable: bool = False
    link: Link | None = None
    handover: bool = False  # a hand-over (transfer / connect_when / connect_owner) is in progress
    join_on_link: bool = False  # the phone was rung to join: take the call as soon as the link opens
    phone_mode: str = "join"
    alerted_human: bool = False
    timer: asyncio.Task | None = None
    grace: asyncio.Task | None = None
    on_call_since: float | None = None
    last_sent: tuple | None = None


OWNERS: dict[str, Owner] = {}


def get(call_id: str) -> Owner:
    return OWNERS.setdefault(call_id, Owner())


def view(call_id: str) -> dict:
    o = OWNERS.get(call_id) or Owner()
    return {"state": o.state, "via": o.via, "alert_until": o.alert_until, "unreachable": o.unreachable}


def _bot(call_id: str):
    live = calls.LIVE.get(call_id)
    return live.bot if live else None


def _name(row: dict) -> str:
    return prompt.owner_name(row, calls.get_profile())


def _set(call_id: str, **fields) -> None:
    o = get(call_id)
    for k, v in fields.items():
        setattr(o, k, v)
    calls.changed(call_id)


def _cancel(task: asyncio.Task | None) -> None:
    if task and task is not asyncio.current_task() and not task.done():
        task.cancel()


def _later(call_id: str, coro) -> asyncio.Task:
    return calls.spawn(call_id, coro)


def push_state(call_id: str) -> None:
    """Sends {owner, phase} to the owner's link when either changed. Safe to call from sync code."""
    o = OWNERS.get(call_id)
    if not o or not o.link:
        return
    row = store.get_call(call_id)
    now = (o.state, row["phase"] if row else None)
    if now != o.last_sent:
        o.last_sent = now
        try:
            asyncio.get_running_loop().create_task(o.link.send_state(*now))
        except RuntimeError:
            pass


def _live(call_id: str) -> dict:
    row = calls.must(call_id)
    if row["status"] != "in_progress":
        raise calls.CallError("the call is not live", 409)
    return row


# --- Alerts and rings ---

async def _alert(call_id: str, kind: str) -> None:
    row = store.get_call(call_id)
    until = datetime.now(timezone.utc) + timedelta(seconds=row["alert_wait_seconds"])
    _set(call_id, state="alerting", via="app", alert_until=until.strftime("%Y-%m-%dT%H:%M:%SZ"))
    calls.event(call_id, "alert sent")
    asyncio.create_task(push.send_alert(row, kind))  # best effort; never blocks the call


async def _ring(call_id: str, mode: str, phone: str | None = None) -> bool:
    """Rings the owner's phone (a second Twilio call). False when there is no number to ring."""
    row = store.get_call(call_id)
    profile = calls.get_profile()
    number = phone or profile["callback_number"]
    if not number:
        return False
    o = get(call_id)
    try:
        sid = await twilio_api.create_call(
            to=number, url=calls.url(f"/twilio/owner/{call_id}"),
            status_callback=calls.url(f"/twilio/status/{call_id}?leg=owner"),
            ring_seconds=profile["phone_ring_seconds"], time_limit=config.MAX_CALL_MINUTES * 60)
    except Exception as e:  # noqa: BLE001
        log.warning("owner ring failed for %s: %s", call_id, e)
        calls.event(call_id, "could not ring the owner's phone")
        return False
    store.update_call(call_id, owner_twilio_sid=sid)
    o.phone_mode = mode
    o.join_on_link = mode == "join"
    _set(call_id, state="ringing", via="phone", alert_until=None)
    calls.event(call_id, "ringing the owner's phone")
    _cancel(o.timer)
    o.timer = _later(call_id, _ring_timeout(call_id, profile["phone_ring_seconds"] + config.OWNER_GATHER_SECONDS))
    return True


async def _ring_timeout(call_id: str, seconds: int) -> None:
    await _sleep(seconds)
    if get(call_id).state == "ringing":
        await _hang_up_phone(call_id)
        await _not_reached(call_id)


async def _not_reached(call_id: str) -> None:
    """A ring or alert ended without the owner. A hand-over is settled: the AI is told and does not retry."""
    o = get(call_id)
    if o.handover:
        _set(call_id, state="none", via=None, alert_until=None, unreachable=True, handover=False, join_on_link=False)
        row = store.get_call(call_id)
        store.update_call(call_id, phase="talking")
        calls.event(call_id, "owner could not be reached")
        bot = _bot(call_id)
        if bot:
            await bot.tell(prompt.unreachable_note(_name(row), row), run_llm=True)
    elif o.state in ("alerting", "ringing"):
        _set(call_id, state="none", via=None, alert_until=None, join_on_link=False)


async def _hang_up_phone(call_id: str) -> None:
    row = store.get_call(call_id)
    if row and row["owner_twilio_sid"]:
        store.update_call(call_id, owner_twilio_sid=None)
        try:
            await twilio_api.update_call(row["owner_twilio_sid"], hang_up=True)
        except Exception as e:  # noqa: BLE001
            log.warning("owner leg hang up failed for %s: %s", call_id, e)


# --- Entry points ---

async def handover(call_id: str) -> None:
    """The bot called connect_owner: reach the owner as the call's `reach` says."""
    row = store.get_call(call_id)
    o = get(call_id)
    o.handover = True
    if o.link:  # already listening: take the call over right away
        await join(call_id)
        return
    if row["reach"] == "phone":
        if not await _ring(call_id, "join"):
            await _not_reached(call_id)
        return
    await _alert(call_id, "handover")
    _cancel(o.timer)
    o.timer = _later(call_id, _after_alert(call_id, row["alert_wait_seconds"], row["reach"] == "app_then_phone"))


async def _after_alert(call_id: str, seconds: int, then_phone: bool) -> None:
    await _sleep(seconds)
    o = get(call_id)
    if o.state != "alerting":
        return
    if o.handover and then_phone and await _ring(call_id, "join"):
        return
    await _not_reached(call_id)


async def on_human(call_id: str) -> None:
    """handle mode with alert_on_human: one alert when a live person answers. The AI does not wait."""
    o = get(call_id)
    if o.alerted_human or o.state != "none":
        return
    o.alerted_human = True
    await _alert(call_id, "human")
    o.timer = _later(call_id, _expire_alert(call_id, store.get_call(call_id)["alert_wait_seconds"]))


async def _expire_alert(call_id: str, seconds: int) -> None:
    await _sleep(seconds)
    if get(call_id).state == "alerting":
        _set(call_id, state="none", via=None, alert_until=None)


async def listen_in(call_id: str) -> None:
    """listen_in: reach the owner as soon as the business answers. The phone rings with reach phone."""
    row = store.get_call(call_id)
    o = get(call_id)
    if row["reach"] == "phone" and await _ring(call_id, "listen"):
        return
    o.alerted_human = True  # the listen-in alert covers the "person answered" alert
    await _alert(call_id, "listen_in")
    o.timer = _later(call_id, _expire_alert(call_id, row["alert_wait_seconds"]))


async def connect(call_id: str, mode: str = "join", reach: str = "phone", phone: str | None = None) -> str:
    """connect_me / the console's connect route: bring the owner to the call now."""
    _live(call_id)
    o = get(call_id)
    if mode not in ("join", "listen") or reach not in ("phone", "app"):
        raise calls.CallError('mode must be "join" or "listen"; reach must be "phone" or "app"', field="mode")
    if o.state == "on_call":
        return "the owner already has the call"
    if o.link and mode == "join":
        await join(call_id)
        return "the owner took the call over"
    if reach == "app":
        await _alert(call_id, "handover" if mode == "join" else "listen_in")
        o.timer = _later(call_id, _expire_alert(call_id, store.get_call(call_id)["alert_wait_seconds"]))
        return "alert sent to the console and the user's devices"
    if phone:
        try:
            phone = guard.check_number(phone)
        except ValueError as e:
            raise calls.CallError(f"phone: {e}", field="phone") from e
    elif not calls.get_profile()["callback_number"]:
        raise calls.CallError("no phone given and no callback number saved", field="phone")
    if o.state == "ringing":
        return "the owner's phone is already ringing"
    o.unreachable = False  # a ring on request may follow an earlier unanswered one
    if not await _ring(call_id, mode, phone):
        raise calls.CallError("could not ring the phone", 502)
    return f"ringing the phone; they press 1 to {'join' if mode == 'join' else 'listen'}"


async def false_alarm(call_id: str) -> None:
    """The bot judged hold or a menu while a hand-over alert or ring was out: cancel it."""
    o = OWNERS.get(call_id)
    if not o or not o.handover or o.state not in ("alerting", "ringing"):
        return
    _cancel(o.timer)
    if o.state == "ringing":
        await _hang_up_phone(call_id)
    _set(call_id, state="none", via=None, alert_until=None, handover=False, join_on_link=False)
    calls.event(call_id, "false alarm, still on hold")


# --- Links ---

async def attach(call_id: str, link: Link) -> None:
    o = get(call_id)
    old, o.link = o.link, link
    o.last_sent = None
    _cancel(o.grace)
    _cancel(o.timer)
    if old and old is not link:
        await old.close()
    bot = _bot(call_id)
    if bot:
        await bot.set_tap(True)
    if o.state == "on_call":  # reconnected within the grace time: keep the call
        if bot:
            await bot.owner_link_changed(link.rate)
        _set(call_id, via=link.kind)
    elif o.join_on_link:
        o.join_on_link = False
        _set(call_id, state="listening", via=link.kind, alert_until=None)
        await join(call_id)
    else:
        _set(call_id, state="listening", via=link.kind, alert_until=None)
        calls.event(call_id, "owner is listening")
    push_state(call_id)


async def join(call_id: str) -> None:
    o = get(call_id)
    if o.state == "on_call":
        return
    if not o.link:
        raise calls.CallError("the owner has no audio open; use reach phone to ring their phone", 409)
    _cancel(o.timer)
    bot = _bot(call_id)
    if bot:
        await bot.take_over(o.link.rate, _name(store.get_call(call_id)))
    o.on_call_since = time.monotonic()
    _set(call_id, state="on_call", handover=False, alert_until=None, unreachable=False)
    store.update_call(call_id, phase="owner_on_call")
    calls.event(call_id, "owner took the call")


async def hand_back(call_id: str, lost: bool = False) -> str:
    o = OWNERS.get(call_id)
    if not o or o.state != "on_call":
        raise calls.CallError("the owner does not have the call", 409)
    row = store.get_call(call_id)
    _add_owner_seconds(call_id, o)
    _set(call_id, state="listening" if o.link else "none", via=o.via if o.link else None)
    store.update_call(call_id, phase="talking")
    calls.event(call_id, "the connection to the owner was lost" if lost else "owner handed the call back")
    bot = _bot(call_id)
    if bot:
        await bot.hand_back(prompt.handed_back_note(_name(row), lost))
    return "the AI has the call again"


def _add_owner_seconds(call_id: str, o: Owner) -> None:
    if o.on_call_since is not None:
        row = store.get_call(call_id)
        store.update_call(call_id, owner_seconds=(row["owner_seconds"] or 0) + int(time.monotonic() - o.on_call_since))
        o.on_call_since = None


async def detach(call_id: str, link: Link) -> None:
    """The link closed. On the phone, hanging up is the hand-back. In the browser, wait for a reconnect."""
    o = OWNERS.get(call_id)
    if not o or o.link is not link:
        return
    o.link = None
    if o.state == "on_call":
        if link.kind == "phone":
            await hand_back(call_id)
        else:
            o.grace = _later(call_id, _drop_grace(call_id))
        return
    bot = _bot(call_id)
    if bot:
        await bot.set_tap(False)
    _set(call_id, state="none", via=None)


async def _drop_grace(call_id: str) -> None:
    await _sleep(config.OWNER_DROP_GRACE_SECONDS)
    o = OWNERS.get(call_id)
    if o and o.link is None and o.state == "on_call":
        await hand_back(call_id, lost=True)
        bot = _bot(call_id)
        if bot:
            await bot.set_tap(False)
        row = store.get_call(call_id)
        calls.event(call_id, "alert sent")
        asyncio.create_task(push.send_alert(row, "dropped"))


async def mic(call_id: str, link: Link, pcm: bytes) -> bool:
    """Owner microphone audio. Passed to the call only while the owner has it; dropped otherwise."""
    o = OWNERS.get(call_id)
    if not o or o.link is not link or o.state != "on_call":
        return False
    bot = _bot(call_id)
    if bot:
        await bot.feed(pcm, link.rate)
    return True


async def tap(call_id: str, them: bytes, played: bytes) -> None:
    """Call audio from the pipeline tap (8 kHz). Listening: both sides mixed. On the call: only the other side."""
    o = OWNERS.get(call_id)
    if not o or not o.link:
        return
    from pipecat.audio.utils import mix_audio

    await o.link.send_audio(them if o.state == "on_call" else mix_audio(them, played))


async def phone_key(call_id: str, link: Link, digit: str) -> None:
    """Keys on the owner's phone: 1 takes over, * hands back, other keys go to the business while on the call."""
    o = OWNERS.get(call_id)
    if not o or o.link is not link:
        return
    if digit == "1" and o.state == "listening":
        await join(call_id)
    elif digit == "*" and o.state == "on_call":
        await hand_back(call_id)
    elif o.state == "on_call":
        bot = _bot(call_id)
        if bot:
            await bot.press(digit)


async def on_phone_status(call_id: str, status: str) -> None:
    """Status callbacks of the owner's phone leg."""
    if status not in ("completed", "busy", "no-answer", "failed", "canceled"):
        return
    o = OWNERS.get(call_id)
    store.update_call(call_id, owner_twilio_sid=None)
    if o and o.state == "ringing":  # never pressed 1, or did not answer
        _cancel(o.timer)
        await _not_reached(call_id)


async def end(call_id: str) -> None:
    """The call ended: close the link, stop timers, hang up the owner's phone leg."""
    o = OWNERS.pop(call_id, None)
    if o:
        _cancel(o.timer)
        _cancel(o.grace)
        if o.state == "on_call":
            _add_owner_seconds(call_id, o)
            row = store.get_call(call_id)
            if row and not row["outcome_result"]:
                store.update_call(call_id, outcome_result="handed_to_owner",
                                  outcome_summary="The call ended while the owner had it.")
        if o.link:
            await o.link.close(ended=True)
    await _hang_up_phone(call_id)
