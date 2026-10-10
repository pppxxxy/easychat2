// 本会话统计：纯逻辑（累计 / 分组 / 汇总 / 计时 / 防御性归一）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEmptyStats,
  createRequestMeter,
  estimatePromptTokens,
  estimateReplyTokens,
  MAX_STATS_GROUPS,
  normalizeStats,
  OTHER_GROUP_KEY,
  recordRequest,
  summarizeStats,
} from '../src/chat/sessionStats.js';

test('createEmptyStats / normalizeStats：坏数据不崩、字段被归一', () => {
  const empty = createEmptyStats();
  assert.equal(empty.requests, 0);
  assert.equal(empty.promptTokens, 0);
  assert.deepEqual(empty.groups, {});

  assert.deepEqual(normalizeStats(null), empty, 'null → 空统计');
  assert.deepEqual(normalizeStats('nope'), empty, '非对象 → 空统计');
  assert.deepEqual(normalizeStats([]), empty, '数组 → 空统计');
  const dirty = normalizeStats({
    requests: -3,
    promptTokens: 'x',
    groups: { a: { requests: '2', label: 5 }, '': { requests: 9 } },
    lastAt: 12.9,
  });
  assert.equal(dirty.requests, 0, '负数归零');
  assert.equal(dirty.promptTokens, 0, '非数字归零');
  assert.equal(dirty.groups.a.requests, 2, '字符串数字被接受');
  assert.equal(dirty.groups.a.label, '5', 'label 归一成字符串');
  assert.equal(Object.keys(dirty.groups).length, 1, '空 key 被丢弃');
  assert.equal(dirty.lastAt, 12, '时间取整');
});

test('createRequestMeter：首字延迟与生成时长；非流式按整段耗时', () => {
  let clock = 1000;
  const meter = createRequestMeter(() => clock);
  clock = 1200;
  meter.markFirstToken();
  clock = 1500;
  meter.markFirstToken(); // 只认第一个
  clock = 3500;
  const timing = meter.finish();
  assert.equal(timing.firstTokenMs, 200, '首字延迟 = 请求发出 → 首个增量');
  assert.equal(timing.generationMs, 2300, '生成时长 = 首字 → 结束');

  let clock2 = 5000;
  const plain = createRequestMeter(() => clock2);
  clock2 = 6000;
  const plainTiming = plain.finish();
  assert.equal(plainTiming.firstTokenMs, 0, '没有首字样本');
  assert.equal(plainTiming.generationMs, 1000, '非流式按整段耗时算速度口径');
});

test('recordRequest：累计、按配置分组、失败计数；不改原对象', () => {
  const base = createEmptyStats();
  const one = recordRequest(base, {
    configId: 'cfg-a', configLabel: 'DeepSeek', model: 'deepseek-chat',
    promptTokens: 1000, completionTokens: 200, firstTokenMs: 400, generationMs: 4000, at: 111,
  });
  assert.equal(base.requests, 0, '原对象不被修改');
  assert.equal(one.requests, 1);
  assert.equal(one.promptTokens, 1000);
  assert.equal(one.completionTokens, 200);
  assert.equal(one.firstTokenSamples, 1);
  assert.equal(one.firstAt, 111);
  assert.equal(one.lastAt, 111);
  assert.equal(one.groups['cfg-a'].label, 'DeepSeek');
  assert.equal(one.groups['cfg-a'].model, 'deepseek-chat');

  const two = recordRequest(one, {
    configId: 'cfg-b', configLabel: 'OpenRouter', model: 'gpt-x',
    promptTokens: 500, completionTokens: 100, firstTokenMs: 800, generationMs: 2000, at: 222,
  });
  const three = recordRequest(two, {
    configId: 'cfg-a', promptTokens: 100, completionTokens: 50, firstTokenMs: 0, generationMs: 1000, failed: true, at: 333,
  });
  assert.equal(three.requests, 3);
  assert.equal(three.failedRequests, 1);
  assert.equal(three.firstTokenSamples, 2, '没有首字的请求不进延迟样本');
  assert.equal(three.groups['cfg-a'].requests, 2);
  assert.equal(three.groups['cfg-a'].failedRequests, 1);
  assert.equal(three.groups['cfg-a'].promptTokens, 1100);
  assert.equal(three.groups['cfg-a'].label, 'DeepSeek', '后续请求缺 label 时保留原值');
  assert.equal(three.firstAt, 111, 'firstAt 只记第一次');
  assert.equal(three.lastAt, 333);

  const noId = recordRequest(createEmptyStats(), { promptTokens: 10, completionTokens: 5 });
  assert.equal(noId.groups.unknown.requests, 1, '缺 configId 归到 unknown');
});

