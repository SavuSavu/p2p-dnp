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

export function createPeerSession({ initiator, onStatus = () => {}, onOpen = () => {}, onRawMessage = () => {}, onClose = () => {} }) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const channelId = globalThis.crypto?.randomUUID?.() || `channel-${Date.now()}-${Math.random()}`;
  let channel;
  let closed = false;
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
    channel.onopen = () => { onStatus('connected'); onOpen(channelId); };
    channel.onclose = reportClose;
    channel.onerror = () => onStatus('channel error');
    channel.onmessage = event => {
      if (typeof event.data !== 'string') return onStatus('ignored invalid packet');
      onRawMessage(event.data, channelId);
    };
  };
  if (initiator) attach(pc.createDataChannel('dnp-v2', { ordered: true }));
  pc.ondatachannel = event => attach(event.channel);
  pc.onconnectionstatechange = () => {
    onStatus(pc.connectionState);
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) reportClose();
  };
  const awaitIce = () => new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', done);
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 4000);
  });
  return {
    channelId,
    async createOffer() {
      await pc.setLocalDescription(await pc.createOffer());
      await awaitIce();
      return encodeSignal(pc.localDescription);
    },
    async acceptOffer(encoded) {
      await pc.setRemoteDescription(decodeSignal(encoded));
      await pc.setLocalDescription(await pc.createAnswer());
      await awaitIce();
      return encodeSignal(pc.localDescription);
    },
    async acceptAnswer(encoded) { await pc.setRemoteDescription(decodeSignal(encoded)); },
    send(message) {
      if (!ready()) return false;
      channel.send(typeof message === 'string' ? message : JSON.stringify(message));
      return true;
    },
    ready,
    close() {
      try { channel?.close(); } catch {}
      pc.close();
      reportClose();
    }
  };
}
