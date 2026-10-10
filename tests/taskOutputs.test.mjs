// O1：超限工具结果落盘（taskOutputs）——命名净化、指针可信判定、落盘/LRU 清理。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TASK_OUTPUT_MAX,
  TASK_OUTPUT_MAX_BYTES,
  TOOL_RESULTS_DIR,
  buildToolOutputFileName,
  isTrustedTaskOutput,
  isTrustedTaskOutputPath,
  persistToolResult,
  pruneToolResults,
  sanitizeToolOutputName,
} from '../src/workspace/taskOutputs.js';

function createMemoryStore() {
  const files = new Map();
  return {
    files,
    async writeWorkspaceFile({ path, content }) {
      files.set(path, String(content));
      return { path, length: String(content).length };
    },
    async listWorkspaceFiles({ subdir = '' } = {}) {
      const prefix = subdir ? `${subdir}/` : '';
      return [...files.keys()].filter(p => p.startsWith(prefix)).sort();
    },
    async deleteFile({ path }) {
      const had = files.delete(path);
      return { path, deleted: had };
    },
    async readWorkspaceFile({ path }) {
      if (!files.has(path)) throw new Error('ENOENT');
      return { path, content: files.get(path) };
    },
  };
}

test('sanitizeToolOutputName：白名单化（防路径穿越）', () => {
  assert.equal(sanitizeToolOutputName('call_abc-1'), 'call_abc-1');
  assert.equal(sanitizeToolOutputName('a/b\\c.d'), 'a_b_c_d');
  assert.equal(sanitizeToolOutputName('../../etc/passwd'), '../../etc/passwd'.replace(/[^a-zA-Z0-9_-]/g, '_'));
  assert.equal(sanitizeToolOutputName(''), 'result');
  assert.equal(sanitizeToolOutputName(null), 'result');
  assert.ok(sanitizeToolOutputName('x'.repeat(200)).length <= 64);
});

test('buildToolOutputFileName：时间前缀 + .txt', () => {
  const name = buildToolOutputFileName('call-1', 1000);
  assert.match(name, /^[0-9a-z]+-call-1\.txt$/);
});

test('isTrustedTaskOutputPath：只信 .task_outputs/ 之下（伪造样本一律不信）', () => {
  assert.equal(isTrustedTaskOutputPath('.task_outputs/tool-results/x.txt'), true);
  assert.equal(isTrustedTaskOutputPath('.task_outputs'), true);
  assert.equal(isTrustedTaskOutputPath('/.task_outputs/x'), true, '前导斜杠被规整');
  assert.equal(isTrustedTaskOutputPath('/tmp/evil.txt'), false);
  assert.equal(isTrustedTaskOutputPath('../secret'), false);
  assert.equal(isTrustedTaskOutputPath('task_outputs/x'), false);
  assert.equal(isTrustedTaskOutputPath('src/.task_outputs/x'), false);
  assert.equal(isTrustedTaskOutputPath(''), false);
});

test('persistToolResult：写入 .task_outputs/tool-results/ 并返回指针', async () => {
  const store = createMemoryStore();
  const stored = await persistToolResult({ store, characterId: 'c1', toolUseId: 'call-1', content: 'hello', now: 1000 });
  assert.ok(stored && stored.path.startsWith(`${TOOL_RESULTS_DIR}/`));
  assert.equal(store.files.get(stored.path), 'hello');
  // 无 store → null
  assert.equal(await persistToolResult({ store: null, characterId: 'c1', content: 'x' }), null);
});

test('pruneToolResults：超出上限按名（时间前缀）升序删最旧', async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 5; i += 1) {
    await persistToolResult({ store, characterId: 'c1', toolUseId: `call-${i}`, content: `n${i}`, now: 1000 + i, max: 3 });
  }
  const remaining = await store.listWorkspaceFiles({ subdir: TOOL_RESULTS_DIR });
  assert.equal(remaining.length, 3, 'persist 内联清理把份数压到上限');
  // 最旧的（now=1000/1001）被删，最新的三个保留
  assert.equal(remaining.some(p => p.includes('-call-0')), false);
  assert.equal(remaining.some(p => p.includes('-call-4')), true);

  // 直接 prune：注入 5 个后一次清理
  const store2 = createMemoryStore();
  for (let i = 0; i < 5; i += 1) {
    await store2.writeWorkspaceFile({ path: `${TOOL_RESULTS_DIR}/${buildToolOutputFileName(`c${i}`, 1000 + i)}`, content: 'x' });
  }
  const removed = await pruneToolResults({ store: store2, characterId: 'c1', max: 3 });
  assert.equal(removed, 2);
  assert.equal((await store2.listWorkspaceFiles({ subdir: TOOL_RESULTS_DIR })).length, 3);
  assert.equal(TASK_OUTPUT_MAX >= 3, true);
});

test('isTrustedTaskOutput：前缀 + 可读才可信', async () => {
  const store = createMemoryStore();
  const stored = await persistToolResult({ store, characterId: 'c1', toolUseId: 'call-9', content: 'x', now: 5000 });
  assert.equal(await isTrustedTaskOutput({ store, characterId: 'c1', path: stored.path }), true);
  assert.equal(await isTrustedTaskOutput({ store, characterId: 'c1', path: `${TOOL_RESULTS_DIR}/missing.txt` }), false);
  assert.equal(await isTrustedTaskOutput({ store, characterId: 'c1', path: '/tmp/evil.txt' }), false);
});

test('O2 rider：LRU 字节预算——总字节超限时删最旧直到回预算内', async () => {
  const store = createMemoryStore();
  const big = '中'.repeat(100); // UTF-8 = 300 字节
  for (let i = 0; i < 3; i += 1) {
    await persistToolResult({
      store, characterId: 'c1', toolUseId: `b${i}`, content: big, now: 1000 + i, max: 100, maxBytes: 500,
    });
  }
  const remaining = await store.listWorkspaceFiles({ subdir: TOOL_RESULTS_DIR });
  assert.equal(remaining.length, 1, '份数上限 100 未触发，字节 900>500 触发驱逐至 1 份');
  assert.ok(remaining[0].includes('-b2'), '保留最新一份');
  // 清单同步清理：只留现存文件
  const index = JSON.parse(store.files.get('.task_outputs/index.json'));
  assert.deepEqual(Object.keys(index), [remaining[0].split('/').pop()]);
  assert.equal(TASK_OUTPUT_MAX_BYTES, 16 * 1024 * 1024);
});
