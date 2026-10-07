// Whole-card generation, editing, advanced content and repair prompts.

import { requestedAdvancedSections, summarizeAnswers } from './state.js';
import { clean } from './shared.js';
import { projectForgeDraft } from './draft.js';

// 世界书字段规则。整卡生成与「补写高级内容」两步共用，避免两处各写一遍后提示词漂移。
function buildWorldInfoRules() {
  return [
    '- worldInfo：世界书条目数组，每项 {comment, keys, content, constant, position, depth, enabled:true}，共写 6-12 条。字段规则：',
    '  · keys：2-4 个触发关键词，选「只在谈到该话题时才会出现的具体词」（如种族名、组织名、地名、人名），禁止使用「你、我、他、她、非常、突然」这类每句话都可能出现的高频词。',
    '  · constant：true 表示常驻注入（无需关键词命中，每一轮都生效）；false 表示关键词触发。',
    '  · position：0=角色定义之前，1=角色定义之后，4=按深度插入（配 depth 数字，表示插入到倒数第 depth 条消息附近）。',
    '  · content：第三人称客观陈述设定事实，不写对话，不写「她会告诉你」这类元描述。',
    '内容组织：',
    '  · 第 1 条必须是总览：comment 写「世界观总览」，constant:true，position:0，keys 可为空数组，content 100-200 字概括世界基调、时代背景、核心冲突。',
    '  · 其余条目全部 constant:false、position:1（紧贴角色定义，适合设定条目）；只有「随对话递进揭晓的真相/秘密」类条目用 position:4、depth:4。',
    '  · 每条只讲一个主题：种族、组织、地点、历史事件、力量/等级体系、规则与禁忌分别成条。',
    '  · 每条 content 80-200 字，要写「具体内容」：例如「等级体系」要写清有哪些等级、各等级特征、晋升条件；「种族」要写清有哪些种族、各自特点与相互关系。',
    '  · 条目之间不要重复；总览只做铺垫，细节留给触发条目。',
  ].join('\n');
}

// 正则字段规则：JS RegExp（非 PCRE）方言、flags、替换语义、placement 与两种 Only 开关。
function buildRegexRules() {
  return [
    '- regexScripts：正则脚本数组，每项 {name, findRegex, replaceString, flags, placement, markdownOnly, promptOnly, enabled:true}。只在确有需要时给 1-3 条，没有合适的用途就不输出该字段。写法规范：',
    '  · 运行环境是 JavaScript RegExp（不是 PCRE）。findRegex 是正则源码字符串：不要带首尾斜杠、不带修饰符（修饰符写进 flags）。可用语法：字符类、量词、分组 (...)、引用分组；lookahead/lookbehind 支持但尽量少用；不要用 \\p{...}、(?P<name>...)、递归等非 JS 语法。',
    '  · flags 是字符串，默认 "g"；需要忽略大小写加 "i"（如 "gi"），跨行匹配加 "m" 或 "s"。不要写 "u"。',
    '  · replaceString 按 JavaScript String.replace 的替换规则：$1 $2 引用分组、$& 引用整段匹配、字面 $ 写 $$。',
    '  · placement 决定作用对象：[1]=用户输入的消息、[2]=AI 输出的消息；只处理展示也必须包含对应项。',
    '  · markdownOnly:true（只影响界面展示，不改变发给模型的内容）与 promptOnly:true（只影响发给模型的内容）互斥，最多一个为 true；两个都 false 表示两边都生效，慎用。',
    '  · replaceString 可以内嵌 HTML 做样式，例如 <span style="color:#c7254e">$&</span> 高亮、<em>$1</em> 斜体；删除匹配内容时 replaceString 用空字符串。',
    '  · 每条 name 用途要一目了然（如「星号动作斜体化」「隐藏状态栏」）。',
    '典型用途参考（按需选用，不要照抄）：',
    '  · 把 *动作* 转为斜体展示：findRegex "\\\\*([^*\\\\n]+)\\\\*"，replaceString "<em>$1</em>"，flags "g"，placement [2]，markdownOnly true。',
    '  · 清理发给模型前的占位符：findRegex "\\\\{\\\\{user\\\\}\\\\}"，replaceString "用户"，flags "g"，placement [1]，promptOnly true。',
  ].join('\n');
}

