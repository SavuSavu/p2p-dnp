import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeName,
  createRoomCode,
  assignPlayers,
  paddleRect,
  clampInput,
} from '../js/core.mjs';

test('sanitizeName accepts trimmed text from 1 to 16 characters', () => {
  assert.equal(sanitizeName('  Ada  '), 'Ada');
  assert.equal(sanitizeName('<b>Ada</b>'), null);
  assert.equal(sanitizeName('Ada\nMallory'), null);
  assert.equal(sanitizeName(''), null);
  assert.equal(sanitizeName('abcdefghijklmnopq'), null);
});

test('createRoomCode returns an unambiguous six-character code', () => {
  const code = createRoomCode(() => 0);
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(code.length, 6);
});

test('assignPlayers alternates teams and scales through split slots for twelve', () => {
  const players = Array.from({ length: 12 }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}` }));
  const assigned = assignPlayers(players);
  assert.deepEqual(assigned.slice(0, 6).map(({ team, edge }) => [team, edge]), [
    ['left', 'left'], ['right', 'right'], ['left', 'top'],
    ['right', 'top'], ['left', 'bottom'], ['right', 'bottom'],
  ]);
  assert.deepEqual(assigned.slice(6).map(({ slot, split }) => [slot, split]), [
    [0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1],
  ]);
});

test('paddleRect constrains top and bottom paddles to their team half', () => {
  const topLeft = paddleRect({ edge: 'top', team: 'left', split: 0, position: 1 }, 1000, 600, 8);
  const bottomRight = paddleRect({ edge: 'bottom', team: 'right', split: 1, position: -1 }, 1000, 600, 8);
  assert.ok(topLeft.x + topLeft.w <= 500);
  assert.ok(bottomRight.x >= 500);
  assert.equal(topLeft.y, 8);
  assert.equal(bottomRight.y + bottomRight.h, 592);
});

test('paired split-slot occupants get distinct non-overlapping sub-regions', () => {
  const players = assignPlayers(Array.from({ length: 12 }, (_, i) => ({ id: `p${i + 1}`, name: `P${i + 1}`, position: i < 6 ? 1 : -1 })));
  for (const [first, second] of [[0, 6], [1, 7]]) {
    const a = paddleRect(players[first], 1000, 600, 8);
    const b = paddleRect(players[second], 1000, 600, 8);
    assert.ok(a.y + a.h <= b.y, `side pair ${first + 1}/${second + 1} overlaps`);
  }
  for (const [first, second] of [[2, 8], [3, 9], [4, 10], [5, 11]]) {
    const a = paddleRect(players[first], 1000, 600, 8);
    const b = paddleRect(players[second], 1000, 600, 8);
    assert.ok(a.x + a.w <= b.x, `horizontal pair ${first + 1}/${second + 1} overlaps`);
  }
});

test('clampInput only permits finite axis values in range', () => {
  assert.deepEqual(clampInput({ axis: 4, seq: 2 }), { axis: 1, seq: 2 });
  assert.deepEqual(clampInput({ axis: -0.4, seq: 0 }), { axis: -0.4, seq: 0 });
  assert.equal(clampInput({ axis: Infinity, seq: 1 }), null);
  assert.equal(clampInput({ axis: 0, seq: -1 }), null);
});
