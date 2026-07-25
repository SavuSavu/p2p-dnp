import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, stepGame, applyPlayerAxis } from '../js/game.mjs';

test('createGame starts a normalized playable state', () => {
  const game = createGame();
  assert.deepEqual(game.score, [0, 0]);
  assert.ok(game.ball.x > 0 && game.ball.x < 1);
});

test('applyPlayerAxis moves only the selected player and clamps position', () => {
  const game = createGame([{ id: 'a', position: 0 }, { id: 'b', position: 0 }]);
  applyPlayerAxis(game, 'a', 1, 2);
  assert.equal(game.players[0].position, 1);
  assert.equal(game.players[1].position, 0);
});

test('stepGame bounces on top and bottom boundaries', () => {
  const game = createGame();
  game.ball = { x: .5, y: .01, vx: 0, vy: -1 };
  stepGame(game, .02);
  assert.ok(game.ball.vy > 0);
  assert.ok(game.ball.y >= 0);
});

test('stepGame scores and resets when ball crosses a side', () => {
  const game = createGame();
  game.ball = { x: 1.01, y: .5, vx: 1, vy: 0 };
  stepGame(game, .016);
  assert.deepEqual(game.score, [1, 0]);
  assert.equal(game.ball.x, .5);
});
