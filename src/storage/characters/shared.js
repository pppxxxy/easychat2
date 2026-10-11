// 角色库存储领域：共享常量与纯规范化逻辑。
// 从 src/storage/characters.js 原样外提（无行为变化）。
// 模块级可变状态 characterLibraryWriteBlocked 只在本模块声明，读（isCharacterLibraryWriteBlocked）
// 与写（setCharacterLibraryWriteBlocked）都经本模块，禁止跨模块复制。

import { assignStableCharacterIds } from '../../context/characterIdentity.js';
import { normalizeCharacterPresets } from '../../character/characterPresets.js';

export const DEFAULT_CHARACTER = {
  id: 'default',
  // builtin 标记初始卡身份：改名 / 改系统提示后仍能识别，不能靠名字比对（会被用户改掉）。
  builtin: true,
  name: 'EasyChat2 助手',
  // 内置助手系统提示：让它熟悉本 App 的全部结构与功能位置，用户问「XX 在哪 / 怎么用」
  // 时能直接给出页面与路径。改这里也会经 describeDefaultAssistantRefresh 刷新既有未改过的卡。
  systemPrompt: [
    '你是「EasyChat2 助手」——本地单机 AI 聊天 App（EasyChat2）的官方内置助手。你熟悉这个 App 的全部结构与功能位置。当用户问「某个功能在哪 / 怎么用」时，直接给出所在页面与操作路径，回答简洁、分点、可照做；不确定的地方就直说，不要编造。',
    '',
    '【底部导航】聊天 / 记忆 / 角色 / 扩展 / 设置。',
    '',
    '【设置】',
    '- API 配置：Base URL、接口协议、API Key、模型（可新建并切换多套配置）。',
    '- 生成参数：最大回复令牌、温度、top-p、top-k。',
    '- 用户人设：你的身份、名字（{{user}}）、描述、头像。',
    '- 外观与语言：主题、字体大小、思考内容展示、气泡风格、界面语言。',
    '- 对话体验：全局预设、记忆总结、流式输出、全宽对话、富 HTML 渲染、保留输入草稿、时间感知、位置感知、动态。',
    '- 功能扩展：对话配图（自动配图）、生图服务、联网搜索、语音播报（TTS）、语音转文字（ASR）。',
    '- 向量记忆：启用向量检索与向量配置。',
    '- 工作区：工作区模式（询问 / 只读 / 读写）、工作目录、命令执行。',
    '- GitHub：连接与令牌。MCP 服务器：添加第三方工具服务。',
    '- 本地模型：端侧 GGUF 模型管理，也可开成本地 OpenAI 兼容服务。',
    '- 隐私与安全：应用锁、单角色锁、批量上锁、密码提示、离开后重新上锁。',
    '- 关于：版本、使用教程、免责条款、GitHub 地址、检测更新、诊断日志、备份与恢复。',
    '',
    '【聊天】底部输入框发消息；右上角「⋯」里可编辑角色、切换角色 / 群聊、打开聊天设置、搜索、导出对话（长图 / Markdown / HTML），以及更多菜单（含语音设置等）。',
    '',
    '【角色】角色库可导入 / 导出角色卡（PNG / JSON）、搜索、置顶、多选删除、创建群聊；点开某个角色进入编辑（角色设定、开场白、世界书、正则脚本、预设等）。',
    '',
    '【记忆】记忆页面用于管理角色记忆摘要与检索。',
    '',
    '【扩展】分四组——',
    '- 创作：制卡工坊（AI 对话式生成角色卡）、图像生成（文生图）。',
    '- 日常陪伴：动态、主动消息（角色定时主动发来消息）、定时任务（角色每天自主完成一段任务）、作息、日记、屏幕注视（截屏让角色看）、插件。',
    '- 内容库：音乐、书籍、世界地图。',
    '- 小游戏：游戏中心。',
    '',
    '【工作区】从「设置 → 工作区」打开，面板分对话 / 文件 / GitHub / 终端 / 历史 / 设置。',
    '',
    '回答时先给出「位置 → 路径」（如「设置 → API 配置 → 新建」），再给 1-3 步操作。始终用中文。',
  ].join('\n'),
  systemPromptComposed: '',
  description: '',
  personality: '',
  scenario: '',
  // 内置教学开场白：首次运行自动开启一段会话并显示，引导用户配 API、导入角色卡、开始聊天。
  // 用户可在角色编辑页改写；仅当为空时才会被内置文案补上（不覆盖用户自设）。
  firstMes: '你好，我是 EasyChat2 助手。开始很简单：\n1. 打开底部「设置」填写 API 地址与密钥；\n2. 到「角色」页导入你喜欢的角色卡；\n3. 回到这里发消息，就能开始聊天了。',
  alternateGreetings: [],
  mesExample: '',
  creatorNotes: '',
  postHistoryInstructions: '',
  tags: [],
  worldInfo: [],
  regexScripts: [],
  presets: [],
  avatarUri: '',
  bgUri: '',
  voiceDisplay: 'text',
  lastUsedAt: 0
};

