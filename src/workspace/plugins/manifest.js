// 插件清单（plugin manifest）——插件化运行时的数据契约（差距 #2 的可行切面）。
//
// 与既有「声明式扩展」（SKILL.md / commands / agents / teams / hooks.json / packs）的关系：
// 那些是**固定种类**的扩展点；插件是**可组合的容器**——一个插件可以同时声明 UI 槽位、
// 工具（沙盒执行）与钩子，把「扩展能力」与「扩展界面」放进同一个可分发单元。
//
// 纯数据 + 纯校验，零 IO、零 RN，可 Node 直测。落盘位置：`.easychat/plugins/<id>/plugin.json`。
//
// 安全边界（重要，别淡化）：本文件只描述与校验；**执行**在 sandbox.js，能力面由
// `permissions` 白名单收窄（默认最小权限）。插件代码不是可信代码——见 sandbox.js 的说明。

export const PLUGIN_MANIFEST_VERSION = 1;

// 可注册的 UI 槽位种类（渲染层按 kind 分派；新增 kind 要同时改 PluginSlot.js）。
export const SLOT_KINDS = Object.freeze([
  'chat.header',    // 对话面板顶部徽标行
  'chat.footer',    // 输入区上方
  'settings.row',   // 设置面板一行（label + value/action）
  'files.toolbar',  // 文件面板工具条按钮
  'message.action', // 消息气泡上的动作按钮
  'composer.button',// 输入框旁的按钮
]);

// 能力白名单：插件在 manifest 里声明它需要什么，沙盒据此注入对应原语。
export const PLUGIN_PERMISSIONS = Object.freeze(['fs.read', 'fs.write', 'search', 'notify']);

export const PLUGIN_LIMITS = Object.freeze({
  idMax: 48,
  nameMax: 60,
  descMax: 200,
  versionMax: 24,
  slotsMax: 12,
  toolsMax: 8,
  hooksMax: 8,
  handlerMax: 20000,
});

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// 插件 id 归一：小写字母/数字/连字符/下划线，1..48。
export function normalizePluginId(id) {
  return String(id == null ? '' : id)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, PLUGIN_LIMITS.idMax);
}

function normalizeSlot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = text(raw.kind, 32);
  if (!SLOT_KINDS.includes(kind)) return null;
  return {
    kind,
    id: text(raw.id, 48),
    label: text(raw.label, PLUGIN_LIMITS.nameMax),
    text: text(raw.text, PLUGIN_LIMITS.descMax),
    action: text(raw.action, 48),
  };
}

function normalizeTool(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = text(raw.name, 64).replace(/[^A-Za-z0-9_-]/g, '_');
  if (!name) return null;
  const handler = text(raw.handler, PLUGIN_LIMITS.handlerMax);
  return {
    name,
    description: text(raw.description, PLUGIN_LIMITS.descMax),
    parameters: raw.parameters && typeof raw.parameters === 'object' ? raw.parameters : { type: 'object', properties: {} },
    readOnly: raw.readOnly === true,
    // handler 是一段 JS 源码字符串，在沙盒里以受限能力面求值（见 sandbox.js）。
    handler,
  };
}

function normalizePermissions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const value = text(item, 32);
    if (PLUGIN_PERMISSIONS.includes(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

// 归一化任意输入 → 标准 manifest（永不抛）。非法字段被丢弃，缺字段补默认。
export function normalizeManifest(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const slots = (Array.isArray(src.slots) ? src.slots : [])
    .map(normalizeSlot).filter(Boolean).slice(0, PLUGIN_LIMITS.slotsMax);
  const tools = (Array.isArray(src.tools) ? src.tools : [])
    .map(normalizeTool).filter(Boolean).slice(0, PLUGIN_LIMITS.toolsMax);
  const hooks = src.hooks && typeof src.hooks === 'object' ? { ...src.hooks } : {};
  return {
    version: PLUGIN_MANIFEST_VERSION,
    id: normalizePluginId(src.id),
    name: text(src.name, PLUGIN_LIMITS.nameMax),
    pluginVersion: text(src.pluginVersion || src.version, PLUGIN_LIMITS.versionMax),
    description: text(src.description, PLUGIN_LIMITS.descMax),
    permissions: normalizePermissions(src.permissions),
    slots,
    tools,
    hooks,
  };
}

// 校验：返回 { ok, errors: string[] }。用于安装前把关与市场条目的自检。
export function validateManifest(raw) {
  const errors = [];
  const src = raw && typeof raw === 'object' ? raw : null;
  if (!src) return { ok: false, errors: ['manifest 不是对象'] };
  const id = normalizePluginId(src.id);
  if (!id) errors.push('缺少合法 id');
  if (!text(src.name, PLUGIN_LIMITS.nameMax)) errors.push('缺少 name');
  const rawSlots = Array.isArray(src.slots) ? src.slots : [];
  rawSlots.forEach((slot, i) => {
    if (!slot || !SLOT_KINDS.includes(text(slot.kind, 32))) errors.push(`slots[${i}] 的 kind 非法`);
  });
  const rawTools = Array.isArray(src.tools) ? src.tools : [];
  rawTools.forEach((tool, i) => {
    if (!tool || !text(tool.name, 64)) errors.push(`tools[${i}] 缺少 name`);
    if (tool && !text(tool.handler, PLUGIN_LIMITS.handlerMax)) errors.push(`tools[${i}] 缺少 handler`);
  });
  const perms = Array.isArray(src.permissions) ? src.permissions : [];
  perms.forEach((p, i) => {
    if (!PLUGIN_PERMISSIONS.includes(text(p, 32))) errors.push(`permissions[${i}] 非法：${p}`);
  });
  return { ok: errors.length === 0, errors };
}
