import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { calls, byVapi, type Call } from "@/lib/store";
import { env, HANDOFF_MODES, type HandoffMode } from "@/lib/config";
import { lookupSupport } from "@/lib/exa";
import { buildAssistant, vapi } from "@/lib/vapi";

const E164 = /^\+[1-9]\d{7,14}$/;

export async function GET() {
  return NextResponse.json([...calls.values()].sort((a, b) => b.createdAt - a.createdAt));
}

/** Start a support call: Exa lookup (unless number given / mock), then Vapi outbound call. */
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const company = String(b.company || "").trim().slice(0, 100);
  const issue = String(b.issue || "").trim().slice(0, 500);
  const mode = (b.mode in HANDOFF_MODES ? b.mode : "transfer") as HandoffMode;
  const myPhone = String(b.myPhone || "").trim();
  let number = String(b.number || "").trim() || undefined;
  if (!company || !issue) return NextResponse.json({ error: "company and issue are required" }, { status: 400 });
  if (myPhone && !E164.test(myPhone)) return NextResponse.json({ error: "my phone must be E.164, e.g. +14155550123" }, { status: 400 });
  if (mode === "transfer" && !myPhone) return NextResponse.json({ error: "my phone is required for transfer" }, { status: 400 });
  if (b.mock) number = env.mockLineNumber || undefined;

  const call: Call = { id: randomUUID(), company, issue, mode, myPhone, number, state: "LOOKING_UP", lines: [], history: [], createdAt: Date.now() };
  calls.set(call.id, call);
  void run(call); // continue in background; client polls
  return NextResponse.json(call);
}

async function run(call: Call) {
  try {
    if (!call.number) {
      const r = await lookupSupport(call.company, call.issue);
      call.number = r.number; call.menuTips = r.menuTips;
      if (!call.number) throw new Error(`Exa found no number: ${r.raw.slice(0, 120)}`);
    }
    if (!E164.test(call.number)) throw new Error(`bad number ${call.number}`);
    call.state = "DIALING";
    const v = await vapi("/call", { phoneNumberId: env.vapiPhoneNumberId, customer: { number: call.number }, assistant: buildAssistant(call) });
    call.vapiCallId = v.id; call.controlUrl = v.monitor?.controlUrl; call.listenUrl = v.monitor?.listenUrl;
    byVapi.set(v.id, call.id);
  } catch (e) {
    call.state = "FAILED"; call.error = (e as Error).message;
  }
}
