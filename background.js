// background.js — Captain unified service worker v6
// Changes from v5:
//   • Added cookies and screen-lock providers (feature parity with the
//     standalone cookie-editor / chrome-lockdown extensions, reimplemented
//     natively against Captain's provider architecture)
//   • TOTP is merged into Vault: a 2FA secret is stored as a protected
//     `otp` field on a vault entry (the KeePass/Bitwarden convention)
//     instead of a separate plaintext chrome.storage.local account list —
//     one encrypted store, unlocked/locked together, instead of two
//   • Focus Guard ticker is now demand-driven instead of running a 1s
//     setInterval unconditionally forever (see ticker.js) — this was the
//     dominant idle CPU/fan-noise source
//   • Removed the dead `fg-keepalive` alarm (created, never listened to)
// Changes from v4:
//   • Annotate provider removed
//   • Blacklist merged into focus-guard
//   • context menus owned exclusively by focus-guard (no more removeAll() race)
//   • guard.js and overlay.js injected lazily via scripting API (not in manifest content_scripts)

import { init as initBrowser,   handlers as browserHandlers   } from './providers/browser.js';
import { init as initWebRTC,    handlers as webrtcHandlers,
         handleWebrtcAction                                    } from './providers/webrtc.js';
import { init as initUA,        handlers as uaHandlers        } from './providers/ua.js';
import { init as initFG,        handlers as fgHandlers        } from './providers/focus-guard.js';
import { init as initProxy,     handlers as proxyHandlers,
         handleProxyAction                                     } from './providers/proxy.js';
import { init as initVault,     handlers as vaultHandlers,
         handleVaultAction                                     } from './providers/vault.js';
import { init as initDiscard,   handlers as discardHandlers   } from './providers/tab-discard.js';
import { init as initWorkspace, handlers as workspaceHandlers,
         handleWorkspaceAction                                 } from './providers/workspace.js';
import { init as initAI,        handlers as aiHandlers,
         streamChat                                            } from './providers/ai.js';
import { init as initCookies,   handlers as cookiesHandlers   } from './providers/cookies.js';
import { init as initScreenLock, handlers as screenLockHandlers } from './providers/screen-lock.js';
import { init as initWebtime,   handlers as webtimeHandlers   } from './providers/webtime.js';
import { get, set }  from './core/storage.js';
import { recordUse } from './core/usage.js';

// ── Migration ─────────────────────────────────────────────────────────────────
async function migrate() {
  const done = await get('c.migrated.v1');
  if (done) return;
  const old = await chrome.storage.local.get(null);
  const mapping = {
    'p.proxy.profiles': 'c.proxy.profiles',
    'p.proxy.active':   'c.proxy.active',
    'p.ua.active':      'c.ua.active',
    'p.ua.custom':      'c.ua.custom',
    'p.webrtc':         'c.webrtc',
    'p.bl.rules':       'c.bl.rules',
  };
  const patch = {};
  for (const [from, to] of Object.entries(mapping)) {
    if (old[from] !== undefined && old[to] === undefined) patch[to] = old[from];
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
  await set('c.migrated.v1', true);
}

// ── Lazy content-script injection ─────────────────────────────────────────────
// Instead of declaring guard.js and overlay.js as persistent content_scripts
// (which injected them into every page unconditionally), we inject them on
// demand when a tab becomes ready.  This avoids running two content scripts
// on every page load regardless of whether the user needs them.
//
// Injection is idempotent: we track injected tab IDs in a Set that is cleared
// when the tab navigates or is removed.

const _injectedTabs = new Set();

async function injectContentScripts(tabId, frameId = 0) {
  if (_injectedTabs.has(tabId)) return;
  _injectedTabs.add(tabId);
  try {
    // guard.js needs document_start semantics for FG url capture — inject
    // at document_idle (the earliest we can reach via scripting API after nav).
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['content/guard.js'],
      injectImmediately: true,
    }).catch(() => {});
    await chrome.scripting.insertCSS({
      target: { tabId, frameIds: [frameId] },
      files: ['content/overlay.css'],
    }).catch(() => {});
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['content/overlay.js'],
    }).catch(() => {});
  } catch { _injectedTabs.delete(tabId); }
}

(async () => {
  await migrate();

  await Promise.all([
    initBrowser(),
    initWebRTC(),
    initUA(),
    initFG(),       // context menus are fully owned here in v5
    initProxy(),
    initVault(),
    initDiscard(),
    initWorkspace(),
    initAI(),
    initCookies(),
    initScreenLock(),
    initWebtime(),
  ]);

  const allHandlers = {
    ...browserHandlers,
    ...webrtcHandlers,
    ...uaHandlers,
    ...fgHandlers,
    ...proxyHandlers,
    ...vaultHandlers,
    ...discardHandlers,
    ...workspaceHandlers,
    ...aiHandlers,
    ...cookiesHandlers,
    ...screenLockHandlers,
    ...webtimeHandlers,
  };

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (!msg?.type) return;

    const dynamicHandler =
      handleProxyAction(msg.type) ??
      handleWorkspaceAction(msg.type) ??
      handleVaultAction(msg.type) ??
      handleWebrtcAction(msg.type);

    const handler = dynamicHandler ?? allHandlers[msg.type];
    if (!handler) return;

    if (msg._fromPalette && msg.type) {
      recordUse(msg._actionId || msg.type).catch(() => {});
    }

    handler(msg, sender)
      .then(respond)
      .catch(err => {
        console.error('[Captain] Handler error for', msg.type, err);
        respond({ ok: false, error: String(err) });
      });

    return true;
  });

  // ── Lazy injection triggers ────────────────────────────────────────────────
  // Clear injected state on navigation so we re-inject on the new document.
  chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
    if (frameId !== 0) return;
    if (!url?.startsWith('http')) return;
    _injectedTabs.delete(tabId);
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!tab.url?.startsWith('http')) return;
    injectContentScripts(tabId).catch(() => {});
  });

  // Inject into already-open tabs on SW startup
  chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).then(tabs => {
    for (const tab of tabs) {
      if (tab.status === 'complete') injectContentScripts(tab.id).catch(() => {});
    }
  }).catch(() => {});

  chrome.tabs.onRemoved.addListener(tabId => _injectedTabs.delete(tabId));

  // ── AI streaming ───────────────────────────────────────────────────────────
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'captain-ai-stream') return;
    port.onMessage.addListener(async (msg) => {
      if (msg.type !== 'ai:stream') return;
      try {
        const config = await get('c.ai.config').then(v => v || {});
        for await (const chunk of streamChat(msg.messages, config)) {
          try { port.postMessage({ type: 'chunk', content: chunk }); } catch { break; }
        }
        port.postMessage({ type: 'done' });
      } catch (e) {
        try { port.postMessage({ type: 'error', error: String(e) }); } catch {}
      }
    });
  });

  chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'open-captain') await browserHandlers['browser:open-captain']?.();
  });

  chrome.action.onClicked.addListener(async () => {
    await browserHandlers['browser:open-captain']?.();
  });
})();
