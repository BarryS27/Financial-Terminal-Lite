'use strict';
// cookies.js — Cookie manager UI logic (runs in pages/cookies.html)

import { $, send, esc, copyText } from './shared.js';

let _cookies = [];
let _siteUrl = '';

async function init() {
  await refresh();
}

async function refresh() {
  const res = await send('cookies:list');
  if (!res.ok) { $('cookie-list').innerHTML = '<div class="empty-state">Could not read cookies for this tab.</div>'; return; }
  _siteUrl = res.url || '';
  _cookies = res.cookies || [];
  try { $('site-host').textContent = new URL(_siteUrl).hostname; } catch { $('site-host').textContent = '(no active tab)'; }
  render(_cookies);
}

function render(list) {
  const container = $('cookie-list');
  if (!list.length) { container.innerHTML = '<div class="empty-state">No cookies found for this site.</div>'; return; }
  container.innerHTML = '';
  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'cookie-row';
    row.innerHTML = `
      <div class="cookie-info">
        <div class="cookie-name">${esc(c.name)}</div>
        <div class="cookie-value">${esc(c.value)}</div>
        <div class="cookie-meta">${esc(c.domain)}${c.path} · ${c.session ? 'session' : new Date(c.expirationDate * 1000).toLocaleDateString()}${c.secure ? ' · secure' : ''}${c.httpOnly ? ' · httpOnly' : ''}</div>
      </div>
      <div class="cookie-actions">
        <button class="icon-btn" title="Copy value" data-action="copy">📋</button>
        <button class="icon-btn" title="Edit" data-action="edit">✏️</button>
        <button class="icon-btn" title="Delete" data-action="delete">🗑️</button>
      </div>`;
    row.querySelector('[data-action=copy]').addEventListener('click', () => copyText(c.value));
    row.querySelector('[data-action=edit]').addEventListener('click', () => openModal(c));
    row.querySelector('[data-action=delete]').addEventListener('click', async () => {
      await send('cookies:delete', { cookie: c });
      refresh();
    });
    container.appendChild(row);
  }
}

$('search-input').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  render(q ? _cookies.filter(c => c.name.toLowerCase().includes(q) || c.value.toLowerCase().includes(q)) : _cookies);
});

$('btn-refresh').addEventListener('click', refresh);

$('btn-delete-all').addEventListener('click', async () => {
  if (!_cookies.length) return;
  if (!confirm(`Delete all ${_cookies.length} cookies for this site?`)) return;
  await send('cookies:delete-all');
  refresh();
});

$('btn-add').addEventListener('click', () => openModal(null));

function openModal(cookie) {
  $('modal-title').textContent = cookie ? 'Edit Cookie' : 'Add Cookie';
  $('c-name').value     = cookie?.name ?? '';
  $('c-name').disabled  = !!cookie;
  $('c-value').value    = cookie?.value ?? '';
  $('c-domain').value   = cookie?.domain ?? (_siteUrl ? new URL(_siteUrl).hostname : '');
  $('c-path').value     = cookie?.path ?? '/';
  $('c-secure').checked = cookie?.secure ?? false;
  $('c-httponly').checked = cookie?.httpOnly ?? false;
  $('c-storeid').value  = cookie?.storeId ?? '';
  $('modal-error').textContent = '';
  $('modal-bg').classList.remove('hidden');
  setTimeout(() => $('c-name').focus(), 30);
}
function closeModal() { $('modal-bg').classList.add('hidden'); }
$('btn-modal-cancel').addEventListener('click', closeModal);
$('modal-bg').addEventListener('click', e => { if (e.target === $('modal-bg')) closeModal(); });

$('btn-modal-save').addEventListener('click', async () => {
  const name = $('c-name').value.trim();
  const domain = $('c-domain').value.trim();
  if (!name || !domain) { $('modal-error').textContent = 'Name and domain are required.'; return; }
  const cookie = {
    name, domain,
    value: $('c-value').value,
    path: $('c-path').value.trim() || '/',
    secure: $('c-secure').checked,
    httpOnly: $('c-httponly').checked,
    storeId: $('c-storeid').value || undefined,
  };
  const res = await send('cookies:set', { cookie });
  if (res.ok) { closeModal(); refresh(); }
  else { $('modal-error').textContent = res.error || 'Save failed.'; }
});

// ── Export / Import ───────────────────────────────────────────────────────────
$('btn-export').addEventListener('click', async () => {
  const res = await send('cookies:export');
  if (!res.ok) return;
  const blob = new Blob([res.json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const host = (() => { try { return new URL(_siteUrl).hostname; } catch { return 'cookies'; } })();
  a.download = `${host}-cookies.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const res = await send('cookies:import', { json: text });
  e.target.value = '';
  if (res.ok) { $('cookie-status').textContent = `Imported ${res.imported} cookie(s). ✓`; refresh(); }
  else { $('cookie-status').textContent = `Import failed: ${res.error}`; $('cookie-status').classList.add('error'); }
});

init();
