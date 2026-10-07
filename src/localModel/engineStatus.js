// 本地引擎状态派生（v5 Stage C，D5）：把「本地是否启用 + 运行态 + 回退事件」压成
// 聊天层状态条需要的呈现模型。纯函数，可 Node 直测；组件只负责渲染与订阅。
//
// 状态条只在「本地已启用且选了活动模型」时出现；回退提示（本地失败静默回退在线）
// 有独立时间窗（默认 10 秒），窗口内优先展示回退警告，让用户知道这条回复来自在线。

export const ENGINE_TONE = {
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  ERROR: 'error',
  FALLBACK: 'fallback',
};

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

  // 回退警告优先：仅在时间窗内展示，让用户知道当前回复走的是在线 API。
  if (fallbackAt > 0 && now - fallbackAt <= FALLBACK_VISIBLE_MS) {
    return {
      visible: true,
      tone: ENGINE_TONE.FALLBACK,
      modelName: activeModelName || activeModelId,
      progress: 0,
      ramBytes: 0,
    };
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
