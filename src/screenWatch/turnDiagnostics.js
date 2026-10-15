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
  // FEAT-AC8 P0-C：落库留痕（**不是** turn-* 回合事件，但走同一条落盘通道）。
  // 为什么要它：persistTurnEntries 此前是裸 catch 静默吞错，真机上「那条消息
  // 到底写进线程没有」无法证实也无法证伪（任务书 §四 明确标注了这个盲区）。
  'thread-append',
]);

// 允许的字段（白名单）：打点是给排查用的，不该把工具参数（可能含用户内容/路径）整包写进去。
// 只留「模型 / 轮数 / 工具名 / 成败 / 耗时 / 线程尾号 / 角色」——足以定位挂点，且不含隐私正文。
// ok 只写 'ok' / 'fail' 两个字面量（不是任意值），避免工具结果正文从这里漏进日志。
// threadTail 只取线程 id **尾 4 位**（够认出是哪一场，又不把 id 全文写进日志）。
const FIELDS = Object.freeze(['model', 'round', 'tool', 'ok', 'threadTail', 'role', 'elapsed', 'error']);

/**
 * 组装一条回合打点的文本。
 *
 * @param {string} event TURN_EVENTS 之一
 * @param {object} fields 白名单字段（缺失的省略，不写 `undefined`）
 * @returns {string} 例：`turn-tool round=2 tool=set_app_setting ok=false elapsed=1200ms`
 */
export function formatTurnEvent(event, fields = {}) {
  const name = TURN_EVENTS.includes(event) ? event : 'turn-unknown';
  const source = fields && typeof fields === 'object' ? fields : {};
  const parts = [name];
  for (const key of FIELDS) {
    const value = source[key];
    // ⚠️ 只挡 undefined / null / 空串：**不能**用 `!value`——`ok=false` 与
    // `elapsed=0` 都是有意义的值，falsy 过滤会把它们吞掉（那就白记了）。
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
