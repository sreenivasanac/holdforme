"""The Pipecat voice bot on one Twilio call: pipeline, the bot's tools, the owner gates and the audio tap.

Pipeline (plan section 7): transport.input -> Deepgram STT -> user aggregator -> LLMGate -> OpenAI LLM
-> Fish TTS -> OwnerGate -> transport.output -> AudioBufferProcessor (tap) -> assistant aggregator.
Written against pipecat-ai 1.15.0 (PipelineTask / PipelineRunner are deprecated aliases there; the
PipelineWorker / WorkerRunner names are used).

While the owner has the call the AI must not act: LLMGate drops context frames going down (new user turns),
OwnerGate drops context frames going up (function results from the assistant aggregator travel upstream),
the bot's key tones, its late speech and interruptions; the tools that act on the line refuse.
"""

import asyncio
import json
import logging
import re
import time

from openai import AsyncOpenAI
from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    FunctionCallResultProperties,
    InputAudioRawFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMMessagesAppendFrame,
    LLMRunFrame,
    OutputAudioRawFrame,
    OutputDTMFFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.fish.tts import FishAudioTTSService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.workers.runner import WorkerRunner

from . import calls, config, owner, prompt, store, twilio_api

log = logging.getLogger("callenvoy.bot")
DIGITS = re.compile(r"^[0-9*#w]{1,20}$")
NO_LLM = FunctionCallResultProperties(run_llm=False)


