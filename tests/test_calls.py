import asyncio

import pytest

from callenvoy import calls, config, store

from .conftest import CALL, run


def place(**kw):
    return run(calls.place_call(calls.PlaceCallInput(**{**CALL, **kw})))


def end_all():
    for r in store.live_calls():
        store.update_call(r["id"], status="completed", talk_seconds=0)


def test_recording_order_and_no_record_params(fresh):
    place()
    assert fresh.created[-1]["record"] is True  # constant default
    store.save_profile({"record_calls": False})
    end_all()
    v = place()
    assert fresh.created[-1]["record"] is False and v["recorded"] is False
    end_all()
    place(record=True)  # the call value wins over the setting
    assert fresh.created[-1]["record"] is True


from callenvoy.twilio_api import create_call as REAL_CREATE  # noqa: E402  (taken before the fixture fakes it)


def test_create_call_sends_a_real_form_body(monkeypatch):
    """Goes through httpx itself: a list passed as `data=` is not form-encoded and fails in an AsyncClient."""
    from functools import partial
    from urllib.parse import parse_qs

    import httpx

    from callenvoy import twilio_api

    sent = {}

    def handler(request: httpx.Request) -> httpx.Response:
        sent["type"] = request.headers["content-type"]
        sent["form"] = parse_qs(request.content.decode())
        return httpx.Response(201, json={"sid": "CA1"})

    monkeypatch.setattr(twilio_api.httpx, "AsyncClient", partial(httpx.AsyncClient, transport=httpx.MockTransport(handler)))
    assert run(REAL_CREATE(to="+14155550123", url="u", status_callback="s", record=False)) == "CA1"
    assert sent["type"] == "application/x-www-form-urlencoded" and sent["form"]["To"] == ["+14155550123"]
    assert sent["form"]["StatusCallbackEvent"] == ["initiated", "ringing", "answered", "completed"]
    assert not set(sent["form"]) & {"Record", "RecordingChannels", "RecordingStatusCallback"}
    run(REAL_CREATE(to="+14155550123", url="u", status_callback="s", record=True))
    assert sent["form"]["RecordingChannels"] == ["dual"] and sent["form"]["Record"] == ["true"]


def test_settings_order_and_bad_values():
    store.save_profile({"mode": "transfer", "voice": "Rohan", "callback_number": "+14155550199"})
    v = place()
    row = store.get_call(v["id"])
    assert row["mode"] == "transfer" and row["voice"] == "Rohan" and row["alert_wait_seconds"] == 20
    v = place(mode="handle", voice="Ethan", alert_wait_seconds=60)
    row = store.get_call(v["id"])
    assert row["mode"] == "handle" and row["voice"] == "Ethan" and row["alert_wait_seconds"] == 60
    with pytest.raises(calls.CallError, match="handle, transfer"):
        calls.save_profile({"mode": "nope"})
    with pytest.raises(calls.CallError, match="1 to 120"):
        calls.save_profile({"max_minutes": 500})
    with pytest.raises(Exception):
        calls.PlaceCallInput(**CALL, voice="Nobody")


def test_save_profile_round_trips_every_setting():
    values = {"name": "Alex", "callback_number": "(415) 555-0199", "details": "d", "caller_id": "own",
              "leave_voicemail": False, "voice": "Meera", "record_calls": False, "max_minutes": 10, "mode": "transfer",
              "reach": "phone", "alert_wait_seconds": 30, "phone_ring_seconds": 40, "no_answer": "end_politely",
              "alert_on_human": False, "listen_in": True, "alert_sound": False, "alert_notification": False,
              "alert_push": False, "push_shows_business": False}
    values.update({k: "x" for k in config.PROFILE_FIELDS})
    assert set(values) == set(config.SETTINGS)
    p = calls.save_profile(values)
    assert p == {**values, "callback_number": "+14155550199"}
    p = calls.save_profile({"name": "", "vin": ""})  # empty string removes a text field
    assert p["name"] is None and p["vin"] is None


def test_profile_field_limits():
    with pytest.raises(calls.CallError, match="longer than 30"):
        calls.save_profile({"assistant_name": "x" * 31})
    with pytest.raises(calls.CallError, match="callback_number"):
        calls.save_profile({"callback_number": "12345"})


def test_phone_reach_without_callback_number_refused():
    with pytest.raises(calls.CallError) as e:
        place(mode="transfer", reach="phone")
    assert e.value.field == "reach"
    place(mode="transfer", reach="app_then_phone")  # accepted; the phone step is skipped


def test_from_own_refused_until_verified(fresh):
    store.save_profile({"callback_number": "+14155550199"})
    with pytest.raises(calls.CallError, match="verif") as e:
        place(**{"from": "own"})
    assert e.value.field == "from"
    fresh.verified.add("+14155550199")
    v = place(**{"from": "own"})
    assert v["calling_number"] == "+14155550199" and fresh.created[-1]["from_number"] == "+14155550199"


