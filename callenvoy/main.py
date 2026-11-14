"""FastAPI app: auth middleware, console API, Twilio webhooks and sockets, MCP endpoint, the web export.

Run: uv run uvicorn callenvoy.main:app --host 127.0.0.1 --port 3020 --no-access-log  (one worker only:
live call state is in memory). Everything lives under BASE_PATH (/callenvoy), which nginx passes through.
"""

import asyncio
import contextlib
import logging
import os
import re
import sys
from typing import Annotated
from urllib.parse import urlparse
from xml.sax.saxutils import escape, quoteattr

import httpx
from fastapi import Depends, FastAPI, Query, Request, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from loguru import logger as loguru_logger
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import BaseModel, Field, StrictBool, StringConstraints
from starlette.requests import HTTPConnection

from . import auth, calls, config, demo_line, guard, mcp_server, owner, owner_audio, push, store, twilio_api

log = logging.getLogger("callenvoy")


def startup_checks() -> None:
    """Refuses a weak CALLENVOY_API_KEY (optional: only imported once as the first key). Outside dev mode
    (CALLENVOY_DEV=1) it also needs an https PUBLIC_BASE_URL, every provider key and the web export.
    Messages name the variable, never its value."""
    if 0 < len(config.env("CALLENVOY_API_KEY").strip()) < config.API_KEY_MIN_LENGTH:
        raise SystemExit(f"CALLENVOY_API_KEY is shorter than {config.API_KEY_MIN_LENGTH} characters")
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
    auth.import_env_key()
    await calls.restart_cleanup()
    async with mcp_server.server.session_manager.run():
        yield


api = FastAPI(title=config.APP_NAME, docs_url=None, redoc_url=None, openapi_url=None)
api.router.routes.extend(_mcp_app.routes)  # POST /mcp, served by the SDK's ASGI handler


PUBLIC_API = {"/api/demo-line", "/api/auth/me", "/api/auth/request", "/api/auth/verify", "/api/auth/sign-out"}
OWNER_ONLY = ("/api/keys", "/api/auth/", "/api/push/")  # a console session only, never an agent key
ADMIN_API = "/api/admin/"  # the admin's console session only; everyone else gets 404
UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


def _noindex(send):
    async def wrapped(message):
        if message["type"] == "http.response.start":
            message = {**message, "headers": [*message.get("headers", []), (b"x-robots-tag", b"noindex")]}
        await send(message)
    return wrapped


