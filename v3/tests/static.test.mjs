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

test('browser controller wires every mode, snapshots, adaptive input and migration UI', async () => {
  const app = await readFile(new URL('js/app.mjs', root), 'utf8');
  for (const behavior of ['startGame(\'single\')', 'startGame(\'random\')', 'startGame(\'room\'', 'makeSnapshot(', 'simulateMigration', 'pointerdown', 'requestAnimationFrame']) {
    assert.ok(app.includes(behavior), `missing browser behavior: ${behavior}`);
  }
});
