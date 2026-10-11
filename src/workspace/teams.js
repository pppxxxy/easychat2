// 持久化 agent 团队（spec 2026-10-11-workspace-parity 多智能体）：
// `.easychat/teams/<name>.md`，与 skills.js/agents.js 同款的渐进披露与「每轮直读」原则。
//
// 一个团队 = 一份**保存好的工作流**：把常用的多步编排（谁先查、谁后综合、各用哪个分身）
// 存成文件，跨会话复用——`run_team({ team })` 按名字取来跑，不必每次重述步骤。
//
// 文件格式：
//   ---
//   name: 调研小组
//   description: 并行调研后综合（一句话，注入清单）
//   ---
//   - id: a | task: 调研 X 的实现 | agent: researcher
//   - id: b | task: 调研 Y 的实现 | agent: researcher
//   - id: c | task: 综合 a 与 b | dependsOn: a, b
//
// 每步一行，以 `-` 起头，字段用 ` | ` 分隔、`key: value`（key 大小写不敏感）：
//   id / task（必填）/ agent（.easychat/agents 里的分身名）/ dependsOn（逗号分隔）/ mode（read|write）。
// task 里不要出现 ` | `（会被当字段分隔符）；task 内的冒号无妨（只按第一个冒号切键值）。

import { splitMarkdownFrontmatter } from './markdownFrontmatter.js';

export const TEAMS_DIR = '.easychat/teams';
export const TEAM_NAME_MAX = 48;
export const TEAM_DESCRIPTION_MAX = 160;
export const TEAM_LIST_MAX = 12;
// 与 WORKFLOW_MAX_STEPS 对齐：团队本质是保存好的工作流，步数上限同源。
export const TEAM_MAX_STEPS = 8;
// 解析 frontmatter + 步骤行只需头部；超长正文截断。
export const TEAM_HEAD_CHARS = 4000;

function truncateText(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 纯函数：团队正文 → 步骤数组（[{ id, task, agent?, dependsOn, mode }]）。
export function parseTeamSteps(body) {
  const steps = [];
  for (const rawLine of String(body || '').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('-')) continue;
    const segments = line.replace(/^-\s*/, '').split('|');
    const step = { id: '', task: '', agent: '', dependsOn: [], mode: 'read' };
    for (const segment of segments) {
      const idx = segment.indexOf(':');
      if (idx < 0) continue;
      const key = segment.slice(0, idx).trim().toLowerCase();
      const value = segment.slice(idx + 1).trim();
      if (key === 'id') step.id = value;
      else if (key === 'task') step.task = value;
      else if (key === 'agent') step.agent = value;
      else if (key === 'mode') step.mode = value.toLowerCase() === 'write' ? 'write' : 'read';
      else if (key === 'dependson' || key === 'depends-on') {
        step.dependsOn = value.split(',').map(item => item.trim()).filter(Boolean);
      }
    }
    if (step.task) {
      if (!step.id) step.id = `step-${steps.length + 1}`;
      steps.push(step);
    }
    if (steps.length >= TEAM_MAX_STEPS) break;
  }
  return steps;
}

// 纯函数：团队档案全文 → { name, description, steps }。无 frontmatter 也能用。
export function parseTeamMarkdown(text, fallbackName = '') {
  const parsed = splitMarkdownFrontmatter(text);
  const meta = parsed.meta || {};
  const body = parsed.body || '';
  const team = {
    name: truncateText(meta.name || fallbackName, TEAM_NAME_MAX),
    description: truncateText(meta.description, TEAM_DESCRIPTION_MAX),
    steps: parseTeamSteps(body),
  };
  if (!team.description) {
    for (const line of body.split('\n')) {
      const candidate = line.trim();
      if (!candidate || candidate.startsWith('-') || candidate.startsWith('#') || candidate.startsWith('>')) continue;
      team.description = truncateText(candidate, TEAM_DESCRIPTION_MAX);
      break;
    }
  }
  return team;
}

