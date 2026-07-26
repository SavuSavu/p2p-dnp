import { sanitizeName, createRoomCode, assignPlayers, paddleRect, clamp } from './core.mjs';
import { createGame, stepGame, applyPlayerAxis } from './game.mjs';
import {
  createHostSession, createGuestSession, transitionHost, transitionGuest, disconnectHostChannel,
  updateGuestSnapshotHealth, makeHello, makeInput, makeRoom, makeState,
} from './session.mjs';
import { gatherIceDescription, createSignalingState, advanceSignaling, resetSignaling } from './signaling.mjs';

const $ = id => document.getElementById(id);
const canvas = $('arena'), ctx = canvas.getContext('2d');
const ui = { gate: $('gate'), lobby: $('lobby'), game: $('game'), error: $('name-error') };
const peerId = `p-${crypto.getRandomValues(new Uint32Array(2)).join('-')}`;
let name = localStorage.getItem('dnp-name') || '';
let mode = '', role = '', code = '', state = null, assigned = [], axis = 0, last = 0, inputSeq = 0, outgoingSeq = 1;
let pc = null, dataChannel = null, channelId = null, netSession = null, channelState = 'offline', lastSnapshotTick = 0;
let snapshotAgeMs = null, snapshotsPaused = false;
let signaling = null;
const keys = new Set();
const searchParams = new URLSearchParams(location.search);
const localTestMode = searchParams.get('test') === '1' && ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
const rtcConfig = searchParams.get('ice') === 'local'
  ? { iceServers: [] }
  : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const iceGraceMs = localTestMode && /^\d+$/.test(searchParams.get('iceGrace') || '') ? Number(searchParams.get('iceGrace')) : 10000;

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
  closeRoom('restart'); mode = nextMode; role = nextRole; code = roomCode; inputSeq = 0; outgoingSeq = 1; lastSnapshotTick = 0; snapshotAgeMs = null; snapshotsPaused = false;
  let players;
  if (mode === 'single') players = [player(peerId, name), player('ai-right', 'VECTOR')];
  else if (mode === 'random') players = [player(peerId, name), player('demo-rival', 'RIVAL-07')];
  else players = [player(peerId, name)];
  assigned = assignPlayers(players); state = createGame(assigned);
  if (mode === 'room') netSession = role === 'host'
    ? createHostSession({ room: code, hostId: peerId, hostName: name, now: performance.now() })
    : createGuestSession({ room: code, guestId: peerId, guestName: name });
  signaling = mode === 'room' ? createSignalingState(role) : null;
  $('mode-label').textContent = mode === 'single' ? 'SOLO CIRCUIT' : mode === 'random' ? 'RANDOM 1V1 · LOCAL SIMULATION' : `PRIVATE WEBRTC 1V1 · ${role.toUpperCase()}`;
  $('room-title').textContent = mode === 'room' ? `ROOM ${code}` : 'LOCAL MATCH';
  $('room-tools').classList.toggle('hidden', mode !== 'room'); $('display-code').textContent = code;
  $('local-signal').value = ''; $('remote-signal').value = '';
  setSignalStatus(mode === 'room' ? (role === 'host' ? 'Create an offer, then send it to the guest.' : 'Paste the host offer, then create an answer.') : '');
  renderSignaling();
  updateMeta(); show('game'); last = performance.now(); requestAnimationFrame(loop);
}

