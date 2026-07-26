// providers/vault.js — Local .kdbx password manager
// Zero backend, zero network. kdbxweb parses the file in-extension.
//
// v5 key-management: the AES-GCM session key is itself wrapped with a
// per-session KEK that is stored in chrome.storage.session under a separate
// key.  On Service-Worker restart the wrapped key is re-imported so the user
// does NOT have to unlock again during the same browser session.
//
// Flow:
//   unlock()  → generate AES-GCM data-key → wrap it with KEK →
//               store { wrappedKey, kekJwk } in chrome.storage.session →
//               store encrypted vault blob in chrome.storage.session
//   SW restart → _sessionKey is null → getOrMakeSessionKey() finds the
//               wrapped key in storage → unwraps → restores _sessionKey
//   lock()    → wipe both storage entries, null _sessionKey

import { register } from '../core/registry.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const IDB_DB    = 'captain-vault';
const IDB_STORE = 'handles';
const IDB_KEY   = 'kdbx-handle';

const SESSION_BLOB_KEY    = 'vault.blob';   // encrypted vault entries
const SESSION_WRAPPED_KEY = 'vault.wk';     // { kekJwk, wrappedKey (b64) }

// ── kdbxweb dynamic loader ────────────────────────────────────────────────────
let _kdbxweb = null;
async function getKdbxweb() {
  if (_kdbxweb) return _kdbxweb;
  const localUrl = chrome.runtime.getURL('lib/kdbxweb.js');
  try { _kdbxweb = await import(localUrl); return _kdbxweb; } catch {}
  throw new Error('kdbxweb not found. Add lib/kdbxweb.js to the extension.');
}

// ── IndexedDB file-handle store ───────────────────────────────────────────────
function openIDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
async function saveHandle(handle) {
  const db = await openIDB();
  const tx = db.transaction(IDB_STORE, 'readwrite');
  tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}
async function loadHandle() {
  const db  = await openIDB();
  const tx  = db.transaction(IDB_STORE, 'readonly');
  const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result ?? null);
    req.onerror   = () => rej(req.error);
  });
}
async function clearHandle() {
  const db = await openIDB();
  const tx = db.transaction(IDB_STORE, 'readwrite');
  tx.objectStore(IDB_STORE).delete(IDB_KEY);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

// ── Key-management helpers ────────────────────────────────────────────────────
// We keep the data-key in memory (_sessionKey).  To survive SW restarts we
// wrap it with an ephemeral AES-KW KEK and store the wrapped form in
// chrome.storage.session (which is cleared when the browser closes).

let _sessionKey = null;   // AES-GCM CryptoKey — in-memory only

async function generateDataKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function generateKEK() {
  return crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, true, ['wrapKey', 'unwrapKey']);
}

async function persistWrappedKey(dataKey) {
  const kek        = await generateKEK();
  const wrapped    = await crypto.subtle.wrapKey('raw', dataKey, kek, { name: 'AES-KW' });
  const kekJwk     = await crypto.subtle.exportKey('jwk', kek);
  const wrappedB64 = btoa(String.fromCharCode(...new Uint8Array(wrapped)));
  await chrome.storage.session.set({
    [SESSION_WRAPPED_KEY]: { kekJwk, wrappedKey: wrappedB64 },
  });
}

async function restoreDataKey() {
  const r = await chrome.storage.session.get(SESSION_WRAPPED_KEY);
  const stored = r[SESSION_WRAPPED_KEY];
  if (!stored?.kekJwk || !stored?.wrappedKey) return null;
  try {
    const kek     = await crypto.subtle.importKey('jwk', stored.kekJwk, { name: 'AES-KW' }, false, ['unwrapKey']);
    const wrapped = Uint8Array.from(atob(stored.wrappedKey), c => c.charCodeAt(0));
    return await crypto.subtle.unwrapKey('raw', wrapped, kek, { name: 'AES-KW' }, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  } catch { return null; }
}

// Returns the data key, re-importing from storage if SW restarted.
async function getOrMakeSessionKey() {
  if (_sessionKey) return _sessionKey;
  // Attempt to restore from wrapped-key store (SW may have restarted)
  const restored = await restoreDataKey();
  if (restored) { _sessionKey = restored; return _sessionKey; }
  // Brand-new session: generate, persist wrapper, return
  _sessionKey = await generateDataKey();
  await persistWrappedKey(_sessionKey);
  return _sessionKey;
}

// ── Blob encrypt / decrypt ────────────────────────────────────────────────────
async function encryptBlob(obj) {
  const key = await getOrMakeSessionKey();
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key,
    new TextEncoder().encode(JSON.stringify(obj)));
  const buf = new Uint8Array(12 + enc.byteLength);
  buf.set(iv); buf.set(new Uint8Array(enc), 12);
  return btoa(String.fromCharCode(...buf));
}

async function decryptBlob(b64) {
  const key = await getOrMakeSessionKey();   // may restore from session storage
  if (!key) return null;
  const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  try {
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12));
    return JSON.parse(new TextDecoder().decode(dec));
  } catch { return null; }
}

