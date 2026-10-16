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
  WORKSPACE_CHAT_DRAFT_MAX,
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
// 「读会抛错」的注入开关：把某个键的 getItem 变成抛错（模拟真机上的 CursorWindow 单值
// 读取上限 / 底层读失败）。沿用本项目既有的注入方式（内存 Map + 模块加载替换）。
const failingKeys = new Set();
const AsyncStorage = {
  getItem: async key => {
    if (failingKeys.has(key)) throw new Error(`read failed: ${key}`);
    return store.has(key) ? store.get(key) : null;
  },
  setItem: async (key, value) => { store.set(key, value); },
  removeItem: async key => { store.delete(key); },
  // 探测用（重建索引）：**只列键名**，不读值——超限值 getItem 会抛错（characters 域的坑）。
  getAllKeys: async () => [...store.keys()],
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
  // 与 src/storage/io.js:160 同口径的最小实现：getItem 抛错 / JSON 坏 → corrupt，
  // 键不存在 → missing，正常 → ok。被测代码靠它区分「键不在」与「读失败」。
  readJsonStatus: async key => {
    let raw;
    try {
      raw = await AsyncStorage.getItem(key);
      if (raw === null || raw === undefined) return { status: 'missing' };
      return { status: 'ok', value: JSON.parse(raw) };
    } catch (error) {
      return { status: 'corrupt' };
    }
  },
  // 与 src/storage/io.js 的 createMutationQueue **同形**（含按 key 分道）：
  // FEAT-AC12-P1 给 workspaceChats 的写入按角色分道，桩不同形就会让
  // 「跨角色不互阻」的用例假绿（串行执行永远看不出分道）。
  createMutationQueue: () => {
    let single = Promise.resolve();
    const buckets = new Map();
    return {
      enqueue(task, key = '') {
        const bucket = String(key || '');
        const tail = bucket ? (buckets.get(bucket) || Promise.resolve()) : single;
        const next = tail.then(task, task);
        if (bucket) buckets.set(bucket, next.catch(() => {}));
        else single = next.catch(() => {});
        return next;
      },
      settle() {
        const tails = [single, ...buckets.values()];
        return Promise.all(tails.map(tail => tail.catch(() => {}))).then(() => undefined);
      },
    };
  },
};

