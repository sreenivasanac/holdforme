import pytest

from callenvoy import guard


@pytest.mark.parametrize("raw,ok", [
    ("+14155550123", "+14155550123"),
    ("(415) 555-0123", "+14155550123"),
    ("1 415 555 0123", "+14155550123"),
    ("+1 604 555 0123", "+16045550123"),  # Canada
])
def test_valid_numbers(raw, ok):
    assert guard.check_number(raw) == ok


@pytest.mark.parametrize("raw", ["911", "+19005550123", "+19765550123", "+18765550123", "+14150550123",
                                 "+11155550123", "+442071234567", "", "555-0123", "+18095550123"])
def test_refused_numbers(raw):
    with pytest.raises(ValueError):
        guard.check_number(raw)


def test_twilio_signature_known_sample():
    # Sample from twilio-python tests/unit/test_request_validator.py
    url = "https://mycompany.com/myapp.php?foo=1&bar=2"
    params = {"CallSid": "CA1234567890ABCDE", "Digits": "1234", "From": "+14158675309",
              "To": "+18005551212", "Caller": "+14158675309"}
    assert guard.twilio_signature(url, params, "12345") == "RSOYDt4T1cUTdK1PDd93/VVr8B8="
    assert guard.twilio_ok(url, params, "RSOYDt4T1cUTdK1PDd93/VVr8B8=", token="12345")
    assert not guard.twilio_ok(url, {**params, "Digits": "1"}, "RSOYDt4T1cUTdK1PDd93/VVr8B8=", token="12345")
    assert not guard.twilio_ok(url, params, None, token="12345")


def test_tickets_one_use_bound_and_expiring(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(guard, "clock", lambda: now[0])
    t = guard.issue_ticket("c_1", 30)
    assert not guard.take_ticket(t, "c_2")  # wrong call, and the attempt uses it up
    t = guard.issue_ticket("c_1", 30)
    assert guard.take_ticket(t, "c_1")
    assert not guard.take_ticket(t, "c_1")  # used
    t = guard.issue_ticket("c_1", 30)
    now[0] += 31
    assert not guard.take_ticket(t, "c_1")  # expired
    assert not guard.take_ticket("nope", "c_1")
