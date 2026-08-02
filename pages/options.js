'use strict';
// Captain Options — ACDN design

import { esc } from './shared.js';

// ── Nav ───────────────────────────────────────────────────────────────────────
const hash = location.hash.replace('#', '');
const _defaultPanel = document.querySelector('.nav-item[data-panel]')?.dataset?.panel;
document.querySelectorAll('.nav-item[data-panel]').forEach(btn => {
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', () => activate(btn.dataset.panel));
});
activate(hash || _defaultPanel || '');

function activate(id) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.panel === id));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + id));
  location.hash = id;
}

function setStatus(id, msg, isErr = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isErr);
  if (!isErr) setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
}

// ── WebRTC ────────────────────────────────────────────────────────────────────
async function loadWebRTC() {
  const res = await chrome.runtime.sendMessage({ type: 'webrtc:get' }).catch(() => null);
  const mode = res?.mode ?? 'off';
  const el   = document.querySelector(`input[name='webrtc'][value='${mode}']`);
  if (el) el.checked = true;
}
document.querySelectorAll('input[name="webrtc"]').forEach(r => {
  r.addEventListener('change', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'webrtc:set', mode: r.value });
    setStatus('webrtc-status', res?.ok ? 'Saved. ✓' : 'Error.', !res?.ok);
  });
});
loadWebRTC();

// ── Proxy ─────────────────────────────────────────────────────────────────────
let _proxyEditing = null;

async function loadProxy() {
  const [listRes, activeRes] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'proxy:list' }),
    chrome.runtime.sendMessage({ type: 'proxy:active' }),
  ]);
  const profiles = listRes?.profiles || [];
  const active   = activeRes?.name || 'system';

  // Update active indicator
  document.getElementById('pe-active-name').textContent = active;
  const ap = profiles.find(p => p.name === active);
  document.getElementById('pe-active-type').textContent = ap?.type ?? '';

  // Quick switch dropdown
  const qs = document.getElementById('pe-quick-switch');
  qs.innerHTML = profiles.map(p => `<option value="${esc(p.name)}" ${p.name===active?'selected':''}>${esc(p.name)}</option>`).join('');

  // Profile cards
  const list = document.getElementById('pe-list');
  list.innerHTML = '';
  profiles.forEach(p => {
    const card = document.createElement('div');
    card.className = 'proxy-card';
    card.innerHTML = `
      <div class="proxy-dot" style="background:${esc(p.color||'#888')}"></div>
      <div class="proxy-card-name">${esc(p.name)}</div>
      <div class="proxy-card-type">${esc(p.type)}</div>
      ${p.name === active ? '<div class="proxy-card-active badge badge-accent">Active</div>' : ''}
      ${!p.builtin ? `<button class="btn btn-outline btn-sm" data-edit="${esc(p.name)}">Edit</button>` : ''}
    `;
    card.querySelector('[data-edit]')?.addEventListener('click', () => openProxyEditor(p));
    list.appendChild(card);
  });
}

document.getElementById('pe-apply').addEventListener('click', async () => {
  const name = document.getElementById('pe-quick-switch').value;
  const res  = await chrome.runtime.sendMessage({ type: 'proxy:switch', name });
  setStatus('pe-status', res?.ok ? `Switched to ${name}. ✓` : res?.error || 'Error.', !res?.ok);
  if (res?.ok) loadProxy();
});

document.getElementById('pe-add').addEventListener('click', () => openProxyEditor(null));

