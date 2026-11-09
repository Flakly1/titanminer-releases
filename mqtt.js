// A tiny MQTT 3.1.1 client (QoS 0) over WebSocket. Same job as RelayClient.java in the mod:
// connects to a public relay, subscribes, publishes, and reconnects by itself.

const enc = new TextEncoder();
const dec = new TextDecoder();

function lengthBytes(n) {
  const out = [];
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 0x80;
    out.push(digit);
  } while (n > 0);
  return out;
}

function mqttString(text) {
  const b = enc.encode(text);
  return [b.length >> 8, b.length & 0xff, ...b];
}

function packet(header, body) {
  const len = lengthBytes(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = header;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

export class MqttWs {
  /**
   * @param {{url: string, subscriptions: string[], onMessage: (topic: string, payload: Uint8Array) => void,
   *          onConnection?: (connected: boolean) => void}} options
   */
  constructor({ url, subscriptions, onMessage, onConnection }) {
    this.url = url;
    this.subscriptions = subscriptions;
    this.onMessage = onMessage;
    this.onConnection = onConnection || (() => {});
    this.connected = false;
    this.lastError = null;
    this._running = false;
    this._ws = null;
    this._buffer = new Uint8Array(0);
    this._failures = 0;
    this._retry = null;
    this._ping = null;
    this._lastRx = 0;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._open();
  }

  stop() {
    this._running = false;
    clearTimeout(this._retry);
    clearInterval(this._ping);
    const ws = this._ws;
    this._ws = null;
    if (ws) {
      try {
        if (this.connected && ws.readyState === 1) ws.send(new Uint8Array([0xe0, 0]));
        ws.close();
      } catch (e) { /* already closed */ }
    }
    this._setConnected(false);
  }

  /** Sends a message (QoS 0). False if not connected right now. */
  publish(topic, payload, retain = false) {
    if (!this.connected || !this._ws || this._ws.readyState !== 1) return false;
    const t = mqttString(topic);
    const body = new Uint8Array(t.length + payload.length);
    body.set(t, 0);
    body.set(payload, t.length);
    try {
      this._ws.send(packet(0x30 | (retain ? 1 : 0), body));
      return true;
    } catch (e) {
      return false;
    }
  }

  _open() {
    if (!this._running) return;
    let ws;
    try {
      ws = new WebSocket(this.url, 'mqtt');
    } catch (e) {
      this.lastError = String(e);
      this._scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this._ws = ws;
    this._buffer = new Uint8Array(0);
    ws.onopen = () => {
      const body = new Uint8Array([
        ...mqttString('MQTT'), 4, 0x02, 0, 30, // protocol 3.1.1, clean session, keep-alive 30 s
        ...mqttString('tmw' + Math.random().toString(16).slice(2, 12)),
      ]);
      ws.send(packet(0x10, body));
    };
    ws.onmessage = (event) => {
      this._lastRx = Date.now();
      this._receive(new Uint8Array(event.data));
    };
    ws.onerror = () => { this.lastError = 'WebSocket error'; };
    ws.onclose = () => {
      if (this._ws !== ws) return; // an old connection
      this._ws = null;
      clearInterval(this._ping);
      this._setConnected(false);
      this._scheduleRetry();
    };
  }

  _scheduleRetry() {
    if (!this._running) return;
    this._failures++;
    const delay = Math.min(30000, 2000 * 2 ** Math.min(this._failures - 1, 4));
    clearTimeout(this._retry);
    this._retry = setTimeout(() => this._open(), delay);
  }

  _setConnected(value) {
    if (this.connected !== value) {
      this.connected = value;
      try { this.onConnection(value); } catch (e) { /* listener problem */ }
    }
  }

  _receive(chunk) {
    const joined = new Uint8Array(this._buffer.length + chunk.length);
    joined.set(this._buffer, 0);
    joined.set(chunk, this._buffer.length);
    this._buffer = joined;
    for (;;) {
      const buf = this._buffer;
      if (buf.length < 2) return;
      let multiplier = 1, length = 0, i = 1, digit;
      do {
        if (i >= buf.length) return; // length not complete yet
        digit = buf[i++];
        length += (digit & 0x7f) * multiplier;
        multiplier *= 128;
        if (multiplier > 128 ** 4) { this._ws && this._ws.close(); return; }
      } while (digit & 0x80);
      if (buf.length < i + length) return; // packet not complete yet
      const header = buf[0];
      const body = buf.slice(i, i + length);
      this._buffer = buf.slice(i + length);
      this._handle(header, body);
    }
  }

  _handle(header, body) {
    const type = header & 0xf0;
    if (type === 0x20) { // CONNACK
      if (body.length >= 2 && body[1] === 0) {
        const sub = [0, 1];
        for (const topic of this.subscriptions) sub.push(...mqttString(topic), 0);
        if (this.subscriptions.length) this._ws.send(packet(0x82, new Uint8Array(sub)));
        this._failures = 0;
        this._setConnected(true);
        clearInterval(this._ping);
        this._ping = setInterval(() => {
          if (!this._ws || this._ws.readyState !== 1) return;
          if (Date.now() - this._lastRx > 50000) { this._ws.close(); return; } // gone quiet: reconnect
          this._ws.send(new Uint8Array([0xc0, 0]));
        }, 20000);
      } else {
        this.lastError = 'Relay refused the connection';
        this._ws && this._ws.close();
      }
    } else if (type === 0x30) { // PUBLISH
      const qos = (header >> 1) & 3;
      const topicLength = (body[0] << 8) | body[1];
      const topic = dec.decode(body.slice(2, 2 + topicLength));
      const start = 2 + topicLength + (qos > 0 ? 2 : 0);
      try { this.onMessage(topic, body.slice(start)); } catch (e) { /* listener problem */ }
    }
    // SUBACK, PINGRESP and anything else need no reply.
  }
}
