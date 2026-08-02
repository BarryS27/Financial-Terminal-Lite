// providers/focus-guard.js
// Derived from LeechBlock NG (MPL 2.0)
// v5: Blacklist (Search Filter) merged in; context-menu race fixed.

import { register } from '../core/registry.js';
import {
  BLOCKED_PAGE, DELAYED_PAGE, PASSWORD_PAGE,
  cleanOptions, cleanTimeData, getParsedURL, cleanSites, getRegExpSites,
  getMinPeriods, getTimePeriodStart, updateRolloverTime, formatTime,
  getCleanURL,
} from './focus-guard-common.js';
import { get, set } from '../core/storage.js';

// ── Extension-side constants ──────────────────────────────────────────────────
const EXTENSION_URL     = chrome.runtime.getURL('');
const BLOCKABLE_URL     = /^(https?|file):/i;
const BLOCKED_PAGE_URL  = chrome.runtime.getURL(BLOCKED_PAGE);
const DELAYED_PAGE_URL  = chrome.runtime.getURL(DELAYED_PAGE);
const PASSWORD_PAGE_URL = chrome.runtime.getURL(PASSWORD_PAGE);

const warn = msg => console.warn('[FG] ' + msg);

// ── Blacklist (Search Filter) state ──────────────────────────────────────────
const BL_RULES_KEY = 'c.bl.rules';
let _blMatcherCache = null;

function blInvalidateCache() { _blMatcherCache = null; }

function blRuleToMatcher(rule) {
  const reParts = rule.match(/^\/(.+)\/([gimsuy]*)$/);
  if (reParts) {
    try { return new RegExp(reParts[1], reParts[2]); } catch { return null; }
  }
  if (rule.startsWith('*.')) {
    const base = rule.slice(2).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\.)${base}$`, 'i');
  }
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\.)${escaped}$`, 'i');
}

function blParseRules(text) {
  if (!text) return [];
  return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}

async function blGetMatchers() {
  if (_blMatcherCache) return _blMatcherCache;
  const text = await get(BL_RULES_KEY);
  _blMatcherCache = blParseRules(text || '').map(blRuleToMatcher).filter(Boolean);
  return _blMatcherCache;
}

export async function isBlocked(hostname) {
  if (!hostname) return false;
  if (hostname.startsWith('chrome-extension') || hostname === 'newtab') return false;
  const matchers = await blGetMatchers();
  return matchers.some(m => m.test(hostname));
}

async function blGetRuleCount() {
  return blParseRules((await get(BL_RULES_KEY)) || '').length;
}

async function blAddRule(hostname) {
  const text     = (await get(BL_RULES_KEY)) || '';
  const existing = blParseRules(text);
  if (existing.includes(hostname)) return { ok: true, added: false };
  await set(BL_RULES_KEY, [...existing, hostname].join('\n'));
  blInvalidateCache();
  return { ok: true, added: true };
}

// ── Focus-guard state ─────────────────────────────────────────────────────────
let gGotOptions      = false;
let gOptions         = {};
let gNumSets         = 0;
const gTabs          = new Map();
let gSetCounted      = new Set();
let gSavedTimeData   = [];
let gRegExps         = [];
let gPrevActiveTabId = 0;
let gFocusWindowId   = 0;
let gClockOffset     = 0;
let gIgnoreJumpSecs  = 0;
let gAllFocused      = false;
let gUseDocFocus     = true;
let gSaveSecsCount   = 0;

// ── Tab init ──────────────────────────────────────────────────────────────────
function initTab(id) {
  if (gTabs.has(id)) return false;
  gTabs.set(id, {
    allowedHost: null, allowedPath: null,
    allowedSet: 0,     allowedEndTime: 0,
    referrer: '',      url: 'about:blank',
    incog: false,      audible: false,
    focused: false,    loaded: false, loadedTime: 0,
  });
  return true;
}

