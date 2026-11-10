import { LIMITS, LLM, TRANSCRIBER, VOICE, env, type HandoffMode } from "./config.ts";

const handoffRule: Record<HandoffMode, string> = {
  transfer: "Then say: 'Thank you, I'm connecting the account holder now, one moment.' and stop talking. The system transfers the call.",
  browser: "Then say the account holder is joining in a moment. Keep the rep engaged politely; the account holder may send you lines to say.",
  agent: "Then resolve the issue yourself: answer the rep's questions with what you know, ask for a reference number, thank them, and use the endCall tool. If they need information you do not have, say the account holder will call back.",
};

/** Transient Vapi assistant: Deepgram ears + voice, DTMF for menus, patient on hold. Transfers are done server-side. */
export function buildAssistant(c: { company: string; issue: string; menuTips?: string; mode: HandoffMode }) {
  return {
    name: "HoldForMe caller",
    firstMessageMode: "assistant-waits-for-user",
    transcriber: TRANSCRIBER,
    voice: VOICE,
    silenceTimeoutSeconds: LIMITS.maxCallSeconds,
    maxDurationSeconds: LIMITS.maxCallSeconds,
    backgroundSpeechDenoisingPlan: { smartDenoisingPlan: { enabled: true } },
    monitorPlan: { listenEnabled: true, controlEnabled: true },
    serverMessages: ["transcript", "status-update", "end-of-call-report"],
    server: { url: `${env.publicBaseUrl}/api/vapi/webhook` },
    model: { ...LLM, tools: [{ type: "dtmf" }, { type: "endCall" }], messages: [{ role: "system", content:
`You are calling ${c.company} customer support on behalf of the account holder.
Issue: ${c.issue}
Phone menu tips (may be outdated): ${c.menuTips || "none"}
Rules:
- On a phone menu, pick the option closest to the issue. Use the dtmf tool to press keys, or speak the option if asked to say it. Press 0 or say "representative" only when a menu asks for an account number you do not have.
- On hold music or recorded messages (e.g. "please hold", "your call is important"), stay completely silent and do NOT use any tool. Never hang up while on hold.
- When a LIVE HUMAN speaks, greet them by name if given, say you are calling on behalf of the account holder, and state the issue in one short sentence. Do not give yourself a name and never call yourself ChatGPT.
- ${handoffRule[c.mode]}
- Be brief and polite. If sincerely asked, say you are an AI assistant calling for the account holder.` }] },
  };
}

export async function vapi(path: string, body?: unknown, method = "POST") {
  const res = await fetch(`https://api.vapi.ai${path}`, {
    method, headers: { Authorization: `Bearer ${env.vapiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Vapi ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

/** Live call control (transfer / say / end-call) via the call's controlUrl. */
export async function control(controlUrl: string, body: unknown) {
  const res = await fetch(controlUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`control ${res.status}`);
}
