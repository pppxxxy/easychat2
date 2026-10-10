// 工作区钩子（hooks.json，spec 2026-10-09-agent-extensibility T6 / P0-8 扩展）。
//
// **声明式、零代码执行**：明确不做任意 JS 插件——RN 里没有能安全跑第三方代码的沙盒
// （进程内 eval 能触达全部原生桥），让 hooks.json 执行脚本等于把整个应用的安全边界
// 交出去。声明式 JSON 覆盖真正有价值的几类场景：
//
// 1. before_shell —— **预置禁令 / 预置必问**（等价于 `before_tool` 的 tool=run_shell）：
//    「这些命令永远不许跑 / 必须先问」。翻译成权限规则的 deny / ask，复用 T3
//    「deny > ask > allow」的既有链路，零新增裁决路径。
// 2. before_tool —— **泛化的工具前门**（P0-8）：按工具名（精确 / `|` 列表 / `*` /
//    `re:` 正则）+ 参数（命令前缀 / 路径 glob，字段驱动）拦下任意工具，不再只覆盖 shell。
//    同样只翻译成 deny / ask。
// 3. before_prompt —— **提交前**：命中用户输入时注入一段上下文（默认），或直接拦下这次
//    发送（`effect: "deny"`，把 message 作为给用户的理由）。
// 4. before_compact —— **压缩前**：把 message 并进压缩提示词的「额外要求」（与 /compact
//    的关注点同一条通道），或拦下这次压缩。
// 5. after_turn —— **本轮结束后**：message 排队给**下一轮请求**当上下文（Claude Code 的
//    Stop 钩子同款用法）。诚实边界：队列在内存里，应用重启即丢（不写盘、不假装持久）。
// 6. session_start —— 每个会话在本次运行里**第一次请求**时注入 message。
// 7. after_write / after_edit —— **事后提醒**：写完/改完某类文件后，把一句提醒追加到
//    工具结果里（模型看得到、可能照做，如「改了 src 记得跑测试」）。它是提醒不是强制。
// 8. on_tool_result —— 按工具名精确匹配，往工具结果里追加提醒。
//
// 存放 `.easychat/hooks.json`（agent 可读写——它只能**收紧**不能放宽：拦得更多、
// 注入的只是文字，改坏了顶多不生效）。
//
// 格式（键缺失 = 没提过；空数组 = 明确要求为空）：
// {
//   "before_shell":   [{ "match": "git push", "message": "推送由用户手动执行" }],
//   "before_tool":    [{ "tool": "run_shell|run_python", "match": "rm -rf",
//                        "message": "删除操作先问过我", "effect": "ask" }],
//   "before_prompt":  [{ "match": "re:^(部署|上线)", "message": "本项目禁止自动部署",
//                        "effect": "deny" }],
//   "before_compact": [{ "message": "保留所有未决问题与报错原文" }],
//   "after_turn":     [{ "message": "把结论写进工作区 AGENTS.md" }],
//   "session_start":  [{ "message": "本次会话请用中文回答" }],
//   "after_write":    [{ "glob": "**/*.md", "message": "检查目录与链接是否同步" }],
//   "after_edit":     [{ "glob": "src/**/*.js", "message": "记得跑测试" }],
//   "on_tool_result": [{ "match": "run_shell", "message": "记得核对退出码" }]
// }
// （before_shell / before_tool 用 match 前缀与路径 glob 语义、effect 缺省 deny；
//   after_* 用 glob 路径语义；match/glob 两个键名都认，宽容解析。）

import { commandPrefixMatches, matchToolPattern, pathMatchesGlob } from '../agent/permissions.js';

export const HOOKS_FILE = '.easychat/hooks.json';
export const HOOK_EVENTS = Object.freeze([
  'before_shell',
  'before_tool',
  'before_prompt',
  'before_compact',
  'after_turn',
  'session_start',
  'after_write',
  'after_edit',
  'on_tool_result',
]);
// 工具前门的 effect 白名单：deny（直接拒绝，缺省）/ ask（必须先问，只给「允许这一次」）。
// **没有 allow**：声明式钩子只能收紧，放宽授权是设置页的显式动作。
export const HOOK_SHELL_EFFECTS = Object.freeze(['deny', 'ask']);
// 提交/压缩前的 effect：inject（默认，注入上下文）/ deny（拦下这次动作）。
export const HOOK_PROMPT_EFFECTS = Object.freeze(['inject', 'deny']);
export const HOOK_MATCH_MAX = 200;
export const HOOK_MESSAGE_MAX = 300;
export const HOOK_TOOL_MAX = 200;
// 每个事件的条目上限：一个钩子文件不该能把提示词/结果撑爆。
export const HOOKS_MAX_PER_EVENT = 20;
// 一轮里最多注入多少条（防「20 条 × 多事件」把上下文撑爆）。
export const HOOK_NOTICES_MAX = 5;

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