// ── RegExp creation ───────────────────────────────────────────────────────────
function createRegExps() {
  for (let set = 1; set <= gNumSets; set++) {
    gRegExps[set] = {};
    const blockRE   = gOptions[`regexpBlock${set}`]   || gOptions[`blockRE${set}`];
    const allowRE   = gOptions[`regexpAllow${set}`]   || gOptions[`allowRE${set}`];
    const referRE   = gOptions[`referRE${set}`];
    const keywordRE = gOptions[`regexpKeyword${set}`] || gOptions[`keywordRE${set}`];
    gRegExps[set].block   = blockRE   ? new RegExp(blockRE,   'i') : null;
    gRegExps[set].allow   = allowRE   ? new RegExp(allowRE,   'i') : null;
    gRegExps[set].refer   = referRE   ? new RegExp(referRE,   'i') : null;
    gRegExps[set].keyword = keywordRE;
  }
}

function testURL(url, referrer, blockRE, allowRE, referRE, allowRefers) {
  const block = blockRE && blockRE.test(url);
  const allow = allowRE && allowRE.test(url);
  const refer = referRE && referRE.test(referrer);
  return allowRefers ? block && !(allow || refer) : (block || refer) && !allow;
}

// ── Context menus ─────────────────────────────────────────────────────────────
// FIX: single removeAll → serial create avoids the race where background.js
// used to call removeAll() independently for the annotate menus, wiping FG
// menus half-built. Now all context menus live here; background.js no longer
// calls removeAll() at startup.
function refreshMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    const context = gOptions['contextMenu'] ? 'all' : 'action';
    chrome.contextMenus.create({ id: 'fg-options',   title: 'Focus Guard options',   contexts: [context] });
    chrome.contextMenus.create({ id: 'fg-lockdown',  title: 'Lockdown…',             contexts: [context] });
    chrome.contextMenus.create({ id: 'fg-override',  title: 'Override blocking',     contexts: [context] });
    chrome.contextMenus.create({ id: 'fg-separator', type: 'separator',              contexts: [context] });
    chrome.contextMenus.create({ id: 'addSite',      title: 'Add site to block set', contexts: [context] });
    for (let set = 1; set <= gNumSets; set++) {
      const setName = gOptions[`setName${set}`];
      const title = 'Block Set ' + set + (setName ? ` (${setName})` : '');
      chrome.contextMenus.create({ id: `addSite-${set}`, parentId: 'addSite', title, contexts: [context] });
    }
    // Search filter context menu item
    chrome.contextMenus.create({ id: 'fg-bl-separator', type: 'separator',              contexts: [context] });
    chrome.contextMenus.create({ id: 'fg-bl-block',     title: 'Search Filter: Block this site', contexts: [context] });
  });
}

// ── Ticker (offscreen) ────────────────────────────────────────────────────────
async function createTicker() {
  try {
    await chrome.offscreen.createDocument({
      url:           chrome.runtime.getURL('ticker.html'),
      reasons:       [chrome.offscreen.Reason.WORKERS],
      justification: 'Focus Guard ticker requires offscreen document',
    });
  } catch { /* Already exists */ }
}

// A set needs active per-second timing only if it has a time limit or a
// block/refer rule configured; sets that are disabled or empty don't need
// the ticker running at all. This lets the offscreen ticker stay fully idle
// (no setInterval, no SW wake-ups) for users who haven't configured Focus
// Guard, which used to burn CPU unconditionally every second.
function anySetNeedsTicking() {
  for (let set = 1; set <= gNumSets; set++) {
    if (gOptions[`disable${set}`]) continue;
    if (+gOptions[`limitMins${set}`] > 0) return true;
    if (gRegExps[set]?.block || gRegExps[set]?.refer) return true;
  }
  return false;
}

function refreshTicker() {
  chrome.runtime.sendMessage({
    type: 'fg:ticker-config',
    tickerSecs: +gOptions['processTabsSecs'] || 1,
    active: anySetNeedsTicking(),
  }).catch(() => {});
}

