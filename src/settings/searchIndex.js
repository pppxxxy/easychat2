// 设置搜索索引：纯数据 + 纯过滤，零依赖，可在 Node 直测。
//
// 每条命中项指向一个设置卡（sectionId）。界面据此展开对应卡、滚动并高亮。
// sectionId 必须与 SettingsScreen 里的折叠卡 id 一致。
//
// **文案一律用 i18n key，不写字面量**（2026-10-12 收敛）：label 是显示给用户看的
//（搜索结果行 + 分区名），此前硬编码中文，英文用户在设置搜索里看到的全是中文。
// 现在 labelKey 直接复用卡片本身用的那些键（settings.api.current / settings.appearance.theme…），
// 于是「搜索结果的措辞」与「卡里的措辞」不可能再各自漂移；确实没有对应键的少数项
// （如「保存 / 删除配置」）才新增 settings.search.* 键。
//
// keywords 保持中文/英文混排：它们是**匹配用**关键词（用户会输入什么），不是文案，
// 不该翻译——英文用户输入 "temperature" 靠 keywords 里的英文词命中。这也是本文件仍留在
// eslint「(b) 永久豁免」清单里的唯一原因：豁免的是 keywords，label 已全部迁走。

// 分区名 → i18n key。复用卡片标题键（settings.<x>.title），不再另写一份中文
//（此前那份还是过期的：appearance 的分区名写「外观与语言」，卡上其实是「外观」）。
export const SETTINGS_SECTION_LABEL_KEYS = {
  api: 'settings.api.title',
  sampling: 'settings.sampling.title',
  persona: 'settings.persona.title',
  appearance: 'settings.appearance.title',
  experience: 'settings.experience.title',
  extensions: 'settings.extensions.title',
  vector: 'settings.vector.title',
  workspace: 'settings.workspace.title',
  github: 'settings.github.title',
  mcpservers: 'settings.mcp.title',
  localmodel: 'settings.localModel.title',
  security: 'settings.security.title',
  autoBackup: 'settings.autoBackup.title',
  about: 'settings.about.title',
  language: 'settings.language.title',
};

