import { sanitizeName, generateRoomCode, isRoomCode, createRoom, addPlayer, layoutForAssignment } from './model.js';
import { createGame, stepGame, moveAi, scoreSnapshot } from './game.js';
import { encodeSignal, decodeSignal, inviteUrl, matchmakingStatus } from './signaling.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { createHostSession, createGuestSession, receiveHostMessage, receiveGuestMessage, disconnectHostChannel } from './session.js';
import { createNegotiation, offerCreated, offerShared, acceptRemoteSignal, resetNegotiation, markConnected, negotiationView } from './negotiation.js';
import { waitForIceGathering } from './ice.js';

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
let stateSeq = 0;
let pendingPc = null;
let channels = [];
let guestRoomCode = '';
let networkSession = null;
let negotiation = null;
let peerConnections = [];
let transportGeneration = 0;
let forceIceTimeout = false;
const channelIds = new WeakMap();
const channelOwners = new WeakMap();

const canvas = $('#game');
const ctx = canvas.getContext('2d');
const views = ['gate', 'lobby', 'randomPanel', 'joinPanel', 'room'];
function show(id) { views.forEach((view) => $(`#${view}`).classList.toggle('hidden', view !== id)); }
function setMessage(text) { $('#gameMessage').textContent = text; }
function setCourtConnectionState(state) {
  $('.game-shell').dataset.connectionState = state;
  canvas.setAttribute('aria-label', state === 'connected' ? 'DefinitelyNotPong game arena' : 'DefinitelyNotPong waiting court');
}
function safeSend(channel, payload) { if (channel?.readyState === 'open') channel.send(JSON.stringify(payload)); }
function broadcast(payload) { channels.forEach((channel) => safeSend(channel, payload)); }
function packet(type, payload = {}) { return { v: PROTOCOL_VERSION, type, code: room.code, peerId, ...payload }; }
function roomPacket() { return packet('room', { room }); }
function statePacket() { return packet('state', { seq: stateSeq++, snapshot: scoreSnapshot(game), inputs: room.assignments.map((a) => ({ id: a.id, input: a.input ?? .5 })) }); }

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
  networkSession = creator ? createHostSession(room) : null;
  negotiation = createNegotiation(mode, peerId);
  game = createGame(900, 600);
  $('.signaling').classList.remove('hidden');
  $('.invite').classList.remove('hidden');

  $('#adminBadge').textContent = creator ? 'ADMIN' : 'GUEST';
  $('#roomCode').textContent = code;
  $('#inviteLink').value = inviteUrl(location.href, code);
  updateRoomUi();
  resetConnectionTransport();
  renderNegotiation();
  setCourtConnectionState('waiting');
  setMessage(creator ? 'WAITING — NOT CONNECTED · CREATE AN OFFER' : 'WAITING FOR HOST OFFER — NOT CONNECTED · PASTE IT BELOW');
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
$('#leaveRoom').addEventListener('click', () => { closeOldTransports(); networkSession = null; negotiation = null; room = null; mode = ''; enterLobby(); });

function closeOldTransports() {
  transportGeneration += 1;
  const oldChannels = [...channels];
  channels = [];
  oldChannels.forEach((channel) => { try { channel.close(); } catch {} });
  const oldPeers = [...peerConnections];
  peerConnections = [];
  oldPeers.forEach((pc) => { try { pc.close(); } catch {} });
  pendingPc = null;
}

function closeChannelOwner(channel) {
  channels = channels.filter((item) => item !== channel);
  const pc = channelOwners.get(channel);
  if (!pc) return;
  channelOwners.delete(channel);
  peerConnections = peerConnections.filter((item) => item !== pc);
  if (pendingPc === pc) pendingPc = null;
  try { if (pc.connectionState !== 'closed') pc.close(); } catch {}
}

function showDisconnectedState(message) {
  if (negotiation) negotiation = resetNegotiation(negotiation);
  $('#netBadge').textContent = 'LOCAL';
  setCourtConnectionState('waiting');
  setMessage(message);
  renderNegotiation();
  $('#rtcState').textContent = 'disconnected';
}

function resetConnectionTransport() {
  closeOldTransports();
  $('#signalIn').value = '';
  $('#signalOut').value = '';
  $('#rtcState').textContent = 'not connected';
  $('#netBadge').textContent = 'LOCAL';
  $('#iceStatus').textContent = 'READY TO GENERATE';
  if (mode === 'host' || mode === 'guest') setCourtConnectionState('waiting');
}

