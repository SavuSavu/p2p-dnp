import { isRoomCode, sanitizeName } from './model.js';

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 16 * 1024;

function sanitizePeerId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid peer id');
  return id;
}

function sanitizeCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  if (!isRoomCode(code)) throw new Error('Invalid room code');
  return code;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function sanitizeRoom(value, expectedCode) {
  if (!value || value.code !== expectedCode || !Array.isArray(value.players) || !Array.isArray(value.assignments)) {
    throw new Error('Invalid room');
  }
  if (value.players.length < 1 || value.players.length > 2 || value.assignments.length !== value.players.length) {
    throw new Error('Invalid room');
  }
  const players = value.players.map((player) => ({ id: sanitizePeerId(player?.id), name: sanitizeName(player?.name) }));
  const ids = new Set(players.map((player) => player.id));
  if (ids.size !== players.length) throw new Error('Invalid room');
  const assignments = value.assignments.map((assignment) => {
    const id = sanitizePeerId(assignment?.id);
    if (!ids.has(id) || !['left', 'right'].includes(assignment.team) || assignment.edge !== 'side' || assignment.half !== 0) {
      throw new Error('Invalid room');
    }
    return {
      id,
      name: sanitizeName(assignment.name),
      team: assignment.team,
      edge: 'side',
      half: 0,
      input: clamp(Number.isFinite(assignment.input) ? assignment.input : 0.5)
    };
  });
  const assignmentIds = new Set(assignments.map((assignment) => assignment.id));
  if (assignmentIds.size !== assignments.length || assignmentIds.size !== ids.size) throw new Error('Invalid room');
  const adminId = sanitizePeerId(value.adminId);
  if (!ids.has(adminId)) throw new Error('Invalid room');
  return { code: expectedCode, adminId, players, assignments };
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function sanitizeState(packet, code) {
  const ball = packet.snapshot?.ball;
  const score = packet.snapshot?.score;
  if (!ball || !score || !Number.isSafeInteger(packet.seq) || packet.seq < 0 ||
      !Array.isArray(packet.inputs) || packet.inputs.length > 2) throw new Error('Invalid state');
  return {
    v: PROTOCOL_VERSION,
    type: 'state',
    code,
    peerId: sanitizePeerId(packet.peerId),
    seq: packet.seq,
    snapshot: {
      ball: {
        x: clamp(finite(ball.x, 'state'), 0, 900),
        y: clamp(finite(ball.y, 'state'), 0, 600),
        vx: clamp(finite(ball.vx, 'state'), -2000, 2000),
        vy: clamp(finite(ball.vy, 'state'), -2000, 2000)
      },
      score: {
        left: clamp(Math.floor(finite(score.left, 'score')), 0, 99),
        right: clamp(Math.floor(finite(score.right, 'score')), 0, 99)
      }
    },
    inputs: packet.inputs.map((input) => ({
      id: sanitizePeerId(input?.id),
      input: clamp(finite(input?.input, 'input'))
    }))
  };
}

export function parseProtocolMessage(raw) {
  if (typeof raw !== 'string') throw new Error('Invalid message');
  if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) throw new Error('Message too large');
  let packet;
  try { packet = JSON.parse(raw); } catch { throw new Error('Invalid message'); }
  if (!packet || packet.v !== PROTOCOL_VERSION) throw new Error('Unsupported protocol version');
  const code = sanitizeCode(packet.code);
  if (packet.type === 'hello') return {
    v: PROTOCOL_VERSION,
    type: 'hello',
    code,
    peer: { id: sanitizePeerId(packet.peer?.id), name: sanitizeName(packet.peer?.name) }
  };
  if (packet.type === 'room') return {
    v: PROTOCOL_VERSION,
    type: 'room',
    code,
    peerId: sanitizePeerId(packet.peerId),
    room: sanitizeRoom(packet.room, code)
  };
  if (packet.type === 'state') return sanitizeState(packet, code);
  if (packet.type === 'input') {
    if (!Number.isSafeInteger(packet.seq) || packet.seq < 0) throw new Error('Invalid input');
    return {
      v: PROTOCOL_VERSION,
      type: 'input',
      code,
      peerId: sanitizePeerId(packet.peerId),
      seq: packet.seq,
      value: clamp(finite(packet.value, 'input'))
    };
  }
  throw new Error('Unsupported message type');
}
