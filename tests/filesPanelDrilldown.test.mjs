// 文件面板「点击目录被踢回根层」的**真渲染**回归测试。
//
// 事故（用户报告，附截图）：工作区文件面板里点 repos 下的 pppxxxxy 目录，**点一次进不去**，
// 反而回到 repos；必须再点一次才进得了 pppxxxxy。
//
// 根因（对 68f7dc9 逐行核实）：
//   refresh 的 useCallback 依赖含 subdir（FilesPanel.js），于是 subdir 一变 refresh 就换引用；
//   而挂载 effect 的依赖数组含 refresh ⇒ 每次下钻 effect 都整体重跑，它内部做的是
//   「面板打开时初始化一次」才该做的事：
//       setFiles([]) → 清空清单
//       refresh(resolved.id) → 重拉
//   紧接着退空保护 effect 看到 files=[] 里没有以新 subdir 开头的条目 ⇒ setSubdir('') ⇒
//   用户被踢回根层。第二次能进，是因为重跑的 effect 已用新闭包拉回了该层列表。
//
// 本文件用**真组件 + 真 effect**渲染 FilesPanel，只把原生边界换成可控桩，
// 于是钉住的是**行为**（点directory 后 subdir 保持、清单不被清空、初始化只跑一次），
// 而不是源码里有没有某个字符串。
//
// 能验证 / 不能验证（诚实边界）：
//   ✅ effect 依赖是否正确、下钻后状态是否保持、初始化次数、面板重开是否回根层
//   ❌ 真机布局、手势、字体、原生文件系统行为
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { setupNativeStubs } from './helpers/rn/setup.mjs';

setupNativeStubs();

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.__DEV__ = false;

const require = createRequire(import.meta.url);
const React = require('react');
const TestRenderer = require('react-test-renderer');
const act = TestRenderer.act || React.act;

// ---- 可控的工作区后端 ----------------------------------------------------
//
// 目录树与调用记录都在桩模块里（tests/helpers/rn/workspace-native-stub.mjs），
// 测试从**同一个桩实例**读 calls —— 与 setup.mjs 的 resolve 短路指向同一文件，
// 因此 ESM 单例语义保证两边看到的是同一份状态。
import { calls as storeCalls } from './helpers/rn/workspace-native-stub.mjs';
import { calls as settingsCalls } from './helpers/rn/workspace-store-stub.mjs';

const calls = {
  get list() { return storeCalls.list; },
  get createStore() { return storeCalls.createStore; },
  get getSettings() { return settingsCalls.getSettings; },
};

// ---- 把 src/ 的相对依赖换成桩（只换 storage/workspace 与 workspace/native）----
//
// ⚠️ 不能用 `Module._load` 打桩：src/ 是 ESM，`import` 不经过 CJS 的 require 钩子。
// 也不能在桩里调 babel：会重入 preset-env。正确做法是用 ESM loader hook，
// 与 setup.mjs 同一机制（registerHooks 的 resolve 短路到桩文件）。
const SRC = path.resolve('src');
const WORKSPACE_STORE_STUB = path.join(SRC, 'storage', 'workspace.js');
const NATIVE_STUB_TARGET = path.join(SRC, 'workspace', 'native.js');
const HELPER_DIR = path.resolve('tests', 'helpers', 'rn');

// 这两个桩文件承担「内存化的工作区设置」与「可控 store」。
//
// ⚠️ 必须用 pathToFileURL，不能手工拼 `file:///` 字符串：
// Windows 下 `file:///D:/...` 碰巧能解析（盘符后面跟的是 `/`），而 Linux 下路径是
// `/home/runner/work/...`，手工拼成 `file:////home/...`（四个斜杠）会解析出**空 host**，
// 于是 URL 与实际路径对不上、resolve 短路失效 —— 这正是「本地全绿、CI 红」的经典成因。
const workspaceStoreStubUrl = pathToFileURL(path.join(HELPER_DIR, 'workspace-store-stub.mjs')).href;
const nativeStoreStubUrl = pathToFileURL(path.join(HELPER_DIR, 'workspace-native-stub.mjs')).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    try {
      const resolvedPath = path.resolve(fileURLToPath(resolved.url));
      // 用 path.resolve 归一后比较：某些平台/resolver 会给出未归一的路径
      // （多余分隔符、符号链接规范化差异），直接字符串比较会在那里失配，
      // 表现为「桩没接上 → 真实 store 被加载 → 测试挂掉」。归一是零成本的加固。
      if (resolvedPath === path.resolve(WORKSPACE_STORE_STUB)) {
        return { url: workspaceStoreStubUrl, shortCircuit: true };
      }
      if (resolvedPath === path.resolve(NATIVE_STUB_TARGET)) {
        return { url: nativeStoreStubUrl, shortCircuit: true };
      }
    } catch {
      // 非 file: URL，照常返回
    }
    return resolved;
  },
});

