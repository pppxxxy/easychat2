// 看屏幕评论链路源码断言：
// - 请求必须以 images:[uri] 携带截图（多模态），prompt 走纯函数；
// - 视觉门控与聊天附件菜单同一口径（supportsVision 或本地多模态），无视觉能力
//   必须给 NO_VISION 明确错误而不是发一个看不懂的请求；
// - 截图先落本地、重试复用同一张（评论针对同一画面）；
// - 接话复用 pendingQuote 机制。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('useScreenWatchComments：多模态带图 + 视觉门控 + 链路守卫', () => {
  const source = readSource('src/screenWatch/useScreenWatchComments.js');
  assert.ok(source.includes('images: uri ? [uri] : []'), '截图以 images 参数走多模态');
  assert.ok(source.includes('getLocalModelMediaCapabilities'), '视觉判定含本地模型多模态');
  assert.ok(source.includes('supportsVision === true'), '视觉判定含在线来源标记');
  assert.ok(source.includes("code: 'NO_VISION'"), '无视觉能力必须给 NO_VISION 错误');
  assert.ok(source.includes('buildScreenWatchPrompt'), 'prompt 走纯函数');
  assert.ok(/stream:\s*false/.test(source) && source.includes('expectedConfigId'),
    '一次性生成 + 配置守卫');
  assert.ok(source.includes('appendScreenWatchComment'), '落库走 comments.js');
  assert.ok(source.includes('lastFailedRef'), '失败可重试（复用同一张截图）');
});

test('ScreenWatchScreen：截屏→评论→接话接线', () => {
  const source = readSource('src/screenWatch/ScreenWatchScreen.js');
  assert.ok(source.includes('captureAppScreen'), '截屏链路接线');
  assert.ok(source.includes('generate({ imageUri: uri })'), '截图 uri 传入评论生成（失败重试由 hook 的 lastFailedRef 复用）');
  assert.ok(source.includes('ensureCharacterSession') && source.includes("navigation.navigate('聊天')"),
    '接话 = 确保会话 + 切聊天页');
  assert.ok(source.includes('setPendingQuote'), '接话复用 pendingQuote');
  assert.ok(source.includes('截屏时这个面板也会入镜') || source.includes('只包含本应用的画面'),
    'v1 固有限制必须如实告知用户');
  assert.ok(source.includes('NO_VISION') || source.includes('识图'), '无视觉能力时面板可见原因');
});
