import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNegotiation,
  offerCreated,
  offerShared,
  acceptRemoteSignal,
  resetNegotiation,
  markConnected
} from '../src/negotiation.js';

const offer = (overrides = {}) => ({
  kind: 'offer',
  roomCode: 'ABC234',
  senderId: 'host-1',
  negotiationId: 'attempt-1',
  description: { type: 'offer', sdp: 'v=0\r\na=offer' },
  ...overrides
});

const answer = (overrides = {}) => ({
  kind: 'answer',
  roomCode: 'ABC234',
  senderId: 'guest-1',
  negotiationId: 'attempt-1',
  description: { type: 'answer', sdp: 'v=0\r\na=answer' },
  ...overrides
});

test('host and guest expose explicit role-specific starting phases', () => {
  assert.deepEqual(createNegotiation('host', 'host-1'), {
    role: 'host', localPeerId: 'host-1', phase: 'idle', negotiationId: null, appliedSignals: []
  });
  assert.equal(createNegotiation('guest', 'guest-1').phase, 'waiting-offer');
});

test('wrong-phase answer is rejected locally before WebRTC can be called', () => {
  const guest = createNegotiation('guest', 'guest-1');
  assert.throws(
    () => acceptRemoteSignal(guest, answer({ senderId: 'other-guest' }), 'ABC234'),
    /Step 1.*host offer/i
  );
});

test('a peer cannot apply its own signal', () => {
  const host = offerShared(offerCreated(createNegotiation('host', 'host-1'), 'attempt-1'));
  assert.throws(
    () => acceptRemoteSignal(host, offer({ senderId: 'host-1' }), 'ABC234'),
    /your own signal/i
  );
});

test('duplicate answer application is rejected', () => {
  let host = offerShared(offerCreated(createNegotiation('host', 'host-1'), 'attempt-1'));
  host = acceptRemoteSignal(host, answer(), 'ABC234').state;
  assert.equal(host.phase, 'answer-applied');
  assert.throws(
    () => acceptRemoteSignal(host, answer(), 'ABC234'),
    /already applied/i
  );
});

test('stale answer from a previous offer is rejected', () => {
  const host = offerShared(offerCreated(createNegotiation('host', 'host-1'), 'attempt-2'));
  assert.throws(
    () => acceptRemoteSignal(host, answer({ negotiationId: 'attempt-1' }), 'ABC234'),
    /older connection attempt/i
  );
});

test('reset creates a clean phase and connected state requires reset before retry', () => {
  let host = offerShared(offerCreated(createNegotiation('host', 'host-1'), 'attempt-1'));
  host = acceptRemoteSignal(host, answer(), 'ABC234').state;
  host = markConnected(host);
  assert.equal(host.phase, 'connected');

  const reset = resetNegotiation(host);
  assert.equal(reset.phase, 'idle');
  assert.equal(reset.negotiationId, null);
  assert.deepEqual(reset.appliedSignals, []);
  assert.equal(offerCreated(reset, 'attempt-2').phase, 'offer-ready');
});

test('signal description type must match its declared offer or answer kind', () => {
  const guest = createNegotiation('guest', 'guest-1');
  assert.throws(
    () => acceptRemoteSignal(guest, offer({ description: { type: 'answer', sdp: 'v=0' } }), 'ABC234'),
    /type does not match/i
  );
});

test('guest accepts one offer and enters answer-ready phase tied to that attempt', () => {
  const guest = createNegotiation('guest', 'guest-1');
  const result = acceptRemoteSignal(guest, offer(), 'ABC234');
  assert.equal(result.state.phase, 'answer-ready');
  assert.equal(result.state.negotiationId, 'attempt-1');
  assert.equal(result.signal.kind, 'offer');
});

test('room mismatch is rejected before transport application', () => {
  const guest = createNegotiation('guest', 'guest-1');
  assert.throws(
    () => acceptRemoteSignal(guest, offer({ roomCode: 'XYZ789' }), 'ABC234'),
    /another room/i
  );
});

test('offer lifecycle advances from idle to offer-ready to waiting-answer', () => {
  const ready = offerCreated(createNegotiation('host', 'host-1'), 'attempt-1');
  assert.equal(ready.phase, 'offer-ready');
  assert.equal(offerShared(ready).phase, 'waiting-answer');
});

test('invalid role transitions are rejected', () => {
  assert.throws(() => offerCreated(createNegotiation('guest', 'guest-1'), 'attempt-1'), /host/i);
  assert.throws(() => markConnected(createNegotiation('host', 'host-1')), /answer/i);
});