// ── Storage ───────────────────────────────────────────────────────────────────
async function retrieveOptions(update = false) {
  const stored = await chrome.storage.local.get(null);
  for (const key in stored) {
    if (!update || !/^timedata/.test(key)) gOptions[key] = stored[key];
  }
  gGotOptions     = true;
  cleanOptions(gOptions);
  cleanTimeData(gOptions);
  gNumSets        = +gOptions['numSets'];
  gClockOffset    = +gOptions['clockOffset'];
  gIgnoreJumpSecs = +gOptions['ignoreJumpSecs'];
  gAllFocused     = gOptions['allFocused'];
  gUseDocFocus    = gOptions['useDocFocus'];
  createRegExps();
  refreshMenus();
  refreshTicker();
  await loadSiteLists();
  updateIcon();
  for (let set = 1; set <= gNumSets; set++) {
    gSavedTimeData[set] = gOptions[`timedata${set}`].toString();
  }
}

async function loadSiteLists() {
  const time = Date.now();
  for (let set = 1; set <= gNumSets; set++) {
    let sitesURL = gOptions[`sitesURL${set}`];
    if (!sitesURL) continue;
    sitesURL = sitesURL.replace(/\$S/, set).replace(/\$T/, time);
    try {
      const res = await fetch(sitesURL);
      if (res.status === 200) {
        const sites   = cleanSites(await res.text());
        const regexps = getRegExpSites(sites, gOptions['matchSubdomains']);
        Object.assign(gOptions, {
          [`sites${set}`]:     sites,
          [`blockRE${set}`]:   regexps.block,
          [`allowRE${set}`]:   regexps.allow,
          [`referRE${set}`]:   regexps.refer,
          [`keywordRE${set}`]: regexps.keyword,
        });
        createRegExps();
        await chrome.storage.local.set({
          [`sites${set}`]:     sites,
          [`blockRE${set}`]:   regexps.block,
          [`allowRE${set}`]:   regexps.allow,
          [`referRE${set}`]:   regexps.refer,
          [`keywordRE${set}`]: regexps.keyword,
        });
      }
    } catch { warn('Cannot load sites from URL: ' + sitesURL); }
  }
}

async function saveTimeData() {
  if (!gGotOptions) return;
  const options = {};
  let touched = false;
  for (let set = 1; set <= gNumSets; set++) {
    const td = gOptions[`timedata${set}`];
    if (gSavedTimeData[set] !== td.toString()) {
      options[`timedata${set}`] = td;
      gSavedTimeData[set] = td.toString();
      touched = true;
    }
  }
  if (touched) await chrome.storage.local.set(options).catch(e => warn('Cannot save time data: ' + e));
}

function restartTimeData(set) {
  if (!gGotOptions || set < 0 || set > gNumSets) return;
  const now = Math.floor(Date.now() / 1000) + gClockOffset * 60;
  if (!set) {
    for (let s = 1; s <= gNumSets; s++) { gOptions[`timedata${s}`][0] = now; gOptions[`timedata${s}`][1] = 0; }
  } else {
    gOptions[`timedata${set}`][0] = now; gOptions[`timedata${set}`][1] = 0;
  }
  saveTimeData();
}

function reorderTimeData(ordering) {
  if (!ordering) return;
  const saved = [];
  for (let set = 1; set <= gNumSets; set++) saved[set] = gOptions[`timedata${set}`].slice();
  for (let set = 1; set <= gNumSets; set++) {
    if (ordering[set] <= gNumSets) gOptions[`timedata${set}`] = saved[ordering[set]];
  }
  saveTimeData();
}

// ── Icon ──────────────────────────────────────────────────────────────────────
function updateIcon() {
  const overrideEnd = gOptions['oret'] || 0;
  const path = overrideEnd > Math.floor(Date.now() / 1000)
    ? 'assets/icon-override.svg'
    : 'assets/icon.svg';
  chrome.action.setIcon({ path }).catch(() => {});
}

