// Microphone capture (bonus A). Streams 16 kHz 16-bit PCM 100 ms chunks as
// binary WebSocket frames while recording.

export function micSupported() {
  // Mic only works on localhost or https (getUserMedia needs a secure context).
  const isLocal =
    location.hostname === "localhost" || location.hostname === "127.0.0.1";
  return (
    (window.isSecureContext || isLocal) &&
    !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
  );
}

const MAX_MS = 30000; // stop after 30 seconds

export class Mic {
  /**
   * @param {() => WebSocket} getSocket  returns the CURRENT socket (survives reconnects)
   */
  constructor(getSocket) {
    this.getSocket = getSocket;
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.sink = null;
    this.recording = false; // a session is active (setup may still be running)
    this.stopRequested = false; // stop() was called, possibly during setup
    this.started = false; // mic_start was sent
    this.chunksSent = 0;
    this.peak = 0; // loudest level this session (0..1)
    this.lastPeak = 0;
    this.autoStopTimer = null;
    this.onAutoStop = null;
    this.onLevel = null;
    this.deviceLabel = "";
  }

  _send(obj) {
    const ws = this.getSocket();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  async start() {
    if (this.recording) return;
    this.recording = true;
    this.stopRequested = false;
    this.chunksSent = 0;
    this.peak = 0;

    // Tell the server FIRST so mic_start can never arrive after mic_stop.
    if (!this._send({ type: "mic_start" })) {
      this.recording = false;
      throw new Error("socket not open");
    }
    this.started = true;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Report which device we actually got, and whether it is muted.
      const track = this.stream.getAudioTracks()[0];
      if (track) {
        this.deviceLabel = track.label || "(unknown device)";
        console.log(
          `[mic] device: ${this.deviceLabel} | enabled: ${track.enabled} | muted: ${track.muted} | state: ${track.readyState}`
        );
      }

      // stop() may have been called while we were awaiting permission.
      if (this.stopRequested) {
        this._teardown();
        this._finish();
        return;
      }

      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      await this.ctx.audioWorklet.addModule("/mic-worklet.js");

      if (this.stopRequested) {
        this._teardown();
        this._finish();
        return;
      }

      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, "mic-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });

      this.node.port.onmessage = (e) => {
        if (!this.recording) return;
        const { pcm, peak } = e.data;
        // Track the loudest level seen, for the UI level meter / diagnostics.
        if (peak > this.peak) this.peak = peak;
        this.lastPeak = peak;
        if (this.onLevel) this.onLevel(peak);
        const ws = this.getSocket();
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(pcm);
          this.chunksSent++;
        }
      };

      this.source.connect(this.node);
      // Keep the worklet pulling audio, but at zero gain so the mic is never
      // routed back to the speakers (that would cause feedback).
      this.sink = this.ctx.createGain();
      this.sink.gain.value = 0;
      this.node.connect(this.sink);
      this.sink.connect(this.ctx.destination);

      this.autoStopTimer = setTimeout(() => {
        if (this.onAutoStop) this.onAutoStop();
        this.stop();
      }, MAX_MS);
    } catch (err) {
      // Setup failed: make sure the server's stream gets closed.
      this._teardown();
      this._finish();
      throw err;
    }
  }

  stop() {
    if (!this.recording) return;

    // If setup is still in flight, flag it and let start() unwind cleanly.
    if (!this.ctx || !this.node) {
      this.stopRequested = true;
      return;
    }

    this._teardown();
    this._finish();
  }

  _teardown() {
    this.recording = false;
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    try {
      if (this.node) {
        this.node.port.onmessage = null;
        this.node.disconnect();
      }
      if (this.source) this.source.disconnect();
      if (this.sink) this.sink.disconnect();
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      if (this.ctx) this.ctx.close();
    } catch (e) {
      /* ignore teardown errors */
    }
    this.node = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.ctx = null;
  }

  // Always pair a sent mic_start with a mic_stop so the server never leaks a stream.
  _finish() {
    if (this.started) {
      this.started = false;
      const pct = Math.round(this.peak * 100);
      console.log(
        `[mic] sent ${this.chunksSent} chunks | peak level ${pct}% | device: ${this.deviceLabel}`
      );
      if (this.chunksSent > 0 && this.peak < 0.02) {
        console.warn(
          "[mic] Audio was essentially SILENT. Your microphone is muted or the wrong input device is selected."
        );
      }
      this._send({ type: "mic_stop" });
    }
    this.recording = false;
    this.stopRequested = false;
  }
}
