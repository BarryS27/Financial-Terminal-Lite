'use strict';
// screen-lock.js — Lock screen UI logic (runs in pages/screen-lock.html)
// Opened as a standalone popup window by providers/screen-lock.js while
// the browser is locked.

import { $, send } from './shared.js';

async function init() {
  const status = await send('screen-lock:status');
  if (!status.hasPassword) {
    $('lock-view').style.display = 'none';
    $('setup-view').style.display = 'block';
  }
}

function makeToggle(btnId, inputId) {
  $(btnId).addEventListener('click', () => {
    const inp = $(inputId);
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $(btnId).textContent = show ? 'Hide' : 'Show';
  });
}
makeToggle('toggle-unlock-pw', 'unlock-pw');
makeToggle('toggle-setup-pw', 'setup-pw');

async function tryUnlock() {
  const pw = $('unlock-pw').value;
  if (!pw) { $('unlock-error').textContent = 'Enter your password.'; return; }
  $('btn-unlock').disabled = true;
  $('btn-unlock').textContent = 'Unlocking…';
  const res = await send('screen-lock:unlock', { password: pw });
  $('btn-unlock').disabled = false;
  $('btn-unlock').textContent = 'Unlock';
  if (res.ok) {
    // The background closes this window as part of unlocking; nothing more to do.
    $('unlock-error').textContent = '';
  } else {
    $('unlock-error').textContent = 'Incorrect password.';
    $('unlock-pw').value = '';
    $('unlock-pw').focus();
  }
}
$('btn-unlock').addEventListener('click', tryUnlock);
$('unlock-pw').addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });

$('btn-setup').addEventListener('click', async () => {
  const pw = $('setup-pw').value;
  const confirm_ = $('setup-pw-confirm').value;
  if (!pw || pw.length < 4) { $('setup-error').textContent = 'Choose a password of at least 4 characters.'; return; }
  if (pw !== confirm_) { $('setup-error').textContent = 'Passwords do not match.'; return; }
  await send('screen-lock:set-password', { password: pw });
  $('setup-view').style.display = 'none';
  $('lock-view').style.display = 'block';
  $('unlock-error').textContent = 'Password set — you can lock the browser from the palette or options page any time.';
});

init();
