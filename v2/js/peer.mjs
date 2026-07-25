function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64url');
  let s = ''; bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
function base64ToBytes(value) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64url'));
  const s = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
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

export function createPeerSession({ initiator, onStatus = () => {}, onMessage = () => {} }) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  let channel;
  const ready = () => channel && channel.readyState === 'open';
  const attach = dc => {
    channel = dc;
    dc.onopen = () => onStatus('connected');
    dc.onclose = () => onStatus('disconnected');
    dc.onmessage = event => { try { onMessage(validatePeerMessage(JSON.parse(event.data))); } catch { onStatus('ignored invalid packet'); } };
  };
  if (initiator) attach(pc.createDataChannel('dnp', { ordered: true }));
  pc.ondatachannel = e => attach(e.channel);
  pc.onconnectionstatechange = () => onStatus(pc.connectionState);
  const awaitIce = () => new Promise(resolve => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 4000);
  });
  return {
    async createOffer() { await pc.setLocalDescription(await pc.createOffer()); await awaitIce(); return encodeSignal(pc.localDescription); },
    async acceptOffer(encoded) { await pc.setRemoteDescription(decodeSignal(encoded)); await pc.setLocalDescription(await pc.createAnswer()); await awaitIce(); return encodeSignal(pc.localDescription); },
    async acceptAnswer(encoded) { await pc.setRemoteDescription(decodeSignal(encoded)); },
    send(message) { if (ready()) channel.send(JSON.stringify(message)); },
    ready,
    close() { pc.close(); }
  };
}