// 哪些事件用「工具名 + 参数」语义、哪些用「文本匹配」语义。
const TOOL_EVENTS = Object.freeze(['before_shell', 'before_tool']);
const PROMPT_EVENTS = Object.freeze(['before_prompt', 'before_compact']);
const NOTICE_EVENTS = Object.freeze(['after_turn', 'session_start']);

// 工具名匹配：**单一实现在权限规则引擎**（`agent/permissions.js` 的 matchToolPattern）——
// 存储规则与钩子规则必须同一套语义，否则「手写规则命中、钩子规则不命中」这类差异
// 会在排查时把人绕死。这里只是给钩子侧一个同名的导出。
export const matchToolName = matchToolPattern;

// 文本匹配（提交/压缩事件）：空/`*` = 全部；`re:` = 正则；其余按子串（大小写敏感，
// 与路径 glob 同口径：规则语义不随平台漂移）。
export function matchHookText(matcher, text) {
  const pattern = String(matcher === undefined || matcher === null ? '' : matcher).trim();
  if (!pattern || pattern === '*') return true;
  const value = String(text === undefined || text === null ? '' : text);
  if (pattern.startsWith('re:')) {
    try {
      return new RegExp(pattern.slice(3)).test(value);
    } catch (error) {
      return false;
    }
  }
  return value.includes(pattern);
}

function normalizeItem(raw, event) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // match / glob 两个键名都认（before_shell 习惯写 match、after_* 习惯写 glob）。
  const pattern = String(source.match || source.glob || '').trim().slice(0, HOOK_MATCH_MAX);
  const message = String(source.message == null ? '' : source.message).trim().slice(0, HOOK_MESSAGE_MAX);
  if (!message) return null; // 缺说明的条目直接剔除（静默，不碍事）
  if (event === 'before_tool') {
    const tool = String(source.tool || '').trim().slice(0, HOOK_TOOL_MAX);
    if (!tool) return null; // 泛化前门必须说清是哪个工具（before_shell 才是默认 run_shell）
    return {
      tool,
      pattern,
      message,
      effect: HOOK_SHELL_EFFECTS.includes(source.effect) ? source.effect : 'deny',
    };
  }
  if (TOOL_EVENTS.includes(event)) {
    if (!pattern) return null; // 预置禁令/必问必须给匹配串
    // effect 只对工具前门有意义；写错/写 allow 一律落到 deny（收紧方向，绝不静默放宽）。
    return {
      pattern,
      message,
      effect: HOOK_SHELL_EFFECTS.includes(source.effect) ? source.effect : 'deny',
    };
  }
  if (PROMPT_EVENTS.includes(event)) {
    return {
      pattern,
      message,
      effect: HOOK_PROMPT_EFFECTS.includes(source.effect) ? source.effect : 'inject',
    };
  }
  if (NOTICE_EVENTS.includes(event)) {
    return { pattern, message };
  }
  // after_* / on_tool_result：必须给匹配串（glob 或工具名）。
  if (!pattern) return null;
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
    out[event] = source[event]
      .map(item => normalizeItem(item, event))
      .filter(Boolean)
      .slice(0, HOOKS_MAX_PER_EVENT);
  }
  return out;
}

