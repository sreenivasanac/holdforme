import { NextResponse } from "next/server";
import { findByVapi, type Call } from "@/lib/store";
import { classify, isHumanConfirmed } from "@/lib/classify";
import { TRANSFER_DELAY_MS } from "@/lib/config";
import { control } from "@/lib/vapi";

/** Vapi end reasons that mean the line never connected. */
const NOT_CONNECTED: Record<string, string> = {
  "customer-busy": "The line was busy.",
  "customer-did-not-answer": "Nobody answered.",
  "twilio-failed-to-connect-call": "The phone network could not connect the call.",
};

/** Vapi server messages: transcript -> Jev/rules classification -> human pickup -> handoff. */
export async function POST(req: Request) {
  const { message: m } = await req.json().catch(() => ({ message: null }));
  const c = m?.call?.id ? findByVapi(m.call.id) : undefined;
  if (!m || !c) return NextResponse.json({});

  if (m.type === "status-update" && m.status === "in-progress" && c.state === "DIALING") {
    c.state = "IVR"; c.answeredAt = Date.now();
  }
  if (m.type === "transcript" && m.transcriptType === "final") await onLine(c, m.role === "assistant" ? "agent" : "business", m.transcript);
  if (m.type === "end-of-call-report") {
    c.endedReason = m.endedReason; c.endedAt = Date.now();
    c.summary = m.analysis?.summary || m.summary; c.recordingUrl = m.recordingUrl || m.artifact?.recordingUrl;
    const why = NOT_CONNECTED[m.endedReason] || (/error/.test(m.endedReason || "") ? `Call error: ${m.endedReason}` : "");
    c.state = why && !c.humanAt ? "FAILED" : c.state === "HANDED_OFF" ? "HANDED_OFF" : "ENDED";
    if (why) c.error = why;
  }
  return NextResponse.json({});
}

async function onLine(c: Call, role: "agent" | "business", text: string) {
  const line: Call["lines"][number] = { role, text, at: Date.now() };
  c.lines.push(line);
  if (role !== "business" || c.humanAt || !["DIALING", "IVR", "ON_HOLD"].includes(c.state)) return;
  c.answeredAt ??= line.at;
  const r = await classify(c.lines.filter((l) => l.role === "business").map((l) => l.text));
  Object.assign(line, { label: r.label, score: r.score, source: r.source });
  c.history.push(r);
  if (!isHumanConfirmed(c.history)) { c.state = r.label === "menu_prompt" ? "IVR" : "ON_HOLD"; return; }
  c.state = "HUMAN_ON_LINE"; c.humanAt = Date.now();
  // Give the agent a few seconds to greet the rep and state the issue, then transfer.
  if (c.mode === "transfer" && c.controlUrl) setTimeout(() => {
    control(c.controlUrl!, { type: "transfer", destination: { type: "number", number: c.myPhone },
      content: "One moment, I'm connecting the account holder now." })
      .then(() => { c.state = "HANDED_OFF"; })
      .catch(() => { c.error = "Transfer failed: the call may have ended."; });
  }, TRANSFER_DELAY_MS);
}
