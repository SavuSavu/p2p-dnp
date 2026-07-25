import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProtocolMessage,
  createHostSession,
  createGuestSession,
  transitionHost,
  transitionGuest,
  disconnectHostChannel,
} from '../js/session.mjs';

const room = 'ABC234';
const hello = (peerId, name = 'Guest') => JSON.stringify({ v: 3, type: 'hello', room, epoch: 1, peerId, name, seq: 0 });

test('parser sanitizes versioned room and state messages', () => {
  assert.deepEqual(parseProtocolMessage(hello('guest-1')), {
    v: 3, type: 'hello', room, epoch: 1, peerId: 'guest-1', name: 'Guest', seq: 0,
  });
  assert.deepEqual(parseProtocolMessage(JSON.stringify({
    v: 3, type: 'room', room, epoch: 2, authorityId: 'host-1', seq: 7,
    players: [{ id: 'host-1', name: 'Host', side: 'left' }, { id: 'guest-1', name: 'Guest', side: 'right' }], junk: true,
  })), {
    v: 3, type: 'room', room, epoch: 2, authorityId: 'host-1', seq: 7,
    players: [{ id: 'host-1', name: 'Host', side: 'left' }, { id: 'guest-1', name: 'Guest', side: 'right' }],
  });
});

test('parser rejects malformed, oversized, wrong-version and out-of-room-shaped packets', () => {
  assert.equal(parseProtocolMessage('{bad'), null);
  assert.equal(parseProtocolMessage(JSON.stringify({ v: 2, type: 'hello', room, epoch: 1, peerId: 'p', name: 'P', seq: 0 })), null);
  assert.equal(parseProtocolMessage(JSON.stringify({ v: 3, type: 'hello', room: 'bad', epoch: 1, peerId: 'p', name: 'P', seq: 0 })), null);
  assert.equal(parseProtocolMessage(JSON.stringify({ v: 3, type: 'hello', room, epoch: 1, peerId: 'p', name: 'P', seq: 0, padding: 'x'.repeat(9000) })), null);
});

test('host binds one guest identity and rejects duplicate or claimed-id changes', () => {
  let session = createHostSession({ room, hostId: 'host-1', hostName: 'Host', now: 10 });
  let result = transitionHost(session, 'channel-a', hello('guest-1'), 20);
  assert.equal(result.accepted, true);
  assert.equal(result.session.channels['channel-a'].peerId, 'guest-1');
  assert.deepEqual(result.session.players.map(p => [p.id, p.side]), [['host-1', 'left'], ['guest-1', 'right']]);

  session = result.session;
  assert.equal(transitionHost(session, 'channel-a', hello('guest-2'), 21).closeChannel, true);
  assert.equal(transitionHost(session, 'channel-b', hello('guest-1'), 22).closeChannel, true);
});

test('host rejects replayed and rate-flooded guest input', () => {
  let session = createHostSession({ room, hostId: 'host-1', hostName: 'Host', now: 0, rateLimit: 3 });
  session = transitionHost(session, 'c', hello('guest-1'), 1).session;
  const input = seq => JSON.stringify({ v: 3, type: 'input', room, epoch: 1, peerId: 'guest-1', seq, axis: 1 });
  let result = transitionHost(session, 'c', input(1), 100);
  assert.equal(result.accepted, true);
  session = result.session;
  assert.equal(transitionHost(session, 'c', input(1), 101).accepted, false);
  session = transitionHost(session, 'c', input(2), 102).session;
  session = transitionHost(session, 'c', input(3), 103).session;
  result = transitionHost(session, 'c', input(4), 104);
  assert.equal(result.closeChannel, true);
  assert.equal(result.reason, 'rate-limit');
});

test('guest binds host hello then accepts authority only from bound channel, peer and epoch', () => {
  let guest = createGuestSession({ room, guestId: 'guest-1', guestName: 'Guest' });
  let result = transitionGuest(guest, 'host-channel', hello('host-1', 'Host'), 5);
  assert.equal(result.accepted, true);
  guest = result.session;
  const state = JSON.stringify({
    v: 3, type: 'state', room, epoch: 1, authorityId: 'host-1', seq: 1, tick: 4,
    ball: { x: .5, y: .5, vx: .2, vy: -.2 }, score: [0, 0],
    players: [{ id: 'host-1', position: 0 }, { id: 'guest-1', position: .25 }],
  });
  assert.equal(transitionGuest(guest, 'other-channel', state, 6).accepted, false);
  assert.equal(transitionGuest(guest, 'host-channel', state.replace('host-1', 'evil-1'), 6).accepted, false);
  assert.equal(transitionGuest(guest, 'host-channel', state, 6).accepted, true);
  guest = transitionGuest(guest, 'host-channel', state, 6).session;
  assert.equal(transitionGuest(guest, 'host-channel', state, 7).accepted, false);
});

test('host disconnect removes bound guest and requests observable room rebroadcast', () => {
  let host = createHostSession({ room, hostId: 'host-1', hostName: 'Host', now: 0 });
  host = transitionHost(host, 'c', hello('guest-1'), 1).session;
  const result = disconnectHostChannel(host, 'c', 50);
  assert.deepEqual(result.session.players.map(p => p.id), ['host-1']);
  assert.equal(result.effects.broadcastRoom, true);
  assert.equal(result.session.health.lastDisconnectReason, 'channel-closed');
});