function openProxyEditor(profile) {
  _proxyEditing = profile?.name ?? null;
  const drawer = document.getElementById('pe-editor');
  drawer.classList.add('open');
  document.getElementById('pe-name').value     = profile?.name     || '';
  document.getElementById('pe-color').value    = (profile?.color   || '#99ccee').replace(/^#([0-9a-f]{3})$/i, (_, c) => '#' + c.split('').map(x=>x+x).join(''));
  document.getElementById('pe-type').value     = profile?.type     || 'fixed';
  document.getElementById('pe-protocol').value = profile?.protocol || 'http';
  document.getElementById('pe-host').value     = profile?.host     || '';
  document.getElementById('pe-port').value     = profile?.port     || 8080;
  document.getElementById('pe-pac-url').value  = profile?.pacUrl   || '';
  updateProxyEditorFields();
  document.getElementById('pe-delete').style.display = _proxyEditing ? '' : 'none';
  document.getElementById('pe-name').focus();
}

document.getElementById('pe-type').addEventListener('change', updateProxyEditorFields);
function updateProxyEditorFields() {
  const type = document.getElementById('pe-type').value;
  document.getElementById('pe-fixed-fields').style.display = type === 'fixed' ? '' : 'none';
  document.getElementById('pe-pac-fields').style.display   = type === 'pac'   ? '' : 'none';
}

document.getElementById('pe-save').addEventListener('click', async () => {
  const name  = document.getElementById('pe-name').value.trim();
  if (!name) { setStatus('pe-status', 'Name required.', true); return; }
  const patch = {
    color:    document.getElementById('pe-color').value,
    type:     document.getElementById('pe-type').value,
    protocol: document.getElementById('pe-protocol').value,
    host:     document.getElementById('pe-host').value.trim(),
    port:     parseInt(document.getElementById('pe-port').value) || 8080,
    pacUrl:   document.getElementById('pe-pac-url').value.trim(),
  };
  const type = _proxyEditing ? 'proxy:update' : 'proxy:create';
  const msg  = _proxyEditing
    ? { type, name: _proxyEditing, patch: { ...patch, name } }
    : { type, name, profile: patch };
  const res = await chrome.runtime.sendMessage(msg);
  setStatus('pe-status', res?.ok ? 'Saved. ✓' : res?.error || 'Error.', !res?.ok);
  if (res?.ok) { document.getElementById('pe-editor').classList.remove('open'); loadProxy(); }
});

document.getElementById('pe-cancel').addEventListener('click', () => {
  document.getElementById('pe-editor').classList.remove('open');
});

document.getElementById('pe-delete').addEventListener('click', async () => {
  if (!_proxyEditing || !confirm(`Delete proxy profile "${_proxyEditing}"?`)) return;
  const res = await chrome.runtime.sendMessage({ type: 'proxy:delete', name: _proxyEditing });
  setStatus('pe-status', res?.ok ? 'Deleted.' : res?.error || 'Error.', !res?.ok);
  if (res?.ok) { document.getElementById('pe-editor').classList.remove('open'); loadProxy(); }
});

loadProxy();

// ── User-Agent ────────────────────────────────────────────────────────────────
const UA_PRESETS = [
  { name: 'Chrome / Windows',  ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' },
  { name: 'Chrome / macOS',    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36' },
  { name: 'Chrome / Android',  ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36' },
  { name: 'Safari / iPhone',   ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  { name: 'Firefox / Linux',   ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0' },
  { name: 'Googlebot',         ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
];

async function loadUA() {
  const res = await chrome.runtime.sendMessage({ type: 'ua:get' }).catch(() => null);
  const active = res?.active?.ua || '';
  document.getElementById('ua-enabled').checked = !!res?.active;
  document.getElementById('ua-custom').value    = active;

  const chips = document.getElementById('ua-chips');
  chips.innerHTML = '';
  UA_PRESETS.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'ua-chip' + (p.ua === active ? ' active' : '');
    chip.dataset.ua = p.ua;
    chip.innerHTML = `<span class="ua-chip-name">${esc(p.name)}</span>`;
    chip.addEventListener('click', () => {
      document.getElementById('ua-custom').value = p.ua;
      chips.querySelectorAll('.ua-chip').forEach(c => c.classList.toggle('active', c === chip));
    });
    chips.appendChild(chip);
  });
}

document.getElementById('ua-save').addEventListener('click', async () => {
  const ua      = document.getElementById('ua-custom').value.trim();
  const enabled = document.getElementById('ua-enabled').checked;
  const res = await chrome.runtime.sendMessage({ type: enabled && ua ? 'ua:set' : 'ua:reset', ua, mode: 'global' });
  setStatus('ua-status', res?.ok ? 'Saved. ✓' : 'Error.', !res?.ok);
});
document.getElementById('ua-reset').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'ua:reset' });
  setStatus('ua-status', res?.ok ? 'Reset to browser default. ✓' : 'Error.', !res?.ok);
  if (res?.ok) { document.getElementById('ua-custom').value = ''; document.getElementById('ua-enabled').checked = false; }
});
loadUA();

// ── Focus Guard ───────────────────────────────────────────────────────────────
// Rewired to Focus Guard's real message API. The previous version called
// fg:get / fg:enable / fg:disable / fg:remove-set / fg:add-set — none of
// which exist on the provider side, so this panel silently did nothing.
// Focus Guard stores state as numbered per-set keys (disable{N}, sites{N},
// setName{N}, ...), not a `sets` array, so we read/write through the
// fg:summary / fg:set-disabled / fg:set-sites handlers that expose that.
async function loadFocusGuard() {
  const res = await chrome.runtime.sendMessage({ type: 'fg:summary' }).catch(() => null);
  if (!res?.ok) return;
  const list = document.getElementById('fg-sets-list');
  list.innerHTML = '';
  res.sets.forEach((s) => {
    const div = document.createElement('div');
    div.className = 'field-group';
    div.style.marginBottom = '10px';
    div.innerHTML = `
      <div class="field">
        <div class="field-label"><strong>${esc(s.name)}</strong><span>${s.sites ? esc(s.sites) : 'No sites configured'}</span></div>
        <div class="field-control">
          <label class="toggle"><input type="checkbox" data-set="${s.set}" data-role="fg-set-toggle" ${s.disabled ? '' : 'checked'}><span class="toggle-track"></span></label>
          <button class="btn btn-outline btn-sm" data-set="${s.set}" data-role="fg-set-edit">Edit sites</button>
        </div>
      </div>`;
    div.querySelector('[data-role=fg-set-toggle]').addEventListener('change', async function () {
      await chrome.runtime.sendMessage({ type: 'fg:set-disabled', set: s.set, disabled: !this.checked });
    });
    div.querySelector('[data-role=fg-set-edit]').addEventListener('click', async () => {
      const sites = prompt(`Sites for "${s.name}" (one per line or comma-separated):`, s.sites);
      if (sites == null) return;
      await chrome.runtime.sendMessage({ type: 'fg:set-sites', set: s.set, sites });
      loadFocusGuard();
    });
    list.appendChild(div);
  });
}
document.getElementById('fg-save').addEventListener('click', async () => {
  setStatus('fg-status', 'Saved. ✓');
});
loadFocusGuard();

// ── Tab Sleep ─────────────────────────────────────────────────────────────────
async function loadTabDiscard() {
  const res = await chrome.runtime.sendMessage({ type: 'tab-discard:get-prefs' });
  if (!res?.ok) return;
  const p = res.prefs;
  document.getElementById('td-enabled').checked = p.enabled;
  document.getElementById('td-period').value    = Math.round(p.period / 60);
  document.getElementById('td-pinned').checked  = p.pinned;
  document.getElementById('td-audible').checked = !p.audible;
  document.getElementById('td-whitelist').value = (p.whitelist || []).join('\n');
}
document.getElementById('td-save').addEventListener('click', async () => {
  const patch = {
    enabled:   document.getElementById('td-enabled').checked,
    period:    (parseInt(document.getElementById('td-period').value)||10) * 60,
    pinned:    document.getElementById('td-pinned').checked,
    audible:   !document.getElementById('td-audible').checked,
    whitelist: document.getElementById('td-whitelist').value.split('\n').map(s=>s.trim()).filter(Boolean),
  };
  const res = await chrome.runtime.sendMessage({ type: 'tab-discard:set-prefs', patch });
  setStatus('td-status', res?.ok ? 'Saved. ✓' : 'Error.', !res?.ok);
});
document.getElementById('td-sleep-now').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'tab-discard:discard-all' });
  setStatus('td-status', 'Sleeping inactive tabs…');
});
loadTabDiscard();

