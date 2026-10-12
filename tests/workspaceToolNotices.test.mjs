// 工具结果的「双受众提示」契约（toolDefs/toolNotices.js）。
//
// 背景（2026-10-12）：toolDefs 里有三条**指示用户去操作**的提示——git 仓库未就绪、
// 写子代理被只读模式拦下、工作流含 write 步骤被整条拒绝。它们同时面向两个读者：
//   · 模型：工具结果就是它的下一步依据；
//   · 用户：工作区工具行（conversation.js → ToolCallRow）把 result.content 直接显示。
// 修法是「模型侧留中文 + 界面侧走词条」，本文件把这个拆分钉成契约：
//
// 1. **模型侧中文逐字不许变**（仓库铁律：翻译会改变模型读到的内容）。这里用
//    逐字断言而不是 /正则/ —— 正则挡不住「顺手把句子润色一下」，而润色就是改模型行为。
// 2. **公共半句只有一份**：run_subagent 与 run_workflow 的「写操作需要用户切到…」
//    必须来自同一个常量（结构上不可能漂移）。
// 3. **界面侧 key 在两种语言里都有值**，且工具结果确实带上了 noticeKey（展示层取用）。
// 4. **展示层接线（4 跳全通）**：工具定义 → registry → loop 的 tool 消息 → toolTrace →
//    conversation 的 row.tool → ToolCallRow。只做前几跳而没接最后一跳，英文界面照样读中文。
//
// 走 loadModule 图：工具定义内部静态引用 network/api.js（网络层），Node 下必须打桩。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { createRequire } from 'node:module';

import { translate } from '../src/i18n/index.js';

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