export const SETTINGS_SEARCH_INDEX = [
  { sectionId: 'api', labelKey: 'settings.api.current', keywords: ['配置', '切换配置', 'api config'] },
  { sectionId: 'api', labelKey: 'settings.api.name', keywords: ['名称', '重命名'] },
  { sectionId: 'api', labelKey: 'settings.api.baseUrl', keywords: ['地址', 'url', 'baseurl', '端点', '接口'] },
  { sectionId: 'api', labelKey: 'settings.api.protocol', keywords: ['协议', 'protocol', 'openai', 'anthropic', 'responses'] },
  { sectionId: 'api', labelKey: 'settings.api.modelList', keywords: ['模型', 'model', '检测模型', '搜索模型'] },
  { sectionId: 'api', labelKey: 'settings.search.apiKey', keywords: ['key', '密钥', '鉴权', 'token'] },
  { sectionId: 'api', labelKey: 'settings.search.apiSaveDelete', keywords: ['保存', '删除'] },

  { sectionId: 'sampling', labelKey: 'settings.sampling.maxTokens', keywords: ['maxtokens', 'max tokens', '令牌', '长度'] },
  { sectionId: 'sampling', labelKey: 'settings.sampling.temperature', keywords: ['temperature', '采样', '随机'] },
  { sectionId: 'sampling', labelKey: 'settings.sampling.topP', keywords: ['topp', '核采样'] },
  { sectionId: 'sampling', labelKey: 'settings.sampling.topK', keywords: ['topk'] },

  { sectionId: 'persona', labelKey: 'settings.persona.current', keywords: ['人设', '身份', 'persona'] },
  { sectionId: 'persona', labelKey: 'settings.search.personaName', keywords: ['名字', '昵称', 'user name', '{{user}}'] },
  { sectionId: 'persona', labelKey: 'settings.persona.description', keywords: ['描述', '自我介绍'] },
  { sectionId: 'persona', labelKey: 'settings.search.personaAvatar', keywords: ['头像', 'avatar', '图片'] },

  { sectionId: 'appearance', labelKey: 'settings.appearance.theme', keywords: ['主题', 'theme', '深色', '浅色', '配色'] },
  { sectionId: 'appearance', labelKey: 'settings.appearance.fontScale', keywords: ['字体', '字号', 'font', '大小'] },
  { sectionId: 'appearance', labelKey: 'settings.global.thinkingDisplay', keywords: ['思考', 'thinking', '推理', 'reasoning'] },
  { sectionId: 'appearance', labelKey: 'settings.global.bubbleStyle', keywords: ['气泡', 'bubble', '圆润', '卡片', '无底纹'] },

  { sectionId: 'experience', labelKey: 'settings.global.presets', keywords: ['预设', 'preset', '记忆总结', '记忆'] },
  { sectionId: 'experience', labelKey: 'settings.global.streaming', keywords: ['流式', 'streaming', '打字机'] },
  { sectionId: 'experience', labelKey: 'settings.global.fullWidth', keywords: ['全宽', '宽度', 'fullwidth'] },
  { sectionId: 'experience', labelKey: 'settings.global.richHtml', keywords: ['html', 'webview', '渲染', '样式'] },
  { sectionId: 'experience', labelKey: 'settings.global.keepDraft', keywords: ['草稿', 'draft', '输入框'] },
  { sectionId: 'experience', labelKey: 'settings.global.timeAware', keywords: ['时间', 'time', '日期', '星期'] },
  { sectionId: 'experience', labelKey: 'settings.location.awareness.title', keywords: ['位置', 'location', '定位', 'gps'] },
  { sectionId: 'experience', labelKey: 'settings.global.moments', keywords: ['动态', 'moments', '朋友圈'] },

  { sectionId: 'extensions', labelKey: 'settings.inlineImage.title', keywords: ['配图', '生图', '画图', 'image', 'illustration', '自动配图'] },
  { sectionId: 'extensions', labelKey: 'settings.inlineImage.provider', keywords: ['生图服务', 'provider', '绘图'] },
  { sectionId: 'extensions', labelKey: 'settings.global.webSearch', keywords: ['联网', '搜索', 'web search', '网络'] },
  { sectionId: 'extensions', labelKey: 'settings.global.tts', keywords: ['语音播报', 'tts', '朗读', '声音'] },
  { sectionId: 'extensions', labelKey: 'settings.global.transcription', keywords: ['语音转文字', 'asr', '转写', '听写', '转文字'] },
  // 工具使用提示（隐藏「用了某工具」的过程气泡）：与扩展卡同区，关键词覆盖「工具」入口。
  { sectionId: 'extensions', labelKey: 'settings.toolNotice.sectionTitle', keywords: ['工具提示', '隐藏工具', '工具气泡', '工具过程', 'tool notice', 'tool bubble', 'hide tool'] },

  { sectionId: 'vector', labelKey: 'settings.vector.enable', keywords: ['向量', 'vector', '检索', 'embedding', '记忆'] },
  { sectionId: 'vector', labelKey: 'settings.vector.config', keywords: ['向量配置', 'embedding 模型'] },

  { sectionId: 'workspace', labelKey: 'settings.workspace.mode', keywords: ['工作区', '模式', 'workspace', '询问', '读写'] },
  { sectionId: 'workspace', labelKey: 'settings.workspace.folder', keywords: ['目录', '文件夹', 'folder', '路径'] },
  { sectionId: 'workspace', labelKey: 'settings.workspace.shell', keywords: ['命令', 'shell', '终端', 'terminal'] },

  { sectionId: 'github', labelKey: 'settings.github.title', keywords: ['github', 'mcp', '连接'] },
  { sectionId: 'github', labelKey: 'settings.search.githubToken', keywords: ['github', 'pat', '令牌', 'token'] },

  { sectionId: 'mcpservers', labelKey: 'settings.mcp.title', keywords: ['mcp', '服务器', '第三方', '工具', 'model context protocol', 'server'] },
  { sectionId: 'mcpservers', labelKey: 'settings.mcp.add.label', keywords: ['mcp', '添加', '端点', '令牌', 'token', 'endpoint'] },
  // 反方向：App 自己当服务器（外部 agent 连进来）。关键词带上「内置/局域网/端口/agent」，
  // 否则用户只会按「MCP 服务器」搜到第三方那张卡。
  { sectionId: 'mcpservers', labelKey: 'settings.mcp.server.title', keywords: ['mcp', '内置', 'server', '局域网', '端口', 'port', 'agent', 'codex', 'claude'] },

  // 本地模型：2026-10-07 从关于卡的一行升级为独立卡（sectionId 随之迁移）。
  { sectionId: 'localmodel', labelKey: 'settings.localModel.title', keywords: ['本地模型', 'local model', 'llama', 'gguf', '端侧'] },

  { sectionId: 'security', labelKey: 'settings.security.appLock', keywords: ['应用锁', '生物识别', '指纹', '面容', 'face id', 'touch id', 'app lock', '锁定'] },
  { sectionId: 'security', labelKey: 'settings.security.characterLocks', keywords: ['角色锁', '密码', 'pin', 'passcode', '隐私', '安全', '锁'] },
  { sectionId: 'security', labelKey: 'settings.security.bulk.title', keywords: ['批量', '多选', '全选', '批量上锁', '统一密码', 'bulk', 'select all', 'multi'] },
  { sectionId: 'security', labelKey: 'settings.search.pinHint', keywords: ['密码提示', '提示', '备忘', '忘记密码', 'hint', 'forgot'] },
  { sectionId: 'security', labelKey: 'settings.security.relock', keywords: ['重新上锁', '后台', 'relock', 'background'] },

  { sectionId: 'autoBackup', labelKey: 'settings.autoBackup.title', keywords: ['自动备份', '备份', '定时备份', 'backup', 'auto'] },
  { sectionId: 'autoBackup', labelKey: 'settings.autoBackup.interval', keywords: ['间隔', '频率', '周期', 'interval'] },
  { sectionId: 'autoBackup', labelKey: 'settings.autoBackup.onExit', keywords: ['退出', '后台', '离开', 'exit'] },
  { sectionId: 'autoBackup', labelKey: 'settings.autoBackup.folder', keywords: ['文件夹', '目录', '位置', '路径', 'folder'] },

  { sectionId: 'about', labelKey: 'settings.about.version', keywords: ['版本', 'version'] },
  { sectionId: 'about', labelKey: 'settings.about.tutorial', keywords: ['教程', '帮助', '引导', 'tutorial'] },
  { sectionId: 'about', labelKey: 'settings.about.disclaimer', keywords: ['免责', '条款', '协议', 'disclaimer'] },
  { sectionId: 'about', labelKey: 'settings.about.github', keywords: ['github', '源码', '仓库'] },
  { sectionId: 'about', labelKey: 'settings.about.checkUpdate', keywords: ['更新', '升级', 'update'] },
  { sectionId: 'about', labelKey: 'settings.about.diagnostics', keywords: ['诊断', '日志', 'log', '报错'] },
  { sectionId: 'about', labelKey: 'settings.about.backup', keywords: ['备份', '恢复', 'backup', '导出', '导入'] },

  // 界面语言：独立卡（默认展开）——搜「语言」直接跳到它。
  { sectionId: 'language', labelKey: 'settings.language.title', keywords: ['语言', 'language', '中文', 'english', 'locale', '切换语言'] },
];

// 按关键词过滤索引：大小写不敏感，匹配**译名**或任一 keyword 的子串。
// 空查询返回空数组（界面据此显示正常列表）。
//
// t 由调用方注入（界面传 useTranslation 的 t；测试传替身或真实 translate）。默认是恒等
// 函数——本模块不持有「当前语言」这个全局状态，用默认 t 时译名匹配不到中文，这是刻意的：
// 语言由调用方决定，纯逻辑测试可以只依赖 keywords。
export function searchSettings(query, { index = SETTINGS_SEARCH_INDEX, t = key => key } = {}) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return [];
  const source = Array.isArray(index) ? index : [];
  return source.filter(item => {
    if (!item || typeof item !== 'object') return false;
    const label = typeof t === 'function' ? t(item.labelKey) : '';
    const haystack = [label, ...(Array.isArray(item.keywords) ? item.keywords : [])]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

export function settingsSectionLabel(sectionId, t = key => key) {
  const key = SETTINGS_SECTION_LABEL_KEYS[sectionId];
  if (!key) return '';
  return typeof t === 'function' ? t(key) : '';
}
