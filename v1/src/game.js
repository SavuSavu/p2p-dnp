function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function resetBall(game, random = Math.random) {
  const direction = random() >= 0.5 ? 1 : -1;
  game.ball.x = game.width / 2;
  game.ball.y = game.height / 2;
  game.ball.vx = direction * 330;
  game.ball.vy = (random() - 0.5) * 280 || 120;
}

export function createGame(width = 900, height = 600, random = Math.random) {
  const game = { width, height, score: { left: 0, right: 0 }, ball: { x: 0, y: 0, r: 9, vx: 0, vy: 0 } };
  resetBall(game, random);
  return game;
}

function intersects(ball, paddle) {
  return ball.x + ball.r >= paddle.x && ball.x - ball.r <= paddle.x + paddle.w &&
    ball.y + ball.r >= paddle.y && ball.y - ball.r <= paddle.y + paddle.h;
}

export function stepGame(game, dt, paddles, random = Math.random) {
  const ball = game.ball;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  if (ball.y - ball.r <= 0 && ball.vy < 0) { ball.y = ball.r; ball.vy *= -1; }
  if (ball.y + ball.r >= game.height && ball.vy > 0) { ball.y = game.height - ball.r; ball.vy *= -1; }
  for (const paddle of paddles) {
    if (!intersects(ball, paddle)) continue;
    if (paddle.axis === 'y') {
      if ((ball.vx < 0 && paddle.x < game.width / 2) || (ball.vx > 0 && paddle.x > game.width / 2)) {
        ball.vx *= -1.04;
        ball.vy += ((ball.y - (paddle.y + paddle.h / 2)) / paddle.h) * 180;
      }
    } else if ((ball.vy < 0 && paddle.y < game.height / 2) || (ball.vy > 0 && paddle.y > game.height / 2)) {
      ball.vy *= -1.04;
    }
  }
  if (ball.x > game.width + ball.r) { game.score.left += 1; resetBall(game, random); }
  if (ball.x < -ball.r) { game.score.right += 1; resetBall(game, random); }
  return game;
}

export function moveAi(current, ballY, dt) {
  const target = clamp(ballY / 600, 0, 1);
  return clamp(current + clamp(target - current, -0.06 * dt, 0.06 * dt), 0, 1);
}

export function scoreSnapshot(game) {
  return {
    ball: { x: game.ball.x, y: game.ball.y, vx: game.ball.vx, vy: game.ball.vy },
    score: { ...game.score }
  };
}
