"""Calls: place, follow (long-poll), hang up, answer questions, limits, the watchdog, settings order.

The MCP tools and the console API both call these functions; there is no second code path.
"""

import asyncio
import json
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from . import config, demo_line, guard, owner, store, twilio_api

log = logging.getLogger("callenvoy.calls")


class CallError(Exception):
    """A refusal with a plain message for the agent or the console. `field` names the bad input."""

    def __init__(self, message: str, status: int = 400, field: str | None = None):
        super().__init__(message)
        self.status = status
        self.field = field


# --- Inputs: one set of field types for the MCP tool signature and the console body ---

VoiceName = Literal[tuple(config.VOICE_NAMES)]  # type: ignore[valid-type]
VOICE_HELP = "voice of the AI: " + ", ".join(f"{v['name']} ({v['gender']}, {v['accent']})" for v in config.VOICES)
To = Annotated[str, Field(min_length=3, max_length=40, description='US/Canada number to call, e.g. "+14155550123" or "(415) 555-0123"')]
Business = Annotated[str, Field(min_length=1, max_length=120, description='who is called, as a person would say it: "Northstar Internet billing"')]
Goal = Annotated[str, Field(min_length=5, max_length=1500, description="what the call should get done, in plain words")]
Facts = Annotated[str | None, Field(default=None, max_length=3000, description="details the AI may share, one per line")]
MenuTips = Annotated[str | None, Field(default=None, max_length=300, description='hints for the phone menu, e.g. "billing is option 1"')]
Flexibility = Annotated[str | None, Field(default=None, max_length=1500, description='what the AI may accept without asking: "any time 6:30-8pm", "up to $300"')]
OnBehalfOf = Annotated[str | None, Field(default=None, max_length=80, description="who the call is for (default: the profile name). The AI calls FOR this person and never claims to be them.")]
Mode = Annotated[Literal["handle", "transfer"] | None, Field(default=None, description='"handle": the AI does the whole call. "transfer": the AI gets through the menu and hold, then hands the call to the user when a live person answers. Default: setting mode.')]
ConnectWhen = Annotated[str | None, Field(default=None, max_length=300, description='a custom condition for handing the call to the user, e.g. "if they need to speak to me". Giving it turns the hand-over on.')]
Reach = Annotated[Literal["app", "phone", "app_then_phone"] | None, Field(default=None, description='how the user is reached for a hand-over: "app" (console alert and push), "phone" (rings their callback number), "app_then_phone". Default: setting reach.')]
AlertOnHuman = Annotated[bool | None, Field(default=None, description='in "handle" mode: alert the user when a live person answers, so they can listen in. Default: setting.')]
ListenIn = Annotated[bool | None, Field(default=None, description="reach the user as soon as the business answers, to listen from the start. Default: setting.")]
_wait = config.SETTINGS["alert_wait_seconds"]
AlertWait = Annotated[int | None, Field(default=None, ge=_wait["min"], le=_wait["max"], description="seconds the AI waits for the user after an alert before the next step")]
NoAnswer = Annotated[Literal["ai_handles", "end_politely"] | None, Field(default=None, description="what the AI does when the user cannot be reached")]
MaxMinutes = Annotated[int | None, Field(default=None, ge=1, le=config.MAX_CALL_MINUTES, description=f"planned length in minutes (not a hard stop: on hold it waits {config.HOLD_EXTENSION_MINUTES} more minutes at a time, mid-talk {config.TALK_EXTENSION_MINUTES} more; never past {config.MAX_CALL_MINUTES})")]
Voice = Annotated[VoiceName | None, Field(default=None, description=VOICE_HELP)]
QuestionId = Annotated[str, Field(min_length=1, max_length=40)]
AnswerText = Annotated[str, Field(min_length=1, max_length=1000, description='a few plain words, e.g. "Yes, 8:15 works."')]
Record = Annotated[bool | None, Field(default=None, description="record this call. Default: setting record_calls.")]
From = Annotated[Literal["callenvoy", "own"] | None, Field(default=None, alias="from", description='caller ID: "callenvoy" (the CallEnvoy number) or "own" (the user\'s callback number, once verified with callenvoy_verify_number; callbacks then ring the user directly). Default: setting caller_id.')]
LeaveVoicemail = Annotated[bool | None, Field(default=None, description="on voicemail, leave one short message with the callback number (true) or hang up (false). Default: setting leave_voicemail.")]