// ── Time / page clocking ──────────────────────────────────────────────────────
function clockPageTime(tabId, isNew, isFocused) {
  if (!gGotOptions) return;
  const tab = gTabs.get(tabId);
  if (!tab || !BLOCKABLE_URL.test(tab.url)) return;
  const now = Math.floor(Date.now() / 1000) + gClockOffset * 60;
  for (let set = 1; set <= gNumSets; set++) {
    if (gSetCounted.has(set)) continue;
    if (!testURL(tab.url, tab.referrer, gRegExps[set].block, gRegExps[set].allow, gRegExps[set].refer, gOptions[`allowRefers${set}`])) continue;
    const timedata = gOptions[`timedata${set}`];
    const focused  = tab.focused || gAllFocused;
    const audible  = tab.audible && gOptions[`countAudio${set}`];
    const active   = gOptions[`countFocus${set}`] ? (focused && isFocused) : true;
    if ((active || audible) && tab.loadedTime && tab.loadedTime < now) {
      const elapsed = now - tab.loadedTime;
      if (gIgnoreJumpSecs <= 0 || elapsed <= gIgnoreJumpSecs) {
        timedata[1] += elapsed;
        const periodStart = getTimePeriodStart(now, gOptions[`limitPeriod${set}`], gOptions[`limitOffset${set}`]);
        if (timedata[2] < periodStart) { timedata[2] = periodStart; timedata[3] = 0; }
        timedata[3] += elapsed;
      }
    }
    if (isNew && !gOptions['processActiveTabs']) gSetCounted.add(set);
    if (isNew) tab.loadedTime = now;
  }
}

// ── Block checking ────────────────────────────────────────────────────────────
function checkTab(id, isBeforeNav, isRepeat) {
  if (!gGotOptions) return false;
  const tab = gTabs.get(id);
  if (!tab || !BLOCKABLE_URL.test(tab.url) || tab.url.startsWith(EXTENSION_URL)) return false;

  const now = Math.floor(Date.now() / 1000) + gClockOffset * 60;
  const d           = new Date(now * 1000);
  const dayOfWeek   = d.getDay();
  const minuteOfDay = d.getHours() * 60 + d.getMinutes();

  for (let set = 1; set <= gNumSets; set++) {
    if (gOptions[`disable${set}`]) continue;
    if (!gRegExps[set].block && !gRegExps[set].refer) continue;
    if (!testURL(tab.url, tab.referrer, gRegExps[set].block, gRegExps[set].allow, gRegExps[set].refer, gOptions[`allowRefers${set}`])) continue;
    if (!gOptions[`days${set}`][dayOfWeek]) continue;

    const minPeriods   = getMinPeriods(gOptions[`times${set}`]);
    const inTimePeriod = !minPeriods.length || minPeriods.some(mp => minuteOfDay >= mp.start && minuteOfDay < mp.end);
    if (!inTimePeriod && !gOptions[`limitMins${set}`]) continue;

    const timedata    = gOptions[`timedata${set}`];
    const limitMins   = +gOptions[`limitMins${set}`];
    const lockdown    = timedata[4] > now;
    const periodStart = getTimePeriodStart(now, gOptions[`limitPeriod${set}`], gOptions[`limitOffset${set}`]);
    if (timedata[2] < periodStart) { timedata[2] = periodStart; timedata[3] = 0; }
    updateRolloverTime(timedata, limitMins, gOptions[`limitPeriod${set}`], periodStart);

    const rolloverSecs   = gOptions[`rollover${set}`] ? timedata[5] : 0;
    const limitSecs      = limitMins * 60;
    const overTimeLimit  = limitSecs && (limitSecs + rolloverSecs - timedata[3]) <= 0;
    const overrideActive = (gOptions['oret'] || 0) > now;

    if (!(lockdown || (inTimePeriod && overTimeLimit)) || overrideActive) continue;

    const delayFirst = gOptions[`delayFirst${set}`];
    const delaySecs  = +gOptions[`delaySecs${set}`];
    const encoded    = encodeURIComponent(tab.url);

    if (delayFirst && delaySecs > 0) {
      chrome.tabs.update(id, { url: `${DELAYED_PAGE_URL}?set=${set}&url=${encoded}` });
    } else {
      chrome.tabs.update(id, { url: `${BLOCKED_PAGE_URL}?set=${set}&url=${encoded}` });
    }
    return true;
  }
  return false;
}

// ── Lockdown / Override ───────────────────────────────────────────────────────
async function applyLockdown(set, endTime) {
  if (set) { gOptions[`timedata${set}`][4] = endTime; }
  else { for (let s = 1; s <= gNumSets; s++) gOptions[`timedata${s}`][4] = endTime; }
  await saveTimeData();
}