function renderNegotiation() {
  if (!negotiation) return;
  const view = negotiationView(negotiation);
  $('#negotiationStep').textContent = view.instruction;
  $('#rtcState').textContent = view.status;
  $('#signalOutType').textContent = view.outputType;
  $('#signalInType').textContent = view.inputType;
  $('#makeOffer').disabled = !view.canCreateOffer;
  $('#applySignal').disabled = !view.canApplySignal;
  $('#copySignal').disabled = !view.canCopySignal;
}

function retryConnection() {
  resetConnectionTransport();
  negotiation = resetNegotiation(negotiation);
  if (mode === 'host') networkSession = createHostSession(room);
  else networkSession = null;
  renderNegotiation();
}

$('#resetConnection').addEventListener('click', retryConnection);
if (new URL(location.href).searchParams.has('test')) $('#iceTimeoutTest').classList.remove('hidden');
$('#iceTimeoutTest').addEventListener('click', () => {
  forceIceTimeout = !forceIceTimeout;
  setIceStatus(forceIceTimeout ? 'TIMEOUT FALLBACK ENABLED' : 'READY TO GENERATE');
});

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

function setIceStatus(status) {
  $('#iceStatus').textContent = status;
}

async function gatherLocalDescription(pc, generation) {
  setIceStatus('GATHERING CONNECTION CANDIDATES');
  const options = {
    graceMs: forceIceTimeout ? 0 : 5000,
    isCurrent: () => transportGeneration === generation && peerConnections.includes(pc)
  };
  if (forceIceTimeout) options.isComplete = () => false;
  const result = await waitForIceGathering(pc, options);
  if (result.stale) return result;
  setIceStatus(result.completeness === 'partial'
    ? 'PARTIAL CANDIDATES — MAY NEED RETRY / TURN'
    : 'OFFER READY — CANDIDATES COMPLETE');
  return result;
}

function makePeer() {
  const testMode = new URL(location.href).searchParams.has('test');
  const pc = new RTCPeerConnection({ iceServers: testMode ? [] : [{ urls: 'stun:stun.l.google.com:19302' }] });
  peerConnections.push(pc);
  pc.addEventListener('connectionstatechange', () => {
    if (!peerConnections.includes(pc)) return;
    $('#rtcState').textContent = pc.connectionState;
    $('#netBadge').textContent = pc.connectionState === 'connected' ? 'P2P LIVE' : 'LOCAL';
  });
  return pc;
}

function attachChannel(channel, pc) {
  const channelId = crypto.randomUUID();
  channelIds.set(channel, channelId);
  channelOwners.set(channel, pc);
  if (mode === 'guest') networkSession = createGuestSession(room.code, { id: peerId, name: playerName }, channelId);
  channels.push(channel);
  channel.addEventListener('open', () => {
    if (negotiation) { negotiation = markConnected(negotiation); renderNegotiation(); }
    setCourtConnectionState('connected');
    $('#rtcState').textContent = 'connected'; setMessage('DIRECT PEER CONNECTION ESTABLISHED');
    safeSend(channel, { v: PROTOCOL_VERSION, type: 'hello', peer: { id: peerId, name: playerName }, code: guestRoomCode || room.code });
    setTimeout(() => setMessage(''), 1500);
  });
  channel.addEventListener('close', () => {
    closeChannelOwner(channel);
    if (mode === 'host' && networkSession) {
      const result = disconnectHostChannel(networkSession, channelId);
      networkSession = result.session;
      room = networkSession.room;
      updateRoomUi();
      if (result.broadcastRoom) broadcast(roomPacket());
      showDisconnectedState('GUEST DISCONNECTED — RESET / RETRY');
    } else if (mode === 'guest') {
      networkSession = null;
      room = {
        code: guestRoomCode,
        adminId: null,
        players: [{ id: peerId, name: playerName }],
        assignments: [{ id: peerId, name: playerName, team: 'right', edge: 'side', half: 0 }]
      };
      updateRoomUi();
      showDisconnectedState('Host disconnected — reset/rejoin');
    }
  });
  channel.addEventListener('message', (event) => handleNetwork(event.data, channel));
}

