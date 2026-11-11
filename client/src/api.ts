// Typed client for the CallEnvoy console API (plan sections 3, 4, 4a).

export const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? '/callenvoy';
/** Where the console's own static files (sw.js, mic-worklet.js, icon) are served: the export's base path.
 *  Not API_BASE: in local dev the API is on another origin, and a service worker must be same-origin. */
export const WEB_BASE = process.env.EXPO_BASE_URL || '/callenvoy';

export type CallStatus = 'queued' | 'dialing' | 'in_progress' | 'completed' | 'no_answer' | 'busy' | 'failed' | 'canceled';
export type Phase = 'menu' | 'on_hold' | 'talking' | 'connecting_owner' | 'owner_on_call' | null;
export type OwnerState = 'none' | 'alerting' | 'ringing' | 'listening' | 'on_call';
export type Mode = 'handle' | 'transfer';
export type Reach = 'app' | 'phone' | 'app_then_phone';
export type NoAnswer = 'ai_handles' | 'end_politely';

export type Line = { n: number; t: string; who: 'them' | 'ai' | 'owner' | 'event'; text: string };
export type Question = { id: string; question: string; answer?: string };

export type Call = {
  id: string;
  direction: 'outbound' | 'inbound'; // section 22.1: inbound = a business called back, forwarded to the owner
  calling_number: string | null; // section 22.2: caller ID used
  leave_voicemail: boolean;
  status: CallStatus;
  phase: Phase;
  finished: boolean;
  business: string;
  number: string;
  goal: string;
  mode: Mode;
  connect_when: string | null;
  reach: Reach;
  listen_in: boolean;
  alert_on_human: boolean;
  recorded: boolean;
  human_at: string | null;
  owner: { state: OwnerState; via: 'app' | 'phone' | null; alert_until: string | null; unreachable: boolean };
  open_questions: Question[];
  answered_questions: Question[];
  outcome: { result: 'done' | 'not_done' | 'voicemail' | 'no_human' | 'handed_to_owner'; summary: string; details: Record<string, unknown> | null } | null;
  talk_seconds: number | null;
  owner_seconds: number | null;
  error: string | null;
  created_at: string;
  ended_at: string | null;
  transcript?: Line[];
  next_line?: number;
  // Not in the plan's call shape: the recording links of get_recordings, if the server adds them.
  recordings?: { url: string; duration_seconds: number }[];
};

// Text settings are null when not set.
export type Settings = {
  name: string | null;
  callback_number: string | null;
  details: string | null;
  voice: string;
  record_calls: boolean;
  max_minutes: number;
  mode: Mode;
  reach: Reach;
  alert_wait_seconds: number;
  phone_ring_seconds: number;
  no_answer: NoAnswer;
  alert_on_human: boolean;
  listen_in: boolean;
  alert_sound: boolean;
  alert_notification: boolean;
  alert_push: boolean;
  push_shows_business: boolean;
  caller_id: CallerId;
  leave_voicemail: boolean;
} & Record<ProfileField, string | null>;

export type CallerId = 'callenvoy' | 'own';

/** Optional calling-profile text fields (plan section 22.4). */
export type ProfileField =
  | 'name_pronunciation'
  | 'assistant_name'
  | 'email'
  | 'address'
  | 'date_of_birth'
  | 'insurance_carrier'
  | 'insurance_member_id'
  | 'insurance_group_number'
  | 'dental_insurance_carrier'
  | 'dental_insurance_member_id'
  | 'vehicle'
  | 'vin'
  | 'frequent_flyer_numbers'
  | 'known_traveler_number'
  | 'redress_number';

export type Voice = { name: string; gender: string; accent: string; style: string; sample_url: string; default?: boolean };

export type Config = {
  app_name: string;
  mcp_url: string;
  voices: Voice[];
  limits: { max_call_minutes: number; max_concurrent_calls: number; daily_minute_cap: number; minutes_used_today?: number };
  ranges: Record<'max_minutes' | 'alert_wait_seconds' | 'phone_ring_seconds', [number, number]>;
  text_limits: Record<string, number>;
  vapid_public_key: string | null;
};

/** The place_call fields (the console form sends the same). */
export type NewCall = {
  to: string;
  business: string;
  goal: string;
  facts?: string;
  menu_tips?: string;
  flexibility?: string;
  on_behalf_of?: string;
  mode?: Mode;
  connect_when?: string;
  reach?: Reach;
  alert_on_human?: boolean;
  listen_in?: boolean;
  alert_wait_seconds?: number;
  no_answer?: NoAnswer;
  max_minutes?: number;
  voice?: string;
  record?: boolean;
  from?: CallerId;
  leave_voicemail?: boolean;
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly field?: string) {
    super(message);
  }
}

let apiKey: string | null = null;
let onUnauthorized: () => void = () => {};

export function setApiKey(key: string | null) {
  apiKey = key;
}
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers: { Authorization: `Bearer ${apiKey ?? ''}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError('Cannot reach the CallEnvoy server. Check your connection and try again.', 0);
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError('That key was not accepted. Check it and try again.', 401);
  }
  if (!res.ok) throw toError(res.status, data);
  return data as T;
}

// The server sends errors as {detail, field?}.
function toError(status: number, data: { detail?: unknown; field?: string } | null): ApiError {
  if (typeof data?.detail === 'string') return new ApiError(data.detail, status, data.field);
  return new ApiError(`The server answered with an error (${status}). Try again.`, status);
}

export const api = {
  config: () => request<Config>('GET', '/api/config'),
  listCalls: (limit: number) => request<Call[]>('GET', `/api/calls?limit=${limit}`),
  placeCall: (body: NewCall) => request<{ id: string }>('POST', '/api/calls', body),
  getCall: (id: string, waitSeconds: number, sinceLine: number, signal?: AbortSignal) =>
    request<Call>('GET', `/api/calls/${encodeURIComponent(id)}?wait_seconds=${waitSeconds}&since_line=${sinceLine}`, undefined, signal),
  hangUp: (id: string) => request<unknown>('POST', `/api/calls/${encodeURIComponent(id)}/hang-up`),
  answer: (id: string, question_id: string, answer: string) =>
    request<unknown>('POST', `/api/calls/${encodeURIComponent(id)}/answer`, { question_id, answer }),
  connect: (id: string, mode: 'join' | 'listen', reach: 'phone' | 'app') =>
    request<unknown>('POST', `/api/calls/${encodeURIComponent(id)}/connect`, { mode, reach }),
  handBack: (id: string) => request<unknown>('POST', `/api/calls/${encodeURIComponent(id)}/hand-back`),
  audioTicket: (id: string) => request<{ ticket: string; expires_in: number }>('POST', `/api/calls/${encodeURIComponent(id)}/audio-ticket`),
  profile: () => request<Settings>('GET', '/api/profile'),
  saveProfile: (patch: Partial<Settings>) => request<Settings>('PUT', '/api/profile', patch),
  addPushDevice: (sub: { endpoint: string; keys: { p256dh: string; auth: string }; label: string }) =>
    request<unknown>('POST', '/api/push/subscriptions', sub),
  removePushDevice: (endpoint: string) => request<unknown>('DELETE', '/api/push/subscriptions', { endpoint }),
  testPush: () => request<{ sent: number }>('POST', '/api/push/test'),
  callerId: () => request<{ number: string | null; verified: boolean }>('GET', '/api/caller-id'),
  verifyCallerId: () => request<{ validation_code: string | null }>('POST', '/api/caller-id/verify'),
};