async function cancelLockdown(set) {
  if (set) { gOptions[`timedata${set}`][4] = 0; }
  else { for (let s = 1; s <= gNumSets; s++) gOptions[`timedata${s}`][4] = 0; }
  await saveTimeData();
}

async function applyOverride(endTime) {
  gOptions['oret'] = endTime;
  await chrome.storage.local.set({ oret: endTime });
  updateIcon();
}

async function cancelOverride() {
  gOptions['oret'] = 0;
  await chrome.storage.local.set({ oret: 0 });
  updateIcon();
}

async function discardRemainingTime() {
  const now = Math.floor(Date.now() / 1000) + gClockOffset * 60;
  for (let set = 1; set <= gNumSets; set++) {
    const limitMins = +gOptions[`limitMins${set}`];
    if (!limitMins) continue;
    const periodStart = getTimePeriodStart(now, gOptions[`limitPeriod${set}`], gOptions[`limitOffset${set}`]);
    if (gOptions[`timedata${set}`][2] < periodStart) {
      gOptions[`timedata${set}`][2] = periodStart;
      gOptions[`timedata${set}`][3] = 0;
    }
    gOptions[`timedata${set}`][3] = limitMins * 60;
  }
  await saveTimeData();
}

async function allowBlockedPage(tabId, blockedURL, blockedSet, autoLoad) {
  if (!gTabs.has(tabId)) return;
  if (autoLoad) await chrome.tabs.update(tabId, { url: blockedURL });
}

// ── Timer display ─────────────────────────────────────────────────────────────
function updateTimer(tabId) {
  const tab = gTabs.get(tabId);
  if (!tab || !gGotOptions) return;
  if (!gOptions['timerVisible']) {
    chrome.tabs.sendMessage(tabId, { type: 'fg:timer', text: '', size: 0, location: 0 }).catch(() => {});
    return;
  }
  const now = Math.floor(Date.now() / 1000) + gClockOffset * 60;
  let text = '';
  for (let set = 1; set <= gNumSets; set++) {
    if (!testURL(tab.url, tab.referrer, gRegExps[set].block, gRegExps[set].allow, gRegExps[set].refer, gOptions[`allowRefers${set}`])) continue;
    const limitMins = +gOptions[`limitMins${set}`];
    if (!limitMins) continue;
    const timedata    = gOptions[`timedata${set}`];
    const periodStart = getTimePeriodStart(now, gOptions[`limitPeriod${set}`], gOptions[`limitOffset${set}`]);
    if (timedata[2] < periodStart) { timedata[2] = periodStart; timedata[3] = 0; }
    const rollover = gOptions[`rollover${set}`] ? timedata[5] : 0;
    const left     = (limitMins * 60) + rollover - timedata[3];
    if (left < +gOptions['timerMaxHours'] * 3600) { text = formatTime(left); break; }
  }
  chrome.tabs.sendMessage(tabId, {
    type: 'fg:timer',
    text,
    size:     +gOptions['timerSize']     || 0,
    location: +gOptions['timerLocation'] || 0,
  }).catch(() => {});
}

// ── Site add ──────────────────────────────────────────────────────────────────
async function addSitesToSet(sites, set, replace = false) {
  if (!set || set < 1 || set > gNumSets) return;
  const key     = `sites${set}`;
  const merged  = replace ? cleanSites(sites) : cleanSites(((gOptions[key] || '') + ' ' + sites).trim());
  const regexps = getRegExpSites(merged, gOptions['matchSubdomains']);
  Object.assign(gOptions, {
    [key]:                   merged,
    [`blockRE${set}`]:       regexps.block,
    [`allowRE${set}`]:       regexps.allow,
    [`referRE${set}`]:       regexps.refer,
    [`regexpKeyword${set}`]: regexps.keyword,
  });
  createRegExps();
  await chrome.storage.local.set({
    [key]:                   merged,
    [`blockRE${set}`]:       regexps.block,
    [`allowRE${set}`]:       regexps.allow,
    [`referRE${set}`]:       regexps.refer,
    [`regexpKeyword${set}`]: regexps.keyword,
  });
}

