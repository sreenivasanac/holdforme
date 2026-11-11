"""The private demo line (+16562405137): a phone menu, ~50 s of spoken hold messages, then our own demo rep bot.

TwiML ported from the old app/api/demo-line/route.ts; the hold music file and the Vapi rep are gone.
"""

import secrets
from xml.sax.saxutils import escape, quoteattr

from . import config, guard


def _xml(body: str) -> str:
    return f'<?xml version="1.0" encoding="UTF-8"?><Response>{body}</Response>'


def _say(text: str) -> str:
    return f"<Say voice={quoteattr(config.DEMO_SAY_VOICE)}>{escape(text)}</Say>"


def wss_url(path: str) -> str:
    base = config.public_base_url()
    return ("wss://" + base[len("https://"):] if base.startswith("https://") else "ws://" + base.split("://", 1)[-1]) + path


def stream(path: str, params: dict | None = None) -> str:
    inner = "".join(f"<Parameter name={quoteattr(k)} value={quoteattr(v)}/>" for k, v in (params or {}).items())
    return f"<Connect><Stream url={quoteattr(wss_url(path))}>{inner}</Stream></Connect>"


def twiml(step: str | None, retry: bool) -> str:
    self_url = config.public_base_url() + "/api/demo-line"
    if step == "hold":
        pause = f'<Pause length="{config.DEMO_HOLD_PAUSE_SECONDS}"/>'
        hold = pause.join(_say(t) for t in config.DEMO_HOLD)
        ticket = guard.issue_ticket("demo_rep", config.DEMO_TICKET_SECONDS)
        return _xml(hold + pause + stream(f"/twilio/media/{ticket}", {"role": "demo_rep"}))
    # Phone menu; any key goes to billing. One retry, then billing anyway so the test never stalls.
    action = quoteattr(f"{self_url}?step=hold")
    nxt = escape(f"{self_url}?step=hold" if retry else f"{self_url}?step=menu&try=1")
    return _xml(
        f'<Gather input="dtmf" numDigits="1" timeout="6" action={action} method="POST">'
        + _say(config.DEMO_MENU_RETRY if retry else config.DEMO_MENU)
        + f'</Gather><Redirect method="POST">{nxt}</Redirect>'
    )


def rep_prompt() -> str:
    ref = f"NS-{secrets.randbelow(90000) + 10000}"
    return f"""You are {config.DEMO_REP_NAME}, a friendly billing support agent at {config.DEMO_BUSINESS}, on a phone call.
The caller has just been connected to you from the hold queue. Start by saying: "Thanks for holding, this is {config.DEMO_REP_NAME} in billing. How can I help you today?"
Rules:
- Keep each turn to one or two short sentences, like a real support agent.
- Ask for the account holder's name and the service address or account phone number to look up the account.
- If the caller says they are an assistant calling for someone, that is fine; continue normally.
- Fix the billing issue they describe (for example a double charge or a wrong fee): say you have issued a credit that shows on the next bill.
- Give the reference number {ref}, reading it slowly.
- When the caller says goodbye, say goodbye and call end_call."""


def inbound_twiml() -> str:
    return _xml(_say("This number does not take calls.") + "<Hangup/>")
