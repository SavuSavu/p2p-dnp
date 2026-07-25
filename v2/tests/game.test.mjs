import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, stepGame, aiTarget, paddleGeometry } from '../js/game.mjs';

test('new single-player game places human left and AI right', () => {
  const game = createGame(['Ada', 'DNP-9000']);
  assert.equal(game.players[0].edge, 'left');
  assert.equal(game.players[1].edge, 'right');
  assert.deepEqual(game.score, [0, 0]);
});

test('side and horizontal paddle geometry obeys edge axis and half clamps', () => {
  const game = createGame(['A','B','C','D','E','F']);
  const left = paddleGeometry(game.players[0], 1000, 600);
  const topLeft = paddleGeometry(game.players[2], 1000, 600);
  const topRight = paddleGeometry(game.players[3], 1000, 600);
  assert.ok(left.h > left.w);
  assert.ok(topLeft.w > topLeft.h);
  assert.ok(topLeft.x + topLeft.w <= 500);
  assert.ok(topRight.x >= 500);
});

test('paired split-slot occupants get distinct non-overlapping sub-regions', () => {
  const game = createGame(Array.from({ length: 12 }, (_, i) => `P${i + 1}`));
  for (const [first, second] of [[0, 6], [1, 7]]) {
    game.players[first].position = 1;
    game.players[second].position = -1;
    const a = paddleGeometry(game.players[first], 1000, 600);
    const b = paddleGeometry(game.players[second], 1000, 600);
    assert.ok(a.y + a.h <= b.y, `side pair ${first + 1}/${second + 1} overlaps`);
  }
  for (const [first, second] of [[2, 8], [3, 9], [4, 10], [5, 11]]) {
    game.players[first].position = 1;
    game.players[second].position = -1;
    const a = paddleGeometry(game.players[first], 1000, 600);
    const b = paddleGeometry(game.players[second], 1000, 600);
    assert.ok(a.x + a.w <= b.x, `horizontal pair ${first + 1}/${second + 1} overlaps`);
  }
});

test('AI predicts a bounded intercept rather than simply following the ball', () => {
  const game = createGame(['A','AI']);
  game.ball = { x: .35, y: .2, vx: .7, vy: .55, r: .012 };
  const target = aiTarget(game);
  assert.ok(target >= .08 && target <= .92);
  assert.notEqual(target, game.ball.y);
});

test('step scores across side goals and resets ball toward conceding side', () => {
  const game = createGame(['A','B']);
  game.ball.x = 1.02; game.ball.vx = .5;
  const next = stepGame(game, 1 / 60, new Map());
  assert.deepEqual(next.score, [1, 0]);
  assert.equal(next.ball.x, .5);
  assert.ok(next.ball.vx > 0);
});

test('step clamps player input and bounces from an occupied paddle', () => {
  const game = createGame(['A','B']);
  game.players[0].position = .5;
  game.ball = { x: .035, y: .5, vx: -.55, vy: 0, r: .012 };
  const next = stepGame(game, 1 / 60, new Map([[0, -1]]));
  assert.ok(next.players[0].position < .5);
  assert.ok(next.ball.vx > 0);
});
