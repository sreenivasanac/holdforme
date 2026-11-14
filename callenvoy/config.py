"""Every tunable constant of CallEnvoy. User settings (SETTINGS) sit on top of these defaults."""

import os
from pathlib import Path

# --- Branding and paths ---
APP_NAME = "CallEnvoy"
BASE_PATH = "/callenvoy"
TOOL_PREFIX = "callenvoy_"
ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "callenvoy.db"
RECORDINGS_DIR = ROOT / "data" / "recordings"  # mp3 copies fetched once from Twilio (dir 700, files 600)
WEB_DIR = ROOT / "client" / "dist"
VOICES_DIR = Path(__file__).resolve().parent / "static" / "voices"
WEB_BUILD_COMMAND = "pnpm --dir client exec expo export --platform web"
PUBLIC_ORIGIN = "https://pragnyalabs.com"
DEV_ORIGIN = "http://localhost:8081"  # Expo web dev server, allowed only with CALLENVOY_DEV=1

# --- Providers ---
STT_MODEL = "nova-3-general"
LLM_MODEL = "gpt-4.1"
LLM_TEMPERATURE = 0
SUMMARY_MODEL = "gpt-4.1"
TTS_MODEL = "s2.1-pro"
# End of turn: Pipecat's default (LocalSmartTurnAnalyzerV3). TODO: SpeechTimeoutUserTurnStopStrategy if too slow on 2 vCPUs.
CALL_SAMPLE_RATE = 8000

# --- Voices (Fish Audio reference ids, searched 2026-11-10). Indian names are our labels. ---
VOICES = [
    {"name": "Hannah", "gender": "female", "accent": "US", "style": "professional, friendly, clear", "reference_id": "9a9cf47702da476aa4629e2506d4a857"},
    {"name": "Sarah", "gender": "female", "accent": "US", "style": "young, soft, conversational", "reference_id": "933563129e564b19a115bedd57b7406a"},
    {"name": "Laura", "gender": "female", "accent": "US", "style": "warm, calm, deeper", "reference_id": "e3cd384158934cc9a01029cd7d278634"},
    {"name": "Sophia", "gender": "female", "accent": "British", "style": "professional", "reference_id": "0efe38923c0b445ab09382e851ae1e30"},
    {"name": "Ethan", "gender": "male", "accent": "US", "style": "clear, calm, professional", "reference_id": "536d3a5e000945adb7038665781a4aca"},
    {"name": "Adrian", "gender": "male", "accent": "US", "style": "deep, slow, steady", "reference_id": "bf322df2096a46f18c579d0baa36f41d"},
    {"name": "Jordan", "gender": "male", "accent": "US", "style": "older, confident, measured", "reference_id": "79d0bd3e4e5444b18f7b6d89b5927bf1"},
    {"name": "Rohan", "gender": "male", "accent": "Indian English", "style": "professional, measured", "reference_id": "73770ea2927d46c19e461e7e812b2f95"},
    {"name": "Vikram", "gender": "male", "accent": "Indian English", "style": "calm, steady, middle-aged", "reference_id": "ca1c77bf09ee4497ac5cd97c5db1f6d5"},
    {"name": "Meera", "gender": "female", "accent": "Indian English", "style": "friendly, professional, middle-aged", "reference_id": "b1a1d760d9604bdb957a56eec3460f1b"},
]
# Fish Official spares if a listed voice sounds wrong on a phone line: Sheila f3a2b90078d54a65af4b95f63bc7798e,
# Kai 0db6e93af420470b9d9b9a886dbaa954, Cody f663fef9788d4ac0a6bfe36f1b3c871f.
VOICE_NAMES = [v["name"] for v in VOICES]
DEFAULT_VOICE = "Hannah"
DEMO_REP_VOICE_ID = "1f97ab64476c4e468a0888ae22954dab"  # Fish Official "Hugo"
VOICE_SAMPLE_TEXT = "Hi, I'm calling on behalf of Alex about a billing question on the account. Do you have a moment?"
# TODO: own Indian English voices through Fish voice design (API support not verified).

# --- Safety limits (constants only; never changeable through settings or MCP) ---
API_KEY_MIN_LENGTH = 32
DEFAULT_CALL_MINUTES = 30
MAX_CALL_MINUTES = 120
MAX_CONCURRENT_CALLS = 2
DAILY_MINUTE_CAP = 240
HOLD_EXTENSION_MINUTES = 15
TALK_EXTENSION_MINUTES = 2
TALK_RECENT_SECONDS = 120  # "live talk" for the watchdog: either side spoke this recently
BLOCKED_AREA_CODES = {
    "900", "976",  # premium rate
    # NANP members outside the US and Canada (often billed at premium rates)
    "242", "246", "264", "268", "284", "345", "441", "473", "649", "658", "664", "721", "758",
    "767", "784", "809", "829", "849", "868", "869", "876",
}

