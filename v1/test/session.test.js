import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../src/model.js';
import {
  createHostSession,
  createGuestSession,
  receiveHostMessage,
  receiveGuestMessage,
  disconnectHostChannel
} from '../src/session.js';

const hello = (peerId = 'guest-1') => JSON.stringify({
  v: 1, type: 'hello', code: 'ABC234', peer: { id: peerId, name: 'Guest' }
});

test('host binds one validated guest identity to a channel and admits it to 1v1', () => {
  const host = createHostSession(createRoom('ABC234', { id: 'host-1', name: 'Host' }));
  const result = receiveHostMessage(host, 'channel-a', hello(), 1000);

  assert.equal(result.accepted, true);
  assert.equal(result.session.channels.get('channel-a').peerId, 'guest-1');
  assert.deepEqual(result.session.room.players.map(({ id, name }) => ({ id, name })), [
    { id: 'host-1', name: 'Host' },
    { id: 'guest-1', name: 'Guest' }
  ]);
  assert.equal(result.broadcastRoom, true);
  assert.equal(result.broadcastState, true);
});

test('host rejects a hello that collides with an existing player or bound peer identity', () => {
  let host = createHostSession(createRoom('ABC234', { id: 'host-1', name: 'Host' }));
  let result = receiveHostMessage(host, 'attacker', hello('host-1'), 1000);
  assert.equal(result.accepted, false);
  assert.equal(result.closeChannel, true);
  assert.equal(result.session.channels.size, 0);

  host = receiveHostMessage(host, 'channel-a', hello('guest-1'), 1010).session;
  result = receiveHostMessage(host, 'channel-b', hello('guest-1'), 1020);
  assert.equal(result.accepted, false);
  assert.equal(result.closeChannel, true);
  assert.equal(result.session.channels.size, 1);
});

test('host rejects identity changes and claimed peer id mismatches on a bound channel', () => {
  let session = receiveHostMessage(
    createHostSession(createRoom('ABC234', { id: 'host-1', name: 'Host' })),
    'channel-a', hello(), 1000
  ).session;

  const secondHello = receiveHostMessage(session, 'channel-a', hello('attacker'), 1010);
  assert.equal(secondHello.accepted, false);
  assert.equal(secondHello.closeChannel, true);

  const forgedInput = receiveHostMessage(session, 'channel-a', JSON.stringify({
    v: 1, type: 'input', code: 'ABC234', peerId: 'attacker', seq: 1, value: 0.2
  }), 1020);
  assert.equal(forgedInput.accepted, false);
  assert.equal(forgedInput.closeChannel, true);
});

test('host applies only increasing input sequences and rate limits each channel', () => {
  let session = receiveHostMessage(
    createHostSession(createRoom('ABC234', { id: 'host-1', name: 'Host' })),
    'channel-a', hello(), 1000
  ).session;
  const input = (seq, value) => JSON.stringify({
    v: 1, type: 'input', code: 'ABC234', peerId: 'guest-1', seq, value
  });

  let result = receiveHostMessage(session, 'channel-a', input(1, 0.8), 1100);
  assert.equal(result.accepted, true);
  session = result.session;
  assert.equal(session.room.assignments.find((item) => item.id === 'guest-1').input, 0.8);

  result = receiveHostMessage(session, 'channel-a', input(1, 0.1), 1110);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'sequence');

  for (let seq = 2; seq <= 30; seq += 1) {
    result = receiveHostMessage(session, 'channel-a', input(seq, 0.4), 1120 + seq);
    if (result.accepted) session = result.session;
  }
  result = receiveHostMessage(session, 'channel-a', input(31, 0.2), 1190);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'rate');
});

test('guest binds the host identity from hello on its designated channel', () => {
  const guest = createGuestSession('ABC234', { id: 'guest-1', name: 'Guest' }, 'host-channel');
  const result = receiveGuestMessage(guest, 'host-channel', JSON.stringify({
    v: 1, type: 'hello', code: 'ABC234', peer: { id: 'host-1', name: 'Host' }
  }));
  assert.equal(result.accepted, true);
  assert.equal(result.session.hostPeerId, 'host-1');
});