class PlaceCallInput(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    to: To
    business: Business
    goal: Goal
    facts: Facts = None
    menu_tips: MenuTips = None
    flexibility: Flexibility = None
    on_behalf_of: OnBehalfOf = None
    mode: Mode = None
    connect_when: ConnectWhen = None
    reach: Reach = None
    alert_on_human: AlertOnHuman = None
    listen_in: ListenIn = None
    alert_wait_seconds: AlertWait = None
    no_answer: NoAnswer = None
    max_minutes: MaxMinutes = None
    voice: Voice = None
    record: Record = None
    from_: From = None
    leave_voicemail: LeaveVoicemail = None


# --- Live state (in memory only) ---

@dataclass
class Live:
    event: asyncio.Event = field(default_factory=asyncio.Event)  # set and replaced on every change
    bot: Any = None  # bot.CallBot while the stream runs
    bot_done: bool = False
    moved_from: Any = None  # the bot of the stream that a key press closed, until the next stream takes over
    futures: dict[str, asyncio.Future] = field(default_factory=dict)  # pending ask_user answers
    tasks: list[asyncio.Task] = field(default_factory=list)  # watchdog, grace timers
    last_them: float = 0.0  # monotonic time of the last line from the other side
    last_talk: float = 0.0  # last line from anyone (them, ai, owner)


LIVE: dict[str, Live] = {}


def changed(call_id: str) -> None:
    """Wakes long-polls and updates the owner's audio link state. Hooked into every store write."""
    live = LIVE.get(call_id)
    if live:
        live.event.set()
        live.event = asyncio.Event()
    owner.push_state(call_id)


store.on_change = changed


def spawn(call_id: str, coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    if call_id in LIVE:
        LIVE[call_id].tasks.append(task)
    return task


def event(call_id: str, text: str) -> None:
    store.add_line(call_id, "event", text)


# --- Settings (section 4a): call value wins, then the saved setting, then the constant ---

def check_setting(key: str, value: Any) -> Any:
    """Returns the normalised value, None for "remove", or raises CallError naming the allowed values."""
    spec = config.SETTINGS.get(key)
    if spec is None:
        raise CallError(f"unknown setting {key}; allowed: {', '.join(config.SETTINGS)}", field=key)
    kind = spec["type"]
    if kind in ("text", "phone"):
        if not isinstance(value, str):
            raise CallError(f"{key} must be text", field=key)
        value = value.strip()
        if not value:
            return None
        if kind == "phone":
            try:
                return guard.check_number(value)
            except ValueError as e:
                raise CallError(f"{key}: {e}", field=key) from e
        if len(value) > spec["max"]:
            raise CallError(f"{key} is longer than {spec['max']} characters", field=key)
        return value
    if kind == "choice":
        if value not in spec["choices"]:
            raise CallError(f"{key} must be one of: {', '.join(spec['choices'])}", field=key)
        return value
    if kind == "bool":
        if not isinstance(value, bool):
            raise CallError(f"{key} must be true or false", field=key)
        return value
    if isinstance(value, bool) or not isinstance(value, int) or not spec["min"] <= value <= spec["max"]:
        raise CallError(f"{key} must be a whole number from {spec['min']} to {spec['max']}", field=key)
    return value


def get_profile() -> dict:
    saved = store.get_profile()
    return {k: saved.get(k, d) for k, d in config.SETTING_DEFAULTS.items()}


def save_profile(fields: dict) -> dict:
    changes = {k: check_setting(k, v) for k, v in fields.items() if v is not None}
    store.save_profile(changes)
    return get_profile()


def resolve(inp: PlaceCallInput, profile: dict) -> dict:
    """The settings a call uses: call value, then saved setting, then constant."""
    pick = lambda given, key: given if given is not None else profile[key]  # noqa: E731
    return {
        "mode": pick(inp.mode, "mode"),
        "reach": pick(inp.reach, "reach"),
        "alert_on_human": pick(inp.alert_on_human, "alert_on_human"),
        "listen_in": pick(inp.listen_in, "listen_in"),
        "alert_wait_seconds": pick(inp.alert_wait_seconds, "alert_wait_seconds"),
        "no_answer": pick(inp.no_answer, "no_answer"),
        "max_minutes": pick(inp.max_minutes, "max_minutes"),
        "voice": pick(inp.voice, "voice"),
        "record": pick(inp.record, "record_calls"),
        "caller_id": pick(inp.from_, "caller_id"),
        "leave_voicemail": pick(inp.leave_voicemail, "leave_voicemail"),
    }


# --- Limits ---

def check_limits() -> None:
    live = store.live_calls()
    if len(live) >= config.MAX_CONCURRENT_CALLS:
        raise CallError(f"{config.MAX_CONCURRENT_CALLS} calls are already running; wait for one to end", 429)
    running = sum(_elapsed(r) for r in live)
    if (store.talk_seconds_today() + running) / 60 >= config.DAILY_MINUTE_CAP:
        raise CallError(f"today's limit of {config.DAILY_MINUTE_CAP} call minutes is reached", 429)


def _elapsed(row: dict) -> int:
    if not row.get("answered_at"):
        return 0
    from datetime import datetime, timezone
    start = datetime.strptime(row["answered_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    return int((datetime.now(timezone.utc) - start).total_seconds())


def minutes_used_today() -> int:
    return (store.talk_seconds_today() + sum(_elapsed(r) for r in store.live_calls())) // 60


# --- Place a call ---

def url(path: str) -> str:
    return config.public_base_url() + path


async def place_call(inp: PlaceCallInput) -> dict:
    try:
        number = guard.check_number(inp.to)
    except ValueError as e:
        raise CallError(f"to: {e}", field="to") from e
    profile = get_profile()
    s = resolve(inp, profile)
    hand_over = s["mode"] == "transfer" or bool(inp.connect_when)
    if s["reach"] == "phone" and (hand_over or s["listen_in"]) and not profile["callback_number"]:
        raise CallError("this call may ring the user's phone, but no callback number is saved: save callback_number "
                        "in the profile, or use reach \"app\" or \"app_then_phone\"", field="reach")
    from_number = None
    if s["caller_id"] == "own":  # looked up before the limit check, so no await sits between check and insert
        own = profile["callback_number"]
        if not own or not await caller_id_verified(own):
            raise CallError("the user's own number is not a verified caller ID yet: save callback_number, then run "
                            "callenvoy_verify_number (or Settings > Verify) and type the code on that phone; or use "
                            'from "callenvoy"', field="from")
        from_number = own
    check_limits()

    call_id = store.new_id("c_")
    text = lambda v: (v or "").strip() or None  # noqa: E731
    store.insert_call({
        "id": call_id, "created_at": store.now(), "status": "queued", "phase": None,
        "to_number": number, "business": inp.business.strip(), "goal": inp.goal.strip(),
        "facts": text(inp.facts), "menu_tips": text(inp.menu_tips), "flexibility": text(inp.flexibility),
        "on_behalf_of": text(inp.on_behalf_of) or profile["name"],
        "mode": s["mode"], "connect_when": text(inp.connect_when), "reach": s["reach"],
        "alert_on_human": int(s["alert_on_human"]), "listen_in": int(s["listen_in"]),
        "alert_wait_seconds": s["alert_wait_seconds"], "no_answer": s["no_answer"],
        "max_minutes": s["max_minutes"], "voice": s["voice"], "record": int(s["record"]),
        "ws_token": secrets.token_urlsafe(32),
        "direction": "outbound", "leave_voicemail": int(s["leave_voicemail"]),
        "from_number": from_number or config.env("TWILIO_FROM_NUMBER") or None,
    })
    LIVE[call_id] = Live()
    try:
        sid = await twilio_api.create_call(
            to=number, url=url(f"/twilio/voice/{call_id}"), status_callback=url(f"/twilio/status/{call_id}"),
            record=bool(s["record"]), time_limit=config.MAX_CALL_MINUTES * 60, from_number=from_number)
    except Exception as e:  # noqa: BLE001 - any dial failure ends the call row
        log.warning("dial failed for %s: %s", call_id, e)
        store.update_call(call_id, status="failed", error=f"could not dial: {e}", ended_at=store.now())
        _drop(call_id)
        raise CallError(f"could not dial: {e}", 502) from e
    store.update_call(call_id, twilio_sid=sid)
    store.update_call(call_id, if_status="queued", status="dialing")  # a final status may have arrived first
    spawn(call_id, _dial_timeout(call_id))
    return view(store.get_call(call_id))


async def _dial_timeout(call_id: str) -> None:
    """Closes a call that Twilio never answered and never finished (lost webhooks), so it frees its slot."""
    await asyncio.sleep(config.DIAL_TIMEOUT_SECONDS)
    row = store.get_call(call_id)
    if not row or row["status"] not in ("queued", "dialing"):
        return
    store.update_call(call_id, status="failed", ended_at=store.now(), phase=None,
                      error=f"no answer and no status from Twilio within {config.DIAL_TIMEOUT_SECONDS} s")
    if row["twilio_sid"]:
        try:
            await twilio_api.update_call(row["twilio_sid"], hang_up=True)
        except Exception as e:  # noqa: BLE001
            log.warning("hang up of a stuck call failed for %s: %s", call_id, e)
    await finish(call_id)


# --- Read ---

def must(call_id: str) -> dict:
    row = store.get_call(call_id)
    if not row:
        raise CallError(f"no call with id {call_id}", 404, field="call_id")
    return row


def is_final(row: dict) -> bool:
    return row["status"] in config.FINAL_STATUSES


def recordings(row: dict) -> list[dict]:
    if not row.get("recording_token"):
        return []
    return [{"url": url(f"/r/{row['recording_token']}"), "duration_seconds": row.get("recording_seconds") or 0}]


def view(row: dict, since_line: int = 0, transcript: bool = True) -> dict:
    cid = row["id"]
    qs = store.questions(cid)
    outcome = None
    if row["outcome_result"]:
        outcome = {"result": row["outcome_result"], "summary": row["outcome_summary"] or "",
                   "details": json.loads(row["outcome_details"]) if row["outcome_details"] else {}}
    talk = row["talk_seconds"] if row["talk_seconds"] is not None else _elapsed(row)
    v = {
        "id": cid, "status": row["status"], "phase": row["phase"],
        "finished": is_final(row) and cid not in LIVE,
        "business": row["business"], "number": row["to_number"], "goal": row["goal"],
        "mode": row["mode"], "connect_when": row["connect_when"], "reach": row["reach"],
        "listen_in": bool(row["listen_in"]), "alert_on_human": bool(row["alert_on_human"]),
        "recorded": bool(row["record"]), "voice": row["voice"], "max_minutes": row["max_minutes"],
        "direction": row["direction"], "calling_number": row["from_number"],
        "leave_voicemail": bool(row["leave_voicemail"]),
        "human_at": row["human_at"],
        "owner": owner.view(cid),
        "open_questions": [{"id": q["id"], "question": q["question"]} for q in qs if q["answer"] is None],
        "answered_questions": [{"id": q["id"], "question": q["question"], "answer": q["answer"]} for q in qs if q["answer"] is not None],
        "outcome": outcome,
        "talk_seconds": talk, "owner_seconds": row["owner_seconds"] or 0, "error": row["error"],
        "created_at": row["created_at"], "ended_at": row["ended_at"],
        "recordings": recordings(row),
    }
    if transcript:
        v["transcript"] = store.lines(cid, since_line)
        v["next_line"] = store.next_line(cid)
    return v


async def get_call(call_id: str, wait_seconds: int = 0, since_line: int = 0) -> dict:
    must(call_id)
    live = LIVE.get(call_id)
    caught_up = since_line <= 0 or store.next_line(call_id) <= since_line
    if live and wait_seconds > 0 and caught_up:
        ev = live.event
        try:
            await asyncio.wait_for(ev.wait(), min(wait_seconds, config.MAX_WAIT_SECONDS))
        except TimeoutError:
            pass
    return view(must(call_id), since_line)


def list_calls(limit: int = 10) -> list[dict]:
    return [view(r, transcript=False) for r in store.list_calls(max(1, min(limit, 50)))]


# --- Actions ---

async def hang_up(call_id: str) -> str:
    row = must(call_id)
    if is_final(row):
        return "the call already ended"
    event(call_id, "hang up requested")
    if row["twilio_sid"]:
        try:
            await twilio_api.update_call(row["twilio_sid"], hang_up=True)
        except Exception as e:  # noqa: BLE001
            log.warning("hang up failed for %s: %s", call_id, e)
    await owner.end(call_id)
    live = LIVE.get(call_id)
    if live and live.bot:
        await live.bot.stop()
    if not row["twilio_sid"]:
        store.update_call(call_id, status="canceled", ended_at=store.now(), phase=None)
        await finish(call_id)
    return "hanging up; callenvoy_get_call shows the final state"


async def answer_question(call_id: str, question_id: str, answer: str) -> dict:
    row = must(call_id)
    q = store.get_question(question_id)
    if not q or q["call_id"] != call_id:
        raise CallError(f"no open question {question_id} on this call", 404, field="question_id")
    if is_final(row):
        raise CallError("the call has ended, so the answer cannot reach it", 409)
    if q["answer"] is not None:
        raise CallError("this question was already answered", 409, field="question_id")
    answer = answer.strip()
    if not 1 <= len(answer) <= 1000:
        raise CallError("answer must be 1 to 1000 characters", field="answer")
    store.answer_question(question_id, answer)
    event(call_id, f"answer sent: {answer}")
    live = LIVE.get(call_id)
    fut = live.futures.pop(question_id, None) if live else None
    if fut and not fut.done():
        fut.set_result(answer)
    elif live and live.bot:  # late answer: the ask_user wait already timed out
        await live.bot.tell(f"Answer to your earlier question \"{q['question']}\": {answer}", run_llm=True)
    return {"question_id": question_id, "answer": answer}


async def ask(call_id: str, question: str) -> str | None:
    """Used by the bot's ask_user tool: saves the question and waits up to QUESTION_WAIT_SECONDS."""
    qid = store.add_question(call_id, question)
    event(call_id, f"asked owner: {question}")
    live = LIVE.get(call_id)
    if not live:
        return None
    fut = asyncio.get_running_loop().create_future()
    live.futures[qid] = fut
    try:
        return await asyncio.wait_for(fut, config.QUESTION_WAIT_SECONDS)
    except TimeoutError:
        live.futures.pop(qid, None)
        return None


def note_line(call_id: str, who: str) -> None:
    live = LIVE.get(call_id)
    if live:
        live.last_talk = time.monotonic()
        if who == "them":
            live.last_them = live.last_talk


# --- Caller ID (section 22.2) ---

async def caller_id_verified(number: str | None) -> bool:
    if not number:
        return False
    try:
        return await twilio_api.caller_id_verified(number)
    except Exception as e:  # noqa: BLE001
        log.warning("caller ID lookup failed: %s", e)
        return False


_caller_id_cache: dict[str, tuple[bool, float]] = {}  # number -> (verified, monotonic time of the lookup)


async def caller_id() -> dict:
    """For the console: Twilio's answer is cached for CALLER_ID_CACHE_SECONDS, cleared by a verify request."""
    number = get_profile()["callback_number"]
    hit = _caller_id_cache.get(number or "")
    if hit and time.monotonic() - hit[1] < config.CALLER_ID_CACHE_SECONDS:
        return {"number": number, "verified": hit[0]}
    verified = await caller_id_verified(number)
    if number:
        _caller_id_cache[number] = (verified, time.monotonic())
    return {"number": number, "verified": verified}


async def verify_number() -> dict:
    _caller_id_cache.clear()
    number = get_profile()["callback_number"]
    if not number:
        raise CallError("save callback_number first; that is the number that gets verified", field="callback_number")
    if await caller_id_verified(number):
        return {"number": number, "verified": True, "validation_code": None,
                "message": f"{number} is already a verified caller ID"}
    try:
        code = await twilio_api.start_caller_id_validation(number)
    except Exception as e:  # noqa: BLE001
        raise CallError(f"could not start the verification: {e}", 502) from e
    return {"number": number, "verified": False, "validation_code": code,
            "message": f"Twilio is calling {number} now. Answer and type {code} on the keypad."}


# --- Inbound callbacks (section 22.1): forwarded to the owner's phone, no AI ---

def inbound(form: dict) -> dict | None:
    """Saves an inbound row and returns it, or None when there is no callback number to forward to."""
    profile = get_profile()
    if not profile["callback_number"]:
        return None
    from datetime import datetime, timedelta, timezone
    caller = guard.to_e164(form.get("From", "")) or (form.get("From") or "unknown")[:40]
    since = (datetime.now(timezone.utc) - timedelta(days=config.INBOUND_BUSINESS_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    call_id = store.new_id("c_")
    store.insert_call({
        "id": call_id, "created_at": store.now(), "status": "in_progress", "phase": None, "direction": "inbound",
        "to_number": caller, "business": store.business_for_number(caller, since) or "Incoming call",
        "goal": "Callback forwarded to the owner's phone", "mode": "handle", "reach": "phone",
        "alert_on_human": 0, "listen_in": 0, "alert_wait_seconds": 0, "no_answer": "ai_handles",
        "max_minutes": 0, "voice": config.DEFAULT_VOICE, "record": 0, "leave_voicemail": 0,
        "twilio_sid": form.get("CallSid"), "from_number": profile["callback_number"],
    })
    LIVE[call_id] = Live()  # so get_call with wait_seconds waits until the forward ends
    return {"id": call_id, "caller": caller, "forward_to": profile["callback_number"]}


DIAL_STATUS = {"completed": "completed", "answered": "completed", "busy": "busy", "no-answer": "no_answer",
               "failed": "failed", "canceled": "canceled"}


async def inbound_done(call_id: str, form: dict) -> None:
    row = store.get_call(call_id)
    if row and row["direction"] == "inbound" and not is_final(row):
        store.update_call(call_id, status=DIAL_STATUS.get(form.get("DialCallStatus", ""), "completed"),
                          talk_seconds=int(form.get("DialCallDuration") or 0), ended_at=store.now())
        await finish(call_id)


async def press_keys(call_id: str, digits: str, bot) -> None:
    """Sends real key signals (RFC 2833) to the business.

    Twilio cannot send keys on an open media stream, and tones in the stream audio are not key presses for
    every menu (a Twilio menu ignores them; tested with 120 and 300 ms tones). So the call leaves its stream,
    Twilio plays the digits, and the call joins a new stream. The next bot continues with this bot's context."""
    row, live = must(call_id), LIVE[call_id]
    token = secrets.token_urlsafe(32)
    store.update_call(call_id, ws_token=token)
    live.moved_from = bot
    try:
        await twilio_api.update_call(row["twilio_sid"], hang_up=False, twiml=twilio_api.twiml(
            f'<Play digits="{digits}"/>' + demo_line.stream(f"/twilio/media/{token}")))
    except Exception:
        live.moved_from = None
        store.update_call(call_id, ws_token=None)
        raise


async def _stream_lost(call_id: str, bot) -> None:
    """A key press closed the stream. If the next stream does not come (the business hung up), close the call."""
    live = LIVE[call_id]
    for _ in range(config.KEY_PRESS_REJOIN_SECONDS * 2):
        await asyncio.sleep(0.5)
        if live.moved_from is not bot:  # the next stream took over
            return
        if is_final(must(call_id)):
            break
    live.moved_from = None
    store.update_call(call_id, ws_token=None)
    await bot.summary_if_missing()
    await bot_finished(call_id)


# --- Twilio events ---

TWILIO_STATUS = {"queued": "dialing", "initiated": "dialing", "ringing": "dialing", "in-progress": "in_progress",
                 "completed": "completed", "busy": "busy", "no-answer": "no_answer", "failed": "failed", "canceled": "canceled"}


async def on_status(call_id: str, form: dict, leg: str = "business") -> None:
    """Twilio status and recording callbacks. The owner's phone leg posts here with leg=owner."""
    row = store.get_call(call_id)
    if not row:
        return
    # Twilio also puts RecordingSid in the final call status when the call is recorded, so only a callback
    # without CallStatus is the recording callback. (The first real call stayed "in progress" because of this.)
    if form.get("RecordingSid") and "CallStatus" not in form:
        if form.get("RecordingStatus", "completed") == "completed":
            store.update_call(call_id, recording_sid=form["RecordingSid"],
                              recording_seconds=int(form.get("RecordingDuration") or 0),
                              recording_token=row["recording_token"] or secrets.token_urlsafe(24))
        return
    if leg == "owner":
        await owner.on_phone_status(call_id, form.get("CallStatus", ""))
        return
    status = TWILIO_STATUS.get(form.get("CallStatus", ""))
    if not status or is_final(row):
        return
    if status in config.FINAL_STATUSES:
        store.update_call(call_id, status=status, ended_at=store.now(),
                          talk_seconds=int(form.get("CallDuration") or 0), phase=None)
        await owner.end(call_id)
        live = LIVE.get(call_id)
        if live and live.bot and not live.bot_done:
            await live.bot.stop()  # the bot writes the summary, then calls bot_finished
        elif not (live and live.moved_from):  # else _stream_lost writes the summary and finishes
            await finish(call_id)
    elif status == "in_progress" and not row["answered_at"]:
        store.update_call(call_id, status=status, answered_at=store.now())
    elif status != row["status"] and row["status"] != "in_progress":
        store.update_call(call_id, status=status)


async def stream_started(call_id: str, bot) -> None:
    row = must(call_id)
    live = LIVE.setdefault(call_id, Live())
    again, live.moved_from = live.moved_from is not None, None
    live.bot = bot
    if again:  # the stream after a key press: the call, its watchdog and the owner's link are already running
        await owner.bot_changed(call_id)
        return
    fields = {"status": "in_progress"}
    if not row["answered_at"]:
        fields["answered_at"] = store.now()
    store.update_call(call_id, **fields)
    spawn(call_id, watchdog(call_id))
    if row["listen_in"]:
        await owner.listen_in(call_id)


async def bot_finished(call_id: str, bot=None) -> None:
    live = LIVE.get(call_id)
    if live and bot is not None and bot.moved:  # a key press closed this stream; the call goes on
        if live.bot is bot:
            live.bot = None
            spawn(call_id, _stream_lost(call_id, bot))
        return
    if live:
        live.bot_done = True
        live.bot = None
    row = store.get_call(call_id)
    if row and is_final(row):
        await finish(call_id)
    elif row:
        spawn(call_id, _finish_later(call_id))


async def _finish_later(call_id: str) -> None:
    """If Twilio's final status never arrives, close the call anyway so nothing hangs."""
    await asyncio.sleep(config.BOT_DONE_GRACE_SECONDS)
    row = store.get_call(call_id)
    if row and not is_final(row):
        store.update_call(call_id, status="completed", ended_at=store.now(), phase=None, talk_seconds=_elapsed(row))
    await finish(call_id)


async def finish(call_id: str) -> None:
    await owner.end(call_id)
    live = _drop(call_id)
    if live:
        live.event.set()
    changed(call_id)


def _drop(call_id: str) -> Live | None:
    live = LIVE.pop(call_id, None)
    if live:
        for f in live.futures.values():
            if not f.done():
                f.cancel()
        current = asyncio.current_task()
        for t in live.tasks:
            if t is not current:
                t.cancel()
    return live


# --- Watchdog: max_minutes is a planned length, not a blind cut (Call4me time-limit.ts lesson) ---

def next_deadline(now: float, deadline: float, started: float, phase: str | None, last_talk: float,
                  owner_on_call: bool = False) -> float | None:
    """At the planned end: on hold add HOLD_EXTENSION, in a live talk add TALK_EXTENSION, else None (hang up).
    Never passes MAX_CALL_MINUTES after `started`."""
    ceiling = started + config.MAX_CALL_MINUTES * 60
    if now < deadline:
        return min(deadline, ceiling)
    if now >= ceiling:
        return None
    if phase == "on_hold":
        new = now + config.HOLD_EXTENSION_MINUTES * 60
    elif owner_on_call or (last_talk and now - last_talk < config.TALK_RECENT_SECONDS):
        new = now + config.TALK_EXTENSION_MINUTES * 60
    else:
        return None
    return min(new, ceiling)


async def watchdog(call_id: str) -> None:
    started = time.monotonic()
    deadline = started + must(call_id)["max_minutes"] * 60
    while True:
        await asyncio.sleep(max(0.0, deadline - time.monotonic()))
        row, live = store.get_call(call_id), LIVE.get(call_id)
        if not row or not live or is_final(row):
            return
        new = next_deadline(time.monotonic(), deadline, started, row["phase"], live.last_talk,
                            owner.view(call_id)["state"] == "on_call")
        if new is None:
            event(call_id, "time limit reached, hanging up")
            await hang_up(call_id)
            return
        if new > deadline:
            event(call_id, f"planned length reached; {round((new - time.monotonic()) / 60)} more minutes allowed")
        deadline = new


# --- Startup ---

async def restart_cleanup() -> None:
    for row in store.restart_cleanup():
        for sid in (row["twilio_sid"], row["owner_twilio_sid"]):
            if sid:
                try:
                    await twilio_api.update_call(sid, hang_up=True)
                except Exception as e:  # noqa: BLE001
                    log.warning("could not hang up orphan leg of %s: %s", row["id"], e)