function setSignalStatus(text) { $('signal-status').textContent = text; }
function setChannelState(value) { channelState = value; updateMeta(); }
function isAuthenticated() { return mode !== 'room' || signaling?.authenticated === true; }
function renderSignaling() {
  const roomWaiting = mode === 'room' && !isAuthenticated();
  $('waiting-court').classList.toggle('hidden', !roomWaiting);
  $('arena-shell').classList.toggle('hidden', roomWaiting);
  document.querySelector('.mobile-controls').classList.toggle('hidden', roomWaiting);
  if (mode !== 'room' || !signaling) return;
  const labels = {
    host: { idle: 'HOST · STEP 1 · SEND INVITE, THEN CREATE OFFER', 'gathering-offer': 'HOST · STEP 2 · GATHERING CONNECTION CANDIDATES', 'waiting-answer': 'HOST · STEP 3 · SEND OFFER, THEN PASTE ANSWER', connecting: 'HOST · STEP 5 · WAITING FOR PEER CONNECTED', connected: 'HOST · PEER CONNECTED' },
    guest: { 'waiting-offer': 'GUEST · STEP 3 · PASTE OFFER AND CREATE ANSWER', 'gathering-answer': 'GUEST · STEP 3 · GATHERING CONNECTION CANDIDATES', connecting: 'GUEST · STEP 5 · SEND ANSWER AND WAIT', connected: 'GUEST · PEER CONNECTED' },
  };
  $('signaling-phase').textContent = labels[role]?.[signaling.phase] || `${role.toUpperCase()} · ${signaling.phase.toUpperCase()}`;
  const actionArea = document.querySelector('.signal-actions');
  for (const id of ['create-offer', 'apply-offer', 'apply-answer']) { const button = $(id); if (button) actionArea.append(button); }
  const primaryId = signaling.phase === 'idle' ? 'create-offer' : signaling.phase === 'waiting-offer' ? 'apply-offer' : signaling.phase === 'waiting-answer' ? 'apply-answer' : null;
  $('primary-signal-action').textContent = primaryId ? '' : signaling.phase === 'connected' ? 'Authenticated channel ready' : 'Complete the highlighted signaling step';
  if (primaryId) $('primary-signal-action').append($(primaryId));
  $('create-offer').disabled = !(role === 'host' && signaling.phase === 'idle');
  $('apply-offer').disabled = !(role === 'guest' && signaling.phase === 'waiting-offer');
  $('apply-answer').disabled = !(role === 'host' && signaling.phase === 'waiting-answer');
  $('copy-signal').disabled = !$('local-signal').value;
}
function ensurePeerConnection() {
  if (pc) return pc;
  const connection = new RTCPeerConnection(rtcConfig);
  const generation = signaling?.generation;
  pc = connection;
  connection.onconnectionstatechange = () => {
    if (pc !== connection || signaling?.generation !== generation) return;
    const connectionState = connection.connectionState || 'closed';
    if (dataChannel?.readyState !== 'open') setChannelState(connectionState);
    if (['failed', 'disconnected', 'closed'].includes(connectionState)) handleDisconnect(connectionState);
  };
  connection.ondatachannel = event => { if (pc === connection && signaling?.generation === generation) attachChannel(event.channel, generation); };
  return connection;
}
function attachChannel(channel, generation = signaling?.generation) {
  dataChannel = channel; channelId = `dc-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
  channel.onopen = () => { if (dataChannel !== channel || signaling?.generation !== generation) return; setChannelState('open'); setSignalStatus('Data channel open · authenticating peer identity…'); sendRaw(makeHello(netSession)); };
  channel.onmessage = event => { if (dataChannel === channel && signaling?.generation === generation) receiveNetwork(event.data); };
  channel.onclose = () => { if (dataChannel !== channel || signaling?.generation !== generation) return; setChannelState('closed'); handleDisconnect(netSession?.health?.lastDisconnectReason || 'channel-closed'); };
  channel.onerror = () => { if (dataChannel === channel && signaling?.generation === generation) setSignalStatus('Data channel error. Reset / Retry signaling. Restrictive NAT may require TURN, which is not bundled.'); };
}
function sendRaw(raw) { if (dataChannel?.readyState === 'open') dataChannel.send(raw); }
function broadcastRoom() { if (role === 'host') sendRaw(makeRoom(netSession, outgoingSeq++)); }
function broadcastState() { if (role === 'host' && !snapshotsPaused) sendRaw(makeState(netSession, state, outgoingSeq++)); }
function receiveNetwork(raw) {
  const now = performance.now();
  if (role === 'host') {
    const result = transitionHost(netSession, channelId, raw, now); netSession = result.session;
    if (result.closeChannel) { setSignalStatus(`Protocol closed: ${result.reason}. Start a new manual signaling exchange to recover.`); updateMeta(); dataChannel?.close(); return; }
    if (!result.accepted) return;
    if (result.effects.broadcastRoom) markAuthenticated();
    if (result.effects.applyInput) applyPlayerAxis(state, result.message.peerId, result.message.axis, .055);
    if (result.effects.broadcastRoom) {
      state.players = netSession.players.map(p => ({ ...p, position: state.players.find(old => old.id === p.id)?.position || 0 }));
      assigned = assignPlayers(state.players); broadcastRoom();
    }
  } else {
    const result = transitionGuest(netSession, channelId, raw, now); netSession = result.session;
    if (!result.accepted) return;
    if (netSession.authorityId && netSession.health.status === 'connected') markAuthenticated();
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
function markAuthenticated() {
  if (!signaling || signaling.authenticated) return;
  try { signaling = advanceSignaling(signaling, 'authenticated'); }
  catch { signaling = { ...signaling, phase: 'connected', authenticated: true }; }
  setSignalStatus('PEER CONNECTED · authenticated channel ready. Court unlocked.'); renderSignaling();
}
function handleDisconnect(reason) {
  if (role === 'host' && netSession && channelId) {
    const result = disconnectHostChannel(netSession, channelId, performance.now()); netSession = result.session;
    netSession.health.lastDisconnectReason = reason;
    state.players = netSession.players.map(p => ({ ...p, position: state.players.find(old => old.id === p.id)?.position || 0 })); assigned = assignPlayers(state.players);
  } else if (role === 'guest' && netSession) netSession.health = { ...netSession.health, status: 'disconnected', lastDisconnectReason: reason };
  setSignalStatus(`Disconnected: ${reason}. Start a new manual signaling exchange to recover.`); updateMeta();
}
function readSignal() {
  try { const signal = JSON.parse($('remote-signal').value); if (!signal || !['offer', 'answer'].includes(signal.type) || typeof signal.sdp !== 'string') throw new Error(); return signal; }
  catch { throw new Error('Signal must be valid offer/answer JSON.'); }
}
$('create-offer').onclick = async () => {
  try {
    if (role !== 'host') throw new Error('Only the room host creates the offer.');
    signaling = advanceSignaling(signaling, 'create-offer'); renderSignaling(); setSignalStatus('Creating offer · gathering connection candidates…');
    const generation = signaling.generation;
    const connection = ensurePeerConnection(); attachChannel(connection.createDataChannel('dnp-v3', { ordered: true }));
    await connection.setLocalDescription(await connection.createOffer());
    const result = await gatherIceDescription(connection, { graceMs: iceGraceMs, isCurrent: () => pc === connection && signaling?.generation === generation });
    $('local-signal').value = JSON.stringify(result.description); signaling = advanceSignaling(signaling, 'offer-ready'); renderSignaling();
    setSignalStatus(result.partial ? 'Offer ready with partial candidates · copy it now. Direct connection may need retry/TURN; TURN is not bundled.' : 'Offer ready · copy YOUR SIGNAL to the guest.');
  } catch (error) { setSignalStatus(error.message); }
};
$('apply-offer').onclick = async () => {
  try {
    if (role !== 'guest') throw new Error('Only a joining guest applies the offer.');
    signaling = advanceSignaling(signaling, 'apply-offer'); renderSignaling(); setSignalStatus('Applying offer · gathering connection candidates for the answer…');
    const generation = signaling.generation;
    const connection = ensurePeerConnection(); await connection.setRemoteDescription(readSignal());
    await connection.setLocalDescription(await connection.createAnswer());
    const result = await gatherIceDescription(connection, { graceMs: iceGraceMs, isCurrent: () => pc === connection && signaling?.generation === generation });
    $('local-signal').value = JSON.stringify(result.description); signaling = advanceSignaling(signaling, 'answer-ready'); renderSignaling();
    setSignalStatus(result.partial ? 'Answer ready with partial candidates · copy it to the host. Direct connection may need retry/TURN; TURN is not bundled.' : 'Answer ready · copy YOUR SIGNAL back to the host.');
  } catch (error) { setSignalStatus(error.message); }
};
$('apply-answer').onclick = async () => {
  try {
    if (role !== 'host') throw new Error('Only the host applies the answer.');
    signaling = advanceSignaling(signaling, 'apply-answer'); renderSignaling();
    await ensurePeerConnection().setRemoteDescription(readSignal()); setSignalStatus('Answer applied · waiting for authenticated data channel. If it fails, Reset / Retry; restrictive NAT may require TURN.');
  } catch (error) { setSignalStatus(error.message); }
};
$('copy-link').onclick = async () => { const url = new URL(location.href); url.searchParams.set('join', code); await copyText(url.toString()); setSignalStatus('Invite link copied. Remember: the link alone does not connect the peer; continue with OFFER and ANSWER.'); };
$('copy-signal').onclick = async () => {
  const signal = $('local-signal').value;
  if (!signal) { setSignalStatus('No signal is ready. Complete the current create/apply step first.'); return; }
  await copyText(signal); setSignalStatus(`${JSON.parse(signal).type.toUpperCase()} copied · send it to the other browser.`);
};
async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; } } catch {}
  const helper = document.createElement('textarea'); helper.value = text; helper.style.position = 'fixed'; helper.style.opacity = '0'; document.body.append(helper); helper.select();
  const copied = document.execCommand('copy'); helper.remove(); if (!copied) throw new Error('Clipboard unavailable. Select and copy the signal manually.');
}
$('reset-signal').onclick = () => {
  closeTransports(); signaling = resetSignaling(signaling); channelState = 'offline'; $('local-signal').value = ''; $('remote-signal').value = '';
  setSignalStatus(role === 'host' ? 'Reset complete · create a fresh offer.' : 'Reset complete · paste a fresh host offer.'); renderSignaling(); updateMeta();
};
function closeTransports() {
  const retiredChannel = dataChannel, retiredPc = pc;
  dataChannel = null; pc = null; channelId = null;
  if (retiredChannel) { retiredChannel.onopen = null; retiredChannel.onmessage = null; retiredChannel.onclose = null; retiredChannel.onerror = null; retiredChannel.close(); }
  if (retiredPc) { retiredPc.onconnectionstatechange = null; retiredPc.ondatachannel = null; retiredPc.close(); }
}
function closeRoom(reason) {
  closeTransports(); channelState = 'offline';
  if (mode === 'room' && netSession) netSession.health.lastDisconnectReason = reason;
}

function updateMeta() {
  const authority = mode === 'room' ? netSession?.authorityId : peerId;
  $('host-state').textContent = `HOST: ${authority === peerId ? 'YOU' : authority || 'UNBOUND'} · EPOCH ${netSession?.epoch || 1}`;
  const age = snapshotAgeMs === null ? 'AGE: —' : `AGE: ${Math.round(snapshotAgeMs)}ms`;
  $('snapshot-state').textContent = `SNAPSHOT: ${lastSnapshotTick || state?.tick || 0} · ${age} · ${(netSession?.health?.status || 'healthy').toUpperCase()}`;
  $('player-count').textContent = `PLAYERS: ${state?.players.length || 0}/${mode === 'room' ? 2 : 2}`;
  const reason = netSession?.health?.lastDisconnectReason ? ` · REASON ${netSession.health.lastDisconnectReason.toUpperCase()}` : '';
  $('channel-health').textContent = `CHANNEL: ${channelState.toUpperCase()} · REJECTED ${netSession?.health?.rejected || 0}${reason}`;
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
  if (mode === 'room' && !isAuthenticated()) return;
  if (mode === 'room' && role === 'guest' && netSession) {
    const previousStatus = netSession.health.status;
    const health = updateGuestSnapshotHealth(netSession, performance.now(), channelState === 'open');
    netSession = health.session; snapshotAgeMs = health.snapshotAgeMs;
    if (previousStatus !== 'disconnected' && netSession.health.status === 'disconnected' && netSession.health.lastDisconnectReason === 'snapshot-timeout') {
      setSignalStatus('Disconnected: snapshot-timeout. The channel is open but authoritative snapshots stopped; start a new signaling exchange.');
    }
  }
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
function loop(now) { if (ui.game.classList.contains('hidden')) return; const dt = (now - last) / 1000; last = now; update(dt); if (mode !== 'room' || isAuthenticated()) draw(); else updateMeta(); requestAnimationFrame(loop); }

Object.defineProperty(window, '__appDebug', { get: () => {
  const diagnostics = { channelState, role, code, localId: peerId, players: state?.players.map(p => ({ id: p.id, name: p.name, position: p.position })) || [], health: netSession?.health };
  if (!localTestMode) return diagnostics;
  return { ...diagnostics,
    pauseSnapshots: () => { if (role === 'host') snapshotsPaused = true; },
    setPacketLimit: limit => { if (role === 'host' && netSession && Number.isInteger(limit) && limit > 0) {
      netSession = { ...netSession, packetLimit: limit, channels: Object.fromEntries(Object.entries(netSession.channels).map(([id, channel]) => [id, { ...channel, packetWindow: [] }])) };
    } },
    sendRaw,
  };
} });
const invited = new URLSearchParams(location.search).get('join');
if (name) { $('player-name').value = name; enterLobby(name); } else show('gate');
if (invited && /^[A-HJ-NP-Z2-9]{6}$/.test(invited.toUpperCase())) { $('room-code').value = invited.toUpperCase(); }
