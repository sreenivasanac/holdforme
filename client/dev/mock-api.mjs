// Dev-only mock of the CallEnvoy console API (plan sections 4, 4a, 10a, 22) with sample calls.
// Not part of the export. Serves client/dist under /callenvoy too, so the real export can be checked.
//   node dev/mock-api.mjs            -> http://localhost:3020/callenvoy/   (API key: dev-key)
//   POST /__mock/calls?set=empty|many  switches the call list
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 3020);
const KEY = 'dev-key';
const DIST = path.resolve(import.meta.dirname, '../dist');
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

const profile = {
  name: 'Dana Reyes', callback_number: '+15035550142', details: 'Home address: 1820 SE Alder St, Apt 4, Portland OR 97214',
  voice: 'Hannah', record_calls: true, max_minutes: 30, mode: 'handle', reach: 'app_then_phone', alert_wait_seconds: 20,
  phone_ring_seconds: 25, no_answer: 'ai_handles', alert_on_human: true, listen_in: false, alert_sound: true,
  alert_notification: true, alert_push: true, push_shows_business: true, caller_id: 'callenvoy', leave_voicemail: true,
  name_pronunciation: '', assistant_name: '', email: 'dana@example.com', address: '', date_of_birth: '',
  insurance_carrier: '', insurance_member_id: '', insurance_group_number: '', dental_insurance_carrier: '',
  dental_insurance_member_id: '', vehicle: '', vin: '', frequent_flyer_numbers: '', known_traveler_number: '', redress_number: '',
};
let verifiedAt = 0; // caller ID: verified 10 s after Verify

const line = (n, sAgo, who, text) => ({ n, t: iso(sAgo * 1000), who, text });
const holdLines = (s) => [
  line(0, s, 'event', 'Dialing +1 (656) 240-5137'),
  line(1, s - 4, 'them', 'Thank you for calling Northstar Internet. For billing, press 1. For technical support, press 2.'),
  line(2, s - 6, 'event', 'pressed 1'),
  line(3, s - 19, 'them', 'All of our agents are busy. Your call is important to us. Please continue to hold.'),
  line(4, s - 20, 'event', 'waiting on hold'),
];
const base = (id, over) => ({
  id, direction: 'outbound', status: 'in_progress', phase: 'talking', finished: false, business: 'Northstar Internet', number: '+16562405137',
  goal: 'My bill went from $65 to $130 after a plan change I did not ask for. Get the plan change reversed and the extra charge credited. Ask for a reference number.',
  mode: 'handle', connect_when: null, reach: 'app_then_phone', listen_in: false, alert_on_human: true, recorded: true, leave_voicemail: true,
  calling_number: '+19186021019', human_at: null, owner: { state: 'none', via: null, alert_until: null, unreachable: false },
  open_questions: [], answered_questions: [], outcome: null, talk_seconds: null, owner_seconds: null, error: null,
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
    base('c_done', { status: 'completed', phase: null, finished: true, created_at: iso(60 * MIN), ended_at: iso(47 * MIN), talk_seconds: 796,
      outcome: { result: 'done', summary: 'Maria in billing moved the account back to the old plan and added a $65 credit, which shows on the next bill.', details: { reference_number: 'NS48213K', credit: '$65.00, next bill' } },
      answered_questions: [{ id: 'q_0', question: 'What is the service address on the account?', answer: '1820 SE Alder St, Apt 4, Portland OR 97214' }],
      recordings: [{ url: '/callenvoy/r/demo', duration_seconds: 796 }],
      transcript: [...holdLines(3600), line(5, 2900, 'ai', 'N S 4 8 2 1 3 K. Thanks so much, Maria. Goodbye.'), line(6, 2890, 'event', 'call ended by AI')] }),
    base('c_handed', { business: 'City Water Billing', number: '+19715550110', status: 'completed', phase: null, finished: true, recorded: false,
      created_at: iso(26 * 60 * MIN), ended_at: iso(26 * 60 * MIN - 756_000), talk_seconds: 756, owner_seconds: 44,
      outcome: { result: 'handed_to_owner', summary: 'You took over after the AI gave the account number. The account was moved back to the old plan.', details: {} },
      transcript: [line(0, 93600, 'event', 'owner took the call'), line(1, 93590, 'owner', 'Great, thank you. Bye.')] }),
    base('c_failed', { business: 'Ridgeline Auto Insurance', number: '+18005550147', status: 'failed', phase: null, finished: true, created_at: iso(3 * 24 * 60 * MIN),
      ended_at: iso(3 * 24 * 60 * MIN), talk_seconds: 0, error: 'Twilio could not place the call: the number is not reachable.' }),
    base('c_in', { direction: 'inbound', business: 'Northstar Internet', number: '+16562405137', status: 'completed', phase: null, finished: true, recorded: false,
      created_at: iso(30 * MIN), ended_at: iso(28 * MIN), talk_seconds: 95, goal: '', calling_number: null }),
  ];
}
let calls = sampleCalls();
let alertStart = Date.now();

