const GUESS_NUMBER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: #1a1a2e; color: #ffffff;
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
    display: flex; align-items: center; justify-content: center;
    padding: 20px; text-align: center;
  }
  .wrap { width: 100%; max-width: 420px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #aaa; font-size: 13px; margin: 0 0 18px; }
  input {
    width: 100%; padding: 12px; font-size: 18px; text-align: center;
    background: #2d2d44; color: #fff; border: 1px solid #3a3a58; border-radius: 10px;
  }
  button {
    width: 100%; margin-top: 12px; padding: 13px; font-size: 16px; font-weight: 700;
    background: #6c63ff; color: #fff; border: none; border-radius: 10px;
  }
  #msg { min-height: 24px; margin-top: 16px; font-size: 15px; font-weight: 600; }
  #meta { color: #888; font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>猜数字</h1>
  <p>我心里有个 1 到 100 之间的整数，来猜猜看。</p>
  <input id="guess" type="number" inputmode="numeric" placeholder="输入数字" />
  <button id="submit">提交</button>
  <div id="msg"></div>
  <div id="meta"></div>
</div>
<script>
  var answer = Math.floor(Math.random() * 100) + 1;
  var tries = 0;
  var input = document.getElementById('guess');
  var msg = document.getElementById('msg');
  var meta = document.getElementById('meta');
  function reset() {
    answer = Math.floor(Math.random() * 100) + 1;
    tries = 0;
    input.value = '';
    msg.textContent = '';
    meta.textContent = '';
    input.focus();
  }
  function submit() {
    var value = parseInt(input.value, 10);
    if (!value || value < 1 || value > 100) {
      msg.textContent = '请输入 1 到 100 之间的整数';
      return;
    }
    tries += 1;
    if (value === answer) {
      msg.textContent = '答对了！共猜了 ' + tries + ' 次';
      meta.textContent = '再次点击「提交」或输入新数字将重新开始';
      answer = -1;
    } else if (value < answer) {
      msg.textContent = '太小了';
    } else {
      msg.textContent = '太大了';
    }
    input.value = '';
    if (answer === -1) {
      setTimeout(reset, 1200);
    }
  }
  document.getElementById('submit').addEventListener('click', submit);
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.keyCode === 13) submit();
  });
