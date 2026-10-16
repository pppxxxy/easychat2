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
  // FEAT-AC9 P0-3：中止与失败**不再冒充** turn-done / turn-timeout。
  //
  // 事故：workspaceWatchTurn 的 catch 收尾原写 `ending === 'aborted' ? 'turn-done' : 'turn-timeout'`
  // —— 用户点「停止」在日志里显示成**正常完成**，而任何非超时的失败（断网 503）显示成
  // 「超时」。日志的作用是回答「这轮怎么结束的」，错标比不打点更糟：它会让人朝错误方向查。
  // classifyTurnEnding 早已把 aborted / timeout / failed 分成三种（那里的注释就写着
  // 「中止是意图，超时是故障」），打点却把它们压成两种——这是同一条纪律的半截执行。
  'turn-aborted',
  'turn-failed',
  // FEAT-AC8 P0-C：落库留痕（**不是** turn-* 回合事件，但走同一条落盘通道）。
  // 为什么要它：persistTurnEntries 此前是裸 catch 静默吞错，真机上「那条消息
  // 到底写进线程没有」无法证实也无法证伪（任务书 §四 明确标注了这个盲区）。
  'thread-append',
]);

// 允许的字段（白名单）：打点是给排查用的，不该把工具参数（可能含用户内容/路径）整包写进去。
// 只留「模型 / 轮数 / 工具名 / 成败 / 中止理由 / 耗时 / 线程尾号 / 角色」——足以定位挂点，且不含隐私正文。
// ok 只写 'ok' / 'fail' 两个字面量（不是 true/false，也不是任意值）——
// 见 formatTurnEvent 里对 ok 的归一；这样「成败」在日志里是一个词，与工具结果正文无关。
// reason 是聚合字段（FEAT-AC11）：中止理由（panel-switch / screen-close / user-stop…）。
// 只放**调用方给的短标签**，不是自由文本——它是枚举式的原因码，不是正文通道。
// threadTail 只取线程 id **尾 4 位**（够认出是哪一场，又不把 id 全文写进日志）。
const FIELDS = Object.freeze(['model', 'round', 'tool', 'ok', 'reason', 'threadTail', 'role', 'elapsed', 'error']);

/**
 * FEAT-AC9 P0-1：**形状归一**——把两种调用形状统一成 `{ name, fields }`。
 *
 * 本轮根因（真机 4 条 turn-unknown，已对码核实）：发射方与接收方的签名对不上，
 * 而两个接线点把两者**裸焊**在一起：
 *   · 发射方 loop.js（`safeCallback(onTurnEvent, { event, ...fields })`）与
 *     workspaceWatchTurn.js（`onTurnEvent({ event, round, elapsed, ...fields })`）
 *     都传**单个对象**；
 *   · 接收方 noteTurnEvent 的签名是**两参** `(事件名字符串, fields 对象)`；
 *   · 接线点 overlayWorkspaceTurn.js / ScreenWatchPanel.js 写的是 `onTurnEvent: noteTurnEvent`
 *     ——对象进了 `TURN_EVENTS.includes(event)` ⇒ 恒 false ⇒ 全部落 `turn-unknown`，
 *     且 fields 缺省 `{}` ⇒ 字段全丢。
 * 反证就在同一个文件里：`onThreadAppend: info => noteTurnEvent('thread-append', info)`
 * 是显式两参调用，所以 thread-append 字段齐全。**一个文件两种形状并存**就是翻车点。
 *
 * 为什么归一放在接收方（而不是只改发射方）：接收方是**所有**接线点的必经之路，
 * 一处修改同时修好两个接线点，并对未来任何新接线防呆（新增驱动路径忘记对齐形状时，
 * 打点仍然可读而不是集体变 turn-unknown）。发射方的两参统一是**契约**，
 * 这里的对象形态保留为**防御层**——生产不再走它，但它让「形状漂移」不再等于「打点全废」。
 *
 * @param {string|object} event 事件名，或 `{ event, ...fields }` 单对象
 * @param {object} [fields] 显式 fields（与对象里的字段**合并**，显式参数优先）
 * @returns {{ name: string, fields: object }}
 */
export function normalizeTurnEvent(event, fields = {}) {
  const explicit = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
  // 单对象形态：{ event: 'turn-tool', round, tool, ... }
  if (event && typeof event === 'object' && !Array.isArray(event)) {
    const { event: name, ...rest } = event;
    // ⚠️ 显式 fields 必须**覆盖**对象内同名字段：两参调用若要修正某个字段，
    // 后者说了算（谁更具体谁优先——与「显式参数优先」的常规直觉一致）。
    return { name, fields: { ...rest, ...explicit } };
  }
  return { name: event, fields: explicit };
}

/**
 * 组装一条回合打点的文本。
 *
 * @param {string|object} event TURN_EVENTS 之一，或 `{ event, ...fields }` 单对象
 * @param {object} fields 白名单字段（缺失的省略，不写 `undefined`）
 * @returns {string} 例：`turn-tool round=2 tool=set_app_setting ok=fail elapsed=1200ms`
 */
export function formatTurnEvent(event, fields = {}) {
  const { name: rawName, fields: source } = normalizeTurnEvent(event, fields);
  const name = TURN_EVENTS.includes(rawName) ? rawName : 'turn-unknown';
  const parts = [name];
  for (const key of FIELDS) {
    const value = source[key];
    // ⚠️ 只挡 undefined / null / 空串：**不能**用 `!value`——`ok=false` 与
    // `elapsed=0` 都是有意义的值，falsy 过滤会把它们吞掉（那就白记了）。
    if (value === undefined || value === null || value === '') continue;
    // FEAT-AC9 P0-3：ok 归一成 'ok' / 'fail' 两个字面量（本文件 FIELDS 的注释一直
    // 宣称如此，而实现渲染的是 true/false——注释与行为二选一改齐，改行为）。
    // 顺序要紧：归一放在**空值检查之后**，否则 false 会被 `value === ''` 之外的
    // 任何提前判空吞掉（这正是 AC8 修过的那个坑）。
    const text = key === 'ok'
      // 布尔是规范输入；已经是 'ok' 字面量时**幂等**通过——同一条打点被二次包装
      // 或转发时，不会把成功翻成失败（那是方向错误的降级：日志说失败、实际成功）。
      ? (value === true || value === 'ok' ? 'ok' : 'fail')
      // error 只取 message 一行并截断：堆栈由真错误路径负责，这里只是定位线索。
      : key === 'error'
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
