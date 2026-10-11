// 插件化运行时（差距 #2）——barrel。
//
// 目标：让「扩展能力」与「扩展界面」成为同一个可分发单元。四个纯模块 + 一个装配层：
//   manifest.js —— 清单 schema / 校验 / 归一（数据契约）
//   registry.js —— UI 槽位注册表（可注册 UI 的最小内核）
//   sandbox.js  —— 能力受限的插件执行（诚实边界见该文件头）
//   market.js   —— 内置插件市场目录
//   loader.js   —— 加载 / 安装 / 装配（IO 走注入 store）
//
// 落盘：`.easychat/plugins.json`。渲染层按 slot kind 取贡献（screen/PluginSlot.js）。

export {
  PLUGIN_MANIFEST_VERSION,
  SLOT_KINDS,
  PLUGIN_PERMISSIONS,
  PLUGIN_CATEGORIES,
  DEFAULT_PLUGIN_CATEGORY,
  PLUGIN_LIMITS,
  normalizePluginId,
  normalizeManifest,
  normalizePluginCategory,
  inferPluginCategory,
  groupPluginsByCategory,
  validateManifest,
} from './manifest.js';
export { SLOT_PRIORITY, priorityOf, createSlotRegistry } from './registry.js';
export {
  SANDBOX_DEFAULT_TIMEOUT_MS,
  SANDBOX_LOG_MAX,
  createCapabilityContext,
  compileHandler,
  runInSandbox,
} from './sandbox.js';
export { PLUGIN_MARKET, listMarket, findMarketPlugin } from './market.js';
export {
  PLUGINS_FILE,
  PLUGINS_FILE_VERSION,
  PLUGIN_INSTALL_MAX,
  loadPluginsFromText,
  serializePlugins,
  buildPluginRuntime,
  loadPluginRuntime,
  installPlugin,
  uninstallPlugin,
} from './loader.js';
