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
import { localeSource } from './helpers/localeSource.mjs';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

// 剥掉注释再断言：源码注释里会**引用旧写法**（如 `.catch(() => {})`）说明「为什么改」，
// 不剥就会把解释文字当成代码命中。
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
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

test('useMusicComments：读失败必须暴露给面板，不得吞成「还没有评论」', () => {
  const source = readSource('src/music/useMusicComments.js');
  const code = stripComments(source);
  // 以前是 `.catch(() => {})`：读失败被演成「空列表」，面板显示「还没有评论」，
  // 用户以为评论丢了（数据其实还在存储里）。
  assert.equal(/\.catch\(\(\) => \{\}\)/.test(code), false, '读失败不得再被空 catch 吞掉');
  assert.ok(source.includes('commentsReadFailed'), '读路径失败要有独立错误态');
  assert.ok(source.includes('commentsError'), 'hook 要把读失败透出给面板');
  assert.ok(source.includes("t('music.comments.readFailed')"), '读失败文案与「生成失败」分开（不是 API 配置问题）');
  assert.ok(source.includes('error: error || commentsError'), '读失败要并进面板唯一读取的 error 通道才看得见');
  assert.ok(source.includes('if (commentsReadFailed) return loadComments()'),
    '重试要按失败类型走对分支（读失败 → 重新读盘）');

  // 语义必须是「数据还在，只是读不到」：读失败只标记错误，**不清空**已装载的评论。
  const loader = /const loadComments = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[\]\);/.exec(source);
  assert.ok(loader, '读路径必须收口在 loadComments 一处');
  assert.ok(loader[1].includes('catch'), '必须显式接住读失败');
  assert.ok(loader[1].includes('setCommentsReadFailed(true)'), '读失败要如实标记');
  assert.equal(loader[1].includes('setComments([])'), false, '读失败不得清空列表（读不到 ≠ 没有）');

  // 错误条与「还没有评论」**不得同时出现**：错误条写着「评论还在，只是这次没读出来」，
  // 紧接一行「还没有评论」会把那句话当场取消掉（两句互相矛盾，闭环等于被抹平）。
  const panel = stripComments(readSource('src/music/MusicScreen.js'));
  assert.ok(/comments\.length === 0 && !generating && !commentError/.test(panel),
    '读失败时不得再渲染「还没有评论」');

  const zh = localeSource('src/i18n/locales/zh-CN');
  const en = localeSource('src/i18n/locales/en');
  assert.ok(zh.includes("'music.comments.readFailed'") && en.includes("'music.comments.readFailed'"),
    '读失败文案中英齐备');
});

test('useMusicComments：裁剪设置的默认值必须可达（原 || 分支不可达且会压成 1ms/1Hz）', () => {
  const source = readSource('src/music/useMusicComments.js');
  // 原写法 `Math.max(1, Math.floor(Number(settings.clipSeconds) || 0) * 1000) || CLIP_DURATION_MS`：
  // Math.max(1, x) 恒 ≥ 1，右侧的 CLIP_DURATION_MS / CLIP_SAMPLE_RATE **永远不可达**；
  // 而真正没配置时（settings 为空）会得到 1ms / 1Hz，而不是注释里承诺的 30 秒 / 16kHz。
  assert.equal(source.includes('Math.max(1, Math.floor(Number(settings.clipSeconds)'), false,
    '不可达的 || 默认分支必须修掉');
  assert.equal(source.includes('Math.max(1, Math.floor(Number(settings.sampleRate)'), false,
    '不可达的 || 默认分支必须修掉');
  assert.ok(source.includes('positiveOrZero(settings.clipSeconds) * 1000) || CLIP_DURATION_MS'),
    '时长默认值（30 秒）必须真正可达');
  assert.ok(source.includes('positiveOrZero(settings.sampleRate)) || CLIP_SAMPLE_RATE'),
    '采样率默认值（16kHz）必须真正可达');
  assert.ok(/function positiveOrZero\(value\)[\s\S]{0,160}Number\.isFinite/.test(source),
    '无效值要显式归 0，默认分支才生效');
});

