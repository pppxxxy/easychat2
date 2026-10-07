// 看屏幕评论链路源码断言：
// - 请求必须以 images:[dataUri] 携带截图（接口只认 data:/http URL，file:// 会被拒），
//   prompt 走纯函数；
// - 视觉门控与聊天附件菜单同一口径（supportsVision 或本地多模态），无视觉能力
//   必须给 NO_VISION 明确错误而不是发一个看不懂的请求；
// - 截图先落本地、重试复用同一张（评论针对同一画面）；
// - 接话复用 pendingQuote 机制。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localeSource } from './helpers/localeSource.mjs';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('useScreenWatchComments：多模态带图 + 视觉门控 + 链路守卫', () => {
  const source = readSource('src/screenWatch/useScreenWatchComments.js');
  assert.ok(source.includes('images: dataUris'), '截图读成 data URI 后以 images 参数走多模态');
  assert.ok(source.includes('readImageDataUri'), '本地 file:// 截图先转 data URI（接口只认 data:/http URL）');
  assert.ok(source.includes('imageUris'), '支持视频帧序列（多图）');
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
  assert.ok(source.includes('ensureCharacterSession') && source.includes('navigation.navigate(ROUTE_NAMES.chat)'),
    '接话 = 确保会话 + 切聊天页');
  assert.ok(source.includes('setPendingQuote'), '接话复用 pendingQuote');
  // 限制文案已迁 i18n：断言 key 存在，并断言基准语言词条确实说明了限制
  assert.ok(source.includes("t('screenWatch.limits')"), 'v1 固有限制必须如实告知用户（i18n key）');
  const zh = localeSource('src/i18n/locales/zh-CN');
  assert.ok(zh.includes('只包含本应用的画面') && zh.includes('悬浮窗'),
    'zh-CN 限制词条必须说明只截本应用、跨应用走悬浮窗');
  // NO_VISION 分流在 hook 层（面板只显示 hook 给的错误文案）
  const hook = readSource('src/screenWatch/useScreenWatchComments.js');
  assert.ok(hook.includes("code: 'NO_VISION'"), '无视觉能力时以 NO_VISION 分流提示');
  assert.ok(hook.includes("t('screenWatch.error.noVision')"), 'NO_VISION 文案走 i18n key');
});

test('面板评论删除/清空接线（2026-10-07）：带确认、只动 comments 存储', () => {
  const screen = readSource('src/screenWatch/ScreenWatchScreen.js');
  // 卡片头删除按钮 + 二次确认（范式同记忆页删线程）
  assert.ok(screen.includes('handleDeleteComment(comment)'), '评论卡片必须接删除处理');
  assert.ok(screen.includes("t('screenWatch.comments.delete.title')"), '删除必须二次确认');
  assert.ok(screen.includes("style: 'destructive'"), '确认按钮 destructive 样式（同记忆页范式）');
  // 清空全部：接通此前从未被任何 UI 调用的 clearScreenWatchComments
  assert.ok(screen.includes('handleClearComments'), '列表底部必须有清空入口');
  assert.ok(screen.includes("t('screenWatch.comments.clear.title')"), '清空同样必须二次确认');
  // hook 暴露 remove/clearAll 并被解构
  const hook = readSource('src/screenWatch/useScreenWatchComments.js');
  assert.ok(hook.includes('remove') && hook.includes('clearAll'), 'hook 必须暴露 remove/clearAll');
  assert.ok(hook.includes('deleteScreenWatchComment') && hook.includes('clearScreenWatchComments'),
    'hook 必须调用数据层单删与整清');
  // 裁决边界：删除不做级联，线程归记忆页
  assert.ok(screen.includes("t('screenWatch.comments.threadsHint')"), '面板必须提示线程归记忆页管理');
  const dataLayer = readSource('src/screenWatch/comments.js');
  assert.ok(dataLayer.includes('export function deleteScreenWatchComment'), '数据层单删函数必须存在');
  assert.ok(!/from '\.\/threads(\.js)?'/.test(dataLayer), 'comments 数据层不得引用 threads 模块（删除不级联到线程）');
});
