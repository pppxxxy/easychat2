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
import { tActive } from '../../i18n/index.js';
import { safeJsonStringify } from '../../utils/safeJson.js';

export const PLUGINS_FILE = '.easychat/plugins.json';
export const PLUGINS_FILE_VERSION = 1;
export const PLUGIN_INSTALL_MAX = 12;

// 纯：把落盘文本解析成 { status, plugins, reason? }。status 两态：
//   ok      —— 解析出了 { plugins: [...] }（空文件 / 空清单也算 ok，等价于「还没装任何插件」）；
//   corrupt —— 文件在、但内容坏了：不是合法 JSON、顶层不是对象、或 plugins 不是数组。
// 为什么「坏」要单独标出来（而不是照旧当空）：坏是**永久态**。
//   · 当空处理 → 面板显示「还没有安装任何插件」，用户既不知道清单坏了，也不知道下一次
//     安装会把旧内容顶掉（静默丢失）；
//   · 像读失败那样直接拒绝写入 → 用户**再也装不上任何插件**（面板没有别的修复入口）。
// 所以这里如实标出坏，由面板给一个**显式**的「重置插件清单」出路。
export function parsePluginsText(text) {
  const raw = String(text == null ? '' : text);
  if (!raw.trim()) return { status: 'ok', plugins: [] };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (error) { return { status: 'corrupt', plugins: [], reason: 'invalidJson' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'corrupt', plugins: [], reason: 'notObject' };
  }
  if (!Array.isArray(parsed.plugins)) return { status: 'corrupt', plugins: [], reason: 'noPluginsArray' };
  return { status: 'ok', plugins: parsed.plugins.map(normalizeManifest).filter(item => item.id) };
}

// 兼容入口：只要插件数组（旧调用方与测试）。损坏与空都返回 []，需要区分时用 parsePluginsText。
export function loadPluginsFromText(text) {
  return parsePluginsText(text).plugins;
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

// 「文件不存在」与「读失败」的判据：workspace 两个后端在文件不存在时抛的都是同一条
// i18n 文案 error.workspace.fileNotFound（store.js:120、safStore.js:178/180），
// 底层文件系统直接冒上来的 ENOENT 同义（code 约定见 workspace/gitFs.js:45-46）。
// 其余异常（权限、SAF、底层 IO）才是「读失败」。
function isWorkspaceFileMissing(error) {
  if (!error) return false;
  if (error.code === 'ENOENT') return true;
  const message = String(error.message || '');
  if (!message) return false;
  // 裸 `new Error('ENOENT')`（Node/RN 底层与测试桩的常见形态）：只有 message、没有 code，
  // 上面那条拿不到。不认它会把「首次安装」误判成读失败，installPlugin 于是拒绝写入 ——
  // 表现是「装了插件却什么都没落盘」，且没有任何报错。故 message 也要认。
  if (message.includes('ENOENT')) return true;
  return message === tActive('error.workspace.fileNotFound', { path: PLUGINS_FILE });
}

// 读插件文件的**三态**结果：
//   ok      —— 读到了（含空文件：text 为 ''，等价于「还没装任何插件」）；
//   missing —— 文件不存在（首次安装的正常态）；
//   error   —— 读失败，内容不可知。
// 为什么必须分开：以前两种失败都被吞成 ''，于是 installPlugin 的 existing=[] 会被当成
// 「用户还没装插件」，写回时把整份 plugins.json 覆盖成只含本次安装的那一个 ——
// 静默删掉用户已装的插件（先例：src/storage/worldMap.js:34-40「读失败就抛错中止：
// 绝不用空列表覆盖已有地图」）。
async function readPluginsText(store, characterId) {
  try {
    const result = await store.readWorkspaceFile({ characterId, path: PLUGINS_FILE });
    return { status: 'ok', text: String((result && result.content) || '') };
  } catch (error) {
    if (isWorkspaceFileMissing(error)) return { status: 'missing', text: '' };
    return { status: 'error', text: '', error: String((error && error.message) || error) };
  }
}

// 读并装配（宿主调用）。store 缺 list/read/write 时降级为空运行时。
export async function loadPluginRuntime({ store, characterId, capabilities = {} } = {}) {
  if (!store || typeof store.readWorkspaceFile !== 'function') {
    // 没有 store = 宿主没接插件能力，当作「一个都没装」。
    return { ...buildPluginRuntime([], { capabilities }), plugins: [], status: 'missing' };
  }
  const read = await readPluginsText(store, characterId);
  const parsed = parsePluginsText(read.text);
  const plugins = parsed.plugins;
  // status 四态：ok / missing（文件不存在，首次安装的正常态）/ error（读失败，内容不可知）/
  // corrupt（文件在、内容坏了）。后两态都必须透出去——调用方不能把它误当成「用户一个插件
  // 都没装」，否则用户既看不到问题，也不知道该修什么（见 parsePluginsText 的说明）。
  const status = read.status === 'ok' ? parsed.status : read.status;
  return {
    ...buildPluginRuntime(plugins, { capabilities }),
    plugins,
    status,
    ...(read.error ? { error: read.error } : {}),
    ...(parsed.reason ? { reason: parsed.reason } : {}),
  };
}

// 安装一个插件（幂等：同 id 覆盖）。返回 { ok, error?, plugins, rebuilt? }。
export async function installPlugin({ store, characterId, manifest } = {}) {
  const check = validateManifest(manifest);
  if (!check.ok) return { ok: false, error: check.errors.join('；'), plugins: [] };
  const normalized = normalizeManifest(manifest);
  const read = await readPluginsText(store, characterId);
  // 读失败**拒绝写入**：此时 existing 只能是 []，写回等于用「只含本次安装」覆盖整份清单。
  if (read.status === 'error') {
    return { ok: false, error: read.error || 'plugins-read-failed', plugins: [] };
  }
  const parsed = parsePluginsText(read.text);
  const existing = parsed.plugins;
  // 内容损坏：**不拒绝**——拒绝就等于把用户锁死（损坏是永久态，清单再也解析不出来，
  // 用户会永远装不上任何插件）。损坏的内容本来就解析不出来，重建是唯一的出路；但要如实
  // 告知（rebuilt），面板据此在安装成功时提示「原清单已损坏、本次已重建」，不能静默顶掉。
  const rebuilt = parsed.status === 'corrupt';
  if (!existing.some(item => item.id === normalized.id) && existing.length >= PLUGIN_INSTALL_MAX) {
    return { ok: false, error: `插件数已达上限 ${PLUGIN_INSTALL_MAX}`, plugins: existing };
  }
  const next = existing.filter(item => item.id !== normalized.id).concat(normalized);
  try {
    await store.writeWorkspaceFile({ characterId, path: PLUGINS_FILE, content: serializePlugins(next) });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error), plugins: existing };
  }
  return { ok: true, plugins: next, ...(rebuilt ? { rebuilt: true } : {}) };
}

