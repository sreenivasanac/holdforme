// Dev-only mock of the CallEnvoy console API (plan sections 4, 4a, 10a, 22; round 2 A1-A4; round 3 A1-A5b) with sample calls.
// Not part of the export. Serves client/dist under /callenvoy too, so the real export can be checked.
//   node dev/mock-api.mjs            -> http://localhost:3020/callenvoy/   (admin: dana@example.com, agent key: dev-key)
// Users: dana@example.com (admin, sample calls and keys), sam@example.com (new: no name, no calls, no keys),
// and a disabled user. Any other address can sign up while sign-ups are on (the link is printed here).
//   GET  /__mock/signin?as=dana|sam     signs this browser in as that user (sets the session cookie) and opens the console
//   GET  /__mock/last-link              the last emailed sign-in link (also printed on the console)
//   POST /__mock/mail?ready=0|1         email sign-in configured or not (GET /api/auth/me mail_ready)
//   POST /__mock/expire                 ends every session (the next request gets 401 session_expired)
//   POST /__mock/recording?fail=1|0     /r/demo answers 404 (to see the player's error state)
//   POST /__mock/recording?unknown=1|0  the call view gives duration_seconds 0 (length not known)
//   POST /__mock/calls?set=empty|many&as=dana|sam   switches that user's call list
//   POST /__mock/admin?fail=1|0          GET /api/admin/users answers 500 (to see the People error state)
//   POST /__mock/socket?id=<call>&send=replaced|error|drop   acts on that call's open audio socket
//   POST /__mock/alert?id=<call>&state=alerting|none&seconds=20   starts or ends an alert (a new alert_until each time)
//   GET  /__mock/count?id=<call>                           how often GET /api/calls/<id> was asked
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 3020);
const DIST = path.resolve(import.meta.dirname, '../dist');
const VOICE_DIR = path.resolve(import.meta.dirname, '../../callenvoy/static/voices');
const OWNER_EMAIL = 'dana@example.com'; // the admin (OWNER_EMAIL on the server)
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const MIN = 60_000;

const VOICES = [
  ['Hannah', 'female', 'US', 'professional, friendly, clear'],
  ['Sarah', 'female', 'US', 'young, soft, conversational'],
  ['Laura', 'female', 'US', 'warm, calm, deeper'],
  ['Sophia', 'female', 'British', 'professional'],
  ['Ethan', 'male', 'US', 'clear, calm, professional'],
  ['Adrian', 'male', 'US', 'deep, slow, steady'],
  ['Jordan', 'male', 'US', 'older, confident, measured'],
  ['Rohan', 'male', 'Indian English', 'professional, measured'],
  ['Vikram', 'male', 'Indian English', 'calm, steady, middle-aged'],
  ['Meera', 'female', 'Indian English', 'friendly, professional, middle-aged'],
].map(([name, gender, accent, style]) => ({ name, gender, accent, style, sample_url: `/callenvoy/static/voices/${name.toLowerCase()}.mp3`, default: name === 'Hannah' }));

const newProfile = (over = {}) => ({
  name: null, callback_number: null, details: null,
  voice: 'Hannah', record_calls: true, max_minutes: 30, mode: 'handle', reach: 'app_then_phone', alert_wait_seconds: 20,
  phone_ring_seconds: 25, no_answer: 'ai_handles', alert_on_human: true, listen_in: false, alert_sound: true,
  alert_notification: true, alert_push: true, push_shows_business: true, caller_id: 'callenvoy', leave_voicemail: true,
  name_pronunciation: null, assistant_name: null, email: null, address: null, date_of_birth: null,
  insurance_carrier: null, insurance_member_id: null, insurance_group_number: null, dental_insurance_carrier: null,
  dental_insurance_member_id: null, vehicle: null, vin: null, frequent_flyer_numbers: null, known_traveler_number: null, redress_number: null,
  ...over,
});
// As the server's config.SETTINGS: text fields with their max length, int fields with their range.
const TEXT_LIMITS = { name: 80, details: 3000, name_pronunciation: 80, assistant_name: 30, email: 120, address: 300, date_of_birth: 40,
  insurance_carrier: 80, insurance_member_id: 60, insurance_group_number: 60, dental_insurance_carrier: 80, dental_insurance_member_id: 60,
  vehicle: 120, vin: 40, frequent_flyer_numbers: 300, known_traveler_number: 40, redress_number: 40 };
const RANGES = { max_minutes: [1, 120], alert_wait_seconds: [5, 120], phone_ring_seconds: [10, 60] };
// As config.py: CallEnvoy's demo line, to pre-fill a first call (round 3 A5b).
const DEMO = { number: '+16562405137', business: 'Northstar Internet', goal: 'Ask billing to remove a wrong charge of 30 dollars on the October bill and get a reference number.',
  facts: 'Service address: 12 Oak Street, Springfield.', menu_tips: 'Billing is option 1.' };
const DAILY_MINUTE_CAP = 240;

