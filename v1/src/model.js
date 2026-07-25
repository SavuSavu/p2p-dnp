const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SLOT_ORDER = ['side', 'top', 'bottom'];

export function sanitizeName(value) {
  const name = String(value ?? '').trim();
  if (name.length < 1 || name.length > 16) throw new Error('Name must be 1-16 characters');
  if (/[<>\u0000-\u001f\u007f]/u.test(name)) throw new Error('Name must be plain text');
  return name;
}

export function generateRoomCode(random = Math.random) {
  return Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(random() * CODE_CHARS.length)]).join('');
}

export function isRoomCode(value) {
  return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(String(value ?? '').toUpperCase());
}

export function assignPlayers(players) {
  return players.slice(0, 12).map((player, index) => ({
    ...player,
    team: index % 2 === 0 ? 'left' : 'right',
    edge: SLOT_ORDER[Math.floor(index / 2) % 3],
    half: index < 6 ? 0 : 1
  }));
}

export function electAdmin(players) {
  return players.map((p) => p.id).sort((a, b) => a.localeCompare(b))[0] ?? null;
}

function normalizeRoom(room) {
  const players = room.players.slice(0, 12);
  return { ...room, players, assignments: assignPlayers(players) };
}

export function createRoom(code, creator) {
  if (!isRoomCode(code)) throw new Error('Invalid room code');
  const player = { id: String(creator.id), name: sanitizeName(creator.name) };
  return normalizeRoom({ code, adminId: player.id, createdAt: Date.now(), players: [player] });
}

export function addPlayer(room, player) {
  if (room.players.length >= 12) throw new Error('Room is full');
  if (room.players.some((p) => p.id === player.id)) return room;
  return normalizeRoom({ ...room, players: [...room.players, { id: String(player.id), name: sanitizeName(player.name) }] });
}

export function removePlayer(room, peerId) {
  const players = room.players.filter((p) => p.id !== peerId);
  const adminId = room.adminId === peerId ? electAdmin(players) : room.adminId;
  return normalizeRoom({ ...room, players, adminId });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function layoutForAssignment(assignment, width, height, input = 0.5, splitActive = false) {
  const t = clamp(Number(input) || 0, 0, 1);
  const split = splitActive;
  if (assignment.edge === 'side') {
    const h = split ? height * 0.18 : height * 0.28;
    const w = 16;
    const zoneStart = split ? assignment.half * height / 2 : 0;
    const zoneSize = split ? height / 2 : height;
    return {
      axis: 'y', x: assignment.team === 'left' ? 24 : width - 24 - w,
      y: zoneStart + t * Math.max(0, zoneSize - h), w, h
    };
  }
  const teamStart = assignment.team === 'left' ? 0 : width / 2;
  const teamWidth = width / 2;
  const zoneWidth = split ? teamWidth / 2 : teamWidth;
  const zoneStart = teamStart + (split ? assignment.half * zoneWidth : 0);
  const w = split ? zoneWidth * 0.22 : zoneWidth * 0.34;
  const h = 16;
  return {
    axis: 'x', x: zoneStart + t * Math.max(0, zoneWidth - w),
    y: assignment.edge === 'top' ? 24 : height - 24 - h, w, h
  };
}

export function validateMessage(packet) {
  if (!packet || packet.type !== 'input') throw new Error('unsupported message');
  if (typeof packet.peerId !== 'string' || !packet.peerId || !Number.isInteger(packet.seq) || packet.seq < 0 || !Number.isFinite(packet.value)) {
    throw new Error('invalid input message');
  }
  return { type: 'input', peerId: packet.peerId, seq: packet.seq, value: clamp(packet.value, 0, 1) };
}