def test_limits_refuse_third_call_and_over_cap():
    place()
    place()
    with pytest.raises(calls.CallError, match="already running") as e:
        place()
    assert e.value.status == 429
    for r in store.live_calls():
        store.update_call(r["id"], status="completed", talk_seconds=config.DAILY_MINUTE_CAP * 60)
    with pytest.raises(calls.CallError, match="limit"):
        place()


def test_watchdog_rules():
    m = 60
    start, planned = 0.0, 30 * m
    assert calls.next_deadline(planned, planned, start, "on_hold", 0) == planned + 15 * m
    assert calls.next_deadline(planned, planned, start, "talking", planned - 30) == planned + 2 * m
    assert calls.next_deadline(planned, planned, start, "talking", planned - 600) is None
    assert calls.next_deadline(planned, planned, start, "menu", 0) is None
    ceiling = config.MAX_CALL_MINUTES * m
    assert calls.next_deadline(ceiling - 60, ceiling - 60, start, "on_hold", 0) == ceiling  # capped
    assert calls.next_deadline(ceiling, ceiling, start, "on_hold", 0) is None  # never past the ceiling


def test_long_poll_returns_early_on_new_line_and_on_timeout():
    async def go():
        v = await calls.place_call(calls.PlaceCallInput(**CALL))
        cid = v["id"]
        loop = asyncio.get_running_loop()
        loop.call_later(0.05, store.add_line, cid, "them", "hello")
        t0 = loop.time()
        got = await calls.get_call(cid, wait_seconds=5)
        assert loop.time() - t0 < 2 and got["transcript"][-1]["text"] == "hello"
        t0 = loop.time()
        got = await calls.get_call(cid, wait_seconds=1, since_line=got["next_line"])
        assert 0.9 < loop.time() - t0 < 2 and got["transcript"] == []
    run(go())


def test_answer_question_round_trip_and_finished_call():
    async def go():
        v = await calls.place_call(calls.PlaceCallInput(**CALL))
        cid = v["id"]
        waiter = asyncio.create_task(calls.ask(cid, "What is the address?"))
        await asyncio.sleep(0.01)
        q = (await calls.get_call(cid))["open_questions"][0]
        await calls.answer_question(cid, q["id"], "1 Main St")
        assert await waiter == "1 Main St"
        store.update_call(cid, status="completed")
        qid = store.add_question(cid, "late?")
        with pytest.raises(calls.CallError, match="ended"):
            await calls.answer_question(cid, qid, "x")
    run(go())


def test_inbound_row_and_business_name():
    v = place(business="Dr. Chen's office", to="+14155550123")
    store.update_call(v["id"], status="completed")
    assert calls.inbound({"From": "+14155550123", "CallSid": "CAin"}) is None  # no callback number
    store.save_profile({"callback_number": "+14155550199"})
    fwd = calls.inbound({"From": "+14155550123", "CallSid": "CAin"})
    row = store.get_call(fwd["id"])
    assert row["direction"] == "inbound" and row["business"] == "Dr. Chen's office" and not row["record"]
    assert calls.inbound({"From": "+16175550100"})["forward_to"] == "+14155550199"
    run(calls.inbound_done(fwd["id"], {"DialCallStatus": "no-answer", "DialCallDuration": "0"}))
    assert store.get_call(fwd["id"])["status"] == "no_answer"
    view = calls.view(store.get_call(fwd["id"]))
    assert view["direction"] == "inbound" and view["finished"] and view["calling_number"] == "+14155550199"


def test_final_status_with_a_recording_id_ends_the_call(fresh):
    """Twilio adds RecordingSid to the "completed" status of a recorded call; it is not a recording callback."""
    cid = place()["id"]
    run(calls.on_status(cid, {"CallStatus": "completed", "CallDuration": "42", "RecordingSid": "RE1"}))
    row = store.get_call(cid)
    assert row["status"] == "completed" and row["talk_seconds"] == 42 and not row["recording_sid"]
    run(calls.on_status(cid, {"RecordingSid": "RE1", "RecordingStatus": "completed", "RecordingDuration": "40"}))
    assert store.get_call(cid)["recording_sid"] == "RE1"


def test_late_dialing_does_not_overwrite_a_final_status(fresh, monkeypatch):
    """Fix 3a: Twilio's final status can arrive before create_call returns."""
    from callenvoy import twilio_api

    real = twilio_api.create_call

    async def fast_fail(**kw):
        sid = await real(**kw)
        cid = kw["url"].rsplit("/", 1)[1]
        await calls.on_status(cid, {"CallStatus": "busy", "CallSid": sid})
        return sid

    monkeypatch.setattr(twilio_api, "create_call", fast_fail)
    v = place()
    assert v["status"] == "busy" and v["finished"]