// 校验（hooks 面板用）：逐事件逐条给出「为什么这条不会生效」，而不是静默丢弃。
// 与 parseWorkspaceHooks 共用同一套归一（能通过校验 = 一定解析得出来）。
export function validateWorkspaceHooks(text) {
  const errors = [];
  let source = text;
  if (typeof text === 'string') {
    try {
      source = JSON.parse(text);
    } catch (error) {
      return { ok: false, errors: [{ event: '', index: -1, reason: 'invalid-json' }] };
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { ok: false, errors: [{ event: '', index: -1, reason: 'not-object' }] };
  }
  for (const key of Object.keys(source)) {
    if (!HOOK_EVENTS.includes(key)) {
      errors.push({ event: key, index: -1, reason: 'unknown-event' });
      continue;
    }
    if (!Array.isArray(source[key])) {
      errors.push({ event: key, index: -1, reason: 'not-array' });
      continue;
    }
    if (source[key].length > HOOKS_MAX_PER_EVENT) {
      errors.push({ event: key, index: HOOKS_MAX_PER_EVENT, reason: 'too-many' });
    }
    source[key].forEach((item, index) => {
      if (!normalizeItem(item, key)) {
        errors.push({ event: key, index, reason: 'invalid-item' });
        return;
      }
      // 正则写错：条目能归一但永远匹配不上——必须报出来（否则用户以为钩子生效了）。
      const pattern = String((item && (item.match || item.glob || item.tool)) || '').trim();
      for (const candidate of [item && item.match, item && item.glob, item && item.tool]) {
        const value = String(candidate === undefined || candidate === null ? '' : candidate).trim();
        if (!value.startsWith('re:')) continue;
        try {
          new RegExp(value.slice(3));
        } catch (error) {
          errors.push({ event: key, index, reason: 'invalid-regex' });
        }
      }
      if (pattern.length > HOOK_MATCH_MAX) {
        errors.push({ event: key, index, reason: 'too-long' });
      }
    });
  }
  return { ok: errors.length === 0, errors };
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

// before_tool 命中（工具名 + 参数）：参数语义交给权限规则引擎的字段驱动匹配，
// 这里只负责「工具名这一层」的筛选。
export function matchBeforeToolHooks(hooks, toolName) {
  const list = hooks && Array.isArray(hooks.before_tool) ? hooks.before_tool : [];
  return list.filter(item => matchToolName(item.tool, toolName));
}

// 翻译成 T3 权限规则（before_shell + before_tool 一起）：
// - 缺省 deny（命中即拒绝、不弹框），声明 `effect: "ask"` 的条目翻成 ask
//   （命中弹「只允许这一次」，且**不记规则**）；
// - match 为空 = 该工具的全部调用（工具级规则）。
// 交给 approveToolCall 的 extraRules，与存储规则合并求值（优先级由 evaluate 保证）。
export function hookPermissionRules(hooks) {
  const source = hooks && typeof hooks === 'object' ? hooks : {};
  const shell = (Array.isArray(source.before_shell) ? source.before_shell : []).map(item => ({
    effect: item && item.effect === 'ask' ? 'ask' : 'deny',
    tool: 'run_shell',
    match: item && item.pattern,
    scope: 'session',
  }));
  const tools = (Array.isArray(source.before_tool) ? source.before_tool : []).map(item => ({
    effect: item && item.effect === 'ask' ? 'ask' : 'deny',
    tool: item && item.tool,
    match: item && item.pattern,
    scope: 'session',
  }));
  return [...shell, ...tools];
}

// before_prompt：命中用户输入 → 拦截（deny）与注入（inject）分开返回。
// 拦截优先（有一条 deny 就不发送），注入按声明顺序、上限 HOOK_NOTICES_MAX 条。
export function collectPromptHooks(hooks, text) {
  const list = hooks && Array.isArray(hooks.before_prompt) ? hooks.before_prompt : [];
  const hit = list.filter(item => matchHookText(item.pattern, text));
  return {
    blocks: hit.filter(item => item.effect === 'deny').map(item => item.message),
    notices: hit.filter(item => item.effect !== 'deny').map(item => item.message).slice(0, HOOK_NOTICES_MAX),
  };
}

// before_compact：命中（无匹配串 = 全部）→ 拦截 / 追加到压缩提示词的「额外要求」。
export function collectCompactionHooks(hooks, text = '') {
  const list = hooks && Array.isArray(hooks.before_compact) ? hooks.before_compact : [];
  const hit = list.filter(item => matchHookText(item.pattern, text));
  return {
    blocks: hit.filter(item => item.effect === 'deny').map(item => item.message),
    notices: hit.filter(item => item.effect !== 'deny').map(item => item.message).slice(0, HOOK_NOTICES_MAX),
  };
}

// after_turn / session_start：只是「排队给下一次请求的上下文」的文字。
export function collectTurnEndNotices(hooks) {
  const list = hooks && Array.isArray(hooks.after_turn) ? hooks.after_turn : [];
  return list.map(item => item.message).slice(0, HOOK_NOTICES_MAX);
}

export function collectSessionStartNotices(hooks) {
  const list = hooks && Array.isArray(hooks.session_start) ? hooks.session_start : [];
  return list.map(item => item.message).slice(0, HOOK_NOTICES_MAX);
}

// 把多来源的通知合成一段注入文本（去重、限量、空则空串）。
// 顺序由调用方定：排队的上轮提醒 → 会话开始 → 本次提交命中——越靠后的越贴近当下。
export function buildHookContextText(notices) {
  const list = [];
  for (const raw of Array.isArray(notices) ? notices : []) {
    const text = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!text || list.includes(text)) continue;
    list.push(text);
    if (list.length >= HOOK_NOTICES_MAX) break;
  }
  return list.join('\n');
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
