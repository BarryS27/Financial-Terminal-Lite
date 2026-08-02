// ticker.js — offscreen document ticker
// Sends fg:tick to the service worker at a configurable interval, but ONLY
// while Focus Guard actually has something to time (active limit sets).
//
// Perf fix: the previous version ran a 1-second setInterval forever,
// unconditionally, waking the service worker every second even with zero
// blocking rules configured — the single biggest source of idle CPU/fan
// noise. The background now tells us whether to run at all (`active`); the
// interval only ticks while there's real work to do.

let gTickerID  = null;
let gTickerSecs = 1;

function startTicking() {
  if (gTickerID) return;
  gTickerID = window.setInterval(onInterval, gTickerSecs * 1000);
}

function stopTicking() {
  if (!gTickerID) return;
  window.clearInterval(gTickerID);
  gTickerID = null;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'fg:ticker-config') return;
  if (message.tickerSecs && message.tickerSecs !== gTickerSecs) {
    gTickerSecs = message.tickerSecs;
    if (gTickerID) { stopTicking(); startTicking(); }
  }
  if (message.active) startTicking(); else stopTicking();
});

function onInterval() {
  chrome.runtime.sendMessage({ type: 'fg:tick' });
}
