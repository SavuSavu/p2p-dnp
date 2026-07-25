import { sanitizeName, createRoomCode, assignPlayers, paddleRect, clamp } from './core.mjs';
import { createGame, stepGame, applyPlayerAxis } from './game.mjs';
import {
  createHostSession, createGuestSession, transitionHost, transitionGuest, disconnectHostChannel,
  makeHello, makeInput, makeRoom, makeState,
} from './session.mjs';

const $ = id => document.getElementById(id);
const canvas = $('arena'), ctx = canvas.getContext('2d');
const ui = { gate: $('gate'), lobby: $('lobby'), game: $('game'), error: $('name-error') };
const peerId = `p-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`;
let name = localStorage.getItem('dnp-name') || '';
let mode = '', role = '', code = '', state = null, assigned = [], axis = 0, last = 0, inputSeq = 0, outgoingSeq = 1;
let pc = null, dataChannel = null, channelId = null, netSession = null, channelState = 'offline', lastSnapshotTick = 0;
const keys = new Set();
const rtcConfig = new URLSearchParams(location.search).get('ice') === 'local'
  ? { iceServers: [] }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function show(which) { for (const key of ['gate', 'lobby', 'game']) ui[key].classList.toggle('hidden', key !== which); }
function enterLobby(value) {
  name = sanitizeName(value);
  if (!name) { ui.error.textContent = 'Use a name between 1 and 16 characters.'; return; }
  localStorage.setItem('dnp-name', name); $('welcome-name').textContent = name; show('lobby');
}
$('name-form').addEventListener('submit', e => { e.preventDefault(); enterLobby($('player-name').value); });
$('rename').onclick = () => { $('player-name').value = name; show('gate'); $('player-name').focus(); };
$('single').onclick = () => startGame('single');
$('random').onclick = () => startGame('random');
$('create').onclick = () => startGame('room', createRoomCode(), 'host');
$('join').onclick = () => {
  const roomCode = $('room-code').value.trim().toUpperCase();
  if (/^[A-HJ-NP-Z2-9]{6}$/.test(roomCode)) startGame('room', roomCode, 'guest');
  else { $('room-code').setCustomValidity('Enter a valid six-character code'); $('room-code').reportValidity(); }
};
$('room-code').oninput = e => e.target.setCustomValidity('');
$('exit').onclick = () => { closeRoom('local-exit'); show('lobby'); };

function player(id, playerName) { return { id, name: playerName, connected: true, position: 0 }; }
function startGame(nextMode, roomCode = '', nextRole = '') {
  closeRoom('restart'); mode = nextMode; role = nextRole; code = roomCode; inputSeq = 0; outgoingSeq = 1; lastSnapshotTick = 0;
  let players;
  if (mode === 'single') players = [player(peerId, name), player('ai-right', 'VECTOR')];
  else if (mode === 'random') players = [player(peerId, name), player('demo-rival', 'RIVAL-07')];
  else players = [player(peerId, name)];
  assigned = assignPlayers(players); state = createGame(assigned);
  if (mode === 'room') netSession = role === 'host'
    ? createHostSession({ room: code, hostId: peerId, hostName: name, now: performance.now() })
    : createGuestSession({ room: code, guestId: peerId, guestName: name });
  $('mode-label').textContent = mode === 'single' ? 'SOLO CIRCUIT' : mode === 'random' ? 'RANDOM 1V1 · DEMO RENDEZVOUS' : `PRIVATE WEBRTC 1V1 · ${role.toUpperCase()}`;
  $('room-title').textContent = mode === 'room' ? `ROOM ${code}` : 'LOCAL MATCH';
  $('room-tools').classList.toggle('hidden', mode !== 'room'); $('display-code').textContent = code;
  $('local-signal').value = ''; $('remote-signal').value = '';
  setSignalStatus(mode === 'room' ? (role === 'host' ? 'Create an offer, then send it to the guest.' : 'Paste the host offer, then create an answer.') : '');
  updateMeta(); show('game'); last = performance.now(); requestAnimationFrame(loop);
}

