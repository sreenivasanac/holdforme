"""The MCP server: 12 tools with the prefix callenvoy_. Stateless, JSON responses.

Design follows the Call4me MCP server (src/server/mcp/server.ts, MIT): one prefix, text plus structured content
in every result, plain tool errors, one log line per tool call without arguments, read-only / open-world /
destructive annotations, and the same tool and field names where the scope overlaps.
"""

import functools
import inspect
import logging
import time
from typing import Annotated, Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp_types import CallToolResult, TextContent, ToolAnnotations
from pydantic import Field

from . import calls, config, owner

log = logging.getLogger("callenvoy.mcp")
P = config.TOOL_PREFIX

INSTRUCTIONS = f"""{config.APP_NAME} places real phone calls for the user and can bring the user onto a call.
1. Read {P}get_profile first: the user's name, callback number and call defaults. Collect every detail the call needs BEFORE dialing (what to get done, the facts the AI may share, what it may accept without asking).
2. Place the call with {P}place_call. It returns a call id at once.
3. Loop {P}get_call with wait_seconds: 30 (pass next_line back as since_line) until finished is true.
4. If open_questions is not empty, the person on the phone is waiting: ask the user and reply with {P}answer_question right away.
5. If owner.state is "alerting", a person is on the line: tell the user they can join in the {config.APP_NAME} console, or ring their phone with {P}connect_me. Use {P}hand_back when the user wants the AI to continue.
6. Tell the user the outcome in a line or two.
Calls are US and Canada only. Use {P}verify_number once before calling from the user's own number (from: "own")."""

RO = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)
ACT = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=False)
OPEN = ToolAnnotations(read_only_hint=False, destructive_hint=False, idempotent_hint=False, open_world_hint=True)
DIALS = ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=False, open_world_hint=True)

CallId = Annotated[str, Field(min_length=1, max_length=40, description='the call id from callenvoy_place_call, e.g. "c_ab12..."')]


def ok(text: str, data: Any) -> CallToolResult:
    return CallToolResult(content=[TextContent(text=text)],
                          structured_content=data if isinstance(data, dict) else {"result": data})


def fail(message: str) -> CallToolResult:
    return CallToolResult(content=[TextContent(text=message)], is_error=True)


def tool(server: MCPServer, name: str, title: str, description: str, annotations: ToolAnnotations):
    """Registers a tool that logs one line per call (never the arguments) and turns CallError into a tool error."""
    def deco(fn):
        @functools.wraps(fn)
        async def wrapper(**kw) -> CallToolResult:
            started = time.monotonic()
            try:
                result = await fn(**kw)
            except calls.CallError as e:
                result = fail(str(e))
            except Exception:  # noqa: BLE001
                log.exception("tool %s failed", name)
                result = fail("something broke on the server; try again in a moment")
            log.info("mcp tool %s %dms %s", name, (time.monotonic() - started) * 1000,
                     "error" if result.is_error else "ok")
            return result

        server.add_tool(wrapper, name=P + name, title=title, description=description,
                        annotations=annotations.model_copy(update={"title": title}))
        return fn
    return deco


def with_model_signature(fn, model):
    """Gives `fn(**kw)` the signature of a pydantic model's fields, so the tool's input schema is the model's
    (needed for the field named "from", which is not a Python parameter name)."""
    params = [inspect.Parameter(n, inspect.Parameter.KEYWORD_ONLY, default=None if not f.is_required() else inspect.Parameter.empty,
                                annotation=Annotated[f.annotation, f])
              for n, f in model.model_fields.items()]
    fn.__signature__ = inspect.Signature(params, return_annotation=CallToolResult)
    return fn


