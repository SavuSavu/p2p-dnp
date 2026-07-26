import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { firefox } from 'playwright';

const url = 'http://127.0.0.1:4175/v1/?test=1';

async function waitForServer(timeoutMs = 10000, targetUrl = url) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(targetUrl)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start at ${url}`);
}

async function enterPrivateRoom(page, role) {
  await page.goto(url);
  await page.locator('#name').fill(role === 'host' ? 'Host' : 'Guest');
  await page.locator('#nameForm button').click();
  if (role === 'host') {
    await page.locator('[data-mode="create"]').click();
    return;
  }
  await page.locator('[data-mode="join"]').click();
  await page.locator('#joinCode').fill('ABC234');
  await page.locator('#joinContinue').click();
}

test('private-room first-time UX leads with a truthful waiting state and complete signaling script', { timeout: 60000 }, async (t) => {
  const server = spawn('python3', ['-m', 'http.server', '4175', '--bind', '127.0.0.1'], { cwd: new URL('../../', import.meta.url).pathname });
  t.after(() => server.kill('SIGTERM'));
  await waitForServer();
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());

  const host = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await enterPrivateRoom(host, 'host');

  assert.equal(await host.locator('.game-shell').getAttribute('data-connection-state'), 'waiting');
  assert.match(await host.locator('#gameMessage').textContent(), /waiting.*not.*connected/i);
  assert.equal(await host.locator('#makeOffer').isVisible(), true);
  const actionBox = await host.locator('.signaling').boundingBox();
  const courtBox = await host.locator('.game-shell').boundingBox();
  assert.ok(actionBox && courtBox && actionBox.y <= courtBox.y + 40, 'primary signaling action should be above or alongside the waiting court');

  const guide = await host.locator('#connectionGuide').innerText();
  assert.match(guide, /verified 1v1/i);
  assert.match(guide, /invite link alone does not connect/i);
  assert.match(guide, /offer.*answer.*chat/is);
  assert.match(guide, /12-player.*experimental.*local/is);
  assert.match(guide, /Reset \/ Retry closes the current P2P attempt/i);

  const hostSteps = await host.locator('#hostSteps li').allTextContents();
  const guestSteps = await host.locator('#guestSteps li').allTextContents();
  assert.equal(hostSteps.length, 5);
  assert.equal(guestSteps.length, 5);
  assert.match(hostSteps.join(' '), /invite.*create.*offer.*chat.*answer.*connected/i);
  assert.match(guestSteps.join(' '), /invite.*offer.*chat.*answer.*connected/i);

  const guest = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await enterPrivateRoom(guest, 'guest');
  assert.equal(await guest.locator('.game-shell').getAttribute('data-connection-state'), 'waiting');
  assert.match(await guest.locator('#gameMessage').textContent(), /waiting.*host offer.*not.*connected/i);
  assert.equal(await guest.locator('#applySignal').isVisible(), true);
});


test('multiplayer capacity copy does not present experimental 12-player layout as network-ready', async () => {
  const html = await (await import('node:fs/promises')).readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /Invite up to 11 peers/);
  assert.match(html, /verified 1v1/i);
  assert.match(html, /12-player[^<]*(experimental|local)/i);
});

test('visible timeout control produces a non-empty partial offer with TURN warning', { timeout: 60000 }, async (t) => {
  const server = spawn('python3', ['-m', 'http.server', '4176', '--bind', '127.0.0.1'], { cwd: new URL('../../', import.meta.url).pathname });
  t.after(() => server.kill('SIGTERM'));
  const timeoutUrl = 'http://127.0.0.1:4176/v1/?test=1';
  await waitForServer(10000, timeoutUrl);
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const page = await (await browser.newContext()).newPage();
  await page.goto(timeoutUrl);
  await page.locator('#name').fill('Host');
  await page.locator('#nameForm button').click();
  await page.locator('[data-mode="create"]').click();

  await page.locator('#iceTimeoutTest').click();
  assert.match(await page.locator('#iceStatus').textContent(), /timeout fallback enabled/i);
  await page.locator('#makeOffer').click();
  await page.waitForFunction(() => document.querySelector('#signalOut').value.length > 0);

  assert.ok((await page.locator('#signalOut').inputValue()).length > 0);
  assert.match(await page.locator('#iceStatus').textContent(), /partial candidates/i);
  assert.match(await page.locator('#iceWarning').textContent(), /TURN/i);
  assert.equal(await page.locator('#copySignal').isDisabled(), false);
});
