// skill 工具（对齐 Claude Code 的 Skill）：按名字加载一个工作区技能的完整内容。
// 技能清单已在系统提示里（渐进披露第一层：名字 + 描述）；本工具是第二层——
// 模型需要某个技能时直接按名字取全文，不必自己拼 `.easychat/skills/<名>/SKILL.md` 路径。

import { readWorkspaceSkills } from '../skills.js';

export const SKILL_TOOL_DEFINITION = {
  name: 'skill',
  description: '按名字加载一个工作区技能的完整说明（步骤/脚本）。系统提示里列了可用技能的名字与'
    + '描述；需要用到某个技能时用本工具取它的全文，再按其中步骤执行。',
  readOnly: true,
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '技能名（见系统提示的技能清单）。' } },
    required: ['name'],
  },
  execute: async (options, args, ctx) => {
    const name = String((args && args.name) || '').trim();
    if (!name) return { content: 'skill 需要 name。', isError: true };
    const skills = await readWorkspaceSkills(options.store, ctx && ctx.characterId).catch(() => []);
    const skill = (Array.isArray(skills) ? skills : []).find(item => (
      item && (String(item.name || '') === name || String(item.dirName || '') === name)
    ));
    if (!skill || !skill.path) return { content: `没有名为「${name}」的技能（用 list_workspace_files 看 .easychat/skills/ 下的目录）。`, isError: true };
    const result = await options.store.readWorkspaceFile({
      characterId: ctx && ctx.characterId,
      path: skill.path,
    });
    const content = String((result && result.content) || '');
    return { content: content || '（技能内容为空）' };
  },
};
