// 已读文件登记测试（能力升级任务书 A5：会话级 working memory 最小版）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  READ_LOG_LIMIT,
  READ_LOG_LINE_LIMIT,
  createReadLog,
  formatReadChars,
  formatReadLogLine,
} from '../src/workspace/readLog.js';
import { READ_ONLY_TOOL_DEFINITIONS } from '../src/workspace/toolDefs/readTools.js';
import { buildWorkspaceAgentSystemPrompt } from '../src/workspace/chat.js';

test('formatReadChars：紧凑展示（3.2k / 800）', () => {
  assert.equal(formatReadChars(0), '0');
  assert.equal(formatReadChars(800), '800');
  assert.equal(formatReadChars(3200), '3.2k');
  assert.equal(formatReadChars(999), '999');
  assert.equal(formatReadChars(1000), '1.0k');
  assert.equal(formatReadChars('bad'), '0');
  assert.equal(formatReadChars(-5), '0');
});

test('createReadLog：登记 / 重读移到最新 / LRU 淘汰 / 空路径忽略 / clear', () => {
  const log = createReadLog(3);
  log.record('a.js', 100);
  log.record('b.py', 200);
  log.record('c.md', 300);
  assert.deepEqual(log.list().map(item => item.path), ['a.js', 'b.py', 'c.md']);

  // 重读 a.js → 移到最新（LRU 序随访问变化）
  log.record('a.js', 150);
  assert.deepEqual(log.list().map(item => item.path), ['b.py', 'c.md', 'a.js']);
  assert.equal(log.list()[2].chars, 150, '重读更新 chars');

  // 超上限 → 淘汰最旧的（b.py）
  log.record('d.txt', 400);
  assert.deepEqual(log.list().map(item => item.path), ['c.md', 'a.js', 'd.txt']);

  log.record('', 1);
  log.record(null, 1);
  assert.equal(log.list().length, 3, '空路径忽略');

  log.clear();
  assert.deepEqual(log.list(), []);
});

test('createReadLog：上限常量为 30；非法 limit 回落', () => {
  assert.equal(READ_LOG_LIMIT, 30);
  const log = createReadLog('bad');
  for (let index = 0; index < READ_LOG_LIMIT + 5; index += 1) log.record(`f${index}.js`, index);
  assert.equal(log.list().length, READ_LOG_LIMIT);
});

test('formatReadLogLine：空 → 空串；正常一行；超长截断', () => {
  assert.equal(formatReadLogLine([]), '');
  assert.equal(formatReadLogLine(null), '');
  assert.equal(
    formatReadLogLine([{ path: 'a.js', chars: 3200 }, { path: 'b.py', chars: 800 }]),
    '本会话已读：a.js(3.2k)、b.py(800)'
  );
  const many = Array.from({ length: 100 }, (unused, index) => ({ path: `long${index}.js`, chars: 1000 }));
  const line = formatReadLogLine(many);
  assert.ok(line.length <= READ_LOG_LINE_LIMIT + 1, '注入行有字符上限');
  assert.ok(line.endsWith('…'));
});

test('read 工具成功后登记（注入 readLog 才登记；不注入安全跳过）', async () => {
  const readTool = READ_ONLY_TOOL_DEFINITIONS.find(item => item.name === 'read_workspace_file');
  const store = {
    async readWorkspaceFile() {
      return { content: 'hello', total: 5, offset: 0, truncated: false };
    },
  };
  const log = createReadLog();
  await readTool.execute({ store, readLog: log }, { path: 'src/a.js' }, {});
  assert.deepEqual(log.list().map(item => item.path), ['src/a.js']);
  assert.equal(log.list()[0].chars, 5, 'chars 用文件总长');

  // 不注入 readLog：照常读，不抛错（聊天页等宿主无需感知这份状态）
  const output = await readTool.execute({ store }, { path: 'b.js' }, {});
  assert.equal(output, 'hello');

  // 读失败不登记
  const failing = { async readWorkspaceFile() { throw new Error('nope'); } };
  const log2 = createReadLog();
  await assert.rejects(() => readTool.execute({ store: failing, readLog: log2 }, { path: 'x' }, {}));
  assert.deepEqual(log2.list(), []);
});

test('提示词注入：read/write 模式带已读行；ask 不带；空不注入', () => {
  const entries = [{ path: 'a.js', chars: 3200 }];
  const read = buildWorkspaceAgentSystemPrompt({ mode: 'read', tools: [], readLog: entries });
  assert.match(read, /本会话已读：a\.js\(3\.2k\)/);
  const write = buildWorkspaceAgentSystemPrompt({ mode: 'write', tools: [], readLog: entries });
  assert.match(write, /本会话已读/);
  const ask = buildWorkspaceAgentSystemPrompt({ mode: 'ask', tools: [], readLog: entries });
  assert.equal(/本会话已读/.test(ask), false, 'ask 没有读工具，不注入');
  const empty = buildWorkspaceAgentSystemPrompt({ mode: 'read', tools: [], readLog: [] });
  assert.equal(/本会话已读/.test(empty), false, '没读过就不出现这一行');
});

test('接线契约：ChatPanel 建登记器 / 切对话清空 / 两处传参', () => {
  const panel = fs.readFileSync(path.resolve('src/workspace/screen/ChatPanel.js'), 'utf8');
  assert.ok(panel.includes('createReadLog()'), '会话登记器在这里创建');
  const clearCount = (panel.match(/readLogRef\.current\.clear\(\)/g) || []).length;
  assert.equal(clearCount, 2, '新建对话与切对话都要清（「本会话」的语义边界）');
  assert.ok(panel.includes('readLog: readLogRef.current'), '注册工具时注入');
  assert.ok(panel.includes('readLog: readLogRef.current ? readLogRef.current.list() : []'), '每轮注入已读行');
  const native = fs.readFileSync(path.resolve('src/workspace/native.js'), 'utf8');
  assert.ok(native.includes('extras.readLog'), '注册入口透传 extras');
  // D4-1：结果增强钩子（on_tool_result）注入在工作区宿主
  assert.ok(panel.includes('onToolResult:'), '结果钩子注入');
  assert.ok(panel.includes('collectToolResultNotices'), '按工具名匹配钩子条目');
  const loop = fs.readFileSync(path.resolve('src/agent/loop.js'), 'utf8');
  assert.ok(loop.includes('onToolResult'), 'loop 透传到 registry ctx');
});
