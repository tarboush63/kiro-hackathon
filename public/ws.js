// Thin WebSocket client. One connection per page, JSON messages.
export class WSClient {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.ws = null;
    this.connect();
  }

  connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);

    this.ws.addEventListener("message", (e) => {
      try {
        const msg = JSON.parse(e.data);
        this.onMessage(msg);
      } catch (err) {
        console.error("bad ws message", err);
      }
    });

    this.ws.addEventListener("close", () => {
      // Simple reconnect after a short delay.
      setTimeout(() => this.connect(), 1500);
    });
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  sendChat(text) {
    this.send({ type: "chat", text });
  }

  sendGreeting() {
    this.send({ type: "greeting" });
  }

  // The underlying WebSocket, for binary audio frames (bonus A).
  get socket() {
    return this.ws;
  }
}
