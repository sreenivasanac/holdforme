"""The Pipecat voice bot on one Twilio call: pipeline, the bot's tools, the owner gates and the audio tap.

Pipeline (plan section 7): transport.input -> Deepgram STT -> user aggregator -> LLMGate -> OpenAI LLM
-> Fish TTS -> OwnerGate -> transport.output -> AudioBufferProcessor (tap) -> assistant aggregator.
Written against pipecat-ai 1.15.0 (PipelineTask / PipelineRunner are deprecated aliases there; the
PipelineWorker / WorkerRunner names are used).
"""

import asyncio
import json
import logging
import re
import time

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
from pipecat.processors.filters.function_filter import FunctionFilter
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.workers.runner import WorkerRunner

from . import config

log = logging.getLogger("callenvoy.bot")
DIGITS = re.compile(r"^[0-9*#w]{1,20}$")
NO_LLM = FunctionCallResultProperties(run_llm=False)


class OwnerGate(FrameProcessor):
    """Sits before transport.output. While the owner has the call (closed) it drops InterruptionFrame, so the other
    side starting to talk does not cut the owner's audio, and drops any late TTS audio of the muted AI.
    feed() pushes the owner's audio to the output. Also tracks whether the bot is speaking."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.closed = False
        self.bot_speaking = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStartedSpeakingFrame):
            self.bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self.bot_speaking = False
        if self.closed and isinstance(frame, (InterruptionFrame, TTSAudioRawFrame)):
            return
        await self.push_frame(frame, direction)

    async def feed(self, pcm: bytes, sample_rate: int) -> None:
        await self.push_frame(OutputAudioRawFrame(audio=pcm, sample_rate=sample_rate, num_channels=1))

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
        {"result": {"type": "string", "enum": ["done", "not_done", "voicemail", "no_human"]},
         "summary": {"type": "string", "description": "one or two sentences: what happened"},
         "details": {"type": "object", "description": "facts to keep, e.g. {\"reference_number\": \"NS-1234\"}"}},
        ["result", "summary"]),
}


def turn_strategies():
    """TURN_STOP: Pipecat's default (LocalSmartTurnAnalyzerV3) or a plain speech timeout if that is too slow."""
    if config.TURN_STOP != "speech_timeout":
        return None
    from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import SpeechTimeoutUserTurnStopStrategy
    from pipecat.turns.user_turn_strategies import UserTurnStrategies

    return UserTurnStrategies(stop=[SpeechTimeoutUserTurnStopStrategy()])


