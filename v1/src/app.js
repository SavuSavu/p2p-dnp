import { sanitizeName, generateRoomCode, isRoomCode, createRoom, addPlayer, layoutForAssignment } from './model.js';
import { createGame, stepGame, moveAi, scoreSnapshot } from './game.js';
import { encodeSignal, decodeSignal, inviteUrl, matchmakingStatus } from './signaling.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const peerId = crypto.randomUUID();
let playerName = localStorage.getItem('dnp-name') || '';
let room = null;
let mode = '';
let game = createGame(900, 600);
let humanInput = 0.5;
let aiInput = 0.5;
let lastTime = performance.now();
let seq = 0;
let pendingPc = null;
let channels = [];
let guestRoomCode = '';

const canvas = $('#game');
const ctx = canvas.getContext('2d');
const views = ['gate', 'lobby', 'randomPanel', 'joinPanel', 'room'];
function show(id) { views.forEach((view) => $(`#${view}`).classList.toggle('hidden', view !== id)); }
function setMessage(text) { $('#gameMessage').textContent = text; }
function safeSend(channel, payload) { if (channel?.readyState === 'open') channel.send(JSON.stringify(payload)); }
function broadcast(payload) { channels.forEach((channel) => safeSend(channel, payload)); }

function enterLobby() {
  $('#playerName').textContent = playerName;
  show('lobby');
}

$('#nameForm').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    playerName = sanitizeName($('#name').value);
    localStorage.setItem('dnp-name', playerName);
    $('#nameError').textContent = '';
    enterLobby();
  } catch (error) { $('#nameError').textContent = error.message; }
});
$('#rename').addEventListener('click', () => { $('#name').value = playerName; show('gate'); });
$$('.back').forEach((button) => button.addEventListener('click', enterLobby));

function beginSingle(demo = false) {
  mode = 'single';
  room = createRoom(generateRoomCode(), { id: peerId, name: playerName });
  room = addPlayer(room, { id: 'local-ai', name: demo ? 'QUEUE BOT' : 'NOT-A-BOT' });
  game = createGame(900, 600);
  updateRoomUi();
  $('#roomCode').textContent = demo ? 'DEMO' : 'LOCAL';
  $('#adminBadge').textContent = 'OFFLINE';
  $('.signaling').classList.add('hidden');
  $('.invite').classList.add('hidden');
  setMessage(demo ? 'LOCAL DEMO OPPONENT FOUND' : '');
  show('room');
  setTimeout(() => setMessage(''), 1600);
}

function beginPrivate(code, creator) {
  mode = creator ? 'host' : 'guest';
  guestRoomCode = code;
  room = creator ? createRoom(code, { id: peerId, name: playerName }) : {
    code, adminId: null, players: [{ id: peerId, name: playerName }], assignments: [{ id: peerId, name: playerName, team: 'right', edge: 'side', half: 0 }]
  };
  game = createGame(900, 600);
  $('.signaling').classList.remove('hidden');
  $('.invite').classList.remove('hidden');
  $('#hostSignal').classList.toggle('hidden', !creator);
  $('#guestSignal').classList.toggle('hidden', creator);
  $('#adminBadge').textContent = creator ? 'ADMIN' : 'GUEST';
  $('#roomCode').textContent = code;
  $('#inviteLink').value = inviteUrl(location.href, code);
  updateRoomUi();
  setMessage(creator ? 'ROOM OPEN · CREATE AN OFFER TO CONNECT' : 'PASTE THE HOST OFFER BELOW');
  show('room');
}

$$('.mode-card').forEach((card) => card.addEventListener('click', () => {
  const selected = card.dataset.mode;
  if (selected === 'single') beginSingle();
  if (selected === 'random') { $('#matchStatus').textContent = matchmakingStatus(''); show('randomPanel'); }
  if (selected === 'create') beginPrivate(generateRoomCode(), true);
  if (selected === 'join') show('joinPanel');
}));
$('#randomDemo').addEventListener('click', () => beginSingle(true));
$('#joinContinue').addEventListener('click', () => {
  const code = $('#joinCode').value.trim().toUpperCase();
  if (!isRoomCode(code)) { $('#joinError').textContent = 'Use six characters: A–Z and 2–9 (excluding I, O, 0, 1).'; return; }
  $('#joinError').textContent = '';
  beginPrivate(code, false);
});
$('#leaveRoom').addEventListener('click', () => { channels.forEach((c) => c.close()); channels = []; pendingPc?.close(); pendingPc = null; room = null; mode = ''; enterLobby(); });

