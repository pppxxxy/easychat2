// 工作区斜杠命令（spec 2026-10-09-agent-extensibility T5）。
//
// 形态：用户在**工作区输入框**打 `/name 参数…`，发送时把命令模板展开成真实提示词
// 发给模型；聊天气泡仍显示用户输入原文（`/name 参数`）——展开是给模型的，不是给界面的。
//
// 存放：`.easychat/commands/<name>.md`（与技能同域；文件名即命令名）。
// 文件格式：
//   ---
//   description: 一句话说明（输入框建议列表里显示）
//   ---
//   模板正文，`$ARGUMENTS` 会被替换成命令后面的参数原文。
//
// 三个设计决策：
// 1. **命令不进系统提示**（与技能不同）：命令是用户侧功能，模型不需要知道有哪些——
//    只有展开后的文本进请求，省掉一份清单的 token；
// 2. **未命中命令名一律不展开**：以 `/` 开头的普通文本（如路径 /a/b）原样发送，
//    绝不猜测——猜错的代价是用户的话被静默改写；
// 3. **无 `$ARGUMENTS` 占位符时参数追加到末尾**：不丢用户输入（写了参数却没用上
//    是最让人困惑的一种"没反应"）。

import { splitMarkdownFrontmatter } from './markdownFrontmatter.js';

export const COMMANDS_DIR = '.easychat/commands';
export const COMMAND_NAME_MAX = 32;
export const COMMAND_DESCRIPTION_MAX = 120;
export const COMMAND_LIST_MAX = 20;
export const COMMAND_ARGUMENTS_TOKEN = '$ARGUMENTS';

function truncateText(value, max) {
  const text = String(value == null ? '' : value).trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// 纯函数：<name>.md 全文 → { name, description, template }。
// name 取文件名（fallbackName）；frontmatter 的 name 可覆盖显示名（但命令词以文件名为准）。
export function parseCommandMarkdown(text, fallbackName = '') {
  const parsed = splitMarkdownFrontmatter(text);
  return {
    name: truncateText(fallbackName, COMMAND_NAME_MAX),
    displayName: truncateText(parsed.meta.name, COMMAND_NAME_MAX),
    description: truncateText(parsed.meta.description, COMMAND_DESCRIPTION_MAX),
    template: parsed.body.trim(),
  };
}

// 从 listWorkspaceFiles 的输出里挑出命令文件：`.easychat/commands/<name>.md`（不递归子目录）。
export function pickCommandFiles(entries) {
  const prefix = `${COMMANDS_DIR}/`;
  const found = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const path = String(entry || '');
    if (!path.startsWith(prefix) || path.endsWith('/')) continue;
    const match = path.slice(prefix.length).match(/^([^/]+)\.md$/i);
    if (!match) continue;
    found.push({ name: match[1], path });
  }
  return found;
}

// IO：列出工作区命令（list 一次 + 逐个**读全文**）；单个坏文件只跳过它。
// 读全文而不是只读头部：展开要用完整模板，截断模板比多读几百字节的代价大得多
//（命令文件在设计上就是短指令，正常远小于 store 的读取上限）。
export async function readWorkspaceCommands(store, characterId) {
  if (!store || typeof store.listWorkspaceFiles !== 'function') return [];
  let entries = [];
  try {
    entries = await store.listWorkspaceFiles({ characterId, subdir: COMMANDS_DIR });
  } catch (error) {
    return [];
  }
  const files = pickCommandFiles(entries);
  const commands = [];
  for (const file of files) {
    try {
      const result = await store.readWorkspaceFile({ characterId, path: file.path });
      const parsed = parseCommandMarkdown(result && result.content, file.name);
      if (!parsed.name) parsed.name = file.name;
      commands.push({ ...parsed, path: file.path });
    } catch (error) {}
  }
  return commands;
}

// 纯函数：把模板渲染成发给模型的文本。
export function renderCommandTemplate(template, args) {
  const text = String(template == null ? '' : template).trim();
  const value = String(args == null ? '' : args).trim();
  if (text.includes(COMMAND_ARGUMENTS_TOKEN)) {
    return text.split(COMMAND_ARGUMENTS_TOKEN).join(value).trim();
  }
  if (!value) return text;
  return `${text}\n\n${value}`;
}