class AuthMiddleware:
    """/mcp: agent key. /api/*: agent key (not on OWNER_ONLY routes) or a console session cookie; PUBLIC_API
    needs neither. Both credentials name one user: it goes to the routes as scope["ce_user"] (see `me`) and to
    the MCP tools as auth.CURRENT_USER. /mcp/<key> is rewritten to /mcp. Errors: {"error", "code"}. The
    key-in-path form is never logged (run uvicorn with --no-access-log)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        root = scope.get("root_path", "")
        path = scope["path"][len(root):] if scope["path"].startswith(root) else scope["path"]
        if scope["method"] == "OPTIONS" and path.startswith("/api/"):  # CORS preflight carries no credential
            return await self.app(scope, receive, send)
        conn = HTTPConnection(scope)
        key = None
        if path.startswith("/mcp/"):
            key = path[len("/mcp/"):].rstrip("/")
            scope = {**scope, "path": root + "/mcp", "raw_path": (root + "/mcp").encode()}
            send = _noindex(send)
        elif path == "/mcp" or path.startswith("/api/"):
            key = conn.headers.get("authorization")
        else:
            return await self.app(scope, receive, send)
        user = None
        try:
            if path.startswith("/api/") and key is None:
                # Cookie (or no credential): the browser. Its writes must come from our own page.
                if scope["method"] in UNSAFE and not owner_audio.origin_ok(conn.headers.get("origin")):
                    raise auth.AuthError("bad_origin", "request from a foreign page", 403)
                if path not in PUBLIC_API:
                    cookie = conn.cookies.get(config.SESSION_COOKIE)
                    if not cookie:
                        raise auth.AuthError("no_credential", "sign in, or send Authorization: Bearer <key>")
                    user = auth.session(cookie)
                    if not user:
                        raise auth.AuthError("session_expired", "the session has ended; sign in again")
                    auth.active(user)
                    if path.startswith(ADMIN_API) and not auth.is_admin(user):  # before any body check
                        return await JSONResponse({"detail": "not found"}, status_code=404)(scope, receive, send)
            elif path not in PUBLIC_API:
                user = auth.check_key(key)
                if path.startswith(ADMIN_API):
                    return await JSONResponse({"detail": "not found"}, status_code=404)(scope, receive, send)
                # The audio ticket lets its holder hear and speak on a live call: the owner only.
                if path.startswith(OWNER_ONLY) or path.endswith("/audio-ticket"):
                    raise auth.AuthError("owner_only", "agent keys cannot use this; sign in to the console", 403)
        except auth.AuthError as e:
            return await JSONResponse({"error": str(e), "code": e.code}, status_code=e.status)(scope, receive, send)
        token = auth.CURRENT_USER.set(user)
        try:
            return await self.app({**scope, "ce_user": user}, receive, send)
        finally:
            auth.CURRENT_USER.reset(token)


api.add_middleware(AuthMiddleware)
if config.dev_mode():  # local Expo dev server only; production is same-origin
    api.add_middleware(CORSMiddleware, allow_origins=[config.DEV_ORIGIN], allow_methods=["*"], allow_credentials=True,
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

def me(request: Request) -> dict:
    """The user of the request's key or session (AuthMiddleware). Every route with user data takes it."""
    user = request.scope.get("ce_user")
    if not user:
        raise calls.CallError("sign in", 401)
    return user


def admin(user: Annotated[dict, Depends(me)]) -> dict:
    """The admin's session (an agent key never gets here). Anyone else: 404, as if the route did not exist."""
    if not auth.is_admin(user):
        raise calls.CallError("not found", 404)
    return user


Me = Annotated[dict, Depends(me)]
Admin = Annotated[dict, Depends(admin)]


@api.get("/healthz")
async def healthz():
    return {"ok": True}


@api.get("/api/config")
async def get_config(user: Me):
    return {
        "app_name": config.APP_NAME,
        "mcp_url": config.public_base_url() + "/mcp",
        "voices": mcp_server.voices(),
        # minutes_used_today: the service's minutes (all users: the shared daily cap); my_minutes_today: this user's
        "limits": {"max_call_minutes": config.MAX_CALL_MINUTES, "max_concurrent_calls": config.MAX_CONCURRENT_CALLS,
                   "daily_minute_cap": config.DAILY_MINUTE_CAP, "minutes_used_today": calls.minutes_used_today(),
                   "my_minutes_today": calls.minutes_used_today(user["id"])},
        "defaults": config.SETTING_DEFAULTS,
        "choices": {k: s["choices"] for k, s in config.SETTINGS.items() if s["type"] == "choice"},
        "ranges": {k: [s["min"], s["max"]] for k, s in config.SETTINGS.items() if s["type"] == "int"},
        "text_limits": {k: s["max"] for k, s in config.SETTINGS.items() if s["type"] == "text"},
        "vapid_public_key": config.env("VAPID_PUBLIC_KEY") or None if push.enabled() else None,
        "demo": config.DEMO_CALL,
    }


@api.get("/api/calls")
async def list_calls(user: Me, limit: int = Query(10, ge=1, le=50)):
    return calls.list_calls(user["id"], limit)


@api.post("/api/calls")
async def place_call(user: Me, body: calls.PlaceCallInput):
    return {"id": (await calls.place_call(user["id"], body))["id"]}


@api.get("/api/calls/{call_id}")
async def get_call(user: Me, call_id: str, wait_seconds: int = Query(0, ge=0, le=50), since_line: int = Query(0, ge=0)):
    return await calls.get_call(user["id"], call_id, wait_seconds, since_line)


@api.post("/api/calls/{call_id}/hang-up")
async def hang_up(user: Me, call_id: str):
    return {"ok": True, "message": await calls.hang_up(user["id"], call_id)}