class LLMGate(FrameProcessor):
    """Before the LLM: while closed, drops LLMContextFrame (in both directions), so the LLM does not run.
    The other side's words still reach the transcript and the context."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.closed = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if not (self.closed and isinstance(frame, LLMContextFrame)):
            await self.push_frame(frame, direction)


class OwnerGate(LLMGate):
    """Before transport.output. While closed it also drops the AI's late speech, its key tones and
    InterruptionFrame (the other side starting to talk must not cut the owner's audio), and the upstream
    LLMContextFrame of a function result. feed() and press() push the owner's audio and keys past the gate."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.bot_speaking = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        if isinstance(frame, BotStartedSpeakingFrame):
            self.bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self.bot_speaking = False
        if self.closed and isinstance(frame, (InterruptionFrame, TTSAudioRawFrame, OutputDTMFFrame)):
            await FrameProcessor.process_frame(self, frame, direction)
            return
        await super().process_frame(frame, direction)

    async def feed(self, pcm: bytes, sample_rate: int) -> None:
        await self.push_frame(OutputAudioRawFrame(audio=pcm, sample_rate=sample_rate, num_channels=1))

    async def press(self, digits: str) -> None:
        await self.push_frame(OutputDTMFFrame.from_string(digits))

    async def cut(self) -> None:
        """Cuts the bot's current speech: one InterruptionFrame both ways (stops LLM/TTS, empties the output queue)."""
        await self.broadcast_frame(InterruptionFrame)


class LineSink(FrameProcessor):
    """End of the owner's speech-to-text pipeline: hands final transcriptions to a callback."""

    def __init__(self, on_text, **kwargs):
        super().__init__(**kwargs)
        self._on_text = on_text

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            await self._on_text(frame.text.strip())
        await self.push_frame(frame, direction)


def _tool(name: str, description: str, properties: dict | None = None, required: list | None = None) -> FunctionSchema:
    return FunctionSchema(name=name, description=description, properties=properties or {}, required=required or [])


TOOLS = {
    "press_digits": _tool(
        "press_digits", "Press keys on the phone keypad, right after a menu names them. 'w' waits half a second.",
        {"digits": {"type": "string", "description": 'keys to press, e.g. "1" or "104#"'}}, ["digits"]),
    "wait": _tool(
        "wait", "Stay silent: a phone menu is still talking, you are on hold, or the speech is not meant for you.",
        {"reason": {"type": "string", "enum": ["menu", "hold", "not_for_me"]}}, ["reason"]),
    "ask_user": _tool(
        "ask_user", "Ask the person you call for a question you need answered (a detail you lack, or an offer outside "
        "what you may accept). Returns their answer, or tells you none came in time.",
        {"question": {"type": "string", "description": "short, self-contained question"}}, ["question"]),
    "connect_owner": _tool(
        "connect_owner", "Bring the person you call for onto the line. Say your one line first. If the result says "
        "they cannot be reached, do not call this again."),
    "end_call": _tool(
        "end_call", "Hang up, after the goodbye or after a voicemail.",
        {"result": {"type": "string", "enum": list(config.OUTCOMES)},
         "summary": {"type": "string", "description": "one or two sentences: what happened"},
         "details": {"type": "object", "description": "facts to keep, e.g. {\"reference_number\": \"NS-1234\"}"}},
        ["result", "summary"]),
}
OWNER_HAS_CALL = "The person you call for has the call now. Do nothing and stay silent until you are told it is handed back."


def save_outcome(call_id: str, result, summary, details=None) -> None:
    store.update_call(call_id, outcome_result=result if result in config.OUTCOMES else "not_done",
                      outcome_summary=str(summary or "")[:1000], outcome_details=json.dumps(details or {}))


class CallBot:
    """One pipeline for one phone leg. With call_id None it is the demo rep (no call row, only end_call)."""

    def __init__(self, websocket, stream_sid: str, twilio_call_sid: str, system_prompt: str, voice_id: str,
                 call_id: str | None = None):
        self.call_id = call_id
        self.twilio_call_sid = twilio_call_sid
        self.owner_name = "the account holder"
        self.released = asyncio.Event()  # set while the AI has the call (not the owner)
        self.released.set()
        self.owner_stt: PipelineWorker | None = None
        self.owner_runner: asyncio.Task | None = None
        serializer = TwilioFrameSerializer(
            stream_sid, twilio_call_sid, config.env("TWILIO_ACCOUNT_SID"), config.env("TWILIO_AUTH_TOKEN"),
            params=TwilioFrameSerializer.InputParams(auto_hang_up=False))
        # allowed_origins=[]: Twilio sends no Origin; the one-use ws_token already guards this socket.
        self.transport = FastAPIWebsocketTransport(websocket, FastAPIWebsocketParams(
            audio_in_enabled=True, audio_out_enabled=True, add_wav_header=False, serializer=serializer,
            allowed_origins=[]))
        stt = DeepgramSTTService(api_key=config.env("DEEPGRAM_API_KEY"),
                                 settings=DeepgramSTTService.Settings(model=config.STT_MODEL))
        self.llm = OpenAILLMService(api_key=config.env("OPENAI_API_KEY"), settings=OpenAILLMService.Settings(
            model=config.LLM_MODEL, temperature=config.LLM_TEMPERATURE))
        tts = FishAudioTTSService(api_key=config.env("FISH_API_KEY"), settings=FishAudioTTSService.Settings(
            model=config.TTS_MODEL, voice=voice_id))
        names = list(TOOLS) if call_id else ["end_call"]
        self.context = LLMContext(messages=[{"role": "system", "content": system_prompt}],
                                  tools=ToolsSchema(standard_tools=[TOOLS[n] for n in names]))
        self.aggs = LLMContextAggregatorPair(self.context, user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer()))
        self.llm_gate = LLMGate()
        self.gate = OwnerGate()
        self.tap = AudioBufferProcessor(sample_rate=config.CALL_SAMPLE_RATE, buffer_size=config.AUDIO_DOWN_BYTES)
        self.task = PipelineWorker(
            Pipeline([self.transport.input(), stt, self.aggs.user(), self.llm_gate, self.llm, tts, self.gate,
                      self.transport.output(), self.tap, self.aggs.assistant()]),
            params=PipelineParams(audio_in_sample_rate=config.CALL_SAMPLE_RATE,
                                  audio_out_sample_rate=config.CALL_SAMPLE_RATE),
            idle_timeout_secs=None,  # the default 300 s would kill every long hold; our watchdog replaces it
            enable_rtvi=False)

        for n in names:
            # ask_user is async (the talk goes on) and has no Pipecat timeout: it waits QUESTION_WAIT_SECONDS for
            # an answer, then for the hand-back if the owner has the call.
            self.llm.register_function(n, getattr(self, f"_tool_{n}"), cancel_on_interruption=n != "ask_user")

        @self.aggs.user().event_handler("on_user_turn_stopped")
        async def _them(_agg, _strategy, message):
            await self._line("them", getattr(message, "content", None))

        @self.aggs.assistant().event_handler("on_assistant_turn_stopped")
        async def _ai(_agg, message):
            await self._line("ai", getattr(message, "content", None))

        @self.tap.event_handler("on_track_audio_data")
        async def _tap(_proc, them, played, _rate, _channels):
            if self.call_id:
                await owner.tap(self.call_id, them, played)

        @self.transport.event_handler("on_client_disconnected")
        async def _gone(_transport, _ws):
            await self.task.cancel()

    @property
    def owner_has_call(self) -> bool:
        return not self.released.is_set()

    # --- run / stop ---

    async def run(self, speak_first: bool = False, max_seconds: float | None = None) -> None:
        """Runs until the call ends. max_seconds is a hard limit (the demo rep has no call row or watchdog)."""
        if speak_first:  # the demo rep greets; the caller bot waits for the other side
            await self.task.queue_frame(LLMRunFrame())
        limit = asyncio.create_task(self._limit(max_seconds)) if max_seconds else None
        try:
            await WorkerRunner(handle_sigint=False).run(self.task)
        finally:
            if limit:
                limit.cancel()
            await self._stop_owner_stt()
            if self.call_id:
                await self._summary_if_missing()

    async def _limit(self, seconds: float) -> None:
        await asyncio.sleep(seconds)
        log.warning("call %s reached its hard limit of %s s", self.twilio_call_sid, seconds)
        try:
            await twilio_api.update_call(self.twilio_call_sid, hang_up=True)
        except Exception as e:  # noqa: BLE001
            log.warning("hang up at the hard limit failed: %s", e)
        await self.stop()

    async def stop(self) -> None:
        await self.task.cancel()

    # --- control from calls.py / owner.py ---

    async def tell(self, text: str, run_llm: bool) -> None:
        """Appends a developer note to the AI's context (and runs the LLM when asked; the gate blocks that run
        while the owner has the call)."""
        await self.task.queue_frame(LLMMessagesAppendFrame(messages=[{"role": "developer", "content": text}],
                                                           run_llm=run_llm))

    async def set_tap(self, on: bool) -> None:
        """Owner audio needs the tap; it runs only while an owner link is attached."""
        await (self.tap.start_recording() if on else self.tap.stop_recording())

    def _close_gates(self, closed: bool) -> None:
        self.llm_gate.closed = self.gate.closed = closed
        (self.released.clear if closed else self.released.set)()

    async def take_over(self, rate: int, name: str) -> None:
        self.owner_name = name
        self._close_gates(True)
        await self.gate.cut()
        await self.tell(prompt.joined_note(name), run_llm=False)
        await self._start_owner_stt(rate)

    async def hand_back(self, note: str) -> None:
        self._close_gates(False)
        await self._stop_owner_stt()
        await self.tell(note, run_llm=True)

    async def owner_link_changed(self, rate: int) -> None:
        await self._stop_owner_stt()
        await self._start_owner_stt(rate)

    async def feed(self, pcm: bytes, rate: int) -> None:
        await self.gate.feed(pcm, rate)
        if self.owner_stt:
            await self.owner_stt.queue_frame(InputAudioRawFrame(audio=pcm, sample_rate=rate, num_channels=1))

    async def press(self, digit: str) -> None:
        """The owner's own key press on the phone, passed to the business."""
        if DIGITS.match(digit) and digit != "w":
            await self.gate.press(digit)

    # --- internals ---

    async def _line(self, who: str, text: str | None) -> None:
        text = (text or "").strip()
        if not text or not self.call_id:
            return
        store.add_line(self.call_id, who, text)
        calls.note_line(self.call_id, who)
        if who == "ai":
            row = store.get_call(self.call_id)
            if row and row["phase"] not in ("connecting_owner", "owner_on_call"):
                store.update_call(self.call_id, phase="talking")
            if row and not row["human_at"]:  # first words to the other side: a live person (section 8)
                store.update_call(self.call_id, human_at=store.now())
                if row["mode"] == "handle" and row["alert_on_human"] and not row["connect_when"]:
                    await owner.on_human(self.call_id)

    async def _start_owner_stt(self, rate: int) -> None:
        """A second tiny pipeline (Deepgram -> sink) for the owner's speech, while the owner has the call."""
        async def on_text(text: str) -> None:
            store.add_line(self.call_id, "owner", text)
            await self.tell(f"{self.owner_name} said to them: {text}", run_llm=False)

        self.owner_stt = PipelineWorker(
            Pipeline([DeepgramSTTService(api_key=config.env("DEEPGRAM_API_KEY"),
                                         settings=DeepgramSTTService.Settings(model=config.STT_MODEL)),
                      LineSink(on_text)]),
            params=PipelineParams(audio_in_sample_rate=rate), idle_timeout_secs=None, enable_rtvi=False)
        self.owner_runner = asyncio.create_task(WorkerRunner(handle_sigint=False).run(self.owner_stt))

    async def _stop_owner_stt(self) -> None:
        if self.owner_stt:
            await self.owner_stt.cancel()
        if self.owner_runner:
            try:
                await asyncio.wait_for(self.owner_runner, 5)
            except Exception:  # noqa: BLE001
                pass
        self.owner_stt = self.owner_runner = None

    async def _summary_if_missing(self) -> None:
        """The other side hung up before end_call: one short GPT request writes the outcome from the transcript."""
        row = store.get_call(self.call_id)
        if not row or row["outcome_result"]:
            return
        text = "\n".join(f"{l['who']}: {l['text']}" for l in store.lines(self.call_id) if l["who"] != "event")
        if not text:
            save_outcome(self.call_id, "no_human", "Nobody spoke on the call.")
            return
        try:
            r = await AsyncOpenAI(api_key=config.env("OPENAI_API_KEY")).chat.completions.create(
                model=config.SUMMARY_MODEL, temperature=0, response_format={"type": "json_object"},
                messages=[{"role": "system", "content":
                           f"Phone call goal: {row['goal']}\nReturn JSON: {{\"result\": one of "
                           f"{', '.join(config.OUTCOMES)}, \"summary\": one or two sentences, \"details\": object of "
                           "facts like reference numbers}."}, {"role": "user", "content": text[-12000:]}])
            out = json.loads(r.choices[0].message.content or "{}")
            save_outcome(self.call_id, out.get("result"), out.get("summary"), out.get("details"))
        except Exception as e:  # noqa: BLE001
            log.warning("summary failed for %s: %s", self.call_id, e)
            save_outcome(self.call_id, "not_done", "The other side hung up.")

    # --- the bot's tools ---

    async def _tool_press_digits(self, params) -> None:
        if self.owner_has_call:
            await params.result_callback(OWNER_HAS_CALL, properties=NO_LLM)
            return
        digits = str(params.arguments.get("digits", ""))
        if not DIGITS.match(digits):
            await params.result_callback("Use 1 to 20 of 0-9 * # (and w to pause).", properties=NO_LLM)
            return
        store.update_call(self.call_id, phase="menu")
        calls.event(self.call_id, f"pressed {digits.replace('w', '')}")
        for i, chunk in enumerate(digits.split("w")):
            if i:
                await asyncio.sleep(0.5)
            if chunk:
                await params.llm.push_frame(OutputDTMFFrame.from_string(chunk))
        await params.result_callback("pressed", properties=NO_LLM)

    async def _tool_wait(self, params) -> None:
        reason = params.arguments.get("reason")
        row = store.get_call(self.call_id)
        phase = {"menu": "menu", "hold": "on_hold"}.get(reason)
        if phase and not self.owner_has_call and row and row["phase"] != phase:
            store.update_call(self.call_id, phase=phase)
            if phase == "on_hold":
                calls.event(self.call_id, "waiting on hold")
        if phase and not self.owner_has_call:
            await owner.false_alarm(self.call_id)
        await params.result_callback("waiting", properties=NO_LLM)

    async def _tool_ask_user(self, params) -> None:
        question = str(params.arguments.get("question", "")).strip()[:500]
        if not question:
            await params.result_callback("Give the question.")
            return
        answer = await calls.ask(self.call_id, question)
        await self.released.wait()  # an answer (or the timeout) during a take-over waits for the hand-back
        await params.result_callback(
            answer if answer is not None else
            "No answer yet. Say you do not have that detail right now and carry on. A later answer may still arrive.")

    async def _tool_connect_owner(self, params) -> None:
        if self.owner_has_call:
            await params.result_callback(OWNER_HAS_CALL, properties=NO_LLM)
            return
        live = calls.LIVE.get(self.call_id)
        row = store.get_call(self.call_id)
        name = prompt.owner_name(row, calls.get_profile())
        o = owner.get(self.call_id)
        if o.unreachable:
            await params.result_callback(f"{name} could not be reached a moment ago, so do not try again. "
                                         + prompt.no_answer_rule(row, name))
            return
        if o.handover:
            await params.result_callback(f"{name} is already being brought on. Keep the person company.", properties=NO_LLM)
            return
        if not live or time.monotonic() - live.last_them > config.HANDOVER_RECENT_SECONDS:
            await params.result_callback("Nobody has spoken to you in the last few seconds. This is not a live person "
                                         "yet: keep waiting silently (call wait).", properties=NO_LLM)
            return
        fields = {"phase": "connecting_owner"}
        if not row["human_at"]:
            fields["human_at"] = store.now()
        store.update_call(self.call_id, **fields)
        calls.event(self.call_id, "connecting the owner")
        await owner.handover(self.call_id)
        await params.result_callback(f"Bringing {name} on the line. Keep the person company until you are told "
                                     f"{name} joined; do not start to solve the issue.", properties=NO_LLM)

    async def _tool_end_call(self, params) -> None:
        if self.owner_has_call:
            await params.result_callback(OWNER_HAS_CALL, properties=NO_LLM)
            return
        args = params.arguments
        if self.call_id:
            save_outcome(self.call_id, args.get("result"), args.get("summary"), args.get("details"))
            calls.event(self.call_id, "AI ended the call")
        await params.result_callback("ending", properties=NO_LLM)
        asyncio.create_task(self._hang_up_after_speech())

    async def _hang_up_after_speech(self) -> None:
        """Lets the last sentence finish, then hangs up through Twilio (one place ends a call) and stops the task."""
        await asyncio.sleep(1.0)
        deadline = time.monotonic() + config.END_CALL_SPEECH_WAIT_SECONDS
        while self.gate.bot_speaking and time.monotonic() < deadline:
            await asyncio.sleep(0.2)
        if self.owner_has_call:  # the owner took the call while the goodbye was playing
            return
        try:
            if self.call_id:
                await calls.hang_up(self.call_id)
            else:
                await twilio_api.update_call(self.twilio_call_sid, hang_up=True)
        except Exception as e:  # noqa: BLE001
            log.warning("hang up after end_call failed: %s", e)
        await self.stop()
