// providers/webtime.js — Site usage signal for Focus Guard
//
// This is NOT a standalone time-tracking product. Captain's own lineage
// (LeechBlock, uBlacklist, WebRTC Control, Cookie Editor…) is about
// reducing tracking and enforcing control, not building a self-quantifying
// dashboard of your own behaviour. So this provider does one narrow job:
// quietly note how long you spend per domain over the last week, purely so
// the Focus Guard panel can show "here's what's actually eating your time"
// next to the block-set editor. There is no separate page, no charts, no
// toolbar badge, and no palette command — it only surfaces inside Focus
// Guard's own settings, off by default, and rows older than 14 days are
// dropped automatically rather than kept forever.
//
// Timing approach mirrors Tab Sleep / Focus Guard's own philosophy: only
// the active tab, in the focused window, while the system isn't idle —
// driven by tab/window/idle events, with a 30s alarm as a safety net for a
// tab that just sits there with no browser events firing (see background.js
// for why an unconditional interval is the wrong call here).

import { get, set } from '../core/storage.js';

const PREFS_KEY      = 'c.webtime.prefs';
const DOMAINS_KEY    = 'c.webtime.domains';
const CHECKPOINT_KEY = 'c.webtime.checkpoint';

const ALARM_TICK = 'c-webtime-tick';
const ALARM_SAVE = 'c-webtime-save';

const RETENTION_DAYS = 14;
const IDLE_SECONDS   = 60;

const DEFAULT_PREFS = {
  enabled:    false,  // opt-in — Captain never starts logging your browsing on its own
  ignoreList: [],      // hostnames / *.wildcard / /regex/ never recorded
};

const UNTRACKABLE_PROTOCOLS = new Set([
  'chrome:', 'chrome-extension:', 'edge:', 'about:', 'moz-extension:', 'devtools:', 'file:',
]);

let _prefs   = { ...DEFAULT_PREFS };
let _domains = {};        // { host: { days: { 'YYYY-MM-DD': seconds } } }

let _trackedTab     = null;  // { id, url } | null
let _lastCheckpoint = Date.now();
let _dirty           = false;

// ── Small local helpers ─────────────────────────────────────────────────────
const hostnameOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const dayKey = (ts = Date.now()) => new Date(ts).toLocaleDateString('sv'); // YYYY-MM-DD

function lastNDays(n, from = Date.now()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() - i);
    out.push(dayKey(d.getTime()));
  }
  return out;
}

function matchesIgnore(host, list) {
  if (!host || !list?.length) return false;
  return list.some(rule => {
    rule = (rule || '').trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith('/') && rule.endsWith('/')) {
      try { return new RegExp(rule.slice(1, -1)).test(host); } catch { return false; }
    }
    rule = rule.replace(/^\*\./, '');
    return host === rule || host.endsWith('.' + rule);
  });
}

function isTrackable(url, ignoreList) {
  if (!url) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (UNTRACKABLE_PROTOCOLS.has(u.protocol)) return false;
  if (!/^https?:$/.test(u.protocol)) return false;
  if (!u.hostname) return false;
  if (matchesIgnore(u.hostname, ignoreList)) return false;
  return true;
}

// Rows older than the retention window are dropped on every save — this is
// a rolling week-scale signal for Focus Guard, not a permanent log.
function pruneOldDays() {
  const keep = new Set(lastNDays(RETENTION_DAYS));
  for (const host of Object.keys(_domains)) {
    const rec = _domains[host];
    for (const day of Object.keys(rec.days)) {
      if (!keep.has(day)) delete rec.days[day];
    }
    if (!Object.keys(rec.days).length) delete _domains[host];
  }
}

// ── Persistence ─────────────────────────────────────────────────────────────
async function loadState() {
  _prefs   = { ...DEFAULT_PREFS, ...(await get(PREFS_KEY) || {}) };
  _domains = (await get(DOMAINS_KEY)) || {};

  const cp = await get(CHECKPOINT_KEY);
  if (cp?.tab?.id != null) {
    const stillOpen = await chrome.tabs.get(cp.tab.id).then(() => true).catch(() => false);
    if (stillOpen) { _trackedTab = cp.tab; _lastCheckpoint = cp.ts || Date.now(); }
  }
}

async function saveIfDirty() {
  if (!_dirty) return;
  _dirty = false;
  pruneOldDays();
  await set(DOMAINS_KEY, _domains);
  await set(CHECKPOINT_KEY, { ts: _lastCheckpoint, tab: _trackedTab });
}

