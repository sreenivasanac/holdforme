import { NextResponse } from "next/server";
import { calls, publicView } from "@/lib/store";
import { control } from "@/lib/vapi";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Ctx) {
  const c = calls.get((await params).id);
  return c ? NextResponse.json(publicView(c)) : NextResponse.json({ error: "Call not found (the server may have restarted)." }, { status: 404 });
}

/** Actions: hangup, or say (the agent speaks the user's typed line on the live call). */
export async function POST(req: Request, { params }: Ctx) {
  const c = calls.get((await params).id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!c.controlUrl) return NextResponse.json({ error: "The call is not connected yet." }, { status: 409 });
  const { action, text } = await req.json().catch(() => ({}));
  try {
    if (action === "hangup") await control(c.controlUrl, { type: "end-call" });
    else if (action === "say" && typeof text === "string" && text.trim()) {
      await control(c.controlUrl, { type: "say", content: text.trim().slice(0, 300) });
    } else return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "The call already ended." }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