// FEAT-AC12-P1：workspace.js 新增两个依赖——迁移留痕与角色删除清理钩子。
const diagnosticsCalls = [];
const diagnosticsStub = {
  recordDiagnostic: (scope, error, message) => { diagnosticsCalls.push({ scope, message }); },
};
const cleanupHooks = [];
const characterLifecycleStub = {
  onCharacterDeleted: (name, handler) => { cleanupHooks.push({ name, handler }); },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return AsyncStorage;
  if (request === './io.js') return ioStub;
  if (request === './diagnostics.js') return diagnosticsStub;
  if (request === './characterLifecycle.js') return characterLifecycleStub;
  if (request === '../workspace/settings.js') return { normalizeWorkspaceSettings };
  // 抛错文案走 i18n（存储层不许硬编码中文）：按既有先例（sessionBranches.test.mjs）
  // 返回键名，避免加载整棵词条树。
  if (request === '../i18n/index.js') return { tActive: key => String(key) };
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

test('输入草稿归一化：老数据空串兜底，超长截断', () => {
  assert.equal(normalizeWorkspaceChat({ id: 'c' }).draft, '', '老数据无 draft → 空串兜底');
  assert.equal(normalizeWorkspaceChat({ id: 'c', draft: 123 }).draft, '123', '非字符串收敛为字符串');
  const long = 'x'.repeat(WORKSPACE_CHAT_DRAFT_MAX + 50);
  const chat = normalizeWorkspaceChat({ id: 'c', draft: long });
  assert.ok(chat.draft.length <= WORKSPACE_CHAT_DRAFT_MAX + 1,
    `草稿应截断到 ${WORKSPACE_CHAT_DRAFT_MAX} 以内`);
});

test('saveWorkspaceChatDraft：草稿落盘、不存在的会话拒绝、且不把旧会话顶到最前', async () => {
  const {
    createWorkspaceChat,
    getWorkspaceChats,
    saveWorkspaceChatDraft,
  } = loadWorkspaceStorage();

  const older = await createWorkspaceChat('draft-a');
  await new Promise(resolve => setTimeout(resolve, 20));
  const newer = await createWorkspaceChat('draft-a');
  let bucket = await getWorkspaceChats('draft-a');
  assert.equal(bucket.chats[0].id, newer.id, '新会话在最前');
  const olderUpdatedAt = bucket.chats.find(item => item.id === older.id).updatedAt;

  // 写草稿：落盘，且 updatedAt 原样不动
  assert.equal(await saveWorkspaceChatDraft('draft-a', older.id, '写到一半的指令'), true);
  bucket = await getWorkspaceChats('draft-a');
  const olderChat = bucket.chats.find(item => item.id === older.id);
  assert.equal(olderChat.draft, '写到一半的指令');
  assert.equal(olderChat.updatedAt, olderUpdatedAt,
    '草稿不是会话活动：updatedAt 不该被改写（否则界面会显示「刚更新」的误导时间）');
  assert.equal(bucket.chats[0].id, newer.id, '打字不该把旧会话顶到历史列表最前');

  // 发送后清草稿
  await saveWorkspaceChatDraft('draft-a', older.id, '');
  bucket = await getWorkspaceChats('draft-a');
  assert.equal(bucket.chats.find(item => item.id === older.id).draft, '');

  // 不存在的会话 / 缺参数：如实返回 false，且不新建会话
  assert.equal(await saveWorkspaceChatDraft('draft-a', 'nope', 'x'), false);
  assert.equal(await saveWorkspaceChatDraft('', older.id, 'x'), false);
  assert.equal((await getWorkspaceChats('draft-a')).chats.length, 2);
});

test('I5 会话归档：normalize 老数据兜底 false + 存取往返 + 幂等', async () => {
  // 纯函数层：老数据无 archived 字段 → false（零迁移）
  assert.equal(normalizeWorkspaceChat({ id: 'x' }).archived, false);
  assert.equal(normalizeWorkspaceChat({ id: 'x', archived: true }).archived, true);

  const { createWorkspaceChat, getWorkspaceChats, setWorkspaceChatArchived } = loadWorkspaceStorage();
  const chat = await createWorkspaceChat('archive-a');
  assert.equal(chat.archived, false, '新会话未归档');

  // 归档 → 标记落盘；再取仍是 archived
  assert.equal(await setWorkspaceChatArchived('archive-a', chat.id, true), true);
  let bucket = await getWorkspaceChats('archive-a');
  assert.equal(bucket.chats.find(item => item.id === chat.id).archived, true);

  // 幂等：重复设置同一状态直接成功
  assert.equal(await setWorkspaceChatArchived('archive-a', chat.id, true), true);

  // 恢复
  assert.equal(await setWorkspaceChatArchived('archive-a', chat.id, false), true);
  bucket = await getWorkspaceChats('archive-a');
  assert.equal(bucket.chats.find(item => item.id === chat.id).archived, false);

  // 边界：不存在的会话 / 缺参数 → false
  assert.equal(await setWorkspaceChatArchived('archive-a', 'nope', true), false);
  assert.equal(await setWorkspaceChatArchived('', chat.id, true), false);
});

test('N2 整表替换：覆盖式写入（压缩后落库用），不是追加', async () => {
  const {
    appendWorkspaceChatMessages,
    createWorkspaceChat,
    getWorkspaceChats,
    replaceWorkspaceChatMessages,
  } = loadWorkspaceStorage();

  const chat = await createWorkspaceChat('compact-a');
  await appendWorkspaceChatMessages('compact-a', chat.id, [
    { id: 'm1', role: 'user', content: '原始一' },
    { id: 'm2', role: 'assistant', content: '原始二' },
    { id: 'm3', role: 'user', content: '原始三' },
  ]);

  const replaced = await replaceWorkspaceChatMessages('compact-a', chat.id, [
    { id: 'sum', role: 'assistant', content: '[历史压缩] 摘要' },
    { id: 'm3', role: 'user', content: '原始三' },
  ]);
  assert.ok(replaced, '替换成功返回会话对象');
  const bucket = await getWorkspaceChats('compact-a');
  assert.deepEqual(bucket.chats[0].messages.map(item => item.id), ['sum', 'm3'], '整表覆盖，不是追加');

  // 不存在的会话 / 缺参数 → null，不改动
  assert.equal(await replaceWorkspaceChatMessages('compact-a', 'nope', [{ id: 'x', role: 'user', content: 'x' }]), null);
  assert.equal(await replaceWorkspaceChatMessages('', chat.id, []), null);
});

// 工作区会话是**一手数据**（用户与 agent 的对话，丢了不可重建）——读失败一次就用空桶
// 整桶覆盖，等于把该角色的对话一次抹掉。变体①「拒绝写回」
//（参考 src/storage/worldMap.js:37）：八个写入口全部抛错中止。
//
// FEAT-AC12-P1：守卫**作用域从整店缩到单角色键**（键位从 WORKSPACE_CHATS_KEY 改为
// `..._item::<characterId>`）。判据一律不变，只是失败注入点换了键。
test('工作区会话：读失败时八个写入口全部抛错，绝不用空桶覆盖已有对话', async () => {
  const mod = loadWorkspaceStorage();
  const {
    appendWorkspaceChatMessages,
    clearWorkspaceChats,
    createWorkspaceChat,
    deleteWorkspaceChat,
    getWorkspaceChats,
    replaceWorkspaceChatMessages,
    saveWorkspaceChatDraft,
    setActiveWorkspaceChat,
    setWorkspaceChatArchived,
    WORKSPACE_CHATS_ITEM_PREFIX,
  } = mod;
  const itemKey = id => `${WORKSPACE_CHATS_ITEM_PREFIX}${id}`;

  store.clear();
  failingKeys.clear();
  mod.__resetWorkspaceChatsMigration();
  // 用户已有的一手对话（另一角色也有一份，用来证明「写回空桶会连带抹掉别人的会话」）
  const mine = await createWorkspaceChat('role-a');
  await appendWorkspaceChatMessages('role-a', mine.id, [{ id: 'm1', role: 'user', content: '一手对话' }]);
  const other = await createWorkspaceChat('role-b');
  await appendWorkspaceChatMessages('role-b', other.id, [{ id: 'n1', role: 'user', content: '别人的对话' }]);
  const beforeA = store.get(itemKey('role-a'));
  const beforeB = store.get(itemKey('role-b'));

  failingKeys.add(itemKey('role-a'));
  const expect = fn => assert.rejects(fn, /chatLogReadFailed/, '读失败必须抛错，不得静默写回空桶');
  await expect(() => createWorkspaceChat('role-a'));
  await expect(() => appendWorkspaceChatMessages('role-a', mine.id, [{ id: 'm2', role: 'user', content: '新消息' }]));
  await expect(() => replaceWorkspaceChatMessages('role-a', mine.id, [{ id: 'm9', role: 'user', content: '压缩后' }]));
  await expect(() => setWorkspaceChatArchived('role-a', mine.id, true));
  await expect(() => saveWorkspaceChatDraft('role-a', mine.id, '草稿'));
  await expect(() => setActiveWorkspaceChat('role-a', mine.id));
  await expect(() => deleteWorkspaceChat('role-a', mine.id));
  await expect(() => clearWorkspaceChats('role-a'));
  failingKeys.delete(itemKey('role-a'));

  // (b) 原会话一字未动：自己的与别人的都在
  assert.equal(store.get(itemKey('role-a')), beforeA, '读失败时绝不允覆盖该角色的键');
  assert.equal(store.get(itemKey('role-b')), beforeB, '别人的角色键更不该被动到');
  assert.equal((await getWorkspaceChats('role-a')).chats[0].messages[0].content, '一手对话');
  assert.equal((await getWorkspaceChats('role-b')).chats[0].messages[0].content, '别人的对话');

  // 读路径的用户体验不变：读失败时列表仍返回空清单，不抛错
  failingKeys.add(itemKey('role-a'));
  const fallback = await getWorkspaceChats('role-a');
  failingKeys.delete(itemKey('role-a'));
  assert.deepEqual(fallback.chats, [], '读失败仍给空清单（不弹报错）');

  // 守卫只在 corrupt 时生效，不是永久封锁：读恢复后照常追加
  const updated = await appendWorkspaceChatMessages('role-a', mine.id, [{ id: 'm3', role: 'user', content: '恢复后' }]);
  assert.equal(updated.messages.length, 2);
  assert.equal((await getWorkspaceChats('role-a')).chats[0].messages[1].content, '恢复后');
});

// ---------- FEAT-AC12-P1：单键拆分（数据风险 + 写放大治理） ----------
//
// 背景：工作区会话原先全角色挤在 @easychat2_workspace_chats 一个键里，违反仓库自己
// 立的不变量（AGENTS.md：Never store a whole growing collection in one key）。
// 现在拆成 `..._item::<characterId>` + 一个索引键；legacy 键退化为**只读迁移源**。

function freshModule() {
  const mod = loadWorkspaceStorage();
  mod.__resetWorkspaceChatsMigration();
  return mod;
}

// 造一份「多角色 + activeId 指向被裁会话 + 重复 id」的 legacy 脏数据，
// 逐角色比对迁移结果与「直接按旧口径归一化」是否一致。
function legacyFixture() {
  const manyMessages = Array.from(
    { length: WORKSPACE_CHAT_MESSAGE_LIMIT + 5 },
    (_, i) => ({ id: `msg-${i}`, role: 'user', content: `c${i}`, at: 1000 + i })
  );
  return {
    'role-a': {
      activeId: 'gone-chat', // 指向一条不在清单里的会话 → 应回落
      chats: [
        { id: 'keep', title: '甲', createdAt: 1, updatedAt: 50, messages: [{ id: 'a1', role: 'user', content: '甲的话' }] },
        // 重复 id：归一化应只留 updatedAt 最大的那条
        { id: 'keep', title: '甲的旧版', createdAt: 1, updatedAt: 10, messages: [] },
      ],
    },
    'role-b': {
      activeId: 'b1',
      chats: [{ id: 'b1', title: '乙', createdAt: 2, updatedAt: 60, messages: manyMessages, draft: 'draft-b' }],
    },
  };
}

test('P1 迁移：legacy 单键按角色拆成 item 键 + 索引，成功后删除 legacy', async () => {
  const mod = freshModule();
  const { getWorkspaceChats, WORKSPACE_CHATS_KEY, WORKSPACE_CHATS_ITEM_PREFIX, WORKSPACE_CHATS_INDEX_KEY } = mod;
  store.clear();
  failingKeys.clear();
  store.set(WORKSPACE_CHATS_KEY, JSON.stringify(legacyFixture()));

  // 读任一角色即触发迁移（读路径懒迁移）
  const a = await getWorkspaceChats('role-a');
  const b = await getWorkspaceChats('role-b');

  // ⚠️ 先断言键位、再断言内容：反过来的话「键没建出来」会以
  // `TypeError: Cannot read properties of undefined` 的形式炸掉，
  // 而不是给出下面这些**说得清哪里错**的断言信息（注入验证逼出来的写法）。
  assert.ok(store.has(`${WORKSPACE_CHATS_ITEM_PREFIX}role-a`), 'role-a 应有独立 item 键');
  assert.ok(store.has(`${WORKSPACE_CHATS_ITEM_PREFIX}role-b`), 'role-b 应有独立 item 键');
  assert.equal(store.has(WORKSPACE_CHATS_KEY), false, '迁移成功后必须删掉 legacy 键');

  assert.equal(a.chats.length, 1, '重复 id 只留一条');
  assert.equal(a.chats[0].title, '甲');
  assert.equal(a.activeId, 'keep', 'activeId 指向被裁会话时应回落到现存的最新一条');
  assert.equal(b.chats.length, 1);
  assert.equal(b.chats[0].draft, 'draft-b', '草稿随会话一起迁移');
  assert.equal(b.chats[0].messages.length, WORKSPACE_CHAT_MESSAGE_LIMIT, '消息按原上限裁剪');

  const index = JSON.parse(store.get(WORKSPACE_CHATS_INDEX_KEY));
  assert.equal(index['role-a'], 50, '索引记该角色最新会话的 updatedAt');
  assert.equal(index['role-b'], 60);
});

test('P1 迁移：与旧口径**逐字一致**（直接归一化 vs 迁移后读回）', async () => {
  const mod = freshModule();
  const { getWorkspaceChats, WORKSPACE_CHATS_KEY } = mod;
  store.clear();
  failingKeys.clear();
  const fixture = legacyFixture();
  store.set(WORKSPACE_CHATS_KEY, JSON.stringify(fixture));

  const viaOldNormalization = normalizeWorkspaceChatsStore(fixture);
  assert.deepEqual(await getWorkspaceChats('role-a'), viaOldNormalization['role-a']);
  assert.deepEqual(await getWorkspaceChats('role-b'), viaOldNormalization['role-b']);
});

test('P1 迁移：幂等——不覆盖已有 item 键，且二次读取不重复拆', async () => {
  const mod = freshModule();
  const { getWorkspaceChats, appendWorkspaceChatMessages, WORKSPACE_CHATS_KEY, WORKSPACE_CHATS_ITEM_PREFIX } = mod;
  store.clear();
  failingKeys.clear();
  store.set(WORKSPACE_CHATS_KEY, JSON.stringify(legacyFixture()));

  const a = await getWorkspaceChats('role-a');
  // 迁移后写入新消息
  await appendWorkspaceChatMessages('role-a', a.chats[0].id, [{ id: 'new-1', role: 'user', content: '迁移后新增' }]);
  const afterWrite = store.get(`${WORKSPACE_CHATS_ITEM_PREFIX}role-a`);

  // 再放一份 legacy（模拟旧备份恢复进来）——迁移不得覆盖已有 item 键
  store.set(WORKSPACE_CHATS_KEY, JSON.stringify({ 'role-a': { activeId: '', chats: [] } }));
  mod.__resetWorkspaceChatsMigration();
  const again = await getWorkspaceChats('role-a');
  // 先断条数再断内容（理由同上面那条：键被清空时 TypeError 说不清哪里错）
  assert.equal(again.chats.length, 1, '已有 item 键不得被 legacy 覆盖');
  assert.equal(again.chats[0].messages.length, 2, '已有 item 键不得被 legacy 覆盖');
  assert.equal(store.get(`${WORKSPACE_CHATS_ITEM_PREFIX}role-a`), afterWrite, '键内容应一字未动');
  assert.equal(store.has(WORKSPACE_CHATS_KEY), false, '本轮迁移仍应清掉 legacy 键');
});

test('P1 迁移：迁移源 corrupt 时**不拆不删不建键**（绝不用空键遮蔽真数据）', async () => {
  const mod = freshModule();
  const { getWorkspaceChats, WORKSPACE_CHATS_KEY, WORKSPACE_CHATS_ITEM_PREFIX } = mod;
  store.clear();
  failingKeys.clear();
  diagnosticsCalls.length = 0;
  // legacy 值不是合法 JSON → readJsonStatus 判 corrupt
  store.set(WORKSPACE_CHATS_KEY, '{ 这不是 JSON');
  const before = store.get(WORKSPACE_CHATS_KEY);

  const bucket = await getWorkspaceChats('role-a');
  assert.deepEqual(bucket.chats, [], '迁移源损坏时该角色读空（不弹错）');
  assert.equal(store.get(WORKSPACE_CHATS_KEY), before, '损坏的 legacy 原值必须原样留着');
  assert.equal(store.has(`${WORKSPACE_CHATS_ITEM_PREFIX}role-a`), false,
    '绝不能在源损坏时建出空 item 键——那会永久遮蔽恢复后的真数据');
  assert.ok(diagnosticsCalls.some(item => /迁移源损坏/.test(String(item.message))),
    '迁移源损坏必须留痕（不静默）');
});

test('P1 迁移：源损坏期间新会话仍可落盘，且不遮蔽 legacy（后续恢复仍能迁移）', async () => {
  const mod = freshModule();
  const { createWorkspaceChat, getWorkspaceChats, WORKSPACE_CHATS_KEY } = mod;
  store.clear();
  failingKeys.clear();
  store.set(WORKSPACE_CHATS_KEY, '{ 坏值');
  // 源损坏不该把 App 变砖：用户仍能开新对话并落盘（这正是本轮要修的那个失败方向）
  const chat = await createWorkspaceChat('role-a');
  assert.ok(chat.id);
  assert.equal((await getWorkspaceChats('role-a')).chats.length, 1);
  // legacy 原值仍在盘上，等人工/备份恢复——没有被「不吞」原则牺牲掉
  assert.equal(store.get(WORKSPACE_CHATS_KEY), '{ 坏值');
});

test('P1 队列分道：A 角色的长写不再挡住 B 角色（跨角色不互阻）', async () => {
  const mod = freshModule();
  const { createWorkspaceChat, appendWorkspaceChatMessages } = mod;
  store.clear();
  failingKeys.clear();
  const a = await createWorkspaceChat('role-a');
  const b = await createWorkspaceChat('role-b');

  // 让 role-a 的读在队列里「卡住」
  const slowKey = `${mod.WORKSPACE_CHATS_ITEM_PREFIX}role-a`;
  const realGet = AsyncStorage.getItem;
  let releaseSlow;
  const gate = new Promise(resolve => { releaseSlow = resolve; });
  AsyncStorage.getItem = async key => {
    if (key === slowKey) await gate;
    return realGet(key);
  };
  try {
    // 先发起 A 的长写（会卡在 gate 上），不 await
    const slowWrite = appendWorkspaceChatMessages('role-a', a.id, [{ id: 'slow', role: 'user', content: '慢' }]);
    // 再发起 B 的写入：分道后它**不应**被 A 挡住
    const fast = await Promise.race([
      appendWorkspaceChatMessages('role-b', b.id, [{ id: 'fast', role: 'user', content: '快' }]).then(() => 'done'),
      new Promise(resolve => setTimeout(() => resolve('blocked'), 200)),
    ]);
    assert.equal(fast, 'done', 'B 角色不该被 A 角色的长写阻塞（队列必须分道）');
    releaseSlow();
    await slowWrite;
  } finally {
    AsyncStorage.getItem = realGet;
    releaseSlow();
  }
});

test('P1 逐出：超过 50 个角色时按 lastUpdatedAt 从旧到新删 item 键', async () => {
  const mod = freshModule();
  const { createWorkspaceChat, WORKSPACE_CHATS_ITEM_PREFIX, WORKSPACE_CHATS_INDEX_KEY } = mod;
  store.clear();
  failingKeys.clear();
  // 造 50 个角色（正好触及上限）
  const ids = Array.from({ length: 50 }, (_, i) => `c${String(i).padStart(2, '0')}`);
  for (const id of ids) await createWorkspaceChat(id);
  // 手工把索引时间戳排成「c00 最旧 … c49 最新」
  const index = {};
  ids.forEach((id, i) => { index[id] = 1000 + i; });
  store.set(WORKSPACE_CHATS_INDEX_KEY, JSON.stringify(index));

  // 第 51 个角色写入 → 应逐出最旧的 c00
  await createWorkspaceChat('c-new');
  assert.equal(store.has(`${WORKSPACE_CHATS_ITEM_PREFIX}c00`), false, '最旧的角色应被逐出');
  assert.ok(store.has(`${WORKSPACE_CHATS_ITEM_PREFIX}c-new`), '刚写入的角色绝不能被逐出');
  assert.ok(store.has(`${WORKSPACE_CHATS_ITEM_PREFIX}c49`), '较新的角色仍在');
  const after = JSON.parse(store.get(WORKSPACE_CHATS_INDEX_KEY));
  assert.equal('c00' in after, false, '逐出要连带清索引条目');
  assert.equal(Object.keys(after).length, 50);
});

test('P1 逐出：刚写入的角色即使**时间戳最旧**也不得被逐出（草稿写路径可达）', async () => {
  // ⚠️ 这条是注入验证逼出来的**真缺口**：最初我用 createWorkspaceChat 造「刚写入的角色」，
  // 而它总把 updatedAt 设成 Date.now() ⇒ 必然排最后 ⇒ 保护分支**永远走不到**，
  // 把 `filter(id => id !== protectId)` 去掉测试照样全绿。
  //
  // 可达路径是 saveWorkspaceChatDraft：它**有意保留 target.updatedAt**（草稿不是会话活动，
  // 不能把旧会话顶到最前——见源码注释）。于是给一个「最旧」的角色存草稿，
  // 写完之后它**仍是索引里最旧的** ⇒ 逐出会立刻删掉它，除非有 protectId 保护。
  const mod = freshModule();
  const {
    createWorkspaceChat, saveWorkspaceChatDraft, getWorkspaceChats,
    WORKSPACE_CHATS_ITEM_PREFIX, WORKSPACE_CHATS_INDEX_KEY,
  } = mod;
  store.clear();
  failingKeys.clear();

  // 先建满 50 个角色（c01..c50）——**不能**用它来造那个「最旧的」角色：
  // 建第 51 个时逐出就已经发生，待测的角色会在准备阶段被删掉（第一版正是这么错的）。
  const ids = Array.from({ length: 50 }, (_, i) => `c${String(i + 1).padStart(2, '0')}`);
  for (const id of ids) await createWorkspaceChat(id);

  // 手工造一个「很久以前更新过」的 c00（直接写盘，绕开 createWorkspaceChat 的 Date.now()）
  const c00Key = `${WORKSPACE_CHATS_ITEM_PREFIX}c00`;
  const c00ChatId = 'c00-chat';
  store.set(c00Key, JSON.stringify({
    activeId: c00ChatId,
    chats: [{ id: c00ChatId, role: 'user', content: '旧会话', isError: false, at: 1, updatedAt: 1 }],
  }));
  const index = JSON.parse(store.get(WORKSPACE_CHATS_INDEX_KEY));
  index.c00 = 1; // 最旧
  store.set(WORKSPACE_CHATS_INDEX_KEY, JSON.stringify(index));
  assert.equal(Object.keys(index).length, 51, '前提：索引里已有 51 个角色（超过上限 50）');

  // 给**最旧的** c00 存草稿 → 草稿保留 updatedAt ⇒ 它写完仍是最旧 → 触发逐出
  await saveWorkspaceChatDraft('c00', c00ChatId, '一段草稿');

  assert.ok(store.has(c00Key),
    '刚写入的角色即使时间戳最旧也不得被逐出（否则用户刚打的草稿当场没了）');
  const bucket = await getWorkspaceChats('c00');
  assert.equal(bucket.chats.length, 1, '前提：草稿确实写进了 c00');
  assert.equal(bucket.chats[0].draft, '一段草稿', '草稿要真的落盘（不是「没被逐出但也没写」）');
  // 逐出仍要发生：总数必须回到 50（保护刚写入的角色 ≠ 让逐出整体失效）
  const after = JSON.parse(store.get(WORKSPACE_CHATS_INDEX_KEY));
  assert.equal(Object.keys(after).length, 50, '保护一个角色不能让逐出整体失效');
  assert.ok('c00' in after, '被保护的角色仍在索引里');
});

test('P1 角色删除：注册了清理钩子，删角色会清掉 item 键与索引条目', async () => {
  const mod = freshModule();
  const { createWorkspaceChat, WORKSPACE_CHATS_ITEM_PREFIX, WORKSPACE_CHATS_INDEX_KEY } = mod;
  store.clear();
  failingKeys.clear();
  await createWorkspaceChat('doomed');
  await createWorkspaceChat('survivor');
  assert.ok(store.has(`${WORKSPACE_CHATS_ITEM_PREFIX}doomed`));

  // 走真实注册的钩子（模块加载时已注册）
  const mine = cleanupHooks.filter(h => h.name === 'workspaceChats');
  assert.ok(mine.length > 0, '必须注册角色删除清理钩子');
  for (const hook of mine) await hook.handler(['doomed']);

  assert.equal(store.has(`${WORKSPACE_CHATS_ITEM_PREFIX}doomed`), false, '被删角色的 item 键应清掉');
  assert.ok(store.has(`${WORKSPACE_CHATS_ITEM_PREFIX}survivor`), '其它角色不受影响');
  const index = JSON.parse(store.get(WORKSPACE_CHATS_INDEX_KEY));
  assert.equal('doomed' in index, false, '索引条目也要清');
  assert.ok('survivor' in index);
});

test('P1 清空：删除 item 键而不是写空桶（不占逐出名额）', async () => {
  const mod = freshModule();
  const {
    createWorkspaceChat, appendWorkspaceChatMessages, clearWorkspaceChats,
    WORKSPACE_CHATS_ITEM_PREFIX, WORKSPACE_CHATS_INDEX_KEY,
  } = mod;
  store.clear();
  failingKeys.clear();
  const chat = await createWorkspaceChat('role-a');
  await appendWorkspaceChatMessages('role-a', chat.id, [{ id: 'x', role: 'user', content: 'x' }]);

  const removed = await clearWorkspaceChats('role-a');
  assert.equal(removed, 1);
  assert.equal(store.has(`${WORKSPACE_CHATS_ITEM_PREFIX}role-a`), false, '应直接删键');
  const index = JSON.parse(store.get(WORKSPACE_CHATS_INDEX_KEY));
  assert.equal('role-a' in index, false);
});

test('P1 索引：损坏时可由 item 键重建（逐出不至于静默失效）', async () => {
  const mod = freshModule();
  const { createWorkspaceChat, getWorkspaceChats, WORKSPACE_CHATS_INDEX_KEY } = mod;
  store.clear();
  failingKeys.clear();
  const a = await createWorkspaceChat('role-a');
  await createWorkspaceChat('role-b');
  // 索引写坏
  store.set(WORKSPACE_CHATS_INDEX_KEY, '{ 坏索引');
  // 触发一次写入路径 → 应重建索引而不是把逐出永久废掉
  await createWorkspaceChat('role-c');
  const index = JSON.parse(store.get(WORKSPACE_CHATS_INDEX_KEY));
  assert.ok('role-a' in index && 'role-b' in index && 'role-c' in index,
    `索引应从 item 键重建出全部角色: ${JSON.stringify(index)}`);
  // 数据本身不受影响
  assert.equal((await getWorkspaceChats('role-a')).activeId, a.id);
});

test('P1 键位：legacy 常量保留为迁移源（旧键名守卫与备份/恢复都还要它）', () => {
  const mod = freshModule();
  assert.equal(mod.WORKSPACE_CHATS_KEY, '@easychat2_workspace_chats');
  assert.equal(mod.WORKSPACE_CHATS_ITEM_PREFIX, '@easychat2_workspace_chats_item::');
  assert.equal(mod.WORKSPACE_CHATS_INDEX_KEY, '@easychat2_workspace_chats_index');
});

test('P1 拆分后：单角色数据只落在自己的 item 键里（不再有整店大键）', async () => {
  const mod = freshModule();
  const {
    createWorkspaceChat, appendWorkspaceChatMessages,
    WORKSPACE_CHATS_KEY, WORKSPACE_CHATS_ITEM_PREFIX,
  } = mod;
  store.clear();
  failingKeys.clear();
  const a = await createWorkspaceChat('role-a');
  // 20000 字符正文（chats.js 的单条上限）——旧布局下它会与其它角色挤在同一个键里
  await appendWorkspaceChatMessages('role-a', a.id, [
    { id: 'big', role: 'assistant', content: 'x'.repeat(20000) },
  ]);
  assert.equal(store.has(WORKSPACE_CHATS_KEY), false, '不得再写整店单键');
  const own = store.get(`${WORKSPACE_CHATS_ITEM_PREFIX}role-a`);
  assert.ok(own && own.length > 20000, '该角色的正文应落在自己的键里');
  // 另一个角色的键里绝不含 role-a 的数据
  const b = await createWorkspaceChat('role-b');
  assert.equal(store.get(`${WORKSPACE_CHATS_ITEM_PREFIX}role-b`).includes('xxxx'), false);
  assert.ok(b.id);
});
