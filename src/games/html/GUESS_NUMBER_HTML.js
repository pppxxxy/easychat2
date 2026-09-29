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
  #range { margin-top: 16px; font-size: 15px; font-weight: 700; color: #7ad1ff; }
  #msg { min-height: 24px; margin-top: 8px; font-size: 15px; font-weight: 600; }
  #meta { color: #888; font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>猜数字</h1>
  <p>我心里有个 1 到 100 之间的整数，每猜一次都会缩小范围。</p>
  <input id="guess" type="number" inputmode="numeric" placeholder="输入数字" />
  <button id="submit">提交</button>
  <div id="range"></div>
  <div id="msg"></div>
  <div id="meta"></div>
</div>
<script>
  var MIN = 1;
  var MAX = 100;
  var answer = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
  var tries = 0;
  var low = MIN;
  var high = MAX;
  var input = document.getElementById('guess');
  var msg = document.getElementById('msg');
  var range = document.getElementById('range');
  var meta = document.getElementById('meta');
  function renderRange() {
    range.textContent = low === high
      ? '数字只能是 ' + low + ' 了'
      : '数字在 ' + low + ' 到 ' + high + ' 之间';
  }
  function reset() {
    answer = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;
    tries = 0;
    low = MIN;
    high = MAX;
    input.value = '';
    msg.textContent = '';
    meta.textContent = '';
    renderRange();
    input.focus();
  }
  function submit() {
    if (answer === -1) return;
    var value = parseInt(input.value, 10);
    if (!Number.isFinite(value) || value < MIN || value > MAX) {
      msg.textContent = '请输入 ' + MIN + ' 到 ' + MAX + ' 之间的整数';
      return;
    }
    tries += 1;
    if (value === answer) {
      msg.textContent = '答对了！共猜了 ' + tries + ' 次';
      meta.textContent = '稍后自动开始新一局';
      range.textContent = '答案就是 ' + value;
      answer = -1;
    } else if (value < answer) {
      low = Math.max(low, value + 1);
      msg.textContent = '太小了';
      renderRange();
    } else {
      high = Math.min(high, value - 1);
      msg.textContent = '太大了';
      renderRange();
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
  renderRange();
</script>
</body>
</html>`;
