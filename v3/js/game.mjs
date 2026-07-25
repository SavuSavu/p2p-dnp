import { clamp } from './core.mjs';

export function createGame(players = []) {
  return {
    tick: 0, score: [0, 0],
    ball: { x: .5, y: .5, vx: .42, vy: .29 },
    players: players.map(p => ({ ...p, position: clamp(Number(p.position) || 0, -1, 1) }))
  };
}

export function applyPlayerAxis(game, id, axis, amount = .025) {
  const player = game.players.find(p => p.id === id);
  if (player) player.position = clamp(player.position + clamp(axis, -1, 1) * amount, -1, 1);
}

export function stepGame(game, dt) {
  game.tick++;
  const b = game.ball;
  b.x += b.vx * dt; b.y += b.vy * dt;
  if (b.y < 0) { b.y = -b.y; b.vy = Math.abs(b.vy); }
  if (b.y > 1) { b.y = 2 - b.y; b.vy = -Math.abs(b.vy); }
  if (b.x > 1 || b.x < 0) {
    game.score[b.x > 1 ? 0 : 1]++;
    const direction = b.x > 1 ? -1 : 1;
    game.ball = { x: .5, y: .5, vx: .42 * direction, vy: (game.tick % 2 ? .27 : -.27) };
  }
  return game;
}
