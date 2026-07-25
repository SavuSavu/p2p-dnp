function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(text) {
  if (typeof Buffer !== 'undefined') return Uint8Array.from(Buffer.from(text, 'base64'));
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export function encodeSignal(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeSignal(text) {
  if (typeof text !== 'string' || text.length > 100000) throw new Error('Signal too large');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Invalid signal');
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4);
    return JSON.parse(new TextDecoder().decode(base64ToBytes(padded)));
  } catch {
    throw new Error('Invalid signal');
  }
}

export function inviteUrl(base, code) {
  const url = new URL(base);
  url.searchParams.set('join', code);
  return url.toString();
}

export function matchmakingStatus(rendezvousUrl) {
  return rendezvousUrl
    ? 'Public rendezvous configured. Your browser can attempt random peer discovery.'
    : 'Static pages cannot discover random strangers without a rendezvous service. Use a private invite/manual signal instead.';
}
