import { Link } from './link.js';
import { formatCode, normalizeCode } from './crypto.js';

const link = new Link();
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
const $dialogs = document.getElementById('dialog-root');

// The client counts as online if its last status is this recent (it sends one every 2 seconds).
const ONLINE_MS = 15000;

let tab = 'home';           // home | modules | chat
let openModule = null;      // id of the module whose settings are open
let menuOpen = false;
let dragging = false;       // a slider is being dragged: don't redraw under the finger
let adding = false;         // the 'add computer' pairing screen is open
let shell = null;           // 'pair' | 'main'
let ui = {};                // elements of the main screen
let lastSig = {};

// ------------------------------------------------------------------ Helpers

/** Builds an element. Text is always added as text, never as HTML (chat can contain anything). */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'checked' || key === 'disabled') { el[key] = true; el.setAttribute(key, ''); }
    else if (key === 'value') { el.value = value; el.setAttribute('value', value); }
    else el.setAttribute(key, value === true ? '' : value);
  }
  const add = (child) => {
    if (Array.isArray(child)) child.forEach(add);
    else if (child !== null && child !== undefined && child !== false) el.append(child.nodeType ? child : document.createTextNode(String(child)));
  };
  children.forEach(add);
  return el;
}

function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Same, but only changes once a minute, so the screen isn't redrawn every second. */
function agoCoarse(ms) {
  return Date.now() - ms < 60000 ? 'just now' : ago(ms);
}

function formatSlider(value, step, suffix) {
  const n = step >= 1 ? String(Math.round(value)) : Number(value).toFixed(1);
  return n + (suffix || '');
}

const fmt = (d) => (Number.isInteger(d) ? String(d) : Number(d).toFixed(1));

function isOnline() {
  const s = link.status;
  return !!s && Date.now() - s.ts < ONLINE_MS && s.screen !== 'Game closed';
}

/** Replaces the contents of `parent` only if what we'd draw is different (so taps aren't lost to redraws). */
function setContent(parent, key, node) {
  const sig = node.outerHTML;
  if (lastSig[key] === sig && parent.firstChild) return;
  lastSig[key] = sig;
  parent.replaceChildren(...node.childNodes);
}

/** Makes `key` the screen shown in the main area; true if it wasn't already (the area is then empty). */
function claimView(key) {
  if (ui.viewKey === key) return false;
  ui.viewKey = key;
  lastSig = {};
  ui.view.replaceChildren();
  ui.view.scrollTop = 0;
  ui.view.style.padding = key === 'chat' ? '0' : '';
  ui.view.style.overflow = key === 'chat' ? 'hidden' : '';
  return true;
}

function switchEl(checked, onChange, label) {
  return h('label', { class: 'switch' },
    h('input', { type: 'checkbox', checked, 'aria-label': label, onchange: (e) => onChange(e.target.checked) }),
    h('span', { class: 'track' }), h('span', { class: 'thumb' }));
}

function dialog({ title, text, input, confirm, onConfirm }) {
  const field = input !== undefined ? h('input', { class: 'field', type: 'text', value: input, autocomplete: 'off', autocapitalize: 'off' }) : null;
  const close = () => scrim.remove();
  const ok = () => { close(); onConfirm(field ? field.value : undefined); };
  if (field) field.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
  const scrim = h('div', { class: 'scrim', onclick: (e) => { if (e.target === scrim) close(); } },
    h('div', { class: 'dialog', role: 'dialog' },
      h('h3', {}, title), text ? h('p', {}, text) : null, field,
      h('div', { class: 'actions' }, h('button', { onclick: close }, 'Cancel'), h('button', { onclick: ok }, confirm))));
  $dialogs.append(scrim);
  if (field) { field.focus(); field.select(); }
}

// ------------------------------------------------------------------ Pair screen