function handleNetwork(raw, channel) {
  const channelId = channelIds.get(channel);
  try {
    if (mode === 'host') {
      const result = receiveHostMessage(networkSession, channelId, raw, performance.now());
      networkSession = result.session;
      room = networkSession.room;
      if (result.closeChannel) channel.close();
      if (result.accepted) updateRoomUi();
      if (result.broadcastRoom) broadcast(roomPacket());
      if (result.broadcastState) broadcast(statePacket());
    } else if (mode === 'guest') {
      const result = receiveGuestMessage(networkSession, channelId, raw);
      networkSession = result.session;
      if (result.closeChannel) channel.close();
      if (result.accepted) {
        room = networkSession.room;
        if (networkSession.snapshot) {
          Object.assign(game.ball, networkSession.snapshot.ball);
          game.score = networkSession.snapshot.score;
        }
        updateRoomUi(); setMessage('');
      }
    }
  } catch { channel.close(); }
}

$('#makeOffer').addEventListener('click', async () => {
  try {
    if (!negotiationView(negotiation).canCreateOffer) throw new Error('Reset before creating another offer');
    resetConnectionTransport();
    const generation = transportGeneration;
    setIceStatus('GENERATING OFFER');
    const negotiationId = crypto.randomUUID();
    const pc = makePeer(); const channel = pc.createDataChannel('dnp', { ordered: true }); attachChannel(channel, pc);
    await pc.setLocalDescription(await pc.createOffer());
    const ice = await gatherLocalDescription(pc, generation);
    if (ice.stale) return;
    pendingPc = pc;
    negotiation = offerCreated(negotiation, negotiationId);
    $('#signalOut').value = encodeSignal({ kind: 'offer', roomCode: room.code, senderId: peerId, negotiationId, name: playerName, description: ice.description });
    negotiation = offerShared(negotiation);
    $('#signalIn').value = '';
    renderNegotiation();
  } catch (error) { $('#rtcState').textContent = error.message; }
});
$('#applySignal').addEventListener('click', async () => {
  try {
    const signal = decodeSignal($('#signalIn').value.trim());
    const accepted = acceptRemoteSignal(negotiation, signal, room.code);
    if (signal.kind === 'offer') {
      const generation = transportGeneration;
      const pc = makePeer(); pc.addEventListener('datachannel', (event) => attachChannel(event.channel, pc));
      setIceStatus('GENERATING ANSWER');
      await pc.setRemoteDescription(signal.description); await pc.setLocalDescription(await pc.createAnswer());
      const ice = await gatherLocalDescription(pc, generation);
      if (ice.stale) return;
      pendingPc = pc;
      negotiation = accepted.state;
      $('#signalOut').value = encodeSignal({ kind: 'answer', roomCode: room.code, senderId: peerId, negotiationId: signal.negotiationId, name: playerName, description: ice.description });
      $('#signalIn').value = '';
    } else {
      if (!pendingPc || pendingPc.signalingState !== 'have-local-offer') throw new Error('Local offer is no longer active; reset and create a new offer');
      await pendingPc.setRemoteDescription(signal.description);
      negotiation = accepted.state;
      $('#signalIn').value = '';
      $('#signalOut').value = '';
    }
    renderNegotiation();
  } catch (error) { $('#rtcState').textContent = error.message; }
});
async function copyFrom(selector, button) { try { await navigator.clipboard.writeText($(selector).value); const old = button.textContent; button.textContent = 'COPIED'; setTimeout(() => button.textContent = old, 1000); } catch { $(selector).select(); } }
$('#copySignal').addEventListener('click', (e) => copyFrom('#signalOut', e.currentTarget));
$('#copyInvite').addEventListener('click', (e) => copyFrom('#inviteLink', e.currentTarget));

function setInput(value) {
  humanInput = Math.min(1, Math.max(0, value));
  const mine = room?.assignments.find((a) => a.id === peerId); if (mine) mine.input = humanInput;
  if (mode === 'guest') broadcast(packet('input', { seq: seq++, value: humanInput }));
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
    else if (mode === 'host') { stepGame(game, dt, draw()); if (Math.floor(now / 50) !== Math.floor((now - dt * 1000) / 50)) broadcast(statePacket()); }
    draw();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

window.__dnp = {
  get room() { return room; },
  get game() { return game; },
  get mode() { return mode; },
  get negotiationDiagnostics() {
    return { phase: negotiation?.phase, openPeerConnections: peerConnections.filter((pc) => pc.connectionState !== 'closed').length, openChannels: channels.filter((channel) => channel.readyState !== 'closed').length };
  }
};

const joinFromUrl = new URL(location.href).searchParams.get('join')?.toUpperCase();
if (playerName) { $('#name').value = playerName; enterLobby(); if (isRoomCode(joinFromUrl)) { $('#joinCode').value = joinFromUrl; show('joinPanel'); } }
else { $('#name').value = ''; show('gate'); if (isRoomCode(joinFromUrl)) $('#joinCode').value = joinFromUrl; }
