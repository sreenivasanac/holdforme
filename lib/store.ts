import type { Classification } from "./classify.ts";
import type { HandoffMode, Label } from "./config.ts";

export type CallState = "LOOKING_UP" | "DIALING" | "IVR" | "ON_HOLD" | "HUMAN_ON_LINE" | "HANDED_OFF" | "ENDED" | "FAILED";
export type Line = { role: "business" | "agent"; text: string; label?: Label; score?: number; source?: string; at: number };

export type Call = {
  id: string; company: string; issue: string; mode: HandoffMode; myPhone: string; demo: boolean;
  number?: string; menuTips?: string; vapiCallId?: string; controlUrl?: string; listenUrl?: string;
  state: CallState; lines: Line[]; history: Classification[];
  summary?: string; recordingUrl?: string; endedReason?: string; error?: string;
  createdAt: number; answeredAt?: number; humanAt?: number; endedAt?: number;
};

export const ACTIVE: CallState[] = ["LOOKING_UP", "DIALING", "IVR", "ON_HOLD", "HUMAN_ON_LINE", "HANDED_OFF"];

// TODO: replace in-memory Map with a DB for call history across restarts.
const g = globalThis as unknown as { __calls?: Map<string, Call>; __byVapi?: Map<string, string> };
export const calls = (g.__calls ??= new Map<string, Call>());
export const byVapi = (g.__byVapi ??= new Map<string, string>());

export const findByVapi = (vapiId: string) => calls.get(byVapi.get(vapiId) || "");
export const activeCount = () => [...calls.values()].filter((c) => ACTIVE.includes(c.state)).length;

/** What the browser may see: control URL and Vapi id can steer the live call or fake webhooks, so they stay server-side. */
export function publicView({ controlUrl, vapiCallId, history, ...c }: Call) {
  return { ...c, myPhone: c.myPhone ? `•••${c.myPhone.slice(-4)}` : "" };
}
export type PublicCall = ReturnType<typeof publicView>;