// ── Workspaces ────────────────────────────────────────────────────────────────
async function loadWorkspaces() {
  const [listRes, actRes, extRes] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'ws:list' }),
    chrome.runtime.sendMessage({ type: 'ws:active' }),
    chrome.runtime.sendMessage({ type: 'ws:get-extensions' }),
  ]);
  const workspaces = listRes?.workspaces || [];
  const activeId   = actRes?.id || 'default';
  const extensions = extRes?.extensions || [];

  const list = document.getElementById('ws-list');
  list.innerHTML = '';
  workspaces.forEach(ws => {
    const div = document.createElement('div');
    div.className = 'field-group';
    div.style.marginBottom = '8px';
    const isActive = ws.id === activeId;
    div.innerHTML = `
      <div class="field">
        <div class="field-label">
          <strong>${esc(ws.icon||'◈')} ${esc(ws.name)}</strong>
          <span>Proxy: ${esc(ws.proxy||'system')} · Domains: ${esc(ws.domains?.join(', ')||'none')}</span>
        </div>
        <div class="field-control">
          ${isActive ? '<span class="badge badge-accent">Active</span>' : ''}
          <button class="btn btn-outline btn-sm ws-activate" data-id="${esc(ws.id)}" ${isActive?'disabled':''}>Switch</button>
          ${!ws.builtIn ? `<button class="btn btn-danger btn-sm ws-delete" data-id="${esc(ws.id)}">✕</button>` : ''}
        </div>
      </div>`;
    div.querySelector('.ws-activate')?.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'ws:activate', id: ws.id });
      setStatus('ws-status', `Switched to ${ws.name}. ✓`);
      loadWorkspaces();
    });
    div.querySelector('.ws-delete')?.addEventListener('click', async () => {
      if (!confirm(`Delete workspace "${ws.name}"?`)) return;
      await chrome.runtime.sendMessage({ type: 'ws:delete', id: ws.id });
      loadWorkspaces();
    });
    list.appendChild(div);
  });

  const extList = document.getElementById('ws-ext-list');
  extList.innerHTML = extensions.length
    ? extensions.map(e => `
      <div class="item-row">
        <div class="item-row-main">
          <div class="item-row-title">${esc(e.name)}</div>
          <div class="item-row-sub">v${esc(e.version)}</div>
        </div>
        <span class="badge ${e.enabled?'badge-green':''}  ">${esc(e.status)}</span>
      </div>`).join('')
    : '<div class="item-row"><div class="item-row-sub">No other extensions found.</div></div>';
}
document.getElementById('ws-add').addEventListener('click', async () => {
  const name = prompt('Workspace name:');
  if (!name) return;
  await chrome.runtime.sendMessage({ type: 'ws:create', data: { name, icon: '◈' } });
  loadWorkspaces();
});
loadWorkspaces();