function buildPair() {
  const err = h('p', { class: 'err' });
  const input = h('input', {
    class: 'field code', type: 'text', placeholder: 'ABCD-EFGH-JKLM-NPQR', 'aria-label': 'Pairing code',
    autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', inputmode: 'text',
  });
  const button = h('button', { class: 'btn block', disabled: true }, 'Connect');
  const tryConnect = () => {
    if (!link.pair(input.value)) err.textContent = "That code isn't right - it's 16 letters and numbers, like ABCD-EFGH-JKLM-NPQR.";
    else { adding = false; update(); }
  };
  input.addEventListener('input', () => {
    const clean = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
    input.value = clean.match(/.{1,4}/g)?.join('-') ?? '';
    err.textContent = '';
    button.disabled = !normalizeCode(input.value);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && normalizeCode(input.value)) tryConnect(); });
  button.addEventListener('click', tryConnect);
  return h('div', { class: 'pair' },
    h('h1', {}, 'TitanMiner'),
    h('h2', {}, 'Link this phone to your client'),
    h('ol', {},
      h('li', {}, 'In Minecraft, press # to open the menu.'),
      h('li', {}, 'Go to Client > Phone Link and turn it on.'),
      h('li', {}, 'Type the code it shows below (or run /titan phone to see it in chat).')),
    input, err, button,
    link.code ? h('button', { class: 'btn outline block', onclick: () => { adding = false; update(); } }, 'Cancel') : null,
    h('p', { class: 'muted small' }, 'Works on Wi-Fi or mobile data, anywhere. Everything is encrypted with this code, so only your device and your client can read or send anything.'),
    h('div', { class: 'tip' },
      h('b', {}, 'On iPhone: '), 'tap Share, then Add to Home Screen, and open TitanMiner from your home screen before entering the code. ',
      h('b', {}, 'On Android: '), 'open the browser menu and choose Install app.'));
}

// ------------------------------------------------------------------ Main screen

const TABS = [['home', '⌂', 'Home'], ['modules', '☰', 'Modules'], ['chat', '\u{1F4AC}', 'Chat']];

function buildMain() {
  const back = h('button', { class: 'icon-btn', 'aria-label': 'Back', onclick: () => { openModule = null; update(); } }, '←');
  const title = h('h1');
  const more = h('button', { class: 'icon-btn', 'aria-label': 'More', onclick: (e) => { e.stopPropagation(); menuOpen = !menuOpen; update(); } }, '⋮');
  const view = h('main');
  const nav = h('nav', {}, TABS.map(([id, icon, name]) => h('button', {
    'data-tab': id, onclick: () => { if (tab === id && id === 'modules') openModule = null; tab = id; update(); },
  }, h('span', { class: 'ico' }, icon), name)));
  const menu = h('div', { class: 'menu' },
    h('button', { onclick: () => { menuOpen = false; adding = true; shell = null; update(); } }, 'Add computer'),
    h('button', { onclick: () => { menuOpen = false; const sel = link.selected; if (sel) link.hideAccount(sel.key); update(); } }, 'Hide this account'),
    h('button', { onclick: () => { menuOpen = false; update(); confirmUnpair(); } }, 'Unpair this computer'));
  menu.hidden = true;
  const header = h('header', {}, back, title, more);
  const chips = h('div', { class: 'chips' });
  $app.replaceChildren(header, chips, view, nav, menu);
  ui = { chips, back, title, more, view, nav, menu, banner: null, chat: null };
}

function renderChips() {
  const accounts = link.accounts, sel = link.selected, now = Date.now();
  const multiPc = new Set(accounts.map((a) => a.pc || '')).size > 1;
  const sig = JSON.stringify(accounts.map((a) => [a.key, a.name, a.pc, now - a.ts < 15000, sel && sel.key === a.key]));
  if (lastSig.chips === sig) return;
  lastSig.chips = sig;
  ui.chips.hidden = !accounts.length;
  ui.chips.replaceChildren(...accounts.map((a) => h('button', {
    class: 'chip' + (sel && sel.key === a.key ? ' on' : ''), 'data-account': a.name,
    onclick: () => link.selectAccount(a.key),
  }, h('span', { class: 'dot' + (now - a.ts < 15000 ? ' live' : '') }), multiPc && a.pc ? `${a.name} (${a.pc})` : a.name)));
}