class Answer(BaseModel):
    question_id: calls.QuestionId
    answer: calls.AnswerText


@api.post("/api/calls/{call_id}/answer")
async def answer(user: Me, call_id: str, body: Answer):
    await calls.answer_question(user["id"], call_id, body.question_id, body.answer)
    return {"ok": True, "message": "sent"}


class Connect(BaseModel):
    mode: str = "join"
    reach: str = "phone"
    phone: str | None = Field(None, max_length=40)


@api.post("/api/calls/{call_id}/connect")
async def connect(user: Me, call_id: str, body: Connect):
    return {"ok": True, "message": await owner.connect(user["id"], call_id, body.mode, body.reach, body.phone)}


@api.post("/api/calls/{call_id}/hand-back")
async def hand_back(user: Me, call_id: str):
    return {"ok": True, "message": await owner.hand_back(calls.must(user["id"], call_id)["id"])}


@api.post("/api/calls/{call_id}/audio-ticket")
async def audio_ticket(user: Me, call_id: str):
    """Only for the call's user (and never for an agent key, see AuthMiddleware): the ticket opens its audio."""
    row = calls.must(user["id"], call_id)
    if row["status"] != "in_progress" or call_id not in calls.LIVE:
        raise calls.CallError("the call is not live", 409)
    return {"ticket": guard.issue_ticket(call_id), "expires_in": config.AUDIO_TICKET_SECONDS}


@api.get("/api/profile")
async def get_profile(user: Me):
    return calls.get_profile(user["id"])


@api.put("/api/profile")
async def put_profile(user: Me, request: Request):
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise calls.CallError("send a JSON object of settings")
    return calls.save_profile(user["id"], body)


@api.get("/api/caller-id")
async def caller_id(user: Me):
    return await calls.caller_id(user["id"])


@api.post("/api/caller-id/verify")
async def caller_id_verify(user: Me):
    return {"validation_code": (await calls.verify_number(user["id"]))["validation_code"]}


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
async def push_subscribe(user: Me, body: PushSub):
    if not push.endpoint_ok(body.endpoint):
        raise calls.CallError("this push service is not supported", field="endpoint")
    known = {d["endpoint"] for d in store.push_devices(user["id"])}
    if body.endpoint not in known and len(known) >= config.MAX_PUSH_DEVICES:
        raise calls.CallError(f"at most {config.MAX_PUSH_DEVICES} devices; remove one first", 409)
    store.save_push_device(user["id"], body.endpoint, body.keys.p256dh, body.keys.auth, body.label)
    return {"ok": True}


@api.delete("/api/push/subscriptions")
async def push_unsubscribe(user: Me, body: PushEndpoint):
    store.delete_push_device(user["id"], body.endpoint)
    return {"ok": True}


@api.post("/api/push/test")
async def push_test(user: Me):
    if not push.enabled():
        raise calls.CallError("web push is off: the server has no VAPID keys", 409)
    return {"sent": await push.send(user["id"], push.payload({"business": ""}, "test", False))}


# --- agent keys (console session only, see AuthMiddleware) ---

KeyName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=config.KEY_NAME_MAX)]


class NewKey(BaseModel):
    name: KeyName


class KeyChange(BaseModel):
    name: KeyName | None = None
    disabled: bool | None = None


def _key(user_id: str, key_id: str) -> dict:
    row = store.get_key(user_id, key_id)
    if not row:
        raise calls.CallError("no such key", 404)
    return row


@api.get("/api/keys")
async def list_keys(user: Me):
    return {"keys": [auth.key_view(r) for r in store.keys(user["id"])]}


@api.post("/api/keys", status_code=201)
async def create_key(user: Me, body: NewKey):
    if len(store.keys(user["id"])) >= config.MAX_KEYS:
        raise calls.CallError(f"at most {config.MAX_KEYS} keys; delete one first", 409)
    row, key = auth.create_key(user["id"], body.name)
    view = auth.key_view(row)
    return {k: view[k] for k in ("id", "name", "prefix", "created_at")} | {"key": key}


