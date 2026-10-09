// 工作区钩子（hooks.json，spec 2026-10-09-agent-extensibility T6）。
//
// **声明式、零代码执行**：明确不做任意 JS 插件——RN 里没有能安全跑第三方代码的沙盒
// （进程内 eval 能触达全部原生桥），让 hooks.json 执行脚本等于把整个应用的安全边界
// 交出去。声明式 JSON 覆盖真正有价值的两类场景：
//
// 1. before_shell —— **预置禁令**：用户提前写下「这些命令永远不许跑」，执行前直接
//    拒绝（连确认弹框都不弹：用户早已表态，不必再问）。实现上翻译成权限规则的 deny，
//    复用 T3「deny 最高优先」的既有链路，零新增裁决路径。
// 2. after_write / after_edit —— **事后提醒**：写完/改完某类文件后，把一句提醒追加到
//    工具结果里（模型看得到、可能照做，如「改了 src 记得跑测试」）。它是提醒不是强制：
//    声明式能做到的只有信息通道这一层。
//
// 存放 `.easychat/hooks.json`（agent 可读写——它只能**收紧**不能放宽：block 更严、
// notify 只是信息，改坏了顶多不生效）。
//
// 格式：
// {
//   "before_shell": [{ "match": "git push", "message": "推送由用户手动执行" }],
//   "after_write":  [{ "glob": "**/*.md", "message": "检查目录与链接是否同步" }],
//   "after_edit":   [{ "glob": "src/**/*.js", "message": "记得跑测试" }]
// }
// （before_shell 用 match 前缀语义；after_* 用 glob 路径语义；两个键名都认，宽容解析。）

import { commandPrefixMatches, pathMatchesGlob } from '../agent/permissions.js';

export const HOOKS_FILE = '.easychat/hooks.json';
export const HOOK_EVENTS = Object.freeze(['before_shell', 'after_write', 'after_edit']);
export const HOOK_MATCH_MAX = 200;
export const HOOK_MESSAGE_MAX = 300;
// 每个事件的条目上限：一个钩子文件不该能把提示词/结果撑爆。
export const HOOKS_MAX_PER_EVENT = 20;

function emptyHooks() {
  return { before_shell: [], after_write: [], after_edit: [] };
}

function normalizeItem(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // match / glob 两个键名都认（before_shell 习惯写 match、after_* 习惯写 glob）。
  const pattern = String(source.match || source.glob || '').trim().slice(0, HOOK_MATCH_MAX);
  const message = String(source.message == null ? '' : source.message).trim().slice(0, HOOK_MESSAGE_MAX);
  if (!pattern || !message) return null; // 缺匹配或缺说明的条目直接剔除（静默，不碍事）
  return { pattern, message };
}

// 纯函数：hooks.json 文本（或已解析对象）→ 归一化结构。
// 非 JSON / 结构不对 → 全空（钩子文件坏了就当没有，绝不因此让工具链报错）。
export function parseWorkspaceHooks(text) {
  const out = emptyHooks();
  let source = text;
  if (typeof text === 'string') {
    try {
      source = JSON.parse(text);
    } catch (error) {
      return out;
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return out;
  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(source[event]) ? source[event] : [];
    out[event] = list.map(normalizeItem).filter(Boolean).slice(0, HOOKS_MAX_PER_EVENT);
  }
  return out;
}

// IO：读工作区钩子（不存在/读失败/格式坏一律空结构）。
export async function readWorkspaceHooks(store, characterId) {
  if (!store || typeof store.readWorkspaceFile !== 'function') return emptyHooks();
  try {
    const result = await store.readWorkspaceFile({ characterId, path: HOOKS_FILE });
    return parseWorkspaceHooks(result && result.content);
  } catch (error) {
    return emptyHooks();
  }
}

// before_shell 命中（命令前缀，与权限规则同语义：词边界——`git push` 不放行 `git pushx`）。
export function matchBeforeShellHooks(hooks, command) {
  const list = hooks && Array.isArray(hooks.before_shell) ? hooks.before_shell : [];
  return list.filter(item => commandPrefixMatches(item.pattern, command));
}

// 翻译成 T3 权限规则的 deny 项：交给 approveToolCall 的 extraRules，
// 走「deny 最高优先」既有链路（命中即拒绝、不弹框）。
export function shellHookDenyRules(hooks) {
  const list = hooks && Array.isArray(hooks.before_shell) ? hooks.before_shell : [];
  return list.map(item => ({
    effect: 'deny',
    tool: 'run_shell',
    match: item.pattern,
    scope: 'session',
  }));
}

// after_* 通知：路径 glob 命中项的 message 列表（按声明顺序）。
export function collectPostEventNotices(hooks, event, filePath) {
  if (event !== 'after_write' && event !== 'after_edit') return [];
  const list = hooks && Array.isArray(hooks[event]) ? hooks[event] : [];
  return list
    .filter(item => pathMatchesGlob(item.pattern, filePath))
    .map(item => item.message);
}

// IO 便捷（工具层用）：读 + 收集一步到位。读失败当没有钩子，不影响工具本身。
export async function postWriteNotices(store, characterId, event, filePath) {
  const hooks = await readWorkspaceHooks(store, characterId);
  return collectPostEventNotices(hooks, event, filePath);
}
