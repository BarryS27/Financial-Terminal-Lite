import { register } from '../core/registry.js';
import { get, set } from '../core/storage.js';

const UA_KEY     = 'c.ua.active';
const CUSTOM_KEY = 'c.ua.custom';

function getChromeVersion() {
  try {
    const chrome = (navigator.userAgentData?.brands || [])
      .find(b => b.brand === 'Google Chrome' || b.brand === 'Chromium');
    if (chrome?.version) return chrome.version;
  } catch {}
  return navigator.userAgent.match(/Chrome\/([\d]+)/)?.[1] || '150';
}

let [_presetCache, _presetChromeVer] = [null, null];
function getPresets() {
  const v = getChromeVersion();
  if (_presetChromeVer !== v) [_presetCache, _presetChromeVer] = [buildPresets(v), v];
  return _presetCache;
}

function buildPresets(cv) {
  const wk = '537.36';
  return [
    { title: `Chrome ${cv} — Windows`,  group: 'Desktop',
      ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/${wk} (KHTML, like Gecko) Chrome/${cv}.0.0.0 Safari/${wk}` },
    { title: `Chrome ${cv} — macOS`,    group: 'Desktop',
      ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/${wk} (KHTML, like Gecko) Chrome/${cv}.0.0.0 Safari/${wk}` },
    { title: `Chrome ${cv} — Linux`,    group: 'Desktop',
      ua: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/${wk} (KHTML, like Gecko) Chrome/${cv}.0.0.0 Safari/${wk}` },
    { title: `Edge ${cv} — Windows`,    group: 'Desktop',
      ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/${wk} (KHTML, like Gecko) Chrome/${cv}.0.0.0 Safari/${wk} Edg/${cv}.0.0.0` },
    { title: 'Firefox 152 — Windows',   group: 'Desktop',
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0' },
    { title: 'Firefox 152 — macOS',     group: 'Desktop',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15.3; rv:152.0) Gecko/20100101 Firefox/152.0' },
    { title: 'Firefox 152 — Linux',     group: 'Desktop',
      ua: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:152.0) Gecko/20100101 Firefox/152.0' },
    { title: 'Safari 18 — macOS',       group: 'Desktop',
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15' },
    { title: `Chrome ${cv} — Android`,  group: 'Mobile',
      ua: `Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/${wk} (KHTML, like Gecko) Chrome/${cv}.0.0.0 Mobile Safari/${wk}` },
    { title: 'Safari — iPhone (iOS 18)', group: 'Mobile',
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1' },
    { title: 'Safari — iPad (iOS 18)',   group: 'Mobile',
      ua: 'Mozilla/5.0 (iPad; CPU OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1' },
    { title: 'Firefox 152 — Android',   group: 'Mobile',
      ua: 'Mozilla/5.0 (Android 15; Mobile; rv:152.0) Gecko/152.0 Firefox/152.0' },
    { title: 'Googlebot 2.1',           group: 'Bots',
      ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    { title: 'Bingbot 2.0',             group: 'Bots',
      ua: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' },
    { title: 'Generic Chrome (no OS)',  group: 'Privacy',
      ua: `Mozilla/5.0 AppleWebKit/${wk} (KHTML, like Gecko) Chrome/${cv}.0.0.0 Safari/${wk}` },
  ];
}

export const UA_PRESETS = getPresets();

const RULE_ID_UA = 100000;
const ALL_RESOURCE_TYPES = [
  'main_frame','sub_frame','script','image','font','object',
  'xmlhttprequest','ping','media','websocket','other',
];

function buildRules(ua, mode, domain) {
  if (!ua) return [];
  const requestHeaders = [{ header: 'User-Agent', operation: 'set', value: ua }];
  if (mode === 'global') {
    return [{ id: RULE_ID_UA, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders },
      condition: { resourceTypes: ALL_RESOURCE_TYPES } }];
  }
  if (mode === 'domain' && domain) {
    return [{ id: RULE_ID_UA, priority: 1,
      action: { type: 'modifyHeaders', requestHeaders },
      condition: { urlFilter: `||${domain}^`, resourceTypes: ALL_RESOURCE_TYPES } }];
  }
  return [];
}

async function applyUA(ua, mode, domain) {
  const rules      = buildRules(ua, mode, domain);
  const existing   = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds  = existing.filter(r => r.id >= RULE_ID_UA && r.id < RULE_ID_UA + 10).map(r => r.id);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules: rules });
  await set(UA_KEY, ua ? { ua, mode: mode || 'global', domain } : null);

  if (ua) {
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.url?.startsWith('http')) continue;
        if (mode === 'domain' && domain) {
          try { if (!new URL(tab.url).hostname.includes(domain)) continue; } catch { continue; }
        }
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: false },
          world: 'MAIN',
          func: (targetUA) => { window.__captainUATarget = targetUA; },
          args: [ua],
        }).catch(() => {});
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: false },
          world: 'MAIN',
          files: ['inject/ua-spoof.js'],
        }).catch(() => {});
      }
    } catch {}
  }
}

