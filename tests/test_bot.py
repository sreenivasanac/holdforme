"""The owner gates, run through Pipecat's own test helper (no services, no network)."""

from pipecat.frames.frames import InterruptionFrame, LLMContextFrame, OutputAudioRawFrame, TextFrame, TTSAudioRawFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.filters.function_filter import FunctionFilter
from pipecat.tests.utils import run_test

from callenvoy.bot import OwnerGate

from .conftest import run


class Gated:
    """Stand-in for CallBot's LLMGate predicate."""
    llm_gate_closed = False

    async def allowed(self, frame):
        return not (self.llm_gate_closed and isinstance(frame, LLMContextFrame))


def test_llm_gate():
    g = Gated()
    g.llm_gate_closed = True
    down, _ = run(run_test(FunctionFilter(g.allowed), frames_to_send=[LLMContextFrame(LLMContext()), TextFrame("x")],
                           expected_down_frames=[TextFrame]))
    g.llm_gate_closed = False
    run(run_test(FunctionFilter(g.allowed), frames_to_send=[LLMContextFrame(LLMContext())],
                 expected_down_frames=[LLMContextFrame]))


def test_owner_gate_closed_drops_interruption_and_tts():
    gate = OwnerGate()
    gate.closed = True
    run(run_test(gate, frames_to_send=[InterruptionFrame(), TTSAudioRawFrame(b"\0" * 320, 8000, 1), TextFrame("x")],
                 expected_down_frames=[TextFrame]))


def test_owner_gate_open_passes():
    run(run_test(OwnerGate(), frames_to_send=[InterruptionFrame(), TextFrame("x")],
                 expected_down_frames=[InterruptionFrame, TextFrame]))


def test_feed_pushes_output_audio():
    gate = OwnerGate()
    pushed = []

    async def capture(frame, direction=None):
        pushed.append(frame)

    gate.push_frame = capture
    run(gate.feed(b"\1\0" * 320, 16000))
    assert isinstance(pushed[0], OutputAudioRawFrame) and pushed[0].sample_rate == 16000
