// 桌面能力位（design.md「首版能力降级」）：能力判定的**唯一来源**。
//
// 界面只读这里，不散落 process.platform 判断；共享层通过既有能力探测（Platform.OS、
// typeof 模块函数、设置页开关）自然关闭 Android 专属路径。
export const CAPABILITIES = Object.freeze({
  desktop: true,
  voiceRecording: false,
  voicePlayback: false,
  localModels: false,
  workspaceTools: false,
  shellCommands: false,
  pythonExecution: false,
  github: false,
  mcp: false,
  screenWatch: false,
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