export async function init() {
  const saved = await get(UA_KEY);
  if (saved?.ua) await applyUA(saved.ua, saved.mode, saved.domain).catch(() => {});

  register('ua', async (q) => {
    const ql      = q?.toLowerCase() ?? '';
    const match   = t => !ql || t.toLowerCase().includes(ql);
    const custom  = (await get(CUSTOM_KEY)) || [];
    const all     = [...getPresets(), ...custom.map(c => ({ ...c, group: 'Custom' }))];
    const saved   = await get(UA_KEY);
    const results = [];

    if (saved?.ua) {
      const activePreset = all.find(u => u.ua === saved.ua);
      const activeTitle  = activePreset ? activePreset.title : saved.ua.slice(0, 50) + '…';
      results.push({ id: 'ua:reset', title: `✓ ${activeTitle}`, desc: 'Click to reset UA', emoji: '🟢', type: 'action' });
    } else if (!ql || 'ua reset default'.includes(ql)) {
      results.push({ id: 'ua:reset', title: 'UA: Reset to default', desc: 'Remove User-Agent override', emoji: '↩️', type: 'action' });
    }

    if (!ql || 'ua open settings options'.includes(ql))
      results.push({ id: 'ua:open-options', title: 'UA: Open settings', desc: 'Manage custom UA profiles', emoji: '⚙️', type: 'action' });

    const emoji = g => ({ Mobile:'📱', Bots:'🤖', Privacy:'🕵️' }[g] ?? '🖥️');
    results.push(...all
      .filter(u => match(u.title) || match(u.group) || match('user agent') || !ql)
      .map(u => ({
        id:     `ua:set:${encodeURIComponent(u.ua)}`,
        title:  `UA: ${u.title}`,
        desc:   u.ua.length > 80 ? u.ua.slice(0, 80) + '…' : u.ua,
        emoji:  emoji(u.group),
        type:   'action',
        _group: u.group,
      })));

    return results;
  });
}

export const handlers = {
  'ua:set':    async (msg) => { await applyUA(msg.ua, msg.mode || 'global', msg.domain); return { ok: true }; },
  'ua:get':    async ()    => { const saved = await get(UA_KEY); return { ok: true, active: saved }; },
  'ua:reset':  async ()    => { await applyUA(null, null, null); return { ok: true }; },
  'ua:add-custom': async (msg) => {
    const list = (await get(CUSTOM_KEY)) || [];
    list.push({ title: msg.title, ua: msg.ua });
    await set(CUSTOM_KEY, list);
    return { ok: true };
  },
  'ua:remove-custom': async (msg) => {
    const list = (await get(CUSTOM_KEY)) || [];
    await set(CUSTOM_KEY, list.filter(u => u.ua !== msg.ua));
    return { ok: true };
  },
  'ua:list-presets': async () => ({ ok: true, presets: UA_PRESETS }),
  'ua:open-options': async () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/options.html#ua') });
    return { ok: true };
  },
};