# --- Call behaviour ---
QUESTION_WAIT_SECONDS = 120
MAX_WAIT_SECONDS = 50  # long-poll ceiling for get_call
HANDOVER_RECENT_SECONDS = 10  # connect_owner needs a "them" line this recent
END_CALL_SPEECH_WAIT_SECONDS = 15  # how long end_call waits for the last sentence to finish
BOT_DONE_GRACE_SECONDS = 30
KEY_PRESS_REJOIN_SECONDS = 20  # after a key press the call must join its new stream in this time
DIAL_TIMEOUT_SECONDS = 90  # no answer and no final status from Twilio in this time: the call is closed as failed
CALLER_ID_CACHE_SECONDS = 60  # GET /api/caller-id caches Twilio's answer this long
OUTCOMES = ("done", "not_done", "voicemail", "no_human")  # after the bot ends, wait this long for Twilio's final status
RECORD_CALLS_DEFAULT = True
FINAL_STATUSES = ("completed", "no_answer", "busy", "failed", "canceled")
LIVE_STATUSES = ("queued", "dialing", "in_progress")
# TODO: make these settings if the owner wants (QUESTION_WAIT_SECONDS, OWNER_DROP_GRACE_SECONDS, audio sizes).

INBOUND_RING_SECONDS = 25  # forwarded callback rings the user this long
# A callback goes to the user who last called that number in this window (else the admin), and is named after
# that user's newest outbound call to it.
INBOUND_BUSINESS_DAYS = 14
# TODO: SMS alerts (needs Twilio A2P 10DLC registration).

# --- Owner audio ---
OWNER_DROP_GRACE_SECONDS = 5
AUDIO_TICKET_SECONDS = 30
AUDIO_FIRST_MESSAGE_SECONDS = 5
OWNER_AUDIO_UP_HZ = 16000
AUDIO_DOWN_BYTES = 640  # 40 ms at 8 kHz, 16-bit
AUDIO_MAX_MESSAGE_BYTES = 4096
AUDIO_MAX_RATE = 2.0  # mic audio faster than this times real time is dropped
OWNER_GATHER_SECONDS = 10  # "Press 1 to join" wait on the owner's phone
OWNER_PROMPT_SECONDS = 15  # margin for answering late and hearing the spoken prompt before the Gather wait
DEMO_TICKET_SECONDS = 120  # the demo line's stream token lives this long
DEMO_REP_MAX_SECONDS = 600  # hard limit for one demo rep call

# --- Agent keys and the owner's sign-in ---
KEY_PREFIX = "ce_live_"
KEY_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"  # no look-alikes (0/o, 1/l/i)
KEY_BODY_LENGTH = 32
KEY_DISPLAY_LENGTH = 12  # the stored, shown prefix
KEY_NAME_MAX = 40
MAX_KEYS = 20
KEY_USE_WRITE_SECONDS = 60  # last_used_at is written at most this often per key
IMPORTED_KEY_NAME = "First key (.env)"
SESSION_COOKIE = "ce_session"
SESSION_DAYS = 30
SIGNIN_TOKEN_MINUTES = 15
# Sign-in link requests (POST /api/auth/request), in memory: (limit, window seconds) per address, per client IP,
# and for all requests together.
SIGNIN_LIMIT_PER_ADDRESS = (3, 3600)
SIGNIN_LIMIT_PER_IP = (10, 3600)
SIGNIN_LIMIT_GLOBAL = (60, 86400)
EMAIL_MAX = 254
SIGNUPS_OPEN_DEFAULT = True  # the admin's "New sign-ups" switch (stored in the database once changed)
USER_SEEN_WRITE_SECONDS = 60  # users.last_seen_at is written at most this often
# Profile key (not a setting) with the callback number this user asked Twilio to verify. Twilio's verified
# caller IDs are shared by the whole account, so "from own" also needs this claim: no user can call from a
# number that another user verified.
CALLER_ID_CLAIM = "verified_caller_id"
CALLER_ID_CLAIM_AT = "verified_caller_id_at"  # when that verification started
CALLER_ID_CLAIM_SECONDS = 600  # another user cannot start a verification of the same number in this time
SMTP_PORT = 587  # STARTTLS
SMTP_TIMEOUT_SECONDS = 20

# --- Web push ---
PUSH_TTL_SECONDS = 60
PUSH_HOSTS = ("fcm.googleapis.com", ".push.apple.com", "updates.push.services.mozilla.com", ".notify.windows.com")
MAX_PUSH_DEVICES = 10

