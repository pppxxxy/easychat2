// 陪伴评论与「接话」链路的源码断言（RN/hook 依赖原生运行时，Node 只能锁关键接线）。
// 关键回归点：
// - 评论走与动态同款的 buildRequestMessages + sendChatMessage(stream:false) 链路，
//   带配置切换守卫（expectedConfigId/Fingerprint）——切配置瞬间触发的评论不得串配置；
// - 接话必须先 ensureCharacterSession（找到或新建该角色会话），再 setPendingQuote +
//   navigate('聊天')，引用带 sessionId 戳；
// - ChatScreen 只在目标会话激活时消费引用一次（防切会话串场）；评论 payload.id 为空，
//   点引用块不触发「原消息已删除」定位。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('useMusicComments：评论链路与守卫齐全', () => {
  const source = readSource('src/music/useMusicComments.js');
  assert.ok(source.includes('buildRequestMessages'), '复用与聊天同口径的消息组装');
  assert.ok(/stream:\s*false/.test(source), '评论一次性生成，不流式');
  assert.ok(source.includes('expectedConfigId') && source.includes('expectedConfigFingerprint'),
    '必须带配置切换守卫');
  assert.ok(source.includes('appendMusicComment') && source.includes('getMusicComments'),
    '评论落库/读取走 comments.js 分键');
  assert.ok(source.includes('EMPTY_REPLY_TEXT'), '空响应占位文本必须按失败处理');
  assert.ok(source.includes('isCanceledError'), '取消不算失败（不误报错误条）');
  assert.ok(/generatingRef\.current\s*&&\s*/.test(source) || /if \(!currentSong \|\| generatingRef\.current\) return false/.test(source),
    '生成必须串行（在途时跳过新触发）');
});

test('MusicScreen：触发评估与接话接线', () => {
  const source = readSource('src/music/MusicScreen.js');
  assert.ok(source.includes('collectTriggersToCross') && source.includes('isSeekJump')
    && source.includes('resolveFiredIdsAtPosition'), '触发判定必须复用 triggers.js 纯函数');
  assert.ok(source.includes('firedRef.current.has(trigger.id)'), '同一次播放内同一打点不得重复触发');
  assert.ok(source.includes('ensureCharacterSession'), '接话前必须确保该角色会话存在');
  assert.ok(source.includes("navigation.navigate('聊天')"), '接话切到聊天页');
  assert.ok(source.includes("kind: 'opening'"), '开播自动请求开场评论');
});

test('AppContext + ChatScreen：pendingQuote 生产/消费对称', () => {
  const context = readSource('src/context/AppContext.js');
  assert.ok(context.includes('setPendingQuote') && context.includes('consumePendingQuote'),
    'AppContext 暴露 set/consume 对');
  assert.ok(context.includes('pendingQuoteRef'), '消费必须走 ref（导航竞态下 state 可能未提交）');
  const chat = readSource('src/ChatScreen.js');
  assert.ok(chat.includes('pendingQuote') && chat.includes('consumePendingQuote'), '聊天页消费接线');
  assert.ok(chat.includes('pendingQuote.sessionId !== activeSessionId'),
    '只在目标会话激活时消费，防切会话串场');
  assert.ok(/consumePendingQuote\(\)[\s\S]{0,120}setQuoteTarget\(/.test(chat),
    '消费后写入引用条，且一次性');
});
