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

test('resolveAudioSupport：在线/本地能力判定', async () => {
  const { resolveAudioSupport } = await import('../src/music/commentPrompts.js');
  assert.equal(resolveAudioSupport({ configs: [{ id: 'a', supportsAudio: true }], activeId: 'a' }), true,
    '在线配置标记 supportsAudio 即视为可听音频');
  assert.equal(resolveAudioSupport({ configs: [{ id: 'a', supportsAudio: false }], activeId: 'a' }), false,
    '在线配置未标记音频能力时不支持');
  assert.equal(resolveAudioSupport({ configs: [{ id: 'a' }, { id: 'b', supportsAudio: true }], activeId: 'b' }), true,
    '按 activeId 选中配置判定');
  assert.equal(resolveAudioSupport({ configs: [{ id: 'a' }], activeId: 'missing' }, null), false,
    'activeId 失配时退回首个配置');
  assert.equal(resolveAudioSupport(undefined), false, '拿不到配置时按不支持处理');
  assert.equal(resolveAudioSupport(null, { audio: true }), true, '本地模型带音频能力即可听');
  assert.equal(resolveAudioSupport({ configs: [{ id: 'a', supportsAudio: false }], activeId: 'a' }, { audio: true }), true,
    '在线不支持但本地支持时仍可听');
});

test('听歌面板：无音频能力时给出提示接线', () => {
  const source = readSource('src/music/MusicScreen.js');
  assert.ok(source.includes('audioSupported'), '面板读取音频能力');
  assert.ok(source.includes("t('music.comments.noAudio')"), '无音频能力时渲染提示文案');
  assert.ok(source.includes("t('music.comments.audioTooLarge')"), '音频过大时渲染提示文案');
  assert.ok(source.includes('AudioClipWebView') && source.includes('clipAudio'), '面板挂载裁剪 WebView 并注入裁剪函数');
  const hook = readSource('src/music/useMusicComments.js');
  assert.ok(hook.includes('resolveAudioSupport'), 'hook 复用纯函数判定');
  assert.ok(hook.includes('prepareSongAudioForModel') && hook.includes('voiceAudio'), '具备能力时把歌曲音频随请求发送');
  assert.ok(hook.includes('sendWithModelProvider'), '经模型路由（本地多模态优先）');
  assert.ok(hook.includes('filterRequestMedia'), '本地/在线分别按能力裁剪媒体');
  const zh = readSource('src/i18n/locales/zh-CN.js');
  const en = readSource('src/i18n/locales/en.js');
  assert.ok(zh.includes("'music.comments.noAudio'") && en.includes("'music.comments.noAudio'"),
    '中英文案齐备');
});

test('canAttachSongAudio：体积与 uri 判定', async () => {
  const {
    canAttachSongAudio,
    MUSIC_AUDIO_MAX_BYTES,
    MUSIC_DECODE_MAX_BYTES,
    buildOpeningCommentPrompt,
    buildTriggerCommentPrompt,
  } = await import('../src/music/commentPrompts.js');
  assert.equal(canAttachSongAudio({ uri: 'file:///a.mp3', size: 1024 }), true, '正常歌曲可附');
  assert.equal(canAttachSongAudio({ uri: '', size: 1024 }), false, '无 uri 不可附');
  assert.equal(canAttachSongAudio({ uri: 'file:///a.mp3', size: 0 }), false, '体积未知不可附');
  assert.equal(canAttachSongAudio({ uri: 'file:///a.mp3', size: MUSIC_AUDIO_MAX_BYTES + 1 }), false, '超上限不可附');
  assert.equal(canAttachSongAudio({ uri: 'file:///a.mp3', size: MUSIC_AUDIO_MAX_BYTES }), true, '恰好等于上限可附');
  assert.equal(
    canAttachSongAudio({ uri: 'file:///a.mp3', size: MUSIC_AUDIO_MAX_BYTES + 1 }, MUSIC_DECODE_MAX_BYTES),
    true,
    '裁剪路径放宽到解码上限'
  );
  assert.equal(canAttachSongAudio({ uri: 'file:///a.mp3', size: MUSIC_DECODE_MAX_BYTES + 1 }, MUSIC_DECODE_MAX_BYTES), false,
    '超过解码上限仍不可附');
  assert.equal(canAttachSongAudio(null), false, '空对象安全');

  const withAudio = buildOpeningCommentPrompt({ songName: '晴天', durationMs: 1000, withAudio: true });
  const noAudio = buildOpeningCommentPrompt({ songName: '晴天', durationMs: 1000 });
  assert.ok(withAudio.includes('随附') && withAudio.includes('已经听到了'), '有音频时提示词声明已听到');
  assert.ok(!noAudio.includes('随附'), '无音频时不提音频');
  const triggerWithAudio = buildTriggerCommentPrompt({ songName: '晴天', positionMs: 500, durationMs: 1000, note: '这里', withAudio: true });
  assert.ok(triggerWithAudio.includes('随附') && triggerWithAudio.includes('这里'), '打点提示词保留备注并声明音频');
});

