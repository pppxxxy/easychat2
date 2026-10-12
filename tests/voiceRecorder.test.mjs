// 录音时长口径的回归测试。
//
// 背景（2026-10-12）：录音到 60 秒上限时，旧实现是「用户按停 → elapsed > MAX → 整段
// discardFile + 抛 tooLong」——用户说完一分钟的话，得到的是一个错误提示，内容没了。而同一
// 功能里「转写更长的音频」（pickAudioFile）根本没有时长上限，两条路径口径不一致且代价全落在
// 用户身上。修法是到上限自动停止并**保留**已录内容。
//
// expo-audio 在 Node 里加载不到（原生模块），hook 本身进不来（它还 import 了含 JSX 的
// I18nContext.js），所以这里分两层钉：
// ① 时长口径是纯模块 voiceDuration.js，直接单测（真正的行为断言）；
// ② 接线（自动停止计时器 / 超限不 discard / 各处清计时器）钉源码——与仓库里 RN 组件的做法一致。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  classifyRecordingDuration,
  MIN_DURATION_MS,
  MAX_DURATION_MS,
} from '../src/chat/voiceDuration.js';

const SOURCE = fs.readFileSync(path.resolve('src/chat/useChatRecorder.js'), 'utf8');

test('时长口径：过短丢弃 / 区间内保留 / 超上限仍保留（不丢内容）', () => {
  assert.equal(classifyRecordingDuration(0), 'tooShort', '0ms 太短');
  assert.equal(classifyRecordingDuration(MIN_DURATION_MS - 1), 'tooShort', '下限前一刻太短');
  assert.equal(classifyRecordingDuration(MIN_DURATION_MS), 'ok', '下限整点算合格（含边界）');
  assert.equal(classifyRecordingDuration(30 * 1000), 'ok', '中段正常');
  assert.equal(classifyRecordingDuration(MAX_DURATION_MS), 'ok', '上限整点仍合格——自动停止就在这一点');
  assert.equal(classifyRecordingDuration(MAX_DURATION_MS + 1), 'tooLong', '超出上限才判超限');
});

test('上限常量就是 60 秒（文案「最多 60 秒」与代码必须同一口径）', () => {
  assert.equal(MAX_DURATION_MS, 60 * 1000);
  assert.ok(MIN_DURATION_MS > 0 && MIN_DURATION_MS < MAX_DURATION_MS);
});

test('超限分支不得再 discardFile（丢内容的根因就是它）', () => {
  // 取 classifyRecordingDuration 的注释块之后、stop 结束之前的源码，断言 discardFile 只
  // 出现在 tooShort 分支里。直接按分支切片，避免误伤注释里对 discardFile 的提及。
  const tooShortAt = SOURCE.indexOf("if (duration === 'tooShort')");
  const tooLongAt = SOURCE.indexOf("if (duration === 'tooLong')");
  assert.ok(tooShortAt > 0 && tooLongAt > tooShortAt, '两个分支都在');
  const tooShortBranch = SOURCE.slice(tooShortAt, tooLongAt);
  assert.ok(tooShortBranch.includes('discardFile'), '过短仍然丢弃（那是用户没打算录）');
  const tooLongBranch = SOURCE.slice(tooLongAt, SOURCE.indexOf('const uri = await persistVoiceFile'));
  assert.ok(!tooLongBranch.includes('discardFile'), '超限分支不得丢弃已录内容');
  assert.ok(tooLongBranch.includes("throw new Error(t('chat.voice.error.tooLong'))"), '超限仍如实提示');
});

test('接线：到 MAX_DURATION_MS 自动停止（经 ref 转发调 stop，拿得到 uri）', () => {
  assert.ok(/setTimeout\(\(\) => \{/.test(SOURCE), '有自动停止计时器');
  assert.ok(/\}, MAX_DURATION_MS\);/.test(SOURCE), '计时器按上限触发（与时长判据同源）');
  assert.ok(SOURCE.includes('stopRef.current?.()'), '计时器调用 stop 本身（不是内部私有停止）');
  assert.ok(SOURCE.includes('stopRef.current = stop;'), 'stop 经 ref 转发，避开 useCallback 自引用');
  assert.ok(SOURCE.includes('if (!recording) return undefined;'), '只在录音中挂计时器');
  assert.ok(SOURCE.includes('if (recorderRef.current === recorder)'), '手动停/取消后计时器短路，不二次停止');
});

test('接线：手动 stop / cancel / 卸载都要清掉自动停止计时器', () => {
  const clearCount = (SOURCE.match(/clearTimeout\(autoStopTimerRef\.current\)/g) || []).length;
  assert.ok(clearCount >= 3, `stop / cancel / 卸载三处都要清（当前 ${clearCount} 处）`);
  // effect cleanup 只清自己那一支——cleanup 后可能紧接着开始下一次录音，清 ref 会误杀新计时器。
  assert.ok(SOURCE.includes('if (autoStopTimerRef.current === timer) autoStopTimerRef.current = null;'),
    'cleanup 按 timer 身份清理，不误杀下一次录音的计时器');
  // 重复 start 会让 effect 不重挂计时器（recording 已是 true）⇒ 新录音失去自动停止，必须挡住。
  assert.ok(SOURCE.includes('if (recorderRef.current) return true;'), '重复 start 直接返回，不换录制器');
});
