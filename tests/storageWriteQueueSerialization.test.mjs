// 三个「绕过写队列」的写入点：串行化行为测试（回归 2026-10-11 逐行审查 P1）。
//
// 三个域都是**单键**存储，同域既有整表覆盖、又有读-改-写：
//   moments.js      saveProactiveSettings（整表）      vs bindProactiveSlotSession（读-改-写）
//   affinity.js     saveAffinity（整表）               vs 删角色钩子（读-改-写，**曾不在队列**）
//   agentTasks.js   saveAgentTasks / markAgentTaskRun  vs 删角色钩子（读-改-写，**曾不在队列**）
// 只要有一条链不在队列上，它就会插到另一条的「读完、还没写」中间：两边都基于旧快照，
// 后落盘的那次把对方刚提交的改动整个覆盖掉——**后发起的调用不再生效**。
//
// 测试手法：真模块 + 内存 AsyncStorage，把「读」注入延迟（先取旧快照、再等，真机 I/O 就是这个
// 语义），让读-改-写那条链停在「已拿到旧快照、还没写回」的窗口里，此时发起后一条写入。
// 断言：后发起的那次最终生效；并且两次写入都真的发生过（防测试空转）。
//
// 钩子按注册顺序串行执行，而注册顺序 = 本文件的模块加载顺序，所以先加载被测钩子所属的域，
// 保证它排在第一个（否则前面的钩子会吃掉整个延迟窗口，被测钩子拿到的已是新快照，
// 它就不写了——测试会变成空转）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const presetEnv = require.resolve('@babel/preset-env');
const SRC_DIR = path.resolve('src');

function loadModule(absPath) {
  const cached = Module._cache[absPath];
  if (cached) return cached.exports;
  const code = babel.transformSync(fs.readFileSync(absPath, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: absPath,
    presets: [[presetEnv, { targets: { node: 'current' }, modules: 'commonjs' }]],
  }).code;
  const mod = new Module(absPath);
  mod.filename = absPath;
  mod.paths = Module._nodeModulePaths(path.dirname(absPath));
  Module._cache[absPath] = mod;
  try {
    mod._compile(code, absPath);
  } catch (error) {
    delete Module._cache[absPath];
    throw error;
  }
  return mod.exports;
}

const store = new Map();
const writeCounts = new Map();
let readDelay = null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const AsyncStorage = {
  getItem: async key => {
    // 先取快照、再延迟：返回的是**旧值**（这正是「读到旧快照、还没写回」的窗口）。
    const value = store.has(key) ? store.get(key) : null;
    const delay = readDelay;
    if (delay && delay.key === key) {
      readDelay = null;
      await sleep(delay.ms);
    }
    return value;
  },
  setItem: async (key, value) => {
    writeCounts.set(key, (writeCounts.get(key) || 0) + 1);
    store.set(key, String(value));
  },
  removeItem: async key => { store.delete(key); },
  multiRemove: async keys => { (Array.isArray(keys) ? keys : []).forEach(key => store.delete(key)); },
  getAllKeys: async () => [...store.keys()],
};

