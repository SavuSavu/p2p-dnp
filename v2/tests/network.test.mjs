import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PACKET_BYTES,
  makeHello,
  makeInput,
  makeRoom,
  makeState,
  parseProtocolMessage,
  createHostSession,
  createGuestSession,
  receiveHostMessage,
  receiveGuestMessage,
  disconnectHostChannel
} from '../js/network.mjs';

const host = { id: 'host-1', name: 'HOST' };
const guest = { id: 'guest-1', name: 'GUEST' };
const code = 'ABC234';
const room = {
  code,
  adminId: host.id,
  players: [host],
  assignments: [{ id: host.id, playerIndex: 0, team: 'left', edge: 'left', input: 0 }]
};
const game = {
  players: [{ id: 0, name: 'HOST', team: 'left', edge: 'left', split: 0, splitActive: false, position: .5, input: 0, ai: false }],
  ball: { x: .5, y: .5, vx: .52, vy: .19, r: .012 },
  score: [0, 0], rally: 0, winner: null
};

const wire = value => JSON.stringify(value);

test('protocol parses versioned hello and returns only sanitized identity fields', () => {
  assert.deepEqual(parseProtocolMessage(wire({ ...makeHello(code, host), ignored: true })), {
    v: 2, type: 'hello', room: code, peer: host
  });
});

test('protocol parses fixed 1v1 room, bounded input, and authoritative state', () => {
  const fullRoom = {
    code,
    adminId: host.id,
    players: [host, guest],
    assignments: [
      { id: host.id, playerIndex: 0, team: 'left', edge: 'left', input: 0 },
      { id: guest.id, playerIndex: 1, team: 'right', edge: 'right', input: .4 }
    ]
  };
  assert.deepEqual(parseProtocolMessage(wire(makeInput(code, guest.id, .4, 3))), makeInput(code, guest.id, .4, 3));
  assert.deepEqual(parseProtocolMessage(wire(makeRoom(code, host.id, fullRoom))), makeRoom(code, host.id, fullRoom));
  assert.deepEqual(parseProtocolMessage(wire(makeState(code, host.id, 9, game))), makeState(code, host.id, 9, game));
});

test('protocol rejects missing versions, malformed packets, unknown authority, and oversized messages', () => {
  assert.throws(() => parseProtocolMessage(wire({ type: 'hello', room: code, peer: host })), /version/i);
  assert.throws(() => parseProtocolMessage(wire({ v: 2, type: 'input', room: code, peerId: guest.id, value: 7, seq: 1 })), /invalid/i);
  assert.throws(() => parseProtocolMessage(wire({ v: 2, type: 'admin', room: code, peerId: guest.id })), /invalid/i);
  assert.throws(() => parseProtocolMessage('x'.repeat(MAX_PACKET_BYTES + 1)), /large/i);
});

test('host binds a channel to hello identity, admits guest, and rejects duplicate or mismatched claims', () => {
  let session = createHostSession(room);
  const joined = receiveHostMessage(session, 'channel-a', wire(makeHello(code, guest)), 100);
  assert.equal(joined.accepted, true);
  assert.equal(joined.broadcastRoom, true);
  assert.equal(joined.broadcastState, true);
  assert.deepEqual(joined.session.room.players, [host, guest]);
  assert.equal(joined.session.channels.get('channel-a').peerId, guest.id);
  session = joined.session;

  assert.equal(receiveHostMessage(session, 'channel-a', wire(makeHello(code, guest)), 101).closeChannel, true);
  assert.equal(receiveHostMessage(session, 'channel-a', wire(makeInput(code, 'forged', 1, 1)), 102).closeChannel, true);
  assert.equal(receiveHostMessage(session, 'channel-b', wire(makeHello(code, guest)), 103).closeChannel, true);
});

test('host accepts strictly increasing guest input and applies replay and rate limits per channel', () => {
  let session = receiveHostMessage(createHostSession(room), 'channel-a', wire(makeHello(code, guest)), 0).session;
  let result = receiveHostMessage(session, 'channel-a', wire(makeInput(code, guest.id, .75, 1)), 10);
  assert.equal(result.accepted, true);
  assert.equal(result.session.room.assignments[1].input, .75);
  session = result.session;
  assert.equal(receiveHostMessage(session, 'channel-a', wire(makeInput(code, guest.id, 0, 1)), 11).reason, 'sequence');

  for (let seq = 2; seq <= 30; seq++) session = receiveHostMessage(session, 'channel-a', wire(makeInput(code, guest.id, 0, seq)), 20).session;
  result = receiveHostMessage(session, 'channel-a', wire(makeInput(code, guest.id, 0, 31)), 20);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'rate');
});

test('guest binds the designated host hello and accepts room/state only from that identity with increasing sequence', () => {
  let session = createGuestSession(code, guest, 'host-channel');
  let result = receiveGuestMessage(session, 'other-channel', wire(makeHello(code, host)), 0);
  assert.equal(result.closeChannel, true);

  result = receiveGuestMessage(session, 'host-channel', wire(makeHello(code, host)), 1);
  assert.equal(result.accepted, true);
  session = result.session;

  const fullRoom = {
    code, adminId: host.id, players: [host, guest],
    assignments: [
      { id: host.id, playerIndex: 0, team: 'left', edge: 'left', input: 0 },
      { id: guest.id, playerIndex: 1, team: 'right', edge: 'right', input: 0 }
    ]
  };
  result = receiveGuestMessage(session, 'host-channel', wire(makeRoom(code, host.id, fullRoom)), 2);
  assert.equal(result.accepted, true);
  session = result.session;
  result = receiveGuestMessage(session, 'host-channel', wire(makeState(code, host.id, 1, game)), 3);
  assert.equal(result.accepted, true);
  assert.deepEqual(result.session.snapshot, game);
  assert.equal(receiveGuestMessage(result.session, 'host-channel', wire(makeState(code, host.id, 1, game)), 4).reason, 'sequence');
  assert.equal(receiveGuestMessage(session, 'host-channel', wire({ v: 2, type: 'room', room: code, peerId: 'attacker', data: fullRoom }), 5).closeChannel, true);
});

test('host disconnect removes the bound guest and requests a clean room rebroadcast', () => {
  const connected = receiveHostMessage(createHostSession(room), 'channel-a', wire(makeHello(code, guest)), 0).session;
  const result = disconnectHostChannel(connected, 'channel-a');
  assert.equal(result.broadcastRoom, true);
  assert.deepEqual(result.session.room.players, [host]);
  assert.equal(result.session.room.assignments.length, 1);
  assert.equal(result.session.channels.has('channel-a'), false);
});


test('room packet constructor requires the sender to be the room admin', () => {
  assert.throws(() => makeRoom(code, guest.id, room), /authority/i);
  assert.deepEqual(makeRoom(code, host.id, room).peerId, host.id);
});

test('packet constructors reject invalid outbound identity and sequence values', () => {
  assert.throws(() => makeHello(code, { id: '', name: 'X' }), /invalid/i);
  assert.throws(() => makeInput(code, guest.id, 0, -1), /invalid/i);
});
