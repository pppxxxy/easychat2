// 国际化词条表（简体中文 = 基准语言）。
//
// 约定：
// - key 用「域.语义」的点分命名（app.tab.chat / chat.attach.title），便于按域分批迁移；
// - 中文是基准：其余语言缺某个 key 时回退到中文，界面不会出现空白文案；
// - **只收 UI 文案**。发给模型的提示词（src/presets.js、src/cardForge/forge.js、
//   src/moments/affinity.js、src/memorySummary.js 等）不在此列——翻译它们会改变
//   角色行为，中文对话场景下英文关键词表会直接失灵；
// - 本文件随迁移批次增长，不要求一次补全。

export const zhCN = {
  // ---- 应用外壳 / 底部导航（App.js）----
  'app.tab.chat': '聊天',
  'app.tab.memory': '记忆',
  'app.tab.character': '角色',
  'app.tab.extension': '扩展',
  'app.tab.settings': '设置',
  'app.crash.title': '启动失败',
  'app.crash.hint': '请把以下内容截图反馈：',
  'app.save.failed.title': '保存失败',
  'app.save.failed.body': '完成状态保存失败，请重试。',
  'app.migration.failed.title': '启动迁移失败',
  'app.migration.failed.body': '旧聊天记录整理未能完成，请检查存储空间后重启应用。',
  'app.default.userName': '用户',

  // ---- 聊天页顶栏（chat/ChatTopBar.js）----
  'chat.topBar.selection.cancel': '取消',
  'chat.topBar.selection.count': '已选择 {count} 条',
  'chat.topBar.selection.selectAll': '全选',
  'chat.topBar.selection.unselectAll': '取消全选',
  'chat.topBar.selection.delete': '删除',
  'chat.topBar.newChat': '新建',
  'chat.topBar.broadcast.on': '自动播报开',
  'chat.topBar.broadcast.off': '自动播报关',
  'chat.topBar.a11y.cancelSelection': '取消选择消息',
  'chat.topBar.a11y.selectAll': '全选消息',
  'chat.topBar.a11y.unselectAll': '取消全选',
  'chat.topBar.a11y.deleteSelected': '删除选中消息',
  'chat.topBar.a11y.switchCharacter': '切换角色',
  'chat.topBar.a11y.switchGroup': '切换群聊',
  'chat.topBar.a11y.newChat': '新建对话',
  'chat.topBar.a11y.broadcastOn': '关闭自动播报',
  'chat.topBar.a11y.broadcastOff': '开启自动播报',
  'chat.topBar.a11y.more': '更多功能',

  // ---- 添加附件菜单（chat/AttachmentMenuModal.js）----
  'chat.attach.title': '添加附件',
  'chat.attach.close': '关闭',
  'chat.attach.text.title': '纯文本文档',
  'chat.attach.text.hint': 'txt / md / json 等文本内容会并入消息',
  'chat.attach.camera.title': '拍照',
  'chat.attach.camera.hint': '拍摄照片发送给角色',
  'chat.attach.image.title': '图片',
  'chat.attach.image.hint': '从相册中选择图片',
  'chat.attach.visionRequired': '当前来源未标记为支持识图，请先在「设置 → API」确认模型能力',

  // ---- 聊天输入区（chat/ChatComposer.js）----
  'chat.composer.placeholder': '输入消息...',
  'chat.composer.a11y.attach': '添加附件',
  'chat.composer.a11y.mention': '提及成员',
  'chat.composer.a11y.sticker': '表情包',
  'chat.composer.a11y.fullScreen': '全屏输入',
  'chat.composer.a11y.stop': '停止',
  'chat.composer.a11y.send': '发送',
  'chat.composer.a11y.cancelQuote': '取消引用',
  'chat.composer.a11y.record': '录制语音消息',
  'chat.composer.a11y.stopRecord': '结束录音并转写',
  'chat.composer.a11y.cancelRecord': '取消录音',
  'chat.composer.recording': '正在录音…松开结束，上滑取消',
  'chat.composer.recording.cancel': '取消',
  'chat.composer.quote.fallbackName': '原文',

  // ---- 思考指示（chat/ThinkingIndicator.js）----
  'chat.thinking.placeholder': '正在思考...',

  // ---- 设置页外壳（SettingsScreen）----
  'settings.title': '设置',
  'settings.appearance.title': '外观',
  'settings.appearance.language': '语言',
  'settings.appearance.theme': '主题',
  'settings.appearance.fontScale': '字体大小',
  'settings.language.zh': '简体中文',
  'settings.language.en': 'English',

  // ---- 通用 ----
  'common.cancel': '取消',
  'common.confirm': '确定',
  'common.save': '保存',
  'common.saving': '保存中...',
  'common.delete': '删除',
  'common.close': '关闭',
  'common.retry': '重试',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.done': '完成',
  'common.loading': '处理中...',
};

export default zhCN;
