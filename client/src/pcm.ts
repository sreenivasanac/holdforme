// PCM helpers for the owner audio socket (plan section 10a). Pure, no browser APIs.

export const DOWN_HZ = 8000; // call audio from the server
export const UP_HZ = 16000; // microphone to the server
export const MIC_SAMPLES = UP_HZ / 50; // 20 ms per message = 320 samples = 640 bytes

/** 16-bit little-endian PCM to floats in [-1, 1]. */
export function int16ToFloat(buf: ArrayBuffer): Float32Array<ArrayBuffer> {
  const view = new DataView(buf);
  const out = new Float32Array(buf.byteLength >> 1);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Floats to 16-bit little-endian PCM, clipped. */
export function floatToInt16(samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return buf;
}

/** Root mean square, 0..1, for the level meters. */
export function level(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.min(1, Math.sqrt(sum / samples.length) * 4) : 0;
}

/** Collects microphone blocks of any size and returns whole 20 ms messages. */
export function makeChunker(size = MIC_SAMPLES) {
  let pending = new Float32Array(0);
  return (block: Float32Array): ArrayBuffer[] => {
    const all = new Float32Array(pending.length + block.length);
    all.set(pending);
    all.set(block, pending.length);
    const out: ArrayBuffer[] = [];
    let i = 0;
    for (; i + size <= all.length; i += size) out.push(floatToInt16(all.subarray(i, i + size)));
    pending = all.slice(i);
    return out;
  };
}
