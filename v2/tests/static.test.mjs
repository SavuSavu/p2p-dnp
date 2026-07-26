import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('page exposes name gate, all modes, canvas, touch controls, and signaling dialog', async () => {
  const html = await read('index.html');
  for (const id of ['name-gate','single-btn','random-btn','create-btn','join-btn','arena','touch-controls','signal-dialog']) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /type="module"/);
});

test('manifest and styles support installable responsive static hosting', async () => {
  const [html, css, manifest] = await Promise.all([read('index.html'), read('styles.css'), read('manifest.webmanifest')]);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(css, /@media/);
  assert.equal(JSON.parse(manifest).display, 'standalone');
});

test('product copy is honest about local random mode and the 1v1 networking milestone', async () => {
  const html = await read('index.html');
  assert.match(html, /RANDOM 1V1[^]*LOCAL SIMULATION/i);
  assert.match(html, /1V1 P2P MILESTONE/i);
  assert.doesNotMatch(html, /1\/12/);
  assert.match(html, /INVITE LINK ALONE DOES NOT CONNECT A PEER/i);
  const app = await read('js/app.mjs');
  assert.match(app, /function startRandomLocal\(/);
  assert.match(app, /#random-btn'\)\.onclick = startRandomLocal/);
});

test('game includes a prominent disconnect recovery action and pointer capture is guarded', async () => {
  const [html, app] = await Promise.all([read('index.html'), read('js/app.mjs')]);
  assert.match(html, /id="disconnect-notice"/);
  assert.match(html, /id="disconnect-action"/);
  assert.match(app, /typeof button\.setPointerCapture === ['"]function['"]/);
});