@api.patch("/api/keys/{key_id}")
async def change_key(user: Me, key_id: str, body: KeyChange):
    _key(user["id"], key_id)
    changes = {k: int(v) if k == "disabled" else v for k, v in body.model_dump(exclude_none=True).items()}
    if changes:
        store.update_key(user["id"], key_id, **changes)
    return auth.key_view(_key(user["id"], key_id))


@api.delete("/api/keys/{key_id}", status_code=204)
async def delete_key(user: Me, key_id: str):
    _key(user["id"], key_id)
    store.delete_key(user["id"], key_id)
    return Response(status_code=204)


# --- sign-in and sign-up (public routes; the session cookie is the only console credential) ---

class SignInRequest(BaseModel):
    email: str = Field(min_length=1, max_length=config.EMAIL_MAX + 20)  # room for white space; email_ok checks


class SignInToken(BaseModel):
    token: str = Field(min_length=1, max_length=200)


def _refused(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"error": message, "code": code}, status_code=status)


def client_ip(request: Request) -> str:
    """nginx appends the address it saw to X-Forwarded-For: only that last entry can be trusted."""
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[-1].strip()
    return forwarded or (request.client.host if request.client else "")


def _may_sign_in(email: str) -> JSONResponse | None:
    """The refusal for a disabled account, or for a new address while sign-ups are off (the admin may always)."""
    user = store.user_by_email(email)
    if user and user["disabled"]:
        return _refused("account_disabled", "this account is disabled", 403)
    if not user and not auth.signups_open() and email != store.admin_email():
        return _refused("signups_closed", "new accounts are closed right now", 403)
    return None


@api.get("/api/auth/me")
async def auth_me(request: Request):
    user = auth.session(request.cookies.get(config.SESSION_COOKIE))
    on = bool(user and not user["disabled"])
    return {"signed_in": on, "email": user["email"] if on else None, "mail_ready": auth.mail_ready(),
            "is_admin": on and auth.is_admin(user), "signups_open": auth.signups_open(),
            "first_run": on and not calls.get_profile(user["id"])["name"]}


@api.post("/api/auth/request")
async def auth_request(body: SignInRequest, request: Request):
    """Mails a one-time link to any valid address (open sign-up). The user is created at the first verify."""
    email = body.email.strip().lower()
    if not auth.email_ok(email):
        return _refused("bad_email", "enter a valid email address", 400)
    if not auth.allow_signin_request(email, client_ip(request)):
        return _refused("rate_limited", "too many sign-in requests; try again later", 429)
    refused = _may_sign_in(email)
    if refused:
        return refused
    if auth.mail_ready():
        auth.mail_signin_link(email)
    return {"ok": True}


@api.post("/api/auth/verify")
async def auth_verify(body: SignInToken):
    email = auth.take_signin_token(body.token)
    if not email:
        return _refused("bad_link", "this sign-in link was used, has expired, or is unknown", 400)
    refused = _may_sign_in(email)
    if refused:
        return refused
    user = store.user_by_email(email) or store.add_user(email)  # the account starts at its first sign-in
    store.user_seen(user["id"])
    r = JSONResponse({"ok": True, "email": user["email"]})
    r.set_cookie(config.SESSION_COOKIE, auth.new_session(user["id"]), max_age=config.SESSION_DAYS * 86400,
                 path=config.BASE_PATH, secure=True, httponly=True, samesite="strict")
    return r


@api.post("/api/auth/sign-out")
async def auth_sign_out(request: Request):
    auth.end_session(request.cookies.get(config.SESSION_COOKIE))
    r = JSONResponse({"ok": True})
    r.delete_cookie(config.SESSION_COOKIE, path=config.BASE_PATH, secure=True, httponly=True, samesite="strict")
    return r


# --- admin: usage only, never call content (admin session only; others get 404) ---

class UserChange(BaseModel):
    disabled: StrictBool


class ServiceSettings(BaseModel):
    signups_open: StrictBool


