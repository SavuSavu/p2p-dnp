export function normalizeName(value) {
  const name = String(value ?? '').trim();
  if (name.length < 1 || name.length > 16) throw new Error('Name must be 1–16 characters');
  if (/[<>\u0000-\u001f\u007f]/u.test(name)) throw new Error('Name must be plain text');
  return name;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createRoomCode(random = Math.random) {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)]).join('');
}

export function normalizeRoomCode(value) {
  const code = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length !== 6) throw new Error('Room code must be six characters');
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(code)) throw new Error('Room code contains invalid characters');
  return code;
}

const SLOT_ORDER = [
  ['left', 'left'], ['right', 'right'], ['left', 'top'],
  ['right', 'top'], ['left', 'bottom'], ['right', 'bottom']
];

export function buildRosterLayout(names) {
  if (names.length > 12) throw new Error('Rooms support at most 12 players');
  const splitActive = names.length > 6;
  return names.map((name, index) => {
    const base = index % 6;
    const [team, edge] = SLOT_ORDER[base];
    return { id: index, name: normalizeName(name), team, edge, split: index < 6 ? 0 : 1, splitActive };
  });
}
