// providers/webtime.js — Web Time tracker integrated into Captain
// Core idea reimplemented from the standalone "Webtime Tracker" extension,
// against Captain's own provider architecture:
//   • Times only the active tab in the focused window, while the system is
//     not idle/locked (mirrors Focus Guard's "don't fake it" philosophy).
//   • Event-driven, not a 1s setInterval — see background.js's note on why
//     the old FG ticker was the dominant idle CPU/fan-noise source. A short
//     alarm (30s) is only a safety net for a tab that just sits there with
//     no browser events firing.
//   • All data stays local (chrome.storage.local) — nothing phones home,
//     and per-site favicons are never fetched from a third party (Captain
//     is a privacy tool; a coloured initial dot is used in the UI instead).

import { register }        from '../core/registry.js';
import { get, set }        from '../core/storage.js';
import { expose }          from '../core/bus.js';

const PREFS_KEY      = 'c.webtime.prefs';
const DOMAINS_KEY     = 'c.webtime.domains';
const META_KEY        = 'c.webtime.meta';
const CHECKPOINT_KEY  = 'c.webtime.checkpoint';

const ALARM_TICK = 'c-webtime-tick';
const ALARM_SAVE = 'c-webtime-save';

const DEFAULT_PREFS = {
  enabled:      true,
  badgeDisplay: false,   // off by default — keeps Captain's icon clean unless opted in
  trackOnMedia: false,   // keep timing a tab that's playing audio/video while idle
  idleSeconds:  60,      // consider the system idle after this many seconds
  ignoreList:   [],       // hostnames / *.wildcard / /regex/ never tracked
};

const UNTRACKABLE_PROTOCOLS = new Set([
  'chrome:', 'chrome-extension:', 'edge:', 'about:', 'moz-extension:', 'devtools:', 'file:',
]);

let _prefs   = { ...DEFAULT_PREFS };
let _domains = {};
let _meta    = { dateStart: null };

let _trackedTab    = null;  // { id, url } | null
let _lastCheckpoint = Date.now();
let _dirty          = false;

// ── Small local helpers ─────────────────────────────────────────────────────
const hostnameOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

// Locale-independent YYYY-MM-DD, same trick used elsewhere in the codebase
// for date bucket keys.
const dayKey = (ts = Date.now()) => new Date(ts).toLocaleDateString('sv');

function lastNDays(n, from = Date.now()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() - i);
    out.push(dayKey(d.getTime()));
  }
  return out; // [today, today-1, ..., today-(n-1)]
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

function badgeText(seconds) {
  if (seconds < 60) return '';
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h';
}

// ── Persistence ─────────────────────────────────────────────────────────────
async function loadState() {
  _prefs   = { ...DEFAULT_PREFS, ...(await get(PREFS_KEY) || {}) };
  _domains = (await get(DOMAINS_KEY)) || {};
  _meta    = (await get(META_KEY)) || {};
  if (!_meta.dateStart) { _meta.dateStart = dayKey(); await set(META_KEY, _meta); }

  const cp = await get(CHECKPOINT_KEY);
  if (cp?.tab?.id != null) {
    // Only resume if the tab is still around — otherwise start fresh.
    const stillOpen = await chrome.tabs.get(cp.tab.id).then(() => true).catch(() => false);
    if (stillOpen) {
      _trackedTab      = cp.tab;
      _lastCheckpoint  = cp.ts || Date.now();
    }
  }
}

async function saveIfDirty() {
  if (!_dirty) return;
  _dirty = false;
  await set(DOMAINS_KEY, _domains);
  await set(CHECKPOINT_KEY, { ts: _lastCheckpoint, tab: _trackedTab });
}

// ── Tracking core ────────────────────────────────────────────────────────────
function attribute(seconds, url, now) {
  const host = hostnameOf(url);
  if (!host || seconds <= 0) return;
  const day    = dayKey(now);
  const rec    = _domains[host] ?? (_domains[host] = { alltime: { seconds: 0 }, days: {} });
  const bucket = rec.days[day]  ?? (rec.days[day]  = { seconds: 0 });
  rec.alltime.seconds += seconds;
  bucket.seconds       += seconds;
  _dirty = true;
}

async function queryIdleState() {
  try { return await chrome.idle.queryState(_prefs.idleSeconds || 60); }
  catch { return 'active'; }
}

async function updateBadge(tabId, host) {
  if (!_prefs.badgeDisplay || tabId == null) return;
  try {
    const secs = _domains[host]?.days?.[dayKey()]?.seconds || 0;
    await chrome.action.setBadgeText({ tabId, text: badgeText(secs) });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#3d7dd8' }).catch(() => {});
  } catch { /* tab may already be gone */ }
}

// Simple promise-chain lock so overlapping browser events can't race each
// other while reading/mutating the in-memory checkpoint.
let _queue = Promise.resolve();
function serialize(fn) {
  _queue = _queue.then(fn, fn);
  return _queue;
}

