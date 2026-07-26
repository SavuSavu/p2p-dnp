import { clamp, sanitizeName } from './core.mjs';

export const PROTOCOL_VERSION = 3;
export const MAX_PACKET_BYTES = 4096;
const ROOM_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const encoder = new TextEncoder();
const validId = value => typeof value === 'string' && ID_RE.test(value) ? value : null;
const validRoom = value => typeof value === 'string' && ROOM_RE.test(value) ? value : null;
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min ? value : null;
const parsePlayers = (players, withNames) => {
  if (!Array.isArray(players) || players.length < 1 || players.length > 2) return null;
  const clean = [];
  for (const player of players) {
    const id = validId(player?.id);
    if (!id || clean.some(p => p.id === id)) return null;
    if (withNames) {
      const name = sanitizeName(player.name);
      if (!name || !['left', 'right'].includes(player.side)) return null;
      clean.push({ id, name, side: player.side });
    } else {
      if (!Number.isFinite(player.position)) return null;
      clean.push({ id, position: clamp(player.position, -1, 1) });
    }
  }
  return clean;
};

export function parseProtocolMessage(raw) {
  if (typeof raw !== 'string' || encoder.encode(raw).byteLength > MAX_PACKET_BYTES) return null;
  let message;
  try { message = JSON.parse(raw); } catch { return null; }
  if (!message || message.v !== PROTOCOL_VERSION || !validRoom(message.room) || !validId(message.peerId ?? message.authorityId) || integer(message.epoch, 1) === null || integer(message.seq) === null) return null;
  const base = { v: PROTOCOL_VERSION, type: message.type, room: message.room, epoch: message.epoch };
  if (message.type === 'hello') {
    const name = sanitizeName(message.name);
    return name ? { ...base, peerId: message.peerId, name, seq: message.seq } : null;
  }
  if (message.type === 'input') {
    if (!Number.isFinite(message.axis)) return null;
    return { ...base, peerId: message.peerId, seq: message.seq, axis: clamp(message.axis, -1, 1) };
  }
  if (message.type === 'room') {
    const players = parsePlayers(message.players, true);
    return players ? { ...base, authorityId: message.authorityId, seq: message.seq, players } : null;
  }
  if (message.type === 'state') {
    const players = parsePlayers(message.players, false);
    const b = message.ball;
    if (!players || integer(message.tick) === null || !b || !['x', 'y', 'vx', 'vy'].every(k => Number.isFinite(b[k])) || !Array.isArray(message.score) || message.score.length !== 2 || !message.score.every(n => Number.isInteger(n) && n >= 0 && n <= 999)) return null;
    return { ...base, authorityId: message.authorityId, seq: message.seq, tick: message.tick,
      ball: { x: clamp(b.x, 0, 1), y: clamp(b.y, 0, 1), vx: clamp(b.vx, -3, 3), vy: clamp(b.vy, -3, 3) },
      score: [...message.score], players };
  }
  return null;
}

export function createHostSession({ room, hostId, hostName, now = 0, rateLimit = 90, packetLimit = 180 }) {
  return { role: 'host', room, epoch: 1, authorityId: hostId, localId: hostId, localName: hostName,
    players: [{ id: hostId, name: hostName, side: 'left' }], channels: {}, outgoingSeq: 0, rateLimit, packetLimit,
    health: { status: 'waiting', lastPacketAt: now, lastSnapshotAt: 0, rejected: 0, lastDisconnectReason: null } };
}
export function createGuestSession({ room, guestId, guestName }) {
  return { role: 'guest', room, epoch: 1, localId: guestId, localName: guestName, authorityId: null, hostChannelId: null,
    players: [], lastSeq: -1, health: { status: 'connecting', lastPacketAt: 0, lastSnapshotAt: 0, rejected: 0, lastDisconnectReason: null } };
}
const reject = (session, reason, closeChannel = false) => ({ session: { ...session, health: { ...session.health, rejected: session.health.rejected + 1,
  lastDisconnectReason: closeChannel ? reason : session.health.lastDisconnectReason } }, accepted: false, reason, closeChannel, effects: {} });

