// Web owner audio (plan section 10a): one WebSocket with raw PCM.
// Down: 8 kHz 16-bit mono, 40 ms blocks. Up: 16 kHz 16-bit mono, 20 ms blocks, only while on the call.
// TODO: audio.native.ts with a raw PCM module; same socket and messages.
import { API_BASE, type OwnerState, type Phase } from '../api';
import { DOWN_HZ, UP_HZ, int16ToFloat, level, makeChunker } from '../pcm';

const BASE = process.env.EXPO_BASE_URL || '/callenvoy';
const START_BUFFER = 0.08; // s of audio queued before playing
const MAX_QUEUE = 0.4; // s; more than this and old audio is dropped to catch up

export type MicResult = 'ok' | 'denied' | 'error';

export type AudioEvents = {
  onState: (owner: OwnerState, phase: Phase) => void;
  onEnded: () => void;
  onClose: (unexpected: boolean) => void;
  onLevel: (callLevel: number) => void;
  onMicLevel: (micLevel: number) => void;
};

export type AudioLink = {
  join: () => void;
  handBack: () => void;
  startMic: () => Promise<MicResult>;
  stopMic: () => void;
  setMuted: (muted: boolean) => void;
  close: () => void;
};

/** Opens the owner audio socket. Must be called from a click (browsers start audio only then). */
export function openAudio(callId: string, ticket: string, ev: AudioEvents): AudioLink {
  const url = new URL(`${API_BASE}/audio/${encodeURIComponent(callId)}`, location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  const play = new AudioContext();
  void play.resume();
  let next = 0;
  let owner: OwnerState = 'none';
  let muted = false;
  let closedByUs = false;
  let ended = false;
  let mic: { stop: () => void } | null = null;

  const queue: string[] = []; // join / hand_back pressed before the socket opened
  ws.onopen = () => {
    ws.send(JSON.stringify({ ticket }));
    queue.splice(0).forEach((m) => ws.send(m));
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);
      if (msg.type === 'state') {
        owner = msg.owner;
        ev.onState(msg.owner, msg.phase ?? null);
      } else if (msg.type === 'ended') {
        ended = true;
        ev.onEnded();
      }
      return;
    }
    const samples = int16ToFloat(e.data as ArrayBuffer);
    ev.onLevel(level(samples));
    const now = play.currentTime;
    if (next < now) next = now + START_BUFFER; // starved: rebuild the start buffer
    if (next - now > MAX_QUEUE) return; // too far behind: drop this block
    const buf = play.createBuffer(1, samples.length, DOWN_HZ);
    buf.copyToChannel(samples, 0);
    const src = play.createBufferSource();
    src.buffer = buf;
    src.connect(play.destination);
    src.start(next);
    next += buf.duration;
  };
  ws.onclose = () => {
    mic?.stop();
    void play.close();
    ev.onClose(!closedByUs && !ended);
  };

  const send = (type: string) => {
    const m = JSON.stringify({ type });
    if (ws.readyState === WebSocket.OPEN) ws.send(m);
    else if (ws.readyState === WebSocket.CONNECTING) queue.push(m);
  };

  return {
    join: () => send('join'),
    handBack: () => send('hand_back'),
    async startMic() {
      if (mic) return 'ok';
      const chunk = makeChunker();
      const opened = await openMic((block) => {
        ev.onMicLevel(muted ? 0 : level(block));
        // The server drops mic audio unless the owner has the call; do not send it at all then.
        if (muted || owner !== 'on_call' || ws.readyState !== WebSocket.OPEN) return;
        for (const msg of chunk(block)) ws.send(msg);
      });
      if (typeof opened === 'string') return opened;
      mic = opened;
      return 'ok';
    },
    stopMic() {
      mic?.stop();
      mic = null;
      ev.onMicLevel(0);
    },
    setMuted: (m) => {
      muted = m;
    },
    close() {
      closedByUs = true;
      ws.close();
    },
  };
}

/** Microphone at 16 kHz through the mic-worklet. Calls onBlock with Float32 blocks. */
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
    const ctx = new AudioContext({ sampleRate: UP_HZ });
    await ctx.audioWorklet.addModule(`${BASE}/mic-worklet.js`);
    const node = new AudioWorkletNode(ctx, 'mic-tap');
    node.port.onmessage = (e) => onBlock(e.data as Float32Array);
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
  const on = () => status && cb(status.state);
  void navigator.permissions
    ?.query({ name: 'microphone' as PermissionName })
    .then((s) => {
      status = s;
      s.addEventListener('change', on);
    })
    .catch(() => {});
  return () => status?.removeEventListener('change', on);
}

/** Microphone level check for Settings. Returns a stop function, or why it failed. */
export async function checkMic(onLevel: (l: number) => void) {
  return openMic((b) => onLevel(level(b)));
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

/** While on: the browser asks before the page is closed or reloaded. */
export function guardLeave(on: boolean): () => void {
  if (!on) return () => {};
  const h = (e: BeforeUnloadEvent) => e.preventDefault();
  window.addEventListener('beforeunload', h);
  return () => window.removeEventListener('beforeunload', h);
}