async function doCycle() {
  if (!_prefs.enabled) {
    if (_trackedTab) { _trackedTab = null; _dirty = true; }
    return;
  }

  const now = Date.now();

  // Settle whatever time accrued on the previously tracked tab. Capped so a
  // suspended/sleeping service worker never dumps a huge backlog onto one site.
  if (_trackedTab && _lastCheckpoint) {
    const elapsedSec = Math.min(Math.round((now - _lastCheckpoint) / 1000), 30);
    if (elapsedSec > 0) {
      attribute(elapsedSec, _trackedTab.url, now);
      updateBadge(_trackedTab.id, hostnameOf(_trackedTab.url));
    }
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
  if (idleState === 'locked') { if (_trackedTab) _dirty = true; _trackedTab = null; return; }
  if (idleState === 'idle' && !(_prefs.trackOnMedia && activeTab.audible)) {
    if (_trackedTab) _dirty = true;
    _trackedTab = null;
    return;
  }

  const changed = _trackedTab?.id !== activeTab.id || _trackedTab?.url !== activeTab.url;
  _trackedTab = { id: activeTab.id, url: activeTab.url };
  if (changed) _dirty = true;
  updateBadge(activeTab.id, hostnameOf(activeTab.url));
}

async function setupAlarms() {
  await chrome.alarms.clear(ALARM_TICK).catch(() => {});
  await chrome.alarms.clear(ALARM_SAVE).catch(() => {});
  if (_prefs.enabled) {
    chrome.alarms.create(ALARM_TICK, { periodInMinutes: 0.5 });
    chrome.alarms.create(ALARM_SAVE, { periodInMinutes: 1 });
  }
}

// ── Reporting ────────────────────────────────────────────────────────────────
function computeSummary() {
  const today = dayKey();
  const days  = lastNDays(7);                 // [today, ..., today-6]
  const chart = days.slice().reverse().map(d => ({ day: d, seconds: 0 })); // oldest → newest
  const chartIndex = new Map(chart.map((c, i) => [c.day, i]));

  let todaySeconds = 0, weekSeconds = 0, alltimeSeconds = 0;
  const todayList = [], weekList = [];

  for (const [host, rec] of Object.entries(_domains)) {
    const tSec = rec.days[today]?.seconds || 0;
    if (tSec > 0) todayList.push({ domain: host, seconds: tSec });
    todaySeconds += tSec;

    let wSec = 0;
    for (const d of days) {
      const s = rec.days[d]?.seconds || 0;
      wSec += s;
      if (chartIndex.has(d)) chart[chartIndex.get(d)].seconds += s;
    }
    if (wSec > 0) weekList.push({ domain: host, seconds: wSec });
    weekSeconds += wSec;

    alltimeSeconds += rec.alltime.seconds || 0;
  }

  todayList.sort((a, b) => b.seconds - a.seconds);
  weekList.sort((a, b) => b.seconds - a.seconds);
  const topAlltime = Object.entries(_domains)
    .map(([domain, rec]) => ({ domain, seconds: rec.alltime.seconds || 0 }))
    .filter(d => d.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 50);

  return {
    totals: { todaySeconds, weekSeconds, alltimeSeconds },
    today:  todayList.slice(0, 50),
    week:   weekList.slice(0, 50),
    topAlltime,
    chart,
  };
}

async function setPrefs(patch) {
  _prefs = { ..._prefs, ...patch };
  await set(PREFS_KEY, _prefs);
  await setupAlarms();
  if (!_prefs.badgeDisplay) chrome.action.setBadgeText({ text: '' }).catch(() => {});
  if (chrome.idle) chrome.idle.setDetectionInterval(_prefs.idleSeconds || 60);
  return _prefs;
}

async function clearData(scope) {
  if (scope === 'all') {
    _domains = {};
  } else {
    const today = dayKey();
    for (const host of Object.keys(_domains)) {
      const rec = _domains[host];
      if (rec.days[today]) {
        rec.alltime.seconds = Math.max(0, rec.alltime.seconds - rec.days[today].seconds);
        delete rec.days[today];
      }
      if (!Object.keys(rec.days).length && rec.alltime.seconds <= 0) delete _domains[host];
    }
  }
  _dirty = true;
  await saveIfDirty();
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function init() {
  await loadState();
  await setupAlarms();
  if (chrome.idle) chrome.idle.setDetectionInterval(_prefs.idleSeconds || 60);

  chrome.tabs.onActivated.addListener(() => serialize(doCycle));
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === 'complete' || info.url || info.audible !== undefined) serialize(doCycle);
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

  register('webtime', async (q) => {
    const match = t => !q || t.toLowerCase().includes(q.toLowerCase());
    const items = [];
    if (match('web time tracker screen time habits report')) {
      const todaySec = computeSummary().totals.todaySeconds;
      const desc = todaySec > 0
        ? `${formatDurationShort(todaySec)} tracked today — view the report`
        : 'See how long you spend on each site';
      items.push({ id: 'webtime:open', title: 'Web Time: View report', desc, emoji: '⏱', type: 'action' });
    }
    return items;
  });

  expose('webtime', {
    getSummary: () => computeSummary(),
    getPrefs:   () => _prefs,
    setPrefs,
    clearData,
  });

  serialize(doCycle);
}

function formatDurationShort(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export const handlers = {
  'webtime:get-summary': async () => ({ ok: true, prefs: _prefs, dateStart: _meta.dateStart, ...computeSummary() }),
  'webtime:get-prefs':   async () => ({ ok: true, prefs: _prefs }),
  'webtime:set-prefs':   async (msg) => ({ ok: true, prefs: await setPrefs(msg.patch || {}) }),
  'webtime:clear-data':  async (msg) => { await clearData(msg.scope || 'today'); return { ok: true }; },
  'webtime:open':        async () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/webtime.html') });
    return { ok: true };
  },
};
