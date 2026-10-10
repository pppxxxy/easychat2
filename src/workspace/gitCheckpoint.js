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

export const CHECKPOINT_MESSAGE_MAX = 60;
export const CHECKPOINT_FALLBACK_MESSAGE = '回合检查点';

// 提交说明 = 用户那一轮的请求（折叠空白 + 截断），这样 `git_log` 一眼能看懂每轮在做什么。
export function buildCheckpointMessage(request, { max = CHECKPOINT_MESSAGE_MAX } = {}) {
  const text = String(request === undefined || request === null ? '' : request)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return CHECKPOINT_FALLBACK_MESSAGE;
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
