import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSignal, decodeSignal, validatePeerMessage, electHost } from '../js/peer.mjs';

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
