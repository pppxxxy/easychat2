// 获取域状态机（纯函数，无 RN/Expo 依赖，Node 直测）。
//
// 四个状态本来就是一台「获取流程」的状态机：子 Tab（下载/导入互斥）、两份草稿
// （切换子 Tab 各自保留）、单对象任务态（kind 空 = 没有任务在跑，不存在 busy 孤儿态）。
// 收进 reducer 后所有迁移都走类型化 action，散落的 setXxx 交叉更新不再可能。

export const IDLE_TASK = { kind: '', progress: 0, writtenBytes: 0, totalBytes: 0 };

// 单字段迁移：值可以直接传，也可以是 (current) => next（与 useState 语义一致）。
export function nextValue(current, value) {
  return typeof value === 'function' ? value(current) : value;
}

export function acquireReducer(state, action) {
  switch (action && action.type) {
    case 'tab':
      return state.tab === action.value ? state : { ...state, tab: action.value };
    case 'downloadDraft':
      return { ...state, downloadDraft: nextValue(state.downloadDraft, action.value) };
    case 'importDraft':
      return { ...state, importDraft: nextValue(state.importDraft, action.value) };
    case 'task':
      return { ...state, task: nextValue(state.task, action.value) };
    default:
      return state;
  }
}
