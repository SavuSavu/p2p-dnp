import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSignal, decodeSignal, inviteUrl, matchmakingStatus } from '../src/signaling.js';

test('manual signaling payload round trips as URL-safe text', () => {
  const source = { kind: 'offer', roomCode: 'ABC234', name: 'Ada', description: { type: 'offer', sdp: 'v=0\r\na=test' } };
  const encoded = encodeSignal(source);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeSignal(encoded), source);
});

test('signal decoder rejects invalid or oversized payloads', () => {
  assert.throws(() => decodeSignal('not_valid!'), /Invalid signal/);
  assert.throws(() => decodeSignal('A'.repeat(100001)), /too large/);
});

test('invite URL is static-host-safe and includes six-character room code', () => {
  assert.equal(inviteUrl('https://example.test/v1/', 'ABC234'), 'https://example.test/v1/?join=ABC234');
});

test('random matchmaking honestly reports lack of rendezvous server', () => {
  assert.match(matchmakingStatus(''), /cannot discover/i);
  assert.match(matchmakingStatus('wss://signal.example'), /public rendezvous/i);
});