// i18n 打桩只给 tActive：与其它测试（subagentWriteGate / chatTools / workspaceChats）同形。
// 打桩让 tActive 返回 key 本身，正好也覆盖了「词条取不到时不许把 key 显示给用户」的回落路径。
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request.endsWith('/i18n/index.js') || request.endsWith('/i18n/index')) {
    return { __esModule: true, tActive: key => String(key) };
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

const notices = loadModule(path.resolve('src/workspace/toolDefs/toolNotices.js'));
const { SUBAGENT_TOOL_DEFINITION } = loadModule(path.resolve('src/workspace/toolDefs/subagentTool.js'));
const { WORKFLOW_TOOL_DEFINITION } = loadModule(path.resolve('src/workspace/toolDefs/workflowTool.js'));
const { GIT_STATUS_TOOL_DEFINITION } = loadModule(path.resolve('src/workspace/toolDefs/gitTools.js'));

// ---- 1. 模型侧中文：逐字冻结 ----

const MODEL_TEXTS = {
  noRepo: '本地版本控制还没就绪：这个工作区还没有 git 仓库。请在「工作区 → 设置」里打开「本地版本控制」开关（会初始化仓库），然后再试。',
  subagent: '写子代理不可用：当前是只读模式，写操作需要用户切到「可改」模式（未执行）。',
  workflow: '工作流无法执行：步骤 write-step 要求 write 模式，但当前是只读模式，写操作需要用户切到「可改」模式（未执行）。',
};

test('模型侧三条文案逐字冻结（翻译它们会改变模型读到的内容）', () => {
  assert.equal(notices.GIT_NO_REPO_TEXT, MODEL_TEXTS.noRepo);
  assert.equal(notices.SUBAGENT_WRITE_BLOCKED_TEXT, MODEL_TEXTS.subagent);
  assert.equal(notices.workflowWriteBlockedText(['write-step']), MODEL_TEXTS.workflow);
  // 多步时用「、」连接（与既有行为一致）
  assert.match(notices.workflowWriteBlockedText(['a', 'b']), /步骤 a、b 要求 write 模式/);
});

test('公共半句只有一份：两条文案各自恰好含一次 MODE_SWITCH_HINT', () => {
  const count = (haystack, needle) => haystack.split(needle).length - 1;
  assert.equal(notices.MODE_SWITCH_HINT, '写操作需要用户切到「可改」模式（未执行）。');
  assert.equal(count(notices.SUBAGENT_WRITE_BLOCKED_TEXT, notices.MODE_SWITCH_HINT), 1);
  assert.equal(count(notices.workflowWriteBlockedText(['x']), notices.MODE_SWITCH_HINT), 1);
  // 反例保护：把公共半句从任一条里删掉，上面两条断言就会失败——这正是「漂移」的形态。
  assert.equal(count(notices.SUBAGENT_WRITE_BLOCKED_TEXT, notices.READ_ONLY_CLAUSE), 1);
});

// ---- 2. 界面侧词条：两种语言都有真实值 ----

test('界面侧词条在 zh-CN 与 en 都有非 key 的值', () => {
  for (const key of Object.values(notices.TOOL_NOTICE_KEYS)) {
    for (const locale of ['zh-CN', 'en']) {
      const value = translate(locale, key);
      assert.notEqual(value, key, `${locale} 缺少词条 ${key}`);
      assert.ok(value.length > 0);
    }
  }
  // 工作流的界面侧文案带步骤参数（与模型侧同源），占位符必须在
  const workflowText = translate('en', notices.TOOL_NOTICE_KEYS.workflowWriteBlocked, { steps: 'a、b' });
  assert.match(workflowText, /a、b/);
});

// ---- 3. 工具结果：正文给模型，noticeKey 给界面 ----

test('git_status：仓库未就位时正文是中文（模型侧），并带上界面侧 noticeKey', async () => {
  // runner 在、但仓库还没建（设置里开关还没打开时就是这形态）。
  const git = { open: () => ({ isRepo: async () => false }) };
  const result = await GIT_STATUS_TOOL_DEFINITION.execute({ git }, { characterId: 'ch' });
  assert.equal(result.isError, true);
  assert.equal(result.content, MODEL_TEXTS.noRepo, '模型读到的正文不得改变');
  assert.equal(result.noticeKey, notices.TOOL_NOTICE_KEYS.gitNoRepo, '界面侧 key 必须随结果带出');
});

test('run_subagent：只读模式下拒绝写子代理——正文不变 + noticeKey', async () => {
  const result = await SUBAGENT_TOOL_DEFINITION.execute(
    { store: {} },
    { task: '写点东西', mode: 'write' },
    { workspaceMode: 'read', characterId: 'ch' },
  );
  assert.equal(result.isError, true);
  assert.equal(result.content, MODEL_TEXTS.subagent);
  assert.equal(result.noticeKey, notices.TOOL_NOTICE_KEYS.subagentWriteBlocked);
});

test('run_workflow：只读模式下含 write 步骤被整条拒绝——正文不变 + noticeKey/参数', async () => {
  const result = await WORKFLOW_TOOL_DEFINITION.execute(
    { store: {} },
    { steps: [{ id: 'write-step', task: '写文件', mode: 'write' }] },
    { workspaceMode: 'read', characterId: 'ch' },
  );
  assert.equal(result.isError, true);
  assert.equal(result.content, MODEL_TEXTS.workflow);
  assert.equal(result.noticeKey, notices.TOOL_NOTICE_KEYS.workflowWriteBlocked);
  assert.equal(result.noticeParams.steps, 'write-step', '界面侧要点名是哪一步（与正文同源）');
});

// ---- 4. 词条取值：界面侧中文有意用第二人称 ----

test('界面侧中文对用户说话（「你」），模型侧中文对模型说话（「用户」）', () => {
  const ui = translate('zh-CN', notices.TOOL_NOTICE_KEYS.subagentWriteBlocked);
  assert.match(ui, /你切到「可改」模式/, '界面文案是直接对用户讲的');
  assert.match(MODEL_TEXTS.subagent, /用户切到「可改」模式/, '模型侧保持第三人称');
});

// ---- 5. 本批新增词条的自检：key 格式 + 中英都有值 ----
//
// 为什么放在这里而不是靠 tests/i18n.test.mjs：那边只报「词条表里有一个不合规的 key」，
// 定位到「哪一批加的」还得靠人翻。这里把本批新增/引用的 key 全部列出来逐个校验，
// 新增词条时漏写英文（或 key 写成驼峰/连字符）当场就红。
test('本批新增词条：key 格式合规，且中英都有值', () => {
  // 与 tests/i18n.test.mjs 同一口径（首段小写、后续段只允许字母数字）。
  const KEY_RE = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;
  const mine = [
    ...Object.values(notices.TOOL_NOTICE_KEYS),
    loadModule(path.resolve('src/workspace/gitCheckpoint.js')).CHECKPOINT_FALLBACK_KEY,
    loadModule(path.resolve('src/chat/toolTrace.js')).TRACE_TRUNCATE_MARK_KEY,
    loadModule(path.resolve('src/chat/chatHelpers.js')).SCRUBBER_TIME_KEY,
  ];
  // SearchScreen 的引用直接从未源文件里抽（它没有导出 key 常量，字面量就是契约）。
  const searchScreen = fs.readFileSync(path.resolve('src/SearchScreen.js'), 'utf8');
  for (const match of searchScreen.matchAll(/\bt\(\s*'([^']+)'/g)) mine.push(match[1]);
  assert.ok(mine.length >= 17, `应覆盖本批全部新增词条，实际 ${mine.length} 个`);
  for (const key of mine) {
    assert.match(key, KEY_RE, `key 格式不规范：${key}`);
    for (const locale of ['zh-CN', 'en']) {
      assert.notEqual(translate(locale, key), key, `${locale} 缺少词条 ${key}`);
    }
  }
});

// ---- 6. 展示层接线（4 跳全通）：ToolCallRow 优先词条、取不到才回落中文正文 ----
//
// 组件含 RN 依赖（react-native 在 Node 下加载不了），本仓无 React 渲染器，按既有约定用
// **源码锚点**（同 tests/chatA11y.test.mjs 对同一文件的做法）。断言刻意只钉「优先级」这条
// 关系，不钉具体写法：取词函数本身的行为由 tests/workspaceConversation.test.mjs 的
// toolNoticeText 用例真断言（中英各一次 + 无 key 回落）。
test('展示层接线：ToolCallRow 用共享取词函数，词条优先、取不到回落中文正文', () => {
  const row = fs.readFileSync(path.resolve('src/workspace/screen/ToolCallRow.js'), 'utf8');
  // 取词逻辑只有一份（行投影层，Node 直测），组件不许另写一份中文→key 的匹配
  assert.match(row, /import\s*\{[^}]*toolNoticeText[^}]*\}\s*from\s*'\.\.\/conversation\.js'/, '复用 toolNoticeText');
  assert.match(row, /toolNoticeText\(tool,\s*t\)/, '用 I18nContext 的 t（沿用组件既有注入方式）');
  // 词条优先、正文兜底：老轨迹没有 noticeKey 时显示的就是中文正文（回落分支不可省）
  assert.match(row, /notice\s*\|\|\s*tool\.resultText/, '词条优先，取不到回落中文正文');
  assert.match(row, /notice\s*\|\|\s*tool\.resultPreview/, '词条优先，取不到回落中文预览');
  // 这次接线只换「显示哪段字」：错误态/成功态的既有区分必须原样还在
  assert.match(row, /if\s*\(tool\.status !== 'ok'\)\s*return null/, '失败态不画改动的分支不得被改动');
});
