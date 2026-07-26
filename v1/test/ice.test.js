import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForIceGathering } from '../src/ice.js';

class FakePeerConnection extends EventTarget {
  constructor({ state = 'gathering', description = null } = {}) {
    super();
    this.iceGatheringState = state;
    this.localDescription = description;
    this.added = [];
    this.removed = [];
  }

  addEventListener(type, listener) {
    this.added.push([type, listener]);
    super.addEventListener(type, listener);
  }

  removeEventListener(type, listener) {
    this.removed.push([type, listener]);
    super.removeEventListener(type, listener);
  }
}

const offer = { type: 'offer', sdp: 'v=0\r\na=candidate:1 1 UDP 1 192.0.2.1 5000 typ host\r\n' };

function manualClock() {
  let callback;
  let cleared = false;
  return {
    setTimer(fn) { callback = fn; return 7; },
    clearTimer(id) { assert.equal(id, 7); cleared = true; },
    fire() { callback(); },
    get cleared() { return cleared; }
  };
}

test('complete ICE resolves immediately with full local description and no resources', async () => {
  const pc = new FakePeerConnection({ state: 'complete', description: offer });
  const result = await waitForIceGathering(pc);
  assert.deepEqual(result, { description: offer, completeness: 'complete' });
  assert.equal(pc.added.length, 0);
});

test('ICE completion resolves early and removes every listener and timer', async () => {
  const pc = new FakePeerConnection({ description: offer });
  const clock = manualClock();
  const pending = waitForIceGathering(pc, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  pc.iceGatheringState = 'complete';
  pc.dispatchEvent(new Event('icegatheringstatechange'));
  assert.deepEqual(await pending, { description: offer, completeness: 'complete' });
  assert.equal(pc.removed.length, 2);
  assert.equal(clock.cleared, true);
});

test('grace timeout returns an existing non-empty local description as partial and cleans up', async () => {
  const pc = new FakePeerConnection({ state: 'complete', description: offer });
  const clock = manualClock();
  const pending = waitForIceGathering(pc, {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isComplete: () => false
  });
  clock.fire();
  assert.deepEqual(await pending, { description: offer, completeness: 'partial' });
  assert.equal(pc.removed.length, 2);
  assert.equal(clock.cleared, true);
});

test('grace timeout without a local description rejects with an actionable error and cleans up', async () => {
  const pc = new FakePeerConnection();
  const clock = manualClock();
  const pending = waitForIceGathering(pc, { setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  clock.fire();
  await assert.rejects(pending, /No WebRTC offer was generated.*Reset \/ Retry/i);
  assert.equal(pc.removed.length, 2);
  assert.equal(clock.cleared, true);
});

test('retired peer connection events and timeouts resolve as stale without publishing SDP', async () => {
  const pc = new FakePeerConnection({ description: offer });
  const clock = manualClock();
  let current = true;
  const pending = waitForIceGathering(pc, {
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isCurrent: () => current
  });
  current = false;
  pc.iceGatheringState = 'complete';
  pc.dispatchEvent(new Event('icecandidate'));
  assert.deepEqual(await pending, { stale: true });
  assert.equal(pc.removed.length, 2);
  assert.equal(clock.cleared, true);
});
