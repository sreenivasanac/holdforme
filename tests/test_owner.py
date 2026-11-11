"""Owner state machine with a fake clock and a fake bot (no pipeline, no network)."""

import asyncio

from callenvoy import calls, owner, owner_audio, store

from .conftest import CALL, run


class Clock:
    def __init__(self):
        self.t = 0.0
        self.waiters: list[tuple[float, asyncio.Future]] = []

    async def sleep(self, seconds):
        fut = asyncio.get_running_loop().create_future()
        self.waiters.append((self.t + seconds, fut))
        await fut

    async def advance(self, seconds):
        for _ in range(20):  # let new timer tasks start and register first
            await asyncio.sleep(0)
        self.t += seconds
        for due, fut in list(self.waiters):
            if due <= self.t and not fut.done():
                fut.set_result(None)
        self.waiters = [(d, f) for d, f in self.waiters if not f.done()]
        for _ in range(20):
            await asyncio.sleep(0)


class Bot:
    def __init__(self):
        self.told, self.log, self.fed = [], [], []

    async def tell(self, text, run_llm):
        self.told.append(text)

    async def set_tap(self, on):
        self.log.append(("tap", on))

    async def take_over(self, rate, name):
        self.log.append(("take_over", rate))

    async def hand_back(self, note):
        self.log.append(("hand_back", note))

    async def owner_link_changed(self, rate):
        self.log.append(("relink", rate))

    async def feed(self, pcm, rate):
        self.fed.append(pcm)

    async def press(self, digit):
        self.log.append(("press", digit))


class Link:
    def __init__(self, kind="app"):
        self.kind, self.rate, self.closed, self.states, self.audio = kind, 16000 if kind == "app" else 8000, False, [], []

    async def send_audio(self, pcm):
        self.audio.append(pcm)

    async def send_state(self, o, phase):
        self.states.append(o)

    async def close(self, ended=False):
        self.closed = True


def live_call(monkeypatch, **kw):
    clock = Clock()
    monkeypatch.setattr(owner, "_sleep", clock.sleep)
    store.save_profile({"callback_number": "+14155550199"})
    v = run(calls.place_call(calls.PlaceCallInput(**{**CALL, **kw})))
    store.update_call(v["id"], status="in_progress")
    bot = Bot()
    calls.LIVE[v["id"]].bot = bot
    return v["id"], clock, bot


def owner_legs(fake):
    return [c for c in fake.created if "/twilio/owner/" in c["url"]]


def test_app_then_phone_goes_alert_ring_no_answer(monkeypatch, fresh):
    cid, clock, bot = live_call(monkeypatch, mode="transfer")

    async def go():
        await owner.handover(cid)
        assert owner.view(cid)["state"] == "alerting" and owner.view(cid)["alert_until"]
        await clock.advance(19)
        assert owner.view(cid)["state"] == "alerting"
        await clock.advance(1)
        assert owner.view(cid)["state"] == "ringing" and len(owner_legs(fresh)) == 1
        await clock.advance(35)
        v = owner.view(cid)
        assert v["state"] == "none" and v["unreachable"] is True
        assert any("could not be reached" in t for t in bot.told)
        await clock.advance(600)
        assert len(owner_legs(fresh)) == 1  # no second ring after unreachable
    run(go())


def test_app_alone_skips_the_ring(monkeypatch, fresh):
    cid, clock, bot = live_call(monkeypatch, mode="transfer", reach="app")

    async def go():
        await owner.handover(cid)
        await clock.advance(20)
        assert owner.view(cid)["unreachable"] and not owner_legs(fresh)
    run(go())


def test_join_during_alert_and_ring_stops_timers(monkeypatch, fresh):
    cid, clock, bot = live_call(monkeypatch, mode="transfer")

    async def go():
        await owner.handover(cid)
        await owner.attach(cid, Link())  # the console opened the audio during the alert
        await clock.advance(100)
        assert owner.view(cid)["state"] == "listening" and not owner_legs(fresh)
        await owner.join(cid)
        assert owner.view(cid)["state"] == "on_call" and ("take_over", 16000) in bot.log
        assert store.get_call(cid)["phase"] == "owner_on_call"
    run(go())

    cid2, clock2, bot2 = live_call(monkeypatch, mode="transfer", reach="phone")

    async def ring():
        await owner.handover(cid2)
        assert owner.view(cid2)["state"] == "ringing"
        await owner.attach(cid2, Link("phone"))  # pressed 1: join at once
        await clock2.advance(100)
        assert owner.view(cid2) == {"state": "on_call", "via": "phone", "alert_until": None, "unreachable": False}
    store.update_call(cid, status="completed")
    run(ring())


