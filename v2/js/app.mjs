import { normalizeName, createRoomCode, normalizeRoomCode } from './core.mjs';
import { createGame, stepGame, paddleGeometry } from './game.mjs';
import { createPeerSession } from './peer.mjs';
import {
  makeHello, makeInput, makeRoom, makeState, serializePacket,
  createHostSession, createGuestSession, receiveHostMessage, receiveGuestMessage, disconnectHostChannel
} from './network.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const views = ['home', 'lobby', 'game'];
const canvas = $('#arena');
const ctx = canvas.getContext('2d');
let name = '';
let identity = null;
let room = null;
let hostSession = null;
let guestSession = null;
let game = null;
let peer = null;
let role = 'local';
let raf = 0;
let last = 0;
let paused = false;
let input = 0;
let inputSeq = 0;
let stateSeq = 0;
let countdown = 0;
let lastInputSentAt = 0;
let lastStateSentAt = 0;

const show = id => views.forEach(view => $(`#${view}`).classList.toggle('hidden', view !== id));
const escapeHTML = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const toast = message => {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  setTimeout(() => $('#toast').classList.remove('show'), 1800);
};
const debug = () => {
  window.__dnpV2 = { role, identity, room, game, connected: peer?.ready() === true };
};

function createIdentity(playerName) {
  return { id: crypto.randomUUID().replaceAll('-', ''), name: playerName };
}

function submitName() {
  try {
    name = normalizeName($('#player-name').value);
    identity = createIdentity(name);
    $('#name-error').textContent = '';
    $('#welcome-name').textContent = name.toUpperCase();
    $('#name-gate').classList.add('hidden');
    $('#mode-picker').classList.remove('hidden');
    localStorage.setItem('dnp-name', name);
    debug();
  } catch (error) {
    $('#name-error').textContent = error.message.toUpperCase();
  }
}

$('#continue-btn').onclick = submitName;
$('#player-name').oninput = event => { $('#name-count').textContent = `${[...event.target.value].length}/16`; };
$('#player-name').onkeydown = event => { if (event.key === 'Enter') submitName(); };
const saved = localStorage.getItem('dnp-name');
if (saved) {
  $('#player-name').value = saved;
  $('#name-count').textContent = `${[...saved].length}/16`;
}

function makeInitialRoom(code) {
  return {
    code,
    adminId: identity.id,
    players: [identity],
    assignments: [{ id: identity.id, playerIndex: 0, team: 'left', edge: 'left', input: 0 }]
  };
}

function openLobby(code, admin) {
  role = admin ? 'host' : 'guest';
  room = admin ? makeInitialRoom(code) : { code, adminId: '', players: [identity], assignments: [] };
  hostSession = admin ? createHostSession(room) : null;
  guestSession = null;
  $('#room-code').textContent = code;
  $('#admin-badge').classList.toggle('hidden', !admin);
  $('#start-room').classList.toggle('hidden', !admin);
  history.replaceState({}, '', `?join=${code}`);
  renderRoster();
  show('lobby');
  debug();
}

function renderRoster() {
  const players = room?.players || [];
  const assignments = room?.assignments || [];
  $('#player-total').textContent = `${players.length}/2`;
  $('#roster').innerHTML = players.map(player => {
    const assignment = assignments.find(item => item.id === player.id);
    const admin = player.id === room.adminId ? 'ADMIN · ' : '';
    const side = assignment ? `${assignment.edge.toUpperCase()} ${assignment.team.toUpperCase()}` : 'CONNECTING';
    return `<div class="player-row"><i></i><b>${escapeHTML(player.name)}</b><span>${admin}${side}</span></div>`;
  }).join('') + Array.from({ length: 2 - players.length }, () => '<div class="player-row open"><i style="background:#30374a"></i><b style="color:#566077">OPEN SLOT</b><span>WAITING</span></div>').join('');
  debug();
}

function startMatch() {
  if (role !== 'host' || room.players.length !== 2) {
    toast('CONNECT ONE PEER BEFORE STARTING');
    return;
  }
  cancelAnimationFrame(raf);
  game = createGame(room.players.map(player => player.name));
  game.players.forEach(player => { player.ai = false; });
  $('#match-label').textContent = `ROOM ${room.code} // FIRST TO 7`;
  $('#result').classList.add('hidden');
  $('#score-left').textContent = '0';
  $('#score-right').textContent = '0';
  paused = false;
  countdown = .3;
  stateSeq = 0;
  show('game');
  broadcastState();
  last = performance.now();
  raf = requestAnimationFrame(loop);
  debug();
}

function startSolo() {
  role = 'local';
  room = null;
  game = createGame([name, 'DNP-9000']);
  game.players[1].ai = true;
  $('#match-label').textContent = 'SOLO // FIRST TO 7';
  $('#result').classList.add('hidden');
  paused = false;
  countdown = 3;
  show('game');
  last = performance.now();
  raf = requestAnimationFrame(loop);
  debug();
}

