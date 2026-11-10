import { NextResponse } from "next/server";
import { findByVapi } from "@/lib/store";
import { classify, isHumanConfirmed } from "@/lib/classify";
import { control } from "@/lib/vapi";

/** Vapi server messages: transcript -> Jev/rules classification -> human pickup -> handoff. */
export async function POST(req: Request) {
  const { message: m } = await req.json().catch(() => ({ message: null }));
  const c = m?.call?.id ? findByVapi(m.call.id) : undefined;
  if (!m || !c) return NextResponse.json({});

  if (m.type === "status-update" && m.status === "in-progress" && c.state === "DIALING") c.state = "IVR";
  if (m.type === "transcript" && m.transcriptType === "final") {
    const role = m.role === "assistant" ? "agent" : "business";
    const line = { role, text: m.transcript, at: Date.now() } as (typeof c.lines)[number];
    c.lines.push(line);
    if (role === "business" && !["HUMAN_ON_LINE", "HANDED_OFF"].includes(c.state)) {
      const r = await classify(c.lines.filter((l) => l.role === "business").map((l) => l.text));
      line.label = `${r.label} ${r.score.toFixed(2)} (${r.source})`;
      c.history.push(r);
      if (isHumanConfirmed(c.history)) {
        c.state = "HUMAN_ON_LINE"; c.humanAt = Date.now();
        // Give the agent ~6s to greet + state the issue, then transfer.
        if (c.mode === "transfer" && c.controlUrl) setTimeout(() => {
          control(c.controlUrl!, { type: "transfer", destination: { type: "number", number: c.myPhone },
            content: `Connecting the account holder about: ${c.issue}` }).then(() => { c.state = "HANDED_OFF"; });
        }, 6000);
      } else c.state = r.label === "menu_prompt" ? "IVR" : "ON_HOLD";
    }
  }
  if (m.type === "end-of-call-report") {
    c.state = c.state === "FAILED" ? c.state : "ENDED";
    c.summary = m.analysis?.summary || m.summary; c.recordingUrl = m.recordingUrl || m.artifact?.recordingUrl;
  }
  return NextResponse.json({});
}
