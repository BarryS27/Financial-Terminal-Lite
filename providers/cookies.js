// providers/cookies.js — Cookie manager for the active tab's site
// Original implementation (feature-equivalent to a "cookie editor" style
// tool: list/add/edit/delete/export/import cookies for one domain).
// Uses the `cookies` permission; no third-party code involved.

import { register } from '../core/registry.js';

async function activeTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || null;
}

function cookieUrl(cookie) {
  // chrome.cookies.set needs a URL matching the cookie's domain/path/secure flag.
  const domain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
  return `http${cookie.secure ? 's' : ''}://${domain}${cookie.path}`;
}

async function listForUrl(url) {
  if (!url) return [];
  const { hostname } = new URL(url);
  return chrome.cookies.getAll({ domain: hostname.replace(/^www\./, '') });
}

export async function init() {
  register('cookies', async (q) => {
    if (q && !'cookies cookie manager site data'.includes(q.toLowerCase()) && !'cookie'.includes(q.toLowerCase())) return [];
    return [{ id: 'cookies:open', title: 'Cookies: Manage current site', desc: 'View, edit, export, import cookies', emoji: '🍪', type: 'action' }];
  });
}

export const handlers = {
  'cookies:open': async () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/cookies.html') });
    return { ok: true };
  },

  'cookies:list': async () => {
    const url = await activeTabUrl();
    const cookies = await listForUrl(url);
    return { ok: true, url, cookies };
  },

  'cookies:get': async (msg) => {
    const cookie = await chrome.cookies.get({ url: msg.url, name: msg.name, storeId: msg.storeId });
    return { ok: true, cookie };
  },

  'cookies:set': async (msg) => {
    const c = msg.cookie;
    try {
      const saved = await chrome.cookies.set({
        url: cookieUrl(c),
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || 'lax',
        expirationDate: c.session ? undefined : (c.expirationDate ?? (Date.now() / 1000 + 60 * 60 * 24 * 365)),
        storeId: c.storeId,
      });
      return { ok: true, cookie: saved };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  },

  'cookies:delete': async (msg) => {
    const c = msg.cookie;
    await chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId });
    return { ok: true };
  },

  'cookies:delete-all': async () => {
    const url = await activeTabUrl();
    const cookies = await listForUrl(url);
    await Promise.all(cookies.map(c => chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId })));
    return { ok: true, removed: cookies.length };
  },

  'cookies:export': async () => {
    const url = await activeTabUrl();
    const cookies = await listForUrl(url);
    return { ok: true, json: JSON.stringify(cookies, null, 2) };
  },

  'cookies:import': async (msg) => {
    let list;
    try { list = JSON.parse(msg.json); } catch { return { ok: false, error: 'invalid_json' }; }
    if (!Array.isArray(list)) return { ok: false, error: 'expected_array' };
    let imported = 0;
    for (const c of list) {
      try {
        await chrome.cookies.set({
          url: cookieUrl(c), name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
          secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite || 'lax',
          expirationDate: c.session ? undefined : c.expirationDate,
          storeId: c.storeId,
        });
        imported++;
      } catch { /* skip malformed entries, continue import */ }
    }
    return { ok: true, imported };
  },
};