def test_wait_on_hold_cancels_the_alert(monkeypatch, fresh):
    cid, clock, bot = live_call(monkeypatch, mode="transfer")

    async def go():
        await owner.handover(cid)
        await owner.false_alarm(cid)
        assert owner.view(cid)["state"] == "none"
        await clock.advance(100)
        assert not owner_legs(fresh)
        assert store.lines(cid)[-1]["text"] == "false alarm, still on hold"
    run(go())


def test_dropped_link_hands_back_after_grace_only(monkeypatch, fresh):
    cid, clock, bot = live_call(monkeypatch)

    async def go():
        link = Link()
        await owner.attach(cid, link)
        await owner.join(cid)
        await owner.detach(cid, link)
        await clock.advance(4)
        assert owner.view(cid)["state"] == "on_call"
        again = Link()
        await owner.attach(cid, again)  # reconnect within the grace time keeps the call
        await clock.advance(10)
        assert owner.view(cid)["state"] == "on_call" and ("relink", 16000) in bot.log
        await owner.detach(cid, again)
        await clock.advance(5)
        assert owner.view(cid)["state"] == "none"
        assert any(k == "hand_back" and "lost" in note for k, note in bot.log)
    run(go())


def test_new_link_replaces_old_and_mic_only_on_call(monkeypatch, fresh):
    cid, clock, bot = live_call(monkeypatch)

    async def go():
        a, b = Link(), Link()
        await owner.attach(cid, a)
        assert not await owner.mic(cid, a, b"\0" * 640)  # listening: dropped
        await owner.attach(cid, b)
        assert a.closed and owner.OWNERS[cid].link is b
        await owner.join(cid)
        assert not await owner.mic(cid, a, b"\0" * 640)  # old link: dropped
        assert await owner.mic(cid, b, b"\1" * 640) and bot.fed == [b"\1" * 640]
        await owner.hand_back(cid)
        assert owner.view(cid)["state"] == "listening" and not await owner.mic(cid, b, b"\0" * 640)
    run(go())


def test_phone_keys(monkeypatch, fresh):
    cid, clock, bot = live_call(monkeypatch)

    async def go():
        p = Link("phone")
        await owner.attach(cid, p)
        await owner.phone_key(cid, p, "1")
        assert owner.view(cid)["state"] == "on_call"
        await owner.phone_key(cid, p, "5")
        assert ("press", "5") in bot.log
        await owner.phone_key(cid, p, "*")
        assert owner.view(cid)["state"] == "listening"
        await owner.phone_key(cid, p, "1")
        await owner.detach(cid, p)  # hanging up the phone hands back at once
        assert owner.view(cid)["state"] == "none" and any(k == "hand_back" for k, _ in bot.log)
    run(go())


def test_twilio_media_round_trip():
    import array
    import math

    from pipecat.audio.utils import create_stream_resampler

    pcm = array.array("h", (int(8000 * math.sin(i / 5)) for i in range(160))).tobytes()

    async def go():
        payload = await owner_audio.encode_media(pcm, create_stream_resampler())
        back = await owner_audio.decode_media(payload, create_stream_resampler())
        assert len(back) == len(pcm)
        a, b = array.array("h", pcm), array.array("h", back)
        assert max(abs(x - y) for x, y in zip(a, b)) < 400  # mu-law is lossy, but close
    run(go())


def test_rate_gate_drops_faster_than_twice_real_time():
    t = [0.0]
    g = owner_audio.RateGate(32000, clock=lambda: t[0])  # 16 kHz 16-bit
    assert all(g.allow(640) for _ in range(100))  # 1 s of burst (2 x 32000 bytes)
    assert not g.allow(640)
    t[0] += 1
    assert g.allow(640)