function confirmUnpair() {
  dialog({
    title: 'Unpair this computer?', text: "All its accounts disappear from this list. You'll need to type the code from the client again to link it.",
    confirm: 'Unpair', onConfirm: () => link.unpairSelectedComputer(),
  });
}

function update() {
  if (!link.code) adding = false;
  if (!link.code || adding) {
    if (shell !== 'pair') { shell = 'pair'; lastSig = {}; $app.replaceChildren(buildPair()); }
  } else {
    if (shell !== 'main') { shell = 'main'; lastSig = {}; buildMain(); }
    const module = openModule && link.config ? link.config.modules.find((m) => m.id === openModule) : null;
    if (openModule && !module && link.config) openModule = null;
    ui.back.hidden = !(tab === 'modules' && module);
    ui.title.textContent = tab === 'modules' && module ? module.name : 'TitanMiner';
    ui.menu.hidden = !menuOpen;
    renderChips();
    ui.nav.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    if (tab === 'home') renderHome();
    else if (tab === 'modules') (module ? renderModule(module) : renderModules());
    else renderChat();
  }
  $toast.textContent = link.toast || '';
  $toast.classList.toggle('show', !!link.toast);
}

// ------------------------------------------------------------------ Home

function bannerContent() {
  const s = link.status, now = Date.now();
  if (!link.relaysUp) return ['warn', 'Connecting... (check your internet)'];
  if (!s) return ['warn', 'Waiting for your client - is the game running with Phone Link on?'];
  if (s.screen === 'Game closed') return ['bad', `Game closed ${ago(s.ts, now)} - start Minecraft to reconnect`];
  if (isOnline()) return ['good', `Client online - updated ${ago(s.ts, now)}`];
  return ['bad', `Client offline - last seen ${ago(s.ts, now)} (game closed or PC asleep?)`];
}

function card(title, ...content) {
  return h('div', { class: 'card' }, h('h2', {}, title), content);
}

const stat = (label, value, cls) => h('div', { class: 'stat' }, h('span', { class: 'muted' }, label), h('span', { class: cls || '' }, value));

