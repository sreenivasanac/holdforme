import { APP_NAME, HUMAN_CONFIDENCE, HUMAN_STREAK, LIMITS, REPO_URL, TAGLINE } from "@/lib/config";
import Console from "@/components/Console";

const HOW = [
  { n: 1, title: "Find the line", by: "Exa", text: "Tell it the company and the problem. Exa search finds the support number and tips for its phone menu." },
  { n: 2, title: "Dial and get through the menu", by: "Vapi + Twilio", text: "Vapi calls from a real phone number. The agent presses keys (DTMF) or says the option that fits your issue." },
  { n: 3, title: "Wait on hold, silently", by: "Deepgram + Jev", text: "Deepgram Nova-3 transcribes the line live. Jev labels each line as hold music, a recorded message, a phone menu, or a live human." },
  { n: 4, title: "Get the human", by: "Vapi live control", text: "When a person answers, your browser alarms. The call transfers to your phone, or you listen in and type lines, or the agent finishes the job." },
];

const LABELS = [
  ["menu_prompt", "Phone menu", "\"For billing, press 1.\""],
  ["recorded_message", "Recorded message", "\"Your call is important to us. Please continue to hold.\""],
  ["hold_music", "Hold music", "Music, tones, or silence"],
  ["live_human", "Live human", "\"Hi, thanks for holding, this is Maria. How can I help?\""],
];

const FAQ = [
  ["Is the person on the demo line real?", "No. The demo line is a real phone number with a real phone menu, recorded messages, and hold music. After about 50 seconds it connects to Maria, an AI voice that plays a billing rep. Use tab 2 to be the human yourself."],
  ["Does it work with real companies?", "Yes. Tab 3 calls a real support line. Real hold times can be long, so choose \"Transfer the call to my phone\" and leave the tab open."],
  ["Why not just use a voicemail-detection feature?", "Answering-machine detection only checks the first seconds of a call. On hold, the line plays many recorded messages that sound like people. HoldForMe checks every line during the whole wait and needs strong evidence before it alerts you."],
  ["What if Jev is not available?", "Each line falls back to keyword rules, so the call continues. The chip on each line shows which one labeled it."],
  ["What does it cost?", "We measured a full demo call (menu, 1 minute of hold, 40 seconds with the rep): $0.10 for the HoldForMe agent in Vapi (Deepgram, LLM, voice), $0.05 for the AI rep, and about $0.05 in Twilio minutes. On a real call, waiting on hold costs about $0.07 per minute."],
  ["Limits on this public demo", `US and Canada numbers only, no 900/976 lines, ${LIMITS.callsPerIpPerHour} calls per hour per visitor, ${LIMITS.maxActiveCalls} calls at the same time, and ${LIMITS.maxCallSeconds / 60} minutes per call. Calls are recorded by Vapi so you can replay them.`],
];

export default function Home() {
  return (
    <main>
      <header className="hero">
        <div className="brand">{APP_NAME}</div>
        <h1>{TAGLINE}</h1>
        <p className="lead">HoldForMe is an AI agent that calls customer support for you. It gets through the phone menu, waits on hold, and alerts you the moment a real person answers. Then it transfers the call to your phone.</p>
        <div className="cta">
          <a className="button" href="#try">Start a demo call</a>
          <a className="button secondary" href={REPO_URL} target="_blank" rel="noreferrer">Source on GitHub</a>
        </div>
        <ul className="stack-tags" aria-label="Built with">
          {["Vapi", "Deepgram", "Jev (Typesafe)", "Exa", "Twilio", "Next.js"].map((t) => <li key={t}>{t}</li>)}
        </ul>
      </header>

      <Console />

      <section className="card">
        <h2>What to look for during a demo call</h2>
        <ul className="checks">
          <li>The status moves from <b>Dialing</b> to <b>Phone menu</b> to <b>On hold</b>, and the agent presses 1 by itself.</li>
          <li>Each line in the transcript gets a label with a confidence score from Jev.</li>
          <li>The agent stays silent through hold music and recorded messages and does not hang up.</li>
          <li>When Maria says {`"Hi, this is Maria"`}, the alarm sounds and the status changes to <b>Human on the line</b>.</li>
          <li>Click <b>Listen live</b> to hear the call. When a human answers, type a line and the agent says it.</li>
          <li>When the call ends, you get a summary and a recording.</li>
        </ul>
      </section>

      <section>
        <h2 className="center">How it works</h2>
        <div className="grid4">
          {HOW.map((h) => (
            <div key={h.n} className="card step">
              <div className="num">{h.n}</div>
              <h3>{h.title}</h3>
              <div className="by">{h.by}</div>
              <p>{h.text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>How it knows a human picked up</h2>
        <p>Many recorded messages sound like a person. A false alarm makes you run back to the phone for nothing, so detection has two layers:</p>
        <div className="grid2">
          <div>
            <h3>1. Jev labels every line</h3>
            <ul className="labels">
              {LABELS.map(([k, name, ex]) => <li key={k}><span className={`chip ${k}`}>{name}</span> {ex}</li>)}
            </ul>
          </div>
          <div>
            <h3>2. A confirmation rule</h3>
            <p>An alert needs <b>{HUMAN_STREAK} {`"live human"`} lines in a row</b>, or <b>1 line with {Math.round(HUMAN_CONFIDENCE * 100)}% confidence or more</b>.</p>
            <p>Jev gets the latest line plus the 3 lines before it, so it can see that hold has ended. A rep who says their name, asks {`"how can I help"`}, or asks for your account counts as human. A recorded greeting does not.</p>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>Architecture</h2>
        <ol className="flow">
          <li><b>Browser</b><small>Next.js app, polls the call every second</small></li>
          <li><b>Exa</b><small>number + phone-menu tips</small></li>
          <li><b>Vapi</b><small>outbound call over Twilio, Deepgram STT and voice, DTMF tool</small></li>
          <li><b>Webhook</b><small>each transcript line goes to Jev, then the confirmation rule</small></li>
          <li><b>Handoff</b><small>Vapi live control: transfer, say, end call</small></li>
        </ol>
      </section>

      <section className="card">
        <h2>Questions</h2>
        {FAQ.map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}
      </section>

      <footer>
        Built for the Side Quest Hotline Vapi Hackathon by Sreenivasan AC · <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a>
      </footer>
    </main>
  );
}
