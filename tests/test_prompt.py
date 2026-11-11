from callenvoy.prompt import build_prompt

BASE = {"business": "Northstar Internet", "goal": "Fix a double charge on the bill", "mode": "handle",
        "no_answer": "ai_handles", "leave_voicemail": 1, "from_number": "+19186021019"}
PROFILE = {"name": "Alex Rivera", "details": "Account 4411", "callback_number": "+14155550123"}


def test_profile_facts_flexibility_and_no_leak():
    p = build_prompt({**BASE, "facts": "Service address 1 Main St", "flexibility": "a credit up to $40"}, PROFILE)
    assert "Alex Rivera" in p and "Account 4411" in p and "1 Main St" in p and "a credit up to $40" in p
    assert "connect_owner" in p  # only the "insists on speaking" rule
    assert "Hand-over to" not in p
    assert "Menu tips" not in p.lower().replace("phone menu tips", "")  # no tips given, no tips section
    assert "None" not in p


def test_connect_when_and_transfer_add_wait_rules():
    p = build_prompt({**BASE, "connect_when": "if they need to speak to me"}, PROFILE)
    assert "if they need to speak to me" in p and "keep the person company" in p
    t = build_prompt({**BASE, "mode": "transfer"}, PROFILE)
    assert "as soon as a live person picks up" in t and "Do not start to solve the issue" in t


def test_no_answer_choice_changes_fallback():
    a = build_prompt({**BASE, "mode": "transfer"}, PROFILE)
    e = build_prompt({**BASE, "mode": "transfer", "no_answer": "end_politely"}, PROFILE)
    assert "I can help with this" in a and "result not_done" not in a
    assert "result not_done" in e and "I can help with this" not in e


def test_voicemail_rule_on_and_off():
    on = build_prompt(BASE, PROFILE)
    off = build_prompt({**BASE, "leave_voicemail": 0}, PROFILE)
    assert "After the beep leave one message" in on and "918-602-1019" in on
    assert "do not leave a message" in off and "After the beep" not in off


def test_profile_fields_only_for_the_owner():
    profile = {**PROFILE, "date_of_birth": "1990-01-02", "insurance_member_id": "XZ9"}
    mine = build_prompt(BASE, profile)
    assert "1990-01-02" in mine and "XZ9" in mine and "Never read the list out" in mine
    other = build_prompt({**BASE, "on_behalf_of": "Sam Lee"}, profile)
    assert "1990-01-02" not in other and "XZ9" not in other
