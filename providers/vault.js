// providers/vault.js — Local .kdbx password manager, with built-in TOTP
// Zero backend, zero network. kdbxweb parses the file in-extension.
//
// v6: TOTP is no longer a separate plaintext store. A 2FA secret is just
// another protected field on a vault entry (kdbx field key 'otp', the same
// convention KeePass/Bitwarden use), unlocked/locked/persisted with the
// rest of the vault instead of living forever in plaintext chrome.storage.
//
// Key management: the AES-GCM session key is wrapped with a per-session KEK
// stored in chrome.storage.session under a separate key. On Service-Worker
// restart the wrapped key is re-imported so the user does NOT have to
// unlock again during the same browser session.
//
// Flow:
//   unlock()  → generate AES-GCM data-key → wrap it with KEK →
//               store { wrappedKey, kekJwk } in chrome.storage.session →
//               store encrypted vault blob in chrome.storage.session
//   SW restart → _sessionKey is null → getOrMakeSessionKey() finds the
//               wrapped key in storage → unwraps → restores _sessionKey
//   lock()    → wipe both storage entries, null _sessionKey

import { register } from '../core/registry.js';

// ── Constants ────────────────────────────────────────────────────────────────
const IDB_DB = 'captain-vault', IDB_STORE = 'handles', IDB_KEY = 'kdbx-handle';
const SESSION_BLOB_KEY = 'vault.blob';       // encrypted vault entries
const SESSION_WRAPPED_KEY = 'vault.wk';      // { kekJwk, wrappedKey (b64) }

// ── kdbxweb dynamic loader ───────────────────────────────────────────────────
let _kdbxweb;
const getKdbxweb = async () =>
  _kdbxweb ??= await import(chrome.runtime.getURL('lib/kdbxweb.js'))
    .catch(() => { throw new Error('kdbxweb not found. Add lib/kdbxweb.js to the extension.'); });

// ── IndexedDB file-handle store ──────────────────────────────────────────────
const openIDB = () => new Promise((res, rej) => {
  const req = indexedDB.open(IDB_DB, 1);
  req.onupgradeneeded = ({ target }) => target.result.createObjectStore(IDB_STORE);
  req.onsuccess = ({ target }) => res(target.result);
  req.onerror   = ({ target }) => rej(target.error);
});
async function idbTx(mode, work) {
  const db = await openIDB();
  const tx = db.transaction(IDB_STORE, mode);
  const result = work(tx.objectStore(IDB_STORE));
  return new Promise((res, rej) => {
    tx.oncomplete = () => res(result);
    tx.onerror = () => rej(tx.error);
  });
}
const clearHandle = () => idbTx('readwrite', store => store.delete(IDB_KEY));
async function loadHandle() {
  const db  = await openIDB();
  const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(IDB_KEY);
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result ?? null);
    req.onerror   = () => rej(req.error);
  });
}

// ── Key management ───────────────────────────────────────────────────────────
// We keep the data-key in memory (_sessionKey). To survive SW restarts we
// wrap it with an ephemeral AES-KW KEK and store the wrapped form in
// chrome.storage.session (which is cleared when the browser closes).
let _sessionKey = null; // AES-GCM CryptoKey — in-memory only

const generateDataKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const generateKEK     = () => crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, true, ['wrapKey', 'unwrapKey']);

async function persistWrappedKey(dataKey) {
  const kek = await generateKEK();
  const [wrapped, kekJwk] = await Promise.all([
    crypto.subtle.wrapKey('raw', dataKey, kek, { name: 'AES-KW' }),
    crypto.subtle.exportKey('jwk', kek),
  ]);
  await chrome.storage.session.set({
    [SESSION_WRAPPED_KEY]: { kekJwk, wrappedKey: btoa(String.fromCharCode(...new Uint8Array(wrapped))) },
  });
}

