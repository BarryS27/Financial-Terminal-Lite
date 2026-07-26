const params   = new URLSearchParams(location.search);
const blockedURL = params.get('url') ? decodeURIComponent(params.get('url')) : '';
const blockedSet = params.get('set') || '1';

chrome.runtime.sendMessage({ type: 'fg:blocked', set: blockedSet }).then(info => {
  const delaySecs = info?.delaySecs ? +info.delaySecs : 60;
  startCountdown(delaySecs);
}).catch(() => startCountdown(60));

let timer;
function startCountdown(total) {
  let remaining = total;
  const cd = document.getElementById('countdown');
  const pb = document.getElementById('progress');
  cd.textContent = remaining;
  pb.style.width = '100%';

  timer = setInterval(() => {
    remaining--;
    cd.textContent = remaining;
    pb.style.width = (remaining / total * 100) + '%';
    if (remaining <= 0) {
      clearInterval(timer);
      pb.style.width = '0%';
      cd.textContent = '✓';
      chrome.runtime.sendMessage({ type: 'fg:delayed', blockedURL, blockedSet });
    }
  }, 1000);
}

document.getElementById('btn-back').addEventListener('click', () => {
  clearInterval(timer);
  history.back();
});
document.getElementById('btn-cancel').addEventListener('click', () => {
  clearInterval(timer);
  chrome.runtime.sendMessage({ type: 'fg:close' });
});

window.addEventListener('pagehide', () => { clearInterval(timer); timer = null; });
window.addEventListener('beforeunload', () => { clearInterval(timer); timer = null; });
