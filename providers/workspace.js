// providers/workspace.js — Captain Workspace System
// Replaces Extensity profiles with intelligent workspaces.
// Rules emerge from usage. Workspaces auto-activate based on domain.

import { register } from '../core/registry.js';
import { get, set } from '../core/storage.js';
import { expose, emit } from '../core/bus.js';

const KEY_WORKSPACES = 'c.ws.workspaces';
const KEY_ACTIVE     = 'c.ws.active';

// ── Default workspaces ────────────────────────────────────────────────────────
const DEFAULT_WORKSPACES = [
  {
    id: 'default',
    name: 'Default',
    icon: '⚓',
    proxy: 'system',
    ua: null,
    focusSets: [],
    tabDiscardAfter: 10 * 60,
    tabDiscardPinned: false,
    domains: [],
    extensions: {},   // extensionId -> 'on'|'off'
    builtIn: true,
  },
];

// ── Storage helpers ───────────────────────────────────────────────────────────
async function loadWorkspaces() {
  return (await get(KEY_WORKSPACES)) || DEFAULT_WORKSPACES;
}

async function saveWorkspaces(ws) {
  return set(KEY_WORKSPACES, ws);
}

async function getActive() {
  return (await get(KEY_ACTIVE)) || 'default';
}

async function findWorkspace(id) {
  return (await loadWorkspaces()).find(w => w.id === id) || null;
}

// ── Extension management ──────────────────────────────────────────────────────
async function getExtensions() {
  try {
    const all = await chrome.management.getAll();
    return all.filter(e => e.id !== chrome.runtime.id); // exclude self
  } catch { return []; }
}

async function applyExtensions(workspace) {
  if (!workspace?.extensions) return;
  const exts = await getExtensions();
  for (const ext of exts) {
    const desired = workspace.extensions[ext.id];
    if (desired === 'on' && !ext.enabled) {
      await chrome.management.setEnabled(ext.id, true).catch(() => {});
    } else if (desired === 'off' && ext.enabled) {
      await chrome.management.setEnabled(ext.id, false).catch(() => {});
    }
  }
}

// ── Workspace activation ──────────────────────────────────────────────────────
async function activateWorkspace(id, source = 'manual') {
  const ws = await findWorkspace(id);
  if (!ws) throw new Error(`Workspace "${id}" not found`);

  await set(KEY_ACTIVE, id);

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.windowId) {
      await chrome.windows.update(tabs[0].windowId, { focused: true }).catch(() => {});
    }
  } catch {}

  // Apply proxy
  if (ws.proxy) {
    chrome.runtime.sendMessage({ type: 'proxy:switch', name: ws.proxy }).catch(() => {});
  }

  // Apply UA
  if (ws.ua) {
    chrome.runtime.sendMessage({ type: 'ua:set', ua: ws.ua, mode: 'global' }).catch(() => {});
  } else {
    chrome.runtime.sendMessage({ type: 'ua:reset' }).catch(() => {});
  }

  // Apply tab discard settings
  if (ws.tabDiscardAfter !== undefined) {
    chrome.runtime.sendMessage({ type: 'tab-discard:set-prefs', patch: {
      period: ws.tabDiscardAfter,
      pinned: ws.tabDiscardPinned ?? false,
    }}).catch(() => {});
  }

  // Apply extension states
  await applyExtensions(ws);

  emit('workspace:activated', { workspace: ws, source });
  return ws;
}

const stripWww = hostname => hostname.replace(/^www\./, '');

// ── Auto-trigger based on domain ──────────────────────────────────────────────
async function checkAutoTrigger(url) {
  const workspaces = await loadWorkspaces();
  let hostname;
  try { hostname = stripWww(new URL(url).hostname); } catch { return; }

  for (const ws of workspaces) {
    if (!ws.domains?.length) continue;
    const matches = ws.domains.some(d =>
      d.startsWith('*.') ? hostname.endsWith(d.slice(1)) : hostname === d || hostname.endsWith(`.${d}`));
    if (matches) {
      if ((await getActive()) !== ws.id) await activateWorkspace(ws.id, 'auto');
      return;
    }
  }
}

// ── Runtime view ─────────────────────────────────────────────────────────────
async function getRuntimeView() {
  const exts = await getExtensions();
  const result = [];
  for (const ext of exts) {
    let status = ext.enabled ? 'on' : 'off';
    if (ext.installType === 'development') status = ext.enabled ? 'on (dev)' : 'off (dev)';
    // Check if it needs reload (crude heuristic: if it was recently updated)
    result.push({
      id: ext.id,
      name: ext.name,
      shortName: ext.shortName || ext.name,
      enabled: ext.enabled,
      status,
      version: ext.version,
      icons: ext.icons,
    });
  }
  return result;
}