async function restoreDataKey() {
  const { [SESSION_WRAPPED_KEY]: stored } = await chrome.storage.session.get(SESSION_WRAPPED_KEY);
  if (!stored?.kekJwk || !stored?.wrappedKey) return null;
  try {
    const kek     = await crypto.subtle.importKey('jwk', stored.kekJwk, { name: 'AES-KW' }, false, ['unwrapKey']);
    const wrapped = Uint8Array.from(atob(stored.wrappedKey), c => c.charCodeAt(0));
    return await crypto.subtle.unwrapKey('raw', wrapped, kek, { name: 'AES-KW' }, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } catch { return null; }
}

// Returns the data key, re-importing from storage if the SW restarted.
async function getOrMakeSessionKey() {
  if (_sessionKey) return _sessionKey;
  _sessionKey = await restoreDataKey();
  if (_sessionKey) return _sessionKey;
  _sessionKey = await generateDataKey();
  await persistWrappedKey(_sessionKey);
  return _sessionKey;
}

// ── Blob encrypt / decrypt ───────────────────────────────────────────────────
async function encryptBlob(obj) {
  const key = await getOrMakeSessionKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const buf = new Uint8Array(12 + enc.byteLength);
  buf.set(iv);
  buf.set(enc, 12);
  return btoa(String.fromCharCode(...buf));
}

async function decryptBlob(b64) {
  const key = await getOrMakeSessionKey(); // may restore from session storage
  if (!key) return null;
  const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  try {
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
    return JSON.parse(new TextDecoder().decode(dec));
  } catch { return null; }
}

// ── chrome.storage.session vault blob ────────────────────────────────────────
async function sessionGet() {
  const { [SESSION_BLOB_KEY]: raw } = await chrome.storage.session.get(SESSION_BLOB_KEY);
  if (!raw) return null;
  return typeof raw === 'string' ? decryptBlob(raw) : raw; // legacy plain-object fallback
}
const sessionSet = data => chrome.storage.session.set({ [SESSION_BLOB_KEY]: encryptBlob(data) });
async function sessionClear() {
  _sessionKey = null;
  await chrome.storage.session.remove([SESSION_BLOB_KEY, SESSION_WRAPPED_KEY]);
}

// ── Domain matching ──────────────────────────────────────────────────────────
const extractDomain = urlStr => { try { return new URL(urlStr).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
function entriesForDomain(entries, hostname) {
  if (!hostname || !entries) return [];
  const h = hostname.toLowerCase().replace(/^www\./, '');
  return entries.filter(({ url }) => {
    if (!url) return false;
    const ed = extractDomain(url);
    return ed && (ed === h || h.endsWith(`.${ed}`) || ed.endsWith(`.${h}`));
  });
}

// ── File reading ─────────────────────────────────────────────────────────────
async function readFileBytes(handle) {
  const granted = await handle.queryPermission({ mode: 'readwrite' }) === 'granted'
    || await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
  if (!granted) throw new Error('File permission denied');
  return (await handle.getFile()).arrayBuffer();
}

// ── kdbxweb parsing ──────────────────────────────────────────────────────────
async function parseKdbx(buffer, password, keyFileBuffer) {
  const kdbxweb = await getKdbxweb();
  const creds = new kdbxweb.Credentials(
    kdbxweb.ProtectedValue.fromString(password),
    keyFileBuffer ? kdbxweb.Credentials.createKeyFileCredentials(keyFileBuffer) : null,
  );
  return kdbxweb.Kdbx.load(buffer, creds);
}

const fieldText = (fields, key) => fields.get(key)?.getText?.() ?? fields.get(key) ?? '';

function dbToEntries(db) {
  const entries = [];
  const walk = group => {
    for (const entry of group.entries) {
      const f = entry.fields;
      entries.push({
        uuid: entry.uuid.id,
        title: fieldText(f, 'Title'),
        username: fieldText(f, 'UserName'),
        password: fieldText(f, 'Password'),
        url: fieldText(f, 'URL'),
        notes: fieldText(f, 'Notes'),
        otp: fieldText(f, 'otp') || null, // Base32 secret or full otpauth:// URI
        group: group.name,
      });
    }
    group.groups.forEach(walk);
  };
  walk(db.getDefaultGroup());
  return entries;
}

async function writeKdbx(db, handle) {
  const writable = await handle.createWritable();
  await writable.write(await db.save());
  await writable.close();
}

// ── TOTP (RFC 6238) ──────────────────────────────────────────────────────────
// Pure, stateless helpers — the secret always comes from an entry's `otp`
// field, never from a separate store. No third-party code involved.
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_ALGORITHMS = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' };

function base32Decode(input) {
  const clean = input.replace(/=+$/, '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) {
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val !== -1) bits += val.toString(2).padStart(5, '0');
  }
  const bytes = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return bytes;
}

function counterBytes(num) {
  const buf = new DataView(new ArrayBuffer(8));
  // JS numbers are safe integers well past any realistic 30s-period counter,
  // so a 32-bit split of the value is sufficient.
  buf.setUint32(4, num >>> 0);
  buf.setUint32(0, Math.floor(num / 2 ** 32));
  return new Uint8Array(buf.buffer);
}

async function hotp(secretBytes, counter, algorithm, digits) {
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: algorithm }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes(counter)));
  const offset = mac.at(-1) & 0x0f;
  const binCode = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binCode % 10 ** digits).padStart(digits, '0');
}

