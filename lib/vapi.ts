import { LLM, TRANSCRIBER, VOICE, env, type HandoffMode } from "./config.ts";

const handoffRule: Record<HandoffMode, string> = {
  transfer: "Then say: 'Thank you, I'm connecting the account holder now, one moment.' and stop talking. The system transfers the call.",
  browser: "Then say: 'Thank you, the account holder is joining now, one moment please.' Keep the rep engaged politely until they join.",
  agent: "Then try to resolve the issue yourself. Ask for any reference number. If you need information you do not have, say you will call back.",
};

/** Transient Vapi assistant: Deepgram ears + voice, DTMF for menus, patient on hold. */
export function buildAssistant(c: { company: string; issue: string; menuTips?: string; mode: HandoffMode; myPhone: string }) {
  const tools: unknown[] = [{ type: "dtmf" }, { type: "endCall" }];
  if (c.mode === "transfer" && c.myPhone) {
    tools.push({ type: "transferCall", destinations: [{ type: "number", number: c.myPhone,
      transferPlan: { mode: "warm-transfer-say-summary", summaryPlan: { enabled: true } } }] });
  }
  return {
    name: "HoldForMe caller",
    firstMessageMode: "assistant-waits-for-user",
    transcriber: TRANSCRIBER,
    voice: VOICE,
    silenceTimeoutSeconds: 3600,
    maxDurationSeconds: 3600,
    backgroundSpeechDenoisingPlan: { smartDenoisingPlan: { enabled: true } },
    serverMessages: ["transcript", "status-update", "end-of-call-report", "tool-calls"],
    server: { url: `${env.publicBaseUrl}/api/vapi/webhook` },
    model: { ...LLM, tools, messages: [{ role: "system", content:
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

/** Live call control (transfer / say) via the call's controlUrl. */
export async function control(controlUrl: string, body: unknown) {
  await fetch(controlUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
