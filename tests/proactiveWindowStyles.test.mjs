// 主动消息「随机时段 + 风格权重」的回归（纯逻辑部分）。
//
// 存储层的归一测试在 proactiveSettings.test.mjs（那边有 AsyncStorage / 原生模块打桩；
// 本文件只测不依赖存储的纯函数，所以能直接 import）。
//
// 末尾有一条**跨语言契约**：任务占位符在 JS 与 Kotlin 两侧必须逐字一致——写歪一个字符，
// 真机上模型就会把 {{proactive_task}} 当正文念出来，而 JS 侧测试全绿。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildProactiveVariants,
  buildProactiveTask,
  buildProactiveExtraPrompt,
  buildProactiveRequestMessages,
  resolveProactiveStylePlan,
  PROACTIVE_TASK_TOKEN,
} from '../src/proactive/proactiveRequest.js';
import {
  PROACTIVE_WINDOW_OPTIONS,
  WEIGHT_MAX_PERCENT,
  weightToPercent,
  percentToWeight,
  formatWindowRange,
  buildStyleRows,
  effectivePercent,
  styleRowsToStyles,
} from '../src/proactive/proactiveStyleModel.js';

const MESSAGE_TYPES = ['DEFAULT', 'CARE', 'GREETING', 'CUSTOM'];

// —— 请求组装：占位符与抽取表 ——

test('抽取表：每条带定稿好的任务句，0 权重与非法项被剔除', () => {
  const variants = buildProactiveVariants([
    { messageType: 'CARE', weight: 0.75 },
    { messageType: 'GREETING', weight: 0.25 },
    { messageType: 'CUSTOM', customPrompt: '问我晚饭吃了没', weight: 0 },
    null,
  ]);
  assert.deepEqual(variants.map(item => item.messageType), ['CARE', 'GREETING']);
  assert.equal(variants[0].task, buildProactiveTask({ messageType: 'CARE' }), '任务句在保存时定稿');
  assert.equal(variants[1].task, buildProactiveTask({ messageType: 'GREETING' }));
  assert.deepEqual(variants.map(item => item.weight), [0.75, 0.25]);
  // 自定义风格的任务句来自用户填的提示词
  const custom = buildProactiveVariants([{ messageType: 'CUSTOM', customPrompt: '问我晚饭吃了没', weight: 1 }]);
  assert.ok(custom[0].task.includes('问我晚饭吃了没'));
});

test('占位符：≥2 条启用才走占位符，单风格必须与旧行为逐字一致', () => {
  const single = resolveProactiveStylePlan([{ messageType: 'CARE', weight: 1 }]);
  assert.equal(single.taskToken, false, '单风格不得启用占位符（旧原生会把占位符当正文）');
  assert.equal(single.variants.length, 1);

  const multi = resolveProactiveStylePlan([
    { messageType: 'CARE', weight: 0.5 },
    { messageType: 'GREETING', weight: 0.5 },
  ]);
  assert.equal(multi.taskToken, true);
  assert.equal(multi.variants.length, 2);

  // 只有一条正权重（另一条停用）也算单风格
  assert.equal(resolveProactiveStylePlan([
    { messageType: 'CARE', weight: 1 },
    { messageType: 'CUSTOM', customPrompt: 'x', weight: 0 },
  ]).taskToken, false);
  assert.equal(resolveProactiveStylePlan(null).taskToken, false, '没有风格表时也不启用');
});

test('提示词：taskToken=true 时写占位符而不是任务句；false 时逐字保留任务句', () => {
  const tokenized = buildProactiveExtraPrompt({ messageType: 'CARE', taskToken: true });
  assert.ok(tokenized.includes(PROACTIVE_TASK_TOKEN), '必须写入占位符');
  assert.equal(tokenized.includes(buildProactiveTask({ messageType: 'CARE' })), false, '不得同时写入任务句');
  assert.ok(tokenized.includes('不超过 80 字'), '字数约束等其余要求照旧');

  const inline = buildProactiveExtraPrompt({ messageType: 'CARE' });
  assert.equal(inline.includes(PROACTIVE_TASK_TOKEN), false, '单风格不得出现占位符');
  assert.ok(inline.includes(buildProactiveTask({ messageType: 'CARE' })));
});