// Accepts either a raw Base32 secret or a full otpauth:// URI in the `otp` field.
function parseOtpField(otp) {
  if (!otp) return null;
  if (otp.startsWith('otpauth://')) {
    try {
      const url = new URL(otp);
      if (url.protocol !== 'otpauth:' || url.host !== 'totp') return null;
      const p = url.searchParams;
      return {
        secret: (p.get('secret') || '').trim(),
        algorithm: (p.get('algorithm') || 'SHA1').toUpperCase(),
        digits: parseInt(p.get('digits') || '6', 10),
        period: parseInt(p.get('period') || '30', 10),
      };
    } catch { return null; }
  }
  return { secret: otp.replace(/\s+/g, ''), algorithm: 'SHA1', digits: 6, period: 30 };
}

async function totpCode(otp, at = Date.now()) {
  const parsed = parseOtpField(otp);
  if (!parsed?.secret) return null;
  const { secret, algorithm, digits, period } = parsed;
  const counter = Math.floor(at / 1000 / period);
  const value = await hotp(base32Decode(secret), counter, TOTP_ALGORITHMS[algorithm] || 'SHA-1', digits);
  return { code: value, secondsLeft: period - (Math.floor(at / 1000) % period), period };
}

// Parses an otpauth://totp/... URI (the format encoded in 2FA QR codes) into
// entry fields, for prefilling the "add TOTP" form with issuer/label too.
function parseOtpauthUri(uri) {
  const url = new URL(uri);
  if (url.protocol !== 'otpauth:' || url.host !== 'totp') return null;
  const label = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const [issuerFromLabel, accountLabel] = label.includes(':') ? label.split(':') : [null, label];
  return {
    issuer: url.searchParams.get('issuer') || issuerFromLabel || '',
    label: (accountLabel || label).trim(),
    otp: uri,
  };
}

// ── In-memory DB reference ────────────────────────────────────────────────────
let _openDb = null, _openHandle = null;

// ── Core operations ───────────────────────────────────────────────────────────
async function unlock(password, keyFileBuffer) {
  const handle = await loadHandle();
  if (!handle) return { ok: false, error: 'no_file', msg: 'No vault file selected. Use vault:open first.' };

  let buffer;
  try { buffer = await readFileBytes(handle); }
  catch (e) { return { ok: false, error: 'permission', msg: String(e) }; }

  let db;
  try { db = await parseKdbx(buffer, password, keyFileBuffer); }
  catch { return { ok: false, error: 'bad_password', msg: 'Wrong password or corrupt file.' }; }

  const entries = dbToEntries(db);
  await sessionSet({ entries, locked: false });
  [_openDb, _openHandle] = [db, handle];
  return { ok: true, count: entries.length };
}