function blockCurrentSite(sender) {
  if (!sender?.tab?.id) return;
  const tab = gTabs.get(sender.tab.id);
  const host = tab?.url ? getParsedURL(tab.url).host : '';
  if (host) addSitesToSet(host, 1);
}

// ── processTabs ───────────────────────────────────────────────────────────────
function processTabs(activeOnly) {
  gSetCounted = new Set();
  chrome.tabs.query({}).then(tabs => {
    for (const tab of tabs) {
      initTab(tab.id);
      const focus = tab.active && (gAllFocused || !gFocusWindowId || tab.windowId === gFocusWindowId);
      if (activeOnly && !tab.active) continue;
      clockPageTime(tab.id, false, focus);
      const blocked = checkTab(tab.id, false, true);
      if (!blocked && tab.active) updateTimer(tab.id);
    }
  }).catch(() => {});
}

// ── Window focus ──────────────────────────────────────────────────────────────
async function updateFocusedWindowId() {
  if (!chrome.windows) return;
  try {
    const win  = await chrome.windows.getCurrent();
    gFocusWindowId = win.focused ? win.id : chrome.windows.WINDOW_ID_NONE;
  } catch { /* no window */ }
}

// ── Tick ──────────────────────────────────────────────────────────────────────
async function handleTick() {
  await updateFocusedWindowId();
  if (!gGotOptions) { await retrieveOptions(); return; }
  processTabs(gOptions['processActiveTabs']);
  updateIcon();
  if (++gSaveSecsCount >= +gOptions['saveSecs']) { await saveTimeData(); gSaveSecsCount = 0; }
}

// ── Tab event handlers ────────────────────────────────────────────────────────
function handleTabCreated(tab) {
  initTab(tab.id);
  if (tab.openerTabId && gTabs.has(tab.openerTabId)) {
    const p = gTabs.get(tab.openerTabId);
    const t = gTabs.get(tab.id);
    t.allowedHost = p.allowedHost; t.allowedPath = p.allowedPath;
    t.allowedSet  = p.allowedSet;  t.allowedEndTime = p.allowedEndTime;
  }
}

function handleTabUpdated(tabId, changeInfo, tab) {
  initTab(tabId);
  if (!gGotOptions) return;
  const t = gTabs.get(tabId);
  t.incog   = tab.incognito;
  t.audible = tab.audible;
  if (changeInfo.url) t.url = getCleanURL(changeInfo.url);
  if (changeInfo.status === 'complete') {
    const focus   = tab.active && (gAllFocused || !gFocusWindowId || tab.windowId === gFocusWindowId);
    clockPageTime(tabId, true, focus);
    const blocked = checkTab(tabId, false, false);
    if (!blocked && tab.active) updateTimer(tabId);
  }
}

function handleTabActivated(activeInfo) {
  const { tabId, previousTabId, windowId } = activeInfo;
  gPrevActiveTabId = previousTabId;
  initTab(tabId);
  gTabs.get(tabId).focused = true;
  if (!gGotOptions) return;
  if (gOptions['processActiveTabs']) { processTabs(false); return; }
  const focus = gAllFocused || !gFocusWindowId || windowId === gFocusWindowId;
  clockPageTime(tabId, true, focus);
  updateTimer(tabId);
}

function handleTabRemoved(tabId) {
  if (!gGotOptions) return;
  clockPageTime(tabId, false, false);
  if (gTabs.get(tabId)?.url?.startsWith(EXTENSION_URL)) {
    chrome.tabs.update(gPrevActiveTabId, { active: true }).catch(() => {});
  }
  gTabs.delete(tabId);
}

function handleBeforeNavigate({ tabId, frameId, url }) {
  initTab(tabId);
  if (!gGotOptions) return;
  clockPageTime(tabId, false, false);
  if (frameId === 0) {
    const t = gTabs.get(tabId);
    t.loaded = false;
    t.url    = getCleanURL(url);
    checkTab(tabId, true, false);
  }
}

