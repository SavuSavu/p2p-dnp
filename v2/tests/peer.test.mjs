import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSignal, decodeSignal, validatePeerMessage, electHost, gatherLocalDescription } from '../js/peer.mjs';

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

test('manual signal encoding round trips Unicode-safe session data', () => {
  const signal = { type: 'offer', sdp: 'hello ✓', room: 'ABC234' };
  assert.deepEqual(decodeSignal(encodeSignal(signal)), signal);
});

test('peer message validation accepts bounded input and rejects forged or malformed packets', () => {
  assert.deepEqual(validatePeerMessage({ type: 'input', value: .4, seq: 2 }), { type: 'input', value: .4, seq: 2 });
  assert.throws(() => validatePeerMessage({ type: 'input', value: 8, seq: 2 }), /invalid/);
  assert.throws(() => validatePeerMessage({ type: 'admin', admin: true }), /invalid/);
});

test('host election picks the lexically lowest connected stable peer id', () => {
  assert.equal(electHost(['z9', 'a2', 'm4']), 'a2');
  assert.equal(electHost([]), null);
});

test('bounded ICE gathering returns a complete non-empty local description and cleans both listeners', async () => {
  const pc = new FakePeerConnection({ description: { type: 'offer', sdp: 'v=0\r\na=candidate:1 1 UDP 1 127.0.0.1 9 typ host\r\n' } });
  const gathering = gatherLocalDescription(pc, { timeoutMs: 100 });
  pc.iceGatheringState = 'complete';
  pc.dispatchEvent(new Event('icegatheringstatechange'));
  assert.deepEqual(await gathering, { status: 'complete', description: pc.localDescription });
  assert.deepEqual(pc.added.map(([type]) => type).sort(), ['icecandidate', 'icegatheringstatechange']);
  assert.deepEqual(pc.removed.map(([type]) => type).sort(), ['icecandidate', 'icegatheringstatechange']);
});

test('never-completing ICE gathering returns a marked partial non-empty local description after the bound', async () => {
  const pc = new FakePeerConnection({ description: { type: 'offer', sdp: 'v=0\r\na=ice-ufrag:test\r\n' } });
  assert.deepEqual(await gatherLocalDescription(pc, { timeoutMs: 5 }), {
    status: 'partial',
    description: pc.localDescription
  });
  assert.deepEqual(pc.removed.map(([type]) => type).sort(), ['icecandidate', 'icegatheringstatechange']);
});

test('bounded ICE gathering fails precisely instead of returning an empty signal', async () => {
  const pc = new FakePeerConnection({ description: null });
  await assert.rejects(gatherLocalDescription(pc, { timeoutMs: 5 }), /no local session description/i);
  assert.deepEqual(pc.removed.map(([type]) => type).sort(), ['icecandidate', 'icegatheringstatechange']);
});

test('retired ICE gathering attempts suppress late completion and fail as stale', async () => {
  let current = true;
  const pc = new FakePeerConnection({ description: { type: 'offer', sdp: 'v=0\r\n' } });
  const gathering = gatherLocalDescription(pc, { timeoutMs: 5, isCurrent: () => current });
  current = false;
  pc.iceGatheringState = 'complete';
  pc.dispatchEvent(new Event('icegatheringstatechange'));
  await assert.rejects(gathering, /signaling attempt was reset/i);
});

test('reset aborts an in-flight ICE gather immediately and removes listeners', async () => {
  const controller = new AbortController();
  const pc = new FakePeerConnection({ description: { type: 'offer', sdp: 'v=0\r\n' } });
  const gathering = gatherLocalDescription(pc, { timeoutMs: 1000, signal: controller.signal });
  controller.abort();
  await assert.rejects(gathering, /signaling attempt was reset/i);
  assert.deepEqual(pc.removed.map(([type]) => type).sort(), ['icecandidate', 'icegatheringstatechange']);
});
