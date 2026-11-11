"""The real owner gates and the bot's tool handlers (no services are contacted, no network)."""

import asyncio
from unittest.mock import MagicMock

import pytest
from pipecat.frames.frames import (
    InterruptionFrame,
    LLMContextFrame,
    OutputAudioRawFrame,
    OutputDTMFFrame,
    TextFrame,
    TTSAudioRawFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection
from pipecat.tests.utils import run_test

from callenvoy import bot, calls, store

from .conftest import CALL, run


def ctx():
    return LLMContextFrame(LLMContext())


@pytest.mark.parametrize("gate_cls", [bot.LLMGate, bot.OwnerGate])
def test_closed_gates_block_the_llm_both_ways(gate_cls):
    g = gate_cls()
    g.closed = True
    run(run_test(g, frames_to_send=[ctx(), TextFrame("x")], expected_down_frames=[TextFrame]))
    g = gate_cls()
    g.closed = True
    run(run_test(g, frames_to_send=[ctx()], frames_to_send_direction=FrameDirection.UPSTREAM,
                 expected_up_frames=[]))
    run(run_test(gate_cls(), frames_to_send=[ctx()], expected_down_frames=[LLMContextFrame]))
    run(run_test(gate_cls(), frames_to_send=[ctx()], frames_to_send_direction=FrameDirection.UPSTREAM,
                 expected_up_frames=[LLMContextFrame]))


def test_owner_gate_closed_drops_bot_audio_keys_and_interruptions():
    gate = bot.OwnerGate()
    gate.closed = True
    run(run_test(gate, frames_to_send=[InterruptionFrame(), TTSAudioRawFrame(b"\0" * 320, 8000, 1),
                                       OutputDTMFFrame.from_string("1"), TextFrame("x")],
                 expected_down_frames=[TextFrame]))
    run(run_test(bot.OwnerGate(), frames_to_send=[InterruptionFrame(), OutputDTMFFrame.from_string("1")],
                 expected_down_frames=[InterruptionFrame, OutputDTMFFrame]))


def test_owner_audio_and_keys_pass_a_closed_gate():
    gate = bot.OwnerGate()
    gate.closed = True
    pushed = []

    async def capture(frame, direction=None):
        pushed.append(frame)

    gate.push_frame = capture
    run(gate.feed(b"\1\0" * 320, 16000))
    run(gate.press("5"))
    assert isinstance(pushed[0], OutputAudioRawFrame) and pushed[0].sample_rate == 16000
    assert isinstance(pushed[1], OutputDTMFFrame) and pushed[1].to_string() == "5"


class Params:
    def __init__(self, **arguments):
        self.arguments = arguments
        self.results = []
        self.llm = MagicMock()

    async def result_callback(self, result, properties=None):
        self.results.append((result, properties))


@pytest.fixture
def make_bot(monkeypatch):
    for k in ("DEEPGRAM_API_KEY", "OPENAI_API_KEY", "FISH_API_KEY"):
        monkeypatch.setenv(k, "test")

    def make(call_id):
        ws = MagicMock()
        ws.headers = {}
        return bot.CallBot(ws, "MZ1", "CA1", "prompt", "voice", call_id=call_id)
    return make


def test_tools_refuse_while_the_owner_has_the_call(make_bot, fresh):
    async def go():
        v = await calls.place_call(calls.PlaceCallInput(**CALL))
        b = make_bot(v["id"])
        calls.LIVE[v["id"]].bot = b
        b._close_gates(True)
        for name, args in (("end_call", {"result": "done", "summary": "s"}), ("press_digits", {"digits": "1"}),
                           ("connect_owner", {})):
            p = Params(**args)
            await getattr(b, f"_tool_{name}")(p)
            assert p.results[0][0] == bot.OWNER_HAS_CALL and p.results[0][1].run_llm is False, name
            assert not p.llm.push_frame.called, name  # no key tone pushed
        await asyncio.sleep(1.2)  # end_call would hang up after about 1 s
        assert store.get_call(v["id"])["outcome_result"] is None and not fresh.updated
    run(go())


def test_ask_user_answer_waits_for_the_hand_back(make_bot):
    async def go():
        v = await calls.place_call(calls.PlaceCallInput(**CALL))
        cid = v["id"]
        b = make_bot(cid)
        calls.LIVE[cid].bot = b
        p = Params(question="What is the address?")
        task = asyncio.create_task(b._tool_ask_user(p))
        await asyncio.sleep(0.01)
        b._close_gates(True)  # the owner takes the call
        q = (await calls.get_call(cid))["open_questions"][0]
        await calls.answer_question(cid, q["id"], "1 Main St")
        await asyncio.sleep(0.05)
        assert p.results == []  # held back while the owner has the call
        b._close_gates(False)  # hand-back
        await asyncio.wait_for(task, 1)
        assert p.results[0][0] == "1 Main St"
    run(go())


def test_demo_rep_hard_limit(make_bot, fresh):
    async def go():
        rep = make_bot(None)
        stopped = []

        async def stop():
            stopped.append(True)

        rep.stop = stop
        await rep._limit(0.01)
        assert fresh.updated == [("CA1", {"hang_up": True})] and stopped
    run(go())
