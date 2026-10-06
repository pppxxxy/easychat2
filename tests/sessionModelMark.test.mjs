// 会话模型标识（modelKind/modelName）链路测试：
// - modelProvider 路由结果通知（真实调用，Node 下本地模块不可用 → api 路径）
// - sessionList.markSessionModel 落盘接线（源码锚点）
// - useChatSend 发送链接线（源码锚点）
// - MemoryScreen 本地 chip/badge 呈现（源码锚点）
// 纯函数本体（applySessionModelMark / buildSessionBadges）的用例在
// sessionLibrary.test.mjs 与 memoryBuckets.test.mjs。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (...segments) => readFileSync(path.join(HERE, '..', ...segments), 'utf8');

const PROVIDER = read('src', 'network', 'modelProvider.js');
const SESSION_LIST = read('src', 'storage', 'sessionList.js');
const SESSIONS_BARREL = read('src', 'storage', 'sessions.js');
const STORAGE_BARREL = read('src', 'storage.js');
const CHAT_SEND = read('src', 'chat', 'useChatSend.js');
const MEMORY_SCREEN = read('src', 'MemoryScreen.js');

test('provider：本地模块不可用时走在线并通知 api（真实调用）', async () => {
  const { sendWithModelProvider } = await import('../src/network/modelProvider.js');
  const events = [];
  const reply = await sendWithModelProvider({
    messages: [],
    localSettings: null,
    localItem: null,
    localFileInfo: null,
    onlineSend: async () => 'online-reply',
    onProviderResolved: info => events.push(info),
  });
  assert.equal(reply, 'online-reply');
  assert.deepEqual(events, [{ kind: 'api' }]);
});

test('provider：不传 onProviderResolved 时行为与旧版一致（可选回调）', async () => {
  const { sendWithModelProvider } = await import('../src/network/modelProvider.js');
  const reply = await sendWithModelProvider({
    messages: [],
    localSettings: null,
    onlineSend: async () => 'plain',
  });
  assert.equal(reply, 'plain');
});

test('provider 接线：三个在线出口都通知 api，本地成功通知 local 并带模型名', () => {
  assert.ok(PROVIDER.includes('onProviderResolved'));
  // 三个在线出口：未就绪 / 资源占用 / 推理失败回退
  const apiNotifyCount = (PROVIDER.match(/notifyApi\(\);/g) || []).length;
  assert.equal(apiNotifyCount, 3, '三个在线出口都必须通知 api');
  assert.ok(PROVIDER.includes("kind: 'local'"));
  assert.ok(PROVIDER.includes('model.name || model.modelName'));
});

test('sessionList：markSessionModel 在会话队列内读-改-写，纯函数判变化', () => {
  assert.ok(SESSION_LIST.includes('export function markSessionModel('));
  assert.ok(SESSION_LIST.includes('enqueueSessionMutation(() => markSessionModelInternal('));
  assert.ok(SESSION_LIST.includes('applySessionModelMark(target, mark)'));
  // 不动 preview/updatedAt，不重排列表
  const fnStart = SESSION_LIST.indexOf('async function markSessionModelInternal');
  const fnBody = SESSION_LIST.slice(fnStart, fnStart + 800);
  assert.ok(!fnBody.includes('sortSessions('), '模型标识落盘不应重排列表');
  assert.ok(!fnBody.includes('preview'), '模型标识落盘不应碰 preview');
});

test('barrel 导出链：sessionList → sessions.js → storage.js', () => {
  assert.ok(SESSIONS_BARREL.includes('markSessionModel,'));
  assert.ok(STORAGE_BARREL.includes('markSessionModel,'));
});

test('发送链接线：onProviderResolved 回传 + 成功后 markSessionModel 落盘', () => {
  assert.ok(CHAT_SEND.includes('onProviderResolved: info =>'));
  assert.ok(CHAT_SEND.includes('markSessionModel(sendSessionId,'));
  assert.ok(CHAT_SEND.includes("resolvedProvider.kind === 'local' ? 'local' : 'api'"));
  // 在线模型名从当前配置解析（getActiveModel），供 api 标记使用
  assert.ok(CHAT_SEND.includes('onlineModelName'));
});

test('记忆页呈现：本地 chip 按数据有无出现，badge 与长按模型全名', () => {
  assert.ok(MEMORY_SCREEN.includes('hasLocalSessions(visibleSessions)'));
  // 门控表达式整体锚定：裸 'LOCAL_FILTER' 子串会被 import 行误命中（substring 陷阱）
  assert.ok(MEMORY_SCREEN.includes('[...MEMORY_FILTERS, LOCAL_FILTER]'));
  assert.ok(MEMORY_SCREEN.includes('memoryChips'));
  // badge 放不下全名，长按操作单副标题补上
  assert.ok(MEMORY_SCREEN.includes('本地 · '));
  assert.ok(MEMORY_SCREEN.includes("session.modelKind === 'local'"));
});
