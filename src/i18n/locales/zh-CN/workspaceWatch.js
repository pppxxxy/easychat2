// SW1：工作区「看屏幕」面板词条（独立域文件——workspace.js 已顶行数棘轮上限，
// 词条域文件是既定的扩容路径）。
export const workspaceWatch = {
  'workspace.screen.rail.watch': '看屏幕',
  'workspace.watch.title': '看屏幕（工作区）',
  'workspace.watch.subtitle': '开悬浮窗后，工作区助手能跨应用看你的屏幕并接你的话。',
  'workspace.watch.statusOn': '悬浮窗已开启',
  'workspace.watch.statusOff': '悬浮窗未开启',
  'workspace.watch.open': '开启悬浮窗',
  'workspace.watch.close': '关闭悬浮窗',
  'workspace.watch.unsupported': '当前构建不支持悬浮窗看屏幕（需要重新打包安装）。',
  'workspace.watch.permissionDenied': '需要悬浮窗权限才能开启：请在系统设置里允许本应用显示在其他应用上层。',
  // FIX-3：投屏授权失败与「悬浮窗权限不足」是两回事，混在一句里会让用户去改错的地方。
  'workspace.watch.capturePermissionRequired': '需要在系统弹窗里允许录屏才能开启：请再点一次「开启悬浮窗」并在弹窗中确认。',
  'workspace.watch.startFailed': '悬浮窗启动失败，请重试。',
  'workspace.watch.threads': '工作区看屏幕对话',
  'workspace.watch.empty': '还没有工作区的看屏幕对话。开启悬浮窗后对着屏幕说话，这里会出现记录。',
  'workspace.watch.emptyPreview': '（暂无内容）',
  'workspace.watch.readFailed': '看屏幕对话读取失败（数据可能损坏），已保留原值。',
  'workspace.watch.sw2Note': '说明：会话已接工作区 agent 管线（工具集与权限门控）；悬浮窗内的 mini 聊天在后续版本。',
  // SW2：给工作区助手下命令（走 agent 管线，带工具与确认）。
  'workspace.watch.assistantName': '工作区助手',
  'workspace.watch.command': '给工作区助手下命令',
  'workspace.watch.commandPlaceholder': '例如：看看这个报错是什么 / 把 README 改一下',
  'workspace.watch.send': '发送',
  'workspace.watch.running': '执行中…',
  'workspace.watch.stop': '停止',
  'workspace.watch.toolRunning': '正在调用 {name}…',
  'workspace.watch.modeRead': '只读',
  'workspace.watch.modeWrite': '可改',
  'workspace.watch.writeHint': '「可改」模式下，破坏性操作（写文件 / 跑命令 / 提交）执行前都会弹确认，你可以逐条允许或拒绝。',
};

export default workspaceWatch;