function updateRoomUi() {
  if (!room) return;
  $('#capacity').textContent = `${room.players.length} / 12`;
  $('#players').replaceChildren(...room.assignments.map((assignment, index) => {
    const li = document.createElement('li');
    const n = document.createElement('b'); n.textContent = String(index + 1).padStart(2, '0');
    const name = document.createElement('span'); name.textContent = assignment.name + (assignment.id === room.adminId ? ' ◆' : '');
    const slot = document.createElement('i'); slot.textContent = `${assignment.team.toUpperCase()} / ${assignment.edge.toUpperCase()}${assignment.half ? '-B' : '-A'}`;
    li.append(n, name, slot); return li;
  }));
}

function waitForIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5000);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); }
    });
  });
}

function makePeer() {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.addEventListener('connectionstatechange', () => {
    $('#rtcState').textContent = pc.connectionState;
    $('#netBadge').textContent = pc.connectionState === 'connected' ? 'P2P LIVE' : 'LOCAL';
  });
  return pc;
}

function attachChannel(channel, pc) {
  channels.push(channel);
  channel.addEventListener('open', () => {
    $('#rtcState').textContent = 'connected'; setMessage('DIRECT PEER CONNECTION ESTABLISHED');
    safeSend(channel, { type: 'hello', peer: { id: peerId, name: playerName }, code: guestRoomCode || room.code });
    if (mode === 'host') safeSend(channel, { type: 'room', room });
    setTimeout(() => setMessage(''), 1500);
  });
  channel.addEventListener('close', () => { channels = channels.filter((item) => item !== channel); });
  channel.addEventListener('message', (event) => handleNetwork(event.data, channel));
}

function handleNetwork(raw, channel) {
  let message; try { message = JSON.parse(raw); } catch { return; }
  if (message.type === 'hello' && mode === 'host' && message.code === room.code && room.players.length < 12) {
    try { room = addPlayer(room, message.peer); } catch { return; }
    updateRoomUi(); broadcast({ type: 'room', room });
  } else if (message.type === 'room' && mode === 'guest' && message.room?.code === guestRoomCode && Array.isArray(message.room.players) && message.room.players.length <= 12) {
    room = message.room; updateRoomUi(); setMessage('');
  } else if (message.type === 'input' && mode === 'host') {
    const assignment = room.assignments.find((a) => a.id === message.peerId);
    if (assignment && Number.isFinite(message.value)) assignment.input = Math.min(1, Math.max(0, message.value));
  } else if (message.type === 'state' && mode === 'guest') {
    if (message.snapshot?.ball && message.snapshot?.score) { Object.assign(game.ball, message.snapshot.ball); game.score = message.snapshot.score; }
    if (Array.isArray(message.inputs)) message.inputs.forEach(({ id, input }) => { const a = room.assignments.find((item) => item.id === id); if (a) a.input = input; });
  }
}

$('#makeOffer').addEventListener('click', async () => {
  try {
    const pc = makePeer(); const channel = pc.createDataChannel('dnp', { ordered: true }); attachChannel(channel, pc);
    await pc.setLocalDescription(await pc.createOffer()); await waitForIce(pc); pendingPc = pc;
    $('#signalOut').value = encodeSignal({ kind: 'offer', roomCode: room.code, name: playerName, description: pc.localDescription });
  } catch (error) { $('#rtcState').textContent = error.message; }
});
$('#applySignal').addEventListener('click', async () => {
  try {
    const signal = decodeSignal($('#signalIn').value.trim());
    if (signal.roomCode !== room.code) throw new Error('Signal belongs to another room');
    if (signal.kind === 'offer') {
      const pc = makePeer(); pc.addEventListener('datachannel', (event) => attachChannel(event.channel, pc));
      await pc.setRemoteDescription(signal.description); await pc.setLocalDescription(await pc.createAnswer()); await waitForIce(pc); pendingPc = pc;
      $('#signalOut').value = encodeSignal({ kind: 'answer', roomCode: room.code, name: playerName, description: pc.localDescription });
    } else if (signal.kind === 'answer' && pendingPc) { await pendingPc.setRemoteDescription(signal.description); }
    else throw new Error('Expected an offer, or create an offer before applying an answer');
    $('#rtcState').textContent = 'handshake applied';
  } catch (error) { $('#rtcState').textContent = error.message; }
});
async function copyFrom(selector, button) { try { await navigator.clipboard.writeText($(selector).value); const old = button.textContent; button.textContent = 'COPIED'; setTimeout(() => button.textContent = old, 1000); } catch { $(selector).select(); } }
$('#copySignal').addEventListener('click', (e) => copyFrom('#signalOut', e.currentTarget));
$('#copyInvite').addEventListener('click', (e) => copyFrom('#inviteLink', e.currentTarget));