async function lock() {
  [_openDb, _openHandle] = [null, null];
  await sessionClear();
  return { ok: true };
}

async function getStatus() {
  const s = await sessionGet();
  if (!s || s.locked) return { unlocked: false };
  return { unlocked: true, count: s.entries?.length ?? 0, fileName: _openHandle?.name || '' };
}

const redact = ({ password: _, otp, ...e }) => ({ ...e, hasOtp: !!otp });

async function getEntriesForHostname(hostname) {
  const s = await sessionGet();
  if (!s || s.locked) return { ok: false, locked: true };
  return { ok: true, entries: entriesForDomain(s.entries, hostname).map(redact) };
}

async function searchEntries(query) {
  const s = await sessionGet();
  if (!s || s.locked) return { ok: false, locked: true };
  const q = (query || '').toLowerCase();
  const hits = q
    ? (s.entries || []).filter(e => e.title.toLowerCase().includes(q) || e.username.toLowerCase().includes(q) || e.url.toLowerCase().includes(q))
    : (s.entries || []);
  return { ok: true, entries: hits.map(redact) };
}

function findEntry(group, uuid) {
  for (const e of group.entries) if (e.uuid.id === uuid) return e;
  for (const g of group.groups) { const found = findEntry(g, uuid); if (found) return found; }
  return null;
}

async function saveEntry(entry) {
  if (!_openDb || !_openHandle) return { ok: false, error: 'locked' };
  const kdbxweb = await getKdbxweb();
  const defGroup = _openDb.getDefaultGroup();
  const kdbxEntry = (entry.uuid && findEntry(defGroup, entry.uuid)) || _openDb.createEntry(defGroup);

  const setField = (key, val) => kdbxEntry.fields.set(key, key === 'Password' ? kdbxweb.ProtectedValue.fromString(val) : val);
  setField('Title', entry.title ?? '');
  setField('UserName', entry.username ?? '');
  setField('Password', entry.password ?? '');
  setField('URL', entry.url ?? '');
  setField('Notes', entry.notes ?? '');
  if (entry.otp) setField('otp', entry.otp); else kdbxEntry.fields.delete('otp');

  try { await writeKdbx(_openDb, _openHandle); }
  catch (e) { return { ok: false, error: 'write_failed', msg: String(e) }; }

  await sessionSet({ entries: dbToEntries(_openDb), locked: false });
  return { ok: true, uuid: kdbxEntry.uuid.id };
}

async function deleteEntry(uuid) {
  if (!_openDb || !_openHandle) return { ok: false, error: 'locked' };
  const target = findEntry(_openDb.getDefaultGroup(), uuid);
  if (!target) return { ok: false, error: 'not_found' };
  _openDb.remove(target);

  try { await writeKdbx(_openDb, _openHandle); }
  catch (e) { return { ok: false, error: 'write_failed', msg: String(e) }; }

  await sessionSet({ entries: dbToEntries(_openDb), locked: false });
  return { ok: true };
}

async function entryByUuid(uuid) {
  const s = await sessionGet();
  if (!s || s.locked) return { ok: false, locked: true };
  const entry = s.entries?.find(e => e.uuid === uuid);
  return entry ? { ok: true, entry } : { ok: false, error: 'not_found' };
}