// ── Smart suggestion ─────────────────────────────────────────────────────────
// Track which workspace is active when visiting a domain
const _domainVisits = new Map(); // domain -> {wsId, count}

async function recordVisit(domain, wsId) {
  if (!domain || !wsId) return;
  const rec = _domainVisits.get(domain) || { wsId, count: 0 };
  if (rec.wsId === wsId) rec.count++;
  else rec.count = 1;
  rec.wsId = wsId;
  _domainVisits.set(domain, rec);

  // Suggest adding a domain rule if repeated (count >= 5)
  if (rec.count === 5) {
    emit('workspace:suggest-rule', { domain, workspaceId: wsId });
  }
}

const NEW_WORKSPACE_DEFAULTS = { icon: '📁', proxy: 'system', ua: null, focusSets: [], tabDiscardAfter: 10 * 60, domains: [], extensions: {} };

async function createWorkspace(data) {
  const workspaces = await loadWorkspaces();
  const newWs = { id: `ws_${Date.now()}`, ...NEW_WORKSPACE_DEFAULTS, ...data };
  await saveWorkspaces([...workspaces, newWs]);
  return newWs;
}

async function updateWorkspace(id, patch) {
  const workspaces = await loadWorkspaces();
  const idx = workspaces.findIndex(w => w.id === id);
  if (idx < 0) return null;
  const updated = { ...workspaces[idx], ...patch };
  await saveWorkspaces(workspaces.with(idx, updated));
  return updated;
}

async function deleteWorkspace(id) {
  const workspaces = await loadWorkspaces();
  if (workspaces.find(w => w.id === id)?.builtIn) return { ok: false, error: 'Cannot delete built-in workspace' };
  const filtered = workspaces.filter(w => w.id !== id);
  if (filtered.length === workspaces.length) return { ok: false, error: 'Workspace not found' };
  await saveWorkspaces(filtered);
  if ((await getActive()) === id) await activateWorkspace('default');
  return { ok: true };
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function handleTabUrl(url) {
  await checkAutoTrigger(url);
  try { await recordVisit(stripWww(new URL(url).hostname), await getActive()); } catch {}
}

export async function init() {
  // Monitor navigation for auto-trigger
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.url) await handleTabUrl(tab.url);
  });

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.url && tab.active) handleTabUrl(info.url);
  });

  register('workspace', async (q) => {
    const match = t => !q || t.toLowerCase().includes(q.toLowerCase());
    const workspaces = await loadWorkspaces();
    const activeId   = await getActive();
    const items = [];

    if (match('workspace manage extensions runtime'))
      items.push({ id: 'ws:open-options', title: 'Workspaces: Open settings',
        desc: 'Manage workspaces, extensions, auto-rules', emoji: '🗂', type: 'action' });

    for (const ws of workspaces) {
      if (!match(ws.name)) continue;
      items.push({
        id:    `ws:activate:${ws.id}`,
        title: `${ws.icon || '📁'} Workspace → ${ws.name}`,
        desc:  activeId === ws.id ? 'Active' : `Proxy: ${ws.proxy || 'system'}`,
        emoji: activeId === ws.id ? '🟢' : '📁',
        type:  'action',
      });
    }
    return items;
  });

  expose('workspace', {
    list: loadWorkspaces,
    getActive,
    activate: (id, source) => activateWorkspace(id, source),
    create: createWorkspace,
    update: async (id, patch) => {
      const updated = await updateWorkspace(id, patch);
      if (!updated) throw new Error('Workspace not found');
      return updated;
    },
    delete: async (id) => {
      const res = await deleteWorkspace(id);
      if (!res.ok) throw new Error(res.error);
    },
    getExtensions: getRuntimeView,
    checkAutoTrigger,
  });
}

export function handleWorkspaceAction(type) {
  if (!type?.startsWith('ws:activate:')) return null;
  const id = type.slice('ws:activate:'.length);
  return () => activateWorkspace(id).then(ws => ({ ok: true, workspace: ws }));
}

export const handlers = {
  'ws:list':   async () => ({ ok: true, workspaces: await loadWorkspaces() }),
  'ws:active': async () => ({ ok: true, id: await getActive() }),
  'ws:activate': async msg => ({ ok: true, workspace: await activateWorkspace(msg.id) }),
  'ws:create': async msg => ({ ok: true, workspace: await createWorkspace(msg.data) }),
  'ws:update': async msg => {
    const updated = await updateWorkspace(msg.id, msg.patch);
    return updated ? { ok: true, workspace: updated } : { ok: false, error: 'Not found' };
  },
  'ws:delete': async msg => deleteWorkspace(msg.id),
  'ws:get-extensions': async () => ({ ok: true, extensions: await getRuntimeView() }),
  'ws:open-options': async () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/options.html#workspaces') });
    return { ok: true };
  },
};
