// 上下文占用估算纯函数测试 + compact 指令/自动压缩接线的源码断言
//（ChatScreen 依赖 RN 运行时，Node 进不去，接线只能钉源码；口径本身在下方直测）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  AUTO_COMPACT_RATIO,
  DEFAULT_CONTEXT_WINDOW,
  computeContextUsage,
  estimateHistoryTokens,
  resolveContextWindow,
  shouldAutoCompact,
} from '../src/chat/contextUsage.js';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

test('estimateHistoryTokens：按消息文本粗估，非数组输入为 0', () => {
  const tokens = estimateHistoryTokens([
    { role: 'user', text: '你好世界' },
    { role: 'assistant', text: '这是一段回复内容' },
  ]);
  assert.ok(tokens > 0, '非空历史必须估出正 token');
  assert.equal(estimateHistoryTokens(null), 0);
  assert.equal(estimateHistoryTokens([]), 0);
  // 文本越多占用越高（口径与本地裁剪一致，只验证单调性，不验证具体数字）。
  const more = estimateHistoryTokens([
    { role: 'user', text: '你好世界' },
    { role: 'assistant', text: '这是一段回复内容' },
    { role: 'user', text: '再来一段更长的内容用来抬高估算结果' },
  ]);
  assert.ok(more > tokens, '消息变多估算必须单调不减');
});

test('resolveContextWindow：声明窗口 > 本地 n_ctx > 默认 32000', () => {
  assert.equal(resolveContextWindow({ declared: 128000, localContextSize: 2048 }), 128000);
  assert.equal(resolveContextWindow({ declared: 0, localContextSize: 4096 }), 4096);
  assert.equal(resolveContextWindow({ declared: 0, localContextSize: 0 }), DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolveContextWindow({}), DEFAULT_CONTEXT_WINDOW);
  // 非法值一律忽略，逐级落到下一个来源。
  assert.equal(resolveContextWindow({ declared: -5, localContextSize: 1024 }), 1024);
  assert.equal(resolveContextWindow({ declared: Number.NaN, localContextSize: 0 }), DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolveContextWindow({ declared: 128.9 }), 128);
});

test('computeContextUsage：ratio = tokens / window，窗口非法时落到默认', () => {
  const usage = computeContextUsage(
    [{ role: 'user', text: 'abc' }],
    1000
  );
  assert.equal(usage.window, 1000);
  assert.ok(usage.tokens > 0);
  assert.ok(Math.abs(usage.ratio - usage.tokens / 1000) < 1e-12);

  const fallback = computeContextUsage([{ role: 'user', text: 'abc' }], 0);
  assert.equal(fallback.window, DEFAULT_CONTEXT_WINDOW);
});

test('shouldAutoCompact：0.8 触发、0.79 不触发、非法占用不触发', () => {
  assert.equal(AUTO_COMPACT_RATIO, 0.8);
  assert.equal(shouldAutoCompact({ tokens: 8000, window: 10000, ratio: 0.8 }), true);
  assert.equal(shouldAutoCompact({ tokens: 7900, window: 10000, ratio: 0.79 }), false);
  assert.equal(shouldAutoCompact(null), false);
  assert.equal(shouldAutoCompact({ ratio: Number.NaN }), false);
  // 自定义线仍可用（面板/测试之外的扩展点）。
  assert.equal(shouldAutoCompact({ ratio: 0.5 }, { ratio: 0.5 }), true);
});

test('ChatScreen：compact 指令拦截与 80% 自动压缩接线钉死在源码', () => {
  const source = readSource('src/ChatScreen.js');
  // 指令：compact / /compact（大小写不敏感），仅当无附件时拦截。
  assert.ok(source.includes("const COMPACT_COMMAND_PATTERN = /^\\/?compact$/i;"), 'compact 指令正则必须存在');
  assert.ok(
    source.includes('COMPACT_COMMAND_PATTERN.test(text) && attachments.length === 0'),
    '拦截必须同时要求无附件'
  );
  assert.ok(source.includes('runCompactCommand().catch(() => {})'), '拦截后立即清输入并执行压缩');
  // 压缩走既有记忆总结管线（manual=true 自带完成/失败提示与并发保护）。
  assert.ok(
    source.includes('await runSummarize(session, messagesRef.current, true)'),
    'compact 必须复用 runSummarize 手动路径'
  );
  assert.ok(
    source.includes("Alert.alert('正在压缩', '上一次压缩还没有完成，请稍候。')"),
    '并发时给出明确提示'
  );
  // 自动压缩：maybeAutoSummarize 计算占用并传给 shouldSummarize。
  assert.ok(
    source.includes('contextUsage = computeContextUsage(list, resolveContextWindow({'),
    '自动路径必须计算上下文占用'
  );
  assert.ok(
    source.includes('declared: caps.contextWindow,'),
    '在线模型按每模型声明的 contextWindow 取窗口'
  );
  assert.ok(
    source.includes('const localContextSize = localItem ? normalizeLocalModelParams(localItem).contextSize : 0;'),
    '本地模型按 n_ctx 取窗口'
  );
  assert.ok(
    source.includes('shouldSummarize({ session, messages: list, settings, contextUsage })'),
    '触发判断必须带上占用'
  );
});

test('SettingsScreen：能力弹层暴露每模型 contextWindow 输入', () => {
  const source = readSource('src/SettingsScreen.js');
  assert.ok(
    source.includes('contextWindow: Math.max(0, Math.floor(Number(capabilityDraft.contextWindow)) || 0)'),
    '保存时把输入收敛为非负整数'
  );
  assert.ok(
    source.includes('contextWindow: caps.contextWindow > 0 ? String(caps.contextWindow) : \'\''),
    '编辑时回填已声明窗口，未声明留空'
  );
  assert.ok(
    source.includes('上下文窗口（tokens）'),
    '输入框有中文标签'
  );
});
