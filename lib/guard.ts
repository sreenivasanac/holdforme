import { LIMITS } from "./config.ts";

/** US/Canada (NANP) numbers only, no premium-rate 900/976 lines: limits toll fraud on a public demo. */
export function isAllowedNumber(n: string): boolean {
  const m = /^\+1([2-9]\d{2})[2-9]\d{6}$/.exec(n);
  return !!m && m[1] !== "900" && m[1] !== "976";
}

/** Normalize "(415) 555-0123" / "4155550123" / "+1 415 555 0123" to E.164; returns "" when not a NANP number. */
export function toE164(raw: string): string {
  const d = raw.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return "";
}

const g = globalThis as unknown as { __hits?: Map<string, number[]> };
const hits = (g.__hits ??= new Map<string, number[]>());

/** Sliding one-hour window per client IP. Returns false when the IP is over the limit. */
export function allowIp(ip: string, now = Date.now()): boolean {
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  if (recent.length >= LIMITS.callsPerIpPerHour) return false;
  hits.set(ip, [...recent, now]);
  return true;
}
