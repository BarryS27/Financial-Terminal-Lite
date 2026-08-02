// providers/screen-lock.js — Password-gated browser lockdown
// Derived from Chrome Lockdown's core behavior (PBKDF2 password + window
// snapshot/restore). Rewritten from scratch against Captain's provider
// pattern; none of the original bundle's code is reused.
//
// Dropped from the original (all were unconditional, always-on CPU/fan
// sources or telemetry with no user-facing value):
//   • the 3-second "focus shield" alarm that permanently monkey-patched
//     chrome.windows.* / chrome.tabs.* on every install
//   • a duplicated 10-second "reassert" alarm (defined twice) plus a
//     10-second heartbeat ping sent *from* the lock screen itself
//   • wake/focus debug loggers that wrote an ever-growing event log to
//     storage on every window/tab event
//   • the welcome-page / uninstall-survey redirects to a third-party site
//
// Kept and reimplemented cleanly:
//   • PBKDF2-SHA256 password hash (Web Crypto, matches modern best practice)
//   • lock = snapshot all windows/tabs → open lock window → close the rest
//   • unlock = verify password → restore windows/tabs from the snapshot
//   • a single low-frequency alarm to recreate the lock window only if the
//     user somehow closes it while still locked (not a busy-loop)

import { register } from '../core/registry.js';
import { get, set, remove } from '../core/storage.js';

const KEY_HASH      = 'c.lock.hash';       // { salt, hash, iterations } (hex)
const KEY_LOCKED     = 'c.lock.locked';
const KEY_LOCK_WINID = 'c.lock.windowId';
const KEY_SNAPSHOT   = 'c.lock.snapshot';
const KEY_ASK_ON_START = 'c.lock.askOnStartup';

const LOCK_URL   = chrome.runtime.getURL('pages/screen-lock.html');
const GUARD_ALARM = 'captain-lock-guard';   // low-frequency: recreates the lock window if it vanishes

const PBKDF2_ITERATIONS = 200_000; // modern OWASP-recommended floor for PBKDF2-SHA256
const KEY_LEN_BITS = 256;

// ── Crypto helpers ─────────────────────────────────────────────────────────────
const toHex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = hex => new Uint8Array(hex.match(/../g).map(b => parseInt(b, 16))).buffer;

async function deriveHash(password, saltHex, iterations) {
  const baseKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations, hash: 'SHA-256' }, baseKey, KEY_LEN_BITS);
  return toHex(bits);
}

async function savePassword(password) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const hash = await deriveHash(password, salt, PBKDF2_ITERATIONS);
  await set(KEY_HASH, { salt, hash, iterations: PBKDF2_ITERATIONS });
}

async function verifyPassword(password) {
  const cfg = await get(KEY_HASH);
  if (!cfg) return false;
  const hash = await deriveHash(password, cfg.salt, cfg.iterations || PBKDF2_ITERATIONS);
  return hash === cfg.hash;
}

async function hasPassword() { return !!(await get(KEY_HASH)); }
async function isLocked()    { return !!(await get(KEY_LOCKED)); }

// ── Window snapshot / restore ─────────────────────────────────────────────────
async function snapshotWindows(excludeId) {
  const wins = await chrome.windows.getAll({ populate: true });
  const snap = [];
  for (const w of wins) {
    if (w.id === excludeId || (w.type && w.type !== 'normal')) continue;
    const tabs = (w.tabs || []).map(t => ({ url: t.url || 'about:blank', pinned: !!t.pinned, active: !!t.active }));
    if (tabs.length) snap.push({ bounds: { left: w.left, top: w.top, width: w.width, height: w.height, state: w.state, focused: !!w.focused }, tabs });
  }
  return snap;
}

async function restoreWindows(snap) {
  if (!snap?.length) return;
  for (const w of snap) {
    const [first, ...rest] = w.tabs;
    let win;
    try { win = await chrome.windows.create({ url: first.url, focused: w.bounds.focused }); }
    catch { continue; }
    for (const t of rest) {
      await chrome.tabs.create({ windowId: win.id, url: t.url, pinned: t.pinned, active: false }).catch(() => {});
    }
    const activeIdx = w.tabs.findIndex(t => t.active);
    if (activeIdx > 0) {
      const tabs = await chrome.tabs.query({ windowId: win.id });
      if (tabs[activeIdx]) chrome.tabs.update(tabs[activeIdx].id, { active: true }).catch(() => {});
    }
    if (w.bounds.state && w.bounds.state !== 'minimized') {
      chrome.windows.update(win.id, { state: w.bounds.state }).catch(() => {});
    } else if (w.bounds.width) {
      chrome.windows.update(win.id, { left: w.bounds.left, top: w.bounds.top, width: w.bounds.width, height: w.bounds.height }).catch(() => {});
    }
  }
}

