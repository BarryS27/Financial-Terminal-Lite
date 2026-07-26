'use strict';

const input   = document.getElementById('search-input');
const results = document.getElementById('results');
const chip    = document.getElementById('filter-chip');
const chipLbl = document.getElementById('filter-chip-label');

let selIdx       = -1;
let activeFilter = null;
let debounce     = null;
let rowEls       = [];

// ── Filter definitions ───────────────────────────────────────────────────────
const FILTERS = [
  { aliases: ['tab','t'],               label: '📄 Tabs',          color: '#4a9eff', match: a => a.type === 'tab' },
  { aliases: ['bookmark','bm','b'],     label: '📕 Bookmarks',     color: '#f0a030', match: a => a.type === 'bookmark' },
  { aliases: ['history','hist','h'],    label: '🗂 History',       color: '#a855f7', match: a => a.type === 'history' },
  { aliases: ['action','act','a'],      label: '⚡ Actions',       color: '#22c55e', match: a => a.type === 'action' || a.id?.startsWith('act:') },
  { aliases: ['webrtc','rtc'],          label: '🛡 WebRTC',        color: '#06b6d4', match: a => a.id?.startsWith('webrtc:') },
  { aliases: ['focus','fg'],            label: '🔒 Focus',         color: '#f43f5e', match: a => a.id?.startsWith('fg:') },
  { aliases: ['ua','agent'],            label: '🌐 User Agent',    color: '#8b5cf6', match: a => a.id?.startsWith('ua:') },
  { aliases: ['bl','filter','sf'],      label: '🚫 Search Filter', color: '#f97316', match: a => a.id?.startsWith('bl:') },
  { aliases: ['proxy','px'],            label: '🔀 Proxy',         color: '#14b8a6', match: a => a.id?.startsWith('proxy:') },
  { aliases: ['workspace','ws','work'], label: '🗂 Workspace',     color: '#10b981', match: a => a.id?.startsWith('ws:') },
  { aliases: ['vault','pw','pass'],     label: '🔐 Vault',         color: '#f59e0b', match: a => a.id?.startsWith('vault:') },
  { aliases: ['ai','chat'],             label: '🤖 AI',            color: '#7c3aed', match: a => a.id?.startsWith('ai:') },
  { aliases: ['sleep','discard'],       label: '💤 Tab Sleep',     color: '#6b7280', match: a => a.id?.startsWith('tab-discard:') },
];

// ── Slash parsing ────────────────────────────────────────────────────────────
function parseSlash(raw) {
  if (!raw.startsWith('/')) return { kind: 'plain', query: raw };
  const sp  = raw.indexOf(' ');
  const cmd = (sp < 0 ? raw.slice(1) : raw.slice(1, sp)).toLowerCase();
  const rest = sp < 0 ? '' : raw.slice(sp + 1).trim();
  if (!cmd) return { kind: 'help', partial: '' };
  const hit = FILTERS.find(f => f.aliases.includes(cmd));
  if (hit) return { kind: 'filter', filter: hit, query: rest };
  return FILTERS.some(f => f.aliases.some(a => a.startsWith(cmd)))
    ? { kind: 'help', partial: cmd }
    : { kind: 'plain', query: raw };
}

// ── Filter chip ──────────────────────────────────────────────────────────────
function setFilter(f) {
  activeFilter = f;
  chip.style.cssText += `;display:inline-flex;background:${f.color}22;border-color:${f.color}66;color:${f.color}`;
  chipLbl.textContent = f.label;
}
function clearFilter() {
  activeFilter = null;
  chip.style.display = 'none';
  chipLbl.textContent = '';
}

document.getElementById('filter-chip-close').addEventListener('mousedown', e => e.preventDefault());
document.getElementById('filter-chip-close').addEventListener('click', () => {
  clearFilter(); input.value = ''; input.focus(); runQuery('');
});

// ── Keyboard ─────────────────────────────────────────────────────────────────
input.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (activeFilter) { clearFilter(); input.value = ''; runQuery(''); }
    else parent.postMessage({ type: 'captain:close' }, '*');
    return;
  }
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(+1); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); moveSel(-1); return; }
  if (e.key === 'Enter')     { e.preventDefault(); activateSel(); return; }
  if (e.key === 'Backspace' && !input.value && activeFilter) { clearFilter(); runQuery(''); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Tab') { e.preventDefault(); input.focus(); }
}, true);