// ── Context menu clicks ───────────────────────────────────────────────────────
function handleMenuClick(info, tab) {
  const { menuItemId: id } = info;
  if      (id === 'fg-options')    openOptions();
  else if (id === 'fg-lockdown')   openLockdown();
  else if (id === 'fg-override')   applyOverride(Math.floor(Date.now() / 1000) + 3600);
  else if (id === 'fg-bl-block') {
    const parsed = tab?.url ? getParsedURL(tab.url) : {};
    if (parsed.host) blAddRule(parsed.host).catch(() => {});
  }
  else if (id.startsWith('addSite-')) {
    const set    = parseInt(id.split('-')[1], 10);
    const parsed = tab?.url ? getParsedURL(tab.url) : {};
    if (parsed.host) addSitesToSet(parsed.host, set);
  }
}

function openOptions(tab = 'focus-guard') {
  chrome.tabs.create({ url: chrome.runtime.getURL(`pages/options.html#${tab}`) });
}

function openLockdown() {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/lockdown.html') });
}

// ── Init ──────────────────────────────────────────────────────────────────────
export async function init() {
  await retrieveOptions();
  await createTicker();

  chrome.tabs.onCreated.addListener(handleTabCreated);
  chrome.tabs.onUpdated.addListener(handleTabUpdated);
  chrome.tabs.onActivated.addListener(handleTabActivated);
  chrome.tabs.onRemoved.addListener(handleTabRemoved);
  chrome.webNavigation.onBeforeNavigate.addListener(handleBeforeNavigate);
  if (chrome.contextMenus) chrome.contextMenus.onClicked.addListener(handleMenuClick);

  register('focus-guard', async (q) => {
    const match = t => !q || t.toLowerCase().includes(q.toLowerCase());
    const blCount = await blGetRuleCount();
    const items = [
      { id: 'fg:block-site',    title: 'Focus Guard: Block this site',    desc: 'Add current site to block set 1',      emoji: '🚫' },
      { id: 'fg:open-lockdown', title: 'Focus Guard: Lockdown…',          desc: 'Open lockdown timer page',             emoji: '🔒' },
      { id: 'fg:override',      title: 'Focus Guard: Override (1 hour)',  desc: 'Temporarily disable blocking for 1hr', emoji: '⏰' },
      { id: 'fg:open-options',  title: 'Focus Guard: Open settings',      desc: 'Open Focus Guard settings tab',        emoji: '⚙️' },
      { id: 'bl:open',          title: 'Search Filter: Open settings',    desc: `${blCount} rule${blCount !== 1 ? 's' : ''} active`, emoji: '⊗' },
      { id: 'bl:add-current',   title: 'Search Filter: Block current site', desc: 'Hide this domain from Google results', emoji: '⊗' },
    ].filter(c => match(c.title));
    return items;
  });
}

