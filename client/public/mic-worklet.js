// Hands each block of microphone samples (Float32, 128 frames) to the page.
// Outputs nothing, so the owner never hears their own voice.
class MicTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('mic-tap', MicTap);
