import { addPlayer, removePlayer } from './model.js';
import { parseProtocolMessage } from './protocol.js';

export function createHostSession(room) {
  return { room, channels: new Map() };
}

export function createGuestSession(code, peer, hostChannelId) {
  return { code, peer, hostChannelId, hostPeerId: null, room: null, snapshot: null, lastStateSeq: -1, stateTimes: [] };
}

export function receiveGuestMessage(session, channelId, raw, now = Date.now()) {
  if (channelId !== session.hostChannelId) return { session, accepted: false, closeChannel: true };
  const message = parseProtocolMessage(raw);
  if (message.code !== session.code || !['hello', 'room', 'state'].includes(message.type)) {
    return { session, accepted: false, closeChannel: true };
  }
  if (message.type === 'hello') {
    if (session.hostPeerId && message.peer.id !== session.hostPeerId) return { session, accepted: false, closeChannel: true };
    return { session: { ...session, hostPeerId: message.peer.id }, accepted: true };
  }
  if (!session.hostPeerId || message.peerId !== session.hostPeerId) {
    return { session, accepted: false, closeChannel: true };
  }
  if (message.type === 'room') {
    if (message.room.adminId !== message.peerId || !message.room.players.some((player) => player.id === session.peer.id)) {
      return { session, accepted: false, closeChannel: true };
    }
    return { session: { ...session, hostPeerId: message.peerId, room: message.room }, accepted: true };
  }
  if (!session.room) return { session, accepted: false };
  if (message.seq <= session.lastStateSeq) return { session, accepted: false, reason: 'sequence' };
  const stateTimes = session.stateTimes.filter((time) => now - time < 1000);
  if (stateTimes.length >= 60) return { session, accepted: false, reason: 'rate' };
  const assignments = session.room.assignments.map((assignment) => {
    const input = message.inputs.find((item) => item.id === assignment.id);
    return input ? { ...assignment, input: input.input } : assignment;
  });
  return {
    session: {
      ...session,
      snapshot: message.snapshot,
      lastStateSeq: message.seq,
      stateTimes: [...stateTimes, now],
      room: { ...session.room, assignments }
    },
    accepted: true
  };
}

export function disconnectHostChannel(session, channelId) {
  const binding = session.channels.get(channelId);
  if (!binding) return { session, broadcastRoom: false };
  const channels = new Map(session.channels);
  channels.delete(channelId);
  return {
    session: { ...session, channels, room: removePlayer(session.room, binding.peerId) },
    broadcastRoom: true
  };
}

export function receiveHostMessage(session, channelId, raw, now = Date.now()) {
  const message = parseProtocolMessage(raw);
  if (message.code !== session.room.code) return { session, accepted: false, closeChannel: true };
  const binding = session.channels.get(channelId);
  if (binding) {
    const claimedPeerId = message.type === 'hello' ? message.peer.id : message.peerId;
    if (claimedPeerId !== binding.peerId || message.type === 'hello') {
      return { session, accepted: false, closeChannel: true };
    }
    if (message.type === 'input') {
      if (message.seq <= binding.lastSeq) return { session, accepted: false, reason: 'sequence' };
      const inputTimes = binding.inputTimes.filter((time) => now - time < 1000);
      if (inputTimes.length >= 30) return { session, accepted: false, reason: 'rate' };
      const channels = new Map(session.channels);
      channels.set(channelId, { ...binding, lastSeq: message.seq, inputTimes: [...inputTimes, now] });
      const assignments = session.room.assignments.map((assignment) => (
        assignment.id === binding.peerId ? { ...assignment, input: message.value } : assignment
      ));
      return {
        session: { ...session, channels, room: { ...session.room, assignments } },
        accepted: true
      };
    }
    return { session, accepted: false };
  }
  if (message.type !== 'hello' || session.room.players.length >= 2) {
    return { session, accepted: false, closeChannel: true };
  }
  if (session.room.players.some((player) => player.id === message.peer.id) ||
      [...session.channels.values()].some((item) => item.peerId === message.peer.id)) {
    return { session, accepted: false, closeChannel: true };
  }
  const room = addPlayer(session.room, message.peer);
  const channels = new Map(session.channels);
  channels.set(channelId, { peerId: message.peer.id, lastSeq: -1, inputTimes: [], connectedAt: now });
  return {
    session: { ...session, room, channels },
    accepted: true,
    broadcastRoom: true,
    broadcastState: true
  };
}
