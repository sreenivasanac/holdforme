/** Central config and branding. Secrets come from env (.env.local). */
export const APP_NAME = "HoldForMe";
export const TAGLINE = "I wait on hold. You get the human.";
export const REPO_URL = "https://github.com/sreenivasanac/holdforme";
/** URL prefix when served under a sub-path (inlined at build time). */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const LABELS = ["hold_music", "recorded_message", "menu_prompt", "live_human"] as const;
export type Label = (typeof LABELS)[number];
export const LABEL_TEXT: Record<Label, string> = {
  hold_music: "Hold music", recorded_message: "Recorded message", menu_prompt: "Phone menu", live_human: "Live human",
};

export const HANDOFF_MODES = {
  transfer: "Transfer the call to my phone",
  browser: "Alert me and let me listen / type in the browser",
  agent: "Let the agent explain my issue",
} as const;
export type HandoffMode = keyof typeof HANDOFF_MODES;

/** Human pickup rule: 2 consecutive live_human labels, or 1 at/above this score. */
export const HUMAN_CONFIDENCE = 0.85;
export const HUMAN_STREAK = 2;
/** Seconds the agent gets to greet the rep before a transfer. */
export const TRANSFER_DELAY_MS = 6000;

/** Guards for a public demo that places real (paid) phone calls. */
export const LIMITS = {
  maxActiveCalls: 4,
  callsPerIpPerHour: 6,
  maxCallSeconds: 20 * 60,
};

/** Demo support line: Twilio number whose TwiML plays a phone menu + hold, then dials the AI "rep". */
export const DEMO = {
  company: "Northstar Internet (demo line)",
  issue: "I was charged twice for my October internet bill ($79.99). Please refund the duplicate charge. Account holder: Alex Rivera, email alex.rivera@example.com.",
  menuTips: "For billing, press 1.",
  voice: "Polly.Joanna",
  holdMusicPath: "/demo/hold-music.mp3",
};

export const VOICE = { provider: "deepgram", model: "aura-2", voiceId: "thalia" };
export const TRANSCRIBER = { provider: "deepgram", model: process.env.DEEPGRAM_STT_MODEL || "nova-3", language: "en" };
export const LLM = { provider: "openai", model: "gpt-4.1", temperature: 0 };

export const env = {
  vapiKey: process.env.VAPI_API_KEY || "",
  vapiPhoneNumberId: process.env.VAPI_PHONE_NUMBER_ID || "",
  demoLineNumber: process.env.DEMO_LINE_NUMBER || "",
  demoRepNumber: process.env.DEMO_REP_NUMBER || "",
  exaKey: process.env.EXA_API_KEY || process.env.EXA_API_KEY__EXA_SEARCH || "",
  jevKey: process.env.JEV_API_KEY || "",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
};
