export const EDGES = ['left', 'right', 'top', 'top', 'bottom', 'bottom'];
export const TEAMS = ['left', 'right', 'left', 'right', 'left', 'right'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function sanitizeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length >= 1 && name.length <= 16 && !/[<>\u0000-\u001f\u007f]/u.test(name) ? name : null;
}

export function createRoomCode(random = Math.random) {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[Math.min(CODE_ALPHABET.length - 1, Math.floor(random() * CODE_ALPHABET.length))]).join('');
}

export function assignPlayers(players) {
  const splitActive = players.length > 6;
  return players.slice(0, 12).map((player, index) => {
    const slot = index % 6;
    return { ...player, slot, split: index < 6 ? 0 : 1, splitActive, edge: EDGES[slot], team: TEAMS[slot] };
  });
}

export function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

export function paddleRect(player, width, height, inset = 10) {
  const pos = clamp(Number(player.position) || 0, -1, 1);
  const splitActive = player.splitActive === true;
  if (player.edge === 'left' || player.edge === 'right') {
    const segmentH = splitActive ? height / 2 : height;
    const baseY = splitActive ? player.split * segmentH : 0;
    const h = Math.min(120, segmentH * 0.36);
    const y = baseY + inset + ((pos + 1) / 2) * Math.max(0, segmentH - h - inset * 2);
    return { x: player.edge === 'left' ? inset : width - inset - 16, y, w: 16, h };
  }
  const halfStart = player.team === 'left' ? 0 : width / 2;
  const segmentW = splitActive ? width / 4 : width / 2;
  const baseX = halfStart + (splitActive ? player.split * segmentW : 0);
  const w = Math.min(150, segmentW * (splitActive ? 0.28 : 0.42));
  const x = baseX + inset + ((pos + 1) / 2) * Math.max(0, segmentW - w - inset * 2);
  return { x, y: player.edge === 'top' ? inset : height - inset - 16, w, h: 16 };
}

export function clampInput(message) {
  if (!message || !Number.isFinite(message.axis) || !Number.isInteger(message.seq) || message.seq < 0) return null;
  return { axis: clamp(message.axis, -1, 1), seq: message.seq };
}