test('audioClip：WAV 编码、重采样与 WebView 脚本', async () => {
  const {
    CLIP_DURATION_MS,
    CLIP_SAMPLE_RATE,
    encodeWavFromPcm,
    resampleToMono,
    buildAudioClipHtml,
  } = await import('../src/music/audioClip.js');

  assert.equal(CLIP_DURATION_MS, 30000, '片段固定 30 秒');
  assert.equal(CLIP_SAMPLE_RATE, 16000, '统一下采样到 16kHz');

  const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const wav = encodeWavFromPcm(pcm, CLIP_SAMPLE_RATE);
  const view = new DataView(wav);
  const text = (offset, length) => Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join('');
  assert.equal(text(0, 4), 'RIFF', 'RIFF 头');
  assert.equal(text(8, 4), 'WAVE', 'WAVE 标识');
  assert.equal(text(12, 4), 'fmt ', 'fmt 块');
  assert.equal(view.getUint16(22, true), 1, '单声道');
  assert.equal(view.getUint32(24, true), CLIP_SAMPLE_RATE, '采样率写入');
  assert.equal(view.getUint32(40, true), pcm.length * 2, 'data 长度');
  assert.equal(wav.byteLength, 44 + pcm.length * 2, '总长度 = 头 + PCM');
  assert.equal(view.getInt16(44, true), 0, '第一个样本');
  assert.equal(view.getInt16(46, true), Math.trunc(0.5 * 0x7fff), '正样本按 int16 缩放');
  assert.equal(view.getInt16(48, true), Math.trunc(-0.5 * 0x8000), '负样本按 int16 缩放');
  assert.equal(view.getInt16(50, true), 0x7fff, '1 夹到满量程');
  assert.equal(view.getInt16(52, true), -0x8000, '-1 夹到负满量程');

  const stereo = [new Float32Array([1, 1, 1, 1]), new Float32Array([0, 0, 0, 0])];
  const mono = resampleToMono(stereo, 16000, 16000);
  assert.equal(mono.length, 4, '同采样率不变长');
  assert.equal(mono[0], 0.5, '双声道取平均');

  const html = buildAudioClipHtml();
  assert.ok(html.includes('decodeAudioData'), '脚本用 Web Audio 解码任意格式');
  assert.ok(html.includes('__clipAudio'), '暴露调入口');
  assert.ok(html.includes('resampleToMono') && html.includes('encodeWavFromPcm'), '注入被测试的纯函数源码');
  assert.ok(html.includes('ReactNativeWebView') && html.includes('postMessage'), '通过桥回传结果');
});

test('裁剪失败写诊断日志', () => {
  const source = readSource('src/music/AudioClipWebView.js');
  assert.ok(source.includes('recordDiagnostic'), '裁剪失败必须落诊断');
  assert.ok(source.includes("'webview'"), '按 webview 分类');
  assert.ok(source.includes('music-audio-clip'), '带可检索上下文标记');
});
