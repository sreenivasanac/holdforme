import { NextResponse } from "next/server";
import { calls } from "@/lib/store";
import { control } from "@/lib/vapi";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = calls.get((await params).id);
  return c ? NextResponse.json(c) : NextResponse.json({ error: "not found" }, { status: 404 });
}

/** Actions: hangup. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const c = calls.get((await params).id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { action } = await req.json().catch(() => ({}));
  if (action === "hangup" && c.controlUrl) await control(c.controlUrl, { type: "end-call" });
  return NextResponse.json({ ok: true });
}
