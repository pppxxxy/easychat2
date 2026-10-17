// i18n 词条 · diagnostics 域（zh-CN 基准）。聚合入口见 ../zh-CN.js。
export const diagnostics = {
  'diagnostics.alert.copied.title': '已复制',
  'diagnostics.alert.copied.body': '诊断日志已复制到剪贴板，可直接粘贴反馈。',
  'diagnostics.alert.copyFailed.title': '复制失败',
  'diagnostics.alert.copyFailed.body': '请手动选择文本复制。',
  'diagnostics.alert.clear.title': '清空诊断日志',
  'diagnostics.alert.clear.body': '确定清空本机留存的诊断记录吗？',
  'diagnostics.alert.clear.confirm': '清空',
  // 清空**失败**必须说出来：否则列表看起来清掉了、重启后日志又回来（见 diagnostics.js
  // clearDiagnostics 的注释：删失败时缓存与存储都保留）。
  'diagnostics.alert.clearFailed.title': '清空失败',
  'diagnostics.alert.clearFailed.body': '诊断日志未能清空（存储写入失败），记录仍然保留，请稍后重试。',
  // 面板名与「关闭」是两个语义，不能共用一个键（形态照 transcription.title +
  // transcription.closeA11y）。此前 title 被误写成关闭文案 ⇒ 面板标题显示成「关闭」。
  'diagnostics.title': '诊断日志',
  'diagnostics.closeA11y': '关闭',
  'diagnostics.readFailed': '诊断日志读取失败，暂时无法显示记录。请稍后重试。',
  'diagnostics.clear': '清空',
  'diagnostics.copyAll': '复制全部',
  'diagnostics.empty': '暂无可查看的记录。',
  'diagnostics.hint': '仅保存在本机、已脱敏，不会上传到任何服务器。遇到异常时可复制后反馈。',
  // 卡顿取证（perf probe）：开关 + 超阈值样本。文案要说清两件事——它只在**超标**时记，
  // 以及开关是持久化的（用户会重启去复现，必须知道重启后仍然生效）。
  'diagnostics.perf.title': '卡顿取证',
  'diagnostics.perf.hint': '开启后只在某一段耗时超过阈值时记一条。开关会被保留，重启后仍然生效；样本只留在内存里。',
  'diagnostics.perf.switchA11y': '卡顿取证开关',
  'diagnostics.perf.empty': '还没有超过阈值的记录。',
  'diagnostics.perf.count': '已记录 {count} 条超阈值样本',
  'diagnostics.perf.worst': '最慢的一条：{label} {ms}ms',
  'diagnostics.perf.refresh': '刷新样本',
  'diagnostics.perf.clearSamples': '清空样本',
  'diagnostics.perf.saveFailed.title': '开关未能保存',
  'diagnostics.perf.saveFailed.body': '存储写入失败，开关已还原。请稍后重试（否则重启后又会变回关闭）。',
};
