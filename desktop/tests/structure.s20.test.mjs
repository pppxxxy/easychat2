// 桌面外壳结构守卫（S20）：四项「不可移植」的逐项复核结论。
//
// 前四轮反复出现「旧结论过期」：OCR、看屏幕、语音播报、语音转写。这一轮把剩下
// 四项按同一标准重查，结论**不是全都可移植**——两条可移植、一条属于排除范围、
// 一条确实不可移植。守卫的价值在于把「为什么」钉成可执行断言，避免下次又凭
// 一句旧注释下结论。
//
//   1. scheduledTasks → 定时 Agent 任务（带工具循环）⇒ 属于排除范围；
//      但**自动备份的定时**与**主动消息的定时**是可移植的，已上移到应用根。
//   2. plugins → 内置插件（联网搜索）是纯 HTTP ⇒ 可移植，已做配置页；
//      不可移植的只有「插件运行时」（外部 JS + 原生界面注入）。
//   3. localModels → llama.rn 原生推理绑定 ⇒ 确实不可移植。
//   4. workspaceTools → 核心是 runAgentTurn 的交互外壳 ⇒ 属于排除范围。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const ROOT = path.resolve(DESKTOP, '..');
const read = (...parts) => readFileSync(path.join(...parts), 'utf8');
const readRoot = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');

const BACKDROP = read('src', 'provider', 'useDesktopBackgroundTasks.js');
const SHELL = read('src', 'provider', 'DesktopApp.jsx');
const PROACTIVE = read('src', 'extension', 'screens', 'ProactiveScreen.jsx');
const SCHEDULER = read('src', 'settings', 'useDesktopAutoBackupScheduler.js');
const DEPS = read('src', 'settings', 'desktopAutoBackupDeps.js');
const PLUGIN_SCREEN = read('src', 'extension', 'screens', 'PluginScreen.jsx');
const REASONS = read('src', 'extension', 'unsupportedReasons.js');
const ROUTES = read('src', 'extension', 'extensionRoutes.js');
const EXT_SCREEN = read('src', 'extension', 'ExtensionScreen.jsx');

test('定时任务：到点调度挂在应用根，不再依赖用户打开某个页面', () => {
  // 手机侧两套调度都在 App 启动时装好。桌面此前把主动消息写在 ProactiveScreen 里，
  // 关掉页面就停——那是真实功能差距。
  assert.ok(SHELL.includes('useDesktopBackgroundTasks'), '应用根未挂后台任务');
  assert.ok(!PROACTIVE.includes('useProactiveForeground'), '主动消息不应仍在页面内调度');
  assert.ok(BACKDROP.includes('useProactiveForeground'), '根上应调度主动消息');
  assert.ok(BACKDROP.includes('useDesktopAutoBackupScheduler'), '根上应调度自动备份');
  // 首启门禁没过时不该开始轮询（否则免责声明还没同意就在后台跑）。
  assert.ok(/ready: loaded && firstRunStage === 'done'/.test(SHELL), '应等首启门禁完成');
});

test('自动备份调度：语义与手机一致（延迟启动 / 隐藏跑退出备份 / 停表）', () => {
  assert.ok(SCHEDULER.includes('visibilitychange'), '桌面应改用 visibilitychange');
  assert.ok(SCHEDULER.includes('runAutoBackupIfDue'), '缺到期执行');
  assert.ok(SCHEDULER.includes('runAutoBackupOnExit'), '缺退出备份');
  // 启动后不立刻备份：手机端真机教训（一打开就压重活、体感发烫）。
  assert.ok(/scheduleDue\(\)/.test(SCHEDULER), '缺延迟启动');
  assert.ok(/busy/.test(SCHEDULER), '缺重入保护');
  // 常量必须从零依赖叶子取：autoBackupScheduler.js import 了 react-native。
  assert.ok(SCHEDULER.includes('autoBackupPolicy.js'), '常量应来自零依赖叶子');
  assert.ok(!/from '.*autoBackupScheduler\.js'/.test(SCHEDULER),
    '不得从 import 了 react-native 的模块取常量（Node 测试会语法报错）');
});

test('备份依赖装配只有一份（卡片与调度器共用，避免漂移）', () => {
  assert.ok(DEPS.includes('createAutoBackupDeps'), '缺装配');
  assert.ok(DEPS.includes('nextFs: null'), '桌面无 FileHandle 后端');
  assert.ok(DEPS.includes('adapter: null'), '桌面无 SAF 适配器');
});

test('插件：内置搜索是纯 HTTP（可移植），不可移植的只有插件运行时', () => {
  // 证据：共享层 plugins/*.js 不得引入原生依赖。
  for (const file of ['webSearch.js', 'webFetch.js', 'providers.js', 'registry.js']) {
    const source = readRoot('src', 'plugins', file);
    // 只看 import/require 语句：这些文件里有注释**提到** react-native（说明为何不用它）。
    const imports = source
      .split('\n')
      .filter(line => /^\s*(import|const .*=\s*require\()/.test(line))
      .join('\n');
    assert.ok(!/react-native|NativeModules|expo-/.test(imports), `${file} 不应 import 原生依赖`);
  }
  assert.ok(PLUGIN_SCREEN.includes('getPlugins'), '插件页应复用共享存储');
  assert.ok(PLUGIN_SCREEN.includes('savePlugins'), '插件页应复用共享写入');
  assert.ok(PLUGIN_SCREEN.includes('missingRequiredFields'), '启用前应做必填校验');
  assert.ok(ROUTES.includes('plugins: PluginScreen'), '路由表缺插件页');
  assert.ok(EXT_SCREEN.includes("id: 'plugins'"), '扩展页缺插件入口');
  // 不可用清单里必须是 pluginRuntime（子能力），不是整项 plugins。
  assert.ok(REASONS.includes('pluginRuntime:'), '缺插件运行时的原因条目');
  assert.ok(!/^\s*plugins: '/m.test(REASONS), 'plugins 不应再整体列为不可用');
});

test('本地模型：确实不可移植（llama.rn 原生绑定 + 原生 API server）', () => {
  const adapter = readRoot('src', 'localModel', 'adapter.js');
  assert.ok(/require\('llama\.rn'\)/.test(adapter), '本地模型依赖 llama.rn 原生绑定');
  const server = readRoot('src', 'localModel', 'localApiServer.js');
  assert.ok(/NativeModules/.test(server), 'API server 依赖 Android 原生模块');
  // 结论要留痕：不可用清单仍含 localModels。
  assert.ok(/^\s*localModels: '/m.test(REASONS), 'localModels 应仍列为不可用');
});

test('工作区工具：核心是 agent 交互外壳（属于排除范围，不是遗漏）', () => {
  const chat = readRoot('src', 'workspace', 'screen', 'ChatPanel.js');
  assert.ok(chat.includes('runAgentTurn'), '工作区主界面由 agent 驱动');
  const native = readRoot('src', 'workspace', 'native.js');
  assert.ok(/isShellAvailable|createShellRunner/.test(native), '工作区接线依赖原生 shell');
  // 结论留痕：仍列为不可用，且文案要说明是 agent 工具域而非「懒得做」。
  assert.ok(/^\s*workspaceTools: '/m.test(REASONS), 'workspaceTools 应仍列为不可用');
});