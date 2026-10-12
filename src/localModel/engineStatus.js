// 本地引擎状态派生（v5 Stage C，D5）：把「本地是否启用 + 运行态 + 回退事件」压成
// 聊天层状态条需要的呈现模型。纯函数，可 Node 直测；组件只负责渲染与订阅。
//
// 状态条只在「本地已启用且选了活动模型」时出现；回退提示（本地失败静默回退在线）
// 有独立时间窗，窗口内优先展示回退警告，让用户知道这条回复来自在线。
//
// **降级提示延时**（2026-10-12）：回退警告不再在事件发生的瞬间就弹，而是先等
// FALLBACK_NOTICE_DELAY_MS。理由：本地失败相当一部分是瞬时的（引擎正在加载/被占用，
// 下一次请求重新加载就成功），立刻弹一条警告会在对话中闪一下就没——用户看到红条、
// 却说不清发生了什么，纯噪音。等 3 秒再提示：既滤掉这种抖动，又短到用户仍能把
// 「这条回复来自在线」和正在读的这条回复对上。

export const ENGINE_TONE = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  ERROR: 'error',
  FALLBACK: 'fallback',
};

// 提示出现前先等多久（滤掉瞬时抖动）。3 秒 = 一次重试/重新加载通常已经出结果的量级，
// 又不至于让用户以为「已经在用本地了」。
export const FALLBACK_NOTICE_DELAY_MS = 3000;
// 提示出现后停留多久。
export const FALLBACK_VISIBLE_MS = 10000;

// runtime.status: idle | loading | ready | error
// 返回 { visible, tone, progress, modelName, ramBytes } 或 visible=false。
export function deriveEngineStatus({
  enabled = false,
  activeModelId = '',
  activeModelName = '',
  runtime = {},
  fallbackAt = 0,
  now = Date.now(),
} = {}) {
  if (!enabled || !activeModelId) return { visible: false };

  // 回退警告优先：延时出现（见文件头）后停留 FALLBACK_VISIBLE_MS，让用户知道当前
  // 回复走的是在线 API；延时窗内与过期后都落回常规状态（该是 ready 就是 ready）。
  if (fallbackAt > 0) {
    const age = now - fallbackAt;
    if (age >= FALLBACK_NOTICE_DELAY_MS && age <= FALLBACK_NOTICE_DELAY_MS + FALLBACK_VISIBLE_MS) {
      return {
        visible: true,
        tone: ENGINE_TONE.FALLBACK,
        modelName: activeModelName || activeModelId,
        progress: 0,
        ramBytes: 0,
      };
    }
  }

  const status = String((runtime && runtime.status) || 'idle');
  if (status === 'loading') {
    return {
      visible: true,
      tone: ENGINE_TONE.LOADING,
      modelName: activeModelName || activeModelId,
      progress: Math.max(0, Math.min(100, Math.round(Number(runtime.progress) || 0))),
      ramBytes: 0,
    };
  }
  if (status === 'error') {
    return {
      visible: true,
      tone: ENGINE_TONE.ERROR,
      modelName: activeModelName || activeModelId,
      progress: 0,
      ramBytes: 0,
    };
  }
  if (status === 'ready') {
    return {
      visible: true,
      tone: ENGINE_TONE.READY,
      modelName: activeModelName || activeModelId,
      progress: 100,
      ramBytes: Number(runtime.ramEstimate) > 0 ? Number(runtime.ramEstimate) : 0,
    };
  }
  // idle：本地已启用但引擎尚未加载——状态条仍常驻，提示「未加载」。
  return {
    visible: true,
    tone: ENGINE_TONE.IDLE,
    modelName: activeModelName || activeModelId,
    progress: 0,
    ramBytes: 0,
  };
}