test('guest accepts room and state only from its bound host channel', () => {
  let guest = createGuestSession('ABC234', { id: 'guest-1', name: 'Guest' }, 'host-channel');
  guest = receiveGuestMessage(guest, 'host-channel', JSON.stringify({
    v: 1, type: 'hello', code: 'ABC234', peer: { id: 'host-1', name: 'Host' }
  })).session;
  const room = createRoom('ABC234', { id: 'host-1', name: 'Host' });
  const admitted = receiveHostMessage(createHostSession(room), 'guest-channel', hello(), 1000).session.room;
  const roomPacket = JSON.stringify({ v: 1, type: 'room', code: 'ABC234', peerId: 'host-1', room: admitted });

  let result = receiveGuestMessage(guest, 'other-channel', roomPacket);
  assert.equal(result.accepted, false);
  assert.equal(result.closeChannel, true);

  result = receiveGuestMessage(guest, 'host-channel', roomPacket);
  assert.equal(result.accepted, true);
  guest = result.session;
  assert.equal(guest.hostPeerId, 'host-1');

  const statePacket = JSON.stringify({
    v: 1, type: 'state', code: 'ABC234', peerId: 'host-1', seq: 1,
    snapshot: { ball: { x: 450, y: 300, vx: 100, vy: -40 }, score: { left: 1, right: 2 } },
    inputs: [{ id: 'host-1', input: 0.2 }, { id: 'guest-1', input: 0.9 }]
  });
  result = receiveGuestMessage(guest, 'host-channel', statePacket);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.session.snapshot.score, { left: 1, right: 2 });
  assert.equal(result.session.room.assignments.find((item) => item.id === 'guest-1').input, 0.9);
});

test('guest rejects stale state sequences and rate limits host snapshots', () => {
  let guest = createGuestSession('ABC234', { id: 'guest-1', name: 'Guest' }, 'host-channel');
  guest = receiveGuestMessage(guest, 'host-channel', JSON.stringify({
    v: 1, type: 'hello', code: 'ABC234', peer: { id: 'host-1', name: 'Host' }
  }), 1000).session;
  const admitted = receiveHostMessage(
    createHostSession(createRoom('ABC234', { id: 'host-1', name: 'Host' })), 'guest-channel', hello(), 1000
  ).session.room;
  guest = receiveGuestMessage(guest, 'host-channel', JSON.stringify({
    v: 1, type: 'room', code: 'ABC234', peerId: 'host-1', room: admitted
  }), 1001).session;
  const state = (seq) => JSON.stringify({
    v: 1, type: 'state', code: 'ABC234', peerId: 'host-1', seq,
    snapshot: { ball: { x: 450, y: 300, vx: 100, vy: -40 }, score: { left: 1, right: 2 } },
    inputs: [{ id: 'host-1', input: 0.2 }, { id: 'guest-1', input: 0.9 }]
  });
  let result = receiveGuestMessage(guest, 'host-channel', state(1), 1010);
  assert.equal(result.accepted, true);
  guest = result.session;
  result = receiveGuestMessage(guest, 'host-channel', state(1), 1020);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'sequence');

  for (let seq = 2; seq <= 60; seq += 1) {
    result = receiveGuestMessage(guest, 'host-channel', state(seq), 1020 + seq);
    if (result.accepted) guest = result.session;
  }
  result = receiveGuestMessage(guest, 'host-channel', state(61), 1090);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'rate');
});

test('host disconnect removes its bound guest and requests a room rebroadcast', () => {
  const joined = receiveHostMessage(
    createHostSession(createRoom('ABC234', { id: 'host-1', name: 'Host' })),
    'channel-a', hello(), 1000
  ).session;
  const result = disconnectHostChannel(joined, 'channel-a');
  assert.deepEqual(result.session.room.players.map((player) => player.id), ['host-1']);
  assert.equal(result.session.channels.size, 0);
  assert.equal(result.broadcastRoom, true);
});
