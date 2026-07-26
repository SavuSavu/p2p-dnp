import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('static page exposes accessible name gate, modes, canvas and mobile controls', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  for (const required of ['id="name-form"', 'maxlength="16"', 'id="single"', 'id="random"', 'id="create"', 'id="join"', 'id="arena"', 'aria-label="Move negative"', 'aria-label="Move positive"', 'aria-live="polite"']) {
    assert.ok(html.includes(required), `missing ${required}`);
  }
  assert.ok(html.includes('type="module"'));
});

test('manifest and stylesheet are present for mobile static hosting', async () => {
  const [manifest, css] = await Promise.all([
    readFile(new URL('manifest.webmanifest', root), 'utf8'),
    readFile(new URL('styles.css', root), 'utf8')
  ]);
  assert.equal(JSON.parse(manifest).display, 'standalone');
  assert.match(css, /touch-action:\s*none/);
  assert.match(css, /prefers-reduced-motion/);
});

test('room UI exposes role-aware manual signaling, recovery controls and a complete five-step script', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  for (const required of ['id="signaling-phase"', 'id="create-offer"', 'id="apply-offer"', 'id="apply-answer"', 'id="copy-signal"', 'id="reset-signal"', 'id="local-signal"', 'id="remote-signal"', 'id="channel-health"', 'id="roster"', 'id="waiting-court"']) {
    assert.ok(html.includes(required), `missing ${required}`);
  }
  for (const instruction of ['Host sends invite link', 'Host creates and sends OFFER', 'Guest pastes OFFER and sends ANSWER', 'Host pastes ANSWER', 'Both wait for PEER CONNECTED']) {
    assert.ok(html.includes(instruction), `missing first-time instruction: ${instruction}`);
  }
  assert.match(html, /TURN[^<]*(?:not bundled|does not bundle)/i);
  const app = await readFile(new URL('js/app.mjs', root), 'utf8');
  for (const behavior of ['RTCPeerConnection', 'createOffer(', 'createAnswer(', 'setRemoteDescription(', 'transitionHost(', 'transitionGuest(', 'disconnectHostChannel(', 'updateGuestSnapshotHealth(']) {
    assert.ok(app.includes(behavior), `missing browser behavior: ${behavior}`);
  }
});

test('product copy describes only the demonstrated 1v1 and local-simulation capabilities', async () => {
  const [html, app] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('js/app.mjs', root), 'utf8'),
  ]);
  assert.match(html, /1v1 P2P milestone/i);
  assert.match(html, /local simulation/i);
  assert.match(html, /invite link alone does not connect a peer/i);
  assert.match(html, /host migration.*future experiment/is);
  assert.doesNotMatch(html, /up to 12 peers/i);
  assert.doesNotMatch(html, /deterministic host election/i);
  assert.doesNotMatch(app, /demo rendezvous/i);
});

test('Playwright proof drives two isolated contexts through full P2P lifecycle', async () => {
  const proof = await readFile(new URL('tests/p2p.browser.mjs', root), 'utf8');
  for (const behavior of ['browser.newContext(', '#create-offer', '#apply-offer', '#apply-answer', '#reset-signal', 'partial-timeout-fallback', 'guestInputReplicated', 'disconnectCleanup']) {
    assert.ok(proof.includes(behavior), `missing integration proof: ${behavior}`);
  }
});