export function transitionHost(session, channelId, raw, now) {
  const channels = { ...session.channels };
  const current = channels[channelId] || { peerId: null, lastSeq: -1, rateWindow: [], packetWindow: [] };
  const packetWindow = (current.packetWindow || []).filter(t => now - t < 1000);
  if (packetWindow.length >= session.packetLimit) return reject({ ...session, channels }, 'packet-budget-exceeded', true);
  channels[channelId] = { ...current, packetWindow: [...packetWindow, now] };
  session = { ...session, channels };
  const msg = parseProtocolMessage(raw);
  if (!msg || msg.room !== session.room || msg.epoch !== session.epoch) return reject(session, 'invalid-packet');
  const existing = channels[channelId];
  if (msg.type === 'hello') {
    if (existing.peerId && existing.peerId !== msg.peerId) return reject(session, 'identity-change', true);
    if (existing.peerId) return reject(session, 'hello-already-bound');
    if (session.players.some(p => p.id === msg.peerId)) return reject(session, 'duplicate-identity', true);
    if (session.players.length >= 2) return reject(session, 'room-full', true);
    channels[channelId] = { ...existing, peerId: msg.peerId };
    const players = session.players.some(p => p.id === msg.peerId) ? session.players : [...session.players, { id: msg.peerId, name: msg.name, side: 'right' }];
    return { session: { ...session, channels, players, health: { ...session.health, status: 'connected', lastPacketAt: now } }, accepted: true, effects: { broadcastRoom: true } };
  }
  if (msg.type !== 'input' || !existing || existing.peerId !== msg.peerId) return reject(session, 'unbound-identity', true);
  if (msg.seq <= existing.lastSeq) return reject(session, 'replay');
  const rateWindow = existing.rateWindow.filter(t => now - t < 1000);
  if (rateWindow.length >= session.rateLimit) return reject(session, 'rate-limit', true);
  channels[channelId] = { ...existing, lastSeq: msg.seq, rateWindow: [...rateWindow, now] };
  return { session: { ...session, channels, health: { ...session.health, lastPacketAt: now } }, accepted: true, message: msg, effects: { applyInput: true } };
}

export function transitionGuest(session, channelId, raw, now) {
  const msg = parseProtocolMessage(raw);
  if (!msg || msg.room !== session.room) return reject(session, 'invalid-packet');
  if (msg.type === 'hello' && session.authorityId === null) {
    return { session: { ...session, authorityId: msg.peerId, hostChannelId: channelId, epoch: msg.epoch, health: { ...session.health, status: 'connected', lastPacketAt: now } }, accepted: true, effects: {} };
  }
  if (!session.authorityId || channelId !== session.hostChannelId || msg.authorityId !== session.authorityId || msg.epoch !== session.epoch || !['room', 'state'].includes(msg.type)) return reject(session, 'unauthorized-authority');
  if (msg.seq <= session.lastSeq) return reject(session, 'replay');
  return { session: { ...session, lastSeq: msg.seq, players: msg.type === 'room' ? msg.players : session.players,
    health: { ...session.health, lastPacketAt: now, lastSnapshotAt: msg.type === 'state' ? now : session.health.lastSnapshotAt } }, accepted: true, message: msg, effects: {} };
}

export function updateGuestSnapshotHealth(session, now, channelOpen, staleAfterMs = 1000, disconnectAfterMs = 3000) {
  const snapshotAgeMs = session.health.lastSnapshotAt > 0 ? Math.max(0, now - session.health.lastSnapshotAt) : null;
  let status = session.health.status;
  let lastDisconnectReason = session.health.lastDisconnectReason;
  if (!channelOpen) status = 'disconnected';
  else if (snapshotAgeMs !== null && snapshotAgeMs >= disconnectAfterMs) { status = 'disconnected'; lastDisconnectReason = 'snapshot-timeout'; }
  else if (snapshotAgeMs !== null && snapshotAgeMs >= staleAfterMs) status = 'stale';
  else if (snapshotAgeMs !== null) status = 'healthy';
  return { session: { ...session, health: { ...session.health, status, lastDisconnectReason } }, snapshotAgeMs };
}

export function disconnectHostChannel(session, channelId, now) {
  const bound = session.channels[channelId];
  if (!bound) return { session, effects: {} };
  const channels = { ...session.channels }; delete channels[channelId];
  return { session: { ...session, channels, players: session.players.filter(p => p.id !== bound.peerId),
    health: { ...session.health, status: 'waiting', lastPacketAt: now, lastDisconnectReason: 'channel-closed' } }, effects: { broadcastRoom: true } };
}

export function makeHello(session) { return JSON.stringify({ v: 3, type: 'hello', room: session.room, epoch: session.epoch, peerId: session.localId, name: session.localName, seq: 0 }); }
export function makeInput(session, axis, seq) { return JSON.stringify({ v: 3, type: 'input', room: session.room, epoch: session.epoch, peerId: session.localId, axis, seq }); }
export function makeRoom(session, seq) { return JSON.stringify({ v: 3, type: 'room', room: session.room, epoch: session.epoch, authorityId: session.authorityId, seq, players: session.players }); }
export function makeState(session, game, seq) { return JSON.stringify({ v: 3, type: 'state', room: session.room, epoch: session.epoch, authorityId: session.authorityId, seq, tick: game.tick, ball: game.ball, score: game.score, players: game.players.map(p => ({ id: p.id, position: p.position })) }); }
