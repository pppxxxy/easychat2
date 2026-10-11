// 权限规则引擎（spec 2026-10-09-agent-extensibility T3）：把「逐条确认」升级成「记住规则」。
//
// 用户在确认弹框上选「本次会话允许 / 永远允许」，之后同类调用不再打扰；
// deny 规则永远最高优先（安全不回退：放过一次的危险操作不进「自动放行」的语义）。
//
// 规则形状 [{ effect: 'allow' | 'ask' | 'deny', tool, match, scope: 'always' | 'session' }]：
// - tool：工具名（'*' = 全部工具；弹框只生成精确工具名，'*' 留给未来的设置页手写）；
// - match：按**参数形态**取语义（字段驱动，不硬编码工具名表——工具表增删也不会漂）：
//     · args.command / args.code 存在 → **命令前缀**（词边界，见 commandPrefixMatches）；
//     · args.path 存在 → **路径 glob**（见 pathMatchesGlob）；
//     · 都没有 → 空 match = 匹配该工具的全部调用；
//   空 match 恒为「工具级规则」（任何参数都命中）。
// - scope：'always' 落盘跨重启；'session' 只在本次运行的内存里（重启即忘）。
//
// 三个不变量（测试钉死）：
// ① deny 优先于 allow，与规则先后顺序无关；
// ② 无命中返回 null——调用方只有此时才弹框问人；
// ③ match 是「用户当时看到的那条原文」，永远不自动放宽（不截短、不取首词）。
//    想放宽（如放行整个 npm）是用户手写规则的活，不是系统的猜测。
//
// **ask 档（2026-10-10 加）**：显式「必须先问」——它的存在意义是从宽规则里**挖出例外**：
// 「放行 git 但 git push 必须先问」这类意图，只有 allow/deny 两态时表达不了（写 deny
// 是彻底禁止，不写则被宽 allow 吞掉）。优先级 deny > ask > allow：
// · ask 压过 allow（否则例外形同虚设）；
// · deny 仍压过一切（安全不回退）；
// · 命中 ask 时的批准只对**这一次**生效（调用方不得记下 allow 规则），
//   否则「必须先问」会被一次点击永久解除——那正是这个档要防的事。

export const PERMISSION_EFFECTS = Object.freeze(['allow', 'ask', 'deny']);
export const PERMISSION_SCOPES = Object.freeze(['always', 'session']);
// 单条 match 上限：同消息内容的上限量级，防一条规则把存储撑爆（命令/代码全文一般远小于它）。
export const PERMISSION_RULE_MAX_MATCH = 4000;
// 工具名上限：允许 `|` 列表与 `re:` 正则（P0-8），但同样要有界。
export const PERMISSION_RULE_MAX_TOOL = 200;

// 工具名匹配（P0-8 起与 hooks.json 的 before_tool 共用同一套语义）：
// - 精确名：`run_shell`；
// - `|` 列表：`run_shell|run_python`（两侧空白容忍，空项忽略）；
// - `*` 或空：全部工具；
// - `re:` 前缀：正则（**显式前缀**——普通工具名里的 `.` `+` 不该被当元字符；
//   写错的正则返回 false：匹配不上比静默放行安全）。
export function matchToolPattern(pattern, toolName) {
  const source = String(pattern === undefined || pattern === null ? '' : pattern).trim();
  const name = String(toolName === undefined || toolName === null ? '' : toolName).trim();
  if (!source || source === '*') return true;
  if (source.startsWith('re:')) {
    try {
      return new RegExp(source.slice(3)).test(name);
    } catch (error) {
      return false;
    }
  }
  return source.split('|').map(item => item.trim()).filter(Boolean).includes(name);
}

export function normalizePermissionRule(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const tool = String(source.tool || '').trim().slice(0, PERMISSION_RULE_MAX_TOOL);
  if (!tool) return null;
  const effect = PERMISSION_EFFECTS.includes(source.effect) ? source.effect : 'allow';
  const scope = PERMISSION_SCOPES.includes(source.scope) ? source.scope : 'always';
  const match = String(source.match == null ? '' : source.match).trim().slice(0, PERMISSION_RULE_MAX_MATCH);
  return { effect, tool, match, scope };
}

// 归一化 + 去重（effect+tool+match 相同视为同一条；scope 不参与相等性：
// 「永远允许」与「本次会话允许」同规则时合并成落盘那条，语义更强的一方胜出）。
export function normalizePermissionRules(list) {
  const source = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const rule = normalizePermissionRule(item);
    if (!rule) continue;
    const key = `${rule.effect}\u0000${rule.tool}\u0000${rule.match}`;
    if (seen.has(key)) {
      if (rule.scope === 'always') {
        const index = out.findIndex(existing => `${existing.effect}\u0000${existing.tool}\u0000${existing.match}` === key);
        if (index >= 0) out[index] = { ...out[index], scope: 'always' };
      }
      continue;
    }
    seen.add(key);
    out.push(rule);
  }
  return out;
}

