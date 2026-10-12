// 两个「安全」JSON 助手（纯函数，零依赖）。
//
// 为什么单独成文件：JSON.parse / JSON.stringify 的 try-catch 包装曾在四处各写一份——
// agent/sdk.js 的 safeJson、apiProtocols/messages.js 的 safeParseJson、
// workspace/plugins/sandbox.js 与 workspace/plugins/loader.js 的 safeJson（后两份逐字相同）。
// 语义其实是**两个方向**，所以这里导出两个函数而不是一个含糊的 safeJson：
//   - safeJsonParse     解析失败 → 调用方指定的回退（sdk 要原文、apiProtocols 要 null）
//   - safeJsonStringify 序列化失败 → String(value)（循环引用 / BigInt 会抛）
// 与 utils/byteLength.js 同因：逐字相同的实现散在各处，改一处就会漂移。
// 消费方清单与「再长一份就红」的检查在 tests/safeJsonSingleSource.test.mjs。

export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return fallback;
  }
}

export function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}
