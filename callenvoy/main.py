"""FastAPI app: auth middleware, console API, Twilio webhooks and sockets, MCP endpoint, the web export.

Run: uv run uvicorn callenvoy.main:app --host 127.0.0.1 --port 3020 --no-access-log  (one worker only:
live call state is in memory). Everything lives under BASE_PATH (/callenvoy), which nginx passes through.
"""

import contextlib
import logging
import os
import sys
from urllib.parse import urlparse
from xml.sax.saxutils import escape, quoteattr

from fastapi import FastAPI, Query, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger as loguru_logger
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, Field

from . import calls, config, demo_line, guard, mcp_server, owner, owner_audio, push, store, twilio_api

log = logging.getLogger("callenvoy")


def startup_checks() -> None:
    """Refuses to start without a strong API key. Outside dev mode (CALLENVOY_DEV=1) it also needs an https
    PUBLIC_BASE_URL, every provider key and the web export. Messages name the variable, never its value."""
    if len(guard.api_key()) < config.API_KEY_MIN_LENGTH:
        raise SystemExit(f"CALLENVOY_API_KEY is missing or shorter than {config.API_KEY_MIN_LENGTH} characters")
    if config.dev_mode():
        return
    if not config.env("PUBLIC_BASE_URL").startswith("https://"):
        raise SystemExit("PUBLIC_BASE_URL is missing or not an https URL")
    missing = [name for name in config.REQUIRED_ENV if not config.env(name)]
    if missing:
        raise SystemExit(f"missing environment variables: {', '.join(missing)}")
    if not (config.WEB_DIR / "index.html").is_file():
        raise SystemExit(f"{config.WEB_DIR}/index.html is missing. Build the console first: {config.WEB_BUILD_COMMAND} "
                         "(or set CALLENVOY_DEV=1 for a local run without it)")


def quiet_logs() -> None:
    """Pipecat logs every spoken sentence at DEBUG and httpx logs URLs with phone numbers at INFO (plan 22.4)."""
    loguru_logger.remove()
    loguru_logger.add(sys.stderr, level="WARNING")
    for name in ("httpx", "openai", "mcp.server.streamable_http"):  # one INFO line per request, no value
        logging.getLogger(name).setLevel(logging.WARNING)


# --- MCP (stateless, plain JSON). transport_security is required: the SDK otherwise only accepts Host: localhost. ---

_public_host = urlparse(config.PUBLIC_ORIGIN).hostname or "pragnyalabs.com"
_hosts = [_public_host, "localhost:*", "127.0.0.1:*"]  # the service listens on 127.0.0.1 only; nginx sets Host
_origins = [config.PUBLIC_ORIGIN] + ([config.DEV_ORIGIN] if config.dev_mode() else [])
_mcp_app = mcp_server.server.streamable_http_app(
    streamable_http_path="/mcp", stateless_http=True, json_response=True,
    transport_security=TransportSecuritySettings(allowed_hosts=_hosts, allowed_origins=_origins))


@contextlib.asynccontextmanager
async def lifespan(_app):
    os.umask(0o077)  # the database and its -wal / -shm files are readable by this user only
    quiet_logs()
    startup_checks()
    store.open_db()
    await calls.restart_cleanup()
    async with mcp_server.server.session_manager.run():
        yield


api = FastAPI(title=config.APP_NAME, docs_url=None, redoc_url=None, openapi_url=None)
api.router.routes.extend(_mcp_app.routes)  # POST /mcp, served by the SDK's ASGI handler


