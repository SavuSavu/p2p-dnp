import { normalizeName, createRoomCode, normalizeRoomCode, buildRosterLayout } from './core.mjs';
import { createGame, stepGame, paddleGeometry } from './game.mjs';
import { createPeerSession } from './peer.mjs';

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const views = ['home','lobby','game'];
let name = '', game, raf, last = 0, paused = false, input = 0, peer = null, role = 'local', roomNames = [], countdown = 0;
const canvas = $('#arena'), ctx = canvas.getContext('2d');
const show = id => views.forEach(v => $(`#${v}`).classList.toggle('hidden', v !== id));
const toast = msg => { $('#toast').textContent = msg; $('#toast').classList.add('show'); setTimeout(() => $('#toast').classList.remove('show'), 1800); };

function submitName() {
  try { name = normalizeName($('#player-name').value); $('#name-error').textContent=''; $('#welcome-name').textContent=name.toUpperCase(); $('#name-gate').classList.add('hidden'); $('#mode-picker').classList.remove('hidden'); localStorage.setItem('dnp-name', name); }
  catch(e) { $('#name-error').textContent=e.message.toUpperCase(); }
}
$('#continue-btn').onclick = submitName;
$('#player-name').oninput = e => $('#name-count').textContent=`${[...e.target.value].length}/16`;
$('#player-name').onkeydown = e => { if(e.key==='Enter') submitName(); };
const saved = localStorage.getItem('dnp-name'); if(saved){ $('#player-name').value=saved; $('#name-count').textContent=`${saved.length}/16`; }

function start(names, label='SOLO // FIRST TO 7') {
  cancelAnimationFrame(raf); roomNames=names; game=createGame(names); game.players.forEach((p,i)=>p.ai = label.startsWith('SOLO') && i===1); role='host';
  $('#match-label').textContent=label; $('#result').classList.add('hidden'); $('#score-left').textContent='0'; $('#score-right').textContent='0'; paused=false; countdown=3; show('game'); last=performance.now(); raf=requestAnimationFrame(loop);
}
$('#single-btn').onclick=()=>start([name,'DNP-9000']);
$('#random-btn').onclick=()=>{ toast('RENDEZVOUS NOT CONFIGURED · TRY MANUAL P2P'); openLobby(createRoomCode(), false); };
$('#create-btn').onclick=()=>openLobby(createRoomCode(), true);
$('#join-btn').onclick=()=>{ const raw=prompt('ENTER SIX-CHARACTER ROOM CODE'); if(!raw)return; try{openLobby(normalizeRoomCode(raw),false)}catch(e){toast(e.message.toUpperCase())} };

function openLobby(code, admin) {
  roomNames=[name]; $('#room-code').textContent=code; $('#admin-badge').classList.toggle('hidden',!admin); $('#start-room').classList.toggle('hidden',!admin); history.replaceState({},'',`?join=${code}`); renderRoster(); show('lobby');
}
function renderRoster(){ const players=buildRosterLayout(roomNames); $('#player-total').textContent=`${players.length}/12`; $('#roster').innerHTML=players.map((p,i)=>`<div class="player-row"><i></i><b>${escapeHTML(p.name)}</b><span>${i===0?'ADMIN · ':''}${p.edge.toUpperCase()} ${p.team.toUpperCase()}</span></div>`).join('') + Array.from({length:Math.min(3,12-players.length)},()=>'<div class="player-row"><i style="background:#30374a"></i><b style="color:#566077">OPEN SLOT</b><span>WAITING</span></div>').join(''); }
const escapeHTML=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
$('#copy-invite').onclick=async()=>{ await navigator.clipboard.writeText(location.href); toast('INVITE LINK COPIED'); };
$('#start-room').onclick=()=>start(roomNames,`ROOM ${$('#room-code').textContent} // FIRST TO 7`);
$$('[data-home]').forEach(b=>b.onclick=goHome);
function goHome(){cancelAnimationFrame(raf);peer?.close();peer=null;history.replaceState({},'',location.pathname);show('home');}

function setupSignal(initiator){
  const dialog=$('#signal-dialog'), area=$('#signal-data'); role=initiator?'host':'client'; peer?.close();
  peer=createPeerSession({initiator,onStatus:s=>{ $('#net-status').textContent=s.toUpperCase(); if(s==='connected'){toast('PEER CONNECTED'); if(roomNames.length<2){roomNames.push('REMOTE PEER');renderRoster();}}},onMessage:m=>{if(m.type==='input'&&role==='host') remoteInput=m.value;if(m.type==='snapshot'&&role==='client'){game=m.state;if($('#game').classList.contains('hidden'))show('game');}}});
  dialog.showModal(); area.value='';
  if(initiator){ $('#signal-title').textContent='Create an offer'; $('#signal-help').textContent='Generate, copy, and send this offer to your peer. Then paste their answer here.'; $('#signal-next').textContent='GENERATE OFFER'; let phase=0; $('#signal-next').onclick=async()=>{if(!phase){area.value=await peer.createOffer();$('#signal-next').textContent='ACCEPT PASTED ANSWER';phase=1}else{await peer.acceptAnswer(area.value);dialog.close();}}; }
  else { $('#signal-title').textContent='Answer an offer'; $('#signal-help').textContent='Paste the room creator’s offer. Generate an answer, then copy it back to them.'; $('#signal-next').textContent='GENERATE ANSWER'; $('#signal-next').onclick=async()=>{area.value=await peer.acceptOffer(area.value);$('#signal-next').textContent='DONE';$('#signal-next').onclick=()=>dialog.close();}; }
}
$('#host-signal').onclick=()=>setupSignal(true); $('#join-signal').onclick=()=>setupSignal(false); $('#signal-copy').onclick=async()=>{await navigator.clipboard.writeText($('#signal-data').value);toast('SIGNAL COPIED')};
let remoteInput=0;

