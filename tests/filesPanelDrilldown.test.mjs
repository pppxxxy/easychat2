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
import { fileURLToPath } from 'node:url';
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
const workspaceStoreStubUrl = new URL(`file:///${path.join(HELPER_DIR, 'workspace-store-stub.mjs').replace(/\\/g, '/')}`).href;
const nativeStoreStubUrl = new URL(`file:///${path.join(HELPER_DIR, 'workspace-native-stub.mjs').replace(/\\/g, '/')}`).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    try {
      const resolvedPath = fileURLToPath(resolved.url);
      if (resolvedPath === WORKSPACE_STORE_STUB) {
        return { url: workspaceStoreStubUrl, shortCircuit: true };
      }
      if (resolvedPath === NATIVE_STUB_TARGET) {
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

async function mountVisible() {
  let tree = null;
  await settle(async () => {
    await act(async () => {
      tree = TestRenderer.create(React.createElement(FilesPanel, { visible: true }));
    });
  }, 'mount');
  await settle(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }, 'mount-settle');
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
  await act(async () => { pressByText(root, 'repos').props.onPress(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

  const afterRepos = calls.list.map(item => item.subdir);
  assert.ok(afterRepos.includes('repos/'), `点 repos 后应请求 repos/ 层，实际调用序列：${JSON.stringify(afterRepos)}`);

  // 关键断言：下钻后**不得**再出现一次 subdir=='' 的加载（那正是被踢回根层的痕迹）
  const listCallsAfterFirstClick = calls.list.length;
  const tail = calls.list.slice(1);
  assert.equal(
    tail.some(item => item.subdir === ''),
    false,
    `点 repos 后不得回落到根层加载，实际调用序列：${JSON.stringify(tail)}`
  );

  // 再点 pppxxxy → 应进入 repos/pppxxxy/
  calls.list.length = 0;
  await act(async () => { pressByText(root, 'pppxxxy').props.onPress(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

  assert.ok(
    calls.list.some(item => item.subdir === 'repos/pppxxxy/'),
    `点 pppxxxy 后应请求 repos/pppxxxy/ 层，实际：${JSON.stringify(calls.list.map(i => i.subdir))}`
  );
  // 同样不得回落到根或上一层的空加载
  assert.equal(
    calls.list.some(item => item.subdir === ''),
    false,
    '下钻 pppxxxy 不得触发根层重载（被踢回根层的痕迹）'
  );
  assert.ok(listCallsAfterFirstClick > 0);
  tree.unmount();
});

test('回归：下钻期间初始化只跑一次（不重复 getWorkspaceSettings / createWorkspaceStore）', async () => {
  const tree = await mountVisible();
  const root = tree.root;
  const settingsAfterMount = calls.getSettings;
  const storeAfterMount = calls.createStore;
  assert.equal(settingsAfterMount, 1, '挂载时解析一次设置');

  // 连续下钻两层
  await act(async () => { pressByText(root, 'repos').props.onPress(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => { pressByText(root, 'pppxxxy').props.onPress(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

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
  let tree = null;
  await settle(async () => {
    await act(async () => {
      tree = TestRenderer.create(React.createElement(FilesPanel, { visible: true }));
    });
  }, 'mount');
  await settle(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }, 'mount-settle');

  // 先下钻到深目录
  await settle(async () => { await act(async () => { pressByText(tree.root, 'repos').props.onPress(); }); }, 'drill');
  await settle(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }, 'drill-settle');
  const drilled = calls.list.map(item => item.subdir);
  assert.ok(drilled.includes('repos/'), `前置：应已下钻到 repos/，实际：${JSON.stringify(drilled)}`);

  // 关闭
  await settle(async () => {
    await act(async () => {
      tree.update(React.createElement(FilesPanel, { visible: false }));
    });
  }, 'close');
  await settle(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }, 'close-settle');

  // 重新打开：应重新初始化并加载根层
  storeCalls.list.length = 0;
  await settle(async () => {
    await act(async () => {
      tree.update(React.createElement(FilesPanel, { visible: true }));
    });
  }, 'reopen');
  await settle(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }, 'reopen-settle');

  assert.ok(
    calls.list.some(item => item.subdir === ''),
    `重开面板应加载根层，实际：${JSON.stringify(calls.list.map(i => i.subdir))}`
  );
  assert.equal(calls.getSettings, 2, '重开面板应重新解析设置（有意设计：每次打开初始化一次）');
  tree.unmount();
});
