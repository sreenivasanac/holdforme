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

/** Jev `choice` classification over recent transcript; falls back to rules on any error. */
export async function classify(lines: string[]): Promise<Classification> {
  const latest = lines[lines.length - 1] || "";
  if (!env.jevKey || !env.jevUrl) return classifyRules(latest);
  try {
    const res = await fetch(env.jevUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.jevKey}` },
      body: JSON.stringify({
        primitive: "choice",
        prompt: "Phone call to customer support. Classify the LATEST line heard from the business side.",
        input: { recent: lines.slice(-3), latest },
        choices: ["hold_music", "recorded_message", "menu_prompt", "live_human"],
      }),
      signal: AbortSignal.timeout(2500),
    });
    const j = await res.json();
    const label = (j.choice ?? j.label) as Label;
    if (!label) throw new Error("no label");
    return { label, score: Number(j.score ?? j.confidence ?? 0.7), source: "jev" };
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
