// Creates the "Mock Comcast" support-line assistant on Vapi and attaches it to MOCK_LINE_PHONE_NUMBER_ID.
// Run: VAPI_API_KEY=... MOCK_LINE_PHONE_NUMBER_ID=... node scripts/setup-mock-line.mjs
const key = process.env.VAPI_API_KEY, phoneId = process.env.MOCK_LINE_PHONE_NUMBER_ID;
if (!key || !phoneId) { console.error("Set VAPI_API_KEY and MOCK_LINE_PHONE_NUMBER_ID"); process.exit(1); }
const api = async (path, body, method = "POST") => {
  const r = await fetch(`https://api.vapi.ai${path}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j;
};
const assistant = await api("/assistant", {
  name: "Mock Comcast support line",
  firstMessage: "Thank you for calling Comcast Xfinity. Calls may be recorded. For billing, press 1. For technical support, press 2.",
  transcriber: { provider: "deepgram", model: "nova-3" },
  voice: { provider: "deepgram", voiceId: "orion" },
  model: { provider: "openai", model: "gpt-4o-mini", messages: [{ role: "system", content:
`You simulate a Comcast customer support phone line for a demo. Follow these phases strictly:
1. IVR: after the caller presses 1 or says billing, say "Your call is important to us. Please continue to hold. The estimated wait time is 2 minutes."
2. HOLD: for the next 3 caller turns or silences, only say recorded-style messages such as "Please continue to hold, the next available agent will be with you shortly." Never respond conversationally.
3. HUMAN: then switch persona and say "Hi, thanks for holding, this is Maria in billing. Who am I speaking with and how can I help you today?" Then act as a friendly human billing rep.` }] },
  silenceTimeoutSeconds: 120,
});
await api(`/phone-number/${phoneId}`, { assistantId: assistant.id }, "PATCH");
console.log("Mock line ready, assistant", assistant.id);
