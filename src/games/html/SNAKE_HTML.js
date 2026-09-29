// 由 games.js 拆出：游戏 HTML 单一来源，避免超长单行字符串。
export default `<!DOCTYPE html>
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
  .pad {
    display: grid; margin-top: 16px;
    grid-template-columns: repeat(3, min(60px, 22vw));
    grid-template-rows: repeat(3, min(60px, 22vw));
    gap: 8px; justify-content: center;
  }
  .pad button {
    width: 100%; height: 100%; font-size: 22px; line-height: 1;
    display: flex; align-items: center; justify-content: center;
    background: #2d2d44; color: #fff; border: 1px solid #3a3a58; border-radius: 12px;
    padding: 0;
  }
  .pad .up { grid-column: 2; grid-row: 1; }
  .pad .left { grid-column: 1; grid-row: 2; }
  .pad .right { grid-column: 3; grid-row: 2; }
  .pad .down { grid-column: 2; grid-row: 3; }
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
  <button class="up" data-dir="up" aria-label="上">▲</button>
  <button class="left" data-dir="left" aria-label="左">◀</button>
  <button class="right" data-dir="right" aria-label="右">▶</button>
  <button class="down" data-dir="down" aria-label="下">▼</button>
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