const line = (n, sAgo, who, text) => ({ n, t: iso(sAgo * 1000), who, text, at: null });
// The demo recording: the voice samples (CBR 128 kb/s mp3 frames) one after the other, twice: about 2 minutes.
const voiceFiles = fs.existsSync(VOICE_DIR) ? fs.readdirSync(VOICE_DIR).filter((f) => f.endsWith('.mp3')).sort() : [];
const one = Buffer.concat(voiceFiles.map((f) => fs.readFileSync(path.join(VOICE_DIR, f))));
const RECORDING = Buffer.concat([one, one]);
const RECORDING_SECONDS = Math.round((RECORDING.length * 8) / 128000) || 120;
let recordingFails = false;
const holdLines = (s) => [
  line(0, s, 'event', 'Dialing +1 (656) 240-5137'),
  line(1, s - 4, 'them', 'Thank you for calling Northstar Internet. For billing, press 1. For technical support, press 2.'),
  line(2, s - 6, 'event', 'pressed 1'),
  line(3, s - 19, 'them', 'All of our agents are busy. Your call is important to us. Please continue to hold.'),
  line(4, s - 20, 'event', 'waiting on hold'),
];
// A finished call with `at` (seconds into the recording). Fragments of one speaker close together show as one bubble.
const doneLines = (createdAgo) => [
  [null, 'event', 'Dialing +1 (656) 240-5137'],
  [0.8, 'them', 'Thank you for calling Northstar Internet.'],
  [3.1, 'them', 'For billing, press 1. For technical support, press 2.'],
  [6.0, 'event', 'pressed 1'],
  [9.5, 'them', 'All of our agents are busy. Please continue to hold.'],
  [12.0, 'event', 'waiting on hold'],
  [24.2, 'them', 'Hi, thanks for holding, this is Maria in billing. How can I help?'],
  [29.0, 'ai', 'Hi Maria, I am calling on behalf of Dana Reyes about her bill.'],
  [33.4, 'ai', 'It went from 65 to 130 dollars after a plan change she did not ask for.'],
  [40.6, 'them', 'I see that. What is the service address on the account?'],
  [45.2, 'ai', 'One moment, let me check that.'],
  [47.0, 'event', 'asked owner: What is the service address on the account?'],
  [58.7, 'ai', 'It is 1820 SE Alder St, Apartment 4, Portland, Oregon.'],
  [66.3, 'them', 'Thank you. I moved the account back to the old plan.'],
  [70.1, 'them', 'And I added a 65 dollar credit. It shows on the next bill.'],
  [null, 'ai', 'Thank you. Could I have a reference number?'], // start not known: not clickable
  [88.4, 'them', 'Sure, it is N S 4 8 2 1 3 K.'],
  [97.9, 'ai', 'N S 4 8 2 1 3 K. Thanks so much, Maria. Goodbye.'],
  [104.5, 'them', 'Goodbye, have a nice day.'],
  [110.0, 'event', 'call ended by AI'],
].map(([at, who, text], n, all) => {
  const sec = at ?? (n ? all[n - 1][0] + 8 : 0); // a line without `at` still has a time
  return { n, t: new Date(Date.now() - createdAgo + (6 + sec) * 1000).toISOString(), who, text, at: who === 'event' ? null : at };
});
const base = (id, over) => ({
  id, direction: 'outbound', status: 'in_progress', phase: 'talking', finished: false, business: 'Northstar Internet', number: '+16562405137',
  goal: 'My bill went from $65 to $130 after a plan change I did not ask for. Get the plan change reversed and the extra charge credited. Ask for a reference number.',
  mode: 'handle', connect_when: null, reach: 'app_then_phone', listen_in: false, alert_on_human: true, recorded: true, leave_voicemail: true,
  calling_number: '+19186021019', human_at: null, owner: { state: 'none', via: null, alert_until: null, unreachable: false },
  open_questions: [], answered_questions: [], outcome: null, talk_seconds: 0, owner_seconds: 0, error: null,
  created_at: iso(11 * MIN), ended_at: null, transcript: [], next_line: 0, recordings: [], ...over,
});

