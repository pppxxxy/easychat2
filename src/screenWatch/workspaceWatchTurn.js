// SW2：看屏幕·工作区会话的回合编排（纯逻辑 + 注入依赖，Node 可直测）。
//
// 与聊天侧（useScreenWatchComments.generate）的分工：
//   · 聊天侧 = 角色评论：buildRequestMessages + sendChatMessage（纯文本/多模态，无工具）；
//   · 本模块 = 工作区会话：buildWorkspaceAgentMessages + runAgentTurn（**带工具集与权限门控**），
//     让工作区助手在看屏幕时能真的干活（列文件、跑测试、改文件），破坏性操作走确认弹窗。
//
// 为什么单独一个模块而不是塞进 hook：这条链的判定（scope 分流、确认注入、线程落库、
// 失败文案）全是可测逻辑，而 hook 本身在 Node 里进不来（react-native Flow 语法）。
// 依赖全注入（runAgent / confirm / appendEntry / t / readFrame），因此能完整单测。
//
// 边界（如实标注）：SW3 的原生 mini 聊天尚未落地，本模块先由 App 内面板驱动；
// 悬浮窗侧一旦接上，复用同一函数即可（scope='workspace' 的入口不分驱动来源）。
//
// **不静态 import threads.js**：那个模块拉进 storage/io.js（expo 原生依赖），
// Node 测试环境进不来。role 字面量与 threads.js 同值（'user'/'assistant'），
// 由 tests/workspaceWatchTurn.test.mjs 的断言与 threads.js 的口径对齐。
const THREAD_ROLE_USER = 'user';
const THREAD_ROLE_CHARACTER = 'assistant';

const COMMENT_TEXT_MAX = 2000;

// 纯函数：这次请求该走哪条管线。'workspace' → agent 管线（带工具）；其余 → 聊天评论管线。
// 判据只看 scope（线程归属），不看面板/悬浮窗来源——同一 scope 在两种驱动下行为一致。
export function resolveScreenWatchPipeline(scope) {
  return scope === 'workspace' ? 'workspace-agent' : 'chat-comment';
}

// 纯函数：把线程条目转成 agent 历史（只取有文本的，取最近 N 条）。
// 与聊天侧的 historyMessages 同口径（role 沿用 user/assistant）。
// limit=0 表示**不要历史**（`slice(-0)` 在 JS 里等于 `slice(0)` 会返回全部——必须显式挡）。
export function buildScreenWatchAgentHistory(entries, limit = 12) {
  const max = Math.max(0, Math.floor(Number(limit)) || 0);
  if (max === 0) return [];
  const list = (Array.isArray(entries) ? entries : [])
    .filter(item => item && typeof item.text === 'string' && item.text.trim())
    .slice(-max);
  return list.map(item => ({
    role: item.role === THREAD_ROLE_USER ? 'user' : 'assistant',
    content: String(item.text).trim(),
  }));
}

// 纯函数：本轮要落库的条目（用户说话 + 助手回复），供调用方逐条 append。
// 不在这里写存储——写失败必须由调用方按既有纪律吞掉（不挡主流程）。
export function buildScreenWatchTurnEntries({ userText, replyText, imageUri, at = Date.now(), idFactory } = {}) {
  const makeId = typeof idFactory === 'function'
    ? idFactory
    : prefix => `${prefix}-${at}-${Math.random().toString(36).slice(2, 8)}`;
  const entries = [];
  const said = String(userText || '').trim();
  if (said) {
    entries.push({
      id: makeId('swu'),
      role: THREAD_ROLE_USER,
      text: said,
      imageUri: String(imageUri || ''),
      at,
    });
  }
  const reply = String(replyText || '').trim();
  if (reply) {
    entries.push({
      id: makeId('swc'),
      role: THREAD_ROLE_CHARACTER,
      text: reply.slice(0, COMMENT_TEXT_MAX),
      imageUri: String(imageUri || ''),
      at,
    });
  }
  return entries;
}

