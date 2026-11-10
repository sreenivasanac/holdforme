# HoldForMe

An agent that calls customer support for you, waits on hold, and alerts you when a live human answers.

- Type or say "call Comcast about my bill".
- **Exa** finds the support number and phone-menu tips.
- **Vapi** dials, presses keypad tones, and waits on hold. **Deepgram** is the transcriber (Nova-3/Flux) and voice (Aura-2) inside Vapi.
- **Jev** classifies each transcript line: hold music, recorded message, menu prompt, or live human (keyword fallback when Jev is not set). A human is confirmed after 2 consecutive labels or 1 with score >= 0.85.
- On a human: loud alarm + vibration in the web app, then per-call handoff: transfer to your phone, join (listen) in browser, or agent handles it. Summary, transcript and recording at the end.

## Run
```bash
pnpm install
cp .env.example .env.local   # fill in keys
pnpm dev                     # http://localhost:3000
pnpm test                    # classifier check
```
Vapi webhooks need a public URL: set `PUBLIC_BASE_URL` (e.g. a tunnel to port 3000).

## Mock support line (stage demo)
Buy a second free Vapi number, then:
```bash
VAPI_API_KEY=... MOCK_LINE_PHONE_NUMBER_ID=... node scripts/setup-mock-line.mjs
```
Set `MOCK_LINE_NUMBER` to that number and tick "Use mock support line".

## TODO
- Deepgram Voice Agent + Think Live for voice intake (browser SpeechRecognition used now).
- Vapi phone-in intake assistant with a `startSupportCall` tool.
- Talk from the browser on "Join now" (listen-only today).
- Manus post-call follow-up (dispute email draft).
- Own number as caller ID (needs a carrier number imported into Vapi).
