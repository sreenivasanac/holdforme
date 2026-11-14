// Display text for calls: labels, numbers, times. Pure functions.
import type { Call, Line } from './api';

export function phone(n: string) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(n);
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : n;
}

export function duration(sec: number) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function callSeconds(c: Call, now = Date.now()) {
  if (c.talk_seconds != null && c.finished) return c.talk_seconds;
  const end = c.ended_at ? Date.parse(c.ended_at) : now;
  return (end - Date.parse(c.created_at)) / 1000;
}

const time = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "Today 9:41 AM", "Yesterday 4:15 PM", "Nov 7, 2:03 PM". */
export function when(iso: string, now = new Date()) {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(now) - day(d)) / 86400000;
  if (diff === 0) return `Today ${time(d)}`;
  if (diff === 1) return `Yesterday ${time(d)}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time(d)}`;
}

/** "Nov 7", or "Nov 7, 2025" in another year. */
export function day(iso: string, now = new Date()) {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}

export function clock(iso: string) {
  return time(new Date(iso));
}

export type Tone = 'neutral' | 'ok' | 'bad' | 'info' | 'alert';

/** Status badge text and colour (mockup wording). */
export function statusLabel(c: Call): { text: string; tone: Tone; live: boolean } {
  if (!c.finished) {
    if (c.direction === 'inbound') return { text: c.status === 'in_progress' ? 'Forwarded to you' : 'Ringing your phone', tone: 'ok', live: true };
    if (c.status === 'queued' || c.status === 'dialing') return { text: 'Dialing', tone: 'ok', live: true };
    const byPhase: Record<string, string> = {
      menu: 'In menu',
      on_hold: 'On hold',
      talking: 'Talking to a person',
      connecting_owner: 'Person on the line',
      owner_on_call: 'Talking to a person',
    };
    return { text: (c.phase && byPhase[c.phase]) || 'Connected', tone: 'ok', live: true };
  }
  const byResult: Record<string, [string, Tone]> = {
    done: ['Done', 'ok'],
    not_done: ['Not done', 'neutral'],
    voicemail: ['Voicemail', 'neutral'],
    no_human: ['No person reached', 'neutral'],
    handed_to_owner: ['Handed to you', 'neutral'],
  };
  if (c.status === 'failed') return { text: 'Failed', tone: 'bad', live: false };
  if (c.outcome && byResult[c.outcome.result]) {
    const [text, tone] = byResult[c.outcome.result];
    return { text, tone, live: false };
  }
  const byStatus: Record<string, string> = { no_answer: 'No answer', busy: 'Busy', canceled: 'Canceled', completed: 'Ended' };
  return { text: byStatus[c.status] ?? 'Ended', tone: 'neutral', live: false };
}

export function ownerLabel(c: Call): { text: string; tone: Tone } | null {
  if (c.finished) return null;
  switch (c.owner.state) {
    case 'alerting':
      return { text: 'Waiting for you', tone: 'alert' };
    case 'ringing':
      return { text: 'Ringing your phone', tone: 'alert' };
    case 'listening':
      return { text: 'You are listening', tone: 'info' };
    case 'on_call':
      return { text: c.owner.via === 'phone' ? 'You are on the call by phone' : 'You are on the call', tone: 'alert' };
    default:
      return null;
  }
}

export const STEPS = ['Dialing', 'In menu', 'On hold', 'Talking to a person', 'Ended'];

/** Index of the current step in STEPS. */
export function stepIndex(c: Call) {
  if (c.finished) return STEPS.length;
  if (c.phase === 'menu') return 1;
  if (c.phase === 'on_hold') return 2;
  if (c.phase) return 3;
  return 0;
}

export const MODE_TEXT = { handle: 'AI handles the call', transfer: 'transfer to you when a person answers' } as const;
export const REACH_TEXT = { app: 'app', phone: 'phone', app_then_phone: 'app, then phone' } as const;

export function modeLine(c: Call) {
  return c.mode === 'transfer'
    ? `Mode: ${MODE_TEXT.transfer} · reach: ${REACH_TEXT[c.reach]}`
    : `Mode: ${MODE_TEXT.handle} · alerts: ${REACH_TEXT[c.reach]}`;
}

export const RESULT_TEXT: Record<string, string> = {
  done: 'Goal reached',
  not_done: 'Goal not reached',
  voicemail: 'Reached voicemail',
  no_human: 'No person answered',
  handed_to_owner: 'You had the call when it ended',
};

/** US/Canada number to E.164 (+1NXXNXXXXXX), or null. Same shape rule as the server's guard. */
export function toE164(input: string): string | null {
  let d = input.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  const e = `+1${d}`;
  return /^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e) ? e : null;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string, now = Date.now()) {
  const min = Math.floor((now - Date.parse(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

/** Lines of one speaker this close together (seconds) show as one bubble. */
export const MERGE_GAP_SECONDS = 10;

const seconds = (l: Line) => Date.parse(l.t) / 1000;

/** Joins consecutive fragments of the same speaker that are close in time. The first fragment's n and t are kept, and the first known `at`. */
export function mergeLines(lines: Line[], gap = MERGE_GAP_SECONDS): Line[] {
  const out: Line[] = [];
  let prev: Line | null = null; // the last fragment taken in, for the time gap
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && prev && l.who !== 'event' && l.who === last.who && Math.abs(seconds(l) - seconds(prev)) <= gap) {
      out[out.length - 1] = { ...last, text: `${last.text} ${l.text}`, at: last.at ?? l.at };
    } else {
      out.push(l);
    }
    prev = l;
  }
  return out;
}

/** Index of the line that plays at `time` (the last one that started), or -1. */
export function lineAt(lines: Line[], time: number) {
  let found = -1;
  lines.forEach((l, i) => {
    if (l.who !== 'event' && l.at != null && l.at <= time) found = i;
  });
  return found;
}