// 纯函数：输入框内容的「命令名补全查询」——以 / 开头且还没打出空格时返回 / 之后的片段，
// 否则 null（已经在写参数、或不是命令形态，建议列表就该收起来）。
export function slashQuery(input) {
  const text = String(input == null ? '' : input);
  if (!text.startsWith('/')) return null;
  const rest = text.slice(1);
  if (rest.includes(' ') || rest.includes('\n') || rest.includes('\t')) return null;
  return rest;
}

// 纯函数：按查询过滤命令（前缀匹配、大小写不敏感；空查询 = 全部）。
export function matchSlashCommands(commands, query) {
  const list = Array.isArray(commands) ? commands : [];
  const q = String(query == null ? '' : query).toLowerCase();
  return list
    .filter(item => item && String(item.name || '').trim())
    .filter(item => !q || String(item.name).toLowerCase().startsWith(q))
    .slice(0, COMMAND_LIST_MAX);
}

// 纯函数：把一条完整输入展开成发给模型的文本。
// 命中返回 { name, args, text }；不是命令形态或命令不存在返回 null（原样发送）。
export function expandSlashCommand(input, commands) {
  const trimmed = String(input == null ? '' : input).trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.slice(1).match(/^([^\s/]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1];
  const args = String(match[2] || '').trim();
  const command = (Array.isArray(commands) ? commands : []).find(item => (
    item && String(item.name || '').toLowerCase() === name.toLowerCase()
  ));
  if (!command) return null;
  return {
    name: command.name,
    args,
    text: renderCommandTemplate(command.template, args),
  };
}

// IO：安装示例命令（幂等：同名的绝不覆盖）。
export async function installSampleCommands(store, characterId) {
  if (!store || typeof store.writeWorkspaceFile !== 'function') return 0;
  let installed = 0;
  for (const sample of SAMPLE_COMMANDS) {
    const path = `${COMMANDS_DIR}/${sample.name}.md`;
    try {
      await store.readWorkspaceFile({ characterId, path });
      continue; // 已有：跳过，不覆盖
    } catch (error) {
      // 不存在 → 继续安装
    }
    try {
      await store.writeWorkspaceFile({ characterId, path, content: sample.markdown });
      installed += 1;
    } catch (error) {}
  }
  return installed;
}

// 内置示例（3 个）。模板是**发给模型的提示词**，按仓库铁律不进 i18n 词条表。
export const SAMPLE_COMMANDS = Object.freeze([
  {
    name: 'weekly',
    markdown: [
      '---',
      'description: 把素材整理成本周周报',
      '---',
      '按 .easychat/skills/weekly-report/SKILL.md 里的流程，把下面的素材整理成周报（先给结论段，再展开明细）：',
      '',
      '$ARGUMENTS',
      '',
    ].join('\n'),
  },
  {
    name: 'polish',
    markdown: [
      '---',
      'description: 润色一段文字，保留原意',
      '---',
      '把下面这段文字润色一遍：保持原意与信息量不变，去掉口头语与重复，让每句话更短。只输出润色后的文本，不要解释改了什么：',
      '',
      '$ARGUMENTS',
      '',
    ].join('\n'),
  },
  {
    name: 'explain',
    markdown: [
      '---',
      'description: 用「结论 + 步骤」解释一段代码或报错',
      '---',
      '解释下面的代码或报错：先一句话说结论，再按执行顺序讲关键点，最后指出容易踩的坑。不要逐行翻译：',
      '',
      '$ARGUMENTS',
      '',
    ].join('\n'),
  },
  {
    // A6（能力升级任务书）：零新代码的跨会话经验沉淀——组合 T5（命令）+ T2（AGENTS.md）：
    // 对话里谈定的长期约定，一条命令固化成下一轮起就生效的工作区记忆。
    name: 'remember',
    markdown: [
      '---',
      'description: 提炼长期约定并写入 AGENTS.md',
      '---',
      '把本次对话里已经确认的**长期有效**约定提炼出来（最多 3 条，每条一句话），先列给我确认；',
      '我回复确认后，用编辑工具把它们写进 AGENTS.md 的「约定与偏好」一节（没有这一节就新建），',
      '不要覆盖或改写已有条目。已经写过的约定不要重复写：',
      '',
      '$ARGUMENTS',
      '',
    ].join('\n'),
  },
]);