$('#single-btn').onclick = startSolo;
$('#random-btn').onclick = () => { toast('RENDEZVOUS NOT CONFIGURED · TRY MANUAL P2P'); openLobby(createRoomCode(), false); };
$('#create-btn').onclick = () => openLobby(createRoomCode(), true);
$('#join-btn').onclick = () => {
  const raw = prompt('ENTER SIX-CHARACTER ROOM CODE');
  if (!raw) return;
  try { openLobby(normalizeRoomCode(raw), false); } catch (error) { toast(error.message.toUpperCase()); }
};
$('#start-room').onclick = startMatch;
$('#copy-invite').onclick = async () => { await navigator.clipboard.writeText(location.href); toast('INVITE LINK COPIED'); };

function sendPacket(message) {
  return peer?.send(serializePacket(message)) === true;
}

function broadcastRoom() {
  if (role === 'host' && peer?.ready()) sendPacket(makeRoom(room.code, identity.id, room));
}

function broadcastState() {
  if (role === 'host' && peer?.ready() && game) sendPacket(makeState(room.code, identity.id, stateSeq++, game));
}

function handleHostRaw(raw, channelId) {
  const result = receiveHostMessage(hostSession, channelId, raw, performance.now());
  hostSession = result.session;
  room = hostSession.room;
  if (result.closeChannel) return peer?.close();
  if (result.broadcastRoom) broadcastRoom();
  if (result.broadcastState && game) broadcastState();
  renderRoster();
}

