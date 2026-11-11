// Run: pnpm --dir client test   (Node's built-in test runner; Node strips the TS types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { int16ToFloat, floatToInt16, makeChunker, MIC_SAMPLES } from '../src/pcm.ts';

test('16-bit <-> float round trip and clipping', () => {
  const f = new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]);
  const back = int16ToFloat(floatToInt16(f));
  assert.equal(back.length, f.length);
  for (const [i, want] of [0, 0.5, -0.5, 1, -1, 1, -1].entries()) assert.ok(Math.abs(back[i] - want) < 1e-4, `sample ${i}`);
  const view = new DataView(floatToInt16(new Float32Array([1, -1, 2])));
  assert.deepEqual([view.getInt16(0, true), view.getInt16(2, true), view.getInt16(4, true)], [32767, -32768, 32767]);
});

test('microphone messages are 20 ms at 16 kHz = 640 bytes', () => {
  const chunk = makeChunker();
  assert.equal(chunk(new Float32Array(128)).length, 0);
  assert.equal(chunk(new Float32Array(128)).length, 0);
  const out = chunk(new Float32Array(128)); // 384 samples so far -> one message, 64 left
  assert.equal(out.length, 1);
  assert.equal(out[0].byteLength, 640);
  assert.equal(MIC_SAMPLES * 2, 640);
  assert.equal(chunk(new Float32Array(256)).length, 1); // 64 + 256 = 320
});

test('call audio block of 640 bytes is 320 samples (40 ms at 8 kHz)', () => {
  assert.equal(int16ToFloat(new ArrayBuffer(640)).length, 320);
});

test('downsampling to 16 kHz keeps length and level, across blocks', async () => {
  const { makeDownsampler } = await import('../src/pcm.ts');
  for (const rate of [48000, 44100]) {
    const down = makeDownsampler(rate);
    let n = 0;
    let last = 0;
    for (let i = 0; i < 10; i++) {
      const out = down(new Float32Array(rate / 10).fill(0.5)); // 100 ms blocks
      n += out.length;
      if (out.length) last = out[out.length - 1];
    }
    assert.ok(Math.abs(n - 16000) <= 1, `${rate}: ${n} samples for 1 s`);
    assert.ok(Math.abs(last - 0.5) < 1e-6);
  }
  // one block or many small blocks give the same samples
  const sig = Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 7));
  const whole = makeDownsampler(48000)(sig);
  const parts = makeDownsampler(48000);
  const joined = [...parts(sig.subarray(0, 128)), ...parts(sig.subarray(128, 1001)), ...parts(sig.subarray(1001))];
  assert.equal(joined.length, whole.length);
  joined.forEach((v, i) => assert.ok(Math.abs(v - whole[i]) < 1e-6));
  // 16 kHz in: unchanged
  const same = new Float32Array([0.1, 0.2]);
  assert.equal(makeDownsampler(16000)(same), same);
});
