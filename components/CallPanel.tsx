"use client";
import { useEffect, useRef, useState } from "react";
import { BASE_PATH, LABEL_TEXT, type Label } from "@/lib/config";
import type { CallState, PublicCall } from "@/lib/store";
import { listen } from "./audio";

const STEPS: { state: CallState; title: string; what: string }[] = [
  { state: "LOOKING_UP", title: "Find number", what: "Exa finds the support number and phone-menu tips" },
  { state: "DIALING", title: "Dial", what: "Vapi places the call from a Twilio number" },
  { state: "IVR", title: "Phone menu", what: "The agent presses keys or says the option" },
  { state: "ON_HOLD", title: "On hold", what: "The agent stays silent; Jev labels every line it hears" },
  { state: "HUMAN_ON_LINE", title: "Human answers", what: "Alarm sounds; the agent greets the rep" },
  { state: "HANDED_OFF", title: "Handoff", what: "Transfer, browser, or the agent finishes" },
];
const STATE_TEXT: Record<CallState, string> = {
  LOOKING_UP: "Finding the number", DIALING: "Dialing", IVR: "Phone menu", ON_HOLD: "On hold",
  HUMAN_ON_LINE: "Human on the line", HANDED_OFF: "Transferred to you", ENDED: "Call ended", FAILED: "Failed",
};

const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const LIVE: CallState[] = ["DIALING", "IVR", "ON_HOLD", "HUMAN_ON_LINE", "HANDED_OFF"];

export default function CallPanel({ call, alarmOn, onSilence }: { call: PublicCall; alarmOn: boolean; onSilence: () => void }) {
  const [listening, setListening] = useState(false);
  const [say, setSay] = useState("");
  const [note, setNote] = useState("");
  const stopListen = useRef<null | (() => void)>(null);
  const linesEnd = useRef<HTMLDivElement>(null);
  const live = LIVE.includes(call.state) && !call.endedAt;
  const now = call.endedAt || Date.now();

  useEffect(() => { linesEnd.current?.scrollIntoView({ block: "nearest" }); }, [call.lines.length]);
  useEffect(() => () => stopListen.current?.(), []);
  useEffect(() => { if (!live) stopListen.current?.(); }, [live]);

  // Index of the furthest step reached, so the stepper shows progress even after the call ends.
  const reached = call.humanAt ? (call.state === "HANDED_OFF" || call.endedAt ? 5 : 4)
    : Math.max(STEPS.findIndex((s) => s.state === call.state), call.lines.some((l) => l.label && l.label !== "menu_prompt") ? 3
      : call.answeredAt ? 2 : call.number ? 1 : 0);

  function toggleListen() {
    if (stopListen.current) { stopListen.current(); return; }
    if (!call.listenUrl) return;
    setListening(true);
    stopListen.current = listen(call.listenUrl, () => { stopListen.current = null; setListening(false); });
  }

  async function act(body: object) {
    const res = await fetch(`${BASE_PATH}/api/calls/${call.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json().catch(() => ({}));
    setNote(res.ok ? "" : j.error || "Action failed.");
    return res.ok;
  }

  return (
    <section className="card" id="call" aria-live="polite">
      {alarmOn && (
        <button className="alarm" onClick={onSilence}>
          A live human picked up at {call.company} after {mmss((call.humanAt || now) - call.createdAt)}!{" "}
          {call.mode === "transfer" ? "Calling your phone now." : call.mode === "browser" ? "Listen in and type what to say." : "The agent is explaining your issue."}
          <span>Tap to silence the alarm</span>
        </button>
      )}

      <div className="callhead">
        <div>
          <h2>{call.company}</h2>
          <div className="muted">{call.number || "Looking up the number…"} · {call.issue}</div>
        </div>
        <div className="right">
          <span className={`pill ${call.state}`}>{STATE_TEXT[call.state]}</span>
          <div className="timer">{mmss(now - call.createdAt)}</div>
        </div>
      </div>

      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.state} className={i < reached || (i === reached && !live) ? "done" : i === reached ? "now" : ""} title={s.what}>
            <b>{s.title}</b><small>{s.what}</small>
          </li>
        ))}
      </ol>

      {call.humanAt && <div className="saved">Human detected after <b>{mmss(call.humanAt - (call.answeredAt || call.createdAt))}</b> on the line. That is time you did not spend on hold.</div>}
      {call.error && <p className="err" role="alert">{call.error}</p>}

      {live && (
        <div className="actions">
          {call.listenUrl && <button className="secondary" onClick={toggleListen}>{listening ? "Stop listening" : "Listen live"}</button>}
          <button className="danger" onClick={() => act({ action: "hangup" })}>Hang up</button>
        </div>
      )}
      {live && call.humanAt && (
        <form className="inline" onSubmit={async (e) => { e.preventDefault(); if (say.trim() && await act({ action: "say", text: say })) setSay(""); }}>
          <input aria-label="Line for the agent to say" placeholder="Type a line for the agent to say to the rep" value={say} onChange={(e) => setSay(e.target.value)} maxLength={300} />
          <button disabled={!say.trim()}>Say it</button>
        </form>
      )}
      {note && <p className="err">{note}</p>}

      <h3>Live transcript</h3>
      <div className="lines">
        {!call.lines.length && <div className="muted">{live ? "Waiting for the line to speak…" : "No speech was heard."}</div>}
        {call.lines.map((l, i) => (
          <div key={i} className={`line ${l.role}`}>
            <div className="who">{l.role === "agent" ? "HoldForMe agent" : call.company} <span>{mmss(l.at - call.createdAt)}</span></div>
            <div>{l.text}</div>
            {l.label && <span className={`chip ${l.label}`} title={`Classified by ${l.source === "jev" ? "Jev" : "keyword rules"}`}>
              {LABEL_TEXT[l.label as Label]} · {Math.round((l.score || 0) * 100)}% · {l.source === "jev" ? "Jev" : "rules"}
            </span>}
          </div>
        ))}
        <div ref={linesEnd} />
      </div>

      {call.menuTips && <details><summary>Phone-menu tips the agent used</summary><p className="muted">{call.menuTips}</p></details>}
      {call.summary && <><h3>Call summary</h3><p>{call.summary}</p></>}
      {call.recordingUrl && <><h3>Recording</h3><audio controls src={call.recordingUrl} /></>}
    </section>
  );
}
