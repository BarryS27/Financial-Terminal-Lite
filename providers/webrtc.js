// providers/webrtc.js
// Derived from WebRTCControl-1.2.0 background.js
// REMOVED: chrome.tabs.create() install redirect, setUninstallURL(), rateUs
// ADDED: Captain provider registration

import { register } from '../core/registry.js';
import { get, set } from '../core/storage.js';

const MODE_KEY = 'c.webrtc';
const FULL_BLOCK_CS_ID = 'captain-webrtc-full-block';

const MODES = {
  off:     { label: 'Off',             title: 'WebRTC: Disable protection',    desc: 'Allow WebRTC to work normally' },
  partial: { label: 'Partial block',   title: 'WebRTC: Block non-proxied UDP', desc: 'Recommended — prevents IP leaks via WebRTC' },
  full:    { label: 'Full block',      title: 'WebRTC: Full block',            desc: 'Block all WebRTC connections entirely' },
};

async function setPolicyDefault() {
  try {
    if (chrome.privacy?.network?.webRTCIPHandlingPolicy) {
      await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
    }
  } catch (e) { console.warn('[WebRTC] Failed to clear policy:', e); }
}

async function setPolicyPartial() {
  try {
    if (chrome.privacy?.network?.webRTCIPHandlingPolicy) {
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: 'disable_non_proxied_udp' });
    }
  } catch (e) { console.warn('[WebRTC] Failed to set partial policy:', e); }
}

async function registerFullBlock() {
  try {
    await chrome.scripting.registerContentScripts([{
      id: FULL_BLOCK_CS_ID,
      matches: ['<all_urls>'],
      js: ['inject/webrtc-block.js'],
      runAt: 'document_start',
      world: 'MAIN',
    }]);
  } catch (e) {
    if (!String(e?.message || '').includes('Duplicate script ID')) {
      console.warn('[WebRTC] registerContentScripts failed:', e);
    }
  }
}

async function unregisterFullBlock() {
  try { await chrome.scripting.unregisterContentScripts({ ids: [FULL_BLOCK_CS_ID] }); } catch {}
}

export async function applyMode(mode) {
  await unregisterFullBlock();
  await setPolicyDefault();
  if (mode === 'partial') await setPolicyPartial();
  else if (mode === 'full') await registerFullBlock();
  await set(MODE_KEY, mode);
}

export async function init() {
  const saved = (await get(MODE_KEY)) ?? 'off';
  await applyMode(saved);

  register('webrtc', async (q) => {
    const match = t => !q || t.toLowerCase().includes(q.toLowerCase());
    return Object.entries(MODES)
      .filter(([, m]) => match(m.title))
      .map(([mode, m]) => ({
        id: `webrtc:${mode}`,
        title: m.title,
        desc: m.desc,
        emoji: '🛡',
        type: 'action',
      }));
  });
}

export const handlers = {
  'webrtc:set': async (msg) => {
    await applyMode(msg.mode);
    return { ok: true };
  },
  'webrtc:get': async () => {
    const mode = (await get(MODE_KEY)) ?? 'off';
    return { ok: true, mode };
  },
};

// Dynamic per-mode palette actions (mirror the proxy:switch:<name> /
// ws:activate:<id> pattern) — clicking "WebRTC: Full block" etc. sends
// `webrtc:${mode}` as the message type, which needs to resolve here since
// it isn't a literal key in `handlers` above.
export function handleWebrtcAction(type) {
  const mode = type && Object.keys(MODES).find(m => type === `webrtc:${m}`);
  if (!mode) return null;
  return () => handlers['webrtc:set']({ mode });
}