// ── AI ────────────────────────────────────────────────────────────────────────
async function loadAI() {
  const res = await chrome.runtime.sendMessage({ type: 'ai:get-config' });
  if (!res?.ok) return;
  const c = res.config;
  document.getElementById('ai-enabled').checked         = c.enabled;
  document.getElementById('ai-provider').value          = c.provider;
  document.getElementById('ai-base-url').value          = c.baseUrl || '';
  document.getElementById('ai-api-key').value           = c.apiKey  || '';
  document.getElementById('ai-system-prompt').value     = c.systemPrompt || '';
  await refreshModels(c);
}
async function refreshModels(cfg) {
  const res = await chrome.runtime.sendMessage({ type: 'ai:list-models' });
  const sel = document.getElementById('ai-model');
  const cur = cfg?.model || (await chrome.runtime.sendMessage({type:'ai:get-config'}))?.config?.model || '';
  sel.innerHTML = '<option value="">— select model —</option>';
  (res?.models||[]).forEach(m => {
    const o = document.createElement('option');
    o.value=m.id; o.textContent=m.name; if(m.id===cur) o.selected=true;
    sel.appendChild(o);
  });
  if (!res?.models?.length) sel.innerHTML = '<option value="">No models found</option>';
}
document.getElementById('ai-refresh-models').addEventListener('click', () => refreshModels());
document.getElementById('ai-save').addEventListener('click', async () => {
  const patch = {
    enabled:      document.getElementById('ai-enabled').checked,
    provider:     document.getElementById('ai-provider').value,
    baseUrl:      document.getElementById('ai-base-url').value.trim(),
    apiKey:       document.getElementById('ai-api-key').value.trim(),
    model:        document.getElementById('ai-model').value,
    systemPrompt: document.getElementById('ai-system-prompt').value.trim(),
  };
  const res = await chrome.runtime.sendMessage({ type: 'ai:set-config', patch });
  setStatus('ai-status', res?.ok ? 'Saved. ✓' : 'Error.', !res?.ok);
});
document.getElementById('ai-open-chat').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'ai:open-panel' });
});
loadAI();

