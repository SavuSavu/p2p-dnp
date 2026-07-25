import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePeerMessage, electHost, RoomState, makeSnapshot } from '../js/protocol.mjs';

test('validatePeerMessage accepts known versioned messages and strips unknown fields', () => {
  assert.deepEqual(validatePeerMessage({ v: 1, type: 'input', peerId: 'p2', axis: 2, seq: 9, admin: true }),
    { v: 1, type: 'input', peerId: 'p2', axis: 1, seq: 9 });
  assert.equal(validatePeerMessage({ v: 2, type: 'input', peerId: 'p2', axis: 0, seq: 1 }), null);
  assert.equal(validatePeerMessage({ v: 1, type: 'hack' }), null);
});

test('validatePeerMessage rejects malformed snapshots and constrains valid snapshots', () => {
  assert.equal(validatePeerMessage({ v: 1, type: 'snapshot', tick: -1 }), null);
  const msg = validatePeerMessage({ v: 1, type: 'snapshot', tick: 4, hostId: 'a', ball: { x: 9999, y: -4, vx: 100, vy: -100 }, score: [3, 2] });
  assert.deepEqual(msg.ball, { x: 1, y: 0, vx: 3, vy: -3 });
});

test('electHost selects the lowest stable connected peer id', () => {
  assert.equal(electHost([{ id: 'z9', connected: true }, { id: 'a2', connected: true }, { id: 'a1', connected: false }]), 'a2');
  assert.equal(electHost([]), null);
});

test('RoomState migrates host and records a visible migration event', () => {
  const room = new RoomState([{ id: 'b', name: 'Bee', connected: true }, { id: 'a', name: 'Aye', connected: true }], 'b');
  room.disconnect('b', 42);
  assert.equal(room.hostId, 'a');
  assert.deepEqual(room.migration, { from: 'b', to: 'a', tick: 42 });
});

test('makeSnapshot produces bounded serializable authoritative state', () => {
  const snap = makeSnapshot({ tick: 3, hostId: 'h', ball: { x: .2, y: .4, vx: 1, vy: -1 }, score: [2, 1], players: [{ id: 'p', position: 3 }] });
  assert.deepEqual(snap.players, [{ id: 'p', position: 1 }]);
  assert.doesNotThrow(() => JSON.stringify(snap));
});
