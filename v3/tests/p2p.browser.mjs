import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const base = process.env.V3_URL || 'http://127.0.0.1:4173/v3/?ice=local';
let server = null;
if (!process.env.V3_URL) {
  server = spawn('python3', ['-m', 'http.server', '4173', '--bind', '127.0.0.1'], {
    cwd: new URL('../../', import.meta.url).pathname,
    stdio: 'ignore'
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base);
      if (response.ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
const browser = await chromium.launch({ headless: true });
const hostContext = await browser.newContext();
const guestContext = await browser.newContext();
const host = await hostContext.newPage();
const guest = await guestContext.newPage();
const errors = [];
for (const page of [host, guest]) page.on('pageerror', error => errors.push(error.message));

async function enter(page, name) {
  await page.goto(base);
  await page.locator('#player-name').fill(name);
  await page.locator('#name-form button').click();
}

try {
  await enter(host, 'Host');
  await host.locator('#create').click();
  const code = await host.locator('#display-code').textContent();
  await host.locator('#create-offer').click();
  await host.waitForFunction(() => document.querySelector('#local-signal')?.value.length > 100);
  const offer = await host.locator('#local-signal').inputValue();
  assert.ok(offer.length > 100);

  await enter(guest, 'Guest');
  await guest.locator('#room-code').fill(code);
  await guest.locator('#join').click();
  await guest.locator('#remote-signal').fill(offer);
  await guest.locator('#apply-offer').click();
  await guest.waitForFunction(() => document.querySelector('#local-signal')?.value.length > 100);
  const answer = await guest.locator('#local-signal').inputValue();
  assert.ok(answer.length > 100);

  await host.locator('#remote-signal').fill(answer);
  await host.locator('#apply-answer').click();
  await host.locator('#player-count').waitFor();
  await host.waitForFunction(() => document.querySelector('#player-count')?.textContent === 'PLAYERS: 2/2');
  await guest.waitForFunction(() => document.querySelector('#player-count')?.textContent === 'PLAYERS: 2/2');
  await host.waitForFunction(() => window.__appDebug?.channelState === 'open');
  await guest.waitForFunction(() => window.__appDebug?.channelState === 'open');

  const before = await host.evaluate(() => window.__appDebug.players.find(p => p.name === 'Guest').position);
  await guest.keyboard.down('ArrowDown');
  await guest.waitForTimeout(250);
  await guest.keyboard.up('ArrowDown');
  await host.waitForFunction(beforeValue => window.__appDebug.players.find(p => p.name === 'Guest')?.position > beforeValue, before);

  await guest.locator('#exit').click();
  await host.waitForFunction(() => document.querySelector('#player-count')?.textContent === 'PLAYERS: 1/2');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ offer: true, answer: true, channel: 'open', roster: '2/2', guestInputReplicated: true, disconnectCleanup: '1/2', pageErrors: errors }));
} finally {
  await hostContext.close();
  await guestContext.close();
  await browser.close();
  server?.kill('SIGTERM');
}
