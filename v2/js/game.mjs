import { buildRosterLayout } from './core.mjs';

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

export function createGame(names) {
  const players = buildRosterLayout(names).map((p, index) => ({ ...p, position: .5, input: 0, ai: index === 1 && names[index] === 'DNP-9000' }));
  return { players, ball: { x: .5, y: .5, vx: .52, vy: .19, r: .012 }, score: [0, 0], rally: 0, winner: null };
}

export function paddleGeometry(player, width = 1, height = 1) {
  const split = player.splitActive === true;
  const pos = clamp(player.position, .1, .9);
  if (player.edge === 'left' || player.edge === 'right') {
    const length = split ? .09 : .2;
    const zoneStart = split ? player.split * .5 : 0;
    const zoneSize = split ? .5 : 1;
    const center = zoneStart + clamp(pos, .1, .9) * zoneSize;
    return { x: (player.edge === 'left' ? .025 : .955) * width, y: (center - length / 2) * height, w: .02 * width, h: length * height };
  }
  const length = split ? .05 : .2;
  const leftHalf = player.team === 'left';
  const halfStart = leftHalf ? 0 : .5;
  const zoneSize = split ? .25 : .5;
  const zoneStart = halfStart + (split ? player.split * zoneSize : 0);
  const center = zoneStart + clamp(pos, .12, .88) * zoneSize;
  return { x: (center - length / 2) * width, y: (player.edge === 'top' ? .025 : .955) * height, w: length * width, h: .02 * height };
}

export function aiTarget(game) {
  const b = game.ball;
  if (b.vx <= 0) return .5;
  let y = b.y + b.vy * ((.955 - b.x) / b.vx);
  while (y < 0 || y > 1) y = y < 0 ? -y : 2 - y;
  return clamp(y, .08, .92);
}

function intersects(ball, rect) {
  const cx = clamp(ball.x, rect.x, rect.x + rect.w);
  const cy = clamp(ball.y, rect.y, rect.y + rect.h);
  return (ball.x - cx) ** 2 + (ball.y - cy) ** 2 <= ball.r ** 2;
}

export function stepGame(source, dt, inputs = new Map()) {
  const game = structuredClone(source);
  for (const p of game.players) {
    let input = clamp(Number(inputs.get(p.id) || 0), -1, 1);
    if (p.ai) input = Math.sign(aiTarget(game) - p.position) * Math.min(1, Math.abs(aiTarget(game) - p.position) * 8);
    p.position = clamp(p.position + input * dt * .72, .1, .9);
  }
  const b = game.ball;
  b.x += b.vx * dt; b.y += b.vy * dt;
  if (b.y - b.r <= 0 || b.y + b.r >= 1) { b.y = clamp(b.y, b.r, 1 - b.r); b.vy *= -1; }
  for (const p of game.players) {
    const g = paddleGeometry(p);
    if (!intersects(b, g)) continue;
    if (p.edge === 'left' && b.vx < 0 || p.edge === 'right' && b.vx > 0) {
      const center = g.y + g.h / 2; b.vx *= -1.055; b.vy += (b.y - center) / g.h * .32;
      b.x = p.edge === 'left' ? g.x + g.w + b.r : g.x - b.r;
    } else if (p.edge === 'top' && b.vy < 0 || p.edge === 'bottom' && b.vy > 0) {
      const center = g.x + g.w / 2; b.vy *= -1.055; b.vx += (b.x - center) / g.w * .32;
      b.y = p.edge === 'top' ? g.y + g.h + b.r : g.y - b.r;
    }
    game.rally++;
  }
  const speed = Math.hypot(b.vx, b.vy);
  if (speed > 1.2) { b.vx *= 1.2 / speed; b.vy *= 1.2 / speed; }
  if (b.x < -b.r || b.x > 1 + b.r) {
    const scorer = b.x > 1 ? 0 : 1;
    game.score[scorer]++;
    const dir = scorer === 0 ? 1 : -1;
    game.ball = { x: .5, y: .5, vx: .52 * dir, vy: (scorer ? -.17 : .17), r: .012 };
    game.rally = 0;
    if (game.score[scorer] >= 7 && game.score[scorer] - game.score[1 - scorer] >= 2) game.winner = scorer;
  }
  return game;
}
