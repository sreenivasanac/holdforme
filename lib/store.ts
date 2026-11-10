import type { Classification } from "./classify.ts";
import type { HandoffMode } from "./config.ts";

export type CallState = "LOOKING_UP" | "DIALING" | "IVR" | "ON_HOLD" | "HUMAN_ON_LINE" | "HANDED_OFF" | "ENDED" | "FAILED";
export type Line = { role: "business" | "agent"; text: string; label?: string; at: number };

export type Call = {
  id: string; company: string; issue: string; mode: HandoffMode; myPhone: string;
  number?: string; menuTips?: string; vapiCallId?: string; controlUrl?: string; listenUrl?: string;
  state: CallState; lines: Line[]; history: Classification[];
  summary?: string; recordingUrl?: string; error?: string; createdAt: number; humanAt?: number;
};

// TODO: replace in-memory Map with a DB for call history across restarts.
const g = globalThis as unknown as { __calls?: Map<string, Call>; __byVapi?: Map<string, string> };
export const calls = (g.__calls ??= new Map<string, Call>());
export const byVapi = (g.__byVapi ??= new Map<string, string>());

export const findByVapi = (vapiId: string) => calls.get(byVapi.get(vapiId) || "");
