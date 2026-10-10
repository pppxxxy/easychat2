// 上下文占用估算纯函数测试 + compact 指令/自动压缩接线的源码断言
//（ChatScreen 依赖 RN 运行时，Node 进不去，接线只能钉源码；口径本身在下方直测）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { zhCN } from '../src/i18n/locales/zh-CN.js';

import {
  AUTO_COMPACT_RATIO,
  COMPACTION_HEADROOM_TOKENS,
  DEFAULT_CONTEXT_WINDOW,
  SESSION_AUTO_COMPACT_RATIO,
  SESSION_COMPACT_HINT_RATIO,
  buildContextBreakdown,
  computeContextUsage,
  estimateHistoryTokens,
  estimateTextTokens,
  resolveCompactionThreshold,
  resolveContextWindow,
  shouldAutoCompact,
  shouldAutoCompactTokens,
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

test('resolveContextWindow：声明窗口 > 本地 n_ctx > 默认 200000', () => {
  // 默认值即产品口径：未声明窗口时按主流在线模型的 200k 档位算占用与压缩阈值。
  assert.equal(DEFAULT_CONTEXT_WINDOW, 200000, '默认窗口 200000');
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

test('三档阈值各有其名：记忆总结 0.8 / 会话自动压缩 0.85 / 提示条 0.7', () => {
  // 2026-10-10 核实：ChatScreen 曾把 0.85 与 0.7 硬编码在渲染里，而常量是 0.8——
  // 看着像笔误，实为三种不同语义（记忆总结的「上下文偏高」判定 / 会话空闲自动压缩 /
  // 提示条出现线）。这条断言钉住「它们不相等」，防止后人「顺手统一」把触发点改跑偏。
  assert.equal(AUTO_COMPACT_RATIO, 0.8, '记忆总结的「上下文偏高」口径');
  assert.equal(SESSION_AUTO_COMPACT_RATIO, 0.85, '会话空闲自动压缩线');
  assert.equal(SESSION_COMPACT_HINT_RATIO, 0.7, '提示条出现线');
  assert.ok(SESSION_COMPACT_HINT_RATIO < AUTO_COMPACT_RATIO, '提示条早于记忆总结线');
  assert.ok(AUTO_COMPACT_RATIO < SESSION_AUTO_COMPACT_RATIO, '记忆总结线早于会话压缩线');
  // 会话压缩线仍用同一判定函数，只是阈值不同。
  assert.equal(shouldAutoCompact({ ratio: 0.85 }, { ratio: SESSION_AUTO_COMPACT_RATIO }), true);
  assert.equal(shouldAutoCompact({ ratio: 0.84 }, { ratio: SESSION_AUTO_COMPACT_RATIO }), false);
});

test('P3：resolveCompactionThreshold = floor(min(W×ratio, W−O−headroom))（对齐 dsh）', () => {
  assert.equal(COMPACTION_HEADROOM_TOKENS, 65536);
  // 无输出预留、默认 headroom：W=200000 → min(160000, 200000−65536=134464) = 134464
  assert.equal(resolveCompactionThreshold(200000), 134464);
  // 有输出预留：W=200000, O=8192 → min(160000, 200000−8192−65536=126272) = 126272
  assert.equal(resolveCompactionThreshold(200000, { outputCap: 8192 }), 126272);
  // headroom 超过窗口 → 预算非正，退回比例上限（委托 compactionPolicy 后不再返回 0，
  // 阈值恒 > 0；W=32000 → floor(32000×0.85) = 27200）。
  assert.equal(resolveCompactionThreshold(32000), 27200);
  // 非法窗口 → 0
  assert.equal(resolveCompactionThreshold(0), 0);
  assert.equal(resolveCompactionThreshold(-1), 0);
  assert.equal(resolveCompactionThreshold(Number.NaN), 0);
  // token 口径判据
  assert.equal(shouldAutoCompactTokens(134464, 200000), true);
  assert.equal(shouldAutoCompactTokens(134463, 200000), false);
  assert.equal(shouldAutoCompactTokens(999, 32000), false, '远低于阈值 → 不触发');
});

test('ChatScreen：compact 指令拦截（可带关注点）与记忆总结的 80% 占用接线钉死在源码', () => {
  const source = readSource('src/ChatScreen.js');
  // 指令：compact / /compact（大小写不敏感），可选跟一个关注点；仅当无附件时拦截。
  assert.ok(
    source.includes("const COMPACT_COMMAND_PATTERN = /^\\/?compact(?:\\s+([\\s\\S]*))?$/i;"),
    'compact 指令正则必须存在且能捕获关注点参数'
  );
  assert.ok(
    source.includes('if (compactMatch && attachments.length === 0)'),
    '拦截必须同时要求无附件'
  );
  assert.ok(
    source.includes("runCompactCommand(compactMatch[1] || '').catch(() => {})"),
    '拦截后立即清输入并把关注点传下去'
  );
  // 压缩走既有记忆总结管线（manual=true 自带完成/失败提示与并发保护），关注点经归一化。
  assert.ok(
    source.includes('await runSummarize(session, messagesRef.current, true, normalizeCompactionFocus(focus))'),
    'compact 必须复用 runSummarize 手动路径并归一化关注点'
  );
  assert.ok(
    source.includes("Alert.alert(t('chat.compact.busy.title'), t('chat.compact.busy.body'))"),
    '并发时给出明确提示（走 i18n 键）'
  );
  assert.equal(zhCN['chat.compact.busy.title'], '正在压缩', '语言包中文值正确');
  assert.equal(zhCN['chat.compact.busy.body'], '上一次压缩还没有完成，请稍候。', '语言包中文值正确');
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
    source.includes("t('settings.capability.contextWindow')"),
    '输入框标签应引用 i18n 键'
  );
  assert.equal(zhCN['settings.capability.contextWindow'], '上下文窗口（tokens）', '语言包中文值正确');
});

// P2-7：上下文占用明细（谁在吃窗口）。
test('P2-7 estimateTextTokens：空文本 0、非空与消息同口径（同一估算器）', () => {
  assert.equal(estimateTextTokens(''), 0);
  assert.equal(estimateTextTokens('   '), 0);
  assert.equal(estimateTextTokens(null), 0);
  assert.ok(estimateTextTokens('x'.repeat(400)) > 0);
  assert.equal(
    estimateTextTokens('一段文本'),
    estimateHistoryTokens([{ role: 'system', text: '一段文本' }]),
    '与消息口径一致——两套数字互相打架比没有数字更糟'
  );
});

test('P2-7 buildContextBreakdown：归一、按 token 降序、占比、空段与坏输入安全', () => {
  const result = buildContextBreakdown([
    { key: 'system', text: 'x'.repeat(400) },
    { key: 'history', tokens: 100 },
    { key: 'input', tokens: 0 },
    { key: '', tokens: 999 },
    { key: 'tools', tokens: -5 },
    null,
  ], 10000);
  assert.deepEqual(result.segments.map(item => item.key), ['system', 'history'], '空段/坏段被剔除');
  assert.equal(result.total, result.segments.reduce((sum, item) => sum + item.tokens, 0));
  assert.ok(result.segments[0].tokens >= result.segments[1].tokens, '降序：最大那块排最前');
  assert.ok(Math.abs(result.segments[1].ratio - 0.01) < 1e-9, 'ratio = tokens / window');
  assert.equal(result.window, 10000);

  // 没给 window（明细只看份额时）→ **不编窗口**：window/ratio 为 0，只有 token 是真的。
  const noWindow = buildContextBreakdown([{ key: 'a', tokens: 10 }]);
  assert.equal(noWindow.window, 0, '没给窗口就不假装知道窗口');
  assert.equal(noWindow.ratio, 0, 'ratio 是 0 而不是拿默认窗口算出来的假占比');
  assert.equal(noWindow.segments[0].ratio, 0);
  assert.equal(noWindow.total, 10, 'token 仍然如实给出');
  assert.equal(buildContextBreakdown(null).segments.length, 0);
  assert.equal(buildContextBreakdown([]).total, 0);
});
