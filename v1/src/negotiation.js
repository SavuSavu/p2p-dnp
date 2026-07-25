const START_PHASE = { host: 'idle', guest: 'waiting-offer' };

function ensureRole(role) {
  if (!Object.hasOwn(START_PHASE, role)) throw new Error('Negotiation role must be host or guest');
}

export function createNegotiation(role, localPeerId) {
  ensureRole(role);
  return { role, localPeerId, phase: START_PHASE[role], negotiationId: null, appliedSignals: [] };
}

export function resetNegotiation(state) {
  return createNegotiation(state.role, state.localPeerId);
}

export function offerCreated(state, negotiationId) {
  if (state.role !== 'host' || state.phase !== 'idle') throw new Error('Only a host at Step 1 can create an offer');
  if (!negotiationId) throw new Error('Connection attempt id is required');
  return { ...state, phase: 'offer-ready', negotiationId };
}

export function offerShared(state) {
  if (state.role !== 'host' || state.phase !== 'offer-ready') throw new Error('Create a host offer before waiting for an answer');
  return { ...state, phase: 'waiting-answer' };
}

function validateSignalShape(signal) {
  if (!signal || typeof signal !== 'object') throw new Error('Invalid signal');
  if (!['offer', 'answer'].includes(signal.kind)) throw new Error('Signal must be labeled offer or answer');
  if (!signal.senderId || !signal.negotiationId) throw new Error('Signal is missing connection identity');
  if (!signal.description || signal.description.type !== signal.kind || typeof signal.description.sdp !== 'string') {
    throw new Error('Signal type does not match its WebRTC description');
  }
}

export function acceptRemoteSignal(state, signal, roomCode) {
  validateSignalShape(signal);
  if (signal.roomCode !== roomCode) throw new Error('Signal belongs to another room');
  if (signal.senderId === state.localPeerId) throw new Error('You cannot apply your own signal');
  const key = `${signal.kind}:${signal.senderId}:${signal.negotiationId}`;
  if (state.appliedSignals.includes(key)) throw new Error(`This ${signal.kind} was already applied`);

  if (state.role === 'guest') {
    if (state.phase !== 'waiting-offer' || signal.kind !== 'offer') {
      throw new Error('Step 1: paste a fresh host offer; this signal is not valid now');
    }
    return {
      state: { ...state, phase: 'answer-ready', negotiationId: signal.negotiationId, appliedSignals: [...state.appliedSignals, key] },
      signal
    };
  }

  if (state.phase === 'answer-applied' && signal.kind === 'answer') throw new Error('This answer was already applied');
  if (state.phase !== 'waiting-answer' || signal.kind !== 'answer') {
    throw new Error('Step 3: the host must paste the guest answer after sharing its offer');
  }
  if (signal.negotiationId !== state.negotiationId) throw new Error('This signal is from an older connection attempt');
  return {
    state: { ...state, phase: 'answer-applied', appliedSignals: [...state.appliedSignals, key] },
    signal
  };
}

export function markConnected(state) {
  if (state.role === 'host' && state.phase !== 'answer-applied') throw new Error('Host must apply an answer before connection');
  if (state.role === 'guest' && state.phase !== 'answer-ready') throw new Error('Guest must create an answer before connection');
  return { ...state, phase: 'connected' };
}

export function negotiationView(state) {
  const views = {
    host: {
      idle: ['STEP 1 OF 3 · CREATE A NEW OFFER', 'Create Offer', 'OFFER', 'ANSWER'],
      'offer-ready': ['STEP 2 OF 3 · COPY THIS OFFER TO THE GUEST', 'Offer Ready', 'OFFER', 'ANSWER'],
      'waiting-answer': ['STEP 3 OF 3 · PASTE THE GUEST ANSWER', 'Waiting for Answer', 'OFFER', 'ANSWER'],
      'answer-applied': ['CONNECTING · ANSWER APPLIED', 'Connecting', 'OFFER', 'ANSWER'],
      connected: ['CONNECTED · DIRECT CHANNEL OPEN', 'Connected', 'OFFER', 'ANSWER']
    },
    guest: {
      'waiting-offer': ['STEP 1 OF 2 · PASTE THE HOST OFFER', 'Waiting for Offer', 'ANSWER', 'OFFER'],
      'answer-ready': ['STEP 2 OF 2 · COPY THIS ANSWER TO THE HOST', 'Answer Ready', 'ANSWER', 'OFFER'],
      connected: ['CONNECTED · DIRECT CHANNEL OPEN', 'Connected', 'ANSWER', 'OFFER']
    }
  };
  const [instruction, status, outputType, inputType] = views[state.role][state.phase];
  return {
    instruction, status, outputType, inputType,
    canCreateOffer: state.role === 'host' && state.phase === 'idle',
    canApplySignal: (state.role === 'guest' && state.phase === 'waiting-offer') || (state.role === 'host' && state.phase === 'waiting-answer'),
    canCopySignal: state.phase === 'offer-ready' || state.phase === 'waiting-answer' || state.phase === 'answer-ready'
  };
}
