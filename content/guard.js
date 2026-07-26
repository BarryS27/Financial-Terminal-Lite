// content/guard.js — Captain focus guard + vault autofill
// IIFE + sentinel prevents duplicate-declaration errors on SPA re-injection.
(function () {
  'use strict';
  if (window.__captainGuardLoaded) return;
  window.__captainGuardLoaded = true;

let _ctxValid = true;

function safeSend(msg, respond) {
  if (!_ctxValid) return;
  try {
    const p = chrome.runtime.sendMessage(msg);
    (respond ? p.then(respond) : p).catch(() => {});
  } catch (e) {
    if (String(e).includes('invalidated')) { _ctxValid = false; cleanup(); }
  }
}

let gTimer = null;
let gAlert = null;

function cleanup() {
  gTimer?.remove(); gTimer = null;
  gAlert?.remove(); gAlert = null;
}

const TIMER_SIZES     = ['10px', '12px', '14px', '16px'];
const TIMER_LOCATIONS = [
  ['0px',  'auto', '0px',  'auto'],
  ['0px',  'auto', 'auto', '0px' ],
  ['auto', '0px',  'auto', '0px' ],
  ['auto', '0px',  '0px',  'auto'],
];

function updateTimer(text, size, location) {
  if (!text) { if (gTimer) gTimer.hidden = true; return; }
  if (!gTimer) {
    gTimer = document.createElement('div');
    gTimer.className = 'captain-guard-timer';
    gTimer.addEventListener('dblclick', () => { gTimer.hidden = true; });
  }
  if (!document.documentElement.contains(gTimer))
    document.documentElement.appendChild(gTimer);
  gTimer.innerText = text;
  if (size >= 0 && size < TIMER_SIZES.length)
    gTimer.style.fontSize = TIMER_SIZES[size];
  if (location >= 0 && location < TIMER_LOCATIONS.length) {
    const [top, bottom, left, right] = TIMER_LOCATIONS[location];
    Object.assign(gTimer.style, { top, bottom, left, right });
  }
  gTimer.hidden = false;
}

function showAlert(text) {
  if (!gAlert) {
    gAlert = document.createElement('div');
    gAlert.className = 'captain-guard-alert-container';
    const box  = document.createElement('div');
    box.className = 'captain-guard-alert-box';
    box.addEventListener('click', () => { gAlert.style.display = 'none'; });
    const icon = document.createElement('div');
    icon.className = 'captain-guard-alert-icon';
    const txt  = document.createElement('div');
    txt.className = 'captain-guard-alert-text';
    box.appendChild(icon);
    box.appendChild(txt);
    gAlert.appendChild(box);
    document.documentElement.appendChild(gAlert);
  }
  gAlert.querySelector('.captain-guard-alert-text').innerText = text;
  gAlert.style.display = 'flex';
}

function applyFilter(filterName, filterCustom) {
  const filters = {
    'blur (1px)': 'blur(1px)', 'blur (2px)': 'blur(2px)', 'blur (4px)': 'blur(4px)',
    'blur (8px)': 'blur(8px)', 'blur (16px)': 'blur(16px)', 'blur (32px)': 'blur(32px)',
    'fade (80%)': 'opacity(20%)', 'fade (90%)': 'opacity(10%)', 'fade (100%)': 'opacity(0%)',
    'grayscale': 'grayscale(100%)', 'invert': 'invert(100%)', 'sepia': 'sepia(100%)',
    'custom': filterCustom,
  };
  document.documentElement.style.filter = filters[filterName] || 'none';
}

safeSend({ type: 'fg:loaded',   url: document.URL });
safeSend({ type: 'fg:referrer', referrer: document.referrer });

window.addEventListener('focus', () => safeSend({ type: 'fg:focus', focus: true  }));
window.addEventListener('blur',  () => safeSend({ type: 'fg:focus', focus: false }));

chrome.runtime.onMessage.addListener((msg, _, respond) => {
  switch (msg.type) {
    case 'fg:timer':  updateTimer(msg.text, msg.size, msg.location); break;
    case 'fg:alert':  showAlert(msg.text); break;
    case 'fg:filter': applyFilter(msg.filterName, msg.filterCustom); break;
    case 'fg:keyword': {
      if (!msg.keywordRE) { respond(null); return true; }
      const text = document.title + ((!msg.titleOnly && document.body) ? '\n' + document.body.innerText : '');
      const m    = new RegExp(msg.keywordRE, 'iu').exec(text);
      respond(m ? m[0] : null);
      return true;
    }
    case 'fg:ping':
      safeSend({ type: 'fg:loaded', url: document.URL });
      break;
    case 'captain:webrtc-policy':
    case 'webrtc:apply-inject': {
      // These are handled by inject/webrtc-block.js in MAIN world;
      // guard just needs to NOT swallow them — pass through.
      break;
    }
    case 'captain:scroll':
      if      (msg.dir === 'top')    window.scrollTo({ top: 0,                          behavior: 'smooth' });
      else if (msg.dir === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      break;
    case 'captain:print':      window.print(); break;
    case 'captain:fullscreen':
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
      else                             document.exitFullscreen().catch(() => {});
      break;
  }
});

// ── Styles ────────────────────────────────────────────────────────────────────
const timerStyle = document.createElement('style');
timerStyle.textContent = `
.captain-guard-timer {
  position: fixed; z-index: 2147483647;
  font-family: monospace; font-size: 12px;
  background: rgba(0,0,0,.7); color: #fff;
  padding: 2px 6px; border-radius: 3px;
  pointer-events: none; user-select: none;
}
.captain-guard-alert-container {
  position: fixed; inset: 0; z-index: 2147483647;
  display: none; align-items: flex-start; justify-content: center;
  padding-top: 40px;
}
.captain-guard-alert-box {
  background: #b00; color: #fff;
  padding: 12px 20px; border-radius: 8px;
  font-family: system-ui, sans-serif; font-size: 14px;
  cursor: pointer; max-width: 400px;
}
`;
document.documentElement.appendChild(timerStyle);

// ── SERP filter (Google only) ─────────────────────────────────────────────────
const _isExtensionPage = location.protocol === 'chrome-extension:' || location.protocol === 'moz-extension:';
if (!_isExtensionPage && /^https:\/\/www\.google\.[^/]+\/search/.test(location.href)) {
  initSerpFilter();
}

function initSerpFilter() {
  const cache = new Map();

  async function checkHostname(hostname) {
    if (cache.has(hostname)) return cache.get(hostname);
    try {
      const result  = await chrome.runtime.sendMessage({ type: 'bl:check', hostname });
      const blocked = result?.blocked ?? false;
      cache.set(hostname, blocked);
      return blocked;
    } catch { cache.set(hostname, false); return false; }
  }

  function extractHostname(el) {
    const cite = el.querySelector('cite');
    if (cite) {
      try { return new URL('https://' + cite.textContent.trim().split('/')[0]).hostname; } catch {}
    }
    const link = el.querySelector('a[href]');
    if (link) {
      try { return new URL(link.href).hostname; } catch {}
    }
    return null;
  }

  function markAsBlocked(el) {
    if (el.dataset.captainFiltered) return;
    el.dataset.captainFiltered = '1';
    el.style.display = 'none';
    const marker = document.createElement('div');
    marker.style.cssText = 'font-size:12px;color:#999;padding:2px 0;cursor:pointer;';
    marker.textContent   = '⊘ Hidden by Captain Search Filter — click to show';
    marker.addEventListener('click', () => { el.style.display = ''; marker.remove(); });
    el.parentNode?.insertBefore(marker, el);
  }

  async function processResults(root) {
    if (!_ctxValid) return;
    const items = (root || document).querySelectorAll('#search .g, #rso .g, #search [data-hveid]');
    for (const item of items) {
      if (item.dataset.captainFiltered) continue;
      const hostname = extractHostname(item);
      if (!hostname) continue;
      if (await checkHostname(hostname)) markAsBlocked(item);
    }
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', () => processResults(null));
  else
    processResults(null);

  // Optimization 6: batch DOM mutations via requestIdleCallback
  let pendingNodes = [];
  let scheduled    = false;

  const observer = new MutationObserver(mutations => {
    if (!_ctxValid) { observer.disconnect(); return; }
    for (const mutation of mutations)
      for (const node of mutation.addedNodes)
        if (node.nodeType === 1) pendingNodes.push(node);
    if (!scheduled) {
      scheduled = true;
      requestIdleCallback(() => {
        const nodes = pendingNodes.splice(0);
        scheduled   = false;
        nodes.forEach(processResults);
      });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

// ── Vault autofill ────────────────────────────────────────────────────────────
// Listens for vault:autofill messages from the background (triggered by the
// command palette "vault:fill:<uuid>" action) and fills the best visible
// username+password pair on the current page.

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'vault:autofill') return;
  fillCredentials(msg.username, msg.password);
});

function fillCredentials(username, password) {
  // Find password fields — prefer visible ones
  const pwFields = [...document.querySelectorAll('input[type="password"]')]
    .filter(isVisible);
  if (!pwFields.length) return;

  // Try to find the associated username field for the first password field
  const pwField = pwFields[0];
  if (username) {
    const userField = findUsernameField(pwField);
    if (userField) nativeSet(userField, username);
  }
  nativeSet(pwField, password);
}

// Walk backwards from the password field to find the nearest text/email input
function findUsernameField(pwField) {
  // 1. Same <form>
  if (pwField.form) {
    const inputs = [...pwField.form.elements].filter(
      el => el !== pwField && /^(text|email|tel)$/.test(el.type) && isVisible(el)
    );
    if (inputs.length) return inputs[inputs.length - 1];
  }
  // 2. Walk previous siblings / ancestors
  const all = [...document.querySelectorAll('input[type="text"],input[type="email"],input[type="tel"]')]
    .filter(isVisible);
  // Find the closest one that appears before pwField in DOM order
  let best = null;
  for (const el of all) {
    if (el.compareDocumentPosition(pwField) & Node.DOCUMENT_POSITION_FOLLOWING) best = el;
  }
  return best;
}

function isVisible(el) {
  if (!el.offsetParent && el.offsetWidth === 0 && el.offsetHeight === 0) return false;
  const s = getComputedStyle(el);
  return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
}

// React/Vue/Angular-safe field setter: sets the native value and dispatches
// input + change events so framework state updates properly.
function nativeSet(el, value) {
  const nativeInputValueSetter =
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── Vault: autofill hint chip ─────────────────────────────────────────────────
// When the vault is unlocked and a page has matching credentials, show a small
// chip near password fields so users can trigger autofill without opening the
// command palette.

(async function initAutofillChip() {
  if (!_ctxValid) return;
  let _credCache = null;

  async function getCredentials() {
    if (_credCache !== null) return _credCache;
    try {
      const hostname = location.hostname.replace(/^www\./, '');
      const res = await chrome.runtime.sendMessage({ type: 'vault:for-hostname', hostname });
      _credCache = (res?.ok && res.entries?.length) ? res.entries : [];
    } catch { _credCache = []; }
    return _credCache;
  }

  function attachChip(pwField) {
    if (pwField.dataset.captainChip) return;
    pwField.dataset.captainChip = '1';

    const chip = document.createElement('button');
    chip.className        = 'captain-fill-chip';
    chip.type             = 'button';
    chip.textContent      = '🔑 Fill';
    chip.style.cssText    = [
      'position:absolute', 'z-index:2147483646',
      'padding:3px 8px', 'border-radius:4px',
      'font-size:11px', 'font-family:system-ui,sans-serif',
      'background:#18181b', 'color:#e4e4e7',
      'border:1px solid #3f3f46', 'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,.4)',
      'display:none', 'line-height:1.4',
    ].join(';');

    document.documentElement.appendChild(chip);
    positionChip(chip, pwField);

    // Show chip when the field is focused
    pwField.addEventListener('focus', async () => {
      const creds = await getCredentials();
      if (!creds.length) return;
      positionChip(chip, pwField);
      chip.style.display = 'block';
    });
    pwField.addEventListener('blur', () => {
      setTimeout(() => { chip.style.display = 'none'; }, 200);
    });

    chip.addEventListener('mousedown', e => e.preventDefault());
    chip.addEventListener('click', async () => {
      const creds = await getCredentials();
      if (!creds.length) return;
      // Use the first matching credential; password fetched from background
      const entry = creds[0];
      let pw = '';
      try {
        const r = await chrome.runtime.sendMessage({ type: 'vault:get-password', uuid: entry.uuid });
        pw = r?.password ?? '';
      } catch {}
      fillCredentials(entry.username, pw);
      chip.style.display = 'none';
    });
  }

  function positionChip(chip, field) {
    const r = field.getBoundingClientRect();
    chip.style.top  = `${r.bottom + window.scrollY + 4}px`;
    chip.style.left = `${r.left   + window.scrollX}px`;
  }

  function scanFields() {
    if (!_ctxValid) return;
    document.querySelectorAll('input[type="password"]').forEach(el => {
      if (isVisible(el)) attachChip(el);
    });
  }

  // Don't show chips if vault is locked — avoid an unnecessary round-trip
  try {
    const status = await chrome.runtime.sendMessage({ type: 'vault:status' });
    if (!status?.unlocked) return;
  } catch { return; }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', scanFields);
  else
    scanFields();

  // Watch for dynamically added password fields (SPAs)
  let _pending = false;
  const observer = new MutationObserver(() => {
    if (!_ctxValid) { observer.disconnect(); return; }
    if (_pending) return;
    _pending = true;
    requestIdleCallback(() => { _pending = false; scanFields(); });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();

})();
