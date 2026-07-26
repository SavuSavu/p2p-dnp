const DEFAULT_GRACE_MS = 5000;

function hasLocalDescription(pc) {
  return Boolean(pc.localDescription?.type && typeof pc.localDescription?.sdp === 'string' && pc.localDescription.sdp.trim());
}

export function waitForIceGathering(pc, {
  graceMs = DEFAULT_GRACE_MS,
  isCurrent = () => true,
  isComplete = () => pc.iceGatheringState === 'complete',
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  if (!isCurrent()) return Promise.resolve({ stale: true });
  if (isComplete()) {
    if (!hasLocalDescription(pc)) {
      return Promise.reject(new Error('No WebRTC offer was generated. Check browser WebRTC permissions, then use Reset / Retry.'));
    }
    return Promise.resolve({ description: pc.localDescription, completeness: 'complete' });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;

    const cleanup = () => {
      pc.removeEventListener('icecandidate', onIceProgress);
      pc.removeEventListener('icegatheringstatechange', onIceProgress);
      if (timer !== undefined) clearTimer(timer);
    };

    const finish = (source) => {
      if (settled) return;
      if (!isCurrent()) {
        settled = true;
        cleanup();
        resolve({ stale: true });
        return;
      }
      if (source !== 'timeout' && !isComplete()) return;
      settled = true;
      cleanup();
      if (!hasLocalDescription(pc)) {
        reject(new Error('No WebRTC offer was generated. Check browser WebRTC permissions, then use Reset / Retry.'));
        return;
      }
      resolve({
        description: pc.localDescription,
        completeness: isComplete() ? 'complete' : 'partial'
      });
    };

    const onIceProgress = () => finish('event');
    pc.addEventListener('icecandidate', onIceProgress);
    pc.addEventListener('icegatheringstatechange', onIceProgress);
    timer = setTimer(() => finish('timeout'), graceMs);
    finish('event');
  });
}