def call_text(v: dict) -> str:
    """Open question first, in capitals, with the tool to answer it; an owner alert second (Call4me pattern)."""
    out = []
    for q in v["open_questions"]:
        out.append(f"OPEN QUESTION (the person on the phone is waiting; answer now with {P}answer_question): [{q['id']}] {q['question']}")
    if v["owner"]["state"] == "alerting":
        out.append(f"A PERSON IS ON THE LINE. The user can join in the console, or call {P}connect_me to ring their phone.")
    out.append(f"{v['id']} · {v['direction']} · {v['status']}{' · ' + v['phase'] if v['phase'] else ''} · {v['business']} {v['number']}"
               f" · owner {v['owner']['state']}{' (unreachable)' if v['owner']['unreachable'] else ''}"
               f" · finished {str(v['finished']).lower()}")
    if v["outcome"]:
        out.append(f"outcome: {v['outcome']['result']}. {v['outcome']['summary']}")
        if v["outcome"]["details"]:
            out.append(f"details: {v['outcome']['details']}")
    if v["error"]:
        out.append(f"error: {v['error']}")
    lines = v.get("transcript") or []
    if lines:
        out.append("transcript:")
        out += [f"{l['n']} {l['who']}: {l['text']}" for l in lines]
    if "next_line" in v:
        out.append(f"next_line: {v['next_line']}")
    return "\n".join(out)


def profile_view(profile: dict, verified: bool) -> dict:
    return {**profile, "caller_id_verified": verified}


def build() -> MCPServer:
    server = MCPServer(name=config.APP_NAME, instructions=INSTRUCTIONS, version="1.0.0")

    async def place_call(**kw) -> CallToolResult:
        v = await calls.place_call(calls.PlaceCallInput.model_validate(kw))
        return ok(f"calling {v['business']} at {v['number']} ({v['id']}) from {v['calling_number'] or 'the CallEnvoy number'}. "
                  f"Poll {P}get_call with wait_seconds: 30 until finished, and answer any open question at once.", v)

    tool(server, "place_call", "Place a phone call",
         "Call a business (US/Canada) for the user and get something done: book, cancel, ask, fix a bill. Checks the "
         "number and limits, saves the call and dials. Returns the call id at once; follow it with "
         f"{P}get_call. A call cannot be taken back, so confirm with the user first.", DIALS)(
        with_model_signature(place_call, calls.PlaceCallInput))

    @tool(server, "get_call", "Check on a call",
          "Status, phase, owner state, open questions, transcript and (when finished) the outcome. With wait_seconds "
          "it returns early when something changes, so poll with wait_seconds: 30 and pass next_line as since_line.", RO)
    async def get_call(call_id: CallId,
                       wait_seconds: Annotated[int, Field(ge=0, le=50, description="wait up to this long for a change")] = 0,
                       since_line: Annotated[int, Field(ge=0, description="only transcript lines from this number on")] = 0) -> CallToolResult:
        v = await calls.get_call(call_id, wait_seconds, since_line)
        return ok(call_text(v), v)

    @tool(server, "hang_up", "Hang up a call", "End a live call now, including the user's phone leg. Safe to repeat.", DIALS)
    async def hang_up(call_id: CallId) -> CallToolResult:
        msg = await calls.hang_up(call_id)
        return ok(msg, {"call_id": call_id, "message": msg})

    @tool(server, "list_calls", "List recent calls", "Recent calls, newest first, without transcripts.", RO)
    async def list_calls(limit: Annotated[int, Field(ge=1, le=50)] = 10) -> CallToolResult:
        rows = calls.list_calls(limit)
        text = "\n".join(f"{v['id']} · {v['created_at'][:16].replace('T', ' ')} · {v['direction']} · {v['status']} · "
                         f"{v['business']} {v['number']}{' · ' + v['outcome']['summary'] if v['outcome'] else ''}"
                         for v in rows) or "no calls yet"
        return ok(text, {"calls": rows})

    @tool(server, "answer_question", "Answer the AI's question",
          "Answer a question the AI asked mid-call (open_questions). The AI says it on the line. Answer in a few plain words.", ACT)
    async def answer_question(call_id: CallId, question_id: Annotated[str, Field(min_length=1, max_length=40)],
                              answer: Annotated[str, Field(min_length=1, max_length=1000)]) -> CallToolResult:
        r = await calls.answer_question(call_id, question_id, answer)
        return ok(f'sent to the AI: "{r["answer"]}"', r)

    @tool(server, "connect_me", "Bring the user onto a live call",
          'Bring the user onto the call now. reach "phone" (default) rings their phone (the profile callback number '
          'unless phone is given); they press 1 to join or listen. reach "app" sends an alert to the console and '
          'their devices. mode "join" (default): they take the call over and the AI goes quiet; "listen": they hear the '
          "call while the AI keeps working (key 1 takes over). They hand back with * or by hanging up. Tell the user first.", OPEN)
    async def connect_me(call_id: CallId,
                         mode: Literal["join", "listen"] = "join",
                         reach: Literal["phone", "app"] = "phone",
                         phone: Annotated[str | None, Field(max_length=40, description="a different US/Canada number to ring")] = None) -> CallToolResult:
        msg = await owner.connect(call_id, mode, reach, phone)
        return ok(msg, {"call_id": call_id, "message": msg, "owner": owner.view(call_id)})

    @tool(server, "hand_back", "Give the call back to the AI",
          "While the user has the call, give it back to the AI. The user keeps listening if their audio is open.", ACT)
    async def hand_back(call_id: CallId) -> CallToolResult:
        msg = await owner.hand_back(call_id)
        return ok(msg, {"call_id": call_id, "message": msg})

    @tool(server, "get_recordings", "Get call recordings",
          "Recording links of a call: [{url, duration_seconds}]. Empty until Twilio has finished the file.", RO)
    async def get_recordings(call_id: CallId) -> CallToolResult:
        row = calls.must(call_id)
        recs = calls.recordings(row)
        note = ("this call was not recorded" if not row["record"] else
                "no recording yet; try again in a minute" if not recs else
                "\n".join(f"{r['url']} ({r['duration_seconds']} s)" for r in recs))
        return ok(note, {"recordings": recs})

    @tool(server, "get_profile", "Saved profile and settings",
          "The user's saved profile (name, callback number, calling profile details) and every call setting.", RO)
    async def get_profile() -> CallToolResult:
        p = profile_view(calls.get_profile(), (await calls.caller_id())["verified"])
        return ok("\n".join(f"{k}: {v}" for k, v in p.items() if v is not None), p)

    async def save_profile(**kw) -> CallToolResult:
        p = calls.save_profile({k: v for k, v in kw.items() if v is not None})
        return ok("saved", p)

    tool(server, "save_profile", "Save profile and settings",
         "Merge fields into the saved profile and settings. An empty string removes a text field. Wrong values give "
         "an error that names the allowed values. Save personal details only with the user's agreement.",
         ToolAnnotations(read_only_hint=False, destructive_hint=True, idempotent_hint=True, open_world_hint=False))(
        _settings_signature(save_profile))

    @tool(server, "list_voices", "List voices", "Every voice the AI can use, with a sample link and the default.", RO)
    async def list_voices() -> CallToolResult:
        vs = voices()
        return ok("\n".join(f"{v['name']}{' (default)' if v['default'] else ''}: {v['gender']}, {v['accent']}, "
                            f"{v['style']} · {v['sample_url']}" for v in vs), {"voices": vs})

    @tool(server, "verify_number", "Verify the user's own number as caller ID",
          "Starts Twilio's verification of the saved callback number, so calls can show it (place_call from: \"own\"). "
          "Twilio calls that number; the user types the returned 6-digit code on the keypad. Tell the user the code.", OPEN)
    async def verify_number() -> CallToolResult:
        r = await calls.verify_number()
        return ok(r["message"], r)

    return server


