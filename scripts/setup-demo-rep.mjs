// Configures the AI "billing rep" that answers when the demo support line (app/api/demo-line) dials DEMO_REP_NUMBER.
// Idempotent: updates the assistant already attached to the Vapi number, or creates one.
// Run: VAPI_API_KEY=... DEMO_REP_PHONE_NUMBER_ID=... node scripts/setup-demo-rep.mjs
const key = process.env.VAPI_API_KEY, phoneId = process.env.DEMO_REP_PHONE_NUMBER_ID;
if (!key || !phoneId) { console.error("Set VAPI_API_KEY and DEMO_REP_PHONE_NUMBER_ID"); process.exit(1); }
const api = async (path, body, method = "POST") => {
  const r = await fetch(`https://api.vapi.ai${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j;
};
const rep = {
  name: "Demo line billing rep (Maria)",
  firstMessage: "Hi, thanks for holding, this is Maria in billing. Who am I speaking with, and how can I help you today?",
  transcriber: { provider: "deepgram", model: "nova-3", language: "en" },
  voice: { provider: "deepgram", model: "aura-2", voiceId: "andromeda" },
  model: { provider: "openai", model: "gpt-4o-mini", tools: [{ type: "endCall" }], messages: [{ role: "system", content:
`You are Maria, a friendly human billing representative at Northstar Internet (a fictional company used for a demo). Speak naturally in short sentences, like a real phone agent.
- If the caller says they are an assistant calling for the account holder, that is fine: ask for the account holder's name, then help.
- For a duplicate or wrong charge: in ONE reply, say you see the duplicate charge for that amount, that the refund arrives in 3 to 5 business days, and that the reference number is N S 4 8 2 1 7. Do not stall with "let me check" or "I see".
- If the caller says they are connecting the account holder, say "Sure, I'll wait" and wait.
- Never say you are an AI. When the caller says goodbye, say goodbye and use the endCall tool.` }] },
  silenceTimeoutSeconds: 60,
  maxDurationSeconds: 600,
};
const { assistantId } = await api(`/phone-number/${phoneId}`, undefined, "GET");
const a = assistantId ? await api(`/assistant/${assistantId}`, rep, "PATCH") : await api("/assistant", rep);
if (!assistantId) await api(`/phone-number/${phoneId}`, { assistantId: a.id }, "PATCH");
console.log("Demo rep ready, assistant", a.id);