function renderHome() {
  if (claimView('home')) {
    ui.banner = h('div', { class: 'banner' }, h('span', { class: 'dot' }), h('span', {}));
    ui.body = h('div');
    ui.view.append(ui.banner, ui.body);
  }
  tickBanner();
  const s = link.status;
  const wrap = h('div');
  if (!s) { setContent(ui.body, 'home', wrap); return; }
  const online = isOnline();
  const p = s.player;

  // Emergency stop, while something automated is running.
  if (online && s.automation) {
    wrap.append(h('button', { class: 'btn danger block', onclick: () => link.pressAction('failsafe.stop_all') }, 'Stop everything'));
  }

  // Server + reconnect.
  const canReconnect = online && !s.singleplayer && !!(s.server || s.lastServer);
  const name = s.serverName || s.server || s.lastServer || 'No server yet';
  wrap.append(card('Server',
    h('div', { class: 'big' }, name),
    s.server && s.serverName && s.serverName !== s.server ? h('div', { class: 'muted small' }, s.server) : null,
    h('div', { class: s.inWorld ? 'good' : 'bad', style: 'margin-top:4px' },
      s.inWorld ? `In game${p ? ' as ' + p.name : ''} - ${s.screen}` : s.screen),
    s.inWorld
      ? h('div', { class: 'btns' },
        h('button', { class: 'btn tonal', disabled: !canReconnect, onclick: () => link.reconnect() }, 'Reconnect'),
        h('button', { class: 'btn outline', disabled: !online, onclick: confirmLogOff }, 'Log off'))
      : h('div', { class: 'btns' },
        h('button', { class: 'btn block', disabled: !canReconnect, onclick: () => link.reconnect() }, `Reconnect to ${s.lastServer || 'server'}`))));

  // Balance.
  const b = s.balance || {};
  wrap.append(card('Balance', h('div', { class: 'row' },
    h('div', { class: 'grow' },
      b.amount ? h('div', { class: 'balance' }, b.amount) : h('div', { class: 'big muted' }, 'Not seen yet'),
      h('div', { class: 'muted small' }, b.amount ? `From ${b.source}, ${agoCoarse(b.at)}` : `Tap refresh to run /${String(b.command || 'bal').replace(/^\//, '')}`)),
    h('button', { class: 'icon-btn', 'aria-label': 'Refresh balance', disabled: !(online && s.inWorld), onclick: () => link.refreshBalance() }, '↻'))));

  // Player.
  if (p) {
    wrap.append(card('Player',
      stat('Health', `${fmt(p.health)} / ${fmt(p.maxHealth)}`, p.health <= p.maxHealth / 3 ? 'bad' : ''),
      stat('Food', `${p.food} / 20`, p.food <= 6 ? 'warn' : ''),
      stat('Position', `${p.x}, ${p.y}, ${p.z}`),
      stat('Dimension', String(p.dimension).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())),
      p.freeSlots >= 0 ? stat('Free slots', `${p.freeSlots} / 36`, p.freeSlots === 0 ? 'warn' : '') : null));
  }

  // Strip Miner.
  const m = s.miner || {};
  wrap.append(card('Strip Miner',
    h('div', { class: m.paused ? 'warn' : m.running ? 'good' : 'muted', style: 'font-weight:600' }, m.paused ? 'Paused' : m.running ? 'Running' : 'Stopped'),
    h('pre', { class: 'miner' }, m.status || m.state || ''),
    h('div', { class: 'btns' },
      h('button', { class: m.running ? 'btn danger' : 'btn', disabled: !(online && s.inWorld), onclick: () => link.pressAction('miner.control') },
        m.running ? 'Stop mining' : 'Start mining'))));

  for (const act of (s.activity || [])) wrap.append(card(act.title, h('pre', { class: 'miner' }, act.text)));

  if (s.path && s.path.active && s.path.status) wrap.append(card('Pathfinder', h('pre', { class: 'miner' }, s.path.status)));

  const sc = s.schedule || {};
  if (sc.enabled) {
    wrap.append(card('Schedule', h('div', {}, sc.text),
      sc.active ? h('div', { class: 'btns' }, h('button', { class: 'btn outline', disabled: !online, onclick: () => link.pressAction('schedule.status') }, 'Stop schedule')) : null));
  }
  // Failsafe alerts + notifications switch.
  const alerts = (s.alerts || []).slice(-3).reverse();
  const notifyBox = h('input', { type: 'checkbox' });
  notifyBox.checked = link.notifyAlerts;
  notifyBox.onchange = async () => {
    if (notifyBox.checked && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
      try { await Notification.requestPermission(); } catch (e) { /* ignore */ }
    }
    link.notifyAlerts = notifyBox.checked;
  };
  wrap.append(card('Alerts',
    ...(alerts.length ? alerts.map((a) => h('div', { class: 'warn small' }, a.text)) : [h('div', { class: 'muted small' }, 'No failsafe alerts.')]),
    h('label', { class: 'small', style: 'display:flex;gap:8px;align-items:center;margin-top:8px' }, notifyBox,
      'Notify me (while the app is open)')));

  if (s.licensed === false) wrap.append(h('p', { class: 'warn small' }, "The client isn't activated yet - enter the license key in game to change settings."));
  wrap.append(h('p', { class: 'muted small' }, `Client v${s.modVersion}`));
  setContent(ui.body, 'home', wrap);
}