function resize(){ const r=canvas.getBoundingClientRect(), d=Math.min(devicePixelRatio||1,2); const w=Math.round(r.width*d),h=Math.round(r.height*d);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;} }
function loop(now){ resize(); const dt=Math.min((now-last)/1000,.033);last=now;if(!paused){if(countdown>0)countdown-=dt;else if(role!=='client'){game=stepGame(game,dt,new Map([[0,input],[1,remoteInput]]));if(peer?.ready())peer.send({type:'snapshot',state:game});} else if(peer?.ready())peer.send({type:'input',value:input,seq:Math.floor(now)});} draw();if(game?.winner!==null){showResult();return}raf=requestAnimationFrame(loop);}
function draw(){const w=canvas.width,h=canvas.height;ctx.clearRect(0,0,w,h);ctx.fillStyle='#060910';ctx.fillRect(0,0,w,h);ctx.strokeStyle='#1a3340';ctx.lineWidth=1;const gap=14*(w/1280);ctx.setLineDash([gap,gap]);ctx.beginPath();ctx.moveTo(w/2,0);ctx.lineTo(w/2,h);ctx.stroke();ctx.setLineDash([]);ctx.strokeStyle='#142332';for(let i=1;i<8;i++){ctx.beginPath();ctx.moveTo(i*w/8,0);ctx.lineTo(i*w/8,h);ctx.stroke()}for(let i=1;i<5;i++){ctx.beginPath();ctx.moveTo(0,i*h/5);ctx.lineTo(w,i*h/5);ctx.stroke()}
  for(const p of game.players){const g=paddleGeometry(p,w,h), color=p.team==='left'?'#39f6df':'#ff3d9f';ctx.shadowColor=color;ctx.shadowBlur=18;ctx.fillStyle=color;ctx.fillRect(g.x,g.y,g.w,g.h);ctx.shadowBlur=0;ctx.fillStyle='#fff';ctx.font=`600 ${Math.max(8,w/115)}px IBM Plex Mono`;ctx.textAlign='center';ctx.textBaseline='middle';const label=p.name.toUpperCase().slice(0,16);if(p.edge==='left'||p.edge==='right'){ctx.save();ctx.translate(g.x+g.w/2,g.y+g.h/2);ctx.rotate(-Math.PI/2);ctx.fillText(label,0,0,Math.max(35,g.h-6));ctx.restore()}else ctx.fillText(label,g.x+g.w/2,g.y+g.h/2,Math.max(35,g.w-6));}
  const b=game.ball;ctx.shadowColor='#fff';ctx.shadowBlur=22;ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(b.x*w,b.y*h,b.r*Math.min(w,h),0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;$('#score-left').textContent=game.score[0];$('#score-right').textContent=game.score[1];$('#countdown').textContent=countdown>0?Math.ceil(countdown):'';
}
function showResult(){cancelAnimationFrame(raf);$('#result-title').textContent=game.winner===0?'CYAN WINS':'MAGENTA WINS';$('#result-title').style.color=game.winner===0?'var(--cyan)':'var(--pink)';$('#result').classList.remove('hidden');}
$('#rematch-btn').onclick=()=>start(roomNames,$('#match-label').textContent);$('#pause-btn').onclick=()=>{paused=!paused;$('#pause-btn').textContent=paused?'▶':'Ⅱ'};
const setKey=(e,v)=>{if(['ArrowUp','w','W','a','A'].includes(e.key))input=-v;if(['ArrowDown','s','S','d','D'].includes(e.key))input=v;if(e.key===' '&&v){paused=!paused;e.preventDefault()}};addEventListener('keydown',e=>setKey(e,1));addEventListener('keyup',e=>setKey(e,0));
$$('#touch-controls button').forEach(b=>{const v=Number(b.dataset.dir);b.onpointerdown=e=>{e.preventDefault();input=v;b.setPointerCapture(e.pointerId)};b.onpointerup=b.onpointercancel=()=>input=0});
canvas.onpointerdown=e=>{const r=canvas.getBoundingClientRect();input=e.clientY<r.top+r.height/2?-1:1};canvas.onpointerup=canvas.onpointercancel=()=>input=0;
const join=new URLSearchParams(location.search).get('join');if(join){try{$('#player-name').focus();$('#continue-btn').addEventListener('click',()=>setTimeout(()=>openLobby(normalizeRoomCode(join),false),0),{once:true})}catch{}}
