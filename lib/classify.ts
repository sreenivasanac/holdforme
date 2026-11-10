import { HUMAN_CONFIDENCE, HUMAN_STREAK, env, type Label } from "./config.ts";

export type Classification = { label: Label; score: number; source: "jev" | "rules" };

const NOT_HUMAN: [Label, RegExp][] = [
  ["menu_prompt", /\b(press|para español|say or enter|main menu|option|dial)\b/i],
  ["recorded_message", /(your call is important|please (continue to )?hold|calls? (are|may be) (recorded|monitored)|high call volume|estimated wait|next available)/i],
  ["hold_music", /^(\W|la|♪|music)*$/i],
];
const HUMAN = /(how (can|may) i help|this is \w+|my name is|who am i speaking|can i (get|have) your|thanks for (calling|holding|waiting)|are you there|what can i do for you)/i;

/** Keyword fallback; same output shape as Jev so Jev drops in. */
export function classifyRules(text: string): Classification {
  for (const [label, re] of NOT_HUMAN) if (re.test(text)) return { label, score: 0.8, source: "rules" };
  if (HUMAN.test(text)) return { label: "live_human", score: 0.9, source: "rules" };
  // Short unscripted speech after hold is often a person; low score so the streak rule decides.
  return { label: text.split(/\s+/).length < 25 ? "live_human" : "recorded_message", score: 0.5, source: "rules" };
}

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const CRITERIA: Record<Label, string> = {
  hold_music: "Music, tones, or noise while on hold",
  recorded_message: "Pre-recorded announcement or hold message, e.g. wait times, call recording notice",
  menu_prompt: "Automated phone menu asking to press keys or say an option",
  live_human: "A real person speaking live and directly to the caller, e.g. greeting, asking name or account",
};

/** Jev (TypeSafe System One) `choice` over recent transcript; falls back to rules on any error. */
export async function classify(lines: string[]): Promise<Classification> {
  const latest = lines[lines.length - 1] || "";
  if (!env.jevKey) return classifyRules(latest);
  try {
    const res = await fetch(JEV_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.jevKey}` },
      body: JSON.stringify({
        model: "jev-latest",
        state: { recent_lines: lines.slice(-4, -1), latest_line: latest },
        questions: { label: { type: "choice", criteria: CRITERIA,
          instructions: "This is the transcript of what a company phone line just said to a caller waiting for customer support. What is the latest line?" } },
      }),
      signal: AbortSignal.timeout(3000),
    });
    const a = (await res.json()).answers?.label;
    if (!a?.choice) throw new Error("no label");
    return { label: a.choice as Label, score: Number(a.confidence ?? 0.7), source: "jev" };
  } catch {
    return classifyRules(latest);
  }
}

/** Reliability rule: confirm a human only on a streak or a high-confidence label. */
export function isHumanConfirmed(history: Classification[]): boolean {
  const last = history[history.length - 1];
  if (!last || last.label !== "live_human") return false;
  if (last.score >= HUMAN_CONFIDENCE) return true;
  const tail = history.slice(-HUMAN_STREAK);
  return tail.length === HUMAN_STREAK && tail.every((c) => c.label === "live_human");
}