class AuthMiddleware:
    """Bearer key for /mcp and /api/* (except the Twilio-signed demo line). /mcp/<key> is rewritten to /mcp.
    401 carries no detail. The key-in-path form is never logged (run uvicorn with --no-access-log)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        root = scope.get("root_path", "")
        path = scope["path"][len(root):] if scope["path"].startswith(root) else scope["path"]
        key = None
        if path.startswith("/mcp/"):
            key = path[len("/mcp/"):].rstrip("/")
            scope = {**scope, "path": root + "/mcp", "raw_path": (root + "/mcp").encode()}
        elif path == "/mcp" or (path.startswith("/api/") and path != "/api/demo-line"):
            auth = dict(scope["headers"]).get(b"authorization", b"").decode("latin-1")
            key = auth[7:].strip() if auth[:7].lower() == "bearer " else ""
        else:
            return await self.app(scope, receive, send)
        if scope["method"] == "OPTIONS" and path.startswith("/api/"):  # CORS preflight carries no key
            return await self.app(scope, receive, send)
        if not guard.key_ok(key):
            return await JSONResponse({"detail": "unauthorized"}, status_code=401)(scope, receive, send)
        return await self.app(scope, receive, send)


api.add_middleware(AuthMiddleware)
if config.dev_mode():  # local Expo dev server only; production is same-origin
    api.add_middleware(CORSMiddleware, allow_origins=[config.DEV_ORIGIN], allow_methods=["*"],
                       allow_headers=["Authorization", "Content-Type"])


# --- errors: {"detail": message, "field": name} ---

@api.exception_handler(calls.CallError)
async def _call_error(_req, e: calls.CallError):
    body = {"detail": str(e)}
    if e.field:
        body["field"] = e.field
    return JSONResponse(body, status_code=e.status)


@api.exception_handler(RequestValidationError)
async def _invalid(_req, e: RequestValidationError):
    err = e.errors()[0] if e.errors() else {}
    loc = [str(p) for p in err.get("loc", []) if p not in ("body", "query", "path")]
    field = loc[-1] if loc else None
    return JSONResponse({"detail": f"{field + ': ' if field else ''}{err.get('msg', 'invalid input')}", "field": field},
                        status_code=400)


# --- console API (same functions as the MCP tools) ---

@api.get("/healthz")
async def healthz():
    return {"ok": True}


@api.get("/api/config")
async def get_config():
    return {
        "app_name": config.APP_NAME,
        "mcp_url": config.public_base_url() + "/mcp",
        "voices": mcp_server.voices(),
        "limits": {"max_call_minutes": config.MAX_CALL_MINUTES, "max_concurrent_calls": config.MAX_CONCURRENT_CALLS,
                   "daily_minute_cap": config.DAILY_MINUTE_CAP, "minutes_used_today": calls.minutes_used_today()},
        "defaults": config.SETTING_DEFAULTS,
        "choices": {k: s["choices"] for k, s in config.SETTINGS.items() if s["type"] == "choice"},
        "ranges": {k: [s["min"], s["max"]] for k, s in config.SETTINGS.items() if s["type"] == "int"},
        "text_limits": {k: s["max"] for k, s in config.SETTINGS.items() if s["type"] == "text"},
        "vapid_public_key": config.env("VAPID_PUBLIC_KEY") or None if push.enabled() else None,
    }


@api.get("/api/calls")
async def list_calls(limit: int = Query(10, ge=1, le=50)):
    return calls.list_calls(limit)


@api.post("/api/calls")
async def place_call(body: calls.PlaceCallInput):
    return {"id": (await calls.place_call(body))["id"]}


@api.get("/api/calls/{call_id}")
async def get_call(call_id: str, wait_seconds: int = Query(0, ge=0, le=50), since_line: int = Query(0, ge=0)):
    return await calls.get_call(call_id, wait_seconds, since_line)


@api.post("/api/calls/{call_id}/hang-up")
async def hang_up(call_id: str):
    return {"ok": True, "message": await calls.hang_up(call_id)}


class Answer(BaseModel):
    question_id: calls.QuestionId
    answer: calls.AnswerText


@api.post("/api/calls/{call_id}/answer")
async def answer(call_id: str, body: Answer):
    await calls.answer_question(call_id, body.question_id, body.answer)
    return {"ok": True, "message": "sent"}


class Connect(BaseModel):
    mode: str = "join"
    reach: str = "phone"
    phone: str | None = Field(None, max_length=40)


@api.post("/api/calls/{call_id}/connect")
async def connect(call_id: str, body: Connect):
    return {"ok": True, "message": await owner.connect(call_id, body.mode, body.reach, body.phone)}


@api.post("/api/calls/{call_id}/hand-back")
async def hand_back(call_id: str):
    return {"ok": True, "message": await owner.hand_back(call_id)}


@api.post("/api/calls/{call_id}/audio-ticket")
async def audio_ticket(call_id: str):
    row = calls.must(call_id)
    if row["status"] != "in_progress" or call_id not in calls.LIVE:
        raise calls.CallError("the call is not live", 409)
    return {"ticket": guard.issue_ticket(call_id), "expires_in": config.AUDIO_TICKET_SECONDS}


@api.get("/api/profile")
async def get_profile():
    return calls.get_profile()


@api.put("/api/profile")
async def put_profile(request: Request):
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise calls.CallError("send a JSON object of settings")
    return calls.save_profile(body)


@api.get("/api/caller-id")
async def caller_id():
    return await calls.caller_id()


@api.post("/api/caller-id/verify")
async def caller_id_verify():
    return {"validation_code": (await calls.verify_number())["validation_code"]}


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=1, max_length=200)
    auth: str = Field(min_length=1, max_length=100)


class PushSub(BaseModel):
    endpoint: str = Field(min_length=1, max_length=1000)
    keys: PushKeys
    label: str | None = Field(None, max_length=80)


class PushEndpoint(BaseModel):
    endpoint: str = Field(min_length=1, max_length=1000)


@api.post("/api/push/subscriptions")
async def push_subscribe(body: PushSub):
    if not push.endpoint_ok(body.endpoint):
        raise calls.CallError("this push service is not supported", field="endpoint")
    known = {d["endpoint"] for d in store.push_devices()}
    if body.endpoint not in known and len(known) >= config.MAX_PUSH_DEVICES:
        raise calls.CallError(f"at most {config.MAX_PUSH_DEVICES} devices; remove one first", 409)
    store.save_push_device(body.endpoint, body.keys.p256dh, body.keys.auth, body.label)
    return {"ok": True}


@api.delete("/api/push/subscriptions")
async def push_unsubscribe(body: PushEndpoint):
    store.delete_push_device(body.endpoint)
    return {"ok": True}


@api.post("/api/push/test")
async def push_test():
    if not push.enabled():
        raise calls.CallError("web push is off: the server has no VAPID keys", 409)
    return {"sent": await push.send(push.payload({"business": ""}, "test", False))}


# --- recordings ---

@api.get("/r/{token}")
async def recording(token: str):
    row = store.find_call("recording_token", token) if len(token) >= 16 else None
    if not row or not row["recording_sid"]:
        return JSONResponse({"detail": "not found"}, status_code=404)
    stream = twilio_api.fetch_recording(row["recording_sid"])
    try:
        first = await anext(stream)
    except (twilio_api.TwilioError, StopAsyncIteration):
        return JSONResponse({"detail": "recording not available"}, status_code=502)

    async def body():
        yield first
        async for chunk in stream:
            yield chunk

    return StreamingResponse(body(), media_type="audio/mpeg")


# --- Twilio webhooks (signature checked) ---

def xml(body: str) -> Response:
    return Response(twilio_api.twiml(body), media_type="text/xml")


async def twilio_form(request: Request) -> dict | None:
    """The form fields when the X-Twilio-Signature matches PUBLIC_BASE_URL + path + query, else None."""
    form = {k: str(v) for k, v in (await request.form()).items()}
    root = request.scope.get("root_path", "")
    path = request.url.path[len(root):] if request.url.path.startswith(root) else request.url.path
    url = config.public_base_url() + path + (f"?{request.url.query}" if request.url.query else "")
    return form if guard.twilio_ok(url, form, request.headers.get("x-twilio-signature")) else None


FORBIDDEN = Response("forbidden", status_code=403)


@api.post("/twilio/voice/{call_id}")
async def twilio_voice(call_id: str, request: Request):
    if await twilio_form(request) is None:
        return FORBIDDEN
    row = store.get_call(call_id)
    if not row or row["status"] not in ("dialing", "in_progress") or not row["ws_token"]:
        return xml("<Hangup/>")
    return xml(demo_line.stream(f"/twilio/media/{row['ws_token']}"))


@api.post("/twilio/status/{call_id}")
async def twilio_status(call_id: str, request: Request, leg: str = "business"):
    form = await twilio_form(request)
    if form is None:
        return FORBIDDEN
    await calls.on_status(call_id, form, "owner" if leg == "owner" else "business")
    return Response(status_code=204)


@api.post("/twilio/owner/{call_id}")
async def twilio_owner(call_id: str, request: Request):
    """The owner's phone leg: "Press 1 to join" (a key press stops a voicemail being put on the call)."""
    form = await twilio_form(request)
    if form is None:
        return FORBIDDEN
    row = store.get_call(call_id)
    o = owner.OWNERS.get(call_id)
    if not row or row["status"] != "in_progress" or not o:
        return xml("<Hangup/>")
    if form.get("Digits") == "1":
        ticket = guard.issue_ticket(f"owner:{call_id}")
        return xml(demo_line.stream(f"/twilio/owner-media/{call_id}/{ticket}"))
    if "Digits" in form:
        return xml("<Hangup/>")
    action = quoteattr(config.public_base_url() + f"/twilio/owner/{call_id}")
    verb = "join" if o.phone_mode == "join" else "listen"
    say = escape(f"{config.APP_NAME}. {row['business']} is on the line. Press 1 to {verb}.")
    return xml(f'<Gather numDigits="1" timeout="{config.OWNER_GATHER_SECONDS}" action={action} method="POST">'
               f"<Say>{say}</Say></Gather><Hangup/>")


