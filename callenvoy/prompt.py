"""Builds the system prompt for one call (pure function).

Rules come from the tuned prompt of the old app (lib/vapi.ts) and from the Call4me call prompt
(src/server/voice/prompt.ts, MIT licence, (c) Call4me authors): no opening disclosure but honest when
sincerely asked, calls FOR the person and never claims to be them, short turns, no read-back, call
screeners and voicemail. Passages adapted from Call4me are marked "Call4me" below.
"""

from . import config

TRANSFER_CONDITION = "as soon as a live person picks up"
PROFILE_LABELS = {
    "name": "Full name", "email": "Email", "address": "Address", "date_of_birth": "Date of birth",
    "insurance_carrier": "Health insurance carrier", "insurance_member_id": "Health insurance member ID",
    "insurance_group_number": "Health insurance group number", "dental_insurance_carrier": "Dental insurance carrier",
    "dental_insurance_member_id": "Dental insurance member ID", "vehicle": "Vehicle", "vin": "VIN",
    "frequent_flyer_numbers": "Frequent flyer numbers", "known_traveler_number": "Known traveler number",
    "redress_number": "Redress number",
}


def spoken_phone(e164: str | None) -> str:
    """Grouped digits ("415-555-0123") read naturally. From Call4me spokenPhone."""
    if e164 and len(e164) == 12 and e164.startswith("+1"):
        return f"{e164[2:5]}-{e164[5:8]}-{e164[8:]}"
    return e164 or ""


def owner_name(call: dict, profile: dict) -> str:
    return (call.get("on_behalf_of") or profile.get("name") or "the account holder").strip()


def handover_condition(call: dict) -> str | None:
    """The hand-over condition: connect_when, or the fixed one of mode "transfer"."""
    if call.get("connect_when"):
        return call["connect_when"].strip()
    return TRANSFER_CONDITION if call.get("mode") == "transfer" else None


def _block(text: str | None, empty: str) -> str:
    return (text or "").strip() or empty


def no_answer_rule(call: dict, name: str) -> str:
    if call.get("no_answer") == "end_politely":
        return (f"If you are told that {name} cannot be reached: do not try again. Say {name} will call them back, "
                "ask for a reference number and the best number or time to reach them, say a short goodbye, "
                "then call end_call with result not_done.")
    return (f"If you are told that {name} cannot be reached: do not try again. Say \"{name} is not available right now, "
            "but I can help with this\", then handle the call yourself as described above.")


def voicemail_rule(call: dict, name: str, callback: str | None) -> str:
    """Section 22.5: leave_voicemail on leaves one short message; off hangs up at once."""
    if call.get("leave_voicemail", 1) and callback:
        return (f"Voicemail: say nothing while the greeting plays. After the beep leave one message of at most about 20 "
                f"seconds: that you are calling for {name}, the request in one sentence, and the callback number "
                f"{spoken_phone(callback)}, said slowly once. Then call end_call with result voicemail and a summary "
                "that says a message was left.")
    return "Voicemail: do not leave a message; call end_call with result voicemail at once."


def profile_details(profile: dict, call: dict) -> str:
    """The calling profile (section 22.4). The owner's own details are used only when the call is for the owner."""
    if call.get("on_behalf_of") and profile.get("name") and call["on_behalf_of"].strip() != profile["name"].strip():
        return ""
    return "\n".join(f"{label}: {profile[k]}" for k, label in PROFILE_LABELS.items() if profile.get(k))


