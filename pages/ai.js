'use strict';
const _persistedId = sessionStorage.getItem('captain-ai-conv-id');
const CONV_ID = _persistedId || ('conv_' + Date.now());
if (!_persistedId) sessionStorage.setItem('captain-ai-conv-id', CONV_ID);
let _streaming = false;
let _config = null;

async function init() {
  const res = await chrome.runtime.sendMessage({ type: 'ai:get-config' });
  _config = res?.config || {};
  const badge = document.getElementById('model-badge');
  badge.textContent = _config.model || 'No model';
  document.getElementById('send-btn').disabled = !_config.model || !_config.enabled;
  await loadHistory();
}

document.getElementById('model-badge').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'ai:open-options' });
});

async function loadHistory() {
  const res = await chrome.runtime.sendMessage({ type: 'ai:get-history', conversationId: CONV_ID });
  const msgs = res?.messages || [];
  if (msgs.length) {
    document.getElementById('empty-state')?.remove();
    msgs.forEach(m => appendBubble(m.role, m.content));
  }
}

function appendBubble(role, content, streaming = false) {
  document.getElementById('empty-state')?.remove();
  const wrap = document.getElementById('messages');
  const div  = document.createElement('div');
  div.className = `msg ${role}`;
  const av  = role === 'user' ? '↑' : '⎈';
  div.innerHTML = `<div class="avatar">${av}</div><div class="bubble${streaming ? ' streaming' : ''}">${esc(content)}</div>`;
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  return div.querySelector('.bubble');
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

async function send() {
  if (_streaming) return;
  const input = document.getElementById('user-input');
  const text  = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = '';
  _streaming = true;
  document.getElementById('send-btn').disabled = true;
  appendBubble('user', text);
  await chrome.runtime.sendMessage({ type: 'ai:add-message', role: 'user', content: text, conversationId: CONV_ID });
  const histRes = await chrome.runtime.sendMessage({ type: 'ai:get-history', conversationId: CONV_ID });
  const history = (histRes?.messages || []).map(m => ({ role: m.role, content: m.content }));
  const bubble  = appendBubble('assistant', '…', true);
  let full = '';
  try {
    const port = chrome.runtime.connect({ name: 'captain-ai-stream' });
    const msgs = _config.systemPrompt
      ? [{ role: 'system', content: _config.systemPrompt }, ...history]
      : history;
    port.postMessage({ type: 'ai:stream', messages: msgs });
    await new Promise((res, rej) => {
      port.onMessage.addListener(msg => {
        if (msg.type === 'chunk') {
          full += msg.content;
          bubble.textContent = full;
          bubble.classList.remove('streaming');
          document.getElementById('messages').scrollTop = 99999;
        } else if (msg.type === 'done')  res();
          else if (msg.type === 'error') rej(new Error(msg.error));
      });
      port.onDisconnect.addListener(res);
    });
    if (full) await chrome.runtime.sendMessage({ type: 'ai:add-message', role: 'assistant', content: full, conversationId: CONV_ID });
  } catch (e) {
    bubble.textContent = `Error: ${e.message}`;
    bubble.style.color = 'oklch(45% 0.18 15)';
    bubble.classList.remove('streaming');
  }
  _streaming = false;
  document.getElementById('send-btn').disabled = !_config.model || !_config.enabled;
}

document.getElementById('send-btn').addEventListener('click', send);
document.getElementById('user-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
document.getElementById('user-input').addEventListener('input', e => {
  e.target.style.height = '';
  e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
});
document.getElementById('clear-btn').addEventListener('click', async () => {
  if (!confirm('Clear this conversation?')) return;
  await chrome.runtime.sendMessage({ type: 'ai:clear-history', conversationId: CONV_ID });
  const wrap = document.getElementById('messages');
  wrap.innerHTML = '';
  const es = document.createElement('div');
  es.id = 'empty-state';
  es.innerHTML = `<svg class="empty-icon" viewBox="0 0 44 44" fill="none"><circle cx="22" cy="22" r="19.5" stroke="currentColor" stroke-width="1.5"/><circle cx="22" cy="22" r="4" fill="currentColor"/></svg><h2>Captain AI</h2><p>Cleared. Ask away.</p>`;
  wrap.appendChild(es);
});
init();
