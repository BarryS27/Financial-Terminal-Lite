// providers/tab-discard.js — Auto Tab Discard integrated into Captain
// Extracted core logic from Auto Tab Discard, stripped all its own UI/backend

import { register } from '../core/registry.js';
import { get, set, update } from '../core/storage.js';
import { expose, emit } from '../core/bus.js';

const KEY = 'c.discard.prefs';

const DEFAULTS = {
  enabled:          true,
  period:           10 * 60,   // seconds before discarding (default 10 min)
  pinned:           false,      // don't discard pinned tabs
  audible:          false,      // don't discard audible tabs
  whitelist:        [],         // hostname patterns to never discard
  onIdle:           false,      // only discard when browser is idle
  idleTimeout:      5 * 60,    // seconds until considered idle
};

const inprogress = new Set();

async function getPrefs() {
  return { ...DEFAULTS, ...(await get(KEY) || {}) };
}

function matchesWhitelist(url, list) {
  if (!url || !list?.length) return false;
  try {
    const host = new URL(url).hostname;
    return list.some(rule => {
      if (rule.startsWith('/') && rule.endsWith('/')) {
        try { return new RegExp(rule.slice(1, -1)).test(host); } catch { return false; }
      }
      return host === rule || host.endsWith('.' + rule);
    });
  } catch { return false; }
}

async function shouldDiscard(tab, prefs) {
  if (!prefs.enabled) return false;
  if (tab.active) return false;
  if (tab.discarded) return false;
  if (tab.pinned && !prefs.pinned) return false;
  if (tab.audible && !prefs.audible) return false;
  if (!tab.url?.startsWith('http')) return false;
  if (matchesWhitelist(tab.url, prefs.whitelist)) return false;
  // onIdle fix: only discard when the browser is idle if the user opted in
  if (prefs.onIdle && chrome.idle) {
    const state = await chrome.idle.queryState(prefs.idleTimeout);
    if (state !== 'idle') return false;
  }
  return true;
}

async function discardTab(tab) {
  if (inprogress.has(tab.id)) return;
  inprogress.add(tab.id);
  setTimeout(() => inprogress.delete(tab.id), 2000);
  try {
    await chrome.tabs.discard(tab.id);
    emit('tab-discard:discarded', { tabId: tab.id, url: tab.url });
  } catch (e) {
    console.debug('[TabDiscard] Could not discard', tab.id, e.message);
  }
}

// Track when each tab was last active
const tabActivity = new Map(); // tabId -> timestamp (ms)

function recordActivity(tabId) {
  tabActivity.set(tabId, Date.now());
}

async function runDiscardCycle() {
  const prefs = await getPrefs();
  if (!prefs.enabled) return;

  const now = Date.now();
  const threshold = prefs.period * 1000;

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!await shouldDiscard(tab, prefs)) continue;
    const lastActive = tabActivity.get(tab.id) ?? tab.lastAccessed ?? now;
    if (now - lastActive >= threshold) {
      await discardTab(tab);
    }
  }
}

// ── Alarm ─────────────────────────────────────────────────────────────────────
const ALARM_NAME = 'captain-discard';

async function setupAlarm(prefs) {
  chrome.alarms.clear(ALARM_NAME).catch(() => {});
  if (prefs.enabled) {
    const periodMinutes = Math.max(0.5, prefs.period / 60);
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: periodMinutes });
  }
}

export async function init() {
  const prefs = await getPrefs();
  await setupAlarm(prefs);

  // Track tab activity
  chrome.tabs.onActivated.addListener(({ tabId }) => recordActivity(tabId));
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'complete') recordActivity(tabId);
  });
  chrome.tabs.onRemoved.addListener(tabId => tabActivity.delete(tabId));

  // Run on alarm
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM_NAME) runDiscardCycle();
  });

  // Idle detection
  if (chrome.idle) {
    chrome.idle.setDetectionInterval(prefs.idleTimeout);
  }

  register('tab-discard', async (q) => {
    const match = t => !q || t.toLowerCase().includes(q.toLowerCase());
    const p = await getPrefs();
    const items = [];
    if (match('tab discard sleep suspend'))
      items.push({ id: 'tab-discard:open-options', title: 'Tab Sleep: Open settings',
        desc: p.enabled ? `Auto-sleep after ${Math.round(p.period/60)}min inactive` : 'Disabled',
        emoji: '💤', type: 'action' });
    if (match('discard all tabs sleep now') || !q)
      items.push({ id: 'tab-discard:discard-all', title: 'Tab Sleep: Sleep inactive tabs now',
        desc: 'Immediately discard all eligible background tabs', emoji: '😴', type: 'action' });
    return items;
  });

  expose('tab-discard', {
    getPrefs,
    setPrefs: async (patch) => {
      const merged = { ...(await getPrefs()), ...patch };
      await set(KEY, merged);
      await setupAlarm(merged);
      return merged;
    },
    discardAll: runDiscardCycle,
    isWhitelisted: async (url) => matchesWhitelist(url, (await getPrefs()).whitelist),
  });
}

export const handlers = {
  'tab-discard:get-prefs': async () => ({ ok: true, prefs: await getPrefs() }),
  'tab-discard:set-prefs': async msg => {
    const merged = { ...(await getPrefs()), ...msg.patch };
    await set(KEY, merged);
    await setupAlarm(merged);
    return { ok: true, prefs: merged };
  },
  'tab-discard:discard-all': async () => { await runDiscardCycle(); return { ok: true }; },
  'tab-discard:open-options': async () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/options.html#tab-discard') });
    return { ok: true };
  },
};