function setSignalStatus(text) { $('signal-status').textContent = text; }
function setChannelState(value) { channelState = value; updateMeta(); }
function ensurePeerConnection() {
  if (pc) return pc;
  pc = new RTCPeerConnection(rtcConfig);
  pc.onconnectionstatechange = () => {
    const connectionState = pc?.connectionState || 'closed';
    if (dataChannel?.readyState !== 'open') setChannelState(connectionState);
    if (['failed', 'disconnected', 'closed'].includes(connectionState)) handleDisconnect(connectionState);
  };
  pc.ondatachannel = event => attachChannel(event.channel);
  return pc;
}
function attachChannel(channel) {
  dataChannel = channel; channelId = `dc-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
  channel.onopen = () => { setChannelState('open'); setSignalStatus('Data channel open · identity handshake active.'); sendRaw(makeHello(netSession)); };
  channel.onmessage = event => receiveNetwork(event.data);
  channel.onclose = () => { setChannelState('closed'); handleDisconnect('channel-closed'); };
  channel.onerror = () => setSignalStatus('Data channel error. Close and retry signaling.');
}
function sendRaw(raw) { if (dataChannel?.readyState === 'open') dataChannel.send(raw); }
function broadcastRoom() { if (role === 'host') sendRaw(makeRoom(netSession, outgoingSeq++)); }
function broadcastState() { if (role === 'host') sendRaw(makeState(netSession, state, outgoingSeq++)); }
function receiveNetwork(raw) {
  const now = performance.now();
  if (role === 'host') {
    const result = transitionHost(netSession, channelId, raw, now); netSession = result.session;
    if (result.closeChannel) { dataChannel?.close(); return; }
    if (!result.accepted) return;
    if (result.effects.applyInput) applyPlayerAxis(state, result.message.peerId, result.message.axis, .055);
    if (result.effects.broadcastRoom) {
      state.players = netSession.players.map(p => ({ ...p, position: state.players.find(old => old.id === p.id)?.position || 0 }));
      assigned = assignPlayers(state.players); broadcastRoom();
    }
  } else {
    const result = transitionGuest(netSession, channelId, raw, now); netSession = result.session;
    if (!result.accepted) return;
    if (result.message?.type === 'room') {
      state.players = result.message.players.map(p => ({ ...p, position: state.players.find(old => old.id === p.id)?.position || 0 }));
      assigned = assignPlayers(state.players);
    }
    if (result.message?.type === 'state') {
      state.tick = result.message.tick; state.ball = result.message.ball; state.score = result.message.score;
      state.players = result.message.players.map(p => ({ ...p, name: netSession.players.find(x => x.id === p.id)?.name || p.id }));
      assigned = assignPlayers(state.players); lastSnapshotTick = state.tick;
    }
  }
  updateMeta();
}
function handleDisconnect(reason) {
  if (role === 'host' && netSession && channelId) {
    const result = disconnectHostChannel(netSession, channelId, performance.now()); netSession = result.session;
    state.players = netSession.players.map(p => ({ ...p, position: state.players.find(old => old.id === p.id)?.position || 0 })); assigned = assignPlayers(state.players);
  } else if (role === 'guest' && netSession) netSession.health = { ...netSession.health, status: 'disconnected', lastDisconnectReason: reason };
  setSignalStatus(`Disconnected: ${reason}. Start a new manual signaling exchange to recover.`); updateMeta();
}
async function waitForIce(connection) {
  if (connection.iceGatheringState === 'complete') return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('ICE gathering timed out')); }, 10000);
    const changed = () => { if (connection.iceGatheringState === 'complete') { cleanup(); resolve(); } };
    const cleanup = () => { clearTimeout(timeout); connection.removeEventListener('icegatheringstatechange', changed); };
    connection.addEventListener('icegatheringstatechange', changed);
  });
}
function readSignal() {
  try { const signal = JSON.parse($('remote-signal').value); if (!signal || !['offer', 'answer'].includes(signal.type) || typeof signal.sdp !== 'string') throw new Error(); return signal; }
  catch { throw new Error('Signal must be valid offer/answer JSON.'); }
}
$('create-offer').onclick = async () => {
  try {
    if (role !== 'host') throw new Error('Only the room host creates the offer.');
    const connection = ensurePeerConnection(); attachChannel(connection.createDataChannel('dnp-v3', { ordered: true }));
    await connection.setLocalDescription(await connection.createOffer()); await waitForIce(connection);
    $('local-signal').value = JSON.stringify(connection.localDescription); setSignalStatus('Offer ready · copy YOUR SIGNAL to the guest.');
  } catch (error) { setSignalStatus(error.message); }
};
$('apply-offer').onclick = async () => {
  try {
    if (role !== 'guest') throw new Error('Only a joining guest applies the offer.');
    const connection = ensurePeerConnection(); await connection.setRemoteDescription(readSignal());
    await connection.setLocalDescription(await connection.createAnswer()); await waitForIce(connection);
    $('local-signal').value = JSON.stringify(connection.localDescription); setSignalStatus('Answer ready · copy YOUR SIGNAL back to the host.');
  } catch (error) { setSignalStatus(error.message); }
};
$('apply-answer').onclick = async () => {
  try {
    if (role !== 'host') throw new Error('Only the host applies the answer.');
    await ensurePeerConnection().setRemoteDescription(readSignal()); setSignalStatus('Answer applied · waiting for authenticated data channel.');
  } catch (error) { setSignalStatus(error.message); }
};
$('copy-link').onclick = async () => { const url = new URL(location.href); url.searchParams.set('join', code); await navigator.clipboard?.writeText(url); };
function closeRoom(reason) {
  if (dataChannel) { dataChannel.onclose = null; dataChannel.close(); }
  if (pc) { pc.onconnectionstatechange = null; pc.close(); }
  dataChannel = null; pc = null; channelId = null; channelState = 'offline';
  if (mode === 'room' && netSession) netSession.health.lastDisconnectReason = reason;
}

function updateMeta() {
  const authority = mode === 'room' ? netSession?.authorityId : peerId;
  $('host-state').textContent = `HOST: ${authority === peerId ? 'YOU' : authority || 'UNBOUND'} · EPOCH ${netSession?.epoch || 1}`;
  $('snapshot-state').textContent = `SNAPSHOT: ${lastSnapshotTick || state?.tick || 0} · ${netSession?.health?.status || 'HEALTHY'}`;
  $('player-count').textContent = `PLAYERS: ${state?.players.length || 0}/${mode === 'room' ? 2 : 2}`;
  $('channel-health').textContent = `CHANNEL: ${channelState.toUpperCase()} · REJECTED ${netSession?.health?.rejected || 0}`;
  $('net-state').textContent = mode === 'room' ? `WEBRTC · ${role.toUpperCase()} · ${channelState.toUpperCase()}` : 'LOCAL · AUTHORITATIVE';
  $('roster').textContent = state?.players.map(p => `${p.name} (${p.id === authority ? 'authority' : 'peer'})`).join(' · ') || 'Waiting for peer…';
}
function desiredAxis() { if (keys.has('ArrowUp') || keys.has('ArrowLeft') || keys.has('w') || keys.has('a')) return -1; if (keys.has('ArrowDown') || keys.has('ArrowRight') || keys.has('s') || keys.has('d')) return 1; return axis; }
addEventListener('keydown', e => { if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'].includes(e.key)) { e.preventDefault(); keys.add(e.key); } });
addEventListener('keyup', e => keys.delete(e.key));
for (const [id, value] of [['move-negative', -1], ['move-positive', 1]]) { const button = $(id); button.addEventListener('pointerdown', e => { e.preventDefault(); axis = value; button.setPointerCapture(e.pointerId); }); button.addEventListener('pointerup', () => axis = 0); button.addEventListener('pointercancel', () => axis = 0); }

function collidePaddles() {
  const b = state.ball, px = b.x * canvas.width, py = b.y * canvas.height, radius = 11;
  for (const p of assigned) { const r = paddleRect(p, canvas.width, canvas.height, 18); if (px + radius >= r.x && px - radius <= r.x + r.w && py + radius >= r.y && py - radius <= r.y + r.h) {
    if (p.edge === 'left' && b.vx < 0) { b.x = (r.x + r.w + radius) / canvas.width; b.vx = Math.abs(b.vx) * 1.025; b.vy += p.position * .08; }
    if (p.edge === 'right' && b.vx > 0) { b.x = (r.x - radius) / canvas.width; b.vx = -Math.abs(b.vx) * 1.025; b.vy += p.position * .08; }
  } }
}
function update(dt) {
  const own = assigned.find(p => p.id === peerId), input = desiredAxis();
  if (own) {
    if (mode !== 'room' || role === 'host') applyPlayerAxis(state, peerId, input, dt * 1.7);
    else if (channelState === 'open') sendRaw(makeInput(netSession, input, inputSeq++));
  }
  if (mode === 'single') { const ai = state.players.find(p => p.id === 'ai-right'); if (ai) ai.position = clamp(ai.position + Math.sign(state.ball.y - (ai.position + 1) / 2) * dt * .8, -1, 1); }
  if (mode === 'random') { const rival = state.players.find(p => p.id === 'demo-rival'); if (rival) rival.position = clamp(rival.position + Math.sign(state.ball.y - (rival.position + 1) / 2) * dt * .62, -1, 1); }
  assigned = assignPlayers(state.players);
  if (mode !== 'room' || role === 'host') { stepGame(state, Math.min(dt, .035)); collidePaddles(); if (mode === 'room' && channelState === 'open' && state.tick % 4 === 0) { broadcastState(); lastSnapshotTick = state.tick; } }
}
function draw() {
  const w = canvas.width, h = canvas.height; ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#050811'; ctx.fillRect(0, 0, w, h); ctx.strokeStyle = '#25304a'; ctx.setLineDash([12, 15]); ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke(); ctx.setLineDash([]);
  for (const p of assigned) { const r = paddleRect(p, w, h, 18); ctx.fillStyle = p.id === peerId ? '#d9ff3f' : p.team === 'left' ? '#38e8e1' : '#ff516c'; ctx.fillRect(r.x, r.y, r.w, r.h); }
  ctx.fillStyle = '#f6f7ec'; ctx.beginPath(); ctx.arc(state.ball.x * w, state.ball.y * h, 10, 0, Math.PI * 2); ctx.fill();
  $('left-score').textContent = state.score[0]; $('right-score').textContent = state.score[1]; updateMeta();
}
function loop(now) { if (ui.game.classList.contains('hidden')) return; const dt = (now - last) / 1000; last = now; update(dt); draw(); requestAnimationFrame(loop); }

Object.defineProperty(window, '__appDebug', { get: () => ({ channelState, role, code, players: state?.players.map(p => ({ id: p.id, name: p.name, position: p.position })) || [], health: netSession?.health }) });
const invited = new URLSearchParams(location.search).get('join');
if (name) { $('player-name').value = name; enterLobby(name); } else show('gate');
if (invited && /^[A-HJ-NP-Z2-9]{6}$/.test(invited.toUpperCase())) { $('room-code').value = invited.toUpperCase(); }
