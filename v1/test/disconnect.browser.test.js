import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { firefox } from 'playwright';

const repoRoot = path.resolve(new URL('../../', import.meta.url).pathname);

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const requested = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
      const file = path.resolve(repoRoot, `.${requested}`);
      if (!file.startsWith(repoRoot)) throw new Error('outside root');
      const body = await readFile(file);
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      response.writeHead(200, { 'content-type': type });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/v1/?test=1` };
}

async function enterName(page, name) {
  await page.locator('#name').fill(name);
  await page.locator('#nameForm button').click();
}

async function connectPair(browser, url) {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await host.goto(url);
  await guest.goto(url);
  await enterName(host, 'Host');
  await enterName(guest, 'Guest');
  await host.locator('[data-mode="create"]').click();
  const code = await host.locator('#roomCode').textContent();
  await guest.locator('[data-mode="join"]').click();
  await guest.locator('#joinCode').fill(code);
  await guest.locator('#joinContinue').click();
  await host.locator('#makeOffer').click();
  await host.waitForFunction(() => document.querySelector('#signalOut').value.length > 0);
  await guest.locator('#signalIn').fill(await host.locator('#signalOut').inputValue());
  await guest.locator('#applySignal').click();
  await guest.waitForFunction(() => document.querySelector('#signalOut').value.length > 0);
  await host.locator('#signalIn').fill(await guest.locator('#signalOut').inputValue());
  await host.locator('#applySignal').click();
  await host.waitForFunction(() => window.__dnp.negotiationDiagnostics.phase === 'connected');
  await guest.waitForFunction(() => window.__dnp.negotiationDiagnostics.phase === 'connected');
  await host.waitForFunction(() => window.__dnp.room?.players?.length === 2);
  await guest.waitForFunction(() => window.__dnp.room?.players?.length === 2);
  return { host, guest };
}

async function assertTransportClean(page) {
  const diagnostics = await page.evaluate(() => window.__dnp.negotiationDiagnostics);
  assert.equal(diagnostics.openChannels, 0);
  assert.equal(diagnostics.openPeerConnections, 0);
}

test('host leave visibly disconnects guest within one second and invalidates stale authority', { timeout: 60000 }, async (t) => {
  const { server, url } = await startServer();
  t.after(() => server.close());
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const { host, guest } = await connectPair(browser, url);

  const started = Date.now();
  await host.locator('#leaveRoom').click();
  await guest.waitForFunction(() => document.querySelector('#gameMessage').textContent.includes('Host disconnected'), null, { timeout: 1000 });
  assert.ok(Date.now() - started < 1000, 'guest disconnect UI updates within one second');
  assert.equal(await guest.locator('#rtcState').textContent(), 'disconnected');
  assert.equal(await guest.locator('#netBadge').textContent(), 'LOCAL');
  assert.deepEqual(await guest.locator('#players li span').allTextContents(), ['Guest']);
  assert.equal(await guest.evaluate(() => window.__dnp.room.adminId), null);
  assert.equal(await guest.locator('#resetConnection').isVisible(), true);
  await assertTransportClean(guest);
  await assertTransportClean(host);
  await guest.locator('#resetConnection').click();
  assert.equal((await guest.evaluate(() => window.__dnp.negotiationDiagnostics)).phase, 'waiting-offer');
  assert.equal(await guest.locator('#applySignal').isDisabled(), false);
});

test('guest leave removes host roster and leaves badge and transports consistent', { timeout: 60000 }, async (t) => {
  const { server, url } = await startServer();
  t.after(() => server.close());
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const { host, guest } = await connectPair(browser, url);

  const started = Date.now();
  await guest.locator('#leaveRoom').click();
  await host.waitForFunction(() => window.__dnp.room?.players?.length === 1, null, { timeout: 1000 });
  assert.ok(Date.now() - started < 1000, 'host roster updates within one second');
  assert.deepEqual(await host.locator('#players li span').allTextContents(), ['Host ◆']);
  assert.equal(await host.locator('#capacity').textContent(), '1 / 12');
  assert.equal(await host.locator('#netBadge').textContent(), 'LOCAL');
  assert.equal(await host.locator('#rtcState').textContent(), 'disconnected');
  await assertTransportClean(host);
  await assertTransportClean(guest);
});