</script>
</body>
</html>`;

const SNAKE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: #1a1a2e; color: #ffffff;
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 16px;
  }
  h1 { font-size: 20px; margin: 0 0 6px; }
  #score { color: #aaa; font-size: 13px; margin-bottom: 12px; }
  canvas { background: #20203a; border-radius: 12px; touch-action: none; }
  .pad { display: flex; margin-top: 16px; }
  .pad button {
    width: 60px; height: 60px; margin: 4px; font-size: 22px;
    background: #2d2d44; color: #fff; border: 1px solid #3a3a58; border-radius: 12px;
  }
  .col { display: flex; flex-direction: column; }
  #restart {
    margin-top: 8px; padding: 10px 20px; background: #6c63ff; color: #fff;
    border: none; border-radius: 10px; font-size: 14px; font-weight: 700;
  }
</style>
</head>
<body>
<h1>贪吃蛇</h1>
<div id="score">得分：0</div>
<canvas id="board" width="300" height="300"></canvas>
<div class="pad">
  <div class="col">
    <button data-dir="up">▲</button>
    <button data-dir="down">▼</button>
  </div>
  <div class="col">
    <button data-dir="left">◀</button>
    <button data-dir="right">▶</button>
  </div>
</div>
<button id="restart">重新开始</button>
<script>
  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');
  var CELL = 15;
  var COUNT = canvas.width / CELL;
  var snake, dir, nextDir, food, score, timer, alive;
  var scoreEl = document.getElementById('score');

  function placeFood() {
    var spot;
    do {
      spot = { x: Math.floor(Math.random() * COUNT), y: Math.floor(Math.random() * COUNT) };
    } while (snake.some(function (part) { return part.x === spot.x && part.y === spot.y; }));
    food = spot;
  }

  function start() {
    snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    dir = { x: 1, y: 0 };
    nextDir = dir;
    score = 0;
    alive = true;
    scoreEl.textContent = '得分：0';
    placeFood();
    if (timer) clearInterval(timer);
    timer = setInterval(tick, 140);
    draw();
  }

  function tick() {
    if (!alive) return;
    dir = nextDir;
    var head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    if (head.x < 0 || head.y < 0 || head.x >= COUNT || head.y >= COUNT) return gameOver();
    if (snake.some(function (part) { return part.x === head.x && part.y === head.y; })) return gameOver();
    snake.unshift(head);
    if (head.x === food.x && head.y === food.y) {
      score += 1;
      scoreEl.textContent = '得分：' + score;
      placeFood();
    } else {
      snake.pop();
    }
    draw();
  }

  function gameOver() {
    alive = false;
    clearInterval(timer);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('游戏结束', canvas.width / 2, canvas.height / 2 - 10);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#aaa';
    ctx.fillText('得分 ' + score, canvas.width / 2, canvas.height / 2 + 16);
  }

  function draw() {
    ctx.fillStyle = '#20203a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ff5a5f';
    ctx.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);
    snake.forEach(function (part, index) {
      ctx.fillStyle = index === 0 ? '#8b85ff' : '#6c63ff';
      ctx.fillRect(part.x * CELL + 1, part.y * CELL + 1, CELL - 2, CELL - 2);
    });
  }

  function setDir(name) {
    var table = {
      up: { x: 0, y: -1 },
      down: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
      right: { x: 1, y: 0 }
    };
    var candidate = table[name];
    if (!candidate) return;
    if (candidate.x === -dir.x && candidate.y === -dir.y) return;
    nextDir = candidate;
  }

  Array.prototype.forEach.call(document.querySelectorAll('button[data-dir]'), function (button) {
    button.addEventListener('click', function () { setDir(button.getAttribute('data-dir')); });
  });
  document.getElementById('restart').addEventListener('click', start);
  document.addEventListener('keydown', function (event) {
    var map = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    if (map[event.key]) { event.preventDefault(); setDir(map[event.key]); }
  });

  var startX = 0, startY = 0;
  canvas.addEventListener('touchstart', function (event) {
    var touch = event.changedTouches[0];
    startX = touch.clientX;
    startY = touch.clientY;
  });
  canvas.addEventListener('touchend', function (event) {
    var touch = event.changedTouches[0];
    var dx = touch.clientX - startX;
    var dy = touch.clientY - startY;
    if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
    setDir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  });
  document.addEventListener('touchmove', function (event) { event.preventDefault(); }, { passive: false });

  start();
</script>
</body>
</html>`;