// 预设字段规则：机制（拼进系统提示词末尾的 [角色预设] 块）+ 行为约束类型 + 与 PHI 的分工。
function buildPresetRules() {
  return [
    '- presets：文本预设数组，每项 {name, prompt, enabled:true}，写 1-3 条。预设的机制：每条 prompt 会被追加到系统提示词末尾的 [角色预设] 区块（角色定义与世界书之后），多条按换行拼接，{{user}} 会替换为用户名。',
    '  · 预设写「对模型输出行为的约束」，不要复述角色设定（那是 description/世界书的职责）。',
    '  · 每条聚焦一类约束，name 说明用途，prompt 40-150 字，用祈使句直接下指令。常用类型：',
    '    文风（如「对话以动作为先，心理描写克制，每段不超过 3 句」）、',
    '    格式（如「动作描写用星号包裹，说话内容用直角引号」）、',
    '    长度（如「每次回复 2-4 段，不要主动结束场景」）、',
    '    禁忌（如「不要替 {{user}} 说话或决定 {{user}} 的行动」）。',
    '  · 与 postHistoryInstructions 的分工：预设放角色/世界层面的长期写作要求；postHistoryInstructions 放必须压过对话惯性的硬规则（输出语言、安全边界、格式红线）。',
  ].join('\n');
}

function buildAdvancedLines(sections) {
  const advancedLines = [];
  if (sections.includes('world')) advancedLines.push(buildWorldInfoRules());
  if (sections.includes('regex')) advancedLines.push(buildRegexRules());
  if (sections.includes('presets')) advancedLines.push(buildPresetRules());
  return advancedLines;
}

const ADVANCED_SECTION_SCHEMA_LABELS = {
  world: 'worldInfo（世界书）',
  regex: 'regexScripts（正则脚本）',
  presets: 'presets（文本预设）',
};

export function buildGeneratePrompt(state, { includeAdvanced = true } = {}) {
  const answers = summarizeAnswers(state);
  const draft = JSON.stringify(projectForgeDraft(state && state.draft), null, 0);
  const sections = includeAdvanced ? requestedAdvancedSections(state) : [];
  const advancedLines = buildAdvancedLines(sections);
  return [
    '你是角色卡（SillyTavern 风格）撰写助手。请根据下面的问答结果和当前草稿，写出一张完整的角色卡。',
    '',
    '问答结果：',
    answers || '（用户没有回答任何问题，请你自行合理设计一个有意思的角色）',
    '',
    '当前草稿（在此基础上完善，可以为空）：',
    draft,
    '',
    '输出要求：',
    ...buildCardOutputRules(),
    ...(advancedLines.length > 0
      ? [
        '- 本次还需要在同一个 JSON 里追加以下高级字段（未要求的字段不要输出）：',
        ...advancedLines,
      ]
      : []),
    '- 全部使用中文。',
  ].join('\n');
}

// 「补写高级内容」的第二步提示词：带上已生成的角色卡投影与全文设定，只要求世界书/正则/预设。
// 拆成第二步是为了避免单次输出数千字 JSON 被截断，导致后半段（高级内容）敷衍或解析失败。
export function buildAdvancedPrompt(state, draft) {
  const sections = requestedAdvancedSections(state);
  const source = draft && typeof draft === 'object' ? draft : ((state && state.draft) || {});
  const advancedLines = buildAdvancedLines(sections);
  return [
    '你是角色卡（SillyTavern 风格）撰写助手。请根据下面的角色卡与设定，补写它的高级内容（世界书 / 正则脚本 / 文本预设）。',
    '',
    '问答结果：',
    summarizeAnswers(state) || '（无）',
    '',
    '已生成的角色卡（在此基础上补写高级内容）：',
    JSON.stringify(projectForgeDraft(source), null, 0),
    '',
    '输出要求：',
    '- 只输出一个 JSON 对象，不要任何解释、前后缀或代码块标记。',
    `- 字段只包含本次要求的这些：${sections.map(key => ADVANCED_SECTION_SCHEMA_LABELS[key] || key).join('、')}；其余字段不要输出。`,
    ...advancedLines,
    '- 全部使用中文。',
  ].join('\n');
}

