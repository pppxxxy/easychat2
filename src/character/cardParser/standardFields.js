// 标准字段抽取与系统提示词拼装。纯函数。
import { firstString, isPlainObject, toStringArray, toStringList } from './normalizeUtils.js';

function toDialogStringArray(value) {
  const result = [];
  const visit = item => {
    if (typeof item === 'string') {
      const text = item.trim();
      if (text) result.push(text);
      return;
    }
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!isPlainObject(item)) return;
    const direct = firstString([item], ['text', 'greeting', 'content', 'message', 'value']);
    if (direct) {
      result.push(direct);
      return;
    }
    Object.values(item).forEach(visit);
  };
  visit(value);
  return result;
}

export function extractStandardFields(root, data, extensions) {
  const standardName = firstString([data, root], ['name', 'char_name', 'charName']);
  const standardFirstMes = firstString(
    [data, root],
    ['first_mes', 'firstMes', 'first_message']
  );
  const standardAlternates = toStringList(
    data?.alternate_greetings ?? root?.alternate_greetings ?? data?.alternateGreetings
  );
  const standardSystemPrompt = firstString([data, root], ['system_prompt', 'systemPrompt']);
  const zhiyuSetting = firstString(
    [data, root],
    ['setting', 'agent_setting', 'character_setting', 'role_setting']
  );
  return {
    name: standardName || firstString([data, root], ['nickname', 'agent_nickname']),
    description: firstString(
      [data, root],
      ['description', 'char_persona', 'charPersona']
    ),
    personality: firstString([data, root], ['personality', 'char_personality']),
    scenario: firstString(
      [data, root],
      ['scenario', 'world_scenario', 'worldScenario']
    ),
    firstMes: standardFirstMes || firstString([data, root], ['greeting', 'agent_greeting']),
    alternateGreetings: standardAlternates.length > 0
      ? standardAlternates
      : toDialogStringArray(data?.preset_dialogs ?? root?.preset_dialogs),
    mesExample: firstString(
      [data, root],
      ['mes_example', 'mesExample', 'example_dialogue', 'exampleMessages']
    ),
    creatorNotes: firstString(
      [data, root, extensions],
      ['creator_notes', 'creatorNotes', 'creator_comment', 'creatorcomment']
    ),
    systemPrompt: standardSystemPrompt || zhiyuSetting,
    postHistoryInstructions: firstString(
      [data, root],
      ['post_history_instructions', 'postHistoryInstructions']
    ),
    tags: toStringArray(data?.tags ?? root?.tags),
  };
}

export function buildSystemPrompt(fields) {
  const sections = [
    ['角色描述', fields.description],
    ['性格', fields.personality],
    ['场景', fields.scenario],
    ['系统提示', fields.systemPrompt],
    ['历史后指令', fields.postHistoryInstructions],
  ];
  return sections
    .filter(([, text]) => text && text.trim())
    .map(([label, text]) => `[${label}]\n${text.trim()}`)
    .join('\n\n');
}
