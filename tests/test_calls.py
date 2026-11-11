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


def test_create_call_sends_no_recording_fields_when_off(monkeypatch):
    import httpx

    from callenvoy import twilio_api

    sent = {}

    class Client:
        def __init__(self, **kw): ...
        async def __aenter__(self): return self
        async def __aexit__(self, *a): ...
        async def post(self, url, data):
            sent["data"] = data
            return httpx.Response(201, json={"sid": "CA1"})

    monkeypatch.setattr(twilio_api.httpx, "AsyncClient", Client)
    assert run(REAL_CREATE(to="+14155550123", url="u", status_callback="s", record=False)) == "CA1"
    assert not {k for k, _ in sent["data"]} & {"Record", "RecordingChannels", "RecordingStatusCallback"}
    run(REAL_CREATE(to="+14155550123", url="u", status_callback="s", record=True))
    assert ("RecordingChannels", "dual") in sent["data"] and ("Record", "true") in sent["data"]


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
    calls.inbound_done(fwd["id"], {"DialCallStatus": "no-answer", "DialCallDuration": "0"})
    assert store.get_call(fwd["id"])["status"] == "no_answer"
    view = calls.view(store.get_call(fwd["id"]))
    assert view["direction"] == "inbound" and view["finished"] and view["calling_number"] == "+14155550199"
