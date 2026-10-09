// Audio playback + viseme-driven lip sync, using one shared AudioContext.

// Polly viseme value -> mouth expression weights.
const VISEME_MAP = {
  a: { aa: 1.0 },
  "@": { aa: 0.5 },
  e: { ee: 0.8 },
  E: { ee: 0.6, aa: 0.3 },
  i: { ih: 0.8 },
  o: { oh: 0.9 },
  O: { oh: 0.7, aa: 0.3 },
  u: { ou: 0.9 },
  t: { ih: 0.3 },
  s: { ih: 0.3 },
  T: { ih: 0.3 },
  S: { ou: 0.3, ih: 0.2 },
  k: { aa: 0.3 },
  r: { ou: 0.3 },
  f: { ih: 0.2 },
};

const MOUTH_SHAPES = ["aa", "ih", "ou", "ee", "oh"];

export class AudioPlayer {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.visemes = [];
    this.startTime = 0;
    this.playing = false;
  }

  // Must be called from a user gesture (the Click to start button).
  init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  _b64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // Play base64 mp3 with its visemes. Resolves when playback ends.
  async play(audioB64, visemes = []) {
    this.init();
    this.stop();

    const arrayBuffer = this._b64ToArrayBuffer(audioB64);
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ctx.destination);

    this.source = source;
    this.visemes = visemes;
    this.playing = true;
    this.startTime = this.ctx.currentTime;

    return new Promise((resolve) => {
      source.onended = () => {
        if (this.source === source) {
          this.playing = false;
          this.source = null;
          this.visemes = [];
        }
        resolve();
      };
      source.start();
    });
  }

  stop() {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch (e) {
        /* already stopped */
      }
      this.source = null;
    }
    this.playing = false;
    this.visemes = [];
  }

  // Apply the current viseme to the VRM mouth. Call every frame while playing.
  updateMouth(vrm) {
    const em = vrm.expressionManager;
    if (!em) return;

    if (!this.playing || this.visemes.length === 0) {
      MOUTH_SHAPES.forEach((s) => em.setValue(s, 0));
      return;
    }

    const now =
      (this.ctx.currentTime - this.startTime - (this.ctx.outputLatency || 0)) *
      1000;

    // Last viseme with time <= now.
    let current = null;
    for (let i = 0; i < this.visemes.length; i++) {
      if (this.visemes[i].time <= now) current = this.visemes[i];
      else break;
    }

    const weights = current ? VISEME_MAP[current.value] || {} : {};
    MOUTH_SHAPES.forEach((s) => em.setValue(s, weights[s] || 0));
  }
}
