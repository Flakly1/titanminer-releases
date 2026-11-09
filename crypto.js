// Same scheme as LinkCrypto.java: the pairing code gives an AES-256 key and the relay topic names.
// Message: version byte (1), 12-byte nonce, AES-GCM of the gzipped JSON, the topic as authenticated data.

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 16;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** The code upper-cased without dashes or spaces, or null if it isn't a valid code. */
export function normalizeCode(code) {
  if (typeof code !== 'string') return null;
  let clean = '';
  for (const c of code) {
    if (c === '-' || /\s/.test(c)) continue;
    if (c.charCodeAt(0) > 127) return null;
    const up = c.toUpperCase();
    if (!ALPHABET.includes(up)) return null;
    clean += up;
  }
  return clean.length === CODE_LENGTH ? clean : null;
}

export function formatCode(clean) {
  return clean.match(/.{1,4}/g).join('-');
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** Slow on purpose (PBKDF2, 120k rounds), so do it once. */
export async function deriveLink(code) {
  const clean = normalizeCode(code);
  if (!clean) throw new Error('Invalid pairing code');
  const material = await crypto.subtle.importKey('raw', enc.encode(clean), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('titanminer-phone-link-v1'), iterations: 120000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('titanminer-topic|' + clean)));
  return { key, topicBase: 'tmlink/' + hex(digest.slice(0, 12)) };
}

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.length > 8 * 1024 * 1024) throw new Error('Message too big');
  return out;
}

export async function seal(link, topic, json) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: enc.encode(topic), tagLength: 128 },
    link.key, await gzip(enc.encode(json))));
  const out = new Uint8Array(1 + 12 + encrypted.length);
  out[0] = 1;
  out.set(nonce, 1);
  out.set(encrypted, 13);
  return out;
}

/** The JSON, or null if the message wasn't made with this code (or was tampered with). */
export async function open(link, topic, message) {
  if (!message || message.length < 1 + 12 + 16 || message[0] !== 1) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: message.slice(1, 13), additionalData: enc.encode(topic), tagLength: 128 },
      link.key, message.slice(13));
    return dec.decode(await gunzip(new Uint8Array(plain)));
  } catch (e) {
    return null;
  }
}