async function closeAllExcept(keepId) {
  const wins = await chrome.windows.getAll({ populate: false });
  await Promise.all(wins.filter(w => w.id !== keepId).map(w => chrome.windows.remove(w.id).catch(() => {})));
}

async function openLockWindow() {
  const created = await chrome.windows.create({ url: LOCK_URL, type: 'popup', focused: true, width: 420, height: 480 });
  await set(KEY_LOCK_WINID, created.id);
  return created.id;
}

// ── Guard alarm (low-frequency, only while locked) ────────────────────────────
// Unlike the original extension's 3s/10s busy-loops, this alarm runs at
// Chrome's minimum practical period (30s) and does nothing unless the lock
// window has actually disappeared — e.g. force-closed via task manager.
async function ensureGuardAlarm(active) {
  await chrome.alarms.clear(GUARD_ALARM);
  if (active) chrome.alarms.create(GUARD_ALARM, { periodInMinutes: 0.5 });
}

async function guardTick() {
  if (!(await isLocked())) { await ensureGuardAlarm(false); return; }
  const winId = await get(KEY_LOCK_WINID);
  const stillOpen = winId != null && await chrome.windows.get(winId).catch(() => null);
  if (!stillOpen) {
    const newId = await openLockWindow();
    await closeAllExcept(newId);
  }
}

// ── Core operations ───────────────────────────────────────────────────────────
async function doLock() {
  if (await isLocked()) return { ok: true };
  const lockId = await openLockWindow();
  await set(KEY_SNAPSHOT, await snapshotWindows(lockId));
  await closeAllExcept(lockId);
  await set(KEY_LOCKED, true);
  await ensureGuardAlarm(true);
  return { ok: true };
}

async function doUnlock(password) {
  if (!(await hasPassword())) return { ok: false, error: 'no_password' };
  if (!(await verifyPassword(password))) return { ok: false, error: 'wrong_password' };
  const snap = await get(KEY_SNAPSHOT);
  await set(KEY_LOCKED, false);
  await ensureGuardAlarm(false);
  await restoreWindows(snap);
  await remove(KEY_SNAPSHOT);
  const lockId = await get(KEY_LOCK_WINID);
  if (lockId != null) await chrome.windows.remove(lockId).catch(() => {});
  await remove(KEY_LOCK_WINID);
  return { ok: true };
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function init() {
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === GUARD_ALARM) guardTick(); });

  // If the browser restarted while locked, re-show the lock screen (snapshot
  // is preserved; no new snapshot needed since nothing was ever restored).
  chrome.runtime.onStartup.addListener(async () => {
    if (await isLocked()) {
      const lockId = await openLockWindow();
      await closeAllExcept(lockId);
      await ensureGuardAlarm(true);
    } else if (await get(KEY_ASK_ON_START) && await hasPassword()) {
      await doLock();
    }
  });

  register('screen-lock', async (q) => {
    const match = t => !q || t.toLowerCase().includes(q.toLowerCase());
    const items = [];
    if (await hasPassword()) {
      if (match('lock browser screen now'))
        items.push({ id: 'screen-lock:lock-now', title: 'Lock Screen: Lock now', desc: 'Hide all windows behind a password', emoji: '🔒', type: 'action' });
    } else if (match('lock screen set password')) {
      items.push({ id: 'screen-lock:open-options', title: 'Lock Screen: Set a password', desc: 'Enable password-gated lockdown', emoji: '🔒', type: 'action' });
    }
    return items;
  });
}

export const handlers = {
  'screen-lock:status': async () => ({
    ok: true, hasPassword: await hasPassword(), locked: await isLocked(), askOnStartup: !!(await get(KEY_ASK_ON_START)),
  }),
  'screen-lock:set-password': async (msg) => {
    if (!msg.password) return { ok: false, error: 'empty' };
    await savePassword(msg.password);
    return { ok: true };
  },
  'screen-lock:change-password': async (msg) => {
    if (!(await verifyPassword(msg.oldPassword || ''))) return { ok: false, error: 'wrong_password' };
    await savePassword(msg.newPassword || '');
    return { ok: true };
  },
  'screen-lock:set-ask-on-startup': async (msg) => { await set(KEY_ASK_ON_START, !!msg.enabled); return { ok: true }; },
  'screen-lock:lock-now':   async () => doLock(),
  'screen-lock:unlock':     async (msg) => doUnlock(msg.password || ''),
  'screen-lock:verify':     async (msg) => ({ ok: true, valid: await verifyPassword(msg.password || '') }),
  'screen-lock:open-options': async () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/options.html#screen-lock') });
    return { ok: true };
  },
};