# --- User settings (section 4a): one list, defaults here, saved values in the profile table ---
SETTINGS: dict[str, dict] = {
    "name": {"type": "text", "max": 80, "default": None},
    "callback_number": {"type": "phone", "default": None},
    "details": {"type": "text", "max": 3000, "default": None},
    "caller_id": {"type": "choice", "choices": ["callenvoy", "own"], "default": "callenvoy"},
    "leave_voicemail": {"type": "bool", "default": True},
    "voice": {"type": "choice", "choices": VOICE_NAMES, "default": DEFAULT_VOICE},
    "record_calls": {"type": "bool", "default": RECORD_CALLS_DEFAULT},
    "max_minutes": {"type": "int", "min": 1, "max": MAX_CALL_MINUTES, "default": DEFAULT_CALL_MINUTES},
    "mode": {"type": "choice", "choices": ["handle", "transfer"], "default": "handle"},
    "reach": {"type": "choice", "choices": ["app", "phone", "app_then_phone"], "default": "app_then_phone"},
    "alert_wait_seconds": {"type": "int", "min": 5, "max": 120, "default": 20},
    "phone_ring_seconds": {"type": "int", "min": 10, "max": 60, "default": 25},
    "no_answer": {"type": "choice", "choices": ["ai_handles", "end_politely"], "default": "ai_handles"},
    "alert_on_human": {"type": "bool", "default": True},
    "listen_in": {"type": "bool", "default": False},
    "alert_sound": {"type": "bool", "default": True},
    "alert_notification": {"type": "bool", "default": True},
    "alert_push": {"type": "bool", "default": True},
    "push_shows_business": {"type": "bool", "default": True},
}
# Calling profile fields (section 22.4): optional text the AI may share only when the call needs it.
PROFILE_FIELDS = {
    "name_pronunciation": 80, "assistant_name": 30, "email": 120, "address": 300, "date_of_birth": 40,
    "insurance_carrier": 80, "insurance_member_id": 60, "insurance_group_number": 60,
    "dental_insurance_carrier": 80, "dental_insurance_member_id": 60,
    "vehicle": 120, "vin": 40, "frequent_flyer_numbers": 300, "known_traveler_number": 40, "redress_number": 40,
}
SETTINGS.update({k: {"type": "text", "max": n, "default": None} for k, n in PROFILE_FIELDS.items()})
SETTING_DEFAULTS = {k: v["default"] for k, v in SETTINGS.items()}

# --- Demo line (private test line; Twilio <Say> voice) ---
DEMO_SAY_VOICE = "Polly.Joanna"
DEMO_MENU = "Thank you for calling Northstar Internet. This is a demo line. For billing, press 1. For technical support, press 2. For all other questions, press 0."
DEMO_MENU_RETRY = "Sorry, I didn't get that. For billing, press 1. For technical support, press 2."
DEMO_HOLD = [  # about 50 s of spoken hold messages with pauses between them
    "You have reached billing. Your call is important to us. All of our agents are currently helping other customers. The estimated wait time is less than one minute.",
    "Thank you for holding. This call may be recorded for quality and training purposes. Please continue to hold, and the next available agent will be with you shortly.",
    "Your call is important to us. Please stay on the line.",
]
DEMO_HOLD_PAUSE_SECONDS = 10
DEMO_REP_NAME = "Maria"
DEMO_BUSINESS = "Northstar Internet"
DEMO_LINE_NUMBER = "+16562405137"  # answers only TWILIO_FROM_NUMBER, so calls to it always use that caller ID
DEMO_CALL = {  # GET /api/config "demo": pre-fills a first call to the demo line (the console's welcome step)
    "number": DEMO_LINE_NUMBER, "business": DEMO_BUSINESS,
    "goal": "Ask billing to remove a wrong charge of 30 dollars on the October bill and get a reference number.",
    "facts": "Service address: 12 Oak Street, Springfield.", "menu_tips": "Billing is option 1.",
}


REQUIRED_ENV = ("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "DEEPGRAM_API_KEY",
                "OPENAI_API_KEY", "FISH_API_KEY")


def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default)


def dev_mode() -> bool:
    return env("CALLENVOY_DEV") == "1"


def public_base_url() -> str:
    """PUBLIC_BASE_URL includes the base path, e.g. https://pragnyalabs.com/callenvoy."""
    return env("PUBLIC_BASE_URL", f"http://localhost:3020{BASE_PATH}").rstrip("/")


def voice(name: str | None) -> dict:
    return next((v for v in VOICES if v["name"] == name), next(v for v in VOICES if v["name"] == DEFAULT_VOICE))
