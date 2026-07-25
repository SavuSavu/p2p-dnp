import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, stepGame, moveAi, scoreSnapshot } from '../src/game.js';

test('game starts centered with deterministic serve and zero score', () => {
  const game = createGame(900, 600, () => 0.75);
  assert.deepEqual(game.score, { left: 0, right: 0 });
  assert.equal(game.ball.x, 450);
  assert.equal(game.ball.y, 300);
  assert.ok(game.ball.vx > 0);
});

test('ball bounces off horizontal arena walls', () => {
  const game = createGame(900, 600);
  game.ball.y = game.ball.r;
  game.ball.vy = -200;
  stepGame(game, 1 / 60, []);
  assert.ok(game.ball.vy > 0);
});

test('side paddle collision reverses horizontal direction', () => {
  const game = createGame(900, 600);
  game.ball.x = 42;
  game.ball.y = 300;
  game.ball.vx = -250;
  stepGame(game, 1 / 60, [{ axis: 'y', x: 24, y: 230, w: 16, h: 140 }]);
  assert.ok(game.ball.vx > 0);
});

test('crossing a goal awards point then resets ball', () => {
  const game = createGame(900, 600, () => 0.75);
  game.ball.x = 920;
  stepGame(game, 1 / 60, []);
  assert.deepEqual(game.score, { left: 1, right: 0 });
  assert.equal(game.ball.x, 450);
});

test('AI tracks ball smoothly and remains normalized', () => {
  assert.equal(moveAi(0.5, 600, 1), 0.56);
  assert.equal(moveAi(0.99, 600, 1), 1);
  assert.equal(moveAi(0.01, 0, 1), 0);
});

test('snapshots contain serializable compact physics state', () => {
  const snapshot = scoreSnapshot(createGame(900, 600));
  assert.deepEqual(Object.keys(snapshot), ['ball', 'score']);
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});
