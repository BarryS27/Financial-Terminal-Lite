import { register, query as registryQuery } from '../core/registry.js';

// Computed once at module load — avoids 20+ redundant navigator reads
const IS_MAC = /mac/i.test(navigator.userAgentData?.platform || navigator.userAgent);
const macKey  = (mac, win) => IS_MAC ? mac : win;

function matchText(text, q) { return !q || (text || '').toLowerCase().includes(q.toLowerCase()); }

let _tabCache = null, _tabCacheTs = 0;
async function getAllTabs() {
  if (_tabCache && Date.now() - _tabCacheTs < 800) return _tabCache;
  return (_tabCache = await chrome.tabs.query({}), _tabCacheTs = Date.now(), _tabCache);
}

function hostname(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

async function tabProvider(q) {
  const tabs   = await getAllTabs();
  const sorted = q ? tabs : [...tabs].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return sorted
    .filter(t => !q || matchText(t.title, q) || matchText(t.url, q))
    .slice(0, 50)
    .map(t => ({ id: `tab:${t.id}`, title: t.title || t.url, desc: hostname(t.url) || 'Tab',
                 icon: t.favIconUrl || '', type: 'tab', tabId: t.id, tabIndex: t.index, windowId: t.windowId }));
}

async function bookmarkProvider(q) {
  const items = q ? await chrome.bookmarks.search({ query: q }) : await chrome.bookmarks.getRecent(30);
  return items.filter(b => b.url).slice(0, 30)
    .map(b => ({ id: `bm:${b.id}`, title: b.title || b.url, desc: hostname(b.url) || 'Bookmark',
                 emoji: '⭐️', type: 'bookmark', url: b.url, bookmarkId: b.id }));
}

async function historyProvider(q) {
  const items = q
    ? await chrome.history.search({ text: q, maxResults: 40, startTime: 0 })
    : await chrome.history.search({ text: '', maxResults: 30, startTime: 0 });
  const seen = new Set();
  return items
    .filter(h => { if (!h.url || seen.has(h.url)) return false; seen.add(h.url); return true; })
    .slice(0, 20)
    .map(h => ({ id: `hist:${h.id}`, title: h.title || h.url,
                 desc: hostname(h.url) || 'History', emoji: '🏛', type: 'history', url: h.url }));
}

// act:* — desc omitted where it just rephrases the title (saves ~800 B raw)
// sc:*  — desc omitted; palette falls back to action.url for display;
//          shortcutProvider filter already checks s.url, so search still works
const SHORTCUTS = [
  { id: 'act:new-tab',       title: 'New tab',               emoji: '✨',  keys: macKey(['⌘','T'],          ['Ctrl','T'])               },
  { id: 'act:incognito',     title: 'Incognito mode',        emoji: '🕵️', keys: macKey(['⌘','⇧','N'],      ['Ctrl','Shift','N'])        },
  { id: 'act:duplicate-tab', title: 'Duplicate tab',         emoji: '📋', keys: macKey(['⌥','⇧','D'],      ['Alt','Shift','D'])         },
  { id: 'act:close-tab',     title: 'Close tab',             emoji: '🗑',  keys: macKey(['⌘','W'],          ['Ctrl','W'])                },
  { id: 'act:close-window',  title: 'Close window',          emoji: '💥', keys: macKey(['⌘','⇧','W'],      ['Ctrl','Shift','W'])        },
  { id: 'act:pin',           title: 'Pin tab',               emoji: '📌', keys: macKey(['⌥','⇧','P'],      ['Alt','Shift','P'])         },
  { id: 'act:mute',          title: 'Mute tab',              emoji: '🔇', keys: macKey(['⌥','⇧','M'],      ['Alt','Shift','M'])         },
  { id: 'act:reload',        title: 'Reload',                emoji: '♻️', keys: macKey(['⌘','⇧','R'],      ['F5'])                     },
  { id: 'act:fullscreen',    title: 'Fullscreen',            emoji: '🖥',  keys: macKey(['⌘','Ctrl','F'],   ['F11'])                    },
  { id: 'act:go-back',       title: 'Go back',               emoji: '👈', keys: macKey(['⌘','←'],          ['Alt','←'])                },
  { id: 'act:go-forward',    title: 'Go forward',            emoji: '👉', keys: macKey(['⌘','→'],          ['Alt','→'])                },
  { id: 'act:scroll-top',    title: 'Scroll to top',         emoji: '👆', keys: macKey(['⌘','↑'],          ['Home'])                   },
  { id: 'act:scroll-bottom', title: 'Scroll to bottom',      emoji: '👇', keys: macKey(['⌘','↓'],          ['End'])                    },
  { id: 'act:print',         title: 'Print page',            emoji: '🖨️', keys: macKey(['⌘','P'],          ['Ctrl','P'])               },
  { id: 'act:history',       title: 'Browsing history',      emoji: '🗂',  keys: macKey(['⌘','Y'],          ['Ctrl','H'])               },
  { id: 'act:downloads',     title: 'Downloads',             emoji: '📦', keys: macKey(['⌘','⇧','J'],      ['Ctrl','J'])               },
  { id: 'act:extensions',    title: 'Extensions',            emoji: '🧩'                                                               },
  { id: 'act:settings',      title: 'Chrome settings',       emoji: '⚙️', keys: macKey(['⌘',','],          [])                         },
  { id: 'act:manage-data',   title: 'Manage browsing data',  emoji: '🔬', keys: macKey(['⌘','⇧','Delete'], ['Ctrl','Shift','Delete'])   },
  { id: 'act:bookmark',      title: 'Bookmark this page',    emoji: '📕', keys: macKey(['⌘','D'],          ['Ctrl','D'])               },
  { id: 'act:remove-all',            title: 'Clear all browsing data', emoji: '🧹' },
  { id: 'act:remove-history',        title: 'Clear browsing history',  emoji: '🗂' },
  { id: 'act:remove-cookies',        title: 'Clear cookies',           emoji: '🍪' },
  { id: 'act:remove-cache',          title: 'Clear cache',             emoji: '🗄' },
  { id: 'act:remove-local-storage',  title: 'Clear local storage',     emoji: '📦' },

  { id: 'sc:notion',      title: 'New Notion page',         url: 'https://notion.new'          },
  { id: 'sc:sheets',      title: 'New Google Sheet',        url: 'https://sheets.new'          },
  { id: 'sc:docs',        title: 'New Google Doc',          url: 'https://docs.new'            },
  { id: 'sc:slides',      title: 'New Google Slides',       url: 'https://slides.new'          },
  { id: 'sc:meet',        title: 'New Google Meet',         url: 'https://meet.new'            },
  { id: 'sc:github-repo', title: 'New GitHub repo',         url: 'https://github.new'          },
  { id: 'sc:gist',        title: 'New GitHub gist',         url: 'https://gist.new'            },
  { id: 'sc:codepen',     title: 'New CodePen',             url: 'https://pen.new'             },
  { id: 'sc:figma',       title: 'New Figma file',          url: 'https://figma.new'           },
  { id: 'sc:excel',       title: 'New Excel spreadsheet',   url: 'https://excel.new'           },
  { id: 'sc:word',        title: 'New Word document',       url: 'https://word.new'            },
  { id: 'sc:powerpoint',  title: 'New PowerPoint',          url: 'https://powerpoint.new'      },
  { id: 'sc:canva',       title: 'New Canva design',        url: 'https://design.new'          },
  { id: 'sc:linear',      title: 'New Linear issue',        url: 'https://linear.new'          },
  { id: 'sc:asana',       title: 'New Asana task',          url: 'https://task.new'            },
  { id: 'sc:calendar',    title: 'New calendar event',      url: 'https://cal.new'             },
  { id: 'sc:x-tweet',     title: 'Post on X',               url: 'https://x.com/intent/tweet'  },
  { id: 'sc:spotify',     title: 'New Spotify playlist',    url: 'https://playlist.new'        },
  { id: 'sc:pdf',         title: 'Convert to PDF',          url: 'https://pdf.new'             },
];

// Also match against url so e.g. "notion.new" still finds the Notion shortcut
async function shortcutProvider(q) {
  return SHORTCUTS.filter(s => matchText(s.title, q) || matchText(s.url, q));
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function switchTab(tabId, tabIndex, windowId) {
  await chrome.tabs.highlight({ tabs: tabIndex, windowId });
  await chrome.windows.update(windowId, { focused: true });
}

async function doAction(id, extra = {}) {
  switch (id) {
    case 'act:new-tab':              await chrome.tabs.create({}); break;
    case 'act:incognito':            await chrome.windows.create({ incognito: true }); break;
    case 'act:close-tab':            { const t = await getCurrentTab(); await chrome.tabs.remove(t.id); break; }
    case 'act:close-window':         { const t = await getCurrentTab(); await chrome.windows.remove(t.windowId); break; }
    case 'act:duplicate-tab':        { const t = await getCurrentTab(); await chrome.tabs.duplicate(t.id); break; }
    case 'act:pin':                  { const t = await getCurrentTab(); await chrome.tabs.update(t.id, { pinned: !t.pinned }); break; }
    case 'act:mute':                 { const t = await getCurrentTab(); await chrome.tabs.update(t.id, { muted: !t.mutedInfo.muted }); break; }
    case 'act:reload':               await chrome.tabs.reload(); break;
    case 'act:go-back':              { const t = await getCurrentTab(); await chrome.tabs.goBack(t.id); break; }
    case 'act:go-forward':           { const t = await getCurrentTab(); await chrome.tabs.goForward(t.id); break; }
    case 'act:bookmark':             { const t = await getCurrentTab(); await chrome.bookmarks.create({ title: t.title, url: t.url }); break; }
    case 'act:history':              await chrome.tabs.create({ url: 'chrome://history/' }); break;
    case 'act:downloads':            await chrome.tabs.create({ url: 'chrome://downloads/' }); break;
    case 'act:extensions':           await chrome.tabs.create({ url: 'chrome://extensions/' }); break;
    case 'act:settings':             await chrome.tabs.create({ url: 'chrome://settings/' }); break;
    case 'act:manage-data':          await chrome.tabs.create({ url: 'chrome://settings/clearBrowserData' }); break;
    case 'act:fullscreen':           { const t = await getCurrentTab(); await chrome.tabs.sendMessage(t.id, { type: 'captain:fullscreen' }).catch(() => {}); break; }
    case 'act:scroll-top':           { const t = await getCurrentTab(); await chrome.tabs.sendMessage(t.id, { type: 'captain:scroll', dir: 'top'    }).catch(() => {}); break; }
    case 'act:scroll-bottom':        { const t = await getCurrentTab(); await chrome.tabs.sendMessage(t.id, { type: 'captain:scroll', dir: 'bottom' }).catch(() => {}); break; }
    case 'act:print':                { const t = await getCurrentTab(); await chrome.tabs.sendMessage(t.id, { type: 'captain:print' }).catch(() => {}); break; }
    case 'act:remove-all':           await chrome.browsingData.remove({ since: 0 }, { cache:true, cookies:true, history:true, indexedDB:true, localStorage:true, passwords:true }); break;
    case 'act:remove-history':       await chrome.browsingData.removeHistory({ since: 0 }); break;
    case 'act:remove-cookies':       await chrome.browsingData.removeCookies({ since: 0 }); break;
    case 'act:remove-cache':         await chrome.browsingData.removeCache({ since: 0 }); break;
    case 'act:remove-local-storage': await chrome.browsingData.removeLocalStorage({ since: 0 }); break;
    default: if (extra.url) await chrome.tabs.create({ url: extra.url }); break;
  }
}

export async function init() {
  register('browser-tabs',      tabProvider);
  register('browser-bookmarks', bookmarkProvider);
  register('browser-history',   historyProvider);
  register('browser-shortcuts', shortcutProvider);
}

export const handlers = {
  'browser:get-actions': async (msg) => ({ actions: await registryQuery(msg.query || '') }),
  'browser:query':       async (msg) => ({ results: await registryQuery(msg.query || '') }),

  'browser:do-action': async (msg) => {
    if (msg.actionType === 'tab') { await switchTab(msg.tabId, msg.tabIndex, msg.windowId); return { ok: true }; }
    await doAction(msg.id, msg);
    return { ok: true };
  },

  'browser:remove': async (msg) => {
    if (msg.itemType === 'bookmark') await chrome.bookmarks.remove(String(msg.id)).catch(() => {});
    else if (msg.itemType === 'tab') await chrome.tabs.remove(msg.tabId).catch(() => {});
    return { ok: true };
  },

  'browser:search': async (msg) => { await chrome.search.query({ text: msg.query }); return { ok: true }; },
  'browser:goto':   async (msg) => { await chrome.tabs.create({ url: msg.url });      return { ok: true }; },

  'browser:search-history':   async (msg) => ({ history:   await chrome.history.search({ text: msg.query, maxResults: 0, startTime: 0 }) }),
  'browser:search-bookmarks': async (msg) => ({ bookmarks: (await chrome.bookmarks.search({ query: msg.query })).filter(b => b.url) }),

  'browser:open-captain': async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url   = tab?.url || '';
    const restricted = !url || /^(chrome|chrome-extension|about):/.test(url);
    if (!restricted) {
      const sent = await chrome.tabs.sendMessage(tab.id, { type: 'captain:open' }).then(() => true).catch(() => false);
      if (!sent) {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => !!window.__captainOverlayLoaded,
        }).catch(() => [{ result: false }]);
        if (!res?.[0]?.result) {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/overlay.js'] }).catch(() => {});
        }
        setTimeout(() => chrome.tabs.sendMessage(tab.id, { type: 'captain:open' }).catch(() => {}), 80);
      }
    } else {
      await chrome.tabs.create({ url: chrome.runtime.getURL('newtab.html') });
    }
    return { ok: true };
  },
};
