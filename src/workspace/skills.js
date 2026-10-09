// 工作区技能（SKILL.md 渐进披露，spec 2026-10-09-agent-extensibility T4）。
//
// 对齐 Claude Code 的 Skills 机制，但**零新工具**：
// - 第一层（清单）：每轮系统提示里只注入「技能名 + 一句话描述」——几十个技能也就几行；
// - 第二层（全文）：模型要用某个技能时，用**现有的 read_workspace_file** 读它的
//   SKILL.md——不需要任何新的读取工具，天然复用分页读取；
// - 第三层（附件）：技能目录里的其它文件同样用 read 工具按需读（下一轮做 UI 时才提）。
//
// 存放：`.easychat/skills/<技能名>/SKILL.md`（与将来的 env.json 同属 .easychat 域；
// 点开头的目录在手机文件管理器里默认隐藏，日常视图不被污染）。
// 技能名 = 目录名（slug 形态），SKILL.md 的 frontmatter 可覆盖显示名与描述。
//
// 与 T2 记忆文件同款原则：**每轮直读，不缓存**——agent 刚创建的技能下一轮就要能用。
// 成本可忽略：先 list 一次技能目录（不存在 = 1 次 IO 直接空），有技能才逐个读头部。

import { splitMarkdownFrontmatter } from './markdownFrontmatter.js';

export const SKILLS_DIR = '.easychat/skills';
export const SKILL_FILE_NAME = 'SKILL.md';
export const SKILL_NAME_MAX = 48;
export const SKILL_DESCRIPTION_MAX = 160;
// 清单注入上限：超出只列前 N 个（技能面板里能看到全部）——提示词不能被技能清单撑爆。
export const SKILL_LIST_MAX = 20;
// 解析 frontmatter 只需头部；技能正文再长也走 read 工具按需读。
export const SKILL_HEAD_CHARS = 1200;

function truncateText(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 纯函数：SKILL.md 全文 → { name, description }。
// 没有 frontmatter 时退化：name 用目录名（fallbackName），description 取正文里
// 第一个「非空、非标题、非引用」行——技能文件可以完全不带元数据也能用。
export function parseSkillMarkdown(text, fallbackName = '') {
  const parsed = splitMarkdownFrontmatter(text);
  const meta = parsed.meta;
  const body = parsed.body;
  const skill = {
    name: truncateText(meta.name || fallbackName, SKILL_NAME_MAX),
    description: truncateText(meta.description, SKILL_DESCRIPTION_MAX),
  };
  if (!skill.description) {
    for (const line of body.split('\n')) {
      const candidate = line.trim();
      if (!candidate) continue;
      if (candidate.startsWith('#')) continue;
      if (candidate.startsWith('>')) continue;
      skill.description = truncateText(candidate, SKILL_DESCRIPTION_MAX);
      break;
    }
  }
  return skill;
}

// 纯函数：系统提示里的技能清单段（空列表 → 空串，调用方据此不注入）。
export function workspaceSkillsSection(skills) {
  const list = (Array.isArray(skills) ? skills : []).filter(item => item && String(item.name || '').trim());
  if (list.length === 0) return '';
  const shown = list.slice(0, SKILL_LIST_MAX);
  const lines = [
    `【工作区技能】这个工作区里有 ${list.length} 个技能，完整说明在 ${SKILLS_DIR}/<技能名>/${SKILL_FILE_NAME}：`,
    ...shown.map(item => `- ${String(item.name).trim()}：${truncateText(item.description, SKILL_DESCRIPTION_MAX) || '（无描述）'}`),
  ];
  if (list.length > shown.length) lines.push(`（仅列出前 ${shown.length} 个，其余在技能目录里）`);
  lines.push(`需要用到某个技能时，先用 read_workspace_file 读它的 ${SKILL_FILE_NAME} 全文，再按其中的步骤做；不要凭清单里的名字猜测内容。`);
  return lines.join('\n');
}

// 从 listWorkspaceFiles 的输出里挑出技能文件：`.easychat/skills/<name>/SKILL.md`。
export function pickSkillFiles(entries) {
  const prefix = `${SKILLS_DIR}/`;
  const found = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const path = String(entry || '');
    if (!path.startsWith(prefix) || path.endsWith('/')) continue;
    const match = path.slice(prefix.length).match(/^([^/]+)\/SKILL\.md$/i);
    if (!match) continue;
    found.push({ dirName: match[1], path });
  }
  return found;
}

