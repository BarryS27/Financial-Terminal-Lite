// newtab.js — new-tab palette host for restricted pages
// Opens when the user triggers Captain on a chrome:// or extension:// page.

const frame = document.createElement('iframe');
frame.src = chrome.runtime.getURL('content/overlay-inner.html');
Object.assign(frame.style, {
  position: 'fixed', inset: '0', width: '100%', height: '100%',
  border: 'none', zIndex: '2147483647', background: 'transparent',
});
document.body.appendChild(frame);

const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('')).origin;
let _ready = false;
let _showQueued = false;

function framePost(msg) {
  if (_ready) {
    frame.contentWindow?.postMessage(msg, '*');
  } else {
    if (msg.type === 'captain:show') _showQueued = true;
  }
}

window.addEventListener('message', async e => {
  if (e.origin !== EXTENSION_ORIGIN) return;
  const { type, query, action, itemType, id, tabId } = e.data || {};
  if (!type?.startsWith('captain:')) return;

  if (type === 'captain:ready') {
    _ready = true;
    document.getElementById('msg').style.display = 'none';
    if (_showQueued) frame.contentWindow?.postMessage({ type: 'captain:show' }, '*');
    return;
  }
  if (type === 'captain:close')  { window.close(); return; }
  if (type === 'captain:remove') {
    chrome.runtime.sendMessage({ type: 'browser:remove', itemType, id, tabId }).catch(() => {});
    return;
  }
  if (type === 'captain:query') {
    const res = await chrome.runtime.sendMessage({ type: 'browser:get-actions', query: query || '' }).catch(() => ({}));
    frame.contentWindow?.postMessage({ type: 'captain:results', actions: res?.actions || [] }, '*');
    return;
  }
  if (type === 'captain:action' && action) {
    await dispatchAction(action);
    window.close();
  }
});

async function dispatchAction(action) {
  const id = action.id || '';
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
  } else {
    msg = { type: id, ...action };
  }
  await chrome.runtime.sendMessage(msg).catch(() => {});
}

// Queue the show immediately — will deliver once iframe signals ready
framePost({ type: 'captain:show' });
