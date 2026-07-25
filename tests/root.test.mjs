import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('root launcher links all three independent versions', async () => {
  const html = await read('index.html');
  for (const href of ['./v1/', './v2/', './v3/']) assert.match(html, new RegExp(`href=["']${href.replaceAll('/', '\\/')}["']`));
  assert.match(html, /DefinitelyNotPong/i);
});

test('Pages workflow deploys the repository as a static artifact', async () => {
  const workflow = await read('.github/workflows/pages.yml');
  assert.match(workflow, /actions\/upload-pages-artifact@v3/);
  assert.match(workflow, /path:\s*\./);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  await read('.nojekyll');
});

test('404 fallback recognizes Pages join routes', async () => {
  const html = await read('404.html');
  assert.match(html, /v1\|v2\|v3/);
  assert.match(html, /join/);
  assert.match(html, /\?join=/);
});

test('README documents static-hosting and rendezvous limitations', async () => {
  const text = await read('README.md');
  assert.match(text, /GitHub Pages/i);
  assert.match(text, /rendezvous/i);
  assert.match(text, /WebRTC/i);
});

test('Codex construction-time review is not shipped as a stale release verdict', async () => {
  await assert.rejects(read('CODEX_REVIEW.md'));
});
