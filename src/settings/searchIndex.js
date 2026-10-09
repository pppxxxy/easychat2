// 设置搜索索引：纯数据 + 纯过滤，零依赖，可在 Node 直测。
//
// 每条命中项指向一个设置卡（sectionId）。界面据此展开对应卡、滚动并高亮。
// sectionId 必须与 SettingsScreen 里的折叠卡 id 一致。

export const SETTINGS_SECTION_LABELS = {
  api: 'API 配置',
  sampling: '生成参数',
  persona: '用户人设',
  appearance: '外观与语言',
  experience: '对话体验',
  extensions: '功能扩展',
  vector: '向量记忆',
  workspace: '工作区',
  github: 'GitHub',
  localmodel: '本地模型',
  security: '隐私与安全',
  about: '关于',
  language: '界面语言',
};

export const SETTINGS_SEARCH_INDEX = [
  { sectionId: 'api', label: '当前配置', keywords: ['配置', '切换配置', 'api config'] },
  { sectionId: 'api', label: '配置名称', keywords: ['名称', '重命名'] },
  { sectionId: 'api', label: 'API 地址', keywords: ['地址', 'url', 'baseurl', '端点', '接口'] },
  { sectionId: 'api', label: '接口协议', keywords: ['协议', 'protocol', 'openai', 'anthropic', 'responses'] },
  { sectionId: 'api', label: '模型列表', keywords: ['模型', 'model', '检测模型', '搜索模型'] },
  { sectionId: 'api', label: 'API Key', keywords: ['key', '密钥', '鉴权', 'token'] },
  { sectionId: 'api', label: '保存 / 删除配置', keywords: ['保存', '删除'] },

  { sectionId: 'sampling', label: '最大回复令牌', keywords: ['maxtokens', 'max tokens', '令牌', '长度'] },
  { sectionId: 'sampling', label: '温度', keywords: ['temperature', '采样', '随机'] },
  { sectionId: 'sampling', label: 'top-p', keywords: ['topp', '核采样'] },
  { sectionId: 'sampling', label: 'top-k', keywords: ['topk'] },

  { sectionId: 'persona', label: '当前人设', keywords: ['人设', '身份', 'persona'] },
  { sectionId: 'persona', label: '人设名称', keywords: ['名字', '昵称', 'user name', '{{user}}'] },
  { sectionId: 'persona', label: '人设描述', keywords: ['描述', '自我介绍'] },
  { sectionId: 'persona', label: '头像', keywords: ['头像', 'avatar', '图片'] },

  { sectionId: 'appearance', label: '主题', keywords: ['主题', 'theme', '深色', '浅色', '配色'] },
  { sectionId: 'appearance', label: '字体大小', keywords: ['字体', '字号', 'font', '大小'] },
  { sectionId: 'appearance', label: '思考内容展示', keywords: ['思考', 'thinking', '推理', 'reasoning'] },
  { sectionId: 'appearance', label: '气泡风格', keywords: ['气泡', 'bubble', '圆润', '卡片', '无底纹'] },

  { sectionId: 'experience', label: '全局预设 / 记忆总结', keywords: ['预设', 'preset', '记忆总结', '记忆'] },
  { sectionId: 'experience', label: '流式输出', keywords: ['流式', 'streaming', '打字机'] },
  { sectionId: 'experience', label: '全宽对话', keywords: ['全宽', '宽度', 'fullwidth'] },
  { sectionId: 'experience', label: '富 HTML 渲染', keywords: ['html', 'webview', '渲染', '样式'] },
  { sectionId: 'experience', label: '保留输入草稿', keywords: ['草稿', 'draft', '输入框'] },
  { sectionId: 'experience', label: '时间感知', keywords: ['时间', 'time', '日期', '星期'] },
  { sectionId: 'experience', label: '位置感知', keywords: ['位置', 'location', '定位', 'gps'] },
  { sectionId: 'experience', label: '动态', keywords: ['动态', 'moments', '朋友圈'] },

  { sectionId: 'extensions', label: '对话配图', keywords: ['配图', '生图', '画图', 'image', 'illustration', '自动配图'] },
  { sectionId: 'extensions', label: '生图服务', keywords: ['生图服务', 'provider', '绘图'] },
  { sectionId: 'extensions', label: '联网搜索', keywords: ['联网', '搜索', 'web search', '网络'] },
  { sectionId: 'extensions', label: '语音播报', keywords: ['语音播报', 'tts', '朗读', '声音'] },
  { sectionId: 'extensions', label: '语音转文字', keywords: ['语音转文字', 'asr', '转写', '听写', '转文字'] },

  { sectionId: 'vector', label: '启用向量检索', keywords: ['向量', 'vector', '检索', 'embedding', '记忆'] },
  { sectionId: 'vector', label: '向量配置', keywords: ['向量配置', 'embedding 模型'] },

  { sectionId: 'workspace', label: '工作区模式', keywords: ['工作区', '模式', 'workspace', '询问', '读写'] },
  { sectionId: 'workspace', label: '工作目录', keywords: ['目录', '文件夹', 'folder', '路径'] },
  { sectionId: 'workspace', label: '命令执行', keywords: ['命令', 'shell', '终端', 'terminal'] },

  { sectionId: 'github', label: 'GitHub 连接', keywords: ['github', 'mcp', '连接'] },
  { sectionId: 'github', label: 'GitHub 令牌', keywords: ['github', 'pat', '令牌', 'token'] },

  // 本地模型：2026-10-07 从关于卡的一行升级为独立卡（sectionId 随之迁移）。
  { sectionId: 'localmodel', label: '本地模型', keywords: ['本地模型', 'local model', 'llama', 'gguf', '端侧'] },

  { sectionId: 'security', label: '应用锁', keywords: ['应用锁', '生物识别', '指纹', '面容', 'face id', 'touch id', 'app lock', '锁定'] },
  { sectionId: 'security', label: '单角色锁', keywords: ['角色锁', '密码', 'pin', 'passcode', '隐私', '安全', '锁'] },
  { sectionId: 'security', label: '批量上锁', keywords: ['批量', '多选', '全选', '批量上锁', '统一密码', 'bulk', 'select all', 'multi'] },
  { sectionId: 'security', label: '密码提示', keywords: ['密码提示', '提示', '备忘', '忘记密码', 'hint', 'forgot'] },
  { sectionId: 'security', label: '离开后重新上锁', keywords: ['重新上锁', '后台', 'relock', 'background'] },

  { sectionId: 'about', label: '当前版本', keywords: ['版本', 'version'] },
  { sectionId: 'about', label: '使用教程', keywords: ['教程', '帮助', '引导', 'tutorial'] },
  { sectionId: 'about', label: '免责条款', keywords: ['免责', '条款', '协议', 'disclaimer'] },
  { sectionId: 'about', label: 'GitHub 地址', keywords: ['github', '源码', '仓库'] },
  { sectionId: 'about', label: '检测更新', keywords: ['更新', '升级', 'update'] },
  { sectionId: 'about', label: '诊断日志', keywords: ['诊断', '日志', 'log', '报错'] },
  { sectionId: 'about', label: '备份与恢复', keywords: ['备份', '恢复', 'backup', '导出', '导入'] },

  // 界面语言：独立卡（默认展开）——搜「语言」直接跳到它。
  { sectionId: 'language', label: '界面语言', keywords: ['语言', 'language', '中文', 'english', 'locale', '切换语言'] },
];

// 按关键词过滤索引：大小写不敏感，匹配 label 或任一 keyword 的子串。
// 空查询返回空数组（界面据此显示正常列表）。
export function searchSettings(query, index = SETTINGS_SEARCH_INDEX) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return [];
  const source = Array.isArray(index) ? index : [];
  return source.filter(item => {
    if (!item || typeof item !== 'object') return false;
    const haystack = [item.label, ...(Array.isArray(item.keywords) ? item.keywords : [])]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

export function settingsSectionLabel(sectionId) {
  return SETTINGS_SECTION_LABELS[sectionId] || '';
}