function sampleCalls() {
  return [
    base('c_alert', { phase: 'connecting_owner', mode: 'transfer', owner: { state: 'alerting', via: 'app', alert_until: null, unreachable: false },
      transcript: [...holdLines(655), line(5, 18, 'them', 'Hi, thanks for holding, this is Maria in billing. How can I help?'),
        line(6, 15, 'ai', 'Hi, I am calling on behalf of Dana Reyes. One moment please, I am bringing them on the line.'), line(7, 14, 'event', 'alert sent')] }),
    base('c_talk', { business: 'Summit Health Insurance', number: '+18885550193', created_at: iso(12 * MIN),
      open_questions: [{ id: 'q_1', question: 'What is the service address on the account?' }],
      transcript: [...holdLines(715), line(5, 40, 'them', 'Thanks. And what is the service address on the account?'),
        line(6, 37, 'ai', 'One moment, let me check that.'), line(7, 36, 'event', 'asked owner: What is the service address on the account?')] }),
    base('c_hold', { business: 'Cascade Power & Light', number: '+15035550178', phase: 'on_hold', created_at: iso(4 * MIN), transcript: holdLines(230) }),
    base('c_phone', { business: 'Bayview Dental', number: '+14155550126', phase: 'owner_on_call', created_at: iso(6 * MIN),
      owner: { state: 'on_call', via: 'phone', alert_until: null, unreachable: false },
      transcript: [...holdLines(350), line(5, 30, 'event', 'owner took the call'), line(6, 20, 'owner', 'Hi, this is Dana. I would like to move my cleaning to next week.')] }),
    base('c_done', { status: 'completed', phase: null, finished: true, created_at: iso(60 * MIN), ended_at: iso(60 * MIN - (RECORDING_SECONDS + 6) * 1000), talk_seconds: RECORDING_SECONDS,
      outcome: { result: 'done', summary: 'Maria in billing moved the account back to the old plan and added a $65 credit, which shows on the next bill.', details: { reference_number: 'NS48213K', credit: '$65.00, next bill' } },
      answered_questions: [{ id: 'q_0', question: 'What is the service address on the account?', answer: '1820 SE Alder St, Apt 4, Portland OR 97214' }],
      recordings: [{ url: '/callenvoy/r/demo', duration_seconds: RECORDING_SECONDS }],
      transcript: doneLines(60 * MIN) }),
    base('c_handed', { business: 'City Water Billing', number: '+19715550110', status: 'completed', phase: null, finished: true, recorded: false,
      created_at: iso(26 * 60 * MIN), ended_at: iso(26 * 60 * MIN - 756_000), talk_seconds: 756, owner_seconds: 44,
      outcome: { result: 'handed_to_owner', summary: 'You took over after the AI gave the account number. The account was moved back to the old plan.', details: {} },
      transcript: [line(0, 93600, 'event', 'owner took the call'), line(1, 93590, 'owner', 'Great, thank you. Bye.')] }),
    base('c_failed', { business: 'Ridgeline Auto Insurance', number: '+18005550147', status: 'failed', phase: null, finished: true, created_at: iso(3 * 24 * 60 * MIN),
      ended_at: iso(3 * 24 * 60 * MIN), talk_seconds: 0, error: 'Twilio could not place the call: the number is not reachable.' }),
    base('c_in', { direction: 'inbound', business: 'Northstar Internet', number: '+16562405137', status: 'completed', phase: null, finished: true, recorded: false,
      created_at: iso(30 * MIN), ended_at: iso(28 * MIN), talk_seconds: 95, goal: '', calling_number: null }),
    // A business calling back right now: forwarded to the owner's phone.
    base('c_in_live', { direction: 'inbound', business: 'Northstar Internet', number: '+16562405137', phase: null, recorded: false,
      created_at: iso(MIN), talk_seconds: 60, goal: '', calling_number: null }),
  ];
}
let alertStart = Date.now();
let alertLen = 20_000;

function live(c) {
  // The alert repeats every 30 s so the countdown can be seen.
  if (c.id === 'c_alert' && (c.owner.state === 'alerting' || c.pending)) {
    if (Date.now() - alertStart > alertLen) alertStart = Date.now();
    c.owner.alert_until = new Date(alertStart + alertLen).toISOString();
  }
  if (!c.finished) c.talk_seconds = Math.round((Date.now() - Date.parse(c.created_at)) / 1000);
  // A call placed from the form moves dialing -> menu -> on hold.
  if (c.placedAt && !c.finished) {
    const s = (Date.now() - c.placedAt) / 1000;
    c.status = s < 4 ? 'dialing' : 'in_progress';
    c.phase = s < 4 ? null : s < 10 ? 'menu' : 'on_hold';
    if (s > 6 && c.transcript.length === 1) c.transcript.push(line(1, 0, 'them', `Thank you for calling ${c.business}. For billing, press 1.`));
    if (s > 9 && c.transcript.length === 2) c.transcript.push(line(2, 0, 'event', 'pressed 1'));
  }
  c.next_line = c.transcript.length;
  return c;
}

