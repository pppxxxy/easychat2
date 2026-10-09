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
export const HOOK_EVENTS = Object.freeze(['before_shell', 'after_write', 'after_edit', 'on_tool_result']);
export const HOOK_MATCH_MAX = 200;
export const HOOK_MESSAGE_MAX = 300;
// 每个事件的条目上限：一个钩子文件不该能把提示词/结果撑爆。
export const HOOKS_MAX_PER_EVENT = 20;

// 内置默认钩子（A4，能力升级任务书）：「改完记得跑验证」是 write 模式受益面最大的
// 一条既有约定，做成默认 after_* 提醒——不用用户自己写 hooks.json 就能得到。
// **同键可覆盖关闭**：用户在 hooks.json 里写了 `"after_edit": []` 就关掉默认
//（键缺失 = 没提过 → 用默认；键为空数组 = 明确要求为空）。
export const DEFAULT_HOOKS = Object.freeze({
  after_write: Object.freeze([
    Object.freeze({ pattern: '**/*', message: '改完记得跑一次验证（测试 / 语法检查 / 直接运行），把结果写进结论。' }),
  ]),
  after_edit: Object.freeze([
    Object.freeze({ pattern: '**/*', message: '改完记得跑一次验证（测试 / 语法检查 / 直接运行），把结果写进结论。' }),
  ]),
});

// 纯函数：把用户钩子与内置默认合并（只补用户**没有声明**的键）。
export function withDefaultHooks(hooks) {
  const source = hooks && typeof hooks === 'object' && !Array.isArray(hooks) ? hooks : {};
  const out = { ...source };
  for (const event of Object.keys(DEFAULT_HOOKS)) {
    if (out[event] === undefined) out[event] = DEFAULT_HOOKS[event];
  }
  return out;
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
// 非 JSON / 结构不对 → 空对象（钩子文件坏了就当没有，绝不因此让工具链报错）。
// **只保留显式声明的键**：键缺失与空数组是两种意图（见 DEFAULT_HOOKS 的说明），
// 缺失的键不进结果——合并层才知道该不该补默认。
export function parseWorkspaceHooks(text) {
  const out = {};
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
    // 值不是数组（写坏了）当缺失处理——保守：不因手误关掉默认提醒。
    if (!Array.isArray(source[event])) continue;
    out[event] = source[event].map(normalizeItem).filter(Boolean).slice(0, HOOKS_MAX_PER_EVENT);
  }
  return out;
}

// IO：读工作区钩子（不存在/读失败/格式坏 → 只剩内置默认，绝不抛错）。
// 返回的是**合并默认后**的完整结构：调用方（工具层）不关心哪些是默认哪些是用户配的。
export async function readWorkspaceHooks(store, characterId) {
  if (!store || typeof store.readWorkspaceFile !== 'function') return withDefaultHooks(null);
  try {
    const result = await store.readWorkspaceFile({ characterId, path: HOOKS_FILE });
    return withDefaultHooks(parseWorkspaceHooks(result && result.content));
  } catch (error) {
    return withDefaultHooks(null);
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

// D4-1：结果钩子——match 对**工具名精确匹配**（结果增强没有「前缀」或路径语义，
// 写错就是没命中，不做模糊——模糊匹配会让一条钩子意外作用到别的工具上）。
export function collectToolResultNotices(hooks, toolName) {
  const list = hooks && Array.isArray(hooks.on_tool_result) ? hooks.on_tool_result : [];
  const name = String(toolName || '');
  if (!name) return [];
  return list.filter(item => item && item.pattern === name).map(item => item.message);
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