input.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => runQuery(input.value.trim()), 120);
});

document.getElementById('backdrop').addEventListener('mousedown', e => e.preventDefault());
document.getElementById('backdrop').addEventListener('click', e => {
  if (e.target === e.currentTarget) parent.postMessage({ type: 'captain:close' }, '*');
});

// ── Selection ────────────────────────────────────────────────────────────────
function moveSel(dir) {
  if (!rowEls.length) return;
  rowEls[selIdx]?.classList.remove('selected');
  selIdx = Math.max(0, Math.min(rowEls.length - 1, selIdx + dir));
  rowEls[selIdx].classList.add('selected');
  rowEls[selIdx].scrollIntoView({ block: 'nearest' });
}
function activateSel() {
  (rowEls[selIdx] ?? rowEls[0])?.click();
}

// ── Query flow ───────────────────────────────────────────────────────────────
function runQuery(raw) {
  results.setAttribute('data-loading', '1');
  if (activeFilter) {
    parent.postMessage({ type: 'captain:query', query: raw }, '*');
    return;
  }
  const p = parseSlash(raw);
  if (p.kind === 'help')   { renderHelp(p.partial); return; }
  if (p.kind === 'filter') { setFilter(p.filter); input.value = p.query; }

  const stubs = raw && !activeFilter ? [
    { id: 'browser:search', title: `Search "${raw}"`, desc: 'Search with default engine', emoji: '🔍' },
    { id: 'browser:goto',   title: `Go to "${raw}"`,  desc: 'Navigate to URL',            emoji: '🌐' },
  ] : [];

  renderResults(stubs, raw);
  parent.postMessage({ type: 'captain:query', query: p.kind === 'filter' ? p.query : raw }, '*');
}

// ── Messages from parent ──────────────────────────────────────────────────────
window.addEventListener('message', e => {
  const { type } = e.data || {};
  if (type === 'captain:show') {
    input.value = ''; clearFilter(); selIdx = -1; results.innerHTML = ''; rowEls = [];
    input.focus(); runQuery('');
    return;
  }
  if (type === 'captain:results') {
    const all = e.data.actions || [];
    const visible = activeFilter ? all.filter(activeFilter.match) : all;
    const stubs = input.value.trim() && !activeFilter ? [
      { id: 'browser:search', title: `Search "${input.value.trim()}"`, desc: 'Search with default engine', emoji: '🔍' },
      { id: 'browser:goto',   title: `Go to "${input.value.trim()}"`,  desc: 'Navigate to URL',            emoji: '🌐' },
    ] : [];
    renderResults([...stubs, ...visible], input.value.trim());
  }
});

// ── v3: send action to parent with usage-tracking metadata ───────────────────
function sendAction(action) {
  parent.postMessage({
    type: 'captain:action',
    action: {
      ...action,
      query: input.value.trim(),
      _fromPalette: true,
      _actionId: action.id,
    },
  }, '*');
}

// ── Render: help ─────────────────────────────────────────────────────────────
function renderHelp(partial) {
  selIdx = -1;
  results.removeAttribute('data-loading');
  const frag = document.createDocumentFragment();

  const hdr = el('div', 'section-label');
  hdr.textContent = partial ? `Commands matching "/${partial}"` : 'Type /command to filter — e.g. /tab, /proxy';
  frag.appendChild(hdr);

  for (const f of FILTERS) {
    if (partial && !f.aliases.some(a => a.startsWith(partial))) continue;
    const row = el('div', 'result-item');
    row.setAttribute('role', 'option');

    const icon = el('div', 'item-icon'); icon.textContent = f.label.split(' ')[0];
    const txt  = el('div', 'item-text');
    const t    = el('div', 'item-title'); t.textContent = f.label.slice(f.label.indexOf(' ') + 1);
    const d    = el('div', 'item-desc');
    d.style.fontFamily = 'monospace';
    d.textContent = '/' + f.aliases[0] + (f.aliases.length > 1 ? '  ·  /' + f.aliases.slice(1).join(', /') : '');
    txt.append(t, d);

    const badge = el('span', 'key-badge');
    badge.style.cssText = `background:${f.color}22;border-color:${f.color}66;color:${f.color}`;
    badge.textContent = '/' + f.aliases[0];

    row.append(icon, txt, badge);
    row.addEventListener('mousedown', e => e.preventDefault());
    row.addEventListener('click', () => {
      setFilter(f); input.value = ''; input.focus();
      parent.postMessage({ type: 'captain:query', query: '' }, '*');
    });
    frag.appendChild(row);
  }

  results.innerHTML = '';
  results.appendChild(frag);
  rowEls = [...results.querySelectorAll('.result-item')];
}