// ---- Users: each has their own calls, keys, profile and caller-ID state ----
const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // no look-alike characters
const newKey = () => 'ce_live_' + Array.from(crypto.randomBytes(32), (b) => ALPHABET[b % ALPHABET.length]).join('');
const withPrefix = (k) => ({ ...k, prefix: k.key.slice(0, 12) });
const DAY = 24 * 60 * MIN;
const newUser = (id, email, over = {}) => ({ id, email, created_at: iso(0), last_seen_at: iso(0), disabled: false, calls: [], keys: [], profile: newProfile(), verifiedAt: 0, ...over });
const users = [
  newUser('u_dana', OWNER_EMAIL, {
    created_at: iso(40 * DAY), last_seen_at: iso(2 * MIN), calls: sampleCalls(),
    profile: newProfile({ name: 'Dana Reyes', callback_number: '+15035550142', details: 'Home address: 1820 SE Alder St, Apt 4, Portland OR 97214', email: OWNER_EMAIL }),
    keys: [
      { id: 'k_env', name: 'First key (.env)', key: 'dev-key', created_at: iso(30 * DAY), last_used_at: iso(2 * DAY), disabled: false },
      { id: 'k_old', name: 'Old laptop, Claude Desktop with a long name', key: newKey(), created_at: iso(9 * DAY), last_used_at: null, disabled: true },
    ].map(withPrefix),
  }),
  newUser('u_sam', 'sam@example.com', { created_at: iso(3 * DAY), last_seen_at: iso(3 * DAY) }),
  newUser('u_long', 'alexandra.konstantinopoulou-whitfield@longdomain-example.org', {
    created_at: iso(12 * DAY), last_seen_at: iso(6 * DAY), disabled: true, profile: newProfile({ name: 'Alexandra Konstantinopoulou-Whitfield' }),
    calls: [base('c_l1', { status: 'completed', phase: null, finished: true, created_at: iso(7 * DAY), ended_at: iso(7 * DAY - 400_000), talk_seconds: 400 })],
  }),
];
const userByEmail = (email) => users.find((u) => u.email === email.toLowerCase());
const callById = (id) => users.flatMap((u) => u.calls).find((c) => c.id === id);
const verified = (u) => !!u.verifiedAt && Date.now() > u.verifiedAt; // caller ID: verified 10 s after Verify
let signupsOpen = true;
let adminFails = false;
const isToday = (iso) => new Date(iso).toDateString() === new Date().toDateString();
const minutes = (calls) => Math.round(calls.reduce((n, c) => n + (c.talk_seconds ?? 0), 0) / 60);
/** As GET /api/admin/users: usage only, no call content. */
const usage = (u) => ({
  id: u.id, email: u.email, name: u.profile.name, created_at: u.created_at, last_seen_at: u.last_seen_at, disabled: u.disabled,
  is_admin: u.email === OWNER_EMAIL, calls: u.calls.length, minutes: minutes(u.calls), minutes_today: minutes(u.calls.filter((c) => isToday(c.created_at))),
  live_calls: u.calls.filter((c) => !c.finished).length,
});

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': 'http://localhost:8081', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cookie = (req, name) => (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
const sessions = new Map(); // session id (the server stores it hashed) -> user id
const linkTokens = new Map(); // token -> { email, until } (one use, bound to one address)
const linkRequests = []; // [time, address] of POST /api/auth/request, for the rate limits
let mailReady = true;
let lastLink = null;
const newSession = (res, u) => {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, u.id);
  u.last_seen_at = iso(0);
  res.setHeader('set-cookie', `ce_session=${sid}; HttpOnly; SameSite=Strict; Path=/callenvoy; Max-Age=${30 * 86400}`);
};
const sessionUser = (req) => users.find((u) => u.id === sessions.get(cookie(req, 'ce_session'))) ?? null;
/** { user, kind: 'owner' | 'agent' }, or the 401 code. */
function credential(req) {
  const sid = cookie(req, 'ce_session');
  const su = sessionUser(req);
  if (su) return su.disabled ? 'account_disabled' : { user: su, kind: 'owner' };
  const h = req.headers.authorization;
  if (!h) return sid ? 'session_expired' : 'no_credential';
  const token = h.replace(/^(Bearer\s+)+/i, '').trim();
  const user = users.find((u) => u.keys.some((x) => x.key === token));
  const k = user?.keys.find((x) => x.key === token);
  if (!k) return 'bad_key';
  if (k.disabled) return 'key_disabled';
  if (user.disabled) return 'account_disabled';
  if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > MIN) k.last_used_at = iso(0); // at most once a minute
  return { user, kind: 'agent' };
}
const ERRORS = { no_credential: 'Sign in or send an API key.', session_expired: 'Your session has ended. Sign in again.', bad_key: 'Unknown API key.', key_disabled: 'This API key is disabled.',
  account_disabled: 'This account is disabled.' };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function auth(req, res, p) {
  if (p === '/api/auth/me') {
    const u = sessionUser(req);
    const on = !!u && !u.disabled;
    return send(res, 200, { signed_in: on, email: on ? u.email : null, mail_ready: mailReady, is_admin: on && u.email === OWNER_EMAIL, signups_open: signupsOpen, first_run: on && !u.profile.name });
  }
  if (p === '/api/auth/request' && req.method === 'POST') {
    const email = String((await readBody(req)).email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return send(res, 400, { error: 'Enter a valid email address.', code: 'bad_email' });
    const u = userByEmail(email);
    if (u?.disabled) return send(res, 403, { error: 'This account is disabled.', code: 'account_disabled' });
    if (!u && !signupsOpen) return send(res, 403, { error: 'New accounts are closed right now.', code: 'signups_closed' });
    // As config.py: 3 per address per hour, 60 per day in total (the mock has one client IP, so no IP limit).
    while (linkRequests.length && linkRequests[0][0] < Date.now() - DAY) linkRequests.shift();
    if (linkRequests.length >= 60 || linkRequests.filter(([t, a]) => a === email && t > Date.now() - 60 * MIN).length >= 3)
      return send(res, 429, { error: 'Too many sign-in requests. Try again later.', code: 'rate_limited' });
    linkRequests.push([Date.now(), email]);
    if (mailReady) {
      const t = crypto.randomBytes(24).toString('hex');
      linkTokens.set(t, { email, until: Date.now() + 15 * MIN });
      lastLink = `http://localhost:${PORT}/callenvoy/signin?token=${t}`;
      console.log(`sign-in link for ${email}: ${lastLink}`);
    }
    return send(res, 200, { ok: true });
  }
  if (p === '/api/auth/verify' && req.method === 'POST') {
    const { token } = await readBody(req);
    const link = linkTokens.get(token);
    linkTokens.delete(token);
    if (!link || link.until < Date.now()) return send(res, 400, { error: 'This sign-in link was used or has expired.', code: 'bad_link' });
    let u = userByEmail(link.email);
    if (u?.disabled) return send(res, 403, { error: 'This account is disabled.', code: 'account_disabled' });
    if (!u) users.push((u = newUser(`u_${crypto.randomBytes(4).toString('hex')}`, link.email))); // the account starts at the first sign-in
    newSession(res, u);
    return send(res, 200, { ok: true, email: u.email });
  }
  if (p === '/api/auth/sign-out' && req.method === 'POST') {
    sessions.delete(cookie(req, 'ce_session'));
    res.setHeader('set-cookie', 'ce_session=; HttpOnly; SameSite=Strict; Path=/callenvoy; Max-Age=0');
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { detail: 'Not found' });
}

/** Admin routes (round 3 A4): 404 for everyone but the admin; usage only. */
async function adminRoutes(req, res, p, me) {
  if (me.email !== OWNER_EMAIL) return send(res, 404, { detail: 'Not found' });
  const m = req.method;
  if (p === '/api/admin/users' && m === 'GET') {
    if (adminFails) return send(res, 500, { detail: 'The user list could not be loaded.' });
    return send(res, 200, { signups_open: signupsOpen, users: users.map(usage) });
  }
  if (p === '/api/admin/settings' && m === 'PUT') {
    const b = await readBody(req);
    if (typeof b.signups_open !== 'boolean') return send(res, 400, { detail: 'signups_open must be true or false.', field: 'signups_open' });
    signupsOpen = b.signups_open;
    return send(res, 200, { signups_open: signupsOpen });
  }
  const u = users.find((x) => x.id === /^\/api\/admin\/users\/([^/]+)$/.exec(p)?.[1]);
  if (!u) return send(res, 404, { detail: 'No user with that id.' });
  if (u === me) return send(res, 400, { detail: 'You cannot disable or remove your own account.' });
  // Live calls of that user are hung up first.
  const hangUpAll = () => u.calls.filter((c) => !c.finished).forEach((c) => Object.assign(c, { finished: true, status: 'canceled', phase: null, ended_at: iso(0) }));
  if (m === 'PATCH') {
    const b = await readBody(req);
    if (typeof b.disabled !== 'boolean') return send(res, 400, { detail: 'disabled must be true or false.', field: 'disabled' });
    u.disabled = b.disabled;
    if (u.disabled) hangUpAll();
    return send(res, 200, usage(u));
  }
  if (m === 'DELETE') {
    hangUpAll();
    users.splice(users.indexOf(u), 1);
    for (const [sid, id] of sessions) if (id === u.id) sessions.delete(sid);
    return send(res, 204);
  }
  return send(res, 404, { detail: 'Not found' });
}

const keyView = ({ key, ...k }) => k;

async function keyRoutes(req, res, p, { keys }) {
  const m = req.method;
  if (p === '/api/keys' && m === 'GET') return send(res, 200, { keys: keys.map(keyView) });
  if (p === '/api/keys' && m === 'POST') {
    const name = String((await readBody(req)).name ?? '').trim();
    if (!name || name.length > 40) return send(res, 400, { detail: 'The name must be 1-40 characters.', field: 'name' });
    if (keys.length >= 20) return send(res, 409, { detail: 'At most 20 keys. Delete one first.' });
    const key = newKey();
    const k = { id: `k_${crypto.randomBytes(4).toString('hex')}`, name, key, prefix: key.slice(0, 12), created_at: iso(0), last_used_at: null, disabled: false };
    keys.push(k);
    return send(res, 201, { ...keyView(k), key });
  }
  const k = keys.find((x) => x.id === p.split('/')[3]);
  if (!k) return send(res, 404, { detail: 'No key with that id.' });
  if (m === 'PATCH') {
    const b = await readBody(req);
    if (typeof b.disabled === 'boolean') k.disabled = b.disabled;
    if (typeof b.name === 'string' && b.name.trim()) k.name = b.name.trim().slice(0, 40);
    return send(res, 200, keyView(k));
  }
  if (m === 'DELETE') {
    keys.splice(keys.indexOf(k), 1);
    return send(res, 204);
  }
  return send(res, 404, { detail: 'Not found' });
}

/** /r/demo with Range support (206, Accept-Ranges, Content-Range), as the server serves the cached mp3. */
function recording(req, res) {
  if (recordingFails || !RECORDING.length) return send(res, 404, { detail: 'No such recording.' });
  const size = RECORDING.length;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  const head = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes' };
  if (!m) {
    res.writeHead(200, { ...head, 'content-length': size });
    return res.end(RECORDING);
  }
  let start = m[1] ? Number(m[1]) : size - Number(m[2]);
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  end = Math.min(end, size - 1);
  if (start > end || start < 0) {
    res.writeHead(416, { 'content-range': `bytes */${size}` });
    return res.end();
  }
  res.writeHead(206, { ...head, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
  res.end(RECORDING.subarray(start, end + 1));
}

const tickets = new Set();
const sockets = new Map(); // call id -> the open audio socket
const counts = {}; // call id -> GET /api/calls/<id> requests

async function api(req, res, p, q) {
  if (p.startsWith('/api/auth/')) return auth(req, res, p);
  const cred = credential(req);
  if (typeof cred === 'string') return send(res, 401, { error: ERRORS[cred], code: cred });
  const { user: u, kind: who } = cred;
  const { profile, calls } = u;
  // As the server: keys, push, admin and the audio ticket (it lets its holder hear and speak on a call) need a console session.
  const ownerOnly = p.startsWith('/api/keys') || p.startsWith('/api/push/') || p.startsWith('/api/admin/') || p.endsWith('/audio-ticket');
  if (who === 'agent' && ownerOnly) return send(res, 403, { error: 'agent keys cannot use this; sign in to the console', code: 'owner_only' });
  const origin = req.headers.origin;
  if (who === 'owner' && req.method !== 'GET' && origin && origin !== `http://localhost:${PORT}`) return send(res, 403, { detail: 'Wrong origin.' });
  if (p.startsWith('/api/keys')) return keyRoutes(req, res, p, u);
  if (p.startsWith('/api/admin/')) return adminRoutes(req, res, p, u);
  const m = req.method;
  if (p === '/api/config') return send(res, 200, { app_name: 'CallEnvoy', mcp_url: 'https://pragnyalabs.com/callenvoy/mcp', voices: VOICES, demo: DEMO,
    limits: { max_call_minutes: 120, max_concurrent_calls: 2, daily_minute_cap: DAILY_MINUTE_CAP, // As the server: the service's minutes today (the shared cap), and this user's own.
      minutes_used_today: users.reduce((n, x) => n + usage(x).minutes_today, 0), my_minutes_today: minutes(calls.filter((c) => isToday(c.created_at))) },
    defaults: Object.fromEntries(Object.keys(profile).map((k) => [k, null])), // not used by the console
    choices: { caller_id: ['callenvoy', 'own'], mode: ['handle', 'transfer'], reach: ['app', 'phone', 'app_then_phone'], no_answer: ['ai_handles', 'end_politely'] },
    ranges: RANGES, text_limits: TEXT_LIMITS, vapid_public_key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' });
  if (p === '/api/profile' && m === 'GET') return send(res, 200, profile);
  if (p === '/api/profile' && m === 'PUT') {
    const b = await readBody(req);
    if (b.max_minutes != null && (b.max_minutes < 1 || b.max_minutes > 120)) return send(res, 400, { detail: 'max_minutes must be 1-120.', field: 'max_minutes' });
    if (b.caller_id === 'own' && !verified(u)) return send(res, 400, { detail: 'Verify your callback number before you use it as caller ID.', field: 'caller_id' });
    for (const [k, v] of Object.entries(b)) if (TEXT_LIMITS[k] && typeof v === 'string' && v.length > TEXT_LIMITS[k]) return send(res, 400, { detail: `At most ${TEXT_LIMITS[k]} characters.`, field: k });
    if (/^x+$/i.test(b.vin ?? '')) return send(res, 400, { detail: 'That is not a VIN.', field: 'vin' }); // to see a field error inside a closed group
    // As save_profile: null is skipped, "" clears the field.
    for (const [k, v] of Object.entries(b)) if (v !== null && k in profile) profile[k] = v === '' ? null : v;
    return send(res, 200, profile);
  }
  if (p === '/api/caller-id') return send(res, 200, { number: profile.callback_number || null, verified: verified(u) });
  if (p === '/api/caller-id/verify') {
    if (verified(u)) return send(res, 200, { validation_code: null }); // already verified with Twilio
    u.verifiedAt = Date.now() + 10_000;
    return send(res, 200, { validation_code: '482913' });
  }
  if (p === '/api/push/test') return send(res, 200, { sent: 2 });
  if (p === '/api/push/subscriptions') return send(res, 200, { ok: true });
  if (p === '/api/calls' && m === 'GET') return send(res, 200, calls.map((c) => ({ ...live(c), transcript: undefined })));
  if (p === '/api/calls' && m === 'POST') {
    const b = await readBody(req);
    if (!profile.name) return send(res, 400, { detail: 'Set your name first (Settings, or callenvoy_save_profile): the AI says who it calls for.' });
    // Shared service limits: the message says nothing about other users.
    if (/limit/i.test(b.goal ?? '')) return send(res, 429, { error: "The service's daily limit of call minutes is reached. Try again tomorrow.", code: 'daily_limit' });
    if (/busy/i.test(b.goal ?? '')) return send(res, 429, { error: 'The service is busy with other calls. Try again in a few minutes.', code: 'service_busy' });
    if (b.reach === 'phone' && b.mode === 'transfer' && !profile.callback_number) return send(res, 400, { detail: 'Transfer by phone needs a callback number. Add one in Settings, or choose App.', field: 'reach' });
    const id = `c_${crypto.randomBytes(4).toString('hex')}`;
    calls.unshift(base(id, { ...b, number: b.to, status: 'queued', phase: null, created_at: iso(0), placedAt: Date.now(), recorded: b.record ?? true,
      calling_number: b.from === 'own' && b.to !== DEMO.number ? profile.callback_number : '+19186021019', /* the demo line answers only the CallEnvoy number */ transcript: [line(0, 0, 'event', `Dialing ${b.to}`)] }));
    return send(res, 200, { id });
  }
  const cm = /^\/api\/calls\/([^/]+)(?:\/([a-z-]+))?$/.exec(p);
  const c = cm && calls.find((x) => x.id === cm[1]);
  if (cm && !c) return send(res, 404, { detail: 'No call with that id.' });
  if (c && !cm[2]) {
    counts[c.id] = (counts[c.id] ?? 0) + 1;
    if (Number(q.get('wait_seconds')) > 0 && !c.finished) await sleep(2000); // a short stand-in for the long-poll
    const since = Number(q.get('since_line') ?? 0);
    live(c);
    return send(res, 200, { ...c, transcript: c.transcript.filter((l) => l.n >= since) });
  }
  const ok = (message) => send(res, 200, { ok: true, message });
  switch (cm?.[2]) {
    case 'hang-up': sockets.get(c.id)?.end('ended'); Object.assign(c, { finished: true, status: 'completed', phase: null, ended_at: iso(0), outcome: { result: 'not_done', summary: 'You hung up the call.', details: {} } }); c.owner.state = 'none'; return ok('Hung up.');
    case 'answer': { const b = await readBody(req); const qn = c.open_questions.find((x) => x.id === b.question_id); if (qn) { c.open_questions = c.open_questions.filter((x) => x !== qn); c.answered_questions.push({ ...qn, answer: b.answer }); c.transcript.push(line(c.transcript.length, 0, 'event', 'owner answered')); } return ok('Sent.'); }
    case 'connect': c.pending = false; c.owner = { ...c.owner, state: 'ringing', via: 'phone', alert_until: null }; // an open browser socket stays open c.transcript.push(line(c.transcript.length, 0, 'event', 'ringing owner')); return ok('Ringing.');
    case 'hand-back': c.owner = { ...c.owner, state: 'none', via: null }; c.phase = 'talking'; c.transcript.push(line(c.transcript.length, 0, 'event', 'owner handed the call back')); return ok('Handed back.');
    case 'audio-ticket': { const t = crypto.randomBytes(16).toString('hex'); tickets.add(`${c.id}:${t}`); return send(res, 200, { ticket: t, expires_in: 30 }); }
  }
  return send(res, 404, { detail: 'Not found' });
}

// Minimal WebSocket for /callenvoy/audio/<id>: state messages and a 440 Hz tone as call audio.
function audioSocket(req, socket) {
  const id = decodeURIComponent(req.url.split('/').pop());
  const c = callById(id);
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const frame = (op, data) => { const len = data.length; const head = len < 126 ? Buffer.from([0x80 | op, len]) : Buffer.from([0x80 | op, 126, len >> 8, len & 255]); socket.write(Buffer.concat([head, data])); };
  const state = (owner) => { if (c) {
    // Listening during a pending hand-over keeps alert_until: the fallback still fires then.
    c.pending = owner === 'listening' && (c.owner.state === 'alerting' || c.pending);
    c.owner = { ...c.owner, state: owner, via: 'app', alert_until: c.pending ? c.owner.alert_until : null }; c.phase = owner === 'on_call' ? 'owner_on_call' : 'talking'; c.transcript.push(line(c.transcript.length, 0, 'event', owner === 'on_call' ? 'owner took the call' : 'owner is listening')); } frame(1, Buffer.from(JSON.stringify({ type: 'state', owner, phase: c?.phase ?? null }))); };
  let authed = false; let t = 0; let timer; const mic = { n: 0, bytes: 0 };
  const json = (m) => frame(1, Buffer.from(JSON.stringify(m)));
  let gone = false; // closed on purpose (by the client or by us)
  // Server messages: ended / replaced, then close.
  const link = { end: (type) => { gone = true; json({ type }); clearInterval(timer); frame(8, Buffer.alloc(0)); socket.end(); },
    error: (message) => json({ type: 'error', message }), drop: () => socket.destroy() };
  socket.on('data', (buf) => {
    for (let i = 0; i < buf.length;) { // parse client frames (always masked)
      const op = buf[i] & 15; let len = buf[i + 1] & 127; let o = i + 2;
      if (len === 126) { len = buf.readUInt16BE(o); o += 2; } else if (len === 127) { len = Number(buf.readBigUInt64BE(o)); o += 8; }
      const mask = buf.subarray(o, o + 4); const data = Buffer.from(buf.subarray(o + 4, o + 4 + len)).map((b, k) => b ^ mask[k % 4]); i = o + 4 + len;
      if (op === 8) { gone = true; clearInterval(timer); if (c) c.owner = { ...c.owner, state: 'none', via: null }; return socket.end(); }
      if (op === 2) { mic.n++; mic.bytes = len; continue; } // microphone audio: counted, then dropped
      if (op !== 1) continue;
      const msg = JSON.parse(data.toString());
      if (!authed) {
        if (!c || !tickets.delete(`${id}:${msg.ticket}`)) return socket.end();
        authed = true;
        sockets.get(id)?.end('replaced'); // one browser link per call: the older one is told and closed
        sockets.set(id, link);
        // A reconnect within the grace keeps the call; otherwise the owner starts as a listener.
        if (c.owner.state === 'on_call' && c.owner.via === 'app') { clearTimeout(c.grace); json({ type: 'state', owner: 'on_call', phase: c.phase }); }
        else state('listening');
        timer = setInterval(() => { const pcm = Buffer.alloc(640); for (let k = 0; k < 320; k++, t++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * t) / 8000) * 6000 * (0.5 + 0.5 * Math.sin(t / 4000))), k * 2); frame(2, pcm); }, 40);
      } else if (msg.type === 'join') { if (c.owner.state !== 'on_call') state('on_call'); } // join is a no-op when already on the call
      else if (msg.type === 'hand_back') state('listening');
    }
  });
  socket.on('close', () => {
    clearInterval(timer);
    if (sockets.get(id) === link) sockets.delete(id);
    // Dropped while on the call: the server waits 5 s (OWNER_DROP_GRACE_SECONDS), then hands back.
    if (!gone && c?.owner.state === 'on_call' && c.owner.via === 'app') c.grace = setTimeout(() => { c.owner = { ...c.owner, state: 'none', via: null }; c.phase = 'talking'; }, 5000);
    else if (!gone && c && sockets.get(id) == null && c.owner.via === 'app') c.owner = { ...c.owner, state: 'none', via: null }; if (mic.n) console.log(`audio ${id}: ${mic.n} mic messages of ${mic.bytes} bytes`); });
  socket.on('error', () => clearInterval(timer));
}

const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.css': 'text/css', '.ttf': 'font/ttf' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204);
  if (url.pathname === '/__mock/socket') {
    const l = sockets.get(url.searchParams.get('id')); const what = url.searchParams.get('send');
    if (!l) return send(res, 404, { detail: 'No open socket.' });
    if (what === 'error') l.error('You do not have the call.'); else if (what === 'drop') l.drop(); else l.end('replaced');
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__mock/alert') {
    const c = callById(url.searchParams.get('id')); if (!c) return send(res, 404, {});
    const on = url.searchParams.get('state') === 'alerting'; alertStart = Date.now(); alertLen = 1000 * Number(url.searchParams.get('seconds') ?? 20);
    c.owner = { state: on ? 'alerting' : 'none', via: on ? 'app' : null, alert_until: null, unreachable: false };
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/__mock/signin') {
    newSession(res, userByEmail(`${url.searchParams.get('as') ?? 'dana'}@example.com`) ?? users[0]);
    res.writeHead(302, { location: '/callenvoy/' });
    return res.end();
  }
  if (url.pathname === '/__mock/last-link') return send(res, 200, { url: lastLink });
  if (url.pathname === '/__mock/mail') { mailReady = url.searchParams.get('ready') !== '0'; return send(res, 200, { mail_ready: mailReady }); }
  if (url.pathname === '/__mock/expire') { sessions.clear(); return send(res, 200, { ok: true }); }
  if (url.pathname === '/__mock/recording') {
    const q = url.searchParams;
    if (q.has('fail')) recordingFails = q.get('fail') === '1';
    if (q.has('unknown')) for (const c of users.flatMap((u) => u.calls)) for (const r of c.recordings ?? []) r.duration_seconds = q.get('unknown') === '1' ? 0 : RECORDING_SECONDS;
    return send(res, 200, { fail: recordingFails });
  }
  if (url.pathname === '/__mock/count') return send(res, 200, { count: counts[url.searchParams.get('id')] ?? 0 });
  if (url.pathname === '/__mock/calls') {
    const u = userByEmail(`${url.searchParams.get('as') ?? 'dana'}@example.com`); if (!u) return send(res, 404, {});
    u.calls = url.searchParams.get('set') === 'empty' ? [] : sampleCalls(); return send(res, 200, { calls: u.calls.length });
  }
  if (url.pathname === '/__mock/admin') { adminFails = url.searchParams.get('fail') === '1'; return send(res, 200, { fail: adminFails }); }
  if (!url.pathname.startsWith('/callenvoy')) return send(res, 404, { detail: 'Not found' });
  const p = url.pathname.slice('/callenvoy'.length) || '/';
  if (p.startsWith('/api/')) return api(req, res, p, url.searchParams);
  if (p === '/r/demo') return recording(req, res);
  if (p.startsWith('/r/')) return send(res, 404, { detail: 'No such recording.' });
  if (p.startsWith('/static/voices/')) {
    const f = path.join(VOICE_DIR, path.basename(p));
    if (!fs.existsSync(f)) return send(res, 404, { detail: 'No sample.' });
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    return fs.createReadStream(f).pipe(res);
  }
  let f = path.join(DIST, path.normalize(p));
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); // single-page app
  if (!fs.existsSync(f)) return send(res, 503, { detail: 'Run `pnpm --dir client exec expo export --platform web` first.' });
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});
server.on('upgrade', (req, socket) => (req.url.startsWith('/callenvoy/audio/') ? audioSocket(req, socket) : socket.destroy()));
server.listen(PORT, () => console.log(`mock CallEnvoy on http://localhost:${PORT}/callenvoy/  (sign in: ${OWNER_EMAIL} or sam@example.com, or open /__mock/signin?as=sam; agent key: dev-key)`));
