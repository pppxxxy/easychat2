// i18n 词条 · vectorProvider 域（zh-CN 基准）。聚合入口见 ../zh-CN.js。
export const vectorProvider = {
  'vectorProvider.openaiEmbeddings': 'OpenAI 兼容',
  // 「本版本不认识用户存下的 providerId」（getVectorProvider 返回 null 时的 fail-closed 报错）。
  // 口径刻意**不说**「配置错误」：用户可能只是从装了更多 provider 的版本降级/换端回来，
  // 他的配置没写错。照 error.vectorMemory.baseUrlRequired 那种「先说明事实 + 下一步」的口气，
  // 并说清为什么中止（已停止向量记忆，避免把聊天内容发往形状未知的服务）。
  // 词条落在本域（vectorProvider）而不是 error 域：它与 vectorProvider.openaiEmbeddings 同属
  // provider 目录的界面文案，且 error.js 当时正被别的批次写入（避免并发覆盖）。
  'vectorProvider.unknownProvider': '保存的向量服务「{id}」本版本不认识，已停止向量记忆，以免把内容发往未知服务',
};
