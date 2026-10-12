// i18n 词条 · search 域（zh-CN 基准）。聚合入口见 ../zh-CN.js。
export const search = {
  'search.alert.failed.title': '搜索失败',
  'search.history.placeholder': '搜索历史聊天记录',
  // ---- 全局搜索屏（src/SearchScreen.js）----
  // 此前整屏硬编码中文（搜索按钮/结果条数/空态标题与说明），英文界面下中英混排。
  'search.action.search': '搜索',
  'search.action.searching': '搜索中...',
  'search.result.count': '找到 {count} 条记录',
  // 结果行里角色资料取不到时的兜底名（会话还在、角色被删或未加载）。
  'search.result.missingCharacter': '角色资料缺失',
  'search.empty.notFound.title': '未找到匹配记录',
  'search.empty.notFound.description': '请换个关键词重新搜索。',
  'search.empty.hint.title': '搜索历史对话',
  'search.empty.hint.description': '输入关键词搜索全部角色的聊天记录。',
};
