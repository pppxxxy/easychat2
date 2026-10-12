// URL path / query 拆分与回拼（零依赖叶子 utils/urlQuery.js）的行为测试。
//
// 语义照抄 src/vectorMemory/providers.js:46-48（该域已按此修好，是正面参考）：
//   const queryIndex = trimmed.indexOf('?');
//   const path = (queryIndex === -1 ? trimmed : trimmed.slice(0, queryIndex)).replace(/\/+$/, '');
//   const query = queryIndex === -1 ? '' : trimmed.slice(queryIndex);
// 即「按**第一个** '?' 拆；path 去净尾部斜杠；query 含前导 '?'」。
// 这些边界值正是各域后缀判定的前提，所以逐条钉住。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { joinUrlQuery, splitUrlQuery } from '../src/utils/urlQuery.js';

test('splitUrlQuery：无 query 时 path 原样、query 为空串', () => {
  assert.deepEqual(
    splitUrlQuery('https://api.openai.com/v1/chat/completions'),
    { path: 'https://api.openai.com/v1/chat/completions', query: '' }
  );
  assert.deepEqual(splitUrlQuery(''), { path: '', query: '' });
  assert.deepEqual(splitUrlQuery(null), { path: '', query: '' });
  assert.deepEqual(splitUrlQuery(undefined), { path: '', query: '' });
});

test('splitUrlQuery：尾部斜杠只从 path 去掉（含多个斜杠）', () => {
  assert.deepEqual(
    splitUrlQuery('https://x.test/v1///'),
    { path: 'https://x.test/v1', query: '' }
  );
  // query 之前的尾部斜杠同样去掉（providers.js 的口径：先切 query 再 replace）
  assert.deepEqual(
    splitUrlQuery('https://x.test/v1/?api-version=1'),
    { path: 'https://x.test/v1', query: '?api-version=1' }
  );
});

test('splitUrlQuery：空 query（结尾就是 ?）保留为 "?"，不吞掉', () => {
  assert.deepEqual(splitUrlQuery('https://x.test/v1?'), { path: 'https://x.test/v1', query: '?' });
});

test('splitUrlQuery：多个 ? 只在**第一个**处切，其余留在 query 里', () => {
  assert.deepEqual(
    splitUrlQuery('https://x.test/v1?a=1?b=2'),
    { path: 'https://x.test/v1', query: '?a=1?b=2' }
  );
});

test('splitUrlQuery：query 值里的 "/" 不得被当成路径', () => {
  // 这条是缺陷机理的核心：Azure 的 api-version 里可能带路径样片段，
  // 若把整串当路径判后缀，端点就会被追加进 query 值里。
  assert.deepEqual(
    splitUrlQuery('https://x.test/v1/chat/completions?api-version=2024-02-01&x=/v1/chat/completions'),
    { path: 'https://x.test/v1/chat/completions', query: '?api-version=2024-02-01&x=/v1/chat/completions' }
  );
});

test('splitUrlQuery：Azure 部署地址的完整样例（先例注释里的那一条）', () => {
  assert.deepEqual(
    splitUrlQuery('https://x.openai.azure.com/openai/deployments/d/embeddings?api-version=2023-05-15'),
    { path: 'https://x.openai.azure.com/openai/deployments/d/embeddings', query: '?api-version=2023-05-15' }
  );
});

test('joinUrlQuery：空 query 只回 path；有 query 时原样接回', () => {
  assert.equal(joinUrlQuery('https://x.test/v1', ''), 'https://x.test/v1');
  assert.equal(joinUrlQuery('https://x.test/v1', '?a=1'), 'https://x.test/v1?a=1');
  assert.equal(joinUrlQuery('https://x.test/v1', '?'), 'https://x.test/v1?');
  assert.equal(joinUrlQuery('https://x.test/v1', null), 'https://x.test/v1');
  assert.equal(joinUrlQuery(null, '?a=1'), '?a=1');
});

test('split → join 是无损往返（不含尾部斜杠归一之外的信息损失）', () => {
  const samples = [
    'https://api.openai.com/v1/chat/completions',
    'https://x.openai.azure.com/openai/deployments/d/chat/completions?api-version=2024-02-01',
    'https://x.test/v1?a=1?b=2',
    'https://x.test/v1?',
    'http://127.0.0.1:8081/generate',
  ];
  for (const url of samples) {
    const { path: p, query: q } = splitUrlQuery(url);
    assert.equal(joinUrlQuery(p, q), url, `往返必须无损：${url}`);
  }
});

test('零依赖叶子：urlQuery.js 不得 import 任何东西（供各域共用且不得参与循环依赖）', () => {
  const source = fs.readFileSync(path.resolve('src/utils/urlQuery.js'), 'utf8');
  // 只认真正的 import/require **语句**（注释里出现「import」这个词不算）。
  assert.equal(/(^|\n)\s*import\s/.test(source), false, 'utils/urlQuery.js 必须零依赖');
  assert.equal(/(^|\n)\s*(const|let|var)?\s*\w*\s*=?\s*require\s*\(/.test(source), false, 'utils/urlQuery.js 不得使用 require');
});