function handleGuestRaw(raw, channelId) {
  const result = receiveGuestMessage(guestSession, channelId, raw, performance.now());
  guestSession = result.session;
  if (result.closeChannel) return peer?.close();
  if (!result.accepted) return;
  if (guestSession.room) {
    room = guestSession.room;
    renderRoster();
  }
  if (guestSession.snapshot) {
    game = guestSession.snapshot;
    if ($('#game').classList.contains('hidden')) {
      $('#match-label').textContent = `ROOM ${room.code} // FIRST TO 7`;
      $('#result').classList.add('hidden');
      show('game');
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  }
  debug();
}

function handlePeerOpen(channelId) {
  if (role === 'guest') guestSession = createGuestSession(room.code, identity, channelId);
  sendPacket(makeHello(room.code, identity));
  debug();
}

function handlePeerClose(channelId) {
  if (role === 'host' && hostSession) {
    const result = disconnectHostChannel(hostSession, channelId);
    hostSession = result.session;
    room = hostSession.room;
    if (result.broadcastRoom) broadcastRoom();
    renderRoster();
  }
  debug();
}

function setupSignal(initiator) {
  const dialog = $('#signal-dialog');
  const area = $('#signal-data');
  const expectedRole = initiator ? 'host' : 'guest';
  if (role !== expectedRole) {
    toast(initiator ? 'CREATE A ROOM TO HOST' : 'JOIN A ROOM TO ANSWER');
    return;
  }
  peer?.close();
  peer = createPeerSession({
    initiator,
    onStatus: status => { $('#net-status').textContent = status.toUpperCase(); },
    onOpen: handlePeerOpen,
    onRawMessage: initiator ? handleHostRaw : handleGuestRaw,
    onClose: handlePeerClose
  });
  dialog.showModal();
  area.value = '';
  if (initiator) {
    $('#signal-title').textContent = 'Create an offer';
    $('#signal-help').textContent = 'Generate, copy, and send this offer to your peer. Then paste their answer here.';
    $('#signal-next').textContent = 'GENERATE OFFER';
    let phase = 0;
    $('#signal-next').onclick = async () => {
      try {
        if (phase === 0) {
          area.value = await peer.createOffer();
          $('#signal-next').textContent = 'ACCEPT PASTED ANSWER';
          phase = 1;
        } else {
          await peer.acceptAnswer(area.value);
          dialog.close();
        }
      } catch { toast('INVALID OR EXPIRED SIGNAL'); }
    };
  } else {
    $('#signal-title').textContent = 'Answer an offer';
    $('#signal-help').textContent = 'Paste the room creator’s offer. Generate an answer, then copy it back to them.';
    $('#signal-next').textContent = 'GENERATE ANSWER';
    $('#signal-next').onclick = async () => {
      try {
        area.value = await peer.acceptOffer(area.value);
        $('#signal-next').textContent = 'DONE';
        $('#signal-next').onclick = () => dialog.close();
      } catch { toast('INVALID OR EXPIRED SIGNAL'); }
    };
  }
  debug();
}

$('#host-signal').onclick = () => setupSignal(true);
$('#join-signal').onclick = () => setupSignal(false);
$('#signal-copy').onclick = async () => { await navigator.clipboard.writeText($('#signal-data').value); toast('SIGNAL COPIED'); };

function goHome() {
  cancelAnimationFrame(raf);
  const oldPeer = peer;
  peer = null;
  oldPeer?.close();
  hostSession = null;
  guestSession = null;
  game = null;
  room = null;
  role = 'local';
  history.replaceState({}, '', location.pathname);
  show('home');
  debug();
}
$$('[data-home]').forEach(button => { button.onclick = goHome; });

function resize() {
  const rect = canvas.getBoundingClientRect();
  const density = Math.min(devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * density);
  const height = Math.round(rect.height * density);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
}

function loop(now) {
  resize();
  const dt = Math.min((now - last) / 1000, .033);
  last = now;
  if (!paused && game) {
    if (countdown > 0) countdown -= dt;
    else if (role !== 'guest') {
      const remote = room?.assignments?.[1]?.input || 0;
      game = stepGame(game, dt, new Map([[0, input], [1, remote]]));
      if (role === 'host' && now - lastStateSentAt >= 33) {
        lastStateSentAt = now;
        broadcastState();
      }
    } else if (peer?.ready() && now - lastInputSentAt >= 34) {
      lastInputSentAt = now;
      sendPacket(makeInput(room.code, identity.id, input, inputSeq++));
    }
  }
  if (game) draw();
  debug();
  if (game?.winner !== null) { showResult(); return; }
  raf = requestAnimationFrame(loop);
}

function draw() {
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#060910';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#1a3340';
  const gap = 14 * (width / 1280);
  ctx.setLineDash([gap, gap]);
  ctx.beginPath(); ctx.moveTo(width / 2, 0); ctx.lineTo(width / 2, height); ctx.stroke(); ctx.setLineDash([]);
  for (const player of game.players) {
    const geometry = paddleGeometry(player, width, height);
    const color = player.team === 'left' ? '#39f6df' : '#ff3d9f';
    ctx.shadowColor = color; ctx.shadowBlur = 18; ctx.fillStyle = color;
    ctx.fillRect(geometry.x, geometry.y, geometry.w, geometry.h); ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff'; ctx.font = `600 ${Math.max(8, width / 115)}px IBM Plex Mono`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.save(); ctx.translate(geometry.x + geometry.w / 2, geometry.y + geometry.h / 2); ctx.rotate(-Math.PI / 2);
    ctx.fillText(player.name.toUpperCase().slice(0, 16), 0, 0, Math.max(35, geometry.h - 6)); ctx.restore();
  }
  const ball = game.ball;
  ctx.shadowColor = '#fff'; ctx.shadowBlur = 22; ctx.fillStyle = '#fff'; ctx.beginPath();
  ctx.arc(ball.x * width, ball.y * height, ball.r * Math.min(width, height), 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
  $('#score-left').textContent = game.score[0];
  $('#score-right').textContent = game.score[1];
  $('#countdown').textContent = countdown > 0 ? Math.ceil(countdown) : '';
}

function showResult() {
  cancelAnimationFrame(raf);
  $('#result-title').textContent = game.winner === 0 ? 'CYAN WINS' : 'MAGENTA WINS';
  $('#result-title').style.color = game.winner === 0 ? 'var(--cyan)' : 'var(--pink)';
  $('#result').classList.remove('hidden');
}

$('#rematch-btn').onclick = () => { if (role === 'host') startMatch(); else if (role === 'local') startSolo(); };
$('#pause-btn').onclick = () => { paused = !paused; $('#pause-btn').textContent = paused ? '▶' : 'Ⅱ'; };
const setKey = (event, value) => {
  if (['ArrowUp', 'w', 'W', 'a', 'A'].includes(event.key)) input = -value;
  if (['ArrowDown', 's', 'S', 'd', 'D'].includes(event.key)) input = value;
  if (event.key === ' ' && value) { paused = !paused; event.preventDefault(); }
};
addEventListener('keydown', event => setKey(event, 1));
addEventListener('keyup', event => setKey(event, 0));
$$('#touch-controls button').forEach(button => {
  const value = Number(button.dataset.dir);
  button.onpointerdown = event => { event.preventDefault(); input = value; button.setPointerCapture(event.pointerId); };
  button.onpointerup = button.onpointercancel = () => { input = 0; };
});
canvas.onpointerdown = event => {
  const rect = canvas.getBoundingClientRect();
  input = event.clientY < rect.top + rect.height / 2 ? -1 : 1;
};
canvas.onpointerup = canvas.onpointercancel = () => { input = 0; };

const join = new URLSearchParams(location.search).get('join');
if (join) {
  $('#player-name').focus();
  $('#continue-btn').addEventListener('click', () => setTimeout(() => {
    try { openLobby(normalizeRoomCode(join), false); } catch { toast('INVALID ROOM CODE'); }
  }, 0), { once: true });
}
debug();