class CallBot:
    """One pipeline for one phone leg. With call_id None it is the demo rep (no call row, only end_call)."""

    def __init__(self, websocket, stream_sid: str, twilio_call_sid: str, system_prompt: str, voice_id: str,
                 call_id: str | None = None):
        from pipecat.serializers.twilio import TwilioFrameSerializer
        from pipecat.services.deepgram.stt import DeepgramSTTService
        from pipecat.services.fish.tts import FishAudioTTSService
        from pipecat.services.openai.llm import OpenAILLMService
        from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport

        self.call_id = call_id
        self.twilio_call_sid = twilio_call_sid
        self.owner_name = "the account holder"
        self.ended = False
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
            vad_analyzer=SileroVADAnalyzer(), user_turn_strategies=turn_strategies()))
        self.llm_gate = FunctionFilter(self._llm_allowed)
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
            self.llm.register_function(n, getattr(self, f"_tool_{n}"),
                                       cancel_on_interruption=n != "ask_user",
                                       timeout_secs=config.QUESTION_WAIT_SECONDS + 15 if n == "ask_user" else None)

        @self.aggs.user().event_handler("on_user_turn_stopped")
        async def _them(_agg, _strategy, message):
            await self._line("them", getattr(message, "content", None))

        @self.aggs.assistant().event_handler("on_assistant_turn_stopped")
        async def _ai(_agg, message):
            await self._line("ai", getattr(message, "content", None))

        @self.tap.event_handler("on_track_audio_data")
        async def _tap(_proc, them, played, _rate, _channels):
            if self.call_id:
                from . import owner

                await owner.tap(self.call_id, them, played)

        @self.transport.event_handler("on_client_disconnected")
        async def _gone(_transport, _ws):
            await self.task.cancel()

    # --- run / stop ---

    async def run(self, speak_first: bool = False) -> None:
        if speak_first:  # the demo rep greets; the caller bot waits for the other side
            await self.task.queue_frame(LLMRunFrame())
        try:
            await WorkerRunner(handle_sigint=False).run(self.task)
        finally:
            await self._stop_owner_stt()
            if self.call_id:
                await self._summary_if_missing()

    async def stop(self) -> None:
        await self.task.cancel()

    # --- control from calls.py / owner.py ---

    async def tell(self, text: str, run_llm: bool) -> None:
        """Appends a developer note to the AI's context (and runs the LLM when asked)."""
        await self.task.queue_frame(LLMMessagesAppendFrame(messages=[{"role": "developer", "content": text}],
                                                           run_llm=run_llm))

    async def set_tap(self, on: bool) -> None:
        """Owner audio needs the tap; it runs only while an owner link is attached."""
        await (self.tap.start_recording() if on else self.tap.stop_recording())

    async def take_over(self, rate: int, name: str) -> None:
        self.owner_name = name
        self.llm_gate_closed = True
        self.gate.closed = True
        await self.gate.cut()
        await self.tell(f"{name} has joined the call. Stay completely silent until you are told the call is handed back.",
                        run_llm=False)
        await self._start_owner_stt(rate)

    async def hand_back(self, note: str) -> None:
        self.llm_gate_closed = False
        self.gate.closed = False
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
        if DIGITS.match(digit) and digit != "w":
            await self.gate.push_frame(OutputDTMFFrame.from_string(digit))

    # --- internals ---

    llm_gate_closed = False

    async def _llm_allowed(self, frame: Frame) -> bool:
        """LLMGate: drops LLMContextFrame while the owner has the call, so the AI does not run."""
        return not (self.llm_gate_closed and isinstance(frame, LLMContextFrame))

    async def _line(self, who: str, text: str | None) -> None:
        text = (text or "").strip()
        if not text or not self.call_id:
            return
        from . import calls, owner, store

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
        from pipecat.services.deepgram.stt import DeepgramSTTService

        from . import store

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
        from . import store

        row = store.get_call(self.call_id)
        if not row or row["outcome_result"]:
            return
        text = "\n".join(f"{l['who']}: {l['text']}" for l in store.lines(self.call_id) if l["who"] != "event")
        if not text:
            store.update_call(self.call_id, outcome_result="no_human", outcome_summary="Nobody spoke on the call.")
            return
        try:
            from openai import AsyncOpenAI

            r = await AsyncOpenAI(api_key=config.env("OPENAI_API_KEY")).chat.completions.create(
                model=config.SUMMARY_MODEL, temperature=0, response_format={"type": "json_object"},
                messages=[{"role": "system", "content":
                           f"Phone call goal: {row['goal']}\nReturn JSON: {{\"result\": one of done, not_done, "
                           "voicemail, no_human, \"summary\": one or two sentences, \"details\": object of facts like "
                           "reference numbers}."}, {"role": "user", "content": text[-12000:]}])
            out = json.loads(r.choices[0].message.content or "{}")
            result = out.get("result") if out.get("result") in ("done", "not_done", "voicemail", "no_human") else "not_done"
            store.update_call(self.call_id, outcome_result=result, outcome_summary=str(out.get("summary", ""))[:1000],
                              outcome_details=json.dumps(out.get("details") or {}))
        except Exception as e:  # noqa: BLE001
            log.warning("summary failed for %s: %s", self.call_id, e)
            store.update_call(self.call_id, outcome_result="not_done", outcome_summary="The other side hung up.")

    # --- the bot's tools ---

    async def _tool_press_digits(self, params) -> None:
        from . import calls, store

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
        from . import calls, owner, store

        reason = params.arguments.get("reason")
        row = store.get_call(self.call_id)
        phase = {"menu": "menu", "hold": "on_hold"}.get(reason)
        if phase and row and row["phase"] not in (phase, "owner_on_call"):
            store.update_call(self.call_id, phase=phase)
            if phase == "on_hold":
                calls.event(self.call_id, "waiting on hold")
        if phase:
            await owner.false_alarm(self.call_id)
        await params.result_callback("waiting", properties=NO_LLM)

    async def _tool_ask_user(self, params) -> None:
        from . import calls

        question = str(params.arguments.get("question", "")).strip()[:500]
        if not question:
            await params.result_callback("Give the question.")
            return
        answer = await calls.ask(self.call_id, question)
        await params.result_callback(
            answer if answer is not None else
            "No answer yet. Say you do not have that detail right now and carry on. A later answer may still arrive.")

    async def _tool_connect_owner(self, params) -> None:
        from . import calls, owner, prompt, store

        live = calls.LIVE.get(self.call_id)
        row = store.get_call(self.call_id)
        name = prompt.owner_name(row, calls.get_profile())
        o = owner.get(self.call_id)
        if o.unreachable:
            await params.result_callback(f"{name} could not be reached a moment ago, so do not try again. "
                                         + prompt.no_answer_rule(row, name))
            return
        if o.state == "on_call" or (o.handover and o.state in ("alerting", "ringing")):
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
        from . import calls, store, twilio_api

        args = params.arguments
        if self.call_id:
            result = args.get("result") if args.get("result") in ("done", "not_done", "voicemail", "no_human") else "not_done"
            store.update_call(self.call_id, outcome_result=result, outcome_summary=str(args.get("summary", ""))[:1000],
                              outcome_details=json.dumps(args.get("details") or {}))
            calls.event(self.call_id, "AI ended the call")
        await params.result_callback("ending", properties=NO_LLM)
        asyncio.create_task(self._hang_up_after_speech())

    async def _hang_up_after_speech(self) -> None:
        """Lets the last sentence finish, then hangs up through Twilio (one place ends a call) and stops the task."""
        await asyncio.sleep(1.0)
        deadline = time.monotonic() + config.END_CALL_SPEECH_WAIT_SECONDS
        while self.gate.bot_speaking and time.monotonic() < deadline:
            await asyncio.sleep(0.2)
        from . import calls, twilio_api

        try:
            if self.call_id:
                await calls.hang_up(self.call_id)
            else:
                await twilio_api.update_call(self.twilio_call_sid, hang_up=True)
        except Exception as e:  # noqa: BLE001
            log.warning("hang up after end_call failed: %s", e)
        await self.stop()
