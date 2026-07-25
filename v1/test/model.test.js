import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeName,
  generateRoomCode,
  isRoomCode,
  assignPlayers,
  createRoom,
  addPlayer,
  removePlayer,
  electAdmin,
  layoutForAssignment,
  validateMessage
} from '../src/model.js';

test('sanitizeName trims and accepts 1-16 visible characters', () => {
  assert.equal(sanitizeName('  Ada  '), 'Ada');
  assert.equal(sanitizeName('abcdefghijklmnop'), 'abcdefghijklmnop');
  assert.throws(() => sanitizeName('   '), /1-16/);
  assert.throws(() => sanitizeName('abcdefghijklmnopq'), /1-16/);
  assert.throws(() => sanitizeName('<b>Ada</b>'), /plain text/);
});

test('room codes use six unambiguous uppercase characters', () => {
  for (let i = 0; i < 100; i += 1) {
    const code = generateRoomCode();
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    assert.equal(isRoomCode(code), true);
  }
  assert.equal(isRoomCode('ABC'), false);
  assert.equal(isRoomCode('ABC1O0'), false);
});

test('player assignment alternates teams and fills side top bottom then split slots', () => {
  const players = Array.from({ length: 12 }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const assigned = assignPlayers(players);
  assert.deepEqual(assigned.map(({ team, edge, half }) => [team, edge, half]), [
    ['left', 'side', 0], ['right', 'side', 0],
    ['left', 'top', 0], ['right', 'top', 0],
    ['left', 'bottom', 0], ['right', 'bottom', 0],
    ['left', 'side', 1], ['right', 'side', 1],
    ['left', 'top', 1], ['right', 'top', 1],
    ['left', 'bottom', 1], ['right', 'bottom', 1]
  ]);
});

test('room creator is admin, capacity is 12, leave reassigns slots, and admin migrates', () => {
  let room = createRoom('ABC234', { id: 'p2', name: 'Creator' });
  assert.equal(room.adminId, 'p2');
  for (let i = 1; i <= 11; i += 1) room = addPlayer(room, { id: `p${i === 2 ? 20 : i}`, name: `P${i}` });
  assert.equal(room.players.length, 12);
  assert.throws(() => addPlayer(room, { id: 'overflow', name: 'Nope' }), /full/);
  room = removePlayer(room, 'p2');
  assert.equal(room.players.length, 11);
  assert.equal(room.adminId, electAdmin(room.players));
  assert.equal(room.assignments[0].half, 0);
});

test('layouts constrain side movement to Y and horizontal paddles to their team half', () => {
  const side = layoutForAssignment({ team: 'left', edge: 'side', half: 0 }, 900, 600, 0.75);
  assert.equal(side.axis, 'y');
  assert.equal(side.x, 24);
  assert.ok(side.y >= 0 && side.y + side.h <= 600);

  const topLeft = layoutForAssignment({ team: 'left', edge: 'top', half: 0 }, 900, 600, 1);
  const topRightSplit = layoutForAssignment({ team: 'right', edge: 'top', half: 1 }, 900, 600, 0);
  assert.equal(topLeft.axis, 'x');
  assert.ok(topLeft.x + topLeft.w <= 450);
  assert.ok(topRightSplit.x >= 450);

  const sideA = layoutForAssignment({ team: 'left', edge: 'side', half: 0 }, 900, 600, 1, true);
  const sideB = layoutForAssignment({ team: 'left', edge: 'side', half: 1 }, 900, 600, 0, true);
  assert.ok(sideA.y + sideA.h <= 300);
  assert.ok(sideB.y >= 300);

  const horizontalA = layoutForAssignment({ team: 'left', edge: 'top', half: 0 }, 900, 600, 1, true);
  const horizontalB = layoutForAssignment({ team: 'left', edge: 'top', half: 1 }, 900, 600, 0, true);
  assert.ok(horizontalA.x + horizontalA.w <= 225);
  assert.ok(horizontalB.x >= 225 && horizontalB.x + horizontalB.w <= 450);
});

test('paired split-slot occupants have distinct non-overlapping sub-regions', () => {
  for (const edge of ['side', 'top', 'bottom']) {
    for (const team of ['left', 'right']) {
      const first = layoutForAssignment({ team, edge, half: 0 }, 900, 600, 1, true);
      const second = layoutForAssignment({ team, edge, half: 1 }, 900, 600, 0, true);
      if (edge === 'side') assert.ok(first.y + first.h <= second.y);
      else assert.ok(first.x + first.w <= second.x);
    }
  }
});

test('protocol message validation rejects untrusted or malformed packets', () => {
  assert.deepEqual(validateMessage({ type: 'input', peerId: 'p1', seq: 2, value: 0.4 }), {
    type: 'input', peerId: 'p1', seq: 2, value: 0.4
  });
  assert.equal(validateMessage({ type: 'input', peerId: 'p1', seq: 2, value: 9 }).value, 1);
  assert.throws(() => validateMessage({ type: 'admin', adminId: 'attacker' }), /unsupported/);
  assert.throws(() => validateMessage({ type: 'input', peerId: '', seq: -1, value: 0 }), /invalid/);
});
