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

// 槽位接线表（纯数据）：本模块据此把「注册得下但界面上没有落点」的 kind 标为暂不支持。
import { UNWIRED_SLOT_KINDS } from './slotKinds.js';

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

// ⚠️ **注册成功 ≠ 会显示**。上表只说明「哪些 kind 收得下」；某个 kind 会不会真的出现在
// 界面上，取决于**接线表** SLOT_RENDER_POINTS（哪个文件里写了 `<PluginSlot kind="..." />`），
// 未接线的那些在 workspace/plugins/slotKinds.js 里显式标 null 并派生成 UNWIRED_SLOT_KINDS。
//
// 那张表抽到 slotKinds.js（纯数据、零 JSX）而不是留在渲染端 screen/PluginSlot.js 里，正是为了
// 让本模块能直接 import 它：PluginSlot.js 是 RN 组件文件，Node 解析它的 JSX 会抛 SyntaxError，
// 而本模块的定位是「纯数据 + 纯校验，零 IO、零 RN，可 Node 直测」（tests/plugins.test.mjs
// 直接 import 本模块）。两边 import 的是**同一份表** ⇒ 结构上不可能漂移。
export const SLOT_KIND_UNWIRED_REASON = 'slot-kind-not-wired';

// 把「收得下的 kind」与「界面上真有落点的 kind」对账 → 每种 kind 的可用性。
// unwiredKinds 缺省即接线表的派生结果（调用方一般不必传；留参数是为了可测/可注入）。
export function slotKindSupport(unwiredKinds = UNWIRED_SLOT_KINDS) {
  const unwired = new Set(
    (Array.isArray(unwiredKinds) ? unwiredKinds : []).map(kind => String(kind || ''))
  );
  // 顺序与成员都从 SLOT_KINDS 派生，这里不出现任何字面量 kind。
  return Object.freeze(SLOT_KINDS.map(kind => Object.freeze({
    kind,
    supported: !unwired.has(kind),
    reason: unwired.has(kind) ? SLOT_KIND_UNWIRED_REASON : '',
  })));
}

// 能力白名单：插件在 manifest 里声明它需要什么，沙盒据此注入对应原语。
export const PLUGIN_PERMISSIONS = Object.freeze(['fs.read', 'fs.write', 'search', 'notify']);

// 插件的四个归类（决定它在插件面板里归到哪一组）：
//   workspace 工作区插件 / chat 聊天插件 / feature 功能插件 / other 其他插件
// 顺序即面板里的分组顺序。
export const PLUGIN_CATEGORIES = Object.freeze(['workspace', 'chat', 'feature', 'other']);
// 「其他」= 不属于前三种的兜底。声明缺失或非法时也落这里（但推断能认出时会归到对应组）。
export const DEFAULT_PLUGIN_CATEGORY = 'other';

// 槽位种类 → 它属于哪一类界面贡献。判定只看槽位，不看插件名字——
// 名字是自由文本，按名字猜归类必然漂移。
const SLOT_CATEGORY = Object.freeze({
  'chat.header': 'chat',
  'chat.footer': 'chat',
  'message.action': 'chat',
  'composer.button': 'chat',
  'files.toolbar': 'workspace',
  'settings.row': 'other',
});

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

// 从插件「实际贡献了什么」推一个归类。用于没声明 category 的插件——导入进来的第三方
// 插件几乎都不会带这个字段，全靠推断落到合适的分组，而不是一股脑进「其他」。
// 判定顺序：工作区能力（读写工作区文件的工具）→ 聊天界面 → 工作区界面 → 功能 → 其他。
// 传进来的 parts 应当是**已归一化**的 slots/tools/hooks/permissions。
export function inferPluginCategory(parts) {
  const src = parts && typeof parts === 'object' ? parts : {};
  const slots = Array.isArray(src.slots) ? src.slots : [];
  const tools = Array.isArray(src.tools) ? src.tools : [];
  const permissions = Array.isArray(src.permissions) ? src.permissions : [];
  const hooks = src.hooks && typeof src.hooks === 'object' ? src.hooks : {};
  if (tools.length > 0 && permissions.some(p => p === 'fs.read' || p === 'fs.write')) return 'workspace';
  if (slots.some(slot => slot && SLOT_CATEGORY[slot.kind] === 'chat')) return 'chat';
  if (slots.some(slot => slot && SLOT_CATEGORY[slot.kind] === 'workspace')) return 'workspace';
  // 钩子会改 agent 行为、工具能干活——都算「加了个功能」；只有一行设置项的不算。
  if (Object.keys(hooks).length > 0 || tools.length > 0) return 'feature';
  return DEFAULT_PLUGIN_CATEGORY;
}

// 归类归一：显式声明优先（白名单内才认），否则推断。
export function normalizePluginCategory(raw, parts) {
  const value = text(raw, 24).toLowerCase();
  if (PLUGIN_CATEGORIES.includes(value)) return value;
  return inferPluginCategory(parts);
}

// 面板分组：顺序固定（工作区 → 聊天 → 功能 → 其他），**空组不返回**——
// 摆一排空标题只会让人以为界面坏了。每项须带已归一的 `category`。
export function groupPluginsByCategory(items) {
  const list = Array.isArray(items) ? items : [];
  const buckets = PLUGIN_CATEGORIES.map(category => ({ category, items: [] }));
  const byCategory = new Map(buckets.map(bucket => [bucket.category, bucket]));
  for (const item of list) {
    const raw = text(item && item.category, 24).toLowerCase();
    const target = PLUGIN_CATEGORIES.includes(raw) ? raw : DEFAULT_PLUGIN_CATEGORY;
    byCategory.get(target).items.push(item);
  }
  return buckets.filter(bucket => bucket.items.length > 0);
}

// 归一化任意输入 → 标准 manifest（永不抛）。非法字段被丢弃，缺字段补默认。
export function normalizeManifest(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const slots = (Array.isArray(src.slots) ? src.slots : [])
    .map(normalizeSlot).filter(Boolean).slice(0, PLUGIN_LIMITS.slotsMax);
  const tools = (Array.isArray(src.tools) ? src.tools : [])
    .map(normalizeTool).filter(Boolean).slice(0, PLUGIN_LIMITS.toolsMax);
  const hooks = src.hooks && typeof src.hooks === 'object' ? { ...src.hooks } : {};
  const permissions = normalizePermissions(src.permissions);
  return {
    version: PLUGIN_MANIFEST_VERSION,
    id: normalizePluginId(src.id),
    name: text(src.name, PLUGIN_LIMITS.nameMax),
    pluginVersion: text(src.pluginVersion || src.version, PLUGIN_LIMITS.versionMax),
    description: text(src.description, PLUGIN_LIMITS.descMax),
    category: normalizePluginCategory(src.category, { slots, tools, hooks, permissions }),
    permissions,
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
  // 归类是可选字段；但**写了就必须合法**——静默回落会让作者以为声明生效了。
  const category = text(src.category, 24).toLowerCase();
  if (category && !PLUGIN_CATEGORIES.includes(category)) errors.push(`category 非法：${src.category}`);
  return { ok: errors.length === 0, errors };
}