function globToRegExp(pattern) {
  let out = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          // `src/**/x` 同时匹配 `src/x`（零层）与 `src/a/b/x`（多层）。
          out += '(?:[^/]+/)*';
        } else {
          out += '.*';
        }
      } else {
        // `*` 不跨层：单段内任意（含空）。
        out += '[^/]*';
      }
      continue;
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

// 路径 glob：`*` 只匹配单层（不跨 /），`**` 匹配任意层级（含零层）；
// 不支持 ? 等其它语法（保持最小可预期集，写错的 pattern 宁可匹配不上）。
// 大小写敏感：规则语义不该随「Android 敏感 / 桌面不敏感」的平台差异漂移。
export function pathMatchesGlob(pattern, target) {
  const source = String(pattern == null ? '' : pattern).trim();
  if (!source) return false;
  const clean = text => text.replace(/^\.\//, '').replace(/\/+$/, '');
  const cleaned = clean(source);
  if (cleaned === '**') return true;
  return globToRegExp(cleaned).test(clean(String(target == null ? '' : target).trim()));
}

// 命令前缀匹配（词边界）：`npm install` 命中 `npm install express`，
// 但**不**命中 `npm installx`——纯 startsWith 会在这里静默放行一条没被审过的命令。
// 前缀必须在「命令结尾 / 空白 / shell 分隔符」处结束才算命中。
export function commandPrefixMatches(prefix, command) {
  const needle = String(prefix == null ? '' : prefix).trim();
  const haystack = String(command == null ? '' : command).trim();
  if (!needle) return false;
  if (needle === haystack) return true;
  if (!haystack.startsWith(needle)) return false;
  return /^[\s;|&><)(]/.test(haystack.slice(needle.length));
}

// 从工具参数里取「被匹配的原文」：字段驱动（不硬编码工具名），
// 命令 / 代码优先，其次路径；都没有则 'any'（工具级规则）。
export function permissionMatchValue(args) {
  const values = args && typeof args === 'object' ? args : {};
  const command = String(values.command == null ? '' : values.command).trim();
  if (command) return { kind: 'command', value: command };
  const code = String(values.code == null ? '' : values.code).trim();
  if (code) return { kind: 'command', value: code };
  const filePath = String(values.path == null ? '' : values.path).trim();
  if (filePath) return { kind: 'path', value: filePath };
  return { kind: 'any', value: '' };
}

export function ruleMatches(rule, { tool, args } = {}) {
  const normalized = normalizePermissionRule(rule);
  if (!normalized) return false;
  const name = String(tool || '').trim();
  if (!matchToolPattern(normalized.tool, name)) return false;
  if (!normalized.match) return true; // 工具级规则：参数不限
  const { kind, value } = permissionMatchValue(args);
  if (kind === 'command') return commandPrefixMatches(normalized.match, value);
  if (kind === 'path') return pathMatchesGlob(normalized.match, value);
  // 带 match 的规则但调用没有可比的原文（如 list 的 subdir）：不命中——宁问不猜。
  return false;
}

// 求值：'deny' | 'ask' | 'allow' | null。deny 先扫，其次 ask，最后 allow；
// 与规则存放顺序无关（优先级是语义，不是数组顺序）。
export function evaluatePermissionRules(rules, { tool, args } = {}) {
  const list = normalizePermissionRules(rules);
  const has = effect => list.some(rule => rule.effect === effect && ruleMatches(rule, { tool, args }));
  if (has('deny')) return 'deny';
  if (has('ask')) return 'ask';
  if (has('allow')) return 'allow';
  return null;
}

// 从弹框上下文生成规则（「本次会话允许 / 永远允许」按钮的落点）：
// match = 这次调用的原文（命令/代码/路径），精确到用户真正审过的那一条。
export function makePermissionRule({ tool, args, effect = 'allow', scope = 'always' } = {}) {
  const name = String(tool || '').trim();
  if (!name) return null;
  const { value } = permissionMatchValue(args);
  return normalizePermissionRule({ effect, tool: name, match: value, scope });
}

// 规则的可读摘要（设置面板用）：文案经注入的 t() 走词条表——
// 这是给用户看的界面文本，不是发给模型的提示词，铁律照旧适用。
export function describePermissionRule(rule, t) {
  const normalized = normalizePermissionRule(rule);
  if (!normalized) return '';
  const translate = typeof t === 'function' ? t : key => key;
  const effectKey = normalized.effect === 'deny'
    ? 'workspace.settings.permissions.effect.deny'
    : (normalized.effect === 'ask'
      ? 'workspace.settings.permissions.effect.ask'
      : 'workspace.settings.permissions.effect.allow');
  const head = translate(effectKey, { tool: normalized.tool });
  if (!normalized.match) return `${head} · ${translate('workspace.settings.permissions.anyCall')}`;
  const preview = normalized.match.length > 60 ? `${normalized.match.slice(0, 60)}…` : normalized.match;
  return `${head}：${preview}`;
}
