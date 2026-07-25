import test from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, parseProtocolMessage } from '../src/protocol.js';

test('protocol accepts a versioned hello and sanitizes its peer fields', () => {
  const parsed = parseProtocolMessage(JSON.stringify({
    v: PROTOCOL_VERSION,
    type: 'hello',
    code: 'abc234',
    peer: { id: ' guest-1 ', name: '  Ada  ', ignored: 'drop me' },
    ignored: true
  }));

  assert.deepEqual(parsed, {
    v: 1,
    type: 'hello',
    code: 'ABC234',
    peer: { id: 'guest-1', name: 'Ada' }
  });
});

test('protocol sanitizes a 1v1 room snapshot and fixed assignments', () => {
  const parsed = parseProtocolMessage(JSON.stringify({
    v: 1,
    type: 'room',
    code: 'ABC234',
    peerId: 'host-1',
    room: {
      code: 'ABC234',
      adminId: 'host-1',
      players: [
        { id: 'host-1', name: ' Host ' },
        { id: 'guest-1', name: ' Guest ' }
      ],
      assignments: [
        { id: 'host-1', name: 'Host', team: 'left', edge: 'side', half: 0, input: 0.25 },
        { id: 'guest-1', name: 'Guest', team: 'right', edge: 'side', half: 0, input: 2 }
      ]
    }
  }));

  assert.deepEqual(parsed.room.assignments.map(({ id, team, edge, half, input }) => ({ id, team, edge, half, input })), [
    { id: 'host-1', team: 'left', edge: 'side', half: 0, input: 0.25 },
    { id: 'guest-1', team: 'right', edge: 'side', half: 0, input: 1 }
  ]);
  assert.equal(parsed.room.players.length, 2);
});

test('protocol rejects room snapshots with duplicate players or assignments', () => {
  const packet = {
    v: 1, type: 'room', code: 'ABC234', peerId: 'host-1',
    room: {
      code: 'ABC234', adminId: 'host-1',
      players: [{ id: 'host-1', name: 'Host' }, { id: 'host-1', name: 'Clone' }],
      assignments: [
        { id: 'host-1', name: 'Host', team: 'left', edge: 'side', half: 0 },
        { id: 'host-1', name: 'Clone', team: 'right', edge: 'side', half: 0 }
      ]
    }
  };
  assert.throws(() => parseProtocolMessage(JSON.stringify(packet)), /invalid room/i);

  packet.room.players[1] = { id: 'guest-1', name: 'Guest' };
  assert.throws(() => parseProtocolMessage(JSON.stringify(packet)), /invalid room/i);
});

test('protocol sanitizes authoritative state and guest input messages', () => {
  const state = parseProtocolMessage(JSON.stringify({
    v: 1,
    type: 'state',
    code: 'ABC234',
    peerId: 'host-1',
    seq: 9,
    snapshot: {
      ball: { x: 9999, y: -2, vx: 9999, vy: -9999, r: 99 },
      score: { left: 3.9, right: -4 }
    },
    inputs: [{ id: 'guest-1', input: 1.5 }]
  }));
  assert.deepEqual(state.snapshot, {
    ball: { x: 900, y: 0, vx: 2000, vy: -2000 },
    score: { left: 3, right: 0 }
  });
  assert.equal(state.seq, 9);
  assert.deepEqual(state.inputs, [{ id: 'guest-1', input: 1 }]);

  assert.deepEqual(parseProtocolMessage(JSON.stringify({
    v: 1, type: 'input', code: 'ABC234', peerId: 'guest-1', seq: 7, value: -1
  })), {
    v: 1, type: 'input', code: 'ABC234', peerId: 'guest-1', seq: 7, value: 0
  });
});

test('protocol rejects missing versions, malformed packets, and oversized messages', () => {
  assert.throws(() => parseProtocolMessage(JSON.stringify({ type: 'hello', code: 'ABC234' })), /version/i);
  assert.throws(() => parseProtocolMessage('{nope'), /Invalid message/);
  assert.throws(() => parseProtocolMessage(JSON.stringify({
    v: 1, type: 'input', code: 'ABC234', peerId: 'guest-1', seq: -1, value: 0.5
  })), /Invalid input/);
  assert.throws(() => parseProtocolMessage(' '.repeat(16 * 1024 + 1)), /too large/i);
  assert.throws(() => parseProtocolMessage(JSON.stringify({
    v: 1, type: 'state', code: 'ABC234', peerId: 'host-1', seq: -1,
    snapshot: { ball: { x: 1, y: 1, vx: 1, vy: 1 }, score: { left: 0, right: 0 } }, inputs: []
  })), /invalid state/i);
});