const FileSystem = {
  documentDirectory: 'file:///documents/',
  getInfoAsync: async () => ({ exists: false }),
  makeDirectoryAsync: async () => {},
  readDirectoryAsync: async () => [],
  deleteAsync: async () => {},
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === '@react-native-async-storage/async-storage') return { __esModule: true, default: AsyncStorage };
  if (request === 'expo-file-system' || request === 'expo-file-system/legacy') {
    return { __esModule: true, ...FileSystem };
  }
  if (request === 'expo-sqlite') return { openDatabase: () => ({ execAsync: async () => [], closeAsync: async () => {} }) };
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
  }
  if (request.endsWith('/characters.js') || request.endsWith('/characters')) {
    return {
      __esModule: true,
      DEFAULT_CHARACTER: { id: 'default' },
      getCharacterLibrary: async () => [],
      saveCharacterLibrary: async () => {},
    };
  }
  if (parent && parent.filename && request.startsWith('.')) {
    const resolvedBase = path.resolve(path.dirname(parent.filename), request);
    if (resolvedBase.startsWith(`${SRC_DIR}${path.sep}`)) {
      for (const candidate of [resolvedBase, `${resolvedBase}.js`]) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return loadModule(candidate);
      }
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__DEV__ = false;

// 加载顺序 = 清理钩子的注册顺序 = 执行顺序（见文件头说明）。
const { runCharacterCleanup } = loadModule(path.resolve('src/storage/characterLifecycle.js'));
const affinity = loadModule(path.resolve('src/storage/affinity.js'));
const agentTasks = loadModule(path.resolve('src/storage/agentTasks.js'));
const moments = loadModule(path.resolve('src/storage/moments.js'));

const PROACTIVE_KEY = '@easychat2_proactive_settings';
const AFFINITY_KEY = '@easychat2_affinity';

const tick = () => sleep(5);

function seed(key, value) {
  store.set(key, JSON.stringify(value));
}

function read(key) {
  return JSON.parse(store.get(key));
}

// 让读-改-写那条链先读到**旧快照**并停在窗口里，此时发起后一条写入。
async function interleave({ readKey, startReadModifyWrite, laterWrite }) {
  writeCounts.clear();
  readDelay = { key: readKey, ms: 60 };
  const first = startReadModifyWrite();
  await tick(); // 第一条已读到旧值，还没写回
  const second = laterWrite();
  await Promise.all([first, second]);
  readDelay = null;
  return writeCounts;
}

test('moments：saveProactiveSettings 不得插进 bindProactiveSlotSession 的读-改-写中间', async () => {
  store.clear();
  const slot = { slotId: 'slot-1', roleId: 'c1', sessionTargetId: '', hour: 9, minute: 0 };
  seed(PROACTIVE_KEY, { slots: [slot], apiConfigId: '', model: '' });

  const writes = await interleave({
    readKey: PROACTIVE_KEY,
    startReadModifyWrite: () => moments.bindProactiveSlotSession('slot-1', 's-bound'),
    // 后发起：用户刚在面板上把槽换成另一个会话（整表写入）
    laterWrite: () => moments.saveProactiveSettings({
      slots: [{ ...slot, sessionTargetId: 's-user' }],
      apiConfigId: '',
      model: '',
    }),
  });

  assert.equal(
    read(PROACTIVE_KEY).slots[0].sessionTargetId,
    's-user',
    '后发起的整表写入必须最终生效（旧写法下会被 bind 的读-改-写覆盖回 s-bound）'
  );
  assert.equal(writes.get(PROACTIVE_KEY) || 0, 2, '两次写入都必须真的发生（防测试空转）');
});

test('affinity：删角色钩子不得插进 saveAffinity 的整表写入中间', async () => {
  store.clear();
  seed(AFFINITY_KEY, { c1: { score: 10, turnCount: 1, triggers: [] } });

  const writes = await interleave({
    readKey: AFFINITY_KEY,
    startReadModifyWrite: () => runCharacterCleanup(['c1']),
    // 后发起：界面把新的好感度表整体存下来（只含 c2）
    laterWrite: () => affinity.saveAffinity({ c2: { score: 5, turnCount: 2, triggers: [] } }),
  });

  const stored = read(AFFINITY_KEY);
  assert.deepEqual(Object.keys(stored), ['c2'], '后发起的整表写入必须最终生效（旧写法下会被钩子覆盖成空表）');
  assert.equal(stored.c2.score, 5);
  assert.equal(writes.get(AFFINITY_KEY) || 0, 2, '两次写入都必须真的发生');
});

test('agentTasks：删角色钩子不得插进 saveAgentTasks 的整表写入中间', async () => {
  store.clear();
  seed(agentTasks.AGENT_TASKS_KEY, {
    tasks: [
      { taskId: 't1', roleId: 'c1', mode: 'WORK', hour: 8, minute: 0 },
      { taskId: 't2', roleId: 'c2', mode: 'WORK', hour: 8, minute: 0 },
    ],
  });
  seed(agentTasks.AGENT_TASK_RUNS_KEY, { t1: '2024-01-01', t2: '2024-01-01' });

  const writes = await interleave({
    readKey: agentTasks.AGENT_TASKS_KEY,
    startReadModifyWrite: () => runCharacterCleanup(['c1']),
    // 后发起：用户在面板上整表保存任务（只剩新任务 t3）
    laterWrite: () => agentTasks.saveAgentTasks([{ taskId: 't3', roleId: 'c3', mode: 'WORK', hour: 8, minute: 0 }]),
  });

  assert.deepEqual(
    read(agentTasks.AGENT_TASKS_KEY).tasks.map(item => item.taskId),
    ['t3'],
    '后发起的整表写入必须最终生效（旧写法下会被钩子写回 t2）'
  );
  assert.equal(writes.get(agentTasks.AGENT_TASKS_KEY) || 0, 2, '两次写入都必须真的发生');
  // 顺带确认钩子本身没坏：c1 的运行记录连带清掉，c2 的保留
  assert.deepEqual(Object.keys(read(agentTasks.AGENT_TASK_RUNS_KEY)), ['t2']);
});