test('recordRequest：分组超上限时按请求数保留，其余并入「其他」', () => {
  let stats = createEmptyStats();
  for (let i = 0; i < MAX_STATS_GROUPS + 3; i += 1) {
    stats = recordRequest(stats, {
      configId: `cfg-${i}`, completionTokens: 10, generationMs: 1000, firstTokenMs: 10,
    });
  }
  const keys = Object.keys(stats.groups);
  assert.ok(keys.length <= MAX_STATS_GROUPS, `分组数收敛到 ${MAX_STATS_GROUPS} 以内`);
  assert.ok(keys.includes(OTHER_GROUP_KEY), '溢出分组并入「其他」');
  assert.equal(stats.requests, MAX_STATS_GROUPS + 3, '总数不受分组收敛影响');
  const grouped = keys.reduce((sum, key) => sum + stats.groups[key].requests, 0);
  assert.equal(grouped, MAX_STATS_GROUPS + 3, '请求数在分组间守恒');
});

test('summarizeStats：合计、平均首字、加权速度、占比、按请求数排序', () => {
  let stats = createEmptyStats();
  stats = recordRequest(stats, {
    configId: 'slow', configLabel: 'Slow', promptTokens: 1000, completionTokens: 100,
    firstTokenMs: 1000, generationMs: 10000, at: 1,
  });
  stats = recordRequest(stats, {
    configId: 'fast', configLabel: 'Fast', promptTokens: 500, completionTokens: 200,
    firstTokenMs: 200, generationMs: 2000, at: 2,
  });
  stats = recordRequest(stats, {
    configId: 'fast', configLabel: 'Fast', promptTokens: 500, completionTokens: 200,
    firstTokenMs: 400, generationMs: 2000, at: 3,
  });

  const summary = summarizeStats(stats);
  assert.equal(summary.requests, 3);
  assert.equal(summary.promptTokens, 2000);
  assert.equal(summary.completionTokens, 500);
  assert.equal(summary.totalTokens, 2500);
  assert.equal(summary.avgFirstTokenMs, Math.round((1000 + 200 + 400) / 3));
  // 加权速度：总输出 500 token / 总生成时长 14s
  assert.equal(Number(summary.tokensPerSec.toFixed(4)), Number((500 / 14).toFixed(4)));
  assert.deepEqual(summary.groups.map(group => group.key), ['fast', 'slow'], '按请求数从多到少');
  assert.equal(summary.groups[0].requests, 2);
  assert.equal(summary.groups[0].totalTokens, 1400);
  assert.equal(Number(summary.groups[0].share.toFixed(4)), Number((1400 / 2500).toFixed(4)));
  assert.equal(summary.groups[1].label, 'Slow');
  // 速度：fast = 400 token / 4s = 100/s
  assert.equal(Number(summary.groups[0].tokensPerSec.toFixed(2)), 100);

  const emptySummary = summarizeStats(null);
  assert.equal(emptySummary.requests, 0);
  assert.equal(emptySummary.avgFirstTokenMs, 0);
  assert.equal(emptySummary.tokensPerSec, 0);
  assert.deepEqual(emptySummary.groups, []);
});

test('估算口径：复用统一估算器（CJK 约 1 token/字）', () => {
  assert.ok(estimatePromptTokens([{ role: 'user', content: '你好世界' }]) >= 4);
  assert.ok(estimateReplyTokens('hello world') > 0);
  assert.equal(estimateReplyTokens(''), 4, '空回复只剩消息开销，不崩');
  assert.equal(estimatePromptTokens(null), 0);
});

// ---- 接线（源码断言；RN 组件在 Node 里渲染不了） ----
import fs from 'node:fs';
import path from 'node:path';
import { formatLatency, formatPercent, formatSpeed, formatTokenCount } from '../src/chat/sessionStatsFormat.js';

const read = p => fs.readFileSync(path.resolve(p), 'utf8');

test('展示格式化：token / 延迟 / 速度 / 占比', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1500), '1.5K');
  assert.equal(formatTokenCount(23400), '23K');
  assert.equal(formatTokenCount(1500000), '1.50M');
  assert.equal(formatLatency(0), '—');
  assert.equal(formatLatency(850), '850ms');
  assert.equal(formatLatency(2300), '2.3s');
  assert.equal(formatSpeed(0), '—');
  assert.equal(formatSpeed(12.345), '12.3/s');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(0.004), '1%', '极小占比也显示 1%，不显示 0%');
  assert.equal(formatPercent(0.42), '42%');
});