test('MusicScreen：触发评估与接话接线', () => {
  const source = readSource('src/music/MusicScreen.js');
  // 触发评估（越过打点判定 + 去重）已外提到该 hook。
  const triggers = readSource('src/music/useMusicTriggers.js');
  assert.ok(triggers.includes('collectTriggersToCross') && triggers.includes('isSeekJump')
    && triggers.includes('resolveFiredIdsAtPosition'), '触发判定必须复用 triggers.js 纯函数');
  assert.ok(triggers.includes('firedRef.current.has(trigger.id)'), '同一次播放内同一打点不得重复触发');
  assert.ok(source.includes('ensureCharacterSession'), '接话前必须确保该角色会话存在');
  assert.ok(source.includes('navigation.navigate(ROUTE_NAMES.chat)'), '接话切到聊天页（路由名走常量）');
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

test('resolveAudioSupport：按**模型**解析能力（不是废弃的配置级字段）', async () => {
  const { resolveAudioSupport, resolveOnlineAudioSupport } = await import('../src/music/commentPrompts.js');

  // 现行口径：能力挂在 modelCapabilities[模型名] 上（能力编辑器只写这里）。
  const perModel = {
    configs: [{ id: 'a', activeModel: 'm1', modelCapabilities: { m1: { supportsAudio: true } } }],
    activeId: 'a',
  };
  assert.equal(resolveAudioSupport(perModel), true, '当前模型声明 supportsAudio 即可听');

  // 同一配置、切到未确认的模型 → 不支持（未确认 = 全不支持）
  const otherModel = {
    configs: [{ id: 'a', activeModel: 'm2', modelCapabilities: { m1: { supportsAudio: true } } }],
    activeId: 'a',
  };
  assert.equal(resolveAudioSupport(otherModel), false, '换到无条目的模型应为不支持');
  assert.equal(resolveAudioSupport(otherModel, { audio: true }), true, '本地可听仍可听');

  // 这正是本次修的 bug：配置级 supportsAudio 是废弃字段。
  //
  // 旧数据的兼容**由存储层归一负责**（normalizeModelCapabilities 在 modelCapabilities
  // 缺失时按配置级旧字段给每个已有模型物化一份）——上方注释与任务书都明确要求
  // 「不要再自行加一层配置级读取」（那会让两套口径重新分叉）。
  // 所以这里不假设纯函数能读配置级字段，而是**先过一次存储层归一**再看结果，
  // 这才是生产里真实发生的事（getApiConfigs 读盘时就会归一）。
  const { normalizeModelCapabilities } = await import('../src/storage/modelCapabilities.js');
  // 模拟存储层读盘后的形状：{ configs: [...], activeId }，其中 configs 已归一。
  const materialize = raw => {
    const models = raw.models || [raw.activeModel || raw.model || 'deepseek-chat'];
    return {
      configs: [{
        ...raw,
        models,
        activeModel: raw.activeModel || models[0],
        modelCapabilities: normalizeModelCapabilities(
          raw.modelCapabilities,
          models,
          { supportsAudio: raw.supportsAudio === true }
        ),
      }],
      activeId: raw.id || 'a',
    };
  };
  assert.equal(
    resolveOnlineAudioSupport(materialize({ id: 'a', supportsAudio: true })),
    true,
    '旧式数据（只有配置级字段）经存储层归一后仍可听'
  );
  assert.equal(
    resolveOnlineAudioSupport({ configs: [{ id: 'a', supportsAudio: true }], activeId: 'a' }),
    false,
    '未经归一的裸配置不该被纯函数读配置级字段（口径单一：只认 modelCapabilities）'
  );
  // 反过来：配置级 false 但模型级 true —— 必须认模型级（旧实现会误判为 false）
  assert.equal(
    resolveOnlineAudioSupport({
      configs: [{ id: 'a', activeModel: 'm1', supportsAudio: false, modelCapabilities: { m1: { supportsAudio: true } } }],
      activeId: 'a',
    }),
    true,
    '配置级 false 不得压过模型级 true（旧实现正是在这里读错字段）'
  );
  assert.equal(
    resolveOnlineAudioSupport({
      configs: [{ id: 'a', activeModel: 'm1', supportsAudio: true, modelCapabilities: { m1: { supportsAudio: false } } }],
      activeId: 'a',
    }),
    false,
    '配置级 true 也不得压过模型级 false'
  );

  // activeId 选中与失配回落
  assert.equal(
    resolveOnlineAudioSupport({
      configs: [
        { id: 'a', activeModel: 'm', modelCapabilities: { m: { supportsAudio: false } } },
        { id: 'b', activeModel: 'm', modelCapabilities: { m: { supportsAudio: true } } },
      ],
      activeId: 'b',
    }),
    true,
    '按 activeId 选中配置判定'
  );
  assert.equal(
    resolveOnlineAudioSupport({ configs: [{ id: 'a' }], activeId: 'missing' }),
    false,
    'activeId 失配时退回首个配置'
  );
  assert.equal(resolveAudioSupport(undefined), false, '拿不到配置时按不支持处理');
  assert.equal(resolveAudioSupport(null, { audio: true }), true, '本地模型带音频能力即可听');
  assert.equal(
    resolveAudioSupport({ configs: [{ id: 'a' }], activeId: 'a' }, { audio: true }),
    true,
    '在线不支持但本地支持时仍可听'
  );
});

test('听歌侧不再读废弃的配置级 supportsAudio（结构性防回归）', async () => {
  const source = readSource('src/music/useMusicComments.js');
  const prompts = readSource('src/music/commentPrompts.js');

  // 消费点必须走逐模型口径
  assert.ok(prompts.includes('capabilitiesForModel'), 'commentPrompts 走逐模型能力解析');
  assert.ok(prompts.includes('modelCapabilities.js'),
    '能力解析从零依赖叶子导入（apiConfigs 会拉进 expo-file-system/legacy，Node 里加载不了）');

  // 第二个消费点（在线消息裁剪）同样不得读配置级字段
  assert.ok(!/allowAudio:\s*Boolean\(activeConfig && activeConfig\.supportsAudio\)/.test(source),
    'filterRequestMedia 的 allowAudio 不得读配置级 supportsAudio');
  assert.ok(source.includes('resolveOnlineAudioSupport(apiConfig)'),
    '在线消息裁剪必须用仅在线判据');

  // 配置级字段只允许作为 legacy 回落来源出现在 modelCapabilities.js 的归一里；
  // 这里只检查两个听歌文件不得再直接读它。
  assert.ok(!/current\.supportsAudio/.test(prompts), 'commentPrompts 不得读配置级 supportsAudio');
});

test('能力解析叶子必须保持零依赖（否则纯函数测试会因 expo-file-system 崩掉）', () => {
  // 这条守卫保护的是「可测性」本身：modelCapabilities.js 一旦引入任何 import，
  // 就可能（直接或间接）拉进 storage/io.js → expo-file-system/legacy，
  // 那个子路径在 Node 下不存在，会让所有直接 import 它的纯函数测试当场崩。
  // 这个坑在上次迁移时真实发生过（tests/imageRecognitionEngine.test.mjs 顶部有记）。
  const leaf = readSource('src/storage/modelCapabilities.js');
  // 只检查**代码**、跳过注释：文件里正解释着「为什么不能引 expo-file-system」，
  // 按整文件正则会把这段说明误当成违规（同 themeContrast 检测器与 FIX-6 的口径）。
  const codeLines = leaf.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line));
  const code = codeLines.join('\n');
  const imports = codeLines.filter(line => /^\s*import\b/.test(line));
  assert.deepEqual(imports, [], `能力解析叶子不得有 import，现有：${imports.join(' | ')}`);
  assert.ok(!/\brequire\s*\(/.test(code), '也不得用 require 绕开');
  // 反向确认：这个文件必须真的不依赖 RN / expo，才谈得上「纯」
  assert.ok(!/expo-|react-native/.test(code), '叶子不得引用 RN/expo 运行时');
  // 上面这条守卫有没有效力，取决于注释剔除逻辑本身：确认注释**确实**被剔掉了
  assert.ok(!code.includes('expo-file-system/legacy'),
    '注释应已被剔除（否则上一条断言形同虚设）');
  // apiConfigs 必须原样把公开符号转发出去（既有导入点不受外提影响）
  const apiConfigs = readSource('src/storage/apiConfigs.js');
  for (const name of ['capabilitiesForModel', 'getActiveModel', 'normalizeCapabilityEntry',
    'rawCapabilityForModel', 'CAPABILITY_DEFAULTS']) {
    assert.ok(apiConfigs.includes(name), `apiConfigs.js 必须仍然导出 ${name}（re-export）`);
  }
});

test('缺陷 2：generate() 把现读的能力回写 audioSupported（横幅不再停在旧值）', () => {
  const source = readSource('src/music/useMusicComments.js');
  const gen = source.slice(source.indexOf('const generate = useCallback'));
  assert.ok(gen.includes('setAudioSupported(canHear)'),
    'generate 里必须按本次现读结果回写状态，否则改了开关不切歌界面不刷新');
  // 回写必须在拿 canHear 之后（同一处的紧邻行），而不是别处
  const canHearAt = gen.indexOf('const canHear = resolveAudioSupport(');
  const writeAt = gen.indexOf('setAudioSupported(canHear)');
  assert.ok(canHearAt >= 0 && writeAt > canHearAt, '回写要跟在 canHear 计算之后');
  // 探测 effect 保留（负责面板打开时的初始态）
  assert.ok(/useEffect\(\(\) => \{[\s\S]{0,400}?setAudioSupported\(resolveAudioSupport/.test(source),
    '[songId] 探测 effect 保留，负责初始态');
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
  const zh = localeSource('src/i18n/locales/zh-CN');
  const en = localeSource('src/i18n/locales/en');
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