function tickBanner() {
  if (!ui.banner) return;
  const [cls, text] = bannerContent();
  ui.banner.firstChild.className = 'dot ' + cls;
  if (ui.banner.lastChild.textContent !== text) ui.banner.lastChild.textContent = text;
}

function confirmLogOff() {
  dialog({
    title: 'Log off?', text: 'Stops the miner and leaves the server. You can reconnect from here.',
    confirm: 'Log off', onConfirm: () => link.disconnect(),
  });
}

// ------------------------------------------------------------------ Modules

function renderModules() {
  claimView('modules');
  if (dragging) return;
  const cfg = link.config;
  const wrap = h('div');
  if (!cfg) {
    wrap.append(h('p', { class: 'muted' }, "Waiting for the client's settings..."));
  } else {
    const cats = (cfg.categories && cfg.categories.length) ? cfg.categories : [...new Set(cfg.modules.map((m) => m.category))];
    for (const cat of cats) {
      const mods = cfg.modules.filter((m) => m.category === cat);
      if (!mods.length) continue;
      wrap.append(h('div', { class: 'cat' }, cat));
      for (const m of mods) {
        wrap.append(h('div', { class: 'module', onclick: () => { openModule = m.id; update(); ui.view.scrollTop = 0; } },
          h('div', { class: 'grow' }, h('div', { class: 'name' }, m.name), h('div', { class: 'muted small' }, m.description)),
          m.hasSwitch ? h('span', { onclick: (e) => e.stopPropagation() }, switchEl(m.enabled, (on) => link.setModule(m.id, on), m.name))
            : h('span', { class: 'muted' }, '›')));
      }
    }
  }
  setContent(ui.view, 'modules', wrap);
}

function renderModule(m) {
  claimView('module:' + m.id);
  if (dragging) return;
  const wrap = h('div');
  wrap.append(h('p', { class: 'muted' }, m.description));
  if (m.hasSwitch) {
    wrap.append(h('div', { class: 'setting' }, h('div', { class: 'grow big', style: 'font-size:18px' }, 'Enabled'),
      switchEl(m.enabled, (on) => link.setModule(m.id, on), 'Enabled')));
  }
  for (const s of m.settings) wrap.append(settingRow(s));
  if (!m.settings.length) wrap.append(h('p', { class: 'muted' }, 'No settings.'));
  setContent(ui.view, 'module:' + m.id, wrap);
}

function labels(s, extra) {
  const desc = [s.description, extra].filter(Boolean).join('\n');
  return h('div', { class: 'grow' }, h('div', { class: 'name' }, s.name),
    desc ? h('div', { class: 'muted small', style: 'white-space:pre-line' }, desc) : null);
}

function settingRow(s) {
  switch (s.type) {
    case 'toggle':
      return h('div', { class: 'setting' }, labels(s), switchEl(!!s.value, (v) => link.setToggle(s.key, v), s.name));
    case 'slider': {
      const decimals = s.step >= 1 ? 0 : (String(s.step).split('.')[1] || '').length;
      const shown = h('span', { class: 'value' }, formatSlider(s.value, s.step, s.suffix));
      const range = h('input', { type: 'range', min: s.min, max: s.max, step: s.step, value: s.value, 'aria-label': s.name });
      const end = () => { dragging = false; };
      range.addEventListener('pointerdown', () => { dragging = true; });
      range.addEventListener('touchstart', () => { dragging = true; }, { passive: true });
      range.addEventListener('input', () => {
        dragging = true;
        shown.textContent = formatSlider(Number(range.value), s.step, s.suffix);
      });
      range.addEventListener('change', () => {
        dragging = false;
        link.setSlider(s.key, Number(Number(range.value).toFixed(decimals)));
      });
      range.addEventListener('pointerup', end);
      range.addEventListener('touchend', end);
      range.addEventListener('pointercancel', end);
      return h('div', { class: 'setting col' }, h('div', { class: 'row' }, labels(s), shown), range);
    }
    case 'action':
      return h('div', { class: 'setting' }, labels(s),
        s.label && s.label !== '-' ? h('button', { class: 'btn tonal', onclick: () => link.pressAction(s.key) }, s.label) : null);
    case 'text':
      return h('div', {
        class: 'setting tap', role: 'button', onclick: () => dialog({
          title: s.name, text: s.description, input: s.value || '', confirm: 'Save', onConfirm: (v) => link.setText(s.key, v.trim()),
        }),
      }, labels(s), h('span', { class: 'value' }, s.value || 'None'));
    case 'keybind':
      return h('div', { class: 'setting' }, labels(s, 'Change keybinds in game'), h('span', { class: 'muted' }, s.value));
    default:
      return h('div');
  }
}