// ── Tracking core ────────────────────────────────────────────────────────────
function attribute(seconds, url, now) {
  const host = hostnameOf(url);
  if (!host || seconds <= 0) return;
  const rec = _domains[host] ?? (_domains[host] = { days: {} });
  const day = dayKey(now);
  rec.days[day] = (rec.days[day] || 0) + seconds;
  _dirty = true;
}

async function queryIdleState() {
  try { return await chrome.idle.queryState(IDLE_SECONDS); }
  catch { return 'active'; }
}

let _queue = Promise.resolve();
function serialize(fn) { _queue = _queue.then(fn, fn); return _queue; }

async function doCycle() {
  if (!_prefs.enabled) {
    if (_trackedTab) { _trackedTab = null; _dirty = true; }
    return;
  }

  const now = Date.now();

  if (_trackedTab && _lastCheckpoint) {
    const elapsedSec = Math.min(Math.round((now - _lastCheckpoint) / 1000), 30);
    if (elapsedSec > 0) attribute(elapsedSec, _trackedTab.url, now);
  }
  _lastCheckpoint = now;

  const win = await chrome.windows.getLastFocused({ populate: true }).catch(() => null);
  const activeTab = win?.tabs?.find(t => t.active);

  if (!win || !win.focused || !activeTab || !isTrackable(activeTab.url, _prefs.ignoreList)) {
    if (_trackedTab) _dirty = true;
    _trackedTab = null;
    return;
  }

  const idleState = await queryIdleState();
  if (idleState !== 'active') {
    if (_trackedTab) _dirty = true;
    _trackedTab = null;
    return;
  }

  const changed = _trackedTab?.id !== activeTab.id || _trackedTab?.url !== activeTab.url;
  _trackedTab = { id: activeTab.id, url: activeTab.url };
  if (changed) _dirty = true;
}

async function setupAlarms() {
  await chrome.alarms.clear(ALARM_TICK).catch(() => {});
  await chrome.alarms.clear(ALARM_SAVE).catch(() => {});
  if (_prefs.enabled) {
    chrome.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
    chrome.alarms.create(ALARM_SAVE, { periodInMinutes: 1 });
  }
}

// ── Reporting (last 7 days only — this feeds a "what's worth blocking?"
// decision, not a historical archive) ───────────────────────────────────────
function computeUsage() {
  const days = lastNDays(7);
  let weekSeconds = 0;
  const perDomain = [];
  for (const [host, rec] of Object.entries(_domains)) {
    let sec = 0;
    for (const d of days) sec += rec.days[d] || 0;
    if (sec > 0) perDomain.push({ domain: host, seconds: sec });
    weekSeconds += sec;
  }
  perDomain.sort((a, b) => b.seconds - a.seconds);
  return { weekSeconds, top: perDomain.slice(0, 8), siteCount: perDomain.length };
}

async function setPrefs(patch) {
  _prefs = { ..._prefs, ...patch };
  await set(PREFS_KEY, _prefs);
  await setupAlarms();
  return _prefs;
}

async function clearData() {
  _domains = {};
  _dirty = true;
  await saveIfDirty();
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function init() {
  await loadState();
  await setupAlarms();
  if (chrome.idle) chrome.idle.setDetectionInterval(IDLE_SECONDS);

  chrome.tabs.onActivated.addListener(() => serialize(doCycle));
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === 'complete' || info.url) serialize(doCycle);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (_trackedTab?.id === tabId) { _trackedTab = null; _dirty = true; }
    serialize(doCycle);
  });
  chrome.windows.onFocusChanged.addListener(() => serialize(doCycle));
  if (chrome.idle) chrome.idle.onStateChanged.addListener(() => serialize(doCycle));

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM_TICK) serialize(doCycle);
    else if (alarm.name === ALARM_SAVE) saveIfDirty();
  });
  chrome.runtime.onSuspend?.addListener(() => saveIfDirty());

  // Deliberately no register('webtime', …) here — this isn't a feature you
  // reach for through the command palette, it's ambient context inside the
  // Focus Guard panel. See panel-focus-guard's "Site Usage" section.
  serialize(doCycle);
}

export const handlers = {
  'webtime:get-usage':  async () => ({ ok: true, prefs: _prefs, ...computeUsage() }),
  'webtime:set-prefs':  async (msg) => ({ ok: true, prefs: await setPrefs(msg.patch || {}) }),
  'webtime:clear-data': async () => { await clearData(); return { ok: true }; },
};
