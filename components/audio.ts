/** Loud looping two-tone alarm via Web Audio (no asset) + vibration. Returns a stop function. */
export function startAlarm() {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator(); const gain = ctx.createGain();
  osc.type = "square"; gain.gain.value = 0.4; osc.connect(gain).connect(ctx.destination); osc.start();
  const t = setInterval(() => { osc.frequency.value = osc.frequency.value === 880 ? 660 : 880; }, 350);
  navigator.vibrate?.([500, 200, 500, 200, 500]);
  return () => { clearInterval(t); osc.stop(); ctx.close(); };
}

/**
 * Play the live call from Vapi's monitor listenUrl. The socket sends one JSON "start" frame,
 * then interleaved stereo 16-bit PCM (caller + business); we mix to mono. Returns a stop function.
 */
export function listen(url: string, onEnd: () => void) {
  let rate = 16000, channels = 2;
  const ctx = new AudioContext(); let at = 0;
  const ws = new WebSocket(url); ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    if (typeof e.data === "string") {
      const j = JSON.parse(e.data); rate = j.sampleRate || rate; channels = j.channels || channels; return;
    }
    const pcm = new Int16Array(e.data); const n = Math.floor(pcm.length / channels);
    if (!n) return;
    const buf = ctx.createBuffer(1, n, rate); const out = buf.getChannelData(0);
    for (let i = 0; i < n; i++) { let s = 0; for (let ch = 0; ch < channels; ch++) s += pcm[i * channels + ch]; out[i] = Math.max(-1, Math.min(1, s / 32768)); }
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
    at = Math.max(at, ctx.currentTime + 0.05); src.start(at); at += buf.duration;
  };
  ws.onclose = () => { ctx.close(); onEnd(); };
  return () => ws.close();
}