const BREAKOUT_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background: #1a1a2e; color: #ffffff;
    font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 16px;
  }
  h1 { font-size: 20px; margin: 0 0 6px; }
  #score { color: #aaa; font-size: 13px; margin-bottom: 12px; }
  canvas { background: #20203a; border-radius: 12px; touch-action: none; }
  #restart {
    margin-top: 14px; padding: 10px 20px; background: #6c63ff; color: #fff;
    border: none; border-radius: 10px; font-size: 14px; font-weight: 700;
  }
  p { color: #888; font-size: 12px; margin: 10px 0 0; }
</style>
</head>
<body>
<h1>打砖块</h1>
<div id="score">得分：0</div>
<canvas id="board" width="300" height="360"></canvas>
<button id="restart">重新开始</button>
<p>拖动屏幕底部移动挡板</p>
<script>
  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');
  var W = canvas.width;
  var H = canvas.height;
  var PADDLE_W = 70;
  var PADDLE_H = 10;
  var BALL_R = 6;
  var COLS = 6;
  var ROWS = 4;
  var BRICK_W = (W - 20) / COLS;
  var BRICK_H = 16;
  var paddle, ball, bricks, score, alive, raf;
  var scoreEl = document.getElementById('score');

  function reset() {
    paddle = { x: (W - PADDLE_W) / 2 };
    ball = { x: W / 2, y: H - 30, vx: 2.4, vy: -2.8 };
    score = 0;
    alive = true;
    scoreEl.textContent = '得分：0';
    bricks = [];
    for (var row = 0; row < ROWS; row += 1) {
      for (var col = 0; col < COLS; col += 1) {
        bricks.push({ x: 10 + col * BRICK_W, y: 40 + row * (BRICK_H + 6), alive: true });
      }
    }
    if (raf) cancelAnimationFrame(raf);
    loop();
  }

  function step() {
    if (!alive) return;
    ball.x += ball.vx;
    ball.y += ball.vy;
    if (ball.x < BALL_R || ball.x > W - BALL_R) ball.vx = -ball.vx;
    if (ball.y < BALL_R) ball.vy = -ball.vy;
    if (ball.y > H) return gameOver();
    if (
      ball.y + BALL_R >= H - 20 &&
      ball.y + BALL_R <= H - 10 &&
      ball.x >= paddle.x &&
      ball.x <= paddle.x + PADDLE_W
    ) {
      ball.vy = -Math.abs(ball.vy);
      var offset = (ball.x - (paddle.x + PADDLE_W / 2)) / (PADDLE_W / 2);
      ball.vx = 2.4 * offset;
    }
    bricks.forEach(function (brick) {
      if (!brick.alive) return;
      if (
        ball.x + BALL_R > brick.x &&
        ball.x - BALL_R < brick.x + BRICK_W &&
        ball.y + BALL_R > brick.y &&
        ball.y - BALL_R < brick.y + BRICK_H
      ) {
        brick.alive = false;
        ball.vy = -ball.vy;
        score += 1;
        scoreEl.textContent = '得分：' + score;
      }
    });
    if (bricks.every(function (brick) { return !brick.alive; })) return win();
  }

  function draw() {
    ctx.fillStyle = '#20203a';
    ctx.fillRect(0, 0, W, H);
    bricks.forEach(function (brick) {
      if (!brick.alive) return;
      ctx.fillStyle = '#6c63ff';
      ctx.fillRect(brick.x, brick.y, BRICK_W - 4, BRICK_H);
    });
    ctx.fillStyle = '#8b85ff';
    ctx.fillRect(paddle.x, H - 20, PADDLE_W, PADDLE_H);
    ctx.fillStyle = '#ff5a5f';
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
  }

  function loop() {
    if (!alive) return;
    step();
    draw();
    raf = requestAnimationFrame(loop);
  }

  function overlay(text, sub) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(text, W / 2, H / 2 - 10);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#aaa';
    ctx.fillText(sub, W / 2, H / 2 + 16);
  }

  function gameOver() {
    alive = false;
    overlay('游戏结束', '得分 ' + score);
  }

  function win() {
    alive = false;
    overlay('全部击破！', '得分 ' + score);
  }

  function movePaddle(clientX) {
    var rect = canvas.getBoundingClientRect();
    var x = clientX - rect.left - PADDLE_W / 2;
    paddle.x = Math.max(0, Math.min(W - PADDLE_W, x));
  }

  canvas.addEventListener('touchstart', function (event) {
    movePaddle(event.changedTouches[0].clientX);
  });
  canvas.addEventListener('touchmove', function (event) {
    event.preventDefault();
    movePaddle(event.changedTouches[0].clientX);
  }, { passive: false });
  canvas.addEventListener('mousemove', function (event) { movePaddle(event.clientX); });
  document.getElementById('restart').addEventListener('click', reset);

  reset();
</script>
</body>
</html>`;

export const GAMES = [
  {
    id: 'guess-number',
    name: '猜数字',
    description: '猜出 1 到 100 之间的随机整数，提示偏大或偏小。',
    html: GUESS_NUMBER_HTML,
  },
  {
    id: 'snake',
    name: '贪吃蛇',
    description: '用方向键或触摸滑动控制小蛇吃食物，撞墙或咬到自己结束。',
    html: SNAKE_HTML,
  },
  {
    id: 'breakout',
    name: '打砖块',
    description: '拖动底部挡板反弹小球，击破全部砖块即可获胜。',
    html: BREAKOUT_HTML,
  },
];

export function getGame(id) {
  return GAMES.find(game => game.id === id) || null;
}
