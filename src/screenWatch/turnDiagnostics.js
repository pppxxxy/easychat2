// FEAT-AC7 P0-D：agent 回合的**结构化打点**（纯逻辑，零 RN 依赖 → Node 直测）。
//
// 为什么必须打点（本轮的教训）：BUG-2 的挂点只能靠「代码里没有超时 + 症状形态」推断，
// 而诊断日志当时**全空**——不是没有错误，是观测器压根没上班（P0-A 修的结构病）。
// 下一次卡住时，日志要能直接说出「卡在第几轮、哪个工具、已耗时多少」，
// 而不是再让人对着截图推演一遍。
//
// 分级纪律（沿用 AC5 P0-C）：全部是 **info 级、无堆栈**（传 { message } 对象）。
// 回合打点是「发生过什么」的流水账，不是错误；用 new Error 会让真错误再次被埋掉。
//
// 本模块只**组装**消息文本，落盘由注入的 recorder 负责——于是能在 Node 里断言
// 「哪一步该记什么」，不必碰 AsyncStorage。

export const TURN_EVENTS = Object.freeze([
  'turn-start',
  'turn-tool',
  'turn-done',
  'turn-timeout',
]);

// 允许的字段（白名单）：打点是给排查用的，不该把工具参数（可能含用户内容/路径）整包写进去。
// 只留「模型 / 轮数 / 工具名 / 耗时」四个——足以定位挂点，且不含隐私正文。
const FIELDS = Object.freeze(['model', 'round', 'tool', 'elapsed', 'error']);

/**
 * 组装一条回合打点的文本。
 *
 * @param {string} event TURN_EVENTS 之一
 * @param {object} fields 白名单字段（缺失的省略，不写 `undefined`）
 * @returns {string} 例：`turn-tool round=2 tool=set_app_setting elapsed=1200ms`
 */
export function formatTurnEvent(event, fields = {}) {
  const name = TURN_EVENTS.includes(event) ? event : 'turn-unknown';
  const source = fields && typeof fields === 'object' ? fields : {};
  const parts = [name];
  for (const key of FIELDS) {
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    // error 只取 message 一行并截断：堆栈由真错误路径负责，这里只是定位线索。
    const text = key === 'error'
      ? String((value && value.message) || value).split('\n')[0].slice(0, 160)
      : String(value);
    if (!text) continue;
    parts.push(`${key}=${key === 'elapsed' ? `${text}ms` : text}`);
  }
  return parts.join(' ');
}

let recorder = null;

/** 注入落盘实现（app 级装配 / 测试）。传 null 恢复为「不打点」。 */
export function setTurnEventRecorder(fn) {
  recorder = typeof fn === 'function' ? fn : null;
}

/**
 * 记一条回合打点。**永不抛**（打点是辅助能力，不该影响主流程——与诊断模块同款纪律）。
 * 未注入 recorder 时静默（纯 Node 单测的缺省）。
 */
export function noteTurnEvent(event, fields = {}) {
  if (!recorder) return;
  try {
    recorder(formatTurnEvent(event, fields));
  } catch (error) {
    // 落盘失败不挡回合。
  }
}