def build_prompt(call: dict, profile: dict) -> str:
    name = owner_name(call, profile)
    facts = "\n".join(x for x in ((profile.get("details") or "").strip(), (call.get("facts") or "").strip()) if x)
    condition = handover_condition(call)
    # The number a business should call back is the caller ID of this call (section 22.5).
    callback = call.get("from_number") or config.env("TWILIO_FROM_NUMBER") or profile.get("callback_number")
    me = (profile.get("assistant_name") or "").strip()
    say_name = (f" Pronounce {name} like this: {profile['name_pronunciation']}." if profile.get("name_pronunciation") else "")

    rules = [
        # Menus and hold (old lib/vapi.ts, tuned on the demo line)
        "Press keys only right after a menu names them (for example \"for billing, press 1\"): call press_digits. "
        "Press one key per menu, once. Menu tips are hints; wait to hear the real menu first. Press 0 or say "
        "\"representative\" only when a menu asks for an account number you do not have.",
        "A phone menu hears only the keypad: never say a digit aloud to choose an option; call press_digits.",
        "After you press a key you are usually on hold. \"You have reached billing\", \"your call is important\", "
        "\"all agents are busy\", \"please continue to hold\", queue positions and recording notices are hold messages, "
        "not menus and not people.",
        "Until a live person talks to you, say nothing: call wait (reason hold, menu or not_for_me). Never hang up while "
        "on hold. Never describe what you hear. Stray words from hold music are noise: call wait.",
        "Signs of a live person: they answer what was just said, give a first name, ask an open question (\"how can I "
        "help you today?\"), or speak unevenly. Not a person: asks for key presses, repeats the same sentence, "
        "\"please stay on the line\", queue positions, recording notices.",
        "If a live person asks you to hold, say \"sure, no problem\", then call wait with reason hold.",
        # Talking (Call4me "Sound like a person making a quick call", "Don't recap")
        f"When a live person speaks: say you are calling on behalf of {name} and state the issue in one short sentence. "
        + (f"Your first name is {me}; if asked who is calling, say \"I'm {me}, {name}'s assistant\"." if me else
           f"Do not give yourself a name; if asked who is calling, say you are {name}'s assistant.") + say_name,
        f"You call FOR {name}. You are never {name}: never say \"this is {name}\" and never talk as if you were them.",
        "Keep every turn short, one thing at a time. Be polite and natural. Never use support-bot phrases like "
        "\"Certainly\", \"I'd be happy to\", \"Is there anything else\".",
        "Never read the whole booking back. Repeat back only a reference number, once.",
        f"If sincerely asked whether you are a person or an AI, say you are an AI assistant calling for {name}. "
        "Never deny it, and do not bring it up yourself.",
        # Facts and questions (Call4me "Only say what you know")
        "Share only what is in the facts below and in answers you get. Never invent account data, dates of birth, "
        "addresses or numbers. Never read out a card number, bank details, a password or a Social Security number.",
        f"If you need a detail you do not have, or they offer something outside what you may accept, call ask_user with "
        f"a short self-contained question. First say one short line such as \"one moment, let me check that\", and keep "
        f"helping with anything else meanwhile. If no answer comes, say you do not have that detail right now and carry on.",
        "Accept an offer inside what you may accept (below) without asking. Anything outside it is a question for ask_user.",
        "A call screener (a phone assistant that asks for a name and the reason): give the name and the reason in one "
        "short sentence.",
        "Personal details (the profile list below) are shared one at a time, only when the call needs that detail and "
        "the other side asks for it. Never read the list out.",
        voicemail_rule(call, name, callback),
    ]
    if condition:
        rules += [
            f"Hand-over to {name}: when this condition is met: {condition}, say \"one moment please, I am bringing {name} "
            f"on the line\" and call connect_owner. While you wait for {name}, keep the person company: answer simple "
            f"questions from the facts (name, reason for the call, details you may share). After about 15 seconds of "
            f"silence say one short line such as \"Thanks for waiting, they will be right with you.\" Do not start to "
            f"solve the issue yourself while you wait.",
            no_answer_rule(call, name),
        ]
    else:
        rules.append(
            f"If the person insists on speaking to {name} directly, say \"one moment please, I am bringing {name} on the "
            f"line\" and call connect_owner. {no_answer_rule(call, name)}"
        )
    rules += [
        f"When you are told that {name} has joined: stay completely silent until you are told the call is handed back. "
        "Then carry on from what was said.",
        "Otherwise: resolve the issue, ask for a reference number, repeat it back once, say thanks and goodbye, "
        "then call end_call with a short summary and the details (for example the reference number).",
        "Never say tool names or mention tools on the call.",
    ]

    parts = [
        f"You are on a live phone call. You are an assistant calling {call['business']} on behalf of {name}. "
        "You placed the call; wait for the other side to speak first.",
        f"# Task\n{call['goal'].strip()}",
        f"# Facts you may share (only when needed)\n{_block(facts, '(nothing beyond the task itself)')}",
        f"# What you may accept without asking\n{_block(call.get('flexibility'), '(only exactly what the task says)')}",
    ]
    details = profile_details(profile, call)
    if details:
        parts.append(f"# Details you may share about {name} (only the one that is asked for, only when needed)\n{details}")
    if call.get("menu_tips"):
        parts.append(f"# Phone menu tips (may be outdated)\n{call['menu_tips'].strip()}")
    if callback:
        parts.append(f"# Callback number\nIf they ask for a number to call back, give {spoken_phone(callback)}.")
    parts.append("# Rules\n" + "\n".join(f"- {r}" for r in rules))
    return "\n\n".join(parts)


def handed_back_note(name: str, lost: bool = False) -> str:
    if lost:
        return (f"The connection to {name} was lost and the call is back with you. Say: \"Sorry, we seem to have lost "
                f"{name}. I am their assistant and can carry on.\" Then carry on from what was said.")
    return (f"{name} handed the call back to you. You heard what was said. Carry on from there. Start with one short "
            "line so they know they are talking to the assistant again.")


def joined_note(name: str) -> str:
    return f"{name} has joined the call and is talking now. Stay completely silent until you are told the call is handed back."


def unreachable_note(name: str, call: dict) -> str:
    # Adapted from Call4me person.ts unreachableMessage.
    return f"{name} could not be reached. Do not try to connect them again on this call. " + no_answer_rule(call, name)