def inbound_twiml(fwd: dict | None, caller_id: str | None = None) -> str:
    """Section 22.1: forward a callback to the owner's phone, showing who calls. No number: refuse politely.
    TODO: the AI answers a callback and continues the earlier task (Call4me does this)."""
    if not fwd:
        return demo_line.refuse_twiml()
    retry = "" if caller_id is None else "?retry=1"
    action = quoteattr(config.public_base_url() + f"/twilio/inbound-done/{fwd['id']}{retry}")
    return twilio_api.twiml(f'<Dial callerId={quoteattr(caller_id or fwd["caller"])} '
                            f'timeout="{config.INBOUND_RING_SECONDS}" action={action} method="POST">'
                            f"<Number>{escape(fwd['forward_to'])}</Number></Dial>")


@api.post("/twilio/inbound")
async def twilio_inbound(request: Request):
    form = await twilio_form(request)
    if form is None:
        return FORBIDDEN
    return Response(inbound_twiml(calls.inbound(form)), media_type="text/xml")


@api.post("/twilio/inbound-done/{call_id}")
async def twilio_inbound_done(call_id: str, request: Request, retry: str | None = None):
    """End of the forward. If Twilio refused the caller's number as caller ID, try once more with ours
    (whether Twilio reports that case as DialCallStatus=failed is not verified)."""
    form = await twilio_form(request)
    if form is None:
        return FORBIDDEN
    row = store.get_call(call_id)
    own = config.env("TWILIO_FROM_NUMBER")
    if form.get("DialCallStatus") == "failed" and not retry and own and row and row["direction"] == "inbound":
        return Response(inbound_twiml({"id": call_id, "caller": row["to_number"], "forward_to": row["from_number"]},
                                      caller_id=own), media_type="text/xml")
    await calls.inbound_done(call_id, form)
    return xml("")


