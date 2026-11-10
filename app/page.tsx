"use client";
import { useEffect, useRef, useState } from "react";
import { APP_NAME, TAGLINE, HANDOFF_MODES, type HandoffMode } from "@/lib/config";
import type { Call } from "@/lib/store";

/** Loud looping two-tone alarm via Web Audio (no asset). Returns a stop function. */
function startAlarm() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator(); const gain = ctx.createGain();
  osc.type = "square"; gain.gain.value = 0.6; osc.connect(gain).connect(ctx.destination); osc.start();
  const t = setInterval(() => { osc.frequency.value = osc.frequency.value === 880 ? 660 : 880; }, 350);
  navigator.vibrate?.([500, 200, 500, 200, 500]);
  return () => { clearInterval(t); osc.stop(); ctx.close(); };
}

/** Parse "call Comcast about my bill" into company + issue. */
function parseRequest(s: string) {
  const m = s.match(/^\s*call\s+(.+?)\s+(?:about|regarding|for|re)\s+(.+)$/i);
  return m ? { company: m[1], issue: m[2] } : null;
}

export default function Home() {
  const [req, setReq] = useState("");
  const [form, setForm] = useState({ company: "", issue: "", number: "", myPhone: "", mode: "transfer" as HandoffMode, mock: false });
  const [call, setCall] = useState<Call | null>(null);
  const [err, setErr] = useState("");
  const [listening, setListening] = useState(false);
  const stopAlarm = useRef<null | (() => void)>(null);

  useEffect(() => {
    if (!call || ["ENDED", "FAILED"].includes(call.state)) return;
    const t = setInterval(async () => setCall(await (await fetch(`/api/calls/${call.id}`)).json()), 1000);
    return () => clearInterval(t);
  }, [call?.id, call?.state]);

  useEffect(() => {
    if (call?.state === "HUMAN_ON_LINE" && !stopAlarm.current) stopAlarm.current = startAlarm();
    if (call && ["ENDED", "FAILED"].includes(call.state)) silence();
  }, [call?.state]);

  function silence() { stopAlarm.current?.(); stopAlarm.current = null; }

  function voiceInput() {
    // TODO: swap browser SpeechRecognition for Deepgram Voice Agent + Think Live intake.
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return setErr("Voice input not supported in this browser");
    const r = new SR(); r.lang = "en-US"; setListening(true);
    r.onresult = (e: any) => applyRequest(e.results[0][0].transcript);
    r.onend = () => setListening(false); r.start();
  }

  function applyRequest(s: string) {
    setReq(s);
    const p = parseRequest(s);
    if (p) setForm((f) => ({ ...f, ...p }));
  }

  async function start() {
    setErr("");
    const res = await fetch("/api/calls", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const j = await res.json();
    if (!res.ok) return setErr(j.error);
    setCall(j);
  }

  /** Browser listen-in via Vapi monitor listenUrl (PCM over WebSocket). */
  function listenIn() {
    if (!call?.listenUrl) return;
    const ctx = new AudioContext({ sampleRate: 16000 }); let at = ctx.currentTime;
    const ws = new WebSocket(call.listenUrl); ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (typeof e.data === "string") return;
      const pcm = new Int16Array(e.data); const buf = ctx.createBuffer(1, pcm.length, 16000);
      buf.getChannelData(0).set(Float32Array.from(pcm, (v) => v / 32768));
      const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
      at = Math.max(at, ctx.currentTime); src.start(at); at += buf.duration;
    };
  }

  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });

  return (
    <main>
      <header><h1 style={{ margin: 0 }}>{APP_NAME}</h1><div style={{ color: "var(--muted)" }}>{TAGLINE}</div></header>

      {call?.state === "HUMAN_ON_LINE" && (
        <div className="card alarm" onClick={silence}>
          A live human picked up at {call.company}! {call.mode === "transfer" ? "Calling your phone now." : call.mode === "browser" ? "Join now." : "Agent is handling it."} (tap to silence)
        </div>
      )}

      <section className="card row" style={{ flexDirection: "column" }}>
        <div>
          <label>What should I do?</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder='e.g. "call Comcast about my bill"' value={req} onChange={(e) => applyRequest(e.target.value)} />
            <button className="secondary" onClick={voiceInput} aria-label="Speak request">{listening ? "..." : "Speak"}</button>
          </div>
        </div>
        <div className="row">
          <div><label>Company</label><input value={form.company} onChange={set("company")} /></div>
          <div><label>Support number (optional, Exa finds it)</label><input placeholder="+18009346489" value={form.number} onChange={set("number")} disabled={form.mock} /></div>
        </div>
        <div><label>Issue</label><textarea rows={2} value={form.issue} onChange={set("issue")} /></div>
        <div className="row">
          <div><label>When a human answers</label>
            <select value={form.mode} onChange={set("mode")}>{Object.entries(HANDOFF_MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div><label>My phone (for transfer)</label><input placeholder="+14155550123" value={form.myPhone} onChange={set("myPhone")} /></div>
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" style={{ width: "auto" }} checked={form.mock} onChange={set("mock")} /> Use mock support line (stage demo)</label>
        <button onClick={start} disabled={!form.company || !form.issue}>Call for me</button>
        {err && <div className="err">{err}</div>}
      </section>

      {call && (
        <section className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div><b>{call.company}</b> {call.number && <span className="tag">{call.number}</span>}</div>
            <span className={`pill ${call.state}`}>{call.state.replace(/_/g, " ")}</span>
          </div>
          {call.error && <p className="err">{call.error}</p>}
          {call.menuTips && <details><summary>Phone menu tips (Exa)</summary><p style={{ fontSize: 14 }}>{call.menuTips}</p></details>}
          <div style={{ display: "flex", gap: 8, margin: "12px 0", flexWrap: "wrap" }}>
            {call.listenUrl && <button className="secondary" onClick={listenIn}>Listen in</button>}
            {call.mode === "browser" && call.state === "HUMAN_ON_LINE" && <button onClick={listenIn}>Join now</button>}
            {!["ENDED", "FAILED"].includes(call.state) && <button className="secondary" onClick={() => fetch(`/api/calls/${call.id}`, { method: "POST", body: JSON.stringify({ action: "hangup" }) })}>Hang up</button>}
          </div>
          <div className="lines">
            {call.lines.map((l, i) => <div key={i} className={`line ${l.role}`}><b>{l.role === "agent" ? "Agent" : call.company}:</b> {l.text}{l.label && <span className="tag">{l.label}</span>}</div>)}
          </div>
          {call.summary && <><h3>Summary</h3><p>{call.summary}</p></>}
          {call.recordingUrl && <audio controls src={call.recordingUrl} style={{ width: "100%" }} />}
        </section>
      )}
    </main>
  );
}
