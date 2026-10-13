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

  try {
    // 帧 → data URI（接口只认 data:/http(s)，本地 file:// 会被服务端忽略）。
    let frames = [];
    if (uris.length > 0 && typeof readFrame === 'function') {
      try {
        frames = await Promise.all(uris.map(uri => readFrame(uri)));
      } catch (error) {
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
      onToolEvent,
    });
    const text = String((result && result.text) || '').trim();
    if (!text) return { ok: false, text: '', steps: (result && result.steps) || [], error: t('error.comments.noReply') };

    // 线程落库：写失败不挡本轮结果（与聊天侧同款纪律）。
    if (thread && typeof appendEntry === 'function') {
      const entries = buildScreenWatchTurnEntries({
        userText: said,
        replyText: text,
        imageUri: uris[0] || '',
      });
      for (const entry of entries) {
        try {
          await appendEntry(thread.id, entry);
        } catch (error) {}
      }
    }
    return { ok: true, text, steps: (result && result.steps) || [], error: '' };
  } catch (caught) {
    if (signal && signal.aborted) return { ok: false, text: '', steps: [], error: '' };
    const detail = String((caught && caught.message) || '').trim();
    return {
      ok: false,
      text: '',
      steps: [],
      error: detail ? `${t('screenWatch.comments.failed')}\n${detail}` : t('screenWatch.comments.failed'),
    };
  }
}
