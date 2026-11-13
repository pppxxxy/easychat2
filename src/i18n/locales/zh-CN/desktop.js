// i18n 词条 · desktop 域（zh-CN 基准）：桌面版入口与「暂不支持」说明。
//
// 为什么单独成域：这些文案只服务 Windows 桌面版（Electron），Android 在线包里用不到。
// 但词条仍走同一套 mechanism（t(key) + 双语言），避免桌面出现硬编码中文。
export const desktop = {
  'desktop.status.available': '可用',
  'desktop.status.unsupported': '桌面版暂不支持',
                      'desktop.export.imageNote': '长图会按当前消息列表重绘为一张 PNG（与手机「长图」同版式）。预览区只对文本格式展示源码。',
'desktop.conversationCard.title': '从对话生成角色卡',
  'desktop.conversationCard.hint': '把当前这段对话交给模型，提炼成一张角色卡并写进制卡草稿；之后可在「扩展 → 制卡工坊」里查看、修改、导入角色库。对话越长越能抓住说话习惯，最长会保留到共享层的字数上限。',
  'desktop.conversationCard.generate': '生成为角色卡',
'desktop.roleComments.hint': '选一个角色，让它就当前内容说一句短评。桌面这版是「手动触发」；手机上还有「播放到打点自动评论」与「按音频/章节上下文评论」。',
'desktop.modelPanel.noLocal': '桌面不提供本地模型（需要 llama.cpp 原生库）；这里只列出在线 API 的模型。',
'desktop.presets.editOnMobile': '桌面这版提供开关（改动立即生效）。新增 / 编辑 / 删除预设条目仍在手机上完成——那是一整套多字段表单，属于独立工作量。',
'desktop.security.appLockUnsupported': '桌面版不提供「应用锁（生物识别）」：它依赖手机的系统锁屏/指纹入口。单角色锁基于你自己设的数字密码，与平台无关，桌面同样可用（密码用 Electron safeStorage 加密保存）。',
'desktop.autoBackup.hint': '桌面这版只备份到应用私有目录（可在下面的按钮打开该目录取走备份包）。手机侧的「选择文件夹」依赖 Android 的 content:// 目录授权；桌面没有可长期持有的目录句柄，一旦路径失效每次自动备份都会静默失败，所以不提供。',
  'desktop.proactive.desktopOnlyHint': '桌面这版**窗口开着时会到点提醒**（每分钟检查一次，用系统通知弹出并把消息写进会话）；窗口关闭后不会触发——手机侧靠系统后台服务在进程退出后唤起，桌面没有等价载体。配置存在同一份数据里，手机端读取后同样生效。',
'desktop.books.docxUnsupported': '桌面这版只解析纯文本与 Markdown。Word(.docx) 是压缩包内的 XML，需要额外解压与解析；请先在手机上导入，或另存为 txt / Markdown 后再导入桌面。',
'desktop.games.nativeHint': '「每日妻子」要读角色库数据（好感度、日程、对话历史），在手机上由原生面板承载；桌面这版先只提供网页小游戏。',
'desktop.group.unavailable': '依赖手机系统的能力',
  'desktop.group.unavailable.hint': '以下入口依赖 Android/Expo 系统能力（截屏授权、悬浮窗、Headless 后台唤起、原生推理库、受限 shell），桌面没有等价物。点开可看具体原因；其余功能桌面均已提供。',
  'desktop.unsupported.intro': '桌面版首版只提供核心聊天闭环。下面是手机上已有、桌面版暂未实现的能力——入口保留在这里，点开可以看到原因与手机上的用法。',
  'desktop.unsupported.imageGen': '生图依赖手机端的原生图片处理与相册写入；桌面版首版没有接入图像生成服务，也不能把生成的图保存到相册。需要生图请在手机上使用，生成后用「备份与恢复」把角色与聊天同步到桌面。',
  'desktop.unsupported.tts': '语音播报（TTS）依赖系统语音合成引擎。桌面版首版未接入，聊天中不会自动朗读回复，也没有手动朗读按钮。',
  'desktop.unsupported.transcription': '语音转文字（ASR）依赖录音与语音识别能力。桌面版首版不支持录音，也就没有转写入口——语音消息在桌面只显示为占位。',
  'desktop.unsupported.localModels': '本地模型推理依赖 llama.rn 原生库（Android/iOS 专用），Windows 上没有对应实现。桌面版只能连接在线 API 接口。',
  'desktop.unsupported.workspace': '工作区（文件管理、命令执行、GitHub 集成、Python 工具）依赖原生 shell 与文件系统权限。桌面版出于安全边界（渲染进程沙箱 + IPC 白名单）首版未开放。',
  'desktop.unsupported.plugins': '插件运行时依赖 Android 侧的原生桥接与 JS 沙箱。桌面版首版未实现插件加载，扩展页只显示内置能力状态。',
  'desktop.unsupported.mcp': '内置 MCP 服务器需要常驻后台监听端口并调用原生能力。桌面版首版未实现，外部 agent 无法连接本应用。',
  'desktop.unsupported.screenWatch': '看屏幕（悬浮窗截图 + 帧序列识别）依赖 Android 的屏幕捕获与悬浮窗权限。桌面版没有对应能力。',
  'desktop.unsupported.proactive': '主动消息与定时任务依赖 Android 后台服务（WorkManager / 前台服务）。桌面版只在窗口打开时运行，不会在后台定时触发。',
  'desktop.unsupported.scheduled': '定时任务依赖系统闹钟与后台唤醒。桌面版首版未实现调度器；需要定时任务请在手机上使用。',
  'desktop.entry.localModels': '本地模型',
  'desktop.entry.workspace': '工作区与工具',
  'desktop.entry.plugins': '插件',
  'desktop.entry.mcp': 'MCP 服务器',
  'desktop.entry.screenWatch': '看屏幕',
  'desktop.entry.scheduled': '定时任务',
};

export default desktop;