// FEAT-AC7 P0-C：**四种收尾都落库**（成功 / 失败 / 中止 / 超时）。
//
// 为什么这是必须的（用户截图 #288）：此前只有**成功**路径落库，中止路径直接
// `return { ok:false, error:'' }` 什么都不写 ⇒ 线程被创建出来却 0 条目，
// 面板显示「（暂无内容）/ 这场对话还没有内容」。用户看到的是「我的消息也没了」——
// 那是比失败更糟的观感：连自己说过什么都不记得。
//
// 纪律：用户说过的话**永远**先落（它是事实），结论文案按收尾类型给明确的一句话。
// 写盘失败不挡主流程（与既有纪律一致）。
async function persistTurnEntries({ thread, appendEntry, userText, conclusionText, imageUri, onAppend = null }) {
  if (!thread || typeof appendEntry !== 'function') return;
  const entries = buildScreenWatchTurnEntries({
    userText,
    replyText: conclusionText,
    imageUri,
  });
  for (const entry of entries) {
    // FEAT-AC8 P0-C：**每条落库都留痕**。
    // 此前这里是裸 `catch (error) {}` —— 静默吞错，于是「到底写没写进去」
    // 真机上无法证实也无法证伪（任务书 §四 明确标注了这个盲区）。
    // 留痕只记「线程 id 尾 4 位 + role + ok/fail」，不含正文（隐私）。
    let ok = true;
    try {
      await appendEntry(thread.id, entry);
    } catch (error) {
      ok = false;
    }
    if (typeof onAppend === 'function') {
      try {
        onAppend({ threadId: thread.id, role: entry.role, ok });
      } catch (error) {}
    }
  }
}

// 收尾类型的判据（纯函数，可直测）：中止 > 超时 > 其它失败。
// 中止与超时必须分开：前者是用户的意图（「已停止」），后者是故障（「超时未响应」）。
export function classifyTurnEnding({ error = null, timedOut = false } = {}) {
  if (error && error.canceled === true) return 'aborted';
  if (error && error.name === 'AbortError') return 'aborted';
  if (timedOut === true || (error && error.timedOut === true)) return 'timeout';
  return 'failed';
}

// 收尾文案（i18n key + 参数）。纯映射，测试可直接断言「哪种收尾说哪句话」。
export function turnEndingTextKey(ending) {
  if (ending === 'aborted') return 'screenWatch.overlay.turnStopped';
  if (ending === 'timeout') return 'screenWatch.overlay.turnTimeout';
  return 'screenWatch.comments.failed';
}


