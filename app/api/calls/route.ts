import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { activeCount, byVapi, calls, publicView, type Call } from "@/lib/store";
import { DEMO, env, HANDOFF_MODES, LIMITS, type HandoffMode } from "@/lib/config";
import { allowIp, isAllowedNumber, toE164 } from "@/lib/guard";
import { lookupSupport } from "@/lib/exa";
import { buildAssistant, vapi } from "@/lib/vapi";

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/** Start a support call: demo line, given number, or Exa lookup; then a Vapi outbound call. Client polls GET /api/calls/:id. */
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const demo = !!b.demo;
  const company = demo ? DEMO.company : String(b.company || "").trim().slice(0, 100);
  const issue = String(b.issue || (demo ? DEMO.issue : "")).trim().slice(0, 500);
  const mode = (b.mode in HANDOFF_MODES ? b.mode : "agent") as HandoffMode;
  const myPhone = b.myPhone ? toE164(String(b.myPhone)) : "";
  const number = demo ? env.demoLineNumber : b.number ? toE164(String(b.number)) : "";

  if (!company || !issue) return bad("Company and issue are required.");
  if (b.myPhone && !isAllowedNumber(myPhone)) return bad("Your phone must be a US/Canada number, e.g. (415) 555-0123.");
  if (mode === "transfer" && !myPhone) return bad("Enter your phone number so I can transfer the call to you.");
  if (b.number && !demo && !isAllowedNumber(number)) return bad("The support number must be a US/Canada number (no 900/976 lines).");
  if (demo && !number) return bad("The demo line is not configured on this server.", 503);
  if (activeCount() >= LIMITS.maxActiveCalls) return bad("Too many calls are running right now. Please try again in a minute.", 429);
  const ip = req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  if (!allowIp(ip)) return bad(`Limit reached: ${LIMITS.callsPerIpPerHour} calls per hour. Please try again later.`, 429);

  const call: Call = { id: randomUUID(), company, issue, mode, myPhone, demo, number: number || undefined,
    menuTips: demo ? DEMO.menuTips : undefined, state: "LOOKING_UP", lines: [], history: [], createdAt: Date.now() };
  calls.set(call.id, call);
  void run(call); // continue in background; client polls
  return NextResponse.json(publicView(call));
}

async function run(call: Call) {
  try {
    if (!call.number) {
      const r = await lookupSupport(call.company, call.issue);
      call.number = r.number; call.menuTips = r.menuTips;
      if (!call.number) throw new Error(`Exa could not find a phone number for ${call.company}. Enter the number yourself and try again.`);
    }
    if (!isAllowedNumber(call.number)) throw new Error(`${call.number} is not a US/Canada number this demo can call.`);
    call.state = "DIALING";
    const v = await vapi("/call", { phoneNumberId: env.vapiPhoneNumberId, customer: { number: call.number }, assistant: buildAssistant(call) });
    call.vapiCallId = v.id; call.controlUrl = v.monitor?.controlUrl; call.listenUrl = v.monitor?.listenUrl;
    byVapi.set(v.id, call.id);
  } catch (e) {
    call.state = "FAILED"; call.error = (e as Error).message; call.endedAt = Date.now();
  }
}
