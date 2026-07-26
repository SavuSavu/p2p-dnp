import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

let base = process.env.V3_URL;
let server = null;
if (!base) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const types = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json' };
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      let file = normalize(join(root, relative));
      if (!file.startsWith(root)) throw new Error('outside root');
      if (pathname.endsWith('/')) file = join(file, 'index.html');
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' }); response.end(body);
    } catch { response.writeHead(404); response.end('Not found'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  base = `http://127.0.0.1:${port}/v3/?ice=local&test=1&iceGrace=500`;
}
const browser = await chromium.launch({ headless: true });
const hostContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const guestContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const host = await hostContext.newPage();
const guest = await guestContext.newPage();
const errors = [];
for (const page of [host, guest]) page.on('pageerror', error => errors.push(error.message));
await host.addInitScript(() => {
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    get iceGatheringState() { return 'gathering'; }
  };
});

async function enter(page, name) {
  await page.goto(base);
  await page.locator('#player-name').fill(name);
  await page.locator('#name-form button').click();
}

try {
  await enter(host, 'Host');
  await host.locator('#create').click();
  assert.match(await host.locator('#signaling-phase').textContent(), /HOST · STEP 1/i);
  assert.equal(await host.locator('#waiting-court').isVisible(), true);
  assert.equal(await host.locator('#arena').isVisible(), false);
  const initialScore = await host.locator('.score').textContent();
  const code = await host.locator('#display-code').textContent();
  await host.locator('#create-offer').click();
  await host.locator('#reset-signal').click();
  await host.waitForTimeout(650);
  assert.equal(await host.locator('#local-signal').inputValue(), '');
  assert.match(await host.locator('#signaling-phase').textContent(), /HOST · STEP 1/i);
  await host.locator('#create-offer').click();
  await host.waitForFunction(() => document.querySelector('#local-signal')?.value.length > 100);
  const offer = await host.locator('#local-signal').inputValue();
  assert.ok(offer.length > 100);
  assert.match(await host.locator('#signal-status').textContent(), /partial candidates.*TURN/i);
  assert.match(await host.locator('#signaling-phase').textContent(), /HOST · STEP 3/i);
  assert.equal(await host.locator('.score').textContent(), initialScore);
  await host.locator('#copy-signal').click();
  await host.waitForFunction(() => document.querySelector('#signal-status')?.textContent.includes('copied'));
  assert.match(await host.locator('#signal-status').textContent(), /copied/i);

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
  await host.waitForFunction(() => document.querySelector('#signaling-phase')?.textContent.includes('PEER CONNECTED'));
  assert.equal(await host.locator('#arena').isVisible(), true);
  assert.equal(await host.locator('#waiting-court').isVisible(), false);

  const before = await host.evaluate(() => window.__appDebug.players.find(p => p.name === 'Guest').position);
  await guest.keyboard.down('ArrowDown');
  await guest.waitForTimeout(250);
  await guest.keyboard.up('ArrowDown');
  await host.waitForFunction(beforeValue => window.__appDebug.players.find(p => p.name === 'Guest')?.position > beforeValue, before);

  await host.evaluate(() => window.__appDebug.pauseSnapshots());
  await guest.waitForFunction(() => window.__appDebug?.channelState === 'open' && window.__appDebug?.health?.status === 'stale');
  assert.match(await guest.locator('#snapshot-state').textContent(), /AGE: \d+ms · STALE/);
  await guest.waitForFunction(() => window.__appDebug?.channelState === 'open' && window.__appDebug?.health?.status === 'disconnected');
  assert.match(await guest.locator('#snapshot-state').textContent(), /DISCONNECTED/);
  assert.match(await guest.locator('#signal-status').textContent(), /snapshot-timeout/);

  await host.evaluate(() => window.__appDebug.setPacketLimit(3));
  await guest.evaluate(() => {
    window.__appDebug.sendRaw('{bad');
    window.__appDebug.sendRaw(JSON.stringify({ v: 3, type: 'hello', room: window.__appDebug.code, epoch: 1, peerId: window.__appDebug.localId, name: 'Guest', seq: 0 }));
    window.__appDebug.sendRaw('{still-bad');
    window.__appDebug.sendRaw('{over-budget');
  });
  await host.waitForFunction(() => document.querySelector('#signal-status')?.textContent.includes('packet-budget-exceeded'));
  assert.match(await host.locator('#channel-health').textContent(), /REASON PACKET-BUDGET-EXCEEDED/);

  await host.waitForFunction(() => document.querySelector('#player-count')?.textContent === 'PLAYERS: 1/2');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ offer: 'partial-timeout-fallback', answer: true, channel: 'open', roster: '2/2', guestInputReplicated: true,
    snapshotHealth: 'healthy→stale→disconnected while open', protocolClosureReason: 'packet-budget-exceeded', disconnectCleanup: '1/2', pageErrors: errors }));
} finally {
  await hostContext.close();
  await guestContext.close();
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
