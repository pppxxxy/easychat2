// 上下文占用估算纯函数测试 + compact 指令/自动压缩接线的源码断言
//（ChatScreen 依赖 RN 运行时，Node 进不去，接线只能钉源码；口径本身在下方直测）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { zhCN } from '../src/i18n/locales/zh-CN.js';

import {
  AUTO_COMPACT_RATIO,
  DEFAULT_CONTEXT_WINDOW,
  SESSION_AUTO_COMPACT_RATIO,
  SESSION_COMPACT_HINT_RATIO,
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