def test_stuck_dialing_call_is_closed(fresh, monkeypatch):
    """Fix 3b: no answer and no final status within DIAL_TIMEOUT_SECONDS: failed, hung up, slot freed."""
    monkeypatch.setattr(config, "DIAL_TIMEOUT_SECONDS", 0.05)

    async def go():
        v = await calls.place_call(calls.PlaceCallInput(**CALL))
        await asyncio.sleep(0.2)
        row = store.get_call(v["id"])
        assert row["status"] == "failed" and "no status from Twilio" in row["error"]
        assert (row["twilio_sid"], {"hang_up": True}) in fresh.updated
        assert v["id"] not in calls.LIVE and not store.live_calls()
        v2 = await calls.place_call(calls.PlaceCallInput(**CALL))
        store.update_call(v2["id"], status="in_progress")  # answered: the timeout leaves it alone
        await asyncio.sleep(0.2)
        assert store.get_call(v2["id"])["status"] == "in_progress"
    run(go())


def test_inbound_get_call_waits_until_the_forward_ends():
    """Contract 8: a forwarded call is live until the <Dial> action callback."""
    store.save_profile({"callback_number": "+14155550199"})

    async def go():
        fwd = calls.inbound({"From": "+14155550123", "CallSid": "CAin"})
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        got = await calls.get_call(fwd["id"], wait_seconds=1)
        assert loop.time() - t0 > 0.9 and not got["finished"]
        loop.call_later(0.05, lambda: asyncio.ensure_future(
            calls.inbound_done(fwd["id"], {"DialCallStatus": "completed", "DialCallDuration": "30"})))
        t0 = loop.time()
        got = await calls.get_call(fwd["id"], wait_seconds=5)
        assert loop.time() - t0 < 2 and got["finished"] and got["talk_seconds"] == 30
    run(go())


def test_caller_id_cache(fresh, monkeypatch):
    """Fix 14: Twilio is asked once per CALLER_ID_CACHE_SECONDS; a verify request clears the cache."""
    store.save_profile({"callback_number": "+14155550199"})
    asked = []
    real = fresh.caller_id_verified

    async def counting(number):
        asked.append(number)
        return await real(number)

    from callenvoy import twilio_api

    monkeypatch.setattr(twilio_api, "caller_id_verified", counting)
    calls._caller_id_cache.clear()
    assert run(calls.caller_id()) == {"number": "+14155550199", "verified": False}
    fresh.verified.add("+14155550199")
    assert run(calls.caller_id())["verified"] is False and len(asked) == 1  # cached
    run(calls.verify_number())  # clears the cache (and sees it is verified now)
    assert run(calls.caller_id())["verified"] is True


class StubBot:
    """Stands in for bot.CallBot in the key press tests."""
    def __init__(self):
        self.moved, self.summaries, self.tap = True, 0, False

    async def summary_if_missing(self):
        self.summaries += 1

    async def set_tap(self, on):
        self.tap = on


def test_key_press_moves_the_call_to_a_new_stream(fresh):
    """Twilio plays real digits, then the call joins a new stream with a new one-use token and the next bot."""
    async def go():
        cid = (await calls.place_call(calls.PlaceCallInput(**CALL)))["id"]
        old, new = StubBot(), StubBot()
        await calls.stream_started(cid, old)
        await calls.press_keys(cid, "1w2", old)
        token = store.get_call(cid)["ws_token"]
        _sid, kw = fresh.updated[-1]
        assert '<Play digits="1w2"/><Connect><Stream url=' in kw["twiml"] and token in kw["twiml"]
        await calls.bot_finished(cid, old)  # the old stream closed: the call is still live, with no bot
        assert calls.LIVE[cid].bot is None and not calls.is_final(store.get_call(cid))
        await calls.stream_started(cid, new)
        await asyncio.sleep(0.6)  # the wait for the new stream sees it and stops
        assert calls.LIVE[cid].bot is new and old.summaries == 0 and len(calls.LIVE[cid].tasks) >= 1
        await calls.finish(cid)
    run(go())


def test_key_press_then_no_new_stream_closes_the_call(fresh):
    async def go():
        cid = (await calls.place_call(calls.PlaceCallInput(**CALL)))["id"]
        old = StubBot()
        await calls.stream_started(cid, old)
        await calls.press_keys(cid, "1", old)
        await calls.bot_finished(cid, old)
        await calls.on_status(cid, {"CallStatus": "completed", "CallDuration": "9"})  # the business hung up
        assert cid in calls.LIVE  # kept until the summary is written
        await asyncio.sleep(0.7)
        assert old.summaries == 1 and cid not in calls.LIVE and store.get_call(cid)["ws_token"] is None
    run(go())