def _user_view(user: dict, usage: dict, names: dict) -> dict:
    numbers = usage.get(user["id"], {"calls": 0, "minutes": 0, "minutes_today": 0, "live_calls": 0})
    return {"id": user["id"], "email": user["email"], "name": names.get(user["id"]), "created_at": user["created_at"],
            "last_seen_at": user["last_seen_at"], "disabled": bool(user["disabled"]), "is_admin": auth.is_admin(user),
            **numbers}


def _other_user(me: dict, user_id: str) -> dict:
    user = store.get_user(user_id)
    if not user:
        raise calls.CallError("no user with that id", 404)
    if user["id"] == me["id"]:
        raise calls.CallError("you cannot disable or remove your own account")
    return user


@api.get("/api/admin/users")
async def admin_users(_me: Admin):
    usage, names = calls.usage(), store.profile_names()
    return {"signups_open": auth.signups_open(), "users": [_user_view(u, usage, names) for u in store.users()]}


@api.patch("/api/admin/users/{user_id}")
async def admin_change_user(who: Admin, user_id: str, body: UserChange):
    """Disable: keys and sessions answer 401 account_disabled, live calls are hung up. Enable undoes it."""
    _other_user(who, user_id)
    store.set_user_disabled(user_id, body.disabled)
    if body.disabled:
        await calls.stop_user_calls(user_id)
    return _user_view(store.get_user(user_id), calls.usage(), store.profile_names())


@api.delete("/api/admin/users/{user_id}", status_code=204)
async def admin_remove_user(who: Admin, user_id: str):
    """Hangs up the user's live calls, then deletes the user, all their data and their cached recordings."""
    _other_user(who, user_id)
    await calls.stop_user_calls(user_id, drop=True)
    for sid in store.delete_user(user_id):
        if re.fullmatch(r"RE\w{1,64}", sid):
            (config.RECORDINGS_DIR / f"{sid}.mp3").unlink(missing_ok=True)
    return Response(status_code=204)


@api.put("/api/admin/settings")
async def admin_settings(_me: Admin, body: ServiceSettings):
    store.set_service_setting("signups_open", body.signups_open)
    return {"signups_open": body.signups_open}


# --- recordings ---

_fetching: dict[str, asyncio.Lock] = {}


async def recording_file(sid: str):
    """The recording mp3 on disk, fetched from Twilio on first use (a .part file until complete)."""
    path = config.RECORDINGS_DIR / f"{sid}.mp3"
    async with _fetching.setdefault(sid, asyncio.Lock()):
        if not path.is_file():
            config.RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
            config.RECORDINGS_DIR.chmod(0o700)
            part = path.with_suffix(".part")
            try:
                with open(os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as f:
                    async for chunk in twilio_api.fetch_recording(sid):
                        f.write(chunk)
                if not part.stat().st_size:  # never keep an empty file: the next request must try again
                    raise twilio_api.TwilioError("empty recording")
                part.rename(path)
            finally:
                part.unlink(missing_ok=True)
    return path


@api.get("/r/{token}")
async def recording(token: str, download: bool = False):
    """No key: the long random token is the credential. Range requests work (FileResponse), so players can seek.
    ?download=1 makes the browser save the file (the console's Download link)."""
    row = store.find_call("recording_token", token) if len(token) >= 16 else None
    if not row or not row["recording_sid"] or not re.fullmatch(r"RE\w{1,64}", row["recording_sid"]):
        return JSONResponse({"detail": "not found"}, status_code=404)
    try:
        path = await recording_file(row["recording_sid"])
    except (twilio_api.TwilioError, OSError, httpx.HTTPError) as e:
        log.warning("recording fetch failed: %s", type(e).__name__)
        return JSONResponse({"detail": "recording not available"}, status_code=502)
    return FileResponse(path, media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=3600"},
                        filename=f"callenvoy-{row['id']}.mp3" if download else None)


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
    profile = calls.get_profile(row["user_id"])  # the call's user: name, details, callback number
    the_bot = bot.CallBot(ws, data["stream_id"], data["call_id"], prompt.build_prompt(row, profile),
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
