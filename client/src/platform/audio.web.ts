// Web owner audio (plan section 10a): one WebSocket with raw PCM.
// Down: 8 kHz 16-bit mono, 40 ms blocks. Up: 16 kHz 16-bit mono, 20 ms blocks, only while on the call.
// TODO: audio.native.ts with a raw PCM module; same socket and messages.
import { API_BASE, WEB_BASE, type OwnerState, type Phase } from '../api';
import { DOWN_HZ, int16ToFloat, level, makeChunker, makeDownsampler } from '../pcm';

const START_BUFFER = 0.08; // s of audio queued before playing
const MAX_QUEUE = 0.4; // s; more than this and the queued (old) audio is dropped to catch up
const LEVEL_MS = 80; // level meters update about 12 times a second

export type MicResult = 'ok' | 'denied' | 'error' | 'closed';

export type AudioEvents = {
  onState: (owner: OwnerState, phase: Phase) => void;
  onEnded: () => void;
  /** Another link (the phone, another tab) took the call; the socket closes and must not reconnect. */
  onReplaced: () => void;
  /** The server refused join or hand_back. */
  onError: (message: string) => void;
  onClose: (unexpected: boolean) => void;
  onLevel: (callLevel: number) => void;
  onMicLevel: (micLevel: number) => void;
};

export type AudioLink = {
  join: () => void;
  handBack: () => void;
  startMic: () => Promise<MicResult>;
  setMuted: (muted: boolean) => void;
  close: () => void;
};

/** Calls `cb` with the highest level seen, at most every LEVEL_MS. */
function throttled(cb: (l: number) => void) {
  let last = 0;
  let peak = 0;
  return (l: number) => {
    peak = Math.max(peak, l);
    const now = performance.now();
    if (now - last < LEVEL_MS) return;
    cb(peak);
    last = now;
    peak = 0;
  };
}

/** Opens the owner audio socket. Must be called from a click (browsers start audio only then). */
export function openAudio(callId: string, ticket: string, ev: AudioEvents): AudioLink {
  const url = new URL(`${API_BASE}/audio/${encodeURIComponent(callId)}`, location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  const play = new AudioContext();
  void play.resume();
  let next = 0;
  let queued: AudioBufferSourceNode[] = [];
  let owner: OwnerState = 'none';
  let muted = false;
  let closed = false;
  let expected = false; // closed by us, by the end of the call, or by a replacing link
  let mic: { stop: () => void } | null = null;
  const pending: string[] = []; // join / hand_back pressed before the socket opened
  const callLevel = throttled(ev.onLevel);
  const micLevel = throttled(ev.onMicLevel);

  const stopMic = () => {
    mic?.stop();
    mic = null;
    ev.onMicLevel(0);
  };
  const shutDown = () => {
    if (closed) return;
    closed = true;
    stopMic();
    queued.forEach((s) => s.stop());
    void play.close();
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({ ticket }));
    pending.splice(0).forEach((m) => ws.send(m));
  };
  ws.onmessage = (e) => {
    if (closed) return;
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        // The microphone closes only when the owner leaves the call (hand-back), not on the first
        // `listening` message that arrives while a Join is still opening it.
        if (owner === 'on_call' && msg.owner !== 'on_call') stopMic();
        owner = msg.owner;
        ev.onState(msg.owner, msg.phase ?? null);
      } else if (msg.type === 'ended') {
        expected = true;
        ev.onEnded();
      } else if (msg.type === 'replaced') {
        expected = true;
        ev.onReplaced();
      } else if (msg.type === 'error') {
        ev.onError(String(msg.message ?? 'The server refused that.'));
      }
      return;
    }
    const samples = int16ToFloat(e.data as ArrayBuffer);
    callLevel(level(samples));
    const now = play.currentTime;
    if (next < now) next = now + START_BUFFER; // starved: rebuild the start buffer
    if (next - now > MAX_QUEUE) {
      // Too far behind: drop the queued (old) audio and play from now.
      queued.forEach((s) => s.stop());
      queued = [];
      next = now + START_BUFFER;
    }
    const buf = play.createBuffer(1, samples.length, DOWN_HZ);
    buf.copyToChannel(samples, 0);
    const src = play.createBufferSource();
    src.buffer = buf;
    src.connect(play.destination);
    src.onended = () => (queued = queued.filter((s) => s !== src));
    src.start(next);
    queued.push(src);
    next += buf.duration;
  };
  ws.onclose = () => {
    shutDown();
    ev.onClose(!expected);
  };

  const send = (type: string) => {
    const m = JSON.stringify({ type });
    if (ws.readyState === WebSocket.OPEN) ws.send(m);
    else if (ws.readyState === WebSocket.CONNECTING) pending.push(m);
  };

  return {
    join: () => send('join'),
    handBack: () => send('hand_back'),
    async startMic() {
      if (mic) return 'ok';
      const chunk = makeChunker();
      const opened = await openMic((block) => {
        micLevel(muted ? 0 : level(block));
        // The server drops mic audio unless the owner has the call; do not send it at all then.
        if (muted || owner !== 'on_call' || ws.readyState !== WebSocket.OPEN) return;
        for (const msg of chunk(block)) ws.send(msg);
      });
      if (typeof opened === 'string') return opened;
      if (closed) {
        opened.stop(); // the socket closed while the browser was opening the microphone
        return 'closed';
      }
      mic = opened;
      return 'ok';
    },
    setMuted: (m) => {
      muted = m;
    },
    close() {
      expected = true;
      shutDown();
      ws.close();
    },
  };
}

