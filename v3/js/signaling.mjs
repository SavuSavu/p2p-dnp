const initialPhase = role => role === 'host' ? 'idle' : 'waiting-offer';

export function createSignalingState(role, generation = 1) {
  if (!['host', 'guest'].includes(role)) throw new Error('Signaling role must be host or guest.');
  return { role, phase: initialPhase(role), generation, authenticated: false };
}

const transitions = {
  host: {
    idle: { 'create-offer': 'gathering-offer' },
    'gathering-offer': { 'offer-ready': 'waiting-answer' },
    'waiting-answer': { 'apply-answer': 'connecting' },
    connecting: { authenticated: 'connected' },
  },
  guest: {
    'waiting-offer': { 'apply-offer': 'gathering-answer' },
    'gathering-answer': { 'answer-ready': 'connecting' },
    connecting: { authenticated: 'connected' },
  },
};

export function advanceSignaling(state, action) {
  const phase = transitions[state.role]?.[state.phase]?.[action];
  if (!phase) throw new Error(`${action} is not available while ${state.role} is ${state.phase}. Reset/retry if you need a fresh exchange.`);
  return { ...state, phase, authenticated: action === 'authenticated' };
}

export function resetSignaling(state) { return createSignalingState(state.role, state.generation + 1); }

function requireDescription(connection) {
  const description = connection?.localDescription;
  if (!description || !['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string' || description.sdp.length === 0) {
    throw new Error('No local WebRTC description is available. Reset and retry signaling.');
  }
  return description;
}

export function gatherIceDescription(connection, {
  graceMs = 10000,
  isCurrent = () => true,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (connection?.iceGatheringState === 'complete') {
    return Promise.resolve({ description: requireDescription(connection), complete: true, partial: false });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      connection.removeEventListener('icecandidate', changed);
      connection.removeEventListener('icegatheringstatechange', changed);
      clearTimer(timer);
    };
    const finish = (complete) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!isCurrent()) { reject(new Error('Signaling attempt was reset. Ignore this stale result and retry.')); return; }
      try { resolve({ description: requireDescription(connection), complete, partial: !complete }); }
      catch (error) { reject(error); }
    };
    const changed = () => {
      if (!isCurrent()) { finish(false); return; }
      if (connection.iceGatheringState === 'complete') finish(true);
    };

    connection.addEventListener('icecandidate', changed);
    connection.addEventListener('icegatheringstatechange', changed);
    timer = setTimer(() => finish(connection.iceGatheringState === 'complete'), graceMs);
  });
}
