export const PROTOCOL_VERSION = 2;
export const MAX_PACKET_BYTES = 16 * 1024;
const MAX_INPUTS_PER_SECOND = 30;
const MAX_STATES_PER_SECOND = 60;
const encoder = new TextEncoder();

const fail = (message = 'invalid peer packet') => { throw new Error(message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,48}$/.test(value);
const isRoom = value => typeof value === 'string' && /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(value);
const isName = value => typeof value === 'string' && value.length >= 1 && value.length <= 16 && !/[<>\u0000-\u001f\u007f]/u.test(value);
const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const sequence = value => Number.isSafeInteger(value) && value >= 0;

function sanitizePeer(peer) {
  if (!isObject(peer) || !isId(peer.id) || !isName(peer.name)) fail();
  return { id: peer.id, name: peer.name };
}

function sanitizeAssignment(value, playerIds) {
  if (!isObject(value) || !isId(value.id) || !playerIds.has(value.id) ||
      !Number.isSafeInteger(value.playerIndex) || value.playerIndex < 0 || value.playerIndex > 1 ||
      !['left', 'right'].includes(value.team) || value.edge !== value.team || !finite(value.input, -1, 1)) fail();
  return { id: value.id, playerIndex: value.playerIndex, team: value.team, edge: value.edge, input: value.input };
}

function sanitizeRoom(value, expectedCode) {
  if (!isObject(value) || value.code !== expectedCode || !isId(value.adminId) ||
      !Array.isArray(value.players) || value.players.length < 1 || value.players.length > 2 ||
      !Array.isArray(value.assignments) || value.assignments.length !== value.players.length) fail();
  const players = value.players.map(sanitizePeer);
  const ids = new Set(players.map(player => player.id));
  if (ids.size !== players.length || !ids.has(value.adminId)) fail();
  const assignments = value.assignments.map(item => sanitizeAssignment(item, ids));
  if (new Set(assignments.map(item => item.id)).size !== assignments.length ||
      new Set(assignments.map(item => item.playerIndex)).size !== assignments.length) fail();
  assignments.forEach(item => {
    const expected = item.playerIndex === 0 ? 'left' : 'right';
    if (item.team !== expected || players[item.playerIndex]?.id !== item.id) fail();
  });
  return { code: value.code, adminId: value.adminId, players, assignments };
}

function sanitizeGamePlayer(value, index) {
  if (!isObject(value) || value.id !== index || !isName(value.name) ||
      value.team !== (index === 0 ? 'left' : 'right') || value.edge !== value.team ||
      value.split !== 0 || value.splitActive !== false || !finite(value.position, .1, .9) ||
      !finite(value.input, -1, 1) || typeof value.ai !== 'boolean') fail();
  return { id: value.id, name: value.name, team: value.team, edge: value.edge, split: 0, splitActive: false, position: value.position, input: value.input, ai: value.ai };
}

function sanitizeGame(value) {
  if (!isObject(value) || !Array.isArray(value.players) || value.players.length < 1 || value.players.length > 2 ||
      !isObject(value.ball) || !Array.isArray(value.score) || value.score.length !== 2 ||
      !Number.isSafeInteger(value.rally) || value.rally < 0 || ![null, 0, 1].includes(value.winner)) fail();
  const players = value.players.map(sanitizeGamePlayer);
  const ball = value.ball;
  if (!finite(ball.x, -.1, 1.1) || !finite(ball.y, 0, 1) || !finite(ball.vx, -1.2, 1.2) ||
      !finite(ball.vy, -1.2, 1.2) || !finite(ball.r, .005, .05) ||
      value.score.some(score => !Number.isSafeInteger(score) || score < 0 || score > 99)) fail();
  return {
    players,
    ball: { x: ball.x, y: ball.y, vx: ball.vx, vy: ball.vy, r: ball.r },
    score: [value.score[0], value.score[1]], rally: value.rally, winner: value.winner
  };
}

export function parseProtocolMessage(raw) {
  if (typeof raw !== 'string') fail();
  if (encoder.encode(raw).byteLength > MAX_PACKET_BYTES) fail('peer packet too large');
  let message;
  try { message = JSON.parse(raw); } catch { fail(); }
  if (!isObject(message)) fail();
  if (message.v !== PROTOCOL_VERSION) fail('invalid protocol version');
  if (!isRoom(message.room)) fail();
  if (message.type === 'hello') return { v: 2, type: 'hello', room: message.room, peer: sanitizePeer(message.peer) };
  if (!isId(message.peerId)) fail();
  if (message.type === 'input') {
    if (!finite(message.value, -1, 1) || !sequence(message.seq)) fail();
    return { v: 2, type: 'input', room: message.room, peerId: message.peerId, value: message.value, seq: message.seq };
  }
  if (message.type === 'room') {
    return { v: 2, type: 'room', room: message.room, peerId: message.peerId, data: sanitizeRoom(message.data, message.room) };
  }
  if (message.type === 'state') {
    if (!sequence(message.seq)) fail();
    return { v: 2, type: 'state', room: message.room, peerId: message.peerId, seq: message.seq, state: sanitizeGame(message.state) };
  }
  fail();
}

function checked(message) {
  return parseProtocolMessage(JSON.stringify(message));
}

export const makeHello = (room, peer) => checked({ v: 2, type: 'hello', room, peer });
export const makeInput = (room, peerId, value, seq) => checked({ v: 2, type: 'input', room, peerId, value, seq });
export const makeRoom = (room, peerId, data) => {
  const message = checked({ v: 2, type: 'room', room, peerId, data });
  if (message.peerId !== message.data.adminId) fail('invalid room authority');
  return message;
};
export const makeState = (room, peerId, seq, state) => checked({ v: 2, type: 'state', room, peerId, seq, state });
export const serializePacket = message => JSON.stringify(checked(message));

function addGuest(room, peer) {
  const players = [...room.players, peer];
  return {
    ...room,
    players,
    assignments: players.map((player, playerIndex) => ({
      id: player.id, playerIndex, team: playerIndex === 0 ? 'left' : 'right',
      edge: playerIndex === 0 ? 'left' : 'right', input: 0
    }))
  };
}

function removePeer(room, peerId) {
  const players = room.players.filter(player => player.id !== peerId);
  return {
    ...room,
    players,
    assignments: players.map((player, playerIndex) => ({
      id: player.id, playerIndex, team: playerIndex === 0 ? 'left' : 'right',
      edge: playerIndex === 0 ? 'left' : 'right', input: room.assignments.find(item => item.id === player.id)?.input || 0
    }))
  };
}

export function createHostSession(room) {
  return { room: sanitizeRoom(room, room.code), channels: new Map() };
}

export function createGuestSession(code, peer, hostChannelId) {
  if (!isRoom(code) || !hostChannelId) fail();
  return { code, peer: sanitizePeer(peer), hostChannelId, hostPeerId: null, room: null, snapshot: null, lastStateSeq: -1, stateTimes: [] };
}

function parseOrReject(session, raw) {
  try { return { message: parseProtocolMessage(raw) }; }
  catch { return { result: { session, accepted: false, closeChannel: true, reason: 'invalid' } }; }
}

export function receiveHostMessage(session, channelId, raw, now = Date.now()) {
  const parsed = parseOrReject(session, raw);
  if (parsed.result) return parsed.result;
  const message = parsed.message;
  if (message.room !== session.room.code) return { session, accepted: false, closeChannel: true };
  const binding = session.channels.get(channelId);
  if (!binding) {
    if (message.type !== 'hello' || session.room.players.length >= 2 ||
        session.room.players.some(player => player.id === message.peer.id) ||
        [...session.channels.values()].some(item => item.peerId === message.peer.id)) {
      return { session, accepted: false, closeChannel: true };
    }
    const channels = new Map(session.channels);
    channels.set(channelId, { peerId: message.peer.id, lastSeq: -1, inputTimes: [] });
    return { session: { ...session, room: addGuest(session.room, message.peer), channels }, accepted: true, broadcastRoom: true, broadcastState: true };
  }
  const claimed = message.type === 'hello' ? message.peer.id : message.peerId;
  if (claimed !== binding.peerId || message.type === 'hello') return { session, accepted: false, closeChannel: true };
  if (message.type !== 'input') return { session, accepted: false };
  if (message.seq <= binding.lastSeq) return { session, accepted: false, reason: 'sequence' };
  const inputTimes = binding.inputTimes.filter(time => now - time < 1000);
  if (inputTimes.length >= MAX_INPUTS_PER_SECOND) return { session, accepted: false, reason: 'rate' };
  const channels = new Map(session.channels);
  channels.set(channelId, { ...binding, lastSeq: message.seq, inputTimes: [...inputTimes, now] });
  const assignments = session.room.assignments.map(item => item.id === binding.peerId ? { ...item, input: message.value } : item);
  return { session: { ...session, channels, room: { ...session.room, assignments } }, accepted: true };
}

export function receiveGuestMessage(session, channelId, raw, now = Date.now()) {
  if (channelId !== session.hostChannelId) return { session, accepted: false, closeChannel: true };
  const parsed = parseOrReject(session, raw);
  if (parsed.result) return parsed.result;
  const message = parsed.message;
  if (message.room !== session.code || !['hello', 'room', 'state'].includes(message.type)) return { session, accepted: false, closeChannel: true };
  if (message.type === 'hello') {
    if (session.hostPeerId && session.hostPeerId !== message.peer.id) return { session, accepted: false, closeChannel: true };
    return { session: { ...session, hostPeerId: message.peer.id }, accepted: true };
  }
  if (!session.hostPeerId || message.peerId !== session.hostPeerId) return { session, accepted: false, closeChannel: true };
  if (message.type === 'room') {
    if (message.data.adminId !== message.peerId || !message.data.players.some(player => player.id === session.peer.id)) return { session, accepted: false, closeChannel: true };
    return { session: { ...session, room: message.data }, accepted: true };
  }
  if (!session.room) return { session, accepted: false };
  if (message.seq <= session.lastStateSeq) return { session, accepted: false, reason: 'sequence' };
  const stateTimes = session.stateTimes.filter(time => now - time < 1000);
  if (stateTimes.length >= MAX_STATES_PER_SECOND) return { session, accepted: false, reason: 'rate' };
  return { session: { ...session, snapshot: message.state, lastStateSeq: message.seq, stateTimes: [...stateTimes, now] }, accepted: true };
}

export function disconnectHostChannel(session, channelId) {
  const binding = session.channels.get(channelId);
  if (!binding) return { session, broadcastRoom: false };
  const channels = new Map(session.channels);
  channels.delete(channelId);
  return { session: { ...session, channels, room: removePeer(session.room, binding.peerId) }, broadcastRoom: true };
}
