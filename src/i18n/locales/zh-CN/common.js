// i18n 词条 · common 域（zh-CN 基准）。聚合入口见 ../zh-CN.js。
  // ---- 通用 ----
  // ---- i18n 迁移批次：硬编码中文清理（2026-10-05）----
export const common = {
  'common.characterFallback': '角色',
  'common.cancel': '取消',
  'common.confirm': '确定',
  'common.save': '保存',
  'common.saving': '保存中...',
  'common.delete': '删除',
  'common.close': '关闭',
  'common.back': '返回',
  'common.retry': '重试',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.done': '完成',
  'common.loading': '处理中...',
  'common.hintLabel': '说明',
  'common.expand': '展开{label}',
  'common.collapse': '收起{label}',
  'common.notSet': '未填写',
  'common.error.retry': '请重试。',
  'common.groupChat': '群聊',
  'common.error.saveFailed': '保存失败',
  'common.error.deleteFailed': '删除失败',
  'common.error.storageOrPermission': '请检查存储空间或权限。',
  'common.error.retryLater': '请稍后重试。',
  'common.detecting': '检测中...',
  'common.on': '开',
  'common.off': '关',
  'common.unnamedCharacter': '未命名角色',
  // ---- AIGC 合规标识（aigc/attribution.js）----
  // 这三条是**合规文案**，此前硬编码中文，英文界面下也显示中文。它们是导出文件
  // 与告警正文里的显式标识，必须随界面语言切换。
  'common.aigc.notice': '本内容由 AI 生成',
  'common.aigc.exportNotice': '—— 本卡片内容由 AI 生成（EasyChat2 制卡）',
  // {keywords} 是命中的 IP 名称列表（顿号分隔）。插值而不是拼接：英文语序不同。
  'common.aigc.ipNotice': '生成的卡片中检测到可能与知名 IP 相似的名称：{keywords}。AI 生成内容与既有作品相似可能存在版权风险，请自行确认有权使用后再保存或传播，相关责任由你自行承担。若内容涉及真实人物姓名，请额外注意肖像权与名誉风险。',
};
