// 工作区会话（对话持久化）：纯函数裁剪 + 存储往返。
//
// 这一层的意义是「回看几轮之前的指令」：消息必须真的落盘、能按角色分区、能切换与删除，
// 同时有上限——工作区回复常带长文本，不裁剪会把 AsyncStorage 撑爆。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import {
  WORKSPACE_CHAT_LIMIT,
  WORKSPACE_CHAT_MESSAGE_LIMIT,
  WORKSPACE_CHAT_TITLE_MAX,
  deriveWorkspaceChatTitle,
  normalizeWorkspaceChat,
  normalizeWorkspaceChatMessage,
  normalizeWorkspaceChatsStore,
  upsertWorkspaceChat,
} from '../src/workspace/chats.js';
import { normalizeWorkspaceSettings } from '../src/workspace/settings.js';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const workspaceStoragePath = path.resolve('src/storage/workspace.js');
const transformed = babel.transformSync(fs.readFileSync(workspaceStoragePath, 'utf8'), {
  babelrc: false,
  configFile: false,
  filename: workspaceStoragePath,
  presets: [[require.resolve('@babel/preset-env'), { targets: { node: 'current' }, modules: 'commonjs' }]],
}).code;

const store = new Map();
const AsyncStorage = {
  getItem: async key => (store.has(key) ? store.get(key) : null),
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
};
const ioStub = {
  readJson: async (key, fallback) => {
    try {
      const raw = await AsyncStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  },
  createMutationQueue: () => {
    let single = Promise.resolve();
    return {
      enqueue(task) {
        const next = single.then(task, task);
        single = next.catch(() => {});
        return next;
      },
    };
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === './io.js') return ioStub;
  if (request === '../workspace/settings.js') return { normalizeWorkspaceSettings };
  return originalLoad.call(this, request, parent, isMain);
};

function loadWorkspaceStorage() {
  const filename = workspaceStoragePath;
  const runtimeModule = new Module(filename);
  runtimeModule.filename = filename;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(filename));
  runtimeModule._compile(transformed, filename);
  return runtimeModule.exports;
}

test('标题提炼：取首条用户指令的第一行，空白与纯助手开头都不算', () => {
  assert.equal(deriveWorkspaceChatTitle([
    { role: 'assistant', content: 'hi' },
    { role: 'user', content: '第一行\n第二行' },
  ]), '第一行');
  assert.equal(deriveWorkspaceChatTitle([]), '');
  assert.equal(deriveWorkspaceChatTitle([{ role: 'user', content: '   ' }]), '', '空白指令不算标题');
  assert.equal(deriveWorkspaceChatTitle(null), '');
  // 超长截断（留一个省略号的位置）
  const long = 'a'.repeat(200);
  const title = deriveWorkspaceChatTitle([{ role: 'user', content: long }]);
  assert.ok(title.length <= WORKSPACE_CHAT_TITLE_MAX + 1, `标题应截断到 ${WORKSPACE_CHAT_TITLE_MAX}`);
});

test('会话归一化：消息只留最近 N 条，role 收敛为 user/assistant', () => {
  const many = Array.from(
    { length: WORKSPACE_CHAT_MESSAGE_LIMIT + 20 },
    (_, index) => ({ id: `m${index}`, role: 'user', content: String(index) })
  );
  const chat = normalizeWorkspaceChat({ id: 'c', messages: many });
  assert.equal(chat.messages.length, WORKSPACE_CHAT_MESSAGE_LIMIT);
  assert.equal(
    chat.messages[chat.messages.length - 1].content,
    String(WORKSPACE_CHAT_MESSAGE_LIMIT + 19),
    '保留最近的消息'
  );
  assert.ok(chat.title, '没有标题时会从消息现推一次');
  assert.ok(chat.id && chat.createdAt >= 0 && chat.updatedAt >= 0);

  const message = normalizeWorkspaceChatMessage({ role: 'system', content: 'x', isError: 'yes' });
  assert.equal(message.role, 'user', '未知 role 一律当用户消息');
  assert.equal(message.isError, false, 'isError 只认布尔 true');
  assert.ok(message.id, '缺 id 时自动生成（去重依赖它）');
});