test('请求消息：占位符进系统提示，且整串替换后不得残留（原生是整份 body 替换）', () => {
  const character = { id: 'c1', name: 'A', systemPrompt: '你是 A' };
  const messages = buildProactiveRequestMessages({ character, taskToken: true });
  const json = JSON.stringify(messages);
  // 系统提示文本在 messages[0].content 与 systemCache.prefixText 里各有一份，
  // 所以占位符会出现多次——这正说明原生必须对**整份 body** 做替换：
  // 只替换某一处的话，模型仍会在另一处看到 {{proactive_task}} 原文。
  const hits = json.split(PROACTIVE_TASK_TOKEN).length - 1;
  assert.ok(hits >= 1, '占位符必须写进请求体');
  assert.equal(json.replaceAll(PROACTIVE_TASK_TOKEN, '任务').includes(PROACTIVE_TASK_TOKEN), false,
    '整串替换后不得残留占位符');
  assert.equal(json.includes(buildProactiveTask({ messageType: 'DEFAULT' })), false,
    '多风格时不得同时带上默认任务句');
});

// —— 界面纯逻辑 ——

test('时段换算：常规区间、跨午夜标次日、关闭返回 null', () => {
  assert.equal(formatWindowRange(9, 0, 0), null);
  assert.deepEqual(formatWindowRange(9, 0, 180), { start: '09:00', end: '12:00', nextDay: false });
  assert.deepEqual(formatWindowRange(9, 30, 60), { start: '09:30', end: '10:30', nextDay: false });
  // 22:00 + 6h 跨到次日 04:00——必须标出来，否则用户以为配置错了
  assert.deepEqual(formatWindowRange(22, 0, 360), { start: '22:00', end: '04:00', nextDay: true });
  assert.deepEqual(formatWindowRange(23, 30, 30), { start: '23:30', end: '00:00', nextDay: true });
  assert.deepEqual(PROACTIVE_WINDOW_OPTIONS, [0, 30, 60, 120, 180, 360]);
});

test('权重百分比往返无损（编辑时数字不跳），并夹在 0..100', () => {
  for (const percent of [0, 1, 25, 33, 50, 75, 100]) {
    assert.equal(weightToPercent(percentToWeight(percent)), percent, String(percent));
  }
  assert.equal(weightToPercent(0.25), 25);
  assert.equal(weightToPercent(0), 0);
  assert.equal(weightToPercent(-1), 0);
  assert.equal(weightToPercent(5), WEIGHT_MAX_PERCENT, '超过 100 夹住');
  assert.equal(percentToWeight(999), 1, '超过 100 夹住');
  assert.equal(percentToWeight('x'), 0);
  assert.equal(WEIGHT_MAX_PERCENT, 100);
});

test('按类型摊平：缺的类型补 0，自定义提示词跟着带出来', () => {
  const rows = buildStyleRows({
    styles: [
      { messageType: 'CARE', customPrompt: '', weight: 0.4 },
      { messageType: 'CUSTOM', customPrompt: '问我吃了吗', weight: 0.6 },
    ],
  }, MESSAGE_TYPES);
  assert.deepEqual(rows.map(row => row.type), MESSAGE_TYPES, '四种类型按固定顺序各一行');
  assert.deepEqual(rows.map(row => row.percent), [0, 40, 0, 60]);
  assert.equal(rows[3].customPrompt, '问我吃了吗');
  assert.deepEqual(buildStyleRows({}, MESSAGE_TYPES).map(row => row.percent), [0, 0, 0, 0]);
  assert.deepEqual(buildStyleRows(null, MESSAGE_TYPES).length, 4, '槽位为空也要有完整的四行');
});

test('有效占比与写回：全 0 时占比为 0，写回保留 0 权重行', () => {
  assert.equal(effectivePercent(70, 140), 50, '70:70 各占一半');
  assert.equal(effectivePercent(1, 4), 25);
  assert.equal(effectivePercent(0, 0), 0, '全 0 不除零');
  assert.deepEqual(
    styleRowsToStyles([
      { type: 'CARE', percent: 70, customPrompt: '' },
      { type: 'CUSTOM', percent: 0, customPrompt: '留着' },
    ]),
    [
      { messageType: 'CARE', customPrompt: '', weight: 0.7 },
      { messageType: 'CUSTOM', customPrompt: '留着', weight: 0 },
    ],
  );
});

// —— 跨语言契约 ——

test('任务占位符：JS 与 Kotlin 两侧逐字一致（写歪一个字符真机就漏原文）', () => {
  const core = fs.readFileSync(path.resolve('plugins/proactiveMessage/android/ProactiveCore.kt'), 'utf8');
  assert.equal(PROACTIVE_TASK_TOKEN, '{{proactive_task}}');
  assert.ok(
    core.includes(`const val PROACTIVE_TASK_TOKEN = "${PROACTIVE_TASK_TOKEN}"`),
    'Kotlin 侧的占位符常量必须与 JS 完全一致',
  );
});
