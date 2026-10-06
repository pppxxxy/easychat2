// 本地模型面板 · 共享小件：兼容分级配色、两份草稿的空形态、参数字段标签。
// 2026-10-06 指令书 Phase 2 拆分：壳（LocalModelPanel.js）只做组合与用户反馈，
// 数据装配进 hooks，渲染进 Section 组件，样式统一在 panelStyles.js。

// 兼容分级的展示色：推荐=主题色，跑不了=危险色，其余（难跑/未知）=柔和危险色。
export function tierColor(theme, tier) {
  if (tier === 'recommended') return theme.colors.primary;
  if (tier === 'incompatible') return theme.colors.danger;
  return theme.colors.dangerSoft;
}

// 下载与导入是两条互斥路径：草稿分开持有，切换子 Tab 时各自保留（U2）。
export function emptyDownloadDraft() {
  return {
    modelId: '',
    name: '',
    modelUrl: '',
    sourceId: '',
    repoPath: '',
    quant: '',
    paramSize: 0,
    // 目录声明的精确字节数与 sha256（来自文件列表），用于下载完整性校验。
    modelExpectedBytes: 0,
    modelSha256: '',
    mmprojUrl: '',
    mmprojUrls: [],
  };
}

export function emptyImportDraft() {
  return {
    sourceUri: '',
    name: '',
    mmprojSourceUri: '',
    mmprojSourceName: '',
  };
}

export const PARAM_LABEL_KEYS = {
  contextSize: 'localModel.param.contextSize',
  gpuLayers: 'localModel.param.gpuLayers',
  threads: 'localModel.param.threads',
  temperature: 'localModel.param.temperature',
  topP: 'localModel.param.topP',
  topK: 'localModel.param.topK',
  maxTokens: 'localModel.param.maxTokens',
};