// JSON 解析失败时的一次性自修复请求：回传被截断/非法转义片段，要求重出完整 JSON。
export function buildJsonRepairPrompt(rawOutput) {
  const snippet = String(rawOutput == null ? '' : rawOutput).slice(0, 500);
  return [
    '你上次输出的 JSON 无法解析（可能被截断或含非法转义）。请重新输出完整、合法的 JSON 对象，不要任何解释或代码块标记。',
    '',
    '上次输出的开头片段（仅供对照，不要原样重复）：',
    snippet || '（空）',
  ].join('\n');
}

// 角色卡 JSON 的输出规则。整卡生成、按图生成、字段描述共用同一份，
// 避免三处各写一遍后互相漂移（字段名/清空语义/中文要求必须一致）。
function buildCardOutputRules() {
  return [
    '- 只输出一个 JSON 对象，不要任何解释、前后缀或代码块标记。',
    '- 字段固定为：name, description, personality, scenario, firstMes, mesExample, creatorNotes, postHistoryInstructions, tags。',
    '- name：角色名（2-8 字）；description：外貌、身份、背景（150-400 字）；personality：性格与说话方式（80-200 字）。',
    '- scenario：故事背景以及角色与用户的关系（50-200 字）。',
    '- firstMes：角色主动说的第一条消息，第一人称，1-3 句，不要替用户说话。',
    '- mesExample：1-2 组对话示例，格式为「{{user}}：…」与「角色名：…」逐行交替。',
    '- creatorNotes：给用户的使用建议（可留空）；postHistoryInstructions：给模型的持续要求（可留空）。',
    '- tags：3-6 个简短中文标签组成的数组。',
    '- 要清空某个字段或全部标签时，把该字段（或 tags）的值写成 null；不要用空字符串或空数组表示清空。',
  ];
}

export function buildEditPrompt({ draft, request, answers } = {}) {
  const summary = clean(answers, 800);
  return [
    '你是角色卡编辑器。请按用户的要求修改下面的角色卡，只改需要改的字段，其余字段原样保留。',
    '',
    '当前卡片 JSON：',
    JSON.stringify(projectForgeDraft(draft), null, 0),
    summary ? `\n已知的设定要求：\n${summary}` : '',
    '',
    `用户要求：${clean(request, 800) || '（空）'}`,
    '',
    '输出要求：',
    '- 只输出修改后的完整 JSON 对象，不要任何解释或代码块标记。',
    '- 字段与结构保持不变，不要新增或删除字段。',
    '- 未修改的字段必须原样完整复制，不要留空。',
    '- 要清空某个字段或全部标签时，把该字段（或 tags）的值写成 null；空字符串和空数组不会被视为清空。',
    '- 全部使用中文。',
  ].filter(Boolean).join('\n');
}

// 「按图片生成角色」的提示词：图片作为多模态内容随本提示一起发送，
// 这里只给文字侧的规则。用户补充说明可选。
export function buildImageCardPrompt({ hint = '', hasAvatar = false, hasBg = false } = {}) {
  const images = [
    hasAvatar ? '第一张是角色的头像/立绘' : '',
    hasBg ? `${hasAvatar ? '第二张' : '第一张'}是角色的场景或背景` : '',
  ].filter(Boolean).join('，');
  return [
    '你是角色卡（SillyTavern 风格）撰写助手。请根据随本条消息附带的图片，写出一张完整的角色卡。',
    images ? `图片说明：${images}。` : '',
    hint ? `用户的补充要求：${clean(hint, 400)}` : '',
    '',
    '要求：',
    '- 从图片中读出外貌特征（发色、瞳色、服饰、气质、年龄感、画风）与场景氛围，据此设计角色。',
    '- 如果图片里有人物，角色要与图中人物一致；如果只有场景，就以该场景设计一个合理的角色。',
    '- 不要描写图片里没有的、与画面明显冲突的特征。',
    ...buildCardOutputRules(),
    '- 全部使用中文。',
  ].filter(Boolean).join('\n');
}
