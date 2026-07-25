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