// ------------------------------------------------------------------ Chat

function renderChat() {
  if (!ui.chat) {
    const list = h('div', { class: 'chat-list' });
    const input = h('input', { class: 'field', type: 'text', placeholder: 'Message or /command', maxlength: '256', enterkeyhint: 'send', autocomplete: 'off' });
    const send = h('button', { class: 'btn', 'aria-label': 'Send', onclick: () => sendChat() }, '➤');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    input.addEventListener('input', refreshChatButtons);
    ui.chat = { root: h('div', { class: 'chat' }, list, h('div', { class: 'chat-send' }, input, send)), list, input, send, sig: '' };
  }
  const c = ui.chat;
  if (claimView('chat')) { ui.view.append(c.root); c.sig = ''; }
  const lines = (link.status && link.status.chat) || [];
  const sig = lines.length + ':' + (lines.length ? lines[lines.length - 1].n : '');
  if (sig !== c.sig) {
    const nearBottom = c.list.scrollHeight - c.list.scrollTop - c.list.clientHeight < 80 || !c.sig;
    c.sig = sig;
    c.list.replaceChildren(...(lines.length ? lines.map((l) => h('div', { class: 'chat-line' + (String(l.text).startsWith('[Titan]') ? ' titan' : '') },
      h('time', {}, new Date(l.t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })), h('span', {}, l.text)))
      : [h('p', { class: 'muted small' }, 'No chat yet. Messages from the server show here (turn off Send Chat in Phone Link to hide them).')]));
    if (nearBottom) c.list.scrollTop = c.list.scrollHeight;
  }
  refreshChatButtons();
}

function refreshChatButtons() {
  const c = ui.chat;
  if (!c) return;
  const inWorld = !!(link.status && link.status.inWorld);
  c.input.disabled = !inWorld;
  c.send.disabled = !inWorld || !c.input.value.trim();
}

function sendChat() {
  const c = ui.chat;
  const text = c.input.value.trim();
  if (!text) return;
  link.chat(text);
  c.input.value = '';
  refreshChatButtons();
}

// ------------------------------------------------------------------ Start

link.subscribe(() => update());
setInterval(() => {
  if (shell !== 'main') return;
  tickBanner();
  const online = isOnline();
  if (online !== lastOnline) { lastOnline = online; update(); } else renderChips();
}, 1000);
let lastOnline = false;
document.addEventListener('click', () => { if (menuOpen) { menuOpen = false; update(); } });

// Only connected while the page is on screen.
const visibility = () => (document.visibilityState === 'visible' ? link.onForeground() : link.onBackground());
document.addEventListener('visibilitychange', visibility);

// A phone's keyboard shrinks the visible area: keep the chat box above it.
if (window.visualViewport) {
  const fit = () => { $app.style.height = window.visualViewport.height + 'px'; window.scrollTo(0, 0); };
  window.visualViewport.addEventListener('resize', fit);
  fit();
}

// A link like .../#code=ABCD-EFGH-JKLM-NPQR pairs straight away (the code is removed from the address).
const fromLink = /^#code=([A-Za-z0-9 -]+)$/.exec(location.hash);
if (fromLink) {
  link.pair(fromLink[1]);
  history.replaceState(null, '', location.pathname + location.search);
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

update();
visibility();