// ── chrome.storage.session vault blob ────────────────────────────────────────
async function sessionGet() {
  const r   = await chrome.storage.session.get(SESSION_BLOB_KEY);
  const raw = r[SESSION_BLOB_KEY];
  if (!raw) return null;
  if (typeof raw === 'string') return decryptBlob(raw);
  return raw; // legacy plain-object fallback
}
async function sessionSet(data) {
  await chrome.storage.session.set({ [SESSION_BLOB_KEY]: await encryptBlob(data) });
}
async function sessionClear() {
  _sessionKey = null;
  await chrome.storage.session.remove([SESSION_BLOB_KEY, SESSION_WRAPPED_KEY]);
}

// ── Domain matching ───────────────────────────────────────────────────────────
function extractDomain(urlStr) {
  try { return new URL(urlStr).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}
function entriesForDomain(entries, hostname) {
  if (!hostname || !entries) return [];
  const h = hostname.toLowerCase().replace(/^www\./, '');
  return entries.filter(e => {
    if (!e.url) return false;
    const ed = extractDomain(e.url);
    return ed && (ed === h || h.endsWith('.' + ed) || ed.endsWith('.' + h));
  });
}

// ── File reading ──────────────────────────────────────────────────────────────
async function readFileBytes(handle) {
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    const req = await handle.requestPermission({ mode: 'readwrite' });
    if (req !== 'granted') throw new Error('File permission denied');
  }
  const file   = await handle.getFile();
  return file.arrayBuffer();
}

// ── kdbxweb parsing ───────────────────────────────────────────────────────────
async function parseKdbx(buffer, password, keyFileBuffer) {
  const kdbxweb = await getKdbxweb();
  const creds   = new kdbxweb.Credentials(
    kdbxweb.ProtectedValue.fromString(password),
    keyFileBuffer ? kdbxweb.Credentials.createKeyFileCredentials(keyFileBuffer) : null,
  );
  return kdbxweb.Kdbx.load(buffer, creds);
}

function dbToEntries(db) {
  const entries = [];
  function walk(group) {
    for (const entry of group.entries) {
      const f = entry.fields;
      entries.push({
        uuid:     entry.uuid.id,
        title:    f.get('Title')?.getText?.()    ?? f.get('Title')    ?? '',
        username: f.get('UserName')?.getText?.() ?? f.get('UserName') ?? '',
        password: f.get('Password')?.getText?.() ?? '',
        url:      f.get('URL')?.getText?.()      ?? f.get('URL')      ?? '',
        notes:    f.get('Notes')?.getText?.()    ?? f.get('Notes')    ?? '',
        group:    group.name,
      });
    }
    for (const sub of group.groups) walk(sub);
  }
  walk(db.getDefaultGroup());
  return entries;
}

async function writeKdbx(db, handle) {
  const buffer   = await db.save();
  const writable = await handle.createWritable();
  await writable.write(buffer);
  await writable.close();
}

// ── In-memory DB reference ────────────────────────────────────────────────────
let _openDb     = null;
let _openHandle = null;

// ── Core operations ───────────────────────────────────────────────────────────
async function unlock(password, keyFileBuffer) {
  let handle = await loadHandle();
  if (!handle) return { ok: false, error: 'no_file', msg: 'No vault file selected. Use vault:open first.' };
  let buffer;
  try { buffer = await readFileBytes(handle); }
  catch (e) { return { ok: false, error: 'permission', msg: String(e) }; }
  let db;
  try { db = await parseKdbx(buffer, password, keyFileBuffer); }
  catch { return { ok: false, error: 'bad_password', msg: 'Wrong password or corrupt file.' }; }

  const entries = dbToEntries(db);
  await sessionSet({ entries, locked: false });
  _openDb     = db;
  _openHandle = handle;
  return { ok: true, count: entries.length };
}

async function lock() {
  _openDb     = null;
  _openHandle = null;
  await sessionClear();
  return { ok: true };
}

async function getStatus() {
  const s = await sessionGet();
  if (!s || s.locked) return { unlocked: false };
  return { unlocked: true, count: s.entries?.length ?? 0, fileName: _openHandle?.name || '' };
}

async function getEntriesForHostname(hostname) {
  const s = await sessionGet();
  if (!s || s.locked) return { ok: false, locked: true };
  const entries = entriesForDomain(s.entries, hostname)
    .map(({ password: _, ...e }) => e);
  return { ok: true, entries };
}

async function searchEntries(query) {
  const s = await sessionGet();
  if (!s || s.locked) return { ok: false, locked: true };
  const q = (query || '').toLowerCase();
  const hits = q
    ? (s.entries || []).filter(e =>
        e.title.toLowerCase().includes(q) ||
        e.username.toLowerCase().includes(q) ||
        e.url.toLowerCase().includes(q))
    : (s.entries || []);
  return { ok: true, entries: hits.map(({ password: _, ...e }) => e) };
}

