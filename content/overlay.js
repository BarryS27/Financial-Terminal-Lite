// content/overlay.js — Captain command palette overlay

(function () {
  'use strict';
  if (window.__captainOverlayLoaded) return;
  window.__captainOverlayLoaded = true;

  let frame   = null;
  let open    = false;
  let _ready  = false;
  let _queue  = null;

  let _cssInjected = false;
  function ensureCSS() {
    if (_cssInjected) return;
    _cssInjected = true;
    const link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = chrome.runtime.getURL('content/overlay.css');
    document.head?.appendChild(link);
  }

  function ensureFrame() {
    if (frame) return;
    ensureCSS();
    frame = document.createElement('iframe');
    frame.id  = 'captain-overlay-frame';
    frame.src = chrome.runtime.getURL('content/overlay-inner.html');
    frame.setAttribute('allow', '');
    Object.assign(frame.style, {
      position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
      border: 'none', zIndex: '2147483647', background: 'transparent',
      display: 'none', colorScheme: 'normal',
    });
    document.documentElement.appendChild(frame);
    window.addEventListener('message', onFrameMsg);
  }

  function framePost(msg) {
    if (!frame) return;
    if (_ready) {
      frame.contentWindow?.postMessage(msg, '*');
    } else {
      _queue = msg;
    }
  }

  function show() {
    if (open) return;
    ensureFrame();
    frame.style.display = 'block';
    open = true;
    framePost({ type: 'captain:show' });
  }

  function hide() {
    if (!open) return;
    open = false;
    frame.style.display = 'none';
  }

  const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;

  function onFrameMsg(e) {
    if (e.origin !== EXTENSION_ORIGIN) return;
    const { type } = e.data || {};
    if (!type?.startsWith('captain:')) return;

    if (type === 'captain:ready') {
      _ready = true;
      if (_queue) { frame.contentWindow?.postMessage(_queue, '*'); _queue = null; }
      return;
    }
    if (type === 'captain:close')  { hide(); return; }
    if (type === 'captain:action') { hide(); dispatchAction(e.data.action).catch(e => console.warn('[Captain] dispatch error:', e)); return; }
    if (type === 'captain:query')  { relay(e.data.query); return; }
    if (type === 'captain:remove') {
      chrome.runtime.sendMessage({ type: 'browser:remove', ...e.data }).catch(() => {});
      return;
    }
  }

  async function relay(query) {
    const res = await chrome.runtime.sendMessage({ type: 'browser:get-actions', query }).catch(() => ({}));
    frame?.contentWindow?.postMessage({ type: 'captain:results', actions: res?.actions || [] }, '*');
  }

  async function dispatchAction(action) {
    const id = action.id || '';
    // Preserve usage-tracking metadata so background.js can recordUse()
    const _meta = { _fromPalette: action._fromPalette || false, _actionId: action._actionId || id };
    let msg;

    if (id === 'browser:search' || action.action === 'search') {
      msg = { type: 'browser:search', query: action.query };
    } else if (id === 'browser:goto' || action.action === 'goto') {
      let url = action.query || action.url || '';
      if (url && !/^[\w-]+:\/\//i.test(url)) url = 'https://' + url;
      msg = { type: 'browser:goto', url };
    } else if (action.type === 'tab') {
      msg = { type: 'browser:do-action', actionType: 'tab',
              tabId: action.tabId, tabIndex: action.tabIndex, windowId: action.windowId };
    } else if (action.type === 'bookmark' || action.type === 'history') {
      msg = { type: 'browser:goto', url: action.url };
    } else if (id.startsWith('ua:set:')) {
      msg = { type: 'ua:set', ua: decodeURIComponent(id.slice(7)), mode: 'global' };
    } else if (id.startsWith('act:') || id.startsWith('sc:')) {
      msg = { type: 'browser:do-action', id, url: action.url };
    } else if (id.startsWith('proxy:switch:')) {
      let _pname = id.slice('proxy:switch:'.length);
      try { _pname = decodeURIComponent(_pname); } catch {}
      msg = { type: 'proxy:switch', name: _pname };
    } else if (id.startsWith('ws:activate:')) {
      // ws:activate:<workspace-id>
      msg = { type: 'ws:activate', id: id.slice('ws:activate:'.length) };
    } else if (id.startsWith('vault:fill:')) {
      msg = { type: 'vault:fill:' + id.slice('vault:fill:'.length) };
    } else {
      msg = { type: id, ...action };
    }

    await chrome.runtime.sendMessage({ ...msg, ..._meta }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'captain:open')  show();
    if (msg.type === 'captain:close') hide();
  });

  window.addEventListener('popstate', hide);
  window.addEventListener('hashchange', hide);
  (function patchHistory() {
    const _push    = history.pushState.bind(history);
    const _replace = history.replaceState.bind(history);
    history.pushState    = (...a) => { hide(); _push(...a); };
    history.replaceState = (...a) => { hide(); _replace(...a); };
  })();

  document.addEventListener('keydown', e => {
    const mac = /mac/i.test(navigator.userAgentData?.platform || navigator.userAgent);
    if ((mac ? e.metaKey : e.ctrlKey) && e.shiftKey && e.key === 'K') {
      e.preventDefault();
      open ? hide() : show();
    }
    if (e.key === 'Escape' && open) { e.preventDefault(); hide(); }
  }, true);

})();
