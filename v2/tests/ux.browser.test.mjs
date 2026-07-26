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
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v2/` };
}

async function identify(page, name) {
  await page.getByLabel('YOUR CALLSIGN').fill(name);
  await page.getByRole('button', { name: /ENTER THE ARENA/ }).click();
}

test('Join Room uses a visible validated room-code form instead of a native prompt', { timeout: 30000 }, async t => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.close());
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.on('dialog', dialog => dialog.dismiss());
  await page.goto(baseUrl);
  await identify(page, 'GUEST');

  await page.getByRole('button', { name: /JOIN ROOM/ }).click();
  const codeInput = page.getByLabel('ROOM CODE');
  assert.equal(await codeInput.isVisible(), true);
  await codeInput.fill('bad');
  await page.getByRole('button', { name: /CONTINUE TO ROOM/ }).click();
  assert.match(await page.getByRole('alert').textContent(), /six|invalid/i);

  await codeInput.fill('abc234');
  await page.getByRole('button', { name: /CONTINUE TO ROOM/ }).click();
  assert.equal(await page.locator('#room-code').textContent(), 'ABC234');
  assert.equal(await page.locator('#lobby').isVisible(), true);
});

test('host lobby explains the complete exchange, exposes role-aware actions, and reports offer progress', { timeout: 30000 }, async t => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.close());
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(baseUrl);
  await identify(page, 'HOST');
  await page.getByRole('button', { name: /CREATE ROOM/ }).click();

  const lobbyText = await page.locator('#lobby').textContent();
  assert.match(lobbyText, /HOST.*GENERATE.*OFFER.*SEND.*GUEST.*PASTE.*ANSWER/is);
  assert.match(lobbyText, /link alone.*room code.*offer.*answer/is);
  assert.equal(await page.getByRole('button', { name: /ANSWER.*OFFER/ }).isVisible(), false);
  assert.equal(await page.getByRole('button', { name: /START MATCH/ }).isDisabled(), true);
  assert.match(await page.locator('#net-status').textContent(), /LOCAL READY/i);

  await page.getByRole('button', { name: /CREATE PEER OFFER/ }).click();
  const generate = page.getByRole('button', { name: /GENERATE OFFER/ });
  await generate.click();
  assert.equal(await generate.isDisabled(), true);
  assert.match(await page.locator('#signal-status').textContent(), /GENERATING|GATHERING/i);
  await page.waitForFunction(() => document.querySelector('#signal-data').value.length > 100);
  assert.match(await page.locator('#signal-status').textContent(), /OFFER READY|PARTIAL CANDIDATES/i);
  assert.match(await page.locator('#signal-data').inputValue(), /\S{100}/);
});

test('visible host signaling reports partial candidates and still produces a shareable offer when ICE never completes', { timeout: 30000 }, async t => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.close());
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class NeverCompletingIcePeer extends Native {
      constructor(configuration) {
        super(configuration);
        Object.defineProperty(this, 'iceGatheringState', { configurable: true, get: () => 'gathering' });
      }
      addEventListener(type, listener, options) {
        if (type === 'icecandidate' || type === 'icegatheringstatechange') return;
        return super.addEventListener(type, listener, options);
      }
      removeEventListener(type, listener, options) {
        if (type === 'icecandidate' || type === 'icegatheringstatechange') return;
        return super.removeEventListener(type, listener, options);
      }
    };
    window.__dnpIceGatherTimeoutMs = 20;
  });
  await page.goto(baseUrl);
  await identify(page, 'HOST');
  await page.getByRole('button', { name: /CREATE ROOM/ }).click();
  await page.getByRole('button', { name: /CREATE PEER OFFER/ }).click();
  await page.getByRole('button', { name: /GENERATE OFFER/ }).click();
  await page.waitForFunction(() => document.querySelector('#signal-data').value.length > 100);
  const visibleStatus = await page.locator('#signal-status').textContent();
  assert.match(visibleStatus, /PARTIAL CANDIDATES/i);
  assert.match(visibleStatus, /TURN|RETRY/i);
  const decoded = await page.evaluate(() => {
    const value = document.querySelector('#signal-data').value.replaceAll('-', '+').replaceAll('_', '/');
    return JSON.parse(atob(value));
  });
  assert.equal(decoded.type, 'offer');
  assert.match(decoded.sdp, /v=0/);
});

test('resetting signaling suppresses stale in-flight ICE results from the retired session', { timeout: 30000 }, async t => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.close());
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.addInitScript(() => { window.__dnpIceGatherTimeoutMs = 1000; });
  await page.goto(baseUrl);
  await identify(page, 'HOST');
  await page.getByRole('button', { name: /CREATE ROOM/ }).click();
  await page.getByRole('button', { name: /CREATE PEER OFFER/ }).click();
  await page.getByRole('button', { name: /GENERATE OFFER/ }).click();
  await page.locator('.dialog-x').click();
  await page.getByRole('button', { name: /CREATE PEER OFFER/ }).click();
  await page.waitForTimeout(100);
  assert.match(await page.locator('#signal-status').textContent(), /^READY TO GENERATE OFFER$/i);
  assert.equal(await page.locator('#signal-data').inputValue(), '');
});

test('touch controls use vertical labels and move continuously while held, then stop on release', { timeout: 30000 }, async t => {
  const { server, baseUrl } = await startServer();
  t.after(() => server.close());
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await page.goto(baseUrl);
  await identify(page, 'TOUCH');
  await page.getByRole('button', { name: /SOLO/ }).click();
  const up = page.getByRole('button', { name: 'Move up' });
  const down = page.getByRole('button', { name: 'Move down' });
  assert.equal(await up.isVisible(), true);
  assert.equal(await down.isVisible(), true);
  assert.match(await up.textContent(), /UP|↑/i);
  assert.match(await down.textContent(), /DOWN|↓/i);

  await page.waitForFunction(() => window.__dnpV2?.game && document.querySelector('#countdown').textContent === '');
  const before = await page.evaluate(() => window.__dnpV2.game.players[0].position);
  const box = await down.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForFunction(value => window.__dnpV2.game.players[0].position > value + .02, before);
  await page.mouse.up();
  const released = await page.evaluate(() => window.__dnpV2.game.players[0].position);
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => window.__dnpV2.game.players[0].position);
  assert.ok(Math.abs(after - released) < .012);
});