// 卸载一个插件。返回 { ok, plugins }。
export async function uninstallPlugin({ store, characterId, id } = {}) {
  const key = String(id == null ? '' : id).trim().toLowerCase();
  const read = await readPluginsText(store, characterId);
  // 同 installPlugin：读失败拒绝写入，否则会把整份清单覆盖成「只少了这一个」的空表。
  if (read.status === 'error') {
    return { ok: false, error: read.error || 'plugins-read-failed', plugins: [] };
  }
  const parsed = parsePluginsText(read.text);
  const existing = parsed.plugins;
  // 损坏态下 existing 只能是 []：**不能**据此回答「插件未安装」——那是在用读不到的清单
  // 断言一件它证明不了的事。如实说明，并指向面板的重置入口。
  if (parsed.status === 'corrupt') {
    return { ok: false, error: '插件清单已损坏，无法确认该插件是否已安装；请先重置插件清单', plugins: [] };
  }
  const next = existing.filter(item => item.id !== key);
  if (next.length === existing.length) return { ok: false, error: '插件未安装', plugins: existing };
  try {
    await store.writeWorkspaceFile({ characterId, path: PLUGINS_FILE, content: serializePlugins(next) });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error), plugins: existing };
  }
  return { ok: true, plugins: next };
}

// 用户**显式**「重置插件清单」：把 plugins.json 重建成空清单（返回 { ok, error? }）。
// 为什么需要这个入口：内容损坏是永久态，解析不出来、又不该像读失败那样拒绝写入
// （拒绝就等于用户再也装不上插件）。但也不能**自动**重置——那等于静默删掉用户已装插件，
// 正是要避免的事。所以只提供一个显式动作，由面板加确认框调用。
// 只重写 .easychat/plugins.json 这一份清单；工作区里的其它文件（插件自己写的文件）一律不动。
export async function resetPluginsFile({ store, characterId } = {}) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') {
    return { ok: false, error: 'plugins-store-unavailable' };
  }
  // 读失败时同样拒绝：读不到就写，等于用空清单覆盖一份可能完好的文件。
  const read = await readPluginsText(store, characterId);
  if (read.status === 'error') {
    return { ok: false, error: read.error || 'plugins-read-failed' };
  }
  try {
    await store.writeWorkspaceFile({ characterId, path: PLUGINS_FILE, content: serializePlugins([]) });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  return { ok: true };
}

export { PLUGIN_MANIFEST_VERSION };
