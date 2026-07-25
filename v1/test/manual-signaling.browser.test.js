import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { firefox } from 'playwright';

const baseUrl = 'http://127.0.0.1:4172/v1/?test=1';

async function waitForServer(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start at ${url}`);
}

async function enterName(page, name) {
  await page.locator('#name').fill(name);
  await page.locator('#nameForm button').click();
}

async function createPair(browser) {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await host.goto(baseUrl);
  await guest.goto(baseUrl);
  await enterName(host, 'Host');
  await enterName(guest, 'Guest');
  await host.locator('[data-mode="create"]').click();
  const code = await host.locator('#roomCode').textContent();
  await guest.locator('[data-mode="join"]').click();
  await guest.locator('#joinCode').fill(code);
  await guest.locator('#joinContinue').click();
  return { host, guest };
}

async function createOffer(host) {
  await host.locator('#makeOffer').click();
  await host.waitForFunction(() => document.querySelector('#signalOut').value.length > 0);
  return host.locator('#signalOut').inputValue();
}

async function applyOffer(guest, offer) {
  await guest.locator('#signalIn').fill(offer);
  await guest.locator('#applySignal').click();
  await guest.waitForFunction(() => {
    const value = document.querySelector('#signalOut').value;
    if (!value) return false;
    try {
      const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
      return JSON.parse(atob(padded)).kind === 'answer';
    } catch { return false; }
  });
  return guest.locator('#signalOut').inputValue();
}

test('manual signaling shows numbered role steps, type labels, and phase-valid controls', { timeout: 60000 }, async (t) => {
  const server = spawn('python3', ['-m', 'http.server', '4172', '--bind', '127.0.0.1'], { cwd: new URL('../../', import.meta.url).pathname });
  t.after(() => server.kill('SIGTERM'));
  await waitForServer(baseUrl);
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const { host, guest } = await createPair(browser);

  assert.match(await host.locator('#negotiationStep').textContent(), /STEP 1 OF 3.*CREATE/i);
  assert.equal(await host.locator('#makeOffer').isDisabled(), false);
  assert.equal(await host.locator('#applySignal').isDisabled(), true);
  assert.equal(await host.locator('#signalOutType').textContent(), 'OFFER');
  assert.match(await guest.locator('#negotiationStep').textContent(), /STEP 1 OF 2.*HOST OFFER/i);
  assert.equal(await guest.locator('#makeOffer').count(), 1);
  assert.equal(await guest.locator('#makeOffer').isDisabled(), true);
  assert.equal(await guest.locator('#applySignal').isDisabled(), false);
  assert.equal(await guest.locator('#signalOutType').textContent(), 'ANSWER');
});

test('wrong-phase, self, duplicate, and stale signals are locally rejected and reset closes old transports', { timeout: 90000 }, async (t) => {
  const server = spawn('python3', ['-m', 'http.server', '4173', '--bind', '127.0.0.1'], { cwd: new URL('../../', import.meta.url).pathname });
  t.after(() => server.kill('SIGTERM'));
  await waitForServer('http://127.0.0.1:4173/v1/?test=1');
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await host.goto('http://127.0.0.1:4173/v1/?test=1');
  await guest.goto('http://127.0.0.1:4173/v1/?test=1');
  await enterName(host, 'Host'); await enterName(guest, 'Guest');
  await host.locator('[data-mode="create"]').click();
  const code = await host.locator('#roomCode').textContent();
  await guest.locator('[data-mode="join"]').click(); await guest.locator('#joinCode').fill(code); await guest.locator('#joinContinue').click();

  const offer1 = await createOffer(host);
  await host.locator('#signalIn').fill(offer1);
  await host.locator('#applySignal').click({ force: true });
  assert.match(await host.locator('#rtcState').textContent(), /own signal/i);
  assert.doesNotMatch(await host.locator('#rtcState').textContent(), /wrong state/i);

  const answer1 = await applyOffer(guest, offer1);
  await guest.locator('#signalIn').fill(answer1);
  await guest.locator('#applySignal').evaluate((button) => { button.disabled = false; button.click(); });
  assert.match(await guest.locator('#rtcState').textContent(), /Step 1|not valid now|own signal/i);

  await host.locator('#signalIn').fill(answer1);
  await host.locator('#applySignal').click();
  await host.waitForFunction(() => window.__dnp.negotiationDiagnostics.phase === 'connected');
  await host.locator('#signalIn').fill(answer1);
  await host.locator('#applySignal').evaluate((button) => { button.disabled = false; button.click(); });
  assert.match(await host.locator('#rtcState').textContent(), /already applied/i);

  await host.locator('#resetConnection').click();
  assert.equal(await host.locator('#signalIn').inputValue(), '');
  assert.equal(await host.locator('#signalOut').inputValue(), '');
  const afterReset = await host.evaluate(() => window.__dnp.negotiationDiagnostics);
  assert.equal(afterReset.phase, 'idle');
  assert.equal(afterReset.openPeerConnections, 0);
  assert.equal(afterReset.openChannels, 0);

  await createOffer(host);
  await host.locator('#signalIn').fill(answer1);
  await host.locator('#applySignal').click();
  assert.match(await host.locator('#rtcState').textContent(), /older connection attempt/i);
  assert.doesNotMatch(await host.locator('#rtcState').textContent(), /wrong state/i);
});

test('reset retry closes the first attempt and permits a fresh successful connection', { timeout: 90000 }, async (t) => {
  const server = spawn('python3', ['-m', 'http.server', '4174', '--bind', '127.0.0.1'], { cwd: new URL('../../', import.meta.url).pathname });
  t.after(() => server.kill('SIGTERM'));
  const url = 'http://127.0.0.1:4174/v1/?test=1';
  await waitForServer(url);
  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  await host.goto(url); await guest.goto(url);
  await enterName(host, 'Host'); await enterName(guest, 'Guest');
  await host.locator('[data-mode="create"]').click();
  const code = await host.locator('#roomCode').textContent();
  await guest.locator('[data-mode="join"]').click(); await guest.locator('#joinCode').fill(code); await guest.locator('#joinContinue').click();

  const abandonedOffer = await createOffer(host);
  await guest.locator('#signalIn').fill(abandonedOffer);
  await host.locator('#resetConnection').click();
  await guest.locator('#resetConnection').click();
  assert.equal((await host.evaluate(() => window.__dnp.negotiationDiagnostics)).openPeerConnections, 0);
  assert.equal((await guest.evaluate(() => window.__dnp.negotiationDiagnostics)).openPeerConnections, 0);

  const freshOffer = await createOffer(host);
  const freshAnswer = await applyOffer(guest, freshOffer);
  await host.locator('#signalIn').fill(freshAnswer);
  await host.locator('#applySignal').click();
  await host.waitForFunction(() => window.__dnp.negotiationDiagnostics.phase === 'connected');
  await guest.waitForFunction(() => window.__dnp.negotiationDiagnostics.phase === 'connected');
  await host.waitForFunction(() => document.querySelector('#players').children.length === 2);
  await guest.waitForFunction(() => document.querySelector('#players').children.length === 2);
});
