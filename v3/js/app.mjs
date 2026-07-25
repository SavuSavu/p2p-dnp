import { sanitizeName, createRoomCode, assignPlayers, paddleRect, clamp } from './core.mjs';
import { createGame, stepGame, applyPlayerAxis } from './game.mjs';
import { validatePeerMessage, RoomState, makeSnapshot } from './protocol.mjs';

const $ = id => document.getElementById(id);
const canvas = $('arena'), ctx = canvas.getContext('2d');
const ui = { gate:$('gate'), lobby:$('lobby'), game:$('game'), error:$('name-error'), migration:$('migration') };
const peerId = `p-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
let name = localStorage.getItem('dnp-name') || '';
let mode = '', code = '', hostId = peerId, room = null, channel = null, state = null, assigned = [], axis = 0, last = 0, sequence = 0, snapshotAt = 0, migrationTimer = 0;
const keys = new Set();

function show(which){ for(const key of ['gate','lobby','game']) ui[key].classList.toggle('hidden', key !== which); }
function enterLobby(value){ name = sanitizeName(value); if(!name){ ui.error.textContent='Use a name between 1 and 16 characters.'; return; } localStorage.setItem('dnp-name',name); $('welcome-name').textContent=name; show('lobby'); }
$('name-form').addEventListener('submit',e=>{e.preventDefault();enterLobby($('player-name').value)});
$('rename').onclick=()=>{ $('player-name').value=name; show('gate'); $('player-name').focus(); };
$('single').onclick=()=>startGame('single');
$('random').onclick=()=>startGame('random');
$('create').onclick=()=>startGame('room',createRoomCode());
$('join').onclick=()=>{ const c=$('room-code').value.trim().toUpperCase(); if(/^[A-HJ-NP-Z2-9]{6}$/.test(c)) startGame('room',c); else $('room-code').setCustomValidity('Enter a valid six-character code'),$('room-code').reportValidity(); };
$('room-code').oninput=e=>e.target.setCustomValidity('');
$('exit').onclick=()=>{ closeRoom(); show('lobby'); };

function player(id,n,connected=true){ return {id,name:n,connected,position:0}; }
function startGame(nextMode, roomCode=''){
  mode=nextMode; code=roomCode; sequence=0; snapshotAt=0; hostId=peerId;
  let peers;
  if(mode==='single') peers=[player(peerId,name),player('ai-right','VECTOR')];
  else if(mode==='random') peers=[player(peerId,name),player('demo-rival','RIVAL-07')];
  else peers=[player(peerId,name)];
  room=new RoomState(peers,hostId); assigned=assignPlayers(peers); state=createGame(assigned);
  $('mode-label').textContent=mode==='single'?'SOLO CIRCUIT':mode==='random'?'RANDOM 1V1 · DEMO RENDEZVOUS':'PRIVATE RESILIENT ROOM';
  $('room-title').textContent=mode==='room'?`ROOM ${code}`:'LOCAL MATCH';
  $('room-tools').classList.toggle('hidden',mode!=='room'); $('display-code').textContent=code;
  $('net-state').textContent=mode==='room'?'P2P · DISCOVERING':'LOCAL · AUTHORITATIVE';
  if(mode==='room') openRoom();
  updateMeta(); show('game'); last=performance.now(); requestAnimationFrame(loop);
}

function openRoom(){
  closeRoom(); channel=new BroadcastChannel(`dnp-v3-${code}`);
  channel.onmessage=e=>receive(e.data);
  send({v:1,type:'hello',peerId,name});
  const url=new URL(location.href); url.searchParams.set('join',code); history.replaceState({},'',url);
}
function closeRoom(){ if(channel) channel.close(); channel=null; const url=new URL(location.href); url.searchParams.delete('join'); history.replaceState({},'',url.pathname+url.search); }
function send(message){ if(channel) channel.postMessage(message); }
function receive(raw){
  const msg=validatePeerMessage(raw); if(!msg) return;
  if(msg.type==='hello'){
    if(!room.peers.some(p=>p.id===msg.peerId) && room.peers.length<12){ room.peers.push(player(msg.peerId,msg.name)); assigned=assignPlayers(room.peers); state.players=assigned; send({v:1,type:'hello',peerId,name}); }
    const elected=[...room.peers].filter(p=>p.connected).map(p=>p.id).sort()[0]; hostId=elected || peerId; room.hostId=hostId; updateMeta();
  } else if(msg.type==='input' && hostId===peerId) applyPlayerAxis(state,msg.peerId,msg.axis,.035);
  else if(msg.type==='snapshot' && msg.hostId===hostId && hostId!==peerId){ state.tick=msg.tick; state.ball=msg.ball; state.score=msg.score; for(const p of msg.players){const local=state.players.find(x=>x.id===p.id);if(local)local.position=p.position;} snapshotAt=msg.tick; }
}

function simulateMigration(){
  const old=hostId; const candidates=room.peers.filter(p=>p.id!==old); if(!candidates.length) candidates.push(player('backup-peer','BACKUP'));
  room.peers.push(...candidates.filter(c=>!room.peers.some(p=>p.id===c.id))); room.disconnect(old,state.tick); hostId=room.hostId || peerId;
  $('migration-text').textContent=`${old} unavailable → ${hostId} elected. Latest snapshot restored.`; ui.migration.classList.remove('hidden'); clearTimeout(migrationTimer); migrationTimer=setTimeout(()=>ui.migration.classList.add('hidden'),4500); updateMeta();
}
$('simulate-migration').onclick=simulateMigration;
$('copy-link').onclick=async()=>{ const url=new URL(location.href);url.searchParams.set('join',code);await navigator.clipboard?.writeText(url);$('copy-link').textContent='COPIED';setTimeout(()=>$('copy-link').textContent='COPY INVITE LINK',1200); };

function updateMeta(){ $('host-state').textContent=`HOST: ${hostId===peerId?'YOU':hostId}`; $('snapshot-state').textContent=`SNAPSHOT: ${snapshotAt}`; $('player-count').textContent=`PLAYERS: ${state?.players.length||0}/12`; $('net-state').textContent=mode==='room'?`P2P · ${hostId===peerId?'HOST':'PEER'}`:'LOCAL · AUTHORITATIVE'; }
function desiredAxis(){ if(keys.has('ArrowUp')||keys.has('ArrowLeft')||keys.has('w')||keys.has('a'))return -1;if(keys.has('ArrowDown')||keys.has('ArrowRight')||keys.has('s')||keys.has('d'))return 1;return axis; }
addEventListener('keydown',e=>{ if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','w','a','s','d'].includes(e.key)){e.preventDefault();keys.add(e.key);} });
addEventListener('keyup',e=>keys.delete(e.key));
for(const [id,value] of [['move-negative',-1],['move-positive',1]]){ const button=$(id);button.addEventListener('pointerdown',e=>{e.preventDefault();axis=value;button.setPointerCapture(e.pointerId)});button.addEventListener('pointerup',()=>axis=0);button.addEventListener('pointercancel',()=>axis=0); }

function collidePaddles(){
  const b=state.ball, px=b.x*canvas.width, py=b.y*canvas.height, radius=11;
  for(const p of assigned){ const r=paddleRect(p,canvas.width,canvas.height,18); if(px+radius>=r.x&&px-radius<=r.x+r.w&&py+radius>=r.y&&py-radius<=r.y+r.h){
    if(p.edge==='left'&&b.vx<0){b.x=(r.x+r.w+radius)/canvas.width;b.vx=Math.abs(b.vx)*1.025;b.vy+=p.position*.08}
    if(p.edge==='right'&&b.vx>0){b.x=(r.x-radius)/canvas.width;b.vx=-Math.abs(b.vx)*1.025;b.vy+=p.position*.08}
    if(p.edge==='top'&&b.vy<0){b.y=(r.y+r.h+radius)/canvas.height;b.vy=Math.abs(b.vy)*1.025}
    if(p.edge==='bottom'&&b.vy>0){b.y=(r.y-radius)/canvas.height;b.vy=-Math.abs(b.vy)*1.025}
  }}
}
function update(dt){
  const own=assigned.find(p=>p.id===peerId), input=desiredAxis();
  if(own){ if(hostId===peerId||mode!=='room')applyPlayerAxis(state,peerId,input,dt*1.7);else send({v:1,type:'input',peerId,axis:input,seq:sequence++}); }
  if(mode==='single'){const ai=state.players.find(p=>p.id==='ai-right');if(ai)ai.position=clamp(ai.position+Math.sign(state.ball.y-(ai.position+1)/2)*dt*.8,-1,1);}
  if(mode==='random'){const rival=state.players.find(p=>p.id==='demo-rival');if(rival)rival.position=clamp(rival.position+Math.sign(state.ball.y-(rival.position+1)/2)*dt*.62,-1,1);}
  assigned=assignPlayers(state.players);
  if(hostId===peerId||mode!=='room'){ stepGame(state,Math.min(dt, .035)); collidePaddles(); if(mode==='room'&&state.tick%6===0){const snap=makeSnapshot({...state,hostId,players:state.players});if(snap){send(snap);snapshotAt=snap.tick;}} }
}
function draw(){
  const w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);ctx.fillStyle='#050811';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#25304a';ctx.setLineDash([12,15]);ctx.beginPath();ctx.moveTo(w/2,0);ctx.lineTo(w/2,h);ctx.stroke();ctx.setLineDash([]);
  ctx.strokeStyle='#17213a';ctx.beginPath();ctx.arc(w/2,h/2,85,0,Math.PI*2);ctx.stroke();
  for(const p of assigned){const r=paddleRect(p,w,h,18);const own=p.id===peerId;ctx.fillStyle=own?'#d9ff3f':p.team==='left'?'#38e8e1':'#ff516c';ctx.fillRect(r.x,r.y,r.w,r.h);ctx.fillStyle='#071014';ctx.font=`600 ${Math.max(9,Math.min(15,r.h*.62))}px DM Mono`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.save();ctx.translate(r.x+r.w/2,r.y+r.h/2);if(r.h>r.w)ctx.rotate(-Math.PI/2);ctx.fillText(p.name.slice(0,16),0,0,Math.max(r.w,r.h)-8);ctx.restore();}
  ctx.fillStyle='#f6f7ec';ctx.shadowColor='#fff';ctx.shadowBlur=16;ctx.beginPath();ctx.arc(state.ball.x*w,state.ball.y*h,10,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;
  $('left-score').textContent=state.score[0];$('right-score').textContent=state.score[1];updateMeta();
}
function loop(now){ if(ui.game.classList.contains('hidden'))return;const dt=(now-last)/1000;last=now;update(dt);draw();requestAnimationFrame(loop); }

const invited=new URLSearchParams(location.search).get('join');
if(name){$('player-name').value=name;enterLobby(name);}else show('gate');
if(invited&&/^[A-HJ-NP-Z2-9]{6}$/.test(invited.toUpperCase())){$('room-code').value=invited.toUpperCase();if(name)startGame('room',invited.toUpperCase());}
