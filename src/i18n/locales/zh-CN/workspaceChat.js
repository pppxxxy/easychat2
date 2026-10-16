// 工作区「对话」域词条（FEAT-AC12 从 workspace.js 抽出）。
//
// 为什么单独一个文件：workspace.js 已贴着 800 行硬上限，而 AC12 又要在这一域加词条
//（重复发送提示 / 小结卡关闭）。按仓库既有约定「新增域 = 新建域文件 + 在导出对象里
// 补一行 ...<域>」（见 locales/zh-CN.js 的说明），把 workspace.chat.* 整域搬出来，
// 两个文件都回到安全水位。key 仍是平铺点分，消费方零改动。

export const workspaceChat = {
  'workspace.chat.intro': '直接说出你的要求，助手会调用工作区工具完成（可附加文本文件或图片，也可录音转文字）。对话不会保存。',
  'workspace.chat.placeholder': '例如：新建 src/app.js，写一个 hello 函数',
  'workspace.chat.tool.reading': '正在调用工具：{name}',
  // P2-1：消息检索（就地过滤消息列表）
  'workspace.chat.search.placeholder': '搜索消息',
  'workspace.chat.search.clear': '清除搜索',
  'workspace.chat.search.count': '{count} 条命中',
  'workspace.chat.search.empty': '没有匹配的消息。',
  'workspace.chat.summary.title': '本次改了什么（{count} 个文件）',
  // git 开着时面板显示的是**最近一次提交**改了什么，未必是本轮（见 TurnSummaryPanel 的说明）。
  'workspace.chat.summary.titleCommit': '最近一次提交改了什么（{count} 个文件）',
  'workspace.chat.summary.op.write': '写入',
  'workspace.chat.summary.op.edit': '修改',
  'workspace.chat.summary.op.mkdir': '建目录',
  'workspace.chat.summary.undo': '撤销本轮',
  // FEAT-AC12 P0-3：第三个出口 ×（关闭）的无障碍标签。
  // 卡片此前只有「收起/撤销」，收起后仍占一行标题，用户没有真正的出口。
  'workspace.chat.summary.dismiss': '关闭本次小结',
  'workspace.chat.summary.undoHint': '撤销需要先打开「本地版本控制」（设置 → 工作区）；没打开时可在文件面板的「文件历史」里逐文件恢复。',
  'workspace.chat.summary.noParent': '没有可回退的提交：本轮改动还没被提交（每轮结束会自动提交一次）。',
  'workspace.chat.summary.commitMessage': '回滚本轮改动（{count} 个文件）',
  'workspace.chat.summary.doneTitle': '已撤销本轮',
  'workspace.chat.summary.doneBody': '已把 {count} 个文件恢复成本轮之前的样子（其中 {removed} 个是本轮新建的，已删除）。回滚本身也记了一次提交。',
  'workspace.chat.summary.failTitle': '撤销失败',
  'workspace.chat.tool.history': '看提交历史',
  'workspace.chat.summary.op.delete': '删除',
  // Q1：明细折叠——面板挂在消息滚动区外面，裸渲染整仓（1066 文件）会把消息区挤死。
  'workspace.chat.summary.more': '还有 {count} 个文件（查看全部）',
  'workspace.chat.summary.bulkFolded': '这次改动较大（{count} 个文件）——明细已折叠，点这里查看全部',
  'workspace.chat.summary.allTitle': '本次改动全部文件（{count} 个）',
  'workspace.chat.tool.running': '运行中…',
  'workspace.chat.tool.runningElapsed': '已运行 {elapsed}',
  'workspace.chat.tool.change': '改动',
  'workspace.chat.tool.content': '写入内容（{count} 字符）',
  'workspace.chat.tool.command': '命令',
  'workspace.chat.tool.code': '代码',
  'workspace.chat.tool.output': '输出',
  'workspace.chat.tool.noOutput': '（无输出）',
  'workspace.chat.tool.plan': '计划',
  'workspace.chat.tool.subtask': '子任务',
  // ---- 工具结果的「界面侧」提示（toolDefs/toolNotices.js 的 TOOL_NOTICE_KEYS）----
  // 这三条对应工具结果正文里的中文（模型侧，按铁律不翻译）。工具结果额外带 noticeKey，
  // 展示层取到后用这些词条渲染当前语言。**接线在 workspace/conversation.js 与
  // screen/ToolCallRow.js**（不在本批所有权内）——接线前工具气泡仍显示中文正文。
  // 措辞有意与模型侧不同一处：正文说「用户」（第三人称，模型读），界面说「你」（第二人称，
  // 直接对用户讲话）。两侧受众不同，不该互相将就。
  'workspace.chat.tool.notice.gitNoRepo': '本地版本控制还没就绪：这个工作区还没有 git 仓库。请在「工作区 → 设置」里打开「本地版本控制」开关（会初始化仓库），然后再试。',
  'workspace.chat.tool.notice.subagentWriteBlocked': '写子代理不可用：当前是只读模式，写操作需要你切到「可改」模式（未执行）。',
  'workspace.chat.tool.notice.workflowWriteBlocked': '工作流无法执行：步骤 {steps} 要求 write 模式，但当前是只读模式，写操作需要你切到「可改」模式（未执行）。',
  'workspace.chat.plan.title': '计划（{done}/{total}）',
  'workspace.chat.trace.title': '工具调用（{count}）',
  'workspace.chat.steering.title': '补充指令',
  'workspace.chat.steering.note': '已收到补充指令，将在下一步纳入',
  'workspace.chat.steering.attachments': '本轮还在进行：补充指令只支持文字；带附件的发送请等本轮结束。',
  'workspace.chat.planApproval.action': '批准并切换到可改模式执行',
  'workspace.chat.err': '执行失败，请稍后重试。',
  'workspace.chat.stopped': '（已停止）',
  // FEAT-AC12 P0-2：连点/卡顿时的重复发送。**必须明确提示**——
  // 静默丢弃会让用户以为「点了没反应」（正是本轮要消灭的观感）。
  'workspace.chat.duplicate.title': '刚刚已发送过相同内容',
  'workspace.chat.duplicate.body': '同一条消息在 3 秒内重复提交已忽略。如果上一轮还没开始，请稍等片刻再点发送。',
  'workspace.chat.compact.title': '压缩会话',
  'workspace.chat.compact.done': '已压缩（{applied}），旧史已摘要，尾部保留。',
  'workspace.chat.compact.noop': '当前会话无需压缩。',
  'workspace.chat.compact.fail': '压缩失败，会话未改动。',
  'workspace.chat.imageTag': '[图片]',
  'workspace.chat.attach.a11y': '附加文件',
  'workspace.chat.attach.err.title': '无法附加',
  'workspace.chat.attach.err.body': '只支持文本文件与图片，该类型暂不支持。',
  'workspace.chat.record.a11y': '录音转文字',
  'workspace.chat.recording': '正在录音…点按结束',
  'workspace.chat.voice.busy': '正在转写…',
  'workspace.chat.voice.stop': '结束',
  'workspace.chat.voice.err.title': '录音失败',
  'workspace.chat.voice.err.body': '录音或转写失败，请重试。',
  'workspace.chat.voice.none.title': '未配置语音转写',
  'workspace.chat.voice.none.body': '可在「设置 → 语音转文字」新增转写配置后重试。',
  'workspace.chat.send.a11y': '发送指令',
  'workspace.chat.stop.a11y': '停止生成',
  'workspace.chat.steer.a11y': '作为补充指令发送（不打断本轮）',
};