function live(c) {
  // The alert repeats every 30 s so the countdown can be seen.
  if (c.id === 'c_alert' && c.owner.state === 'alerting') {
    if (Date.now() - alertStart > 20_000) alertStart = Date.now();
    c.owner.alert_until = new Date(alertStart + 20_000).toISOString();
  }
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

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': 'http://localhost:8081', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT, DELETE' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tickets = new Set();

async function api(req, res, p, q) {
  if (req.headers.authorization !== `Bearer ${KEY}`) return send(res, 401, { detail: 'Unauthorized' });
  const m = req.method;
  if (p === '/api/config') return send(res, 200, { app_name: 'CallEnvoy', mcp_url: 'https://pragnyalabs.com/callenvoy/mcp', voices: VOICES,
    limits: { max_call_minutes: 120, max_concurrent_calls: 2, daily_minute_cap: 240, minutes_used_today: 34 }, vapid_public_key: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U' });
  if (p === '/api/profile' && m === 'GET') return send(res, 200, profile);
  if (p === '/api/profile' && m === 'PUT') {
    const b = await readBody(req);
    if (b.max_minutes != null && (b.max_minutes < 1 || b.max_minutes > 120)) return send(res, 400, { detail: 'max_minutes must be 1-120.', field: 'max_minutes' });
    if (b.caller_id === 'own' && !(verifiedAt && Date.now() > verifiedAt)) return send(res, 400, { detail: 'Verify your callback number before you use it as caller ID.', field: 'caller_id' });
    Object.assign(profile, b);
    return send(res, 200, profile);
  }
  if (p === '/api/caller-id') return send(res, 200, { number: profile.callback_number || null, verified: !!verifiedAt && Date.now() > verifiedAt });
  if (p === '/api/caller-id/verify') { verifiedAt = Date.now() + 10_000; return send(res, 200, { validation_code: '482913' }); }
  if (p === '/api/push/test') return send(res, 200, { sent: 2 });
  if (p === '/api/push/subscriptions') return send(res, 200, { ok: true });
  if (p === '/api/calls' && m === 'GET') return send(res, 200, calls.map((c) => ({ ...live(c), transcript: undefined })));
  if (p === '/api/calls' && m === 'POST') {
    const b = await readBody(req);
    if (/limit/i.test(b.goal ?? '')) return send(res, 429, { detail: 'The daily limit of 240 call minutes is reached. Try again tomorrow.' });
    if (b.reach === 'phone' && b.mode === 'transfer' && !profile.callback_number) return send(res, 400, { detail: 'Transfer by phone needs a callback number. Add one in Settings, or choose App.', field: 'reach' });
    const id = `c_${crypto.randomBytes(4).toString('hex')}`;
    calls.unshift(base(id, { ...b, number: b.to, status: 'queued', phase: null, created_at: iso(0), placedAt: Date.now(), recorded: b.record ?? true,
      calling_number: b.from === 'own' ? profile.callback_number : '+19186021019', transcript: [line(0, 0, 'event', `Dialing ${b.to}`)] }));
    return send(res, 200, { id });
  }
  const cm = /^\/api\/calls\/([^/]+)(?:\/([a-z-]+))?$/.exec(p);
  const c = cm && calls.find((x) => x.id === cm[1]);
  if (cm && !c) return send(res, 404, { detail: 'No call with that id.' });
  if (c && !cm[2]) {
    if (Number(q.get('wait_seconds')) > 0 && !c.finished) await sleep(2000); // a short stand-in for the long-poll
    const since = Number(q.get('since_line') ?? 0);
    live(c);
    return send(res, 200, { ...c, transcript: c.transcript.filter((l) => l.n >= since) });
  }
  const ok = (message) => send(res, 200, { ok: true, message });
  switch (cm?.[2]) {
    case 'hang-up': Object.assign(c, { finished: true, status: 'completed', phase: null, ended_at: iso(0), outcome: { result: 'not_done', summary: 'You hung up the call.', details: {} } }); c.owner.state = 'none'; return ok('Hung up.');
    case 'answer': { const b = await readBody(req); const qn = c.open_questions.find((x) => x.id === b.question_id); if (qn) { c.open_questions = c.open_questions.filter((x) => x !== qn); c.answered_questions.push({ ...qn, answer: b.answer }); c.transcript.push(line(c.transcript.length, 0, 'event', 'owner answered')); } return ok('Sent.'); }
    case 'connect': c.owner = { ...c.owner, state: 'ringing', via: 'phone', alert_until: null }; c.transcript.push(line(c.transcript.length, 0, 'event', 'ringing owner')); return ok('Ringing.');
    case 'hand-back': c.owner = { ...c.owner, state: 'none', via: null }; c.phase = 'talking'; c.transcript.push(line(c.transcript.length, 0, 'event', 'owner handed the call back')); return ok('Handed back.');
    case 'audio-ticket': { const t = crypto.randomBytes(16).toString('hex'); tickets.add(`${c.id}:${t}`); return send(res, 200, { ticket: t, expires_in: 30 }); }
  }
  return send(res, 404, { detail: 'Not found' });
}

// Minimal WebSocket for /callenvoy/audio/<id>: state messages and a 440 Hz tone as call audio.
function audioSocket(req, socket) {
  const id = decodeURIComponent(req.url.split('/').pop());
  const c = calls.find((x) => x.id === id);
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const frame = (op, data) => { const len = data.length; const head = len < 126 ? Buffer.from([0x80 | op, len]) : Buffer.from([0x80 | op, 126, len >> 8, len & 255]); socket.write(Buffer.concat([head, data])); };
  const state = (owner) => { if (c) { c.owner = { ...c.owner, state: owner, via: 'app', alert_until: null }; c.phase = owner === 'on_call' ? 'owner_on_call' : 'talking'; c.transcript.push(line(c.transcript.length, 0, 'event', owner === 'on_call' ? 'owner took the call' : 'owner is listening')); } frame(1, Buffer.from(JSON.stringify({ type: 'state', owner, phase: c?.phase ?? null }))); };
  let authed = false; let t = 0; let timer; const mic = { n: 0, bytes: 0 };
  socket.on('data', (buf) => {
    for (let i = 0; i < buf.length;) { // parse client frames (always masked)
      const op = buf[i] & 15; let len = buf[i + 1] & 127; let o = i + 2;
      if (len === 126) { len = buf.readUInt16BE(o); o += 2; } else if (len === 127) { len = Number(buf.readBigUInt64BE(o)); o += 8; }
      const mask = buf.subarray(o, o + 4); const data = Buffer.from(buf.subarray(o + 4, o + 4 + len)).map((b, k) => b ^ mask[k % 4]); i = o + 4 + len;
      if (op === 8) { clearInterval(timer); if (c) c.owner = { ...c.owner, state: 'none', via: null }; return socket.end(); }
      if (op === 2) { mic.n++; mic.bytes = len; continue; } // microphone audio: counted, then dropped
      if (op !== 1) continue;
      const msg = JSON.parse(data.toString());
      if (!authed) {
        if (!c || !tickets.delete(`${id}:${msg.ticket}`)) return socket.end();
        authed = true; state('listening');
        timer = setInterval(() => { const pcm = Buffer.alloc(640); for (let k = 0; k < 320; k++, t++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * t) / 8000) * 6000 * (0.5 + 0.5 * Math.sin(t / 4000))), k * 2); frame(2, pcm); }, 40);
      } else if (msg.type === 'join') state('on_call');
      else if (msg.type === 'hand_back') state('listening');
    }
  });
  socket.on('close', () => { clearInterval(timer); if (mic.n) console.log(`audio ${id}: ${mic.n} mic messages of ${mic.bytes} bytes`); });
  socket.on('error', () => clearInterval(timer));
}

const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.css': 'text/css', '.ttf': 'font/ttf' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') return send(res, 204);
  if (url.pathname === '/__mock/calls') { const set = url.searchParams.get('set'); calls = set === 'empty' ? [] : sampleCalls(); return send(res, 200, { calls: calls.length }); }
  if (!url.pathname.startsWith('/callenvoy')) return send(res, 404, { detail: 'Not found' });
  const p = url.pathname.slice('/callenvoy'.length) || '/';
  if (p.startsWith('/api/')) return api(req, res, p, url.searchParams);
  if (p.startsWith('/static/voices/') || p.startsWith('/r/')) return send(res, 404, { detail: 'No sample audio in the mock.' });
  let f = path.join(DIST, path.normalize(p));
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); // single-page app
  if (!fs.existsSync(f)) return send(res, 503, { detail: 'Run `pnpm --dir client exec expo export --platform web` first.' });
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});
server.on('upgrade', (req, socket) => (req.url.startsWith('/callenvoy/audio/') ? audioSocket(req, socket) : socket.destroy()));
server.listen(PORT, () => console.log(`mock CallEnvoy on http://localhost:${PORT}/callenvoy/  (key: ${KEY})`));