// ── Provider registration ─────────────────────────────────────────────────────
export async function init() {
  register('vault', async (q) => {
    const match = t => !q || t.toLowerCase().includes(q.toLowerCase());
    const status = await getStatus();
    const items = [];

    if (!status.unlocked) {
      if (match('vault password manager unlock totp 2fa'))
        items.push({ id: 'vault:open-ui', title: 'Vault: Open password manager', desc: 'Unlock your local .kdbx vault', emoji: '🔐', type: 'action' });
    } else {
      if (match('vault lock'))
        items.push({ id: 'vault:lock', title: 'Vault: Lock', desc: `${status.count} entries loaded — click to lock`, emoji: '🔒', type: 'action' });
      if (match('vault open password manager totp 2fa'))
        items.push({ id: 'vault:open-ui', title: 'Vault: Open', desc: 'Browse passwords and 2FA codes', emoji: '🔐', type: 'action' });
    }

    if (status.unlocked && q) {
      const res = await searchEntries(q);
      if (res.ok) {
        for (const e of res.entries.slice(0, 5)) {
          items.push({ id: `vault:fill:${e.uuid}`, title: e.title || e.url, desc: e.username || 'No username', emoji: '🔑', type: 'action' });
          if (e.hasOtp) items.push({ id: `vault:copy-otp:${e.uuid}`, title: `TOTP: Copy code for ${e.title || e.username}`, desc: 'Copies the current 6-digit code', emoji: '🔢', type: 'action' });
        }
      }
    }
    return items;
  });
}

// ── Message handlers ──────────────────────────────────────────────────────────
export const handlers = {
  'vault:unlock': ({ password, keyFile }) => unlock(password, keyFile ? base64ToBuffer(keyFile) : null),
  'vault:lock': () => lock(),
  'vault:status': () => getStatus(),
  'vault:for-hostname': ({ hostname }) => getEntriesForHostname(hostname),
  'vault:search': ({ query }) => searchEntries(query),

  'vault:get-password': async ({ uuid }) => {
    const r = await entryByUuid(uuid);
    return r.ok ? { ok: true, password: r.entry.password } : r;
  },

  'vault:save-entry': ({ entry }) => saveEntry(entry),
  'vault:delete-entry': ({ uuid }) => deleteEntry(uuid),

  'vault:forget-file': async () => {
    await Promise.all([clearHandle(), lock()]);
    return { ok: true };
  },

  'vault:open-ui': () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/vault.html') });
    return { ok: true };
  },

  'vault:fill': async ({ uuid }) => {
    const r = await entryByUuid(uuid);
    if (!r.ok) return r;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'vault:autofill', username: r.entry.username, password: r.entry.password }).catch(() => {});
    }
    return { ok: true };
  },

  // ── TOTP, now scoped to a vault entry instead of a separate store ──────────
  'vault:totp-list': async () => {
    const s = await sessionGet();
    if (!s || s.locked) return { ok: false, locked: true };
    const withOtp = (s.entries || []).filter(e => e.otp);
    const codes = await Promise.all(withOtp.map(e => totpCode(e.otp)));
    return { ok: true, accounts: withOtp.map((e, i) => ({ uuid: e.uuid, title: e.title, username: e.username, ...codes[i] })) };
  },

  'vault:totp-code': async ({ uuid }) => {
    const r = await entryByUuid(uuid);
    if (!r.ok) return r;
    const result = await totpCode(r.entry.otp);
    return result ? { ok: true, ...result } : { ok: false, error: 'invalid_secret' };
  },

  'vault:totp-parse-uri': ({ uri }) => {
    const parsed = uri?.startsWith('otpauth://') ? parseOtpauthUri(uri) : null;
    return parsed ? { ok: true, ...parsed } : { ok: false, error: 'invalid_uri' };
  },
};

// Dynamic per-entry palette actions (mirror the proxy:switch:<name> /
// ws:activate:<id> pattern used by other providers).
export function handleVaultAction(type) {
  if (type?.startsWith('vault:fill:')) {
    const uuid = type.slice('vault:fill:'.length);
    return () => handlers['vault:fill']({ uuid });
  }
  if (type?.startsWith('vault:copy-otp:')) {
    const uuid = type.slice('vault:copy-otp:'.length);
    return async () => {
      const r = await entryByUuid(uuid);
      if (!r.ok) return r;
      const result = await totpCode(r.entry.otp);
      return result ? { ok: true, code: result.code } : { ok: false, error: 'invalid_secret' };
    };
  }
  return null;
}

function base64ToBuffer(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
