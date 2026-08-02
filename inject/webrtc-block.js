// inject/webrtc-block.js
// Derived from WebRTCControl-1.2.0 inject-webrtc-block.js
// Injected into MAIN world at document_start when full WebRTC blocking is active.
// Overrides RTCPeerConnection so all WebRTC connections throw immediately.
(() => {
  const BLOCKED_ERROR = () => { throw new Error('WebRTC blocked by Captain'); };
  const BLOCKED_PROMISE = () => Promise.reject(new Error('WebRTC blocked by Captain'));

  ['RTCPeerConnection', 'webkitRTCPeerConnection'].forEach(name => {
    const original = self[name];
    if (!original) return;

    // Save original prototype BEFORE replacing self[name]
    const originalProto = original.prototype;

    const blocked = function () { BLOCKED_ERROR(); };
    try { Object.defineProperty(blocked, 'name', { value: original.name }); } catch {}
    try { Object.defineProperty(blocked, 'length', { value: original.length }); } catch {}
    try { Object.setPrototypeOf(blocked, Object.getPrototypeOf(original)); } catch {}
    try { Object.defineProperty(self, name, { configurable: false, writable: false, value: blocked }); }
    catch { self[name] = blocked; }

    // Block prototype methods on the ORIGINAL prototype
    if (originalProto) {
      for (const method of ['createDataChannel','addIceCandidate','setLocalDescription','setRemoteDescription','createOffer','createAnswer']) {
        if (originalProto[method]) {
          try { Object.defineProperty(originalProto, method, { value: BLOCKED_ERROR }); } catch {}
        }
      }
    }
  });

  // Block getUserMedia
  try {
    if (navigator?.mediaDevices?.getUserMedia) {
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
        value: BLOCKED_PROMISE,
      });
    }
  } catch {}
  try {
    if (typeof navigator.getUserMedia === 'function') {
      navigator.getUserMedia = BLOCKED_ERROR;
    }
  } catch {}
})();