// ── Message handlers ──────────────────────────────────────────────────────────
export const handlers = {
  'fg:loaded': async (msg, sender) => {
    if (!sender?.tab?.id) return;
    initTab(sender.tab.id);
    const t  = gTabs.get(sender.tab.id);
    t.loaded = true; t.loadedTime = Math.floor(Date.now() / 1000); t.url = getCleanURL(msg.url);
  },
  'fg:referrer': async (msg, sender) => {
    if (!sender?.tab?.id) return;
    initTab(sender.tab.id);
    gTabs.get(sender.tab.id).referrer = msg.referrer;
  },
  'fg:focus': async (msg, sender) => {
    if (!sender?.tab?.id) return;
    initTab(sender.tab.id);
    gTabs.get(sender.tab.id).focused = msg.focus;
  },

  'fg:tick': async () => handleTick(),

  'fg:blocked': async (msg, sender) => {
    if (!sender?.tab?.id) return null;
    const set = +msg.set || 1;
    return {
      set,
      url:       gTabs.get(sender.tab.id)?.url || '',
      customMsg: gOptions[`customMsg${set}`]    || '',
      setName:   gOptions[`setName${set}`]      || '',
      delaySecs: gOptions[`delaySecs${set}`]    || '60',
    };
  },
  'fg:delayed': async (msg, sender) => {
    if (!sender?.tab?.id) return;
    await allowBlockedPage(sender.tab.id, msg.blockedURL, msg.blockedSet, gOptions[`delayAutoLoad${msg.blockedSet}`]);
  },
  'fg:close':           async (_, sender) => { if (sender?.tab?.id) chrome.tabs.remove(sender.tab.id); },
  'fg:lockdown':        async (msg)       => { if (!msg.endTime) await cancelLockdown(msg.set); else await applyLockdown(msg.set, msg.endTime); },
  'fg:override':        async ()          => applyOverride(Math.floor(Date.now() / 1000) + 3600),
  'fg:cancel-override': async ()          => cancelOverride(),
  'fg:options':         async (msg)       => { await retrieveOptions(true); reorderTimeData(msg.ordering); },
  'fg:add-sites':       async (msg)       => addSitesToSet(msg.sites, msg.set),
  'fg:block-site':      async (_, sender) => blockCurrentSite(sender),
  'fg:open-options':    async ()          => openOptions(),
  'fg:restart':         async (msg)       => restartTimeData(msg.set),
  'fg:discard-time':    async ()          => discardRemainingTime(),
  'fg:open-lockdown':   async ()          => openLockdown(),

  // Read-only summary for the options page (the panel previously called
  // fg:get / fg:enable / fg:disable / fg:remove-set / fg:add-set, none of
  // which exist — Focus Guard's real state lives in numbered per-set keys
  // like disable{N}/setName{N}/sites{N}, not a `sets` array). This handler
  // exposes that real shape instead.
  'fg:summary': async () => ({
    ok: true,
    numSets: gNumSets,
    sets: Array.from({ length: gNumSets }, (_, i) => {
      const set = i + 1;
      return {
        set,
        name: gOptions[`setName${set}`] || `Set ${set}`,
        disabled: !!gOptions[`disable${set}`],
        sites: gOptions[`sites${set}`] || '',
        limitMins: gOptions[`limitMins${set}`] || '',
      };
    }),
  }),
  'fg:set-disabled': async (msg) => {
    const set = +msg.set;
    if (!set || set < 1 || set > gNumSets) return { ok: false };
    gOptions[`disable${set}`] = !!msg.disabled;
    await chrome.storage.local.set({ [`disable${set}`]: !!msg.disabled });
    createRegExps();
    refreshTicker();
    return { ok: true };
  },
  'fg:set-sites': async (msg) => {
    const set = +msg.set;
    if (!set || set < 1 || set > gNumSets) return { ok: false };
    await addSitesToSet(msg.sites, set, /* replace */ true);
    return { ok: true };
  },

  'fg:password': async (msg, sender) => {
    if (!sender?.tab?.id) return { ok: false };
    const set       = +msg.blockedSet || 1;
    const correctPw = gOptions[`passwordSetSpec${set}`] || gOptions['password'];
    if (!correctPw || msg.password !== correctPw) return { ok: false };
    await allowBlockedPage(sender.tab.id, msg.blockedURL, set, true);
    return { ok: true };
  },

  // ── Merged blacklist handlers ──────────────────────────────────────────────
  'bl:check':      async (msg)          => ({ blocked: await isBlocked(msg.hostname) }),
  'bl:add':        async (msg)          => blAddRule(msg.hostname),
  'bl:add-current': async (_, sender)  => {
    try {
      const tab = sender?.tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      return blAddRule(new URL(tab?.url || '').hostname);
    } catch { return { ok: false }; }
  },
  'bl:remove': async (msg) => {
    const text = (await get(BL_RULES_KEY)) || '';
    await set(BL_RULES_KEY, blParseRules(text).filter(r => r !== msg.rule).join('\n'));
    blInvalidateCache();
    return { ok: true };
  },
  'bl:get-rules': async () => ({ ok: true, rules: (await get(BL_RULES_KEY)) || '' }),
  'bl:set-rules': async (msg) => {
    await set(BL_RULES_KEY, msg.rules || '');
    blInvalidateCache();
    return { ok: true };
  },
  'bl:open': async () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/options.html#blacklist') });
    return { ok: true };
  },
};
