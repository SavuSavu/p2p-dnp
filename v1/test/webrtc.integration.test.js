import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { firefox } from 'playwright';

const baseUrl = 'http://127.0.0.1:4171/v1/';

async function waitForServer(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not start at ${url}`);
}

async function enterName(page, name) {
  await page.locator('#name').fill(name);
  await page.locator('#nameForm button').click();
}

async function exchangeManualSignals(host, guest) {
  await host.locator('#makeOffer').click();
  await host.locator('#signalOut').waitFor({ state: 'visible' });
  await host.waitForFunction(() => document.querySelector('#signalOut').value.length > 0);
  const offer = await host.locator('#signalOut').inputValue();
  await guest.locator('#signalIn').fill(offer);
  await guest.locator('#applySignal').click();
  await guest.waitForFunction(() => document.querySelector('#signalOut').value.length > 0);
  const answer = await guest.locator('#signalOut').inputValue();
  await host.locator('#signalIn').fill(answer);
  await host.locator('#applySignal').click();
}

test('two isolated Firefox pages complete manual WebRTC 1v1, replicate input, and clean up disconnect', { timeout: 60000 }, async (t) => {
  const server = spawn('python3', ['-m', 'http.server', '4171', '--bind', '127.0.0.1'], {
    cwd: new URL('../../', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => server.kill('SIGTERM'));
  await waitForServer(baseUrl);

  const browser = await firefox.launch({ headless: true });
  t.after(() => browser.close());
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const errors = [];
  host.on('pageerror', (error) => errors.push(`host: ${error.message}`));
  guest.on('pageerror', (error) => errors.push(`guest: ${error.message}`));

  await host.goto(baseUrl);
  await guest.goto(baseUrl);
  await enterName(host, 'Host');
  await enterName(guest, 'Guest');
  await host.locator('[data-mode="create"]').click();
  const code = await host.locator('#roomCode').textContent();
  await guest.locator('[data-mode="join"]').click();
  await guest.locator('#joinCode').fill(code);
  await guest.locator('#joinContinue').click();

  await exchangeManualSignals(host, guest);
  await host.waitForFunction(() => document.querySelector('#players').children.length === 2);
  await guest.waitForFunction(() => document.querySelector('#players').children.length === 2);
  assert.deepEqual(await host.locator('#players li span').allTextContents(), ['Host ◆', 'Guest']);
  assert.deepEqual(await guest.locator('#players li span').allTextContents(), ['Host ◆', 'Guest']);
  await host.waitForFunction(() => window.__dnp?.game?.ball && window.__dnp?.room?.players?.length === 2);
  await guest.waitForFunction(() => window.__dnp?.game?.ball && window.__dnp?.room?.players?.length === 2);

  await guest.waitForFunction(() => window.__dnp.game.score && window.__dnp.game.ball);
  await guest.waitForFunction(() => window.__dnp.game.score.left + window.__dnp.game.score.right > 0);
  const [hostScore, guestScore] = await Promise.all([
    host.evaluate(() => ({ ...window.__dnp.game.score })),
    guest.evaluate(() => ({ ...window.__dnp.game.score }))
  ]);
  assert.ok(Math.abs(hostScore.left - guestScore.left) <= 1, 'guest left score tracks host');
  assert.ok(Math.abs(hostScore.right - guestScore.right) <= 1, 'guest right score tracks host');
  const [hostBall, guestBall] = await Promise.all([
    host.evaluate(() => ({ ...window.__dnp.game.ball })),
    guest.evaluate(() => ({ ...window.__dnp.game.ball }))
  ]);
  assert.ok(Math.abs(hostBall.x - guestBall.x) < 80, 'guest ball tracks host authoritative state');
  assert.ok(Math.abs(hostBall.y - guestBall.y) < 80, 'guest ball tracks host authoritative state');

  await guest.keyboard.press('ArrowDown');
  await host.waitForFunction(() => window.__dnp.room.assignments.find((item) => item.name === 'Guest')?.input > 0.5);
  await guest.waitForFunction(() => window.__dnp.room.assignments.find((item) => item.name === 'Guest')?.input > 0.5);

  await guest.locator('#leaveRoom').click();
  await host.waitForFunction(() => document.querySelector('#players').children.length === 1);
  assert.deepEqual(await host.locator('#players li span').allTextContents(), ['Host ◆']);
  assert.deepEqual(errors, []);
});
