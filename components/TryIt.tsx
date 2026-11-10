"use client";
import { useState } from "react";
import { BASE_PATH, DEMO, HANDOFF_MODES, LIMITS, type HandoffMode } from "@/lib/config";
import type { PublicCall } from "@/lib/store";

type Tab = "demo" | "me" | "real";
const TABS: Record<Tab, string> = { demo: "1. Demo support line", me: "2. Call me (I play the company)", real: "3. Call a real company" };

/** Parse "call Delta about my lost bag" into company + issue. */
function parseRequest(s: string) {
  const m = s.match(/^\s*(?:please\s+)?call\s+(.+?)\s+(?:about|regarding|for|re|to)\s+(.+)$/i);
  return m ? { company: m[1], issue: m[2] } : null;
}

export default function TryIt({ busy, onStart }: { busy: boolean; onStart: (c: PublicCall) => void }) {
  const [tab, setTab] = useState<Tab>("demo");
  const [f, setF] = useState({ request: "", company: "", number: "", issue: DEMO.issue, mode: "agent" as HandoffMode, myPhone: "" });
  const [err, setErr] = useState("");
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  function applyRequest(s: string) {
    const p = parseRequest(s);
    setF((x) => ({ ...x, request: s, ...(p || {}) }));
  }

  function voiceInput() {
    // TODO: swap browser SpeechRecognition for Deepgram Voice Agent intake.
    const w = window as unknown as Record<string, new () => any>;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) return setErr("Voice input is not supported in this browser. Type instead.");
    const r = new SR(); r.lang = "en-US"; setListening(true);
    r.onresult = (e: any) => applyRequest(e.results[0][0].transcript);
    r.onend = () => setListening(false); r.start();
  }

  async function start() {
    setErr(""); setSending(true);
    const body = tab === "demo" ? { demo: true, issue: f.issue, mode: f.mode, myPhone: f.myPhone }
      : tab === "me" ? { company: f.company || "Test Company", number: f.number, issue: f.issue, mode: f.mode, myPhone: f.myPhone }
      : { company: f.company, number: f.number, issue: f.issue, mode: f.mode, myPhone: f.myPhone };
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    try {
      const res = await fetch(`${BASE_PATH}/api/calls`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) setErr(j.error || "Could not start the call."); else onStart(j);
    } catch { setErr("Network error. Please try again."); }
    setSending(false);
  }

  const ready = tab === "demo" ? !!f.issue : tab === "me" ? !!f.number && !!f.issue : !!f.company && !!f.issue;

  return (
    <section className="card" id="try">
      <h2>Try it now</h2>
      <div className="tabs" role="tablist">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "tab on" : "tab"}
            onClick={() => { setTab(t); setErr(""); setF((x) => ({ ...x, issue: t === "demo" ? DEMO.issue : t === "me" ? "My internet bill is wrong." : "" })); }}>{TABS[t]}</button>
        ))}
      </div>

      {tab === "demo" && <div className="hint">
        <b>Best for judges. No phone needed, about 90 seconds.</b> The agent calls our demo support line {`"${DEMO.company}"`}. It is a real phone number with a phone menu, about 50 seconds of hold music and recorded messages, and then a billing rep named Maria. Maria is an AI voice that plays the human.
        Watch the agent press 1, stay silent on hold, notice the moment Maria answers, and sound the alarm.
      </div>}
      {tab === "me" && <div className="hint">
        <b>You play the support line.</b> The agent calls your phone. Answer it, then say these lines with a short pause after each one:
        <ol>
          <li>{`"Thanks for calling. For billing, press 1."`}: the agent presses a key.</li>
          <li>{`"Please hold. Your call is important to us."`}: the agent stays silent and the status changes to On hold.</li>
          <li>{`"Hi, this is Sam from billing. How can I help you?"`}: the alarm sounds and the agent explains the issue.</li>
        </ol>
      </div>}
      {tab === "real" && <div className="hint">
        <b>Calls a real support line.</b> Exa finds the number and phone-menu tips. Leave the number empty to let Exa find it.
        Real hold times can be long. Calls stop after {LIMITS.maxCallSeconds / 60} minutes. Choose {`"Call for me"`} to let the agent finish the call, or {`"Hold for me"`} to take over when a person answers.
      </div>}

      <div className="stack">
        {tab === "real" && <div>
          <label htmlFor="req">What should I do?</label>
          <div className="inline">
            <input id="req" placeholder='e.g. "call Delta about my lost bag"' value={f.request} onChange={(e) => applyRequest(e.target.value)} />
            <button className="secondary" onClick={voiceInput} aria-label="Speak the request">{listening ? "Listening…" : "Speak"}</button>
          </div>
        </div>}
        {tab !== "demo" && <div className="row">
          {tab === "real" && <div><label htmlFor="company">Company</label><input id="company" value={f.company} onChange={set("company")} placeholder="Delta Air Lines" /></div>}
          <div><label htmlFor="number">{tab === "me" ? "Your phone (the agent calls it)" : "Support number (optional)"}</label>
            <input id="number" type="tel" inputMode="tel" value={f.number} onChange={set("number")} placeholder={tab === "me" ? "(415) 555-0123" : "Exa finds it"} /></div>
        </div>}
        <div><label htmlFor="issue">Issue the agent explains (add a name the rep can ask for)</label><textarea id="issue" rows={2} value={f.issue} onChange={set("issue")} /></div>
        <div className="row">
          <div><label htmlFor="mode">When a human answers</label>
            <select id="mode" value={f.mode} onChange={set("mode")}>
              {Object.entries(HANDOFF_MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></div>
          {f.mode === "transfer" && <div><label htmlFor="myPhone">Your phone for the transfer</label>
            <input id="myPhone" type="tel" inputMode="tel" value={f.myPhone} onChange={set("myPhone")} placeholder="(415) 555-0123" /></div>}
        </div>
        <button className="big" onClick={start} disabled={!ready || busy || sending}>
          {busy ? "A call is in progress" : sending ? "Starting…" : tab === "demo" ? "Start demo call" : "Call for me"}
        </button>
        {err && <div className="err" role="alert">{err}</div>}
        <p className="fine">US and Canada numbers only. {LIMITS.callsPerIpPerHour} calls per hour per visitor. Calls are recorded by Vapi so you can replay them. Do not share real account details.</p>
      </div>
    </section>
  );
}
