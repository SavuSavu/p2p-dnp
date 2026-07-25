import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, createRoomCode, normalizeRoomCode, buildRosterLayout } from '../js/core.mjs';

test('normalizeName trims valid names and rejects empty or overlong names', () => {
  assert.equal(normalizeName('  Ada  '), 'Ada');
  assert.throws(() => normalizeName('   '), /1–16/);
  assert.throws(() => normalizeName('12345678901234567'), /1–16/);
  assert.throws(() => normalizeName('<b>Ada</b>'), /plain text/);
  assert.throws(() => normalizeName('Ada\nMallory'), /plain text/);
});

test('room codes are unambiguous six-character uppercase tokens', () => {
  const code = createRoomCode(() => 0);
  assert.equal(code, 'AAAAAA');
  assert.equal(normalizeRoomCode(' ab-cd 23 '), 'ABCD23');
  assert.throws(() => normalizeRoomCode('ABC'), /six/);
  assert.throws(() => normalizeRoomCode('ABCI01'), /characters/);
});

test('roster alternates teams and fills side then top then bottom', () => {
  const names = Array.from({ length: 6 }, (_, i) => `P${i + 1}`);
  const layout = buildRosterLayout(names);
  assert.deepEqual(layout.map(({ team, edge }) => [team, edge]), [
    ['left', 'left'], ['right', 'right'], ['left', 'top'],
    ['right', 'top'], ['left', 'bottom'], ['right', 'bottom']
  ]);
});

test('players seven through twelve split the existing six slots', () => {
  const layout = buildRosterLayout(Array.from({ length: 12 }, (_, i) => `P${i + 1}`));
  assert.equal(layout.length, 12);
  assert.deepEqual(layout.slice(6).map(p => [p.edge, p.split]), [
    ['left', 1], ['right', 1], ['top', 1], ['top', 1], ['bottom', 1], ['bottom', 1]
  ]);
  assert.throws(() => buildRosterLayout(Array(13).fill('X')), /12/);
});
