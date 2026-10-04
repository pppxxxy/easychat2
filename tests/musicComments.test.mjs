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

test('resolveAudioSupport：在线配置音频能力判定', async () => {
  const { resolveAudioSupport } = await import('../src/music/commentPrompts.js');
  assert.equal(resolveAudioSupport({ configs: [{ id: 'a', supportsAudio: true }], activeId: 'a' }), true,
    '在线配置标记 supportsAudio 即视为可听音频');
  assert.equal(resolveAudioSupport({ configs: [{ id: 'a', supportsAudio: false }], activeId: 'a' }), false,
    '在线配置未标记音频能力时不支持');
  assert.equal(resolveAudioSupport({ configs: [{ id: 'a' }, { id: 'b', supportsAudio: true }], activeId: 'b' }), true,
    '按 activeId 选中配置判定');
  assert.equal(resolveAudioSupport({ configs: [{ id: 'a' }], activeId: 'missing' }), false,
    'activeId 失配时退回首个配置');
  assert.equal(resolveAudioSupport(undefined), false, '拿不到配置时按不支持处理');
});

test('听歌面板：无音频能力时给出提示接线', () => {
  const source = readSource('src/music/MusicScreen.js');
  assert.ok(source.includes('audioSupported'), '面板读取音频能力');
  assert.ok(source.includes("t('music.comments.noAudio')"), '无音频能力时渲染提示文案');
  assert.ok(source.includes("t('music.comments.audioTooLarge')"), '音频过大时渲染提示文案');
  const hook = readSource('src/music/useMusicComments.js');
  assert.ok(hook.includes('resolveAudioSupport'), 'hook 复用纯函数判定');
  assert.ok(hook.includes('readSongAudioForModel') && hook.includes('voiceAudio'), '具备能力时把歌曲音频随请求发送');
  const zh = readSource('src/i18n/locales/zh-CN.js');
  const en = readSource('src/i18n/locales/en.js');
  assert.ok(zh.includes("'music.comments.noAudio'") && en.includes("'music.comments.noAudio'"),
    '中英文案齐备');
});

test('canAttachSongAudio：体积与 uri 判定', async () => {
  const { canAttachSongAudio, MUSIC_AUDIO_MAX_BYTES, buildOpeningCommentPrompt, buildTriggerCommentPrompt } =
    await import('../src/music/commentPrompts.js');
  assert.equal(canAttachSongAudio({ uri: 'file:///a.mp3', size: 1024 }), true, '正常歌曲可附');
  assert.equal(canAttachSongAudio({ uri: '', size: 1024 }), false, '无 uri 不可附');
  assert.equal(canAttachSongAudio({ uri: 'file:///a.mp3', size: 0 }), false, '体积未知不可附');
  assert.equal(canAttachSongAudio({ uri: 'file:///a.mp3', size: MUSIC_AUDIO_MAX_BYTES + 1 }), false, '超上限不可附');
  assert.equal(canAttachSongAudio({ uri: 'file:///a.mp3', size: MUSIC_AUDIO_MAX_BYTES }), true, '恰好等于上限可附');
  assert.equal(canAttachSongAudio(null), false, '空对象安全');

  const withAudio = buildOpeningCommentPrompt({ songName: '晴天', durationMs: 1000, withAudio: true });
  const noAudio = buildOpeningCommentPrompt({ songName: '晴天', durationMs: 1000 });
  assert.ok(withAudio.includes('随附') && withAudio.includes('已经听到了'), '有音频时提示词声明已听到');
  assert.ok(!noAudio.includes('随附'), '无音频时不提音频');
  const triggerWithAudio = buildTriggerCommentPrompt({ songName: '晴天', positionMs: 500, durationMs: 1000, note: '这里', withAudio: true });
  assert.ok(triggerWithAudio.includes('随附') && triggerWithAudio.includes('这里'), '打点提示词保留备注并声明音频');
});
