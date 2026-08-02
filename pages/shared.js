// pages/shared.js — Common UI-page helpers
// Consolidates copies of esc()/copyText() that were previously duplicated
// (with small inconsistencies) across vault.js, ai.js, and options.js.
// Import as: import { $, send, esc, copyText, toast } from './shared.js';

export const $ = id => document.getElementById(id);

export const send = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data });

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let _keyframesInjected = false;
function ensureKeyframes() {
  if (_keyframesInjected) return;
  _keyframesInjected = true;
  document.head.insertAdjacentHTML('beforeend', '<style>@keyframes fadeout{to{opacity:0}}</style>');
}

// Small fixed pill, matching the visual language already used ad hoc for
// "Copied!" feedback across pages before this module existed.
export function toast(message, { color = '#22c55e' } = {}) {
  ensureKeyframes();
  const el = document.createElement('div');
  el.textContent = message;
  el.style.cssText = `position:fixed;bottom:20px;left:50%;transform:translateX(-50%);` +
    `background:${color};color:#fff;padding:8px 20px;border-radius:20px;font-size:13px;` +
    `font-weight:600;z-index:9999;pointer-events:none;animation:fadeout .8s .8s forwards`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1700);
}

export function copyText(text, message = 'Copied!') {
  navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  });
  toast(message);
}
