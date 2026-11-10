/** Central config and branding. Secrets come from env (.env.local). */
export const APP_NAME = "HoldForMe";
export const TAGLINE = "I wait on hold. You get the human.";
/** URL prefix when served under a sub-path (inlined at build time). */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const LABELS = ["hold_music", "recorded_message", "menu_prompt", "live_human"] as const;
export type Label = (typeof LABELS)[number];

export const HANDOFF_MODES = {
  transfer: "Transfer to my phone",
  browser: "Join in browser",
  agent: "Agent handles it",
} as const;
export type HandoffMode = keyof typeof HANDOFF_MODES;

/** Human pickup rule: 2 consecutive live_human labels, or 1 at/above this score. */
export const HUMAN_CONFIDENCE = 0.85;
export const HUMAN_STREAK = 2;

export const VOICE = { provider: "deepgram", model: "aura-2", voiceId: "thalia" };
export const TRANSCRIBER = { provider: "deepgram", model: process.env.DEEPGRAM_STT_MODEL || "nova-3", language: "en" };
export const LLM = { provider: "openai", model: "gpt-4o-mini" };

export const env = {
  vapiKey: process.env.VAPI_API_KEY || "",
  vapiPhoneNumberId: process.env.VAPI_PHONE_NUMBER_ID || "",
  mockLineNumber: process.env.MOCK_LINE_NUMBER || "",
  exaKey: process.env.EXA_API_KEY || process.env.EXA_API_KEY__EXA_SEARCH || "",
  jevKey: process.env.JEV_API_KEY || "",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "",
};