async function saveEntry(entry) {
  if (!_openDb || !_openHandle) return { ok: false, error: 'locked' };
  const kdbxweb  = await getKdbxweb();
  const defGroup = _openDb.getDefaultGroup();

  let kdbxEntry;
  if (entry.uuid) {
    function findEntry(group) {
      for (const e of group.entries) if (e.uuid.id === entry.uuid) return e;
      for (const g of group.groups) { const r = findEntry(g); if (r) return r; }
      return null;
    }
    kdbxEntry = findEntry(defGroup);
  }
  if (!kdbxEntry) kdbxEntry = _openDb.createEntry(defGroup);

  const setField = (key, val) => {
    kdbxEntry.fields.set(key,
      key === 'Password' ? kdbxweb.ProtectedValue.fromString(val) : val);
  };
  setField('Title',    entry.title    ?? '');
  setField('UserName', entry.username ?? '');
  setField('Password', entry.password ?? '');
  setField('URL',      entry.url      ?? '');
  setField('Notes',    entry.notes    ?? '');

  try { await writeKdbx(_openDb, _openHandle); }
  catch (e) { return { ok: false, error: 'write_failed', msg: String(e) }; }

  await sessionSet({ entries: dbToEntries(_openDb), locked: false });
  return { ok: true, uuid: kdbxEntry.uuid.id };
}

async function deleteEntry(uuid) {
  if (!_openDb || !_openHandle) return { ok: false, error: 'locked' };
  function findAndRemove(group) {
    const idx = group.entries.findIndex(e => e.uuid.id === uuid);
    if (idx >= 0) { _openDb.remove(group.entries[idx]); return true; }
    for (const g of group.groups) if (findAndRemove(g)) return true;
    return false;
  }
  if (!findAndRemove(_openDb.getDefaultGroup())) return { ok: false, error: 'not_found' };
  try { await writeKdbx(_openDb, _openHandle); }
  catch (e) { return { ok: false, error: 'write_failed', msg: String(e) }; }
  await sessionSet({ entries: dbToEntries(_openDb), locked: false });
  return { ok: true };
}

// ── Provider registration ─────────────────────────────────────────────────────
export async function init() {
  register('vault', async (q) => {
    const match  = t => !q || t.toLowerCase().includes(q.toLowerCase());
    const status = await getStatus();
    const items  = [];

    if (!status.unlocked) {
      if (match('vault password manager unlock'))
        items.push({ id: 'vault:open-ui', title: 'Vault: Open password manager',
          desc: 'Unlock your local .kdbx vault', emoji: '🔐', type: 'action' });
    } else {
      if (match('vault lock'))
        items.push({ id: 'vault:lock', title: 'Vault: Lock',
          desc: `${status.count} entries loaded — click to lock`, emoji: '🔒', type: 'action' });
      if (match('vault open password manager'))
        items.push({ id: 'vault:open-ui', title: 'Vault: Open',
          desc: 'Browse and fill passwords', emoji: '🔐', type: 'action' });
    }

    if (status.unlocked && q) {
      const res = await searchEntries(q);
      if (res.ok) {
        for (const e of res.entries.slice(0, 5)) {
          items.push({
            id:    `vault:fill:${e.uuid}`,
            title: e.title || e.url,
            desc:  e.username || 'No username',
            emoji: '🔑',
            type:  'action',
          });
        }
      }
    }
    return items;
  });
}

// ── Message handlers ──────────────────────────────────────────────────────────
export const handlers = {
  'vault:unlock': async (msg) => {
    const keyBuf = msg.keyFile ? _b64ToBuffer(msg.keyFile) : null;
    return unlock(msg.password, keyBuf);
  },
  'vault:lock':         async ()    => lock(),
  'vault:status':       async ()    => getStatus(),
  'vault:for-hostname': async (msg) => getEntriesForHostname(msg.hostname),
  'vault:search':       async (msg) => searchEntries(msg.query),

  'vault:get-password': async (msg) => {
    const s = await sessionGet();
    if (!s || s.locked) return { ok: false, locked: true };
    const e = (s.entries || []).find(e => e.uuid === msg.uuid);
    if (!e) return { ok: false, error: 'not_found' };
    return { ok: true, password: e.password };
  },

  'vault:save-entry':   async (msg) => saveEntry(msg.entry),
  'vault:delete-entry': async (msg) => deleteEntry(msg.uuid),

  'vault:forget-file': async () => {
    await Promise.all([clearHandle(), lock()]);
    return { ok: true };
  },

  'vault:open-ui': async () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/vault.html') });
    return { ok: true };
  },

  'vault:fill': async (msg) => {
    const s = await sessionGet();
    if (!s || s.locked) return { ok: false, locked: true };
    const e = (s.entries || []).find(e => e.uuid === msg.uuid);
    if (!e) return { ok: false, error: 'not_found' };
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'vault:autofill',
        username: e.username,
        password: e.password,
      }).catch(() => {});
    }
    return { ok: true };
  },
};

function _b64ToBuffer(b64) {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
