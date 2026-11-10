import { LIMITS, LLM, TRANSCRIBER, VOICE, env, type HandoffMode } from "./config.ts";

const handoffRule: Record<HandoffMode, string> = {
  transfer: "Then say: 'Thank you, I'm connecting the account holder now, one moment.' and stop talking. The system transfers the call.",
  browser: "Then say the account holder is joining in a moment. Keep the rep engaged politely; the account holder may send you lines to say.",
  agent: "Then resolve the issue yourself: answer the rep's questions with the account details above and ask for a reference number. Let the rep finish speaking, repeat the reference number back once, say thank you and goodbye, then use the endCall tool. If they need information you do not have, say the account holder will call back.",
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
Issue and account details: ${c.issue}
Phone menu tips (may be outdated): ${c.menuTips || "none"}
Rules:
- Use the dtmf tool only right after a menu names the keys (e.g. "for billing, press 1"). Press one key per menu, once. Menu tips are hints; wait to hear the real menu first. Press 0 or say "representative" only when a menu asks for an account number you do not have.
- After you press a key you are usually on hold. Lines like "you have reached billing", "your call is important", "all agents are busy", "please continue to hold" are hold messages, not menus. On hold, stay completely silent and do NOT use any tool, including dtmf. Never hang up while on hold.
- To stay silent, reply with an empty message. Never say "silence", "hello", or describe what you hear.
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