// 纯函数：系统提示里的团队清单段（空列表 → 空串，调用方据此不注入）。
export function workspaceTeamsSection(teams) {
  const list = (Array.isArray(teams) ? teams : []).filter(item => item && String(item.name || '').trim());
  if (list.length === 0) return '';
  const sorted = [...list].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const shown = sorted.slice(0, TEAM_LIST_MAX);
  const lines = [
    `【工作区团队】这个工作区保存了 ${list.length} 个团队（run_team 的 team 参数按名字选用）：`,
    ...shown.map(item => {
      const count = Array.isArray(item.steps) ? item.steps.length : 0;
      return `- ${String(item.name).trim()}：${truncateText(item.description, TEAM_DESCRIPTION_MAX) || '（无描述）'}（${count} 步）`;
    }),
  ];
  if (sorted.length > shown.length) {
    lines.push(`（按名字排序仅列出前 ${shown.length} 个，还有 ${sorted.length - shown.length} 个——可用 list_workspace_files 查看 ${TEAMS_DIR}/ 下的全部团队）`);
  }
  lines.push('需要跑某个团队时用 run_team（它会按团队文件里的步骤编排子代理）。');
  return lines.join('\n');
}

// 从 listWorkspaceFiles 的输出里挑出团队档案：`.easychat/teams/<name>.md`（一级）。
export function pickTeamFiles(entries) {
  const prefix = `${TEAMS_DIR}/`;
  const found = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const path = String(entry || '');
    if (!path.startsWith(prefix) || path.endsWith('/')) continue;
    const match = path.slice(prefix.length).match(/^([^/]+)\.md$/i);
    if (!match) continue;
    found.push({ dirName: match[1], path });
  }
  return found;
}

// IO：列出工作区团队（list 一次 + 逐个读头部解析）。单个坏文件只跳过它。
export async function readWorkspaceTeams(store, characterId, names = null) {
  if (!store || typeof store.listWorkspaceFiles !== 'function') return [];
  let entries = [];
  try {
    entries = await store.listWorkspaceFiles({ characterId, subdir: TEAMS_DIR });
  } catch (error) {
    return [];
  }
  const wanted = Array.isArray(names) && names.length
    ? new Set(names.map(item => String(item || '').trim().toLowerCase()).filter(Boolean))
    : null;
  const files = pickTeamFiles(entries).filter(file => !wanted || wanted.has(file.dirName.toLowerCase()));
  const teams = [];
  for (const file of files) {
    try {
      const result = await store.readWorkspaceFile({ characterId, path: file.path, maxChars: TEAM_HEAD_CHARS });
      const parsed = parseTeamMarkdown(result && result.content, file.dirName);
      teams.push({ ...parsed, name: parsed.name || file.dirName, dirName: file.dirName, path: file.path });
    } catch (error) {}
  }
  return teams;
}

// IO：安装示例团队（幂等：已存在的整文件跳过，绝不覆盖用户改过的内容）。返回写入数量。
export async function installSampleTeams(store, characterId) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return 0;
  let installed = 0;
  for (const sample of SAMPLE_TEAMS) {
    const path = `${TEAMS_DIR}/${sample.fileName}.md`;
    try {
      const existing = await store.readWorkspaceFile({ characterId, path });
      if (existing && String(existing.content || '').trim()) continue;
    } catch (error) {}
    try {
      await store.writeWorkspaceFile({ characterId, path, content: sample.content });
      installed += 1;
    } catch (error) {}
  }
  return installed;
}

export const SAMPLE_TEAMS = Object.freeze([
  {
    fileName: 'research-and-synthesize',
    content: [
      '---',
      'name: 调研并综合',
      'description: 两路并行调研后综合成一份结论',
      '---',
      '- id: a | task: 调研主题 A 的关键实现与取舍',
      '- id: b | task: 调研主题 B 的关键实现与取舍',
      '- id: c | task: 综合 A 与 B 的结论，给出最终建议 | dependsOn: a, b',
    ].join('\n'),
  },
]);