// ── Render: results ───────────────────────────────────────────────────────────
function renderResults(actions, q) {
  selIdx = -1;
  const frag = document.createDocumentFragment();

  const G = { tab: [], bookmark: [], history: [], action: [] };
  for (const a of actions) (G[a.type] ?? G.action).push(a);

  const navCount  = G.tab.length + G.bookmark.length + G.history.length;
  const multiGroup = [G.tab, G.bookmark, G.history].filter(g => g.length).length > 1
                   || (G.action.length > 0 && navCount > 0);

  for (const [label, group] of [
    ['Tabs', G.tab], ['Bookmarks', G.bookmark],
    ['History', G.history], ['Actions', G.action],
  ]) {
    if (!group.length) continue;
    if (multiGroup || activeFilter) {
      const sec = el('div', 'section-label'); sec.textContent = label;
      frag.appendChild(sec);
    }
    for (const item of group) frag.appendChild(buildRow(item, q));
  }

  results.innerHTML = '';
  results.appendChild(frag);
  rowEls = [...results.querySelectorAll('.result-item')];
  results.removeAttribute('data-loading');
}

// ── Build a single result row ─────────────────────────────────────────────────
function buildRow(action, q) {
  const row = el('div', 'result-item');
  row.setAttribute('role', 'option');

  const icon = el('div', 'item-icon');
  if (action.icon) {
    const img = document.createElement('img');
    img.src = action.icon;
    img.onerror = () => { img.remove(); icon.textContent = '🌐'; };
    icon.appendChild(img);
  } else {
    icon.textContent = action.emoji || '⚡';
  }

  const txt   = el('div', 'item-text');
  const title = el('div', 'item-title'); title.textContent = action.title || '';
  const desc  = el('div', 'item-desc');
  const descStr = action.desc || action.url || '';
  if (q && descStr.toLowerCase().includes(q.toLowerCase())) {
    const i = descStr.toLowerCase().indexOf(q.toLowerCase());
    desc.textContent = descStr.slice(0, i);
    const mark = document.createElement('mark');
    mark.textContent = descStr.slice(i, i + q.length);
    desc.appendChild(mark);
    desc.appendChild(document.createTextNode(descStr.slice(i + q.length)));
  } else {
    desc.textContent = descStr;
  }
  txt.append(title, desc);
  row.append(icon, txt);

  if (action.keys?.length) {
    const keys = el('div', 'item-keys');
    for (const k of action.keys) {
      const b = el('span', 'key-badge'); b.textContent = k; keys.appendChild(b);
    }
    row.appendChild(keys);
  }

  if (action.type === 'tab' || action.type === 'bookmark') {
    const rm = el('div', 'item-remove');
    rm.title = action.type === 'tab' ? 'Close tab' : 'Remove bookmark';
    rm.textContent = '✕';
    rm.addEventListener('mousedown', e => e.preventDefault());
    rm.addEventListener('click', ev => {
      ev.stopPropagation();
      parent.postMessage({ type: 'captain:remove', itemType: action.type,
                           id: action.bookmarkId, tabId: action.tabId }, '*');
      const i = rowEls.indexOf(row);
      if (i !== -1) rowEls.splice(i, 1);
      if (selIdx >= rowEls.length) selIdx = rowEls.length - 1;
      row.remove();
    });
    row.appendChild(rm);
  }

  // Prevent mousedown from stealing focus — critical fix for click reliability
  row.addEventListener('mousedown', e => e.preventDefault());
  row.addEventListener('click', () => sendAction(action));
  return row;
}

// ── Micro helper ─────────────────────────────────────────────────────────────
function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

input.focus();

// Prevent entire palette mousedown from stealing input focus
document.getElementById('palette').addEventListener('mousedown', e => {
  if (e.target !== input) e.preventDefault();
});

parent.postMessage({ type: 'captain:ready' }, '*');
