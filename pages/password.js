'use strict';

const params     = new URLSearchParams(location.search);
const blockedURL = params.get('url') ? decodeURIComponent(params.get('url')) : '';
const blockedSet = params.get('set') || '1';

const pwInput  = document.getElementById('pw');
const errorEl  = document.getElementById('error');
const btnSubmit = document.getElementById('btn-submit');
const btnBack   = document.getElementById('btn-back');

function showError(msg) {
  errorEl.textContent = msg;
  pwInput.select();
}

async function tryUnlock() {
  const password = pwInput.value;
  if (!password) { showError('Please enter the password.'); return; }

  btnSubmit.disabled = true;
  btnSubmit.textContent = 'Checking…';

  try {
    const res = await chrome.runtime.sendMessage({
      type: 'fg:password',
      password,
      blockedURL,
      blockedSet,
    });
    if (res?.ok) {
      // allowBlockedPage in background will navigate the tab — nothing more needed here
      errorEl.textContent = '';
    } else {
      showError('Incorrect password. Please try again.');
      btnSubmit.disabled = false;
      btnSubmit.textContent = 'Unlock';
    }
  } catch {
    showError('Could not reach the extension. Try reloading.');
    btnSubmit.disabled = false;
    btnSubmit.textContent = 'Unlock';
  }
}

btnSubmit.addEventListener('click', tryUnlock);
btnBack.addEventListener('click', () => history.back());

pwInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') tryUnlock();
});

pwInput.focus();
