function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
  let value = '';
  bytes.forEach(byte => { value += String.fromCharCode(byte); });
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64ToBytes(value) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64url'));
  const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

export const encodeSignal = data => bytesToBase64(new TextEncoder().encode(JSON.stringify(data)));
export const decodeSignal = value => JSON.parse(new TextDecoder().decode(base64ToBytes(String(value).trim())));

export function validatePeerMessage(message) {
  if (!message || typeof message !== 'object') throw new Error('invalid peer message');
  if (message.type === 'input' && Number.isFinite(message.value) && message.value >= -1 && message.value <= 1 && Number.isSafeInteger(message.seq) && message.seq >= 0) {
    return { type: 'input', value: message.value, seq: message.seq };
  }
  if (message.type === 'hello' && typeof message.name === 'string' && message.name.length >= 1 && message.name.length <= 16) return { type: 'hello', name: message.name };
  if (message.type === 'snapshot' && message.state && typeof message.state === 'object') return message;
  throw new Error('invalid peer message');
}

export const electHost = ids => ids.length ? [...ids].sort()[0] : null;

function requireLocalDescription(pc) {
  const description = pc.localDescription;
  if (!description || typeof description.type !== 'string' || typeof description.sdp !== 'string' || !description.sdp.trim()) {
    throw new Error('no local session description was produced; reset and retry signaling');
  }
  return { type: description.type, sdp: description.sdp };
}

export function gatherLocalDescription(pc, {
  timeoutMs = 4000,
  isCurrent = () => true,
  signal,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      pc.removeEventListener('icecandidate', onCandidate);
      pc.removeEventListener('icegatheringstatechange', onGatheringStateChange);
      signal?.removeEventListener('abort', onAbort);
      if (timer !== undefined) clearTimer(timer);
    };
    const finish = status => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!isCurrent()) return reject(new Error('signaling attempt was reset; generate a fresh signal'));
      try { resolve({ status, description: requireLocalDescription(pc) }); }
      catch (error) { reject(error); }
    };
    const onCandidate = event => {
      if (!isCurrent()) return finish('complete');
      if (event.candidate === null) finish('complete');
    };
    const onGatheringStateChange = () => {
      if (!isCurrent() || pc.iceGatheringState === 'complete') finish('complete');
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('signaling attempt was reset; generate a fresh signal'));
    };
    pc.addEventListener('icecandidate', onCandidate);
    pc.addEventListener('icegatheringstatechange', onGatheringStateChange);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    if (pc.iceGatheringState === 'complete') return finish('complete');
    timer = setTimer(() => finish('partial'), timeoutMs);
  });
}

export function createPeerSession({ initiator, onStatus = () => {}, onOpen = () => {}, onRawMessage = () => {}, onClose = () => {} }) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const channelId = globalThis.crypto?.randomUUID?.() || `channel-${Date.now()}-${Math.random()}`;
  let channel;
  let closed = false;
  let signalingAttempt = 0;
  let gatherController = null;
  const ready = () => channel?.readyState === 'open';
  const reportClose = () => {
    if (closed) return;
    closed = true;
    onStatus('disconnected');
    onClose(channelId);
  };
  const attach = dataChannel => {
    channel = dataChannel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => { if (!closed) { onStatus('connected'); onOpen(channelId); } };
    channel.onclose = reportClose;
    channel.onerror = () => { if (!closed) onStatus('channel error'); };
    channel.onmessage = event => {
      if (closed) return;
      if (typeof event.data !== 'string') return onStatus('ignored invalid packet');
      onRawMessage(event.data, channelId);
    };
  };
  if (initiator) attach(pc.createDataChannel('dnp-v2', { ordered: true }));
  pc.ondatachannel = event => attach(event.channel);
  pc.onconnectionstatechange = () => {
    if (closed) return;
    onStatus(pc.connectionState);
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) reportClose();
  };
  const gather = attempt => {
    gatherController?.abort();
    gatherController = new AbortController();
    return gatherLocalDescription(pc, {
    timeoutMs: Number.isFinite(globalThis.__dnpIceGatherTimeoutMs) ? globalThis.__dnpIceGatherTimeoutMs : 4000,
    isCurrent: () => !closed && attempt === signalingAttempt,
    signal: gatherController.signal
    });
  };
  return {
    channelId,
    async createOffer() {
      const attempt = ++signalingAttempt;
      await pc.setLocalDescription(await pc.createOffer());
      const gathering = await gather(attempt);
      return { signal: encodeSignal(gathering.description), gathering: gathering.status };
    },
    async acceptOffer(encoded) {
      const attempt = ++signalingAttempt;
      await pc.setRemoteDescription(decodeSignal(encoded));
      await pc.setLocalDescription(await pc.createAnswer());
      const gathering = await gather(attempt);
      return { signal: encodeSignal(gathering.description), gathering: gathering.status };
    },
    async acceptAnswer(encoded) { await pc.setRemoteDescription(decodeSignal(encoded)); },
    send(message) {
      if (!ready()) return false;
      channel.send(typeof message === 'string' ? message : JSON.stringify(message));
      return true;
    },
    ready,
    close() {
      signalingAttempt += 1;
      gatherController?.abort();
      try { channel?.close(); } catch {}
      pc.close();
      reportClose();
    }
  };
}
