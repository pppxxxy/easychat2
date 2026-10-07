// 向量记忆「开关即总闸」守卫（2026-10-05 审核报告修复）。
//
// 修复前的真实语义：开关 = 「向量检索 or 关键词检索」，从来不是「开 or 关」——
// 关闭时 retrieve 退回关键词检索（中文单字 token 命中形同虚设）、indexMessages
// 照写分段。叠加 getVectorOwnerId 的 'default' 兜底与对账无归属校验，初始助手卡
// 的桶变成了关不掉也清不掉的串记忆通道。本文件把每一道闸都钉死。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { retrieve, indexMessages } from '../src/vectorMemory/index.js';
import { getVectorOwnerId, shouldIndexSession } from '../src/vectorMemory/scope.js';

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(relativePath), 'utf8');
}

const SEGMENTS = [
  { id: 'seg-1', sessionId: 'session-a', messageId: 'm1', text: '你有什么历史记忆？我们之前聊过什么' },
  { id: 'seg-2', sessionId: 'session-a', messageId: 'm2', text: '一段非常旧的文章内容' },
  { id: 'seg-3', sessionId: 'session-b', messageId: 'm3', text: '模型相关的话题' },
];

test('retrieve：开关关闭必须不召回（哪怕关键词完全命中）', async () => {
  const hits = await retrieve({
    config: { enabled: false },
    index: SEGMENTS,
    query: '一段非常旧的文章内容',
  });
  assert.deepEqual(hits, [], '关闭 = 不召回，不降级到关键词检索');
});

test('retrieve：开关开启时关键词兜底仍可用（嵌入失败是特性不是漏洞）', async () => {
  // enabled: true 但没有可用 embedding 服务（Node 无 provider 配置）→ 走 catch
  // 的关键词兜底。这条兜底只在开关开启时存在。
  const hits = await retrieve({
    config: { enabled: true, model: 'embed-x' },
    index: SEGMENTS,
    query: '模型',
  });
  assert.ok(hits.length > 0, '开启时兜底召回仍然工作');
});

test('indexMessages：开关关闭必须不写入分段', async () => {
  const existing = [{ id: 'keep', sessionId: 'session-a', messageId: 'm0', text: '旧', vector: [] }];
  const next = await indexMessages({
    messages: [
      { id: 'm9', role: 'user', text: '新的消息内容' },
    ],
    config: { enabled: false },
    sessionId: 'session-c',
    existing,
  });
  assert.deepEqual(next, existing, '关闭 = 不新增分段');
  assert.equal(next.length, 1);
});

test('getVectorOwnerId：无主分段返回空串，不再兜底 default', () => {
  assert.equal(getVectorOwnerId({ type: 'single', characterId: 'c1' }), 'c1');
  assert.equal(getVectorOwnerId({ type: 'single', characterId: 'c1' }, 'fallback'), 'c1');
  // characterId 为空的会话在 shouldIndexSession 守卫处就被判无主（fallback 不生效）。
  assert.equal(getVectorOwnerId({ type: 'single', characterId: '' }, 'fallback'), '');
  // fallback 只在「会话行缺失」时生效，且仅显式传参可用——不再默认 'default'。
  assert.equal(getVectorOwnerId(null, 'fallback'), 'fallback');
  assert.equal(getVectorOwnerId(null, ''), '');
  assert.equal(getVectorOwnerId(null), '');
  assert.equal(getVectorOwnerId({ type: 'group', characterId: '' }), '', '群聊不入索引');
  assert.equal(shouldIndexSession({ type: 'group', characterId: 'c1' }), false);
});

test('对账归属校验钉死在源码：会话存在但主人不符也必须清', () => {
  // sessionList.js 2026-10-07 拆成 barrel + sessionList/ 子目录；对账实现在 vectorReconcile.js。
  const source = readSource('src/storage/sessionList/vectorReconcile.js');
  // 锚定 shouldIndexSession 与归属比较同时出现在 reconcile 的过滤回调里。
  // c1005c1 起改为「先 shouldIndexSession 早退，再单独比对 characterId 并计数残留」。
  assert.ok(source.includes('if (!shouldIndexSession(session)) return false;'),
    'reconcile 过滤先过 shouldIndexSession');
  assert.match(
    source,
    /String\(session\.characterId \|\| ''\) !== characterId/,
    'reconcile 过滤必须校验分段会话的 characterId 与桶主人一致'
  );
});

test('源码断言：旧兜底与新猜测不得复活，维护入口必须在位', () => {
  const scope = readSource('src/vectorMemory/scope.js');
  assert.ok(!scope.includes("|| 'default'"), 'getVectorOwnerId 不得再兜底 default');

  const library = readSource('src/context/sessionLibrary.js');
  assert.ok(!library.includes('slice(0, 12)'), '12 字前缀猜测不得复活');
  assert.ok(library.includes("return '';"), '猜不出必须显式返回空串');

  const settings = readSource('src/SettingsScreen.js');
  const vectorSection = readSource('src/settings/sections/VectorSection.js');
  assert.ok(settings.includes('clearVectorIndex'), '设置页必须接入清空向量记忆');
  // 定义在 SettingsScreen（确认弹框处理），渲染在 VectorSection（卡片拆分后）。
  assert.match(settings, /const confirmClearVectorIndex = useCallback/, '清空入口须有确认弹框处理（定义）');
  assert.match(vectorSection, /onPress=\{confirmClearVectorIndex\}/, '清空入口须绑定到按钮（使用）');
  assert.match(vectorSection, /settings\.vector\.enableHint/, '开关语义提示必须在位');
});