test('会话清单：按更新时间降序、同 id 去重、选中项失效回落最新', () => {
  const result = normalizeWorkspaceChatsStore({
    c1: {
      activeId: 'gone',
      chats: [
        { id: 'a', updatedAt: 100, messages: [] },
        { id: 'b', updatedAt: 300, messages: [] },
        { id: 'a', updatedAt: 200, messages: [] },
      ],
    },
    '  ': { activeId: 'x', chats: [] },
    c2: 'nope',
  });
  assert.deepEqual(Object.keys(result), ['c1'], '空角色名与非法分区被丢弃');
  assert.deepEqual(result.c1.chats.map(item => item.id), ['b', 'a'], '降序且去重');
  assert.equal(result.c1.activeId, 'b', '选中的会话不在清单里 → 回落最新一条');

  const overflowing = {
    c: {
      activeId: '',
      chats: Array.from({ length: WORKSPACE_CHAT_LIMIT + 5 }, (_, index) => ({
        id: `c${index}`,
        updatedAt: index,
        messages: [],
      })),
    },
  };
  assert.equal(normalizeWorkspaceChatsStore(overflowing).c.chats.length, WORKSPACE_CHAT_LIMIT);

  assert.deepEqual(normalizeWorkspaceChatsStore(null), {});
  assert.deepEqual(normalizeWorkspaceChatsStore('nope'), {});
});

test('upsertWorkspaceChat：新会话在最前，同 id 覆盖而不是重复', () => {
  const list = upsertWorkspaceChat([{ id: 'old', updatedAt: 1, messages: [] }], {
    id: 'fresh',
    updatedAt: 5,
    messages: [],
  });
  assert.deepEqual(list.map(item => item.id), ['fresh', 'old']);

  const replaced = upsertWorkspaceChat(list, { id: 'old', updatedAt: 9, messages: [{ id: 'm', role: 'user', content: 'x' }] });
  assert.deepEqual(replaced.map(item => item.id), ['old', 'fresh'], '同 id 覆盖并重新排序');
  assert.equal(replaced[0].messages.length, 1);
});

test('存储往返：新建 / 追加去重 / 切换 / 删除 / 清空，且按角色隔离', async () => {
  const {
    appendWorkspaceChatMessages,
    clearWorkspaceChats,
    createWorkspaceChat,
    deleteWorkspaceChat,
    getWorkspaceChats,
    setActiveWorkspaceChat,
  } = loadWorkspaceStorage();

  const first = await createWorkspaceChat('role-a');
  assert.ok(first.id, '新建返回带 id 的会话');
  let bucket = await getWorkspaceChats('role-a');
  assert.equal(bucket.chats.length, 1);
  assert.equal(bucket.activeId, first.id, '新建即设为活跃');

  await appendWorkspaceChatMessages('role-a', first.id, [
    { id: 'm1', role: 'user', content: '帮我看下 README', at: 1 },
    { id: 'm2', role: 'assistant', content: '好的', at: 2 },
  ]);
  bucket = await getWorkspaceChats('role-a');
  assert.equal(bucket.chats[0].messages.length, 2, '消息落盘');
  assert.equal(bucket.chats[0].title, '帮我看下 README', '标题取自首条用户指令');

  // 同 id 重复追加视为已存在（流式结束后可能重发终稿）
  await appendWorkspaceChatMessages('role-a', first.id, [{ id: 'm2', role: 'assistant', content: '好的（改）' }]);
  bucket = await getWorkspaceChats('role-a');
  assert.equal(bucket.chats[0].messages.length, 2, '同 id 不重复落盘');

  const second = await createWorkspaceChat('role-a');
  bucket = await getWorkspaceChats('role-a');
  assert.equal(bucket.chats.length, 2);
  assert.equal(bucket.activeId, second.id);

  assert.equal(await setActiveWorkspaceChat('role-a', first.id), true);
  assert.equal((await getWorkspaceChats('role-a')).activeId, first.id);
  assert.equal(await setActiveWorkspaceChat('role-a', 'nope'), false, '不存在的会话切换失败并如实返回');
  assert.equal((await getWorkspaceChats('role-a')).activeId, first.id, '失败不改动活跃项');

  // 角色隔离：另一个角色看不到这些
  assert.deepEqual((await getWorkspaceChats('role-b')).chats, []);

  bucket = await deleteWorkspaceChat('role-a', first.id);
  assert.deepEqual(bucket.chats.map(item => item.id), [second.id]);
  assert.equal(bucket.activeId, second.id, '删掉活跃会话后回落到剩下的');

  assert.equal(await clearWorkspaceChats('role-a'), 1);
  assert.deepEqual((await getWorkspaceChats('role-a')).chats, []);
  // 追加到已不存在的会话：静默返回 null，不抛（生成结束落盘时可能已被删）
  assert.equal(await appendWorkspaceChatMessages('role-a', second.id, [{ id: 'x', role: 'user', content: 'x' }]), null);
});
