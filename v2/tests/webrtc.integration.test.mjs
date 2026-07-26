import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { firefox } from 'playwright';

const root = new URL('../../', import.meta.url).pathname;

async function startServer() {
  const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
      const file = normalize(join(root, relative.endsWith('/') ? `${relative}index.html` : relative));
      if (!file.startsWith(root)) throw new Error('invalid path');
      response.setHeader('content-type', types[extname(file)] || 'application/octet-stream');
      response.end(await readFile(file));
    } catch {
      response.statusCode = 404;
      response.end('not found');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}/v2/` };
}

async function waitForServer(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start at ${url}`);
}

async function identify(page, name) {
  await page.locator('#player-name').fill(name);
  await page.locator('#continue-btn').click();
}

async function exchangeSignals(host, guest) {
  await host.locator('#host-signal').click();
  await host.locator('#signal-next').click();
  await host.waitForFunction(() => document.querySelector('#signal-data').value.length > 0);
  const offer = await host.locator('#signal-data').inputValue();

  await guest.locator('#join-signal').click();
  await guest.locator('#signal-data').fill(offer);
  await guest.locator('#signal-next').click();
  await guest.waitForFunction(() => {
    const value = document.querySelector('#signal-data').value;
    if (!value) return false;
    try {
      const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
      return JSON.parse(atob(normalized)).type === 'answer';
    } catch { return false; }
  });
  const answer = await guest.locator('#signal-data').inputValue();
  await guest.locator('#signal-next').click();

  await host.locator('#signal-data').fill(answer);
  await host.locator('#signal-next').click();
}

test('two isolated browsers complete manual WebRTC, play host-authoritative 1v1, replicate state, and clean disconnect', { timeout: 60000 }, async t => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.close());
  await waitForServer(baseUrl);

  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const hostPage = await hostContext.newPage();
  const guestPage = await guestContext.newPage();
  const errors = [];
  hostPage.on('pageerror', error => errors.push(`host: ${error.message}`));
  guestPage.on('pageerror', error => errors.push(`guest: ${error.message}`));

  await hostPage.goto(baseUrl);
  await guestPage.goto(baseUrl);
  await identify(hostPage, 'HOST');
  await identify(guestPage, 'GUEST');
  await hostPage.locator('#create-btn').click();
  const code = await hostPage.locator('#room-code').textContent();
  await guestPage.goto(`${baseUrl}?join=${code}`);
  await identify(guestPage, 'GUEST');

  await exchangeSignals(hostPage, guestPage);
  await hostPage.waitForFunction(() => window.__dnpV2?.room?.players?.length === 2);
  await guestPage.waitForFunction(() => window.__dnpV2?.room?.players?.length === 2);
  assert.deepEqual(await hostPage.locator('#roster .player-row b').allTextContents(), ['HOST', 'GUEST']);
  assert.deepEqual(await guestPage.locator('#roster .player-row b').allTextContents(), ['HOST', 'GUEST']);

  await hostPage.locator('#start-room').click();
  await hostPage.waitForFunction(() => window.__dnpV2?.game?.players?.length === 2);
  await guestPage.waitForFunction(() => window.__dnpV2?.game?.players?.length === 2);
  const before = await hostPage.evaluate(() => window.__dnpV2.game.players[1].position);
  await guestPage.keyboard.down('ArrowDown');
  await hostPage.waitForFunction(value => window.__dnpV2.game.players[1].position > value + .02, before);
  await guestPage.keyboard.up('ArrowDown');

  const [hostState, guestState] = await Promise.all([
    hostPage.evaluate(() => ({ ball: { ...window.__dnpV2.game.ball }, score: [...window.__dnpV2.game.score], names: window.__dnpV2.game.players.map(p => p.name) })),
    guestPage.evaluate(() => ({ ball: { ...window.__dnpV2.game.ball }, score: [...window.__dnpV2.game.score], names: window.__dnpV2.game.players.map(p => p.name) }))
  ]);
  assert.deepEqual(hostState.names, ['HOST', 'GUEST']);
  assert.deepEqual(guestState.names, ['HOST', 'GUEST']);
  assert.ok(Math.abs(hostState.ball.x - guestState.ball.x) < .08);
  assert.ok(Math.abs(hostState.ball.y - guestState.ball.y) < .08);
  assert.ok(Math.abs(hostState.score[0] - guestState.score[0]) <= 1);
  assert.ok(Math.abs(hostState.score[1] - guestState.score[1]) <= 1);

  await guestPage.getByRole('button', { name: '← LEAVE' }).click();
  await hostPage.waitForFunction(() => window.__dnpV2?.room?.players?.length === 1);
  await hostPage.waitForFunction(() => window.__dnpV2?.paused === true && window.__dnpV2?.connected === false);
  const ballWhenPaused = await hostPage.evaluate(() => ({ ...window.__dnpV2.game.ball }));
  await hostPage.waitForTimeout(150);
  const disconnected = await hostPage.evaluate(() => ({
    ball: { ...window.__dnpV2.game.ball },
    assignments: window.__dnpV2.room.assignments,
    status: document.querySelector('#net-status').textContent,
    notice: document.querySelector('#disconnect-notice').textContent,
    actionVisible: !document.querySelector('#disconnect-action').classList.contains('hidden')
  }));
  assert.deepEqual(disconnected.ball, ballWhenPaused);
  assert.equal(disconnected.assignments.length, 1);
  assert.equal(disconnected.assignments[0].input, 0);
  assert.match(disconnected.status, /DISCONNECTED/i);
  assert.match(disconnected.notice, /PEER DISCONNECTED/i);
  assert.equal(disconnected.actionVisible, true);
  await hostPage.locator('#disconnect-action').click();
  await hostPage.waitForFunction(() => !document.querySelector('#lobby').classList.contains('hidden'));
  assert.equal(await hostPage.locator('#start-room').isVisible(), true);
  assert.equal(await hostPage.locator('#host-signal').isVisible(), true);
  assert.deepEqual(await hostPage.locator('#roster .player-row:not(.open) b').allTextContents(), ['HOST']);
  assert.deepEqual(errors, []);
});