// ── Search filter (merged into Focus Guard) ───────────────────────────────────
async function loadBlRules() {
  const res = await chrome.runtime.sendMessage({ type: 'bl:get-rules' });
  const rules = res?.rules || '';
  document.getElementById('bl-rules').value = rules;
  // infer enabled from whether rules exist
  document.getElementById('bl-enabled').checked = rules.trim().length > 0;
}

document.getElementById('bl-save')?.addEventListener('click', async () => {
  const rules = document.getElementById('bl-rules').value;
  const res   = await chrome.runtime.sendMessage({ type: 'bl:set-rules', rules });
  setStatus('bl-status', res?.ok ? 'Saved. ✓' : 'Error.', !res?.ok);
});

loadBlRules();

// ── Security (Vault & 2FA / Cookies / Screen Lock) ────────────────────────────
document.getElementById('open-vault').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/vault.html') });
});
document.getElementById('open-cookies').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/cookies.html') });
});

async function loadScreenLock() {
  const res = await chrome.runtime.sendMessage({ type: 'screen-lock:status' }).catch(() => null);
  if (!res?.ok) return;
  document.getElementById('lock-pw-status').textContent = res.hasPassword ? 'Password set' : 'No password set yet';
  document.getElementById('lock-set-pw').textContent = res.hasPassword ? 'Change' : 'Set';
  document.getElementById('lock-ask-startup').checked = !!res.askOnStartup;
  document.getElementById('lock-now').disabled = !res.hasPassword;
}

document.getElementById('lock-set-pw').addEventListener('click', async () => {
  const hasPw = document.getElementById('lock-set-pw').textContent === 'Change';
  if (hasPw) {
    const oldPassword = prompt('Current password:');
    if (oldPassword == null) return;
    const newPassword = prompt('New password:');
    if (!newPassword) return;
    const res = await chrome.runtime.sendMessage({ type: 'screen-lock:change-password', oldPassword, newPassword });
    setStatus('lock-status', res.ok ? 'Password changed. ✓' : 'Incorrect current password.', !res.ok);
  } else {
    const newPassword = prompt('Choose a password for Screen Lock:');
    if (!newPassword) return;
    await chrome.runtime.sendMessage({ type: 'screen-lock:set-password', password: newPassword });
    setStatus('lock-status', 'Password set. ✓');
  }
  loadScreenLock();
});

document.getElementById('lock-ask-startup').addEventListener('change', async function () {
  await chrome.runtime.sendMessage({ type: 'screen-lock:set-ask-on-startup', enabled: this.checked });
});

document.getElementById('lock-now').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'screen-lock:lock-now' });
});

loadScreenLock();
