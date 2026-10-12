// 插件加载与运行时装配——差距 #2 的「加载 / 安装 / 装配」层。
//
// 数据流：`.easychat/plugins.json`（一个 JSON：{ version, plugins: [manifest] }）
//   → loadPluginsFromText（纯解析）
//   → buildPluginRuntime（纯装配：槽位进 registry、工具进 agent 定义、钩子透传）
//   → 渲染层按 kind 取槽位贡献；agent 侧按工具名执行（走 sandbox.js）。
//
// 存储用**单文件**（pluginsMax × handlerMax ≈ 240KB 上界），跨不过 AsyncStorage 单值上限；
// 且它不是高频增长集合（插件数上限 12），与「消息/角色」那种分键场景不同。
//
// IO 走注入的 store（list/read/write 接口），核心解析/装配是纯函数、可 Node 直测。

import { normalizeManifest, validateManifest, PLUGIN_MANIFEST_VERSION } from './manifest.js';
import { createSlotRegistry } from './registry.js';
import { runInSandbox } from './sandbox.js';
import { safeJsonStringify } from '../../utils/safeJson.js';

export const PLUGINS_FILE = '.easychat/plugins.json';
export const PLUGINS_FILE_VERSION = 1;
export const PLUGIN_INSTALL_MAX = 12;

// 纯：把落盘文本解析成插件数组（损坏/空 → []）。
export function loadPluginsFromText(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return [];
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (error) { return []; }
  const list = parsed && Array.isArray(parsed.plugins) ? parsed.plugins : [];
  return list.map(normalizeManifest).filter(item => item.id);
}

// 纯：插件数组 → 落盘文本。
export function serializePlugins(plugins) {
  const list = (Array.isArray(plugins) ? plugins : []).map(normalizeManifest).filter(item => item.id);
  return JSON.stringify({ version: PLUGINS_FILE_VERSION, updatedAt: Date.now(), plugins: list }, null, 2);
}

// 纯：装配运行时。capabilities 是宿主提供的 { read, write, search, notify }（可空）。
// 返回 { registry, tools, hooks, pluginIds }：
//   registry —— 槽位注册表（渲染层用 render(kind) 取贡献）；
//   tools    —— agent 工具定义数组（execute 走沙盒）；
//   hooks    —— { [event]: [...] } 透传给 hooks 事件面；
//   pluginIds—— 已装配插件 id 列表。
export function buildPluginRuntime(plugins, { capabilities = {}, source = 'extension' } = {}) {
  const registry = createSlotRegistry();
  const tools = [];
  const hooks = {};
  const pluginIds = [];
  for (const plugin of (Array.isArray(plugins) ? plugins : [])) {
    const manifest = normalizeManifest(plugin);
    if (!manifest.id) continue;
    pluginIds.push(manifest.id);
    for (const slot of manifest.slots) {
      registry.add({ kind: slot.kind, id: `${manifest.id}:${slot.id || slot.label || slot.kind}`, source, contribution: slot });
    }
    // 插件工具**只装配、不自动注册进 agent 工具表**（2026-10-11 决策）：沙盒是「能力受限」
    // 而非安全沙盒（见 sandbox.js 文件头），从文件自动注册可执行代码风险高。要启用需宿主
    // 显式把这些定义 registerTool 进去（目前无调用者）——面板据此如实标注「尚未接入 agent」。
    for (const tool of manifest.tools) {
      const toolName = `plugin_${manifest.id}_${tool.name}`.replace(/[^A-Za-z0-9_]/g, '_');
      tools.push({
        name: toolName,
        description: tool.description || `插件 ${manifest.name} 的工具 ${tool.name}`,
        parameters: tool.parameters,
        readOnly: tool.readOnly === true,
        execute: async (args) => {
          const outcome = await runInSandbox(tool.handler, {
            args: args || {},
            permissions: manifest.permissions,
            capabilities,
          });
          const logs = outcome.logs && outcome.logs.length ? `\n[插件日志]\n${outcome.logs.join('\n')}` : '';
          if (!outcome.ok) return { content: `插件执行失败：${outcome.error}${logs}`, isError: true };
          const value = outcome.value;
          const text = typeof value === 'string' ? value : safeJsonStringify(value);
          return `${text || '（插件无输出）'}${logs}`;
        },
      });
    }
    for (const [event, list] of Object.entries(manifest.hooks || {})) {
      if (!Array.isArray(list)) continue;
      hooks[event] = (hooks[event] || []).concat(list);
    }
  }
  return { registry, tools, hooks, pluginIds };
}

async function readPluginsText(store, characterId) {
  try {
    const result = await store.readWorkspaceFile({ characterId, path: PLUGINS_FILE });
    return String((result && result.content) || '');
  } catch (error) {
    return '';
  }
}

// 读并装配（宿主调用）。store 缺 list/read/write 时降级为空运行时。
export async function loadPluginRuntime({ store, characterId, capabilities = {} } = {}) {
  if (!store || typeof store.readWorkspaceFile !== 'function') {
    return { ...buildPluginRuntime([], { capabilities }), plugins: [] };
  }
  const plugins = loadPluginsFromText(await readPluginsText(store, characterId));
  return { ...buildPluginRuntime(plugins, { capabilities }), plugins };
}

// 安装一个插件（幂等：同 id 覆盖）。返回 { ok, error?, plugins }。
export async function installPlugin({ store, characterId, manifest } = {}) {
  const check = validateManifest(manifest);
  if (!check.ok) return { ok: false, error: check.errors.join('；'), plugins: [] };
  const normalized = normalizeManifest(manifest);
  const existing = loadPluginsFromText(await readPluginsText(store, characterId));
  if (!existing.some(item => item.id === normalized.id) && existing.length >= PLUGIN_INSTALL_MAX) {
    return { ok: false, error: `插件数已达上限 ${PLUGIN_INSTALL_MAX}`, plugins: existing };
  }
  const next = existing.filter(item => item.id !== normalized.id).concat(normalized);
  try {
    await store.writeWorkspaceFile({ characterId, path: PLUGINS_FILE, content: serializePlugins(next) });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error), plugins: existing };
  }
  return { ok: true, plugins: next };
}

// 卸载一个插件。返回 { ok, plugins }。
export async function uninstallPlugin({ store, characterId, id } = {}) {
  const key = String(id == null ? '' : id).trim().toLowerCase();
  const existing = loadPluginsFromText(await readPluginsText(store, characterId));
  const next = existing.filter(item => item.id !== key);
  if (next.length === existing.length) return { ok: false, error: '插件未安装', plugins: existing };
  try {
    await store.writeWorkspaceFile({ characterId, path: PLUGINS_FILE, content: serializePlugins(next) });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error), plugins: existing };
  }
  return { ok: true, plugins: next };
}

export { PLUGIN_MANIFEST_VERSION };
