// 录音时长口径（纯模块，零 React/RN 依赖 ⇒ 可在 Node 里直接单测）。
//
// 为什么单独成文件：口径是「承诺」——录到多久算合格、超了怎么办，直接决定用户会不会丢内容。
// 放在 useChatRecorder.js 里就测不到（那个文件 import 了 I18nContext.js，含 JSX，Node 进不去），
// 而口径恰恰是这次出 bug 的地方（到 60 秒整段丢弃）。

export const MIN_DURATION_MS = 500;
export const MAX_DURATION_MS = 60 * 1000;

// 过短 → 'tooShort'（丢弃并提示：那是误触，留着只会得到一段静音）
// 区间内 → 'ok'
// 超上限 → 'tooLong'（**保留**内容，只提示）
//
// 「超上限」为什么不丢弃：录音到 MAX_DURATION_MS 时由自动停止计时器定格，正常路径根本走不到
// 这里；即便计时器被宿主环境拖延（后台/掉帧）而漏网，也不该把用户整段话删掉——同一功能的
// 「转写更长的音频」入口（pickAudioFile）本来就没有时长上限，删了就是两条路径两种代价。
export function classifyRecordingDuration(elapsedMs) {
  if (elapsedMs < MIN_DURATION_MS) return 'tooShort';
  if (elapsedMs > MAX_DURATION_MS) return 'tooLong';
  return 'ok';
}