let FilesPanel;
FilesPanel = (await import('../src/workspace/screen/FilesPanel.js')).default;

// ---- 取宿主节点（只认宿主，避开组件层级重复计数，见 chatComposerRender 的选择器纪律）----
function findPressables(root) {
  return root.findAll(node => (
    typeof node.type === 'string'
    && typeof node.props.onPress === 'function'
  ));
}

// 点击「含指定文案」的可按节点（文案在它的子树里）。
function pressByText(root, needle) {
  const target = findPressables(root).find(node => {
    const texts = node.findAll(item => typeof item.type === 'string' && typeof item.props.children === 'string');
    return texts.some(item => String(item.props.children).includes(needle));
  });
  assert.ok(target, `找不到包含「${needle}」的可点击节点`);
  return target;
}

// 渲染 + 让挂载 effect 里的 await 链走完。
//
// ⚠️ 必须带超时：若挂载 effect 误依赖了 refresh，会陷入
// 「effect 重跑 → setCharacterId → refresh 换引用 → effect 再重跑」的无限循环。
// 没有超时的话测试不是**失败**而是**挂死**——CI 上表现为整包超时、本地要手动 kill，
// 而且看不出是哪条用例坏了。有了它，这种情况会变成一条明确的失败信息。
// （实测：注入这个 bug 后确实会无限循环，因此这道保护是必要的，不是防御性摆设。）
async function settle(actFn, label) {
  let timer = null;
  await Promise.race([
    actFn(),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`渲染未在 5000ms 内收敛（${label}）——挂载 effect 很可能在反复初始化`)),
        5000
      );
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

// 等「挂载链真的走完」，而不是赌一次 setTimeout(0)。
//
// 为什么不能只 flush 一次微任务队列：挂载 effect 里是
//   getWorkspaceSettings → createWorkspaceStore → resolveWorkspaceAssistant → refresh
// 的**多级 await 链**，每级都要一次真实事件循环轮次。单次 setTimeout(0) 在本地机器上
// 恰好够用，但在更慢的 CI runner 上可能只走完一两级——于是断言看到的是「还没加载」，
// 测试随机失败。这里改成轮询到「最后一次 list 调用之后又有一次 flush」，上限 2s。
async function flushUntil(condition, label, { timeoutMs = 2000, stepMs = 5 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, stepMs)); });
  }
  // 超时不直接抛：让调用方的断言给出更有信息量的失败（它会打印实际调用序列）。
  throw new Error(`等待条件超时（${label}，${timeoutMs}ms）`);
}

async function mountVisible() {
  let tree = null;
  await settle(async () => {
    await act(async () => {
      tree = TestRenderer.create(React.createElement(FilesPanel, { visible: true }));
    });
  }, 'mount');
  // 等到挂载 effect 真的拉过一次列表（这比「flush 一次」可靠）。
  await flushUntil(() => storeCalls.list.length > 0, 'mount-list');
  return tree;
}

test.beforeEach(() => {
  // 桩模块是 ESM 单例，直接改它自己的字段（上面的 calls 只是只读视图）。
  storeCalls.list.length = 0;
  storeCalls.createStore = 0;
  settingsCalls.getSettings = 0;
  settingsCalls.patch = 0;
});

