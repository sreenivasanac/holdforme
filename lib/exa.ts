import { env } from "./config.ts";

const PHONE = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/;

async function exaAnswer(query: string): Promise<string> {
  const res = await fetch("https://api.exa.ai/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": env.exaKey },
    body: JSON.stringify({ query, text: false }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Exa ${res.status}`);
  return (await res.json()).answer || "";
}

/** Find the support number (E.164) and phone-menu tips for a company + issue. */
export async function lookupSupport(company: string, issue: string) {
  const [numAns, tips] = await Promise.all([
    exaAnswer(`What is the US customer service phone number for ${company} for: ${issue}? Reply with the number only.`),
    exaAnswer(`How do I navigate the ${company} customer service phone menu (IVR) to reach a live agent about: ${issue}? Give short steps, e.g. which keys to press or words to say.`).catch(() => ""),
  ]);
  const m = numAns.match(PHONE);
  return { number: m ? `+1${m[1]}${m[2]}${m[3]}` : undefined, menuTips: tips.slice(0, 800), raw: numAns };
}