function setInput(value) {
  humanInput = Math.min(1, Math.max(0, value));
  const mine = room?.assignments.find((a) => a.id === peerId); if (mine) mine.input = humanInput;
  if (mode === 'guest') broadcast({ type: 'input', peerId, seq: seq++, value: humanInput });
}
window.addEventListener('keydown', (event) => {
  if (!room) return;
  if (['w', 'ArrowUp', 'a', 'ArrowLeft'].includes(event.key)) setInput(humanInput - .05);
  if (['s', 'ArrowDown', 'd', 'ArrowRight'].includes(event.key)) setInput(humanInput + .05);
});
canvas.addEventListener('pointermove', (event) => {
  if (!room) return; const rect = canvas.getBoundingClientRect(); const mine = room.assignments.find((a) => a.id === peerId);
  setInput(mine?.edge === 'side' ? (event.clientY - rect.top) / rect.height : (event.clientX - rect.left) / rect.width);
});

function draw() {
  ctx.clearRect(0, 0, 900, 600); ctx.fillStyle = '#07090b'; ctx.fillRect(0, 0, 900, 600);
  ctx.strokeStyle = '#252a31'; ctx.setLineDash([8, 12]); ctx.beginPath(); ctx.moveTo(450, 0); ctx.lineTo(450, 600); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = '700 46px Space Grotesk'; ctx.fillStyle = '#252a31'; ctx.textAlign = 'center'; ctx.fillText(game.score.left, 390, 62); ctx.fillText(game.score.right, 510, 62);
  const paddles = [];
  if (room) room.assignments.forEach((assignment) => {
    const input = assignment.input ?? (assignment.id === peerId ? humanInput : .5);
    const paddle = layoutForAssignment(assignment, 900, 600, input, room.assignments.length >= 7); paddles.push(paddle);
    ctx.fillStyle = assignment.team === 'left' ? '#37e6e0' : '#ff4fa3'; ctx.fillRect(paddle.x, paddle.y, paddle.w, paddle.h);
    ctx.fillStyle = '#eef1ed'; ctx.font = '500 11px DM Mono'; ctx.textAlign = 'center';
    if (paddle.axis === 'y') { ctx.save(); ctx.translate(paddle.x + paddle.w / 2, paddle.y + paddle.h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(assignment.name.slice(0, 16), 0, 4); ctx.restore(); }
    else ctx.fillText(assignment.name.slice(0, 16), paddle.x + paddle.w / 2, paddle.y + 12);
  });
  ctx.fillStyle = '#f4da48'; ctx.beginPath(); ctx.arc(game.ball.x, game.ball.y, game.ball.r, 0, Math.PI * 2); ctx.fill();
  return paddles;
}
function loop(now) {
  const dt = Math.min(.033, (now - lastTime) / 1000); lastTime = now;
  if (room) {
    if (mode === 'single') { aiInput = moveAi(aiInput, game.ball.y, dt); room.assignments[1].input = aiInput; stepGame(game, dt, draw()); }
    else if (mode === 'host') { stepGame(game, dt, draw()); if (Math.floor(now / 50) !== Math.floor((now - dt * 1000) / 50)) broadcast({ type: 'state', snapshot: scoreSnapshot(game), inputs: room.assignments.map((a) => ({ id: a.id, input: a.input ?? .5 })) }); }
    draw();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

const joinFromUrl = new URL(location.href).searchParams.get('join')?.toUpperCase();
if (playerName) { $('#name').value = playerName; enterLobby(); if (isRoomCode(joinFromUrl)) { $('#joinCode').value = joinFromUrl; show('joinPanel'); } }
else { $('#name').value = ''; show('gate'); if (isRoomCode(joinFromUrl)) $('#joinCode').value = joinFromUrl; }