@api.post("/api/demo-line")
async def demo(request: Request, step: str | None = None, try_: str | None = Query(None, alias="try")):
    """Only our own outbound number may reach the demo rep: anyone else would start a paid bot."""
    form = await twilio_form(request)
    if form is None:
        return FORBIDDEN
    own = config.env("TWILIO_FROM_NUMBER")
    if not own or form.get("From") != own:
        return xml("<Hangup/>")
    return Response(demo_line.twiml(step, try_ == "1"), media_type="text/xml")


# --- WebSockets ---

@api.websocket("/twilio/media/{token}")
async def twilio_media(ws: WebSocket, token: str):
    """Business leg (token = the call's one-use ws_token) or the demo rep (token = a demo ticket)."""
    from pipecat.runner.utils import parse_telephony_websocket

    from . import bot, prompt

    row = store.find_call("ws_token", token) if len(token) >= 32 else None
    demo_rep = row is None and guard.take_ticket(token, "demo_rep")
    if row and row["status"] in ("dialing", "in_progress"):
        store.update_call(row["id"], ws_token=None)  # one use
    elif not demo_rep:
        await ws.close(code=1008)
        return
    await ws.accept()
    try:
        _kind, data = await parse_telephony_websocket(ws)
    except ValueError:
        return
    if demo_rep:
        rep = bot.CallBot(ws, data["stream_id"], data["call_id"], demo_line.rep_prompt(), config.DEMO_REP_VOICE_ID)
        await rep.run(speak_first=True, max_seconds=config.DEMO_REP_MAX_SECONDS)
        return
    call_id = row["id"]
    live = calls.LIVE.get(call_id)
    before = live.moved_from if live else None  # set when a key press moved the call to this new stream
    the_bot = bot.CallBot(ws, data["stream_id"], data["call_id"], prompt.build_prompt(row, calls.get_profile()),
                          config.voice(row["voice"])["reference_id"], call_id=call_id,
                          messages=bot.resume_messages(before.context.get_messages()) if before else None)
    try:
        await calls.stream_started(call_id, the_bot)
        await the_bot.run()
    finally:
        await calls.bot_finished(call_id, the_bot)


@api.websocket("/twilio/owner-media/{call_id}/{token}")
async def twilio_owner_media(ws: WebSocket, call_id: str, token: str):
    await owner_audio.phone_socket(ws, call_id, token)


@api.websocket("/audio/{call_id}")
async def owner_socket(ws: WebSocket, call_id: str):
    await owner_audio.browser_socket(ws, call_id)


# --- static files: voice samples and the web export ---

@api.api_route("/api/{rest:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def api_unknown(rest: str):
    return JSONResponse({"detail": "not found"}, status_code=404)



api.mount("/static/voices", StaticFiles(directory=config.VOICES_DIR, check_dir=False), name="voices")


@api.get("/{path:path}")
async def web(path: str):
    """Files of the web export; any other page path gets index.html (deep links such as /calls/c_123)."""
    root = config.WEB_DIR.resolve()
    target = (root / path).resolve()
    if path and target.is_file() and target.is_relative_to(root):
        cache = "public, max-age=31536000, immutable" if path.startswith("_expo/") else "no-cache"
        return FileResponse(target, headers={"Cache-Control": cache})
    index = root / "index.html"
    if not index.is_file():
        return JSONResponse({"detail": f"console not built: {config.WEB_BUILD_COMMAND}"}, status_code=404)
    return FileResponse(index, headers={"Cache-Control": "no-cache"})


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.mount(config.BASE_PATH, api)


@app.get("/")
async def to_base():
    return Response(status_code=307, headers={"Location": config.BASE_PATH + "/"})


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
