import test from 'node:test';
import assert from 'node:assert/strict';
import { gatherIceDescription, createSignalingState, advanceSignaling, resetSignaling } from '../js/signaling.mjs';

class FakePeerConnection {
  constructor() {
    this.iceGatheringState = 'gathering';
    this.localDescription = { type: 'offer', sdp: 'v=0\r\na=candidate:partial 1 udp 1 127.0.0.1 9 typ host\r\n' };
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, event = {}) { for (const listener of [...(this.listeners.get(type) || [])]) listener(event); }
  listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}

function fakeClock() {
  let callback = null, cleared = 0;
  return {
    setTimer(fn) { callback = fn; return 17; },
    clearTimer(id) { assert.equal(id, 17); cleared += 1; },
    fire() { callback(); },
    get cleared() { return cleared; },
  };
}

test('ICE grace expiry returns a shareable partial local description instead of rejecting', async () => {
  const connection = new FakePeerConnection();
  const clock = fakeClock();
  const pending = gatherIceDescription(connection, { graceMs: 25, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  clock.fire();
  const result = await pending;

  assert.deepEqual(result, { description: connection.localDescription, complete: false, partial: true });
  assert.equal(connection.listenerCount(), 0);
  assert.equal(clock.cleared, 1);
});

test('ICE completion resolves complete and removes candidate/state listeners and timer', async () => {
  const connection = new FakePeerConnection();
  const clock = fakeClock();
  const pending = gatherIceDescription(connection, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  connection.iceGatheringState = 'complete';
  connection.emit('icegatheringstatechange');
  const result = await pending;

  assert.equal(result.complete, true);
  assert.equal(result.partial, false);
  assert.equal(connection.listenerCount(), 0);
  assert.equal(clock.cleared, 1);
});

test('ICE fallback rejects precisely when no local description exists and never returns an empty signal', async () => {
  const connection = new FakePeerConnection();
  connection.localDescription = null;
  const clock = fakeClock();
  const pending = gatherIceDescription(connection, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  clock.fire();
  await assert.rejects(pending, /No local WebRTC description is available/);
  assert.equal(connection.listenerCount(), 0);
  assert.equal(clock.cleared, 1);
});

test('events from a reset stale peer connection are ignored and cleaned up', async () => {
  const connection = new FakePeerConnection();
  const clock = fakeClock();
  let current = true;
  const pending = gatherIceDescription(connection, { isCurrent: () => current, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  current = false;
  connection.iceGatheringState = 'complete';
  connection.emit('icecandidate', { candidate: null });

  await assert.rejects(pending, /Signaling attempt was reset/);
  assert.equal(connection.listenerCount(), 0);
  assert.equal(clock.cleared, 1);
});

test('already-complete ICE resolves immediately without installing listeners or timers', async () => {
  const connection = new FakePeerConnection();
  connection.iceGatheringState = 'complete';
  let timerCreated = false;
  const result = await gatherIceDescription(connection, { setTimer() { timerCreated = true; } });
  assert.equal(result.complete, true);
  assert.equal(connection.listenerCount(), 0);
  assert.equal(timerCreated, false);
});

test('role-aware signaling phases allow only the next host and guest action', () => {
  let host = createSignalingState('host');
  assert.deepEqual(host, { role: 'host', phase: 'idle', generation: 1, authenticated: false });
  host = advanceSignaling(host, 'create-offer');
  assert.equal(host.phase, 'gathering-offer');
  host = advanceSignaling(host, 'offer-ready');
  assert.equal(host.phase, 'waiting-answer');
  assert.throws(() => advanceSignaling(host, 'create-offer'), /not available/i);
  host = advanceSignaling(host, 'apply-answer');
  assert.equal(host.phase, 'connecting');
  host = advanceSignaling(host, 'authenticated');
  assert.equal(host.phase, 'connected');
  assert.equal(host.authenticated, true);

  let guest = createSignalingState('guest');
  assert.equal(guest.phase, 'waiting-offer');
  guest = advanceSignaling(guest, 'apply-offer');
  assert.equal(guest.phase, 'gathering-answer');
  guest = advanceSignaling(guest, 'answer-ready');
  assert.equal(guest.phase, 'connecting');
  assert.throws(() => advanceSignaling(guest, 'apply-answer'), /not available/i);
});

test('reset creates a fresh generation and role-specific initial phase', () => {
  const host = resetSignaling({ ...createSignalingState('host'), phase: 'connected', authenticated: true });
  assert.deepEqual(host, { role: 'host', phase: 'idle', generation: 2, authenticated: false });
  const guest = resetSignaling({ ...createSignalingState('guest'), phase: 'connecting' });
  assert.deepEqual(guest, { role: 'guest', phase: 'waiting-offer', generation: 2, authenticated: false });
});
