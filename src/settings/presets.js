// 内置全局文本预设（9 条）。
//
// 为什么导出的是**定义**（id + i18n key）而不是成品对象：
//   - name / description 是用户可见文案，必须随界面语言走；
//   - prompt 是**发给模型的提示词**，按仓库铁律不进 i18n（翻译它会改变模型行为）。
// 两者原本混在同一个导出常量里，于是「模块级导出常量不得硬编码中文」这条 lint 规则
// 把提示词也当成待迁移文案（32 处违规里大半是提示词）。
// 现在：提示词挪进**未导出**的 BUILTIN_PROMPTS（规则明确不查未导出常量，工具描述同因），
// 导出的是 nameKey / descriptionKey；成品由 builtinGlobalPresets() 按当前语言组装。
//
// 语言切换行为：内置预设是**每次读取时**翻译的（getGlobalPresets 只在缺失/损坏时返回
// 默认值，并不落盘），所以切语言后内置项的名称与描述会立刻跟着变；用户自己改过的名称
// 存在 @easychat2_preset_list 里，不受影响。

import { tActive } from '../i18n/index.js';

const BUILTIN_PROMPTS = Object.freeze({
  immersive:
    '始终以角色的身份、语气与世界观回应，保持沉浸感。不要以 AI 助手或旁白的口吻跳出角色，也不要提及角色卡、提示词、系统设定等元信息。',
  'no-user-act':
    '不要替 {{user}} 说话、行动或做决定。{{user}} 的言行请留给 {{user}} 自己，你只需描写角色和周围环境的反应。',
  'rich-senses':
    '在描写中自然加入视觉、听觉、触觉、气味和氛围等感官细节，让场景更生动，但不要拖慢剧情推进。',
  'no-repeat':
    '不要复述、总结或改写 {{user}} 已经说过的内容，直接以角色的新反应和行动推进剧情。',
  concise:
    '每次回复控制在一到三段之间，抓住重点，避免冗长堆砌和重复铺陈。',
  paragraphs:
    '输出时请自然分段：对白、动作与场景描写尽量各成段落，一个段落只表达一个焦点，段落之间用空行隔开，不要把大段内容全挤在一个段落里。',
  'zh-cn': '无论输入使用何种语言，始终使用简体中文回复。',
  'character-state':
    '每次回复的末尾用一行附上角色的当前状态，格式为：[心情: ...][好感度: 0-100][内心想法: ...]。心情用一个词概括，好感度随互动合理变化，内心想法控制在 30 字以内。',
  kaomoji:
    '请根据角色性格与当前语境，自然地使用颜文字来传递情绪，让心理活动与反应更鲜活。使用要点：\n'
    + '1. 按情绪挑选：开心可用 (≧▽≦)、(￣▽￣)～*、(๑˃̵ᴗ˂̵)，害羞可用 (*/ω＼*)、(⁄ ⁄•⁄ω⁄•⁄ ⁄)，无奈可用 (￣_￣|||)、(・_・;)，疑惑可用 (・∀・)？、(￣～￣)，生气可用 (╯°□°）╯、(¬_¬)，委屈可用 (´；ω；｀)、(｡•́︿•̀｡)，惊讶可用 (°ロ°)、(⊙_⊙)。\n'
    + '2. 讲究搭配：颜文字通常放在句末或单独成行，与前后文字留一个空格；同一句里最多用一个，不要连续堆叠。\n'
    + '3. 贴合角色：活泼角色可以更频繁，冷静或严肃的角色应更克制，用词与颜文字风格保持一致。\n'
    + '4. 分清场合：正式、沉重、悲伤或紧张的剧情中避免或用极少的颜文字，不要削弱氛围。\n'
    + '5. 保持可读：颜文字是点缀而非主体，不影响原意，也不要每句话都使用。',
});

export const GLOBAL_PRESETS = Object.freeze([
  { id: 'immersive', nameKey: 'preset.builtin.immersive.name', descriptionKey: 'preset.builtin.immersive.description' },
  { id: 'no-user-act', nameKey: 'preset.builtin.noUserAct.name', descriptionKey: 'preset.builtin.noUserAct.description' },
  { id: 'rich-senses', nameKey: 'preset.builtin.richSenses.name', descriptionKey: 'preset.builtin.richSenses.description' },
  { id: 'no-repeat', nameKey: 'preset.builtin.noRepeat.name', descriptionKey: 'preset.builtin.noRepeat.description' },
  { id: 'concise', nameKey: 'preset.builtin.concise.name', descriptionKey: 'preset.builtin.concise.description' },
  { id: 'paragraphs', nameKey: 'preset.builtin.paragraphs.name', descriptionKey: 'preset.builtin.paragraphs.description' },
  { id: 'zh-cn', nameKey: 'preset.builtin.zhCn.name', descriptionKey: 'preset.builtin.zhCn.description' },
  { id: 'character-state', nameKey: 'preset.builtin.characterState.name', descriptionKey: 'preset.builtin.characterState.description' },
  { id: 'kaomoji', nameKey: 'preset.builtin.kaomoji.name', descriptionKey: 'preset.builtin.kaomoji.description' },
]);

// 组装成品：名称/描述按当前语言，提示词原样（模型输入，不翻译）。
export function builtinGlobalPresets() {
  return GLOBAL_PRESETS.map(def => ({
    id: def.id,
    name: tActive(def.nameKey),
    description: tActive(def.descriptionKey),
    prompt: BUILTIN_PROMPTS[def.id] || '',
  }));
}

// 提示词表的只读视图：给测试与「内置预设的提示词是否被误翻译」这类检查用。
export function builtinPresetPrompts() {
  return { ...BUILTIN_PROMPTS };
}

export default GLOBAL_PRESETS;
