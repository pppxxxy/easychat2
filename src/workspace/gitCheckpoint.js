// 回合检查点（W7）：把 agent 每一轮的改动落成本地提交。
//
// 为什么需要它：三个只读 git 工具只能回答「现在改了什么」，而**历史要靠人来攒**。
// 检查点把「每轮结束」变成一次本地提交，于是：
//   · `git_log` 变成「我这几轮都干了什么」；
//   · `checkoutAll` 有了明确的回滚目标（回到本轮之前）；
//   · `fileHistory` 快照不覆盖 `run_shell` 改的文件这个漏洞，由 git 检查点兜住。
//
// 三条纪律：
// 1. **绝不阻塞、绝不失败回合**：检查点是旁路增强，任何异常都被吞掉并如实回报 reason。
//    调用方 fire-and-forget（`.catch(() => {})`）。
// 2. **不产生空提交**：本轮没改动就没有提交（`commitAll` 返回 null）。
// 3. **不替用户开仓库**：仓库由设置里的开关建（`ensureRepo`）；这里只提交，未就绪就跳过。

// 提交说明兜底走 i18n：它会经 git.commit **写进本地提交历史**，之后由 git_log 工具
// 与「历史」面板直接显示——硬编码中文会让英文用户在自己的提交历史里读到中文。
// 用 tActive（非 React 树的同步取词，与 markdownGuard.js / imageGen 同款）：
// buildCheckpointMessage 是纯函数，调用点在 fire-and-forget 的回调里，拿不到 hook。
// 只 import tActive —— 多处测试把 i18n/index.js 打桩成 `{ tActive }`。
//
// 关键：提交信息**一旦写入 git 历史就固定了**，所以词条要在**提交时**取当前语言的值
//（就是这里的默认参数在调用瞬间求值），而不是存 key 等到展示时再翻——那样历史里的
// 旧提交会随界面语言变化而「变脸」，与 git 的不可变语义冲突。
//
// 由此推出第二条：**词条缺失时不回落到任何一种语言**，只回落到语言无关的稳定标识
//（CHECKPOINT_FALLBACK_ID）。理由见 checkpointFallbackMessage 的注释。
import { tActive } from '../i18n/index.js';

export const CHECKPOINT_MESSAGE_MAX = 60;
export const CHECKPOINT_FALLBACK_KEY = 'workspace.git.checkpointFallback';
// 词条缺失时的回落：语言无关的稳定标识，**不是**某一种语言的文案。
//
// 取舍（为什么宁可写 `checkpoint` 也不写中文）：这条兜底经 git.commit **写进用户的提交
// 历史**，而历史不可变——落笔之后再切界面语言也不会变。于是：
//   · 回落中文 ⇒ 英文用户的历史里躺着中文；
//   · 回落英文 ⇒ 中文用户的历史里躺着英文；
//   · 回落 key 本身 ⇒ 把 `workspace.git.checkpointFallback` 这种内部标识写进用户历史，最糟。
// 前两种都是「错一半」，所以干脆不回落到任何语言：`checkpoint` 中英用户都认得出是「检查点」，
// 且它不冒充文案——用户一眼能看出这是系统兜底，而不是自己或模型写过的话。
//
// 为什么不用「空提交信息 + 让调用方决定」：commitAll 把空串原样交给 isomorphic-git，
// 会生成一条无标题提交（git log 里只剩 oid），比标识更难追溯；而调用方 runTurnCheckpoint
// 是 fire-and-forget，手里没有能「决定」的上下文（它连 request 都可能为空）。
export const CHECKPOINT_FALLBACK_ID = 'checkpoint';

// 兜底提交说明：t 可注入（测试），默认当前活动语言。
export function checkpointFallbackMessage(t = tActive) {
  const text = typeof t === 'function' ? String(t(CHECKPOINT_FALLBACK_KEY) || '') : '';
  // 词条漏登记时 t 返回 key 本身——那会把 `workspace.git.checkpointFallback` 写进
  // 用户的 git 历史（比中文/英文都糟），所以这里回落到语言无关的稳定标识，见上。
  return text && text !== CHECKPOINT_FALLBACK_KEY ? text : CHECKPOINT_FALLBACK_ID;
}

// 提交说明 = 用户那一轮的请求（折叠空白 + 截断），这样 `git_log` 一眼能看懂每轮在做什么。
export function buildCheckpointMessage(request, { max = CHECKPOINT_MESSAGE_MAX, t = tActive } = {}) {
  const text = String(request === undefined || request === null ? '' : request)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return checkpointFallbackMessage(t);
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : CHECKPOINT_MESSAGE_MAX;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// 跑一次检查点。返回判别式结果（调用方一般不关心，但测试与将来的 UI 需要）：
//   { ok: true, oid }                     —— 已提交
//   { ok: false, skipped: 'no-git' }      —— 开关关 / 外部根（runner 为 null）
//   { ok: false, skipped: 'no-repo' }     —— 仓库还没建
//   { ok: false, skipped: 'no-change' }   —— 本轮没改动
//   { ok: false, skipped: 'failed', error }—— 提交失败（已吞掉，不影响回合）
export async function runTurnCheckpoint({ git, request = '', characterId = '' } = {}) {
  if (!git || typeof git.open !== 'function') return { ok: false, skipped: 'no-git' };
  try {
    const handle = git.open({ characterId });
    if (!(await handle.isRepo())) return { ok: false, skipped: 'no-repo' };
    const oid = await handle.commitAll(buildCheckpointMessage(request));
    return oid ? { ok: true, oid } : { ok: false, skipped: 'no-change' };
  } catch (error) {
    return { ok: false, skipped: 'failed', error: String((error && error.message) || '') };
  }
}
