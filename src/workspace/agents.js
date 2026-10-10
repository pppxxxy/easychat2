// 自定义子代理档案（E3，spec 2026-10-10-agent-maturity）：
// `.easychat/agents/<name>.md`，与 skills.js 同款的渐进披露与「每轮直读」原则。
//
// frontmatter 四字段（全可选，缺省退化）：
//   name        —— 显示名（缺省 = 文件名）
//   description —— 一句话描述（注入清单；缺省 = 正文第一行）
//   tools       —— 逗号分隔的工具名清单（**只能收窄只读白名单**）
//   max-rounds  —— 子代理轮次上限（clamp [1, 12]，缺省走 SUBAGENT_MAX_ROUNDS）
//
// 硬边界（结构性，不靠"记得别给"）：
// 1. tools 与 SUBAGENT_TOOL_NAMES 求交集——写别的名字（含 run_subagent）静默丢弃；
// 2. run_subagent 永不在 SUBAGENT_TOOL_NAMES 里，所以「分身里再开分身」在名字
//    过滤阶段就被物理挡下（与 subagent.js 的双层保证同源）。
//
// 模型统一走活动配置（不做 per-agent 模型）——BYO 端点定位下这是刻意的简化。

import { splitMarkdownFrontmatter } from './markdownFrontmatter.js';
import { SUBAGENT_TOOL_NAMES } from '../agent/subagent.js';

export const AGENTS_DIR = '.easychat/agents';
export const AGENT_NAME_MAX = 48;
export const AGENT_DESCRIPTION_MAX = 160;
// 清单注入上限：超出如实报数（与技能清单同款纪律，提示词不被撑爆）。
export const AGENT_LIST_MAX = 12;
// 解析 frontmatter 只需头部；正文（如果有）走 read 工具按需读。
export const AGENT_HEAD_CHARS = 1200;
// max-rounds 的硬上限：防用户写 100 把子代理跑飞（下限 1）。
export const AGENT_MAX_ROUNDS_LIMIT = 12;

function truncateText(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 纯函数：分身档案全文 → { name, description, tools?, maxRounds? }。
// 没有 frontmatter 也能用：name 用文件名、description 取正文第一个有效行。
export function parseAgentMarkdown(text, fallbackName = '') {
  const parsed = splitMarkdownFrontmatter(text);
  const meta = parsed.meta || {};
  const body = parsed.body || '';
  const profile = {
    name: truncateText(meta.name || fallbackName, AGENT_NAME_MAX),
    description: truncateText(meta.description, AGENT_DESCRIPTION_MAX),
  };
  // tools：逗号分隔；**∩ 只读白名单**（顺序跟随白名单，稳定可比）。
  const requested = String(meta.tools || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const tools = SUBAGENT_TOOL_NAMES.filter(name => requested.includes(name));
  if (tools.length > 0) profile.tools = tools;
  // max-rounds：clamp [1, AGENT_MAX_ROUNDS_LIMIT]——非法值当没写。
  const rounds = Math.floor(Number(meta['max-rounds']));
  if (Number.isFinite(rounds) && rounds > 0) {
    profile.maxRounds = Math.min(Math.max(1, rounds), AGENT_MAX_ROUNDS_LIMIT);
  }
  if (!profile.description) {
    for (const line of body.split('\n')) {
      const candidate = line.trim();
      if (!candidate) continue;
      if (candidate.startsWith('#')) continue;
      if (candidate.startsWith('>')) continue;
      profile.description = truncateText(candidate, AGENT_DESCRIPTION_MAX);
      break;
    }
  }
  return profile;
}

// 纯函数：系统提示里的分身清单段（空列表 → 空串，调用方据此不注入）。
export function workspaceAgentsSection(agents) {
  const list = (Array.isArray(agents) ? agents : []).filter(item => item && String(item.name || '').trim());
  if (list.length === 0) return '';
  // 按名字排序后截断——清单稳定可比（顺序不依赖文件枚举，缓存前缀才稳）。
  const sorted = [...list].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const shown = sorted.slice(0, AGENT_LIST_MAX);
  const lines = [
    `【子代理分身】这个工作区定义了 ${list.length} 个分身（run_subagent 的 agent 参数按名字选用）：`,
    ...shown.map(item => {
      const rounds = Number.isFinite(item.maxRounds) ? `（${item.maxRounds} 轮上限）` : '';
      return `- ${String(item.name).trim()}：${truncateText(item.description, AGENT_DESCRIPTION_MAX) || '（无描述）'}${rounds}`;
    }),
  ];
  if (sorted.length > shown.length) {
    lines.push(`（按名字排序仅列出前 ${shown.length} 个，还有 ${sorted.length - shown.length} 个——可用 list_workspace_files 查看 ${AGENTS_DIR}/ 下的全部档案）`);
  }
  return lines.join('\n');
}

// 从 listWorkspaceFiles 的输出里挑出分身档案：`.easychat/agents/<name>.md`（一级）。
export function pickAgentFiles(entries) {
  const prefix = `${AGENTS_DIR}/`;
  const found = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const path = String(entry || '');
    if (!path.startsWith(prefix) || path.endsWith('/')) continue;
    const rest = path.slice(prefix.length);
    const match = rest.match(/^([^/]+)\.md$/i);
    if (!match) continue;
    found.push({ name: match[1], path });
  }
  return found;
}

// 从工作区读全部档案（或按名字取一个）。单个坏文件只跳过它——一个坏档案不该
// 让整张分身清单消失（与技能清单同款）。
export async function readWorkspaceAgents(store, characterId, names = null) {
  if (!store || typeof store.listWorkspaceFiles !== 'function') return [];
  let entries = [];
  try {
    entries = await store.listWorkspaceFiles({ characterId, subdir: AGENTS_DIR });
  } catch (error) {
    return [];
  }
  const wanted = Array.isArray(names) && names.length
    ? new Set(names.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))
    : null;
  const files = pickAgentFiles(entries).filter(file => !wanted || wanted.has(file.name.toLowerCase()));
  const profiles = [];
  for (const file of files) {
    try {
      const result = await store.readWorkspaceFile({
        characterId,
        path: file.path,
        maxChars: AGENT_HEAD_CHARS,
      });
      const parsed = parseAgentMarkdown(result && result.content, file.name);
      profiles.push({ ...parsed, name: parsed.name || file.name, path: file.path });
    } catch (error) {}
  }
  return profiles;
}