// IO 编排：跑一轮工作区看屏幕会话。
// 返回 { ok, text, steps, error }——**不抛**（调用方是 UI 回调，抛错只会变成未捕获拒绝）。
// 依赖注入：runAgent（runHeadlessAgent）/ confirm（工具确认）/ readFrame（本地路径 → data URI）
// / appendEntry（线程落库）/ mode / characterId / signal / t（文案）。
export async function runWorkspaceWatchTurn({
  userText = '',
  imageUri = '',
  imageUris = [],
  thread = null,
  historyLimit = 12,
  mode = 'read',
  characterId = '',
  signal = null,
  runAgent,
  confirm = null,
  permissionRules = null,
  readFrame = null,
  appendEntry = null,
  onToolEvent = null,
  // FEAT-AC8 P0-D：回合打点（宿主注入；缺省不打点）。**打点收口在本函数**——
  // 面板与悬浮窗两条驱动路径都经这里，于是「同一件事只记一份」，
  // 且真实轮数只有这一层看得全（见下面 maxRound 的说明）。
  onTurnEvent = null,
  // FEAT-AC8 P0-C：落库留痕（宿主注入；缺省不记）。记「线程 id 尾 4 位 + role + ok/fail」。
  // 为什么注入而不是本文件直接调 turnDiagnostics：本模块要在纯 Node 里直测
  //（见文件头「不静态 import threads.js」的同一理由），注入让测试能断言「记了什么」。
  onThreadAppend = null,
  t = key => key,
} = {}) {
  const said = String(userText || '').trim();
  const uris = (Array.isArray(imageUris) ? imageUris : []).map(item => String(item || '')).filter(Boolean);
  if (uris.length === 0 && imageUri) uris.push(String(imageUri));
  // 纯文字且没内容 → 不发请求（与聊天侧同一判据）。
  if (uris.length === 0 && !said) return { ok: false, text: '', steps: [], error: '' };
  if (typeof runAgent !== 'function') {
    return { ok: false, text: '', steps: [], error: t('screenWatch.error.agentUnavailable') };
  }

  // FEAT-AC8 P0-D：真实轮数贯通。
  // 任务书指出「日志里 round=0 是硬编码的 0，纯打点质量问题」——正确。
  // 轮数的**唯一来源**是 onToolEvent 的 event.round（loop.js 每轮带真实轮号），
  // 本函数包一层取最大值，于是 turn-* 打点不必再猜、也不必硬编码。
  const startedAt = Date.now();
  let maxRound = 0;
  const emitTurn = (event, fields = {}) => {
    if (typeof onTurnEvent !== 'function') return;
    try {
      onTurnEvent({ event, round: maxRound, elapsed: Date.now() - startedAt, ...fields });
    } catch (error) {}
  };
  const forwardToolEvent = event => {
    if (event && Number.isFinite(Number(event.round))) {
      maxRound = Math.max(maxRound, Number(event.round));
    }
    if (typeof onToolEvent === 'function') onToolEvent(event);
  };
  // 落库留痕器：只取线程 id 尾 4 位（够定位是哪一场，又不把 id 全文写进日志）。
  const appendTracer = typeof onThreadAppend === 'function'
    ? info => onThreadAppend({
      threadTail: String(info.threadId || '').slice(-4),
      role: info.role,
      ok: info.ok === true,
    })
    : null;
  emitTurn('turn-start');

  try {
    // 帧 → data URI（接口只认 data:/http(s)，本地 file:// 会被服务端忽略）。
    let frames = [];
    if (uris.length > 0 && typeof readFrame === 'function') {
      try {
        frames = await Promise.all(uris.map(uri => readFrame(uri)));
      } catch (error) {
        emitTurn('turn-timeout', { error: new Error('frame-read-failed') });
        return { ok: false, text: '', steps: [], error: t('screenWatch.capture.failed.body') };
      }
    }
    if (signal && signal.aborted) return { ok: false, text: '', steps: [], error: '' };

    const history = buildScreenWatchAgentHistory(thread ? thread.entries : [], historyLimit);
    const result = await runAgent({
      prompt: said,
      messages: history,
      mode,
      characterId,
      signal,
      images: frames.filter(Boolean),
      // 破坏性操作（写文件 / 跑命令 / git 提交）执行前弹确认；不传时 registry 会拒绝。
      confirm,
      // 权限规则（hooks.json + 用户存储）：不传时写工具上的手写 deny 会失效（P0-2）。
      permissionRules,
      onToolEvent: forwardToolEvent,
      // 打点透传给 agent 循环（缺省不传 = 不打点）。
      ...(typeof onTurnEvent === 'function' ? { onTurnEvent } : {}),
    });
    const text = String((result && result.text) || '').trim();
    if (!text) {
      // 模型没给正文（占位/空回复）：也算一种收尾——照样落库，不让线程空着。
      const emptyConclusion = t('error.comments.noReply');
      await persistTurnEntries({
        thread, appendEntry, userText: said, conclusionText: emptyConclusion, imageUri: uris[0] || '',
        onAppend: appendTracer,
      });
      return { ok: false, text: '', steps: (result && result.steps) || [], error: emptyConclusion };
    }

    // 线程落库：写失败不挡本轮结果（与聊天侧同款纪律）。
    await persistTurnEntries({
      thread, appendEntry, userText: said, conclusionText: text, imageUri: uris[0] || '',
      onAppend: appendTracer,
    });
    emitTurn('turn-done');
    return { ok: true, text, steps: (result && result.steps) || [], error: '' };
  } catch (caught) {
    // FEAT-AC7 P0-C：**中止 / 超时 / 失败三种收尾也要落库**（用户消息 + 结论文案）。
    // 中止曾在此处直接 return 且什么都不写 ⇒ 线程 0 条目（截图 #288）。
    const ending = classifyTurnEnding({ error: caught, timedOut: !!(caught && caught.timedOut) });
    const detail = String((caught && caught.message) || '').trim();
    const conclusion = ending === 'failed' && detail
      ? `${t(turnEndingTextKey(ending))}\n${detail}`
      : t(turnEndingTextKey(ending));
    await persistTurnEntries({
      thread, appendEntry, userText: said, conclusionText: conclusion, imageUri: uris[0] || '',
      onAppend: appendTracer,
    });
    // P0-D：收尾打点带**真实轮数**（maxRound 由 onToolEvent 累积而来）。
    emitTurn(ending === 'aborted' ? 'turn-done' : 'turn-timeout', caught ? { error: caught } : {});
    // 中止不是失败：不给用户看错误（既有语义不变），但它**已经落库**了。
    if (ending === 'aborted') return { ok: false, text: '', steps: [], error: '' };
    return { ok: false, text: '', steps: [], error: conclusion };
  }
}
