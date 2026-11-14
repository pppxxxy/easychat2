// 桌面能力位（design.md「首版能力降级」）：能力判定的**唯一来源**。
//
// 界面只读这里，不散落 process.platform 判断；共享层通过既有能力探测（Platform.OS、
// typeof 模块函数、设置页开关）自然关闭 Android 专属路径。
export const CAPABILITIES = Object.freeze({
  desktop: true,
  // 录音：需要麦克风采集 + expo-audio 的 AudioRecorder（原生 AVFoundation/CoreAudio）。
  // 桌面渲染层有 MediaRecorder，但它只产 webm/opus，且要自建权限提示与编码链路；
  // 共享层 useChatRecorder 的契约是 expo-audio（recorder.uri + RecordingPresets），
  // **没有**对应的桌面实现，所以录音仍不可用——这是能力缺失，不是「不可移植」。
  voiceRecording: false,
  // 语音播报用 Web Speech API（Chromium 自带），已可用；录音仍不可用（见 voiceRecording）。
  voicePlayback: true,
  // 语音转写（ASR）：共享层 src/transcription.js 是**纯 HTTP**（POST /v1/audio/transcriptions），
  // 不依赖任何原生能力。桌面的唯一障碍是渲染层 fetch 装不下 RN 形态的文件项，
  // 已由 platform/fetch.js + 主进程 multipart 通道解决（含目录白名单）。
  voiceTranscription: true,
  localModels: false,
  workspaceTools: false,
  shellCommands: false,
  pythonExecution: false,
  github: false,
  mcp: false,
  // 看屏幕：截**本应用**画面 → 视觉模型评论，走 webContents.capturePage（零权限）。
  // 跨应用截屏与悬浮窗（手机 MediaProjection + SYSTEM_ALERT_WINDOW）仍不可移植，
  // 但那是「看屏幕」的一个子能力（见 unsupportedReasons.screenOverlay），不是全部。
  screenWatch: true,
  // 悬浮窗子能力：在其他应用之上绘制自己的界面 + 跨应用截屏。桌面无等价物
  //（desktopCapturer 只能拿用户经系统选择器授权的单窗口流，且不能置顶渲染自家 UI）。
  // 与 screenWatch 分开记：一个是页面，一个是页面里的一个入口。
  screenOverlay: false,
  proactiveMessages: false,
  scheduledTasks: false,
  appLock: false,
  vectorMemory: false,
  imageGeneration: false,
  plugins: false,
  moments: false,
  diary: false,
  worldMap: false,
  books: false,
  music: false,
});

export function isCapabilityAvailable(name) {
  return CAPABILITIES[name] === true;
}