/** Microphone through the mic-worklet, at the device rate, downsampled to 16 kHz.
 *  (Firefox refuses a 16 kHz context for a microphone that runs at another rate.) */
async function openMic(onBlock: (b: Float32Array) => void): Promise<{ stop: () => void } | 'denied' | 'error'> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    return (e as Error).name === 'NotAllowedError' ? 'denied' : 'error';
  }
  try {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(`${WEB_BASE}/mic-worklet.js`);
    const node = new AudioWorkletNode(ctx, 'mic-tap');
    const down = makeDownsampler(ctx.sampleRate);
    node.port.onmessage = (e) => onBlock(down(e.data as Float32Array));
    ctx.createMediaStreamSource(stream).connect(node).connect(ctx.destination); // the worklet outputs silence
    return {
      stop() {
        stream.getTracks().forEach((t) => t.stop());
        void ctx.close();
      },
    };
  } catch {
    stream.getTracks().forEach((t) => t.stop());
    return 'error';
  }
}

export async function micPermission(): Promise<'granted' | 'denied' | 'prompt'> {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return p.state;
  } catch {
    return 'prompt';
  }
}

/** Calls back when the microphone permission changes (e.g. the owner allowed it in the browser). */
export function watchMicPermission(cb: (state: 'granted' | 'denied' | 'prompt') => void): () => void {
  let status: PermissionStatus | null = null;
  let gone = false;
  const on = () => status && cb(status.state);
  void navigator.permissions
    ?.query({ name: 'microphone' as PermissionName })
    .then((s) => {
      if (gone) return;
      status = s;
      s.addEventListener('change', on);
    })
    .catch(() => {});
  return () => {
    gone = true;
    status?.removeEventListener('change', on);
  };
}

/** Microphone level check for Settings. Returns a stop function, or why it failed. */
export async function checkMic(onLevel: (l: number) => void) {
  const show = throttled(onLevel);
  return openMic((b) => show(level(b)));
}

let stopCurrent: (() => void) | null = null;

/** Plays a sound file (voice sample, recording), stopping any other one. Returns a stop function. */
export function playUrl(url: string, onEnd: () => void): () => void {
  stopCurrent?.();
  const a = new Audio(url);
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    a.pause();
    if (stopCurrent === stop) stopCurrent = null;
    onEnd();
  };
  stopCurrent = stop;
  a.onended = stop;
  a.onerror = stop;
  void a.play().catch(stop);
  return stop;
}

export type PlayerEvents = {
  onTime: (t: number) => void;
  onDuration: (d: number) => void;
  onPlaying: (on: boolean) => void;
  onLoading: (on: boolean) => void;
  onError: () => void;
};
export type Player = { play: () => void; pause: () => void; seek: (t: number) => void; close: () => void };

/** A recording that can seek (the server answers Range requests). Loads its length at once; after an error the next play loads again. */
export function openPlayer(url: string, ev: PlayerEvents): Player {
  let a: HTMLAudioElement | null = null;
  let pending: number | null = null; // a seek asked for before the length was known (Safari ignores it then)
  const pause = () => {
    a?.pause();
    if (stopCurrent === pause) stopCurrent = null;
  };
  // No more events from this element, and its download stops.
  const detach = (x: HTMLAudioElement) => {
    x.ontimeupdate = x.ondurationchange = x.onwaiting = x.onplaying = x.onpause = x.onerror = x.onloadedmetadata = null;
    x.removeAttribute('src');
    x.load();
    if (a === x) a = null;
  };
  const audio = () => {
    if (a) return a;
    const x = new Audio();
    x.preload = 'metadata';
    x.ontimeupdate = () => ev.onTime(x.currentTime);
    x.ondurationchange = () => Number.isFinite(x.duration) && ev.onDuration(x.duration);
    x.onloadedmetadata = () => {
      if (pending != null) x.currentTime = pending;
      pending = null;
    };
    x.onwaiting = () => ev.onLoading(true);
    x.onplaying = () => {
      ev.onLoading(false);
      ev.onPlaying(true);
    };
    x.onpause = () => ev.onPlaying(false);
    x.onerror = () => {
      detach(x);
      ev.onLoading(false);
      ev.onPlaying(false);
      ev.onError();
    };
    x.src = url;
    a = x;
    return x;
  };
  audio(); // the length shows before Play
  return {
    play: () => {
      const x = audio();
      if (stopCurrent !== pause) stopCurrent?.(); // one sound at a time (voice samples too)
      stopCurrent = pause;
      if (x.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) ev.onLoading(true);
      void x.play().catch(() => ev.onLoading(false)); // a load failure arrives as onerror
    },
    pause,
    seek: (t) => {
      const x = audio();
      if (x.readyState < HTMLMediaElement.HAVE_METADATA) pending = t;
      else x.currentTime = t;
      ev.onTime(t);
    },
    close: () => {
      pause();
      if (a) detach(a);
    },
  };
}

/** While on: the browser asks before the page is closed or reloaded. */
export function guardLeave(on: boolean): () => void {
  if (!on) return () => {};
  const h = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = ''; // older browsers need this to show the prompt
  };
  window.addEventListener('beforeunload', h);
  return () => window.removeEventListener('beforeunload', h);
}