def _settings_signature(fn):
    """save_profile takes every setting of section 4a (and 22) as an optional field."""
    kinds = {"text": str, "phone": str, "bool": bool, "int": int}
    params = []
    for k, spec in config.SETTINGS.items():
        t = Literal[tuple(spec["choices"])] if spec["type"] == "choice" else kinds[spec["type"]]
        desc = {"text": f"text, at most {spec.get('max')} characters; empty string removes it",
                "phone": "US/Canada number; empty string removes it", "bool": "true or false",
                "int": f"{spec.get('min')} to {spec.get('max')}", "choice": "one of: " + ", ".join(spec.get("choices", []))}[spec["type"]]
        if k == "voice":
            desc = calls.VOICE_HELP
        params.append(inspect.Parameter(k, inspect.Parameter.KEYWORD_ONLY, default=None,
                                        annotation=Annotated[t | None, Field(description=desc)]))
    fn.__signature__ = inspect.Signature(params, return_annotation=CallToolResult)
    return fn


def voices() -> list[dict]:
    base = config.public_base_url()
    return [{"name": v["name"], "gender": v["gender"], "accent": v["accent"], "style": v["style"],
             "sample_url": f"{base}/static/voices/{v['name'].lower()}.mp3", "default": v["name"] == config.DEFAULT_VOICE}
            for v in config.VOICES]


server = build()