test('菜单与面板接线：⋯ 菜单有「本会话统计」，面板挂在聊天页', () => {
  const screen = read('src/ChatScreen.js');
  assert.ok(screen.includes("key: 'session-stats'"), '菜单项存在');
  assert.ok(screen.includes("t('chat.menu.sessionStats')"), '菜单文案走 i18n');
  assert.ok(screen.includes("section: t('chat.menu.section.other')"), '归入「其他」分组');
  assert.ok(screen.includes('openSessionStats'), '有打开处理');
  assert.ok(screen.includes('getSessionStats(') && screen.includes('summarizeStats('), '打开时读并汇总');
  assert.ok(screen.includes('<SessionStatsModal'), '面板已挂载');
  assert.ok(screen.includes('messageCount={messages.filter'), '消息条数取当前会话（排除临时气泡）');
  assert.ok(screen.includes('clearSessionStatsForActive'), '清空入口接线');
  assert.ok(screen.includes('clearSessionStats('), '清空走存储域');

  const modal = read('src/chat/SessionStatsModal.js');
  assert.ok(modal.includes("t('chat.stats.byConfig')"), '按 API 配置分组小节');
  assert.ok(modal.includes("t('chat.stats.note')"), '口径说明（估算/计时方式）如实标注');
  assert.ok(modal.includes('statBarFill'), '占比条');
  assert.ok(!modal.includes('Math.random'), '不做假数据');
});

test('打点接线：请求链路记时、失败/取消也记、群聊同样计入', () => {
  const send = read('src/chat/useChatSend.js');
  assert.ok(send.includes('createRequestMeter()'), '每次请求建计时器');
  // 首字：三条流式路径都要打点（agent / 在线流式 / 本地）
  assert.equal((send.match(/meter\.markFirstToken\(\)/g) || []).length, 3, '三条流式路径都标首字');
  assert.ok(send.includes('ensembleMeter.markFirstToken()'), '群聊合议流式也标首字');
  // 记账点：成功 / 取消 / 失败
  assert.ok(/recordStats\(replyText\)/.test(send), '成功记一笔（含输出 token 估算）');
  assert.equal((send.match(/recordStats\(''\)/g) || []).length, 2, '取消两条路径也记请求数');
  assert.ok(/recordStats\('', \{ failed: true \}\)/.test(send), '失败记一笔并计入失败数');
  assert.ok(send.includes('recordGroupStats('), '群聊请求同样计入本会话统计');
  assert.ok(send.includes('estimatePromptTokens(requestMessages)'), '输入 token 按实际请求估算');
  assert.ok(send.includes('.catch(() => {})'), '统计写入失败被吞掉（不影响聊天）');
  assert.ok(send.includes('let recordStats = () => {}'), '打点在 try 外声明，catch 也能用');
  // 本地模型与在线分别归属：本地按 local 分组，不混进在线配置的账。
  assert.ok(send.includes("isLocal ? 'local' : (expectedConfigId || 'unknown')"), '本地/在线分组分开');
  assert.ok(send.includes("tRef.current('chat.stats.localProvider')"), '本地分组名走 i18n');
});

test('E1 cachedTokens：累计（顶层+分组）、命中率、无 usage 会话恒 0', () => {
  let stats = createEmptyStats();
  stats = recordRequest(stats, { configId: 'a', promptTokens: 100, completionTokens: 10, cachedTokens: 80 });
  stats = recordRequest(stats, { configId: 'a', promptTokens: 200, completionTokens: 20, cachedTokens: 150 });
  const summary = summarizeStats(stats);
  assert.equal(summary.cachedTokens, 230, '顶层累计');
  assert.equal(summary.promptTokens, 300);
  assert.equal(summary.cacheHitRate, 230 / 300, '命中率 = cached / prompt');
  assert.equal(summary.groups[0].cachedTokens, 230, '分组同步累计');
  assert.equal(summary.groups[0].cacheHitRate, 230 / 300);

  // 不返回 usage 的会话（不传 cachedTokens）：恒 0，不产生 NaN
  const bare = summarizeStats(
    recordRequest(createEmptyStats(), { configId: 'b', promptTokens: 50, completionTokens: 5 })
  );
  assert.equal(bare.cachedTokens, 0);
  assert.equal(bare.cacheHitRate, 0, '0/50 = 0（不是 NaN）');
  assert.equal(summarizeStats(createEmptyStats()).cacheHitRate, 0, '空统计不除零');

  // 归一防御：坏数据不把面板算崩
  assert.equal(normalizeStats({ cachedTokens: 'x' }).cachedTokens, 0);
  assert.equal(normalizeStats({ cachedTokens: -5 }).cachedTokens, 0);
});
