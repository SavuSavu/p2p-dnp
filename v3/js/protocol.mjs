import { clamp, clampInput, sanitizeName } from './core.mjs';

const peerId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(value) ? value : null;
const score = value => Array.isArray(value) && value.length === 2 && value.every(n => Number.isInteger(n) && n >= 0 && n <= 999) ? [...value] : null;

export function validatePeerMessage(raw) {
  if (!raw || raw.v !== 1 || typeof raw.type !== 'string') return null;
  if (raw.type === 'input') {
    const id = peerId(raw.peerId); const input = clampInput(raw);
    return id && input ? { v: 1, type: 'input', peerId: id, ...input } : null;
  }
  if (raw.type === 'hello') {
    const id = peerId(raw.peerId); const name = sanitizeName(raw.name);
    return id && name ? { v: 1, type: 'hello', peerId: id, name } : null;
  }
  if (raw.type === 'snapshot') {
    const hostId = peerId(raw.hostId); const points = score(raw.score);
    if (!hostId || !points || !Number.isInteger(raw.tick) || raw.tick < 0 || !raw.ball || !['x','y','vx','vy'].every(k => Number.isFinite(raw.ball[k]))) return null;
    const ball = { x: clamp(raw.ball.x, 0, 1), y: clamp(raw.ball.y, 0, 1), vx: clamp(raw.ball.vx, -3, 3), vy: clamp(raw.ball.vy, -3, 3) };
    const players = Array.isArray(raw.players) ? raw.players.slice(0, 12).map(p => ({ id: peerId(p.id), position: clamp(Number(p.position) || 0, -1, 1) })).filter(p => p.id) : [];
    return { v: 1, type: 'snapshot', tick: raw.tick, hostId, ball, score: points, players };
  }
  return null;
}

export function electHost(peers) {
  return peers.filter(p => p?.connected && peerId(p.id)).map(p => p.id).sort()[0] ?? null;
}

export class RoomState {
  constructor(peers = [], hostId = null) { this.peers = peers.map(p => ({ ...p })); this.hostId = hostId; this.migration = null; }
  disconnect(id, tick) {
    const peer = this.peers.find(p => p.id === id); if (peer) peer.connected = false;
    if (id === this.hostId) { const from = this.hostId; this.hostId = electHost(this.peers); this.migration = { from, to: this.hostId, tick }; }
  }
}

export function makeSnapshot(state) {
  return validatePeerMessage({
    v: 1, type: 'snapshot', tick: state.tick, hostId: state.hostId, ball: state.ball,
    score: state.score, players: (state.players || []).map(p => ({ id: p.id, position: p.position }))
  });
}
