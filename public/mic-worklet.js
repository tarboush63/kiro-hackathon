// AudioWorklet: averages the input (44.1/48 kHz) down to 16 kHz, converts to
// 16-bit PCM, and posts ~100 ms chunks back to the main thread.
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    // 100 ms at 16 kHz = 1600 samples.
    this.chunkSize = 1600;
    this.buffer = new Int16Array(this.chunkSize);
    this.bufferIndex = 0;
    // Fractional read position into the incoming block for downsampling.
    this.ratio = sampleRate / this.targetRate;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    // Simple averaging downsample: for each output sample, average the input
    // samples that fall into its window.
    let pos = 0;
    while (pos < channel.length) {
      const start = Math.floor(pos);
      const end = Math.min(Math.floor(pos + this.ratio), channel.length);
      let sum = 0;
      let count = 0;
      for (let i = start; i < end; i++) {
        sum += channel[i];
        count++;
      }
      const sample = count > 0 ? sum / count : 0;

      // Float [-1,1] -> 16-bit PCM.
      let s = Math.max(-1, Math.min(1, sample));
      this.buffer[this.bufferIndex++] = s < 0 ? s * 0x8000 : s * 0x7fff;

      if (this.bufferIndex >= this.chunkSize) {
        // Copy and post the chunk's bytes, plus a peak level for diagnostics.
        const out = this.buffer.slice(0, this.chunkSize);
        let peak = 0;
        for (let i = 0; i < out.length; i++) {
          const v = Math.abs(out[i]);
          if (v > peak) peak = v;
        }
        this.port.postMessage({ pcm: out.buffer, peak: peak / 32768 }, [
          out.buffer,
        ]);
        this.buffer = new Int16Array(this.chunkSize);
        this.bufferIndex = 0;
      }

      pos += this.ratio;
    }

    return true;
  }
}

registerProcessor("mic-processor", MicProcessor);