// 历史内置系统提示种子：升级内置助手知识时，只把「系统提示仍是这些旧种子之一」的内置卡
// 刷新为新版；用户改过的一律保留。刷新判定见 context/characterLibrary.js 的
// describeDefaultAssistantRefresh，由 AppContext 启动时补写（类比内置头像回填）。
export const DEFAULT_ASSISTANT_LEGACY_PROMPTS = [
  '你是 EasyChat2 的智能助手，回答简洁清晰。',
];

export function normalizeCharacter(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const merged = { ...DEFAULT_CHARACTER, ...source };
  // 这里绝不能用 DEFAULT_CHARACTER.id 兜底：空 id 一旦变成 'default'，就会和
  // 初始卡撞成同一个身份。真正的补全交给 assignStableCharacterIds 统一分配并落盘。
  merged.id = String(source.id == null ? '' : source.id).trim();
  // builtin 只认存储里显式写过的标记，不能从 DEFAULT_CHARACTER 继承，否则所有角色都会变成初始卡。
  merged.builtin = source.builtin === true;
  const lastUsedAt = Number(merged.lastUsedAt);
  merged.lastUsedAt = Number.isFinite(lastUsedAt) ? lastUsedAt : 0;
  merged.pinned = merged.pinned === true;
  merged.tags = Array.isArray(merged.tags)
    ? merged.tags.map(tag => String(tag || '').trim()).filter(Boolean)
    : [];
  merged.alternateGreetings = Array.isArray(merged.alternateGreetings)
    ? merged.alternateGreetings.map(item => String(item == null ? '' : item))
    : [];
  merged.mesExample = String(merged.mesExample || '');
  merged.presets = normalizeCharacterPresets(merged.presets);
  // 语音形态：'text' 仅文字（默认）/ 'voice-text' 语音+原文 / 'voice' 纯语音（隐藏正文但入库）。
  merged.voiceDisplay = ['text', 'voice-text', 'voice'].includes(merged.voiceDisplay)
    ? merged.voiceDisplay
    : 'text';
  return merged;
}

export function isInitialCard(character) {
  if (character && character.builtin === true) return true;
  // 旧数据没有 builtin：退化用"名字 + 系统提示"比对，尽量在首次读取时把真初始卡认出来并补标记。
  return String(character && character.name || '') === String(DEFAULT_CHARACTER.name || '')
    && String(character && character.systemPrompt || '') === String(DEFAULT_CHARACTER.systemPrompt || '');
}

export function ensureDefaultCharacter(list, now = Date.now()) {
  const normalized = (Array.isArray(list) ? list : []).map(normalizeCharacter);
  const { list: items, changed } = assignStableCharacterIds(normalized, {
    defaultId: DEFAULT_CHARACTER.id,
    isInitial: isInitialCard,
    now,
  });
  // 补 builtin 标记：初始卡改名 / 改系统提示后仍能被识别，避免身份判定再次失效。
  // 同时只允许 default 持有 builtin：历史数据里可能残留多个 builtin，会让身份判定二义。
  let builtinChanged = false;
  const marked = items.map(item => {
    if (item.id === DEFAULT_CHARACTER.id) {
      if (item.builtin === true) return item;
      builtinChanged = true;
      return { ...item, builtin: true };
    }
    if (item.builtin === true) {
      builtinChanged = true;
      return { ...item, builtin: false };
    }
    return item;
  });
  let changedNow = changed || builtinChanged;
  if (!marked.some(item => item.id === DEFAULT_CHARACTER.id)) {
    marked.unshift(normalizeCharacter(DEFAULT_CHARACTER));
    changedNow = true;
  }
  return { list: marked, changed: changedNow };
}

// 给默认角色播种内置教学开场白（仅当尚未播种且当前为空时）。
// 存量用户的默认角色 firstMes 是空串，会覆盖 DEFAULT_CHARACTER 的新默认值，
// 故需一次性迁移；用持久化标记保证「用户主动清空后不再被填回」。
export function seedDefaultGreeting(list, seeded) {
  if (seeded) return { list, changed: false };
  let changed = false;
  const next = (Array.isArray(list) ? list : []).map(item => {
    if (item.id !== DEFAULT_CHARACTER.id) return item;
    if (String(item.firstMes || '').trim()) return item;
    changed = true;
    return { ...item, firstMes: DEFAULT_CHARACTER.firstMes };
  });
  return { list: next, changed };
}

export function sortCharacters(list) {
  return [...list].sort((a, b) => {
    const pinnedDiff = (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0);
    if (pinnedDiff !== 0) return pinnedDiff;
    const diff = (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
    if (diff !== 0) return diff;
    return String(a.id).localeCompare(String(b.id));
  });
}

let characterLibraryWriteBlocked = false;

export function isCharacterLibraryWriteBlocked() {
  return characterLibraryWriteBlocked;
}

// 内部 setter：供 index 在读写角色库时翻转阻断态。状态只存在于本模块。
export function setCharacterLibraryWriteBlocked(value) {
  characterLibraryWriteBlocked = value === true;
}
