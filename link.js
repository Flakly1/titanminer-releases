// The web app's end of the link (same job as LinkManager.kt in the Android app): connects to the
// relays with topics and a key from the pairing code, only while the page is visible.

import { MqttWs } from './mqtt.js';
import { deriveLink, formatCode, normalizeCode, open, seal } from './crypto.js';

// Browsers can't use the relays' normal port, so these are the same relays' WebSocket ports.
const DEFAULT_RELAYS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
const CODES_KEY = 'titan.codes';
const OLD_CODE_KEY = 'titan.code';
const HIDDEN_KEY = 'titan.hidden';
const SELECTED_KEY = 'titan.selected';

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

export class Link {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.relayUrls = globalThis.TITAN_RELAYS || DEFAULT_RELAYS;
    /** Saved codes, one per computer; every Minecraft account on a computer shares its code. */
    this.codes = [];
    this.hidden = new Set();
    this.selectedKey = null;
    this.accountData = new Map(); // "code|accountId" -> {code, id, name, pc, status, config, seenAt}
    this.toast = null;
    this.computers = new Map(); // code -> {link, relays}
    this._seen = new Set();
    this._listeners = new Set();
    this._foreground = false;
    this._pingTimer = null;
    this._starting = new Set();
    this._load();
  }

  _read(key) {
    try { return this.storage && this.storage.getItem(key); } catch (e) { return null; }
  }

  _write(key, value) {
    try {
      if (value === null) this.storage.removeItem(key); else this.storage.setItem(key, value);
    } catch (e) { /* storage blocked */ }
  }

  _load() {
    try { this.codes = JSON.parse(this._read(CODES_KEY) || '[]').filter((c) => normalizeCode(c)); } catch (e) { this.codes = []; }
    const old = this._read(OLD_CODE_KEY); // from the first version, which saved a single code
    if (old && normalizeCode(old) && !this.codes.includes(old)) this.codes.push(old);
    try { this.hidden = new Set(JSON.parse(this._read(HIDDEN_KEY) || '[]')); } catch (e) { this.hidden = new Set(); }
    this.selectedKey = this._read(SELECTED_KEY);
    this._save();
    this._write(OLD_CODE_KEY, null);
  }

  _save() {
    this._write(CODES_KEY, JSON.stringify(this.codes));
    this._write(HIDDEN_KEY, JSON.stringify([...this.hidden]));
    this._write(SELECTED_KEY, this.selectedKey);
  }

  /** Called with no arguments whenever anything changed. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _changed() {
    for (const fn of this._listeners) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }

  /** Non-null when anything is paired (the first saved code). */
  get code() { return this.codes[0] || null; }

  get relaysUp() {
    let n = 0;
    for (const c of this.computers.values()) n += c.relays.filter((r) => r.connected).length;
    return n;
  }

  /** The accounts found on the linked computers, for the switcher. */
  get accounts() {
    const list = [];
    for (const [key, d] of this.accountData) {
      if (this.hidden.has(key) || !this.codes.includes(d.code)) continue;
      list.push({ key, code: d.code, id: d.id, name: d.name || `Account ${d.id.slice(0, 4)}`, pc: d.pc, ts: d.seenAt });
    }
    list.sort((a, b) => (a.pc || '').localeCompare(b.pc || '') || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return list;
  }

  /** The account being controlled; falls back to the most recently seen one. */
  get selected() {
    const list = this.accounts;
    return list.find((a) => a.key === this.selectedKey) || list.reduce((best, a) => (!best || a.ts > best.ts ? a : best), null);
  }

  get status() {
    const sel = this.selected;
    return sel ? this.accountData.get(sel.key).status || null : null;
  }

  get config() {
    const sel = this.selected;
    return sel ? this.accountData.get(sel.key).config || null : null;
  }

  // ---------------------------------------------------------------- Pairing

  /** Adds a computer (re-adding a saved one is fine). */
  pair(code) {
    const clean = normalizeCode(code);
    if (!clean) return false;
    const formatted = formatCode(clean);
    if (!this.codes.includes(formatted)) this.codes.push(formatted);
    this._save();
    if (this._foreground) this._start();
    this._changed();
    return true;
  }

  selectAccount(key) {
    this.selectedKey = key;
    this._save();
    this._changed();
    this.send('ping');
  }

  hideAccount(key) {
    this.hidden.add(key);
    if (this.selectedKey === key) this.selectedKey = null;
    this._save();
    this._changed();
  }

  /** Forgets the computer of the selected account (all its accounts disappear). */
  unpairSelectedComputer() {
    const sel = this.selected;
    if (!sel) return this.unpair();
    this._forget(sel.code);
  }

  _forget(code) {
    this.codes = this.codes.filter((c) => c !== code);
    for (const key of [...this.accountData.keys()]) if (key.startsWith(code + '|')) this.accountData.delete(key);
    for (const key of [...this.hidden]) if (key.startsWith(code + '|')) this.hidden.delete(key);
    if (this.selectedKey && this.selectedKey.startsWith(code + '|')) this.selectedKey = null;
    const computer = this.computers.get(code);
    if (computer) computer.relays.forEach((r) => r.stop());
    this.computers.delete(code);
    this._save();
    this._changed();
  }

  /** Forgets every computer. */
  unpair() {
    for (const code of [...this.codes]) this._forget(code);
  }

  // ---------------------------------------------------------------- Lifecycle

  /** The page is on screen: connect. */
  onForeground() {
    this._foreground = true;
    this._start();
  }

  /** The page is hidden: disconnect, so nothing runs in the background. */
  onBackground() {
    this._foreground = false;
    this._stop();
    this._changed();
  }

  async _start() {
    for (const code of this.codes) {
      if (this.computers.has(code) || this._starting.has(code)) continue;
      this._starting.add(code);
      let link;
      try {
        link = await deriveLink(code);
      } catch (e) {
        this._starting.delete(code);
        continue;
      }
      this._starting.delete(code);
      if (!this._foreground || !this.codes.includes(code) || this.computers.has(code)) continue; // changed while deriving the key
      const computer = { link, code, relays: [] };
      this.computers.set(code, computer);
      for (const url of this.relayUrls) {
        const relay = new MqttWs({
          url,
          subscriptions: [link.topicBase + '/status/+', link.topicBase + '/config/+'],
          onMessage: (topic, payload) => this._receive(computer, topic, payload),
          onConnection: (connected) => {
            if (connected) this._pingComputer(computer, 'hello');
            this._changed();
          },
        });
        computer.relays.push(relay);
        relay.start();
      }
    }
    if (!this._pingTimer && this.computers.size) {
      this._pingTimer = setInterval(() => this.computers.forEach((c) => this._pingComputer(c, 'ping')), 10000);
    }
    this._changed();
  }

  _stop() {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
    for (const c of this.computers.values()) c.relays.forEach((r) => r.stop());
    this.computers.clear();
  }

  /** Tells every account on a computer that someone is watching, so they report often. */
  _pingComputer(computer, type) {
    for (const d of this.accountData.values()) if (d.code === computer.code) this._sendTo(computer, d.id, type);
  }

  // ---------------------------------------------------------------- Messages

  async _receive(computer, topic, payload) {
    if (!payload.length) return; // a cleared retained message
    const accountId = topic.slice(topic.lastIndexOf('/') + 1);
    if (!accountId) return;
    const json = await open(computer.link, topic, payload);
    if (json === null || this.computers.get(computer.code) !== computer) return;
    let message;
    try { message = JSON.parse(json); } catch (e) { return; }
    if (!message || typeof message !== 'object') return;
    if (typeof message.id === 'string') {
      if (this._seen.has(message.id)) return;
      this._seen.add(message.id);
      if (this._seen.size > 2000) this._seen.delete(this._seen.values().next().value);
    }
    if (message.type !== 'status' && message.type !== 'config') return;
    const key = computer.code + '|' + accountId;
    let d = this.accountData.get(key);
    const isNew = !d;
    if (!d) {
      d = { code: computer.code, id: accountId, name: '', pc: null, status: null, config: null, seenAt: 0 };
      this.accountData.set(key, d);
    }
    if (message.type === 'status') {
      if (!d.status || (message.ts || 0) >= (d.status.ts || 0)) {
        this._checkAlerts(key, message.account || d.name, message);
        d.status = message;
        d.seenAt = message.ts || 0;
        if (message.account) d.name = message.account;
        if (message.pc) d.pc = message.pc;
      }
    } else if (!d.config || (message.ts || 0) >= (d.config.ts || 0)) {
      d.config = message;
    }
    if (isNew) this._sendTo(computer, accountId, 'hello');
    this._changed();
  }

  async send(type, fields = {}) {
    const sel = this.selected;
    if (!sel) return;
    const computer = this.computers.get(sel.code);
    if (computer) this._sendTo(computer, sel.id, type, fields);
  }

  async _sendTo(computer, accountId, type, fields = {}) {
    const topic = computer.link.topicBase + '/cmd/' + accountId;
    const sealed = await seal(computer.link, topic, JSON.stringify({ v: 1, type, id: randomId(), ts: Date.now(), ...fields }));
    for (const relay of computer.relays) relay.publish(topic, sealed, false);
  }

  /** Notify about failsafe alerts newer than the last one seen for this account (when turned on). */
  _checkAlerts(key, account, status) {
    const alerts = status.alerts || [];
    if (!alerts.length) return;
    const newest = Math.max(...alerts.map((a) => a.ts || 0));
    const seenKey = 'titan.alertTs.' + key;
    const seen = Number(this._read(seenKey) || -1);
    this._write(seenKey, String(newest));
    if (seen < 0 || !this.notifyAlerts) return; // first time: don't replay old alerts
    for (const a of alerts) {
      if ((a.ts || 0) > seen) this._notify(account, a.text);
    }
  }

  get notifyAlerts() { return this._read('titan.notify') === '1'; }

  set notifyAlerts(on) { this._write('titan.notify', on ? '1' : '0'); }

  async _notify(account, text) {
    const title = account ? `TitanMiner - ${account}` : 'TitanMiner';
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
      if (reg && reg.showNotification) await reg.showNotification(title, { body: text, icon: 'icons/icon-192.png', tag: 'titan-' + Date.now() });
      else new Notification(title, { body: text });
    } catch (e) { /* not supported here */ }
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  }

  showToast(text) {
    this.toast = text;
    this._changed();
    setTimeout(() => {
      if (this.toast === text) { this.toast = null; this._changed(); }
    }, 3000);
  }

  // ---------------------------------------------------------------- Actions (shown straight away, confirmed by the client)

  _editModule(id, change) {
    if (!this.config) return;
    const m = this.config.modules.find((x) => x.id === id);
    if (m) change(m);
  }

  _editSetting(key, change) {
    if (!this.config) return;
    for (const m of this.config.modules) {
      const s = m.settings.find((x) => x.key === key);
      if (s) change(s);
    }
  }

  setModule(id, on) {
    this._editModule(id, (m) => { m.enabled = on; });
    this._changed();
    this.send('module', { module: id, on });
  }

  setToggle(key, value) {
    this._editSetting(key, (s) => { s.value = value; });
    this._changed();
    this.send('toggle', { key, value });
  }

  setSlider(key, value) {
    this._editSetting(key, (s) => { s.value = value; });
    this._changed();
    this.send('slider', { key, value });
  }

  setText(key, value) {
    this._editSetting(key, (s) => { s.value = value; });
    this._changed();
    this.send('text', { key, value });
  }

  pressAction(key) { this.send('action', { key }); }
  reconnect() { this.send('reconnect'); this.showToast('Reconnecting...'); }
  disconnect() { this.send('disconnect'); this.showToast('Logging off...'); }
  refreshBalance() { this.send('balance'); this.showToast('Checking balance...'); }
  chat(text) { this.send('chat', { text }); }
}