// IO：列出工作区技能（list 一次 + 逐个读头部解析）。
// 单个技能读失败只跳过它——一个坏文件不该让整张技能清单消失。
export async function readWorkspaceSkills(store, characterId) {
  if (!store || typeof store.listWorkspaceFiles !== 'function') return [];
  let entries = [];
  try {
    entries = await store.listWorkspaceFiles({ characterId, subdir: SKILLS_DIR });
  } catch (error) {
    return [];
  }
  const files = pickSkillFiles(entries);
  const skills = [];
  for (const file of files) {
    try {
      const result = await store.readWorkspaceFile({ characterId, path: file.path, maxChars: SKILL_HEAD_CHARS });
      const parsed = parseSkillMarkdown(result && result.content, file.dirName);
      if (!parsed.name) parsed.name = file.dirName;
      skills.push({ ...parsed, path: file.path, dirName: file.dirName });
    } catch (error) {}
  }
  return skills;
}

// IO：安装示例技能（幂等：已存在的技能目录整目录跳过，绝不覆盖用户改过的内容）。
// 返回这次真正写入的数量。
export async function installSampleSkills(store, characterId) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return 0;
  let installed = 0;
  for (const sample of SAMPLE_SKILLS) {
    const path = `${SKILLS_DIR}/${sample.name}/${SKILL_FILE_NAME}`;
    try {
      await store.readWorkspaceFile({ characterId, path });
      continue; // 已有（哪怕空文件）：跳过，不覆盖
    } catch (error) {
      // 不存在 → 继续安装；其它读取错误在写入时再暴露。
    }
    try {
      await store.writeWorkspaceFile({ characterId, path, content: sample.markdown });
      installed += 1;
    } catch (error) {}
  }
  return installed;
}

// 内置示例（3 个，覆盖「流程型 / 清单型 / 产物型」三种技能形态）。
// 内容是**发给模型的提示词**，按仓库铁律不进 i18n 词条表（与记忆模板同款处理）。
export const SAMPLE_SKILLS = Object.freeze([
  {
    name: 'weekly-report',
    markdown: [
      '---',
      'name: 周报整理',
      'description: 把零散的进展与待办整理成结构化周报（Markdown 或 Word）',
      '---',
      '',
      '# 周报整理流程',
      '',
      '## 步骤',
      '1. 先读工作区里与本周相关的文件（进展记录、提交说明、待办清单），不要向用户复述已知内容；',
      '2. 按「本周完成 / 进行中 / 下周计划 / 风险与阻塞」四段组织；',
      '3. 每条用「做了什么 → 结果/影响」写清，避免只写动作不写结果；',
      '4. 需要交付 Word 版时，先写入一个 .md 文件，再用 export_workspace_docx 导出。',
      '',
      '## 约定',
      '- 不确定的事项标注「（待确认）」，不要替用户编造数字；',
      '- 先给结论段（两三句），再展开明细。',
      '',
    ].join('\n'),
  },
  {
    name: 'code-review',
    markdown: [
      '---',
      'name: 代码审查',
      'description: 用固定清单审查工作区代码，按统一格式给出行级意见',
      '---',
      '',
      '# 代码审查清单',
      '',
      '## 检查项',
      '1. 正确性：边界条件、空值、错误分支是否处理；',
      '2. 安全：拼接的路径/命令是否可被外部输入注入；',
      '3. 可读性：命名是否表达意图；嵌套是否超过三层；',
      '4. 一致性：与同目录既有代码的风格是否一致（先读两个邻居文件再下结论）。',
      '',
      '## 输出格式',
      '- 每行意见：`文件:行号 — 问题 — 建议`；',
      '- 按严重级别排序（错误 > 风险 > 建议）；',
      '- 只报确定的问题，不确定的放进「需要作者确认」列表。',
      '',
    ].join('\n'),
  },
  {
    name: 'docx-export',
    markdown: [
      '---',
      'name: 文档导出',
      'description: 把整理好的内容导出成排版干净的 Word 文档',
      '---',
      '',
      '# 文档导出流程',
      '',
      '1. 先把内容审一遍：标题层级只用 # / ## / ###，列表保持同层一致；',
      '2. 写入源文件（文件名用中文可读名，如 `季度总结.md`）；',
      '3. 调用 export_workspace_docx 导出同名 .docx；',
      '4. 导出后把生成的文件路径告诉用户，并提醒可在文件面板里分享。',
      '',
      '## 约定',
      '- 不要为了排版塞空行或全角空格；',
      '- 表格用标准 Markdown 表格，导出的 Word 会保留。',
      '',
    ].join('\n'),
  },
]);