test('回归：点一次目录就进入该层，不会被踢回根层', async () => {
  const tree = await mountVisible();
  const root = tree.root;

  // 初始在根层
  assert.deepEqual(calls.list[0], { subdir: '', depth: 1 }, '首次加载应为根层单层');

  // 点 repos/ → 应进入 repos/
  await settle(async () => { await act(async () => { pressByText(root, 'repos').props.onPress(); }); }, 'click-repos');
  await flushUntil(() => calls.list.some(item => item.subdir === 'repos/'), 'repos-list');

  const afterRepos = calls.list.map(item => item.subdir);
  assert.ok(afterRepos.includes('repos/'), `点 repos 后应请求 repos/ 层，实际调用序列：${JSON.stringify(afterRepos)}`);

  // 关键断言：下钻后**不得**再出现一次 subdir=='' 的加载（那正是被踢回根层的痕迹）
  const tail = calls.list.slice(1);
  assert.equal(
    tail.some(item => item.subdir === ''),
    false,
    `点 repos 后不得回落到根层加载，实际调用序列：${JSON.stringify(tail)}`
  );

  // 再点 pppxxxy → 应进入 repos/pppxxxy/
  // ⚠️ 必须清**桩自己的** list（storeCalls），不是只读视图 calls.list——
  // 给只读 getter 赋值在严格模式下会抛 TypeError，在不同 Node 版本上报错时机可能不同。
  storeCalls.list.length = 0;
  await settle(async () => { await act(async () => { pressByText(root, 'pppxxxy').props.onPress(); }); }, 'click-pppxxxy');
  await flushUntil(() => calls.list.some(item => item.subdir === 'repos/pppxxxy/'), 'pppxxxy-list');

  assert.ok(
    calls.list.some(item => item.subdir === 'repos/pppxxxy/'),
    `点 pppxxxy 后应请求 repos/pppxxxy/ 层，实际：${JSON.stringify(calls.list.map(i => i.subdir))}`
  );
  // 同样不得回落到根层
  assert.equal(
    calls.list.some(item => item.subdir === ''),
    false,
    '下钻 pppxxxy 不得触发根层重载（被踢回根层的痕迹）'
  );
  tree.unmount();
});

test('回归：下钻期间初始化只跑一次（不重复 getWorkspaceSettings / createWorkspaceStore）', async () => {
  const tree = await mountVisible();
  const root = tree.root;
  const settingsAfterMount = calls.getSettings;
  const storeAfterMount = calls.createStore;
  assert.equal(settingsAfterMount, 1, '挂载时解析一次设置');

  // 连续下钻两层（每层都等到列表真的回来再点下一次）
  await settle(async () => { await act(async () => { pressByText(root, 'repos').props.onPress(); }); }, 'click-repos');
  await flushUntil(() => calls.list.some(item => item.subdir === 'repos/'), 'repos-list');
  await settle(async () => { await act(async () => { pressByText(root, 'pppxxxy').props.onPress(); }); }, 'click-pppxxxy');
  await flushUntil(() => calls.list.some(item => item.subdir === 'repos/pppxxxy/'), 'pppxxxy-list');

  assert.equal(
    calls.getSettings,
    settingsAfterMount,
    '下钻不该重新解析工作区设置（原 bug 每层都重跑一次）'
  );
  assert.equal(
    calls.createStore,
    storeAfterMount,
    '下钻不该重建 store（原 bug 每层都重建）'
  );
  tree.unmount();
});

test('有意设计不回归：面板关闭再打开回到根层', async () => {
  const tree = await mountVisible();

  // 先下钻到深目录
  await settle(async () => { await act(async () => { pressByText(tree.root, 'repos').props.onPress(); }); }, 'drill');
  await flushUntil(() => calls.list.some(item => item.subdir === 'repos/'), 'drill-list');
  const drilled = calls.list.map(item => item.subdir);
  assert.ok(drilled.includes('repos/'), `前置：应已下钻到 repos/，实际：${JSON.stringify(drilled)}`);

  // 关闭
  await settle(async () => {
    await act(async () => {
      tree.update(React.createElement(FilesPanel, { visible: false }));
    });
  }, 'close');

  // 重新打开：应重新初始化并加载根层
  storeCalls.list.length = 0;
  await settle(async () => {
    await act(async () => {
      tree.update(React.createElement(FilesPanel, { visible: true }));
    });
  }, 'reopen');
  await flushUntil(() => calls.list.length > 0, 'reopen-list');

  assert.ok(
    calls.list.some(item => item.subdir === ''),
    `重开面板应加载根层，实际：${JSON.stringify(calls.list.map(i => i.subdir))}`
  );
  assert.equal(calls.getSettings, 2, '重开面板应重新解析设置（有意设计：每次打开初始化一次）');
  tree.unmount();
});
